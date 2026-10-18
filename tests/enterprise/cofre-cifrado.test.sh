#!/usr/bin/env bash
# Bloco D, cofre cifrado (lado bash): migrar, abrir, remover, nivel pessoal intocado. systemd-creds de mentira.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
preparar
stubs_d
app_copia

SEGREDO1="sk-teste-segredo-um-123456789"
SEGREDO2="gemini-teste-segredo-dois-987654"
CASA="$LIB/agentes/ana"
CLARO="$CASA/cofre/cofre.env"
CRED="$CLARO.cred"
RAM="$DGCLAW_RAIZ/run/dgclaw/cofres/ana/cofre.env"
AUD="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"

echo "cofre: nivel pessoal"
"$CLI_COPIA" agente criar ana --nome "Ana" >/dev/null 2>&1
printf "OPENAI_API_KEY='%s'\nGEMINI_API_KEY='%s'\n" "$SEGREDO1" "$SEGREDO2" >"$CLARO"
nega "migrar recusa quando a protecao esta desligada" "$CLI_COPIA" cofre migrar
afirma "o cofre em claro ficou como estava" grep -q "$SEGREDO1" "$CLARO"
afirma "nada de .cred nem de pasta em memoria" bash -c "[ ! -e '$CRED' ] && [ ! -e '$DGCLAW_RAIZ/run/dgclaw/cofres' ]"
"$CLI_COPIA" cofre status 2>&1 | grep -q EM-CLARO; igual "status mostra o cofre em claro" 0 "$?"

echo "cofre: migrar no escritorio"
nivel_na_raiz escritorio
: >"$STUB_LOG"
"$CLI_COPIA" cofre migrar >"$TMP/o.txt" 2>&1
igual "migrar termina bem" 0 "$?"
afirma "o .cred existe" test -s "$CRED"
afirma "o .cred e 600" bash -c "[ \"\$(stat -c %a '$CRED')\" = 600 ]"
afirma "o claro saiu do disco" test ! -e "$CLARO"
afirma "o .cred nao tem o valor" bash -c "! grep -q '$SEGREDO1' '$CRED'"
igual "a copia em memoria tem as duas chaves, iguais ao original" "$(printf "OPENAI_API_KEY='%s'\nGEMINI_API_KEY='%s'" "$SEGREDO1" "$SEGREDO2")" "$(cat "$RAM")"
afirma "arquivo em memoria 600" bash -c "[ \"\$(stat -c %a '$RAM')\" = 600 ]"
afirma "pasta em memoria 700" bash -c "[ \"\$(stat -c %a '$(dirname "$RAM")')\" = 700 ]"
igual "a pasta em memoria e do root do container (uid 1000000)" "1000000:1000000" "$(dono_de "$(dirname "$RAM")")"
afirma "nome da credencial no systemd-creds" grep -q "^systemd-creds encrypt --name=dgclaw-cofre-ana --with-key=auto - " "$STUB_LOG"
afirma "nenhum valor em argv" bash -c "! grep -q -e '$SEGREDO1' -e '$SEGREDO2' '$STUB_LOG'"
afirma "nenhum valor na saida" bash -c "! grep -q -e '$SEGREDO1' -e '$SEGREDO2' '$TMP/o.txt'"
afirma "auditado com o numero de chaves" bash -c "jq -e 'select(.evento == \"cofre.migrar\" and .dados.slug == \"ana\" and .dados.chaves == 2)' '$AUD'"
afirma "nenhum valor na auditoria" bash -c "! grep -q -e '$SEGREDO1' -e '$SEGREDO2' '$AUD'"
"$CLI_COPIA" cofre migrar >"$TMP/o.txt" 2>&1
igual "migrar de novo e inofensivo" 0 "$?"
afirma "a chave continua la" grep -q "$SEGREDO1" "$RAM"
"$CLI_COPIA" cofre status 2>&1 | grep -q "cifrado"; igual "status mostra cifrado" 0 "$?"

echo "cofre: abrir (reboot) e falhas"
rm -rf "$DGCLAW_RAIZ/run/dgclaw/cofres"
"$CLI_COPIA" cofre status 2>&1 | grep -q "FECHADA"; igual "status avisa que a copia em memoria sumiu" 0 "$?"
"$CLI_COPIA" cofre abrir >"$TMP/o.txt" 2>&1
igual "abrir recria a copia em memoria" 0 "$?"
afirma "com o conteudo certo" grep -q "$SEGREDO2" "$RAM"
cp "$CRED" "$TMP/cred.bom"
sed 's/dgclaw-cofre-ana/dgclaw-cofre-outro/' "$CRED" >"$TMP/cred.ruim" && cp "$TMP/cred.ruim" "$CRED"
rm -rf "$DGCLAW_RAIZ/run/dgclaw/cofres"
nega "credencial de outro nome nao abre" "$CLI_COPIA" cofre abrir ana
"$CLI_COPIA" cofre abrir ana >"$TMP/o.txt" 2>&1
afirma "a mensagem diz o que fazer" grep -q "O que fazer" "$TMP/o.txt"
cp "$TMP/cred.bom" "$CRED"
echo "cofre: systemd-creds quebrado nao perde chave"
printf "XAI_API_KEY='xai-teste-123456'\n" >"$CLARO"
STUB_CREDS_FALHA=1 "$CLI_COPIA" cofre migrar >"$TMP/o.txt" 2>&1
igual "migrar falha" 1 "$?"
afirma "o claro continua no disco" grep -q xai-teste-123456 "$CLARO"
afirma "a mensagem diz que o cofre nao foi tocado" grep -q "nao foi tocado" "$TMP/o.txt"
rm -f "$CLARO"

echo "cofre: agente novo nasce com o cofre cifrado e a pasta em memoria"
"$CLI_COPIA" agente criar bia --nome "Bia" >/dev/null 2>&1
igual "criou" 0 "$?"
afirma "bia: .cred e nada em claro" bash -c "[ -s '$LIB/agentes/bia/cofre/cofre.env.cred' ] && [ ! -e '$LIB/agentes/bia/cofre/cofre.env' ]"
afirma "bia: pasta em memoria existe" test -d "$DGCLAW_RAIZ/run/dgclaw/cofres/bia"

echo "cofre: remover agente apaga a copia em memoria"
"$CLI_COPIA" agente remover bia --sim >/dev/null 2>&1
afirma "a pasta em memoria de bia sumiu" test ! -e "$DGCLAW_RAIZ/run/dgclaw/cofres/bia"
afirma "a de ana continua" test -d "$DGCLAW_RAIZ/run/dgclaw/cofres/ana"

echo "cofre: unidade do boot"
lib ent_instalar_cofre >/dev/null 2>&1
afirma "dgclaw-cofre.service depende do disco e vem antes dos containers" bash -c "grep -q 'After=dgclaw-disco.service' '$DGCLAW_RAIZ/etc/systemd/system/dgclaw-cofre.service' && grep -q 'Before=podman.service' '$DGCLAW_RAIZ/etc/systemd/system/dgclaw-cofre.service'"
afirma "a unidade foi habilitada" grep -q "^systemctl enable dgclaw-cofre.service" "$STUB_LOG"

fim
