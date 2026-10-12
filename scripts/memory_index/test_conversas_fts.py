#!/usr/bin/env python3
"""test_conversas_fts.py — a bancada da busca em conversas antigas.

Roda sem agente vivo, sem rede e sem sujar a maquina: monta um workspace e transcripts de
mentira num diretorio temporario e confere o que o indice guarda, o que a busca acha e o
que o recall automatico decide injetar. Uma busca errada nao da erro nenhum: ela so deixa
de achar, e ninguem percebe ate o dono dizer "eu te falei isso e voce esqueceu".

    python3 test_conversas_fts.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
SCRIPT = AQUI / "conversas_fts.py"

falhas = []
contados = [0]


def confere(nome, obtido, esperado):
    contados[0] += 1
    if obtido == esperado:
        print(f"  ✓ {nome}")
    else:
        print(f"  ✗ {nome}\n      esperado: {esperado!r}\n      obtido:   {obtido!r}")
        falhas.append(nome)


def user(texto, ts):
    return {"type": "user", "timestamp": ts, "message": {"content": [{"type": "text", "text": texto}]}}


def tool(nome, entrada, ts):
    return {"type": "assistant", "timestamp": ts,
            "message": {"content": [{"type": "tool_use", "name": nome, "input": entrada}]}}


def resultado_ferramenta(conteudo, ts):
    return {"type": "user", "timestamp": ts,
            "message": {"content": [{"type": "tool_result", "content": conteudo}]}}


def dg(texto):
    return f'<dgchat from="Paulo" chat="c1" msg="1" ts="x">{texto}</dgchat>'


TG = '<channel source="plugin:telegram:telegram" user="Paulo">'

base = Path(tempfile.mkdtemp(prefix="dgclaw-fts-teste-"))
ws = base / "ws"
sess = base / "sessoes"
(ws / "memory" / "clientes").mkdir(parents=True)
sess.mkdir()
ENV = {**os.environ, "DGCLAW_WORKSPACE": str(ws), "DGCLAW_SESSION_DIR": str(sess),
       "DGCLAW_OWNER": "Paulo", "DGCLAW_NAME": "Bento", "DGCLAW_TZ": "America/Sao_Paulo"}
ENV.pop("DGCLAW_CONVERSAS_DB", None)


def roda(*args, entrada=None):
    r = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(ws), *args],
                       capture_output=True, text=True, env=ENV, input=entrada)
    return r.returncode, r.stdout, r.stderr


def grava(nome, linhas, modo="w"):
    with open(sess / nome, modo, encoding="utf-8") as f:
        for o in linhas:
            f.write(json.dumps(o, ensure_ascii=False) + "\n")


try:
    print("\n1. antes do primeiro reindex a busca diz que nao ha indice (e nao cria nada)")
    rc, out, err = roda("buscar", "qualquer")
    confere("buscar sem indice sai com codigo 2", rc, 2)
    confere("e nao cria o banco", (ws / ".dgclaw" / "memory_index" / "conversas.db").exists(), False)
    rc, out, _ = roda("status")
    confere("status diz desligada", out.strip().startswith("busca em conversas: desligada"), True)

    print("\n2. o reindex guarda so a conversa de verdade")
    grava("s1.jsonl", [
        user(dg("quero falar da reuniao com o Bradesco sobre o patrocinio"), "2026-09-02T20:40:00Z"),
        tool("mcp__dgchat__reply", {"chat": "c1", "text": "Fechado, anotei a reuniao do patrocinio."}, "2026-09-02T20:40:05Z"),
        user("leia /tmp/dgclaw-poke-bento-heartbeat-20260902-210000.txt e execute", "2026-09-02T21:00:00Z"),
        resultado_ferramenta("PATROCINIO " * 5000, "2026-09-02T21:00:02Z"),
        tool("mcp__dgchat__reply", {"chat": "c1", "text": "Bom dia! Lembrete do roteiro da cena 13."}, "2026-09-03T10:00:00Z"),
        user(TG + "e o Zarvanito, conseguiu falar com ele?</channel>", "2026-09-04T12:00:00Z"),
        tool("mcp__telegram__telegram__reply", {"text": "Ainda nao, ele nao respondeu."}, "2026-09-04T12:00:03Z"),
    ])
    (ws / "MEMORY.md").write_text("# Memoria\n\n## Pessoas\n- Zarvanito e o contador do Paulo (2026-08-20)\n", encoding="utf-8")
    (ws / "memory" / "2026-09-02.md").write_text("# 2026-09-02\n\nO Paulo pediu o roteiro completo com o grid de fotos.\n", encoding="utf-8")
    (ws / "memory" / "clientes" / "santander.md").write_text("- O bonus da Santander ainda nao foi confirmado.\n", encoding="utf-8")
    rc, out, err = roda("reindex")
    confere("reindex sai 0", rc, 0)
    confere("conta 5 falas e 3 trechos de memoria (titulo nao e trecho)", "+5 fala(s) de conversa, +3 trecho(s) de memoria" in out, True)
    db = ws / ".dgclaw" / "memory_index" / "conversas.db"
    confere("o banco nasce fechado (600)", oct(db.stat().st_mode & 0o777), "0o600")

    print("\n3. a busca acha, cita e destaca")
    rc, out, _ = roda("buscar", "patrocinio")
    linhas = [l for l in out.splitlines() if l.startswith("[")]
    confere("acha as duas falas sobre o patrocinio (e nao o tool_result gigante)", len(linhas), 2)
    confere("cita data e hora no fuso do dono, canal e quem falou",
            linhas[0].startswith("[02/09/2026 17:40 · painel · Paulo]")
            or linhas[1].startswith("[02/09/2026 17:40 · painel · Paulo]"), True)
    confere("destaca o termo", "«patrocinio»" in out, True)
    rc, out, _ = roda("buscar", "reuniao")
    confere("acento nao atrapalha (reuniao acha reuniao)", "«reuniao»" in out, True)
    rc, out, _ = roda("buscar", "poke heartbeat")
    confere("poke de rotina nao entra no indice", "nada encontrado" in out, True)
    rc, out, _ = roda("buscar", "Zarvanito", "--so", "conversas")
    confere("--so conversas tira a memoria", ("telegram" in out) and ("memoria" not in out), True)
    rc, out, _ = roda("buscar", "Zarvanito", "--desde", "2026-09-03", "--json")
    res = json.loads(out)["resultados"]
    confere("--desde corta o que e mais antigo (a linha de MEMORY.md e de 20/08)",
            sorted(r["tipo"] for r in res), ["conversa"])
    rc, out, _ = roda("buscar", "santander")
    confere("memory/ e lido com subpastas", "memory/clientes/santander.md" in out, True)
    rc, out, _ = roda("buscar", "bradesco cena")
    confere("sem trecho com as duas palavras, cai no OU e avisa",
            out.startswith("(nenhum trecho tem todas as palavras"), True)
    rc, _, err = roda("buscar", "x", "--desde", "02/09/2026")
    confere("--desde em formato errado e recusado com explicacao", (rc, "AAAA-MM-DD" in err), (1, True))

    print("\n4. incremental: so o que entrou depois, e linha pela metade espera")
    rc, out, _ = roda("reindex", "--quieto")
    confere("sem novidade, --quieto nao fala nada", out.strip(), "")
    grava("s1.jsonl", [user(dg("anota: a gravacao ficou pra quinta"), "2026-09-05T13:00:00Z")], modo="a")
    with open(sess / "s1.jsonl", "a", encoding="utf-8") as f:
        f.write('{"type": "user", "timestamp": "2026-09-05T13:01:00Z", "message": {"content": [{"type": "text", "text": "<dgchat from=\\"Paulo\\" chat=\\"c1\\" msg=\\"2\\" ts=\\"x\\">metade')
    rc, out, _ = roda("reindex")
    confere("entra so a fala nova (a linha pela metade fica pra depois)", "+1 fala(s) de conversa" in out, True)
    with open(sess / "s1.jsonl", "a", encoding="utf-8") as f:
        f.write(' da frase sobre a quinta</dgchat>"}]}}\n')
    rc, out, _ = roda("reindex")
    confere("quando a linha termina, ela entra inteira", "+1 fala(s) de conversa" in out, True)
    rc, out, _ = roda("buscar", "metade frase")
    confere("e a busca acha a frase completa", "«metade» da «frase»" in out, True)

    print("\n5. transcript repetido nao duplica, transcript apagado nao apaga a lembranca")
    shutil.copy(sess / "s1.jsonl", sess / "s1-copia.jsonl")
    rc, out, _ = roda("reindex")
    confere("a copia (sessao retomada) nao duplica nada", "+0 fala(s) de conversa" in out, True)
    (sess / "s1.jsonl").unlink()
    (sess / "s1-copia.jsonl").unlink()
    rc, out, _ = roda("reindex")
    rc, out, _ = roda("buscar", "patrocinio")
    confere("o Claude Code limpou o transcript, mas o indice lembra", out.count("«patrocinio»") >= 1, True)

    print("\n6. memoria editada e apagada")
    (ws / "memory" / "clientes" / "santander.md").write_text("- O bonus da Santander foi confirmado: R$ 500.\n", encoding="utf-8")
    roda("reindex")
    rc, out, _ = roda("buscar", "santander")
    confere("a versao nova substitui a velha", ("confirmado" in out) and ("ainda nao foi" not in out), True)
    (ws / "memory" / "clientes" / "santander.md").unlink()
    roda("reindex")
    rc, out, _ = roda("buscar", "santander")
    confere("arquivo de memoria apagado sai do indice", "nada encontrado" in out, True)

    print("\n7. o recall automatico: so fala do dono, so casamento bom, no maximo 3")
    def recall(prompt):
        rc, out, err = roda("recall", entrada=json.dumps({"input": prompt}))
        return json.loads(out)
    r = recall(dg("lembra o que eu falei do Zarvanito?"))
    confere("palavra rara sozinha ja dispara", r["fired"], True)
    confere("e traz o trecho certo", "Zarvanito" in (r["recall"] or ""), True)
    confere("no maximo 3 trechos", (r["recall"] or "").count("\n- [") <= 3, True)
    r = recall("leia /tmp/dgclaw-poke-bento-reflection-20260905-233000.txt e execute Zarvanito")
    confere("poke de rotina nunca dispara (mesmo citando a palavra)", r["fired"], False)
    r = recall("Zarvanito digitado direto no terminal, sem canal")
    confere("texto sem envelope de canal nao dispara", r["fired"], False)
    r = recall(dg("ok, pode mandar"))
    confere("mensagem curta e comum nao dispara", r["fired"], False)
    r = recall(TG + "e a reuniao do patrocinio, alguma novidade?</channel>")
    confere("Telegram tambem dispara, com duas palavras casando", r["fired"], True)

    print("\n8. status para o doctor e o painel")
    rc, out, _ = roda("status")
    confere("status diz ligada e conta os trechos",
            (rc, out.startswith("busca em conversas: ligada (")), (0, True))
    rc, out, _ = roda("status", "--json")
    s = json.loads(out)
    confere("o JSON separa conversa e memoria", (s["ligada"], s["conversa"] > 0, s["memoria"] > 0), (True, True, True))
finally:
    shutil.rmtree(base, ignore_errors=True)

print(f"\n{contados[0] - len(falhas)}/{contados[0]} ok")
if falhas:
    print("FALHAS:", ", ".join(falhas))
    sys.exit(1)
