#!/usr/bin/env python3
"""ig-publish.py (DG Claw) — Publica no Instagram via Graph API. Generico.

ZERO id hardcoded: a conta IG, o token e os parametros vem dos argumentos /
do instagram.json. Usa apenas stdlib + requests (ja comum no projeto).

Subcomandos:
  publish-image  --account <ig-id> --image-url <url> --caption <txt> --token-file <path>
      Fluxo de 2 passos da Graph API:
        1. POST /{ig-id}/media          (cria container com image_url + caption)
        2. POST /{ig-id}/media_publish  (publica o container -> creation_id)
      Imprime JSON com o id do post publicado.

  reply-comment  --comment-id <id> --message <txt> --token-file <path>
      POST /{comment-id}/replies  (responde um comentario)

  validate       --token-file <path>
      GET /me  — valida o token antes de salvar. rc 0 = ok, rc 1 = invalido.

Notas:
  - O token NUNCA e logado nem impresso. So o resultado da API.
  - Erros da Graph API sao reportados com mensagem clara (codigo + message).
  - --caption / --message podem vir tambem de --caption-file / --message-file
    (evita problemas de shell quoting com textos longos/multilinha).
"""

import argparse
import json
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERRO: a lib 'requests' nao esta instalada (pip install requests).", file=sys.stderr)
    sys.exit(2)

GRAPH = "https://graph.facebook.com/v21.0"


def read_token(token_file):
    p = Path(token_file).expanduser()
    if not p.exists():
        print(f"ERRO: token nao encontrado em {p}", file=sys.stderr)
        sys.exit(2)
    tok = p.read_text(encoding="utf-8").strip()
    if not tok:
        print(f"ERRO: token vazio em {p}", file=sys.stderr)
        sys.exit(2)
    return tok


def _text_arg(inline, file_arg):
    """Resolve um texto: prioriza --X-file (conteudo do arquivo) sobre --X inline."""
    if file_arg:
        return Path(file_arg).expanduser().read_text(encoding="utf-8").rstrip("\n")
    return inline or ""


def _graph_error(resp):
    """Extrai mensagem de erro legivel da resposta da Graph API."""
    try:
        err = resp.json().get("error", {})
        msg = err.get("message", resp.text[:300])
        code = err.get("code", resp.status_code)
        sub = err.get("error_user_msg") or ""
        return f"Graph API erro {code}: {msg}" + (f" | {sub}" if sub else "")
    except (ValueError, json.JSONDecodeError):
        return f"HTTP {resp.status_code}: {resp.text[:300]}"


def publish_image(account, image_url, caption, token, wait=2):
    # Passo 1: criar container
    r1 = requests.post(
        f"{GRAPH}/{account}/media",
        data={"image_url": image_url, "caption": caption, "access_token": token},
        timeout=60,
    )
    if r1.status_code != 200:
        print(_graph_error(r1), file=sys.stderr)
        sys.exit(1)
    creation_id = r1.json().get("id")
    if not creation_id:
        print(f"ERRO: container sem id na resposta: {r1.text[:300]}", file=sys.stderr)
        sys.exit(1)

    # Passo 2: publicar o container. Pequena espera pro IG processar a imagem.
    time.sleep(wait)
    r2 = requests.post(
        f"{GRAPH}/{account}/media_publish",
        data={"creation_id": creation_id, "access_token": token},
        timeout=60,
    )
    if r2.status_code != 200:
        print(_graph_error(r2), file=sys.stderr)
        sys.exit(1)
    media_id = r2.json().get("id")
    out = {"ok": True, "creationId": creation_id, "mediaId": media_id}

    # Tenta resolver a permalink (best-effort; nao falha se nao vier)
    try:
        rp = requests.get(
            f"{GRAPH}/{media_id}",
            params={"fields": "permalink", "access_token": token},
            timeout=30,
        )
        if rp.status_code == 200:
            out["permalink"] = rp.json().get("permalink")
    except requests.RequestException:
        pass

    print(json.dumps(out, ensure_ascii=False))
    return 0


def reply_comment(comment_id, message, token):
    r = requests.post(
        f"{GRAPH}/{comment_id}/replies",
        data={"message": message, "access_token": token},
        timeout=60,
    )
    if r.status_code != 200:
        print(_graph_error(r), file=sys.stderr)
        sys.exit(1)
    reply_id = r.json().get("id")
    print(json.dumps({"ok": True, "replyId": reply_id, "commentId": comment_id}, ensure_ascii=False))
    return 0


def validate(token):
    r = requests.get(f"{GRAPH}/me", params={"access_token": token}, timeout=30)
    if r.status_code != 200:
        print(_graph_error(r), file=sys.stderr)
        sys.exit(1)
    data = r.json()
    # Nao imprime o token, so id/name retornados pelo /me
    print(json.dumps({"ok": True, "id": data.get("id"), "name": data.get("name")}, ensure_ascii=False))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Publica no Instagram via Graph API (DG Claw).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("publish-image")
    p1.add_argument("--account", required=True, help="igAccountId (Instagram Business id)")
    p1.add_argument("--image-url", required=True, help="URL publica da imagem (jpg/png)")
    p1.add_argument("--caption", default="")
    p1.add_argument("--caption-file", default=None)
    p1.add_argument("--token-file", required=True)

    p2 = sub.add_parser("reply-comment")
    p2.add_argument("--comment-id", required=True)
    p2.add_argument("--message", default="")
    p2.add_argument("--message-file", default=None)
    p2.add_argument("--token-file", required=True)

    p3 = sub.add_parser("validate")
    p3.add_argument("--token-file", required=True)

    args = ap.parse_args()
    token = read_token(args.token_file)

    if args.cmd == "publish-image":
        caption = _text_arg(args.caption, args.caption_file)
        return publish_image(args.account, args.image_url, caption, token)
    if args.cmd == "reply-comment":
        message = _text_arg(args.message, args.message_file)
        if not message.strip():
            print("ERRO: mensagem de resposta vazia.", file=sys.stderr)
            sys.exit(2)
        return reply_comment(args.comment_id, message, token)
    if args.cmd == "validate":
        return validate(token)


if __name__ == "__main__":
    sys.exit(main() or 0)
