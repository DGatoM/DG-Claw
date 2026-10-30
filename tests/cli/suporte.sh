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

echo "--desligar encerra as sessoes SSH abertas com a chave"
printf '%s\n' "$ALHEIA1" >"$ARQ"
dgclaw suporte ligar --chave "$CHAVE" >/dev/null 2>&1
FP_SUP="$(ssh-keygen -l -f "$TMP/suporte.pub" | awk '{print $2}')"
cp "$(command -v sleep)" "$TMP/sshd"
"$TMP/sshd" 300 & PID_FALSO=$!
"$TMP/sshd" 300 & PID_OUTRA=$!
printf 'Oct 30 sshd[1]: Accepted publickey for root from 203.0.113.9 port 50022 ssh2: ED25519 %s\nAccepted publickey for root from 198.51.100.7 port 41000 ssh2: ED25519 SHA256:daoutrapessoa\n' "$FP_SUP" >"$TMP/journal.txt"
printf 'ESTAB 0 0 10.0.0.5:22 203.0.113.9:50022 users:(("sshd",pid=%s,fd=4))\nESTAB 0 0 10.0.0.5:22 198.51.100.7:41000 users:(("sshd",pid=%s,fd=4))\n' "$PID_FALSO" "$PID_OUTRA" >"$STUB_ESTADO/ss-conexoes"
STUB_JOURNAL="$TMP/journal.txt" dgclaw suporte desligar >"$TMP/o.txt" 2>&1; rc=$?
igual "desligar com sessao aberta sai 0" 0 "$rc"
afirma "diz que encerrou 1 sessao" grep -q "1 sessao(oes) SSH aberta(s)" "$TMP/o.txt"
nega "a sessao da chave do suporte morreu" kill -0 "$PID_FALSO"
afirma "a sessao de outra chave continua" kill -0 "$PID_OUTRA"
kill "$PID_OUTRA" 2>/dev/null; wait 2>/dev/null

echo "--desligar sem como identificar a sessao avisa com clareza"
dgclaw suporte ligar --chave "$CHAVE" >/dev/null 2>&1
rm -f "$STUB_ESTADO/ss-conexoes"
dgclaw suporte desligar >"$TMP/o.txt" 2>&1; rc=$?
igual "sai 0" 0 "$rc"
afirma "avisa que pode haver sessao aberta" grep -q "pode haver uma sessao antiga aberta" "$TMP/o.txt"
afirma "ensina a derrubar" grep -q "pkill -KILL -t" "$TMP/o.txt"
afirma "avisa que restart nao derruba" grep -q "NAO derruba as sessoes ja abertas" "$TMP/o.txt"

fim
