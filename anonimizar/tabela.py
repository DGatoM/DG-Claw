"""Tabela de marcadores, consistência entre documentos e troca de texto.

A tabela é uma lista `[{"tipo","valor","marcador"}]` (a do agente inteiro). Dentro do motor ela vira
um índice por `(tipo, chave normalizada)`. Nada aqui grava ou imprime valores.
"""
import re
import unicodedata

from detectores import TIPOS, so_digitos

PARTICULAS = {"de", "da", "do", "das", "dos", "e"}
TIPOS_NOME = ("PESSOA", "EMPRESA", "ENDERECO")
TIPOS_NUMERICOS = {"CPF", "RG", "PIS", "CNH", "TITULO", "CEP", "TELEFONE", "CARTAO", "CONTA", "AGENCIA"}

_RX_MARCADOR = re.compile(r"\[(" + "|".join(TIPOS) + r")_(\d+)\]")


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
        self._rx = None
        self._rx_partes = None
        for e in tabela.entradas:
            self._superficie(e["valor"], e["tipo"], e["marcador"])

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

    def preparar(self, texto):
        """Detecta no texto e registra tudo o que achou (os marcadores ficam definidos)."""
        from detectores import detectar
        texto = neutralizar(texto)
        spans = detectar(texto, bool(self.opcoes.get("valores")), bool(self.opcoes.get("datas")))
        if self.ner is not None:
            tipos = ["PESSOA", "ENDERECO"] + (["EMPRESA"] if self.opcoes.get("empresas") else [])
            spans = _juntar_ner(spans, self.ner.detectar(texto, tipos), texto)
        nomes = []
        for ini, fim, tipo, _prio in spans:
            valor = texto[ini:fim]
            if tipo == "PESSOA":
                nomes.append(valor)
            else:
                m = self.tabela.achar(tipo, valor) or self.tabela.criar(tipo, valor)
                self._superficie(valor, tipo, m)
        self._registrar_pessoas(nomes)

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
        for variantes in por_token.values():
            if len(set(variantes.values())) == 1:
                for tok, marcador in variantes.items():
                    if tok not in self.partes:
                        self.partes[tok] = ("PESSOA", marcador)
                        self._rx_partes = None

    def encontrar(self, texto):
        """Trocas `(inicio, fim, novo_texto)` para um trecho, inclusive a neutralização de marcador plantado."""
        trocas = list(achar_neutralizacoes(texto))
        candidatos = []
        for rx, tabela in ((self._regex(), self.superficies), (self._regex_partes(), self.partes)):
            if rx is None:
                continue
            for m in rx.finditer(texto):
                chave = " ".join(m.group(0).split())
                tipo, marcador = tabela[chave.casefold() if tabela is self.superficies else chave]
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


class Reversor:
    def __init__(self, tabela):
        self.valor_de = {}
        for e in tabela:
            self.valor_de.setdefault(e["marcador"], e["valor"])
        self.trocas = 0
        self.desconhecidos = []

    def encontrar(self, texto, formatar=None):
        saida = []
        for m in _RX_MARCADOR.finditer(texto):
            marcador = m.group(0)
            if marcador in self.valor_de:
                valor = self.valor_de[marcador]
                saida.append((m.start(), m.end(), formatar(valor) if formatar else valor))
                self.trocas += 1
            elif marcador not in self.desconhecidos:
                self.desconhecidos.append(marcador)
        return saida

    def reverter(self, texto, formatar=None):
        return aplicar_trocas(texto, self.encontrar(texto, formatar))
