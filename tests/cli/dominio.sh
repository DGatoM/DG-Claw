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

# Caddyfile personalizado: o comando falha, nada e gravado (arquivo, permissao, dominio registrado)
printf '# DG Claw: gerado\nantigo.exemplo.com {\n\treverse_proxy 127.0.0.1:8300\n\theader X-Minha-Linha "do dono"\n}\n' >"$CF"
rm -f "$CONFD"
chmod 640 "$CF"
cp -p "$CF" "$TMP/cf-antes"
printf 'DGCLAW_DOMINIO=antigo.exemplo.com\n' >"$ETC/dgclaw.env"
cp -p "$ETC/dgclaw.env" "$TMP/env-antes"
: >"$STUB_LOG"
dgclaw dominio trocar personalizado.exemplo.com.br --sem-conferir-dns >"$TMP/o.txt" 2>&1
igual "personalizado: sai com 1" "1" "$?"
afirma "personalizado: explica o que fazer" grep -q 'tem personalizacoes suas' "$TMP/o.txt"
afirma "personalizado: arquivo intacto byte a byte" cmp "$CF" "$TMP/cf-antes"
igual "personalizado: permissao intacta" "640" "$(stat -c %a "$CF")"
afirma "personalizado: dominio registrado nao mudou" cmp "$ETC/dgclaw.env" "$TMP/env-antes"
nega "personalizado: nao recarregou o caddy" grep -q 'systemctl reload caddy' "$STUB_LOG"
# o dono edita o nome do site a mao e roda de novo: o DG Claw registra o dominio
sed -i 's/^antigo.exemplo.com {/personalizado.exemplo.com.br {/' "$CF"
dgclaw dominio trocar personalizado.exemplo.com.br --sem-conferir-dns >"$TMP/o.txt" 2>&1
igual "personalizado editado a mao: sai com 0" "0" "$?"
afirma "personalizado editado a mao: dominio registrado" grep -qx 'DGCLAW_DOMINIO=personalizado.exemplo.com.br' "$ETC/dgclaw.env"
afirma "personalizado editado a mao: linha do dono intacta" grep -q 'header X-Minha-Linha "do dono"' "$CF"
igual "personalizado editado a mao: permissao intacta" "640" "$(stat -c %a "$CF")"

# Dois sites no mesmo arquivo personalizado: so vale o site do painel (reverse_proxy para 8300)
printf 'import conf.d/*\n\nloja.exemplo.com {\n\treverse_proxy 127.0.0.1:9000\n}\n\nantigo.exemplo.com {\n\treverse_proxy 127.0.0.1:8300\n\theader X-Minha-Linha "do dono"\n}\n' >"$CF"
printf '# DG Claw: personalizado\n' | cat - "$CF" >"$TMP/cf2" && mv "$TMP/cf2" "$CF"
rm -f "$CONFD"; chmod 640 "$CF"; cp -p "$CF" "$TMP/cf-antes"
printf 'DGCLAW_DOMINIO=antigo.exemplo.com\n' >"$ETC/dgclaw.env"; cp -p "$ETC/dgclaw.env" "$TMP/env-antes"
dgclaw dominio trocar loja.exemplo.com --sem-conferir-dns >"$TMP/o.txt" 2>&1
igual "dois sites: trocar para o da loja falha" "1" "$?"
afirma "dois sites: arquivo intacto" cmp "$CF" "$TMP/cf-antes"
afirma "dois sites: env intacto" cmp "$ETC/dgclaw.env" "$TMP/env-antes"
sed -i 's/^antigo.exemplo.com {/painel.exemplo.com, www.exemplo.com:443 {/' "$CF"
dgclaw dominio trocar www.exemplo.com --sem-conferir-dns >"$TMP/o.txt" 2>&1
igual "dominio junto com outro na linha do painel: passa" "0" "$?"
afirma "dominio junto com outro: registrado" grep -qx 'DGCLAW_DOMINIO=www.exemplo.com' "$ETC/dgclaw.env"
printf 'DGCLAW_DOMINIO=antigo.exemplo.com\n' >"$ETC/dgclaw.env"
sed -i 's/^painel.exemplo.com, www.exemplo.com:443 {/painel.exemplo.com {/' "$CF"
dgclaw dominio trocar www.exemplo.com --sem-conferir-dns >"$TMP/o.txt" 2>&1
igual "dominio que nao esta em nenhum bloco: falha" "1" "$?"
dgclaw dominio trocar painel.exemplo.com --sem-conferir-dns >"$TMP/o.txt" 2>&1
igual "painel editado a mao para o nome novo: passa" "0" "$?"
afirma "painel editado a mao: registrado" grep -qx 'DGCLAW_DOMINIO=painel.exemplo.com' "$ETC/dgclaw.env"

# Caddyfile gerado pelo instalador: ganha a compressao ao trocar
printf '# DG Claw: gerado\nantigo.exemplo.com {\n\treverse_proxy 127.0.0.1:8300\n}\n' >"$CF"
dgclaw dominio trocar gerado.exemplo.com.br --sem-conferir-dns >"$TMP/o.txt" 2>&1
afirma "gerado: nome novo com compressao" grep -q 'zstd' "$CF"
nega "gerado: sem event-stream" grep -q 'event-stream' "$CF"

# sem conferir DNS e ensaio
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"
dgclaw --ensaio dominio trocar sem-dns.exemplo.com --sem-conferir-dns >"$TMP/o.txt" 2>&1
igual "ensaio: sai com 0" "0" "$?"
afirma "ensaio: dgclaw.env intacto" grep -qx 'DGCLAW_DOMINIO=teste.exemplo.org' "$ETC/dgclaw.env"
nega "ensaio: conf.d nao ganhou o nome" grep -q 'sem-dns' "$CONFD"

fim
