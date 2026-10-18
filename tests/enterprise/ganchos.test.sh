#!/usr/bin/env bash
# Despachante e ganchos (lib/enterprise/base.sh) e a prova de que no nivel pessoal a CLI nao muda.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

echo "ganchos: despachante"
cat >"$TMP/despachante.sh" <<'FIM'
ent_cmd_ola() { echo "ola $*"; }
ent_cmd_dois_nomes() { echo "dois $1"; return 3; }
FIM
lib_com() { # lib_com <arquivo extra> <funcao...>
    local extra="$1"; shift
    bash -c 'set -euo pipefail; REPO="$1"; extra="$2"; shift 2; APP_DIR="$REPO"
        . "$REPO/lib/comum.sh"; . "$REPO/lib/protecoes.sh"; . "$REPO/lib/enterprise/base.sh"; . "$extra"
        "$@"' _ "$REPO" "$extra" "$@"
}
igual "chama ent_cmd_<cmd> com os argumentos" "ola a b" "$(lib_com "$TMP/despachante.sh" ent_despachar ola a b)"
lib_com "$TMP/despachante.sh" ent_despachar dois-nomes x >/dev/null; igual "traco vira sublinhado e o codigo de saida passa" 3 "$?"
lib_com "$TMP/despachante.sh" ent_despachar nao-existe >/dev/null 2>&1; igual "comando que ninguem tem devolve 127" 127 "$?"
lib_com "$TMP/despachante.sh" ent_despachar >/dev/null 2>&1; igual "sem comando devolve 127" 127 "$?"
lib_com "$TMP/despachante.sh" ent_despachar 'ola;rm' >/dev/null 2>&1; igual "nome com caracter estranho devolve 127" 127 "$?"
lib_com "$TMP/despachante.sh" ent_despachar 'Ola' >/dev/null 2>&1; igual "maiuscula devolve 127" 127 "$?"

echo "ganchos: executor por prefixo"
cat >"$TMP/ganchos.sh" <<'FIM'
ent_args_container_b() { local -n _a="$1"; _a+=(--opcao-b "$2"); }
ent_args_container_a() { local -n _a="$1"; _a+=(--opcao-a "$2"); }
ent_args_container_c() { local -n _a="$1"; _a+=(--opcao-c "$2"); }
ent_status_a() { echo "status x"; }
ent_status_m() { echo "status falhou"; return 7; }
ent_status_zz() { echo "status zz"; }
FIM
cat >"$TMP/roda-args.sh" <<'FIM'
args=(create --name x)
ent_rodar_ganchos ent_args_container_ args ana
printf '%s\n' "${args[*]}"
FIM
igual "ganchos de argumentos rodam em ordem alfabetica e mexem no array do chamador" \
    "create --name x --opcao-a ana --opcao-b ana --opcao-c ana" "$(lib_com "$TMP/ganchos.sh" source "$TMP/roda-args.sh")"
igual "prefixo sem nenhum gancho nao faz nada" "" "$(lib_com "$TMP/ganchos.sh" ent_rodar_ganchos ent_nao_existe_ x)"
lib_com "$TMP/ganchos.sh" ent_rodar_ganchos ent_status_ >"$TMP/o.txt" 2>&1; igual "gancho que falha: devolve o codigo dele" 7 "$?"
afirma "gancho que falha: o proximo nao roda" bash -c "! grep -q 'status zz' '$TMP/o.txt'"
afirma "gancho que falha: a mensagem diz qual foi" grep -q "ent_status_m terminou com codigo 7" "$TMP/o.txt"
afirma "os que vieram antes rodaram" grep -q "status x" "$TMP/o.txt"

echo "ganchos: a CLI de verdade"
app_copia
nega "comando que ninguem tem continua sendo erro" "$CLI_COPIA" coisa
"$CLI_COPIA" coisa >"$TMP/o.txt" 2>&1
afirma "a mensagem de erro de sempre" grep -q "o comando 'coisa' nao existe" "$TMP/o.txt"
cat >"$TMP/app/lib/enterprise/zz-teste.sh" <<'FIM'
ent_cmd_exemplo() { echo "exemplo $*"; }
ent_args_container_zz() {
    local -n _args="$1"
    if protecao_ligada container_endurecido; then _args+=(--security-opt no-new-privileges); fi
}
ent_depois_de_criar_zz() { echo "depois-de-criar $1" >>"$STUB_LOG"; }
ent_status_zz() { s_ok "linha do gancho de status"; }
FIM
igual "a CLI despacha o comando enterprise" "exemplo 1 2" "$("$CLI_COPIA" exemplo 1 2)"

echo "ganchos: nivel pessoal deixa o podman create igual ao de antes"
"$CLI_COPIA" agente criar ana --nome "Ana" --dono "Marta" >"$TMP/saida.txt" 2>&1
igual "agente criou" 0 "$?"
grep '^podman create' "$STUB_LOG" | sed "s#$DGCLAW_RAIZ#@RAIZ@#g" >"$TMP/create.txt"
igual "pessoal: a linha do podman create e a mesma de antes dos ganchos (golden)" "$(cat "$REPO/tests/enterprise/golden/podman-create-pessoal.txt")" "$(cat "$TMP/create.txt")"
afirma "o gancho de depois-de-criar rodou" grep -q "depois-de-criar ana" "$STUB_LOG"

echo "ganchos: nivel escritorio deixa o gancho acrescentar, antes da imagem"
preparar
app_copia
cat >"$TMP/app/lib/enterprise/zz-teste.sh" <<'FIM'
ent_args_container_zz() {
    local -n _args="$1"
    if protecao_ligada container_endurecido; then _args+=(--security-opt no-new-privileges); fi
}
FIM
nivel_na_raiz escritorio
"$CLI_COPIA" agente criar ana --nome "Ana" --dono "Marta" --uso setor --auth api >"$TMP/saida.txt" 2>&1
igual "escritorio: agente criou" 0 "$?"
linha="$(grep '^podman create' "$STUB_LOG")"
afirma "escritorio: o gancho acrescentou a opcao" bash -c "[[ '$linha' == *'--security-opt no-new-privileges'* ]]"
afirma "escritorio: a imagem continua sendo o ultimo item" bash -c "[[ '$linha' == *' localhost/dgclaw-agente:latest' ]]"

echo "ganchos: status mostra versao e nivel e chama os ganchos"
preparar
app_copia
cat >"$TMP/app/lib/enterprise/zz-teste.sh" <<'FIM'
ent_status_zz() { s_ok "linha do gancho de status"; }
FIM
touch "$STUB_ESTADO/svc-caddy"
"$CLI_COPIA" status >"$TMP/o.txt" 2>&1
afirma "status mostra a versao e o nivel" grep -q "versao 1.0.0, nivel de protecao: pessoal" "$TMP/o.txt"
afirma "status chama os ganchos ent_status_" grep -q "linha do gancho de status" "$TMP/o.txt"

echo "ganchos: auditoria das acoes da CLI"
preparar
nivel_na_raiz empresa
dgclaw agente criar ana --nome "Ana" --uso setor --auth api >/dev/null 2>&1
dgclaw agente remover ana --sim >/dev/null 2>&1
LOGA="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"
igual "criar e remover foram auditados" "agente.criar agente.remover" "$(jq -r .evento "$LOGA" | paste -sd' ')"
nivel_na_raiz pessoal
rm -f "$LOGA"
dgclaw agente criar bia --nome "Bia" >/dev/null 2>&1
nega "no pessoal a CLI nao cria arquivo de auditoria" test -e "$LOGA"

fim
