"""Executor da ferramenta carteira.resumo: resumo agregado de uma carteira de clientes.

Lê a base (SQLite, só leitura), agrupa por faixa etária ou por plano, suprime os grupos pequenos e entrega só números.
Nome e CPF nunca saem da base para o resultado: o executor só seleciona as colunas de que precisa, e os nomes são
mandados ao serviço pelo canal de metadados, para o verificador de saída bloquear qualquer vazamento.

Troque a leitura da base pela do seu sistema. Duas regras valem sempre:
  1. texto que veio do agente nunca entra em SQL por concatenação (aqui a coluna sai de uma lista fechada);
  2. nada de print() de dado da base: o que o executor imprime em stderr vai para o log do servidor.
"""
import os
import sqlite3

from dgclaw_ferramenta import agregar, entrada, resultado

# A coluna vem de uma lista fechada: o parâmetro do agente só escolhe uma chave desta tabela.
COLUNAS = {"faixa_etaria": "faixa_etaria", "plano": "plano"}


def main():
    dados = entrada()
    params = dados["params"]
    coluna = COLUNAS[params["agrupar_por"]]
    # Credencial da ferramenta: BASE_SQLITE vem de credenciais.env e só existe dentro deste processo.
    con = sqlite3.connect("file:%s?mode=ro" % os.environ["BASE_SQLITE"], uri=True)
    con.row_factory = sqlite3.Row
    linhas = [dict(r) for r in con.execute(
        "SELECT %s AS grupo, valor FROM carteira WHERE competencia = ?" % coluna, (params["periodo"],))]
    nomes = [r[0] for r in con.execute("SELECT nome FROM carteira")]
    con.close()
    resumo = agregar(linhas, por="grupo", medidas={"valor_total": ("soma", "valor"), "valor_medio": ("media", "valor")})
    resultado({"periodo": params["periodo"], "agrupado_por": params["agrupar_por"], "grupos": resumo},
              registros_lidos=len(linhas), nomes_proibidos=nomes)


main()
