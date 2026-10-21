#!/usr/bin/env bash
# dgclaw chave-api: o embrulho fino de web/bin/chave-api.js, com o programa de verdade numa raiz falsa.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

if ! command -v node >/dev/null 2>&1; then
    echo "  pulado: sem node nesta maquina"
    fim
    exit $?
fi

APP="$DGCLAW_RAIZ/opt/dgclaw/app"
mkdir -p "$APP/web"
cp -r "$REPO/web/bin" "$REPO/web/lib" "$APP/web/"
ARQ="$LIB/web/chaves-api.json"
roda() { dgclaw "$@" </dev/null >"$TMP/o.txt" 2>"$TMP/e.txt"; }

echo "criar"
roda chave-api criar --nome "Suporte DG" --escopo diagnostico
igual "criar sai 0" "0" "$?"
TOKEN="$(cat "$TMP/o.txt")"
igual "o stdout e uma linha so" "1" "$(wc -l <"$TMP/o.txt" | tr -d ' ')"
afirma "e um token dgc_" bash -c "[[ '$TOKEN' =~ ^dgc_[A-Za-z0-9_-]{40,}\$ ]]"
nega "o token nao vai para o stderr" grep -q "$TOKEN" "$TMP/e.txt"
afirma "o stderr avisa que o token nao aparece de novo" grep -q 'nao aparece de novo\|não aparece de novo' "$TMP/e.txt"
afirma "o arquivo de chaves existe" test -s "$ARQ"
igual "o arquivo tem permissao 600" "600" "$(stat -c %a "$ARQ")"
nega "o token nao esta em disco" grep -q "$TOKEN" "$ARQ"

echo "listar"
roda chave-api listar
igual "listar sai 0" "0" "$?"
afirma "mostra o nome" grep -q 'Suporte DG' "$TMP/o.txt"
afirma "mostra a chave como ativa" grep -q 'ativa' "$TMP/o.txt"
nega "nao mostra o token" grep -q "$TOKEN" "$TMP/o.txt"
nega "nao mostra hash" grep -qi 'hash' "$TMP/o.txt"
roda chave-api listar --json
afirma "o --json nao leva o hash" bash -c "! grep -q '\"hash\"' '$TMP/o.txt'"

echo "revogar"
ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ARQ','utf8')).chaves[0].id)")"
roda chave-api revogar "$ID"
igual "revogar sai 0" "0" "$?"
roda chave-api revogar "$ID"
igual "revogar de novo sai 1 (ja revogada)" "1" "$?"
afirma "o motivo vem escrito" grep -q 'revogada' "$TMP/e.txt"
roda chave-api revogar naoexiste
igual "revogar id desconhecido sai 1" "1" "$?"
roda chave-api listar
afirma "listar mostra revogada" grep -q 'revogada em' "$TMP/o.txt"

echo "trava entre processos"
afirma "o arquivo de trava fica (nunca e apagado)" test -e "$ARQ.lock"
nega "a CLI nao cria o arquivo de uso (so o Web marca uso)" test -e "$LIB/web/chaves-api-uso.json"
# Um processo segura a trava do kernel (flock) por 6 s: a CLI espera 3 s, desiste com motivo e nao rouba a trava,
# mesmo com o arquivo de trava "velho".
touch -d '2 minutes ago' "$ARQ.lock"
flock -x "$ARQ.lock" sleep 6 &
SEGURA=$!
sleep 0.5
roda chave-api criar --nome "Com trava ocupada" --escopo diagnostico
igual "trava ocupada: criar sai 1" "1" "$?"
afirma "o motivo diz que outro processo esta mexendo" grep -q 'outro processo' "$TMP/e.txt"
nega "nenhum token no stdout" test -s "$TMP/o.txt"
wait "$SEGURA" 2>/dev/null
roda chave-api criar --nome "Depois que soltou" --escopo diagnostico
igual "trava solta: criar sai 0" "0" "$?"
# Processo morto com SIGKILL segurando a trava: o kernel solta e o proximo entra.
flock -x "$ARQ.lock" sleep 60 &
SEGURA=$!
sleep 0.5
pkill -KILL -P "$SEGURA" sleep 2>/dev/null
kill -KILL "$SEGURA" 2>/dev/null
wait "$SEGURA" 2>/dev/null
roda chave-api criar --nome "Depois do kill" --escopo diagnostico
igual "dono morto: criar sai 0" "0" "$?"

echo "uso errado e recusas"
roda chave-api
igual "sem acao sai 2" "2" "$?"
roda chave-api apagar
igual "acao desconhecida sai 2" "2" "$?"
roda chave-api criar --escopo diagnostico
igual "criar sem --nome sai 2" "2" "$?"
roda chave-api criar --nome X
igual "criar sem --escopo sai 2" "2" "$?"
roda chave-api criar --nome X --escopo escrita
igual "escopo desconhecido sai 1" "1" "$?"
afirma "o motivo cita o escopo" grep -q 'escrita' "$TMP/e.txt"
nega "o stdout fica vazio na recusa" test -s "$TMP/o.txt"

fim
