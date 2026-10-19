#!/usr/bin/env bash
# lib/protecoes.sh e a matriz: padroes por nivel, trava, ajuste, org e arquivo ruim.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

# --- a matriz em si ---------------------------------------------------------------------
igual "a matriz tem as 22 chaves do desenho" 22 "$(jq '.chaves | length' "$MATRIZ")"
afirma "toda chave tem descricao, como e porque" jq -e '[.chaves[] | select((.descricao // "") == "" or (.como // "") == "" or (.porque // "") == "")] | length == 0' "$MATRIZ"
afirma "toda chave tem valor nos 4 niveis" jq -e '[.chaves[] | select(((.nivel | keys | sort) != ["empresa","escritorio","pessoal","regulado"]))] | length == 0' "$MATRIZ"
# shellcheck disable=SC2016 # codigo jq
afirma "o valor de cada nivel e do tipo certo" jq -e '
    [.chaves[] | . as $c | .nivel[] |
        select( ($c.tipo == "bool" and (type != "boolean"))
             or ($c.tipo == "enum" and (. as $v | $c.valores | index($v) == null))
             or ($c.tipo == "numero" and (type != "number")) )] | length == 0' "$MATRIZ"
afirma "nenhum texto da matriz tem travessao" bash -c "! grep -q '—\|–' '$MATRIZ'"
igual "travadas no escritorio" "2fa admin_isolado auditoria backup cofre_cifrado container_endurecido credencial_empresa disco_cifrado https_endurecido monitoramento multiusuario politicas_claude travas_externas" \
    "$(jq -r '.chaves | to_entries[] | select(.value.travado.escritorio == true) | .key' "$MATRIZ" | sort | paste -sd' ')"
igual "travadas so no regulado" "kit_sensivel saida sigilo_externo sso" \
    "$(jq -r '.chaves | to_entries[] | select(.value.travado.regulado == true and (.value.travado.empresa // false) == false) | .key' "$MATRIZ" | sort | paste -sd' ')"

# --- sem arquivo = pessoal ----------------------------------------------------------------------
igual "sem arquivo o nivel e pessoal" pessoal "$(lib protecao_nivel)"
igual "pessoal: 2fa nao" nao "$(lib protecao_valor 2fa)"
igual "pessoal: sessao_horas 720" 720 "$(lib protecao_valor sessao_horas)"
nega "pessoal: 2fa desligado" lib protecao_ligada 2fa
nega "pessoal: auditoria desligada" lib protecao_ligada auditoria
nega "pessoal: runtime runc nao conta como ligado" lib protecao_ligada runtime
afirma "pessoal: admin_llm ligado" lib protecao_ligada admin_llm
afirma "pessoal: sigilo_externo ligado" lib protecao_ligada sigilo_externo
nega "chave que nao existe e erro" lib protecao_valor nao_existe
lib protecao_valor nao_existe >"$TMP/o.txt" 2>&1
afirma "o erro diz qual chave nao existe" grep -q "nao_existe" "$TMP/o.txt"

# --- padroes por nivel (a tabela do desenho) -----------------------------------------------------
conferir() { # nivel chave esperado
    nivel_na_raiz "$1"
    igual "$1: $2 = $3" "$3" "$(lib protecao_valor "$2")"
}
conferir escritorio 2fa ti;            conferir empresa 2fa todos;           conferir regulado 2fa todos
conferir escritorio auditoria basica;  conferir empresa auditoria completa;  conferir regulado auditoria externa
conferir escritorio sessao_horas 168;  conferir empresa sessao_horas 72;     conferir regulado sessao_horas 12
conferir regulado runtime gvisor;      conferir empresa runtime runc
conferir regulado disco_cifrado externo; conferir empresa disco_cifrado auto
conferir regulado backup_retencao_dias 14; conferir empresa backup_retencao_dias 30
conferir escritorio retencao_dias 180; conferir regulado retencao_dias 30
conferir escritorio sigilo_externo false; conferir regulado sso obrigatorio; conferir escritorio sso opcional
conferir regulado saida bloqueio;      conferir escritorio saida registro
conferir escritorio kit_sensivel false; conferir empresa kit_sensivel true
conferir regulado admin_llm true
conferir escritorio multiusuario true
nivel_na_raiz regulado
afirma "regulado: runtime gvisor conta como ligado" lib protecao_ligada runtime
afirma "regulado: 2fa todos ligado" lib protecao_ligada 2fa
nega "regulado: sigilo_externo desligado" lib protecao_ligada sigilo_externo

# --- ajuste -------------------------------------------------------------------------------------
nivel_na_raiz escritorio
afirma "sobe 2fa de ti para todos" lib protecao_ajustar 2fa todos
igual "o ajuste vale" todos "$(lib protecao_valor 2fa)"
igual "o arquivo continua 600" 600 "$(stat -c %a "$ETC/protecoes.json")"
nega "desce 2fa abaixo da trava (nao)" lib protecao_ajustar 2fa nao
lib protecao_ajustar 2fa nao >"$TMP/o.txt" 2>&1
afirma "a recusa explica a trava e diz o que fazer" grep -q "trava" "$TMP/o.txt"
afirma "a recusa diz o que fazer" grep -q "O que fazer" "$TMP/o.txt"
igual "a recusa nao mexeu no ajuste" todos "$(lib protecao_valor 2fa)"
nega "bool travado nao desliga" lib protecao_ajustar backup false
afirma "chave nao travada pode descer (sessao_horas)" lib protecao_ajustar sessao_horas 24
igual "sessao_horas ajustada" 24 "$(lib protecao_valor sessao_horas)"
nega "numero invalido recusado" lib protecao_ajustar sessao_horas abc
nega "numero negativo recusado" lib protecao_ajustar sessao_horas -5
nega "enum fora da lista recusado" lib protecao_ajustar auditoria ultra
nega "bool com palavra recusado" lib protecao_ajustar backup talvez
nega "chave inexistente recusada" lib protecao_ajustar xpto true
nega "sem valor recusado" lib protecao_ajustar sessao_horas
nivel_na_raiz regulado
nega "regulado: sigilo_externo true e abaixo da trava" lib protecao_ajustar sigilo_externo true
afirma "regulado: admin_llm pode ser desligado" lib protecao_ajustar admin_llm false
igual "admin_llm desligado" false "$(lib protecao_valor admin_llm)"

# --- trocar de nivel ---------------------------------------------------------------------------
nivel_na_raiz escritorio '{"sessao_horas":24,"2fa":"todos"}'
afirma "grava o nivel empresa" lib protecao_gravar_nivel empresa
igual "nivel gravado" empresa "$(lib protecao_nivel)"
igual "ajuste valido sobrevive a troca de nivel" 24 "$(lib protecao_valor sessao_horas)"
nivel_na_raiz regulado '{"sessao_horas":12}'
lib protecao_gravar_nivel escritorio >/dev/null 2>&1
afirma "ajuste invalido some quando o nivel muda" jq -e '.ajustes | has("2fa") | not' "$ETC/protecoes.json"
nega "nivel inexistente recusado" lib protecao_gravar_nivel supremo
igual "o arquivo nao mudou com o nivel inexistente" escritorio "$(lib protecao_nivel)"

# --- arquivo com ajuste ruim na mao ------------------------------------------------------------
nivel_na_raiz empresa '{"2fa":"nao","sessao_horas":"muito"}'
igual "ajuste abaixo da trava e ignorado" todos "$(lib protecao_valor 2fa 2>/dev/null)"
lib protecao_valor 2fa >"$TMP/o.txt" 2>&1
afirma "o aviso diz a chave, o valor e o porque" grep -q "2fa = \"nao\"" "$TMP/o.txt"
igual "ajuste de tipo errado e ignorado" 72 "$(lib protecao_valor sessao_horas 2>/dev/null)"

# --- org e arquivo ilegivel ------------------------------------------------------------------
nivel_na_raiz empresa
afirma "grava o UUID da organizacao" lib protecao_org 123e4567-e89b-12d3-a456-426614174000
igual "le o UUID" 123e4567-e89b-12d3-a456-426614174000 "$(lib protecao_org)"
igual "o nivel sobreviveu" empresa "$(lib protecao_nivel)"
nega "UUID mal formado recusado" lib protecao_org 123
printf 'isso nao e json' >"$ETC/protecoes.json"
igual "arquivo ilegivel: pessoal" pessoal "$(lib protecao_nivel 2>/dev/null)"
lib protecao_nivel >"$TMP/o.txt" 2>&1
afirma "arquivo ilegivel: o aviso diz qual arquivo" grep -q "protecoes.json" "$TMP/o.txt"
nivel_na_raiz galactico
igual "nivel inexistente no arquivo: pessoal" pessoal "$(lib protecao_nivel 2>/dev/null)"

# --- raiz sem o arquivo: gravar cria com 600 ---------------------------------------------------
rm -f "$ETC/protecoes.json"
afirma "gravar o nivel cria o arquivo" lib protecao_gravar_nivel escritorio
igual "arquivo criado com 600" 600 "$(stat -c %a "$ETC/protecoes.json")"
afirma "arquivo e JSON com versao 1" jq -e '.versao == 1 and .nivel == "escritorio" and (.atualizado_em | length > 0)' "$ETC/protecoes.json"

fim
