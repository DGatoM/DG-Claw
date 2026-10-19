#!/usr/bin/env python3
"""Analisa um video com o Gemini (plano gratuito) usando so requests.

Uso: analisar_video.py <arquivo-ou-url> "pergunta"
  - link do YouTube publico: o Gemini le direto, sem baixar
  - outro link: baixa com yt-dlp
  - arquivo: envia pela File API, espera ficar pronto, analisa e apaga no fim
Le GEMINI_API_KEY do ambiente. A chave nunca e impressa.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import requests

API = "https://generativelanguage.googleapis.com"
MODELO = "gemini-2.5-flash"
UA = {"User-Agent": "DGClaw/1.0"}


def falha(msg):
    print(f"ERRO: {msg}", file=sys.stderr)
    sys.exit(1)


def checa(r, o_que):
    if r.status_code < 300:
        return
    c = r.status_code
    if c == 429:
        falha(f"Limite gratuito do Gemini atingido ao {o_que} (HTTP 429). Espere alguns minutos (ou ate amanha) e tente de novo, ou use um video mais curto.")
    if c in (400, 401, 403) and re.search(r"API key|API_KEY|PERMISSION|credential", r.text, re.I):
        falha(f"O Gemini recusou a chave ao {o_que} (HTTP {c}). A chave esta errada ou foi apagada. Crie outra em https://aistudio.google.com/apikey e grave de novo.")
    falha(f"O Gemini respondeu HTTP {c} ao {o_que}: {r.text[:300].replace(chr(10), ' ')}")


def req(chave, metodo, url, o_que, **kw):
    h = dict(UA, **{"x-goog-api-key": chave}, **kw.pop("headers", {}))
    try:
        r = requests.request(metodo, url, headers=h, timeout=kw.pop("timeout", 120), **kw)
    except requests.RequestException as e:
        falha(f"Nao consegui falar com o Gemini ao {o_que} ({type(e).__name__}). Confira a internet e tente de novo.")
    checa(r, o_que)
    return r


def envia(chave, caminho):
    tam = os.path.getsize(caminho)
    mime = subprocess.run(["file", "-b", "--mime-type", caminho], capture_output=True, text=True).stdout.strip() or "video/mp4"
    ini = req(chave, "POST", f"{API}/upload/v1beta/files", "iniciar o envio do video",
              headers={"X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
                       "X-Goog-Upload-Header-Content-Length": str(tam),
                       "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json"},
              data=json.dumps({"file": {"display_name": os.path.basename(caminho)}}))
    url_up = ini.headers.get("x-goog-upload-url")
    if not url_up:
        falha("O Gemini nao devolveu o endereco de envio. Tente de novo.")
    with open(caminho, "rb") as f:
        up = req(chave, "POST", url_up, "enviar o video", timeout=900,
                 headers={"Content-Length": str(tam), "X-Goog-Upload-Offset": "0",
                          "X-Goog-Upload-Command": "upload, finalize"}, data=f)
    info = up.json()["file"]
    for _ in range(90):
        if info.get("state") == "ACTIVE":
            return info, mime
        if info.get("state") == "FAILED":
            falha("O Gemini nao conseguiu processar esse video. Tente outro formato (mp4).")
        time.sleep(4)
        info = req(chave, "GET", f"{API}/v1beta/{info['name']}", "consultar o video").json()
    falha("O Gemini demorou demais para processar o video. Tente um video mais curto.")


def main():
    if len(sys.argv) < 3:
        falha('Uso: analisar_video.py <arquivo-ou-url> "pergunta"')
    alvo, pergunta = sys.argv[1], " ".join(sys.argv[2:])
    chave = os.environ.get("GEMINI_API_KEY", "").strip()
    if not chave:
        falha("Nao encontrei a GEMINI_API_KEY. Ela ainda nao foi gravada no cofre do agente, ou o agente nao foi reiniciado depois de gravar. Siga a skill gemini-gratuito.")
    arquivo_api = None
    parte = None
    with tempfile.TemporaryDirectory() as tmp:
        if re.match(r"https?://(www\.|m\.)?(youtube\.com|youtu\.be)/", alvo):
            parte = {"file_data": {"file_uri": alvo}}
        else:
            caminho = alvo
            if re.match(r"https?://", alvo):
                r = subprocess.run(["yt-dlp", "-f", "mp4/best[height<=720]", "-o", os.path.join(tmp, "video.%(ext)s"), alvo],
                                   capture_output=True, text=True)
                achados = [x for x in os.listdir(tmp)]
                if r.returncode != 0 or not achados:
                    falha(f"Nao consegui baixar o video do link. O link pode ser privado ou nao ter video. Detalhe: {r.stderr.strip()[-200:]}")
                caminho = os.path.join(tmp, achados[0])
            if not os.path.isfile(caminho):
                falha(f"O arquivo {caminho} nao existe. Confira o caminho.")
            arquivo_api, mime = envia(chave, caminho)
            parte = {"file_data": {"mime_type": arquivo_api.get("mimeType", mime), "file_uri": arquivo_api["uri"]}}
        try:
            r = req(chave, "POST", f"{API}/v1beta/models/{MODELO}:generateContent", "analisar o video", timeout=300,
                    headers={"Content-Type": "application/json"},
                    data=json.dumps({"contents": [{"parts": [parte, {"text": pergunta}]}]}))
            cand = (r.json().get("candidates") or [{}])[0]
            texto = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
            if not texto:
                falha(f"O Gemini nao devolveu texto (motivo: {cand.get('finishReason', 'desconhecido')}). Reformule a pergunta ou tente outro video.")
            print(texto.strip())
        finally:
            if arquivo_api:
                try:
                    requests.delete(f"{API}/v1beta/{arquivo_api['name']}", headers=dict(UA, **{"x-goog-api-key": chave}), timeout=30)
                except requests.RequestException as e:
                    print(f"AVISO: nao consegui apagar o arquivo temporario {arquivo_api['name']} no Gemini: {e}. "
                          "Ele expira sozinho em cerca de 48 horas.", file=sys.stderr)


if __name__ == "__main__":
    main()
