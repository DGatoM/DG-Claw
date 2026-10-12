#!/bin/bash
# channel-health.sh — Confere se o canal Telegram REALMENTE conectou (nao basta is-active).
#
# O servico fica "active" mesmo com o canal morto: o banner Channels aparece, mas o poller
# do telegram (o `bun ... server.ts` do MCP) pode ter morrido por baixo. Foi o caso do
# incidente de 05/06/2026 (bot mudo por horas, systemd dizendo "active"). Este check olha o
# SINAL REAL: o bot.pid do state-dir apontando pra um `bun server.ts` vivo; com fallback no
# log do MCP do telegram ("Successfully connected" recente).
#
# Uso:  bash channel-health.sh <config.sh> [--wait N]
#   --wait N : espera ate N seg pelo sinal de conexao (default 0 = checa uma vez)
# rc 0 = canal conectado; rc 1 = NAO conectado (provavel needs-auth/poller morto).
set -uo pipefail

CONFIG="${1:?Uso: channel-health.sh <config.sh> [--wait N]}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 2; }
WAIT=0; [ "${2:-}" = "--wait" ] && WAIT="${3:-30}"
# shellcheck disable=SC1090
source "$CONFIG"
WS="${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
SLUG="${DGCLAW_SLUG:-$(basename "$WS")}"
STATE_DIR="${TELEGRAM_STATE_DIR:-}"

# projkey do cache do claude = caminho do workspace com / -> - (cwd do servico = WorkingDirectory)
PROJKEY=$(printf '%s' "$WS" | sed 's#/#-#g')
LOGDIR="$HOME/.cache/claude-cli-nodejs/${PROJKEY}/mcp-logs-plugin-telegram-telegram"

pid_is_poller() { # $1=pid -> 0 se for mesmo o `bun ... server.ts` (evita pid reuse)
    local pid="$1"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
    local cmd
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || return 1
    [[ "$cmd" == *server.ts* ]]
}

check_once() {
    # Sinal PRIMARIO: bot.pid do state-dir aponta pra um poller vivo.
    if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/bot.pid" ]; then
        local pid; pid=$(tr -dc '0-9' < "$STATE_DIR/bot.pid" 2>/dev/null)
        pid_is_poller "$pid" && return 0
    fi
    # Sinal SECUNDARIO: existe um `bun server.ts` cujo environ aponta pra ESTE state-dir.
    if [ -n "$STATE_DIR" ]; then
        if grep -slza "TELEGRAM_STATE_DIR=$STATE_DIR" /proc/[0-9]*/environ >/dev/null 2>&1; then
            return 0
        fi
    fi
    # Fallback (logo apos restart, antes do processo estabilizar): log recente com conexao.
    [ -d "$LOGDIR" ] || return 1
    local newest; newest=$(ls -1t "$LOGDIR" 2>/dev/null | head -1)
    [ -n "$newest" ] || return 1
    local f="$LOGDIR/$newest"
    if grep -qi "Successfully connected\|connected to MCP server" "$f" 2>/dev/null; then
        local age=$(( $(date +%s) - $(stat -c %Y "$f" 2>/dev/null || echo 0) ))
        [ "$age" -le 600 ] && return 0
    fi
    return 1
}

deadline=$(( $(date +%s) + WAIT ))
while : ; do
    if check_once; then
        echo "canal OK: poller telegram vivo (slug=$SLUG)"
        exit 0
    fi
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 5
done

echo "canal NAO conectou: poller telegram ausente (slug=$SLUG)" >&2
echo "  causa provavel: cache needs-auth ou o poller (bun server.ts) morreu. Reinicie dgclaw-$SLUG." >&2
exit 1
