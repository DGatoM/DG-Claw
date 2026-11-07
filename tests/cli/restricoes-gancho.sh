#!/usr/bin/env bash
# scripts/escrita-restrita-hook.mjs: o gancho PreToolUse que limita onde o agente grava.
# Alimenta o gancho com o JSON que o Claude Code manda e confere o que ele decide.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"

if ! command -v node >/dev/null 2>&1; then
    echo "  node nao esta instalado aqui; o teste do gancho de escrita nao rodou (instale o Node 22)." >&2
    exit 1
fi
GANCHO="$REPO/scripts/escrita-restrita-hook.mjs"
# Fora de /tmp: o gancho libera /tmp de proposito, e uma pasta de teste la dentro esconderia os bloqueios.
TMP="$(mktemp -d -p "$REPO/tests" .gancho-XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
CASA="$TMP/casa"; FORA="$TMP/fora"
mkdir -p "$CASA/relatorios/2026" "$CASA/outra" "$CASA/memory" "$CASA/.dgclaw" "$CASA/.claude" "$FORA"
ln -s "$FORA" "$CASA/relatorios/atalho"          # dentro da pasta liberada, mas aponta para fora
ln -s "$CASA/outra" "$TMP/atalho-de-fora"
export DGCLAW_WORKSPACE="$CASA" DGCLAW_RESTRICOES="$TMP/restricoes.json"
printf '{"versao":1,"sem_bash":false,"sem_enviar_arquivo":false,"escrita_so_em":["relatorios"]}\n' >"$DGCLAW_RESTRICOES"

# decide <ferramenta> <caminho> [cwd]: imprime "libera" ou "bloqueia"; o motivo vai para $TMP/motivo.
decide() {
    local ferr="$1" cam="$2" cwd="${3:-$CASA}" campo=file_path out
    [ "$ferr" = NotebookEdit ] && campo=notebook_path
    out="$(jq -nc --arg f "$ferr" --arg c "$cam" --arg d "$cwd" --arg k "$campo" '{hook_event_name:"PreToolUse", tool_name:$f, cwd:$d, tool_input:{($k):$c}}' | node "$GANCHO")"
    if [ -z "$out" ]; then echo libera; else
        printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason' >"$TMP/motivo"
        printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null && echo bloqueia || echo estranho
    fi
}

echo "dentro e fora da pasta liberada"
igual "Write dentro da pasta passa" "libera" "$(decide Write "$CASA/relatorios/a.md")"
igual "Edit numa subpasta passa" "libera" "$(decide Edit "$CASA/relatorios/2026/b.md")"
igual "MultiEdit em arquivo novo numa subpasta que ainda nao existe passa" "libera" "$(decide MultiEdit "$CASA/relatorios/novo/c.md")"
igual "NotebookEdit dentro da pasta passa" "libera" "$(decide NotebookEdit "$CASA/relatorios/n.ipynb")"
igual "caminho relativo resolve pelo cwd" "libera" "$(decide Write "a.md" "$CASA/relatorios")"
igual "Write fora da pasta bloqueia" "bloqueia" "$(decide Write "$CASA/outra/x.md")"
afirma "o motivo diz qual pasta e permitida" grep -q "$CASA/relatorios" "$TMP/motivo"
igual "Write na raiz da casa bloqueia" "bloqueia" "$(decide Write "$CASA/solto.txt")"
igual "Write em /etc bloqueia" "bloqueia" "$(decide Write /etc/passwd)"
igual "pasta de nome parecido (relatorios-velhos) bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios-velhos/x.md")"
igual ".. para sair da pasta bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/../outra/x.md")"
igual "caminho relativo com .. bloqueia" "bloqueia" "$(decide Write "../outra/x.md" "$CASA/relatorios")"

echo "atalhos"
igual "atalho dentro da pasta que aponta para fora bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/atalho/x.md")"
igual "atalho que aponta para fora (arquivo novo) bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/atalho/pasta-nova/x.md")"
ln -s "$FORA/alvo.txt" "$CASA/relatorios/ponte.txt"
igual "atalho de arquivo que aponta para fora bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/ponte.txt")"
igual "caminho de fora que chega por atalho a uma pasta nao liberada bloqueia" "bloqueia" "$(decide Write "$TMP/atalho-de-fora/x.md")"
rm "$CASA/relatorios/ponte.txt"
ln -s b-circular "$CASA/relatorios/a-circular"; ln -s a-circular "$CASA/relatorios/b-circular"
igual "atalho circular (erro inesperado) bloqueia em vez de liberar" "bloqueia" "$(decide Write "$CASA/relatorios/a-circular")"
rm "$CASA/relatorios/a-circular" "$CASA/relatorios/b-circular"
mv "$CASA/relatorios" "$CASA/rel-real"; ln -s "$FORA" "$CASA/relatorios"
igual "a propria pasta liberada virou atalho para fora: nao vale" "bloqueia" "$(decide Write "$CASA/relatorios/x.md")"
rm "$CASA/relatorios"; mv "$CASA/rel-real" "$CASA/relatorios"

echo "o que o agente grava sozinho para funcionar"
igual "MEMORY.md passa" "libera" "$(decide Write "$CASA/MEMORY.md")"
igual "working-memory.md passa" "libera" "$(decide Edit "$CASA/working-memory.md")"
igual "memory/ passa" "libera" "$(decide Write "$CASA/memory/2026-11-07.md")"
igual ".dgclaw/ passa" "libera" "$(decide Write "$CASA/.dgclaw/logs/x.log")"
igual ".claude/ passa" "libera" "$(decide Write "$CASA/.claude/settings.local.json")"
igual "o settings.json do servidor nao passa" "bloqueia" "$(decide Write "$CASA/.claude/settings.json")"
igual "/tmp passa" "libera" "$(decide Write /tmp/rascunho.txt)"
igual "outro arquivo MEMORY.md (em pasta nao liberada) nao passa" "bloqueia" "$(decide Write "$CASA/outra/MEMORY.md")"

echo "sem restricao: libera tudo"
rm -f "$DGCLAW_RESTRICOES"
igual "sem restricoes.json libera" "libera" "$(decide Write "$CASA/outra/x.md")"
printf '{"versao":1,"sem_bash":true,"escrita_so_em":null}\n' >"$DGCLAW_RESTRICOES"
igual "escrita_so_em nulo libera" "libera" "$(decide Write "$CASA/outra/x.md")"
printf '{"versao":1,"sem_bash":true}\n' >"$DGCLAW_RESTRICOES"
igual "escrita_so_em ausente libera" "libera" "$(decide Write "$CASA/outra/x.md")"

echo "arquivo estragado: nao solta a trava"
printf '{"versao":1,"escrita_so_em": [' >"$DGCLAW_RESTRICOES"
igual "JSON ilegivel bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/x.md")"
afirma "e diz o que aconteceu" grep -q 'não consegui ler' "$TMP/motivo"
printf '{"versao":1,"escrita_so_em": "relatorios"}\n' >"$DGCLAW_RESTRICOES"
igual "escrita_so_em que nao e lista bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/x.md")"

echo "entrada estranha"
printf '{"versao":1,"escrita_so_em":["relatorios"]}\n' >"$DGCLAW_RESTRICOES"
out="$(printf 'isto nao e json' | node "$GANCHO")"
afirma "entrada que nao e JSON bloqueia" bash -c "printf '%s' '$out' | jq -e '.hookSpecificOutput.permissionDecision == \"deny\"'"
out="$(printf '{"tool_name":"Write","tool_input":{}}' | node "$GANCHO")"
afirma "pedido sem caminho bloqueia" bash -c "printf '%s' '$out' | jq -e '.hookSpecificOutput.permissionDecision == \"deny\"'"

fim
