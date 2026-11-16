#!/usr/bin/env python3
"""secao_dono.py - publica a memoria de trabalho de uma rodada SEM deixar a sessao escrever instrucao.

POR QUE EXISTE. O cron de posts le a secao "Instrucoes do <dono>" do persona/working-memory.md e
manda aplicar o que estiver nela, com permissao ampla. O cron de comentarios roda uma sessao que le
texto de terceiros e precisa atualizar a memoria (secoes "Hoje", "Pessoas Proximas"...). Se um
comentario convencesse a sessao a escrever uma "instrucao do dono" falsa, o cron de posts a
obedeceria.

COMO FUNCIONA. A sessao NUNCA edita o arquivo vivo. O cron entrega a ela uma COPIA
(data/rodada/working-memory.md) e guarda a BASE (copia identica, fora do alcance dela). Depois da
sessao este programa junta as tres versoes (base, copia da sessao, arquivo vivo de agora) por secao:

  - secao de instrucoes (qualquer titulo com "instruc", em qualquer nivel de titulo e com ate 3
    espacos antes do #): vale SEMPRE a versao viva. Nada que a sessao escreveu ali entra. A unica
    excecao e o marcador " [APLICADO 09h30]" no fim de uma linha que ja existia;
  - as outras secoes: se a sessao mudou a secao e o dono nao mexeu nela durante a rodada, entra a
    versao da sessao; se os dois mudaram, fica a do dono e a da sessao e guardada em --rejeitadas;
  - titulo novo que a sessao criou com "instruc" e descartado.
  A gravacao e atomica (arquivo temporario + rename), sobre o arquivo vivo LIDO NO MOMENTO de
  publicar, entao uma edicao do dono feita durante a rodada nao se perde.

Uso:  secao_dono.py publicar --base B --copia C --vivo V --rejeitadas PASTA

Saida: 0 publicado sem ocorrencia | 1 erro (a mensagem diz o motivo; o vivo nao foi tocado)
| 3 a sessao tentou mexer em instrucao (descartado; o resto foi publicado)
| 4 dono e sessao mudaram a mesma secao (ficou a do dono; o resto foi publicado).
"""
import argparse
import os
import re
import sys
import unicodedata
from datetime import datetime

TITULO = re.compile(r"^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$")
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


def chave_do_titulo(texto):
    t = unicodedata.normalize("NFKD", texto)
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", t).strip().lower()


def eh_protegido(chave):
    return "instruc" in chave


def dividir(texto):
    """Devolve [(id, protegido, texto)] na ordem. id = (titulo normalizado, ocorrencia).
    O que vem antes do primeiro titulo e a secao ('', 0)."""
    secoes = []
    contagem = {}
    chave = ""
    buf = []

    def fechar():
        if not buf and chave == "":
            return
        n = contagem.get(chave, 0)
        contagem[chave] = n + 1
        secoes.append(((chave, n), eh_protegido(chave), "".join(buf)))

    for linha in texto.splitlines(keepends=True):
        m = TITULO.match(linha.rstrip("\r\n"))
        if m:
            fechar()
            chave = chave_do_titulo(m.group(1))
            buf = [linha]
        else:
            buf.append(linha)
    fechar()
    return secoes


def normaliza(texto):
    linhas = [MARCADOR.sub("", ln.rstrip("\r\n")).rstrip() for ln in texto.splitlines()]
    while linhas and not linhas[-1]:
        linhas.pop()
    return linhas


def com_marcadores(vivo, copia):
    """Na secao protegida, devolve o texto VIVO, adotando da copia so o marcador APLICADO acrescentado."""
    marcadas = {}
    for ln in copia.splitlines(keepends=True):
        corpo = ln.rstrip("\r\n")
        if MARCADOR.search(corpo):
            marcadas.setdefault(MARCADOR.sub("", corpo).rstrip(), ln)
    saida = []
    for ln in vivo.splitlines(keepends=True):
        corpo = ln.rstrip("\r\n")
        k = MARCADOR.sub("", corpo).rstrip()
        if not MARCADOR.search(corpo) and k in marcadas and k:
            fim = ln[len(corpo):]
            saida.append(marcadas[k].rstrip("\r\n") + fim)
        else:
            saida.append(ln)
    return "".join(saida)


def publicar(base, copia, vivo, rejeitadas):
    t_base, t_copia = ler(base), ler(copia)
    ocorrencias = {"instrucao": [], "conflito": []}

    for _ in range(2):  # uma releitura se o dono gravar no meio
        t_vivo = ler(vivo)
        s_base = {i: t for i, _, t in dividir(t_base)}
        s_copia = {i: t for i, _, t in dividir(t_copia)}
        s_vivo = dividir(t_vivo)
        vivos_ids = {i for i, _, _ in s_vivo}
        ocorrencias = {"instrucao": [], "conflito": []}

        saida = []
        for i, protegido, texto in s_vivo:
            if protegido:
                if i in s_copia:
                    if normaliza(s_copia[i]) != normaliza(texto):
                        ocorrencias["instrucao"].append(s_copia[i])
                    saida.append(com_marcadores(texto, s_copia[i]))
                else:
                    saida.append(texto)
                continue
            if i in s_copia and s_copia[i] != s_base.get(i):
                if texto == s_base.get(i):
                    saida.append(s_copia[i])
                else:
                    ocorrencias["conflito"].append(s_copia[i])
                    saida.append(texto)
            else:
                saida.append(texto)
        # secoes que a sessao criou (nao existiam na base nem no vivo)
        for i, p, t in dividir(t_copia):
            if i in vivos_ids or i in s_base:
                continue
            if p:
                ocorrencias["instrucao"].append(t)
            else:
                if saida and not saida[-1].endswith("\n"):
                    saida[-1] += "\n"
                saida.append(t)
        novo = "".join(saida)
        if ler(vivo) == t_vivo:
            break
    else:
        erro("o arquivo vivo mudou duas vezes durante a publicacao; nao gravei. Tente na proxima rodada.")
        return 1

    if ocorrencias["instrucao"] or ocorrencias["conflito"]:
        try:
            os.makedirs(rejeitadas, mode=0o700, exist_ok=True)
            marca = datetime.now().strftime("%Y-%m-%d-%H%M%S")
            destino = os.path.join(rejeitadas, f"memoria-rejeitada-{marca}.txt")
            fd = os.open(destino, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                for k, titulo in (("instrucao", "INSTRUCOES (descartadas)"), ("conflito", "SECOES EM CONFLITO (ficou a do dono)")):
                    for t in ocorrencias[k]:
                        f.write(f"==== {titulo} ====\n{t}\n")
        except OSError as e:
            erro(f"nao consegui guardar o que foi rejeitado em {rejeitadas}: {e}")
            return 1

    if novo != t_vivo:
        tmp = vivo + ".tmp-secao-dono"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(novo)
            os.replace(tmp, vivo)
        except OSError as e:
            erro(f"nao consegui gravar {vivo}: {e}")
            return 1

    if ocorrencias["instrucao"]:
        erro(f"a sessao tentou escrever ou alterar instrucoes ({len(ocorrencias['instrucao'])} trecho(s)); "
             f"foi descartado e a versao do dono foi mantida. O texto esta em {destino}.")
        return 3
    if ocorrencias["conflito"]:
        erro(f"o dono e a sessao mudaram a mesma secao durante a rodada ({len(ocorrencias['conflito'])}); "
             f"ficou a do dono e a da sessao esta em {destino}.")
        return 4
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("publicar")
    p.add_argument("--base", required=True)
    p.add_argument("--copia", required=True)
    p.add_argument("--vivo", required=True)
    p.add_argument("--rejeitadas", required=True)
    a = ap.parse_args()
    return publicar(a.base, a.copia, a.vivo, a.rejeitadas)


if __name__ == "__main__":
    sys.exit(main())
