#!/bin/bash
# session-context.sh — SessionStart hook do DG Claw.
#
# Resolve o problema da compactacao: quando a conversa fica grande, o Claude Code
# compacta o contexto sozinho. No default, o resumo guarda o "diario de bordo" do
# CLI (chamadas de tool, etc), mas PERDE o fio real da conversa do Telegram — aí a
# pessoa responde algo e a agente nao sabe do que se trata.
#
# Este hook roda no inicio de sessao E logo apos a compactacao (source=compact) e
# RE-INJETA o contexto que importa pra agente continuar coerente:
#   1. Contexto global: working-memory.md + MEMORY.md
#   2. As ultimas mensagens REAIS trocadas no Telegram (chat-tail.md)
#
# Assim, pos-compactacao, a agente ve a mesma conversa que o usuario ve.
# Falha silenciosa PARA A SESSAO (ela precisa subir mesmo se isto quebrar), mas
# nunca calada: o motivo vai para <ws>/.dgclaw/logs/session-context.log.
#
# MODO DE SEGURANCA (01/10/2026). Com <ws>/.dgclaw/modo-seguro.json presente, a sessao
# acabou de ser reiniciada SEM a conversa anterior, porque algo nela fazia o agente
# travar (a recusa do filtro da Anthropic que deixou a Isa muda em 30/09). Aqui e a
# porta por onde o texto envenenado voltaria: o chat-tail.md. Entao, nesse modo:
#   - o chat-tail so e reinjetado se o reinicio o REFEZ (marca chatTailRefeito=true),
#     e o arquivo refeito so tem o fio ate `cortarDepoisDe`; sem a marca, nao entra;
#   - o cabecalho diz ao agente que ele esta em modo de seguranca e que NAO deve abrir
#     o transcript anterior, a quarentena nem reprocessar anexos daquela conversa.
# Quem grava a marca e o _lib/reinicio.py. Ver docs/SAUDE-E-MODO-SEGURO.md.
#
# POR QUE O CONTEUDO NAO E MAIS INTERPOLADO EM CODIGO (01/10/2026). Ate aqui a memoria
# era colada dentro de um '''...''' de Python. Uma aspa tripla ou uma contra-barra
# (C:\Users, \n escrito de verdade) na working-memory virava SyntaxError, e como o erro
# ia para /dev/null a reinjecao pos-compact sumia calada. No pior caso, texto da
# memoria virava codigo. Agora o Python le os ARQUIVOS ele mesmo; o shell so passa
# caminhos e o `source` por variavel de ambiente.

set +e

WORKSPACE="${DGCLAW_WORKSPACE:-$PWD}"
HOOK_INPUT=$(cat)

HOOK_INPUT="$HOOK_INPUT" DGCLAW_WORKSPACE="$WORKSPACE" python3 - <<'PY'
import json, os, sys, traceback
from datetime import datetime

ws = os.environ.get("DGCLAW_WORKSPACE") or os.getcwd()
dg = os.path.join(ws, ".dgclaw")
N_MSGS = 24  # quantas ultimas mensagens do canal re-injetar


def registrar(msg):
    try:
        os.makedirs(os.path.join(dg, "logs"), exist_ok=True)
        with open(os.path.join(dg, "logs", "session-context.log"), "a") as f:
            f.write(f"[{datetime.now().astimezone().isoformat(timespec='seconds')}] {msg}\n")
    except OSError:
        pass


def ler(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return None
    except OSError as e:
        registrar(f"nao consegui ler {p}: {e}")
        return None


try:
    try:
        source = json.loads(os.environ.get("HOOK_INPUT") or "{}").get("source", "")
    except ValueError:
        source = ""

    # Zera o contador de trocas ao compactar (o aviso de "conversa longa" reinicia)
    if source == "compact":
        try:
            with open(os.path.join(dg, "turns.count"), "w") as f:
                f.write("0\n")
        except OSError as e:
            registrar(f"nao consegui zerar turns.count: {e}")

    marca = None
    bruto = ler(os.path.join(dg, "modo-seguro.json"))
    if bruto is not None:
        try:
            marca = json.loads(bruto)
        except ValueError as e:
            # Marca quebrada conta como LIGADA e sem fio refeito: e o lado seguro.
            registrar(f"modo-seguro.json ilegivel ({e}); tratando como ligado")
            marca = {"ativo": True, "chatTailRefeito": False}
    seguro = bool(marca and marca.get("ativo", True))

    # CLAUDE.md que ja importa a memoria (@working-memory.md / @MEMORY.md, template de
    # 05/10/2026) carrega o arquivo inteiro sozinho, no boot e depois de compactar. Reinjetar
    # aqui seria a mesma memoria duas vezes no contexto, pagando duas vezes.
    claude_md = ler(os.path.join(ws, "CLAUDE.md")) or ""
    importados = {l.strip() for l in claude_md.splitlines() if l.startswith("@")}
    out = []
    wm = ler(os.path.join(ws, "working-memory.md"))
    if wm and "@working-memory.md" in importados:
        wm = None
    if wm:
        # Sai so o titulo "# " do topo e as citacoes ">" (instrucoes do modelo). Os "## "
        # FICAM: sao os nomes das secoes ("Tarefas em andamento", "Ultimas conversas"), e
        # sem eles o agente recebe uma lista solta sem saber o que e o que. Ate 01/10/2026
        # um `sed 's/^#.*//'` apagava os dois, e um `head -60` cortava a WM nova no meio.
        linhas = [l for l in wm.splitlines() if not l.startswith(">") and not (l.startswith("# ") or l == "#")]
        corpo = "\n".join(linhas).strip()
        TETO = 14000  # a WM nova chega a ~9 KB; isto entra so no boot e na compactacao
        if len(corpo) > TETO:
            registrar(f"working-memory com {len(corpo)} caracteres; reinjetei os primeiros {TETO}")
            corpo = corpo[:TETO].rstrip() + "\n\n(... a working-memory continua no arquivo; leia o resto se precisar)"
        out.append("## Sua memoria de curto prazo (working-memory.md)\n\n" + corpo)
    mem = ler(os.path.join(ws, "MEMORY.md"))
    if mem and "@MEMORY.md" in importados:
        mem = None
    if mem:
        fatos = [l for l in mem.splitlines() if l.startswith("- ")][:50]
        if fatos:
            out.append("## Fatos de longo prazo (MEMORY.md)\n\n" + "\n".join(fatos))

    tail = ler(os.path.join(dg, "chat-tail.md"))
    if tail and (not seguro or marca.get("chatTailRefeito") is True):
        ultimas = tail.splitlines()[-N_MSGS:]
        if ultimas:
            out.append("## Ultimas mensagens da conversa no Telegram (o fio que o usuario ve)\n\n"
                       + "\n".join(ultimas))
    elif tail and seguro:
        registrar("modo de seguranca sem chat-tail refeito: o fio antigo NAO foi reinjetado")

    if not out and not seguro:
        sys.exit(0)

    if seguro:
        header = (
            "Voce esta em MODO DE SEGURANCA desde " + str(marca.get("ativadoEm") or "agora")
            + ". Motivo: " + str(marca.get("motivo") or "a conversa anterior fazia voce travar") + ". "
            "A conversa anterior NAO foi carregada nesta sessao, de proposito. Nao abra nem leia o "
            "transcript anterior (.jsonl em ~/.claude/projects), nem a pasta .dgclaw/quarentena, e nao "
            "reprocesse anexos, audios ou transcricoes daquela conversa. Nao retome o ultimo assunto "
            "sozinho: fale com o dono e pergunte como ele quer seguir. Contexto seguro abaixo:"
        )
    elif source == "compact":
        header = ("A conversa foi compactada agora. Pra voce NAO perder o fio do que estava rolando no "
                  "Telegram, aqui esta o contexto real (use isto como a verdade da conversa atual):")
    else:
        header = "Contexto pra voce retomar a conversa com o dono (memoria + ultimas mensagens do Telegram):"

    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": header + "\n\n" + "\n\n".join(out),
    }}, ensure_ascii=False))
except SystemExit:
    raise
except Exception:
    registrar("falhou montando o contexto: " + traceback.format_exc().replace("\n", " | "))
PY

exit 0
