#!/usr/bin/env python3
"""transcribe.py — Transcreve audio para texto. Multi-provider, sem dependencia externa.

NB: gemeo de scripts/transcribe.py (modo SERVIDOR). O modo LOCAL copia
local/scripts/ inteiro pro .dgclaw/scripts/ do agente (cópia estável, mesmo
padrao de hooks/panel). Mexeu num, espelhe no outro.

Uso:  transcribe.py <arquivo-de-audio> [--provider auto|gemini|openai|groq|elevenlabs|local]

Provider "auto" (default) escolhe o primeiro disponivel na ordem:
  gemini -> groq -> openai -> elevenlabs -> local (faster-whisper)

Config por env:
  TRANSCRIBE_PROVIDER   forca um provider
  TRANSCRIBE_LANG       idioma (default pt)
  GEMINI_API_KEY / GOOGLE_API_KEY
  OPENAI_API_KEY, GROQ_API_KEY, ELEVENLABS_API_KEY

Saida: transcricao em stdout. Erro -> stderr + exit != 0.
"""
import base64
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

LANG = os.environ.get("TRANSCRIBE_LANG", "pt")
PROMPT = (
    f"Transcreva este audio em {'portugues do Brasil' if LANG == 'pt' else LANG}, "
    "verbatim, sem resumir e sem comentarios. Retorne APENAS a transcricao."
)
# Telegram voice = ogg/opus. Convertemos p/ mp3 mono 16k: aceito por todos os
# providers e ~10x menor que wav (importa no inline_data base64 do Gemini).
TARGET_SR = "16000"


def log(msg):
    sys.stderr.write(f"[transcribe] {msg}\n")


def to_mp3(src):
    """Converte qualquer audio p/ mp3 mono 16kHz. Retorna path (tempfile)."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg nao encontrado (apt install ffmpeg)")
    out = tempfile.mktemp(suffix=".mp3")
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ar", TARGET_SR, "-ac", "1", "-b:a", "32k", out],
        capture_output=True,
    )
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError(f"ffmpeg falhou: {r.stderr.decode()[-400:]}")
    return out


# O Cloudflare da Groq bloqueia o User-Agent default do urllib ("Python-urllib/3.x")
# com 403 "error code: 1010" — assinatura de cliente. curl passa, urllib nao. Um UA
# qualquer resolve. Inofensivo nos outros providers, entao vai em todo request.
UA = "dgclaw-transcribe/1.0"


def _post(url, data, headers, timeout=180):
    headers = {"User-Agent": UA, **headers}
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()[:400]}")


def _multipart(fields, filepath, filefield="file"):
    """Monta body multipart/form-data. Retorna (body, content_type)."""
    boundary = "----transcribe" + base64.b16encode(os.urandom(8)).decode()
    body = b""
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    name = os.path.basename(filepath)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    body += (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{filefield}\"; "
        f"filename=\"{name}\"\r\nContent-Type: {ctype}\r\n\r\n".encode()
    )
    body += open(filepath, "rb").read() + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


# ---------------------------------------------------------------- providers
def via_gemini(path):
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise RuntimeError("sem GEMINI_API_KEY")
    if key.startswith("vault:"):
        # O proxy do bunker resolve placeholders vault: só nas rotas dele; a API
        # do Google recusaria o literal. Ver reference_gemini_imagens_vps_proxy_vault.
        raise RuntimeError("GEMINI_API_KEY e um placeholder vault: (use a key real)")
    model = os.environ.get("TRANSCRIBE_GEMINI_MODEL", "gemini-2.5-flash")
    mp3 = to_mp3(path)
    try:
        b = base64.b64encode(open(mp3, "rb").read()).decode()
        payload = {
            "contents": [{"parts": [
                {"text": PROMPT},
                {"inline_data": {"mime_type": "audio/mp3", "data": b}},
            ]}]
        }
        d = _post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
            json.dumps(payload).encode(),
            {"Content-Type": "application/json"},
        )
        return d["candidates"][0]["content"]["parts"][0]["text"].strip()
    finally:
        os.path.exists(mp3) and os.unlink(mp3)


def _whisper_http(path, url, key, model):
    mp3 = to_mp3(path)
    try:
        body, ctype = _multipart({"model": model, "language": LANG}, mp3)
        d = _post(url, body, {"Authorization": f"Bearer {key}", "Content-Type": ctype})
        return d["text"].strip()
    finally:
        os.path.exists(mp3) and os.unlink(mp3)


def via_openai(path):
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("sem OPENAI_API_KEY")
    return _whisper_http(
        path, "https://api.openai.com/v1/audio/transcriptions", key,
        os.environ.get("TRANSCRIBE_OPENAI_MODEL", "whisper-1"),
    )


def via_groq(path):
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("sem GROQ_API_KEY")
    return _whisper_http(
        path, "https://api.groq.com/openai/v1/audio/transcriptions", key,
        os.environ.get("TRANSCRIBE_GROQ_MODEL", "whisper-large-v3-turbo"),
    )


def via_elevenlabs(path):
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError("sem ELEVENLABS_API_KEY")
    mp3 = to_mp3(path)
    try:
        body, ctype = _multipart({"model_id": "scribe_v1"}, mp3)
        d = _post("https://api.elevenlabs.io/v1/speech-to-text", body,
                  {"xi-api-key": key, "Content-Type": ctype})
        return d["text"].strip()
    finally:
        os.path.exists(mp3) and os.unlink(mp3)


def via_local(path):
    """faster-whisper local: $0, roda em CPU. Requer `pip install faster-whisper`."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise RuntimeError("faster-whisper nao instalado (pip install faster-whisper)")
    size = os.environ.get("TRANSCRIBE_LOCAL_MODEL", "small")
    m = WhisperModel(size, device="cpu", compute_type="int8")
    segs, _ = m.transcribe(path, language=LANG, vad_filter=True)
    return " ".join(s.text.strip() for s in segs).strip()


PROVIDERS = {
    "gemini": via_gemini, "openai": via_openai, "groq": via_groq,
    "elevenlabs": via_elevenlabs, "local": via_local,
}
AUTO_ORDER = ["gemini", "groq", "openai", "elevenlabs", "local"]


def main():
    # Parser na mao (sem argparse) pra manter a saida de erro curta e em pt.
    # Aceita: --provider X | --provider=X, em qualquer ordem vs. o arquivo.
    provider = os.environ.get("TRANSCRIBE_PROVIDER") or os.environ.get(
        "DGCLAW_TRANSCRIBE_PROVIDER", "auto"
    )
    positional = []
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--provider":
            if i + 1 >= len(argv):
                sys.exit("--provider exige um valor")
            provider = argv[i + 1]
            i += 2
        elif a.startswith("--provider="):
            provider = a.split("=", 1)[1]
            i += 1
        elif a in ("-h", "--help"):
            sys.exit(__doc__)
        elif a.startswith("--"):
            sys.exit(f"opcao desconhecida: {a}")
        else:
            positional.append(a)
            i += 1

    if not positional:
        sys.exit(__doc__)
    path = positional[0]
    if not os.path.exists(path):
        sys.exit(f"arquivo nao encontrado: {path}")

    order = AUTO_ORDER if provider == "auto" else [provider]
    errs = []
    for name in order:
        fn = PROVIDERS.get(name)
        if not fn:
            sys.exit(f"provider desconhecido: {name} (use: {', '.join(PROVIDERS)})")
        try:
            log(f"tentando {name}...")
            text = fn(path)
            if text:
                log(f"OK via {name} ({len(text)} chars)")
                print(text)
                return
            errs.append(f"{name}: resposta vazia")
        except Exception as e:
            errs.append(f"{name}: {e}")
            log(f"{name} falhou: {e}")
    sys.exit("todos os providers falharam:\n  " + "\n  ".join(errs))


if __name__ == "__main__":
    main()
