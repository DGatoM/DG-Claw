#!/usr/bin/env bash
# dgclaw nivel (mostrar, definir, ajustar, org) e dgclaw protecoes aplicar, pela CLI de verdade.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
export DGCLAW_QUEM=testador
LOGA="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"

echo "nivel: pessoal por padrao"
dgclaw nivel >"$TMP/o.txt" 2>&1
igual "mostrar sai com 0" 0 "$?"
afirma "mostra o nivel pessoal" grep -q "Nivel de protecao: pessoal" "$TMP/o.txt"
afirma "mostra a tabela com 22 chaves" bash -c "[ \$(grep -cE '^[a-z0-9_]+ +[a-z0-9]+ +[a-z0-9]+' '$TMP/o.txt') -ge 22 ]"
afirma "diz que nenhuma protecao enterprise esta ligada" grep -q "nenhuma protecao enterprise esta ligada" "$TMP/o.txt"
dgclaw nivel mostrar >/dev/null 2>&1; igual "mostrar explicito tambem funciona" 0 "$?"

echo "nivel: definir"
dgclaw nivel definir empresa >"$TMP/o.txt" 2>&1
igual "definir empresa sai com 0" 0 "$?"
afirma "o nivel foi gravado" jq -e '.nivel == "empresa"' "$ETC/protecoes.json"
igual "o arquivo e 600" 600 "$(stat -c %a "$ETC/protecoes.json")"
afirma "avisa para rodar protecoes aplicar" grep -q 'dgclaw protecoes aplicar' "$TMP/o.txt"
igual "subir de nivel liga a trilha e a primeira linha e a mudanca" "nivel.definir" "$(jq -r .evento "$LOGA" | paste -sd' ')"
igual "com de e para" "pessoal>empresa" "$(jq -r '.dados | "\(.de)>\(.para)"' "$LOGA")"
dgclaw nivel >"$TMP/o.txt" 2>&1
afirma "agora a tabela mostra 2fa = todos e travado" grep -qE '^2fa +todos +todos +travado' "$TMP/o.txt"
nega "nivel inexistente recusado" dgclaw nivel definir supremo
dgclaw nivel definir supremo >"$TMP/o.txt" 2>&1
afirma "a recusa lista os niveis" grep -q "pessoal escritorio empresa regulado" "$TMP/o.txt"
nega "definir sem nivel" dgclaw nivel definir
igual "o nivel nao mudou com os erros" empresa "$(jq -r .nivel "$ETC/protecoes.json")"

echo "nivel: ajustar"
dgclaw nivel ajustar sessao_horas 24 >"$TMP/o.txt" 2>&1
igual "ajustar sai com 0" 0 "$?"
afirma "mostra de -> para" grep -q "sessao_horas: 72 -> 24" "$TMP/o.txt"
afirma "avisa para aplicar" grep -q 'dgclaw protecoes aplicar' "$TMP/o.txt"
igual "registrado na auditoria" "nivel.definir nivel.ajustar" "$(jq -r .evento "$LOGA" | paste -sd' ')"
dgclaw nivel ajustar 2fa nao >"$TMP/o.txt" 2>&1
igual "abaixo da trava: sai com 1" 1 "$?"
afirma "abaixo da trava: explica" grep -q "trava" "$TMP/o.txt"
igual "recusa nao entra na auditoria" 2 "$(wc -l <"$LOGA" | tr -d ' ')"
nega "chave inexistente" dgclaw nivel ajustar xpto 1
nega "sem valor" dgclaw nivel ajustar sessao_horas

echo "nivel: org"
dgclaw nivel org 123e4567-e89b-12d3-a456-426614174000 >"$TMP/o.txt" 2>&1
igual "org sai com 0" 0 "$?"
afirma "uuid gravado" jq -e '.org_uuid == "123e4567-e89b-12d3-a456-426614174000" and .nivel == "empresa" and .ajustes.sessao_horas == 24' "$ETC/protecoes.json"
nega "uuid invalido recusado" dgclaw nivel org 12345
dgclaw nivel >"$TMP/o.txt" 2>&1
afirma "a tabela mostra a organizacao" grep -q "123e4567-e89b-12d3-a456-426614174000" "$TMP/o.txt"

echo "nivel: rebaixar tambem fica na trilha"
dgclaw nivel definir pessoal >/dev/null 2>&1
igual "o ultimo evento e o rebaixamento" "empresa>pessoal" "$(tail -n 1 "$LOGA" | jq -r '.dados | "\(.de)>\(.para)"')"
nega "e depois disso nao grava mais nada" bash -c "n=\$(wc -l <'$LOGA'); '$CLI' nivel org 123e4567-e89b-12d3-a456-426614174000 >/dev/null 2>&1; [ \$(wc -l <'$LOGA') -ne \$n ]"
igual "o ajuste valido sobreviveu ao rebaixamento" 24 "$(dgclaw nivel 2>/dev/null | awk '$1 == "sessao_horas" {print $2}')"

echo "nivel: ensaio nao grava"
rm -f "$ETC/protecoes.json" "$LOGA"
dgclaw --ensaio nivel definir escritorio >"$TMP/o.txt" 2>&1
igual "ensaio sai com 0" 0 "$?"
nega "ensaio nao cria o arquivo" test -e "$ETC/protecoes.json"

echo "protecoes aplicar"
dgclaw nivel definir escritorio >/dev/null 2>&1
dgclaw protecoes aplicar >"$TMP/o.txt" 2>&1
igual "sem ganchos sai com 0" 0 "$?"
# Cada bloco enterprise que entra (retencao, monitor...) traz o proprio ent_aplicar_*: com ganchos a
# mensagem e "protecoes aplicadas"; sem nenhum, "nenhuma protecao desta versao".
afirma "diz que aplicou, ou que nada precisa ser levado" grep -qE "nenhuma protecao desta versao|protecoes aplicadas" "$TMP/o.txt"
nega "subcomando desconhecido" dgclaw protecoes xpto
app_copia
cat >"$TMP/app/lib/enterprise/zz-teste.sh" <<'FIM'
ent_aplicar_zz() { echo "aplicando $(protecao_nivel)" >>"$STUB_LOG"; }
FIM
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "com gancho, ele roda com o nivel atual" grep -q "aplicando escritorio" "$STUB_LOG"
igual "protecoes.aplicar auditado" "protecoes.aplicar" "$(jq -r .evento "$LOGA" | tail -n 1)"

fim
