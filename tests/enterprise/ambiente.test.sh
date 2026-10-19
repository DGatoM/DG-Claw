#!/usr/bin/env bash
# A secao "Onde voce esta e o que voce consegue fazer" no identidade.md: o que cada protecao acrescenta
# (lib/enterprise/ambiente.sh, templates/ambiente/enterprise/) e a prova de que no nivel pessoal nada muda.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
preparar
stubs_d
AMB="$REPO/templates/ambiente/enterprise"

echo "ambiente enterprise: os trechos seguem as regras do main"
for t in container travas ferramentas admin-isolado; do
    afirma "$t.md existe" test -s "$AMB/$t.md"
    nega "$t.md sem travessao nem en dash" grep -q $'—\|–' "$AMB/$t.md"
    nega "$t.md sem a formula 'nao e sobre X'" grep -qiE 'não é (sobre|só|apenas|uma questão)|não se trata' "$AMB/$t.md"
    igual "$t.md so usa os campos NOME, DONO e SLUG" "" "$(grep -o '{{[^}]*}}' "$AMB/$t.md" | sort -u | grep -vxE '\{\{(NOME|DONO|SLUG)\}\}')"
done

app_copia
ID="$DGCLAW_RAIZ/var/lib/dgclaw/agentes/ana/home/.plataforma/identidade.md"

echo "ambiente enterprise: nivel pessoal, o identidade.md e o do main"
"$CLI_COPIA" agente criar ana --nome "Ana" --dono "Marta" >/dev/null 2>&1
igual "agente criou" 0 "$?"
nega "pessoal: sem trecho de caixa endurecida" grep -q "proteções da empresa" "$ID"
nega "pessoal: sem trecho de travas" grep -q "passam por uma pessoa" "$ID"
nega "pessoal: sem trecho de ferramentas" grep -q "dgclaw-ferramenta" "$ID"
SOMA_PESSOAL="$(sha256sum "$ID" | cut -d' ' -f1)"
"$CLI_COPIA" agente identidade ana >/dev/null 2>&1
igual "pessoal: regravar nao muda nada" "$SOMA_PESSOAL" "$(sha256sum "$ID" | cut -d' ' -f1)"

echo "ambiente enterprise: escritorio acrescenta a caixa endurecida e as travas"
nivel_na_raiz escritorio
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
igual "protecoes aplicar sai com 0" 0 "$?"
afirma "o aplicar regravou a identidade" grep -q "identidade dos agentes diz o que o nivel escritorio pede" "$TMP/o.txt"
afirma "escritorio: trecho da caixa endurecida" grep -q "Sua caixa tem as proteções da empresa" "$ID"
afirma "escritorio: o campo SLUG foi preenchido (dgclaw agente pacote ana)" grep -q "dgclaw agente pacote ana <pacote>" "$ID"
afirma "escritorio: trecho das travas" grep -q "Ações para fora da empresa passam por uma pessoa" "$ID"
afirma "escritorio: o ig-publish travado esta descrito" grep -q "ig-publish.py" "$ID"
nega "escritorio: sem ferramentas (kit_sensivel so liga em empresa)" grep -q "dgclaw-ferramenta" "$ID"
nega "escritorio: o agente comum nao ganha o trecho do Admin" grep -q "Você é o Admin isolado" "$ID"
afirma "o trecho vem depois da secao do main" bash -c "[ \$(grep -n 'Onde você está e o que você consegue fazer' '$ID' | head -1 | cut -d: -f1) -lt \$(grep -n 'Sua caixa tem as proteções' '$ID' | cut -d: -f1) ]"

echo "ambiente enterprise: empresa acrescenta as ferramentas fechadas"
nivel_na_raiz empresa
"$CLI_COPIA" agente identidade ana >/dev/null 2>&1
afirma "empresa: trecho das ferramentas" grep -q "dgclaw-ferramenta listar" "$ID"

echo "ambiente enterprise: o Admin isolado recebe o trecho dele e nao o do agente"
# O Admin (slug admin) pelo gancho, com o renderizador trocado por cat: o que importa e QUAL trecho sai.
cat >"$TMP/admin.sh" <<'FIM'
C_NOME=X; C_DONO_TEXTO=Y; C_SLUG=admin; C_PAPEL=p; C_JEITO=j; C_DATA=2026-01-01
renderizar_template() { cat "$1"; }
ent_rodar_ganchos ent_ambiente_extra_ admin
FIM
saida_admin() { lib_d source "$TMP/admin.sh"; }
SAIDA_ADMIN="$(saida_admin)"
afirma "slug admin: trecho do dgclaw-controle" grep -q "dgclaw-controle ops" <<<"$SAIDA_ADMIN"
nega "slug admin: sem ferramentas nem travas" grep -qE "dgclaw-ferramenta|ig-publish" <<<"$SAIDA_ADMIN"
afirma "slug admin: com a caixa endurecida tambem" grep -q "sudo" <<<"$SAIDA_ADMIN"
nivel_na_raiz pessoal
igual "pessoal: nada para o Admin" "" "$(saida_admin admin)"

fim
