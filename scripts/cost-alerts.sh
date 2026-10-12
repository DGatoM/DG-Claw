#!/bin/bash
# cost-alerts.sh (DG Claw) — alerta o dono quando o gasto Anthropic da persona
# atravessa thresholds do orcamento mensal (50/75/90/100%) OU quando uma execucao
# individual passa de um teto. Notifica SEMPRE via scripts/notify-owner.sh.
#
# Tudo parametrizado por env do contrato DG Claw. ZERO hardcode de persona/paths.
#
# Env:
#   DGCLAW_WORKSPACE        (obrigatorio na pratica) — raiz do workspace da persona.
#   DGCLAW_BUDGET_USD       (opcional, default 200)  — orcamento mensal em USD.
#   DGCLAW_EXEC_ALERT_USD   (opcional, default 5)    — teto de 1 execucao isolada.
#   DGCLAW_LOGS_DIR         (opcional)               — onde estao os *-tokens.jsonl.
#                               Default: <ws>/.dgclaw/logs
#   DGCLAW_COST_STATE       (opcional)               — state file (throttle).
#                               Default: <DGCLAW_LOGS_DIR>/.cost-alerts-state.json
#   TELEGRAM_STATE_DIR / DGCLAW_OWNER_TELEGRAM_ID    — usados por notify-owner.sh.
#
# Rodar de hora em hora (timer). Mantem estado por mes (thresholds) e por session_id
# (execucoes caras) pra nao repetir o mesmo alerta — throttle idempotente.

set -uo pipefail

# Diretorio deste script (pra achar notify-owner.sh ao lado, sem hardcode de path).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOTIFY_SH="$SCRIPT_DIR/notify-owner.sh"

# Se chamado com um config.sh (pelos timers de vida), sourcia pra exportar DGCLAW_*.
CONFIG="${1:-${DGCLAW_CONFIG:-}}"
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    source "$CONFIG"
fi

WS="${DGCLAW_WORKSPACE:?cost-alerts: DGCLAW_WORKSPACE nao setado}"
BUDGET="${DGCLAW_BUDGET_USD:-200}"
EXEC_ALERT="${DGCLAW_EXEC_ALERT_USD:-5}"
LOG_DIR="${DGCLAW_LOGS_DIR:-$WS/.dgclaw/logs}"
STATE_FILE="${DGCLAW_COST_STATE:-$LOG_DIR/.cost-alerts-state.json}"
RUN_LOG="$LOG_DIR/cost-alerts.log"

mkdir -p "$LOG_DIR"
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

notify() {
    # Nunca deixa um erro de notificacao derrubar o cron.
    bash "$NOTIFY_SH" "$1" >/dev/null 2>&1 || \
        echo "[$(date -Iseconds)] WARN: notify-owner falhou" >> "$RUN_LOG"
}

# ── 1. soma custo do mes corrente + coleta execucoes caras ───────────────────
MONTH_START_EPOCH=$(date -d "$(date '+%Y-%m-01')" +%s)
SUMMARY=$(EXEC_ALERT="$EXEC_ALERT" LOG_DIR="$LOG_DIR" MONTH_START_EPOCH="$MONTH_START_EPOCH" python3 2>>"$RUN_LOG" <<'PYEOF'
import json, glob, os, sys
from datetime import datetime

start_epoch = int(os.environ["MONTH_START_EPOCH"])
exec_thresh = float(os.environ["EXEC_ALERT"])
log_dir = os.environ["LOG_DIR"]

total = 0.0
exec_alerts = []
for f in glob.glob(os.path.join(log_dir, "*-tokens.jsonl")):
    try:
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                ts = obj.get("timestamp")
                if not ts:
                    continue
                try:
                    epoch = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
                except Exception:
                    continue
                if epoch < start_epoch:
                    continue
                cost = float(obj.get("total_cost_usd") or 0)
                total += cost
                if cost > exec_thresh:
                    exec_alerts.append({
                        "cron": obj.get("cron"),
                        "session_id": obj.get("session_id"),
                        "cost": cost,
                        "ts": ts,
                    })
    except Exception as e:
        # Nao engole em silencio: registra o arquivo problematico no stderr (cai no RUN_LOG)
        # e segue pros demais — 1 log corrompido nao deve zerar o total do mes inteiro.
        sys.stderr.write(f"cost-alerts: erro lendo {f}: {type(e).__name__}: {e}\n")
print(json.dumps({"total": round(total, 6), "exec_alerts": exec_alerts}))
PYEOF
)
PY_RC=$?

# Se o Python falhou de vez (SUMMARY vazio ou nao-JSON), aborta sem fingir total=0
# (total=0 dispararia "0% do orcamento" enganoso e poderia mascarar gasto real).
if [ "$PY_RC" -ne 0 ] || ! echo "$SUMMARY" | jq -e '.total' >/dev/null 2>&1; then
    echo "[$(date -Iseconds)] ERRO: agregacao de custo falhou (py_rc=$PY_RC, summary=${SUMMARY:0:120}) — abortando sem alarme" >> "$RUN_LOG"
    exit 0
fi

TOTAL=$(echo "$SUMMARY" | jq -r '.total')
PCT=$(python3 -c "b=float('$BUDGET'); t=float('$TOTAL'); print(int((t/b)*100) if b>0 else 0)")

echo "[$(date -Iseconds)] month_total=\$$TOTAL budget=\$$BUDGET pct=$PCT%" >> "$RUN_LOG"

MONTH=$(date '+%Y-%m')

# ── 2. thresholds 50/75/90/100 (1x por mes cada) ─────────────────────────────
fire_threshold() {
    local lvl="$1"
    local already
    already=$(jq -r --arg m "$MONTH" --arg lvl "$lvl" '.[$m][$lvl] // ""' "$STATE_FILE")
    if [ -z "$already" ]; then
        local emoji="⚠️"
        [ "$lvl" = "100" ] && emoji="🚨"
        notify "$emoji Custo Anthropic: $PCT% do orcamento mensal usado (\$$(printf '%.2f' "$TOTAL") de \$$(printf '%.0f' "$BUDGET")). Threshold $lvl% atingido."
        jq --arg m "$MONTH" --arg lvl "$lvl" --arg ts "$(date -Iseconds)" \
           '.[$m][$lvl] = $ts' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
        echo "[$(date -Iseconds)] FIRED threshold $lvl%" >> "$RUN_LOG"
    fi
}

[ "$PCT" -ge 50 ]  && fire_threshold 50
[ "$PCT" -ge 75 ]  && fire_threshold 75
[ "$PCT" -ge 90 ]  && fire_threshold 90
[ "$PCT" -ge 100 ] && fire_threshold 100

# ── 3. execucoes individuais caras (1x por session_id) ───────────────────────
echo "$SUMMARY" | jq -c '.exec_alerts[]' | while read -r alert; do
    SID=$(echo "$alert" | jq -r '.session_id')
    { [ -z "$SID" ] || [ "$SID" = "null" ]; } && continue
    ALREADY=$(jq -r --arg sid "$SID" '.exec_alerts[$sid] // ""' "$STATE_FILE")
    if [ -z "$ALREADY" ]; then
        COST=$(echo "$alert" | jq -r '.cost')
        CRON=$(echo "$alert" | jq -r '.cron')
        TS=$(echo "$alert" | jq -r '.ts')
        notify "💸 Execucao cara: \$$(printf '%.2f' "$COST") em $CRON ($TS). Ver detalhe no painel (aba Custos)."
        jq --arg sid "$SID" --arg ts "$(date -Iseconds)" \
           '.exec_alerts[$sid] = $ts' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
        echo "[$(date -Iseconds)] FIRED exec alert sid=$SID cost=\$$COST" >> "$RUN_LOG"
    fi
done

exit 0
