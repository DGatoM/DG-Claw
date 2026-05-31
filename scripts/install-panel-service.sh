#!/bin/bash
# install-panel-service.sh — Sobe o mini painel de memoria como servico systemd.
#
# Uso:  sudo bash install-panel-service.sh <config.sh> [PORTA]
# Default porta 8200. Gera um token de acesso e mostra a URL no fim.

set -euo pipefail

CONFIG="${1:?Uso: install-panel-service.sh <config.sh> [PORTA]}"
PORT="${2:-8200}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"

RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"; [ -n "$RUN_HOME" ] || RUN_HOME="$HOME"

# token de acesso (reusa se ja existir no config)
TOKEN="${DGCLAW_PANEL_TOKEN:-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
grep -q DGCLAW_PANEL_TOKEN "$CONFIG" || echo "export DGCLAW_PANEL_TOKEN=\"$TOKEN\"" >> "$CONFIG"

cat > "/etc/systemd/system/dgclaw-${DGCLAW_SLUG}-panel.service" <<EOF
[Unit]
Description=DG Claw painel de memoria: ${DGCLAW_SLUG}
After=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Environment=HOME=${RUN_HOME}
Environment=DGCLAW_WORKSPACE=${DGCLAW_WORKSPACE}
Environment=DGCLAW_NAME=${DGCLAW_NAME:-DG Claw}
Environment=DGCLAW_PANEL_PORT=${PORT}
Environment=DGCLAW_PANEL_TOKEN=${TOKEN}
ExecStart=/usr/bin/python3 ${SCRIPT_DIR}/panel.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "dgclaw-${DGCLAW_SLUG}-panel.service"

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Painel no ar."
echo "Abra no navegador:  http://${IP:-SEU_IP}:${PORT}/?t=${TOKEN}"
echo "(o token protege o acesso — guarde a URL)"
