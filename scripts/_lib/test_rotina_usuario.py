#!/usr/bin/env python3
"""Testes: com que usuario a rotina roda, elevacao por sudo e dono dos arquivos do manifesto.

Rodar:  python3 scripts/_lib/test_rotina_usuario.py

Contexto: no container da v1 o agente e o usuario `agente` (uid 1001), nao root. A unit da
rotina tem de rodar como ele, com o HOME dele, e o gerenciador tem de pedir sudo sozinho para
gravar em /etc/systemd/system. Nada aqui usa root, systemd nem sudo de verdade.
"""
import importlib.util
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent


def _carregar():
    spec = importlib.util.spec_from_file_location("persona_cron_mgr_u", SCRIPTS / "persona-cron-mgr.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _pw(nome, uid, home):
    return SimpleNamespace(pw_name=nome, pw_uid=uid, pw_dir=home)


PASSWD = {0: _pw("root", 0, "/root"), 1001: _pw("agente", 1001, "/home/agente")}


def _getpwuid(uid):
    if uid not in PASSWD:
        raise KeyError(uid)
    return PASSWD[uid]


def _getpwnam(nome):
    for p in PASSWD.values():
        if p.pw_name == nome:
            return p
    raise KeyError(nome)


def _stat_dono(uid, alvo):
    """os.stat so mente para a pasta do agente (alvo); o resto do sistema segue real."""
    real = os.stat

    def falso(p, *a, **k):
        if str(p) == str(alvo):
            return SimpleNamespace(st_uid=uid, st_gid=uid)
        return real(p, *a, **k)
    return mock.patch.object(os, "stat", side_effect=falso)


class Base(unittest.TestCase):
    def setUp(self):
        self.mod = _carregar()
        self.tmp = tempfile.mkdtemp()
        self.units = tempfile.mkdtemp()  # pasta das units separada da pasta do agente
        self.addCleanup(shutil.rmtree, self.units, ignore_errors=True)
        self.c = {"slug": "ana", "ws": self.tmp, "plugin": "/opt/plugin", "config": "",
                  "tz": "America/Sao_Paulo", "unit_dir": self.units,
                  "dgdir": Path(self.tmp) / ".dgclaw", "manifest": Path(self.tmp) / ".dgclaw" / "self-crons.json",
                  "backup_dir": Path(self.tmp) / ".dgclaw" / "backups" / "self-crons", "n_backups": 5}
        p = [mock.patch.object(self.mod.dono_agente.pwd, "getpwuid", side_effect=_getpwuid),
             mock.patch.object(self.mod.dono_agente.pwd, "getpwnam", side_effect=_getpwnam),
             mock.patch.dict(os.environ, {"HOME": "/root"})]
        os.environ.pop("DGCLAW_ROTINA_USUARIO", None)
        for x in p:
            x.start()
            self.addCleanup(x.stop)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def dono(self, uid):
        return _stat_dono(uid, self.tmp)

    def _svc(self):
        with mock.patch.object(self.mod, "run"):
            self.mod.install_units(self.c, "lembrete", "*-*-* 08:00:00", None, "lembre a dona Marta do pao", "x")
        return (Path(self.units) / "dgclaw-ana-self-lembrete.service").read_text()


class QuemRoda(Base):
    def test_dono_root_gera_user_root(self):
        with self.dono(0):
            svc = self._svc()
        self.assertIn("User=root\n", svc)
        self.assertIn("Environment=HOME=/root\n", svc)

    def test_dono_agente_gera_user_agente_mesmo_com_home_root_no_ambiente(self):
        with self.dono(1001):
            svc = self._svc()
        self.assertIn("User=agente\n", svc)
        self.assertIn("Environment=HOME=/home/agente\n", svc)
        self.assertNotIn("HOME=/root", svc)

    def test_variavel_manda_sobre_o_dono(self):
        with self.dono(1001), mock.patch.dict(os.environ, {"DGCLAW_ROTINA_USUARIO": "root"}):
            svc = self._svc()
        self.assertIn("User=root\n", svc)
        self.assertIn("Environment=HOME=/root\n", svc)

    def test_variavel_com_usuario_inexistente_falha(self):
        with self.dono(1001), mock.patch.dict(os.environ, {"DGCLAW_ROTINA_USUARIO": "fantasma"}):
            with self.assertRaises(SystemExit):
                self.mod.usuario_da_rotina(self.c)

    def test_uid_sem_passwd_falha_citando_o_uid(self):
        with self.dono(4242), mock.patch.object(self.mod, "log_err") as log:
            with self.assertRaises(SystemExit):
                self.mod.usuario_da_rotina(self.c)
        msg = log.call_args[0][0]
        self.assertIn("4242", msg)
        self.assertIn("DGCLAW_ROTINA_USUARIO", msg)


class Elevacao(Base):
    def setUp(self):
        super().setUp()
        self.c["unit_dir"] = "/etc/systemd/system"
        self.env = mock.patch.dict(os.environ, {"DGCLAW_SLUG": "ana", "RUNNER_TOKEN_FILE": "/tmp/t"})
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop(self.mod.VARS_ELEVADO, None)

    def _ok(self):
        return subprocess.CompletedProcess([], 0, "", "")

    def test_reexecuta_com_sudo_preservando_variaveis(self):
        with mock.patch.object(self.mod.os, "geteuid", return_value=1001), \
             mock.patch.object(self.mod.os, "access", return_value=False), \
             mock.patch.object(self.mod.subprocess, "run", return_value=self._ok()), \
             mock.patch.object(self.mod.os, "execvp") as ex:
            self.mod.elevar_se_preciso(self.c)
        cmd = ex.call_args[0][1]
        self.assertEqual(cmd[:2], ["sudo", "-n"])
        self.assertTrue(cmd[2].startswith("--preserve-env="))
        for nome in ("DGCLAW_SLUG", "RUNNER_TOKEN_FILE", self.mod.VARS_ELEVADO):
            self.assertIn(nome, cmd[2])

    def test_sem_sudo_falha_com_a_mensagem(self):
        falha = subprocess.CompletedProcess([], 1, "", "a password is required")
        with mock.patch.object(self.mod.os, "geteuid", return_value=1001), \
             mock.patch.object(self.mod.os, "access", return_value=False), \
             mock.patch.object(self.mod.subprocess, "run", return_value=falha), \
             mock.patch.object(self.mod.os, "execvp") as ex, \
             mock.patch.object(self.mod, "log_err") as log:
            with self.assertRaises(SystemExit):
                self.mod.elevar_se_preciso(self.c)
        ex.assert_not_called()
        msg = log.call_args[0][0]
        self.assertIn("/etc/systemd/system", msg)
        self.assertIn("sudo", msg)

    def test_ja_elevado_e_ainda_sem_escrita_nao_entra_em_laco(self):
        with mock.patch.dict(os.environ, {self.mod.VARS_ELEVADO: "1"}), \
             mock.patch.object(self.mod.os, "geteuid", return_value=1001), \
             mock.patch.object(self.mod.os, "access", return_value=False), \
             mock.patch.object(self.mod.os, "execvp") as ex:
            with self.assertRaises(SystemExit):
                self.mod.elevar_se_preciso(self.c)
        ex.assert_not_called()

    def test_root_ou_pasta_gravavel_nao_eleva(self):
        with mock.patch.object(self.mod.os, "geteuid", return_value=0), \
             mock.patch.object(self.mod.os, "execvp") as ex:
            self.mod.elevar_se_preciso(self.c)
        ex.assert_not_called()


class DonoDosArquivos(Base):
    def test_root_devolve_manifesto_e_lock_ao_dono_do_workspace(self):
        with mock.patch.object(self.mod.os, "geteuid", return_value=0), \
             self.dono(1001), \
             mock.patch.object(self.mod.os, "chown") as ch:
            with self.mod.manifest_lock(self.c):
                self.mod.write_manifest(self.c, {"slug": "ana", "crons": {}})
        alvos = [str(x[0][0]) for x in ch.call_args_list]
        self.assertIn(str(self.c["dgdir"] / ".self-crons.lock"), alvos)
        self.assertIn(str(self.c["dgdir"] / "self-crons.json.tmp"), alvos)
        self.assertTrue(all(x[0][1:] == (1001, 1001) for x in ch.call_args_list))

    def test_falha_de_chown_avisa_e_nao_aborta(self):
        with mock.patch.object(self.mod.os, "geteuid", return_value=0), \
             self.dono(1001), \
             mock.patch.object(self.mod.os, "chown", side_effect=PermissionError("negado")), \
             mock.patch("sys.stderr", new_callable=io.StringIO) as err:
            self.mod.chown_dono(self.c, "/tmp/x")
        self.assertIn("/tmp/x", err.getvalue())
        self.assertIn("chown 1001:1001 /tmp/x", err.getvalue())


if __name__ == "__main__":
    unittest.main()
