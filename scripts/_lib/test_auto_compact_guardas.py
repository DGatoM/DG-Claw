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

    def test_card_sem_tamanho_de_fila_valido_adia(self):
        for card in ({"status": "idle"}, {"status": "idle", "naFilaTotal": "abc"},
                     {"status": "idle", "naFilaTotal": -1}, {"status": "idle", "naFilaTotal": None}):
            m = self._motivo(card)
            self.assertIsNotNone(m, card)
            self.assertIn("adio", m)

    def test_lista_de_fila_nao_vazia_conta_como_ocupado_mesmo_com_total_zero(self):
        m = self._motivo({"status": "idle", "naFilaTotal": 0, "naFila": [{"em": 1, "msg": None}]})
        self.assertIn("fila 1", m)

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

    def test_marcador_sem_timestamp_nao_conta_mesmo_com_mtime_recente(self):
        with tempfile.TemporaryDirectory() as d:
            t = Path(d) / "s.jsonl"
            t.write_text(json.dumps({"type": "system", "subtype": "compact_boundary"}) + "\n")
            self.assertFalse(guardas.acabou_de_compactar(t))

    def test_teto_do_recuo_nunca_encolhe_um_cooldown_configurado_maior(self):
        self.assertEqual(guardas.cooldown_com_recuo(480, 5, 2), 480)
        self.assertEqual(guardas.cooldown_com_recuo(480, 1, 2), 480)

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

    def _rodar(self, card, state=None, ao_injetar=None, boundary_ts=None, boundary_paralelo_ts=None,
               prender_trava=False, eventos=None, trava_tipo=None):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            transcript = ws / "t.jsonl"
            linhas = []
            if boundary_ts:
                # o recibo vale so no transcript vivo (nao em outro arquivo da pasta)
                linhas.append(json.dumps({"type": "system", "subtype": "compact_boundary", "timestamp": boundary_ts}))
            linhas.append(json.dumps({"type": "assistant", "message": {
                "role": "assistant", "content": "ok",
                "usage": {"input_tokens": 10, "cache_read_input_tokens": 900_000}}}))
            transcript.write_text("\n".join(linhas) + "\n")
            if boundary_paralelo_ts:
                (ws / "paralelo.jsonl").write_text(json.dumps(
                    {"type": "system", "subtype": "compact_boundary", "timestamp": boundary_paralelo_ts}) + "\n")
            state_file = ws / "estado.json"
            trava_fd = None
            if prender_trava:
                import fcntl
                trava_fd = open(str(state_file) + ".lock", "w")
                fcntl.flock(trava_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if trava_tipo == "symlink":
                alvo = ws / "alvo-da-trava"
                alvo.write_text("nao pode ser tocado")
                os.symlink(alvo, str(state_file) + ".lock")
            elif trava_tipo == "fifo":
                os.mkfifo(str(state_file) + ".lock")
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
                 mock.patch.object(guardas.inj, "_bunker_estado",
                                   **({"side_effect": card} if isinstance(card, list) else {"return_value": card})), \
                 mock.patch.object(principal.inj, "is_session_alive", return_value=True), \
                 mock.patch.object(principal, "resolve_live_transcript", return_value=transcript), \
                 mock.patch.object(principal, "resolve_state_file", return_value=state_file), \
                 mock.patch.object(principal, "looks_idle", return_value=True), \
                 mock.patch.object(principal, "notify_owner",
                                   side_effect=lambda *a: eventos.append("aviso") if eventos is not None else None), \
                 mock.patch.object(principal, "esperar_assentar_e_fechar"), \
                 mock.patch.object(principal, "inject_compact",
                                   side_effect=lambda *a: (ao_injetar() if ao_injetar else None, injetou.append(a),
                                                           eventos.append("envio") if eventos is not None else None, 0)[3]):
                rc = principal.main()
            if trava_fd:
                trava_fd.close()
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

    def test_since_do_recibo_e_capturado_antes_do_envio(self):
        envios = []
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0},
                                           ao_injetar=lambda: envios.append(datetime.now(timezone.utc)))
        self.assertEqual(rc, 0)
        since = datetime.fromisoformat(gravado["last_compact_ts"])
        self.assertLessEqual(since, envios[0])
        self.assertEqual(gravado["pending_resume_poke"]["since"], gravado["last_compact_ts"])

    def test_compact_bem_sucedido_zera_o_contador_e_o_cooldown_volta_ao_normal(self):
        # last_compact_ts de 30 min atras, compact_boundary depois dele: com 4 falhas o recuo seria 240 min
        # (nao injetaria); zerado, o cooldown normal de 20 min ja passou e o /compact segue.
        antes = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        boundary = (datetime.now(timezone.utc) - timedelta(minutes=25)).isoformat()
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0},
                                           state={"consecutive_fail": 4, "last_compact_ts": antes},
                                           boundary_ts=boundary)
        self.assertEqual(rc, 0)
        self.assertEqual(gravado["consecutive_fail"], 0)
        self.assertEqual(len(injetou), 1)

    def test_boundary_so_no_transcript_paralelo_nao_zera_o_contador_e_o_4_5_conta_falha(self):
        antes = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        boundary = (datetime.now(timezone.utc) - timedelta(minutes=25)).isoformat()
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0},
                                           state={"consecutive_fail": 1, "last_compact_ts": antes},
                                           boundary_paralelo_ts=boundary)
        self.assertEqual(rc, 0)
        self.assertEqual(gravado["consecutive_fail"], 2)

    def test_aviso_ao_dono_sai_depois_do_envio_aceito(self):
        eventos = []
        self._rodar({"status": "idle", "naFilaTotal": 0}, eventos=eventos)
        self.assertEqual(eventos, ["envio", "aviso"])

    def test_trava_que_e_symlink_sai_1_sem_injetar(self):
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0}, trava_tipo="symlink")
        self.assertEqual(rc, 1)
        self.assertEqual(injetou, [])

    def test_trava_que_e_fifo_sai_1_sem_travar_nem_injetar(self):
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0}, trava_tipo="fifo")
        self.assertEqual(rc, 1)
        self.assertEqual(injetou, [])

    def test_pendencia_de_outra_sessao_e_descartada_sem_voltei_nem_retomada(self):
        from auto_compact import ciclo
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            a, b = ws / "A.jsonl", ws / "B.jsonl"
            ts = datetime.now(timezone.utc)
            b.write_text(json.dumps({"type": "system", "subtype": "compact_boundary",
                                     "timestamp": (ts + timedelta(seconds=5)).isoformat()}) + "\n")
            st = {"pending_resume_poke": {"file": str(ws / "poke.txt"), "ts": ts.isoformat(),
                                          "since": ts.isoformat(), "ctx": 150000, "transcript": str(a)}}
            state_file = ws / "estado.json"
            with mock.patch.object(ciclo, "resolve_live_transcript", return_value=b), \
                 mock.patch.object(ciclo, "send_resume_poke") as poke, \
                 mock.patch.object(ciclo, "notify_owner") as aviso:
                fechou = ciclo.fechar_ciclo_pendente(st, state_file, ws, "teste", "canal", ws, 45)
            self.assertTrue(fechou)
            poke.assert_not_called()
            aviso.assert_not_called()
            self.assertNotIn("pending_resume_poke", st)

    def test_pendencia_sem_identidade_gravada_tambem_e_descartada(self):
        from auto_compact import ciclo
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            b = ws / "B.jsonl"
            b.write_text("\n")
            ts = datetime.now(timezone.utc).isoformat()
            st = {"pending_resume_poke": {"file": None, "ts": ts, "since": ts, "ctx": 1}}
            with mock.patch.object(ciclo, "resolve_live_transcript", return_value=b), \
                 mock.patch.object(ciclo, "notify_owner") as aviso:
                self.assertTrue(ciclo.fechar_ciclo_pendente(st, ws / "e.json", ws, "t", "c", ws, 45))
            aviso.assert_not_called()
            self.assertNotIn("pending_resume_poke", st)

    def test_trava_ja_tomada_sai_0_sem_injetar(self):
        rc, injetou, gravado = self._rodar({"status": "idle", "naFilaTotal": 0}, prender_trava=True)
        self.assertEqual(rc, 0)
        self.assertEqual(injetou, [])
        self.assertNotIn("last_compact_ts", gravado)

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


class FilaParadaNoWatchdog(unittest.TestCase):
    def _card(self, **kw):
        base = {"status": "working", "statusReason": "hook:PreCompact", "naFilaTotal": 2,
                "naFila": [{"em": 1000.0, "msg": None}, {"em": 2000.0, "msg": None}],
                "updatedAt": 1000.0}
        # tempos absolutos relativos a agora, fixados uma vez por card
        agora = _agora_ms()
        base["naFila"] = [{"em": agora - 40 * 60000, "msg": None}, {"em": agora - 30 * 60000, "msg": None}]
        base["updatedAt"] = agora - 40 * 60000
        base.update(kw)
        return base

    def _ctx(self, tmp, auto_recovery="on", state=None):
        return {"state": {} if state is None else state, "state_path": Path(tmp) / ".watchdog-state.json",
                "now": datetime.now(timezone.utc), "service": "dgclaw-teste.service",
                "auto_recovery": auto_recovery, "max_restarts": 3, "window_min": 60}

    def _cuidar(self, card, auto_recovery="on", transcript_epoch="mudo"):
        """transcript_epoch: "mudo" = transcript parado ha 40 min; None = sem medicao."""
        if transcript_epoch == "mudo":
            transcript_epoch = time.time() - 40 * 60
        with tempfile.TemporaryDirectory() as d:
            ctx = self._ctx(d, auto_recovery)
            avisos = []
            with mock.patch.object(wd, "do_restart", side_effect=AssertionError("nunca deve reiniciar")), \
                 mock.patch.object(wd, "attempt_restart", side_effect=AssertionError("nunca deve reiniciar")), \
                 mock.patch.object(wd, "notify_owner", side_effect=lambda m: avisos.append(m) or True):
                r = wd.cuidar_da_fila_parada(card, {"estado": "ativo", "tipo": "ok"}, ctx, transcript_epoch)
            return r, avisos

    def test_fila_parada_avisa_e_marca_a_saude_sem_reiniciar(self):
        (tratado, verdict, diag), avisos = self._cuidar(self._card())
        self.assertTrue(tratado)
        self.assertIn("so observei", verdict)
        self.assertEqual(len(avisos), 1)
        self.assertIn("2 mensagem", avisos[0])
        self.assertIn("trabalhando", avisos[0])
        self.assertIn("Reiniciar", avisos[0])
        self.assertEqual(diag["tipo"], "fila_parada")
        self.assertTrue(diag["so_observou"])

    def test_atividade_recente_do_runner_com_updatedat_velho_nao_e_fila_parada(self):
        (tratado, _v, _d), avisos = self._cuidar(self._card(ultimoEventoEm=_agora_ms(-2)))
        self.assertFalse(tratado)
        self.assertEqual(avisos, [])

    def test_status_reason_arbitrario_nao_vai_para_aviso_nem_saude(self):
        card = self._card(statusReason="hook:PreToolUse mcp__x__segredo", status="working")
        (tratado, verdict, diag), avisos = self._cuidar(card)
        self.assertTrue(tratado)
        tudo = json.dumps(diag) + verdict + " ".join(avisos)
        self.assertNotIn("segredo", tudo)
        self.assertNotIn("mcp__", tudo)
        self.assertIn("usando uma ferramenta", avisos[0])
        (_t, _v, diag2), avisos2 = self._cuidar(self._card(statusReason="texto livre qualquer", status="algo-novo"))
        self.assertNotIn("texto livre", json.dumps(diag2) + " ".join(avisos2))
        self.assertIn("em andamento", avisos2[0])

    def test_fila_com_agente_idle_ou_waiting_input_nao_avisa(self):
        for st in ("idle", "waiting_input"):
            (tratado, _v, _d), avisos = self._cuidar(self._card(status=st))
            self.assertFalse(tratado)
            self.assertEqual(avisos, [])

    def test_fila_nova_ou_card_recente_nao_avisa(self):
        for card in (self._card(naFila=[{"em": _agora_ms(-3), "msg": None}], naFilaTotal=1),
                     self._card(updatedAt=_agora_ms(-2)), self._card(naFilaTotal=0, naFila=[])):
            (tratado, _v, _d), avisos = self._cuidar(card)
            self.assertFalse(tratado)
            self.assertEqual(avisos, [])

    def test_transcript_escrito_ha_pouco_nao_avisa(self):
        (tratado, _v, _d), avisos = self._cuidar(self._card(), transcript_epoch=time.time() - 120)
        self.assertFalse(tratado)
        self.assertEqual(avisos, [])

    def test_codex_ou_sem_medicao_tambem_so_avisa(self):
        for card, epoch in ((self._card(codexHome="/tmp/codex-teste"), "mudo"), (self._card(), None)):
            (tratado, _v, diag), avisos = self._cuidar(card, transcript_epoch=epoch)
            self.assertTrue(tratado)
            self.assertEqual(len(avisos), 1)
            self.assertTrue(diag["so_observou"])

    def test_auto_recovery_off_tambem_so_avisa(self):
        (tratado, _v, _d), avisos = self._cuidar(self._card(), auto_recovery="off")
        self.assertTrue(tratado)
        self.assertEqual(len(avisos), 1)

    def test_dedup_por_incidente_muda_com_o_item_mais_antigo_e_limpa_ao_destravar(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = self._ctx(d)
            avisos = []
            epoch = time.time() - 40 * 60
            with mock.patch.object(wd, "attempt_restart", side_effect=AssertionError("nunca deve reiniciar")), \
                 mock.patch.object(wd, "notify_owner", side_effect=lambda m: avisos.append(m) or True):
                card = self._card()
                wd.cuidar_da_fila_parada(card, {}, ctx, epoch)
                wd.cuidar_da_fila_parada(card, {}, ctx, epoch)
                self.assertEqual(len(avisos), 1)
                outro = self._card(naFila=[{"em": _agora_ms(-35), "msg": None}], naFilaTotal=1)
                wd.cuidar_da_fila_parada(outro, {}, ctx, epoch)
                self.assertEqual(len(avisos), 2, "item mais antigo mudou: avisa de novo")
                self.assertIn("fila_parada_avisada", ctx["state"])
                wd.cuidar_da_fila_parada(self._card(status="idle", naFilaTotal=0, naFila=[]), {}, ctx, epoch)
                self.assertNotIn("fila_parada_avisada", ctx["state"])

    def test_rodada_com_diagnostico_ativo_nao_repete_o_aviso(self):
        card = self._card()
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            logs = ws / "logs"
            avisos = []
            diag = {"estado": "ativo", "tipo": "ok", "frase": "ok"}
            with mock.patch.object(wd, "resolve_workspace", return_value=ws), \
                 mock.patch.object(wd, "resolve_slug", return_value="teste"), \
                 mock.patch.object(wd, "resolve_service", return_value="dgclaw-teste.service"), \
                 mock.patch.object(wd, "resolve_session_dir", return_value=ws), \
                 mock.patch.object(wd, "resolve_logs_dir", return_value=logs), \
                 mock.patch.object(wd, "service_is_enabled", return_value=True), \
                 mock.patch.object(wd, "pulso_write") as pulso, \
                 mock.patch.object(wd, "latest_poke_mtime", return_value=None), \
                 mock.patch.object(wd, "ultimo_turno_epoch", return_value=time.time() - 40 * 60), \
                 mock.patch.object(wd.reinicio, "ler_marca", return_value=None), \
                 mock.patch.object(wd.saude_sessao, "diagnosticar", return_value=(diag, None)), \
                 mock.patch.object(wd.inject, "is_session_alive", return_value=True), \
                 mock.patch.object(wd.inject, "resolve_mode", return_value="bunker"), \
                 mock.patch.object(wd.inject, "_bunker_estado", return_value=card), \
                 mock.patch.object(wd, "attempt_restart", side_effect=AssertionError("nunca deve reiniciar")), \
                 mock.patch.object(wd, "do_restart", side_effect=AssertionError("nunca deve reiniciar")), \
                 mock.patch.object(wd, "notify_owner", side_effect=lambda m: avisos.append(m) or True):
                v1 = wd.rodada()
                v2 = wd.rodada()
            self.assertIn("fila parada", v1)
            self.assertNotIn("saudavel", v1, "o veredito e o da fila, nao 'viva e saudavel'")
            self.assertIn("fila parada", v2)
            self.assertTrue(any(c.args[0] == "saude" and "fila_parada" in c.args[2] for c in pulso.call_args_list),
                            "o Pulso recebe a conclusao da fila")
            self.assertEqual(len(avisos), 1, "diagnostico ativo limpa saude_avisado, mas nao o campo proprio")
            gravado = json.loads((logs / "saude.json").read_text())
            self.assertEqual(gravado["tipo"], "fila_parada")
            self.assertTrue(gravado["so_observou"])


if __name__ == "__main__":
    unittest.main()
