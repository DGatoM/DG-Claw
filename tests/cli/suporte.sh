#!/usr/bin/env bash
# `dgclaw suporte ligar|desligar|status|limpar` e a linha "suporte:" do `dgclaw status`.
# Raiz falsa (DGCLAW_RAIZ) e o relogio fixo por DGCLAW_AGORA_MS: o authorized_keys de verdade nunca e tocado.
# As chaves sao geradas aqui com o ssh-keygen real; o `ssh -V` e o stub de tests/cli/stubs.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
command -v ssh-keygen >/dev/null || { echo "falta o ssh-keygen no PATH (pacote openssh-client)" >&2; exit 1; }

AGORA_S="$(date -u -d '2026-11-01 12:00:00' +%s)"
export DGCLAW_AGORA_MS=$((AGORA_S * 1000))
ARQ="$DGCLAW_RAIZ/root/.ssh/authorized_keys"
LOG="$DGCLAW_RAIZ/var/log/dgclaw/suporte.log"

gerar() { # gerar <nome> <tipo> [bits]: grava $TMP/<nome>.pub
    ssh-keygen -q -t "$2" ${3:+-b "$3"} -N '' -C "comentario-$1" -f "$TMP/$1" >/dev/null
}
gerar suporte ed25519
gerar outra ed25519
gerar rsa2048 rsa 2048
gerar rsa3072 rsa 3072
CHAVE="$(cat "$TMP/suporte.pub")"
OUTRA="$(cat "$TMP/outra.pub")"
BLOB="$(awk '{print $2}' "$TMP/suporte.pub")"
ALHEIA1='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlheiaDaMartaNaoMexer marta@notebook'
ALHEIA2='from="10.0.0.1" ssh-rsa AAAAB3NzaC1yc2EAAAAlheiaDoBackup backup'
mkdir -p "$(dirname "$ARQ")"
printf '%s\n%s\n' "$ALHEIA1" "$ALHEIA2" >"$ARQ"
chmod 600 "$ARQ"

echo "--ligar grava com prazo e marcador"
FIM_ESPERADO="$(date -u -d "@$((AGORA_S + 7 * 86400))" +%Y%m%d%H%M)"
dgclaw suporte ligar --chave "$CHAVE" >"$TMP/o.txt" 2>&1; rc=$?
igual "ligar sai 0" 0 "$rc"
afirma "linha com expiry-time de 7 dias (padrao)" grep -qF "expiry-time=\"${FIM_ESPERADO}Z\" ssh-ed25519 $BLOB dgclaw-suporte:" "$ARQ"
afirma "marcador com a data fim" grep -qE "dgclaw-suporte:[0-9a-f]{8}:${FIM_ESPERADO}\$" "$ARQ"
nega "o comentario da chave nao vai para o arquivo" grep -q "comentario-suporte" "$ARQ"
igual "arquivo 600" 600 "$(stat -c %a "$ARQ")"
igual "pasta .ssh 700" 700 "$(stat -c %a "$(dirname "$ARQ")")"
afirma "linha alheia 1 preservada" grep -qxF "$ALHEIA1" "$ARQ"
afirma "linha alheia 2 preservada" grep -qxF "$ALHEIA2" "$ARQ"
igual "tres linhas" 3 "$(wc -l <"$ARQ")"
afirma "o ligar diz ate quando vale" grep -q "ate 08/11/2026 12:00 UTC" "$TMP/o.txt"

echo "--registro no suporte.log, sem a chave inteira"
afirma "log tem o ligar" grep -q " ligar " "$LOG"
afirma "log tem o fingerprint" grep -q "fp=SHA256:" "$LOG"
nega "log nao tem o corpo da chave" grep -qF "$BLOB" "$LOG"
igual "log 600" 600 "$(stat -c %a "$LOG")"

echo "--ligar de novo nao duplica"
dgclaw suporte ligar --chave "$CHAVE" --dias 3 >"$TMP/o.txt" 2>&1; rc=$?
igual "ligar repetido sai 0" 0 "$rc"
igual "continua uma so linha do suporte" 1 "$(grep -c "dgclaw-suporte:" "$ARQ")"
igual "continuam tres linhas" 3 "$(wc -l <"$ARQ")"
FIM3="$(date -u -d "@$((AGORA_S + 3 * 86400))" +%Y%m%d%H%M)"
afirma "o prazo foi renovado para 3 dias" grep -qE "dgclaw-suporte:[0-9a-f]{8}:${FIM3}\$" "$ARQ"
afirma "o log marca a renovacao" grep -q "renovada=sim" "$LOG"

echo "--chave invalida e prazo"
for ruim in "" "ssh-ed25519" "ssh-ed25519 !!!nao-e-base64" "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsemsentido" "ssh-dss AAAAB3NzaC1kc3MAAACB" 'command="rm -rf /" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlheia'; do
    : >"$TMP/o.txt"
    dgclaw suporte ligar --chave "$ruim" >"$TMP/o.txt" 2>&1; rc=$?
    igual "chave '${ruim:0:30}' recusada" 1 "$rc"
done
afirma "a recusa explica o que fazer" grep -q "O que fazer" "$TMP/o.txt"
nega "RSA de 2048 bits recusada" dgclaw suporte ligar --chave "$(cat "$TMP/rsa2048.pub")"
afirma "RSA de 3072 bits aceita" dgclaw suporte ligar --chave "$(cat "$TMP/rsa3072.pub")"
nega "mais de uma linha recusada" dgclaw suporte ligar --chave "$CHAVE"$'\n'"$OUTRA"
nega "dias 31 recusado" dgclaw suporte ligar --chave "$OUTRA" --dias 31
nega "dias 0 recusado" dgclaw suporte ligar --chave "$OUTRA" --dias 0
nega "dias nao numerico recusado" dgclaw suporte ligar --chave "$OUTRA" --dias sete
nega "sem --chave recusado" dgclaw suporte ligar --dias 7
afirma "dias 30 aceito" dgclaw suporte ligar --chave "$OUTRA" --dias 30
dgclaw suporte ligar --chave "$OUTRA" --dias 31 >"$TMP/o.txt" 2>&1
afirma "a recusa de dias diz o maximo" grep -q "de 1 a 30" "$TMP/o.txt"

echo "--sshd antigo demais"
STUB_SSH_VERSAO=8.1p1 dgclaw suporte ligar --chave "$(cat "$TMP/rsa3072.pub")" >"$TMP/o.txt" 2>&1; rc=$?
igual "OpenSSH 8.1 recusa" 1 "$rc"
afirma "explica o 8.2" grep -q "8.2" "$TMP/o.txt"
STUB_SSH_VERSAO=8.2p1 dgclaw suporte ligar --chave "$(cat "$TMP/rsa3072.pub")" >/dev/null 2>&1; rc=$?
igual "OpenSSH 8.2 aceita" 0 "$rc"

echo "--chave igual a uma permanente nao e tocada"
printf '%s\n' "ssh-ed25519 $(awk '{print $2}' "$TMP/outra.pub") permanente" >>"$ARQ"
sed -i '/dgclaw-suporte:/d' "$ARQ"
dgclaw suporte ligar --chave "$OUTRA" >"$TMP/o.txt" 2>&1; rc=$?
igual "recusa chave que ja e permanente" 1 "$rc"
afirma "linha permanente intacta" grep -qxF "ssh-ed25519 $(awk '{print $2}' "$TMP/outra.pub") permanente" "$ARQ"

echo "--status"
: >"$ARQ"; printf '%s\n' "$ALHEIA1" >"$ARQ"
dgclaw suporte status >"$TMP/o.txt" 2>&1; rc=$?
igual "status sem chave sai 0" 0 "$rc"
afirma "diz desligado" grep -qx "suporte: desligado" "$TMP/o.txt"
dgclaw suporte ligar --chave "$CHAVE" --dias 5 >/dev/null 2>&1
dgclaw suporte status >"$TMP/o.txt" 2>&1
afirma "lista a chave ligada com a data" grep -q "ligada .*vale ate 06/11/2026 12:00 UTC" "$TMP/o.txt"
# Uma linha vencida (prazo no passado) escrita na mao no formato do ligar.
VENCIDA_FIM="$(date -u -d "@$((AGORA_S - 86400))" +%Y%m%d%H%M)"
printf 'expiry-time="%sZ" ssh-ed25519 %s dgclaw-suporte:deadbeef:%s\n' "$VENCIDA_FIM" "$(awk '{print $2}' "$TMP/outra.pub")" "$VENCIDA_FIM" >>"$ARQ"
dgclaw suporte status >"$TMP/o.txt" 2>&1
afirma "lista a vencida" grep -q "vencida .*venceu em 31/10/2026 12:00 UTC" "$TMP/o.txt"
afirma "oferece remover" grep -q "dgclaw suporte limpar" "$TMP/o.txt"

echo "--limpar tira so as vencidas"
dgclaw suporte limpar >"$TMP/o.txt" 2>&1; rc=$?
igual "limpar sai 0" 0 "$rc"
afirma "diz quantas removeu" grep -q "1 chave(s) vencida(s)" "$TMP/o.txt"
nega "a vencida saiu" grep -q "deadbeef" "$ARQ"
afirma "a vigente ficou" grep -qF "$BLOB" "$ARQ"
afirma "a alheia ficou" grep -qxF "$ALHEIA1" "$ARQ"
afirma "o log marca o limpar" grep -qE " limpar por=[a-z]+ fp=" "$LOG"
dgclaw suporte limpar >"$TMP/o.txt" 2>&1
afirma "limpar de novo nao acha nada" grep -q "0 chave(s)" "$TMP/o.txt"

echo "--dgclaw status tem a linha do suporte"
printf 'expiry-time="%sZ" ssh-ed25519 %s dgclaw-suporte:deadbeef:%s\n' "$VENCIDA_FIM" "$(awk '{print $2}' "$TMP/outra.pub")" "$VENCIDA_FIM" >>"$ARQ"
saida="$(bash -c '
    . "$1"; . "$2/lib/suporte.sh"
    s_ok() { printf "ok %s\n" "$1"; }; s_aviso() { printf "aviso %s\n" "$1"; }
    suporte_status_linha' _ "$REPO/lib/comum.sh" "$REPO" 2>&1)"
afirma "ligado ate 06/11/2026" grep -q "suporte: ligado ate 06/11/2026 12:00 UTC" <<<"$saida"

echo "--desligar remove so as nossas"
printf '%s\n' "$ALHEIA2" >>"$ARQ"
dgclaw suporte desligar >"$TMP/o.txt" 2>&1; rc=$?
igual "desligar sai 0" 0 "$rc"
afirma "diz quantas removeu (duas: a vigente e a vencida)" grep -q "2 chave(s) removida(s)" "$TMP/o.txt"
nega "nenhum marcador sobrou" grep -q "dgclaw-suporte:" "$ARQ"
afirma "linha alheia 1 sobreviveu" grep -qxF "$ALHEIA1" "$ARQ"
afirma "linha alheia 2 sobreviveu" grep -qxF "$ALHEIA2" "$ARQ"
igual "arquivo ainda 600" 600 "$(stat -c %a "$ARQ")"
dgclaw suporte desligar >"$TMP/o.txt" 2>&1; rc=$?
igual "desligar de novo sai 0" 0 "$rc"
afirma "diz que ja estava desligado" grep -q "ja estava desligado" "$TMP/o.txt"
dgclaw suporte status >"$TMP/o.txt" 2>&1
afirma "status volta a desligado" grep -qx "suporte: desligado" "$TMP/o.txt"
afirma "o log marca o desligar" grep -qE " desligar por=[a-z]+ fp=" "$LOG"

echo "--arquivo sem newline final e subcomando desconhecido"
printf '%s' "$ALHEIA1" >"$ARQ"
dgclaw suporte ligar --chave "$CHAVE" >/dev/null 2>&1
afirma "a ultima linha alheia sem newline foi mantida inteira" grep -qxF "$ALHEIA1" "$ARQ"
nega "subcomando que nao existe" dgclaw suporte abrir
nega "sem subcomando" dgclaw suporte

echo "--dias gigante nao estoura a aritmetica"
nega "dias 18446744073709555266 recusado" dgclaw suporte ligar --chave "$OUTRA" --dias 18446744073709555266
nega "dias 007 recusado" dgclaw suporte ligar --chave "$OUTRA" --dias 007
nega "dias -3 recusado" dgclaw suporte ligar --chave "$OUTRA" --dias -3

echo "--sessoes de root abertas: o desligar lista, nao adivinha e so derruba com --derrubar-sessoes"
# "sshd" de mentira: um cat com o nome sshd e o titulo do processo trocado (exec -a). O cmdline fica so com o titulo,
# como no sshd de verdade; ele espera num FIFO que o proprio teste mantem aberto.
cp "$(command -v cat)" "$TMP/sshd"; mkfifo "$TMP/espera"; exec 8<>"$TMP/espera"
fantasma() { bash -c 'exec -a "$1" "$0" <"$2"' "$TMP/sshd" "$1" "$TMP/espera" & }
fantasma "sshd: root@pts/0"; PID_A=$!
fantasma "sshd: root@pts/1"; PID_B=$!
fantasma "sshd: marta [priv]"; PID_C=$!
sleep 0.3
printf 'ESTAB 0 0 10.0.0.5:22 203.0.113.9:50022 users:(("sshd",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 198.51.100.7:41000 users:(("sshd",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 192.0.2.44:33000 users:(("sshd",pid=%s,fd=4))\n' "$PID_A" "$PID_B" "$PID_C" >"$STUB_ESTADO/ss-conexoes"
printf '%s\n' "$ALHEIA1" >"$ARQ"
dgclaw suporte ligar --chave "$CHAVE" >/dev/null 2>&1
SSH_CONNECTION="203.0.113.9 50022 10.0.0.5 22" dgclaw suporte desligar >"$TMP/o.txt" 2>&1; rc=$?
igual "desligar com outra sessao aberta sai 0" 0 "$rc"
afirma "lista a sessao propria e marca" grep -q "203.0.113.9:50022, desde .*<- e a SUA sessao" "$TMP/o.txt"
afirma "lista a outra sessao" grep -q "198.51.100.7:41000, desde" "$TMP/o.txt"
nega "nao lista sessao de usuario comum" grep -q "192.0.2.44" "$TMP/o.txt"
afirma "diz que ainda ha 1 sessao de root aberta" grep -q "ainda ha 1 sessao(oes) de root aberta(s)" "$TMP/o.txt"
afirma "diz que o acesso NAO esta totalmente desligado" grep -q "NAO esta totalmente desligado" "$TMP/o.txt"
nega "nunca diz acesso do suporte desligado com sessao aberta" grep -q "acesso do suporte desligado" "$TMP/o.txt"
afirma "ensina o --derrubar-sessoes" grep -q "suporte desligar --derrubar-sessoes" "$TMP/o.txt"
nega "a chave saiu do arquivo" grep -q "dgclaw-suporte:" "$ARQ"
afirma "nada foi derrubado sem pedir (A)" kill -0 "$PID_A"
afirma "nada foi derrubado sem pedir (B)" kill -0 "$PID_B"

echo "--derrubar-sessoes encerra as outras e poupa a de quem pede"
SSH_CONNECTION="203.0.113.9 50022 10.0.0.5 22" dgclaw suporte desligar --derrubar-sessoes >"$TMP/o.txt" 2>&1; rc=$?
igual "derrubar sai 0" 0 "$rc"
afirma "diz que encerrou 1" grep -q "1 sessao(oes) SSH de root encerrada(s). A sua nao foi tocada" "$TMP/o.txt"
sleep 1.5
nega "a outra sessao morreu" kill -0 "$PID_B"
afirma "a sessao propria continua" kill -0 "$PID_A"
afirma "a sessao do usuario comum continua" kill -0 "$PID_C"
afirma "sem outra sessao, diz que o acesso ja estava desligado" grep -q "ja estava desligado" "$TMP/o.txt"

echo "--derrubar-sessoes sem saber qual e a sua (em SSH) recusa"
fantasma "sshd: root@pts/2"; PID_D=$!
sleep 0.3
printf 'ESTAB 0 0 10.0.0.5:22 203.0.113.9:50022 users:(("sshd",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 198.51.100.8:42000 users:(("sshd",pid=%s,fd=4))\n' "$PID_A" "$PID_D" >"$STUB_ESTADO/ss-conexoes"
SSH_CONNECTION="192.0.2.1 1 10.0.0.5 22" dgclaw suporte desligar --derrubar-sessoes >"$TMP/o.txt" 2>&1; rc=$?
igual "recusa quando nao acha a propria sessao" 1 "$rc"
afirma "explica o porque" grep -q "nao consegui dizer qual das sessoes de root abertas e a sua" "$TMP/o.txt"
afirma "nao derrubou ninguem (A)" kill -0 "$PID_A"
afirma "nao derrubou ninguem (D)" kill -0 "$PID_D"
nega "opcao desconhecida no desligar" dgclaw suporte desligar --tudo

echo "--sem nenhuma sessao: desligado de verdade"
rm -f "$STUB_ESTADO/ss-conexoes"
dgclaw suporte ligar --chave "$CHAVE" >/dev/null 2>&1
dgclaw suporte desligar >"$TMP/o.txt" 2>&1
afirma "diz nenhuma sessao" grep -q "sessoes SSH de root abertas agora: nenhuma" "$TMP/o.txt"
afirma "diz acesso do suporte desligado" grep -q "acesso do suporte desligado: nenhuma chave dele no arquivo e nenhuma outra sessao" "$TMP/o.txt"

echo "--limpar com chave vencida grava revogadas.log e alerta se ha sessao aberta"
printf 'ESTAB 0 0 10.0.0.5:22 198.51.100.8:42000 users:(("sshd",pid=%s,fd=4))\n' "$PID_D" >"$STUB_ESTADO/ss-conexoes"
printf 'expiry-time="%sZ" ssh-ed25519 %s dgclaw-suporte:deadbeef:%s\n' "$VENCIDA_FIM" "$(awk '{print $2}' "$TMP/outra.pub")" "$VENCIDA_FIM" >>"$ARQ"
dgclaw suporte limpar >"$TMP/o.txt" 2>&1
REV="$DGCLAW_RAIZ/var/lib/dgclaw/suporte/revogadas.log"
afirma "revogadas.log tem a chave" grep -q "revogada fp=" "$REV"
afirma "revogadas.log registra a sessao aberta" grep -q "ha 1 sessao(oes) de root aberta(s)" "$REV"
igual "revogadas.log 600" 600 "$(stat -c %a "$REV")"
igual "pasta suporte 700" 700 "$(stat -c %a "$(dirname "$REV")")"
saida="$(bash -c '
    . "$1"; . "$2/lib/suporte.sh"
    s_ok() { printf "ok %s\n" "$1"; }; s_aviso() { printf "aviso %s\n" "$1"; }
    suporte_status_linha' _ "$REPO/lib/comum.sh" "$REPO" 2>&1)"
afirma "dgclaw status avisa da sessao aberta" grep -q "suporte: chave revogada ou vencida, acesso ainda nao confirmado como encerrado (1 sessao(oes) de root abertas), veja sudo dgclaw suporte status" <<<"$saida"
dgclaw suporte status >"$TMP/o.txt" 2>&1
afirma "suporte status lista a sessao" grep -q "198.51.100.8:42000, desde" "$TMP/o.txt"
kill "$PID_A" "$PID_C" "$PID_D" 2>/dev/null; wait 2>/dev/null


echo "--usuario exato root: rootbackup e root2 nao contam"
fantasma "sshd: rootbackup@pts/1"; P1=$!
fantasma "sshd: root2 [priv]"; P2=$!
fantasma "sshd: root [priv]"; P3=$!
fantasma "sshd: root@notty"; P4=$!
sleep 0.3
printf 'ESTAB 0 0 10.0.0.5:22 192.0.2.1:1001 users:(("sshd",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 192.0.2.2:1002 users:(("sshd",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 192.0.2.3:1003 users:(("sshd",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 192.0.2.4:1004 users:(("sshd",pid=%s,fd=4))\n' "$P1" "$P2" "$P3" "$P4" >"$STUB_ESTADO/ss-conexoes"
dgclaw suporte status >"$TMP/o.txt" 2>&1
nega "rootbackup nao e listado" grep -q "192.0.2.1:1001" "$TMP/o.txt"
nega "root2 nao e listado" grep -q "192.0.2.2:1002" "$TMP/o.txt"
afirma "'sshd: root [priv]' e listado" grep -q "192.0.2.3:1003" "$TMP/o.txt"
afirma "'sshd: root@notty' e listado" grep -q "192.0.2.4:1004" "$TMP/o.txt"

echo "--ensaio nao tem efeito nenhum"
printf '%s\n' "$ALHEIA1" >"$ARQ"; dgclaw suporte ligar --chave "$CHAVE" >/dev/null 2>&1
rm -f "$DGCLAW_RAIZ/root/.ssh/.dgclaw-suporte.lock" "$DGCLAW_RAIZ/var/lib/dgclaw/suporte/alerta-sessoes"
ANTES="$(sha256sum <"$ARQ")"; LOG_ANTES="$(wc -c <"$LOG")"
dgclaw --ensaio suporte desligar --derrubar-sessoes >"$TMP/o.txt" 2>&1; rc=$?
igual "ensaio sai 0" 0 "$rc"
afirma "descreve o que encerraria" grep -q "\[ensaio\] encerraria a sessao de 192.0.2.3:1003" "$TMP/o.txt"
afirma "sshd P3 continua vivo" kill -0 "$P3"
afirma "sshd P4 continua vivo" kill -0 "$P4"
igual "authorized_keys intacto" "$ANTES" "$(sha256sum <"$ARQ")"
nega "nao criou a trava em .ssh" test -e "$DGCLAW_RAIZ/root/.ssh/.dgclaw-suporte.lock"
nega "nao gravou a marca de alerta" test -e "$DGCLAW_RAIZ/var/lib/dgclaw/suporte/alerta-sessoes"
igual "nao escreveu no suporte.log" "$LOG_ANTES" "$(wc -c <"$LOG")"
dgclaw --ensaio suporte limpar >/dev/null 2>&1; dgclaw --ensaio suporte ligar --chave "$OUTRA" >/dev/null 2>&1
nega "ensaio nao criou a trava (limpar/ligar)" test -e "$DGCLAW_RAIZ/root/.ssh/.dgclaw-suporte.lock"

echo "--pendencia: desligar sem derrubar deixa a marca e o status so diz desligado depois de confirmar"
dgclaw suporte desligar >"$TMP/o.txt" 2>&1
afirma "a marca de pendencia foi gravada" test -e "$DGCLAW_RAIZ/var/lib/dgclaw/suporte/alerta-sessoes"
linha_status() { bash -c '
    . "$1"; . "$2/lib/suporte.sh"
    s_ok() { printf "ok %s\n" "$1"; }; s_aviso() { printf "aviso %s\n" "$1"; }
    suporte_status_linha' _ "$REPO/lib/comum.sh" "$REPO" 2>&1; }
afirma "com sessao aberta o status nao diz desligado" grep -q "suporte: chave revogada ou vencida, acesso ainda nao confirmado como encerrado (2 sessao(oes) de root abertas)" <<<"$(linha_status)"
nega "e nao diz 'ok suporte: desligado'" grep -q "^ok suporte: desligado" <<<"$(linha_status)"
kill "$P3" "$P4" 2>/dev/null; sleep 0.3; : >"$STUB_ESTADO/ss-conexoes"
afirma "sem sessao, o status confirma e diz desligado" grep -q "^ok suporte: desligado" <<<"$(linha_status)"
nega "e a pendencia acabou" test -e "$DGCLAW_RAIZ/var/lib/dgclaw/suporte/alerta-sessoes"
kill "$P1" "$P2" 2>/dev/null; wait 2>/dev/null


echo "--falha ao consultar as sessoes NUNCA vira 'nenhuma sessao'"
ALERTA="$DGCLAW_RAIZ/var/lib/dgclaw/suporte/alerta-sessoes"
rm -f "$ALERTA" "$STUB_ESTADO/ss-conexoes"
printf '%s\n' "$ALHEIA1" >"$ARQ"; dgclaw suporte ligar --chave "$CHAVE" >/dev/null 2>&1
STUB_SS_FALHA=1 dgclaw suporte desligar >"$TMP/o.txt" 2>&1; rc=$?
igual "ss com erro: desligar sai com codigo 1" 1 "$rc"
afirma "diz que nao conseguiu verificar" grep -q "nao consegui verificar as sessoes de root abertas (o ss saiu com codigo 1)" "$TMP/o.txt"
nega "nao anuncia acesso desligado" grep -q "acesso do suporte desligado\|ja estava desligado" "$TMP/o.txt"
afirma "gravou a pendencia" test -e "$ALERTA"
rm -f "$ALERTA"
STUB_SS_FALHA=1 dgclaw suporte desligar --derrubar-sessoes >"$TMP/o.txt" 2>&1; rc=$?
igual "ss com erro: desligar --derrubar-sessoes sai com 1" 1 "$rc"
afirma "e grava a pendencia" test -e "$ALERTA"
rm -f "$ALERTA"
DGCLAW_SS=/nao/existe/ss dgclaw suporte desligar >"$TMP/o.txt" 2>&1; rc=$?
igual "ss ausente: desligar sai com 1" 1 "$rc"
afirma "diz que o ss nao esta instalado" grep -q "o programa ss nao esta instalado" "$TMP/o.txt"
afirma "ss ausente tambem grava a pendencia" test -e "$ALERTA"
STUB_SS_FALHA=1 dgclaw suporte status >"$TMP/o.txt" 2>&1; rc=$?
igual "ss com erro: status sai com 1" 1 "$rc"
afirma "status diz que nao consegue confirmar" grep -q "acesso ainda nao confirmado como encerrado (nao consegui verificar as sessoes de root" "$TMP/o.txt"
nega "status nao diz 'suporte: desligado'" grep -qx "suporte: desligado" "$TMP/o.txt"
linha_ss_erro="$(STUB_SS_FALHA=1 bash -c '. "$1"; . "$2/lib/suporte.sh"; s_ok() { echo "ok $1"; }; s_aviso() { echo "aviso $1"; }; suporte_status_linha' _ "$REPO/lib/comum.sh" "$REPO" 2>&1)"
afirma "dgclaw status avisa e nao diz desligado" grep -q "^aviso suporte: chave revogada ou vencida, acesso ainda nao confirmado como encerrado (nao consegui verificar as sessoes" <<<"$linha_ss_erro"
dgclaw suporte status >"$TMP/o.txt" 2>&1; rc=$?
igual "com o ss de volta, status sai 0" 0 "$rc"
nega "e a pendencia some" test -e "$ALERTA"

echo "--status consulta as sessoes antes de dizer o estado"
fantasma "sshd: root@pts/7"; PZ=$!
sleep 0.3
printf 'ESTAB 0 0 10.0.0.5:22 198.51.100.50:5050 users:(("sshd",pid=%s,fd=4))\n' "$PZ" >"$STUB_ESTADO/ss-conexoes"
rm -f "$ALERTA"; printf '%s\n' "$ALHEIA1" >"$ARQ"
dgclaw suporte ligar --chave "$CHAVE" >/dev/null 2>&1
dgclaw suporte desligar >/dev/null 2>&1
dgclaw suporte status >"$TMP/o.txt" 2>&1; rc=$?
afirma "removida sem derrubar, com sessao aberta: status nao confirma encerramento" grep -q "suporte: chave revogada ou vencida, acesso ainda nao confirmado como encerrado (1 sessao(oes) de root abertas)" "$TMP/o.txt"
nega "e nao diz 'suporte: desligado'" grep -qx "suporte: desligado" "$TMP/o.txt"
afirma "a linha do dgclaw status tambem" grep -q "acesso ainda nao confirmado como encerrado (1 sessao(oes) de root abertas)" <<<"$(linha_status)"
echo "--chave vencida antes do timer, com sessao aberta"
rm -f "$ALERTA"
printf '%s\n' "$ALHEIA1" >"$ARQ"
printf 'expiry-time="%sZ" ssh-ed25519 %s dgclaw-suporte:cafe0001:%s\n' "$VENCIDA_FIM" "$(awk '{print $2}' "$TMP/outra.pub")" "$VENCIDA_FIM" >>"$ARQ"
dgclaw suporte status >"$TMP/o.txt" 2>&1
afirma "status: vencida no arquivo + sessao aberta nao e desligado" grep -q "suporte: chave revogada ou vencida, acesso ainda nao confirmado como encerrado (1 sessao(oes) de root abertas)" "$TMP/o.txt"
afirma "dgclaw status: o mesmo" grep -q "acesso ainda nao confirmado como encerrado (1 sessao(oes) de root abertas)" <<<"$(linha_status)"
: >"$STUB_ESTADO/ss-conexoes"
afirma "sem sessao, a vencida no arquivo so pede o limpar" grep -q "desligado, mas 1 chave(s) vencida(s)" <<<"$(linha_status)"
STUB_SS_FALHA=1 dgclaw suporte status >"$TMP/o.txt" 2>&1
afirma "consulta que falha com vencida no arquivo tambem nao confirma" grep -q "acesso ainda nao confirmado como encerrado (nao consegui verificar" "$TMP/o.txt"
kill "$PZ" 2>/dev/null; wait 2>/dev/null

echo "--OpenSSH 9.8+: processo sshd-session"
cp "$(command -v cat)" "$TMP/sshd-session"
fantasma_s() { bash -c 'exec -a "$1" "$0" <"$2"' "$TMP/sshd-session" "$1" "$TMP/espera" & }
rm -f "$ALERTA"; printf '%s\n' "$ALHEIA1" >"$ARQ"
fantasma_s "sshd-session: root@pts/1"; S1=$!
fantasma_s "sshd-session: root [priv]"; S2=$!
fantasma_s "sshd-session: rootbackup@pts/2"; S3=$!
fantasma_s "sshd-session: marta [priv]"; S4=$!
sleep 0.3
printf 'ESTAB 0 0 10.0.0.5:22 203.0.113.1:2001 users:(("sshd-session",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 203.0.113.2:2002 users:(("sshd-session",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 203.0.113.3:2003 users:(("sshd-session",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 203.0.113.4:2004 users:(("sshd-session",pid=%s,fd=4))\n' "$S1" "$S2" "$S3" "$S4" >"$STUB_ESTADO/ss-conexoes"
dgclaw suporte status >"$TMP/o.txt" 2>&1
afirma "lista 'sshd-session: root@pts/1'" grep -q "203.0.113.1:2001" "$TMP/o.txt"
afirma "lista 'sshd-session: root [priv]'" grep -q "203.0.113.2:2002" "$TMP/o.txt"
nega "nao lista rootbackup" grep -q "203.0.113.3:2003" "$TMP/o.txt"
nega "nao lista outro usuario" grep -q "203.0.113.4:2004" "$TMP/o.txt"
SSH_CONNECTION="203.0.113.1 2001 10.0.0.5 22" dgclaw suporte desligar --derrubar-sessoes >"$TMP/o.txt" 2>&1; rc=$?
igual "derrubar com sshd-session sai 0" 0 "$rc"
sleep 1.5
nega "derrubou a outra sessao sshd-session" kill -0 "$S2"
afirma "poupou a propria" kill -0 "$S1"
afirma "nao tocou em outro usuario" kill -0 "$S4"
echo "--titulo de sshd em formato desconhecido: verificacao inconclusiva"
fantasma "sshd: !!estranho!!"; SX=$!
sleep 0.3
printf 'ESTAB 0 0 10.0.0.5:22 203.0.113.9:2009 users:(("sshd",pid=%s,fd=4))\n' "$SX" >"$STUB_ESTADO/ss-conexoes"
dgclaw suporte ligar --chave "$CHAVE" >/dev/null 2>&1
dgclaw suporte desligar >"$TMP/o.txt" 2>&1; rc=$?
igual "formato desconhecido: desligar sai 1" 1 "$rc"
afirma "diz que nao reconhece o titulo" grep -q "formato que nao reconheco" "$TMP/o.txt"
nega "nao anuncia desligado" grep -q "acesso do suporte desligado" "$TMP/o.txt"
afirma "grava a pendencia" test -e "$ALERTA"
dgclaw suporte status >"$TMP/o.txt" 2>&1; rc=$?
igual "e o status tambem sai 1" 1 "$rc"
kill "$S1" "$S3" "$S4" "$SX" 2>/dev/null; wait 2>/dev/null
rm -f "$STUB_ESTADO/ss-conexoes" "$ALERTA"

echo "--a mesma chave RSA em duas representacoes tem o mesmo fingerprint"
python3 -I - "$TMP/rsa3072.pub" "$TMP/rsa3072-alt.pub" <<'FIMPY'
import base64, struct, sys
t, b64 = open(sys.argv[1]).read().split()[:2]
blob = base64.b64decode(b64)
def le(b, o):
    n = struct.unpack('>I', b[o:o + 4])[0]
    return b[o + 4:o + 4 + n], o + 4 + n
def w(x): return struct.pack('>I', len(x)) + x
_, o = le(blob, 0); e, o = le(blob, o); n, o = le(blob, o)
open(sys.argv[2], 'w').write('ssh-rsa ' + base64.b64encode(w(b'ssh-rsa') + w(e) + w(b'\x00' + n)).decode() + '\n')
FIMPY
igual "as duas representacoes tem o mesmo fingerprint" "$(ssh-keygen -l -f "$TMP/rsa3072.pub" | awk '{print $2}')" "$(ssh-keygen -l -f "$TMP/rsa3072-alt.pub" | awk '{print $2}')"
nega "os textos base64 sao diferentes" test "$(awk '{print $2}' "$TMP/rsa3072.pub")" = "$(awk '{print $2}' "$TMP/rsa3072-alt.pub")"
printf '%s\n' "$ALHEIA1" "$(cat "$TMP/rsa3072.pub")" >"$ARQ"
dgclaw suporte ligar --chave "$(cat "$TMP/rsa3072-alt.pub")" >"$TMP/o.txt" 2>&1; rc=$?
igual "ligar com a outra representacao de uma chave permanente recusa" 1 "$rc"
afirma "diz que ja e acesso permanente" grep -q "como acesso permanente" "$TMP/o.txt"
igual "o arquivo nao ganhou linha nenhuma" 2 "$(wc -l <"$ARQ")"
printf '%s\n' "$ALHEIA1" >"$ARQ"
dgclaw suporte ligar --chave "$(cat "$TMP/rsa3072-alt.pub")" >/dev/null 2>&1
dgclaw suporte ligar --chave "$(cat "$TMP/rsa3072.pub")" --dias 2 >/dev/null 2>&1; rc=$?
igual "renovar pela outra representacao sai 0" 0 "$rc"
igual "continua uma so linha do suporte (renovou, nao duplicou)" 1 "$(grep -c "dgclaw-suporte:" "$ARQ")"

fim
