#!/usr/bin/env bash
# pulso-report.sh (DG Claw) — manda pro dono (via notify-owner.sh) o pulso do dia.
#
# Generalizacao do pulso-report do ClaudeClaw: notifica SEMPRE via notify-owner.sh
# (nunca telegram_notify hardcoded) e le o ledger de DGCLAW_PULSO_DIR.
#
#   pulso-report.sh <config> [report|alert]
#     report  → resumo agendado (13h/19h/23h58): % + contagem + lista de problemas.
#     alert   → SO dispara se houver problema CRITICO; silencioso quando tudo bem.
#
# Texto PLANO — o Telegram (DM admin) NAO renderiza markdown. Sem *, _, `, #.
#
# Fonte da verdade: o ledger <ws>/.dgclaw/logs/pulso/<dia>.jsonl escrito pela pulso-lib
# (o ultimo status por id no dia vence). DEGRADA GRACIOSO: se nao houver ledger do dia,
# nao manda nada (exit 0). Registra a si mesmo no Pulso.
set -uo pipefail

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"

WS="$DGCLAW_WORKSPACE"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$WS/.dgclaw/plugin}"
MODE="${2:-report}"
LEDGER_DIR="${DGCLAW_PULSO_DIR:-$WS/.dgclaw/logs/pulso}"
NOTIFY="$PLUGIN/scripts/notify-owner.sh"

# Pulso: registra a propria execucao (degrada gracioso se a lib nao existir).
# shellcheck disable=SC1091
source "$PLUGIN/scripts/_lib/pulso-lib.sh" 2>/dev/null && pulso_auto pulso-report

DAY="$(date +%F)"
LEDGER="$LEDGER_DIR/$DAY.jsonl"
[ -f "$LEDGER" ] || { echo "pulso-report: sem ledger do dia ($LEDGER) — nada a reportar" >&2; exit 0; }

# Monta a mensagem em Python (texto plano) e decide se envia.
MSG="$(MODE="$MODE" python3 - "$LEDGER" <<'PY'
import json, os, sys
mode = os.environ.get("MODE", "report")
last = {}  # id -> ultimo registro do dia (o mais recente vence)
try:
    for line in open(sys.argv[1]):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        last[r.get("id", "?")] = r
except Exception:
    sys.exit(0)

if not last:
    sys.exit(0)

oks = [i for i, r in last.items() if r.get("status") == "ok"]
erros = [(i, r) for i, r in last.items() if r.get("status") == "erro"]

# modo alert: so fala se houver erro
if mode == "alert" and not erros:
    sys.exit(9)

total = len(last)
pct = round(100 * len(oks) / total) if total else 0
agora = __import__("datetime").datetime.now().strftime("%H:%M")

if not erros:
    print(f"Pulso {agora} — tudo verde. {len(oks)}/{total} componentes OK.")
    sys.exit(0)

linhas = [f"Pulso {agora} — {pct}% OK ({len(oks)}/{total}). {len(erros)} com problema:"]
for i, r in sorted(erros):
    det = (r.get("detalhe") or "").strip()
    linhas.append(f"- {i}: deu erro" + (f" ({det})" if det else ""))
print("\n".join(linhas))
PY
)"
RC=$?

# RC 9 = modo alert sem nada critico → silencio.
if [ "$RC" -eq 9 ] || [ -z "$MSG" ]; then
    exit 0
fi

bash "$NOTIFY" "$MSG" >/dev/null 2>&1 || true
