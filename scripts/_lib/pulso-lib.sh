#!/usr/bin/env bash
# pulso-lib.sh (DG Claw) — registro no ledger do Pulso (camada de PRECISAO) p/ crons .sh.
#
# ZERO path hardcoded de maquina/agente. O ledger vai pra
# DGCLAW_PULSO_DIR (default <ws>/.dgclaw/logs/pulso), derivado de DGCLAW_WORKSPACE.
#
# Uso (retrofit de 1 linha no topo/fim de qualquer cron .sh):
#   source "$PLUGIN/scripts/_lib/pulso-lib.sh"; pulso_auto <nome>
#
# pulso_auto [id]: instala um trap EXIT que registra "ok" se o script sair com rc==0,
#   senao "erro". O id default vem de $(basename "$0" .sh). Passe um id explicito
#   pra casar com o nome da unit (ex.: pulso_auto reflection).
#
# pulso <ok|erro|aguardando> [detalhe]: registro explicito. Util onde o script faz `exit 0`
#   mascarando uma falha. O ultimo estado explicito vence o do trap.
#
# Append-only, defensivo, nunca derruba o script chamador (|| true em tudo).

# Ledger: env explicito > derivado do workspace > fallback ./.dgclaw/logs/pulso.
if [ -n "${DGCLAW_PULSO_DIR:-}" ]; then
  PULSO_LEDGER_DIR="$DGCLAW_PULSO_DIR"
elif [ -n "${DGCLAW_WORKSPACE:-}" ]; then
  PULSO_LEDGER_DIR="$DGCLAW_WORKSPACE/.dgclaw/logs/pulso"
else
  PULSO_LEDGER_DIR="${PULSO_LEDGER_DIR:-$PWD/.dgclaw/logs/pulso}"
fi

# id default = nome do script sem .sh; pode ser sobrescrito por PULSO_ID/argumento.
_pulso_id() {
  if [ -n "${PULSO_ID:-}" ]; then printf '%s' "$PULSO_ID"; return; fi
  local base; base="$(basename "$0")"
  printf '%s' "${base%.sh}"
}

# pulso_write <id> <status> [detalhe]
pulso_write() {
  local id="$1" status="$2" det="${3:-}"
  [ -z "$id" ] && return 0
  mkdir -p "$PULSO_LEDGER_DIR" 2>/dev/null || true
  local day ts file
  day="$(date +%F)"
  ts="$(date -Is)"
  file="$PULSO_LEDGER_DIR/$day.jsonl"
  # escapa aspas e barras invertidas do detalhe pra JSON valido
  det="${det//\\/\\\\}"; det="${det//\"/\\\"}"; det="${det//$'\n'/ }"
  # Chaves duplicadas de proposito: ts/id/detalhe sao as de sempre; component/timestamp/detail
  # sao as que o leitor (pulso-status.py, read_ledger) procura. Sem elas a linha era ignorada
  # e o Pulso caia no estado do systemd, onde exit 0 vira "ok" verde mesmo com a rotina falha.
  printf '{"ts":"%s","id":"%s","status":"%s","detalhe":"%s","component":"%s","timestamp":"%s","detail":"%s"}\n' \
    "$ts" "$id" "$status" "$det" "$id" "$ts" "$det" >> "$file" 2>/dev/null || true
}

# pulso <ok|erro> [detalhe] — registro explicito p/ o id corrente
pulso() {
  local status="$1" det="${2:-}"
  PULSO_EXPLICIT=1
  pulso_write "$(_pulso_id)" "$status" "$det"
}

# trap instalado por pulso_auto
_pulso_on_exit() {
  local rc=$?
  # encadeia o trap EXIT que ja existia antes (ex.: limpeza de tmp), sem quebra-lo
  # nem deixar que ele engula nosso registro.
  if [ -n "${PULSO_PREV_EXIT_TRAP:-}" ]; then
    eval "$PULSO_PREV_EXIT_TRAP" || true
  fi
  # se ja houve registro explicito, nao duplica com o do trap
  [ "${PULSO_EXPLICIT:-0}" = "1" ] && return 0
  if [ "$rc" -eq 0 ]; then
    pulso_write "$(_pulso_id)" "ok" ""
  else
    pulso_write "$(_pulso_id)" "erro" "rc=$rc"
  fi
}

pulso_auto() {
  [ -n "${1:-}" ] && export PULSO_ID="$1"
  PULSO_EXPLICIT=0
  # preserva qualquer trap EXIT ja instalado pra encadear (nao clobberar).
  local raw cur
  raw="$(trap -p EXIT 2>/dev/null)"
  cur="${raw#trap -- }"
  cur="${cur% EXIT}"
  case "$cur" in *_pulso_on_exit*) cur="''" ;; esac   # evita auto-referencia
  eval "PULSO_PREV_EXIT_TRAP=${cur:-\"\"}"
  trap _pulso_on_exit EXIT
}
