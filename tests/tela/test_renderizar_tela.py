#!/usr/bin/env python3
"""renderizar.py: usa o Chrome da Tela quando ele responde e cai no Chromium novo quando nao.

Sem navegador de verdade: o Playwright e trocado por um falso e a porta 9222 por um teste de resposta.
Uso: python3 tests/tela/test_renderizar_tela.py
"""
import importlib.util
import io
import os
import sys
import contextlib

AQUI = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(AQUI, "..", "..", "skills", "video-animado", "scripts", "renderizar.py")
spec = importlib.util.spec_from_file_location("renderizar", SCRIPT)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

falhas = 0


def confere(desc, cond):
    global falhas
    print(("  ok     " if cond else "  FALHOU ") + desc)
    if not cond:
        falhas += 1


class Chromium:
    def __init__(self, conecta_falha=False):
        self.chamadas = []
        self.conecta_falha = conecta_falha

    def connect_over_cdp(self, url):
        self.chamadas.append(("cdp", url))
        if self.conecta_falha:
            raise RuntimeError("conexao recusada\nlinha 2")
        return "nav-tela"

    def launch(self, **kw):
        self.chamadas.append(("launch", kw))
        return "nav-novo"


class P:
    def __init__(self, **kw):
        self.chromium = Chromium(**kw)


def roda(responde, sem_tela=None, **kw):
    r.tela_responde = lambda: responde
    os.environ.pop("DGCLAW_RENDER_SEM_TELA", None)
    if sem_tela:
        os.environ["DGCLAW_RENDER_SEM_TELA"] = sem_tela
    p = P(**kw)
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        res = r.abrir_navegador(p)
    return p.chromium.chamadas, res, err.getvalue()


c, res, e = roda(True)
confere("Tela responde: conecta por CDP no endereco fixo", c == [("cdp", "http://127.0.0.1:9222")])
confere("Tela responde: devolve o navegador da Tela marcado como da Tela", res == ("nav-tela", True))
confere("Tela responde: diz no stderr que usou a Tela", "usando o Chrome da Tela" in e)

c, res, e = roda(False)
confere("Tela muda: nao tenta conectar, abre Chromium novo", [x[0] for x in c] == ["launch"] and res == ("nav-novo", False))
confere("Tela muda: stderr diz o motivo", "nao respondeu" in e.replace("não", "nao"))

c, res, e = roda(True, conecta_falha=True)
confere("Conexao falha: cai no launch", [x[0] for x in c] == ["cdp", "launch"] and res == ("nav-novo", False))
confere("Conexao falha: stderr traz o detalhe", "conexao recusada" in e and "linha 2" not in e)

c, res, e = roda(True, sem_tela="1")
confere("DGCLAW_RENDER_SEM_TELA=1 forca o launch sem tentar a Tela", [x[0] for x in c] == ["launch"])

confere("o endereco da Tela e fixo no codigo", r.TELA_CDP == "http://127.0.0.1:9222")
os.environ.pop("DGCLAW_RENDER_SEM_TELA", None)

print(f"render-tela: {falhas} falha(s)")
sys.exit(1 if falhas else 0)
