#!/usr/bin/env python3
"""enviar_respostas.py - o cron envia as respostas que a sessao de comentarios DECIDIU.

A sessao roda sem Bash: ela so escreve data/rodada/respostas.json. Quem fala com o Instagram e
este programa, chamado pelo cron DEPOIS da sessao, e ele so o faz pelo responder-comentario.sh (que
confere id, carimbo do scrape, trava e reserva). Assim nada que esteja num comentario consegue
transformar a sessao em quem escolhe conta, token ou endereco.

Formato do arquivo:
  {"respostas": [
     {"commentId": "17900000001", "acao": "responder", "texto": "Obrigada!", "evento": "comment_positive"},
     {"commentId": "17900000002", "acao": "pular"}
  ]}
  acao: "responder" ou "pular". evento (opcional): so um destes: comment_positive, comment_neutral,
  comment_negative, comment_from_close, troll_comment.

Uso:  enviar_respostas.py --arquivo respostas.json --responder <responder-comentario.sh> [--ext-event <ext-event.sh>]
Saida (stdout, uma linha): enviadas=N puladas=N recusadas=N incertas=N
Codigo: 0 processou (mesmo com recusas) | 1 arquivo ilegivel ou formato invalido | 5 houve resultado INCERTO
(o Instagram pode ter publicado: a reserva do id fica em .replied_comments; confira na conta).
"""
import argparse
import json
import os
import re
import subprocess
import sys

ID_RE = re.compile(r"^[0-9]{5,30}$")
EVENTOS = {"comment_positive", "comment_neutral", "comment_negative", "comment_from_close", "troll_comment"}
MAX_ITENS = 200


def erro(msg):
    print(f"enviar_respostas: {msg}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arquivo", required=True)
    ap.add_argument("--responder", required=True)
    ap.add_argument("--ext-event", default=None)
    a = ap.parse_args()

    if not os.path.exists(a.arquivo):
        erro(f"a sessao nao gravou {a.arquivo}: nenhuma resposta a enviar nesta rodada.")
        print("enviadas=0 puladas=0 recusadas=0 incertas=0")
        return 0
    try:
        with open(a.arquivo, encoding="utf-8") as f:
            dados = json.load(f)
        itens = dados["respostas"]
        if not isinstance(itens, list):
            raise TypeError("'respostas' precisa ser uma lista")
    except (OSError, ValueError, KeyError, TypeError) as e:
        erro(f"{a.arquivo} esta ilegivel ou fora do formato ({e}). Nada foi enviado.")
        return 1
    if len(itens) > MAX_ITENS:
        erro(f"{len(itens)} itens em {a.arquivo}; processo so os {MAX_ITENS} primeiros. Os demais comentarios "
             "continuam pendentes e entram nas proximas rodadas.")
        itens = itens[:MAX_ITENS]

    cont = {"enviadas": 0, "puladas": 0, "recusadas": 0, "incertas": 0}
    # Valida o esquema de TODOS os itens antes de enviar qualquer um: um item malformado nao derruba o lote.
    validos = []
    for n, it in enumerate(itens, 1):
        if not isinstance(it, dict):
            erro(f"item {n}: nao e um objeto; ignorado.")
            cont["recusadas"] += 1
            continue
        cid, acao, texto, ev = it.get("commentId"), it.get("acao"), it.get("texto"), it.get("evento")
        if not isinstance(cid, str) or not ID_RE.match(cid):
            erro(f"item {n}: commentId invalido ({str(cid)[:40]!r}); ignorado.")
            cont["recusadas"] += 1
            continue
        if acao == "pular":
            cmd = ["bash", a.responder, "--pular", cid]
        elif acao == "responder" and isinstance(texto, str):
            try:
                texto.encode("utf-8")
            except UnicodeEncodeError:
                erro(f"item {n} ({cid}): o texto tem caractere que nao da para codificar em UTF-8; ignorado.")
                cont["recusadas"] += 1
                continue
            if "\x00" in texto:
                erro(f"item {n} ({cid}): o texto tem caractere nulo; ignorado.")
                cont["recusadas"] += 1
                continue
            cmd = ["bash", a.responder, cid, texto]
        else:
            erro(f"item {n} ({cid}): 'acao' precisa ser 'responder' (com 'texto' em texto) ou 'pular'; ignorado.")
            cont["recusadas"] += 1
            continue
        if ev is not None and not (isinstance(ev, str) and ev in EVENTOS):
            erro(f"item {n} ({cid}): 'evento' invalido; o evento foi ignorado, a resposta segue.")
            ev = None
        validos.append((n, cid, acao, cmd, ev))

    for n, cid, acao, cmd, ev in validos:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            erro(f"item {n} ({cid}): o envio passou de 5 minutos; resultado INCERTO. Confira na conta do Instagram.")
            cont["incertas"] += 1
            continue
        except (OSError, ValueError) as e:
            erro(f"item {n} ({cid}): nao consegui rodar o responder-comentario.sh ({e}); recusado.")
            cont["recusadas"] += 1
            continue
        saida = (r.stdout + r.stderr).strip().replace("\n", " ")[:400]
        if r.returncode == 0:
            cont["puladas" if acao == "pular" else "enviadas"] += 1
            if acao == "responder" and ev and a.ext_event:
                try:
                    subprocess.run(["bash", a.ext_event, ev], capture_output=True, text=True, timeout=60)
                except (OSError, subprocess.TimeoutExpired) as e:
                    erro(f"item {n} ({cid}): a resposta saiu, mas o evento {ev} nao foi anunciado ({e}).")
        elif r.returncode == 5:
            erro(f"item {n} ({cid}): {saida}")
            cont["incertas"] += 1
        else:
            erro(f"item {n} ({cid}) recusado (codigo {r.returncode}): {saida}")
            cont["recusadas"] += 1
    print(" ".join(f"{k}={v}" for k, v in cont.items()))
    return 5 if cont["incertas"] else 0


if __name__ == "__main__":
    sys.exit(main())
