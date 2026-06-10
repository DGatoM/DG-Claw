#!/bin/bash
# install-channel-watchdog.sh — Instala o watchdog de runtime do canal Telegram.
#
# Cria um par systemd .service(oneshot)+.timer (dgclaw-<slug>-channel-watchdog) que roda
# a cada 2 min e, se o canal caiu com o service ainda ativo, reinicia e avisa o dono.
# Cobre o RUNTIME (o ExecStartPre/needs-auth so cobre o START).
#
# Copia channel-watchdog.sh + channel-health.sh pra <workspace>/.dgclaw/ (copia estavel,
# pra sobreviver a reinstalacao/limpeza do plugin) e aponta a unit pra la.
#
# Uso:  sudo bash install-channel-watchdog.sh <config.sh>
#       sudo bash install-channel-watchdog.sh <config.sh> --off   (remove)
set -uo pipefail

CONFIG="${1:?Uso: install-channel-watchdog.sh <config.sh> [--off]}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
OFF=0; [ "${2:-}" = "--off" ] && OFF=1
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
SLUG="$DGCLAW_SLUG"; WS="$DGCLAW_WORKSPACE"
UNIT="dgclaw-${SLUG}-channel-watchdog"

if [ "$OFF" = "1" ]; then
    systemctl disable --now "${UNIT}.timer" 2>/dev/null || true
    rm -f "/etc/systemd/system/${UNIT}.service" "/etc/systemd/system/${UNIT}.timer"
    systemctl daemon-reload 2>/dev/null || true
    echo "watchdog do canal removido ($UNIT)."
    exit 0
fi

# copia estavel dos scripts no workspace (sobrevive a reinstall do plugin)
STABLE="$WS/.dgclaw"
mkdir -p "$STABLE"
cp "$SELF_DIR/channel-watchdog.sh" "$STABLE/channel-watchdog.sh"
cp "$SELF_DIR/channel-health.sh"   "$STABLE/channel-health.sh"
chmod +x "$STABLE/channel-watchdog.sh" "$STABLE/channel-health.sh"
WD="$STABLE/channel-watchdog.sh"

cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=DG Claw watchdog do canal Telegram: ${SLUG}
After=dgclaw-${SLUG}.service

[Service]
Type=oneshot
User=root
Environment=HOME=/root
# o script da source no config.sh (que exporta TELEGRAM_STATE_DIR etc).
ExecStart=/bin/bash ${WD} ${CONFIG}
EOF

cat > "/etc/systemd/system/${UNIT}.timer" <<EOF
[Unit]
Description=DG Claw watchdog do canal Telegram (timer): ${SLUG}

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=20s
Unit=${UNIT}.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "${UNIT}.timer"
echo "watchdog do canal instalado: ${UNIT}.timer (a cada 2 min)"
echo "  checa o poller real (channel-health) e reinicia dgclaw-${SLUG} se cair + avisa o dono."
echo "  logs: $STABLE/logs/channel-watchdog.log   |   desligar: install-channel-watchdog.sh \"$CONFIG\" --off"
