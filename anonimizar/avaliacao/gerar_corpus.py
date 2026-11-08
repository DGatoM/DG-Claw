#!/usr/bin/env python3
"""Gera o corpus FICTÍCIO da bateria de acurácia e o gabarito a partir dos textos-fonte.

O gabarito guarda `itens` na ordem em que aparecem no documento (tipo "!" = armadilha); o avaliador os procura em
sequência, por isso um trecho repetido não se confunde com outro igual que está dentro de um nome maior.
Cada fonte (fontes/NN-nome.txt) começa com `#formato: txt|docx|pdf|xlsx` e marca no próprio texto:
  [[TIPO:trecho]]   o que DEVE virar marcador (TIPO = PESSOA, EMPRESA, ENDERECO, CPF, CNPJ...)
  [[!:trecho]]      armadilha: o que NÃO deve ser marcado
Os números de documento vêm de ${CPF_A}, ${CNPJ_A}, ${CNPJ_ALFA_A}, ${PIS_A}, ${UUID_A} (com sufixo _RAW = sem
pontuação). Todos são gerados por algoritmo a partir de bases inventadas: nenhum dado real.

  python3 gerar_corpus.py --fontes fontes --gabarito gabarito.json --saida /tmp/corpus
Os binários (docx, pdf, xlsx) são gerados na hora e não vão para o git; o texto-fonte e o gabarito, sim.
"""
import argparse
import json
import os
import re
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
CPF_BASES = dict(zip("ABCDEFGH", ["390533447", "111444777", "123456789", "987654321", "246813579", "135792468", "112358132", "314159265"]))
CNPJ_BASES = dict(zip("ABCD", ["112223330001", "456789120001", "778899000001", "334455660001"]))
CNPJ_ALFA_BASES = dict(zip("AB", ["12ABC34501DE", "7K9X2M4P0001"]))
UUIDS = {"A": "123e4567-e89b-12d3-a456-426614174000", "B": "9b2f6c1e-4d3a-4f7b-8c55-0a1b2c3d4e5f"}


def _dv_cpf(base):
    d = [int(c) for c in base]
    for n in (9, 10):
        d.append((sum(d[i] * (n + 1 - i) for i in range(n)) * 10) % 11 % 10)
    return "".join(map(str, d))


def _dv_cnpj(base):
    v = [ord(c) - 48 for c in base]
    for pesos in ([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]):
        r = sum(a * b for a, b in zip(v, pesos)) % 11
        v.append(0 if r < 2 else 11 - r)
    return base + "".join(map(str, v[12:]))


def _pis(base):
    pesos = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    r = 11 - sum(int(a) * b for a, b in zip(base, pesos)) % 11
    return base + str(0 if r >= 10 else r)


def variaveis():
    v = {}
    for k, b in CPF_BASES.items():
        c = _dv_cpf(b)
        v["CPF_" + k + "_RAW"] = c
        v["CPF_" + k] = "%s.%s.%s-%s" % (c[:3], c[3:6], c[6:9], c[9:])
    for tabela, prefixo in ((CNPJ_BASES, "CNPJ_"), (CNPJ_ALFA_BASES, "CNPJ_ALFA_")):
        for k, b in tabela.items():
            c = _dv_cnpj(b)
            v[prefixo + k + "_RAW"] = c
            v[prefixo + k] = "%s.%s.%s/%s-%s" % (c[:2], c[2:5], c[5:8], c[8:12], c[12:])
    p = _pis("1234567890")
    v["PIS_A_RAW"] = p
    v["PIS_A"] = "%s.%s.%s-%s" % (p[:3], p[3:8], p[8:10], p[10])
    for k, u in UUIDS.items():
        v["UUID_" + k] = u
    return v


_RX_VAR = re.compile(r"\$\{(\w+)\}")
_RX_MARCA = re.compile(r"\[\[([A-Z!]+):(.*?)\]\]")


def processar(fonte):
    """(formato, texto_puro, esperados, armadilhas) de um texto-fonte."""
    linhas = fonte.split("\n")
    formato = "txt"
    if linhas and linhas[0].startswith("#formato:"):
        formato = linhas[0].split(":", 1)[1].strip()
        linhas = linhas[1:]
    vars_ = variaveis()
    corpo = _RX_VAR.sub(lambda m: vars_[m.group(1)], "\n".join(linhas)).rstrip("\n") + "\n"
    esperados, armadilhas, itens = [], [], []
    for m in _RX_MARCA.finditer(corpo):
        itens.append({"tipo": m.group(1), "texto": m.group(2)})
        (armadilhas if m.group(1) == "!" else esperados).append(
            {"texto": m.group(2)} if m.group(1) == "!" else {"tipo": m.group(1), "texto": m.group(2)})
    return formato, _RX_MARCA.sub(lambda m: m.group(2), corpo), esperados, armadilhas, itens


def escrever(formato, texto, caminho):
    if formato == "txt":
        with open(caminho, "w", encoding="utf-8") as f:
            f.write(texto)
    elif formato == "docx":
        import docx
        d = docx.Document()
        for par in re.split(r"\n\s*\n", texto.strip()):
            d.add_paragraph(par.replace("\n", " "))
        d.save(caminho)
    elif formato == "pdf":
        from xml.sax.saxutils import escape
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
        estilo = getSampleStyleSheet()["BodyText"]
        itens = []
        for par in re.split(r"\n\s*\n", texto.strip()):
            itens.append(Paragraph(escape(par).replace("\n", "<br/>"), estilo))
            itens.append(Spacer(1, 8))
        SimpleDocTemplate(caminho, pagesize=A4).build(itens)
    elif formato == "xlsx":
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Clientes"
        for linha in texto.strip().split("\n"):
            ws.append([c.strip() for c in linha.split(" | ")])
        wb.save(caminho)
    else:
        raise SystemExit("formato desconhecido: %s" % formato)


def gerar(fontes_dir, gabarito, saida):
    os.makedirs(saida, exist_ok=True)
    docs = []
    for nome in sorted(os.listdir(fontes_dir)):
        if not nome.endswith(".txt"):
            continue
        with open(os.path.join(fontes_dir, nome), encoding="utf-8") as f:
            formato, texto, esp, arm, itens = processar(f.read())
        arquivo = nome[:-4] + "." + formato
        escrever(formato, texto, os.path.join(saida, arquivo))
        docs.append({"id": nome[:-4], "arquivo": arquivo, "formato": formato, "esperados": esp, "armadilhas": arm, "itens": itens})
    if gabarito:
        with open(gabarito, "w", encoding="utf-8") as f:
            json.dump({"documentos": docs}, f, ensure_ascii=False, indent=1)
            f.write("\n")
    return docs


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fontes", default=os.path.join(AQUI, "fontes"))
    ap.add_argument("--gabarito", default=os.path.join(AQUI, "gabarito.json"))
    ap.add_argument("--saida", required=True)
    a = ap.parse_args()
    d = gerar(a.fontes, a.gabarito, a.saida)
    print("%d documentos em %s; gabarito em %s" % (len(d), a.saida, a.gabarito), file=sys.stderr)
