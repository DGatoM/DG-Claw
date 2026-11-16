#!/usr/bin/env bash
# Restricoes: as rotinas autonomas que rodam o Claude fora do runner (reflexao headless, post, comentarios,
# consolidacao) conferem a conta antes de rodar e recebem as ferramentas negadas. Um `claude` falso no PATH
# grava cada chamada; a recusa tem que acontecer SEM chamar o motor (docs/RESTRICOES-DO-AGENTE.md).
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASSOU=0; FALHOU=0
ok() { PASSOU=$((PASSOU + 1)); printf '  ok     %s\n' "$1"; }
nok() { FALHOU=$((FALHOU + 1)); printf '  FALHOU %s\n' "$1"; }
afirma() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else nok "$d"; fi; }
nega() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then nok "$d"; else ok "$d"; fi; }

command -v node >/dev/null 2>&1 || { echo "  node nao esta instalado aqui; o teste nao rodou." >&2; exit 1; }
# O dist do runner: usa o que o ambiente indicar (DGCLAW_RUNNER_DIST); sem ele, compila o runner do commit
# atual numa pasta temporaria (sem node_modules e sem dist, como o testes_runner de tests/rodar.sh), para
# nunca gravar runner/dist no working tree.
DIST="${DGCLAW_RUNNER_DIST:-}"
if [ -z "$DIST" ] || [ ! -f "$DIST/conferir-conta-cli.js" ]; then
    command -v npm >/dev/null 2>&1 || { echo "  falta o npm no PATH; instale o Node 22 ou aponte DGCLAW_RUNNER_DIST para um runner/dist ja compilado." >&2; exit 1; }
    mkdir -p "$TMP/runner"
    tar -C "$REPO/runner" --exclude=node_modules --exclude=dist -cf - . | tar -C "$TMP/runner" -xf -
    (
        cd "$TMP/runner" || exit 1
        npm ci --ignore-scripts --no-audit --no-fund >"$TMP/npm.log" 2>&1 && npm run build >>"$TMP/npm.log" 2>&1
    ) || { echo "  nao consegui compilar o runner; fim do log:" >&2; tail -20 "$TMP/npm.log" >&2; exit 1; }
    DIST="$TMP/runner/dist"
    [ -f "$DIST/conferir-conta-cli.js" ] || { echo "  o build nao gerou $DIST/conferir-conta-cli.js" >&2; exit 1; }
fi
export DGCLAW_RUNNER_DIST="$DIST"

# Claude falso: "auth status" devolve $FALSO_CONTA; qualquer outra chamada grava os argumentos e sai com 1
# (assim a reflexao nao dispara o restart-fresh).
mkdir -p "$TMP/bin"
cat >"$TMP/bin/claude" <<'SH'
#!/bin/bash
if [ "$1" = "auth" ]; then printf '%s\n' "${FALSO_CONTA:-}"; exit 0; fi
# A rotina de comentarios confere no --help que a CLI conhece as flags de restricao antes de rodar.
if [ "$1" = "--help" ]; then echo "--allowedTools --disallowedTools --tools dontAsk --strict-mcp-config --disable-slash-commands --setting-sources --settings"; exit 0; fi
printf '%s\n' "$*" >>"$FALSO_CHAMADAS"
# Um argumento por linha, entre colchetes, para conferir argumentos vazios (como --tools "").
{ printf 'CHAMADA'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >>"$FALSO_CHAMADAS.argv"
exit 1
SH
chmod +x "$TMP/bin/claude"

WS="$TMP/ws"; PLUGIN="$TMP/plugin"; CASA="$TMP/casa"; ETC="$TMP/etc"
mkdir -p "$WS/.dgclaw/logs" "$PLUGIN/scripts" "$CASA/.claude" "$ETC"
cp -r "$REPO/scripts/_lib" "$PLUGIN/scripts/_lib"
printf '#!/bin/bash\nexit 0\n' >"$PLUGIN/scripts/powers.py"
for s in notify-owner.sh ext-event.sh preparar-scrape.sh; do printf '#!/bin/bash\nexit 0\n' >"$PLUGIN/scripts/$s"; done
printf '#!/bin/bash\necho PREAMBULO\n' >"$PLUGIN/scripts/untrusted.py"
# powers.py e untrusted.py sao chamados com python3: viram scripts python de uma linha.
printf 'import sys\nsys.exit(0)\n' >"$PLUGIN/scripts/powers.py"
printf 'print("PREAMBULO")\n' >"$PLUGIN/scripts/untrusted.py"
{
    echo "export DGCLAW_WORKSPACE='$WS'"
    echo "export DGCLAW_SLUG='teste'"
    echo "export DGCLAW_PLUGIN_ROOT='$PLUGIN'"
    echo "export DGCLAW_TZ='America/Sao_Paulo'"
    echo "export DGCLAW_PROVEDOR='claude'"
} >"$WS/.dgclaw/config.sh"
CFG="$WS/.dgclaw/config.sh"
CHAMADAS="$TMP/chamadas.log"
CONTA_PESSOAL='{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'
CONTA_ORG='{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","orgName":"Org Exemplo"}'

printf '{"versao":1,"sem_bash":true,"sem_enviar_arquivo":false,"escrita_so_em":["relatorios"]}\n' >"$TMP/restricoes.json"
printf '{"config":{"denyTools":["Bash","BashOutput","KillShell","Monitor"]}}\n' >"$ETC/runner.json"

# rotina <qual> <conta> <com-restricao sim|nao>: roda e deixa o codigo em RC
rotina() {
    local qual="$1" conta="$2" com="$3" restr="$TMP/restricoes.json"
    [ "$com" = sim ] || restr="$TMP/nao-existe.json"
    : >"$CHAMADAS"; rm -f "$WS"/.dgclaw/logs/*.log
    RC=0
    local cmd
    case "$qual" in
        reflexao) cmd=(bash "$REPO/scripts/reflection.sh" "$CFG") ;;
        post) cmd=(bash "$REPO/scripts/cron/dgclaw-post.sh" "$CFG" 8h) ;;
        comentarios) cmd=(bash "$REPO/scripts/cron/dgclaw-comentarios.sh" "$CFG") ;;
        consolidacao) cmd=(bash "$REPO/scripts/consolidate.sh" "$CFG") ;;
    esac
    env PATH="$TMP/bin:$PATH" HOME="$CASA" FALSO_CONTA="$conta" FALSO_CHAMADAS="$CHAMADAS" \
        RUNNER_RESTRICOES_FILE="$restr" RUNNER_AGENT_FILE="$ETC/runner.json" DGCLAW_RUNNER_DIST="$DIST" \
        DGCLAW_REFLECT_MODE=headless DGCLAW_REFLECT_SEMPRE=1 DGCLAW_REFLECT_DATE=2026-11-12 \
        "${cmd[@]}" >"$TMP/saida.txt" 2>&1 || RC=$?
}
chamou() { [ -s "$CHAMADAS" ]; }
log_geral() { cat "$WS"/.dgclaw/logs/*.log "$TMP/saida.txt" 2>/dev/null; }

for qual in reflexao post comentarios consolidacao; do
    echo "$qual: restricao ativa e conta de organizacao"
    rotina "$qual" "$CONTA_ORG" sim
    nega "$qual: nao chamou o motor" chamou
    nega "$qual: sai com codigo diferente de 0" test "$RC" -eq 0
    afirma "$qual: o log diz RECUSADA, o que falhou e o que fazer" bash -c "$(declare -f log_geral); WS='$WS'; TMP='$TMP'; log_geral | grep -q 'RECUSADA' && log_geral | grep -q 'organização Team/Enterprise' && log_geral | grep -q 'O que fazer'"

    echo "$qual: restricao ativa e conta pessoal"
    rotina "$qual" "$CONTA_PESSOAL" sim
    afirma "$qual: chamou o motor" chamou
    afirma "$qual: com as ferramentas negadas do runner" bash -c "grep -q -- '--disallowedTools Bash --disallowedTools BashOutput --disallowedTools KillShell --disallowedTools Monitor' '$CHAMADAS'"

    echo "$qual: sem restricao"
    rotina "$qual" "$CONTA_ORG" nao
    afirma "$qual: chamou o motor, mesmo com conta de organizacao" chamou
    # A sessao de comentarios ja nasce com as suas proprias ferramentas negadas (sem Bash etc.); o que nao pode
    # aparecer sem restricao sao as negadas do runner.json.
    if [ "$qual" = comentarios ]; then
        nega "$qual: sem as ferramentas negadas do runner" bash -c "grep -q -- '--disallowedTools BashOutput' '$CHAMADAS'"
    else
        nega "$qual: sem nenhuma ferramenta negada" bash -c "grep -q disallowedTools '$CHAMADAS'"
    fi
done

echo "falha fechada: restricoes.json ilegivel, conta ilegivel e conferidor ausente"
printf 'isto nao e json\n' >"$TMP/restricoes.json"
rotina reflexao "$CONTA_PESSOAL" sim
nega "restricoes.json invalido: nao chamou o motor" chamou
nega "restricoes.json invalido: codigo diferente de 0" test "$RC" -eq 0
printf '{"versao":1,"sem_bash":true,"sem_enviar_arquivo":false,"escrita_so_em":null}\n' >"$TMP/restricoes.json"
rotina post "" sim
nega "saida de conta vazia: nao chamou o motor" chamou
nega "saida de conta vazia: codigo diferente de 0" test "$RC" -eq 0
printf '{"config":{}}\n' >"$ETC/runner.json"
rotina post "$CONTA_PESSOAL" sim
afirma "runner.json sem denyTools: roda, sem ferramentas negadas" chamou
printf 'nao e json\n' >"$ETC/runner.json"
rotina post "$CONTA_PESSOAL" sim
nega "runner.json ilegivel: nao chamou o motor" chamou
nega "runner.json ilegivel: codigo diferente de 0" test "$RC" -eq 0
printf '{"config":{"denyTools":["Bash"]}}\n' >"$ETC/runner.json"
RC=0; : >"$CHAMADAS"
env PATH="$TMP/bin:$PATH" HOME="$CASA" FALSO_CONTA="$CONTA_PESSOAL" FALSO_CHAMADAS="$CHAMADAS" RUNNER_RESTRICOES_FILE="$TMP/restricoes.json" \
    RUNNER_AGENT_FILE="$ETC/runner.json" DGCLAW_RUNNER_DIST="$TMP/sem-runner" HOME="$CASA" \
    bash -c ". '$REPO/scripts/_lib/restricoes-rotina.sh'; restricoes_conferir_rotina teste '$TMP/l.log'" 2>"$TMP/err.txt" || RC=$?
nega "sem o conferidor compilado (e sem o da imagem): recusa" test "$RC" -eq 0
afirma "sem o conferidor: o motivo diz o que fazer" grep -q 'O que fazer' "$TMP/err.txt"

echo "reflexao com indice e working-memory: o eco do passado so roda depois da conferencia"
printf '{"versao":1,"sem_bash":true,"sem_enviar_arquivo":false,"escrita_so_em":null}\n' >"$TMP/restricoes.json"
printf '{"config":{"denyTools":["Bash"]}}\n' >"$ETC/runner.json"
mkdir -p "$PLUGIN/scripts/memory_index" "$WS/.dgclaw/memory_index"
cp "$REPO"/scripts/memory_index/*.py "$PLUGIN/scripts/memory_index/"
: >"$WS/.dgclaw/memory_index/chunks.db"
printf 'Hoje conversei com a Marta sobre o projeto Aurora e o contrato novo.\n' >"$WS/working-memory.md"
rm -f "$CHAMADAS.argv"
rotina reflexao "$CONTA_ORG" sim
nega "eco: conta incompativel, nenhum claude foi chamado (nem o da busca de memoria)" chamou
nega "eco: conta incompativel, nenhuma chamada registrada com argumentos" test -s "$CHAMADAS.argv"
nega "eco: conta incompativel, a rotina sai com codigo diferente de 0" test "$RC" -eq 0
rm -f "$CHAMADAS.argv"
rotina reflexao "$CONTA_PESSOAL" sim
afirma "eco: conta compativel, a busca de memoria chamou o claude" grep -q 'Voce e detector de saliencia' "$CHAMADAS.argv"
afirma "eco: a busca de memoria roda sem ferramentas (--tools vazio)" grep -q '\[--tools\] \[\]' "$CHAMADAS.argv"
afirma "eco: a busca de memoria roda sem MCP (--strict-mcp-config)" grep -q '\[--strict-mcp-config\]' "$CHAMADAS.argv"
afirma "eco: a busca de memoria roda um turno so (--max-turns 1)" grep -q '\[--max-turns\] \[1\]' "$CHAMADAS.argv"
rm -rf "$PLUGIN/scripts/memory_index" "$WS/.dgclaw/memory_index" "$WS/working-memory.md" "$CHAMADAS.argv"

echo
echo "Restricoes das rotinas autonomas: $PASSOU ok, $FALHOU falha(s)."
[ "$FALHOU" -eq 0 ]
