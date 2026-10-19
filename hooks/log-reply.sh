#!/bin/bash
# log-reply.sh — PostToolUse hook: registra as respostas que a agente mandou no
# Telegram, pra alimentar o chat-tail.md (usado pelo session-context no pos-compact).
#
# Casa com a tool de reply do plugin telegram. Nunca bloqueia a resposta: se algo falhar,
# avisa em stderr (o stdout de hook pode virar contexto do agente) e sai com 0.

set +e
WORKSPACE="${DGCLAW_WORKSPACE:-$PWD}"
TAIL="$WORKSPACE/.dgclaw/chat-tail.md"
mkdir -p "$(dirname "$TAIL")" || echo "log-reply: nao consegui criar a pasta de $TAIL. As respostas do bot nao entram no chat-tail.md; confira permissao e espaco em disco." >&2

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
except Exception as e:
    sys.stderr.write('log-reply: nao consegui gravar em ' + TAIL + ' (' + type(e).__name__ + '). As respostas do bot nao entram no chat-tail.md; confira permissao e espaco em disco.' + chr(10))
"
exit 0
