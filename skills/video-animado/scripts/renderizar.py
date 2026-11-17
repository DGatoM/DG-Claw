#!/usr/bin/env python3
"""Renderiza uma composição HTML determinística em MP4 (H.264, 30 fps).

Uso: renderizar.py entrada.html saida.mp4 [--fps 30] [--largura N --altura N]

A página precisa expor:
  window.__duracao   duração em segundos
  window.__render(t) desenha o estado exato do instante t
  window.__tamanho   [largura, altura] (opcional se passar --largura/--altura)
"""
import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.request

# Chrome da Tela do agente. Endereço fixo de propósito: não vem de argumento nem de variável
# de ambiente, para o script não poder ser apontado para outro servidor.
TELA_CDP = "http://127.0.0.1:9222"


def tela_responde():
    """True se o Chrome da Tela do agente responde no CDP local (espera no máximo ~2 s)."""
    try:
        with urllib.request.urlopen(TELA_CDP + "/json/version", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def abrir_navegador(p):
    """Devolve (navegador, da_tela). Prefere o Chrome da Tela; senão abre um Chromium novo."""
    motivo = None
    if os.environ.get("DGCLAW_RENDER_SEM_TELA") == "1":
        motivo = "DGCLAW_RENDER_SEM_TELA=1 pediu para não usar o Chrome da Tela"
    elif not tela_responde():
        motivo = "o Chrome da Tela não respondeu em 127.0.0.1:9222"
    else:
        try:
            nav = p.chromium.connect_over_cdp(TELA_CDP)
            print("render: usando o Chrome da Tela (contexto próprio), sem abrir outro navegador.",
                  file=sys.stderr)
            return nav, True
        except Exception as e:
            detalhe = str(e).splitlines()[0] if str(e) else type(e).__name__
            motivo = f"não consegui conectar ao Chrome da Tela ({detalhe})"
    print(f"render: abrindo um Chromium novo, porque {motivo}.", file=sys.stderr)
    try:
        return p.chromium.launch(args=["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"]), False
    except Exception as e:
        erro("o Chromium do Playwright não está nesta caixa (ou não abriu). "
             "Rode: sudo -E /opt/venv/bin/python -m playwright install --with-deps chromium\n"
             f"Detalhe: {str(e).splitlines()[0]}")


def erro(msg):
    print(f"ERRO: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("entrada")
    ap.add_argument("saida")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--largura", type=int)
    ap.add_argument("--altura", type=int)
    a = ap.parse_args()

    if not os.path.isfile(a.entrada):
        erro(f"não achei o arquivo HTML '{a.entrada}'. Confira o caminho e rode de novo.")
    for prog in ("ffmpeg", "ffprobe"):
        if not shutil.which(prog):
            erro(f"'{prog}' não está instalado nesta caixa. Rode: sudo apt-get install -y ffmpeg")
    try:
        from playwright.sync_api import sync_playwright, Error as PWError
    except ImportError:
        erro("o módulo playwright não está neste Python. Use /opt/venv/bin/python scripts/renderizar.py ...")

    os.makedirs(os.path.dirname(os.path.abspath(a.saida)), exist_ok=True)
    t0 = time.time()

    with sync_playwright() as p:
        nav, da_tela = abrir_navegador(p)
        ctx = None
        try:
            # Abre primeiro num tamanho provisório só para ler window.__tamanho
            larg, alt = a.largura, a.altura
            ctx = nav.new_context(viewport={"width": larg or 1080, "height": alt or 1920})
            pag = ctx.new_page()
            erros_js = []
            pag.on("pageerror", lambda e: erros_js.append(str(e)))
            pag.goto("file://" + os.path.abspath(a.entrada))
            pag.evaluate("document.fonts.ready")
            if not (larg and alt):
                tam = pag.evaluate("window.__tamanho || null")
                if not tam:
                    erro("a página não define window.__tamanho e você não passou --largura/--altura. "
                         "Adicione 'window.__tamanho = [1080, 1920];' no HTML.")
                larg, alt = int(tam[0]), int(tam[1])
                pag.set_viewport_size({"width": larg, "height": alt})
                pag.evaluate("document.fonts.ready")
            if erros_js:
                erro("o JavaScript da página deu erro: " + erros_js[0] + ". Corrija o HTML e rode de novo.")

            ok = pag.evaluate("typeof window.__render === 'function' && typeof window.__duracao === 'number'")
            if not ok:
                erro("a página precisa definir window.__duracao (número, em segundos) e "
                     "window.__render(t) (função). Veja templates/composicao-base.html.")
            dur = float(pag.evaluate("window.__duracao"))
            if dur <= 0 or dur > 60:
                erro(f"window.__duracao vale {dur}; use entre 1 e 60 segundos (o ideal é 5 a 15).")
            total = round(dur * a.fps)

            ff = subprocess.Popen(
                ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(a.fps),
                 "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
                 "-pix_fmt", "yuv420p", "-movflags", "+faststart", a.saida],
                stdin=subprocess.PIPE)
            try:
                for i in range(total):
                    pag.evaluate("t => window.__render(t)", i / a.fps)
                    ff.stdin.write(pag.screenshot(type="jpeg", quality=95))
                    if (i + 1) % 30 == 0 or i + 1 == total:
                        print(f"quadro {i + 1}/{total} ({100 * (i + 1) // total}%)", flush=True)
            except BrokenPipeError:
                erro("o ffmpeg fechou no meio do render. Rode de novo; se repetir, confira o espaço em disco (df -h).")
            except PWError as e:
                ff.kill()
                erro(f"o navegador falhou no quadro {i}: {str(e).splitlines()[0]}. "
                     "Verifique o JavaScript de __render(t) e rode de novo.")
            finally:
                try:
                    ff.stdin.close()
                except Exception:
                    pass  # stdin do ffmpeg ja fechado (ele pode ter morrido); o wait() abaixo cobre o erro
            if ff.wait() != 0:
                erro("o ffmpeg terminou com erro ao gerar o MP4. Rode de novo e confira o espaço em disco.")
        finally:
            # No Chrome da Tela (que é do dono) fecha só o contexto criado aqui, nunca o navegador.
            if da_tela:
                if ctx is not None:
                    try:
                        ctx.close()
                    except Exception as e:
                        print(f"aviso: não consegui fechar o contexto do render: {e}", file=sys.stderr)
            else:
                nav.close()

    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", a.saida], capture_output=True, text=True)
    try:
        real = float(r.stdout.strip())
    except ValueError:
        erro("o ffprobe não conseguiu ler o MP4 gerado. Rode o render de novo.")
    if abs(real - dur) > 0.1:
        erro(f"a duração do MP4 ({real:.2f}s) não bate com a esperada ({dur:.2f}s). Rode de novo.")
    mb = os.path.getsize(a.saida) / 1e6
    print(f"\nPronto: {os.path.abspath(a.saida)}\nDuração: {real:.2f}s | {larg}x{alt} | {mb:.1f} MB | "
          f"render em {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
