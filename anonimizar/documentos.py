"""Leitores e gravadores de documento: txt/md/csv/json, pdf, docx, xlsx e pptx.

pypdf, python-docx e openpyxl só são importados quando o formato pede. O docx e o pptx são
reescritos dentro do zip (só os trechos de texto mudam), então a formatação sobrevive. Quando um
valor está partido entre runs, o texto novo vai para o primeiro run e o resto do valor é apagado
dos demais. Nenhuma mensagem de erro carrega conteúdo do documento, só o nome do arquivo.
"""
import bisect
import datetime
import csv
import html
import io
import json
import os
import posixpath
import re
import zipfile
from xml.sax.saxutils import escape as xml_escape

LIMITE_ZIP = 200 * 1024 * 1024
MAX_CELULAS = 2_000_000
MAX_LINHAS = 200_000
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
    nomes_baixo = [i.filename.lower() for i in z.infolist()]
    if len(set(nomes_baixo)) != len(nomes_baixo):
        z.close()
        raise ErroMotor("arquivo_invalido", "O arquivo '%s' tem duas partes com o mesmo nome (ou nomes que só diferem na caixa das letras). "
                        "Documento de Office legítimo não faz isso e o programa que abrir pode escolher a parte errada. "
                        "Peça ao agente para gerar de novo." % nome)
    total = sum(i.file_size for i in z.infolist())
    if total > LIMITE_ZIP or len(z.infolist()) > 20000:
        z.close()
        raise ErroMotor("zip_grande", "O arquivo '%s' ocupa mais de 200 MB depois de aberto (ou tem entradas demais). "
                        "Por segurança ele foi recusado. Divida o documento em partes menores." % nome)
    _conferir_sem_dtd(z, caminho, nome)
    return z


def _nome_da_parte(z, procurado):
    """Nome real, dentro do zip, da parte `procurado`: o OPC compara nomes de parte sem distinção de caixa."""
    for info in z.infolist():
        if info.filename.lower() == procurado.lower():
            return info.filename
    raise KeyError(procurado)


_DTD_CONFERIDOS = set()
_PADROES_DTD = [p.lower() for t in ("<!DOCTYPE", "<!ENTITY") for p in (t.encode(), t.encode("utf-16-le"), t.encode("utf-16-be"))]


def _conferir_sem_dtd(z, caminho, nome):
    """OOXML legítimo não declara DTD nem entidade: recusa o pacote que tiver <!DOCTYPE ou <!ENTITY em qualquer parte XML
    (inclusive em UTF-16), porque entidade esconde número e referência da conferência prévia e do parser."""
    try:
        st = os.stat(caminho)
        chave = (os.path.abspath(caminho), st.st_size, st.st_mtime_ns)
    except OSError:
        chave = None
    if chave in _DTD_CONFERIDOS:
        return
    for info in z.infolist():
        if not info.filename.lower().endswith((".xml", ".rels", ".vml")):
            continue
        resto = b""
        with z.open(info) as f:
            while True:
                bloco = f.read(1024 * 1024)
                texto = (resto + bloco).lower()
                if any(p in texto for p in _PADROES_DTD):
                    z.close()
                    raise ErroMotor("xml_proibido", "A parte '%s' do arquivo '%s' declara uma DTD ou entidade XML (<!DOCTYPE/<!ENTITY), que documento de Office "
                                    "legítimo não usa e que pode esconder dados. O arquivo foi recusado: abra e salve de novo no programa de origem."
                                    % (info.filename, nome))
                if not bloco:
                    break
                resto = (resto + bloco)[-64:]
    if chave is not None:
        _DTD_CONFERIDOS.add(chave)


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

_PARTES_DOCX = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$", re.I)
_PARTES_PPTX = re.compile(r"^ppt/(slides/slide|notesSlides/notesSlide)\d+\.xml$", re.I)


def _lxml():
    try:
        from lxml import etree
        return etree
    except ImportError:
        raise ErroMotor("falta_leitor", "O leitor de Word/PowerPoint (lxml, que vem com o python-docx) não está instalado. "
                        "Instale o motor de documentos pelo painel (nível leitores) e tente de novo.") from None


_TIPO_HYPERLINK = "/relationships/hyperlink"
# O Word importa estes ao abrir (RTF/HTML/MHT/docx de altChunk, subdocumento mestre) e RTF carrega campos que a neutralização
# XML não enxerga, então são recusados mesmo internos. oleObject/package internos ficam: o Word só os exibe como objeto e não
# atualiza campos de dentro deles ao abrir ou atualizar o documento principal.
_TIPOS_IMPORTADOS = ("/relationships/aFChunk", "/relationships/subDocument")
_PARTES_XLSX_COM_FETCH = re.compile(r"^xl/(connections\.xml|queryTables/|externalLinks/|webExtensions/)", re.I)


def conferir_sem_vinculos_externos(caminho, nome, so_rels=False):
    """Recusa o pacote OOXML (docx, pptx, xlsx) que tenha relacionamento EXTERNO de qualquer tipo que não seja hyperlink
    (imagem ligada, objeto OLE, modelo anexo, subdocumento, quadro, altChunk, pacote, mídia, vínculo de planilha...), e, no xlsx,
    as partes de conexão de dados, consulta web e vínculo externo. Esses itens buscam conteúdo sozinhos ao abrir ou atualizar e,
    junto com um campo que lê o texto, mandariam o dado real para fora. Hyperlink externo fica: precisa de clique e o endereço
    (Target) nunca é alterado pela reversão, então nenhum dado real entra nele."""
    import xml.etree.ElementTree as ET
    ruins = []
    with abrir_zip(caminho, nome) as z:
        for info in z.infolist():
            f = info.filename
            if not so_rels and _PARTES_XLSX_COM_FETCH.match(f):
                ruins.append(f)
            if not f.lower().endswith(".rels"):
                continue
            try:
                raiz = ET.fromstring(z.read(f))
            except ET.ParseError:
                raise ErroMotor("arquivo_invalido", "A parte '%s' do arquivo '%s' está corrompida. Peça ao agente para gerar de novo." % (f, nome)) from None
            for r in raiz:
                tipo_rel = r.get("Type") or ""
                if tipo_rel.endswith(_TIPOS_IMPORTADOS):
                    ruins.append("%s (%s, bloco importado)" % (f, tipo_rel.rsplit("/", 1)[-1]))
                elif r.get("TargetMode", "").lower() == "external" and not (r.get("Type") or "").endswith(_TIPO_HYPERLINK):
                    ruins.append("%s (%s)" % (f, (r.get("Type") or "").rsplit("/", 1)[-1] or "sem tipo"))
    if ruins:
        raise ErroMotor("vinculo_externo", "O documento devolvido ('%s') tem vínculo externo que busca conteúdo sozinho ao abrir ou atualizar "
                        "(%s). Colocar os dados reais nele poderia mandá-los para fora, então a versão final foi recusada. "
                        "Peça ao agente para gerar de novo sem imagens ligadas, objetos externos nem conexões de dados."
                        % (nome, "; ".join(ruins[:5])))


def _neutralizar_campos(raiz):
    """Tira todo campo do Word de uma parte, deixando só o texto de resultado como texto comum. Devolve True se mudou algo.

    fldSimple vira os runs filhos; campo complexo (fldChar begin/separate/end) perde os delimitadores e a instrução, e
    ficam só os runs entre separate e end, inclusive em campos aninhados (um REF dentro de INCLUDEPICTURE some junto
    com a instrução). instrText, delInstrText e fldData soltos são removidos sempre. Também sai w:dataBinding, que
    liga um controle de conteúdo a um pacote customXml."""
    mudou = False
    for el in list(raiz.iter(W + "fldSimple")):
        pai = el.getparent()
        i = pai.index(el)
        for filho in list(el):
            pai.insert(i, filho)
            i += 1
        pai.remove(el)
        mudou = True
    pilha = []
    remover = []
    for el in raiz.iter(W + "r"):
        marca = el.find(W + "fldChar")
        if marca is not None:
            tipo = marca.get(W + "fldCharType")
            if tipo == "begin":
                pilha.append("instrucao")
            elif tipo == "separate" and pilha:
                pilha[-1] = "resultado"
            elif tipo == "end" and pilha:
                pilha.pop()
            remover.append(el)
        elif "instrucao" in pilha:
            remover.append(el)
    for el in remover:
        el.getparent().remove(el)
    for tag in ("instrText", "delInstrText", "fldData", "dataBinding"):
        for el in list(raiz.iter(W + tag)):
            el.getparent().remove(el)
            mudou = True
    return mudou or bool(remover)


def _tipos_de_conteudo(z, nome):
    """([Content_Types].xml) -> (por PartName em minúsculas, por extensão em minúsculas). Ilegível = recusa."""
    import xml.etree.ElementTree as ET
    try:
        raiz = ET.fromstring(z.read(_nome_da_parte(z, "[Content_Types].xml")))
    except (KeyError, ET.ParseError):
        raise ErroMotor("arquivo_invalido", "O arquivo '%s' não tem um [Content_Types].xml legível. Peça ao agente para gerar de novo." % nome) from None
    por_parte, por_ext = {}, {}
    for el in raiz:
        tipo = (el.get("ContentType") or "").lower()
        if el.tag.endswith("Override") and el.get("PartName"):
            por_parte[el.get("PartName").lstrip("/").lower()] = tipo
        elif el.tag.endswith("Default") and el.get("Extension") is not None:
            por_ext[el.get("Extension").lower()] = tipo
    return por_parte, por_ext


def _eh_parte_xml(z, info, nome, tipos):
    """O Word identifica a parte por relacionamento e tipo de conteúdo, não por pasta nem extensão: vale como XML a parte que
    começa com '<' ou cujo tipo declarado termina em 'xml'. Só passa de fora a parte binária de verdade."""
    if info.is_dir() or info.filename.lower() == "[content_types].xml":
        return False
    if info.file_size == 0:
        return False
    if _parece_xml(z, info, nome):
        return True
    f = info.filename.lower()
    tipo = tipos[0].get(f)
    if tipo is None:
        tipo = tipos[1].get(f.rsplit(".", 1)[-1] if "." in f.rsplit("/", 1)[-1] else "", "")
    return tipo.endswith("xml")


def docx_reverter(entrada, saida, nome, encontrar):
    """Reversão: nós de texto (w:t) do corpo, cabeçalhos, rodapés e notas, e o autor de comentários e revisões (atributo
    de autoria, que a ida troca por marcador de pessoa). Nenhum outro atributo, relacionamento ou propriedade.

    O documento vem do agente, que pode estar comprometido, então ANTES de restaurar qualquer dado:
    - vínculo externo que busca conteúdo (imagem ligada, modelo anexo, OLE, subdocumento...) RECUSA a reversão;
    - campos do Word são NEUTRALIZADOS em toda parte XML do pacote, em qualquer pasta ou extensão (viram o texto de resultado, como PAGE e TOC
      legítimos), em vez de recusar, porque o agente pode gerar campo legítimo. Sem isso, um INCLUDEPICTURE com REF
      aninhado levaria o texto restaurado para a URL ao atualizar os campos;
    - w:dataBinding (controle de conteúdo ligado a customXml) é removido."""
    from ooxml import atributo_de_autoria
    etree = _lxml()
    conferir_sem_vinculos_externos(entrada, nome)
    subs = {}
    with abrir_zip(entrada, nome) as z:
        tipos = _tipos_de_conteudo(z, nome)
        parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False)
        for info in z.infolist():
            f = info.filename
            if not _eh_parte_xml(z, info, nome, tipos):
                continue
            dados = z.read(f)
            if any(p in dados.lower() for p in _PADROES_DTD):
                raise ErroMotor("xml_proibido", "A parte '%s' do arquivo '%s' declara uma DTD ou entidade XML (<!DOCTYPE/<!ENTITY), que documento de Office "
                                "legítimo não usa e que pode esconder dados. O arquivo foi recusado: abra e salve de novo no programa de origem." % (f, nome))
            try:
                raiz = etree.fromstring(dados, parser)
            except etree.XMLSyntaxError:
                raise ErroMotor("arquivo_invalido", "A parte '%s' do arquivo '%s' está corrompida. Peça ao agente para gerar de novo." % (f, nome)) from None
            if next(raiz.iter(W + "subDoc"), None) is not None:
                raise ErroMotor("vinculo_externo", "A parte '%s' do arquivo '%s' importa um subdocumento (w:subDoc), que o Word abre sozinho e pode "
                                "buscar conteúdo de fora. A versão final foi recusada: peça ao agente para gerar de novo sem subdocumentos." % (f, nome))
            if next(raiz.iter(W + "altChunk"), None) is not None:
                raise ErroMotor("vinculo_externo", "A parte '%s' do arquivo '%s' importa um bloco externo (altChunk: RTF, HTML ou outro documento), "
                                "que o Word abre sozinho e pode conter campos que levariam os dados reais para fora. A versão final foi recusada: "
                                "peça ao agente para gerar de novo sem blocos importados." % (f, nome))
            mudou = _neutralizar_campos(raiz)
            if not _PARTES_DOCX.match(f):
                if mudou:
                    subs[f] = etree.tostring(raiz, xml_declaration=True, encoding="UTF-8", standalone=True)
                continue
            for p in raiz.iter(W + "p"):
                ts = [t for t in p.iter(W + "t") if next(t.iterancestors(W + "p")) is p]
                if not ts:
                    continue
                trechos = [t.text or "" for t in ts]
                trocas = encontrar("".join(trechos))
                if not trocas:
                    continue
                for t, novo in zip(ts, distribuir(trechos, trocas)):
                    t.text = novo
                    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                mudou = True
            for el in raiz.iter():
                if not isinstance(el.tag, str):
                    continue
                for k, v in list(el.attrib.items()):
                    if k.rsplit("}", 1)[-1] != "initials" and atributo_de_autoria(el, k) and v.strip():
                        trocas = encontrar(v)
                        if trocas:
                            el.set(k, distribuir([v], trocas)[0])
                            mudou = True
            if mudou:
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


def pptx_transformar(entrada, saida, nome, encontrar, reverter=False):
    """Na reversão (reverter=True) recusa vínculo externo que busca conteúdo (imagem ligada, OLE...). Os campos a:fld do
    PowerPoint (número, data) só guardam texto e não leem o documento; hyperlink só age com clique e o endereço não muda."""
    if reverter:
        conferir_sem_vinculos_externos(entrada, nome)
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


def _numero_da_coluna(letras):
    n = 0
    for c in letras.upper():
        n = n * 26 + (ord(c) - 64)
    return n


MAX_COLUNA, MAX_LINHA_EXCEL = 16384, 1048576
_RX_CELULA = re.compile(r"\$?([A-Za-z]{1,3})\$?(\d+)")
_RX_COLUNA = re.compile(r"\$?([A-Za-z]{1,3})")
_RX_LINHA = re.compile(r"\$?(\d+)")


def _extremo(txt):
    """(coluna, linha) de A1, (coluna, None) de A ou (None, linha) de 1; None se ilegível ou fora dos limites do Excel.
    Aceita zeros à esquerda e qualquer quantidade de dígitos: o openpyxl converte para int, então a conferência também."""
    m = _RX_CELULA.fullmatch(txt)
    if m:
        col, lin = _numero_da_coluna(m.group(1)), int(m.group(2))
    else:
        m = _RX_COLUNA.fullmatch(txt)
        if m:
            col, lin = _numero_da_coluna(m.group(1)), None
        else:
            m = _RX_LINHA.fullmatch(txt)
            if not m:
                return None
            col, lin = None, int(m.group(1))
    if (col is not None and not 1 <= col <= MAX_COLUNA) or (lin is not None and not 1 <= lin <= MAX_LINHA_EXCEL):
        return None
    return col, lin


def _area(ref):
    """(linhas, colunas) de uma referência A1:B2, A1, A:C ou 1:3; None se não for uma referência legível ou passar de XFD1048576."""
    partes = ref.strip().split(":")
    if len(partes) > 2:
        return None
    ext = [_extremo(p) for p in partes]
    if None in ext:
        return None
    if len(ext) == 1:
        if ext[0][0] is None or ext[0][1] is None:
            return None
        return 1, 1
    (c1, l1), (c2, l2) = ext
    if (c1 is None) != (c2 is None) or (l1 is None) != (l2 is None):
        return None
    linhas = MAX_LINHA_EXCEL if l1 is None else abs(l2 - l1) + 1
    colunas = MAX_COLUNA if c1 is None else abs(c2 - c1) + 1
    return linhas, colunas


def _area_total(sqref):
    """Soma as áreas de uma lista separada por espaço (sqref); None se alguma parte for ilegível."""
    total = 0
    for parte in sqref.split():
        ar = _area(parte)
        if ar is None:
            return None
        total += ar[0] * ar[1]
    return total


# Quantos elementos de cada tipo uma planilha pode ter (limite por parte); o que passa disso é tratado como bomba.
LIMITES_DE_CONTAGEM = {"c": MAX_CELULAS, "row": MAX_LINHAS, "si": MAX_CELULAS, "xf": 200_000, "dxf": 100_000, "numFmt": 10_000, "font": 100_000,
                       "fill": 100_000, "border": 100_000, "sheet": 1_000, "definedName": 100_000, "hyperlink": 200_000, "comment": 200_000,
                       "cfRule": 100_000, "dataValidation": 100_000, "Relationship": 100_000}


class _LimiteDeBytes:
    """Leitura de uma parte do zip com teto de bytes descompactados."""

    def __init__(self, f, limite, parte=None, nome=None):
        self.f, self.restante, self.parte, self.nome, self.resto = f, limite, parte, nome, b""

    def read(self, n=-1):
        dados = self.f.read(n)
        if self.parte is not None:
            texto = (self.resto + dados).lower()
            if any(p in texto for p in _PADROES_DTD):
                raise ErroMotor("xml_proibido", "A parte '%s' do arquivo '%s' declara uma DTD ou entidade XML (<!DOCTYPE/<!ENTITY), que documento de Office "
                                "legítimo não usa e que pode esconder dados. O arquivo foi recusado: abra e salve de novo no programa de origem."
                                % (self.parte, self.nome))
            self.resto = (self.resto + dados)[-64:]
        self.restante -= len(dados)
        if self.restante < 0:
            raise ErroMotor("zip_grande", "Uma parte do arquivo passa do limite de tamanho depois de aberta. Divida o documento em partes menores.")
        return dados


# Espaço em branco que uma parte pode ter antes do primeiro "<". O expat aceita qualquer quantidade, então a decisão de conferir
# a parte não pode olhar só um começo fixo: acima deste teto a parte é recusada em vez de passar sem conferência.
MAX_ESPACO_INICIAL = 65_536


def _parece_xml(z, info, nome="planilha"):
    """Decide pelo início do conteúdo, nunca pelo nome: o openpyxl abre as partes pelos relacionamentos, então
    'worksheets/sheet1.xml' ou 'xl/planilha.dat' valem tanto quanto 'xl/worksheets/sheet1.xml'.
    Lê em streaming, pulando BOM, espaços e bytes nulos (UTF-16 tem um byte nulo por caractere) até o primeiro byte útil."""
    if info.is_dir() or info.file_size == 0:
        return False
    pulados, inicio = 0, True
    with z.open(info) as f:
        while True:
            bloco = f.read(4096)
            if not bloco:
                return False
            if inicio:
                inicio = False
                for bom in (b"\xef\xbb\xbf", b"\xff\xfe", b"\xfe\xff"):
                    if bloco.startswith(bom):
                        bloco, pulados = bloco[len(bom):], pulados + len(bom)
                        break
            util = bloco.lstrip(b"\x00 \t\r\n")
            pulados += len(bloco) - len(util)
            if pulados > MAX_ESPACO_INICIAL:
                raise ErroMotor("arquivo_invalido", "A parte '%s' do arquivo '%s' começa com mais de %d bytes de espaço em branco antes do conteúdo, "
                                "o que documento de Office legítimo não tem e impediria a conferência de segurança. O arquivo foi recusado: "
                                "abra e salve de novo no programa de origem." % (info.filename, nome, MAX_ESPACO_INICIAL))
            if util:
                return util.startswith(b"<")


def _ref_ilegivel(nome, parte, elemento, ref):
    return ErroMotor("arquivo_invalido", "A planilha '%s' tem uma referência que não consigo ler (%s=\"%s\" em <%s>, parte %s). "
                     "Abra e salve de novo no Excel, depois envie." % (nome, "ref", ref[:60], elemento, parte))


# Elementos cujo @ref o openpyxl materializa em células (ws[ref] ou MergedCell), conferido no código da 3.1:
#   mergeCell    worksheet/_reader.py bind_merged_cells -> _clean_merge_range cria um MergedCell por célula da área
#   hyperlink    worksheet/_reader.py bind_hyperlinks   -> ws[link.ref] cria todas as células da área
#   comment      reader/excel.py                        -> ws[ref] (um intervalo vira uma criação de células por linha e coluna)
# O resto (dataValidation, conditionalFormatting, autoFilter, cols, tabelas, fórmulas matriciais, nomes definidos) guarda a referência
# sem criar célula; foi testado com XFD1048576 e carrega em milissegundos.
_ELEMENTOS_COM_AREA = ("mergeCell", "hyperlink", "comment")


def conferir_planilha_crua(caminho, nome):
    """Lê toda parte XML do pacote em streaming (expat, sem entidade externa) ANTES do openpyxl.

    Usa os atributos já decodificados (dimension/@ref, mergeCell/@ref: &#65; vira A), soma numa conta só as áreas que o openpyxl
    materializa (mesclagens, hyperlinks, comentários) e conta os elementos que explodem memória (células, linhas, strings
    compartilhadas, estilos). Acima do limite: planilha_grande, sem carregar. Referência que não dá para ler é recusada.
    """
    import xml.etree.ElementTree as ET
    with abrir_zip(caminho, nome) as z:
        materializadas = 0
        areas = {}      # parte -> células que ela materializa
        alvos = {}      # parte de destino normalizada -> [tipos dos relacionamentos que apontam para ela]
        for info in z.infolist():
            if not _parece_xml(z, info, nome):
                continue
            contagem, pilha, abas_por_id = {}, [], {}
            eh_rels = info.filename.lower().endswith(".rels")
            try:
                with z.open(info) as bruto:
                    for evento, el in ET.iterparse(_LimiteDeBytes(bruto, LIMITE_ZIP, info.filename, nome), events=("start", "end")):
                        local = el.tag.rsplit("}", 1)[-1]
                        if evento == "start":
                            pilha.append(el)
                            n = contagem[local] = contagem.get(local, 0) + 1
                            if n > LIMITES_DE_CONTAGEM.get(local, 1 << 62):
                                raise _planilha_grande(nome, info.filename, "a parte tem mais de %d elementos <%s>" % (LIMITES_DE_CONTAGEM[local], local))
                            if local == "sheet":
                                # só o atributo de relacionamento que o openpyxl lê conta (x:id de outro namespace é ignorado por ele)
                                rids = [el.attrib[k] for k in _ATRIBUTOS_RID if k in el.attrib]
                                if len(rids) != 1:
                                    raise _aba_repetida(nome, info.filename, "uma aba do arquivo não tem exatamente um r:id de relacionamento")
                                rid = rids[0]
                                abas_por_id[rid] = abas_por_id.get(rid, 0) + 1
                                if abas_por_id[rid] > 1:
                                    raise _aba_repetida(nome, info.filename, "várias abas do arquivo apontam para o mesmo relacionamento (%s)" % rid[:40])
                            elif eh_rels and local == "Relationship":
                                tipo = (el.get("Type") or "").rsplit("/", 1)[-1]
                                if el.get("TargetMode") == "External":
                                    # o openpyxl não normaliza o destino externo, mas o procura entre as partes do pacote: alvo igual ao nome de
                                    # uma parte interna é carregado como ela
                                    if tipo in _TIPOS_CARREGADOS_POR_USO:
                                        raise _aba_repetida(nome, info.filename, "um relacionamento externo do tipo %s" % tipo[:20])
                                    alvo = (el.get("Target") or "").lower()
                                else:
                                    alvo = _alvo_normalizado(info.filename, el.get("Target") or "").lower()
                                alvos.setdefault(alvo, []).append(el.get("Type") or "")
                            if local == "dimension" or local in _ELEMENTOS_COM_AREA:
                                ref = (el.get("ref") or "").strip()
                                if not ref:
                                    continue
                                if local == "dimension":
                                    ar = _area(ref)
                                    if ar is None:
                                        raise _ref_ilegivel(nome, info.filename, local, ref)
                                    if ar[0] > MAX_LINHAS or ar[0] * ar[1] > MAX_CELULAS:
                                        raise _planilha_grande(nome, info.filename, "a dimensão declarada tem %d linhas e %d colunas" % ar)
                                else:
                                    total = _area_total(ref)
                                    if total is None:
                                        raise _ref_ilegivel(nome, info.filename, local, ref)
                                    materializadas += total
                                    areas[info.filename.lower()] = areas.get(info.filename.lower(), 0) + total
                                    if materializadas > MAX_CELULAS:
                                        raise _planilha_grande(nome, info.filename, "as áreas de mesclagens, links e comentários somam mais de %d células" % MAX_CELULAS)
                        else:
                            pilha.pop()
                            if len(pilha) >= 2:      # solta o que já foi lido: a memória não cresce com a planilha
                                pilha[-1].remove(el)
            except ET.ParseError:
                # só o .vml (desenho legado que o Excel às vezes grava malformado e o openpyxl não interpreta) é tolerado; qualquer outra
                # parte com cara de XML pode ser aberta pelo relacionamento, então XML quebrado é recusado
                if not info.filename.lower().endswith(".vml"):
                    raise ErroMotor("arquivo_invalido", "A parte '%s' da planilha '%s' está corrompida. Abra e salve de novo no Excel, depois envie."
                                    % (info.filename, nome)) from None
        for alvo, tipos in alvos.items():
            if len(tipos) > 1 and (areas.get(alvo) or any(t.rsplit("/", 1)[-1] in _TIPOS_CARREGADOS_POR_USO for t in tipos)):
                raise _aba_repetida(nome, alvo, "%d relacionamentos apontam para a mesma parte" % len(tipos))


# Tipos de relacionamento cuja parte o openpyxl lê de novo a cada vez que é apontada (aba, folha de gráfico, comentários). A soma das
# áreas conta cada parte uma vez; se a mesma parte pudesse ser apontada várias vezes, um pacote de poucos KB multiplicaria a mesclagem
# por mil. Partes compartilhadas de verdade (imagem, tema, estilos, desenhos) não entram aqui e continuam permitidas.
_TIPOS_CARREGADOS_POR_USO = ("worksheet", "chartsheet", "comments", "dialogsheet", "macrosheet")
# Namespaces do atributo id de <sheet> que o openpyxl reconhece (descriptors/excel.py, Relation.namespace) mais a variante strict do OOXML.
_ATRIBUTOS_RID = ("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id",
                  "{http://purl.oclc.org/ooxml/officeDocument/relationships}id")


def _alvo_normalizado(rels, alvo):
    """Mesma regra do openpyxl (get_dependents): '/x' é absoluto no pacote; o resto é relativo à pasta que contém a pasta _rels."""
    if alvo.startswith("/"):
        return posixpath.normpath(alvo[1:])
    pai = posixpath.split(posixpath.dirname(rels))[0]
    return posixpath.normpath(posixpath.join(pai, alvo))


def _aba_repetida(nome, parte, motivo):
    return ErroMotor("arquivo_invalido", "A planilha '%s' faz a mesma aba ou os mesmos comentários serem carregados mais de uma vez (%s; parte %s), "
                     "o que planilha gerada pelo Excel não faz e permitiria esconder uma mesclagem enorme. O arquivo foi recusado: "
                     "abra e salve de novo no Excel, depois envie." % (nome, motivo, parte))


def _planilha_grande(nome, parte, motivo):
    return ErroMotor("planilha_grande", "A planilha '%s' é grande demais para anonimizar: %s (parte %s; o limite é %d células e %d linhas por aba). "
                     "Desfaça as mesclagens enormes, apague linhas e colunas vazias ou divida a planilha." % (nome, motivo, parte, MAX_CELULAS, MAX_LINHAS))


def xlsx_abrir(caminho, nome, **kw):
    openpyxl = _importar("openpyxl", "openpyxl", nome)
    conferir_planilha_crua(caminho, nome)
    try:
        wb = openpyxl.load_workbook(caminho, **kw)
        conferir_tamanho(wb, nome)
        return wb
    except ErroMotor:
        raise
    except Exception as e:
        raise ErroMotor("arquivo_invalido", "Não consegui abrir a planilha '%s' (%s). Abra e salve de novo no Excel, depois envie."
                        % (nome, type(e).__name__)) from None


def celulas_existentes(ws):
    """Só as células que existem no arquivo, em ordem. Nunca percorre o retângulo da dimensão (A1 e XFD1048576 são 17 bilhões)."""
    return sorted(ws._cells.values(), key=lambda c: (c.row, c.column))


def conferir_tamanho(wb, nome):
    for ws in wb.worksheets:
        existentes, linhas, colunas = len(ws._cells), ws.max_row or 0, ws.max_column or 0
        if existentes > MAX_CELULAS or linhas > MAX_LINHAS or linhas * colunas > MAX_CELULAS:
            raise ErroMotor("planilha_grande", "A aba '%s' da planilha '%s' é grande demais para anonimizar (%d células com valor, %d linhas, %d colunas; "
                            "o limite é %d células, %d linhas e %d células no retângulo da aba). Apague as linhas e colunas vazias ou divida a planilha em partes."
                            % ("(aba %d)" % (wb.worksheets.index(ws) + 1), nome, existentes, linhas, colunas, MAX_CELULAS, MAX_LINHAS, MAX_CELULAS))


def xlsx_celulas(wb):
    """Todas as células com valor ou com comentário (comentário em célula vazia também é dado pessoal)."""
    for ws in wb.worksheets:
        yield from xlsx_celulas_da_aba(ws)


def _eh_numero(c):
    return c.data_type == "n" and isinstance(c.value, (int, float)) and not isinstance(c.value, bool) and not c.is_date


def numero_como_texto(v):
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return None
        return str(int(v)) if v.is_integer() else repr(v)
    return str(v)


def texto_da_formula(v):
    """Texto de uma fórmula de célula: string, ArrayFormula (.text) ou DataTableFormula (sem texto: vazio)."""
    if isinstance(v, str):
        return v
    t = getattr(v, "text", None)
    return t if isinstance(t, str) else ""


def cabecalhos(ws):
    """Coluna -> primeiro texto das 3 primeiras linhas (contexto de CPF, telefone, conta...)."""
    cab = {}
    for c in celulas_existentes(ws):
        if c.row <= 3 and isinstance(c.value, str) and c.value.strip() and c.column not in cab:
            cab[c.column] = c.value
    return cab


def xlsx_autores(wb):
    """Autores de comentário não vazios: autoria é dado pessoal, o nome seja ou não reconhecido."""
    return list({c.comment.author.strip(): None for c in xlsx_celulas(wb) if c.comment is not None and (c.comment.author or "").strip()})


def xlsx_textos(wb):
    """Texto de células (inclusive texto de fórmulas), comentários, autores e nomes de aba."""
    saida = [ws.title for ws in wb.worksheets]
    for c in xlsx_celulas(wb):
        if c.data_type == "f":
            saida.append(texto_da_formula(c.value))
        elif isinstance(c.value, str):
            saida.append(c.value)
        if c.comment is not None:
            saida += [t for t in (c.comment.text, c.comment.author) if t]
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


def _literal_puro(texto):
    m = re.fullmatch(r'=\s*"((?:[^"]|"")*)"\s*', texto)
    return m.group(1).replace('""', '"') if m else None


def trocar_texto_de_celula(sessao, v, cabecalho):
    """Texto de célula já filtrado. Número guardado como texto ("11988776655", "445566-7") usa o título da coluna."""
    novo = sessao.trocar(v)
    if novo == v and re.fullmatch(r"[\d\s().+\-]{8,22}", v.strip()):
        m = sessao.numero_para_marcador(re.sub(r"\D", "", v), cabecalho)
        if m:
            return m
    return novo


_RX_LITERAL_NUMERICO = re.compile(r"(?<![A-Za-z_$\d.!'\"])(\d{6,14})(?![\d.]|[A-Za-z_(!])")


def xlsx_transformar(wb, sessao):
    """Anonimiza o workbook aberto: nomes de aba, células de texto, números, fórmulas com dado, comentários.

    Devolve quantas fórmulas foram trocadas por texto (a fórmula levava dado pessoal dentro do literal).
    """
    novos = {}
    usados = set()
    for ws in wb.worksheets:
        novos[ws.title] = _titulo_seguro(sessao.trocar(ws.title), usados)
    mudaram = {a: b for a, b in novos.items() if a != b}
    for ws in wb.worksheets:   # as fórmulas passam a apontar para o nome novo antes de qualquer outra coisa
        for c in celulas_existentes(ws):
            if c.data_type == "f" and isinstance(c.value, str):
                for velho, novo in mudaram.items():
                    c.value = c.value.replace("'%s'!" % velho, "'%s'!" % novo).replace(velho + "!", novo + "!")
            elif c.data_type == "f" and hasattr(c.value, "text") and isinstance(c.value.text, str):
                for velho, novo in mudaram.items():
                    c.value.text = c.value.text.replace("'%s'!" % velho, "'%s'!" % novo).replace(velho + "!", novo + "!")
    for ws in wb.worksheets:
        ws.title = novos[ws.title]
    formulas = 0
    datas = bool(sessao.opcoes.get("datas"))
    for ws in wb.worksheets:
        cab = cabecalhos(ws)
        for c in xlsx_celulas_da_aba(ws):
            v = c.value
            ctx = cab.get(c.column, "")
            if v is None:
                pass   # célula vazia: só o comentário (abaixo) tem o que tratar
            elif datas and isinstance(v, datetime.date):
                c.value = sessao.data_para_marcador(v)
                c.data_type = "s"
                c.number_format = "General"
            elif _eh_numero(c):
                texto = numero_como_texto(v)
                m = sessao.numero_para_marcador(texto, ctx) if texto else None
                if m:
                    c.value = m
            elif isinstance(v, str) or c.data_type == "f":
                if c.data_type == "f" and not isinstance(v, str):   # fórmula matricial / tabela de dados
                    texto_f = texto_da_formula(v)
                    v = texto_f
                    if not texto_f:
                        continue
                trocas = sessao.encontrar(v)
                novo = distribuir([v], trocas)[0] if trocas else v
                if c.data_type == "f":
                    # literal numérico na fórmula recebe o mesmo tratamento contextual das células numéricas
                    novo = _RX_LITERAL_NUMERICO.sub(lambda mt: sessao.numero_para_marcador(mt.group(1), ctx) or mt.group(1), novo)
                    if novo != v:
                        puro = _literal_puro(novo)
                        c.value = puro if puro is not None else novo.lstrip("=")
                        c.data_type = "s"
                        formulas += 1
                else:
                    if not trocas:
                        novo = trocar_texto_de_celula(sessao, v, ctx)
                    if novo != v:
                        c.value = novo
                        c.data_type = "s"
            if c.comment is not None:
                t, a = c.comment.text, c.comment.author
                if t and sessao.trocar(t) != t:
                    c.comment.text = sessao.trocar_sem_contar(t)
                if a and sessao.trocar(a) != a:
                    c.comment.author = sessao.trocar_sem_contar(a)
        ws._images = []
        ws._charts = []
    wb._external_links = []
    wb.properties.creator = ""
    wb.properties.lastModifiedBy = ""
    return formulas


def xlsx_celulas_da_aba(ws):
    for c in celulas_existentes(ws):
        if c.value is not None or c.comment is not None:
            yield c


def xlsx_reverter(wb, valores, encontrar):
    """Reversão: só texto de célula e autor de comentário (nunca nome de aba, texto de comentário, link ou propriedade).

    O arquivo sai SEM fórmulas: cada fórmula vira o valor em cache (ou, se nunca foi calculada, o texto dela como
    texto inerte). Assim uma fórmula como WEBSERVICE(...&A1) não consegue mandar o dado real para fora.
    """
    for ws in wb.worksheets:
        ws_v = valores[ws.title] if ws.title in valores.sheetnames else None
        for c in xlsx_celulas_da_aba(ws):
            v = c.value
            if v is None:
                pass
            elif c.data_type == "f":
                cache = ws_v[c.coordinate].value if ws_v is not None else None
                v = cache if cache is not None else texto_da_formula(v)
                c.data_type = "s" if isinstance(v, str) else c.data_type
            if isinstance(v, str):
                trocas = encontrar(v)
                if trocas:
                    v = distribuir([v], trocas)[0]
                c.value = v
                c.data_type = "s"   # texto começado em "=" não pode voltar a ser fórmula
            elif c.data_type == "n" or c.value is not v:
                c.value = v
            if c.comment is not None and c.comment.author:
                trocas = encontrar(c.comment.author)
                if trocas:
                    c.comment.author = distribuir([c.comment.author], trocas)[0]
    for nome in list(wb.defined_names):
        del wb.defined_names[nome]
    for ws in wb.worksheets:
        for nome in list(ws.defined_names):
            del ws.defined_names[nome]
    wb._external_links = []


def neutralizar_html_md(texto):
    """HTML cru do markdown é desativado sem exceção: todo "<" vira "&lt;", inclusive dentro de código.

    Não tenta entender cerca de código nem crase escapada: o que o CommonMark trata como HTML não pode escapar por um erro do filtro.
    Devolve (texto, mudou).
    """
    novo = texto.replace("<", "&lt;")
    return novo, novo != texto


def csv_inerte(celula):
    """CSV que abre no Excel: célula que começa com = + - @ tab ou CR ganha apóstrofo e não vira fórmula."""
    return "'" + celula if celula[:1] in ("=", "+", "-", "@", "\t", "\r") else celula


def xlsx_csvs(caminho_original, nome, wb_anon, sessao):
    """Um CSV por aba, com os valores em cache (ou o texto da fórmula, se nunca foi calculada)."""
    valores = xlsx_abrir(caminho_original, nome, data_only=True)
    saida = []
    for ws_v, ws in zip(valores.worksheets, wb_anon.worksheets):
        cab = cabecalhos(ws_v)
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        for lin_v, lin in zip(ws_v.iter_rows(), ws.iter_rows()):
            linha = []
            for cv, c in zip(lin_v, lin):
                if cv.value is None and c.data_type != "f":
                    # fórmula sem valor em cache que já foi trocada por texto na planilha (ou célula vazia): o texto já está filtrado
                    linha.append("" if c.value is None else c.value)
                    continue
                v = cv.value if cv.value is not None else texto_da_formula(c.value)
                if isinstance(v, str):
                    v = trocar_texto_de_celula(sessao, v, cab.get(cv.column, ""))
                elif v is not None and _eh_numero(cv):
                    texto = numero_como_texto(v)
                    m = sessao.numero_para_marcador(texto, cab.get(cv.column, "")) if texto else None
                    v = m or v
                elif isinstance(v, datetime.date) and sessao.opcoes.get("datas"):
                    v = sessao.data_para_marcador(v)
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

def json_mapear(obj, fn, fn_num=None, ctx=""):
    """Aplica fn às strings (e chaves). fn_num(texto_do_numero, nome_da_chave) pode trocar um número por texto."""
    if isinstance(obj, str):
        return fn(obj)
    if isinstance(obj, list):
        return [json_mapear(x, fn, fn_num, ctx) for x in obj]
    if isinstance(obj, dict):
        return {fn(k): json_mapear(v, fn, fn_num, k) for k, v in obj.items()}
    if fn_num is not None and isinstance(obj, (int, float)) and not isinstance(obj, bool):
        texto = numero_como_texto(obj)
        novo = fn_num(texto, ctx) if texto else None
        return novo if novo is not None else obj
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
