#!/bin/bash
# launch.sh — Sobe a sessao Channels longeva do assistente DG Claw.
#
# Chamado pelo servico systemd dgclaw-<slug>.service. Le a config do assistente
# em <workspace>/.dgclaw/config.sh, monta a identidade e da exec no
# `claude --channels` conectado ao bot do Telegram.
#
# A config (gerada pelo wizard /dgclaw:setup) deve exportar pelo menos:
#   DGCLAW_NAME, DGCLAW_SLUG, DGCLAW_WORKSPACE, TELEGRAM_STATE_DIR
# E opcionalmente:
#   GEMINI_API_KEY      (liga a busca semantica de memoria)
#   CLAUDE_BIN          (path do binario claude; default = autodetect)
#   BUN_BIN_DIR         (dir do bun; default = ~/.bun/bin)

set -uo pipefail

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
    echo "launch.sh: config nao encontrada (passe o path de config.sh)" >&2
    exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG"

: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
: "${TELEGRAM_STATE_DIR:?config sem TELEGRAM_STATE_DIR}"

export DGCLAW_WORKSPACE TELEGRAM_STATE_DIR
[ -n "${GEMINI_API_KEY:-}" ] && export GEMINI_API_KEY

# Bun no PATH (o MCP server do plugin telegram roda em Bun)
BUN_BIN_DIR="${BUN_BIN_DIR:-$HOME/.bun/bin}"
export PATH="$BUN_BIN_DIR:$HOME/.local/bin:$PATH"

# Binario do claude
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DGCLAW_WORKSPACE" || exit 1

# Monta identidade (AGENT.md + regras de canal) num arquivo temporario
# shellcheck disable=SC1091
source "$SCRIPT_DIR/bootstrap-identity.sh" "$DGCLAW_WORKSPACE"

# Mantem o identity file vivo ate o claude sair
trap - EXIT
trap "rm -f '$IDENTITY_FILE'" EXIT TERM INT

exec "$CLAUDE_BIN" \
    --channels plugin:telegram@claude-plugins-official \
    --append-system-prompt-file "$IDENTITY_FILE" \
    --permission-mode bypassPermissions \
    --name "dgclaw-$DGCLAW_SLUG"
