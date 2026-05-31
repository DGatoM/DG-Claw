#!/bin/bash
# memory-recall.sh — UserPromptSubmit hook do DG Claw. Faz 3 coisas (tudo local):
#   1. RECALL: procura nos arquivos de memoria linhas relacionadas a mensagem.
#   2. CHAT-TAIL: registra a mensagem do dono no fio (pro re-contexto pos-compact).
#   3. AVISO DE TAMANHO: conta as trocas; se a conversa ficou longa, sugere a
#      compactacao (a agente avisa o dono e o contexto e preservado no pos-compact).
#
# Tudo local, sem API externa. Falha silenciosa (a conversa precisa continuar).

set +e
WORKSPACE="${DGCLAW_WORKSPACE:-$PWD}"
SCRIPTS="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/scripts/memory_index"
RECALL="$SCRIPTS/memory_recall_local.py"
TAIL="$WORKSPACE/.dgclaw/chat-tail.md"
CNT="$WORKSPACE/.dgclaw/turns.count"
COMPACT_AT=40   # avisa a partir de ~40 trocas desde a ultima compactacao
mkdir -p "$(dirname "$TAIL")" 2>/dev/null

HOOK_INPUT=$(cat)

USER_TEXT=$(printf '%s' "$HOOK_INPUT" | python3 -c "
import json, sys, re
try:
    d = json.loads(sys.stdin.read())
    p = d.get('prompt','') or ''
    p = re.sub(r'<channel[^>]*>','',p); p = re.sub(r'</channel>','',p)
    print(p.strip())
except Exception:
    pass
")
[ -z "$USER_TEXT" ] && exit 0

# --- chat-tail: registra a fala do dono ---
{ printf 'Dono: %s\n' "$(printf '%s' "$USER_TEXT" | tr '\n' ' ' | cut -c1-500)" >> "$TAIL"
  L=$(wc -l < "$TAIL" 2>/dev/null); [ "${L:-0}" -gt 80 ] && tail -n 80 "$TAIL" > "$TAIL.tmp" && mv "$TAIL.tmp" "$TAIL"
} 2>/dev/null

# --- contador de trocas + aviso de compactacao ---
N=$(cat "$CNT" 2>/dev/null); N=$((${N:-0}+1)); echo "$N" > "$CNT" 2>/dev/null
COMPACT_NOTE=""
if [ "$N" -ge "$COMPACT_AT" ] && [ $(( N % 10 )) -eq 0 ]; then
    COMPACT_NOTE="A conversa ja esta longa ($N mensagens). Logo o sistema vai resumir o contexto automaticamente — voce NAO vai perder o fio (ele e re-injetado). Pode avisar o dono, em tom leve, que voce esta organizando a memoria pra manter a conversa fluida."
fi

# --- recall local ---
RECALL_TEXT=$(printf '%s' "$USER_TEXT" | python3 -c "import json,sys; print(json.dumps({'input': sys.stdin.read()}))" \
    | DGCLAW_WORKSPACE="$WORKSPACE" timeout 5 python3 "$RECALL" 2>/dev/null \
    | python3 -c "import json,sys
try: r=json.loads(sys.stdin.read())
except Exception: sys.exit(0)
print(r.get('recall') or '')" 2>/dev/null)

CTX=""
[ -n "$RECALL_TEXT" ] && CTX="$RECALL_TEXT"
[ -n "$COMPACT_NOTE" ] && CTX="${CTX:+$CTX

}$COMPACT_NOTE"
[ -z "$CTX" ] && exit 0

CTX="$CTX" python3 -c "
import json, os
print(json.dumps({'hookSpecificOutput': {'hookEventName':'UserPromptSubmit','additionalContext': os.environ['CTX']}}, ensure_ascii=False))
" 2>/dev/null
exit 0
