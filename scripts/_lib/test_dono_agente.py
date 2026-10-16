#!/usr/bin/env python3
"""Testes do ajudante dono_agente.py (usuario/HOME das units e devolucao de arquivos ao dono).

Rodar:  python3 scripts/_lib/test_dono_agente.py
Nada aqui exige root nem toca no sistema: passwd e stat sao simulados, a CLI roda numa pasta tmp.
"""
import io
import os
import pwd
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
import dono_agente as da  # noqa: E402

PASSWD = {0: SimpleNamespace(pw_name="root", pw_dir="/root"),
          1001: SimpleNamespace(pw_name="agente", pw_dir="/home/agente")}


def _uid(uid):
    if uid not in PASSWD:
        raise KeyError(uid)
    return PASSWD[uid]


def _nam(nome):
    for p in PASSWD.values():
        if p.pw_name == nome:
            return p
    raise KeyError(nome)


def dono(uid, alvo="/ws/ana"):
    real = os.stat

    def falso(p, *a, **k):
        if str(p) == alvo:
            return SimpleNamespace(st_uid=uid, st_gid=uid)
        return real(p, *a, **k)
    return mock.patch.object(os, "stat", side_effect=falso)


class Regras(unittest.TestCase):
    def setUp(self):
        for x in (mock.patch.object(da.pwd, "getpwuid", side_effect=_uid),
                  mock.patch.object(da.pwd, "getpwnam", side_effect=_nam),
                  mock.patch.dict(os.environ, {"HOME": "/root"})):
            x.start()
            self.addCleanup(x.stop)
        os.environ.pop("DGCLAW_ROTINA_USUARIO", None)

    def test_dono_root(self):
        with dono(0):
            self.assertEqual(da.usuario_da_rotina("/ws/ana"), ("root", "/root"))

    def test_dono_agente_ignora_home_do_ambiente(self):
        with dono(1001):
            self.assertEqual(da.usuario_da_rotina("/ws/ana"), ("agente", "/home/agente"))

    def test_variavel_manda(self):
        with dono(1001), mock.patch.dict(os.environ, {"DGCLAW_ROTINA_USUARIO": "root"}):
            self.assertEqual(da.usuario_da_rotina("/ws/ana"), ("root", "/root"))

    def test_variavel_com_usuario_inexistente(self):
        with dono(1001), mock.patch.dict(os.environ, {"DGCLAW_ROTINA_USUARIO": "fantasma"}):
            with self.assertRaises(da.ErroDono) as e:
                da.usuario_da_rotina("/ws/ana")
        self.assertIn("fantasma", str(e.exception))

    def test_uid_sem_passwd_cita_o_uid(self):
        with dono(4242):
            with self.assertRaises(da.ErroDono) as e:
                da.usuario_da_rotina("/ws/ana")
        self.assertIn("4242", str(e.exception))
        self.assertIn("DGCLAW_ROTINA_USUARIO", str(e.exception))

    def test_pasta_inexistente_cita_o_caminho(self):
        with self.assertRaises(da.ErroDono) as e:
            da.dono_do_workspace("/nao/existe/ana")
        self.assertIn("/nao/existe/ana", str(e.exception))

    def test_chown_so_quando_root_e_dono_nao_root(self):
        casos = [(0, 1001, True), (0, 0, False), (1001, 1001, False)]
        for euid, uid_dono, esperado in casos:
            with mock.patch.object(os, "geteuid", return_value=euid), dono(uid_dono), \
                 mock.patch.object(os, "chown") as ch:
                da.chown_dono("/ws/ana", "/ws/ana/x")
            self.assertEqual(ch.called, esperado, (euid, uid_dono))
            if esperado:
                ch.assert_called_once_with("/ws/ana/x", uid_dono, uid_dono)

    def test_falha_de_chown_vai_para_o_stderr_e_nao_aborta(self):
        with mock.patch.object(os, "geteuid", return_value=0), dono(1001), \
             mock.patch.object(os, "chown", side_effect=PermissionError("negado")), \
             mock.patch("sys.stderr", new_callable=io.StringIO) as err:
            da.chown_dono("/ws/ana", "/ws/ana/x")
        self.assertIn("/ws/ana/x", err.getvalue())
        self.assertIn("chown 1001:1001 /ws/ana/x", err.getvalue())


class Cli(unittest.TestCase):
    def _rodar(self, *args, env=None):
        e = dict(os.environ, **(env or {}))
        e.pop("DGCLAW_ROTINA_USUARIO", None)
        e.update(env or {})
        return subprocess.run([sys.executable, str(AQUI / "dono_agente.py"), *args],
                              capture_output=True, text=True, env=e)

    def test_unidade_coerente_com_quem_roda(self):
        with tempfile.TemporaryDirectory() as ws:
            r = self._rodar("unidade", "--ws", ws, env={"HOME": "/root"})
            eu = pwd.getpwuid(os.stat(ws).st_uid)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(),
                         [f"User={eu.pw_name}", f"Environment=HOME={eu.pw_dir}"])

    def test_unidade_com_pasta_inexistente_sai_1_com_mensagem(self):
        r = self._rodar("unidade", "--ws", "/nao/existe/ana")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout, "")
        self.assertIn("/nao/existe/ana", r.stderr)

    def test_chown_em_pasta_do_proprio_usuario_nao_muda_nada_e_sai_0(self):
        with tempfile.TemporaryDirectory() as ws:
            r = self._rodar("chown", "--ws", ws, "-R", ws)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
