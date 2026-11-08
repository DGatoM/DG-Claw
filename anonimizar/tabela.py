"""Tabela de marcadores, consistência entre documentos e troca de texto.

A tabela é uma lista `[{"tipo","valor","marcador"}]` (a do agente inteiro). Dentro do motor ela vira
um índice por `(tipo, chave normalizada)`. Nada aqui grava ou imprime valores.
"""
import re
import unicodedata

import excecoes
from detectores import TIPOS, so_digitos

PARTICULAS = {"de", "da", "do", "das", "dos", "e"}
TIPOS_NOME = ("PESSOA", "EMPRESA", "ENDERECO")
TIPOS_NUMERICOS = {"CPF", "RG", "PIS", "CNH", "TITULO", "CEP", "TELEFONE", "CARTAO", "CONTA", "AGENCIA"}

_RX_MARCADOR = re.compile(r"\[(" + "|".join(TIPOS) + r")_(\d+)\]")


MARCADOR_AUTOR = "[AUTOR]"
_RX_PARECE_NOME = re.compile(r"(?:[^\W_]|[ .'\u2019-])+")


def parece_nome(valor):
    """Letras (com acento), dígitos, espaço, ponto, hífen e apóstrofo, com ao menos uma letra e até 80 caracteres."""
    v = valor.strip()
    return len(v) <= 80 and bool(_RX_PARECE_NOME.fullmatch(v)) and any(c.isalpha() for c in v)


def sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def normalizar(tipo, valor):
    """Chave de comparação: sem acento, minúsculas, espaços colapsados; documentos só dígitos."""
    if tipo == "CNPJ":
        return re.sub(r"[^0-9A-Z]", "", valor.upper())
    if tipo == "TELEFONE":
        d = so_digitos(valor)
        return d[2:] if d.startswith("55") and len(d) in (12, 13) else d
    if tipo in TIPOS_NUMERICOS:
        return so_digitos(valor)
    if tipo == "EMAIL":
        return valor.strip().lower()
    if tipo == "PIX":
        return valor.strip().lower()
    if tipo in ("VALOR", "DATA"):
        return re.sub(r"\s+", "", sem_acento(valor).lower())
    return re.sub(r"\s+", " ", sem_acento(valor).lower()).strip()


def tokens_nome(chave):
    return [t for t in re.split(r"[\s.,]+", chave) if t and t not in PARTICULAS]


def neutralizar(texto):
    """Marcador plantado no documento vira colchetes de largura total."""
    return _RX_MARCADOR.sub(lambda m: "［" + m.group(1) + "_" + m.group(2) + "］", texto)


def achar_neutralizacoes(texto):
    return [(m.start(), m.end(), "［" + m.group(1) + "_" + m.group(2) + "］") for m in _RX_MARCADOR.finditer(texto)]


class Tabela:
    def __init__(self, entradas=None):
        self.entradas = []          # todas, na ordem
        self.indice = {}            # (tipo, chave) -> marcador
        self.valor_de = {}          # marcador -> valor (o primeiro)
        self.proximo = {}           # tipo -> próximo n
        self.novas = []
        for e in entradas or []:
            self._carregar(e)

    def _carregar(self, e):
        tipo, valor, marcador = e.get("tipo"), e.get("valor"), e.get("marcador")
        if tipo not in TIPOS or not isinstance(valor, str) or not isinstance(marcador, str):
            raise ValueError("entrada da tabela com formato inválido (esperado tipo, valor e marcador conhecidos)")
        m = _RX_MARCADOR.fullmatch(marcador)
        if not m or m.group(1) != tipo:
            raise ValueError("marcador da tabela não bate com o tipo (esperado [TIPO_n])")
        self.entradas.append({"tipo": tipo, "valor": valor, "marcador": marcador})
        self.indice.setdefault((tipo, normalizar(tipo, valor)), marcador)
        self.valor_de.setdefault(marcador, valor)
        self.proximo[tipo] = max(self.proximo.get(tipo, 1), int(m.group(2)) + 1)

    def achar(self, tipo, valor):
        return self.indice.get((tipo, normalizar(tipo, valor)))

    def criar(self, tipo, valor):
        n = self.proximo.get(tipo, 1)
        marcador = "[%s_%d]" % (tipo, n)
        self.proximo[tipo] = n + 1
        e = {"tipo": tipo, "valor": valor, "marcador": marcador}
        self.entradas.append(e)
        self.novas.append(e)
        self.indice[(tipo, normalizar(tipo, valor))] = marcador
        self.valor_de[marcador] = valor
        return marcador

    def nomes_completos(self, tipo="PESSOA"):
        """(chave, marcador) dos nomes com mais de um token, da tabela e do documento em curso."""
        saida = {}
        for (t, chave), marcador in self.indice.items():
            if t == tipo and len(tokens_nome(chave)) > 1:
                saida[chave] = marcador
        return saida


class Sessao:
    """Um pedido de anonimização: detecta, registra na tabela e troca."""

    def __init__(self, tabela, opcoes, ner=None):
        self.tabela = tabela
        self.opcoes = opcoes or {}
        self.ner = ner
        self.superficies = {}       # casefold(texto do documento) -> (tipo, marcador)
        self.partes = {}            # primeiro nome/sobrenome exato (maiúscula/minúscula importa) -> (tipo, marcador)
        self.contagem = {}
        self.contando = True
        self.autores_descartados = set()   # autores que não parecem nome: viram "[AUTOR]", nunca entram na tabela
        self.detectados = {}        # (tipo, chave) -> valor: tudo o que apareceu NESTE documento
        self._rx = None
        self._rx_partes = None
        for e in tabela.entradas:
            self._superficie(e["valor"], e["tipo"], e["marcador"])
        self._expandir_partes()

    def _superficie(self, texto, tipo, marcador):
        chave = " ".join(texto.split()).casefold()
        if len(chave) >= 2 and chave not in self.superficies:
            self.superficies[chave] = (tipo, marcador)
            self._rx = None

    def _regex(self):
        if self._rx is None and self.superficies:
            self._rx = _compilar(self.superficies, re.IGNORECASE)
        return self._rx

    def _regex_partes(self):
        if self._rx_partes is None and self.partes:
            self._rx_partes = _compilar(self.partes, 0)
        return self._rx_partes

    def preparar(self, texto, ner=True):
        """Detecta no texto e registra tudo o que achou (os marcadores ficam definidos)."""
        from detectores import detectar
        texto = neutralizar(texto)
        spans = detectar(texto, bool(self.opcoes.get("valores")), bool(self.opcoes.get("datas")))
        if ner and self.ner is not None:
            tipos = ["PESSOA", "ENDERECO"] + (["EMPRESA"] if self.opcoes.get("empresas") else [])
            spans = _juntar_ner(spans, self.ner.detectar(texto, tipos), texto)
        nomes = []
        for ini, fim, tipo, _prio in spans:
            valor = texto[ini:fim]
            self._lembrar(tipo, valor)
            if tipo == "PESSOA":
                nomes.append(valor)
            else:
                m = self.tabela.achar(tipo, valor) or self.tabela.criar(tipo, valor)
                self._superficie(valor, tipo, m)
        self._registrar_pessoas(nomes)

    def registrar_pessoas(self, nomes):
        """Registra como PESSOA nomes que o detector não precisa reconhecer (autor de comentário ou revisão).

        Só entra na tabela o que parece nome (`parece_nome`). Autor que não passa (um documento externo pode pôr qualquer
        texto ali, inclusive sintaxe de Markdown ou HTML) NÃO é registrado: fica em `autores_descartados` e `encontrar` o
        troca, quando é o valor inteiro de um campo, pelo marcador fixo "[AUTOR]", que não tem reversão. Assim documento
        externo não injeta texto na tabela que a versão final restaura.
        """
        # uma letra só não é nome (é inicial ou rótulo) e, registrada, a verificação final a acharia em qualquer parte do pacote
        nomes = [n for n in nomes if len(n.strip()) >= 2]
        for n in nomes:
            if not parece_nome(n):
                self.autores_descartados.add(n.strip())
        nomes = [n for n in nomes if parece_nome(n)]
        for n in nomes:
            self._lembrar("PESSOA", n)
        self._registrar_pessoas(nomes)

    def _lembrar(self, tipo, valor):
        self.detectados.setdefault((tipo, normalizar(tipo, valor)), valor)

    def numero_para_marcador(self, digitos, contexto=""):
        """Número guardado como número (célula, JSON): CPF/CNPJ sem zero à esquerda, telefone e conta com o título da coluna.

        Devolve o marcador (e registra) ou None se o número não é dado pessoal.
        """
        from detectores import detectar
        ctx = re.sub(r"[_\-]+", " ", re.sub(r"(?<=[a-z])(?=[A-Z])", " ", contexto or "")).strip()
        candidatos = [digitos]
        if len(digitos) <= 11:
            candidatos.append(digitos.zfill(11))
        if len(digitos) <= 14:
            candidatos.append(digitos.zfill(14))
        if re.search(r"(?i)\bcpf\b", ctx) and 9 <= len(digitos) <= 11:
            return self._marcar("CPF", digitos.zfill(11))
        if re.search(r"(?i)\bcnpj\b", ctx) and 12 <= len(digitos) <= 14:
            return self._marcar("CNPJ", digitos.zfill(14))
        prefixo = (ctx + ": ") if ctx else ""
        for cand in candidatos:
            t = prefixo + cand
            for ini, fim, tipo, _p in detectar(t, False, False):
                if ini >= len(prefixo) and fim == len(t):
                    return self._marcar(tipo, cand)
        return None

    def data_para_marcador(self, d):
        """Célula de data do Excel: vira marcador DATA; o valor vale nos formatos dd/mm/aaaa e ISO para a verificação final."""
        self._lembrar("DATA", d.strftime("%Y-%m-%d"))
        return self._marcar("DATA", "%02d/%02d/%04d" % (d.day, d.month, d.year))

    def _marcar(self, tipo, valor):
        self._lembrar(tipo, valor)
        m = self.tabela.achar(tipo, valor) or self.tabela.criar(tipo, valor)
        self._superficie(valor, tipo, m)
        if self.contando:
            self.contagem[tipo] = self.contagem.get(tipo, 0) + 1
        return m

    def _registrar_pessoas(self, nomes):
        """Nome parcial vira o marcador do nome completo se houver um único candidato; senão, marcador próprio."""
        tab = self.tabela
        unicos = {}
        for n in nomes:
            unicos.setdefault(normalizar("PESSOA", n), n)
        for chave, valor in sorted(unicos.items(), key=lambda kv: -len(tokens_nome(kv[0]))):
            m = tab.achar("PESSOA", valor)
            if m is None:
                alvo = set(tokens_nome(chave))
                cands = {mk for ck, mk in tab.nomes_completos().items()
                         if len(tokens_nome(ck)) > len(alvo) and alvo <= set(tokens_nome(ck))}
                m = next(iter(cands)) if len(cands) == 1 and alvo else tab.criar("PESSOA", valor)
            self._superficie(valor, "PESSOA", m)
        self._expandir_partes()

    def _expandir_partes(self):
        """Primeiro nome e sobrenome soltos viram o marcador do nome completo, se só um nome completo os tem."""
        por_token = {}
        for e in self.tabela.entradas:
            if e["tipo"] != "PESSOA" or len(tokens_nome(normalizar("PESSOA", e["valor"]))) < 2:
                continue
            for tok in e["valor"].replace(",", " ").split():
                chave = sem_acento(tok).lower().strip(".")
                if len(chave) >= 3 and chave not in PARTICULAS and tok[0].isupper():
                    por_token.setdefault(chave, {})[tok.strip(".")] = e["marcador"]
        # Pedaços do nome com mais de uma palavra ("Maria Aparecida" de "Maria Aparecida dos Santos Ferreira")
        por_pedaco = {}
        for e in self.tabela.entradas:
            if e["tipo"] != "PESSOA":
                continue
            toks = [t.strip(".,") for t in e["valor"].split() if t.strip(".,")]
            for i in range(len(toks)):
                for j in range(i + 2, len(toks) + 1):
                    if (i, j) == (0, len(toks)) or toks[i].lower() in PARTICULAS or toks[j - 1].lower() in PARTICULAS:
                        continue
                    por_pedaco.setdefault(" ".join(toks[i:j]).casefold(), set()).add(e["marcador"])
        for pedaco, marcadores in por_pedaco.items():
            if len(marcadores) == 1 and pedaco not in self.superficies:
                self._superficie(pedaco, "PESSOA", next(iter(marcadores)))
        for variantes in por_token.values():
            if len(set(variantes.values())) == 1:
                for tok, marcador in variantes.items():
                    if tok not in self.partes:
                        self.partes[tok] = ("PESSOA", marcador)
                        self._rx_partes = None

    def encontrar(self, texto, estrutural=False):
        """Em parte estrutural (propriedades, atributos) data e valor ficam: trocar quebraria o formato do arquivo.

        Trocas `(inicio, fim, novo_texto)` para um trecho, inclusive a neutralização de marcador plantado."""
        corte = texto.strip()
        if corte and corte in self.autores_descartados:
            ini = texto.index(corte)
            return [(ini, ini + len(corte), MARCADOR_AUTOR)]
        trocas = list(achar_neutralizacoes(texto))
        candidatos = []
        for rx, tabela in ((self._regex(), self.superficies), (self._regex_partes(), self.partes)):
            if rx is None:
                continue
            for m in rx.finditer(texto):
                chave = " ".join(m.group(0).split())
                tipo, marcador = tabela[chave.casefold() if tabela is self.superficies else chave]
                if estrutural and tipo in ("DATA", "VALOR"):
                    continue
                candidatos.append((m.start(), m.end(), marcador, tipo))
        candidatos.sort(key=lambda c: (-(c[1] - c[0]), c[0]))
        ocupado = [(a, b) for a, b, _ in trocas]
        for ini, fim, marcador, tipo in candidatos:
            if any(ini < b and fim > a for a, b in ocupado):
                continue
            ocupado.append((ini, fim))
            trocas.append((ini, fim, marcador))
            if self.contando:
                self.contagem[tipo] = self.contagem.get(tipo, 0) + 1
        trocas.sort()
        return trocas

    def trocar(self, texto):
        return aplicar_trocas(texto, self.encontrar(texto))

    def trocar_sem_contar(self, texto):
        antes, self.contando = self.contando, False
        try:
            return self.trocar(texto)
        finally:
            self.contando = antes


def _compilar(tabela, flags):
    partes = []
    for chave in sorted(tabela, key=len, reverse=True):
        corpo = r"\s+".join(re.escape(t) for t in chave.split(" "))
        pre = r"(?<!\w)" if (chave[0].isalnum() or chave[0] == "_") else ""
        pos = r"(?!\w)" if (chave[-1].isalnum() or chave[-1] == "_") else ""
        partes.append(pre + corpo + pos)
    return re.compile("|".join(partes), flags)


def aplicar_trocas(texto, trocas):
    partes, pos = [], 0
    for ini, fim, novo in trocas:
        partes.append(texto[pos:ini])
        partes.append(novo)
        pos = fim
    partes.append(texto[pos:])
    return "".join(partes)


def _juntar_ner(spans_regex, spans_ner, texto):
    """Os spans do detector de nomes perdem a parte que já é número/contato (regex ganha)."""
    saida = list(spans_regex)
    novos = []
    for ini, fim, tipo in spans_ner:
        if excecoes.ignorar(tipo, texto[ini:fim]):
            continue
        pedacos = [(ini, fim)]
        for a, b, _t, _p in spans_regex:
            prox = []
            for x, y in pedacos:
                if b <= x or a >= y:
                    prox.append((x, y))
                else:
                    if x < a:
                        prox.append((x, a))
                    if b < y:
                        prox.append((b, y))
            pedacos = prox
        for x, y in pedacos:
            trecho = texto[x:y]
            lstrip = len(trecho) - len(trecho.lstrip(" \t\n,;:()"))
            trecho = trecho.strip(" \t\n,;:()")
            if sum(c.isalnum() for c in trecho) >= 3:
                novos.append((x + lstrip, x + lstrip + len(trecho), tipo, 6))
    novos.sort(key=lambda s: (-(s[1] - s[0]), s[0]))
    for s in novos:
        if all(s[1] <= e[0] or s[0] >= e[1] for e in saida):
            saida.append(s)
    saida.sort()
    return saida


# Região de URL: a palavra (delimitada só por espaço ASCII, tab ou fim de linha) que contém "://" ou "www.", ou que
# começa num esquema perigoso. isspace() e \s Unicode ficam de fora de propósito: NBSP, U+2003 e U+3000 não separam
# o marcador da URL (o visualizador de Markdown os trata como parte do destino).
_RX_URL = re.compile(r"(?i)[^ \t\r\n]*(?:://|www\.)[^ \t\r\n]*"
                     r"|(?<![A-Za-z0-9_])(?:mailto|data|javascript|vbscript|file|blob|ftp|tel|sms|xmpp):[^ \t\r\n]*")
_RX_ABRE_TAG = re.compile(r"<[A-Za-z!/?]")
_CARACTERES_DE_URL = set("/\\=?&#%:@")


def zonas_de_tags(texto):
    """Do "<" ao ">" que fecha FORA de aspas (simples ou duplas), em várias linhas. Comentário vai até "-->".

    Tag que não fecha vale até o fim do texto: na dúvida, nada dentro dela é restaurado.
    """
    zonas, i = [], 0
    while True:
        m = _RX_ABRE_TAG.search(texto, i)
        if not m:
            return zonas
        ini = m.start()
        if texto.startswith("<!--", ini):
            fim = texto.find("-->", ini + 4)
            fim = len(texto) if fim < 0 else fim + 3
        else:
            aspas, j, fim = None, ini + 1, len(texto)
            while j < len(texto):
                c = texto[j]
                if aspas:
                    if c == aspas:
                        aspas = None
                elif c in "\"'":
                    aspas = c
                elif c == ">":
                    fim = j + 1
                    break
                j += 1
        zonas.append((ini, fim))
        i = max(fim, ini + 1)


def zonas_sem_troca(texto):
    """Trechos onde marcador NÃO vira dado real: tag e comentário HTML (mesmo em várias linhas) e região de URL.

    Destino de link/imagem do Markdown não precisa de regra aqui: na versão final .md toda sintaxe de link já foi
    desativada por desativar_links_md antes da restauração.
    """
    return [(m.start(), m.end()) for m in _RX_URL.finditer(texto)] + zonas_de_tags(texto)


def pedaco_parece_url(texto, ini, fim):
    """O "pedaço sem espaço ASCII" que contém o marcador tem / \\ = ? & # % : ou @ (cobre URL sem esquema)."""
    esq = ini
    while esq > 0 and texto[esq - 1] not in " \t\r\n":
        esq -= 1
    dir_ = fim
    while dir_ < len(texto) and texto[dir_] not in " \t\r\n":
        dir_ += 1
    return any(c in _CARACTERES_DE_URL for c in texto[esq:dir_])


_RX_ESPECIAIS_MD = re.compile(r"[\\`*_{}\[\]()#|~>!]")
_RX_INICIO_DE_LINHA_MD = re.compile(r"^([ \t]*)(?:(\d+)([.)])(?=\s|$)|([-+=])(?=[\s\-+=]|$))", re.M)


def escapar_md(valor):
    """Valor restaurado entra no Markdown como texto literal: nunca vira imagem, link, tag nem título.

    `\\` na frente da pontuação de sintaxe; `<` e `&` viram entidade (o "<" do texto do agente já virou "&lt;" antes, então
    este é o único "<" que chegaria cru). `- + = .` só importam no começo de linha (lista, título, lista numerada), por isso
    o CPF "123.456.789-00" continua legível no meio da frase.
    """
    v = _RX_ESPECIAIS_MD.sub(lambda m: "\\" + m.group(0), valor.replace("&", "&amp;").replace("<", "&lt;"))
    return _RX_INICIO_DE_LINHA_MD.sub(
        lambda m: m.group(1) + (m.group(2) + "\\" + m.group(3) if m.group(2) else "\\" + m.group(4)), v)


def desativar_links_md(texto):
    """Tira toda a sintaxe de link e imagem do texto que o agente escreveu na versão final em Markdown.

    Todo "[" e "]" que não faz parte de um marcador válido ([CPF_1]) ganha "\\" na frente: não sobra link inline, imagem,
    link de referência nem definição de referência ("[x]: url"). É a mesma linha do "<" que vira "&lt;": em vez de tentar
    reconhecer o destino do link com expressão regular (o agente escapa de qualquer uma), nenhum destino existe. Barras
    invertidas que já precediam o colchete são dobradas, para que "\\[" do agente não anule o escape.

    Custo aceito: os links e as imagens que o agente escreveu aparecem como texto ("[x](https://...)") no .md final, e
    colchetes dentro de bloco de código também ganham a barra. Os marcadores continuam intactos e são restaurados
    depois, com escapar_md. O .txt não é renderizado e o reverter_texto devolve texto puro ao agente: nenhum dos dois usa isto.
    """
    marcadores = {}
    for m in _RX_MARCADOR.finditer(texto):
        marcadores[m.start()] = True
        marcadores[m.end() - 1] = True

    def troca(m):
        barras, pos = m.group(1), m.start(2)
        if pos in marcadores:
            return barras + m.group(2) if m.group(2) == "]" else barras * 2 + m.group(2)
        return barras * 2 + "\\" + m.group(2)
    return re.sub(r"(\\*)([\[\]])", troca, texto)


def desativar_marcadores_restantes(texto):
    """Última etapa da versão final .md: marcador que sobrou (desconhecido, ou numa região de URL) perde a abertura de colchete.

    Roda depois da restauração. Os valores restaurados já saem de escapar_md com "\\[" e "\\_", então não casam com o
    marcador: tudo o que ainda casa é marcador cru. Sem isso, "![CPF_999](https://x)" continuaria sendo imagem e
    "![CPF_999]( [CPF_1] )" viraria imagem com o dado restaurado no endereço. A barra é acrescentada depois das que já
    estavam na frente (desativar_links_md deixa um número par), então o colchete fica literal.
    """
    return _RX_MARCADOR.sub(lambda m: "\\[" + m.group(1) + "_" + m.group(2) + "\\]", texto)


class Reversor:
    def __init__(self, tabela, escapar=None):
        self.escapar = escapar      # transforma o valor restaurado em texto literal do formato de saída (ex.: escapar_md)
        self.valor_de = {}
        for e in tabela:
            self.valor_de.setdefault(e["marcador"], e["valor"])
        self.trocas = 0
        self.desconhecidos = []

    def encontrar(self, texto):
        zonas = zonas_sem_troca(texto)
        saida = []
        for m in _RX_MARCADOR.finditer(texto):
            marcador = m.group(0)
            if marcador in self.valor_de:
                if any(a < m.end() and m.start() < b for a, b in zonas) or pedaco_parece_url(texto, m.start(), m.end()):
                    continue
                valor = self.valor_de[marcador]
                saida.append((m.start(), m.end(), self.escapar(valor) if self.escapar else valor))
                self.trocas += 1
            elif marcador not in self.desconhecidos:
                self.desconhecidos.append(marcador)
        return saida

    def reverter(self, texto):
        return aplicar_trocas(texto, self.encontrar(texto))
