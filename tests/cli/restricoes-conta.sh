#!/usr/bin/env bash
# Restricoes: conta de organizacao Team/Enterprise reprova mesmo sem politica no cache (o Claude Code busca a politica
# de hora em hora e ela substituiria a configuracao do DG Claw), e a consulta nunca anuncia TRAVADO numa restricao que
# nao foi aplicada (docs/RESTRICOES-DO-AGENTE.md).
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

R="$LIB/agentes/ana/runner"
criar_agente ana --nome "Ana"
EMAIL='segredo.pessoa@empresa-exemplo.com'
conta() { printf '%s\n' "$1" >"$STUB_ESTADO/conta-saida"; }

echo "achado 1: conta de organizacao sem politica no cache"
reprovam=(
    'team|{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"'"$EMAIL"'","orgId":"org-123","orgName":"Empresa Secreta"}'
    'enterprise|{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"Enterprise","email":"'"$EMAIL"'","orgId":"org-123","orgName":"Empresa Secreta"}'
    'sem-plano|{"loggedIn":true,"authMethod":"claude.ai","email":"'"$EMAIL"'","orgName":"Empresa Secreta"}'
    'plano-nulo|{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":null,"email":"'"$EMAIL"'"}'
    'plano-numero|{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":7,"email":"'"$EMAIL"'"}'
    'lixo|isto nao e json '"$EMAIL"
    'vazia|'
    'lista|["'"$EMAIL"'"]'
)
for linha in "${reprovam[@]}"; do
    caso="${linha%%|*}"; conta "${linha#*|}"
    echo running >"$STUB_ESTADO/c-dgclaw-ana"
    dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
    : >"$STUB_LOG"
    dgclaw agente restricoes ana --sem-bash sim >"$TMP/o1.txt" 2>&1; rc=$?
    nega "$caso: o comando falha" test "$rc" -eq 0
    afirma "$caso: pediu a conta dentro da caixa, como agente, com prazo" grep -q '^podman exec --user agente dgclaw-ana claude auth status --json$' "$STUB_LOG"
    afirma "$caso: diz que as restricoes NAO valem" grep -q 'NAO valem' "$TMP/o1.txt"
    afirma "$caso: parou o container" grep -q '^podman stop dgclaw-ana' "$STUB_LOG"
    igual "$caso: ficou parado" "exited" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
    afirma "$caso: orienta conta pessoal ou chave de API" grep -q 'conta pessoal (Pro ou Max) ou uma chave de API' "$TMP/o1.txt"
    nega "$caso: o e-mail nao aparece na saida" grep -q "$EMAIL" "$TMP/o1.txt"
    nega "$caso: nem a organizacao" grep -q 'Empresa Secreta\|org-123' "$TMP/o1.txt"
    nega "$caso: nem no log das restricoes" grep -rq "$EMAIL\|Empresa Secreta\|org-123" "$LIB/agentes/ana/restricoes.log"
done

conta '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"'"$EMAIL"'"}'
echo running >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o1b.txt" 2>&1
afirma "team: o motivo cita Team/Enterprise" grep -q 'Team/Enterprise' "$TMP/o1b.txt"

echo "achado 1: contas que passam"
passam=(
    'max|{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"'"$EMAIL"'"}'
    'pro|{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"'"$EMAIL"'"}'
    'api-key|{"loggedIn":true,"authMethod":"api_key","email":"'"$EMAIL"'"}'
    'oauth-token|{"loggedIn":true,"authMethod":"oauth_token","subscriptionType":"max"}'
    'sem-login|{"loggedIn":false,"authMethod":"none"}'
)
for linha in "${passam[@]}"; do
    caso="${linha%%|*}"; conta "${linha#*|}"
    echo running >"$STUB_ESTADO/c-dgclaw-ana"
    dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
    dgclaw agente restricoes ana --sem-bash sim >"$TMP/o2.txt" 2>&1; igual "$caso: aplica e sai com 0" "0" "$?"
    igual "$caso: o agente continua ligado" "running" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
    nega "$caso: o e-mail nao aparece" grep -q "$EMAIL" "$TMP/o2.txt"
done

echo "achado 1: a consulta mostra NAO VALE, nao para o agente e nao vaza dados"
echo running >"$STUB_ESTADO/c-dgclaw-ana"
rm -f "$STUB_ESTADO/conta-saida" "$R"/*.pendente
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1
conta '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"enterprise","email":"'"$EMAIL"'","orgName":"Empresa Secreta"}'
dgclaw agente restricoes ana >"$TMP/c1.txt" 2>&1; igual "sai com 0" "0" "$?"
afirma "diz NAO VALE com Team/Enterprise" grep -q 'NAO VALE:.*Team/Enterprise' "$TMP/c1.txt"
nega "nao diz TRAVADO" grep -q TRAVADO "$TMP/c1.txt"
nega "nao vaza e-mail nem organizacao" grep -q "$EMAIL\|Empresa Secreta" "$TMP/c1.txt"
igual "nao para o agente" "running" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
rm -f "$STUB_ESTADO/conta-saida"

echo "achado 2: interrupcao entre gravar o restricoes.json e aplicar"
echo running >"$STUB_ESTADO/c-dgclaw-ana"
rm -f "$R"/*.pendente
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao --escrita-livre >/dev/null 2>&1
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1
nega "aplicacao bem-sucedida nao deixa marcador de transacao" test -e "$R/restricoes-transacao.pendente"
nega "nem de reinicio" test -e "$R/restricoes.pendente"
# simula a interrupcao: o dono acrescenta o envio, mas so o restricoes.json chega ao disco
jq '.sem_enviar_arquivo = true' "$R/restricoes.json" >"$TMP/rs.json"
chmod 644 "$R/restricoes.json"; cp "$TMP/rs.json" "$R/restricoes.json"
dgclaw agente restricoes ana >"$TMP/c2.txt" 2>&1; igual "a consulta sai com 0" "0" "$?"
nega "o cenario (so Bash travado, envio acrescentado) nao mostra TRAVADO" grep -q TRAVADO "$TMP/c2.txt"
afirma "diz AINDA NAO VALE" grep -q 'AINDA NAO VALE' "$TMP/c2.txt"
afirma "diz NAO VALE com o comando que resolve" grep -q 'NAO VALE:.*Resolve: dgclaw agente reiniciar ana' "$TMP/c2.txt"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana >"$TMP/c3.txt" 2>&1
nega "parado: tambem nao mostra TRAVADO" grep -q TRAVADO "$TMP/c3.txt"
afirma "parado: o comando que resolve e iniciar" grep -q 'NAO VALE:.*Resolve: dgclaw agente iniciar ana' "$TMP/c3.txt"
echo running >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente reiniciar ana >/dev/null 2>&1; igual "reiniciar refaz os arquivos" "0" "$?"
dgclaw agente restricoes ana >"$TMP/c4.txt" 2>&1
afirma "depois de reiniciar volta a TRAVADO" grep -q 'Enviar arquivos: *TRAVADO' "$TMP/c4.txt"
nega "e sem marcador de transacao" test -e "$R/restricoes-transacao.pendente"

echo "achado 2: marcador de transacao sem mudanca nos arquivos aparece como pendencia"
printf 'transacao das restricoes pendente desde 2026-11-08T10:00:00Z\n' >"$R/restricoes-transacao.pendente"
dgclaw agente restricoes ana >"$TMP/c5.txt" 2>&1
afirma "mostra a pendencia" grep -q 'Pendente:.*transacao das restricoes pendente' "$TMP/c5.txt"
nega "nao diz TRAVADO" grep -q TRAVADO "$TMP/c5.txt"
rm -f "$R/restricoes-transacao.pendente"

echo "achado 2: aplicacao sem mudanca nao reinicia o runner sem motivo"
dgclaw agente restricoes ana --sem-bash sim --sem-enviar-arquivo sim >/dev/null 2>&1
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim --sem-enviar-arquivo sim >"$TMP/o3.txt" 2>&1; igual "repetir o comando funciona" "0" "$?"
nega "nao reiniciou o runner" grep -q 'systemctl restart' "$STUB_LOG"
nega "nao deixou marcador de transacao" test -e "$R/restricoes-transacao.pendente"
nega "nem de reinicio" test -e "$R/restricoes.pendente"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana --sem-bash sim --sem-enviar-arquivo sim >"$TMP/o4.txt" 2>&1; igual "agente parado: funciona" "0" "$?"
nega "agente parado: sem marcador de transacao" test -e "$R/restricoes-transacao.pendente"
nega "agente parado: sem marcador de reinicio" test -e "$R/restricoes.pendente"

echo "achado 2: aplicacao que falha deixa o marcador de transacao e a consulta nao diz TRAVADO"
echo running >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao >/dev/null 2>&1
FALSO="$TMP/falso-mv"; mkdir -p "$FALSO"
printf '#!/bin/sh\ncase "$*" in *managed-settings.json*) echo "mv: falha simulada" >&2; exit 1;; esac\nexec /bin/mv "$@"\n' >"$FALSO/mv"; chmod +x "$FALSO/mv"
PATH="$FALSO:$PATH" dgclaw agente restricoes ana --sem-bash sim >"$TMP/o5.txt" 2>&1; nega "o comando falha" test "$?" -eq 0
afirma "o marcador de transacao ficou" test -e "$R/restricoes-transacao.pendente"
dgclaw agente restricoes ana >"$TMP/c6.txt" 2>&1
nega "a consulta nao diz TRAVADO" grep -q TRAVADO "$TMP/c6.txt"
dgclaw agente reiniciar ana >/dev/null 2>&1
nega "reiniciar tira o marcador" test -e "$R/restricoes-transacao.pendente"

fim
