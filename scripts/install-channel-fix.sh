#!/bin/bash
# install-channel-fix.sh — Instala o mitigador do bug "canal telegram mudo no 2o start".
#
# Coloca um drop-in systemd com ExecStartPre no servico do DG Claw (dgclaw-<slug>.service)
# que limpa a chave needs-auth do telegram antes de cada start. NAO edita a unit do DG Claw
# (drop-in e arquivo separado em .service.d/). Idempotente.
#
# Uso:  sudo bash install-channel-fix.sh <.dgclaw/config.sh>
#       sudo bash install-channel-fix.sh <.dgclaw/config.sh> --off   (remove)

set -uo pipefail

CONFIG="${1:?Uso: install-channel-fix.sh <.dgclaw/config.sh> [--off]}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
OFF=0; [ "${2:-}" = "--off" ] && OFF=1
set +u; # shellcheck disable=SC1090
source "$CONFIG"; set -u
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
SLUG="$DGCLAW_SLUG"; WS="$DGCLAW_WORKSPACE"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$WS/.dgclaw/plugin}"

DROPDIR="/etc/systemd/system/dgclaw-${SLUG}.service.d"
DROPIN="$DROPDIR/10-dgclaw-tg-authcache.conf"
PRESTART="$WS/.dgclaw/prestart-clear-tg-authcache.sh"

if [ "$OFF" = "1" ]; then
    rm -f "$DROPIN" "$PRESTART"
    rmdir --ignore-fail-on-non-empty "$DROPDIR" 2>/dev/null || true
    systemctl daemon-reload 2>/dev/null || true
    echo "channel-fix removido (drop-in + prestart)."
    exit 0
fi

# Resolve o config dir que o servico realmente usa (igual ao launch.sh do DG Claw):
# DGCLAW_CLAUDE_CONFIG_DIR custom, senao o default /root/.claude (o servico faz unset).
CFGDIR="${DGCLAW_CLAUDE_CONFIG_DIR:-/root/.claude}"

# 1. copia estavel do prestart no workspace do agente
cp "$PLUGIN/scripts/prestart-clear-tg-authcache.sh" "$PRESTART"
chmod +x "$PRESTART"

# 2. drop-in (prefixo `-` no ExecStartPre = ignora erro, nunca bloqueia o boot)
mkdir -p "$DROPDIR"
cat > "$DROPIN" <<EOF
# Mitiga regressao do Claude Code: limpa a chave needs-auth do canal telegram
# antes de cada start (senao o bot fica mudo a partir do 2o start). Instalado pelo DG Claw.
[Service]
ExecStartPre=-/bin/bash ${PRESTART} ${CFGDIR}
EOF

systemctl daemon-reload
echo "channel-fix instalado: $DROPIN"
echo "  (limpa plugin:telegram:telegram de ${CFGDIR}/mcp-needs-auth-cache.json a cada start)"
echo "  AVISO: a chave e GLOBAL do plugin telegram — se houver OUTROS agentes de canal"
echo "  telegram nesta maquina na mesma config dir, eles tambem precisam"
echo "  do mesmo ExecStartPre pra nao ficarem mudos no proximo restart deles."
