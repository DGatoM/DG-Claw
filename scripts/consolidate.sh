#!/bin/bash
# consolidate.sh — Consolidacao noturna da memoria, feita pelo PROPRIO Claude.
#
# Sem API externa: usa o claude CLI (mesma assinatura do assistente) pra ler o
# working-memory.md, promover o que e duradouro pro MEMORY.md e limpar o resto.
#
# Uso:  bash consolidate.sh <config.sh>
# Roda pelo timer systemd dgclaw-<slug>-consolidate.timer (ver install-consolidate-timer.sh).

set -uo pipefail

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"

export PATH="${BUN_BIN_DIR:-$HOME/.bun/bin}:$HOME/.local/bin:$PATH"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
LOG="$DGCLAW_WORKSPACE/.dgclaw/logs/consolidate.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null

cd "$DGCLAW_WORKSPACE" || exit 1

PROMPT='Voce esta fazendo a CONSOLIDACAO NOTURNA da memoria do assistente. Trabalhe so com os arquivos deste diretorio, em silencio, e NAO mande mensagem pra ninguem.

Tarefa:
1. Leia working-memory.md (curto prazo) e MEMORY.md (longo prazo).
2. Promova pro MEMORY.md os fatos do working-memory que sao DURADOUROS (preferencias, pessoas, projetos, decisoes que valem pra frente). Escreva como linhas curtas e datadas, na secao certa, sem duplicar o que ja esta la.
3. Remova do working-memory.md o que ja foi concluido, virou fato duradouro (ja movido) ou ficou obsoleto. Mantenha so o que ainda esta "em aberto/agora".
4. Mantenha o MEMORY.md organizado e enxuto: junte duplicatas, nao apague historico importante, nao invente nada.
5. Use as ferramentas de edicao de arquivo pra salvar as mudancas. No fim, escreva UMA linha de resumo do que mudou (apenas texto, sem mandar pra Telegram).

Regra: na duvida, preserve. Nunca invente fatos que nao estao escritos.'

echo "[$(date '+%F %T')] iniciando consolidacao em $DGCLAW_WORKSPACE" >> "$LOG"
"$CLAUDE_BIN" --print \
    --no-session-persistence \
    --permission-mode bypassPermissions \
    --add-dir "$DGCLAW_WORKSPACE" \
    -p "$PROMPT" >> "$LOG" 2>&1
echo "[$(date '+%F %T')] consolidacao terminou (rc=$?)" >> "$LOG"
