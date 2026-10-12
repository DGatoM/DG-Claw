#!/usr/bin/env python3
"""test_build_working_memory.py — a bancada da working-memory.

Monta workspaces e transcripts de mentira num diretorio temporario e roda o
build-working-memory.py de verdade, com o relogio fingido (DGCLAW_WM_AGORA), conferindo o
que o Danilo exigiu em 01/10/2026: as quatro secoes sobre o dono no topo, as ultimas
conversas geradas sem LLM, o "Ontem" que nao fica mais vazio, e a migracao de uma
working-memory antiga sem perder uma linha.

    python3 test_build_working_memory.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
BUILD = AQUI / "build-working-memory.py"

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


def reply(texto, ts):
    return {"type": "assistant", "timestamp": ts, "message": {"content": [
        {"type": "tool_use", "name": "mcp__dgchat__reply", "input": {"chat": "c1", "text": texto}}]}}


def dg(texto):
    return f'<dgchat from="Paulo Souza" chat="c1" msg="1" ts="x">{texto}</dgchat>'


WM_ANTIGA = """# Working Memory de Bento

> Memoria viva, curta. Regenerada todo dia as 7h.

⚡ PENDÊNCIAS ATIVAS: video do banco esperando a cena 13 | video da poupanca parado.

## Agora
- **Agora:** quarta, 30/09/2026 17:00 BRT

## Hoje
- (vazio — cada cron e cada conversa adicionam uma linha aqui)

## Ontem
- (vazio — cada cron e cada conversa adicionam uma linha aqui)

## Pessoas proximas
- Paulo (meu criador)

## Na minha cabeca
- Entrega dele abre no celular: pagina ou PDF.
- Erro meu eu conto cedo.

## Metas de curto prazo
- Esperar a palavra dele sobre a cena 13.

## Instrucoes do Paulo
- [post] usar tom leve (recebido 2026-09-01 10:00)
- [post] coisa velha [APLICADO 2026-09-02]

## Quero Falar com o Paulo Sobre
- A pasta persona/ esta vazia.

## Projetos meus
- secao que eu criei e o build nao conhece

## Agenda Hoje
- (cron de agenda/calendario popula aqui, se houver — senao fica vazio)

<!-- CARRY-OVER DA PLATAFORMA: escrito antes de um compact automático. -->
### O que estava rolando
- linha do carry-over
<!-- FIM DO CARRY-OVER DA PLATAFORMA -->
"""

base = Path(tempfile.mkdtemp(prefix="dgclaw-wm-teste-"))


def novo_ws(nome, wm=None, transcript=None):
    ws = base / nome
    sess = base / (nome + "-sessoes")
    (ws / "memory").mkdir(parents=True)
    (ws / ".dgclaw" / "logs").mkdir(parents=True)
    sess.mkdir()
    if wm is not None:
        (ws / "working-memory.md").write_text(wm, encoding="utf-8")
    if transcript:
        with open(sess / "s.jsonl", "w", encoding="utf-8") as f:
            for o in transcript:
                f.write(json.dumps(o, ensure_ascii=False) + "\n")
    return ws, sess


def build(ws, sess, agora, *flags):
    env = {**os.environ, "DGCLAW_WORKSPACE": str(ws), "DGCLAW_SESSION_DIR": str(sess),
           "DGCLAW_OWNER": "Paulo", "DGCLAW_NAME": "Bento", "DGCLAW_TZ": "America/Sao_Paulo",
           "DGCLAW_WM_AGORA": agora}
    r = subprocess.run([sys.executable, str(BUILD), *flags], capture_output=True, text=True, env=env)
    if r.returncode != 0:
        print("    (stderr do build:", r.stderr.strip()[:500], ")")
    return r.returncode, (ws / "working-memory.md").read_text(encoding="utf-8")


def secoes(texto):
    return [l[3:].strip() for l in texto.splitlines() if l.startswith("## ")]


def corpo(texto, secao):
    out, dentro = [], False
    for l in texto.splitlines():
        if l.startswith("## "):
            dentro = l[3:].strip() == secao
            continue
        if dentro and l.strip():
            out.append(l)
    return out


try:
    print("\n1. migracao de uma working-memory antiga (nada se perde)")
    conversa = [
        user(dg("bom dia, vamos fechar o roteiro do banco?"), "2026-09-30T12:00:00Z"),
        reply("Bom dia, Paulo! Fechamos sim, falta so a cena 13.", "2026-09-30T12:00:05Z"),
        user("leia /tmp/dgclaw-poke-bento-heartbeat-20260930-130000.txt e execute", "2026-09-30T13:00:00Z"),
        reply("Paulo, a Selic caiu hoje para 13,75%.", "2026-09-30T13:00:10Z"),
    ]
    ws, sess = novo_ws("migra", WM_ANTIGA, conversa)
    rc, wm = build(ws, sess, "2026-10-01T07:00")
    confere("o build sai 0", rc, 0)
    s = secoes(wm)
    confere("as quatro secoes novas vem logo depois das pendencias, nesta ordem",
            s[:5], ["Objetivos do Paulo", "Tarefas em andamento", "O que eu sei sobre o Paulo",
                    "Últimas conversas", "Agora"])
    reais = [l for l in WM_ANTIGA.splitlines()
             if l.strip() and not l.startswith(("#", ">")) and "(vazio" not in l and "**Agora:**" not in l
             and "[APLICADO" not in l and "(cron de agenda" not in l]
    perdidas = [l for l in reais if l not in wm]
    confere("toda linha real da antiga continua no arquivo", perdidas, [])
    confere("a instrucao ja aplicada foi limpa (comportamento antigo mantido)", "[APLICADO" in wm, False)
    confere("a secao que o agente criou foi preservada", "Projetos meus" in s, True)
    confere("o carry-over da plataforma volta intacto, no fim",
            wm.rstrip().endswith("<!-- FIM DO CARRY-OVER DA PLATAFORMA -->"), True)
    confere("o placeholder antigo de 'Hoje' NAO virou conteudo de 'Ontem'",
            any("(vazio" in l for l in corpo(wm, "Ontem")), False)
    confere("o arquivo fica dentro do teto de 9000 bytes", len(wm.encode("utf-8")) <= 9000, True)

    print("\n2. ultimas conversas: deterministicas, com data, uma linha por troca")
    conv = corpo(wm, "Últimas conversas")
    confere("duas linhas (a troca do dono e a mensagem por conta propria)", len(conv), 2)
    confere("a troca leva data no fuso do dono, canal, quem falou e a minha resposta",
            conv[0], "- 30/09 09:00 (painel) Paulo: bom dia, vamos fechar o roteiro do banco? "
                     "→ eu: Bom dia, Paulo! Fechamos sim, falta so a cena 13.")
    confere("o poke nao aparece, mas o que eu mandei puxado por ele sim, marcado",
            conv[1].startswith("- 30/09 10:00 (painel) eu, por conta propria: Paulo, a Selic"), True)
    confere("'Agora' diz ha quanto tempo ele falou", "Ultima fala do Paulo:** ha 22h (30/09 09:00)" in wm, True)
    confere("'Ontem' sem resumo nem diario conta as mensagens do canal",
            corpo(wm, "Ontem"), ["<!-- dia 2026-09-30 -->", "- No canal: 1 mensagem(ns) do Paulo e 2 minha(s)."])

    print("\n3. a reflexao deixa o resumo em 'Hoje' e ele vira 'Ontem' as 7h")
    wm2 = wm.replace("## Hoje\n- (vazio: cada conversa e cada rotina acrescentam uma linha aqui)",
                     "## Hoje\n<!-- resumo do dia 2026-10-01 -->\n- Fechei o roteiro com ele.\n- A cena 13 ficou pra sexta.")
    wm2 = wm2.replace("## O que eu sei sobre o Paulo\n", "## O que eu sei sobre o Paulo\n- Prefere audio a texto longo (aprendi em 2026-10-01)\n")
    (ws / "working-memory.md").write_text(wm2, encoding="utf-8")
    rc, wm3 = build(ws, sess, "2026-10-02T07:00")
    confere("'Ontem' traz o resumo da reflexao, com a marca do dia",
            corpo(wm3, "Ontem"), ["<!-- dia 2026-10-01 -->", "- Fechei o roteiro com ele.", "- A cena 13 ficou pra sexta."])
    confere("'Hoje' recomeca vazio", corpo(wm3, "Hoje"), ["- (vazio: cada conversa e cada rotina acrescentam uma linha aqui)"])
    confere("a crenca curada continua, e o placeholder de formato saiu",
            corpo(wm3, "O que eu sei sobre o Paulo"), ["- Prefere audio a texto longo (aprendi em 2026-10-01)"])
    rc, wm4 = build(ws, sess, "2026-10-02T15:00")
    confere("rodar o build de novo no mesmo dia nao apaga o 'Ontem'", corpo(wm4, "Ontem"), corpo(wm3, "Ontem"))

    print("\n4. sem resumo da reflexao, o 'Ontem' sai do diario")
    ws, sess = novo_ws("diario", WM_ANTIGA)
    (ws / "memory" / "2026-09-30.md").write_text(
        "# 2026-09-30 (quarta)\n\n## O dia\n\nConferi o CDI: 13,65%.\n\nNada novo do Paulo.\n", encoding="utf-8")
    rc, wm = build(ws, sess, "2026-10-01T07:00")
    confere("as linhas do diario viram o 'Ontem', com a fonte citada",
            corpo(wm, "Ontem"), ["<!-- dia 2026-09-30 -->", "- Conferi o CDI: 13,65%.", "- Nada novo do Paulo.",
                                 "- (resumo tirado do diario memory/2026-09-30.md)"])
    ws, sess = novo_ws("nada", WM_ANTIGA)
    rc, wm = build(ws, sess, "2026-10-01T07:00")
    confere("sem resumo, sem diario e sem conversa, ele DIZ que nao ha nada (e nao finge)",
            corpo(wm, "Ontem")[1].startswith("- (nada registrado em 30/09: sem resumo da reflexao"), True)
    confere("sem transcript, 'Ultimas conversas' diz que ainda nao houve conversa",
            corpo(wm, "Últimas conversas"), ["- (ainda nao houve conversa pelo canal)"])

    print("\n5. o teto: o que nao cabe vai pro transbordo, nao pro lixo")
    grande = "\n".join(f"- crenca numero {i}: " + "x" * 120 + " (aprendi em 2026-09-01)" for i in range(30))
    wm_g = WM_ANTIGA.replace("## Agora\n", f"## O que eu sei sobre o Paulo\n{grande}\n\n## Agora\n")
    ws, sess = novo_ws("teto", wm_g)
    rc, wm = build(ws, sess, "2026-10-01T07:00")
    sei = corpo(wm, "O que eu sei sobre o Paulo")
    confere("a secao curada respeita o teto dela (1800 bytes, mais a nota)", len("\n".join(sei[:-1]).encode()) <= 1800, True)
    confere("e avisa onde esta o resto", sei[-1].endswith("em memory/wm-transbordo.md)"), True)
    tb = (ws / "memory" / "wm-transbordo.md").read_text(encoding="utf-8")
    confere("as crencas que sairam estao no transbordo, com a secao de origem",
            ("crenca numero 29" in tb) and ('saiu de "O que eu sei sobre o Paulo"' in tb), True)
    confere("nenhuma crenca sumiu (arquivo + transbordo)",
            all(f"crenca numero {i}:" in wm + tb for i in range(30)), True)

    print("\n6. --agora-only (o batimento) atualiza sem virar o dia")
    ws, sess = novo_ws("batimento", WM_ANTIGA.replace(
        "## Hoje\n- (vazio — cada cron e cada conversa adicionam uma linha aqui)",
        "## Hoje\n- 10:00 mandei o PDF pro Paulo"), conversa)
    rc, wm = build(ws, sess, "2026-10-01T11:00", "--agora-only")
    confere("o batimento sai 0", rc, 0)
    confere("a working-memory antiga ganha as secoes novas na hora",
            secoes(wm)[:5], ["Objetivos do Paulo", "Tarefas em andamento", "O que eu sei sobre o Paulo",
                             "Últimas conversas", "Agora"])
    confere("'Hoje' fica como estava (o dia so vira as 7h)", corpo(wm, "Hoje"), ["- 10:00 mandei o PDF pro Paulo"])
    confere("e o carry-over continua intacto", "- linha do carry-over" in wm, True)
    rc, wm_b = build(ws, sess, "2026-10-01T11:30", "--agora-only")
    confere("rodar de novo nao duplica secao", len(secoes(wm_b)), len(set(secoes(wm_b))))

    print("\n7. agente novo, sem working-memory nenhuma")
    ws, sess = novo_ws("novo")
    rc, wm = build(ws, sess, "2026-10-01T07:00")
    confere("o build cria o arquivo do zero", (rc, secoes(wm)[0]), (0, "Objetivos do Paulo"))
finally:
    shutil.rmtree(base, ignore_errors=True)

print(f"\n{contados[0] - len(falhas)}/{contados[0]} ok")
if falhas:
    print("FALHAS:", ", ".join(falhas))
    sys.exit(1)
