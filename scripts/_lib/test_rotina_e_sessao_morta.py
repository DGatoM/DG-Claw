#!/usr/bin/env python3
"""Testes: rotina agendada nao interrompe turno, e sessao morta nao aparece como "ok".

Rodar:  python3 scripts/_lib/test_rotina_e_sessao_morta.py

Contexto: a reflexao das 23h30 e o batimento da Ana saiam com codigo 0 quando a sessao do
agente estava desligada, e o Pulso mostrava "ok" verde. Alem disso, as linhas que o
pulso-lib.sh gravava tinham chaves que o leitor (pulso-status.py) nao conhecia e eram
ignoradas. Aqui nada usa root, systemd nem sessao real: o inject.py vira um stub e o
workspace e temporario.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

AQUI = Path(__file__).resolve().parent
SCRIPTS = AQUI.parent

STUB_INJECT = """#!/usr/bin/env python3
# stub do inject.py: --check devolve STUB_CHECK_RC; injecao devolve STUB_INJECT_RC.
import os, sys
if "--check" in sys.argv:
    sys.exit(int(os.environ.get("STUB_CHECK_RC", "0")))
sys.exit(int(os.environ.get("STUB_INJECT_RC", "0")))
"""


def _carregar(nome_arquivo, nome_modulo, env=None):
    spec = importlib.util.spec_from_file_location(nome_modulo, SCRIPTS / nome_arquivo)
    mod = importlib.util.module_from_spec(spec)
    with mock.patch.dict(os.environ, env or {}):
        spec.loader.exec_module(mod)
    return mod


class ExecLineEUnit(unittest.TestCase):
    def setUp(self):
        self.mod = _carregar("persona-cron-mgr.py", "persona_cron_mgr")
        self.tmp = tempfile.mkdtemp()
        self.c = {"slug": "ana", "ws": self.tmp, "plugin": "/opt/plugin", "config": "",
                  "tz": "America/Sao_Paulo", "unit_dir": self.tmp}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_exec_line_passa_require_idle(self):
        self.assertIn("--require-idle", self.mod.exec_line(self.c, "lembre a dona Marta do pao"))

    def test_service_gerado_reenfileira_no_75(self):
        with mock.patch.object(self.mod, "run") as run:
            self.mod.install_units(self.c, "lembrete", "*-*-* 08:00:00", None,
                                   "lembre a dona Marta do pao", "lembrete")
        self.assertEqual(run.call_count, 2)  # daemon-reload e enable, sem systemctl de verdade
        svc = (Path(self.tmp) / "dgclaw-ana-self-lembrete.service").read_text()
        self.assertIn("RestartForceExitStatus=75", svc)
        self.assertIn("RestartSec=120", svc)
        self.assertIn("--require-idle", svc)
        # oneshot nao aceita RestartForceExitStatus (systemd 255 recusa a unit)
        self.assertIn("Type=simple", svc)
        self.assertNotIn("oneshot", svc)


class PulsoLedger(unittest.TestCase):
    def test_leitor_enxerga_linha_do_pulso_lib(self):
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(
                ["bash", "-c", f'source "{SCRIPTS}/_lib/pulso-lib.sh"; PULSO_ID=reflection '
                 'pulso erro "a sessão não estava no ar"'],
                env={**os.environ, "DGCLAW_PULSO_DIR": d}, check=True)
            ps = _carregar("pulso-status.py", "pulso_status", {"DGCLAW_PULSO_DIR": d})
            visto = ps.read_ledger("hoje")
        self.assertIn("reflection", visto)
        self.assertEqual(visto["reflection"]["status"], "erro")
        self.assertIn("sessão não estava no ar", visto["reflection"]["detail"])
        self.assertTrue(visto["reflection"]["timestamp"])


class RotinasComSessaoMorta(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.ws = self.tmp / "ws"
        (self.ws / ".dgclaw").mkdir(parents=True)
        self.plugin = self.tmp / "plugin"
        shutil.copytree(SCRIPTS, self.plugin / "scripts",
                        ignore=shutil.ignore_patterns("__pycache__", "legado"))
        (self.plugin / "scripts" / "_lib" / "inject.py").write_text(STUB_INJECT)
        self.pulso = self.tmp / "pulso"
        self.cfg = self.ws / ".dgclaw" / "config.sh"
        self.cfg.write_text(
            f'DGCLAW_WORKSPACE="{self.ws}"\nDGCLAW_SLUG=ana\nDGCLAW_NAME=Ana\n'
            f'DGCLAW_OWNER=Marta\nDGCLAW_PLUGIN_ROOT="{self.plugin}"\n')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        # o inject.sh deixa o poke em /tmp quando a "injecao" (stub) funciona
        for f in Path("/tmp").glob("dgclaw-poke-ana-*.txt"):
            f.unlink(missing_ok=True)

    def _rodar(self, script, **env):
        e = {**os.environ, "HOME": str(self.tmp), "DGCLAW_PULSO_DIR": str(self.pulso),
             "DGCLAW_HEARTBEAT_FORCE": "1", **{k: str(v) for k, v in env.items()}}
        e.pop("DGCLAW_REFLECT_MODE", None)
        e.pop("DGCLAW_INJECT_DRYRUN", None)
        r = subprocess.run(["bash", str(self.plugin / "scripts" / script), str(self.cfg)],
                           env=e, capture_output=True, text=True, timeout=120)
        return r

    def _ledger(self):
        linhas = []
        for f in sorted(self.pulso.glob("*.jsonl")):
            linhas += [json.loads(x) for x in f.read_text().splitlines() if x.strip()]
        return linhas

    def _quero_falar(self):
        # motivo para o batimento agir: linha real na secao "Quero Falar"
        (self.ws / "working-memory.md").write_text(
            "## Quero Falar com o Marta Sobre\n- avisar que o pao da padaria Aurora chegou\n")

    def test_heartbeat_sessao_morta_sai_com_erro(self):
        # sem motivo nenhum para agir: antes saia "nada a fazer" e ficava verde
        r = self._rodar("heartbeat.sh", STUB_CHECK_RC=2)
        self.assertNotEqual(r.returncode, 0, r.stderr)
        erros = [x for x in self._ledger() if x["id"] == "heartbeat" and x["status"] == "erro"]
        self.assertTrue(erros, self._ledger())
        self.assertTrue(erros[-1]["detalhe"].strip())
        self.assertNotIn("/root", erros[-1]["detalhe"])

    def test_heartbeat_sessao_ocupada_e_ok(self):
        self._quero_falar()
        r = self._rodar("heartbeat.sh", STUB_CHECK_RC=0, STUB_INJECT_RC=75)
        self.assertEqual(r.returncode, 0, r.stderr)
        ult = [x for x in self._ledger() if x["id"] == "heartbeat"][-1]
        self.assertEqual(ult["status"], "ok")
        self.assertIn("ocupada", ult["detalhe"])

    def test_reflection_sessao_morta_sai_com_erro(self):
        r = self._rodar("reflection.sh", STUB_CHECK_RC=2)
        self.assertEqual(r.returncode, 2, r.stderr)
        ult = [x for x in self._ledger() if x["id"] == "reflection"][-1]
        self.assertEqual(ult["status"], "erro")
        self.assertIn("reflexão", ult["detalhe"])
        self.assertIn("reflection.sh", ult["detalhe"])

    def test_reflection_sessao_ocupada_fica_aguardando(self):
        r = self._rodar("reflection.sh", STUB_CHECK_RC=0, STUB_INJECT_RC=75)
        self.assertEqual(r.returncode, 0, r.stderr)
        ult = [x for x in self._ledger() if x["id"] == "reflection"][-1]
        self.assertEqual(ult["status"], "aguardando")
        self.assertIn("20 min", ult["detalhe"])

    def test_reflection_injetada_e_ok(self):
        r = self._rodar("reflection.sh", STUB_CHECK_RC=0, STUB_INJECT_RC=0)
        self.assertEqual(r.returncode, 0, r.stderr)
        ult = [x for x in self._ledger() if x["id"] == "reflection"][-1]
        self.assertEqual(ult["status"], "ok")

    def test_reflection_falha_de_injecao_diz_o_rc(self):
        r = self._rodar("reflection.sh", STUB_CHECK_RC=0, STUB_INJECT_RC=4)
        self.assertEqual(r.returncode, 4, r.stderr)
        ult = [x for x in self._ledger() if x["id"] == "reflection"][-1]
        self.assertEqual(ult["status"], "erro")
        self.assertIn("rc=4", ult["detalhe"])


if __name__ == "__main__":
    unittest.main()
