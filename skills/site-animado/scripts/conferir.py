#!/usr/bin/env python3
"""Abre o site .html num navegador headless, rola a página e tira prints para o agente olhar.
Confere rolagem horizontal e erros de console, em desktop (1440) e celular (390).

Uso: python3 conferir.py caminho/do/site.html [--saida /tmp/conferir-site]
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
    ap.add_argument("--saida", default="/tmp/conferir-site")
    a = ap.parse_args()
    if not os.path.isfile(a.html):
        sys.exit(f"ERRO: arquivo não encontrado: {a.html}")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("ERRO: o módulo playwright não está instalado. Sem ele não dá para conferir; entregue o arquivo e avise que não foi testado visualmente.")
    os.makedirs(a.saida, exist_ok=True)
    erros, problemas = [], []
    with sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            sys.exit("ERRO: o navegador chromium do playwright não está instalado (rode: playwright install chromium). Detalhe: " + str(e).splitlines()[0])
        for nome, w, h, mobile in (("desktop", 1440, 900, False), ("mobile", 390, 844, True)):
            ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, is_mobile=mobile, has_touch=mobile)
            pg = ctx.new_page()
            pg.on("console", lambda m, n=nome: erros.append(f"[{n}] {m.text}") if m.type == "error" else None)
            pg.on("pageerror", lambda e, n=nome: erros.append(f"[{n}] {e}"))
            pg.goto(pathlib.Path(a.html).resolve().as_uri())
            pg.wait_for_timeout(800)
            total = pg.evaluate("document.documentElement.scrollHeight")
            sw = pg.evaluate("document.documentElement.scrollWidth")
            if sw > w + 1:
                culpado = pg.evaluate("""(w)=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>w+1&&!e.closest('.hero')).slice(0,5).map(e=>e.tagName.toLowerCase()+'.'+e.className)""", w)
                problemas.append(f"[{nome}] rolagem horizontal: página com {sw}px em tela de {w}px. Elementos que passam: {culpado}")
            y, i = 0, 0
            while y < total:
                pg.evaluate(f"window.scrollTo(0,{y})")
                pg.wait_for_timeout(1100)
                pg.screenshot(path=f"{a.saida}/{nome}-{i:02d}.png")
                y += int(h * 0.85); i += 1
                if i > 40: break
            print(f"{nome}: {i} prints, altura total {total}px")
            ctx.close()
        b.close()
    print(f"Prints em {a.saida}. Abra cada um e confira texto cortado, contraste, sobreposição e a seção sticky.")
    for pr in problemas: print("PROBLEMA:", pr)
    for e in erros: print("ERRO NO CONSOLE:", e)
    if problemas or erros: sys.exit(1)
    print("Sem rolagem horizontal e sem erros no console.")

if __name__ == "__main__":
    _autoembrulho()
    main()
