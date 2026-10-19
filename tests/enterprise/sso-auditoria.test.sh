#!/usr/bin/env bash
# dgclaw sso e dgclaw auditoria (bloco G): configurar o login unico sem segredo em argv, conta de emergencia,
# verificar/exportar/selo da corrente, destino externo, retencao, linhas do status e verificacao do monitor.
# Raiz falsa, sem rede: o teste do provedor e do coletor de verdade fica em web/test/ent-sso.test.js e ent-auditoria-externa.test.js.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
export DGCLAW_QUEM=testador
LOGA="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"
SSO_JSON="$ETC/sso.json"
# a CLI procura o web/bin em /opt/dgclaw/app: na raiz falsa, aponta para o repositorio
mkdir -p "$DGCLAW_RAIZ/opt/dgclaw"
ln -s "$REPO" "$DGCLAW_RAIZ/opt/dgclaw/app"
HASH_FALSO="scrypt\$1024\$8\$1\$$(head -c 12 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')\$$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
printf "DGCLAW_PANEL_USER=maria\nDGCLAW_PANEL_PASSWORD_HASH='%s'\n" "$HASH_FALSO" >"$ETC/web.env"
printf '{"versao":1,"agentes":[{"slug":"admin","tipo":"admin"},{"slug":"luna","tipo":"agente"}]}\n' >"$ETC/agentes.json"
# credenciais de teste geradas na hora
SEGREDO="seg-$(head -c 12 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
CRED_COLETOR="cc-$(head -c 12 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"

echo "pessoal: nada a conferir e nada muda"
dgclaw auditoria verificar >"$TMP/o.txt" 2>&1
igual "verificar sai com 0" 0 "$?"
afirma "diz que a auditoria esta desligada" grep -q "desligada" "$TMP/o.txt"
dgclaw sso status >"$TMP/o.txt" 2>&1
igual "sso status sai com 0" 0 "$?"
afirma "mostra o modo nao" grep -q "modo nao" "$TMP/o.txt"
nega "nenhum arquivo de auditoria nasceu" test -e "$LOGA"
nega "o sso.json nao nasceu" test -e "$SSO_JSON"

echo "ajuda e erros de uso"
dgclaw auditoria >"$TMP/o.txt" 2>&1
igual "auditoria sem subcomando: recusa" 1 "$?"
afirma "o erro lista os subcomandos" grep -q "verificar | selo | exportar" "$TMP/o.txt"
dgclaw sso fantasma >"$TMP/o.txt" 2>&1
igual "sso com subcomando inexistente: recusa" 1 "$?"
afirma "ajuda lista os comandos novos" bash -c "'$CLI' --ajuda | grep -q 'dgclaw sso configurar' && '$CLI' --ajuda | grep -q 'dgclaw auditoria verificar'"

echo "regulado: gera eventos de verdade e confere a corrente"
nivel_na_raiz regulado
dgclaw usuario criar ana.ti --papel ti --email ana.ti@empresa.com.br >/dev/null 2>&1
dgclaw usuario criar bia --papel funcionario --agentes luna --email bia@empresa.com.br >/dev/null 2>&1
dgclaw auditoria verificar >"$TMP/o.txt" 2>&1
igual "verificar: corrente integra, sai com 0" 0 "$?"
afirma "diz quantas linhas" grep -qE "Corrente íntegra: [0-9]+ linha" "$TMP/o.txt"
dgclaw auditoria verificar --json >"$TMP/o.json" 2>&1
igual "verificar --json: ok" true "$(jq -r '.ok' "$TMP/o.json")"
igual "verificar --json: um arquivo" 1 "$(jq -r '.arquivos' "$TMP/o.json")"

dgclaw auditoria selo >"$TMP/o.txt" 2>&1
igual "selo sai com 0" 0 "$?"
igual "o selo e o hash da ultima linha" "$(tail -n 1 "$LOGA" | jq -r '.hash')" "$(awk '{print $1}' "$TMP/o.txt")"

echo "exportar"
dgclaw auditoria exportar --formato jsonl --saida "$TMP/saida.jsonl" >"$TMP/o.txt" 2>&1
igual "exportar jsonl sai com 0" 0 "$?"
igual "arquivo com modo 600" 600 "$(stat -c %a "$TMP/saida.jsonl")"
igual "as linhas exportadas sao as originais" "$(head -n 1 "$LOGA")" "$(head -n 1 "$TMP/saida.jsonl")"
dgclaw auditoria exportar --evento usuario_criado --quem testador >"$TMP/stdout.txt" 2>"$TMP/e.txt"
igual "filtro por evento e quem" 2 "$(wc -l <"$TMP/stdout.txt")"
afirma "diz quantos eventos exportou" grep -q "2 evento(s) exportado(s)" "$TMP/e.txt"
dgclaw auditoria exportar --formato csv --evento usuario_criado >"$TMP/stdout.csv" 2>/dev/null
afirma "csv tem cabecalho" grep -q '"ts","evento","quem","origem","dados","ant","hash"' "$TMP/stdout.csv"
dgclaw auditoria exportar --de ontem >"$TMP/o.txt" 2>&1
igual "data invalida: uso errado (2)" 2 "$?"
afirma "o erro diz o formato da data" grep -q "AAAA-MM-DD" "$TMP/o.txt"
afirma "a exportacao ficou na auditoria" bash -c "jq -e 'select(.evento==\"auditoria_exportada\" and .origem==\"cli\")' '$LOGA' >/dev/null"
afirma "o filtro usado foi registrado" bash -c "jq -e 'select(.evento==\"auditoria_exportada\") | .dados.filtros | select(.evento==\"usuario_criado\")' '$LOGA' >/dev/null"
dgclaw --ensaio auditoria exportar --saida "$TMP/nao.jsonl" >"$TMP/o.txt" 2>&1
igual "ensaio de exportar: sai com 0" 0 "$?"
nega "ensaio de exportar nao grava o arquivo" test -e "$TMP/nao.jsonl"

echo "corrente quebrada: aponta a linha"
cp "$LOGA" "$TMP/auditoria.copia"
sed -i '2s/"quem":"testador"/"quem":"intruso"/' "$LOGA"
dgclaw auditoria verificar >"$TMP/o.txt" 2>&1
igual "verificar: corrente quebrada, sai com 1" 1 "$?"
afirma "diz a linha e o arquivo" grep -q "QUEBRADA na linha 2 (auditoria.jsonl, linha 2)" "$TMP/o.txt"
afirma "diz o que fazer" grep -q "O que fazer" "$TMP/o.txt"
cp "$TMP/auditoria.copia" "$LOGA"

echo "sso configurar: segredo so por stdin ou arquivo"
dgclaw sso configurar --provedor google --client-id abc123 --dominios empresa.com.br </dev/null >"$TMP/o.txt" 2>&1
igual "sem segredo e sem terminal: recusa" 1 "$?"
afirma "o erro mostra como mandar o segredo" grep -q -- "--segredo-stdin" "$TMP/o.txt"
printf '%s\n' "$SEGREDO" | dgclaw sso configurar --provedor google --client-id abc123 --dominios empresa.com.br --segredo-stdin >"$TMP/o.txt" 2>&1
igual "google configurado" 0 "$?"
igual "sso.json com modo 600" 600 "$(stat -c %a "$SSO_JSON")"
igual "provedor gravado" google "$(jq -r '.provedor' "$SSO_JSON")"
igual "o segredo foi gravado" "$SEGREDO" "$(jq -r '.client_secret' "$SSO_JSON")"
nega "o segredo nao aparece na saida" grep -q "$SEGREDO" "$TMP/o.txt"
nega "o segredo nao aparece na auditoria" grep -q "$SEGREDO" "$LOGA"
afirma "a saida diz o endereco de retorno a cadastrar" grep -q "https://teste.exemplo.org/sso/retorno" "$TMP/o.txt"
afirma "a configuracao ficou na auditoria" bash -c "jq -e 'select(.evento==\"sso_configurado\") | .dados | select(.client_id==\"abc123\")' '$LOGA' >/dev/null"
printf '%s' "$SEGREDO" >"$TMP/seg.txt"; chmod 600 "$TMP/seg.txt"
dgclaw sso configurar --provedor microsoft --client-id abc123 --tenant common --segredo-arquivo "$TMP/seg.txt" >"$TMP/o.txt" 2>&1
igual "tenant common: recusa" 1 "$?"
afirma "o erro explica o ID do diretorio" grep -q "ID do diretório" "$TMP/o.txt"
igual "o arquivo bom nao foi trocado pelo ruim" google "$(jq -r '.provedor' "$SSO_JSON")"
dgclaw sso configurar --provedor oidc --client-id abc123 --emissor http://idp.empresa.com --segredo-arquivo "$TMP/seg.txt" >"$TMP/o.txt" 2>&1
igual "emissor sem https: recusa" 1 "$?"
dgclaw sso configurar --provedor oidc --client-id novo --emissor https://idp.empresa.com/realms/x --manter-segredo >"$TMP/o.txt" 2>&1
igual "manter-segredo reaproveita o segredo atual" 0 "$?"
igual "segredo mantido" "$SEGREDO" "$(jq -r '.client_secret' "$SSO_JSON")"
igual "provedor trocado" oidc "$(jq -r '.provedor' "$SSO_JSON")"
dgclaw sso testar >"$TMP/o.txt" 2>&1
igual "testar sem rede: recusa" 1 "$?"
afirma "o erro explica que nao alcancou o provedor" grep -q "Não consegui falar com o provedor" "$TMP/o.txt"
nega "o segredo nao vazou no erro" grep -q "$SEGREDO" "$TMP/o.txt"
dgclaw sso status --json >"$TMP/o.json" 2>&1
igual "status: configurado" true "$(jq -r '.configurado' "$TMP/o.json")"
igual "status: modo obrigatorio no regulado" obrigatorio "$(jq -r '.modo' "$TMP/o.json")"
afirma "status avisa que falta a conta de emergencia" bash -c "jq -e '.avisos | map(select(test(\"conta de emergência\"))) | length > 0' '$TMP/o.json' >/dev/null"

echo "sso emergencia"
dgclaw sso emergencia bia >"$TMP/o.txt" 2>&1
igual "funcionario nao pode: recusa" 1 "$?"
afirma "o erro diz que precisa ser TI" grep -q "precisa ser do TI" "$TMP/o.txt"
dgclaw sso emergencia fantasma >"$TMP/o.txt" 2>&1
igual "usuario inexistente: recusa" 1 "$?"
dgclaw sso emergencia ana.ti >"$TMP/o.txt" 2>&1
igual "TI vira conta de emergencia" 0 "$?"
igual "marca gravada no usuarios.json" true "$(jq -r '.usuarios[] | select(.usuario=="ana.ti") | .emergencia' "$LIB/web/usuarios.json")"
dgclaw usuario criar zeca --papel ti >/dev/null 2>&1
dgclaw sso emergencia zeca >"$TMP/o.txt" 2>&1
igual "so uma conta de emergencia: recusa a segunda" 1 "$?"
afirma "o erro diz como tirar a primeira" grep -q "emergencia --remover ana.ti" "$TMP/o.txt"
dgclaw sso emergencia ana.ti >"$TMP/o.txt" 2>&1
igual "repetir a mesma nao muda nada e sai com 0" 0 "$?"
afirma "o status mostra a conta" bash -c "'$CLI' sso status | grep -q 'Conta de emergência: ana.ti'"
nega "o aviso de falta de emergencia sumiu" bash -c "'$CLI' sso status | grep -q 'não há conta de emergência'"
afirma "a marca ficou na auditoria" bash -c "jq -e 'select(.evento==\"sso_emergencia_definida\")' '$LOGA' >/dev/null"
# uso recente da emergencia: um login_ok dela na trilha vira aviso no status
DGCLAW_QUEM=ana.ti bash -c ". '$REPO/lib/comum.sh'; . '$REPO/lib/protecoes.sh'; . '$REPO/lib/enterprise/auditoria.sh'; auditar login_ok '{\"via\":\"senha+2fa\"}'"
dgclaw sso status >"$TMP/o.txt" 2>&1
afirma "status avisa que a conta de emergencia foi usada" grep -q "foi usada em" "$TMP/o.txt"
dgclaw sso emergencia --remover ana.ti >"$TMP/o.txt" 2>&1
igual "remover a marca" 0 "$?"
igual "marca removida" null "$(jq -r '.usuarios[] | select(.usuario=="ana.ti") | .emergencia // "null"' "$LIB/web/usuarios.json")"

echo "auditoria externa: configurar sem credencial em argv"
dgclaw auditoria externa configurar --tipo http --url http://coletor.empresa.com/x >"$TMP/o.txt" 2>&1
igual "http sem TLS: recusa" 1 "$?"
afirma "o erro explica" grep -q "precisa ser https" "$TMP/o.txt"
nega "nada foi gravado" test -e "$ETC/auditoria-externa.json"
dgclaw auditoria externa configurar --tipo syslog --host logs.empresa.com --porta 70000 >"$TMP/o.txt" 2>&1
igual "porta invalida: recusa" 1 "$?"
printf '%s\n' "$CRED_COLETOR" | dgclaw auditoria externa configurar --tipo http --url https://coletor.empresa.com/auditoria --token-stdin >"$TMP/o.txt" 2>&1
igual "destino http gravado" 0 "$?"
igual "auditoria-externa.json com modo 600" 600 "$(stat -c %a "$ETC/auditoria-externa.json")"
igual "a credencial foi gravada" "$CRED_COLETOR" "$(jq -r '.token' "$ETC/auditoria-externa.json")"
nega "a credencial nao aparece na saida" grep -q "$CRED_COLETOR" "$TMP/o.txt"
nega "a credencial nao aparece na auditoria" grep -q "$CRED_COLETOR" "$LOGA"
dgclaw auditoria externa status >"$TMP/o.txt" 2>&1
igual "status sem pendencia atrasada: 0" 0 "$?"
afirma "status mostra o destino sem a credencial" grep -q "Destino: http https://coletor.empresa.com/auditoria" "$TMP/o.txt"
nega "status nao mostra a credencial" grep -q "$CRED_COLETOR" "$TMP/o.txt"
dgclaw auditoria externa fantasma >"$TMP/o.txt" 2>&1
igual "subcomando externo inexistente: uso errado" 2 "$?"

echo "retencao da auditoria"
dgclaw auditoria retencao mostrar >"$TMP/o.txt" 2>&1
afirma "padrao de 5 anos" grep -q "1825 dias" "$TMP/o.txt"
dgclaw auditoria retencao definir 100 >"$TMP/o.txt" 2>&1
igual "menos de 365 dias: recusa" 1 "$?"
dgclaw auditoria retencao definir 2555 >"$TMP/o.txt" 2>&1
igual "define 7 anos" 0 "$?"
afirma "mostra o novo prazo" bash -c "'$CLI' auditoria retencao mostrar | grep -q '2555 dias'"
dgclaw auditoria retencao aplicar >"$TMP/o.txt" 2>&1
igual "aplicar sem meses velhos: 0" 0 "$?"
afirma "diz que nao ha o que apagar" grep -q "Nada a apagar" "$TMP/o.txt"

echo "status e monitor"
status_aud() {
    bash -c 'set -uo pipefail; REPO="$1"; APP_DIR="$REPO"; . "$REPO/lib/comum.sh"; . "$REPO/lib/protecoes.sh"
        for f in "$REPO"/lib/enterprise/*.sh; do . "$f"; done
        s_ok() { printf "ok %s\n" "$1"; }; s_aviso() { printf "aviso %s\n" "$1"; }; s_mal() { printf "mal %s\n" "$1"; }
        ent_status_auditoria_completa; ent_status_sso' _ "$REPO"
}
status_aud >"$TMP/o.txt" 2>&1
afirma "status: corrente integra" grep -q "ok auditoria externa: corrente integra" "$TMP/o.txt"
afirma "status: fila externa em dia" grep -q "ok auditoria externa: em dia" "$TMP/o.txt"
afirma "status: login unico configurado" grep -q "ok login unico (obrigatorio): oidc" "$TMP/o.txt"
afirma "status: avisa que falta a conta de emergencia" grep -q "aviso login unico: o SSO é obrigatório e não há conta de emergência" "$TMP/o.txt"
monitor_aud() {
    bash -c 'set -uo pipefail; REPO="$1"; APP_DIR="$REPO"; . "$REPO/lib/comum.sh"; . "$REPO/lib/protecoes.sh"
        for f in "$REPO"/lib/enterprise/*.sh; do . "$f"; done
        MON_PROBLEMAS=(); _mon_checar_auditoria_externa; printf "%s\n" "${MON_PROBLEMAS[@]:-}"' _ "$REPO"
}
mkdir -p "$LIB/web"
printf '{"pendentes_desde":"%s","ultimo_erro":"coletor fora do ar"}\n' "$(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" >"$LIB/web/auditoria-externa-estado.json"
monitor_aud >"$TMP/o.txt" 2>&1
nega "monitor: 30 minutos de atraso ainda nao e problema" grep -q "auditoria-externa" "$TMP/o.txt"
printf '{"pendentes_desde":"%s","ultimo_erro":"coletor fora do ar"}\n' "$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)" >"$LIB/web/auditoria-externa-estado.json"
monitor_aud >"$TMP/o.txt" 2>&1
afirma "monitor: mais de 1 hora parada vira problema" grep -q "auditoria-externa.*parada ha" "$TMP/o.txt"
afirma "monitor: o problema traz a causa e o que fazer" grep -q "coletor fora do ar.*dgclaw auditoria externa testar" "$TMP/o.txt"
printf '{"corrente_alterada":true}\n' >"$LIB/web/auditoria-externa-estado.json"
monitor_aud >"$TMP/o.txt" 2>&1
afirma "monitor: corrente alterada vira problema" grep -q "auditoria-externa-alterada" "$TMP/o.txt"
rm -f "$ETC/auditoria-externa.json"
monitor_aud >"$TMP/o.txt" 2>&1
afirma "monitor: nivel externa sem destino vira problema" grep -q "falta o destino" "$TMP/o.txt"

echo "nivel pessoal de volta: nada disso existe"
nivel_na_raiz pessoal
dgclaw sso status >"$TMP/o.txt" 2>&1
afirma "status do sso volta a modo nao" grep -q "modo nao" "$TMP/o.txt"
status_aud >"$TMP/o.txt" 2>&1
nega "nenhuma linha de status no pessoal" grep -q "." "$TMP/o.txt"

fim
