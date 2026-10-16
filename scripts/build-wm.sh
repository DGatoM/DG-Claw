#!/bin/bash
# build-wm.sh — wrapper do build-working-memory.py pros timers systemd.
# Sourcia a config (exporta DGCLAW_*) e roda o rebuild da working-memory.
#
# Uso:  bash build-wm.sh <.dgclaw/config.sh> [--agora-only]

set -uo pipefail
CONFIG="${1:?Uso: build-wm.sh <config.sh> [--agora-only]}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
export DGCLAW_WORKSPACE DGCLAW_OWNER DGCLAW_NAME DGCLAW_TZ
export DGCLAW_PERSONA_DIR="${DGCLAW_PERSONA_DIR:-$DGCLAW_WORKSPACE/persona}"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$DGCLAW_WORKSPACE/.dgclaw/plugin}"

# Pulso: registra ok/erro deste cron no ledger (componente "build-wm").
# shellcheck disable=SC1091
source "$PLUGIN/scripts/_lib/pulso-lib.sh" 2>/dev/null && pulso_auto build-wm

python3 "$PLUGIN/scripts/build-working-memory.py" "${2:-}"
RC=$?

WS_OWNER=$(stat -c '%U' "$DGCLAW_WORKSPACE" 2>/dev/null || echo root)
if [ "$WS_OWNER" != "root" ]; then
    for f in working-memory.md memory/wm-transbordo.md; do
        [ -f "$DGCLAW_WORKSPACE/$f" ] || continue
        chown "$WS_OWNER" "$DGCLAW_WORKSPACE/$f" \
            || echo "build-wm: nao consegui passar $f para o usuario $WS_OWNER (o agente pode nao conseguir editar)" >&2
    done
fi

# Depois do build completo, atualiza tambem o indice da busca em conversas. E a rede de
# seguranca de quem ainda nao tem o timer conversas-fts (agentes instalados antes de
# 01/10/2026): pelo menos uma vez por dia o indice anda. Falha aqui nao muda o resultado
# do build (a working-memory ja foi escrita), mas fica registrada no conversas-fts.log.
if [ "${2:-}" != "--agora-only" ] && [ -f "$PLUGIN/scripts/conversas-fts.sh" ]; then
    bash "$PLUGIN/scripts/conversas-fts.sh" "$CONFIG" \
        || echo "build-wm: o reindex da busca em conversas falhou; ver $DGCLAW_WORKSPACE/.dgclaw/logs/conversas-fts.log" >&2
fi

# Rede de seguranca da memoria: se a reflexao da noite consolidou o MEMORY.md na sessao viva
# e ninguem conferiu (a persona esqueceu o recibo), confere agora. So no build completo.
# Idempotente: se o poke-ack ja conferiu, esta chamada nao faz nada.
if [ "${2:-}" != "--agora-only" ] && [ -f "$PLUGIN/scripts/_lib/memoria_guarda.py" ]; then
    REFLOG="$DGCLAW_WORKSPACE/.dgclaw/logs/reflection.log"
    mkdir -p "$(dirname "$REFLOG")" 2>/dev/null
    python3 "$PLUGIN/scripts/_lib/memoria_guarda.py" conferir --ws "$DGCLAW_WORKSPACE" >> "$REFLOG" 2>&1 \
        || echo "[$(date '+%F %T')] build-wm: a conferencia do MEMORY.md saiu com codigo diferente de 0 (3 = restaurou a versao anterior; outro = nao consegui conferir). Detalhes nas linhas acima." >> "$REFLOG"
fi
exit "$RC"
