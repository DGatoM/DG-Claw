#!/usr/bin/env bash
# Os bash -c recebem os caminhos como argumento ($1), de proposito entre aspas simples.
# shellcheck disable=SC2016
# scripts/smoke-entrega.sh: um caso todo OK e casos com FALHA, com podman, curl e systemctl de mentira
# (tests/cli/stubs-entrega) e uma raiz falsa (DGCLAW_RAIZ). Nada toca o sistema.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
SMOKE="$REPO/scripts/smoke-entrega.sh"

preparar
# A limpeza entre os casos apaga $STUB_ESTADO: sem a pasta temporaria criada, o teste para antes de apagar qualquer coisa.
case "${TMP:-}" in /*) [ -d "$TMP" ] || { echo "smoke-entrega: o mktemp -d falhou" >&2; exit 1; } ;; *) echo "smoke-entrega: o mktemp -d falhou" >&2; exit 1 ;; esac
[ "$STUB_ESTADO" = "$TMP/estado" ] || { echo "smoke-entrega: STUB_ESTADO fora da pasta temporaria" >&2; exit 1; }
PATH="$AQUI/stubs-entrega:$PATH"
export PATH

mkdir -p "$DGCLAW_RAIZ/opt/dgclaw/app"
registro() { jq -n --arg s "$1" '{versao: 1, agentes: [{slug: $s, tipo: "agente", provedor: "claude"}]}' >"$ETC/agentes.json"; }
smoke() { bash "$SMOKE" "$@" >"$TMP/s.txt" 2>&1; }
limpar_estado() {
    find "$STUB_ESTADO" -mindepth 1 -delete
    printf '1.2.3\n' >"$DGCLAW_RAIZ/opt/dgclaw/app/VERSION"
    printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"
    registro ana
    : >"$STUB_LOG"
}

echo "smoke-entrega: tudo certo"
limpar_estado
smoke
igual "sai com 0" "0" "$?"
afirma "versao OK" grep -q 'OK     \[1\] DG Claw 1.2.3' "$TMP/s.txt"
afirma "painel OK na porta padrao" grep -q 'OK     \[2\] o painel do DG Claw respondeu na porta 8300' "$TMP/s.txt"
afirma "curl na porta padrao" grep -q 'curl .*http://127.0.0.1:8300/' "$STUB_LOG"
afirma "servico web OK" grep -q 'OK     \[3\] dgclaw-web ativo' "$TMP/s.txt"
afirma "servico admin OK" grep -q 'OK     \[3\] dgclaw-admin ativo' "$TMP/s.txt"
afirma "container rodando OK" grep -q 'OK     \[4\] dgclaw-ana rodando' "$TMP/s.txt"
afirma "memoria 4096 MB OK" grep -q 'OK     \[4\] dgclaw-ana com limite de memoria de 4096 MB' "$TMP/s.txt"
afirma "lista a conferir a mao" grep -q 'A conferir a mao' "$TMP/s.txt"
nega "nao imprime FALHA" grep -q 'FALHA' "$TMP/s.txt"
nega "nenhum podman exec no log" grep -q 'podman exec' "$STUB_LOG"
nega "nenhum journalctl no log" grep -q 'journalctl' "$STUB_LOG"
nega "nenhum cofre no log" grep -q 'cofre' "$STUB_LOG"
afirma "o uso aponta o caminho absoluto da instalacao" bash -c 'bash "$1" --ajuda | grep -qxF "uso: sudo bash /opt/dgclaw/app/scripts/smoke-entrega.sh"' _ "$SMOKE"

echo "smoke-entrega: uso"
smoke ana
igual "argumento extra: sai com 2" "2" "$?"
afirma "argumento extra mostra o uso" grep -q 'uso: sudo bash' "$TMP/s.txt"

echo "smoke-entrega: versao ausente"
limpar_estado
rm -f "$DGCLAW_RAIZ/opt/dgclaw/app/VERSION"
smoke
igual "sem VERSION: sai com 0" "0" "$?"
afirma "sem VERSION: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[1\]' "$TMP/s.txt"

echo "smoke-entrega: painel"
limpar_estado
echo 7 >"$STUB_ESTADO/curl-rc"; : >"$STUB_ESTADO/saude"
smoke
igual "painel sem conexao: sai com 1" "1" "$?"
afirma "painel sem conexao: FALHA" grep -q 'FALHA  \[2\] o painel do DG Claw nao respondeu' "$TMP/s.txt"
limpar_estado
printf 'DGCLAW_PORTA_PAINEL=9123\n' >"$ETC/dgclaw.env"
smoke
afirma "a porta do dgclaw.env vai no curl" grep -q 'curl .*http://127.0.0.1:9123/api/saude' "$STUB_LOG"
limpar_estado
printf '<html>302 Found</html>' >"$STUB_ESTADO/saude"
smoke
afirma "outro servico na porta: FALHA" grep -q 'FALHA  \[2\] o painel do DG Claw nao respondeu' "$TMP/s.txt"

echo "smoke-entrega: servico inativo"
limpar_estado
: >"$STUB_ESTADO/inativo-dgclaw-admin"
smoke
igual "servico inativo: sai com 1" "1" "$?"
afirma "servico inativo: FALHA com a dica" grep -q 'FALHA  \[3\] dgclaw-admin nao esta ativo' "$TMP/s.txt"

echo "smoke-entrega: container"
limpar_estado
echo 1 >"$STUB_ESTADO/existe"
smoke
igual "container inexistente: sai com 1" "1" "$?"
afirma "container inexistente: FALHA" grep -q 'FALHA  \[4\] o container dgclaw-ana nao existe' "$TMP/s.txt"
limpar_estado
echo false >"$STUB_ESTADO/rodando"
smoke
igual "container parado: sai com 1" "1" "$?"
afirma "container parado: dica de iniciar" grep -q 'dgclaw agente iniciar ana' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/podman-mudo"
smoke
igual "podman sem resposta: sai com 0" "0" "$?"
afirma "podman sem resposta: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[4\]' "$TMP/s.txt"

echo "smoke-entrega: memoria"
limpar_estado
echo 0 >"$STUB_ESTADO/memoria"
smoke
igual "memoria 0: sai com 1" "1" "$?"
afirma "memoria 0: FALHA" grep -q 'FALHA  \[4\] dgclaw-ana esta sem limite de memoria' "$TMP/s.txt"
limpar_estado
echo 1073741824 >"$STUB_ESTADO/memoria"
smoke
igual "memoria abaixo de 2 GB: sai com 0" "0" "$?"
afirma "memoria abaixo de 2 GB: AVISO" grep -q 'AVISO  \[4\] dgclaw-ana tem 1024 MB, abaixo de 2 GB.' "$TMP/s.txt"
nega "o aviso nao manda recriar" grep -qi 'recri' "$TMP/s.txt"
limpar_estado
echo 2147483648 >"$STUB_ESTADO/memoria"
smoke
afirma "memoria de 2 GB: OK" grep -q 'OK     \[4\] dgclaw-ana com limite de memoria de 2048 MB' "$TMP/s.txt"

echo "smoke-entrega: registro"
limpar_estado
registro 'Ana;rm'
smoke
igual "slug invalido: sai com 0" "0" "$?"
afirma "slug invalido: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[4\]' "$TMP/s.txt"
nega "slug invalido nao e repetido" grep -q 'Ana' "$TMP/s.txt"
nega "slug invalido nao chega ao podman" grep -q 'podman' "$STUB_LOG"
limpar_estado
rm -f "$ETC/agentes.json"
smoke
afirma "registro ausente: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[4\]' "$TMP/s.txt"
limpar_estado
echo '{"versao":1,"agentes":[]}' >"$ETC/agentes.json"
smoke
afirma "registro sem agente: AVISO" grep -q 'AVISO  \[4\] o registro nao tem nenhum agente' "$TMP/s.txt"

echo "smoke-entrega: curl com erro depois do 200, registro sem tipo e container divergente"
limpar_estado
echo 28 >"$STUB_ESTADO/curl-rc"
smoke
igual "200 com curl saindo com 28: sai com 1" "1" "$?"
afirma "200 com curl 28: FALHA do painel" grep -q 'FALHA  \[2\] o painel do DG Claw nao respondeu na porta 8300 (/api/saude sem a resposta esperada; curl saiu com 28)' "$TMP/s.txt"
limpar_estado
echo '{"versao":1,"agentes":[{"slug":"admin"},{"slug":"bia"},{"slug":"ana","tipo":"agente"}]}' >"$ETC/agentes.json"
smoke
afirma "registro sem tipo: confere o agente bia" grep -q 'OK     \[4\] dgclaw-bia rodando' "$TMP/s.txt"
nega "registro sem tipo: o slug admin nao e agente" grep -q 'dgclaw-admin rodando' "$TMP/s.txt"
afirma "registro misto: confere ana" grep -q 'OK     \[4\] dgclaw-ana rodando' "$TMP/s.txt"
limpar_estado
echo '{"versao":1,"agentes":[{"slug":"ana","tipo":"agente","container":"dgclaw-ana-novo"},{"slug":"bia","tipo":"agente","container":"dgclaw-bia"}]}' >"$ETC/agentes.json"
smoke
afirma "container divergente: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[4\] o registro aponta para o agente ana um container diferente de dgclaw-ana' "$TMP/s.txt"
nega "container divergente: nao inspeciona dgclaw-ana" grep -q 'podman .*dgclaw-ana$' "$STUB_LOG"
afirma "container igual ao padrao: confere bia" grep -q 'OK     \[4\] dgclaw-bia rodando' "$TMP/s.txt"

limpar_estado
echo '{"versao":1,"agentes":[{"slug":"ana","tipo":" agente "}]}' >"$ETC/agentes.json"
smoke
afirma "tipo com espacos: confere o agente, como o painel" grep -q 'OK     \[4\] dgclaw-ana rodando' "$TMP/s.txt"
afirma "curl sem proxy e sem curlrc" grep -q "curl -q -s --noproxy \* " "$STUB_LOG"

limpar_estado
printf 'DGCLAW_PORTA_PAINEL=80a\n' >"$ETC/dgclaw.env"
smoke
afirma "porta invalida: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[2\] a linha DGCLAW_PORTA_PAINEL' "$TMP/s.txt"
nega "porta invalida: nao consulta a 8300" grep -q 'curl ' "$STUB_LOG"
limpar_estado
echo '{"versao":1,"agentes":[{"slug":"bia","tipo":"agente"},{"slug":"ana","tipo":"trabalho"}]}' >"$ETC/agentes.json"
smoke
afirma "tipo desconhecido: tambem confere o agente" grep -q 'OK     \[4\] dgclaw-ana rodando' "$TMP/s.txt"

limpar_estado
echo '{"versao":1,"agentes":[{"slug":"ana ","tipo":"agente"}]}' >"$ETC/agentes.json"
smoke
afirma "slug com espaco: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[4\] um agente do registro tem nome fora do formato' "$TMP/s.txt"
nega "slug com espaco: nao inspeciona dgclaw-ana" grep -q 'podman' "$STUB_LOG"

fim
