#!/usr/bin/env bash
# Bloco E, credencial da empresa: --uso pessoa|setor obrigatorio, regras de auth, dono na lista da pessoa,
# marca para o painel e nivel pessoal intacto.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
preparar
stubs_d
app_copia

agente_json() { jq -c --arg s "$1" '.agentes[] | select(.slug == $s)' "$ETC/agentes.json"; }

echo "credencial: nivel pessoal cria como sempre (sem --uso)"
"$CLI_COPIA" agente criar ana --nome "Ana" >"$TMP/o.txt" 2>&1
igual "pessoal: agente criar sem --uso funciona" 0 "$?"
igual "pessoal: o registro nao ganha uso nem dono" "null" "$(agente_json ana | jq -c '.uso')"
afirma "pessoal: nao ha marca de credencial_empresa para o painel" bash -c "[ ! -e '$LIB/agentes/ana/config/credencial-empresa' ]"
nega "pessoal: --uso invalido e recusado" "$CLI_COPIA" agente criar bia --nome "Bia" --uso familia
"$CLI_COPIA" agente criar bia --nome "Bia" --uso familia >"$TMP/o.txt" 2>&1
afirma "a mensagem lista os usos que existem" grep -q "pessoa" "$TMP/o.txt"

echo "credencial: escritorio exige --uso"
preparar; stubs_d; app_copia
nivel_na_raiz escritorio
"$CLI_COPIA" usuario criar fran --papel funcionario >/dev/null 2>&1
igual "usuario fran criado" 0 "$?"
nega "sem --uso: recusa" "$CLI_COPIA" agente criar ana --nome "Ana"
"$CLI_COPIA" agente criar ana --nome "Ana" >"$TMP/o.txt" 2>&1
afirma "a mensagem pede --uso pessoa|setor e diz por que" bash -c "grep -q -- '--uso pessoa|setor' '$TMP/o.txt' && grep -q 'intransferivel' '$TMP/o.txt'"
afirma "nenhum podman create rodou" bash -c "! grep -q '^podman create' '$STUB_LOG'"
nega "setor com assinatura: recusa" "$CLI_COPIA" agente criar sac --nome "SAC" --uso setor
"$CLI_COPIA" agente criar sac --nome "SAC" --uso setor >"$TMP/o.txt" 2>&1
afirma "a mensagem manda usar --auth api" grep -q -- "--auth api" "$TMP/o.txt"
nega "pessoa com --auth api: recusa" "$CLI_COPIA" agente criar ana --nome "Ana" --uso pessoa --usuario fran --auth api
nega "pessoa sem --usuario: recusa" "$CLI_COPIA" agente criar ana --nome "Ana" --uso pessoa
"$CLI_COPIA" agente criar ana --nome "Ana" --uso pessoa >"$TMP/o.txt" 2>&1
afirma "a mensagem manda ver os logins" grep -q "usuario listar" "$TMP/o.txt"
nega "pessoa com usuario que nao existe: recusa" "$CLI_COPIA" agente criar ana --nome "Ana" --uso pessoa --usuario ninguem

echo "credencial: agente de pessoa"
"$CLI_COPIA" agente criar ana --nome "Ana" --uso pessoa --usuario fran >"$TMP/o.txt" 2>&1
igual "pessoa com usuario existente: cria" 0 "$?"
igual "o registro tem uso pessoa" '"pessoa"' "$(agente_json ana | jq -c '.uso')"
igual "o registro tem o dono" '"fran"' "$(agente_json ana | jq -c '.dono')"
igual "o agente entrou na lista da fran" '["ana"]' "$(jq -c '.usuarios[] | select(.usuario == "fran") | .agentes' "$LIB/web/usuarios.json")"
afirma "a marca para o painel existe no config do agente" bash -c "[ -s '$LIB/agentes/ana/config/credencial-empresa' ]"
afirma "a marca explica o motivo em portugues" grep -q "assento" "$LIB/agentes/ana/config/credencial-empresa"
afirma "auditou o uso" bash -c "jq -e 'select(.evento == \"agente.uso\" and .dados.slug == \"ana\" and .dados.uso == \"pessoa\")' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl'"

echo "credencial: agente de setor"
"$CLI_COPIA" agente criar sac --nome "SAC" --uso setor --auth api >"$TMP/o.txt" 2>&1
igual "setor com --auth api: cria" 0 "$?"
igual "o registro tem uso setor" '"setor"' "$(agente_json sac | jq -c '.uso')"
igual "agente de setor nao tem dono" "null" "$(agente_json sac | jq -c '.dono')"

echo "credencial: agente uso (agente que ja existia)"
nega "uso pessoa sem --usuario e recusado" "$CLI_COPIA" agente uso sac pessoa
"$CLI_COPIA" agente uso sac pessoa >"$TMP/o.txt" 2>&1
afirma "a mensagem pede o --usuario" grep -q "precisa de --usuario" "$TMP/o.txt"
"$CLI_COPIA" agente uso sac setor >"$TMP/o.txt" 2>&1
igual "agente uso setor funciona" 0 "$?"
nega "agente que nao existe" "$CLI_COPIA" agente uso zzz setor
nega "uso que nao existe" "$CLI_COPIA" agente uso sac familia

echo "credencial: protecoes aplicar escreve a marca e avisa de agente sem uso"
printf '{"versao": 1, "agentes": [{"slug":"velho","nome":"Velho","tipo":"agente"}]}\n' >"$ETC/agentes.json"
mkdir -p "$LIB/agentes/velho/config"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "marca escrita no agente antigo" bash -c "[ -s '$LIB/agentes/velho/config/credencial-empresa' ]"
afirma "avisa que o agente antigo nao tem uso" grep -q "sem uso definido: velho" "$TMP/o.txt"
nivel_na_raiz pessoal
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "voltar para pessoal apaga a marca" bash -c "[ ! -e '$LIB/agentes/velho/config/credencial-empresa' ]"

fim
