#!/usr/bin/env bash
# Testes do lib/emergencia.sh (dgclaw emergencia): sem root, sem mexer na máquina.
# Usa uma raiz falsa (DGCLAW_RAIZ) e comandos de mentira no PATH que só registram as chamadas
# (inclusive o conteúdo do arquivo nft que o corte carrega).
# shellcheck disable=SC2016,SC2015
# (SC2016: os comandos de mentira ficam entre aspas simples de propósito; SC2015: ok/nok não são if-then-else)
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$AQUI/../../lib/emergencia.sh"
BIN="$AQUI/../../bin/dgclaw"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSOU=0
FALHOU=0

ok() { PASSOU=$((PASSOU + 1)); printf '  ok   %s\n' "$1"; }
nok() { FALHOU=$((FALHOU + 1)); printf '  FALHA %s\n' "$1"; }

confere() { # descrição, esperado, obtido
  if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1"; printf '    esperado:\n%s\n    obtido:\n%s\n' "$2" "$3"; fi
}
contem() { # descrição, texto, trecho
  if grep -qF -- "$3" <<<"$2"; then ok "$1"; else nok "$1 (faltou: $3)"; printf '%s\n' "$2" | sed 's/^/    | /'; fi
}

monta_ambiente() {
  RAIZ="$TMP/raiz"
  FAKE="$TMP/fake"
  rm -rf "$RAIZ" "$FAKE"
  mkdir -p "$RAIZ/etc/dgclaw" "$FAKE/bin"
  : >"$FAKE/chamadas.log"; : >"$FAKE/unidades.log"
  export DGCLAW_RAIZ="$RAIZ" EMERGENCIA_CONF="$RAIZ/etc/dgclaw/emergencia.conf" EMERGENCIA_ESPERA=0 FAKE
  export PATH="$FAKE/bin:$PATH"
  cat >"$EMERGENCIA_CONF" <<CONF
SERVICOS_PUBLICOS="cloudflared caddy"
INTERFACES_ADMIN="tailscale0"
IPS_ADMIN=""
PORTA_SSH=22
PRAZO_CONFIRMAR_MIN=5
URLS_TESTE_RELIGAR="https://site.exemplo/ok"
REDES_INTERNAS="10.89.0.0/16"
ESTADO_DIR=/var/lib/dgclaw/emergencia
CONF
  touch "$FAKE/ativo-cloudflared" "$FAKE/ativo-caddy" "$FAKE/habilitado-cloudflared" "$FAKE/habilitado-caddy"

  fake systemctl '
case "$1" in
  is-active) if [[ "$3" == emergencia-desfazer.timer ]]; then [[ -f "$FAKE/timer-ativo" ]]; exit; fi
             [[ -f "$FAKE/falha-$3" ]] && exit 3; [[ -f "$FAKE/ativo-$3" ]]; exit ;;
  is-enabled) [[ -f "$FAKE/habilitado-$3" ]]; exit ;;
  stop) echo "systemctl $*" >>"$FAKE/chamadas.log"
        if [[ "$2" == emergencia-desfazer.timer ]]; then rm -f "$FAKE/timer-ativo"; else rm -f "$FAKE/ativo-$2"; fi ;;
  start) echo "systemctl $*" >>"$FAKE/chamadas.log"; touch "$FAKE/ativo-$2" ;;
  daemon-reload|enable|disable) echo "systemctl $*" >>"$FAKE/unidades.log" ;;
esac'
  fake systemd-run 'echo "systemd-run $*" >>"$FAKE/chamadas.log"; touch "$FAKE/timer-ativo"'
  fake tailscale '
if [[ -f "$FAKE/ts-logado" ]]; then echo "100.64.0.1 vps danilo linux -"; else echo "Logged out."; exit 1; fi'
  fake ip '
if [[ -f "$FAKE/if-tailscale0" && "$*" == *tailscale0* ]]; then echo "tailscale0 UNKNOWN 0.0.0.0"; else echo "Device does not exist" >&2; exit 1; fi'
  fake nft '
case "$1 $2" in
  "list ruleset") echo "table inet filter {}"; exit 0 ;;
  "list table") if [[ -f "$FAKE/nft-tabela" ]]; then cat "$FAKE/nft-carregado.txt" 2>/dev/null; exit 0; else exit 1; fi ;;
  "delete table") echo "nft $*" >>"$FAKE/chamadas.log"
                  [[ -f "$FAKE/nft-lento" ]] && sleep 1.5
                  rm -f "$FAKE/nft-tabela"; exit 0 ;;
  "-c -f") echo "nft $*" >>"$FAKE/chamadas.log"; cp "$3" "$FAKE/nft-validado.txt"
           if [[ -f "$FAKE/nft-invalido" ]]; then echo "Error: syntax error" >&2; exit 1; fi; exit 0 ;;
  "-f "*) echo "nft $*" >>"$FAKE/chamadas.log"
          if [[ -f "$FAKE/nft-falha-carga" ]]; then echo "Error: carga recusada" >&2; exit 1; fi
          cp "$2" "$FAKE/nft-carregado.txt"; touch "$FAKE/nft-tabela"; exit 0 ;;
esac
echo "nft: chamada inesperada $*" >&2; exit 1'
  fake logger 'exit 0'
  fake curl 'echo "curl $*" >>"$FAKE/chamadas.log"; [[ "$*" != *falha* ]]'
}

fake() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$FAKE/bin/$1"; chmod +x "$FAKE/bin/$1"; }

liga_tailscale() { touch "$FAKE/ts-logado" "$FAKE/if-tailscale0"; }
chamadas() { cat "$FAKE/chamadas.log"; }
roda() { # roda o script capturando saída e código em SAIDA/RC
  RC=0
  SAIDA="$("$SCRIPT" "$@" 2>&1)" || RC=$?
}

pega_codigo() { # gera um código novo com `preparar --json` e deixa em COD
  roda preparar --json "$@"
  COD="$(python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read())["codigo"])' <<<"$SAIDA" 2>/dev/null)" || COD=""
}

echo "1. simular sem Tailscale logado e sem IPS_ADMIN"
monta_ambiente
roda simular
contem "diz que seria recusado" "$SAIDA" "O corte seria recusado porque"
contem "explica que trancaria todo mundo fora" "$SAIDA" "o corte trancaria todo mundo fora: ligue o Tailscale"
confere "simular não executou nada" "" "$(chamadas)"
WEB="$RAIZ/var/lib/dgclaw/web/seguranca/emergencia.json"
if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["disponivel"] is False and "trancaria" in d["motivo"] and d["estado"]["cortado"] is False' "$WEB"; then ok "gravou emergencia.json para o painel (indisponível, com motivo)"; else nok "emergencia.json ausente ou errado"; fi
confere "emergencia.json legível (644)" "644" "$(stat -c %a "$WEB")"

echo "2. simular com Tailscale"
monta_ambiente; liga_tailscale
roda simular
contem "pré-checagens ok" "$SAIDA" "o corte seria aceito"
contem "lista o stop do caddy" "$SAIDA" "systemctl stop caddy"
contem "lista o carregamento da tabela nft" "$SAIDA" "nft -f $RAIZ/var/lib/dgclaw/emergencia/emergencia.nft"
contem "mostra a tabela nft própria" "$SAIDA" "table inet dgclaw_emergencia {"
contem "mostra o drop da entrada antes de qualquer estabelecida" "$SAIDA" "type filter hook input priority -10; policy accept;"
contem "libera a interface do Tailscale" "$SAIDA" 'iifname { "tailscale0" } accept'
contem "mantém a rede dos agentes" "$SAIDA" "ip saddr { 10.89.0.0/16 } accept"
confere "simular não executou nada" "" "$(chamadas)"
roda simular --json
if python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["recusado"] is False and len(d["comandos"])>=3 and "dgclaw_emergencia" in d["regras_nft"]' <<<"$SAIDA"; then ok "simular --json é JSON válido"; else nok "simular --json inválido: $SAIDA"; fi
roda estado --json
if python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["cortado"] is False' <<<"$SAIDA"; then ok "estado --json é JSON válido"; else nok "estado --json inválido: $SAIDA"; fi
if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["disponivel"] is True and d["motivo"]=="" and len(d["plano"]["comandos"])>=3' "$WEB"; then ok "emergencia.json: disponível, com o plano"; else nok "emergencia.json (disponível) errado"; fi
roda --help
contem "o uso cita o preparar" "$SAIDA" "preparar"

echo "3. domínio do painel vira a URL do teste do religar"
monta_ambiente; liga_tailscale
sed -i '/^URLS_TESTE_RELIGAR=/d' "$EMERGENCIA_CONF"
printf 'DGCLAW_DOMINIO=painel.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
pega_codigo
roda cortar --codigo "$COD"
confere "cortar ok" "0" "$RC"
: >"$FAKE/chamadas.log"
pega_codigo
roda religar --codigo "$COD"
contem "religar testa o domínio do dgclaw.env" "$(chamadas)" "curl -fsS --max-time 10 -o /dev/null https://painel.exemplo.org/"

echo "4. preparar: código de uso único, hash em disco e recusas"
monta_ambiente; liga_tailscale
pega_codigo
[[ "$COD" =~ ^[A-HJKMNP-Z2-9]{6}$ ]] && ok "código com 6 caracteres sem ambiguidade" || nok "código fora do formato: '$COD'"
ARQ="$RAIZ/var/lib/dgclaw/seguranca/emergencia-codigo"
confere "arquivo do código é 600" "600" "$(stat -c %a "$ARQ")"
confere "pasta do código é 700" "700" "$(stat -c %a "$(dirname "$ARQ")")"
if grep -qF -- "$COD" "$ARQ"; then nok "o código está em claro no arquivo"; else ok "só o hash fica em disco"; fi
if python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["acao"]=="cortar" and d["valido_s"]==120 and d["plano"]["recusado"] is False' <<<"$SAIDA"; then ok "preparar --json traz ação, validade e plano"; else nok "preparar --json: $SAIDA"; fi
roda cortar
confere "cortar sem código falha" "1" "$RC"
contem "pede o código" "$SAIDA" "faltou o código"
roda cortar --codigo ERRADO
confere "código errado falha" "1" "$RC"
contem "diz que não confere" "$SAIDA" "o código não confere (tentativa 1 de 3)"
confere "nada foi chamado" "" "$(chamadas)"
roda cortar --codigo ERRADO; roda cortar --codigo ERRADO
contem "na 3ª tentativa descarta" "$SAIDA" "foi descartado"
[[ ! -e "$ARQ" ]] && ok "código descartado do disco" || nok "código continua em disco"
roda cortar --codigo "$COD"
confere "código descartado não vale mais" "1" "$RC"
pega_codigo
printf '%s\n%s\n0\n' "$(printf %s "$COD" | sha256sum | awk '{print $1}')" "$(( $(date +%s) - 5 ))" >"$ARQ"
roda cortar --codigo "$COD"
confere "código vencido falha" "1" "$RC"
contem "diz que venceu" "$SAIDA" "o código venceu"
confere "nada foi chamado" "" "$(chamadas)"
echo "   preparar sem caminho de acesso é recusado"
monta_ambiente
roda preparar
confere "preparar recusado" "1" "$RC"
contem "motivo" "$SAIDA" "não dá para preparar o corte porque"

echo "5. cortar recusa sem caminho de acesso e com regras que o nft não aceita (código válido)"
monta_ambiente; liga_tailscale
pega_codigo
touch "$FAKE/nft-invalido"
roda cortar --codigo "$COD"
confere "regras recusadas pelo nft falham" "1" "$RC"
contem "motivo do nft" "$SAIDA" "o nft recusou as regras"
confere "só validou, não agendou nem parou nada" "nft -c -f $RAIZ/var/lib/dgclaw/emergencia/emergencia.nft" "$(chamadas)"
[[ ! -e "$RAIZ/var/lib/dgclaw/emergencia/cortado" ]] && ok "sem marcador de corte" || nok "marcador de corte criado apesar da recusa"
rm "$FAKE/nft-invalido"
: >"$FAKE/chamadas.log"
pega_codigo
rm "$FAKE/ts-logado"
roda cortar --codigo "$COD"
confere "Tailscale deslogado falha" "1" "$RC"
confere "nada foi chamado" "" "$(chamadas)"

echo "6. cortar de verdade (falso) com Tailscale e IPS_ADMIN"
monta_ambiente; liga_tailscale
sed -i 's|^IPS_ADMIN=.*|IPS_ADMIN="203.0.113.10 198.51.100.0/24 2001:db8::1"|' "$EMERGENCIA_CONF"
pega_codigo
roda cortar --codigo "$COD"
confere "exit 0" "0" "$RC"
SELF="$(readlink -f "$SCRIPT")"
ED="$RAIZ/var/lib/dgclaw/emergencia"
ID_CORTE="$(sed -n 's/^corte_id=//p' "$ED/cortado")"
[[ "$ID_CORTE" =~ ^[0-9a-f]{16}$ ]] && ok "o corte ganhou um id único no marcador" || nok "id do corte ausente: '$ID_CORTE'"
ESPERADO="nft -c -f $ED/emergencia.nft
systemd-run --on-active=5m --unit=emergencia-desfazer --setenv=EMERGENCIA_CONF=$EMERGENCIA_CONF --setenv=DGCLAW_RAIZ=$RAIZ $SELF religar --automatico --corte $ID_CORTE
systemctl stop cloudflared
systemctl stop caddy
nft -f $ED/emergencia.nft"
confere "sequência exata de chamadas (valida, agenda, para, carrega)" "$ESPERADO" "$(chamadas)"
NFT="$(cat "$FAKE/nft-carregado.txt")"
confere "o arquivo validado é o carregado" "$(cat "$FAKE/nft-validado.txt")" "$NFT"
contem "recria a tabela do zero (idempotente)" "$NFT" "delete table inet dgclaw_emergencia"
contem "chain de entrada antes do ufw (hook input, prioridade -10)" "$NFT" "type filter hook input priority -10; policy accept;"
contem "chain de saída" "$NFT" "type filter hook output priority -10; policy accept;"
contem "chain de encaminhamento" "$NFT" "type filter hook forward priority -10; policy accept;"
contem "aceita loopback" "$NFT" 'iifname "lo" accept'
contem "aceita a interface admin" "$NFT" 'iifname { "tailscale0" } accept'
contem "SSH dos IPs admin v4" "$NFT" "ip saddr { 203.0.113.10, 198.51.100.0/24 } tcp dport 22 accept"
contem "SSH dos IPs admin v6" "$NFT" "ip6 saddr { 2001:db8::1 } tcp dport 22 accept"
contem "rede interna dos agentes" "$NFT" "ip saddr { 10.89.0.0/16 } accept"
contem "resposta aos IPs admin (saída v4)" "$NFT" "ip daddr { 203.0.113.10, 198.51.100.0/24 } accept"
contem "resposta aos IPs admin (saída v6)" "$NFT" "ip6 daddr { 2001:db8::1 } accept"
contem "não deixa o IPv6 sem vizinhança" "$NFT" "icmpv6 type { nd-router-solicit"
confere "sem --isolar-saida entrada e encaminhamento têm drop (a saída não)" "2" "$(grep -c '^[[:space:]]*drop$' <<<"$NFT")"
FWD="$(sed -n '/chain encaminhamento/,/^\t}/p' <<<"$NFT")"
contem "encaminhamento padrão: aceita resposta a conexão de container" "$FWD" "ct direction reply accept"
contem "encaminhamento padrão: container sai para a internet" "$FWD" "ct direction original ip saddr { 10.89.0.0/16 } accept"
contem "encaminhamento padrão: entre redes internas" "$FWD" "ip saddr { 10.89.0.0/16 } ip daddr { 10.89.0.0/16 } accept"
contem "encaminhamento padrão: interface admin" "$FWD" 'oifname { "tailscale0" } accept'
confere "encaminhamento padrão termina em drop (v4 e v6 sem DNAT)" "drop" "$(grep -v '^[[:space:]]*}' <<<"$FWD" | tail -n 1 | tr -d '\t')"
if command -v nft >/dev/null 2>&1 && [[ "$EUID" -eq 0 ]]; then
  REAL="$(PATH="${PATH#"$FAKE/bin:"}" command -v nft)"
  if saida_real="$("$REAL" -c -f "$FAKE/nft-validado.txt" 2>&1)"; then ok "nft -c -f real aceita o arquivo do corte padrão"; else nok "nft real recusou: $saida_real"; fi
fi
if grep -q 'ct state established' <<<"$NFT"; then nok "aceitou conexão estabelecida sem ser DNS"; else ok "conexão estabelecida não é aceita (cai no drop)"; fi
[[ -f "$ED/cortado" ]] && ok "marcador cortado criado" || nok "marcador cortado ausente"
[[ ! -e "$ARQ" ]] && ok "o código foi gasto" || nok "o código continua em disco"
confere "pasta de estado é 700" "700" "$(stat -c %a "$ED")"
confere "pasta antes é 700" "700" "$(stat -c %a "$ED/antes")"
for f in nft-ruleset.txt servicos.txt carimbo.txt; do
  [[ -s "$ED/antes/$f" ]] && ok "guardou antes/$f" || nok "faltou antes/$f"
done
confere "serviços guardados" "cloudflared|ativo|habilitado
caddy|ativo|habilitado" "$(cat "$ED/antes/servicos.txt")"
[[ -s "$ED/emergencia.log" ]] && ok "log gravado" || nok "log vazio"
if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); e=d["estado"]; assert e["cortado"] is True and e["religar_automatico_agendado"] is True and e["religar_automatico_em"].endswith("Z")' "$WEB"; then ok "emergencia.json mostra o corte e a hora do religar automático"; else nok "emergencia.json depois do corte"; fi
pega_codigo
roda cortar --codigo "$COD"
confere "cortar de novo é recusado" "1" "$RC"
contem "diz que já está cortado" "$SAIDA" "já está cortado"
roda estado
contem "estado mostra cortado" "$SAIDA" "Estado: CORTADO"
contem "estado mostra confirmação pendente" "$SAIDA" "PENDENTE"
roda estado --json
if python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["cortado"] is True and d["religar_automatico_agendado"] is True' <<<"$SAIDA"; then ok "estado --json cortado"; else nok "estado --json: $SAIDA"; fi
pega_codigo
if python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["acao"]=="religar"' <<<"$SAIDA"; then ok "preparar com o servidor cortado oferece o religar"; else nok "preparar cortado: $SAIDA"; fi

echo "7. confirmar cancela o timer"
: >"$FAKE/chamadas.log"
roda confirmar
confere "exit 0" "0" "$RC"
confere "parou o timer" "systemctl stop emergencia-desfazer.timer" "$(chamadas)"
[[ -f "$ED/confirmado" ]] && ok "marcador confirmado" || nok "sem marcador confirmado"

echo "8. religar exige código e apaga só a tabela nft própria"
rm -f "$FAKE/ativo-cloudflared" "$FAKE/ativo-caddy"
: >"$FAKE/chamadas.log"
roda religar
confere "religar sem código falha" "1" "$RC"
roda religar --codigo ERRADO
confere "religar com código errado falha" "1" "$RC"
confere "nada foi chamado" "" "$(chamadas)"
pega_codigo
roda religar --codigo "$(printf %s "$COD" | tr '[:upper:]' '[:lower:]')"
confere "exit 0 (código aceito em minúsculas)" "0" "$RC"
ESPERADO="nft delete table inet dgclaw_emergencia
systemctl start cloudflared
systemctl start caddy
curl -fsS --max-time 10 -o /dev/null https://site.exemplo/ok"
confere "sequência do religar (apaga a tabela pelo nome, religa, testa)" "$ESPERADO" "$(chamadas)"
contem "relatório do que voltou" "$SAIDA" "voltou: serviço caddy ativo"
[[ ! -e "$ED/cortado" ]] && ok "marcador cortado apagado" || nok "marcador cortado continua"
ls "$ED/historico"/*/cortado >/dev/null 2>&1 && ok "histórico guardado" || nok "histórico ausente"
ls "$ED/historico"/*/emergencia.nft >/dev/null 2>&1 && ok "o arquivo nft foi para o histórico" || nok "arquivo nft ausente do histórico"
if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["estado"]["cortado"] is False' "$WEB"; then ok "emergencia.json volta ao normal"; else nok "emergencia.json depois do religar"; fi
roda estado
contem "estado volta ao normal" "$SAIDA" "Estado: NORMAL"
pega_codigo
roda religar --codigo "$COD"
confere "religar sem corte falha" "1" "$RC"
contem "motivo" "$SAIDA" "não há corte ativo"

echo "9. religar relata o que não voltou e sai com erro"
monta_ambiente; liga_tailscale
sed -i 's|^URLS_TESTE_RELIGAR=.*|URLS_TESTE_RELIGAR="https://site.exemplo/ok https://falha.exemplo/x"|' "$EMERGENCIA_CONF"
pega_codigo
roda cortar --codigo "$COD"
touch "$FAKE/falha-caddy"
pega_codigo
roda religar --codigo "$COD"
confere "exit diferente de zero" "1" "$RC"
contem "diz que o caddy não voltou" "$SAIDA" "NÃO voltou: serviço caddy"
contem "diz que a URL não voltou" "$SAIDA" "NÃO voltou: https://falha.exemplo/x"
[[ ! -e "$RAIZ/var/lib/dgclaw/emergencia/cortado" ]] && ok "marcador apagado mesmo assim" || nok "marcador ficou"

echo "10. --isolar-saida e religar automático (sem código)"
monta_ambiente; liga_tailscale
pega_codigo --isolar-saida
roda cortar --codigo "$COD" --isolar-saida
NFT="$(cat "$FAKE/nft-carregado.txt")"
confere "com --isolar-saida entrada, saída e encaminhamento têm drop" "3" "$(grep -c '^[[:space:]]*drop$' <<<"$NFT")"
contem "libera DNS (udp)" "$NFT" "udp dport 53 accept"
contem "libera DNS (tcp)" "$NFT" "tcp dport 53 accept"
contem "resposta a conexão aberta por este servidor não cai no drop" "$NFT" "ct direction reply accept"
contem "tráfego do tailscaled liberado na saída isolada" "$NFT" "meta mark & 0xff0000 == 0x80000 accept"
contem "porta publicada de container cai no corte" "$NFT" "ct direction original ct status dnat drop"
contem "libera saída pela interface" "$NFT" 'oifname { "tailscale0" } accept'
contem "encaminhamento: só a interface admin" "$NFT" 'iifname { "tailscale0" } accept'
contem "encaminhamento: só entre redes internas" "$NFT" "ip saddr { 10.89.0.0/16 } ip daddr { 10.89.0.0/16 } accept"
: >"$FAKE/chamadas.log"
roda religar --automatico
confere "religar automático ok sem código" "0" "$RC"

echo "11. conf não é executado e chave desconhecida é recusada"
monta_ambiente; liga_tailscale
echo 'SERVICOS_PUBLICOS="$(touch '"$TMP"'/invadido)"' >>"$EMERGENCIA_CONF"
roda simular
[[ ! -e "$TMP/invadido" ]] && ok "conf não executou comando" || nok "conf EXECUTOU comando"
contem "recusa nome de serviço inválido" "$SAIDA" "SERVICOS_PUBLICOS tem nome inválido"
monta_ambiente
echo 'COISA=1' >>"$EMERGENCIA_CONF"
roda estado
contem "chave desconhecida" "$SAIDA" "chave desconhecida 'COISA'"

echo "12. dgclaw emergencia chama o mesmo script"
monta_ambiente; liga_tailscale
RC=0; SAIDA="$("$BIN" emergencia estado 2>&1)" || RC=$?
confere "exit 0" "0" "$RC"
contem "estado normal pela CLI" "$SAIDA" "Estado: NORMAL"
RC=0; SAIDA="$("$BIN" --ajuda 2>&1)" || RC=$?
contem "a ajuda do dgclaw lista a emergência" "$SAIDA" "dgclaw emergencia estado|simular|preparar|cortar|confirmar|religar"

echo "13. religar manual e automático ao mesmo tempo: a tabela é apagada uma vez"
monta_ambiente; liga_tailscale
pega_codigo
roda cortar --codigo "$COD"
confere "cortar ok" "0" "$RC"
touch "$FAKE/nft-lento"
: >"$FAKE/chamadas.log"
pega_codigo
( "$SCRIPT" religar --codigo "$COD" >"$TMP/religar-1.txt" 2>&1; echo $? >"$TMP/religar-1.rc" ) &
sleep 0.5
RC=0; SAIDA="$("$SCRIPT" religar --automatico 2>&1)" || RC=$?
wait
confere "o automático sai 0" "0" "$RC"
contem "o automático diz que já estava religado" "$SAIDA" "Já estava religado"
confere "o manual terminou bem" "0" "$(cat "$TMP/religar-1.rc")"
confere "a tabela foi apagada uma vez só" "1" "$(chamadas | grep -c '^nft delete table')"
ED="$RAIZ/var/lib/dgclaw/emergencia"
[[ ! -e "$ED/cortado" ]] && ok "marcador de corte apagado" || nok "marcador de corte ficou"
rm -f "$FAKE/nft-lento"
echo "   o segundo religar manual (com código) que esperou a trava também sai 0"
monta_ambiente; liga_tailscale
pega_codigo
roda cortar --codigo "$COD"
touch "$FAKE/nft-lento"
: >"$FAKE/chamadas.log"
pega_codigo
COD1="$COD"
( "$SCRIPT" religar --codigo "$COD1" >"$TMP/religar-1.txt" 2>&1; echo $? >"$TMP/religar-1.rc" ) &
sleep 0.5
RC=0; SAIDA="$("$SCRIPT" religar --codigo "$COD1" 2>&1)" || RC=$?
wait
confere "o segundo manual sai 0" "0" "$RC"
contem "diz que já estava religado" "$SAIDA" "Já estava religado"
confere "a tabela foi apagada uma vez só" "1" "$(chamadas | grep -c '^nft delete table')"

echo "14. o corte NÃO sobrevive a um reinício (por desenho): vira estado inconsistente e reaplicar guarda o snapshot original"
monta_ambiente; liga_tailscale
ED="$RAIZ/var/lib/dgclaw/emergencia"
pega_codigo
roda cortar --codigo "$COD"
confere "cortar ok" "0" "$RC"
[[ ! -d "$RAIZ/etc/systemd/system" ]] && ok "o corte não instala nenhuma unidade de boot" || nok "apareceu $RAIZ/etc/systemd/system"
confere "o corte não chama enable/daemon-reload" "" "$(cat "$FAKE/unidades.log")"
roda confirmar
confere "confirmar ok" "0" "$RC"
confere "caddy parado pelo corte" "nao" "$([[ -f "$FAKE/ativo-caddy" ]] && echo sim || echo nao)"
echo "   simula o reinício: some a tabela nft e o timer, o cloudflared sobe sozinho (habilitado)"
rm -f "$FAKE/nft-tabela" "$FAKE/timer-ativo" "$FAKE/nft-carregado.txt"
touch "$FAKE/ativo-cloudflared"
roda estado --json
if python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["cortado"] is True and d["inconsistente"] is True and "NÃO está protegida" in d["motivo_inconsistente"]' <<<"$SAIDA"; then ok "estado --json acusa o estado inconsistente com o motivo"; else nok "estado --json inconsistente: $SAIDA"; fi
roda estado
contem "estado fala em INCONSISTENTE" "$SAIDA" "Estado: INCONSISTENTE"
cp "$ED/antes/servicos.txt" "$TMP/servicos-antes.txt"
echo "   reaplicar o corte inconsistente preserva antes/ e a lista original (caddy continua na lista)"
pega_codigo
if python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["acao"]=="cortar"' <<<"$SAIDA"; then ok "preparar oferece o corte no estado inconsistente"; else nok "preparar inconsistente: $SAIDA"; fi
roda cortar --codigo "$COD"
confere "cortar no estado inconsistente é aceito" "0" "$RC"
[[ -f "$FAKE/nft-tabela" ]] && ok "a tabela nft foi recarregada" || nok "tabela não recarregada"
[[ ! -e "$ED/confirmado" ]] && ok "a confirmação antiga foi descartada" || nok "confirmação antiga ficou"
confere "o snapshot de antes/ não foi reescrito" "$(cat "$TMP/servicos-antes.txt")" "$(cat "$ED/antes/servicos.txt")"
contem "a lista original ainda tem o caddy como ativo" "$(cat "$ED/antes/servicos.txt")" "caddy|ativo|"
contem "o marcador mantém o caddy nos parados" "$(sed -n 's/^servicos_parados=//p' "$ED/cortado")" "caddy"
confere "caddy parado de novo" "nao" "$([[ -f "$FAKE/ativo-caddy" ]] && echo sim || echo nao)"
confere "cloudflared parado de novo" "nao" "$([[ -f "$FAKE/ativo-cloudflared" ]] && echo sim || echo nao)"
pega_codigo
roda religar --codigo "$COD"
confere "religar ok" "0" "$RC"
[[ -f "$FAKE/ativo-caddy" && -f "$FAKE/ativo-cloudflared" ]] && ok "religar inicia o caddy e o cloudflared" || nok "religar não iniciou os serviços originais"
echo "   reaplicar sem o estado guardado recusa, sem mexer em nada"
monta_ambiente; liga_tailscale
pega_codigo
roda cortar --codigo "$COD"
rm -f "$FAKE/nft-tabela" "$FAKE/nft-carregado.txt"; rm -rf "$RAIZ/var/lib/dgclaw/emergencia/antes"
pega_codigo
roda cortar --codigo "$COD"
confere "recusa" "1" "$RC"
contem "explica por quê" "$SAIDA" "não deixou o estado guardado"

echo "16. religar automático não desfaz corte confirmado nem corte ultrapassado"
monta_ambiente; liga_tailscale
pega_codigo
roda cortar --codigo "$COD"
ED="$RAIZ/var/lib/dgclaw/emergencia"
ID1="$(sed -n 's/^corte_id=//p' "$ED/cortado")"
echo "   corrida: confirmar segura a trava, o automático espera e entra depois da confirmação"
: >"$FAKE/chamadas.log"
( exec 9>"$ED/.trava"; flock 9; sleep 1.5; date >"$ED/confirmado" ) &
sleep 0.4
RC=0; SAIDA="$("$SCRIPT" religar --automatico --corte "$ID1" 2>&1)" || RC=$?
wait
confere "o automático sai 0" "0" "$RC"
contem "diz que o corte já foi confirmado" "$SAIDA" "já foi confirmado"
confere "não apagou a tabela" "0" "$(chamadas | grep -c '^nft delete table')"
[[ -f "$ED/cortado" && -f "$FAKE/nft-tabela" ]] && ok "corte e firewall intactos" || nok "o automático desfez o corte confirmado"
echo "   id antigo depois de um novo corte"
rm -f "$ED/confirmado"
sed -i 's/^corte_id=.*/corte_id=ffffffffffffffff/' "$ED/cortado"
: >"$FAKE/chamadas.log"
RC=0; SAIDA="$("$SCRIPT" religar --automatico --corte "$ID1" 2>&1)" || RC=$?
confere "o automático antigo sai 0" "0" "$RC"
contem "diz que era de um corte anterior" "$SAIDA" "de um corte anterior"
confere "não apagou a tabela" "0" "$(chamadas | grep -c '^nft delete table')"
[[ -f "$ED/cortado" ]] && ok "marcador do corte novo intacto" || nok "o automático antigo apagou o corte novo"
echo "   id certo religa"
RC=0; SAIDA="$("$SCRIPT" religar --automatico --corte ffffffffffffffff 2>&1)" || RC=$?
confere "o automático do corte atual sai 0" "0" "$RC"
[[ ! -e "$ED/cortado" ]] && ok "religou" || nok "não religou com o id certo"
RC=0; SAIDA="$("$SCRIPT" religar --automatico --corte nao-e-hex 2>&1)" || RC=$?
confere "id malformado é recusado" "1" "$RC"

echo "17. confirmar recusa corte incompleto e mantém o religar automático"
monta_ambiente; liga_tailscale
pega_codigo
roda cortar --codigo "$COD"
ED="$RAIZ/var/lib/dgclaw/emergencia"
rm -f "$FAKE/nft-tabela"
roda confirmar
confere "sem firewall carregado, recusa" "1" "$RC"
contem "diz que o corte não se completou" "$SAIDA" "o corte não se completou: a tabela nft dgclaw_emergencia não está carregada"
contem "diz que o religar automático continua" "$SAIDA" "o religar automático continua agendado"
[[ -f "$FAKE/timer-ativo" ]] && ok "o timer não foi cancelado" || nok "o timer foi cancelado"
[[ ! -e "$ED/confirmado" ]] && ok "não gravou confirmado" || nok "gravou confirmado em corte incompleto"
touch "$FAKE/nft-tabela"
touch "$FAKE/ativo-caddy"
roda confirmar
confere "serviço público rodando, recusa" "1" "$RC"
contem "diz qual serviço continua rodando" "$SAIDA" "o serviço caddy continua rodando"
rm -f "$FAKE/ativo-caddy"
printf 'table inet dgclaw_emergencia {\n\tchain entrada {\n\t}\n}\n' >"$FAKE/nft-carregado.txt"
roda confirmar
confere "tabela sem as chains esperadas, recusa" "1" "$RC"
contem "diz qual chain falta" "$SAIDA" "falta a chain saida na tabela nft"
cp "$FAKE/nft-validado.txt" "$FAKE/nft-carregado.txt"
roda confirmar
confere "corte completo, confirma" "0" "$RC"
[[ -f "$ED/confirmado" ]] && ok "confirmado gravado" || nok "confirmado ausente"

echo "18. cortar que falha ao carregar o nft desfaz o que fez"
monta_ambiente; liga_tailscale
pega_codigo
touch "$FAKE/nft-falha-carga"
roda cortar --codigo "$COD"
ED="$RAIZ/var/lib/dgclaw/emergencia"
confere "cortar sai com erro" "1" "$RC"
contem "diz que o corte não foi feito e o que foi desfeito" "$SAIDA" "O corte NÃO foi feito"
[[ -f "$FAKE/ativo-cloudflared" && -f "$FAKE/ativo-caddy" ]] && ok "serviços parados foram religados" || nok "serviços ficaram parados"
[[ ! -e "$ED/cortado" ]] && ok "marcador apagado" || nok "marcador de corte ficou"
[[ ! -f "$FAKE/timer-ativo" ]] && ok "timer cancelado" || nok "timer ficou agendado"
roda estado
contem "estado volta ao normal" "$SAIDA" "Estado: NORMAL"

echo
echo "Passaram: $PASSOU  Falharam: $FALHOU"
((FALHOU == 0))
