#!/usr/bin/env bash
# Bloco E, HTTPS endurecido: cabecalhos no Caddyfile por nivel, pessoal identico ao de antes, aplicar e recusa do Caddy.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

ANTES='teste.exemplo.org {
	reverse_proxy 127.0.0.1:8300
}'

echo "https: nivel pessoal gera o Caddyfile de sempre"
saida="$(lib bloco_caddy teste.exemplo.org | tail -n +2)"
igual "pessoal: bloco do site identico ao de antes" "$ANTES" "$saida"
afirma "pessoal: nenhum cabecalho de seguranca" bash -c "! grep -q 'Strict-Transport' <<<'$saida'"

echo "https: nivel escritorio acrescenta os cabecalhos"
nivel_na_raiz escritorio
saida="$(lib bloco_caddy teste.exemplo.org)"
for c in 'Strict-Transport-Security "max-age=31536000; includeSubDomains"' '?X-Content-Type-Options "nosniff"' '?Referrer-Policy "same-origin"' 'microphone=(self)' 'camera=(self)' '-Server' 'reverse_proxy 127.0.0.1:8300'; do
    afirma "tem: $c" bash -c "grep -qF -- '$c' <<<'$saida'"
done
afirma "o reverse_proxy continua no bloco" grep -q "reverse_proxy" <<<"$saida"

echo "https: aplicar reescreve o Caddyfile do DG Claw e recarrega"
mkdir -p "$DGCLAW_RAIZ/etc/caddy"
nivel_na_raiz pessoal
lib bloco_caddy teste.exemplo.org >"$DGCLAW_RAIZ/etc/caddy/Caddyfile"
lib ent_aplicar_https >"$TMP/o.txt" 2>&1
igual "pessoal: aplicar nao mexe no Caddy (nenhum validate)" 0 "$(grep -c '^caddy validate' "$STUB_LOG")"
# o stub do systemctl guarda o estado pelo segundo argumento (aqui, --quiet)
echo active >"$STUB_ESTADO/svc---quiet"
nivel_na_raiz escritorio
: >"$STUB_LOG"
lib ent_aplicar_https >"$TMP/o.txt" 2>&1
igual "aplicar no escritorio sai com 0" 0 "$?"
afirma "o Caddyfile ganhou o HSTS" grep -q "Strict-Transport-Security" "$DGCLAW_RAIZ/etc/caddy/Caddyfile"
afirma "o Caddyfile continua com a marca do DG Claw" grep -q '^# DG Claw' "$DGCLAW_RAIZ/etc/caddy/Caddyfile"
afirma "recarregou o Caddy" grep -q "^systemctl reload caddy" "$STUB_LOG"
: >"$STUB_LOG"
lib ent_aplicar_https >"$TMP/o.txt" 2>&1
afirma "segunda vez nao recarrega de novo" bash -c "! grep -q 'reload caddy' '$STUB_LOG'"

echo "https: baixar o nivel tira os cabecalhos"
nivel_na_raiz pessoal
lib ent_aplicar_https >"$TMP/o.txt" 2>&1
afirma "voltou ao Caddyfile de antes" bash -c "! grep -q Strict-Transport '$DGCLAW_RAIZ/etc/caddy/Caddyfile'"

echo "https: o Caddy recusa a configuracao e o arquivo volta"
nivel_na_raiz pessoal
lib bloco_caddy teste.exemplo.org >"$DGCLAW_RAIZ/etc/caddy/Caddyfile"
antes="$(cat "$DGCLAW_RAIZ/etc/caddy/Caddyfile")"
nivel_na_raiz escritorio
mkdir -p "$TMP/falha"
printf '#!/usr/bin/env bash\necho "Error: header invalido" >&2\nexit 1\n' >"$TMP/falha/caddy"; chmod +x "$TMP/falha/caddy"
PATH="$TMP/falha:$PATH" lib ent_aplicar_https >"$TMP/o.txt" 2>&1
igual "aplicar falha (codigo diferente de 0) quando o caddy validate falha" 1 "$?"
igual "o Caddyfile voltou ao que era" "$antes" "$(cat "$DGCLAW_RAIZ/etc/caddy/Caddyfile")"
afirma "a mensagem diz o que fazer" grep -q "O que fazer" "$TMP/o.txt"

echo "https: dgclaw https cabecalhos"
nivel_na_raiz escritorio
afirma "imprime as linhas" bash -c "'$CLI' https cabecalhos | grep -q Strict-Transport"
nega "subcomando desconhecido falha" "$CLI" https xyz

fim
