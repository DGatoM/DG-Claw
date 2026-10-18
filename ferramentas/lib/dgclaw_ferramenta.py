"""Biblioteca do pipeline de uma ferramenta sensível do DG Claw (bloco I).

O executor de uma ferramenta usa só estas funções:

    entrada()                                 os parâmetros que o serviço já validou
    pseudonimizar(valor)                      troca um identificador por um pseudônimo estável (HMAC-SHA256)
    agregar(linhas, por=..., medidas=...)     agrupa e SUPRIME os grupos com menos de `minimo_grupo` pessoas
    resultado(dados, registros_lidos=...)     entrega o resultado ao serviço (stdout) e os metadados (canal 3)

O serviço (ferramentas/servidor.js) ainda passa o resultado pelo verificador de saída antes de devolver ao agente.
Pseudônimo continua sendo dado pessoal (LGPD): ele só evita que o nome ou o CPF apareçam, não anonimiza.
"""
import hashlib
import hmac
import json
import os
import sys

__all__ = ["entrada", "pseudonimizar", "agregar", "resultado", "minimo_grupo", "pasta_saida", "ErroFerramenta"]


class ErroFerramenta(Exception):
    """Erro com mensagem pronta para o log do serviço (o texto nunca vai para o agente)."""


def entrada():
    """Os parâmetros que o serviço já validou, lidos do stdin: {"params": {...}, "ferramenta": "...", "minimo_grupo": N}."""
    texto = sys.stdin.read()
    try:
        return json.loads(texto)
    except ValueError as e:
        raise ErroFerramenta("o serviço não mandou um JSON válido no stdin do executor (%s)" % e)


def minimo_grupo():
    try:
        return int(os.environ["DGCLAW_MINIMO_GRUPO"])
    except (KeyError, ValueError):
        raise ErroFerramenta("falta DGCLAW_MINIMO_GRUPO no ambiente do executor: rode-o pelo serviço ou por 'dgclaw ferramenta testar'")


def pasta_saida():
    """Pasta temporária própria da execução, apagada no fim. É onde um relatório em arquivo deve ser gravado."""
    p = os.environ.get("DGCLAW_SAIDA_DIR")
    if not p:
        raise ErroFerramenta("falta DGCLAW_SAIDA_DIR no ambiente do executor")
    return p


def _chave():
    caminho = os.environ.get("DGCLAW_CHAVE_PSEUDONIMO")
    if not caminho:
        raise ErroFerramenta("falta DGCLAW_CHAVE_PSEUDONIMO no ambiente do executor")
    try:
        with open(caminho, "rb") as f:
            chave = f.read().strip()
    except OSError as e:
        raise ErroFerramenta("não consegui ler a chave de pseudônimo %s (%s). Crie com: dgclaw ferramenta chave" % (caminho, e.strerror))
    if len(chave) < 32:
        raise ErroFerramenta("a chave de pseudônimo %s tem menos de 32 bytes; gere outra com: dgclaw ferramenta chave" % caminho)
    return chave


def pseudonimizar(valor):
    """'p_' + 16 hexadecimais do HMAC-SHA256 do valor com a chave da empresa. O mesmo valor dá sempre o mesmo pseudônimo."""
    if valor is None:
        raise ErroFerramenta("pseudonimizar recebeu None; trate o campo vazio antes (um vazio não vira pseudônimo)")
    h = hmac.new(_chave(), str(valor).encode("utf-8"), hashlib.sha256).hexdigest()
    return "p_" + h[:16]


def _numero(v, medida, campo):
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ErroFerramenta("a medida %s precisa de números, e o campo %s trouxe %r" % (medida, campo, type(v).__name__))
    return v


def agregar(linhas, por, medidas=None, minimo=None):
    """Agrupa `linhas` (lista de dicts) pelo campo `por` e calcula as `medidas`.

    medidas: {"nome_da_saida": ("soma"|"media"|"minimo"|"maximo", "campo")}. Cada grupo traz também "pessoas" (a contagem de linhas).
    Grupo com menos de `minimo` linhas (padrão: o minimo_grupo da ferramenta) vira {por: valor, "pessoas": "menos de N", medida: "suprimido"}.
    Os grupos saem em ordem do valor de `por`, para a ordem não revelar nada.
    """
    n_min = minimo if minimo is not None else minimo_grupo()
    medidas = medidas or {}
    grupos = {}
    for linha in linhas:
        if por not in linha:
            raise ErroFerramenta("a linha não tem o campo %s usado em 'por'" % por)
        grupos.setdefault(linha[por], []).append(linha)
    saida = []
    for valor in sorted(grupos, key=lambda x: str(x)):
        membros = grupos[valor]
        if len(membros) < n_min:
            item = {por: valor, "pessoas": "menos de %d" % n_min}
            for nome in medidas:
                item[nome] = "suprimido"
            saida.append(item)
            continue
        item = {por: valor, "pessoas": len(membros)}
        for nome, (operacao, campo) in medidas.items():
            valores = [x for x in (_numero(m.get(campo), nome, campo) for m in membros) if x is not None]
            if not valores:
                item[nome] = None
            elif operacao == "soma":
                item[nome] = round(sum(valores), 2)
            elif operacao == "media":
                item[nome] = round(sum(valores) / len(valores), 2)
            elif operacao == "minimo":
                item[nome] = min(valores)
            elif operacao == "maximo":
                item[nome] = max(valores)
            else:
                raise ErroFerramenta("a operação %r da medida %s não existe (use soma, media, minimo ou maximo)" % (operacao, nome))
        saida.append(item)
    return saida


def resultado(dados, registros_lidos=None, nomes_proibidos=None, arquivo=None):
    """Entrega o resultado. `dados` (JSON) vai ao serviço pelo stdout; os metadados vão pelo canal 3, que o agente nunca vê.

    registros_lidos   quantas linhas da base o executor leu (vai para a auditoria; None quando não sabe)
    nomes_proibidos   nomes de pessoas da base que NÃO podem aparecer na saída (o verificador bloqueia se aparecerem)
    arquivo           nome de um arquivo gravado em pasta_saida() (relatório); o serviço o confere e o entrega
    """
    meta = {"registros_lidos": registros_lidos, "nomes_proibidos": list(nomes_proibidos or []), "arquivo": arquivo}
    try:
        with os.fdopen(3, "wb", closefd=False) as canal:
            canal.write(json.dumps(meta, ensure_ascii=False).encode("utf-8"))
    except OSError:
        print("aviso: o canal 3 dos metadados não está aberto; o executor está rodando fora do serviço", file=sys.stderr)
    sys.stdout.write(json.dumps(dados, ensure_ascii=False))
    sys.stdout.flush()
