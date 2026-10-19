#!/usr/bin/env bash
# Bloco J, Admin desligavel (admin_llm = false): dgclaw admin desligar|ligar, status, instalador. podman e systemctl de mentira.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
ENT_STUBS_C="$(cd "$(dirname "$0")" && pwd)/stubs-c"
preparar
stubs_d
PATH="$ENT_STUBS_C:$PATH"; export PATH
app_copia

AGENTES="$ETC/agentes.json"
GUARDADO="$ETC/agentes.json.admin-desligado"
UNITS="$DGCLAW_RAIZ/etc/systemd/system"
AUD="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"
ADMIN_CT='{"slug":"admin","nome":"Admin","tipo":"admin","papel":"admin","container":"dgclaw-admin","runner":"http://127.0.0.1:4310","agente_id":"admin","chat_id":"c_admin","provedor":"claude"}'
ANA='{"slug":"ana","nome":"Ana","tipo":"agente","runner":"http://127.0.0.1:4311","agente_id":"ana","chat_id":"c_ana","provedor":"claude"}'
reinicia() { printf '{"versao": 1, "agentes": [%s,%s]}\n' "$ADMIN_CT" "$ANA" >"$AGENTES"; }
reinicia
echo running >"$STUB_ESTADO/c-dgclaw-admin"
mkdir -p "$UNITS"; echo "[Unit]" >"$UNITS/dgclaw-admin.service"
tem_admin() { jq -e '.agentes[] | select(.slug == "admin")' "$AGENTES" >/dev/null; }

echo "admin desligar: pessoal e escritorio"
nega "pessoal: o Admin so desliga com o Admin isolado" "$CLI_COPIA" admin desligar
"$CLI_COPIA" admin desligar >"$TMP/o.txt" 2>&1
afirma "a mensagem manda isolar primeiro" grep -q "dgclaw admin isolar" "$TMP/o.txt"
afirma "nada mudou (Admin continua no registro e nenhuma parada)" bash -c "jq -e '.agentes[] | select(.slug == \"admin\")' '$AGENTES' >/dev/null && ! grep -q 'podman stop' '$STUB_LOG' && [ ! -e '$GUARDADO' ]"
igual "pessoal: ent_admin_unidades segue o registro como antes (Admin em container: o controle)" "dgclaw-controle" "$(lib_d ent_admin_unidades)"

echo "admin desligar: regulado"
nivel_na_raiz regulado
mkdir -p "$LIB/web/controle"
printf '{"aberta_em":1,"fecha_em":9999999999999,"fecha_ms":9999999999999,"minutos":10,"por":"ti","slug":"admin-manutencao"}\n' >"$LIB/web/controle/manutencao.json"
: >"$STUB_LOG"
"$CLI_COPIA" admin desligar >"$TMP/o.txt" 2>&1
igual "desligar termina bem" 0 "$?"
afirma "o Admin saiu do agentes.json e a Ana ficou" bash -c "! jq -e '.agentes[] | select(.slug == \"admin\")' '$AGENTES' >/dev/null && jq -e '.agentes[] | select(.slug == \"ana\")' '$AGENTES' >/dev/null"
afirma "a entrada ficou guardada em agentes.json.admin-desligado, modo 600" bash -c "jq -e '.slug == \"admin\" and .container == \"dgclaw-admin\"' '$GUARDADO' && [ \$(stat -c %a '$GUARDADO') = 600 ]"
igual "admin_llm = false" false "$(lib protecao_valor admin_llm)"
afirma "parou o container do Admin" grep -q "^podman stop dgclaw-admin" "$STUB_LOG"
afirma "e tirou o restart automatico (nao volta no proximo boot)" grep -q "^podman update --restart=no dgclaw-admin" "$STUB_LOG"
afirma "desabilitou o Admin do host" grep -q "^systemctl disable --now dgclaw-admin.service" "$STUB_LOG"
afirma "fechou a manutencao de emergencia" bash -c "[ ! -e '$LIB/web/controle/manutencao.json' ] && grep -q 'dgclaw-admin-manutencao' '$STUB_LOG'"
afirma "auditado" jq -e 'select(.evento == "admin.desligar")' "$AUD"
igual "o servico que precisa estar de pe agora e so o controle" "dgclaw-controle" "$(lib_d ent_admin_unidades)"
"$CLI_COPIA" admin status >"$TMP/o.txt" 2>&1
afirma "admin status diz que esta desligado de proposito" grep -q "DESLIGADO de proposito" "$TMP/o.txt"
"$CLI_COPIA" status >"$TMP/o.txt" 2>&1
afirma "dgclaw status explica que o Admin esta desligado" grep -q "Admin desligado de proposito" "$TMP/o.txt"
afirma "dgclaw status nao trata a falta do Admin como defeito" bash -c "! grep -q 'o Admin nao responde' '$TMP/o.txt' && ! grep -q 'servico dgclaw-admin parado' '$TMP/o.txt'"
"$CLI_COPIA" admin desligar >"$TMP/o.txt" 2>&1
igual "desligar de novo e inofensivo" 0 "$?"
afirma "diz que ja estava desligado" grep -q "ja esta desligado" "$TMP/o.txt"
nega "criar um agente com o nome admin continua proibido" "$CLI_COPIA" agente criar admin --nome Admin
echo "admin desligar: protecoes aplicar e o instalador nao recriam o Admin"
: >"$STUB_LOG"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "protecoes aplicar nao cria o Admin em container" bash -c "! grep -q 'podman create.*dgclaw-admin' '$STUB_LOG' && ! jq -e '.agentes[] | select(.slug == \"admin\")' '$AGENTES' >/dev/null"
printf '{"versao": 1, "agentes": [%s,%s]}\n' "$ADMIN_CT" "$ANA" >"$AGENTES"   # o instalador (configurar_admin) recadastra o Admin
lib_d ent_instalar_admin_isolado >"$TMP/o.txt" 2>&1
afirma "ent_instalar_admin_isolado deixa o Admin quieto" bash -c "! grep -q 'podman create' '$STUB_LOG'"
lib_d ent_instalar_admin_llm >"$TMP/o.txt" 2>&1
afirma "ent_instalar_admin_llm desliga de novo o que o instalador recadastrou" bash -c "! jq -e '.agentes[] | select(.slug == \"admin\")' '$AGENTES' >/dev/null"

echo "admin ligar"
"$CLI_COPIA" admin ligar >"$TMP/o.txt" 2>&1
igual "ligar termina bem" 0 "$?"
afirma "o Admin voltou ao agentes.json com a entrada de antes" jq -e '.agentes[] | select(.slug == "admin" and .container == "dgclaw-admin")' "$AGENTES"
igual "admin_llm = true" true "$(lib protecao_valor admin_llm)"
afirma "religou o container com o restart de antes" bash -c "grep -q '^podman update --restart=unless-stopped dgclaw-admin' '$STUB_LOG' && grep -q '^podman start dgclaw-admin' '$STUB_LOG'"
afirma "a copia guardada foi apagada" test ! -e "$GUARDADO"
afirma "auditado" jq -e 'select(.evento == "admin.ligar")' "$AUD"
igual "unidades esperadas: o controle (Admin isolado)" "dgclaw-controle" "$(lib_d ent_admin_unidades)"
"$CLI_COPIA" admin ligar >"$TMP/o.txt" 2>&1
afirma "ligar de novo: ja esta ligado" grep -q "ja esta ligado" "$TMP/o.txt"
rm -f "$AGENTES"; printf '{"versao": 1, "agentes": []}\n' >"$AGENTES"
lib protecao_ajustar admin_llm false
nega "ligar sem a entrada guardada falha" "$CLI_COPIA" admin ligar
"$CLI_COPIA" admin ligar >"$TMP/o.txt" 2>&1
afirma "e diz como recriar o Admin" grep -q "dgclaw admin isolar" "$TMP/o.txt"

fim
