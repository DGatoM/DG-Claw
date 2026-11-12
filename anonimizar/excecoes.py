"""Palavras que o detector de nomes marca mas que não são dado pessoal de ninguém.

Só entram aqui nomes que não identificam uma pessoa ou empresa do cliente: papéis de contrato ("LOCADORA"),
nome de documento ("CNPJ"), instituições públicas e grandes bancos, marcas de consumo e endereços de site.
A comparação é por nome inteiro, sem acento e sem diferença de maiúscula: "Banco do Brasil" cai aqui,
"Banco do Brasil Seguros Ltda" não. Acrescente à vontade; é uma lista de dono, não de código.
"""
import re
import unicodedata

PAPEIS = {
    "locador", "locadora", "locatario", "locataria", "contratante", "contratada", "contratado", "outorgante", "outorgado", "outorgada",
    "credor", "credora", "devedor", "devedora", "comprador", "compradora", "vendedor", "vendedora", "fiador", "fiadora", "cedente",
    "cessionario", "prestador", "tomador", "beneficiario", "pagador", "requerente", "requerido", "autor", "reu", "condominio",
    "cnpj", "cpf", "rg", "cep", "pix", "partes", "empresa", "cliente", "paciente", "titular", "sindico", "advogado", "juiz",
}
INSTITUICOES = {
    "inss", "receita federal", "detran", "banco central", "caixa economica federal", "caixa", "banco do brasil", "bradesco", "itau",
    "santander", "nubank", "banco inter", "sicredi", "sicoob", "correios", "petrobras", "anvisa", "procon", "serasa", "spc",
    "microsoft", "google", "apple", "samsung", "amazon", "meta", "facebook", "instagram", "whatsapp", "telegram", "tiktok",
    "youtube", "linkedin", "uber", "ifood", "mercado livre", "mercado pago", "magazine luiza", "coca-cola", "coca cola", "pepsi",
    "guarana antarctica", "nike", "adidas", "toyota", "volkswagen", "fiat", "chevrolet", "honda", "dell", "lenovo", "sony",
    "windows", "linux", "android", "excel", "power bi", "word", "powerpoint",
}
_DOMINIO = re.compile(r"^[\w\-]+(?:\s*\.\s*[\w\-]+)+$")


def _chave(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s.lower()).strip(" .,;:")


def ignorar(tipo, texto):
    """True se o detector de nomes marcou algo que não vale um marcador."""
    c = _chave(texto)
    if c in PAPEIS:
        return True
    if tipo == "EMPRESA" and (c in INSTITUICOES or _DOMINIO.match(c)):
        return True
    return False
