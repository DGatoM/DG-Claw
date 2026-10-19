#!/bin/bash
# prestart-clear-tg-authcache.sh — Remove a chave global do canal telegram do cache
# needs-auth do Claude Code, ANTES de cada start do servico do DG Claw.
#
# Por que: regressao do Claude Code (~v2.1.16x). O Claude carimba
# `plugin:telegram:telegram` em <config>/mcp-needs-auth-cache.json ~20s apos cada
# conexao (e tambem se uma conexao falha, ex.: 409 Conflict). Com a chave presente
# no startup, o canal e PULADO em silencio (bot mudo, "1 setup issue: MCP", sem 👀).
# Em headless (systemd) nao ha re-auth interativo -> o canal nao volta sozinho.
#
# Roda como ExecStartPre (com prefixo `-` na unit, pra NUNCA bloquear o start).
# Idempotente, inofensivo (so essa chave; o cache e regeneravel), sempre exit 0.
#
# Uso:  bash prestart-clear-tg-authcache.sh [<config_dir>]
#       config_dir default = ${CLAUDE_CONFIG_DIR:-$HOME/.claude}
set -uo pipefail

CFGDIR="${1:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
CACHE="$CFGDIR/mcp-needs-auth-cache.json"
[ -f "$CACHE" ] || exit 0

# Cache ilegivel ou invalido e esperado (o Claude o regenera): o python sai em silencio nesse caso.
# Qualquer outra falha (ex.: sem permissao para gravar) aparece no journal da unit.
python3 - "$CACHE" <<'PY' || echo "prestart-clear-tg-authcache: nao consegui limpar a chave do telegram em $CACHE; o canal pode ficar mudo. Apague a chave plugin:telegram:telegram desse arquivo e reinicie o servico." >&2
import json, sys
f = sys.argv[1]
try:
    d = json.load(open(f))
except Exception:
    sys.exit(0)
if isinstance(d, dict) and d.pop("plugin:telegram:telegram", None) is not None:
    json.dump(d, open(f, "w"))
PY
exit 0
