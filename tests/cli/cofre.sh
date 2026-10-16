#!/usr/bin/env bash
# dgclaw agente cofre: o embrulho fino de web/bin/cofre.js. Aqui o cofre.js e um falso que so
# anota o que recebeu; no fim, um caso com o cofre.js de verdade numa raiz falsa.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

APP="$DGCLAW_RAIZ/opt/dgclaw/app"
FALSO="$APP/web/bin/cofre.js"
REG="$TMP/registro"
mkdir -p "$APP/web/bin" "$REG"
cat >"$FALSO" <<'JS'
const fs = require('node:fs');
const d = process.env.FALSO_DIR;
fs.writeFileSync(`${d}/chamado`, 'sim');
fs.writeFileSync(`${d}/args`, process.argv.slice(2).map((a) => `${a}\n`).join(''));
fs.writeFileSync(`${d}/stdin`, fs.readFileSync(0));
fs.writeFileSync(`${d}/env`, ['DGCLAW_WEB_ENV', 'DGCLAW_AGENTES', 'DGCLAW_WEB_DATA'].map((n) => `${n}=${process.env[n]}\n`).join(''));
let rc = 0;
try { rc = Number(fs.readFileSync(`${d}/codigo`, 'utf8')); } catch (e) { rc = 0; }
process.exitCode = rc;
JS
export FALSO_DIR="$REG"
zera() { rm -f "$REG/chamado" "$REG/args" "$REG/stdin" "$REG/env" "$REG/codigo"; }
chamou() { [ -f "$REG/chamado" ]; }
roda() { dgclaw "$@" </dev/null >"$TMP/o.txt" 2>"$TMP/e.txt"; }

echo "argumentos"
zera
roda agente cofre ana guardar OPENAI_API_KEY --provedor openai --aplicar --quem "Fulano de Tal" --json
igual "argumentos chegam iguais e na ordem" \
    "guardar|ana|OPENAI_API_KEY|--provedor|openai|--aplicar|--quem|Fulano de Tal|--json" \
    "$(paste -sd'|' "$REG/args")"

echo "stdin"
zera
printf %s 'sk-teste-sem-quebra' | dgclaw agente cofre ana guardar X_KEY >/dev/null 2>&1
igual "valor sem quebra de linha final chega igual" "sk-teste-sem-quebra" "$(cat "$REG/stdin")"
igual "e sem byte a mais" "19" "$(wc -c <"$REG/stdin" | tr -d ' ')"
zera
# shellcheck disable=SC2016 # os $ sao literais de proposito
ESPECIAL='sk-teste $HOME "aspas" '\''simples'\'' \n barra\ fim'
printf %s "$ESPECIAL" | dgclaw agente cofre ana guardar X_KEY >/dev/null 2>&1
afirma "valor com especiais chega byte a byte" cmp -s <(printf %s "$ESPECIAL") "$REG/stdin"
zera
printf 'sk-teste-linha\n' | dgclaw agente cofre ana guardar X_KEY >/dev/null 2>&1
igual "a quebra de linha final tambem passa (quem apara e o cofre.js)" "15" "$(wc -c <"$REG/stdin" | tr -d ' ')"

echo "ambiente"
zera
DGCLAW_WEB_ENV=/outro/web.env DGCLAW_AGENTES=/outro/agentes.json DGCLAW_WEB_DATA=/outro/dados roda agente cofre ana listar
igual "web.env da raiz falsa" "DGCLAW_WEB_ENV=$DGCLAW_RAIZ/etc/dgclaw/web.env" "$(sed -n 1p "$REG/env")"
igual "agentes.json da raiz falsa" "DGCLAW_AGENTES=$DGCLAW_RAIZ/etc/dgclaw/agentes.json" "$(sed -n 2p "$REG/env")"
igual "dados do Web da raiz falsa" "DGCLAW_WEB_DATA=$DGCLAW_RAIZ/var/lib/dgclaw/web" "$(sed -n 3p "$REG/env")"

echo "codigo de saida"
for c in 0 1 2; do
    zera; printf %s "$c" >"$REG/codigo"
    roda agente cofre ana listar
    igual "saida $c do cofre.js volta intacta" "$c" "$?"
done

echo "uso errado do embrulho"
for casos in "agente cofre" "agente cofre Ana!" "agente cofre admin listar" "agente cofre ana" "agente cofre ana apagar"; do
    zera
    # shellcheck disable=SC2086 # as palavras do caso sao de proposito separadas
    roda $casos
    igual "'$casos' sai 2" "2" "$?"
    nega "'$casos' nao chama o cofre.js" chamou
    afirma "'$casos' diz o que fazer" grep -q 'O que fazer:' "$TMP/e.txt"
done
zera
roda agente cofre "" listar
igual "slug vazio sai 2" "2" "$?"
nega "slug vazio nao chama o cofre.js" chamou

echo "ensaio"
zera
roda --ensaio agente cofre ana guardar X_KEY
igual "--ensaio sai 0" "0" "$?"
nega "--ensaio nao chama o cofre.js" chamou
afirma "--ensaio mostra o comando" grep -q 'cofre.js guardar ana X_KEY' "$TMP/o.txt"
zera
roda --ensaio agente cofre ana guardar X_KEY sk-teste-NAO-PODE-APARECER outra
igual "--ensaio com valor na linha sai 0" "0" "$?"
nega "--ensaio nao imprime um valor passado como argumento" grep -q 'sk-teste-NAO-PODE-APARECER' "$TMP/o.txt"
afirma "--ensaio conta os argumentos que nao mostra" grep -q '(+2 argumento(s))' "$TMP/o.txt"

echo "sem root"
mkdir -p "$TMP/falso-id"
printf '#!/bin/sh\necho 1000\n' >"$TMP/falso-id/id"
chmod +x "$TMP/falso-id/id"
zera
PATH="$TMP/falso-id:$PATH" DGCLAW_RAIZ="" dgclaw agente cofre ana listar </dev/null >"$TMP/o.txt" 2>"$TMP/e.txt"
igual "sem root sai 1" "1" "$?"
afirma "sem root diz que precisa de root" grep -q 'precisa rodar como root' "$TMP/e.txt"
nega "sem root nao chama o cofre.js" chamou

echo "sem o cofre.js"
rm -f "$FALSO"
roda agente cofre ana listar
igual "sem cofre.js sai 1" "1" "$?"
afirma "a mensagem traz o caminho" grep -qF "$FALSO" "$TMP/e.txt"

echo "cofre.js de verdade"
if ! command -v node >/dev/null 2>&1; then
    echo "  pulado: sem node nesta maquina"
else
    criar_agente ana --nome "Ana"
    mkdir -p "$APP/web" "$APP/panel"
    cp -r "$REPO/web/bin" "$REPO/web/lib" "$APP/web/"
    cp -r "$REPO/panel/lib" "$APP/panel/"
    casa="$(jq -r '.. | .home_host? // empty' "$DGCLAW_RAIZ/etc/dgclaw/agentes.json" | head -1)"
    case "$casa" in
        "$DGCLAW_RAIZ"/*) dentro=1 ;;
        *) dentro=0 ;;
    esac
    igual "a casa do agente fica dentro da raiz falsa" "1" "$dentro"
    if [ "$dentro" = 1 ]; then
        SEGREDO='sk-teste-nao-e-chave-de-verdade-1234'
        printf %s "$SEGREDO" | dgclaw agente cofre ana guardar TESTE_API_KEY --provedor outro >"$TMP/o.txt" 2>"$TMP/e.txt"
        igual "guardar (sem --aplicar) sai 0" "0" "$?"
        meta="$DGCLAW_RAIZ/var/lib/dgclaw/web/cofre/ana.json"
        afirma "o metadado foi gravado" test -s "$meta"
        nega "o valor nao esta no metadado" grep -q "$SEGREDO" "$meta"
        nega "o valor nao saiu na tela" grep -q "$SEGREDO" "$TMP/o.txt" "$TMP/e.txt"
        dgclaw agente cofre ana listar >"$TMP/o.txt" 2>"$TMP/e.txt" </dev/null
        igual "listar sai 0" "0" "$?"
        afirma "listar mostra o nome da chave" grep -q 'TESTE_API_KEY' "$TMP/o.txt"
        nega "listar nao mostra o valor" grep -q "$SEGREDO" "$TMP/o.txt"
    fi
fi

fim
