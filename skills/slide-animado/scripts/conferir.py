#!/usr/bin/env python3
"""Abre o deck .html num navegador headless, avança cada passo (bullets e telas)
e tira prints em /tmp/conferir-slide para o agente olhar.

Uso: python3 conferir.py caminho/do/deck.html [--saida /tmp/conferir-slide] [--flip]
  --flip  força o fallback FLIP (simula navegador sem View Transitions)
"""
import argparse, os, shutil, sys, pathlib

def _autoembrulho():
    # Reexecuta este script sob o dgclaw-pesado (cgroup próprio com teto de memória e de tempo):
    # se a conferência estourar, morre só ele, e o que sobrar dele (Chrome headless) é recolhido.
    if os.environ.get("DGCLAW_PESADO"):
        return
    exe = shutil.which("dgclaw-pesado")
    if not exe:
        return
    args = [exe]
    if not os.environ.get("DGCLAW_PESADO_TIMEOUT"):
        args += ["--timeout", "600"]
    # Reexecuta ESTE arquivo (não o programa que o chamou) e mantém as opções de isolamento do interpretador.
    if sys.flags.isolated:
        opcoes = ["-I"]
    else:
        opcoes = [o for o, ligada in (("-E", sys.flags.ignore_environment), ("-s", sys.flags.no_user_site),
                                      ("-P", getattr(sys.flags, "safe_path", False))) if ligada]
    os.execv(exe, args + ["--", sys.executable, *opcoes, os.path.abspath(__file__), *sys.argv[1:]])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--saida", default="/tmp/conferir-slide")
    ap.add_argument("--flip", action="store_true")
    a = ap.parse_args()
    if not os.path.isfile(a.html):
        sys.exit(f"ERRO: arquivo não encontrado: {a.html}")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("ERRO: o módulo playwright não está instalado. Sem ele não dá para conferir; entregue o arquivo e avise que não foi testado visualmente.")
    os.makedirs(a.saida, exist_ok=True)
    erros = []
    with sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            sys.exit("ERRO: o navegador chromium do playwright não está instalado (rode: playwright install chromium). Detalhe: " + str(e).splitlines()[0])
        pg = b.new_page(viewport={"width": 1280, "height": 720})
        pg.on("console", lambda m: erros.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: erros.append(str(e)))
        pg.goto(pathlib.Path(a.html).resolve().as_uri())
        pg.wait_for_timeout(600)
        if a.flip:
            pg.evaluate("window.__deck && window.__deck.forceFlip()")
        total = pg.evaluate("document.querySelectorAll('.slide').length")
        print(f"{total} telas. Modo de transição: {pg.evaluate('window.__deck ? window.__deck.mode() : \"?\"')}")
        n = 0
        pg.screenshot(path=f"{a.saida}/{n:02d}.png"); n += 1
        while True:
            antes = pg.evaluate("window.__deck.cur")
            pg.keyboard.press("Space")
            pg.wait_for_timeout(1300)
            pg.screenshot(path=f"{a.saida}/{n:02d}.png"); n += 1
            depois = pg.evaluate("window.__deck.cur")
            if depois == antes and pg.evaluate("window.__deck.cur") == total - 1:
                # pode ter bullets restantes; para quando 2 prints seguidos forem iguais
                if n > 2 and open(f"{a.saida}/{n-1:02d}.png","rb").read() == open(f"{a.saida}/{n-2:02d}.png","rb").read():
                    os.remove(f"{a.saida}/{n-1:02d}.png"); n -= 1
                    break
            if n > 60: break
        b.close()
    print(f"{n} prints em {a.saida} (00.png em diante). Abra cada um e confira o texto cortado, o contraste e o alinhamento.")
    if erros:
        print("ERROS NO CONSOLE:"); [print(" -", e) for e in erros]; sys.exit(1)
    print("Sem erros no console.")

if __name__ == "__main__":
    _autoembrulho()
    main()
