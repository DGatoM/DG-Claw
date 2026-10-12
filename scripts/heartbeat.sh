#!/bin/bash
# heartbeat.sh — Batimento (a cada 30min) do agente. Smart-check barato.
#
# Sempre (barato, sem Claude): roda os ganchos das extensoes instaladas e refresca a secao
# "## Agora" da working-memory, pra que a proxima sessao chegue sabendo em que pe estao as
# coisas.
#
# ONDA A (sessao viva): quando o smart-check decide que HA motivo pra agir (ver abaixo), o
# poke de proatividade e INJETADO na sessao --channels viva do agente (assinatura flat) — NAO
# mais via `claude -p` (que queima credito de API). A propria persona decide se avisa o dono e
# manda a mensagem pela tool de canal dela. Se a sessao nao estiver no ar (dono desligou o bot
# 24/7 pra poupar), o heartbeat LOGA "sessao nao ativa, pulando" e sai 0 (no-op gracioso).
#
# So injeta SE houver motivo:
#   (a) a secao "Quero Falar com o <dono> Sobre" tem linha real (nao comentario/placeholder), ou
#   (b) a working-memory esta velha (>8h sem rebuild).
#
# Uso:  bash heartbeat.sh <.dgclaw/config.sh>

set -uo pipefail

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"

export PATH="${BUN_BIN_DIR:-$HOME/.bun/bin}:$HOME/.local/bin:$PATH"
export DGCLAW_WORKSPACE DGCLAW_PERSONA_DIR="${DGCLAW_PERSONA_DIR:-$DGCLAW_WORKSPACE/persona}"
export DGCLAW_OWNER DGCLAW_NAME
SLUG="$DGCLAW_SLUG"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$DGCLAW_WORKSPACE/.dgclaw/plugin}"
LOG="$DGCLAW_WORKSPACE/.dgclaw/logs/heartbeat.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
WM="$DGCLAW_WORKSPACE/working-memory.md"
cd "$DGCLAW_WORKSPACE" || exit 1

# Pulso: registra ok/erro no ledger (rc final via trap EXIT). Degrada gracioso se a lib
# nao existir. rc 2 (sessao morta) sai 0 -> conta como "ok" (no-op gracioso esperado).
# shellcheck disable=SC1091
source "$PLUGIN/scripts/_lib/pulso-lib.sh" 2>/dev/null && pulso_auto heartbeat

# --- 1. sempre: ganchos das extensoes + refresh do "Agora" (barato, sem Claude) ---
# Cada extensao instalada pode ter um hooks/heartbeat.sh (o DG Alive usa pra envelhecer as
# emocoes). Falha de extensao vai pro log e nao interrompe o batimento do nucleo.
EXT_DIR="$DGCLAW_WORKSPACE/.dgclaw/ext"
if [ -d "$EXT_DIR" ]; then
    while IFS= read -r ext; do
        hook="$ext/hooks/heartbeat.sh"
        [ -f "$hook" ] || continue
        if ! DGCLAW_WORKSPACE="$DGCLAW_WORKSPACE" DGCLAW_CONFIG="$CONFIG" \
             timeout 20 bash "$hook" >>"$LOG" 2>&1; then
            echo "$(date '+%F %T') heartbeat: a extensao '$(basename "$ext")' falhou no gancho heartbeat.sh (veja as linhas acima). O batimento seguiu sem ela." >> "$LOG"
        fi
    done < <(find "$EXT_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
fi
python3 "$PLUGIN/scripts/build-working-memory.py" --agora-only >/dev/null 2>&1 || true

# --- 2. tem algo pra falar com o dono? ---
HAS_NEWS=0
if [ -f "$WM" ]; then
    BLOCK=$(awk '/^## Quero Falar com o/{f=1;next} /^## /{f=0} f' "$WM" | grep -vE '^\s*(<!--|$)' | grep -vE '^\s*-\s*\(' )
    [ -n "$BLOCK" ] && HAS_NEWS=1
fi

# --- 3. working-memory velha? (>8h) ---
STALE=0
if [ -f "$WM" ]; then
    AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$WM") ) / 3600 ))
    [ "$AGE_H" -ge 8 ] && STALE=1
fi

if [ "$HAS_NEWS" = "0" ] && [ "$STALE" = "0" ]; then
    echo "[$(date '+%F %T')] heartbeat: nada a fazer" >> "$LOG"
    exit 0
fi

# --- 3.5 sorteio de proatividade (1/4) ---
# Mesmo HAVENDO motivo, nem todo batimento deve incomodar o dono: a vida nao avisa
# de tudo o tempo todo. Sorteamos 1 em 4 (~25%), o que corta ~60% das chamadas que
# PASSARAM no smart-check. Ja rodamos os ganchos e refrescamos o "## Agora" acima, entao
# perder este sorteio nao perde estado — so adia o poke pro proximo batimento.
# EXCECAO: se a working-memory esta velha (STALE), nao sorteamos — refrescar e barato/seguro
# e nao queremos deixar a memoria envelhecer indefinidamente.
# Override: DGCLAW_HEARTBEAT_FORCE=1 pula o sorteio (debug/teste).
if [ "$STALE" = "0" ] && [ "${DGCLAW_HEARTBEAT_FORCE:-0}" != "1" ]; then
    DICE=$(( RANDOM % 4 ))
    if [ "$DICE" -ne 0 ]; then
        echo "[$(date '+%F %T')] heartbeat: motivo presente (news=$HAS_NEWS) mas sorteio nao caiu (dice=$DICE/4) — adiando poke" >> "$LOG"
        exit 0
    fi
    echo "[$(date '+%F %T')] heartbeat: sorteio caiu (dice=0/4) — seguindo pro poke" >> "$LOG"
fi

# --- 4. ha motivo: injeta o poke de proatividade na sessao viva (fire-and-forget) ---
# shellcheck disable=SC1091
source "$PLUGIN/scripts/_lib/inject.sh"

# No-op gracioso ANTES de montar/injetar: se a sessao nao esta viva, nem tenta.
if ! require_live_session "$SLUG" "heartbeat (news=$HAS_NEWS stale=$STALE)" >> "$LOG" 2>&1; then
    exit 0
fi

NAME="${DGCLAW_NAME:-a assistente}"
PROMPT="Voce e ${NAME}, num batimento interno (heartbeat). NAO e o dono falando com voce.
Olhe a working-memory.md, em especial a secao 'Quero Falar com o ${DGCLAW_OWNER:-dono} Sobre'.
Se houver algo REALMENTE digno de avisar o ${DGCLAW_OWNER:-dono} agora (um achado, um recado seu,
algo que nao pode esperar), mande a mensagem curta e natural pra ele pelo seu canal (texto corrido,
sem markdown, com no maximo 1-2 emojis) e remova a linha correspondente da working-memory.
Se NAO houver nada que justifique interromper, nao mande nada — so siga em frente."

echo "[$(date '+%F %T')] heartbeat: injetando poke (news=$HAS_NEWS stale=$STALE) na sessao viva de ${SLUG}" >> "$LOG"
inject_session "$SLUG" heartbeat <<< "$PROMPT" >> "$LOG" 2>&1
RC=$?
case "$RC" in
    0) echo "[$(date '+%F %T')] heartbeat: poke injetado (rc=0)" >> "$LOG" ;;
    2) echo "[$(date '+%F %T')] heartbeat: sessao nao ativa — pulando (no-op gracioso)" >> "$LOG" ;;
    *) echo "[$(date '+%F %T')] heartbeat: FALHA ao injetar (rc=$RC)" >> "$LOG" ;;
esac

# rc 2 (sessao morta) e um no-op gracioso esperado -> exit 0.
# rc 1/3/4 (falha REAL: lock timeout, PermissionError, erro de injecao) -> propaga como erro,
# pra o systemd/admin enxergar a colisao/deadlock em vez de falhar em silencio.
[ "$RC" = "2" ] && exit 0
exit "$RC"
