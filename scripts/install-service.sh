#!/bin/bash
# install-service.sh — Cria e sobe o servico systemd do assistente DG Claw.
#
# Uso:  sudo bash install-service.sh <config.sh> [<launch.sh>]
#
# Le DGCLAW_SLUG / DGCLAW_NAME da config, escreve a unit em
# /etc/systemd/system/dgclaw-<slug>.service e da enable --now.
# A unit roda como o usuario que invocou o sudo (nao como root puro), pra que
# ~/.claude, ~/.bun e os connectors fiquem no HOME certo.

set -euo pipefail

CONFIG="${1:?Uso: install-service.sh <config.sh> [launch.sh]}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="${2:-$SCRIPT_DIR/launch.sh}"
[ -f "$LAUNCH" ] || { echo "launch.sh nao encontrado: $LAUNCH" >&2; exit 1; }

# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
: "${DGCLAW_NAME:?config sem DGCLAW_NAME}"

# Usuario/HOME alvo: quem chamou sudo, ou o usuario atual
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || RUN_HOME="$HOME"

UNIT="/etc/systemd/system/dgclaw-${DGCLAW_SLUG}.service"

cat > "$UNIT" <<EOF
[Unit]
Description=DG Claw assistente: ${DGCLAW_NAME} (${DGCLAW_SLUG})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Environment=HOME=${RUN_HOME}
WorkingDirectory=${DGCLAW_WORKSPACE}
ExecStart=/bin/bash ${LAUNCH} ${CONFIG}
Restart=always
RestartSec=5
# Da pra ver as toras com: journalctl -u dgclaw-${DGCLAW_SLUG} -f

[Install]
WantedBy=multi-user.target
EOF

echo "Unit escrita em $UNIT"
systemctl daemon-reload
systemctl enable --now "dgclaw-${DGCLAW_SLUG}.service"
echo "Servico dgclaw-${DGCLAW_SLUG} iniciado."
echo "Status:  systemctl status dgclaw-${DGCLAW_SLUG}"
echo "Logs:    journalctl -u dgclaw-${DGCLAW_SLUG} -f"
