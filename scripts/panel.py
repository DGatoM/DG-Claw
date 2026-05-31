#!/usr/bin/env python3
"""panel.py — Mini painel web do DG Claw pra ver/editar a memoria.

Sem dependencias (so Python padrao). Mostra MEMORY.md, working-memory.md e as
notas em memory/*.md em caixas de texto editaveis. Salvar grava DIRETO no
arquivo original. Sem boneco, sem firula — so a memoria.

Env:
  DGCLAW_WORKSPACE   diretorio do assistente (obrigatorio)
  DGCLAW_NAME        nome exibido no topo (opcional)
  DGCLAW_PANEL_PORT  porta (default 8200)
  DGCLAW_PANEL_TOKEN token de acesso (?t=TOKEN). Se vazio, libera sem token
                     (use so atras de firewall/rede confiavel).

Uso:  DGCLAW_WORKSPACE=~/dgclaw/tina DGCLAW_PANEL_TOKEN=abc python3 panel.py
Abrir: http://SEU_IP:8200/?t=abc
"""
import html
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

WS = Path(os.environ.get("DGCLAW_WORKSPACE", ".")).expanduser().resolve()
NAME = os.environ.get("DGCLAW_NAME", "DG Claw")
PORT = int(os.environ.get("DGCLAW_PANEL_PORT", "8200"))
TOKEN = os.environ.get("DGCLAW_PANEL_TOKEN", "")


def editable_files():
    """Lista de arquivos editaveis (caminhos relativos ao workspace)."""
    files = []
    for name in ("working-memory.md", "MEMORY.md"):
        if (WS / name).exists():
            files.append(name)
    md = WS / "memory"
    if md.exists():
        for p in sorted(md.glob("*.md")):
            files.append(f"memory/{p.name}")
    return files


def safe_path(rel: str) -> Path | None:
    """Resolve um caminho relativo e garante que esta dentro do workspace e
    e um .md permitido (anti path-traversal)."""
    if not rel or rel.startswith("/") or ".." in rel:
        return None
    if not rel.endswith(".md"):
        return None
    p = (WS / rel).resolve()
    try:
        p.relative_to(WS)
    except ValueError:
        return None
    if rel in ("working-memory.md", "MEMORY.md") or rel.startswith("memory/"):
        return p
    return None


PAGE = """<!doctype html><html lang=pt-br><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>Memoria — {name}</title>
<style>
 body{{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:18px;background:#0f1115;color:#e6e6e6}}
 h1{{font-size:20px}} h2{{font-size:15px;margin:22px 0 6px;color:#8ab4f8}}
 .hint{{color:#9aa;font-size:13px;margin:-2px 0 14px}}
 textarea{{width:100%;box-sizing:border-box;min-height:200px;background:#171a21;color:#e6e6e6;
   border:1px solid #2a2f3a;border-radius:8px;padding:10px;font:13px/1.5 ui-monospace,monospace}}
 button{{background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer;margin-top:8px}}
 .ok{{color:#7fdc8f}} .file{{margin-bottom:8px}}
</style></head><body>
<h1>🧠 Memoria do {name}</h1>
<p class=hint>Edite e clique em <b>Salvar</b>. Grava direto no arquivo. As mudancas
valem na proxima conversa (a sessao do bot le esses arquivos).</p>
{saved}
{blocks}
</body></html>"""

BLOCK = """<form method=post action="/save?t={tok}">
<h2>{title}</h2>
<input type=hidden name=file value="{file}">
<textarea name=content spellcheck=false>{content}</textarea>
<button type=submit>Salvar {file}</button>
</form>"""


class H(BaseHTTPRequestHandler):
    def _auth(self, q):
        if not TOKEN:
            return True
        return q.get("t", [""])[0] == TOKEN

    def _deny(self):
        self.send_response(403); self.end_headers()
        self.wfile.write(b"403 - token invalido (use ?t=SEU_TOKEN)")

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if not self._auth(q):
            return self._deny()
        if u.path not in ("/", ""):
            self.send_response(404); self.end_headers(); return
        saved = ""
        if q.get("saved"):
            saved = f"<p class=ok>✓ {html.escape(q['saved'][0])} salvo.</p>"
        blocks = ""
        for rel in editable_files():
            p = safe_path(rel)
            content = p.read_text(encoding="utf-8") if p and p.exists() else ""
            title = {"working-memory.md": "Curto prazo (working-memory)",
                     "MEMORY.md": "Longo prazo (MEMORY)"}.get(rel, rel)
            blocks += BLOCK.format(tok=html.escape(TOKEN), title=html.escape(title),
                                   file=html.escape(rel), content=html.escape(content))
        body = PAGE.format(name=html.escape(NAME), saved=saved, blocks=blocks)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if not self._auth(q):
            return self._deny()
        if u.path != "/save":
            self.send_response(404); self.end_headers(); return
        length = int(self.headers.get("Content-Length", 0))
        data = parse_qs(self.rfile.read(length).decode("utf-8"))
        rel = data.get("file", [""])[0]
        content = data.get("content", [""])[0]
        p = safe_path(rel)
        if not p:
            self.send_response(400); self.end_headers()
            self.wfile.write(b"arquivo invalido"); return
        p.write_text(content.replace("\r\n", "\n"), encoding="utf-8")
        self.send_response(303)
        self.send_header("Location", f"/?t={TOKEN}&saved={rel}")
        self.end_headers()

    def log_message(self, *a):
        pass


def main():
    if not WS.exists():
        raise SystemExit(f"workspace nao existe: {WS}")
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    print(f"painel DG Claw em http://0.0.0.0:{PORT}/  (workspace: {WS})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
