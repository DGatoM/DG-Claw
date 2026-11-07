"""Detector de nomes, endereços e empresas com GLiNER2 (modelo fastino/gliner2-privacy-filter-PII-multi, Apache-2.0).

O modelo é carregado de uma pasta local, sem rede (HF_HUB_OFFLINE=1), só de safetensors, e só no
primeiro pedido que precisa dele. Antes de carregar confere a memória livre. Texto longo é
fatiado em trechos de ~350 palavras com sobreposição.
"""
import os
import re
import time

MEMORIA_MINIMA_MB = 2500
PALAVRAS_POR_TRECHO = 350
SOBREPOSICAO = 50
LIMIAR = 0.5

# rótulo que o modelo entende -> tipo do marcador
ROTULOS = {
    "PESSOA": ("person",),
    "ENDERECO": ("street_address", "address"),
    "EMPRESA": ("company", "organization"),
}

# O modelo corta o endereço brasileiro no número da casa ou deixa passar complemento, bairro e cidade/UF.
# Este padrão pega: via + número, complementos conhecidos, e "bairro, cidade/UF" quando há cidade/UF no fim.
_VIA = r"(?:Rua|Avenida|Av\.|Travessa|Alameda|Pra[çc]a|Rodovia|Estrada|Largo|Viela|Beco)"
_COMPL = (r"(?i:(?:apartamento|apto\.?|ap\.?|bloco|casa|sala|conjunto|conj\.?|andar|loja|quadra|lote|bairro|centro|vila|jardim)\b\.?"
          r"[\wÀ-ú ]{0,30}|\d{1,2}[ºo°]\s*andar)")
_RX_ENDERECO = re.compile(
    _VIA + r"\s+[^,\n]{2,60}?,\s*(?:n[ºo°.]*\s*)?\d+[A-Za-z]?"
    r"(?:\s*,\s*" + _COMPL + r")*"
    r"(?:(?:\s*,\s*[\wÀ-ú' ]{2,40}?){0,3}?\s*,\s*[A-ZÀ-Ú][\wÀ-ú' ]{1,30}/[A-Z]{2})?")


class ErroNer(Exception):
    def __init__(self, codigo, mensagem):
        super().__init__(mensagem)
        self.codigo = codigo
        self.mensagem = mensagem


def memoria_disponivel_mb():
    try:
        with open("/proc/meminfo") as f:
            for linha in f:
                if linha.startswith("MemAvailable:"):
                    return int(linha.split()[1]) // 1024
    except OSError:
        pass
    return None


def rss_mb():
    try:
        with open("/proc/self/status") as f:
            for linha in f:
                if linha.startswith("VmRSS:"):
                    return int(linha.split()[1]) // 1024
    except OSError:
        pass
    return 0


def fatiar(texto):
    """[(inicio, fim)] de trechos com ~350 palavras e 50 de sobreposição, em posições do texto."""
    palavras = [m.span() for m in re.finditer(r"\S+", texto)]
    if len(palavras) <= PALAVRAS_POR_TRECHO:
        return [(0, len(texto))]
    trechos, i = [], 0
    while i < len(palavras):
        j = min(len(palavras), i + PALAVRAS_POR_TRECHO)
        trechos.append((palavras[i][0], palavras[j - 1][1]))
        if j == len(palavras):
            break
        i = j - SOBREPOSICAO
    return trechos


class NerGliner:
    carregado = False

    def __init__(self, pasta_modelo, versao):
        self.pasta = pasta_modelo
        self.versao = versao
        self.modelo = None
        self.segundos_carga = None
        self.trechos_processados = 0
        self.segundos_trechos = 0.0

    def _carregar(self):
        livre = memoria_disponivel_mb()
        if livre is not None and livre < MEMORIA_MINIMA_MB:
            raise ErroNer("memoria_insuficiente",
                          "Não há memória livre para carregar o detector de nomes: há %d MB disponíveis e ele precisa de %d MB. "
                          "Feche outros agentes ou programas e tente de novo, ou aumente a memória da VPS."
                          % (livre, MEMORIA_MINIMA_MB))
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
        inicio = time.time()
        try:
            import torch
            torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
            from gliner2 import GLiNER2
            self.modelo = GLiNER2.from_pretrained(self.pasta)
            if hasattr(self.modelo, "eval"):
                self.modelo.eval()
        except ErroNer:
            raise
        except Exception as e:
            raise ErroNer("modelo_falhou", "Não consegui carregar o detector de nomes em %s (%s). "
                          "Rode a instalação do nível completo de novo pelo painel e veja o log dela."
                          % (self.pasta, type(e).__name__)) from None
        self.segundos_carga = round(time.time() - inicio, 2)
        self.carregado = True

    def detectar(self, texto, tipos):
        if not texto.strip():
            return []
        if self.modelo is None:
            self._carregar()
        rotulos = {}
        for tipo in tipos:
            for r in ROTULOS[tipo]:
                rotulos[r] = tipo
        achados = []
        for ini, fim in fatiar(texto):
            trecho = texto[ini:fim]
            t0 = time.time()
            try:
                bruto = self.modelo.extract_entities(trecho, list(rotulos), threshold=LIMIAR, include_spans=True)
            except Exception as e:
                raise ErroNer("modelo_falhou", "O detector de nomes falhou ao ler um trecho do documento (%s). "
                              "Tente de novo; se repetir, rode a instalação do nível completo de novo." % type(e).__name__) from None
            self.segundos_trechos += time.time() - t0
            self.trechos_processados += 1
            for rotulo, itens in (bruto.get("entities") or {}).items():
                for item in itens:
                    achados.append(_span(item, trecho, ini, rotulos.get(rotulo)))
        if "ENDERECO" in tipos:
            achados += [(m.start(), m.end(), "ENDERECO") for m in _RX_ENDERECO.finditer(texto)]
        return [a for a in achados if a]


def _span(item, trecho, base, tipo):
    if tipo is None:
        return None
    if isinstance(item, dict):
        a, b = item.get("start"), item.get("end")
        texto_item = item.get("text")
        if isinstance(a, int) and isinstance(b, int) and 0 <= a < b <= len(trecho) and trecho[a:b] == texto_item:
            return (base + a, base + b, tipo)
        item = texto_item
    if isinstance(item, str) and item:
        a = trecho.find(item)
        if a != -1:
            return (base + a, base + a + len(item), tipo)
    return None
