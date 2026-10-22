#!/usr/bin/env bash
# Modo --proxy-existente e faixa de rede configuravel na CLI: a rede do agente nasce na faixa do
# dgclaw.env, `dominio` nao toca no Caddy no modo proxy e `status` nao cobra o Caddy.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"

echo "criar: a rede usa a faixa do dgclaw.env"
preparar
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_FAIXA_REDE=10.91.0.0/16\n' >"$ETC/dgclaw.env"
criar_agente ana --nome "Ana"
afirma "rede criada em 10.91.1.0/24" grep -q 'network create --disable-dns --label dgclaw.v1=1 --label dgclaw.agente=ana --subnet 10.91.1.0/24 dgclaw-ana' "$STUB_LOG"
nega "nenhuma rede 10.89" grep -q 'subnet 10.89' "$STUB_LOG"
afirma "mensagem mostra a faixa" grep -q 'rede dgclaw-ana (10.91.1.0/24)' "$TMP/saida.txt"
criar_agente bia --nome "Bia"
afirma "o segundo agente ganha o /24 seguinte" grep -q 'label dgclaw.agente=bia --subnet 10.91.2.0/24 dgclaw-bia' "$STUB_LOG"

echo "criar: sem a linha vale o padrao 10.89"
preparar
criar_agente ana --nome "Ana"
afirma "rede criada em 10.89.1.0/24" grep -q 'network create --disable-dns --label dgclaw.v1=1 --label dgclaw.agente=ana --subnet 10.89.1.0/24 dgclaw-ana' "$STUB_LOG"

echo "criar: faixa invalida no dgclaw.env"
preparar
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_FAIXA_REDE=10.89.1.0/24\n' >"$ETC/dgclaw.env"
criar_agente ana --nome "Ana"
igual "falha" "1" "$?"
afirma "explica a faixa e onde corrigir" grep -q "a faixa de rede '10.89.1.0/24' (DGCLAW_FAIXA_REDE em .*dgclaw.env) nao serve" "$TMP/saida.txt"
nega "nenhuma rede criada" grep -q 'network create' "$STUB_LOG"

echo "criar: sem dominio, a base do painel usa a porta configurada"
preparar
printf 'DGCLAW_PORTA_PAINEL=8450\n' >"$ETC/dgclaw.env"
criar_agente ana --nome "Ana"
afirma "painel em http://127.0.0.1:8450" grep -q 'Painel: http://127.0.0.1:8450/p/ana' "$TMP/saida.txt"

echo "dominio no modo proxy"
preparar
CF="$DGCLAW_RAIZ/etc/caddy/Caddyfile"
printf 'DGCLAW_DOMINIO=antigo.exemplo.org\nDGCLAW_PROXY_EXISTENTE=1\nDGCLAW_PORTA_PAINEL=8450\nDGCLAW_USUARIO=maria\n' >"$ETC/dgclaw.env"
dgclaw dominio >"$TMP/o.txt" 2>&1
igual "mostrar sai com 0" "0" "$?"
afirma "mostrar: o dominio" grep -q 'antigo.exemplo.org' "$TMP/o.txt"
afirma "mostrar: o modo" grep -q 'atras de proxy existente' "$TMP/o.txt"
afirma "mostrar: a porta" grep -q '127.0.0.1:8450' "$TMP/o.txt"
afirma "mostrar: trecho nginx" grep -q 'proxy_pass http://127.0.0.1:8450;' "$TMP/o.txt"
afirma "mostrar: trecho cloudflare" grep -q 'service: http://127.0.0.1:8450' "$TMP/o.txt"

: >"$STUB_LOG"
dgclaw dominio trocar Novo.Exemplo.com.br >"$TMP/o.txt" 2>&1
igual "trocar sai com 0" "0" "$?"
afirma "trocar: grava o dominio (minusculo)" grep -qx 'DGCLAW_DOMINIO=novo.exemplo.com.br' "$ETC/dgclaw.env"
afirma "trocar: mantem as outras linhas" grep -qx 'DGCLAW_PROXY_EXISTENTE=1' "$ETC/dgclaw.env"
nega "trocar: nao criou Caddyfile" test -e "$CF"
nega "trocar: nao criou nada em etc/caddy" test -e "$DGCLAW_RAIZ/etc/caddy"
nega "trocar: nao chamou caddy" grep -q '^caddy ' "$STUB_LOG"
nega "trocar: nao mexeu no servico caddy" grep -q 'systemctl .*caddy' "$STUB_LOG"
nega "trocar: nao conferiu DNS" grep -q '^dig ' "$STUB_LOG"
nega "trocar: nao esperou HTTPS" grep -q 'resolve novo.exemplo.com.br' "$STUB_LOG"
afirma "trocar: imprime o trecho nginx com o nome novo" grep -q 'server_name novo.exemplo.com.br;' "$TMP/o.txt"
afirma "trocar: imprime a porta" grep -q 'proxy_pass http://127.0.0.1:8450;' "$TMP/o.txt"
afirma "trocar: imprime o cloudflared" grep -q 'cloudflared tunnel route dns <nome-do-tunel> novo.exemplo.com.br' "$TMP/o.txt"
afirma "trocar: diz que o proxy e com a pessoa" grep -q 'Falta atualizar o seu proxy' "$TMP/o.txt"

# Mesmo sem o binario caddy no PATH (ele nem existe no modo proxy), o comando funciona.
mkdir -p "$TMP/semcaddy"
for f in "$AQUI"/stubs/*; do [ "$(basename "$f")" = caddy ] && continue; ln -s "$f" "$TMP/semcaddy/$(basename "$f")"; done
afirma "trocar nao exige o binario caddy" env "PATH=$TMP/semcaddy:/usr/bin:/bin" "$CLI" dominio trocar outro.exemplo.com.br

: >"$STUB_LOG"
dgclaw --ensaio dominio trocar ensaio.exemplo.com.br >"$TMP/o.txt" 2>&1
igual "ensaio sai com 0" "0" "$?"
afirma "ensaio: dgclaw.env intacto" grep -qx 'DGCLAW_DOMINIO=outro.exemplo.com.br' "$ETC/dgclaw.env"

echo "primeiro-acesso usa a porta quando nao ha dominio"
preparar
printf 'DGCLAW_PORTA_PAINEL=8450\n' >"$ETC/dgclaw.env"
printf 'DGCLAW_PANEL_USER=maria\n' >"$ETC/web.env"
afirma "link local na porta configurada" bash -c "'$CLI' primeiro-acesso 2>/dev/null | grep -q '^http://127.0.0.1:8450/primeiro-acesso#'"

echo "status: modo proxy nao cobra o caddy e usa a porta"
preparar
printf 'DGCLAW_DOMINIO=antigo.exemplo.org\nDGCLAW_PROXY_EXISTENTE=1\nDGCLAW_PORTA_PAINEL=8450\n' >"$ETC/dgclaw.env"
for u in dgclaw-web dgclaw-admin; do echo active >"$STUB_ESTADO/svc-$u"; done
dgclaw status >"$TMP/o.txt" 2>&1
igual "status sai com 0 sem o caddy ativo" "0" "$?"
nega "nao fala do servico caddy" grep -q 'servico caddy' "$TMP/o.txt"
afirma "avisa o modo proxy" grep -q 'modo proxy existente' "$TMP/o.txt"
afirma "Web na porta configurada" grep -q 'Web responde em 127.0.0.1:8450' "$TMP/o.txt"
afirma "chamou a porta configurada" grep -q 'curl .*http://127.0.0.1:8450/' "$STUB_LOG"

echo "status: modo normal continua cobrando o caddy"
preparar
printf 'DGCLAW_DOMINIO=antigo.exemplo.org\n' >"$ETC/dgclaw.env"
for u in dgclaw-web dgclaw-admin; do echo active >"$STUB_ESTADO/svc-$u"; done
dgclaw status >"$TMP/o.txt" 2>&1
igual "status sai com 1 com o caddy parado" "1" "$?"
afirma "cobra o caddy" grep -q 'FALHOU servico caddy parado' "$TMP/o.txt"
afirma "Web na 8300" grep -q 'Web responde em 127.0.0.1:8300' "$TMP/o.txt"

fim
