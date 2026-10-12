#!/usr/bin/env python3
"""Testes dos consertos 06 e 08 do auto-compact (Lara, Marina e Luna, 05/10/2026).

Rodar:  python3 scripts/test_auto_compact_assentar.py

06: logo depois de compactar, o ultimo usage do transcript ainda e o de ANTES; sem ler o
    compactMetadata.postTokens do compact_boundary o vigia injetava /compact a cada ciclo.
08: o "Voltei" so saia no ciclo SEGUINTE do timer (30 min depois) e exigia sessao ociosa,
    que o eco do /compact nunca deixava ser verdade. Agora o run que injeta espera o recibo.
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
spec = importlib.util.spec_from_file_location("auto_compact", AQUI / "auto-compact.py")
ac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ac)


def _iso(delta_s=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_s)).isoformat()


def _assistant(tokens):
    return json.dumps({"type": "assistant", "message": {"role": "assistant", "content": "ok",
                       "usage": {"input_tokens": 10, "cache_read_input_tokens": tokens}}})


def _boundary(pos, ts=None):
    return json.dumps({"type": "system", "subtype": "compact_boundary",
                       "timestamp": ts or _iso(), "compactMetadata": {"postTokens": pos}})


def _user(conteudo, **extra):
    return json.dumps({"type": "user", "message": {"role": "user", "content": conteudo}, **extra})


class ContextoPosCompactacao(unittest.TestCase):
    def _ctx(self, linhas):
        with tempfile.TemporaryDirectory() as d:
            tr = Path(d) / "s.jsonl"
            tr.write_text("\n".join(linhas) + "\n")
            return ac.context_tokens(tr)

    def test_boundary_vale_postTokens(self):
        self.assertEqual(self._ctx([_assistant(158000), _boundary(9311)]), 9311)

    def test_resposta_nova_volta_a_valer_o_usage(self):
        self.assertEqual(self._ctx([_assistant(158000), _boundary(9311), _assistant(12000)]),
                         12010)

    def test_sem_boundary_continua_igual(self):
        self.assertEqual(self._ctx([_assistant(50000)]), 50010)


class OciosidadePosCompactacao(unittest.TestCase):
    def _idle(self, linhas):
        with tempfile.TemporaryDirectory() as d:
            tr = Path(d) / "s.jsonl"
            tr.write_text("\n".join(linhas) + "\n")
            antigo = time.time() - 300
            os.utime(tr, (antigo, antigo))
            return ac.looks_idle(tr, 45)

    def test_eco_do_compact_conta_como_fim_de_turno(self):
        self.assertTrue(self._idle([
            _assistant(158000), _boundary(9311),
            _user("resumo da conversa", isCompactSummary=True),
            _user("<local-command-caveat>nao responda</local-command-caveat>", isMeta=True),
            _user("<local-command-stdout>Compacted</local-command-stdout>"),
        ]))

    def test_mensagem_do_dono_sem_resposta_segura(self):
        self.assertFalse(self._idle([
            _assistant(158000), _boundary(9311),
            _user("<local-command-stdout>Compacted</local-command-stdout>"),
            _user("oi, voce esta ai?"),
        ]))


class FechamentoNoMesmoRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.tr = self.dir / "s.jsonl"
        self.tr.write_text(_assistant(158000) + "\n")
        self.state = self.dir / "state.json"
        agora = _iso(-1)
        self.st = {"pending_resume_poke": {"file": None, "ts": agora, "since": agora,
                                           "ctx": 157000}}
        ac.save_state(self.state, self.st)
        self.avisos = []

    def tearDown(self):
        self.tmp.cleanup()

    def _esperar(self, limite, boundary_no_sleep):
        chamadas = {"n": 0}

        def sono(_s):
            chamadas["n"] += 1
            if chamadas["n"] == boundary_no_sleep:
                with self.tr.open("a") as f:
                    f.write(_boundary(9311, _iso(1)) + "\n")
                    f.write(_user("<local-command-stdout>Compacted</local-command-stdout>")
                            + "\n")

        with mock.patch.dict(os.environ, {"DGCLAW_COMPACT_SETTLE_WAIT_S": str(limite),
                                          "DGCLAW_NAME": "Luna"}), \
             mock.patch.object(ac.time, "sleep", side_effect=sono), \
             mock.patch.object(ac, "notify_owner", side_effect=self.avisos.append):
            ac.esperar_assentar_e_fechar(self.st, self.state, self.dir, "luna", "dgclaw-luna",
                                         self.dir, 45)

    def test_voltei_sai_quando_o_boundary_aparece(self):
        self._esperar(limite=0.5, boundary_no_sleep=1)
        self.assertEqual(len(self.avisos), 1)
        self.assertIn("Voltei", self.avisos[0])
        self.assertIn("157k", self.avisos[0])
        self.assertNotIn("pending_resume_poke", ac.load_state(self.state))

    def test_sem_boundary_o_pendente_fica_pro_proximo_ciclo(self):
        self._esperar(limite=0.05, boundary_no_sleep=10**9)
        self.assertEqual(self.avisos, [])
        self.assertIn("pending_resume_poke", ac.load_state(self.state))

    def test_zero_desliga_a_espera(self):
        self._esperar(limite=0, boundary_no_sleep=1)
        self.assertEqual(self.avisos, [])
        self.assertIn("pending_resume_poke", ac.load_state(self.state))


if __name__ == "__main__":
    unittest.main(verbosity=2)
