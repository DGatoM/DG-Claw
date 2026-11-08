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
# Fora de /tmp, onde quer que o repositorio esteja: o gancho libera /tmp de proposito, e uma pasta de teste la
# dentro esconderia os bloqueios (uma copia do repositorio em /tmp quebrava o teste).
TMP="$(mktemp -d -p /var/tmp dgclaw-gancho-XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
CASA="$TMP/casa"; FORA="$TMP/fora"
mkdir -p "$CASA/relatorios/2026" "$CASA/outra" "$CASA/memory" "$CASA/.dgclaw" "$CASA/.claude" "$FORA"
ln -s "$FORA" "$CASA/relatorios/atalho"          # dentro da pasta liberada, mas aponta para fora
ln -s "$CASA/outra" "$TMP/atalho-de-fora"
# O gancho nao le variavel de ambiente: os caminhos de teste vao por argumento de linha de comando.
DGCLAW_RESTRICOES="$TMP/restricoes.json"
roda_gancho() { node "$GANCHO" --restricoes "$DGCLAW_RESTRICOES" --casa "$CASA"; }
printf '{"versao":1,"sem_bash":false,"sem_enviar_arquivo":false,"escrita_so_em":["relatorios"]}\n' >"$DGCLAW_RESTRICOES"

# decide <ferramenta> <caminho> [cwd]: imprime "libera" ou "bloqueia"; o motivo vai para $TMP/motivo.
decide() {
    local ferr="$1" cam="$2" cwd="${3:-$CASA}" campo=file_path out
    [ "$ferr" = NotebookEdit ] && campo=notebook_path
    out="$(jq -nc --arg f "$ferr" --arg c "$cam" --arg d "$cwd" --arg k "$campo" '{hook_event_name:"PreToolUse", tool_name:$f, cwd:$d, tool_input:{($k):$c}}' | roda_gancho)"
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

echo "o que o agente grava sozinho: so a memoria"
mkdir -p "$CASA/.codex" "$CASA/.plataforma/dgchat"
igual "MEMORY.md passa" "libera" "$(decide Write "$CASA/MEMORY.md")"
igual "working-memory.md passa" "libera" "$(decide Edit "$CASA/working-memory.md")"
igual "memory/ passa" "libera" "$(decide Write "$CASA/memory/2026-11-07.md")"
igual "outro arquivo MEMORY.md (em pasta nao liberada) nao passa" "bloqueia" "$(decide Write "$CASA/outra/MEMORY.md")"
# O que algum executor do agente (batimento, rotinas, ganchos, MCP) le para executar fica fechado.
igual ".dgclaw/config.sh (o batimento faz source dele) bloqueia" "bloqueia" "$(decide Write "$CASA/.dgclaw/config.sh")"
igual ".dgclaw/ext/*/hooks/heartbeat.sh bloqueia" "bloqueia" "$(decide Write "$CASA/.dgclaw/ext/alive/hooks/heartbeat.sh")"
igual ".dgclaw/self-crons.json bloqueia" "bloqueia" "$(decide Edit "$CASA/.dgclaw/self-crons.json")"
igual ".dgclaw/logs bloqueia" "bloqueia" "$(decide Write "$CASA/.dgclaw/logs/x.log")"
igual ".claude/settings.local.json (disableAllHooks) bloqueia" "bloqueia" "$(decide Write "$CASA/.claude/settings.local.json")"
igual ".claude/settings.json bloqueia" "bloqueia" "$(decide Write "$CASA/.claude/settings.json")"
igual ".claude/skills bloqueia" "bloqueia" "$(decide Write "$CASA/.claude/skills/x/SKILL.md")"
igual ".codex/ bloqueia" "bloqueia" "$(decide Write "$CASA/.codex/config.toml")"
igual ".plataforma/dgchat.mcp.json (comando do MCP) bloqueia" "bloqueia" "$(decide Write "$CASA/.plataforma/dgchat.mcp.json")"
igual "arquivo de inicio do shell (.bashrc) bloqueia" "bloqueia" "$(decide Write "$CASA/.bashrc")"
igual "/tmp bloqueia" "bloqueia" "$(decide Write /tmp/rascunho.sh)"
igual "/var/tmp bloqueia" "bloqueia" "$(decide Write /var/tmp/rascunho.sh)"
ln -s "$CASA/.dgclaw/config.sh" "$CASA/MEMORY2.md"; : >"$CASA/.dgclaw/config.sh"
mv "$CASA/MEMORY.md" "$CASA/MEMORY.antigo" 2>/dev/null; ln -s "$CASA/.dgclaw/config.sh" "$CASA/MEMORY.md"
igual "MEMORY.md que virou atalho para o config.sh bloqueia" "bloqueia" "$(decide Write "$CASA/MEMORY.md")"
rm "$CASA/MEMORY.md" "$CASA/MEMORY2.md"
mv "$CASA/memory" "$CASA/memory.real"; ln -s "$CASA/.dgclaw" "$CASA/memory"
igual "memory/ que virou atalho para .dgclaw bloqueia" "bloqueia" "$(decide Write "$CASA/memory/config.sh")"
rm "$CASA/memory"; mv "$CASA/memory.real" "$CASA/memory"
ln -s "$CASA/.dgclaw" "$CASA/relatorios/dg"
igual "pasta liberada com atalho para .dgclaw bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/dg/config.sh")"
rm "$CASA/relatorios/dg"

echo "protegidos em qualquer profundidade (skills com gancho, config.sh, instrucoes), com e sem pastas"
mkdir -p "$CASA/relatorios/.claude/skills/x" "$CASA/memory/.claude/skills/x" "$CASA/a/b/.dgclaw" "$CASA/x"
printf '{"versao":1,"sem_bash":true,"escrita_so_em":["relatorios"]}\n' >"$DGCLAW_RESTRICOES"
igual "com pastas: relatorios/.claude/skills/x/SKILL.md bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/.claude/skills/x/SKILL.md")"
igual "com pastas: memory/.claude/skills/x/SKILL.md bloqueia" "bloqueia" "$(decide Write "$CASA/memory/.claude/skills/x/SKILL.md")"
igual "com pastas: SKILL.md fora de pasta oculta, dentro da pasta liberada, bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/skill/SKILL.md")"
igual "com pastas: SKILL.md em maiusculas/minusculas trocadas bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/sKiLl.Md")"
igual "com pastas: CLAUDE.md dentro da pasta liberada bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/CLAUDE.md")"
igual "com pastas: arquivo oculto dentro da pasta liberada bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/.mcp.json")"
igual "com pastas: .. que desvia para pasta oculta bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/x/../.claude/settings.json")"
igual "com pastas: barras duplas nao enganam" "bloqueia" "$(decide Write "$CASA//relatorios//.claude//skills/x/SKILL.md")"
igual "com pastas: relatorios normal continua passando" "libera" "$(decide Write "$CASA/relatorios/ok.md")"
printf '{"versao":1,"sem_bash":true,"escrita_so_em":null}\n' >"$DGCLAW_RESTRICOES"
echo "so protegidos (escrita_so_em nulo): libera o resto da casa e fecha a configuracao"
igual "so protegidos: pasta comum passa" "libera" "$(decide Write "$CASA/x/ok.md")"
igual "so protegidos: relatorios/.claude/skills/x/SKILL.md bloqueia" "bloqueia" "$(decide Write "$CASA/relatorios/.claude/skills/x/SKILL.md")"
igual "so protegidos: memory/.claude/skills/x/SKILL.md bloqueia" "bloqueia" "$(decide Write "$CASA/memory/.claude/skills/x/SKILL.md")"
igual "so protegidos: a/b/.dgclaw/config.sh bloqueia" "bloqueia" "$(decide Write "$CASA/a/b/.dgclaw/config.sh")"
igual "so protegidos: .dgclaw/config.sh na raiz bloqueia" "bloqueia" "$(decide Edit "$CASA/.dgclaw/config.sh")"
igual "so protegidos: x/CLAUDE.md bloqueia" "bloqueia" "$(decide Write "$CASA/x/CLAUDE.md")"
igual "so protegidos: x/CLAUDE.local.md bloqueia" "bloqueia" "$(decide Write "$CASA/x/CLAUDE.local.md")"
igual "so protegidos: x/AGENTS.md bloqueia" "bloqueia" "$(decide Write "$CASA/x/AGENTS.md")"
igual "so protegidos: .bashrc, .profile e .config bloqueiam" "bloqueia bloqueia bloqueia" "$(decide Write "$CASA/.bashrc") $(decide Write "$CASA/.profile") $(decide Write "$CASA/.config/a/b")"
igual "so protegidos: .git/hooks/pre-commit em repositorio dentro da casa bloqueia" "bloqueia" "$(decide Write "$CASA/x/.git/hooks/pre-commit")"
igual "so protegidos: AGENT.md na raiz (identidade) bloqueia" "bloqueia" "$(decide Write "$CASA/AGENT.md")"
ln -s "$CASA/.dgclaw" "$CASA/x/dg"
igual "so protegidos: atalho de pasta comum para .dgclaw bloqueia" "bloqueia" "$(decide Write "$CASA/x/dg/config.sh")"
rm "$CASA/x/dg"
igual "so protegidos: .. para fugir para .claude bloqueia" "bloqueia" "$(decide Write "x/../.claude/settings.json" "$CASA")"
igual "so protegidos: fora da casa e de /tmp (aqui a pasta de teste) bloqueia" "bloqueia" "$(decide Write "$FORA/solto.md")"
igual "so protegidos: a memoria continua livre" "libera" "$(decide Write "$CASA/memory/hoje.md")"

echo "fora da casa: so /tmp no modo so-protegidos; no modo com pastas, nada fora das pastas"
mkdir -p "$TMP/spool/cron"
ln -s "$TMP/spool/cron" "$CASA/x/atalho-cron"
printf '{"versao":1,"sem_bash":true,"escrita_so_em":null}\n' >"$DGCLAW_RESTRICOES"
igual "so protegidos: /var/spool/cron/crontabs/agente bloqueia" "bloqueia" "$(decide Write /var/spool/cron/crontabs/agente)"
igual "so protegidos: /etc/sudoers.d/x bloqueia" "bloqueia" "$(decide Write /etc/sudoers.d/x)"
igual "so protegidos: /opt/dgclaw/qualquer bloqueia" "bloqueia" "$(decide Write /opt/dgclaw/qualquer)"
igual "so protegidos: casa de outro usuario bloqueia" "bloqueia" "$(decide Write /home/outro/x)"
igual "so protegidos: atalho dentro da casa para fora (spool/cron) bloqueia" "bloqueia" "$(decide Write "$CASA/x/atalho-cron/agente")"
igual "so protegidos: /tmp/x passa" "libera" "$(decide Write /tmp/x)"
igual "so protegidos: dentro da casa passa" "libera" "$(decide Write "$CASA/relatorios/x")"
printf '{"versao":1,"sem_bash":true,"escrita_so_em":["relatorios"]}\n' >"$DGCLAW_RESTRICOES"
igual "com pastas: /var/spool/cron/crontabs/agente bloqueia" "bloqueia" "$(decide Write /var/spool/cron/crontabs/agente)"
igual "com pastas: /etc/sudoers.d/x bloqueia" "bloqueia" "$(decide Write /etc/sudoers.d/x)"
igual "com pastas: /tmp/x continua fechado" "bloqueia" "$(decide Write /tmp/x)"
igual "com pastas: pasta liberada passa" "libera" "$(decide Write "$CASA/relatorios/x")"

echo "sem restricao: libera tudo"
rm -f "$DGCLAW_RESTRICOES"
igual "gancho instalado e politica ausente bloqueia (nunca libera por falta do arquivo)" "bloqueia" "$(decide Write "$CASA/outra/x.md")"
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
out="$(printf 'isto nao e json' | roda_gancho)"
afirma "entrada que nao e JSON bloqueia" bash -c "printf '%s' '$out' | jq -e '.hookSpecificOutput.permissionDecision == \"deny\"'"
out="$(printf '{"tool_name":"Write","tool_input":{}}' | roda_gancho)"
afirma "pedido sem caminho bloqueia" bash -c "printf '%s' '$out' | jq -e '.hookSpecificOutput.permissionDecision == \"deny\"'"

echo "o agente nao muda a politica por variavel de ambiente (settings.local.json env)"
printf '{"versao":1,"escrita_so_em":["relatorios"]}\n' >"$DGCLAW_RESTRICOES"
ent="$(jq -nc --arg c "$CASA" --arg f "$CASA/outra/x.md" '{tool_name:"Write",cwd:$c,tool_input:{file_path:$f}}')"
out="$(printf '%s' "$ent" | env DGCLAW_RESTRICOES=/nao/existe DGCLAW_WORKSPACE=/nao/existe/casa node "$GANCHO" --restricoes "$DGCLAW_RESTRICOES" --casa "$CASA")"
afirma "DGCLAW_RESTRICOES e DGCLAW_WORKSPACE apontando para o vazio nao liberam" bash -c "printf '%s' '$out' | jq -e '.hookSpecificOutput.permissionDecision == \"deny\"'"
out="$(printf '%s' "$ent" | env DGCLAW_RESTRICOES="$DGCLAW_RESTRICOES" DGCLAW_WORKSPACE="$CASA" node "$GANCHO")"
afirma "sem argumentos valem os caminhos de producao (aqui ausentes): bloqueia" bash -c "printf '%s' '$out' | jq -e '.hookSpecificOutput.permissionDecision == \"deny\"'"
afirma "o comando registrado limpa o ambiente (env -i), entao nem NODE_OPTIONS chega" grep -q 'env -i' "$REPO/lib/restricoes.sh"

fim
