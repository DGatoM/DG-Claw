#!/usr/bin/env bash
# dgclaw dominio: troca do dominio do painel.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

CF="$DGCLAW_RAIZ/etc/caddy/Caddyfile"
CONFD="$DGCLAW_RAIZ/etc/caddy/conf.d/dgclaw.caddy"
mkdir -p "$DGCLAW_RAIZ/etc/caddy"
printf '# DG Claw: antigo\nteste.exemplo.org {\n\treverse_proxy 127.0.0.1:8300\n}\n' >"$CF"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_VERSAO=1.2\nDGCLAW_USUARIO=maria\n' >"$ETC/dgclaw.env"

# mostrar
dgclaw dominio >"$TMP/o.txt" 2>&1
afirma "mostrar: diz o dominio atual" grep -q 'teste.exemplo.org' "$TMP/o.txt"
afirma "mostrar: diz o IP publico" grep -q '203.0.113.7' "$TMP/o.txt"

# formato invalido
nega "formato invalido recusado" dgclaw dominio trocar 'https://x.com/'
nega "sem ponto recusado" dgclaw dominio trocar painel
nega "sem nome recusado" dgclaw dominio trocar
afirma "nada mudou apos recusas" grep -q 'teste.exemplo.org {' "$CF"

# DNS nao aponta
echo 192.0.2.55 >"$STUB_ESTADO/dns-novo.exemplo.com.br"
dgclaw dominio trocar novo.exemplo.com.br >"$TMP/o.txt" 2>&1
igual "DNS errado: sai com 1" "1" "$?"
afirma "DNS errado: explica o registro A e o IP" grep -q 'registro tipo A.*203.0.113.7' "$TMP/o.txt"
afirma "DNS errado: Caddyfile intacto" grep -q 'teste.exemplo.org {' "$CF"
afirma "DNS errado: dgclaw.env intacto" grep -q 'DGCLAW_DOMINIO=teste.exemplo.org' "$ETC/dgclaw.env"
nega "DNS errado: nao recarregou o caddy" grep -q 'systemctl reload caddy' "$STUB_LOG"

# DNS ok
echo 203.0.113.7 >"$STUB_ESTADO/dns-novo.exemplo.com.br"
: >"$STUB_LOG"
dgclaw dominio trocar Novo.Exemplo.com.br >"$TMP/o.txt" 2>&1
igual "DNS ok: sai com 0" "0" "$?"
afirma "DNS ok: Caddyfile com o nome novo" grep -q '^novo.exemplo.com.br {' "$CF"
nega "DNS ok: sem o nome antigo no Caddyfile" grep -q 'teste.exemplo.org' "$CF"
afirma "DNS ok: dgclaw.env com o dominio novo" grep -qx 'DGCLAW_DOMINIO=novo.exemplo.com.br' "$ETC/dgclaw.env"
afirma "DNS ok: dgclaw.env manteve as outras linhas" grep -qx 'DGCLAW_USUARIO=maria' "$ETC/dgclaw.env"
afirma "DNS ok: caddy validate" grep -q '^caddy validate' "$STUB_LOG"
afirma "DNS ok: reload do caddy" grep -q 'systemctl reload caddy' "$STUB_LOG"
afirma "DNS ok: esperou o HTTPS do nome novo" grep -q 'resolve novo.exemplo.com.br:443:127.0.0.1' "$STUB_LOG"
afirma "DNS ok: imprime o link novo" grep -q 'https://novo.exemplo.com.br/' "$TMP/o.txt"
nega "DNS ok: nao reiniciou o admin" grep -q 'restart dgclaw-admin' "$STUB_LOG"

# primeiro-acesso passa a usar o dominio novo
printf 'DGCLAW_PANEL_USER=maria\n' >"$ETC/web.env"
afirma "primeiro-acesso usa o dominio novo" bash -c "'$CLI' primeiro-acesso 2>/dev/null | grep -q '^https://novo.exemplo.com.br/primeiro-acesso#'"

# caddy recusa: restaura
touch "$STUB_ESTADO/caddy-falha"
echo 203.0.113.7 >"$STUB_ESTADO/dns-outro.exemplo.com.br"
dgclaw dominio trocar outro.exemplo.com.br >"$TMP/o.txt" 2>&1
igual "caddy recusa: sai com 1" "1" "$?"
afirma "caddy recusa: Caddyfile voltou ao que era" grep -q '^novo.exemplo.com.br {' "$CF"
afirma "caddy recusa: dgclaw.env nao mudou" grep -qx 'DGCLAW_DOMINIO=novo.exemplo.com.br' "$ETC/dgclaw.env"
rm -f "$STUB_ESTADO/caddy-falha"

# Caddyfile com outros sites: vai para conf.d
printf 'import conf.d/*\n\nloja.exemplo.com {\n\trespond "oi"\n}\n' >"$CF"
dgclaw dominio trocar outro.exemplo.com.br >"$TMP/o.txt" 2>&1
igual "outros sites: sai com 0" "0" "$?"
afirma "outros sites: site do DG Claw em conf.d" grep -q '^outro.exemplo.com.br {' "$CONFD"
afirma "outros sites: Caddyfile dos outros preservado" grep -q 'loja.exemplo.com' "$CF"

# sem conferir DNS e ensaio
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"
dgclaw --ensaio dominio trocar sem-dns.exemplo.com --sem-conferir-dns >"$TMP/o.txt" 2>&1
igual "ensaio: sai com 0" "0" "$?"
afirma "ensaio: dgclaw.env intacto" grep -qx 'DGCLAW_DOMINIO=teste.exemplo.org' "$ETC/dgclaw.env"
nega "ensaio: conf.d nao ganhou o nome" grep -q 'sem-dns' "$CONFD"

# atras de tunel: sem conferir DNS contra o IP publico, HTTPS por loopback com -k, tls internal
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_ATRAS_DE_TUNEL=1\nLINHA_DA_MARTA=oi\n' >"$ETC/dgclaw.env"
printf '# DG Claw: antigo\nteste.exemplo.org {\n\ttls internal\n\treverse_proxy 127.0.0.1:8300\n}\n' >"$CF"
dgclaw dominio >"$TMP/o.txt" 2>&1
afirma "tunel mostrar: diz que esta atras de tunel" grep -q 'atras de um tunel' "$TMP/o.txt"
nega "tunel mostrar: nao manda criar registro A" grep -q 'registro DNS tipo A' "$TMP/o.txt"
: >"$STUB_LOG"
echo 192.0.2.55 >"$STUB_ESTADO/dns-tunel.exemplo.com.br" # DNS "errado" de proposito: nao pode importar
dgclaw dominio trocar tunel.exemplo.com.br >"$TMP/o.txt" 2>&1
igual "tunel trocar: sai com 0" "0" "$?"
afirma "tunel trocar: Caddyfile com o nome novo e tls internal" bash -c "grep -q '^tunel.exemplo.com.br {' '$CF' && grep -q 'tls internal' '$CF'"
afirma "tunel trocar: avisa que o nome precisa estar no tunel" grep -q 'precisa estar no tunel' "$TMP/o.txt"
nega "tunel trocar: nao consultou o IP publico" grep -qE '^curl .*(ipify|ifconfig)' "$STUB_LOG"
nega "tunel trocar: nao consultou o DNS" grep -q '^dig ' "$STUB_LOG"
afirma "tunel trocar: HTTPS local com -k" grep -qE '^curl .*-k .*resolve tunel.exemplo.com.br:443:127.0.0.1' "$STUB_LOG"
afirma "tunel trocar: manteve o modo e a linha alheia" bash -c "grep -qx 'DGCLAW_ATRAS_DE_TUNEL=1' '$ETC/dgclaw.env' && grep -qx 'LINHA_DA_MARTA=oi' '$ETC/dgclaw.env'"

fim
