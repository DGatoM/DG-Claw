#!/bin/bash
# channel-watchdog.sh — Vigia de runtime do canal Telegram do DG Claw.
#
# Licao do incidente de 05/06/2026: o systemd reportava o service `active`, mas o
# poller do Telegram (`bun ... server.ts`) morria por baixo e o bot ficava MUDO por
# horas, sem ninguem perceber. O ExecStartPre (fix needs-auth) so cobre o START; este
# watchdog cobre o RUNTIME: roda a cada 2 min (via timer systemd) e, se o canal caiu
# com o service ainda ativo, reinicia o service e avisa o dono.
#
# Notificacao: usa o notify-owner.sh do DG Claw se existir (manda pelo bot do dono);
# senao cai num fallback inline pela Bot API (token do state-dir + allowFrom[0]).
#
# Uso:  bash channel-watchdog.sh <config.sh>
# Idempotente, sempre exit 0 (nunca quebra o timer). Sem spam: o aviso de falha sai na
# primeira rodada morta e depois so de DGCLAW_CHANNEL_WATCHDOG_LEMBRETE_H em
# DGCLAW_CHANNEL_WATCHDOG_LEMBRETE_H horas (padrao 6); e depois de 3 restarts que nao
# resolveram, o proximo so sai 30 min depois do ultimo, em vez de a cada 2 min.
#
# Estado em logs/channel-watchdog.state, uma linha:
#   alive | dead <restarts_seguidos> <epoch_ultimo_restart> <epoch_ultimo_aviso> | sem-telegram
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
[ -n "${DGCLAW_OWNER_TELEGRAM_ID:-}" ] && export DGCLAW_OWNER_TELEGRAM_ID

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="$WS/.dgclaw/logs"; mkdir -p "$LOGDIR" 2>/dev/null || true
STATEF="$LOGDIR/channel-watchdog.state"
LOGF="$LOGDIR/channel-watchdog.log"

LEMBRETE_S=$(( ${DGCLAW_CHANNEL_WATCHDOG_LEMBRETE_H:-6} * 3600 ))
RESTART_PAUSA_S=1800
NOW=$(date +%s)

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $*" >> "$LOGF" 2>/dev/null || true; }

notify() { # avisa o dono; tenta notify-owner.sh do DG Claw, senao Bot API inline
    local msg="$1"
    local NO="$WS/.dgclaw/plugin/scripts/notify-owner.sh"
    if [ -x "$NO" ] || [ -f "$NO" ]; then
        bash "$NO" "$msg" >/dev/null 2>&1 && return 0
    fi
    # fallback inline (mesma logica do notify-owner: token do .env + allowFrom[0]); sem parse_mode
    [ -n "$STATE_DIR" ] || return 0
    local token chat
    token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$STATE_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
    [ -n "$token" ] || return 0
    if [[ ! "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
        log "aviso ao dono nao enviado: o TELEGRAM_BOT_TOKEN de $STATE_DIR/.env nao tem o formato <numero>:<letras>"
        return 0
    fi
    chat="${DGCLAW_OWNER_TELEGRAM_ID:-}"
    if [ -z "$chat" ] && [ -f "$STATE_DIR/access.json" ]; then
        chat=$(ACCESS="$STATE_DIR/access.json" python3 -c "import json,os;d=json.load(open(os.environ['ACCESS']));a=d.get('allowFrom',[]);print(a[0] if a else '')" 2>/dev/null)
    fi
    [ -n "$chat" ] || return 0
    # URL com o token pelo stdin (-K -), fora do argv que o `ps` mostra (achado S08)
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" | curl -sS --max-time 20 -K - \
        --data-urlencode "chat_id=${chat}" --data-urlencode "text=${msg}" -o /dev/null 2>/dev/null || true
}

prev=""; [ -f "$STATEF" ] && prev=$(head -1 "$STATEF" 2>/dev/null)

# 0. Sem Telegram nao ha poller para vigiar: o channel-health falharia sempre e este script
# reiniciaria o agente a cada 2 min, para sempre (Lara 02/10 e Luna 05/10/2026, 45 avisos).
# O instalador ja nao instala o timer nesse caso; isto e a segunda trava, para timer que
# tenha ficado de uma instalacao antiga. O log registra uma vez so.
if [ -z "$STATE_DIR" ]; then
    if [ "$prev" != "sem-telegram" ]; then
        log "sem canal telegram (config sem TELEGRAM_STATE_DIR): nada a vigiar, sem acao. Para tirar este timer: bash $SELF_DIR/install-channel-watchdog.sh $CONFIG --off"
        echo sem-telegram > "$STATEF"
    fi
    exit 0
fi

# Contadores da falha em curso (so existem quando o estado anterior e dead)
FALHAS=0; ULT_RESTART=0; ULT_AVISO=0
if [ "${prev%% *}" = "dead" ]; then
    read -r _ FALHAS ULT_RESTART ULT_AVISO <<< "$prev"
    FALHAS=${FALHAS:-0}; ULT_RESTART=${ULT_RESTART:-0}; ULT_AVISO=${ULT_AVISO:-0}
fi

# 1. canal vivo? (sinal real, nao is-active)
if bash "$SELF_DIR/channel-health.sh" "$CONFIG" >/dev/null 2>&1; then
    if [ "${prev%% *}" = "dead" ]; then
        notify "🐕 Watchdog: o canal do Telegram VOLTOU ao normal. As mensagens estao chegando de novo."
        log "recovered"
    fi
    echo alive > "$STATEF"; exit 0
fi

# 2. canal caiu. Se o service nem deveria estar de pe (stop manual), so registra.
active=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
if [ "$active" != "active" ]; then
    log "dead but service=$active (provavel stop manual) — sem acao"
    echo "dead $FALHAS $ULT_RESTART $ULT_AVISO" > "$STATEF"; exit 0
fi

# 3. falha real: service ativo mas poller morto -> reinicia e confere.
# Depois de 3 restarts seguidos sem resolver, reiniciar a cada 2 min so derruba a sessao viva
# sem consertar nada: o proximo espera 30 min desde o ultimo.
if [ "$FALHAS" -ge 3 ] && [ $(( NOW - ULT_RESTART )) -lt "$RESTART_PAUSA_S" ]; then
    log "poller segue morto; $FALHAS restarts seguidos nao resolveram, o proximo sai 30 min depois do ultimo"
    exit 0
fi
log "poller morto com service ativo — reiniciando $SERVICE"
systemctl restart "$SERVICE" 2>/dev/null || true
sleep 12
if bash "$SELF_DIR/channel-health.sh" "$CONFIG" >/dev/null 2>&1; then
    notify "🔧 Watchdog: o canal do Telegram tinha caido (poller morto) — reiniciei automatico e voltou. Se voce mandou msg e nao respondeu, reenvia."
    log "auto_restart_ok"
    echo alive > "$STATEF"
else
    FALHAS=$(( FALHAS + 1 ))
    # Avisa na primeira falha e depois so como lembrete, nunca a cada rodada.
    if [ "$ULT_AVISO" -eq 0 ] || [ $(( NOW - ULT_AVISO )) -ge "$LEMBRETE_S" ]; then
        if [ "$ULT_AVISO" -eq 0 ]; then
            notify "🚨 Watchdog: o canal do Telegram caiu e o restart automatico NAO resolveu. Precisa de olho manual: systemctl restart $SERVICE"
        else
            notify "🚨 Watchdog (lembrete): o canal do Telegram continua caido, ja foram $FALHAS restarts sem resolver. Precisa de olho manual: systemctl restart $SERVICE"
        fi
        ULT_AVISO=$NOW
        log "auto_restart_failed ($FALHAS seguidos, dono avisado)"
    else
        log "auto_restart_failed ($FALHAS seguidos, aviso ja dado; o proximo lembrete sai em ate ${DGCLAW_CHANNEL_WATCHDOG_LEMBRETE_H:-6} h)"
    fi
    echo "dead $FALHAS $NOW $ULT_AVISO" > "$STATEF"
fi
exit 0
