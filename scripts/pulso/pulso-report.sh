#!/usr/bin/env bash
# pulso-report.sh (DG Claw) — manda pro dono (via notify-owner.sh) o pulso do dia.
#
#   pulso-report.sh <config.sh> report   -> resumo agendado (3x/dia): % + contagem +
#                                           lista de problemas.
#   pulso-report.sh <config.sh> alert    -> SO dispara se houver problema CRITICO
#                                           (crit=alta); silencioso quando tudo verde.
#
# Texto PLANO — o Telegram do dono (DM admin) NAO renderiza markdown. Sem *, _, `, #.
# Notificacao SEMPRE via notify-owner.sh do plugin (nunca um notificador hardcoded de outro agente).
# ZERO dado pessoal: so o slug do agente, contagens e ids de componente.
#
# Uso:  bash pulso-report.sh <.dgclaw/config.sh> [report|alert]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
export DGCLAW_WORKSPACE DGCLAW_SLUG DGCLAW_PULSO_DIR DGCLAW_POWERS_FILE
export TELEGRAM_STATE_DIR DGCLAW_OWNER_TELEGRAM_ID

MODE="${2:-report}"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$DGCLAW_WORKSPACE/.dgclaw/plugin}"
NOTIFY="$PLUGIN/scripts/notify-owner.sh"
[ -f "$NOTIFY" ] || NOTIFY="$HERE/../notify-owner.sh"

STATUS_JSON="$(python3 "$HERE/pulso-status.py" --json 2>/dev/null)"
if [ -z "$STATUS_JSON" ]; then
  echo "pulso-report: status vazio" >&2
  exit 1
fi

# Monta a mensagem em Python (texto plano) e decide se envia.
MSG="$(MODE="$MODE" python3 - "$STATUS_JSON" <<'PY'
import json, os, sys
d = json.loads(sys.argv[1])
mode = os.environ.get("MODE", "report")
c = d["counts"]
probs = d["problemas"]
criticos = [p for p in probs if p["crit"] == "alta"]

# modo alert: so fala se tiver problema critico
if mode == "alert" and not criticos:
    sys.exit(9)

red = c["erro"] + c["faltou"]
nome = {p["id"]: p for p in d["processos"]}
slug = d.get("slug", "") or "agente"

if not probs and d["pct"] == 100:
    print(f"Pulso {slug} {d['now']} — tudo verde. "
          f"{c['ok']} componentes OK, {c['pendente']} ainda vao rodar.")
    sys.exit(0)

linhas = []
linhas.append(f"Pulso {slug} {d['now']} — {d['pct']}% dos vencidos rodaram OK.")
linhas.append(f"{c['ok']} ok · {red} com problema · {c['aguardando']} aguardando · "
              f"{c['pendente']} pendentes · {c['sem-sinal']} sem sinal")

if probs:
    linhas.append("")
    mostra = sorted(probs, key=lambda p: {"alta":0,"media":1,"baixa":2}.get(p["crit"],3))
    cap = 10
    for p in mostra[:cap]:
        tag = "!!" if p["crit"] == "alta" else ""
        nm = nome.get(p["id"], {}).get("nome", p["id"])
        est = "nao rodou" if p["resumo"] == "faltou" else "deu erro"
        linhas.append(f"- [{p['crit']}]{tag} {nm}: {est}")
    if len(mostra) > cap:
        linhas.append(f"...e mais {len(mostra)-cap} (ver aba PULSO no painel).")

print("\n".join(linhas))
PY
)"
RC=$?

# RC 9 = modo alert sem nada critico -> nao manda nada (silencio e ouro)
if [ "$RC" -eq 9 ] || [ -z "$MSG" ]; then
  exit 0
fi

bash "$NOTIFY" "$MSG"
