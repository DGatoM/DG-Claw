#!/bin/bash
# channel-watchdog.sh — Vigia de runtime do canal Telegram do DG Claw.
#
# Licao do incidente de 05/06/2026: o systemd reportava o service `active`, mas o
# poller do Telegram (`bun ... server.ts`) morria por baixo e o bot ficava MUDO por
# horas, sem ninguem perceber. O ExecStartPre (fix needs-auth) so cobre o START; este
# watchdog cobre o RUNTIME: roda a cada 2 min (via timer systemd) e, se o canal caiu
# com o service ainda ativo, reinicia o service e avisa o dono.
#
# Notificacao: usa o notify-owner.sh do DG Alive se existir (manda pelo bot do dono);
# senao cai num fallback inline pela Bot API (token do state-dir + allowFrom[0]).
#
# Uso:  bash channel-watchdog.sh <config.sh>
# Idempotente, sem spam (dedup por transicao), sempre exit 0 (nunca quebra o timer).
set -uo pipefail

CONFIG="${1:?Uso: channel-watchdog.sh <config.sh>}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 0; }
# shellcheck disable=SC1090
source "$CONFIG"
WS="${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
SLUG="${DGCLAW_SLUG:-$(basename "$WS")}"
SERVICE="dgclaw-${SLUG}.service"
STATE_DIR="${TELEGRAM_STATE_DIR:-}"
export TELEGRAM_STATE_DIR
[ -n "${DG_ALIVE_OWNER_TELEGRAM_ID:-}" ] && export DG_ALIVE_OWNER_TELEGRAM_ID

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="$WS/.dgclaw/logs"; mkdir -p "$LOGDIR" 2>/dev/null || true
STATEF="$LOGDIR/channel-watchdog.state"
LOGF="$LOGDIR/channel-watchdog.log"

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $*" >> "$LOGF" 2>/dev/null || true; }

notify() { # avisa o dono; tenta notify-owner.sh do DG Alive, senao Bot API inline
    local msg="$1"
    local NO="$WS/.dg-alive/plugin/scripts/notify-owner.sh"
    if [ -x "$NO" ] || [ -f "$NO" ]; then
        bash "$NO" "$msg" >/dev/null 2>&1 && return 0
    fi
    # fallback inline (mesma logica do notify-owner: token do .env + allowFrom[0]); sem parse_mode
    [ -n "$STATE_DIR" ] || return 0
    local token chat
    token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$STATE_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
    [ -n "$token" ] || return 0
    chat="${DG_ALIVE_OWNER_TELEGRAM_ID:-}"
    if [ -z "$chat" ] && [ -f "$STATE_DIR/access.json" ]; then
        chat=$(python3 -c "import json;d=json.load(open('$STATE_DIR/access.json'));a=d.get('allowFrom',[]);print(a[0] if a else '')" 2>/dev/null)
    fi
    [ -n "$chat" ] || return 0
    curl -sS --max-time 20 "https://api.telegram.org/bot${token}/sendMessage" \
        --data-urlencode "chat_id=${chat}" --data-urlencode "text=${msg}" -o /dev/null 2>/dev/null || true
}

prev=""; [ -f "$STATEF" ] && prev=$(cat "$STATEF" 2>/dev/null)

# 1. canal vivo? (sinal real, nao is-active)
if bash "$SELF_DIR/channel-health.sh" "$CONFIG" >/dev/null 2>&1; then
    if [ "$prev" = "dead" ]; then
        notify "🐕 Watchdog: o canal do Telegram VOLTOU ao normal. As mensagens estao chegando de novo."
        log "recovered"
    fi
    echo alive > "$STATEF"; exit 0
fi

# 2. canal caiu. Se o service nem deveria estar de pe (stop manual), so registra.
active=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
if [ "$active" != "active" ]; then
    log "dead but service=$active (provavel stop manual) — sem acao"
    echo dead > "$STATEF"; exit 0
fi

# 3. falha real: service ativo mas poller morto -> reinicia e confere
log "poller morto com service ativo — reiniciando $SERVICE"
systemctl restart "$SERVICE" 2>/dev/null || true
sleep 12
if bash "$SELF_DIR/channel-health.sh" "$CONFIG" >/dev/null 2>&1; then
    notify "🔧 Watchdog: o canal do Telegram tinha caido (poller morto) — reiniciei automatico e voltou. Se voce mandou msg e nao respondeu, reenvia."
    log "auto_restart_ok"
    echo alive > "$STATEF"
else
    notify "🚨 Watchdog: o canal do Telegram caiu e o restart automatico NAO resolveu. Precisa de olho manual: systemctl restart $SERVICE"
    log "auto_restart_failed"
    echo dead > "$STATEF"
fi
exit 0
