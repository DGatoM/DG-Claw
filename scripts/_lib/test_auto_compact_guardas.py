#!/usr/bin/env python3
"""Testes das guardas do auto-compact no runner e da checagem de fila parada do watchdog
(incidente de 19/11/2026: /compact enfileirado atras de /compact, o CLI recusou o segundo com
"Not enough messages to compact." e o agente ficou "working" por horas com a fila presa).

Nada aqui toca agente de verdade: o estado do card e simulado (mock de inject._bunker_estado),
e o restart e o aviso ao dono sao substituidos por registradores.

Rodar:  python3 scripts/_lib/test_auto_compact_guardas.py
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

AQUI = Path(__file__).resolve().parent
SCRIPTS = AQUI.parent
sys.path.insert(0, str(AQUI))
sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location("auto_compact_main", SCRIPTS / "auto-compact.py")
ac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ac)
from auto_compact import guardas  # noqa: E402

wspec = importlib.util.spec_from_file_location("watchdog_mod", SCRIPTS / "watchdog.py")
wd = importlib.util.module_from_spec(wspec)
wspec.loader.exec_module(wd)


def _agora_ms(delta_min=0):
    return (time.time() + delta_min * 60) * 1000


class GuardaDeFilaDoAutoCompact(unittest.TestCase):
    def _motivo(self, card, modo="bunker"):
        with mock.patch.object(guardas.inj, "resolve_mode", return_value=modo), \
             mock.patch.object(guardas.inj, "_bunker_estado", return_value=card):
            return guardas.agente_ocupado_no_bunker()

    def test_card_working_nao_enfileira(self):
        m = self._motivo({"status": "working", "naFilaTotal": 0})
        self.assertIn("working", m)
        self.assertIn("nao enfileiro /compact", m)

    def test_card_idle_com_fila_nao_enfileira(self):
        m = self._motivo({"status": "idle", "naFilaTotal": 3})
        self.assertIn("fila 3", m)

    def test_card_idle_e_fila_vazia_segue(self):
        self.assertIsNone(self._motivo({"status": "idle", "naFilaTotal": 0}))

    def test_estado_ilegivel_segue_como_antes(self):
        self.assertIsNone(self._motivo(None))

    def test_fora_do_bunker_nao_consulta_nada(self):
        with mock.patch.object(guardas.inj, "resolve_mode", return_value="tiocsti"), \
             mock.patch.object(guardas.inj, "_bunker_estado", side_effect=AssertionError("nao deveria ler")):
            self.assertIsNone(guardas.agente_ocupado_no_bunker())


class CompactRecenteERecuo(unittest.TestCase):
    def _transcript(self, d, minutos_atras):
        ts = (datetime.now(timezone.utc) - timedelta(minutes=minutos_atras)).isoformat()
        (Path(d) / "s.jsonl").write_text(json.dumps(
            {"type": "system", "subtype": "compact_boundary", "timestamp": ts}) + "\n")

    def test_compact_de_3_min_atras_bloqueia(self):
        with tempfile.TemporaryDirectory() as d:
            self._transcript(d, 3)
            self.assertTrue(guardas.acabou_de_compactar(Path(d)))

    def test_compact_de_30_min_atras_nao_bloqueia(self):
        with tempfile.TemporaryDirectory() as d:
            self._transcript(d, 30)
            self.assertFalse(guardas.acabou_de_compactar(Path(d)))

    def test_intervalo_vem_da_env(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"DGCLAW_COMPACT_MIN_INTERVAL_MIN": "60"}):
            self._transcript(d, 30)
            self.assertTrue(guardas.acabou_de_compactar(Path(d)))

    def test_recuo_dobra_por_falha_e_tem_teto_de_4h(self):
        self.assertEqual(guardas.cooldown_com_recuo(20, 0, 2), 20)
        self.assertEqual(guardas.cooldown_com_recuo(20, 1, 2), 20)
        self.assertEqual(guardas.cooldown_com_recuo(20, 2, 2), 80)
        self.assertEqual(guardas.cooldown_com_recuo(20, 3, 2), 160)
        self.assertEqual(guardas.cooldown_com_recuo(20, 4, 2), 240)
        self.assertEqual(guardas.cooldown_com_recuo(20, 9, 2), 240)


class MainDoAutoCompactNoRunner(unittest.TestCase):
    """O main inteiro, com o card falso: a guarda sai 0 sem injetar nem gravar estado."""

    def _rodar(self, card, state=None):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            transcript = ws / "t.jsonl"
            transcript.write_text(json.dumps({"type": "assistant", "message": {
                "role": "assistant", "content": "ok",
                "usage": {"input_tokens": 10, "cache_read_input_tokens": 900_000}}}) + "\n")
            state_file = ws / "estado.json"
            if state is not None:
                state_file.write_text(json.dumps(state))
            amb = {"DGCLAW_WORKSPACE": str(ws), "DGCLAW_SLUG": "teste", "DGCLAW_SESSION_DIR": str(ws),
                   "DGCLAW_COMPACT_NOTIFY": "0", "DGCLAW_AUTO_RECOVERY": "on"}
            from auto_compact import principal
            injetou = []
            with mock.patch.dict(os.environ, amb), \
                 mock.patch.object(sys, "argv", ["auto-compact.py"]), \
                 mock.patch.object(principal.inj, "resolve_mode", return_value="bunker"), \
                 mock.patch.object(guardas.inj, "resolve_mode", return_value="bunker"), \
                 mock.patch.object(guardas.inj, "_bunker_estado", return_value=card), \
                 mock.patch.object(principal.inj, "is_session_alive", return_value=True), \
                 mock.patch.object(principal, "resolve_live_transcript", return_value=transcript), \
                 mock.patch.object(principal, "resolve_state_file", return_value=state_file), \
                 mock.patch.object(principal, "looks_idle", return_value=True), \
                 mock.patch.object(principal, "notify_owner"), \
                 mock.patch.object(principal, "esperar_assentar_e_fechar"), \
                 mock.patch.object(principal, "inject_compact", side_effect=lambda *a: injetou.append(a) or 0):
                rc = principal.main()
            gravado = json.loads(state_file.read_text()) if state_file.exists() else {}
            return rc, injetou, gravado

    def test_card_working_sai_0_sem_injetar_nem_gravar(self):
        rc, injetou, gravado = self._rodar({"status": "working", "naFilaTotal": 2},
                                           state={"consecutive_fail": 1})
        self.assertEqual(rc, 0)
        self.assertEqual(injetou, [])
        self.assertNotIn("last_compact_ts", gravado)
        self.assertEqual(gravado["consecutive_fail"], 1)

    def test_card_idle_e_fila_vazia_injeta(self):
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0})
        self.assertEqual(rc, 0)
        self.assertEqual(len(injetou), 1)
        self.assertIn("last_compact_ts", gravado)

    def test_em_recuo_depois_de_falhas_nao_injeta(self):
        recente = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0},
                                           state={"consecutive_fail": 2, "last_compact_ts": recente})
        self.assertEqual(rc, 0)
        self.assertEqual(injetou, [])
        self.assertEqual(gravado["consecutive_fail"], 2)


class FilaParadaNoWatchdog(unittest.TestCase):
    def _card(self, **kw):
        base = {"status": "working", "statusReason": "hook:PreCompact", "naFilaTotal": 2,
                "naFila": [{"em": _agora_ms(-40), "msg": None}, {"em": _agora_ms(-30), "msg": None}],
                "updatedAt": _agora_ms(-40)}
        base.update(kw)
        return base

    def _ctx(self, tmp, auto_recovery="on"):
        return {"state": {}, "state_path": Path(tmp) / ".watchdog-state.json",
                "now": datetime.now(timezone.utc), "service": "dgclaw-teste.service",
                "auto_recovery": auto_recovery, "max_restarts": 3, "window_min": 60}

    def _cuidar(self, card, auto_recovery="on", transcript_epoch=None):
        with tempfile.TemporaryDirectory() as d:
            ctx = self._ctx(d, auto_recovery)
            reinicios, avisos = [], []
            with mock.patch.object(wd, "do_restart", side_effect=lambda s: reinicios.append(s) or (True, "")), \
                 mock.patch.object(wd, "notify_owner", side_effect=lambda m: avisos.append(m) or True):
                r = wd.cuidar_da_fila_parada(card, {"estado": "ativo", "tipo": "ok"}, ctx, transcript_epoch)
            return r, reinicios, avisos

    def test_fila_parada_reinicia_avisa_e_marca_a_saude(self):
        (tratado, verdict, diag), reinicios, avisos = self._cuidar(self._card())
        self.assertTrue(tratado)
        self.assertEqual(len(reinicios), 1)
        self.assertIn("reiniciei", verdict)
        self.assertIn("fila parada", verdict)
        self.assertIn("working", verdict)
        self.assertIn("hook:PreCompact", verdict)
        self.assertEqual(len(avisos), 1, "o dono e avisado")
        self.assertEqual(diag["tipo"], "fila_parada")
        self.assertNotEqual(diag["estado"], "ativo")

    def test_fila_com_agente_idle_nao_reinicia(self):
        (tratado, _v, _d), reinicios, _a = self._cuidar(self._card(status="idle"))
        self.assertFalse(tratado)
        self.assertEqual(reinicios, [])

    def test_waiting_input_nao_reinicia(self):
        (tratado, _v, _d), reinicios, _a = self._cuidar(self._card(status="waiting_input"))
        self.assertFalse(tratado)
        self.assertEqual(reinicios, [])

    def test_fila_nova_nao_reinicia(self):
        card = self._card(naFila=[{"em": _agora_ms(-3), "msg": None}], naFilaTotal=1)
        (tratado, _v, _d), reinicios, _a = self._cuidar(card)
        self.assertFalse(tratado)
        self.assertEqual(reinicios, [])

    def test_card_que_mudou_de_estado_ha_pouco_nao_reinicia(self):
        (tratado, _v, _d), reinicios, _a = self._cuidar(self._card(updatedAt=_agora_ms(-2)))
        self.assertFalse(tratado)
        self.assertEqual(reinicios, [])

    def test_transcript_escrito_ha_pouco_nao_reinicia(self):
        # Ferramenta longa: o card nao muda de estado, mas o turno vivo escreve no transcript.
        (tratado, _v, _d), reinicios, _a = self._cuidar(self._card(), transcript_epoch=time.time() - 120)
        self.assertFalse(tratado)
        self.assertEqual(reinicios, [])

    def test_transcript_mudo_ha_muito_reinicia(self):
        (tratado, _v, _d), reinicios, _a = self._cuidar(self._card(), transcript_epoch=time.time() - 40 * 60)
        self.assertTrue(tratado)
        self.assertEqual(len(reinicios), 1)

    def test_fila_vazia_nao_reinicia(self):
        (tratado, _v, _d), reinicios, _a = self._cuidar(self._card(naFilaTotal=0, naFila=[]))
        self.assertFalse(tratado)
        self.assertEqual(reinicios, [])

    def test_auto_recovery_off_so_observa(self):
        (tratado, verdict, _d), reinicios, avisos = self._cuidar(self._card(), auto_recovery="off")
        self.assertTrue(tratado)
        self.assertEqual(reinicios, [])
        self.assertIn("auto-recovery=off", verdict)
        self.assertEqual(len(avisos), 1)

    def test_respeita_o_cap_de_reinicios(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = self._ctx(d)
            ctx["state"] = {"restarts": [datetime.now(timezone.utc).isoformat()] * 3}
            reinicios = []
            with mock.patch.object(wd, "do_restart", side_effect=lambda s: reinicios.append(s) or (True, "")), \
                 mock.patch.object(wd, "notify_owner", return_value=True):
                tratado, verdict, _ = wd.cuidar_da_fila_parada(self._card(), {"estado": "ativo"}, ctx)
            self.assertTrue(tratado)
            self.assertEqual(reinicios, [])
            self.assertIn("cap atingido", verdict)


if __name__ == "__main__":
    unittest.main()
