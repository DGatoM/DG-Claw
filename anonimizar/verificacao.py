"""Verificação final e lista de marcadores usados, lendo a saída pronta parte por parte.

Para docx e xlsx cada arquivo do zip é descompactado e lido (texto e atributos das partes XML; as
demais partes, em bruto). Procura cada valor detectado no documento, normalizado; para dígitos,
também a sequência só de dígitos. Nunca devolve nem registra o valor: só o tipo e a parte.
"""
import os
import re
import zipfile

from detectores import TIPOS
from documentos import ErroMotor
from tabela import normalizar, sem_acento

_RX_MARCADOR = re.compile(r"\[(" + "|".join(TIPOS) + r")_(\d+)\]")
_RX_ABA = re.compile(r"(?<![\w\[])(" + "|".join(TIPOS) + r")_(\d+)(?![\w\]])")
TIPOS_DIGITOS = {"CPF", "RG", "PIS", "CNH", "TITULO", "CEP", "TELEFONE", "CARTAO", "CONTA", "AGENCIA"}


def partes(caminho):
    """[(nome_da_parte, texto)] de uma saída."""
    ext = os.path.splitext(caminho)[1].lower()
    if ext not in (".docx", ".xlsx"):
        with open(caminho, "rb") as f:
            return [(os.path.basename(caminho), f.read().decode("utf-8", "replace"))]
    from lxml import etree
    saida = []
    with zipfile.ZipFile(caminho) as z:
        for info in z.infolist():
            dados = z.read(info.filename)
            if info.filename.endswith((".xml", ".rels", ".vml")):
                try:
                    raiz = etree.fromstring(dados, etree.XMLParser(recover=True, resolve_entities=False, no_network=True))
                except etree.XMLSyntaxError:
                    raiz = None
                if raiz is not None:
                    blocos = []
                    for el in raiz.iter():
                        if isinstance(el.tag, str):
                            if el.text and el.text.strip():
                                blocos.append(el.text)
                            if el.tail and el.tail.strip():
                                blocos.append(el.tail)
                            blocos += [v for v in el.attrib.values() if v]
                    saida.append((info.filename, "\n".join(blocos)))
                    continue
            saida.append((info.filename, dados.decode("latin-1")))
    return saida


def marcadores_usados(caminhos):
    achados = set()
    for c in caminhos:
        for nome, texto in partes(c):
            achados.update("[%s_%s]" % m for m in _RX_MARCADOR.findall(texto))
            if nome == "xl/workbook.xml":
                achados.update("[%s_%s]" % m for m in _RX_ABA.findall(texto))
    return sorted(achados, key=lambda m: (m.split("_")[0], int(m[:-1].split("_")[1])))


def _procura(tipo, valor):
    """Função(texto) -> bool para um valor detectado."""
    chave = normalizar(tipo, valor)
    if not chave:
        return lambda t: False
    if tipo in TIPOS_DIGITOS:
        pre = r"(?:55)?" if tipo == "TELEFONE" else ""
        rx = re.compile(r"(?<!\d)" + pre + re.escape(chave) + r"(?!\d)")
        if len(chave) >= 7:
            return lambda t: bool(rx.search(t) or rx.search(re.sub(r"[ .\-/()+]", "", t)))
        return lambda t: bool(rx.search(t))
    if tipo == "CNPJ":
        rx = re.compile(r"(?<![0-9A-Za-z])" + re.escape(chave) + r"(?![0-9A-Za-z])")
        return lambda t: bool(rx.search(t) or rx.search(re.sub(r"[./\-\s]", "", t.upper())))
    if tipo in ("VALOR", "DATA"):
        rx = re.compile(r"(?<!\w)" + re.escape(chave) + r"(?!\w)")
        return lambda t: bool(rx.search(re.sub(r"\s+", "", sem_acento(t).lower())))
    rx = re.compile(r"(?<!\w)" + re.escape(chave).replace(r"\ ", " ") + r"(?!\w)")
    return lambda t: bool(rx.search(re.sub(r"\s+", " ", sem_acento(t).lower())))


def verificar(caminhos, detectados, nome_exibido):
    """detectados: {(tipo, chave): valor}. Levanta ErroMotor('sobrou_dado') se algum valor ainda aparece."""
    procuras = [(tipo, _procura(tipo, valor)) for (tipo, _chave), valor in detectados.items()]
    for c in caminhos:
        for nome_parte, texto in partes(c):
            if not texto:
                continue
            for tipo, acha in procuras:
                if acha(texto):
                    raise ErroMotor("sobrou_dado", "A verificação final achou um dado pessoal do tipo %s que sobrou na parte '%s' do arquivo de saída "
                                    "de '%s'. Nada foi entregue ao agente. Envie o documento em outro formato (.txt, .docx) "
                                    "ou apague esse dado antes de enviar." % (tipo, nome_parte, nome_exibido))
