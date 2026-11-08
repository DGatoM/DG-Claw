"""Docx e xlsx por dentro: filtro em TODA parte XML do zip, remoção do que não dá para filtrar.

O Office guarda dado pessoal em muito lugar além do corpo: propriedades (docProps), relacionamentos
externos, comentários, hyperlinks, nomes definidos, XML personalizado, texto de formas. Aqui cada nó
de texto e cada valor de atributo de cada parte XML passa pelo filtro. O que é binário ou externo
(imagens e mídia, objetos embutidos, macros, links externos) não dá para filtrar: sai do arquivo,
junto com os relacionamentos e as referências a eles, e o arquivo continua válido.
Nenhuma mensagem aqui carrega conteúdo, só nome de arquivo e contagem.
"""
import posixpath
import re
import zipfile

from documentos import ErroMotor, abrir_zip, distribuir

NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
PARAGRAFOS = {W + "p", A + "p", S + "si", S + "text", S + "is"}
TEXTOS = {W + "t", W + "delText", A + "t", S + "t"}
# Atributos que costumam carregar texto de gente (os demais passam só pelos detectores de número e contato).
ATRIBUTOS_HUMANOS = {"author", "initials", "descr", "title", "alt", "Target", "display", "tooltip", "location", "href", "lastAuthor"}
# Atributos de autoria: nome de gente mesmo curto ("Ana"). Não passam pelo corte de seis caracteres e as iniciais saem em branco.
ATRIBUTOS_DE_AUTORIA = {"author", "initials", "lastAuthor", "displayName", "userId"}
ELEMENTOS_COM_NOME_DE_PESSOA = {"cmAuthor", "person"}
# Carimbos de criação/alteração do arquivo: não são dado do documento; saem zerados da saída.
CARIMBOS_DE_TEMPO = {"created", "modified", "lastPrinted"}
GUID = re.compile(r"^\{?[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}?$")
NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def atributo_de_autoria(el, chave):
    local = chave.rsplit("}", 1)[-1]
    if local in ATRIBUTOS_DE_AUTORIA:
        return True
    return local == "name" and isinstance(el.tag, str) and el.tag.rsplit("}", 1)[-1] in ELEMENTOS_COM_NOME_DE_PESSOA


def atributo_estrutural(el, chave, valor):
    """True só para atributo de estrutura do Office cujo valor tem cara de GUID (w14:paraId, w:rsid*, xr:uid, fmtid, uri...).

    Qualquer outro atributo com cara de UUID (w:tooltip, title, descr...) passa pelo detector de chave PIX.
    """
    if not GUID.match(valor):
        return False
    ns, local = (chave[1:].split("}", 1) if chave.startswith("{") else ("", chave))
    pai = el.tag.split("}")[-1] if isinstance(el.tag, str) else ""
    if ns == NS_W and local.startswith("rsid"):
        return True
    if local in ("paraId", "textId") and ns.startswith("http://schemas.microsoft.com/office/word/"):
        return True
    if local == "uid" and ns.startswith("http://schemas.microsoft.com/office/spreadsheetml/") and "revision" in ns:
        return True
    if local == "itemID" and pai == "datastoreItem" and ns.endswith("/customXml"):
        return True
    if ns == "" and ((local == "fmtid" and pai == "property") or (local == "uri" and pai == "ext")):
        return True
    return local == "val" and pai in ("docId", "persistentDocumentId") and ns.startswith("http://schemas.microsoft.com/office/word/")

TIPOS_REL_EXTERNOS_REMOVIDOS = {"image", "oleObject", "externalLink", "attachedTemplate", "frame", "audio", "video", "package", "vbaProject"}
SUBIR_ATE = {"drawing", "pict", "object", "pic", "oleObj", "control", "legacyDrawing", "legacyDrawingHF", "externalReference",
             "picture", "graphicFrame", "oneCellAnchor", "twoCellAnchor", "absoluteAnchor"}


def lxml():
    try:
        from lxml import etree
        return etree
    except ImportError:
        raise ErroMotor("falta_leitor", "O leitor de Word/Excel (lxml, que vem com o python-docx) não está instalado. "
                        "Instale o motor de documentos pelo painel (nível leitores) e tente de novo.") from None


def eh_xml(nome):
    return nome.lower().endswith((".xml", ".rels", ".vml"))


ELEMENTOS_INTEIROS = {"conditionalFormatting", "extLst", "sparklineGroups"}
ELEMENTOS_DE_FORMULA = {"f", "calculatedColumnFormula", "totalsRowFormula", "formula", "formula1", "formula2", "definedNames", "definedName"}
_RX_FORMULA_BRUTA = re.compile(r"<(?:[\w.-]+:)?(?:" + "|".join(sorted(ELEMENTOS_DE_FORMULA | ELEMENTOS_INTEIROS)) + r")(?=[\s>/])"
                               r"|\btype\s*=\s*[\"']formula[\"']")
_PARTES_ATIVAS = ("vbaproject", "externallinks/", "/querytables/", "/pivotcache", "/connections.xml", "/charts/", "/webextensions/")


def categoria_removida(nome, sem_formulas=False):
    """None se a parte fica; senão o nome da categoria para o aviso."""
    if nome.lower() == "[content_types].xml":
        return None
    baixo = nome.lower()
    if sem_formulas and "/charts/" in baixo:
        return "gráficos"
    if "vbaproject" in baixo:
        return "macros"
    if "externallinks/" in baixo:
        return "links para outras planilhas"
    if baixo.endswith("/connections.xml") or "/querytables/" in baixo or "/webextensions/" in baixo or "/pivotcache/" in baixo:
        return "conexões de dados"
    if "/embeddings/" in baixo or "oleobject" in baixo or "/activex/" in baixo:
        return "objetos embutidos"
    if "/media/" in baixo or "thumbnail" in baixo or baixo.endswith((".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".emf", ".wmf", ".svg", ".webp")):
        return "imagens e mídia"
    if not eh_xml(nome):
        return "arquivos binários"
    return None


def _analisar(etree, dados, nome):
    try:
        parser = etree.XMLParser(recover=nome.lower().endswith(".vml"), resolve_entities=False, no_network=True, huge_tree=False,
                                 remove_comments=True, remove_pis=True)
        return etree.fromstring(dados, parser)
    except etree.XMLSyntaxError:
        raise ErroMotor("arquivo_invalido", "Uma parte interna do arquivo está corrompida (%s). "
                        "Abra e salve de novo no programa de origem, depois envie." % nome) from None


def _serializar(etree, raiz):
    return etree.tostring(raiz, xml_declaration=True, encoding="UTF-8", standalone=True)


def _origem_do_rels(nome_rels):
    pasta, arq = posixpath.split(nome_rels)
    base = posixpath.dirname(pasta)
    fonte = arq[:-len(".rels")]
    return posixpath.join(base, fonte) if fonte else ""


def _resolver(origem, alvo):
    if alvo.startswith("/"):
        return alvo[1:]
    return posixpath.normpath(posixpath.join(posixpath.dirname(origem), alvo))


def _paragrafo_de(el):
    for a in el.iterancestors():
        if a.tag in PARAGRAFOS:
            return a
    return None


def paragrafos(raiz):
    """(paragrafo, [elementos de texto dele]) em ordem."""
    for p in raiz.iter(*PARAGRAFOS):
        ts = [t for t in p.iter(*TEXTOS) if _paragrafo_de(t) is p]
        if ts:
            yield p, ts


def _so_texto_de_celula(nome):
    """Partes cujo texto já foi tratado célula a célula (openpyxl): o filtro daqui não repete, para não neutralizar marcador nosso."""
    nome = nome.lower()
    return nome == "xl/sharedstrings.xml" or nome.startswith("xl/comments")


def _ignora_texto(nome, el):
    if _so_texto_de_celula(nome):
        return True
    return nome.lower().startswith("xl/worksheets/") and _texto_de_celula(el)


def _texto_de_celula(el):
    """Nó de texto de uma célula (valor, fórmula, texto em linha): quem trata é a camada do openpyxl."""
    if el.tag.split("}")[-1] in ("v", "f", "t", "is"):
        return True
    return any(a.tag.split("}")[-1] == "c" for a in el.iterancestors())


def textos_para_deteccao(caminho, nome, so_nao_celulas=False):
    """(conteudo, atributos_para_nomes, atributos_para_regex): tudo o que o detector precisa ver."""
    etree = lxml()
    conteudo, attr_ner, attr_regex = [], set(), set()
    with abrir_zip(caminho, nome) as z:
        for info in z.infolist():
            f = info.filename
            if not eh_xml(f) or categoria_removida(f) or (so_nao_celulas and _so_texto_de_celula(f)):
                continue
            raiz = _analisar(etree, z.read(f), f)
            tratados = set()
            for _p, ts in paragrafos(raiz):
                if not (so_nao_celulas and f.lower().startswith("xl/worksheets/")):
                    conteudo.append("".join(t.text or "" for t in ts))
                tratados.update(ts)
            for el in raiz.iter():
                if not isinstance(el.tag, str):
                    continue
                if f.lower() == "docprops/core.xml" and el.tag.split("}")[-1] in CARIMBOS_DE_TEMPO:
                    continue
                if el not in tratados and el.text and el.text.strip() and not (so_nao_celulas and _ignora_texto(f, el)):
                    conteudo.append(el.text.strip())
                for k, v in el.attrib.items():
                    if (len(v) >= 6 or (v.strip() and atributo_de_autoria(el, k))) and not atributo_estrutural(el, k, v):
                        (attr_ner if k.split("}")[-1] in ATRIBUTOS_HUMANOS else attr_regex).add(v)
    return conteudo, sorted(attr_ner), sorted(attr_regex)


def autores_para_registro(caminho, nome):
    """Valores não vazios dos atributos de autoria (menos iniciais): autoria é dado pessoal, o nome seja ou não reconhecido."""
    etree = lxml()
    achados = {}
    with abrir_zip(caminho, nome) as z:
        for info in z.infolist():
            f = info.filename
            if not eh_xml(f) or categoria_removida(f):
                continue
            raiz = _analisar(etree, z.read(f), f)
            for el in raiz.iter():
                if not isinstance(el.tag, str):
                    continue
                for k, v in el.attrib.items():
                    if k.rsplit("}", 1)[-1] != "initials" and v.strip() and atributo_de_autoria(el, k) and not atributo_estrutural(el, k, v):
                        achados.setdefault(v.strip(), None)
    return list(achados)


def reescrever(entrada, saida, nome, encontrar, avisos, so_nao_celulas=False, sem_formulas=False):
    """Reescreve o docx/xlsx filtrando tudo. `encontrar(texto, estrutural, neutralizar)` devolve trocas."""
    etree = lxml()
    removidos_por_categoria = {}
    with abrir_zip(entrada, nome) as z:
        nomes = [i.filename for i in z.infolist()]
        removidos = set()
        removidos_baixo = set()
        for n in nomes:
            c = categoria_removida(n, sem_formulas)
            if c:
                removidos.add(n)
                removidos_baixo.add(n.lower())
                removidos_por_categoria[c] = removidos_por_categoria.get(c, 0) + 1
        subs = {}
        rids_removidos = {}
        # 1. relacionamentos: some o que aponta para parte removida ou é externo não filtrável
        for n in nomes:
            if not n.lower().endswith(".rels") or n in removidos:
                continue
            raiz = _analisar(etree, z.read(n), n)
            origem = _origem_do_rels(n)
            mudou = False
            for r in list(raiz):
                alvo, tipo = r.get("Target") or "", (r.get("Type") or "").rsplit("/", 1)[-1]
                externo = r.get("TargetMode") == "External"
                if (externo and tipo in TIPOS_REL_EXTERNOS_REMOVIDOS) or (not externo and _resolver(origem, alvo).lower() in removidos_baixo):
                    rids_removidos.setdefault(origem.lower(), set()).add(r.get("Id"))
                    removidos_por_categoria["imagens e mídia" if tipo == "image" else "referências externas"] = \
                        removidos_por_categoria.get("imagens e mídia" if tipo == "image" else "referências externas", 0) + 1
                    raiz.remove(r)
                    mudou = True
            if mudou:
                subs[n] = _serializar(etree, raiz)
        # 2. partes XML
        for n in nomes:
            if n in removidos or not eh_xml(n):
                continue
            if n.lower().endswith(".rels"):
                raiz = _analisar(etree, subs.get(n) or z.read(n), n)
                _filtrar_atributos(raiz, n, encontrar)
                subs[n] = _serializar(etree, raiz)
                continue
            if n.lower() == "[content_types].xml":
                raiz = _analisar(etree, z.read(n), n)
                for o in list(raiz):
                    if o.get("PartName") and o.get("PartName")[1:].lower() in removidos_baixo:
                        raiz.remove(o)
                subs[n] = _serializar(etree, raiz)
                continue
            raiz = _analisar(etree, z.read(n), n)
            rids = rids_removidos.get(n.lower(), set())
            if rids:
                _tirar_referencias(raiz, rids)
            if sem_formulas:
                _tirar_formulas(raiz)
            _filtrar_parte(raiz, n, encontrar, so_nao_celulas)
            if n.lower() == "docprops/core.xml":
                for el in raiz.iter():
                    if isinstance(el.tag, str) and el.tag.split("}")[-1] in ("creator", "lastModifiedBy"):
                        el.text = ""
                    elif isinstance(el.tag, str) and el.tag.split("}")[-1] in CARIMBOS_DE_TEMPO:
                        el.text = "1970-01-01T00:00:00Z"
            subs[n] = _serializar(etree, raiz)
        with zipfile.ZipFile(saida, "w") as out:
            for info in z.infolist():
                if info.filename in removidos:
                    continue
                dados = subs.get(info.filename)
                if dados is None:
                    dados = z.read(info.filename)
                novo = zipfile.ZipInfo(info.filename, info.date_time)
                novo.compress_type = zipfile.ZIP_DEFLATED
                novo.external_attr = info.external_attr
                out.writestr(novo, dados)
    if removidos_por_categoria:
        avisos.append("Saíram do arquivo '%s' por não dar para anonimizar: %s." % (
            nome, ", ".join("%s (%d)" % (c, q) for c, q in sorted(removidos_por_categoria.items()))))


def _tirar_formulas(raiz):
    """Tira todo elemento que carrega fórmula. Validação de dados e formatação condicional ficam sem a regra inteira."""
    for el in list(raiz.iter()):
        if not isinstance(el.tag, str) or el.getparent() is None:
            continue
        local = el.tag.split("}")[-1]
        if local in ELEMENTOS_INTEIROS or el.get("type") == "formula":
            el.getparent().remove(el)
            continue
        if local not in ELEMENTOS_DE_FORMULA:
            continue
        pai = el.getparent()
        if pai.tag.split("}")[-1] in ("dataValidation", "cfRule") and pai.getparent() is not None:
            avo = pai.getparent()
            avo.remove(pai)
            if len(avo) == 0 and avo.getparent() is not None:
                avo.getparent().remove(avo)
        else:
            pai.remove(el)


def conferir_sem_formulas(caminho, nome):
    """Varredura bruta do pacote final: recusa se sobrou fórmula, conexão, macro, link externo ou tabela dinâmica."""
    with zipfile.ZipFile(caminho) as z:
        for info in z.infolist():
            f = info.filename
            if any(p in f.lower() for p in _PARTES_ATIVAS):
                raise ErroMotor("formula_residual", "O arquivo de saída de '%s' ainda tem uma parte ativa (%s). Nada foi entregue; "
                                "peça ao agente o resultado em .csv ou .docx." % (nome, f))
            if eh_xml(f) and _RX_FORMULA_BRUTA.search(z.read(f).decode("utf-8", "replace")):
                raise ErroMotor("formula_residual", "O arquivo de saída de '%s' ainda tem uma fórmula na parte '%s'. Nada foi entregue; "
                                "peça ao agente o resultado em .csv ou .docx." % (nome, f))


def _tirar_referencias(raiz, rids):
    alvos = []
    for el in raiz.iter():
        if not isinstance(el.tag, str):
            continue
        if any(k.startswith("{" + NS_R + "}") and v in rids for k, v in el.attrib.items()):
            alvos.append(el)
    for el in alvos:
        pai = el.getparent()
        if pai is None:
            continue
        alvo = el
        for a in el.iterancestors():   # o mais externo: tirar só o miolo deixaria um desenho inválido
            if a.tag.split("}")[-1] in SUBIR_ATE:
                alvo = a
        p = alvo.getparent()
        if p is not None:
            p.remove(alvo)
            if p.tag.split("}")[-1] == "externalReferences" and len(p) == 0:
                p.getparent().remove(p)


def _filtrar_attr_valor(v, nome_attr, encontrar, el=None):
    autoria = el is not None and atributo_de_autoria(el, nome_attr)
    if autoria and nome_attr.rsplit("}", 1)[-1] == "initials":
        return ""
    if (len(v) < 6 and not autoria) or (el is not None and atributo_estrutural(el, nome_attr, v)):
        return v
    trocas = encontrar(v, True)
    return distribuir([v], trocas)[0] if trocas else v


def _filtrar_atributos(raiz, nome, encontrar):
    for el in raiz.iter():
        if isinstance(el.tag, str):
            for k, v in list(el.attrib.items()):
                novo = _filtrar_attr_valor(v, k, encontrar, el)
                if novo != v:
                    el.set(k, novo)


def _filtrar_parte(raiz, nome, encontrar, so_nao_celulas):
    nome = nome.lower()
    estrutural_texto = nome.startswith("docprops/") or nome.startswith("customxml/")
    tratados = set()
    # parágrafos: o valor pode estar partido entre vários runs
    if not (so_nao_celulas and (_so_texto_de_celula(nome) or nome.startswith("xl/worksheets/"))):
        for _p, ts in paragrafos(raiz):
            trechos = [t.text or "" for t in ts]
            trocas = encontrar("".join(trechos), estrutural_texto)
            if trocas:
                for t, novo in zip(ts, distribuir(trechos, trocas)):
                    t.text = novo
                    if t.tag == W + "t":
                        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            tratados.update(ts)
    for el in raiz.iter():
        if not isinstance(el.tag, str):
            continue
        if el not in tratados and not (so_nao_celulas and _ignora_texto(nome, el)) and el.text and el.text.strip():
            trocas = encontrar(el.text, estrutural_texto)
            if trocas:
                el.text = distribuir([el.text], trocas)[0]
        if el.tail and el.tail.strip():
            trocas = encontrar(el.tail, estrutural_texto)
            if trocas:
                el.tail = distribuir([el.tail], trocas)[0]
        for k, v in list(el.attrib.items()):
            novo = _filtrar_attr_valor(v, k, encontrar, el)
            if novo != v:
                el.set(k, novo)
