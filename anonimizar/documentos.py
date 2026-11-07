"""Leitores e gravadores de documento: txt/md/csv/json, pdf, docx, xlsx e pptx.

pypdf, python-docx e openpyxl só são importados quando o formato pede. O docx e o pptx são
reescritos dentro do zip (só os trechos de texto mudam), então a formatação sobrevive. Quando um
valor está partido entre runs, o texto novo vai para o primeiro run e o resto do valor é apagado
dos demais. Nenhuma mensagem de erro carrega conteúdo do documento, só o nome do arquivo.
"""
import bisect
import csv
import html
import io
import json
import os
import re
import zipfile
from xml.sax.saxutils import escape as xml_escape

LIMITE_ZIP = 200 * 1024 * 1024
MIN_CARACTERES_POR_PAGINA = 20
FORMATOS_TEXTO = (".txt", ".md", ".csv", ".json")
FORMATOS_LEITORES = (".pdf", ".docx", ".xlsx")
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class ErroMotor(Exception):
    def __init__(self, codigo, mensagem):
        super().__init__(mensagem)
        self.codigo = codigo
        self.mensagem = mensagem


def _importar(modulo, pacote, nome_arquivo):
    try:
        return __import__(modulo)
    except ImportError:
        raise ErroMotor(
            "falta_leitor",
            "O arquivo '%s' precisa do leitor '%s', que não está instalado. "
            "Instale o motor de documentos pelo painel (Anonimizar documentos, nível leitores) e tente de novo."
            % (nome_arquivo, pacote)) from None


# ---------- texto simples ----------

def ler_texto(caminho):
    with open(caminho, "rb") as f:
        bruto = f.read()
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return bruto.decode(enc)
        except UnicodeDecodeError:
            continue
    return bruto.decode("latin-1")


def escrever_texto(caminho, texto):
    with open(caminho, "w", encoding="utf-8", newline="") as f:
        f.write(texto)


# ---------- zip ----------

def abrir_zip(caminho, nome):
    try:
        with open(caminho, "rb") as f:
            cabeca = f.read(8)
        if cabeca.startswith(b"\xd0\xcf\x11\xe0"):
            raise ErroMotor("protegido", "O arquivo '%s' está protegido por senha (ou é um formato antigo). "
                            "Salve uma cópia sem senha, no formato mais novo, e envie de novo." % nome)
        z = zipfile.ZipFile(caminho)
    except zipfile.BadZipFile:
        raise ErroMotor("arquivo_invalido", "O arquivo '%s' está corrompido ou não é do formato que a extensão diz. "
                        "Abra e salve de novo no programa de origem, depois envie." % nome) from None
    total = sum(i.file_size for i in z.infolist())
    if total > LIMITE_ZIP or len(z.infolist()) > 20000:
        z.close()
        raise ErroMotor("zip_grande", "O arquivo '%s' ocupa mais de 200 MB depois de aberto (ou tem entradas demais). "
                        "Por segurança ele foi recusado. Divida o documento em partes menores." % nome)
    return z


def reescrever_zip(z, saida, substituicoes):
    """Copia o zip trocando o conteúdo das entradas em `substituicoes` (nome -> bytes)."""
    with zipfile.ZipFile(saida, "w") as out:
        for info in z.infolist():
            dados = substituicoes.get(info.filename)
            if dados is None:
                dados = z.read(info.filename)
            novo = zipfile.ZipInfo(info.filename, info.date_time)
            novo.compress_type = zipfile.ZIP_DEFLATED
            novo.external_attr = info.external_attr
            out.writestr(novo, dados)


def distribuir(trechos, trocas):
    """Aplica `trocas` (inicio, fim, novo) sobre o texto juntado de `trechos` e devolve os trechos novos."""
    inicios, vivos, pos = [], [], 0
    for k, t in enumerate(trechos):
        if t:
            inicios.append(pos)
            vivos.append(k)
        pos += len(t)
    offs = {}
    pos = 0
    for k, t in enumerate(trechos):
        offs[k] = pos
        pos += len(t)
    novos = list(trechos)

    def trecho_de(p):
        return vivos[bisect.bisect_right(inicios, p) - 1]

    for ini, fim, novo in reversed(trocas):
        i, j = trecho_de(ini), trecho_de(fim - 1)
        if i == j:
            novos[i] = novos[i][:ini - offs[i]] + novo + novos[i][fim - offs[i]:]
        else:
            novos[i] = novos[i][:ini - offs[i]] + novo
            for k in range(i + 1, j):
                novos[k] = ""
            novos[j] = novos[j][fim - offs[j]:]
    return novos


# ---------- docx ----------

_PARTES_DOCX = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$")
_PARTES_PPTX = re.compile(r"^ppt/(slides/slide|notesSlides/notesSlide)\d+\.xml$")


def _lxml():
    try:
        from lxml import etree
        return etree
    except ImportError:
        raise ErroMotor("falta_leitor", "O leitor de Word/PowerPoint (lxml, que vem com o python-docx) não está instalado. "
                        "Instale o motor de documentos pelo painel (nível leitores) e tente de novo.") from None


def _paragrafos_docx(raiz):
    for p in raiz.iter(W + "p"):
        ts = [t for t in p.iter(W + "t", W + "delText") if next(t.iterancestors(W + "p")) is p]
        if ts:
            yield p, ts


def docx_textos(caminho, nome):
    etree = _lxml()
    textos = []
    with abrir_zip(caminho, nome) as z:
        for info in z.infolist():
            if _PARTES_DOCX.match(info.filename):
                raiz = etree.fromstring(z.read(info.filename))
                for _p, ts in _paragrafos_docx(raiz):
                    textos.append("".join(t.text or "" for t in ts))
            elif info.filename.startswith("word/_rels/") and info.filename.endswith(".rels"):
                textos += [a for a in _alvos_externos(etree, z.read(info.filename))]
    return textos


def _alvos_externos(etree, dados):
    raiz = etree.fromstring(dados)
    return [r.get("Target") for r in raiz if r.get("TargetMode") == "External" and r.get("Target")]


def docx_transformar(entrada, saida, nome, encontrar):
    """Reescreve o docx aplicando `encontrar(texto_do_paragrafo) -> trocas` a cada parágrafo."""
    etree = _lxml()
    subs = {}
    with abrir_zip(entrada, nome) as z:
        for info in z.infolist():
            f = info.filename
            if _PARTES_DOCX.match(f):
                raiz = etree.fromstring(z.read(f))
                mudou = False
                for _p, ts in _paragrafos_docx(raiz):
                    trechos = [t.text or "" for t in ts]
                    trocas = encontrar("".join(trechos))
                    if not trocas:
                        continue
                    for t, novo in zip(ts, distribuir(trechos, trocas)):
                        t.text = novo
                        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                    mudou = True
                if mudou:
                    subs[f] = etree.tostring(raiz, xml_declaration=True, encoding="UTF-8", standalone=True)
            elif f.startswith("word/_rels/") and f.endswith(".rels"):
                raiz = etree.fromstring(z.read(f))
                mudou = False
                for r in raiz:
                    alvo = r.get("Target")
                    if r.get("TargetMode") == "External" and alvo:
                        trocas = encontrar(alvo)
                        if trocas:
                            r.set("Target", distribuir([alvo], trocas)[0])
                            mudou = True
                if mudou:
                    subs[f] = etree.tostring(raiz, xml_declaration=True, encoding="UTF-8", standalone=True)
            elif f == "docProps/core.xml":
                raiz = etree.fromstring(z.read(f))
                for el in raiz.iter():
                    if isinstance(el.tag, str) and el.tag.split("}")[-1] in ("creator", "lastModifiedBy") and el.text:
                        el.text = ""
                subs[f] = etree.tostring(raiz, xml_declaration=True, encoding="UTF-8", standalone=True)
        reescrever_zip(z, saida, subs)


def docx_para_md(caminho):
    docx = _importar("docx", "python-docx", os.path.basename(caminho))
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    doc = docx.Document(caminho)
    linhas = []

    def tabela(tbl):
        linhas_t = []
        for r, row in enumerate(tbl.rows):
            celulas = []
            vistos = set()
            for c in row.cells:
                if id(c._tc) in vistos:
                    continue
                vistos.add(id(c._tc))
                celulas.append(c.text.replace("\n", " ").replace("|", "\\|").strip())
            linhas_t.append("| " + " | ".join(celulas) + " |")
            if r == 0:
                linhas_t.append("|" + "---|" * max(1, len(celulas)))
        return "\n".join(linhas_t)

    for filho in doc.element.body.iterchildren():
        marca = filho.tag.split("}")[-1]
        if marca == "p":
            p = Paragraph(filho, doc)
            texto = p.text.strip()
            if not texto:
                linhas.append("")
                continue
            estilo = (p.style.name if p.style is not None else "") or ""
            m = re.match(r"(?i)(?:heading|t[ií]tulo)\s*(\d)", estilo)
            if m:
                texto = "#" * min(6, int(m.group(1))) + " " + texto
            elif estilo.lower().startswith(("list", "lista")):
                texto = "- " + texto
            linhas.append(texto)
        elif marca == "tbl":
            linhas.append(tabela(Table(filho, doc)))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(linhas)).strip() + "\n"


# ---------- pptx ----------

_RX_PARA = re.compile(r"<a:p\b[^>]*?>.*?</a:p>", re.S)
_RX_AT = re.compile(r"(<a:t(?:\s[^>]*)?>)(.*?)(</a:t>)", re.S)


def pptx_transformar(entrada, saida, nome, encontrar):
    subs = {}
    with abrir_zip(entrada, nome) as z:
        for info in z.infolist():
            if not _PARTES_PPTX.match(info.filename):
                continue
            xml = z.read(info.filename).decode("utf-8")

            def por_paragrafo(mp):
                bloco = mp.group(0)
                achados = list(_RX_AT.finditer(bloco))
                if not achados:
                    return bloco
                trechos = [html.unescape(a.group(2)) for a in achados]
                trocas = encontrar("".join(trechos))
                if not trocas:
                    return bloco
                novos = distribuir(trechos, trocas)
                saida_b, pos = [], 0
                for a, novo in zip(achados, novos):
                    saida_b.append(bloco[pos:a.start()] + a.group(1) + xml_escape(novo) + a.group(3))
                    pos = a.end()
                saida_b.append(bloco[pos:])
                return "".join(saida_b)

            novo_xml = _RX_PARA.sub(por_paragrafo, xml)
            if novo_xml != xml:
                subs[info.filename] = novo_xml.encode("utf-8")
        reescrever_zip(z, saida, subs)


# ---------- pdf ----------

def pdf_texto(caminho, nome):
    pypdf = _importar("pypdf", "pypdf", nome)
    try:
        leitor = pypdf.PdfReader(caminho)
        if leitor.is_encrypted and not leitor.decrypt(""):
            raise ErroMotor("protegido", "O PDF '%s' está protegido por senha. Salve uma cópia sem senha e envie de novo." % nome)
        paginas = [(p.extract_text() or "") for p in leitor.pages]
    except ErroMotor:
        raise
    except Exception as e:
        raise ErroMotor("arquivo_invalido", "Não consegui ler o PDF '%s' (%s). Abra e salve de novo no programa de origem, "
                        "ou envie em .docx." % (nome, type(e).__name__)) from None
    uteis = sum(len(re.sub(r"\s", "", t)) for t in paginas)
    if not paginas or uteis / len(paginas) < MIN_CARACTERES_POR_PAGINA:
        raise ErroMotor("pdf_sem_texto", "O PDF '%s' não tem texto selecionável: provavelmente é um documento escaneado (imagem). "
                        "A leitura de imagem (OCR) ainda não existe. Envie a versão em texto (.docx, .txt) ou um PDF gerado direto "
                        "do programa de origem." % nome)
    return "\n\n".join(t.strip() for t in paginas)


# ---------- xlsx ----------

_SHEET_INVALIDO = re.compile(r"[\\/?*\[\]:]")


def xlsx_abrir(caminho, nome, **kw):
    openpyxl = _importar("openpyxl", "openpyxl", nome)
    abrir_zip(caminho, nome).close()
    try:
        return openpyxl.load_workbook(caminho, **kw)
    except Exception as e:
        raise ErroMotor("arquivo_invalido", "Não consegui abrir a planilha '%s' (%s). Abra e salve de novo no Excel, depois envie."
                        % (nome, type(e).__name__)) from None


def xlsx_celulas(wb):
    """Células de texto (nunca fórmulas)."""
    for ws in wb.worksheets:
        for linha in ws.iter_rows():
            for c in linha:
                if c.data_type != "f" and isinstance(c.value, str) and c.value:
                    yield c


def xlsx_textos(wb):
    saida = [ws.title for ws in wb.worksheets]
    for c in xlsx_celulas(wb):
        saida.append(c.value)
        if c.comment is not None and c.comment.text:
            saida.append(c.comment.text)
    return saida


def _titulo_seguro(titulo, usados):
    base = _SHEET_INVALIDO.sub("", titulo).strip().strip("'")[:31] or "Aba"
    novo, n = base, 2
    while novo.lower() in usados:
        sufixo = "_%d" % n
        novo = base[:31 - len(sufixo)] + sufixo
        n += 1
    usados.add(novo.lower())
    return novo


def xlsx_transformar(wb, encontrar, trocar_titulo):
    """Troca texto das células, comentários e nomes de aba. `trocar_titulo(titulo) -> titulo novo`."""
    for c in xlsx_celulas(wb):
        trocas = encontrar(c.value)
        if trocas:
            c.value = distribuir([c.value], trocas)[0]
        if c.comment is not None and c.comment.text:
            trocas = encontrar(c.comment.text)
            if trocas:
                c.comment.text = distribuir([c.comment.text], trocas)[0]
    novos = {}
    usados = set()
    for ws in wb.worksheets:
        novos[ws.title] = _titulo_seguro(trocar_titulo(ws.title), usados)
    if any(a != b for a, b in novos.items()):
        for ws in wb.worksheets:
            for linha in ws.iter_rows():
                for c in linha:
                    if c.data_type == "f" and isinstance(c.value, str):
                        for velho, novo in novos.items():
                            if velho != novo:
                                c.value = c.value.replace("'%s'!" % velho, "'%s'!" % novo).replace(velho + "!", novo + "!")
        for ws in wb.worksheets:
            ws.title = novos[ws.title]
    wb.properties.creator = ""
    wb.properties.lastModifiedBy = ""


def xlsx_csvs(caminho_original, nome, wb_anon, trocar):
    """Um CSV por aba, com os valores em cache (ou o texto da fórmula, se nunca foi calculada)."""
    valores = xlsx_abrir(caminho_original, nome, data_only=True)
    saida = []
    for ws_v, ws in zip(valores.worksheets, wb_anon.worksheets):
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        for lin_v, lin in zip(ws_v.iter_rows(), ws.iter_rows()):
            linha = []
            for cv, c in zip(lin_v, lin):
                v = cv.value if cv.value is not None else (c.value if c.data_type == "f" else None)
                if isinstance(v, str):
                    v = trocar(v)
                elif hasattr(v, "isoformat"):
                    v = v.isoformat()
                linha.append("" if v is None else v)
            w.writerow(linha)
        saida.append(buf.getvalue())
    return saida


def xlsx_avisos(wb, nome):
    for ws in wb.worksheets:
        if getattr(ws, "_charts", None) or getattr(ws, "_images", None):
            return ["A planilha '%s' tem gráficos ou imagens, que a versão anonimizada não preserva (os dados e as fórmulas ficam)." % nome]
    return []


# ---------- json / csv na reversão ----------

def json_mapear(obj, fn):
    if isinstance(obj, str):
        return fn(obj)
    if isinstance(obj, list):
        return [json_mapear(x, fn) for x in obj]
    if isinstance(obj, dict):
        return {fn(k): json_mapear(v, fn) for k, v in obj.items()}
    return obj


def json_strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, list):
        for x in obj:
            yield from json_strings(x)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from json_strings(v)


def csv_delimitador(texto):
    amostra = texto.split("\n", 1)[0]
    return max(",;\t|", key=amostra.count) if any(d in amostra for d in ",;\t|") else ","


def csv_mapear(texto, fn):
    delim = csv_delimitador(texto)
    leitor = csv.reader(io.StringIO(texto, newline=""), delimiter=delim)
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=delim, lineterminator="\n")
    for linha in leitor:
        w.writerow([fn(c) for c in linha])
    return buf.getvalue()
