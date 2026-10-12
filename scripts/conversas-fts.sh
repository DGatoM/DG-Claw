#!/bin/bash
# conversas-fts.sh — mantem em dia o indice da busca em conversas antigas.
#
# Roda pelo timer dgclaw-<slug>-conversas-fts (a cada 15 min) e tambem no fim do build-wm
# das 7h (assim agente que ainda nao ganhou o timer novo tem o indice atualizado pelo menos
# uma vez por dia). O reindex e incremental: sem conversa nova, leva milissegundos.
#
# Python puro, sem Claude, sem chave, sem rede. Detalhes: memory_index/conversas_fts.py.
#
# Uso:  bash conversas-fts.sh <.dgclaw/config.sh>

set -uo pipefail
CONFIG="${1:?Uso: conversas-fts.sh <.dgclaw/config.sh>}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
set +u
# shellcheck disable=SC1090
source "$CONFIG"
set -u
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
export DGCLAW_WORKSPACE DGCLAW_OWNER DGCLAW_NAME DGCLAW_TZ
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$DGCLAW_WORKSPACE/.dgclaw/plugin}"
LOG="$DGCLAW_WORKSPACE/.dgclaw/logs/conversas-fts.log"
mkdir -p "$(dirname "$LOG")"

# Pulso: registra ok/erro deste cron no ledger (componente "conversas-fts"). Sem a lib, o
# reindex roda igual e o aviso fica no log (o pulso nao vai mostrar esta rotina).
# shellcheck disable=SC1091
if ! source "$PLUGIN/scripts/_lib/pulso-lib.sh" 2>>"$LOG"; then
    echo "[$(date '+%F %T')] aviso: sem $PLUGIN/scripts/_lib/pulso-lib.sh, o pulso nao registra esta rodada" >> "$LOG"
else
    pulso_auto conversas-fts
fi

python3 "$PLUGIN/scripts/memory_index/conversas_fts.py" --workspace "$DGCLAW_WORKSPACE" reindex --quieto >> "$LOG" 2>&1
RC=$?
case "$RC" in
    0) ;;
    3) echo "[$(date '+%F %T')] busca em conversas DESLIGADA: este python3 nao tem FTS5 (ver a linha acima). O recall cai na busca simples por palavra." >> "$LOG" ;;
    *) echo "[$(date '+%F %T')] reindex da busca em conversas falhou (codigo $RC); detalhe nas linhas acima" >> "$LOG" ;;
esac

# O indice e do agente: se o workspace tem dono proprio, o arquivo tambem (o timer roda
# como root no modo classico, e um banco do root o agente nao conseguiria atualizar).
WS_OWNER=$(stat -c '%U' "$DGCLAW_WORKSPACE" 2>/dev/null || echo root)
DB="$DGCLAW_WORKSPACE/.dgclaw/memory_index/conversas.db"
if [ "$WS_OWNER" != "root" ] && [ "$(id -u)" = "0" ] && [ -f "$DB" ]; then
    chown "$WS_OWNER" "$DB" "$DB-wal" "$DB-shm" 2>/dev/null
    chown "$WS_OWNER" "$DB" || echo "[$(date '+%F %T')] nao consegui passar $DB para o usuario $WS_OWNER" >> "$LOG"
fi
exit "$RC"
