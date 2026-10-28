#!/usr/bin/env bash
# A secao "Onde voce esta e o que voce consegue fazer" que entra no prompt de todo agente
# (templates/ambiente/) e o comando `dgclaw agente identidade` que a regrava.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/../cli/_comum.sh"
preparar

MARCA='## Onde você está e o que você consegue fazer'
AMB="$REPO/templates/ambiente"

echo "ambiente: os modelos"
for t in agente admin; do
    afirma "$t.md existe" test -s "$AMB/$t.md"
    igual "$t.md comeca com o titulo-marcador" "$MARCA" "$(head -1 "$AMB/$t.md")"
    nega "$t.md sem travessao nem en dash" grep -q $'—\|–' "$AMB/$t.md"
    nega "$t.md sem a formula 'nao e sobre X'" grep -qiE 'não é (sobre|só|apenas|uma questão)|não se trata' "$AMB/$t.md"
done
for t in agente admin; do
    igual "$t.md so usa os campos NOME, DONO e SLUG" "" "$(grep -o '{{[^}]*}}' "$AMB/$t.md" | sort -u | grep -vxE '\{\{(NOME|DONO|SLUG)\}\}')"
done
# O install.sh copia o admin.md cru para o .plataforma/ambiente.md do Admin, sem renderizar: campo ali chegaria
# literal ao prompt dele.
nega "admin.md sem campo {{...}} (o instalador nao renderiza)" grep -q '{{' "$AMB/admin.md"

echo "ambiente: toda doc de capacidade esta citada no agente.md"
while IFS= read -r doc; do
    [ -n "$doc" ] || continue
    afirma "o arquivo $doc existe" test -f "$REPO/$doc"
    afirma "agente.md cita $doc" grep -qF "$doc" "$AMB/agente.md"
done <"$AMB/capacidades.txt"

echo "ambiente: instrucao do audio transcrito"
for t in agente admin; do
    afirma "$t.md explica a marca [áudio transcrito]" grep -qF '[áudio transcrito]' "$AMB/$t.md"
done

echo "ambiente: dgclaw agente identidade"
criar_agente ana --nome "Ana" --dono "Marta"
ID="$DGCLAW_RAIZ/var/lib/dgclaw/agentes/ana/home/.plataforma/identidade.md"
AG="$DGCLAW_RAIZ/var/lib/dgclaw/agentes/ana/home/AGENT.md"
afirma "o criar ja grava a secao no identidade.md" grep -qxF "$MARCA" "$ID"
afirma "identidade traz a regra do canal" grep -q 'REGRA ZERO DO CANAL DG CHAT' "$ID"
afirma "identidade traz o AGENT.md" grep -q '^# Ana' "$ID"
afirma "o nome do agente foi renderizado" grep -q 'Você é Ana, um agente do DG Claw' "$ID"
nega "identidade sem campo {{...}} sobrando" grep -q '{{' "$ID"

# Agente antigo: identidade sem a secao.
grep -vF "$MARCA" "$ID" >"$TMP/velha.md" && cp "$TMP/velha.md" "$ID"
dgclaw status >"$TMP/status.txt" 2>&1
afirma "status avisa quando falta a secao" grep -q 'dgclaw agente identidade ana' "$TMP/status.txt"

dgclaw agente identidade ana >"$TMP/o.txt" 2>&1
igual "identidade sai com 0" "0" "$?"
afirma "a saida diz que nada foi reiniciado" grep -q 'nada foi reiniciado' "$TMP/o.txt"
afirma "a secao voltou" grep -qxF "$MARCA" "$ID"
dgclaw status >"$TMP/status.txt" 2>&1
nega "status calado depois de regravar" grep -q 'dgclaw agente identidade ana' "$TMP/status.txt"

h1="$(sha256sum "$ID" | cut -d' ' -f1)"
dgclaw agente identidade ana >/dev/null 2>&1
igual "regravar duas vezes nao muda nada (idempotente)" "$h1" "$(sha256sum "$ID" | cut -d' ' -f1)"

printf '\nLinha que a pessoa escreveu no AGENT.md.\n' >>"$AG"
dgclaw agente identidade ana >/dev/null 2>&1
afirma "mudanca no AGENT.md passa para o identidade.md" grep -q 'Linha que a pessoa escreveu' "$ID"
afirma "o AGENT.md da pessoa continua como estava" grep -q 'Linha que a pessoa escreveu' "$AG"

# A atualizacao chama `agente recriar`, que chama o reparar completo: agente antigo precisa
# receber a regra nova sem ninguem rodar `agente identidade` a mao.
grep -vF "$MARCA" "$ID" >"$TMP/velha2.md" && cp "$TMP/velha2.md" "$ID"
nega "pre-condicao: identidade velha sem a secao" grep -qxF "$MARCA" "$ID"
dgclaw agente reparar ana >"$TMP/rep.txt" 2>&1
igual "reparar completo sai com 0" "0" "$?"
afirma "o reparar completo regrava a secao no identidade.md" grep -qxF "$MARCA" "$ID"
afirma "a regra da tarefa longa chega ao agente antigo" grep -q 'Sempre livre para conversar' "$ID"

nega "slug inexistente recusa" dgclaw agente identidade fantasma
nega "sem slug recusa" dgclaw agente identidade
fim
