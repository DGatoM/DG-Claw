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

  status         --aprovacao <id>
      So com DGCLAW_TRAVAS=1: consulta o estado de um pedido que esperava o TI.

Modo travado (versao empresa, DGCLAW_TRAVAS=1 no ambiente do agente):
  O token do Instagram NAO fica mais com o agente: ele mora num cofre do host. Este script entao nao
  chama a Graph API. Ele pede a acao pela caixa (dgclaw-api POST /api/v1/acoes/instagram), o TI aprova na
  tela de aprovacoes, e quem publica e o Web, no host. O script espera o resultado consultando a
  aprovacao (--espera, em segundos; padrao 600). Saidas: 0 publicado; 1 recusado, vencido ou falhou;
  3 ainda esperando o TI (o JSON traz o id; consulte depois com "status"). Sem DGCLAW_TRAVAS o
  comportamento e o de sempre. O --token-file continua aceito e e ignorado nesse modo.

Notas:
  - O token NUNCA e logado nem impresso. So o resultado da API.
  - Erros da Graph API sao reportados com mensagem clara (codigo + message).
  - --caption / --message podem vir tambem de --caption-file / --message-file
    (evita problemas de shell quoting com textos longos/multilinha).
"""

import argparse
import json
import os
import subprocess
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


# --- modo travado (DGCLAW_TRAVAS=1): a acao passa pela caixa e pela aprovacao do TI ----------------

def _travas_ligadas():
    return os.environ.get("DGCLAW_TRAVAS") == "1"


def _caixa(metodo, rota, corpo=None, espera=25):
    """Chama o Web pela caixa (dgclaw-api). Devolve (status_http, corpo_json). Erro de uso vira SystemExit com motivo."""
    cmd = [os.environ.get("DGCLAW_API_CMD", "dgclaw-api"), metodo, rota, "--com-status", "--espera", str(espera)]
    entrada = None
    if corpo is not None:
        cmd.append("-")
        entrada = json.dumps(corpo, ensure_ascii=False)
    try:
        r = subprocess.run(cmd, input=entrada, capture_output=True, text=True, timeout=espera + 15)
    except FileNotFoundError:
        print("ERRO: o comando dgclaw-api nao foi encontrado neste container. Peca ao dono para rodar 'dgclaw agente reparar <seu-slug>'.", file=sys.stderr)
        sys.exit(2)
    except subprocess.TimeoutExpired:
        print("ERRO: o Web nao respondeu a tempo pela caixa. Tente de novo em instantes; se persistir, avise o dono.", file=sys.stderr)
        sys.exit(2)
    try:
        resp = json.loads(r.stdout)
        return int(resp["status"]), resp.get("corpo") or {}
    except (ValueError, KeyError, TypeError):
        detalhe = (r.stderr or r.stdout or "sem resposta").strip()[:300]
        print(f"ERRO: a caixa respondeu algo que nao entendi (codigo {r.returncode}): {detalhe}", file=sys.stderr)
        sys.exit(2)


def _travas_espera_padrao():
    try:
        return max(0, int(os.environ.get("DGCLAW_IG_ESPERA", "600")))
    except ValueError:
        return 600


def _travas_consultar(aprovacao_id):
    status, corpo = _caixa("GET", f"/api/v1/aprovacoes/{aprovacao_id}")
    if status != 200:
        print(f"ERRO: nao consegui consultar o pedido {aprovacao_id} ({status}): {corpo.get('erro', 'sem detalhe')}", file=sys.stderr)
        sys.exit(1)
    return corpo.get("aprovacao") or {}


def _travas_concluir(ap):
    """Imprime o desfecho de um pedido e devolve o codigo de saida. None = ainda pendente."""
    estado = ap.get("estado")
    resultado = ap.get("resultado") or {}
    if estado == "executada":
        print(json.dumps({"ok": True, "aprovacao": ap.get("id"), "mediaId": resultado.get("media_id"),
                          "permalink": resultado.get("permalink"), "replyId": resultado.get("reply_id"),
                          "saida": resultado.get("saida")}, ensure_ascii=False))
        return 0
    if estado == "recusada":
        motivo = resultado.get("motivo") or "sem motivo informado"
        print(f"ERRO: o TI recusou o pedido ({motivo}). Nada foi publicado. Nao repita sem falar com o dono.", file=sys.stderr)
        return 1
    if estado == "expirada":
        print("ERRO: o pedido venceu (24 horas sem decisao do TI). Nada foi publicado. Peca de novo se ainda fizer sentido.", file=sys.stderr)
        return 1
    if estado == "falhou":
        print(f"ERRO: o TI aprovou, mas a publicacao falhou: {resultado.get('erro', 'sem detalhe')}. Nao repita as cegas: confira no Instagram.", file=sys.stderr)
        return 1
    return None


def _travas_pedir(corpo, espera):
    status, resp = _caixa("POST", "/api/v1/acoes/instagram", corpo)
    if status != 202 or not resp.get("aprovacao"):
        print(f"ERRO: o Web recusou o pedido ({status}): {resp.get('erro', 'sem detalhe')}", file=sys.stderr)
        sys.exit(1)
    ident = resp["aprovacao"]
    print(f"Pedido {ident} enviado ao TI (aprovacao em /aprovacoes). Esperando ate {espera} s pela decisao.", file=sys.stderr)
    fim = time.time() + espera
    while True:
        ap = _travas_consultar(ident)
        codigo = _travas_concluir(ap)
        if codigo is not None:
            return codigo
        if time.time() >= fim:
            print(json.dumps({"ok": False, "pendente": True, "aprovacao": ident,
                              "mensagem": f"O TI ainda nao decidiu. Consulte depois com: ig-publish.py status --aprovacao {ident}"}, ensure_ascii=False))
            return 3
        time.sleep(min(15, max(1, fim - time.time())))


def _travas_main(args):
    if args.cmd == "status":
        codigo = _travas_concluir(_travas_consultar(args.aprovacao))
        if codigo is None:
            print(json.dumps({"ok": False, "pendente": True, "aprovacao": args.aprovacao}))
            return 3
        return codigo
    if args.cmd == "validate":
        print("O token do Instagram fica no cofre do host, entao daqui nao da para validar. Peca ao TI: dgclaw acoes instagram testar <seu-slug>", file=sys.stderr)
        return 1
    espera = args.espera if args.espera is not None else _travas_espera_padrao()
    if args.cmd == "publish-image":
        legenda = _text_arg(args.caption, args.caption_file)
        return _travas_pedir({"op": "publicar", "conta": args.account, "legenda": legenda, "imagem_url": args.image_url}, espera)
    mensagem = _text_arg(args.message, args.message_file)
    if not mensagem.strip():
        print("ERRO: mensagem de resposta vazia.", file=sys.stderr)
        return 2
    return _travas_pedir({"op": "responder", "comentario_id": args.comment_id, "mensagem": mensagem}, espera)


def main():
    ap = argparse.ArgumentParser(description="Publica no Instagram via Graph API (DG Claw).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("publish-image")
    p1.add_argument("--account", required=True, help="igAccountId (Instagram Business id)")
    p1.add_argument("--image-url", required=True, help="URL publica da imagem (jpg/png)")
    p1.add_argument("--caption", default="")
    p1.add_argument("--caption-file", default=None)
    p1.add_argument("--token-file", required=not _travas_ligadas())
    p1.add_argument("--espera", type=int, default=None, help="so no modo travado: segundos esperando o TI (padrao 600)")

    p2 = sub.add_parser("reply-comment")
    p2.add_argument("--comment-id", required=True)
    p2.add_argument("--message", default="")
    p2.add_argument("--message-file", default=None)
    p2.add_argument("--token-file", required=not _travas_ligadas())
    p2.add_argument("--espera", type=int, default=None, help="so no modo travado: segundos esperando o TI (padrao 600)")

    p3 = sub.add_parser("validate")
    p3.add_argument("--token-file", required=not _travas_ligadas())

    p4 = sub.add_parser("status")
    p4.add_argument("--aprovacao", required=True, help="id do pedido que esperava o TI (modo travado)")

    args = ap.parse_args()
    if _travas_ligadas():
        return _travas_main(args)
    if args.cmd == "status":
        print("ERRO: 'status' so existe no modo travado (DGCLAW_TRAVAS=1).", file=sys.stderr)
        return 2
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
