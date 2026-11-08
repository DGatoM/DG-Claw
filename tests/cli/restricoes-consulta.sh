#!/usr/bin/env bash
# Restricoes: a falha de suporte deixa o agente parado tambem no comando `restricoes`, nenhuma orientacao de
# recuperacao manda rodar a consulta (que so imprime), e a consulta separa o configurado do que esta valendo
# (docs/RESTRICOES-DO-AGENTE.md).
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

R="$LIB/agentes/ana/runner"
EST="$LIB/agentes/ana/home/.plataforma"
criar_agente ana --nome "Ana"
mkdir -p "$EST/sessoes"
# mostra o estado de todos os arquivos da pasta do agente (nome, tamanho, data) para provar que a consulta nao grava
fotografia() { find "$LIB/agentes/ana" -printf '%p %s %T@\n' | sort; }

echo "aplicar com o agente ligado e imagem sem suporte: o container e parado (fail-closed)"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
echo running >"$STUB_ESTADO/c-dgclaw-ana"
touch "$STUB_ESTADO/sem-suporte"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o1.txt" 2>&1; rc=$?
nega "o comando falha" test "$rc" -eq 0
afirma "parou o container" grep -q '^podman stop dgclaw-ana' "$STUB_LOG"
igual "e ele ficou parado" "exited" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
afirma "diz que parou" grep -q 'Parei o container' "$TMP/o1.txt"
afirma "registrou no log das restricoes" grep -q 'aplicar:.*container parado' "$LIB/agentes/ana/restricoes.log"
afirma "deixou o marcador de suporte" test -e "$R/restricoes-suporte.pendente"
afirma "manda recriar com --forcar (o agente ficou parado)" grep -q 'dgclaw agente recriar ana --forcar' "$TMP/o1.txt"
afirma "e construir a imagem do servidor antes, se for o caso" grep -q 'dgclaw imagem construir --agora' "$TMP/o1.txt"
nega "nenhuma orientacao manda rodar a consulta sem opcoes" grep -qP 'dgclaw agente restricoes ana(?![\w-])(?! +--)' "$TMP/o1.txt"

echo "a consulta, com o agente parado e marcador de suporte, nao diz TRAVADO"
dgclaw agente restricoes ana >"$TMP/c0.txt" 2>&1; igual "sai com 0" "0" "$?"
afirma "mostra o que esta pendente" grep -q 'Pendente:.*conferencia de suporte pendente desde' "$TMP/c0.txt"
afirma "e o comando que resolve" grep -q 'dgclaw agente iniciar ana' "$TMP/c0.txt"
nega "nao diz TRAVADO" grep -q TRAVADO "$TMP/c0.txt"
afirma "diz AINDA NAO VALE" grep -q 'AINDA NAO VALE' "$TMP/c0.txt"

echo "recuperar: com a imagem boa, iniciar religa e limpa os marcadores"
rm -f "$STUB_ESTADO/sem-suporte"
dgclaw agente iniciar ana >"$TMP/o2.txt" 2>&1; igual "iniciar funciona" "0" "$?"
dgclaw agente reiniciar ana >/dev/null 2>&1; igual "reiniciar (agora ligado) tira tambem a migracao pendente" "0" "$?"
nega "sem marcador de suporte" test -e "$R/restricoes-suporte.pendente"
nega "e sem marcador de migracao" test -e "$R/restricoes-migracao.pendente"
nega "e sem marcador de reinicio" test -e "$R/restricoes.pendente"

echo "consulta normal (tudo certo): continua TRAVADO, sai com 0 e nao grava nada"
antes="$(fotografia)"
: >"$STUB_LOG"
dgclaw agente restricoes ana >"$TMP/c1.txt" 2>&1; igual "sai com 0" "0" "$?"
afirma "Bash TRAVADO" grep -q 'Bash (terminal): *TRAVADO' "$TMP/c1.txt"
nega "sem linha de pendencia" grep -q 'Pendente:' "$TMP/c1.txt"
nega "sem NAO VALE" grep -q 'NAO VALE' "$TMP/c1.txt"
nega "sem aviso de Codex" grep -q 'Codex:' "$TMP/c1.txt"
afirma "conferiu o suporte dentro do container" grep -q 'exec dgclaw-ana readlink' "$STUB_LOG"
nega "nao reiniciou nada" grep -q 'systemctl restart' "$STUB_LOG"
igual "nao gravou nada na pasta do agente" "$antes" "$(fotografia)"

echo "consulta com marcadores de pendencia: AINDA NAO VALE no lugar de TRAVADO"
printf 'reinicio do runner pendente desde 2026-11-08T10:00:00Z\n' >"$R/restricoes.pendente"
printf 'migracao do gancho antigo pendente desde 2026-11-08T10:01:00Z\n' >"$R/restricoes-migracao.pendente"
antes="$(fotografia)"
dgclaw agente restricoes ana >"$TMP/c2.txt" 2>&1; igual "sai com 0" "0" "$?"
nega "nao diz TRAVADO" grep -q TRAVADO "$TMP/c2.txt"
afirma "diz configurado, AINDA NAO VALE" grep -q 'Bash (terminal): *configurado, AINDA NAO VALE' "$TMP/c2.txt"
afirma "mostra o reinicio pendente e desde quando" grep -q 'Pendente:.*reinicio do runner pendente desde 2026-11-08T10:00:00Z' "$TMP/c2.txt"
afirma "e o comando que resolve (reiniciar)" grep -q 'dgclaw agente reiniciar ana' "$TMP/c2.txt"
afirma "mostra a migracao pendente e o comando (reparar)" grep -q 'migracao do gancho antigo pendente.*dgclaw agente reparar ana' "$TMP/c2.txt"
igual "nao gravou nada" "$antes" "$(fotografia)"
rm -f "$R/restricoes.pendente" "$R/restricoes-migracao.pendente"

echo "consulta com o container ligado e a imagem sem suporte: NAO VALE com o motivo"
touch "$STUB_ESTADO/sem-suporte"
dgclaw agente restricoes ana >"$TMP/c3.txt" 2>&1; igual "sai com 0" "0" "$?"
afirma "diz NAO VALE" grep -q 'NAO VALE:' "$TMP/c3.txt"
afirma "com o motivo" grep -q 'NAO VALE:.*nao existe ou nao e um link' "$TMP/c3.txt"
afirma "e o comando que resolve" grep -q 'dgclaw agente recriar ana' "$TMP/c3.txt"
nega "nao diz TRAVADO" grep -q TRAVADO "$TMP/c3.txt"
igual "a consulta nao para o agente" "running" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
rm -f "$STUB_ESTADO/sem-suporte"

echo "consulta com politica remota: NAO VALE com o motivo, com ou sem merge"
for caso in remota-com-chave remota-merge remota-merge-desliga; do
    touch "$STUB_ESTADO/$caso"
    dgclaw agente restricoes ana >"$TMP/c5.txt" 2>&1; igual "$caso: sai com 0" "0" "$?"
    afirma "$caso: diz NAO VALE com a politica remota" grep -q 'NAO VALE:.*politica administrada remota' "$TMP/c5.txt"
    afirma "$caso: orienta conta pessoal ou chave de API" grep -q 'conta pessoal (Pro ou Max) ou chave de API.*dgclaw agente reiniciar ana' "$TMP/c5.txt"
    nega "$caso: nao sugere mais o merge" grep -qi 'managedSourcesBehavior\|merge' "$TMP/c5.txt"
    nega "$caso: nao diz TRAVADO" grep -q TRAVADO "$TMP/c5.txt"
    igual "$caso: a consulta nao para o agente" "running" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
    rm -f "$STUB_ESTADO/$caso"
done
rm -f "$LIB/agentes/ana/home/.claude/remote-settings.json"

echo "consulta com o agente parado: diz que confere ao ligar"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
: >"$STUB_LOG"
dgclaw agente restricoes ana >"$TMP/c4.txt" 2>&1; igual "sai com 0" "0" "$?"
afirma "avisa que a conferencia sera feita ao ligar" grep -q 'quando ele ligar' "$TMP/c4.txt"
nega "nao entrou no container" grep -q 'exec dgclaw-ana' "$STUB_LOG"
echo running >"$STUB_ESTADO/c-dgclaw-ana"

echo "consulta com sessao em Codex: avisa que as travas nao valem la"
printf '{"provedor":"codex"}\n' >"$EST/provedor.json"
antes="$(fotografia)"
dgclaw agente restricoes ana >"$TMP/c5.txt" 2>&1; igual "sai com 0" "0" "$?"
afirma "mostra a sessao em Codex" grep -q 'Codex:.*principal: Codex' "$TMP/c5.txt"
afirma "e que as travas nao valem la" grep -q 'No Codex estas travas nao valem' "$TMP/c5.txt"
igual "nao gravou nada" "$antes" "$(fotografia)"
rm -f "$EST/provedor.json"

echo "sem restricao ligada: a consulta nao confere nem avisa"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
: >"$STUB_LOG"
dgclaw agente restricoes ana >"$TMP/c6.txt" 2>&1; igual "sai com 0" "0" "$?"
nega "nao entrou no container" grep -q 'exec dgclaw-ana' "$STUB_LOG"

echo "nenhuma orientacao do codigo manda rodar a consulta sem opcoes"
# shellcheck disable=SC2016 # os $ sao texto procurado pelo grep, nao variaveis
PADRAO='agente restricoes (\$slug|\$\{slug\}|\$1)(?![\w-])(?! +--)'
nega "lib/restricoes.sh" grep -nP "$PADRAO" "$REPO/lib/restricoes.sh"
nega "bin/dgclaw" grep -nP "$PADRAO" "$REPO/bin/dgclaw"
nega "web/lib/thread.js" grep -nP 'agente restricoes \$\{agente\.slug\}(?! +--)' "$REPO/web/lib/thread.js"

fim
