#!/bin/bash
# log-reply.sh — PostToolUse hook: registra as respostas que a agente mandou no
# Telegram, pra alimentar o chat-tail.md (usado pelo session-context no pos-compact).
#
# Casa com a tool de reply do plugin telegram. Falha silenciosa.

set +e
WORKSPACE="${DGCLAW_WORKSPACE:-$PWD}"
TAIL="$WORKSPACE/.dgclaw/chat-tail.md"
mkdir -p "$(dirname "$TAIL")" 2>/dev/null

HOOK_INPUT=$(cat)

printf '%s' "$HOOK_INPUT" | python3 -c "
import json, sys, os
TAIL = os.environ.get('TAIL') or '$TAIL'
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
name = (d.get('tool_name') or '')
if 'telegram' not in name.lower() or 'reply' not in name.lower():
    sys.exit(0)
inp = d.get('tool_input') or {}
text = inp.get('text') or inp.get('message') or ''
text = ' '.join(str(text).split())
if not text:
    sys.exit(0)
line = 'Voce (bot): ' + text[:500]
try:
    with open(TAIL, 'a') as f:
        f.write(line + chr(10))
    # mantem so as ultimas 80 linhas
    lines = open(TAIL).read().splitlines()
    if len(lines) > 80:
        open(TAIL, 'w').write(chr(10).join(lines[-80:]) + chr(10))
except Exception:
    pass
" 2>/dev/null
exit 0
