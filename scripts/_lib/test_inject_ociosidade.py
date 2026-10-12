#!/usr/bin/env python3
"""Testes da guarda de ociosidade (session_is_idle) e da busca da sessao viva (find_pts).

Rodar:  python3 scripts/_lib/test_inject_ociosidade.py

BL-426 (05/10/2026): depois de um /compact o transcript termina em linhas 'user' que nao
sao turno (resumo da compactacao, linhas isMeta, o eco do comando local). A guarda lia isso
como "mensagem do dono sem resposta" e travava toda injecao ate a proxima resposta: a
reflexao da Lara foi adiada tres noites seguidas.
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inject  # noqa: E402


def _linha(tipo, conteudo=None, **extra):
    o = {"type": tipo, **extra}
    if conteudo is not None:
        o["message"] = {"role": tipo, "content": conteudo}
    return json.dumps(o)


class SessaoOciosa(unittest.TestCase):
    def _idle(self, linhas, idade_s=120):
        with tempfile.TemporaryDirectory() as d:
            tr = Path(d) / "sessao.jsonl"
            tr.write_text("\n".join(linhas) + "\n")
            antigo = time.time() - idade_s
            os.utime(tr, (antigo, antigo))
            with mock.patch.object(inject, "resolve_mode", return_value="tiocsti"), \
                 mock.patch.object(inject, "_resolve_session_dir", return_value=Path(d)), \
                 mock.patch.object(inject, "_find_live_transcript", return_value=tr):
                return inject.session_is_idle("teste", idle_sec=45)

    def test_resposta_no_fim_e_ociosa(self):
        self.assertTrue(self._idle([_linha("user", "oi"), _linha("assistant", "ola")]))

    def test_mensagem_do_dono_sem_resposta_e_ocupada(self):
        self.assertFalse(self._idle([_linha("assistant", "ola"), _linha("user", "e ai?")]))

    def test_depois_do_compact_e_ociosa(self):
        linhas = [
            _linha("user", "faz X"),
            _linha("assistant", "feito"),
            _linha("system", subtype="compact_boundary"),
            _linha("user", "This session is being continued...", isCompactSummary=True),
            _linha("user", "<local-command-caveat>Caveat: ...</local-command-caveat>", isMeta=True),
            _linha("user", "<command-name>/compact</command-name>"),
            _linha("user", "<local-command-stdout>Compacted</local-command-stdout>"),
        ]
        self.assertTrue(self._idle(linhas))

    def test_dono_fala_depois_do_compact_continua_ocupada(self):
        linhas = [
            _linha("assistant", "feito"),
            _linha("user", "<local-command-stdout>Compacted</local-command-stdout>"),
            _linha("user", "e agora?"),
        ]
        self.assertFalse(self._idle(linhas))

    def test_transcript_mexendo_e_ocupada(self):
        self.assertFalse(self._idle([_linha("assistant", "ola")], idade_s=5))


class AchaSessaoSemTelegram(unittest.TestCase):
    def _find(self, cmdlines):
        pids = [str(1000 + i) for i in range(len(cmdlines))]
        tabela = dict(zip(pids, cmdlines))

        def fake_open(path, mode="r", *a, **k):
            pid = path.split("/")[2]
            return mock.mock_open(read_data=tabela[pid].replace(" ", "\x00").encode())()

        def fake_check_output(args, text=False, **k):
            if args[0] == "pgrep":
                return "\n".join(pids)
            return "pts/7"

        with mock.patch("builtins.open", fake_open), \
             mock.patch.object(inject.subprocess, "check_output", fake_check_output):
            return inject.find_pts("dgclaw-teste")

    def test_sessao_so_painel_sem_channels(self):
        pid, pts = self._find(["/root/.local/bin/claude --name dgclaw-teste --model opus"])
        self.assertEqual((pid, pts), ("1000", "/dev/pts/7"))

    def test_sessao_com_telegram(self):
        pid, _ = self._find(["/root/.local/bin/claude --channels plugin:telegram --name dgclaw-teste"])
        self.assertEqual(pid, "1000")

    def test_injetor_python_fica_de_fora(self):
        pid, _ = self._find(["python3 /x/_lib/inject.py --name dgclaw-teste oi"])
        self.assertIsNone(pid)

    def test_instalacao_npm(self):
        pid, _ = self._find(["node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --name dgclaw-teste"])
        self.assertEqual(pid, "1000")


if __name__ == "__main__":
    unittest.main(verbosity=2)
