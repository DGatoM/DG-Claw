#!/bin/bash
# install-consolidate-timer.sh — Agenda a consolidacao noturna via systemd timer.
#
# Uso:  sudo bash install-consolidate-timer.sh <config.sh> [HH:MM]
# Default: 04:00. Cria dgclaw-<slug>-consolidate.{service,timer}.

set -euo pipefail

CONFIG="${1:?Uso: install-consolidate-timer.sh <config.sh> [HH:MM]}"
WHEN="${2:-04:00}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"

RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"; [ -n "$RUN_HOME" ] || RUN_HOME="$HOME"

cat > "/etc/systemd/system/dgclaw-${DGCLAW_SLUG}-consolidate.service" <<EOF
[Unit]
Description=DG Claw consolidacao de memoria: ${DGCLAW_SLUG}

[Service]
Type=oneshot
User=${RUN_USER}
Environment=HOME=${RUN_HOME}
WorkingDirectory=${DGCLAW_WORKSPACE}
ExecStart=/bin/bash ${SCRIPT_DIR}/consolidate.sh ${CONFIG}
EOF

cat > "/etc/systemd/system/dgclaw-${DGCLAW_SLUG}-consolidate.timer" <<EOF
[Unit]
Description=DG Claw consolidacao noturna: ${DGCLAW_SLUG} (${WHEN})

[Timer]
OnCalendar=*-*-* ${WHEN}:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "dgclaw-${DGCLAW_SLUG}-consolidate.timer"
echo "Timer de consolidacao agendado pra ${WHEN} todo dia."
echo "Rodar agora (teste):  sudo systemctl start dgclaw-${DGCLAW_SLUG}-consolidate.service"
echo "Ver log:              cat ${DGCLAW_WORKSPACE}/.dgclaw/logs/consolidate.log"
