#!/bin/bash
# memory-reindex.sh — refaz o indice da memoria semantica do agente (MEMORY.md, working-memory,
# diarios em memory/, relationships e afins). E o que permite ao agente achar "aquilo que o
# dono falou em agosto" mesmo com outras palavras.
#
# Roda pelo timer dgclaw-<slug>-memory-reindex (de madrugada, quando ninguem esta usando a
# maquina) e no fim do install-embedding-local.sh. E incremental: so embeda trecho novo ou
# mudado. Com o modelo local e 1 nucleo, ~1 s por trecho novo.
#
# Sem modelo local e sem GEMINI_API_KEY, sai 0 e deixa no log a linha "memoria semantica
# desligada: <motivo e como ligar>". Isso e estado, nao erro: o doctor mostra o mesmo.
#
# Uso:  bash memory-reindex.sh <.dgclaw/config.sh> [--full]
set -uo pipefail
CONFIG="${1:?Uso: memory-reindex.sh <.dgclaw/config.sh> [--full]}"
shift
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
set +u
# shellcheck disable=SC1090
source "$CONFIG"
set -u
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
export DGCLAW_WORKSPACE DGCLAW_SLUG DGCLAW_MEMORY_INDEX_DIR DGCLAW_EMBED_PROVIDER DGCLAW_EMBED_DIR \
       DGCLAW_EMBED_THREADS GEMINI_API_KEY 2>/dev/null
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$DGCLAW_WORKSPACE/.dgclaw/plugin}"
[ -d "$PLUGIN/scripts/memory_index" ] || PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$DGCLAW_WORKSPACE/.dgclaw/logs/memory-reindex.log"
mkdir -p "$(dirname "$LOG")"

# shellcheck disable=SC1091
if source "$PLUGIN/scripts/_lib/pulso-lib.sh" 2>>"$LOG"; then
    pulso_auto memory-reindex
else
    echo "[$(date '+%F %T')] aviso: sem $PLUGIN/scripts/_lib/pulso-lib.sh, o pulso nao registra esta rodada" >> "$LOG"
fi

echo "[$(date '+%F %T')] reindex da memoria semantica: comecando" >> "$LOG"
# nice/ionice: o reindex nunca disputa CPU com a conversa do dono
nice -n 15 ionice -c3 python3 "$PLUGIN/scripts/memory_index/reindex.py" "$@" >> "$LOG" 2>&1
RC=$?
if [ "$RC" != "0" ]; then
    echo "[$(date '+%F %T')] reindex da memoria semantica FALHOU (codigo $RC); o motivo esta nas linhas acima. A busca continua com o indice anterior." >> "$LOG"
fi
# O vocabulario de base (o que e palavra comum para este agente) alimenta o caminho rapido
# da busca, que so dispara com palavra estranha. Contagem local, sem modelo: segundos.
python3 "$PLUGIN/scripts/memory_index/build-baseline.py" >> "$LOG" 2>&1 \
    || echo "[$(date '+%F %T')] o vocabulario de base (build-baseline.py) falhou; ver acima" >> "$LOG"
tail -n 3 "$LOG"

# O indice e do agente: se o workspace tem dono proprio, o banco tambem (o timer roda como
# root e um banco do root o agente nao conseguiria atualizar).
WS_OWNER=$(stat -c '%U' "$DGCLAW_WORKSPACE" 2>/dev/null || echo root)
IDX="${DGCLAW_MEMORY_INDEX_DIR:-$DGCLAW_WORKSPACE/.dgclaw/memory_index}"
if [ "$WS_OWNER" != "root" ] && [ "$(id -u)" = "0" ] && [ -f "$IDX/chunks.db" ]; then
    chown "$WS_OWNER" "$IDX" "$IDX/chunks.db" "$IDX/chunks.db-wal" "$IDX/chunks.db-shm" "$IDX/reindex.lock" "$IDX/baseline-vocab.json" 2>/dev/null
    chown "$WS_OWNER" "$IDX/chunks.db" || echo "[$(date '+%F %T')] nao consegui passar $IDX/chunks.db para o usuario $WS_OWNER" >> "$LOG"
fi
exit "$RC"
