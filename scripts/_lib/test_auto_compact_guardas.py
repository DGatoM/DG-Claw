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

    def test_estado_ilegivel_adia_em_vez_de_seguir(self):
        m = self._motivo(None)
        self.assertIn("nao consegui ler o estado do card", m)
        self.assertIn("adio", m)

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
            self.assertTrue(guardas.acabou_de_compactar(Path(d) / "s.jsonl"))

    def test_compact_de_30_min_atras_nao_bloqueia(self):
        with tempfile.TemporaryDirectory() as d:
            self._transcript(d, 30)
            self.assertFalse(guardas.acabou_de_compactar(Path(d) / "s.jsonl"))

    def test_intervalo_vem_da_env(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"DGCLAW_COMPACT_MIN_INTERVAL_MIN": "60"}):
            self._transcript(d, 30)
            self.assertTrue(guardas.acabou_de_compactar(Path(d) / "s.jsonl"))

    def test_compact_recente_so_no_transcript_paralelo_nao_bloqueia_a_principal(self):
        with tempfile.TemporaryDirectory() as d:
            ts = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
            paralelo = Path(d) / "paralelo.jsonl"
            paralelo.write_text(json.dumps(
                {"type": "system", "subtype": "compact_boundary", "timestamp": ts}) + "\n")
            principal = Path(d) / "principal.jsonl"
            principal.write_text(json.dumps({"type": "assistant", "message": {"content": "ok"}}) + "\n")
            self.assertFalse(guardas.acabou_de_compactar(principal))
            self.assertTrue(guardas.acabou_de_compactar(paralelo))

    def test_recuo_com_contador_enorme_ou_invalido_nao_estoura(self):
        self.assertEqual(guardas.cooldown_com_recuo(20, 10 ** 9, 2), 240)
        self.assertEqual(guardas.cooldown_com_recuo(20, "abc", 2), 20)
        self.assertEqual(guardas.cooldown_com_recuo(20, -5, 2), 20)
        self.assertEqual(guardas.cooldown_com_recuo(20, None, 2), 20)
        self.assertEqual(guardas.cooldown_com_recuo(20, 2.5, 2), 20)

    def test_recuo_dobra_por_falha_e_tem_teto_de_4h(self):
        self.assertEqual(guardas.cooldown_com_recuo(20, 0, 2), 20)
        self.assertEqual(guardas.cooldown_com_recuo(20, 1, 2), 20)
        self.assertEqual(guardas.cooldown_com_recuo(20, 2, 2), 80)
        self.assertEqual(guardas.cooldown_com_recuo(20, 3, 2), 160)
        self.assertEqual(guardas.cooldown_com_recuo(20, 4, 2), 240)
        self.assertEqual(guardas.cooldown_com_recuo(20, 9, 2), 240)


class MainDoAutoCompactNoRunner(unittest.TestCase):
    """O main inteiro, com o card falso: a guarda sai 0 sem injetar nem gravar estado."""

    def _rodar(self, card, state=None, rc_injecao=0, force=False):
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
                 mock.patch.object(sys, "argv", ["auto-compact.py"] + (["--force"] if force else [])), \
                 mock.patch.object(principal.inj, "resolve_mode", return_value="bunker"), \
                 mock.patch.object(guardas.inj, "resolve_mode", return_value="bunker"), \
                 mock.patch.object(guardas.inj, "_bunker_estado", return_value=card), \
                 mock.patch.object(principal.inj, "is_session_alive", return_value=True), \
                 mock.patch.object(principal, "resolve_live_transcript", return_value=transcript), \
                 mock.patch.object(principal, "resolve_state_file", return_value=state_file), \
                 mock.patch.object(principal, "looks_idle", return_value=True), \
                 mock.patch.object(principal, "notify_owner"), \
                 mock.patch.object(principal, "esperar_assentar_e_fechar"), \
                 mock.patch.object(principal, "inject_compact",
                                   side_effect=lambda *a, **k: injetou.append((a, k)) or rc_injecao):
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

    def test_card_idle_e_fila_vazia_injeta_com_somente_se_ocioso(self):
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0})
        self.assertEqual(rc, 0)
        self.assertEqual(len(injetou), 1)
        self.assertTrue(injetou[0][1]["somente_se_ocioso"])
        self.assertIn("last_compact_ts", gravado)

    def test_force_mantem_o_comportamento_antigo(self):
        rc, injetou, gravado = self._rodar({"status": "working", "naFilaTotal": 2}, force=True)
        self.assertEqual(rc, 0)
        self.assertEqual(len(injetou), 1)
        self.assertFalse(injetou[0][1]["somente_se_ocioso"])

    def test_runner_recusa_por_ocupado_adia_sem_gravar_nem_contar_falha(self):
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0}, rc_injecao=6,
                                           state={"consecutive_fail": 1})
        self.assertEqual(rc, 0)
        self.assertEqual(len(injetou), 1)
        self.assertNotIn("last_compact_ts", gravado)
        self.assertEqual(gravado["consecutive_fail"], 1)

    def test_leitura_do_card_falhou_nao_envia(self):
        rc, injetou, gravado = self._rodar(None)
        self.assertEqual(rc, 0)
        self.assertEqual(injetou, [])
        self.assertNotIn("last_compact_ts", gravado)

    def test_em_recuo_depois_de_falhas_nao_injeta(self):
        recente = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0},
                                           state={"consecutive_fail": 2, "last_compact_ts": recente})
        self.assertEqual(rc, 0)
        self.assertEqual(injetou, [])
        self.assertEqual(gravado["consecutive_fail"], 2)


class EntregaSomenteSeOcioso(unittest.TestCase):
    def test_inject_bunker_manda_somente_se_ocioso_sem_inject_when_idle(self):
        import inject
        pedidos = []
        with mock.patch.dict(os.environ, {"DGCLAW_BUNKER_CARD": "c1"}), \
             mock.patch.object(inject, "_bunker_pedir",
                               side_effect=lambda rota, corpo=None, timeout=30: pedidos.append(corpo) or (202, {"success": True})):
            ok, _ = inject._inject_bunker("/compact", False, True)
        self.assertTrue(ok)
        self.assertEqual(pedidos, [{"text": "/compact", "somenteSeOcioso": True}])

    def test_409_agente_ocupado_volta_como_motivo_proprio(self):
        import inject
        resp = {"success": False, "error": "o agente esta working", "code": "AGENTE_OCUPADO"}
        with mock.patch.dict(os.environ, {"DGCLAW_BUNKER_CARD": "c1"}), \
             mock.patch.object(inject, "_bunker_pedir", return_value=(409, resp)):
            ok, motivo = inject._inject_bunker("/compact", False, True)
        self.assertFalse(ok)
        self.assertTrue(motivo.startswith(inject.MOTIVO_OCUPADO))

    def test_inject_text_devolve_6_quando_o_runner_recusa_por_ocupado(self):
        from auto_compact import injecao
        with mock.patch.object(injecao, "env", return_value=""), \
             mock.patch.object(injecao.inj, "resolve_mode", return_value="bunker"), \
             mock.patch.object(injecao.inj, "is_session_alive", return_value=True), \
             mock.patch.object(injecao.inj, "_bunker_card", return_value="c1"), \
             mock.patch.object(injecao.inj, "_inject_bunker",
                               return_value=(False, "AGENTE_OCUPADO: working")) as ib:
            rc = injecao.inject_compact("teste", "canal", False, somente_se_ocioso=True)
        self.assertEqual(rc, 6)
        ib.assert_called_once_with("/compact", False, True)


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

    def _cuidar(self, card, auto_recovery="on", transcript_epoch="mudo", releitura="igual"):
        """transcript_epoch: "mudo" = Claude com o transcript parado ha 40 min; None = sem medicao.
        releitura: "igual" devolve o mesmo card; outro valor e o card relido (ou None = falhou)."""
        if transcript_epoch == "mudo":
            transcript_epoch = time.time() - 40 * 60
        with tempfile.TemporaryDirectory() as d:
            ctx = self._ctx(d, auto_recovery)
            reinicios, avisos = [], []
            relido = card if releitura == "igual" else releitura
            with mock.patch.object(wd, "do_restart", side_effect=lambda s: reinicios.append(s) or (True, "")), \
                 mock.patch.object(wd, "notify_owner", side_effect=lambda m: avisos.append(m) or True):
                r = wd.cuidar_da_fila_parada(card, {"estado": "ativo", "tipo": "ok"}, ctx,
                                             transcript_epoch, reler_card=lambda: relido)
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

    def test_sem_medicao_do_transcript_so_avisa_uma_vez_e_nao_reinicia(self):
        card = self._card()
        with tempfile.TemporaryDirectory() as d:
            ctx = self._ctx(d)
            reinicios, avisos = [], []
            with mock.patch.object(wd, "do_restart", side_effect=lambda s: reinicios.append(s) or (True, "")), \
                 mock.patch.object(wd, "notify_owner", side_effect=lambda m: avisos.append(m) or True):
                for _ in range(2):
                    tratado, verdict, diag = wd.cuidar_da_fila_parada(card, {"estado": "ativo"}, ctx, None)
            self.assertTrue(tratado)
            self.assertEqual(reinicios, [])
            self.assertEqual(len(avisos), 1, "um aviso por incidente")
            self.assertIn("so observei", verdict)
            self.assertEqual(diag["tipo"], "fila_parada")
            self.assertTrue(diag["so_observou"])

    def test_agente_codex_so_avisa_e_nao_reinicia_mesmo_com_transcript_velho(self):
        (tratado, verdict, diag), reinicios, avisos = self._cuidar(
            self._card(codexHome="/tmp/codex-teste"), transcript_epoch=time.time() - 40 * 60)
        self.assertTrue(tratado)
        self.assertEqual(reinicios, [])
        self.assertEqual(len(avisos), 1)
        self.assertIn("Codex", avisos[0])
        self.assertTrue(diag["so_observou"])

    def test_releitura_com_card_mudado_desiste_sem_reiniciar(self):
        card = self._card()
        casos = {
            "card andou": self._card(updatedAt=_agora_ms(-1)),
            "ficou idle": self._card(status="idle"),
            "parado pelo dono": self._card(status="stopped"),
            "item mais antigo mudou": self._card(naFila=[{"em": _agora_ms(-20), "msg": None}], naFilaTotal=1),
            "releitura falhou": None,
        }
        for nome, relido in casos.items():
            with self.subTest(nome):
                (tratado, _v, _d), reinicios, _a = self._cuidar(card, releitura=relido)
                self.assertFalse(tratado)
                self.assertEqual(reinicios, [])

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
            card = self._card()
            with mock.patch.object(wd, "do_restart", side_effect=lambda s: reinicios.append(s) or (True, "")), \
                 mock.patch.object(wd, "notify_owner", return_value=True):
                tratado, verdict, _ = wd.cuidar_da_fila_parada(
                    card, {"estado": "ativo"}, ctx, time.time() - 40 * 60, reler_card=lambda: card)
            self.assertTrue(tratado)
            self.assertEqual(reinicios, [])
            self.assertIn("cap atingido", verdict)


if __name__ == "__main__":
    unittest.main()
