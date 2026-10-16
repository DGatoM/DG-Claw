#!/usr/bin/env python3
"""Testes do memoria_guarda.py (copia do MEMORY.md antes da consolidacao da noite).

Rodar:  python3 scripts/_lib/test_memoria_guarda.py
"""
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AQUI = Path(__file__).resolve().parent
SCRIPTS = AQUI.parent
RAIZ = SCRIPTS.parent
GUARDA = AQUI / "memoria_guarda.py"
sys.path.insert(0, str(AQUI))
import memoria_guarda  # noqa: E402

PASTA = "memory/.antes-da-consolidacao"


def memoria(n_itens):
    """MEMORY.md de mentira da agente Ana: cabecalho + n_itens linhas de conteudo."""
    itens = "\n".join(f"- (01/10/2026) fato {i} sobre a padaria Aurora" for i in range(n_itens))
    return (
        "<!-- instrucoes longas\n     que nao contam\n     nada -->\n\n"
        "# MEMORY.md - Ana\n\n---\n\n## Regras aprendidas\n\n" + itens + "\n"
    )


class Contagem(unittest.TestCase):
    def test_comentario_multilinha_e_separador_nao_contam(self):
        texto = "<!-- a\nb\nc -->\n# Titulo\n---\n\n## Secao\n- item\n**Campo:** valor\n<!-- x -->\n"
        # Titulo, Secao, item, Campo
        self.assertEqual(memoria_guarda.contar_entradas(texto), 4)

    def test_comentario_na_mesma_linha_do_texto(self):
        self.assertEqual(memoria_guarda.contar_entradas("**Quem e:** dona Marta <!-- dica -->\n"), 1)

    def test_vazio(self):
        self.assertEqual(memoria_guarda.contar_entradas("\n\n---\n<!-- so comentario -->\n"), 0)


class Base(unittest.TestCase):
    def setUp(self):
        self.ws = Path(tempfile.mkdtemp())
        self.notify_out = self.ws / "aviso.txt"
        self.notify = self.ws / "notify-falso.sh"
        self.notify.write_text(f'#!/bin/bash\nprintf "%s" "$1" > "{self.notify_out}"\nexit "${{NOTIFY_RC:-0}}"\n')
        self.pasta = self.ws / PASTA

    def tearDown(self):
        shutil.rmtree(self.ws, ignore_errors=True)

    def rodar(self, *args, **env):
        e = {**os.environ, "DGCLAW_MEMORIA_GUARDA_NOTIFY": str(self.notify),
             **{k: str(v) for k, v in env.items()}}
        return subprocess.run([sys.executable, str(GUARDA), *args, "--ws", str(self.ws)],
                              env=e, capture_output=True, text=True)

    def mem(self, n):
        (self.ws / "MEMORY.md").write_text(memoria(n))


class Guardar(Base):
    def test_sem_memory_sai_0_e_avisa(self):
        r = self.rodar("guardar")
        self.assertEqual(r.returncode, 0)
        self.assertIn("nao existe", r.stderr)
        self.assertFalse(self.pasta.exists())

    def test_copia_com_permissao_600(self):
        self.mem(5)
        r = self.rodar("guardar")
        self.assertEqual(r.returncode, 0, r.stderr)
        copia = Path(r.stdout.strip())
        self.assertTrue(re.fullmatch(r"MEMORY-\d{4}-\d\d-\d\d-\d{4}\.md", copia.name), copia.name)
        self.assertEqual(copia.read_text(), (self.ws / "MEMORY.md").read_text())
        self.assertEqual(stat.S_IMODE(copia.stat().st_mode), 0o600)

    def test_mantem_so_as_14_mais_recentes(self):
        self.mem(3)
        self.pasta.mkdir(parents=True)
        for d in range(1, 21):
            (self.pasta / f"MEMORY-2026-09-{d:02d}-2330.md").write_text("x")
        for d in range(1, 18):
            (self.pasta / f"MEMORY-2026-08-{d:02d}-2330-rejeitada.md").write_text("x")
        self.assertEqual(self.rodar("guardar").returncode, 0)
        normais = sorted(p.name for p in self.pasta.glob("MEMORY-*.md") if not p.name.endswith("-rejeitada.md"))
        rej = sorted(p.name for p in self.pasta.glob("*-rejeitada.md"))
        self.assertEqual(len(normais), 14)
        self.assertEqual(len(rej), 14)
        self.assertNotIn("MEMORY-2026-09-01-2330.md", normais)   # a mais antiga saiu
        self.assertIn("MEMORY-2026-09-20-2330.md", normais)      # a mais nova ficou
        self.assertNotIn("MEMORY-2026-08-01-2330-rejeitada.md", rej)


class Conferir(Base):
    def guardar_e_mudar(self, antes, depois):
        self.mem(antes)
        self.assertEqual(self.rodar("guardar").returncode, 0)
        self.mem(depois)

    def test_perda_de_10_por_cento_nao_mexe(self):
        # 2 linhas fixas (titulo e secao) + itens: 40 entradas para 36 = perda de 10%
        self.guardar_e_mudar(38, 34)
        atual = (self.ws / "MEMORY.md").read_text()
        r = self.rodar("conferir")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.ws / "MEMORY.md").read_text(), atual)
        self.assertFalse(list(self.pasta.glob("*-rejeitada.md")))
        self.assertFalse(self.notify_out.exists())

    def test_perda_de_40_por_cento_restaura_e_avisa(self):
        self.guardar_e_mudar(38, 22)   # 40 entradas para 24 = perda de 40%
        original = memoria(38)
        r = self.rodar("conferir")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertEqual((self.ws / "MEMORY.md").read_text(), original)
        rej = list(self.pasta.glob("*-rejeitada.md"))
        self.assertEqual(len(rej), 1)
        self.assertEqual(rej[0].read_text(), memoria(22))
        aviso = self.notify_out.read_text()
        self.assertIn("40 para 24", aviso)   # entradas antes e depois
        self.assertIn("40%", aviso)
        self.assertIn(rej[0].name, aviso)
        self.assertIn("PERDA", r.stdout)

    def test_segunda_chamada_e_no_op(self):
        self.guardar_e_mudar(20, 6)
        self.assertEqual(self.rodar("conferir").returncode, 3)
        self.notify_out.unlink()
        r = self.rodar("conferir")
        self.assertEqual(r.returncode, 0)
        self.assertFalse(self.notify_out.exists())
        self.assertEqual((self.ws / "MEMORY.md").read_text(), memoria(20))

    def test_memory_sumiu_conta_como_zero(self):
        self.mem(10)
        self.rodar("guardar")
        (self.ws / "MEMORY.md").unlink()
        r = self.rodar("conferir")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertTrue((self.ws / "MEMORY.md").is_file())
        self.assertFalse(list(self.pasta.glob("*-rejeitada.md")))   # nao havia o que guardar

    def test_aviso_que_falha_aparece_no_stderr(self):
        self.guardar_e_mudar(20, 6)
        r = self.rodar("conferir", NOTIFY_RC=1)
        self.assertEqual(r.returncode, 3)
        self.assertIn("rc=1", r.stderr)

    def test_antes_vazio_nao_compara(self):
        (self.ws / "MEMORY.md").write_text("<!-- so comentario -->\n")
        self.rodar("guardar")
        self.mem(5)
        self.assertEqual(self.rodar("conferir").returncode, 0)

    def test_copias_velhas_nao_conferidas_nao_voltam(self):
        self.pasta.mkdir(parents=True)
        (self.pasta / "MEMORY-2026-10-01-2330.md").write_text(memoria(30))
        (self.pasta / "MEMORY-2026-10-02-2330.md").write_text(memoria(10))
        self.mem(10)
        self.assertEqual(self.rodar("conferir").returncode, 0)
        self.assertEqual(self.rodar("conferir").returncode, 0)   # a de 30 itens nao e usada depois

    def test_sem_pasta_de_copias(self):
        r = self.rodar("conferir")
        self.assertEqual(r.returncode, 0)


class PokeAck(unittest.TestCase):
    def test_ack_de_reflexao_dispara_a_conferencia(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            ws = tmp / "ws"
            plugin = tmp / "plugin"
            (ws / ".dgclaw").mkdir(parents=True)
            shutil.copytree(SCRIPTS, plugin / "scripts", ignore=shutil.ignore_patterns("__pycache__", "legado"))
            notify = tmp / "notify.sh"
            notify.write_text(f'#!/bin/bash\nprintf "%s" "$1" > "{tmp}/aviso.txt"\n')
            (ws / "MEMORY.md").write_text(memoria(20))
            env = {**os.environ, "DGCLAW_WORKSPACE": str(ws), "DGCLAW_MEMORIA_GUARDA_NOTIFY": str(notify)}
            subprocess.run([sys.executable, str(plugin / "scripts/_lib/memoria_guarda.py"), "guardar",
                            "--ws", str(ws)], env=env, check=True, capture_output=True)
            (ws / "MEMORY.md").write_text(memoria(5))   # a "consolidacao" apagou quase tudo
            r = subprocess.run(["bash", str(plugin / "scripts/poke-ack.sh"), "ana", "reflection-2026-10-12"],
                               env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual((ws / "MEMORY.md").read_text(), memoria(20))
            log = (ws / ".dgclaw/logs/reflection.log").read_text()
            self.assertIn("PERDA", log)
            self.assertTrue((tmp / "aviso.txt").exists())
            # chave que nao e de reflexao nao confere nada
            (ws / "MEMORY.md").write_text(memoria(5))
            subprocess.run(["bash", str(plugin / "scripts/poke-ack.sh"), "ana", "heartbeat-2026-10-12"],
                           env=env, capture_output=True, text=True)
            self.assertEqual((ws / "MEMORY.md").read_text(), memoria(5))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ConsolidateDesligado(unittest.TestCase):
    """O consolidate.sh fica DESLIGADO na v1: nada que instala ou sobe o agente pode cita-lo.
    A consolidacao de verdade e a reflexao noturna (reflection.sh), que tem a copia de
    seguranca. Se alguem religar o consolidate, este teste falha e obriga a decidir de novo."""

    ALVOS = ["install.sh", "bin/dgclaw", "scripts/install-timers.sh"]
    PROIBIDO = re.compile(r"install-consolidate-timer|consolidate\.sh")

    def _arquivos(self):
        arqs = [RAIZ / a for a in self.ALVOS]
        arqs += sorted((RAIZ / "lib").glob("*.sh"))
        for base in (RAIZ / "container", RAIZ / "runner" / "src"):
            if base.is_dir():
                for p in sorted(base.rglob("*")):
                    if p.is_file() and "node_modules" not in p.parts:
                        try:
                            p.read_text(encoding="utf-8")
                        except (UnicodeDecodeError, OSError):
                            continue
                        arqs.append(p)
        return arqs

    def test_nada_instala_o_consolidate(self):
        achados = []
        for p in self._arquivos():
            if not p.is_file():
                continue
            for n, linha in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                if not self.PROIBIDO.search(linha):
                    continue
                # unica citacao permitida: a linha que DESLIGA o timer antigo no install-timers
                if p.name == "install-timers.sh" and re.search(r"disable|stop|rm |remove|desliga", linha):
                    continue
                achados.append(f"{p.relative_to(RAIZ)}:{n}: {linha.strip()}")
        self.assertEqual(achados, [], "o consolidate.sh foi religado? " + "; ".join(achados))

    def test_consolidate_tem_a_rede_de_seguranca(self):
        t = (SCRIPTS / "consolidate.sh").read_text(encoding="utf-8")
        self.assertIn("memoria_guarda.py", t)
        self.assertLess(t.index('guardar --ws'), t.index('--print'))
        self.assertGreater(t.index('conferir --ws'), t.index('--print'))


if __name__ == "__main__":
    unittest.main()
