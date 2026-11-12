"""Detector de nomes falso e determinístico, só para testes (DGCLAW_ANON_NER=falso).

Marca como PESSOA os nomes completos da lista fixa abaixo e também cada nome ou sobrenome deles
sozinho (para exercitar a consistência de nome parcial). Marca ENDERECO ("Rua/Avenida ... , número")
e, se pedido, EMPRESA (palavras capitalizadas terminando em Ltda, S.A. ou ME). Nada de modelo.
"""
import re

NOMES_FICTICIOS = (
    "Maria Souza", "Maria Silva", "João Pereira", "Ana Paula Lima", "Carlos Andrade", "Beatriz Moura",
)
_PARTICULAS = {"de", "da", "do", "das", "dos", "e"}

_COMPLETOS = sorted(NOMES_FICTICIOS, key=len, reverse=True)
_SOLTOS = sorted({p for n in NOMES_FICTICIOS for p in n.split() if p.lower() not in _PARTICULAS}, key=len, reverse=True)
_RX_NOME = re.compile(
    r"(?<!\w)(?:" + "|".join(re.escape(n) for n in _COMPLETOS) + "|" + "|".join(re.escape(n) for n in _SOLTOS) + r")(?!\w)", re.IGNORECASE)
_RX_ENDERECO = re.compile(r"(?:Rua|Avenida|Av\.|Travessa|Alameda|Praça)\s+[\wÀ-ú ]+?,\s*(?:n[ºo°.]\s*)?\d+")
_RX_EMPRESA = re.compile(r"(?:[A-ZÀ-Ú][\wÀ-ú&]+\s+){1,4}(?:Ltda\.?|S\.A\.|ME|EIRELI)(?!\w)")


class NerFalso:
    versao = "falso"
    carregado = True

    def detectar(self, texto, tipos):
        saida = []
        if "PESSOA" in tipos:
            saida += [(m.start(), m.end(), "PESSOA") for m in _RX_NOME.finditer(texto)]
        if "ENDERECO" in tipos:
            saida += [(m.start(), m.end(), "ENDERECO") for m in _RX_ENDERECO.finditer(texto)]
        if "EMPRESA" in tipos:
            saida += [(m.start(), m.end(), "EMPRESA") for m in _RX_EMPRESA.finditer(texto)]
        return saida
