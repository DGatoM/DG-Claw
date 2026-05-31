#!/bin/bash
# memory-recall.sh — UserPromptSubmit hook do DG Claw (recall LOCAL, sem API).
#
# Antes do assistente responder, procura nos arquivos de memoria por linhas
# relacionadas a mensagem do dono (busca por palavra-chave, local, instantanea).
# Se achar, injeta "MEMORIA RELACIONADA: ..." via hookSpecificOutput.
#
# FALHA SILENCIOSA em tudo: a conversa precisa continuar mesmo se o hook quebrar.
# Nao usa nenhum servico externo nem chave de API.

set +e

WORKSPACE="${DGCLAW_WORKSPACE:-$PWD}"
SCRIPTS="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/scripts/memory_index"
RECALL="$SCRIPTS/memory_recall_local.py"

[ -f "$RECALL" ] || exit 0

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

RESULT=$(printf '%s' "$USER_TEXT" | python3 -c "import json,sys; print(json.dumps({'input': sys.stdin.read()}))" \
    | DGCLAW_WORKSPACE="$WORKSPACE" timeout 5 python3 "$RECALL" 2>/dev/null)
[ -z "$RESULT" ] && exit 0

printf '%s' "$RESULT" | python3 -c "
import json, sys
try:
    r = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
if not r.get('fired') or not r.get('recall'):
    sys.exit(0)
print(json.dumps({'hookSpecificOutput': {'hookEventName':'UserPromptSubmit','additionalContext': r['recall']}}, ensure_ascii=False))
" 2>/dev/null

exit 0
