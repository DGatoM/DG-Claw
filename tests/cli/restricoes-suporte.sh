#!/usr/bin/env bash
# Restricoes: o container precisa carregar a configuracao administrada antes de o comando dizer que valem,
# e a leitura do provedor das sessoes nunca pode travar o comando (docs/RESTRICOES-DO-AGENTE.md).
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

R_DIR() { printf '%s/agentes/%s/runner' "$LIB" "$1"; }
criar_agente ana --nome "Ana"
MS="$(R_DIR ana)/managed-settings.json"
PEND="$(R_DIR ana)/restricoes.pendente"; PEND_SUP="$(R_DIR ana)/restricoes-suporte.pendente"
EST="$LIB/agentes/ana/home/.plataforma"; mkdir -p "$EST/sessoes"

echo "rodando com suporte: confere dentro do container e segue como sempre"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o1.txt" 2>&1; igual "sai com 0" "0" "$?"
afirma "conferiu o link da configuracao administrada dentro do container" grep -q 'exec dgclaw-ana readlink /etc/claude-code/managed-settings.json' "$STUB_LOG"
afirma "e o conteudo visto la dentro" grep -q 'exec dgclaw-ana cat /etc/claude-code/managed-settings.json' "$STUB_LOG"
afirma "e o script do gancho na imagem" grep -q 'exec dgclaw-ana test ' "$STUB_LOG"
afirma "reiniciou o runner" grep -q 'systemctl restart dgclaw-runner' "$STUB_LOG"
nega "nao ficou marcador de suporte" test -e "$PEND_SUP"
nega "nem de reinicio" test -e "$PEND"

echo "rodando sem suporte (imagem antiga): falha, nao diz que aplicou, orienta a recriar"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
touch "$STUB_ESTADO/sem-suporte"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o2.txt" 2>&1; rc=$?
nega "o comando falha" test "$rc" -eq 0
nega "nao diz que aplicou" grep -qi 'aplicad' "$TMP/o2.txt"
nega "nem que reiniciou o runner" grep -q 'runner do agente ana reiniciado' "$TMP/o2.txt"
afirma "diz que a imagem e antiga" grep -q 'imagem' "$TMP/o2.txt"
afirma "diz que as restricoes NAO valem" grep -q 'NAO valem' "$TMP/o2.txt"
afirma "manda recriar com o comando do CLI" grep -q 'dgclaw agente recriar ana' "$TMP/o2.txt"
afirma "o marcador de reinicio continua" test -e "$PEND"
afirma "o container foi parado (agente com trava nao roda sem ela)" grep -q '^podman stop dgclaw-ana' "$STUB_LOG"
igual "e ficou parado" "exited" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
rm -f "$STUB_ESTADO/sem-suporte"
: >"$STUB_LOG"
dgclaw agente iniciar ana >"$TMP/o2.txt" 2>&1; igual "depois de recriar, ligar de novo funciona" "0" "$?"
igual "e o agente fica ligado" "running" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
nega "e o marcador de reinicio saiu (o runner subiu com os arquivos novos)" test -e "$PEND"

echo "conteudo diferente e script ausente tambem reprovam"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
touch "$STUB_ESTADO/ms-diferente"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o3.txt" 2>&1; nega "conteudo visto la dentro diferente: falha" test "$?" -eq 0
rm -f "$STUB_ESTADO/ms-diferente"; echo running >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
touch "$STUB_ESTADO/sem-script-gancho"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o3.txt" 2>&1; nega "sem o script do gancho na imagem: falha" test "$?" -eq 0
rm -f "$STUB_ESTADO/sem-script-gancho"; echo running >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
touch "$STUB_ESTADO/sem-suporte"
: >"$STUB_LOG"
dgclaw agente restricoes ana --escrita-livre >"$TMP/o3.txt" 2>&1; igual "sem restricao nenhuma, nao confere nem falha" "0" "$?"
nega "nem entra no container para isso" grep -q 'readlink' "$STUB_LOG"
rm -f "$STUB_ESTADO/sem-suporte"

echo "parado: grava o marcador e confere quando o agente ligar"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
touch "$STUB_ESTADO/sem-suporte"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o4.txt" 2>&1; igual "parado: o comando sai com 0" "0" "$?"
nega "nao tentou entrar no container" grep -q 'exec dgclaw-ana readlink' "$STUB_LOG"
afirma "o marcador de suporte foi gravado" test -e "$PEND_SUP"
igual "marcador do root" "0:0" "$(stat -c %u:%g "$PEND_SUP" 2>/dev/null || echo 0:0)"
afirma "avisa que a conferencia sera feita quando ligar" grep -q 'quando o agente ligar\|quando ele ligar' "$TMP/o4.txt"
: >"$STUB_LOG"
dgclaw agente iniciar ana >"$TMP/o5.txt" 2>&1; nega "iniciar com imagem sem suporte falha" test "$?" -eq 0
afirma "o container foi parado (a trava e obrigatoria)" grep -q '^podman stop dgclaw-ana' "$STUB_LOG"
igual "e ficou parado" "exited" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
afirma "manda recriar" grep -q 'dgclaw agente recriar ana' "$TMP/o5.txt"
nega "nao diz que iniciou" grep -q 'agente ana iniciado' "$TMP/o5.txt"
afirma "o marcador continua" test -e "$PEND_SUP"
rm -f "$STUB_ESTADO/sem-suporte"
dgclaw agente iniciar ana >"$TMP/o5.txt" 2>&1; igual "com a imagem boa, iniciar funciona" "0" "$?"
igual "e o agente fica ligado" "running" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
nega "o marcador sai" test -e "$PEND_SUP"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"; touch "$STUB_ESTADO/sem-suporte"
dgclaw agente restricoes ana --sem-bash nao --escrita-livre >/dev/null 2>&1
dgclaw agente iniciar ana >/dev/null 2>&1; igual "sem restricao ligada, iniciar nem confere" "0" "$?"
rm -f "$STUB_ESTADO/sem-suporte"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1

echo "provedor: FIFO com o agente parado nao trava o comando"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
mkfifo "$EST/provedor.json"
timeout 20 "$CLI" agente restricoes ana --sem-bash sim >"$TMP/o6.txt" 2>&1; rc=$?
igual "terminou sem estourar o prazo e saiu com 0" "0" "$rc"
afirma "o provedor ficou em duvida" grep -q 'nao consegui ler' "$TMP/o6.txt"
afirma "e os arquivos novos estao no lugar" jq -e '.hooks.PreToolUse | length == 1' "$MS"
rm -f "$EST/provedor.json"

echo "provedor: FIFO com o agente rodando tambem nao trava"
echo running >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
mkfifo "$EST/provedor.json"
: >"$STUB_LOG"
timeout 20 "$CLI" agente restricoes ana --sem-bash sim >"$TMP/o7.txt" 2>&1; rc=$?
igual "terminou e saiu com 0" "0" "$rc"
afirma "em duvida" grep -q 'nao consegui ler' "$TMP/o7.txt"
afirma "e reiniciou o runner" grep -q 'systemctl restart dgclaw-runner' "$STUB_LOG"
rm -f "$EST/provedor.json"

echo "provedor: com o agente rodando a leitura passa pelo usuario agente, dentro do container"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
printf '{"provedor":"codex"}\n' >"$EST/provedor.json"
mkdir -p "$EST/sessoes/p1"; printf '{"provedor":"claude"}\n' >"$EST/sessoes/p1/provedor.json"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o8.txt" 2>&1
afirma "chamou podman exec --user agente node -e" grep -q '^podman exec --user agente dgclaw-ana node -e ' "$STUB_LOG"
afirma "com a pasta .plataforma da casa como argumento" grep -q '/home/agente/\.plataforma$' "$STUB_LOG"
afirma "avisa a principal em Codex" grep -q 'principal: Codex' "$TMP/o8.txt"
nega "a paralela em Claude nao entra no aviso" grep -q 'paralela p1' "$TMP/o8.txt"
rm -rf "$EST/provedor.json" "$EST/sessoes/p1"

echo "provedor: arquivo enorme ou link viram duvida (rodando e parado)"
head -c 70000 /dev/zero | tr '\0' ' ' >"$EST/provedor.json"
mkdir -p "$EST/sessoes/p2"; ln -s "$EST/provedor.json" "$EST/sessoes/p2/provedor.json"
for estado in running exited; do
    echo "$estado" >"$STUB_ESTADO/c-dgclaw-ana"
    dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
    dgclaw agente restricoes ana --sem-bash sim >"$TMP/o9.txt" 2>&1; igual "$estado: sai com 0" "0" "$?"
    afirma "$estado: arquivo enorme na principal vira duvida" grep -q 'principal: nao consegui ler' "$TMP/o9.txt"
    afirma "$estado: link na paralela vira duvida" grep -q 'paralela p2: nao consegui ler' "$TMP/o9.txt"
done
echo running >"$STUB_ESTADO/c-dgclaw-ana"

echo "politica remota (conta de organizacao claude.ai): vence a local, entao a conferencia falha e o container para"
RH="$LIB/agentes/ana/home/.claude/remote-settings.json"
for caso in remota-com-chave remota-link remota-invalida exec-node-nao; do
    echo running >"$STUB_ESTADO/c-dgclaw-ana"
    dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
    touch "$STUB_ESTADO/$caso"
    : >"$STUB_LOG"
    dgclaw agente restricoes ana --sem-bash sim >"$TMP/o10.txt" 2>&1; rc=$?
    nega "$caso: o comando falha" test "$rc" -eq 0
    nega "$caso: nao diz que aplicou" grep -qi 'aplicad' "$TMP/o10.txt"
    afirma "$caso: leu o arquivo dentro da caixa como agente" grep -q ' /home/agente/\.claude/remote-settings\.json$' "$STUB_LOG"
    afirma "$caso: diz que as restricoes NAO valem" grep -q 'NAO valem' "$TMP/o10.txt"
    afirma "$caso: fala da organizacao do claude.ai" grep -q 'organizacao do claude.ai' "$TMP/o10.txt"
    afirma "$caso: orienta conta pessoal ou merge e reiniciar" grep -q 'managedSourcesBehavior.*merge.*dgclaw agente reiniciar ana' "$TMP/o10.txt"
    nega "$caso: nao manda recriar a imagem" grep -q 'agente recriar' "$TMP/o10.txt"
    afirma "$caso: parou o container" grep -q '^podman stop dgclaw-ana' "$STUB_LOG"
    igual "$caso: ficou parado" "exited" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
    rm -f "$STUB_ESTADO/$caso"
done
echo "politica remota: ligar de novo com a politica presente tambem para"
touch "$STUB_ESTADO/remota-com-chave"
dgclaw agente iniciar ana >"$TMP/o11.txt" 2>&1; nega "iniciar com politica remota falha" test "$?" -eq 0
igual "e o container fica parado" "exited" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
rm -f "$STUB_ESTADO/remota-com-chave"
echo "politica remota: ausente, vazia ou com merge passam"
for caso in nenhuma remota-vazia remota-merge; do
    echo running >"$STUB_ESTADO/c-dgclaw-ana"
    dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
    [ "$caso" = nenhuma ] || touch "$STUB_ESTADO/$caso"
    dgclaw agente restricoes ana --sem-bash sim >"$TMP/o12.txt" 2>&1; igual "$caso: aplica e sai com 0" "0" "$?"
    igual "$caso: o container continua ligado" "running" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
    rm -f "$STUB_ESTADO/$caso"
done
echo running >"$STUB_ESTADO/c-dgclaw-ana"
rm -f "$RH"

fim
