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
#   CLAUDE_BIN                 (path do binario claude; default = autodetect)
#   BUN_BIN_DIR                (dir do bun; default = ~/.bun/bin)
#   DGCLAW_CLAUDE_CONFIG_DIR   (config dir onde o plugin telegram esta instalado;
#                               vazio = usa o default ~/.claude)
#
# NB: rodar sob systemd exige PTY (use o ExecStart com `script`, ver
# install-service.sh) e, como root, IS_SANDBOX=1 (setado aqui automaticamente).

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

# --- Config dir do claude (causa-raiz de "plugin telegram not installed") ---
# O plugin telegram + o login vivem num config dir especifico. Se o ambiente
# herdou um CLAUDE_CONFIG_DIR custom que NAO tem o plugin, o --channels quebra.
# Regra: usa o dir que o wizard gravou (onde instalou o telegram); senao, o
# default. CLAUDE_CONFIG_DIR=$HOME/.claude NAO e o mesmo que o default
# (faria o claude ler $HOME/.claude/.claude.json interno) — entao a gente
# UNSET pra cair no default de verdade ($HOME/.claude.json + dir $HOME/.claude).
if [ -n "${DGCLAW_CLAUDE_CONFIG_DIR:-}" ]; then
    export CLAUDE_CONFIG_DIR="$DGCLAW_CLAUDE_CONFIG_DIR"
else
    unset CLAUDE_CONFIG_DIR
fi

# Como root, --permission-mode bypassPermissions exige IS_SANDBOX=1
# (senao: "--dangerously-skip-permissions cannot be used with root privileges").
[ "$(id -u)" = "0" ] && export IS_SANDBOX=1

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
