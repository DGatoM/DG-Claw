#!/usr/bin/env bash
# Bloco J, nivel regulado inteiro: nivel definir + protecoes aplicar + agente criar com stubs, teste de restauracao assinado,
# e a prova de que escritorio/empresa continuam como estavam. Nada de sistema roda de verdade.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-j.sh
. "$(dirname "$0")/_bloco-j.sh"
PATH_ORIG="$PATH"
novo() {
    PATH="$PATH_ORIG"
    preparar; stubs_j ""
    export STUB_RESTIC="$TMP/repo-restic"
    app_copia
    AUD="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"
}

echo "regulado: dgclaw nivel definir regulado + protecoes aplicar + agente criar"
novo
export DGCLAW_QUEM=testador
"$CLI_COPIA" nivel definir regulado >"$TMP/o.txt" 2>&1
igual "nivel definir regulado" 0 "$?"
igual "runtime = gvisor" gvisor "$(lib protecao_valor runtime)"
igual "disco_cifrado = externo" externo "$(lib protecao_valor disco_cifrado)"
igual "backup_retencao_dias = 14" 14 "$(lib protecao_valor backup_retencao_dias)"
igual "retencao_dias = 30" 30 "$(lib protecao_valor retencao_dias)"
igual "admin_llm continua ligado por padrao (desligar e escolha)" true "$(lib protecao_valor admin_llm)"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "protecoes aplicar nao quebra e fala do disco externo sem metodo" grep -q "disco esta no modo externo sem metodo configurado" "$TMP/o.txt"
printf 'DGCLAW_PANEL_USER=maria\n' >"$ETC/web.env"
"$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >"$TMP/o.txt" 2>&1
igual "agente criou" 0 "$?"
linha="$(grep '^podman create .*--name dgclaw-ana ' "$STUB_LOG" | head -n 1)"
afirma "o array do podman tem --runtime runsc" bash -c "[[ '$linha' == *'--runtime runsc'* ]]"
afirma "tem cap-drop=ALL e no-new-privileges" bash -c "[[ '$linha' == *'--cap-drop=ALL'* && '$linha' == *'--security-opt no-new-privileges'* ]]"
afirma "tem o cofre em memoria e o limite de pids" bash -c "[[ '$linha' == *'run/dgclaw/cofres/ana:/run/dgclaw/cofre:ro'* && '$linha' == *'--pids-limit 1024'* ]]"
afirma "e a politica de proxy do podman continua desligada (--http-proxy=false)" bash -c "[[ '$linha' == *'--http-proxy=false'* ]]"
"$CLI_COPIA" status >"$TMP/o.txt" 2>&1
afirma "dgclaw status mostra o nivel regulado" grep -q "nivel de protecao: regulado" "$TMP/o.txt"
afirma "dgclaw status lista o gVisor" grep -q "gVisor instalado" "$TMP/o.txt"
afirma "dgclaw status avisa da chave do disco" grep -q "chave do disco\|disco no modo externo" "$TMP/o.txt"

echo "regulado: o mesmo agente em escritorio e empresa nao ganha nada do bloco J"
for nivel in escritorio empresa; do
    novo
    nivel_na_raiz "$nivel"
    printf 'DGCLAW_PANEL_USER=maria\n' >"$ETC/web.env"
    "$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >/dev/null 2>&1
    afirma "$nivel: sem --runtime" bash -c "! grep -q -- '--runtime' '$STUB_LOG'"
    afirma "$nivel: nenhuma prova do gVisor" bash -c "! grep -q 'dgclaw-prova-runtime' '$STUB_LOG'"
    afirma "$nivel: nenhum arquivo do bloco J criado" bash -c "[ ! -e '$ETC/disco-externo.json' ] && [ ! -e '$ETC/runtime-sem-reforco' ] && [ ! -e '$ETC/agentes.json.admin-desligado' ]"
    "$CLI_COPIA" status >"$TMP/o.txt" 2>&1
    afirma "$nivel: dgclaw status nao fala de gVisor nem de Tang" bash -c "! grep -qi 'gvisor\|tang\|trancad' '$TMP/o.txt'"
done

echo "regulado: teste de restauracao mensal com relatorio assinado pela auditoria"
novo
nivel_na_raiz regulado
printf 'DGCLAW_PANEL_USER=maria\n' >"$ETC/web.env"
"$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >/dev/null 2>&1
mkdir -p "$LIB/agentes/ana/home/memory"; echo "lembrar" >"$LIB/agentes/ana/home/memory/a.md"
printf 'AWS_ACCESS_KEY_ID=AKIAEXEMPLO\nAWS_SECRET_ACCESS_KEY=chave-secreta-123456\n' >"$TMP/cred.txt"
"$CLI_COPIA" backup configurar --repositorio "s3:https://s3.exemplo.com/bucket" --credenciais "$TMP/cred.txt" >/dev/null 2>&1 </dev/null
"$CLI_COPIA" backup agora >/dev/null 2>&1
"$CLI_COPIA" backup testar >"$TMP/o.txt" 2>&1
igual "backup testar passa" 0 "$?"
REL="$(find "$LIB/backup/relatorios" -name 'teste-restauracao-*.json' | head -n 1)"
afirma "o relatorio existe, com modo 600" bash -c "[ -f '$REL' ] && [ \$(stat -c %a '$REL') = 600 ]"
afirma "o relatorio diz resultado ok, snapshot e quantos arquivos" jq -e '.resultado == "ok" and (.snapshot | test("^snap")) and .arquivos_conferidos >= 1' "$REL"
SHA="$(sha256sum <"$REL" | cut -d' ' -f1)"
# shellcheck disable=SC2016 # $h e do jq
afirma "o evento da auditoria carrega o sha256 do relatorio" jq -e --arg h "$SHA" 'select(.evento == "backup.teste_restauracao" and .dados.relatorio_sha256 == $h)' "$AUD"
echo "mudar o relatorio depois quebra a conferencia"
echo '{"resultado":"adulterado"}' >"$REL"
igual "o sha256 do relatorio mudado nao bate mais com o evento" 0 "$(jq -r --arg h "$(sha256sum <"$REL" | cut -d' ' -f1)" 'select(.evento == "backup.teste_restauracao" and .dados.relatorio_sha256 == $h) | 1' "$AUD" | wc -l)"
lib_d ent_instalar_backup >/dev/null 2>&1
afirma "o timer de teste e mensal no regulado" grep -q "OnCalendar=\*-\*-01 05:00:00" "$DGCLAW_RAIZ/etc/systemd/system/dgclaw-backup-teste.timer"

echo "escritorio: o teste de restauracao nao gera relatorio nem hash extra"
novo
nivel_na_raiz escritorio
printf 'DGCLAW_PANEL_USER=maria\n' >"$ETC/web.env"
"$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >/dev/null 2>&1
mkdir -p "$LIB/agentes/ana/home/memory"; echo "lembrar" >"$LIB/agentes/ana/home/memory/a.md"
"$CLI_COPIA" backup configurar --repositorio "s3:https://s3.exemplo.com/bucket" --credenciais "$TMP/cred.txt" >/dev/null 2>&1 </dev/null
"$CLI_COPIA" backup agora >/dev/null 2>&1
"$CLI_COPIA" backup testar >/dev/null 2>&1
afirma "sem pasta de relatorios" test ! -e "$LIB/backup/relatorios"
afirma "o evento nao tem relatorio_sha256" bash -c "! jq -e 'select(.evento == \"backup.teste_restauracao\") | .dados.relatorio_sha256' '$AUD' | grep -q ."

fim
