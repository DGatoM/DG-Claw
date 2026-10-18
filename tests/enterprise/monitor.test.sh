#!/usr/bin/env bash
# dgclaw monitor verificar|configurar|testar: cada checagem, o envio por webhook/Telegram/ping sem segredo em
# argv ou em log, a repeticao a cada 6 h, o "resolvido", o dead man's switch e o gancho do status.
# Tudo com stubs de df, openssl, systemctl, curl, iptables e podman; relogio fixo por DGCLAW_AGORA_MS.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
PATH="$AQUI/../enterprise/stubs-monitor:$PATH"
export PATH DGCLAW_QUEM=testador
EST="$STUB_ESTADO"
R_="$DGCLAW_RAIZ"
MON="$LIB/monitor"
ALERTAS="$ETC/alertas.env"
AGORA="$(date -u -d '2026-10-18 12:00:00' +%s)"
export DGCLAW_AGORA_MS=$((AGORA * 1000))
WEBHOOK_SEGREDO="SEGREDOWEBHOOK123"
BOT_SEGREDO="123456:ABCbotsegredo"
PING_SEGREDO="uuid-ping-secreto-9"

avancar() { DGCLAW_AGORA_MS=$(( (AGORA + $1) * 1000 )); export DGCLAW_AGORA_MS; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
chamadas() { grep -c "$1" "$STUB_LOG" || true; }
cfgs() { grep -c "$1" "$EST/curl-cfgs.log" 2>/dev/null || true; }
verificar() { dgclaw monitor verificar >"$TMP/v.txt" 2>&1; }

cenario_bom() {
    mkdir -p "$LIB/agentes" "$LIB/backup" "$R_/proc" "$R_/var/log/dgclaw"
    jq -n '{versao:1, agentes:[{slug:"ana", tipo:"agente", home_host:"/x"}]}' >"$ETC/agentes.json"
    rm -f "$EST"/df "$EST"/openssl-falha "$EST"/curl-falha "$EST"/curl-eco "$EST"/iptables-falha "$EST/curl-cfgs.log"
    for u in dgclaw-web dgclaw-admin caddy; do echo active >"$EST/svc-$u"; done
    echo running >"$EST/c-dgclaw-ana"
    touch "$EST/cerca"
    date -u -d "@$((AGORA + 60 * 86400))" '+%b %e %H:%M:%S %Y GMT' >"$EST/cert-fim"
    printf 'MemTotal:        8000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\n' >"$R_/proc/meminfo"
    printf '{"ok":true,"quando":"%s","snapshot":"s1","erro":null}\n' "$(iso $((AGORA - 7200)))" >"$LIB/backup/ultimo-backup.json"
    printf '{"ok":true,"quando":"%s","snapshot":"s1","erro":null}\n' "$(iso $((AGORA - 3 * 86400)))" >"$LIB/backup/ultimo-teste.json"
    printf 'ALERTA_WEBHOOK_URL=https://hooks.exemplo.org/T000/%s\nALERTA_TELEGRAM_TOKEN=%s\nALERTA_TELEGRAM_CHAT=-100123\nALERTA_PING_URL=https://ping.exemplo.org/%s\n' \
        "$WEBHOOK_SEGREDO" "$BOT_SEGREDO" "$PING_SEGREDO" >"$ALERTAS"
    chmod 600 "$ALERTAS"
    rm -rf "$MON"
    : >"$STUB_LOG"
    avancar 0
}

nivel_na_raiz empresa
cenario_bom

echo "monitor: tudo certo"
verificar
igual "sai com 0" 0 "$?"
afirma "diz que esta tudo certo" grep -q "tudo certo" "$TMP/v.txt"
igual "so o ping saiu (1 pedido), nenhum alerta" 1 "$(cfgs 'ping.exemplo.org')"
igual "nada foi para o webhook nem para o Telegram" 0 "$(( $(cfgs 'hooks.exemplo.org') + $(cfgs 'api.telegram.org') ))"
afirma "ultimo.json ok" jq -e '.ok == true and .epoch == '"$AGORA"'' "$MON/ultimo.json"
igual "pasta de estado 700" 700 "$(stat -c %a "$MON")"
igual "ultimo.json 600" 600 "$(stat -c %a "$MON/ultimo.json")"
nega "nenhum segredo em argv do curl" grep -qE "$WEBHOOK_SEGREDO|123456:ABC|$PING_SEGREDO|ABCbotsegredo" "$STUB_LOG"
afirma "mas a URL do ping foi pelo stdin do curl" grep -q "$PING_SEGREDO" "$EST/curl-cfgs.log"
afirma "curl com -q (ignora ~/.curlrc) e --config -" grep -q "curl -q .*--config -" "$STUB_LOG"

echo "monitor: disco"
cenario_bom
printf 'raiz 90 /\n' >"$EST/df"
verificar
igual "disco a 90%: sai com 1" 1 "$?"
afirma "diz o disco e a porcentagem" grep -q "O disco em / esta 90% cheio" "$TMP/v.txt"
afirma "diz o que fazer" grep -q "O que fazer: Libere espaco" "$TMP/v.txt"
igual "alerta saiu no webhook" 1 "$(cfgs 'hooks.exemplo.org')"
igual "alerta saiu no Telegram" 1 "$(cfgs 'api.telegram.org')"
igual "sem problema nao tem ping: com problema nao pinga" 0 "$(cfgs 'ping.exemplo.org')"
afirma "texto do alerta no webhook" grep -q 'DG Claw (teste.exemplo.org)' "$EST/curl-cfgs.log"
afirma "o Telegram usa data-urlencode" grep -q 'data-urlencode = "chat_id=-100123"' "$EST/curl-cfgs.log"
afirma "estado guarda o alerta aberto" jq -e '."disco:/".ultimo_envio == '"$AGORA" "$MON/estado.json"
echo "monitor: o mesmo alerta nao repete antes de 6 h"
: >"$EST/curl-cfgs.log"
avancar 3600
verificar
igual "uma hora depois: nada novo enviado" 0 "$(cfgs 'hooks.exemplo.org')"
avancar $((6 * 3600 - 1))
verificar
igual "5h59 depois: nada novo enviado" 0 "$(cfgs 'hooks.exemplo.org')"
avancar $((6 * 3600))
verificar
igual "6h depois: repete" 1 "$(cfgs 'hooks.exemplo.org')"
echo "monitor: resolvido"
: >"$EST/curl-cfgs.log"
rm -f "$EST/df"
avancar $((7 * 3600))
verificar
igual "voltou ao normal: sai com 0" 0 "$?"
afirma "manda o resolvido" grep -q "RESOLVIDO" "$EST/curl-cfgs.log"
afirma "o resolvido diz qual era" grep -q "O disco em / esta 90% cheio" "$EST/curl-cfgs.log"
igual "estado esvazia" "{}" "$(jq -c . "$MON/estado.json")"
igual "e o ping volta" 1 "$(cfgs 'ping.exemplo.org')"
echo "monitor: o disco cifrado e o de /var/lib/dgclaw entram"
cenario_bom
printf 'agentes 91 /mnt/cifrado\nvar/lib/dgclaw 88 /var/lib/dgclaw\n' >"$EST/df"
verificar
afirma "volume cifrado (disco_cifrado ligado no nivel empresa)" grep -q "O disco em /mnt/cifrado esta 91%" "$TMP/v.txt"
afirma "/var/lib/dgclaw" grep -q "O disco em /var/lib/dgclaw esta 88%" "$TMP/v.txt"
printf 'MONITOR_VOLUME_CIFRADO=%s/outro\n' "$R_" >>"$ALERTAS"; mkdir -p "$R_/outro"
printf 'outro 95 /mnt/outro\n' >"$EST/df"
verificar
afirma "MONITOR_VOLUME_CIFRADO troca o caminho conferido" grep -q "O disco em /mnt/outro esta 95%" "$TMP/v.txt"

echo "monitor: certificado"
cenario_bom
date -u -d "@$((AGORA + 5 * 86400))" '+%b %e %H:%M:%S %Y GMT' >"$EST/cert-fim"
verificar
afirma "vence em 5 dias" grep -q "certificado HTTPS de teste.exemplo.org vence em 5 dia(s)" "$TMP/v.txt"
date -u -d "@$((AGORA - 2 * 86400))" '+%b %e %H:%M:%S %Y GMT' >"$EST/cert-fim"
verificar
afirma "venceu" grep -q "venceu ha 2 dia(s)" "$TMP/v.txt"
date -u -d "@$((AGORA + 14 * 86400 + 3600))" '+%b %e %H:%M:%S %Y GMT' >"$EST/cert-fim"
verificar
igual "14 dias e uma hora ainda esta bom" 0 "$?"
touch "$EST/openssl-falha"
verificar
afirma "porta 443 sem resposta" grep -q "Nao consegui ler o certificado HTTPS de teste.exemplo.org" "$TMP/v.txt"
afirma "a dica fala do Caddy" grep -q "systemctl status caddy" "$TMP/v.txt"

echo "monitor: cerca de rede"
cenario_bom
rm "$EST/cerca"
verificar
igual "cerca sumida: alerta (sai com 1)" 1 "$?"
afirma "diz que reaplicou" grep -q "tinha sumido.*Eu reapliquei e ela voltou" "$TMP/v.txt"
afirma "de fato rodou o firewall.sh (criou as cadeias)" grep -q "iptables -w -t filter -N DGCLAW_HOST" "$STUB_LOG"
afirma "a cerca voltou" test -e "$EST/cerca"
verificar
igual "proxima rodada: tudo certo e manda o resolvido" 0 "$?"
rm "$EST/cerca"; touch "$EST/iptables-falha"
verificar
afirma "se nao conseguir reaplicar, diz" grep -q "nao consegui reaplicar" "$TMP/v.txt"

echo "monitor: servicos e containers"
cenario_bom
echo inactive >"$EST/svc-caddy"
echo exited >"$EST/c-dgclaw-ana"
verificar
afirma "servico parado" grep -q "O servico caddy nao esta de pe" "$TMP/v.txt"
afirma "container parado, com o comando para ligar" grep -q "container do agente ana esta exited.*dgclaw agente iniciar ana" "$TMP/v.txt"
rm "$EST/c-dgclaw-ana"
verificar
afirma "container que nao existe" grep -q "container do agente ana esta ausente" "$TMP/v.txt"

echo "monitor: backup e teste de restauracao"
cenario_bom
printf '{"ok":true,"quando":"%s","snapshot":"s1","erro":null}\n' "$(iso $((AGORA - 27 * 3600)))" >"$LIB/backup/ultimo-backup.json"
verificar
afirma "backup com 27 h" grep -q "O ultimo backup tem 27 hora(s) (o limite e 26)" "$TMP/v.txt"
printf '{"ok":true,"quando":"%s","snapshot":"s1","erro":null}\n' "$(iso $((AGORA - 26 * 3600)))" >"$LIB/backup/ultimo-backup.json"
verificar
igual "backup com 26 h esta no limite e passa" 0 "$?"
printf '{"ok":false,"quando":"%s","snapshot":null,"erro":"disco cheio no destino"}\n' "$(iso $((AGORA - 3600)))" >"$LIB/backup/ultimo-backup.json"
verificar
afirma "backup que falhou mostra o erro" grep -q "backup falhou em .*: disco cheio no destino" "$TMP/v.txt"
rm "$LIB/backup/ultimo-backup.json"
verificar
afirma "backup sem registro" grep -q "Nao ha registro de backup" "$TMP/v.txt"
printf 'isto nao e json' >"$LIB/backup/ultimo-backup.json"
verificar
afirma "backup com registro ilegivel" grep -q "nao e um JSON valido" "$TMP/v.txt"
cenario_bom
printf '{"ok":true,"quando":"%s","snapshot":"s1","erro":null}\n' "$(iso $((AGORA - 36 * 86400)))" >"$LIB/backup/ultimo-teste.json"
verificar
afirma "teste de restauracao com 36 dias" grep -q "O ultimo teste de restauracao tem 864 hora(s) (o limite e 840)" "$TMP/v.txt"
printf 'MONITOR_TESTE_MAX_DIAS=60\n' >>"$ALERTAS"
verificar
igual "MONITOR_TESTE_MAX_DIAS=60 aceita" 0 "$?"
cenario_bom
printf '{"ok":false,"quando":"%s","snapshot":null,"erro":"restic: wrong password"}\n' "$(iso $((AGORA - 3600)))" >"$LIB/backup/ultimo-teste.json"
verificar
afirma "teste que falhou mostra o erro" grep -q "teste de restauracao falhou.*restic: wrong password" "$TMP/v.txt"
rm -f "$LIB/backup/ultimo-teste.json" "$LIB/backup/ultimo-backup.json"
nivel_na_raiz pessoal
verificar
igual "nivel pessoal (backup desligado): nao cobra backup" 0 "$?"
nivel_na_raiz empresa

echo "monitor: memoria"
cenario_bom
printf 'MemTotal:        8000000 kB\nMemAvailable:     400000 kB\n' >"$R_/proc/meminfo"
verificar
afirma "5% de memoria livre" grep -q "Restam so 5% de memoria livre" "$TMP/v.txt"
rm "$R_/proc/meminfo"
verificar
afirma "sem /proc/meminfo diz que nao leu" grep -q "Nao consegui ler a memoria livre" "$TMP/v.txt"

echo "monitor: falha no envio nao esconde o alerta nem vaza segredo"
cenario_bom
printf 'raiz 90 /\n' >"$EST/df"
touch "$EST/curl-falha" "$EST/curl-eco"
verificar
igual "sai com 1" 1 "$?"
afirma "avisa que o canal nao entregou" grep -q "alerta por webhook nao saiu" "$TMP/v.txt"
afirma "e que tenta de novo" grep -q "tento de novo" "$TMP/v.txt"
nega "a saida nao tem a URL do webhook" grep -q "$WEBHOOK_SEGREDO" "$TMP/v.txt"
nega "nem o segredo do bot" grep -q "ABCbotsegredo" "$TMP/v.txt"
afirma "estado nao marca como enviado" jq -e '."disco:/".ultimo_envio == 0' "$MON/estado.json"
rm "$EST/curl-falha" "$EST/curl-eco"; : >"$EST/curl-cfgs.log"
avancar 300
verificar
igual "na proxima rodada o alerta sai" 1 "$(cfgs 'hooks.exemplo.org')"

echo "monitor: sem canal configurado"
cenario_bom
printf 'raiz 90 /\n' >"$EST/df"
rm "$ALERTAS"
verificar
igual "ainda sai com 1" 1 "$?"
afirma "avisa para configurar" grep -q "nenhum canal esta configurado.*dgclaw monitor configurar" "$TMP/v.txt"
afirma "o resultado fica registrado" jq -e '.ok == false' "$MON/ultimo.json"

echo "monitor: ensaio"
cenario_bom
printf 'raiz 90 /\n' >"$EST/df"
dgclaw --ensaio monitor verificar >"$TMP/v.txt" 2>&1
igual "ensaio sai com 0" 0 "$?"
nega "ensaio nao grava estado" test -e "$MON"
igual "ensaio nao chama o curl" 0 "$(chamadas '^curl')"
afirma "ensaio lista o problema" grep -q "90% cheio" "$TMP/v.txt"

echo "monitor: alertas.env frouxo"
cenario_bom
chmod 644 "$ALERTAS"
verificar
afirma "avisa para fechar a permissao" grep -q "chmod 600" "$TMP/v.txt"

echo "monitor configurar"
rm -f "$ALERTAS"
printf 'https://hooks.exemplo.org/novo\n123456:ABC-def\n-100999\nhttps://ping.exemplo.org/abc\n' | dgclaw monitor configurar >"$TMP/c.txt" 2>&1
igual "configurar: sai com 0" 0 "$?"
igual "arquivo 600" 600 "$(stat -c %a "$ALERTAS")"
igual "quatro chaves" "ALERTA_PING_URL ALERTA_TELEGRAM_CHAT ALERTA_TELEGRAM_TOKEN ALERTA_WEBHOOK_URL" "$(grep -oE '^ALERTA_[A-Z_]+' "$ALERTAS" | sort | paste -sd' ')"
nega "a saida nao mostra o segredo do bot" grep -q "ABC-def" "$TMP/c.txt"
nega "nem a URL" grep -q "hooks.exemplo.org/novo" "$TMP/c.txt"
echo 'MONITOR_TESTE_MAX_DIAS=10' >>"$ALERTAS"
printf '\n\n\n-\n' | dgclaw monitor configurar >"$TMP/c.txt" 2>&1
afirma "Enter mantem o valor atual" grep -q 'ALERTA_WEBHOOK_URL=https://hooks.exemplo.org/novo' "$ALERTAS"
nega "- apaga o ping" grep -q 'ALERTA_PING_URL' "$ALERTAS"
afirma "mantem as outras linhas do arquivo" grep -q 'MONITOR_TESTE_MAX_DIAS=10' "$ALERTAS"
printf 'isto-nao-e-url\n' | dgclaw monitor configurar >"$TMP/c.txt" 2>&1
nega "URL invalida e recusada" test "$?" -eq 0
afirma "a recusa explica" grep -q "nao tem o formato esperado" "$TMP/c.txt"
afirma "o arquivo nao foi estragado pela recusa" grep -q 'ALERTA_WEBHOOK_URL=https://hooks.exemplo.org/novo' "$ALERTAS"
rm -f "$ALERTAS"
printf '\n123456:ABC-def\n\n\n' | dgclaw monitor configurar >"$TMP/c.txt" 2>&1
nega "bot sem chat e recusado" test "$?" -eq 0
afirma "diz que falta o chat" grep -q "falta o chat" "$TMP/c.txt"
nega "nada foi gravado" test -e "$ALERTAS"
afirma "auditou a configuracao sem os valores" bash -c "dgclaw() { '$CLI' \"\$@\"; }; printf 'https://x.exemplo.org/a\n\n\n\n' | dgclaw monitor configurar >/dev/null 2>&1; jq -e 'select(.evento==\"monitor_configurado\") | .dados.webhook == true' '$R_/var/log/dgclaw/auditoria.jsonl' >/dev/null && ! grep -q 'x.exemplo.org' '$R_/var/log/dgclaw/auditoria.jsonl'"

echo "monitor testar"
cenario_bom
dgclaw monitor testar >"$TMP/t.txt" 2>&1
igual "testar: sai com 0" 0 "$?"
afirma "webhook testado" grep -q "webhook: mensagem de teste enviada" "$TMP/t.txt"
afirma "telegram testado" grep -q "telegram: mensagem de teste enviada" "$TMP/t.txt"
afirma "ping testado" grep -q "ping externo: ok" "$TMP/t.txt"
afirma "o texto de teste foi enviado" grep -q "Teste de alerta do DG Claw" "$EST/curl-cfgs.log"
touch "$EST/curl-falha" "$EST/curl-eco"
dgclaw monitor testar >"$TMP/t.txt" 2>&1
nega "canal que falha: sai com erro" test "$?" -eq 0
afirma "diz qual canal falhou" grep -q "webhook: FALHOU" "$TMP/t.txt"
nega "sem vazar a URL" grep -q "$WEBHOOK_SEGREDO" "$TMP/t.txt"
nega "sem vazar o bot" grep -q "ABCbotsegredo" "$TMP/t.txt"
rm "$EST/curl-falha" "$EST/curl-eco"
rm "$ALERTAS"
dgclaw monitor testar >"$TMP/t.txt" 2>&1
nega "sem canal: erro" test "$?" -eq 0
afirma "e diz como configurar" grep -q "dgclaw monitor configurar" "$TMP/t.txt"

echo "monitor: status"
cenario_bom
verificar
dgclaw status >"$TMP/s.txt" 2>&1
afirma "status mostra o monitor" grep -q "monitor: tudo certo (verificado ha 0 min)" "$TMP/s.txt"
printf 'raiz 90 /\n' >"$EST/df"
verificar
dgclaw status >"$TMP/s.txt" 2>&1
afirma "status mostra o alerta aberto" grep -q "monitor: 1 alerta(s) aberto(s): O disco em / esta 90%" "$TMP/s.txt"
avancar 1200
dgclaw status >"$TMP/s.txt" 2>&1
afirma "resultado velho (20 min) e apontado" grep -q "monitor: o ultimo resultado tem 20 minutos" "$TMP/s.txt"
rm -rf "$MON"
dgclaw status >"$TMP/s.txt" 2>&1
afirma "monitor que nunca rodou" grep -q "monitor: ainda nao rodou" "$TMP/s.txt"

echo "monitor: timer (instalar e aplicar)"
UNID="$R_/etc/systemd/system"
cenario_bom
rm -f "$ALERTAS"; : >"$STUB_LOG"
lib ent_instalar_monitor >"$TMP/i.txt" 2>&1
afirma "timer a cada 5 minutos" grep -q "OnUnitActiveSec=5min" "$UNID/dgclaw-monitor.timer"
afirma "servico roda monitor verificar" grep -q "ExecStart=/usr/local/bin/dgclaw monitor verificar" "$UNID/dgclaw-monitor.service"
afirma "habilitou o timer" grep -q "systemctl enable --now dgclaw-monitor.timer" "$STUB_LOG"
afirma "sem alertas.env avisa como configurar" grep -q "dgclaw monitor configurar" "$TMP/i.txt"
igual "pasta de estado 700" 700 "$(stat -c %a "$MON")"
nivel_na_raiz pessoal
lib ent_aplicar_monitor >"$TMP/i.txt" 2>&1
nega "nivel pessoal: aplicar remove o timer" test -e "$UNID/dgclaw-monitor.timer"
rm -rf "$UNID"
lib ent_aplicar_monitor >"$TMP/i.txt" 2>&1
nega "nivel pessoal: nao cria nada" test -e "$UNID/dgclaw-monitor.timer"
igual "nivel pessoal: gancho de status nao imprime" "" "$(dgclaw status 2>&1 | grep -c 'monitor:' | sed 's/^0$//')"

fim
