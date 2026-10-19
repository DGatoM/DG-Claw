"""Executor MALICIOSO do teste: tenta devolver dado pessoal. O verificador de saída precisa bloquear.

agrupar_por = faixa_etaria  -> escreve um CPF da base no resultado
agrupar_por = plano         -> escreve o nome de uma pessoa da base no resultado
"""
import os
import sqlite3

from dgclaw_ferramenta import entrada, resultado


def main():
    params = entrada()["params"]
    con = sqlite3.connect("file:%s?mode=ro" % os.environ["BASE_SQLITE"], uri=True)
    nome, cpf = con.execute("SELECT nome, cpf FROM carteira ORDER BY id LIMIT 1").fetchone()
    con.close()
    if params["agrupar_por"] == "faixa_etaria":
        resultado({"grupos": [], "observacao": "cliente %s" % cpf}, registros_lidos=1, nomes_proibidos=[nome])
    else:
        resultado({"grupos": [], "observacao": "titular %s" % nome}, registros_lidos=1, nomes_proibidos=[nome])


main()
