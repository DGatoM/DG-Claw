#!/bin/bash
# memory-recall.sh — UserPromptSubmit hook do DG Claw.
#
# Antes do assistente responder, busca a memoria semantica por algo relevante a
# mensagem do dono. Se achar, injeta um "MEMORIA ERRANTE: ..." no contexto via
# hookSpecificOutput.additionalContext.
#
# FALHA SILENCIOSA em tudo: a conversa precisa continuar mesmo se o hook quebrar.
# No-op gracioso quando faltar workspace, GEMINI_API_KEY ou chunks.db.

set +e

# Workspace do assistente (exportado pelo launch.sh; fallback = cwd)
WORKSPACE="${DGCLAW_WORKSPACE:-$PWD}"
SCRIPTS="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/scripts/memory_index"
FAST="$SCRIPTS/memory_search_fast.py"

LOG="$WORKSPACE/.dgclaw/logs/memory-recall.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null

[ -f "$FAST" ] || exit 0
# Sem busca semantica configurada? Sai sem fazer nada.
[ -n "${GEMINI_API_KEY:-}" ] || exit 0
[ -f "$WORKSPACE/memory_index/chunks.db" ] || exit 0

HOOK_INPUT=$(cat)

# Extrai o texto do dono (tira o wrapper <channel ...> do plugin telegram)
USER_TEXT=$(printf '%s' "$HOOK_INPUT" | python3 -c "
import json, sys, re
try:
    d = json.loads(sys.stdin.read())
    p = d.get('prompt','') or ''
    p = re.sub(r'<channel[^>]*>','',p)
    p = re.sub(r'</channel>','',p)
    print(p.strip())
except Exception:
    pass
")
[ -z "$USER_TEXT" ] && exit 0

RESULT=$(printf '%s' "$USER_TEXT" | python3 -c "import json,sys; print(json.dumps({'input': sys.stdin.read()}))" \
    | DGCLAW_WORKSPACE="$WORKSPACE" timeout 6 python3 "$FAST" 2>>"$LOG")
[ -z "$RESULT" ] && exit 0

printf '%s' "$RESULT" | python3 -c "
import json, sys
try:
    r = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
if not r.get('fired') or not r.get('recall'):
    sys.exit(0)
out = {
  'hookSpecificOutput': {
    'hookEventName': 'UserPromptSubmit',
    'additionalContext': r['recall']
  }
}
print(json.dumps(out, ensure_ascii=False))
" 2>>"$LOG"

exit 0
