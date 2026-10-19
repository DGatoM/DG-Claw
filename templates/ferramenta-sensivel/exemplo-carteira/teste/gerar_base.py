"""Gera a base SINTÉTICA do teste da ferramenta de exemplo: nomes e CPFs falsos, todos conhecidos.

Uso: python3 gerar_base.py <base.db> <segredos.json>

O teste falha se qualquer nome ou CPF listado em segredos.json aparecer na saída da ferramenta. Os CPFs são
calculados com dígito verificador válido (é o que o verificador de saída procura), mas não pertencem a ninguém.
"""
import json
import sqlite3
import sys

PRENOMES = ["Zuleica", "Hermenegildo", "Anastacia", "Baltazar", "Cleonice", "Valdemiro", "Ismenia", "Epaminondas", "Filomena", "Genoveva", "Heraclito", "Idalina"]
SOBRENOMES = ["Montenegro", "Albuquerque", "Vasconcelos", "Tavares", "Quintanilha", "Bittencourt", "Nogueira"]
INTERMEDIARIOS = ["Almeida", "Furtado", "Gouveia", "Ximenes", "Pimentel"]

# (faixa etária, quantas pessoas): a de 60+ tem só 3 e precisa ser suprimida com o mínimo de 10.
FAIXAS = [("18-29", 22), ("30-44", 25), ("45-59", 10), ("60+", 3)]
PLANOS = ["basico"] * 40 + ["completo"] * 17 + ["premium"] * 3


def cpf_valido(base9):
    d = [int(c) for c in base9]
    for tam in (9, 10):
        soma = sum(d[i] * (tam + 1 - i) for i in range(tam))
        d.append(((soma * 10) % 11) % 10)
    return "".join(str(x) for x in d)


def main():
    if len(sys.argv) != 3:
        sys.exit("uso: python3 gerar_base.py <base.db> <segredos.json>")
    destino, segredos_json = sys.argv[1], sys.argv[2]
    con = sqlite3.connect(destino)
    con.execute("CREATE TABLE carteira (id INTEGER PRIMARY KEY, nome TEXT, cpf TEXT, faixa_etaria TEXT, plano TEXT, valor REAL, competencia TEXT)")
    segredos = []
    i = 0
    for faixa, qtd in FAIXAS:
        for _ in range(qtd):
            nome = "%s %s %s" % (PRENOMES[i % 12], INTERMEDIARIOS[(i * 2) % 5], SOBRENOMES[(i * 3 + 1) % 7])
            cpf = cpf_valido("%09d" % (123456789 + i * 7919))
            con.execute("INSERT INTO carteira (nome, cpf, faixa_etaria, plano, valor, competencia) VALUES (?, ?, ?, ?, ?, ?)",
                        (nome, cpf, faixa, PLANOS[i], 200.0 + i * 3.5, "2026-09"))
            segredos += [nome, cpf, "%s.%s.%s-%s" % (cpf[:3], cpf[3:6], cpf[6:9], cpf[9:])]
            i += 1
    # Uma linha de outro mês: o filtro por período precisa deixá-la de fora.
    con.execute("INSERT INTO carteira (nome, cpf, faixa_etaria, plano, valor, competencia) VALUES (?, ?, ?, ?, ?, ?)",
                ("Teofilo Wanderley Quintanilha", cpf_valido("987654321"), "30-44", "basico", 999.0, "2026-08"))
    con.commit()
    con.close()
    with open(segredos_json, "w", encoding="utf-8") as f:
        json.dump(segredos, f, ensure_ascii=False)


main()
