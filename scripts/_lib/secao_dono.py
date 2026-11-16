#!/usr/bin/env python3
"""secao_dono.py - protege a secao "Instrucoes do <dono>" do persona/working-memory.md.

POR QUE EXISTE. O cron de posts le essa secao e manda aplicar o que estiver nela, e roda com
permissao ampla. O cron de comentarios roda uma sessao que le texto de terceiros e precisa editar
o working-memory.md (secoes "Hoje", "Pessoas Proximas"...). Se um comentario convencesse a
sessao a escrever uma "instrucao do dono" falsa, o cron de posts a obedeceria. Este programa tira
uma foto da secao antes da sessao (guardar) e, depois, confere (conferir): se a secao mudou, a
versao original volta, a rejeitada fica guardada para o dono olhar e o programa sai com 3.

O QUE A SESSAO PODE FAZER NA SECAO. So acrescentar o marcador " [APLICADO 09h30]" no fim de uma
linha (o cron manda marcar a instrucao que ela aplicou). Qualquer outra mudanca (linha nova,
linha apagada, texto trocado, secao nova com esse titulo, secao removida) e desfeita.

Subcomandos:
  guardar  --arquivo <working-memory.md> --foto <arquivo-da-foto>
  conferir --arquivo <working-memory.md> --foto <arquivo-da-foto> [--rejeitadas <pasta>]

Saida: 0 ok (nada mudou, ou so marcadores) | 1 erro de leitura/escrita (a mensagem diz o motivo)
| 3 a secao foi alterada e foi restaurada.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime

TITULO = re.compile(r"^##\s+Instru[cç][oõ]es do\b", re.IGNORECASE)
QUALQUER_H2 = re.compile(r"^##\s")
MARCADOR = re.compile(r"[ \t]*\[APLICADO \d{1,2}h\d{2}\][ \t]*$")


def erro(msg):
    print(f"secao_dono: {msg}", file=sys.stderr)


def ler(caminho):
    try:
        with open(caminho, encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        erro(f"nao consegui ler {caminho}: {e}")
        sys.exit(1)


def blocos(texto):
    """Separa em blocos [(protegido, [linhas])]: cada secao 'Instrucoes do ...' e um bloco."""
    saida = []
    atual = []
    protegido = False
    for linha in texto.splitlines(keepends=True):
        if QUALQUER_H2.match(linha):
            if atual:
                saida.append((protegido, atual))
            atual = [linha]
            protegido = bool(TITULO.match(linha))
        else:
            atual.append(linha)
    if atual:
        saida.append((protegido, atual))
    return saida


def normaliza(linhas):
    """Tira o marcador [APLICADO ..] do fim das linhas e as brancas das pontas."""
    out = [MARCADOR.sub("", ln.rstrip("\r\n")).rstrip() for ln in linhas]
    while out and not out[-1]:
        out.pop()
    return out


def secoes(texto):
    return [b for p, b in blocos(texto) if p]


def guardar(arquivo, foto):
    texto = ler(arquivo)
    dados = {"secoes": ["".join(s) for s in secoes(texto)]}
    try:
        fd = os.open(foto, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False)
    except OSError as e:
        erro(f"nao consegui gravar a foto em {foto}: {e}")
        return 1
    return 0


def conferir(arquivo, foto, rejeitadas):
    try:
        orig = json.loads(ler(foto))["secoes"]
    except (ValueError, KeyError, TypeError) as e:
        erro(f"a foto {foto} esta ilegivel ({e}). Nao conferi a secao de instrucoes do dono; "
             "confira o working-memory.md na mao.")
        return 1
    texto = ler(arquivo)
    atuais = secoes(texto)
    n_orig = [normaliza(s.splitlines(keepends=True)) for s in orig]
    n_atual = [normaliza(s) for s in atuais]
    if n_orig == n_atual:
        return 0

    # Mudou: guarda a versao rejeitada e reconstroi o arquivo com as secoes originais.
    try:
        os.makedirs(rejeitadas, mode=0o700, exist_ok=True)
        marca = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        destino = os.path.join(rejeitadas, f"instrucoes-rejeitadas-{marca}.txt")
        fd = os.open(destino, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("".join("".join(s) + "\n----\n" for s in atuais))
    except OSError as e:
        erro(f"nao consegui guardar a versao rejeitada em {rejeitadas}: {e}")
        return 1

    novo = []
    i = 0
    for protegido, b in blocos(texto):
        if not protegido:
            novo.append("".join(b))
            continue
        if i < len(orig):
            novo.append(orig[i])
        i += 1  # secao a mais (ou a mesma ja restaurada): descartada
    resto = orig[len([1 for p, _ in blocos(texto) if p]):]
    if resto:  # a sessao apagou uma secao: ela volta no fim
        if novo and not novo[-1].endswith("\n"):
            novo[-1] += "\n"
        novo.extend(resto)
    try:
        tmp = arquivo + ".tmp-secao-dono"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("".join(novo))
        os.replace(tmp, arquivo)
    except OSError as e:
        erro(f"nao consegui restaurar a secao em {arquivo}: {e}")
        return 1
    erro(f"a secao 'Instrucoes do dono' mudou durante a sessao e foi restaurada. "
         f"A versao rejeitada esta em {destino}.")
    return 3


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("guardar")
    g.add_argument("--arquivo", required=True)
    g.add_argument("--foto", required=True)
    c = sub.add_parser("conferir")
    c.add_argument("--arquivo", required=True)
    c.add_argument("--foto", required=True)
    c.add_argument("--rejeitadas", default=None)
    a = ap.parse_args()
    if a.cmd == "guardar":
        return guardar(a.arquivo, a.foto)
    rej = a.rejeitadas or os.path.join(os.path.dirname(os.path.abspath(a.arquivo)), "..", "data", "rejeitadas")
    return conferir(a.arquivo, a.foto, os.path.normpath(rej))


if __name__ == "__main__":
    sys.exit(main())
