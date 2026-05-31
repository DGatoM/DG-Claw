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
# Falha silenciosa (a sessao precisa subir mesmo se isto quebrar).

set +e

WORKSPACE="${DGCLAW_WORKSPACE:-$PWD}"
TAIL="$WORKSPACE/.dgclaw/chat-tail.md"
N_MSGS=24   # quantas ultimas mensagens do Telegram re-injetar

HOOK_INPUT=$(cat)
SOURCE=$(printf '%s' "$HOOK_INPUT" | python3 -c "import json,sys
try: print(json.loads(sys.stdin.read()).get('source',''))
except Exception: print('')" 2>/dev/null)

# Zera o contador de trocas ao compactar (o aviso de "conversa longa" reinicia)
[ "$SOURCE" = "compact" ] && echo 0 > "$WORKSPACE/.dgclaw/turns.count" 2>/dev/null

OUT=""

# 1. Contexto global (curto + longo prazo)
if [ -f "$WORKSPACE/working-memory.md" ]; then
    OUT+="## Sua memoria de curto prazo (working-memory.md)\n\n"
    OUT+="$(sed -e 's/^#.*//' "$WORKSPACE/working-memory.md" | grep -v '^>' | head -60)\n\n"
fi
if [ -f "$WORKSPACE/MEMORY.md" ]; then
    OUT+="## Fatos de longo prazo (MEMORY.md)\n\n"
    OUT+="$(grep -E '^- ' "$WORKSPACE/MEMORY.md" | head -50)\n\n"
fi

# 2. Ultimas mensagens reais do Telegram (so se houver tail)
if [ -f "$TAIL" ]; then
    OUT+="## Ultimas mensagens da conversa no Telegram (o fio que o usuario ve)\n\n"
    OUT+="$(tail -n "$N_MSGS" "$TAIL")\n"
fi

[ -z "$OUT" ] && exit 0

# Cabecalho explicando, mais enfatico apos compactacao
if [ "$SOURCE" = "compact" ]; then
    HEADER="A conversa foi compactada agora. Pra voce NAO perder o fio do que estava rolando no Telegram, aqui esta o contexto real (use isto como a verdade da conversa atual):"
else
    HEADER="Contexto pra voce retomar a conversa com o dono (memoria + ultimas mensagens do Telegram):"
fi

printf '%s' "$HOOK_INPUT" | python3 -c "
import json, sys
header = '''$HEADER'''
body = '''$(printf '%b' "$OUT" | sed "s/'/’/g")'''
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': header + chr(10) + chr(10) + body}}, ensure_ascii=False))
" 2>/dev/null

exit 0
