#!/usr/bin/env bash
# A configuracao do yt-dlp do agente (~/.config/yt-dlp/config): nasce no `agente criar`, e o
# `agente reparar` acrescenta so o que falta, sem apagar, duplicar nem reordenar o que a pessoa tem.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

COOKIES='--cookies-from-browser "chrome+basictext:/home/agente/.tela-chrome"'
JS='--js-runtimes node'

criar_agente ana --nome "Ana"
H="$LIB/agentes/ana/home"
CFG="$H/.config/yt-dlp/config"

echo "criar: o config nasce com as duas opcoes"
afirma "o arquivo existe" test -s "$CFG"
igual "tem a linha dos cookies da Tela uma vez" "1" "$(grep -cxF -- "$COOKIES" "$CFG")"
igual "tem a linha do node uma vez" "1" "$(grep -cxF -- "$JS" "$CFG")"
igual "modo 644" "644" "$(stat -c %a "$CFG")"

echo "criar de novo: nao duplica"
criar_agente ana --nome "Ana"
igual "continua com 2 linhas" "2" "$(wc -l <"$CFG" | tr -d ' ')"

echo "reparar: arquivo da pessoa com linha alheia e sem as nossas (sem quebra de linha no fim)"
printf '# meu config\n-f best\n--no-mtime' >"$CFG"
dgclaw agente reparar ana >"$TMP/r.txt" 2>&1
igual "reparar sai com 0" "0" "$?"
igual "as tres primeiras linhas, na ordem e intactas" "$(printf '# meu config\n-f best\n--no-mtime')" "$(head -3 "$CFG")"
igual "as nossas entram no fim, uma vez cada" "$(printf '%s\n%s' "$COOKIES" "$JS")" "$(tail -2 "$CFG")"
igual "total de 5 linhas" "5" "$(wc -l <"$CFG" | tr -d ' ')"
cp "$CFG" "$TMP/depois-1"
dgclaw agente reparar ana >"$TMP/r.txt" 2>&1
afirma "rodar o reparar de novo nao muda nada" cmp -s "$CFG" "$TMP/depois-1"

echo "reparar: a pessoa ja escolheu outra opcao (cookies de outro lugar)"
printf -- '--cookies-from-browser firefox\n-f best\n' >"$CFG"
dgclaw agente reparar ana >"$TMP/r.txt" 2>&1
igual "a escolha dela fica, sem a nossa duplicada" "1" "$(grep -c -- '--cookies-from-browser' "$CFG")"
afirma "a escolha dela e a linha original" grep -qx -- '--cookies-from-browser firefox' "$CFG"
afirma "so o que faltava (node) foi acrescentado" grep -qxF -- "$JS" "$CFG"
igual "a primeira linha dela continua primeira" "--cookies-from-browser firefox" "$(head -1 "$CFG")"

echo "reparar: link simbolico no lugar do arquivo"
rm -f "$CFG"
printf 'conteudo de fora\n' >"$TMP/alvo-de-fora"
ln -s "$TMP/alvo-de-fora" "$CFG"
dgclaw agente reparar ana >"$TMP/r.txt" 2>&1
igual "reparar recusa (sai com 1)" "1" "$?"
igual "o alvo do link nao foi tocado" "conteudo de fora" "$(cat "$TMP/alvo-de-fora")"
rm -f "$CFG"

fim
