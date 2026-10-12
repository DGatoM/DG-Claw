#!/bin/bash
# cron-audit.sh (DG Claw) — auditoria noturna (23:55) dos crons/timers da pessoa virtual.
#
# Generalizacao da isa-cron-audit do ClaudeClaw. NADA e hardcoded com nomes de um agente
# especifico: a LISTA de componentes a monitorar e DESCOBERTA dinamicamente de tres fontes:
#   1. timers systemd  dgclaw-<slug>-*.timer   (vida: reflection/audit/build-wm/heartbeat/
#                                                  pulso-report/cron-audit + ondas de poderes)
#   2. powers.json     poderes enabled com cron_timers[]  (os timers que cada poder declara)
#   3. servico de canal  dgclaw-<slug>.service     (a sessao --channels viva que serve o bot)
#
# Pra cada componente checa:
#   - timer: a unit existe? esta enabled? esta active? ultima ativacao foi quando? proxima OK?
#   - service: esta active? (a sessao viva precisa estar no ar pros pokes injetados rodarem)
#   - powers: cada cron_timer declarado por um poder enabled tem a .timer instalada?
#
# Anomalias sao escritas em <ws>/.dgclaw/logs/cron-anomalies-latest.md (consumido por
# heartbeat/DM pra levar ao dono) e logadas em <ws>/.dgclaw/logs/cron-audit.log. Se ZERO
# anomalias, o arquivo -latest.md e removido. NUNCA edita a working-memory daqui (corrida com
# outros crons). exit 0 sempre (auditoria so reporta). Registra no Pulso (ok/erro).
#
# Uso:  bash cron-audit.sh <.dgclaw/config.sh>
# Roda pelo timer dgclaw-<slug>-cron-audit.timer (23:55).

set -uo pipefail

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"

WS="$DGCLAW_WORKSPACE"
SLUG="$DGCLAW_SLUG"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$WS/.dgclaw/plugin}"
LOG_DIR="$WS/.dgclaw/logs"
AUDIT_LOG="$LOG_DIR/cron-audit.log"
ANOMALY_FILE="$LOG_DIR/cron-anomalies-latest.md"
POWERS_FILE="$WS/.dgclaw/powers.json"
mkdir -p "$LOG_DIR" 2>/dev/null

# Pulso: registra ok/erro no ledger (degrada gracioso se a lib nao existir).
# shellcheck disable=SC1091
source "$PLUGIN/scripts/_lib/pulso-lib.sh" 2>/dev/null && pulso_auto cron-audit

TS=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$TS] iniciando auditoria de crons/timers (slug=$SLUG)" >> "$AUDIT_LOG"

ANOMALIES=()
TOTAL=0
HEALTHY=0
NOW=$(date +%s)

# ─── helper: audita 1 timer systemd (existe/enabled/active/ultima ativacao) ────
audit_timer() {
    local unit="$1" label="$2"
    TOTAL=$((TOTAL+1))

    # a unit-file existe?
    if ! systemctl list-unit-files "$unit" >/dev/null 2>&1 \
         || ! systemctl list-unit-files "$unit" 2>/dev/null | grep -q -F "$unit"; then
        ANOMALIES+=("- ❌ \`$label\` — timer \`$unit\` nao instalado")
        return
    fi

    # esta enabled?
    local en; en="$(systemctl is-enabled "$unit" 2>/dev/null || echo unknown)"
    if [ "$en" != "enabled" ] && [ "$en" != "static" ]; then
        ANOMALIES+=("- ⚠️ \`$label\` — timer \`$unit\` nao habilitado (is-enabled=$en)")
        return
    fi

    # esta active (agendado)?
    if ! systemctl is-active --quiet "$unit" 2>/dev/null; then
        ANOMALIES+=("- ⚠️ \`$label\` — timer \`$unit\` instalado mas inativo (nao vai disparar)")
        return
    fi

    # ultima ativacao do .service pareado (se ja rodou pelo menos 1x)
    local svc last_iso last_epoch age_days
    svc="${unit%.timer}.service"
    last_iso="$(systemctl show -p LastTriggerUSec --value "$unit" 2>/dev/null)"
    if [ -z "$last_iso" ] || [ "$last_iso" = "0" ] || [ "$last_iso" = "n/a" ]; then
        # fallback: ActiveEnterTimestamp do service
        last_iso="$(systemctl show -p ExecMainStartTimestamp --value "$svc" 2>/dev/null)"
    fi
    last_epoch=0
    [ -n "$last_iso" ] && last_epoch="$(date -d "$last_iso" +%s 2>/dev/null || echo 0)"

    if [ "$last_epoch" -gt 0 ]; then
        age_days=$(( (NOW - last_epoch) / 86400 ))
        if [ "$age_days" -gt 7 ]; then
            ANOMALIES+=("- ⚠️ \`$label\` — sem disparar ha $age_days dias (ultima $(date -d @"$last_epoch" '+%Y-%m-%d %H:%M'))")
            return
        fi
    fi
    HEALTHY=$((HEALTHY+1))
}

# ─── 1. timers de vida + ondas: dgclaw-<slug>-*.timer ───────────────────────
# Descoberta dinamica via systemctl (NUNCA lista hardcoded de nomes).
shopt -s nullglob
DISCOVERED=()
while IFS= read -r unit; do
    [ -n "$unit" ] && DISCOVERED+=("$unit")
done < <(systemctl list-unit-files "dgclaw-${SLUG}-*.timer" --no-legend 2>/dev/null | awk '{print $1}')

if [ "${#DISCOVERED[@]}" -eq 0 ]; then
    ANOMALIES+=("- ❌ nenhum timer \`dgclaw-${SLUG}-*\` encontrado (a 'vida' nao foi instalada?)")
else
    for unit in "${DISCOVERED[@]}"; do
        short="${unit#dgclaw-${SLUG}-}"; short="${short%.timer}"
        audit_timer "$unit" "$short"
    done
fi

# ─── 2. powers.json: poderes enabled devem ter seus cron_timers[] instalados ───
if [ -f "$POWERS_FILE" ]; then
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        pid="${line%%|*}"; unit="${line#*|}"
        audit_timer "$unit" "poder:$pid"
    done < <(python3 - "$POWERS_FILE" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for p in d.get("powers", []):
    if p.get("enabled") and p.get("cron_timers"):
        for t in p["cron_timers"]:
            u = t if t.endswith(".timer") else t + ".timer"
            print(f"{p.get('id','?')}|{u}")
PY
    )
fi

# ─── 3. servico de canal (sessao --channels viva): dgclaw-<slug>.service ───────
# A vida injeta pokes nessa sessao; se ela estiver morta os crons viram no-op.
# Descobre o nome do canal de forma generalizada (default dgclaw-<slug>).
CHAN_SVC="${DGCLAW_CHANNEL_NAME:-dgclaw-${SLUG}}.service"
if systemctl list-unit-files "$CHAN_SVC" >/dev/null 2>&1 \
   && systemctl list-unit-files "$CHAN_SVC" 2>/dev/null | grep -q -F "$CHAN_SVC"; then
    TOTAL=$((TOTAL+1))
    if systemctl is-active --quiet "$CHAN_SVC" 2>/dev/null; then
        HEALTHY=$((HEALTHY+1))
    else
        ANOMALIES+=("- ⚠️ \`canal\` — sessao viva \`$CHAN_SVC\` nao esta no ar (pokes injetados viram no-op)")
    fi
fi

echo "[$TS] total=$TOTAL healthy=$HEALTHY anomalies=${#ANOMALIES[@]}" >> "$AUDIT_LOG"

# ─── escreve/limpa o anomaly file ─────────────────────────────────────────────
if [ "${#ANOMALIES[@]}" -gt 0 ]; then
    AUDIT_BLOCK=$(printf '%s\n' "${ANOMALIES[@]}")
    {
        echo "Anomalias encontradas:"
        echo "$AUDIT_BLOCK"
    } >> "$AUDIT_LOG"
    {
        echo "# Anomalias de crons/timers — $(date '+%Y-%m-%d %H:%M')"
        echo ""
        echo "$AUDIT_BLOCK"
        echo ""
        echo "Total: $TOTAL componentes. Saudaveis: $HEALTHY. Anomalos: ${#ANOMALIES[@]}."
    } > "$ANOMALY_FILE"
    pulso erro "$((${#ANOMALIES[@]})) anomalias" 2>/dev/null || true
else
    [ -f "$ANOMALY_FILE" ] && rm -f "$ANOMALY_FILE"
fi

# Auditoria so reporta — nunca derruba nada.
exit 0
