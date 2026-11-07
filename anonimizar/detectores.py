"""Detectores por expressão regular com validação (só biblioteca padrão).

Cada detector devolve spans `(inicio, fim, tipo, prioridade)`. Prioridade menor ganha quando dois
spans se sobrepõem; empatando, ganha o mais longo. Número que falha no dígito verificador não é
CPF/CNPJ (evita falso positivo), exceto o formato 000.000.000-00 com "CPF" logo antes.
Nenhuma função aqui registra ou imprime o valor encontrado.
"""
import datetime as dt
import re

TIPOS = ("PESSOA", "EMPRESA", "ENDERECO", "CPF", "CNPJ", "RG", "PIS", "CNH", "TITULO", "CEP",
         "TELEFONE", "EMAIL", "CARTAO", "CONTA", "AGENCIA", "PIX", "VALOR", "DATA")

DDDS_VALIDOS = {
    11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44,
    45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81,
    82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
}


def so_digitos(s):
    return re.sub(r"\D", "", s)


# ---------- validadores ----------

def cpf_valido(d):
    if len(d) != 11 or not d.isdigit() or len(set(d)) == 1:
        return False
    for n in (9, 10):
        s = sum(int(d[i]) * (n + 1 - i) for i in range(n))
        dv = (s * 10) % 11 % 10
        if dv != int(d[n]):
            return False
    return True


def cnpj_valido(c):
    """CNPJ numérico ou alfanumérico (regra nova da Receita: valor = código ASCII - 48)."""
    if len(c) != 14 or not re.fullmatch(r"[0-9A-Z]{12}[0-9]{2}", c) or len(set(c)) == 1:
        return False
    v = [ord(ch) - 48 for ch in c]
    for n, pesos in ((12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]), (13, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])):
        r = sum(v[i] * pesos[i] for i in range(n)) % 11
        dv = 0 if r < 2 else 11 - r
        if dv != v[n]:
            return False
    return True


def pis_valido(d):
    if len(d) != 11 or not d.isdigit() or len(set(d)) == 1:
        return False
    pesos = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    r = 11 - sum(int(d[i]) * pesos[i] for i in range(10)) % 11
    return (0 if r >= 10 else r) == int(d[10])


def luhn_valido(d):
    if not 13 <= len(d) <= 19 or len(set(d)) == 1:
        return False
    total = 0
    for i, ch in enumerate(reversed(d)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


# ---------- padrões ----------

_CPF = re.compile(r"(?<![\d.\-/])(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?![\d]|[.\-/]\d)")
_CNPJ = re.compile(r"(?<![0-9A-Za-z])([0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}/?[0-9A-Z]{4}-?[0-9]{2})(?![0-9A-Za-z])")
_CARTAO = re.compile(r"(?<![\d+])(\d(?:[ -]?\d){12,18})(?![\d])")
_PIS_FMT = re.compile(r"(?<![\d.\-])(\d{3}\.\d{5}\.\d{2}-\d)(?![\d])")
_CTX_PIS = re.compile(r"(?i)\b(?:PIS|PASEP|NIT|PIS/PASEP)\b[\s:.\-nºo°]{0,12}(\d[\d.\-]{9,14}\d)")
_CTX_CNH = re.compile(r"(?i)(?:\bCNH\b|habilita[çc][ãa]o)[^\d\n]{0,25}(\d{11})(?!\d)")
_CTX_TITULO = re.compile(r"(?i)(?:t[ií]tulo\s+(?:de\s+)?eleitor(?:al)?|\beleitor\b)[^\d\n]{0,25}(\d{4}[ .]?\d{4}[ .]?\d{4})(?!\d)")
_CTX_RG = re.compile(
    r"(?i)(?:\bR\.?\s?G\b\.?|\bidentidade\b|\bregistro\s+geral\b)(?:\s*(?:n[ºo°]\.?|n\.?[ºo°]|n[úu]mero))?[\s:.\-]{0,6}"
    r"(\d{1,2}\.?\d{3}\.?\d{3}(?:-?[\dXx])?)(?![\d])")
_CEP = re.compile(r"(?<![\d.\-])(\d{2}\.?\d{3}-\d{3})(?![\d])")
_CTX_CEP = re.compile(r"(?i)\bCEP\b[\s:.\-nºo°]{0,8}(\d{8})(?!\d)")
_EMAIL = re.compile(r"(?<![\w.+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
_UUID = re.compile(r"(?<![0-9A-Fa-f\-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f\-])")
_CTX_AGENCIA = re.compile(r"(?i)\b(?:ag[êe]ncia|ag\.|ag\b)(?:\s*(?:n[ºo°]\.?|n\.?[ºo°]))?[\s:.\-]{0,4}(\d{3,5}(?:-[\dxX])?)(?![\d])")
_CTX_CONTA = re.compile(
    r"(?i)(?:\bconta(?:\s+(?:corrente|poupan[çc]a|sal[áa]rio|pagamento))?|\bc\s?/\s?c\b|\bc\.\s?c\.?|\bcc\b|\bc/p\b)"
    r"(?:\s*(?:n[ºo°]\.?|n\.?[ºo°]))?[\s:.\-]{0,4}(\d{3,12}(?:\s?-\s?[\dxX])?)(?![\d])")
_TEL = re.compile(r"(?<![\w@.,/])(\+?55[\s.\-]?)?(\(\s?\d{2}\s?\)[\s.\-]?|\d{2}[\s.\-])?(9?\d{4})(-|\s)?(\d{4})(?![\w@]|[.,]\d)")
_TEL_PLANO = re.compile(r"(?<![\w.,])(\d{2})(9?\d{4})(\d{4})(?![\w]|[.,]\d)")
_TEL_55 = re.compile(r"(?<![\w])\+55(\d{2})(9?\d{8})(?!\d)")
_TEL_0800 = re.compile(r"(?<!\d)(?:(?:0800|0300)[ .\-]?\d{3}[ .\-]?\d{3,4}|(?:4004|4003|3003)[ .\-]?\d{4})(?!\d)")
_CTX_TEL = re.compile(r"(?i)(?:tel(?:efone)?|fone|fixo|cel(?:ular)?|m[oó]vel|comercial|residencial|whats(?:app)?|zap|contato|ligar|ramal|pix|atendimento|central|sac)[^\d\n]{0,20}$")
_CTX_CPF_ANTES = re.compile(r"(?i)\bCPF\b[^\d\n]{0,15}$")

_MESES = "janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro"
_DATA_NUM = re.compile(r"(?<![\d/.\-])(\d{1,2})([/.\-])(\d{1,2})\2(\d{4}|\d{2})(?![\d])")
_DATA_ISO = re.compile(r"(?<![\d\-])(\d{4})-(\d{2})-(\d{2})(?![\d])")
_DATA_EXT = re.compile(r"(?i)(?<![\d])\d{1,2}\s*(?:º|°|o)?\s+de\s+(?:" + _MESES + r")\s+de\s+\d{4}")
_NUMEROS = (r"(?:um|uma|dois|duas|tr[êe]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|quinze|"
            r"dezesseis|dezessete|dezoito|dezenove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|"
            r"cem|cento|duzentos|duzentas|trezentos|quatrocentos|quinhentos|seiscentos|setecentos|oitocentos|"
            r"novecentos|mil|milh[ãa]o|milh[õo]es)")
_VALOR_RS = re.compile(r"(?i)R\$\s?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?(?:\s+(?:mil|milh[ãa]o|milh[õo]es))?(?![\d])"
                       r"|R\$\s?\d+(?:,\d{1,2})?(?:\s+(?:mil|milh[ãa]o|milh[õo]es))?(?![\d])")
_VALOR_REAIS = re.compile(r"(?i)(?<![\d.,])\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?\s+(?:(?:mil|milh[ãa]o|milh[õo]es)\s+)?reais\b")
_VALOR_EXT = re.compile(r"(?i)\b" + _NUMEROS + r"(?:\s+(?:e\s+)?" + _NUMEROS + r")*\s+reais\b")


def _antes(texto, pos, n=40):
    return texto[max(0, pos - n):pos]


def _add(saida, m, grupo, tipo, prio):
    saida.append((m.start(grupo), m.end(grupo), tipo, prio))


def detectar(texto, valores=False, datas=False):
    """Todos os candidatos por regex, já com sobreposições resolvidas."""
    c = []
    for m in _CNPJ.finditer(texto):
        bruto = m.group(1)
        if cnpj_valido(re.sub(r"[./-]", "", bruto)):
            _add(c, m, 1, "CNPJ", 1)
    for m in _CPF.finditer(texto):
        bruto = m.group(1)
        d = so_digitos(bruto)
        if cpf_valido(d):
            _add(c, m, 1, "CPF", 1)
        elif re.fullmatch(r"\d{3}\.\d{3}\.\d{3}-\d{2}", bruto) and _CTX_CPF_ANTES.search(_antes(texto, m.start(1), 20)):
            _add(c, m, 1, "CPF", 1)
    for m in _CARTAO.finditer(texto):
        if luhn_valido(so_digitos(m.group(1))):
            _add(c, m, 1, "CARTAO", 2)
    for m in _PIS_FMT.finditer(texto):
        if pis_valido(so_digitos(m.group(1))):
            _add(c, m, 1, "PIS", 3)
    for rx, tipo, tam in ((_CTX_PIS, "PIS", 11), (_CTX_CNH, "CNH", 11), (_CTX_TITULO, "TITULO", 12)):
        for m in rx.finditer(texto):
            if len(so_digitos(m.group(1))) == tam:
                _add(c, m, 1, tipo, 0)
    for m in _CTX_RG.finditer(texto):
        if len(re.sub(r"[^\dXx]", "", m.group(1))) >= 7:
            _add(c, m, 1, "RG", 0)
    for m in _CEP.finditer(texto):
        _add(c, m, 1, "CEP", 3)
    for m in _CTX_CEP.finditer(texto):
        _add(c, m, 1, "CEP", 0)
    for m in _EMAIL.finditer(texto):
        _add(c, m, 0, "EMAIL", 1)
    for m in _UUID.finditer(texto):
        _add(c, m, 0, "PIX", 1)
    for m in _CTX_AGENCIA.finditer(texto):
        _add(c, m, 1, "AGENCIA", 0)
    for m in _CTX_CONTA.finditer(texto):
        _add(c, m, 1, "CONTA", 0)
    for m in _TEL.finditer(texto):
        if _telefone_ok(texto, m):
            _add(c, m, 0, "TELEFONE", 4)
    for m in _TEL_55.finditer(texto):
        if int(m.group(1)) in DDDS_VALIDOS:
            _add(c, m, 0, "TELEFONE", 1)
    for m in _TEL_0800.finditer(texto):
        _add(c, m, 0, "TELEFONE", 3)
    for m in _TEL_PLANO.finditer(texto):
        ddd, ini = m.group(1), m.group(2)
        if (int(ddd) in DDDS_VALIDOS and _CTX_TEL.search(_antes(texto, m.start(), 30))
                and (ini[0] == "9" if len(ini) == 5 else ini[0] in "2345678")):
            _add(c, m, 0, "TELEFONE", 4)
    if datas:
        for m in _DATA_NUM.finditer(texto):
            if _data_ok(m.group(1), m.group(3), m.group(4)):
                _add(c, m, 0, "DATA", 5)
        for m in _DATA_ISO.finditer(texto):
            if _data_ok(m.group(3), m.group(2), m.group(1)):
                _add(c, m, 0, "DATA", 5)
        for m in _DATA_EXT.finditer(texto):
            _add(c, m, 0, "DATA", 5)
    if valores:
        for rx in (_VALOR_RS, _VALOR_REAIS, _VALOR_EXT):
            for m in rx.finditer(texto):
                _add(c, m, 0, "VALOR", 5)
    return _resolver(c)


def _data_ok(dia, mes, ano):
    try:
        a = int(ano)
        a = a + 2000 if a < 100 else a
        dt.date(a, int(mes), int(dia))
        return 1900 <= a <= 2100
    except ValueError:
        return False


def _telefone_ok(texto, m):
    p55, ddd, ini, sep, fim = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
    ctx = bool(_CTX_TEL.search(_antes(texto, m.start(), 30)))
    celular = len(ini) == 5
    if celular and ini[0] != "9":
        return False
    if not celular and ini[0] not in "2345678":
        return False
    ddd_num = None
    if ddd:
        ddd_num = int(so_digitos(ddd))
        if ddd_num not in DDDS_VALIDOS:
            return False
    if p55 and not ddd:
        return False
    com_hifen = sep == "-"
    if p55 and p55.startswith("+"):
        return True
    if ddd and ddd.lstrip().startswith("("):
        return True
    if ddd:
        return com_hifen or celular or ctx
    if celular and com_hifen:
        return True
    return ctx


def _resolver(candidatos):
    candidatos.sort(key=lambda s: (s[3], -(s[1] - s[0]), s[0]))
    escolhidos = []
    for s in candidatos:
        if all(s[1] <= e[0] or s[0] >= e[1] for e in escolhidos):
            escolhidos.append(s)
    escolhidos.sort()
    return escolhidos
