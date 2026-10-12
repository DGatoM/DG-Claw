#!/bin/bash
# detect-dgclaw.sh — Acha assistentes DG Claw instalados nesta maquina.
#
# Uso:
#   bash detect-dgclaw.sh            # lista todos (uma linha por agente: slug|workspace|config)
#   bash detect-dgclaw.sh <slug>     # imprime o config.sh path daquele slug (rc!=0 se nao achar)
#
# Cobre os dois layouts de instalacao do DG Claw:
#   - sandbox/root:    /root/dgclaw/<slug>/.dgclaw/config.sh   (roda como root)
#   - usuario dedicado: /home/dgclaw-<slug>/.dgclaw/config.sh
# E confirma cruzando com o state-dir do Telegram em ~/.claude/dgclaw-channels/<slug>/.

set -uo pipefail

WANT="${1:-}"

# Junta candidatos dos dois layouts conhecidos, sem duplicar.
mapfile -t CONFIGS < <(
  { ls -1 /root/dgclaw/*/.dgclaw/config.sh 2>/dev/null
    ls -1 /home/dgclaw-*/.dgclaw/config.sh 2>/dev/null
    ls -1 /home/*/dgclaw/*/.dgclaw/config.sh 2>/dev/null
  } | sort -u
)

found=0
for cfg in "${CONFIGS[@]}"; do
  [ -f "$cfg" ] || continue
  # Le slug/workspace sem dar source (evita efeitos colaterais de env).
  slug=$(grep -E '^export DGCLAW_SLUG=' "$cfg" | head -1 | sed -E 's/.*="?([^"]*)"?.*/\1/')
  ws=$(grep -E '^export DGCLAW_WORKSPACE=' "$cfg" | head -1 | sed -E 's/.*="?([^"]*)"?.*/\1/')
  [ -n "$slug" ] || continue

  if [ -n "$WANT" ]; then
    if [ "$slug" = "$WANT" ]; then
      echo "$cfg"
      exit 0
    fi
    continue
  fi

  # lista as extensoes instaladas neste agente (o DG Alive e uma delas)
  exts=""
  if [ -d "$ws/.dgclaw/ext" ]; then
    for e in "$ws"/.dgclaw/ext/*/; do
      [ -f "${e}ext.json" ] || continue
      exts="${exts}${exts:+,}$(basename "$e")"
    done
  fi
  [ -n "$exts" ] || exts="-"
  # marca se o service existe
  svc="no"
  systemctl list-unit-files "dgclaw-${slug}.service" >/dev/null 2>&1 && \
    systemctl cat "dgclaw-${slug}.service" >/dev/null 2>&1 && svc="yes"

  echo "${slug}|${ws}|${cfg}|ext=${exts}|service=${svc}"
  found=1
done

if [ -n "$WANT" ]; then
  echo "detect-dgclaw: slug '$WANT' nao encontrado" >&2
  exit 1
fi

[ "$found" = "1" ] || { echo "detect-dgclaw: nenhum DG Claw encontrado nesta maquina" >&2; exit 2; }
exit 0
