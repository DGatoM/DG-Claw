"""Verificação final e lista de marcadores usados, lendo a saída pronta parte por parte.

Para docx e xlsx cada arquivo do zip é descompactado e lido (texto e atributos das partes XML; as
demais partes, em bruto). Procura cada valor detectado no documento, normalizado; para dígitos,
também a sequência só de dígitos. Nunca devolve nem registra o valor: só o tipo e a parte.
"""
import html
import os
import re
import zipfile

from detectores import TIPOS, detectar
from documentos import ErroMotor
from ooxml import atributo_estrutural
from tabela import normalizar, sem_acento

_RX_MARCADOR = re.compile(r"\[(" + "|".join(TIPOS) + r")_(\d+)\]")
_RX_ABA = re.compile(r"(?<![\w\[])(" + "|".join(TIPOS) + r")_(\d+)(?![\w\]])")
_GUID = re.compile(r"^\{?[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}?$")
_RX_MARCADOR_QUALQUER = re.compile(r"[\[［](?:" + "|".join(TIPOS) + r")_\d+[\]］]")
INDEPENDENTES = ("CPF", "CNPJ", "EMAIL", "TELEFONE", "CARTAO", "PIX")
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
            if info.filename.lower().endswith((".xml", ".rels", ".vml")):
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
                            blocos += [v for k, v in el.attrib.items() if v and not atributo_estrutural(el, k, v)]
                    saida.append((info.filename, "\n".join(blocos)))
            # O texto bruto da parte, como está no arquivo (comentário XML, instrução de processamento, atributo) e com as
            # entidades resolvidas (&#x31; vira 1): o dado pode estar em qualquer um dos dois.
            bruto = dados.decode("utf-8", "replace") if info.filename.lower().endswith((".xml", ".rels", ".vml")) else dados.decode("latin-1")
            saida.append((info.filename + " (texto bruto)", bruto))
            saida.append((info.filename + " (entidades resolvidas)", html.unescape(bruto)))
    return saida


def marcadores_usados(caminhos):
    achados = set()
    for c in caminhos:
        for nome, texto in partes(c):
            achados.update("[%s_%s]" % m for m in _RX_MARCADOR.findall(texto))
            if nome.lower() == "xl/workbook.xml":
                achados.update("[%s_%s]" % m for m in _RX_ABA.findall(texto))
    return sorted(achados, key=lambda m: (m.split("_")[0], int(m[:-1].split("_")[1])))


def _procura(tipo, valor):
    """Função(texto) -> bool para um valor detectado."""
    chave = normalizar(tipo, valor)
    if not chave:
        return lambda t: False
    if tipo in ("CPF",):   # também sem os zeros à esquerda (o Excel guarda o CPF como número)
        sem_zero = chave.lstrip("0")
        if len(sem_zero) >= 7:
            rx0 = re.compile(r"(?<!\d)0*" + re.escape(sem_zero) + r"(?!\d)")
            return lambda t: bool(rx0.search(t) or rx0.search(re.sub(r"[ .\-/()+]", "", t)))
    if tipo in TIPOS_DIGITOS:
        pre = r"(?:55)?" if tipo == "TELEFONE" else ""
        rx = re.compile(r"(?<!\d)" + pre + re.escape(chave) + r"(?!\d)")
        if len(chave) >= 7:
            return lambda t: bool(rx.search(t) or rx.search(re.sub(r"[ .\-/()+]", "", t)))
        return lambda t: bool(rx.search(t))
    if tipo == "CNPJ":
        sem_zero = chave.lstrip("0")
        rx = re.compile(r"(?<![0-9A-Za-z])0*" + re.escape(sem_zero) + r"(?![0-9A-Za-z])")
        return lambda t: bool(rx.search(t) or rx.search(re.sub(r"[./\-\s]", "", t.upper())))
    if tipo == "DATA":   # data ISO pode vir seguida de "T00:00:00"
        rx = re.compile(r"(?<!\d)" + re.escape(chave) + r"(?!\d)")
        return lambda t: bool(rx.search(re.sub(r"\s+", "", sem_acento(t).lower())))
    if tipo == "VALOR":
        rx = re.compile(r"(?<!\w)" + re.escape(chave) + r"(?!\w)")
        return lambda t: bool(rx.search(re.sub(r"\s+", "", sem_acento(t).lower())))
    rx = re.compile(r"(?<!\w)" + re.escape(chave).replace(r"\ ", " ") + r"(?!\w)")
    return lambda t: bool(rx.search(re.sub(r"\s+", " ", sem_acento(t).lower())))


def _varredura_independente(caminhos, nome_exibido):
    """Roda de novo os detectores validados (dígito verificador, Luhn, e-mail, telefone, UUID), sem depender da lista do
    documento, sobre o texto de cada parte (nós de texto e valores de atributo; nas demais saídas, o texto todo).
    Os marcadores são ignorados. Achou algo, o dado sobrou."""
    for c in caminhos:
        for nome_parte, texto in partes(c):
            if nome_parte.endswith((" (texto bruto)", " (entidades resolvidas)")):
                continue
            limpo = _RX_MARCADOR_QUALQUER.sub(" ", texto)
            for _ini, _fim, tipo, _p in detectar(limpo, False, False):
                if tipo in INDEPENDENTES:
                    raise ErroMotor("sobrou_dado", "A verificação final achou um dado pessoal do tipo %s que sobrou na parte '%s' do arquivo de saída "
                                    "de '%s' (segunda conferência, sem a lista do documento). Nada foi entregue ao agente. Envie o documento "
                                    "em outro formato (.txt, .docx) ou apague esse dado antes de enviar." % (tipo, nome_parte, nome_exibido))


def verificar(caminhos, detectados, nome_exibido):
    """detectados: {(tipo, chave): valor}. Levanta ErroMotor('sobrou_dado') se algum valor ainda aparece."""
    _varredura_independente(caminhos, nome_exibido)
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
