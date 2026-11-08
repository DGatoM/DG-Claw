#!/usr/bin/env bash
# Restricoes ao LIGAR um container que ja existe (iniciar e reiniciar): tudo sob a trava do agente e ANTES de ligar.
# Regenera managed-settings.json e runner.json a partir do restricoes.json, confere o label da imagem do container
# e so entao liga. Falha fecha: nada de ligar com arquivo permissivo velho (docs/RESTRICOES-DO-AGENTE.md).
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

R_DIR() { printf '%s/agentes/%s/runner' "$LIB" "$1"; }
criar_agente ana --nome "Ana"
RS="$(R_DIR ana)/restricoes.json"; MS="$(R_DIR ana)/managed-settings.json"; RJ="$(R_DIR ana)/runner.json"
NS_MS="$STUB_ESTADO/no-start-managed-settings.json"; NS_RJ="$STUB_ESTADO/no-start-runner.json"
LABEL='image inspect .* \.Labels'
# linha do log em que aparece o padrao (a primeira)
linha() { grep -n -m1 -- "$1" "$STUB_LOG" | cut -d: -f1; }
# antes <padrao-a> <padrao-b>: os dois aparecem no log e a vem antes de b
antes() { local a b; a="$(linha "$1")"; b="$(linha "$2")"; [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; }
sem_start() { ! grep -q '^podman start ' "$STUB_LOG"; }
parado() { echo exited >"$STUB_ESTADO/c-dgclaw-ana"; }

echo "Monitor sai negado junto com o Bash, nos dois arquivos"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1; igual "restricoes --sem-bash sim aplica" "0" "$?"
afirma "managed-settings nega Monitor" jq -e '.permissions.deny | index("Monitor") != null' "$MS"
afirma "runner.json nega Monitor" jq -e '.config.denyTools | index("Monitor") != null' "$RJ"
afirma "e o Bash junto" jq -e '.permissions.deny | index("Bash") != null' "$MS"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
nega "sem a trava do Bash, Monitor nao fica negado" jq -e '(.permissions.deny // []) | index("Monitor") != null' "$MS"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1

echo "iniciar com managed-settings ausente, '{}' ou invalido: regenera ANTES de ligar"
for estrago in ausente vazio invalido; do
    parado
    case "$estrago" in
        ausente) rm -f "$MS" ;;
        vazio) rm -f "$MS"; printf '{}' >"$MS" ;;
        invalido) rm -f "$MS"; printf 'isto nao e json' >"$MS" ;;
    esac
    jq 'del(.config.denyTools)' "$RJ" >"$TMP/rj.novo" && rm -f "$RJ" && cp "$TMP/rj.novo" "$RJ"
    : >"$STUB_LOG"; rm -f "$NS_MS" "$NS_RJ"
    dgclaw agente iniciar ana >"$TMP/l1.txt" 2>&1; igual "$estrago: iniciar sai com 0" "0" "$?"
    afirma "$estrago: na hora da partida o managed-settings ja tinha o gancho e o Monitor" jq -e '(.hooks.PreToolUse | length) == 1 and (.permissions.deny | index("Monitor") != null)' "$NS_MS"
    afirma "$estrago: na hora da partida o runner.json ja negava o Bash" jq -e '.config.denyTools | index("Bash") != null' "$NS_RJ"
    igual "$estrago: o agente ficou ligado" "running" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
done

echo "restricoes.json invalido ou link: nao liga, falha"
dgclaw agente parar ana >/dev/null 2>&1
cp "$RS" "$TMP/rs.bom"
rm -f "$RS"; printf 'lixo' >"$RS"
: >"$STUB_LOG"
dgclaw agente iniciar ana >"$TMP/l2.txt" 2>&1; nega "JSON invalido: iniciar falha" test "$?" -eq 0
afirma "JSON invalido: nao chamou podman start" sem_start
igual "JSON invalido: continua parado" "exited" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
afirma "JSON invalido: a mensagem fala do arquivo" grep -q 'restricoes.json' "$TMP/l2.txt"
rm -f "$RS"; ln -s "$TMP/rs.bom" "$RS"
: >"$STUB_LOG"
dgclaw agente iniciar ana >"$TMP/l2.txt" 2>&1; nega "link: iniciar falha" test "$?" -eq 0
afirma "link: nao chamou podman start" sem_start
rm -f "$RS"; cp "$TMP/rs.bom" "$RS"; chmod 444 "$RS"

echo "imagem sem o label: nao liga e manda recriar"
touch "$STUB_ESTADO/sem-label"
: >"$STUB_LOG"
dgclaw agente iniciar ana >"$TMP/l3.txt" 2>&1; nega "iniciar falha" test "$?" -eq 0
afirma "nao chamou podman start" sem_start
afirma "manda recriar" grep -q 'dgclaw agente recriar ana' "$TMP/l3.txt"
igual "continua parado" "exited" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
rm -f "$STUB_ESTADO/sem-label"

echo "ordem do iniciar: regenerar e conferir o label antes do start; conferencia de dentro depois"
rm -f "$MS"
: >"$STUB_LOG"
dgclaw agente iniciar ana >"$TMP/l4.txt" 2>&1; igual "iniciar sai com 0" "0" "$?"
afirma "conferiu o label da imagem" grep -q "$LABEL" "$STUB_LOG"
afirma "o label foi conferido antes do start" antes "$LABEL" '^podman start '
afirma "a conferencia de dentro (readlink) veio depois do start" antes '^podman start ' 'exec dgclaw-ana readlink'
nega "sem marcador de suporte no fim" test -e "$(R_DIR ana)/restricoes-suporte.pendente"

echo "reiniciar: regenera antes de reiniciar o runner, e falha fechado"
rm -f "$MS"; printf '{}' >"$MS"
jq 'del(.config.denyTools)' "$RJ" >"$TMP/rj.novo" && rm -f "$RJ" && cp "$TMP/rj.novo" "$RJ"
: >"$STUB_LOG"
dgclaw agente reiniciar ana >"$TMP/l5.txt" 2>&1; igual "reiniciar sai com 0" "0" "$?"
afirma "managed-settings regenerado com o Monitor" jq -e '.permissions.deny | index("Monitor") != null' "$MS"
afirma "runner.json regenerado" jq -e '.config.denyTools | index("Bash") != null' "$RJ"
afirma "label conferido antes de reiniciar o runner" antes "$LABEL" 'systemctl restart dgclaw-runner'
touch "$STUB_ESTADO/sem-label"
: >"$STUB_LOG"
dgclaw agente reiniciar ana >"$TMP/l6.txt" 2>&1; nega "sem label: reiniciar falha" test "$?" -eq 0
nega "sem label: nao reiniciou o runner" grep -q 'systemctl restart dgclaw-runner' "$STUB_LOG"
afirma "sem label: manda recriar" grep -q 'dgclaw agente recriar ana' "$TMP/l6.txt"
rm -f "$STUB_ESTADO/sem-label"
rm -f "$RS"; printf 'lixo' >"$RS"
: >"$STUB_LOG"
dgclaw agente reiniciar ana >"$TMP/l7.txt" 2>&1; nega "restricoes.json invalido: reiniciar falha" test "$?" -eq 0
nega "restricoes.json invalido: nao reiniciou o runner" grep -q 'systemctl restart dgclaw-runner' "$STUB_LOG"
rm -f "$RS"; cp "$TMP/rs.bom" "$RS"; chmod 444 "$RS"

echo "conferencia pos-inicio continua valendo como segunda camada"
parado
touch "$STUB_ESTADO/sem-suporte"
: >"$STUB_LOG"
dgclaw agente iniciar ana >"$TMP/l8.txt" 2>&1; nega "imagem sem o link por dentro: iniciar falha" test "$?" -eq 0
afirma "e o container foi parado" grep -q '^podman stop dgclaw-ana' "$STUB_LOG"
afirma "o marcador de suporte ficou" test -e "$(R_DIR ana)/restricoes-suporte.pendente"
rm -f "$STUB_ESTADO/sem-suporte"

echo "agente sem restricoes.json segue igual"
criar_agente bob --nome "Bob"
nega "bob nao tem restricoes.json" test -e "$(R_DIR bob)/restricoes.json"
echo exited >"$STUB_ESTADO/c-dgclaw-bob"
: >"$STUB_LOG"
dgclaw agente iniciar bob >"$TMP/l9.txt" 2>&1; igual "iniciar sai com 0" "0" "$?"
afirma "ligou" grep -q '^podman start dgclaw-bob' "$STUB_LOG"
nega "nao conferiu label" grep -q "$LABEL" "$STUB_LOG"
: >"$STUB_LOG"
dgclaw agente reiniciar bob >/dev/null 2>&1; igual "reiniciar sai com 0" "0" "$?"
nega "nao conferiu label" grep -q "$LABEL" "$STUB_LOG"

fim
