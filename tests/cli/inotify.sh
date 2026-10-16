#!/usr/bin/env bash
# Folga de inotify: o aviso no `dgclaw status` e a explicacao quando o container sai com 255.
# O /proc e falso (DGCLAW_RAIZ/proc): pastas de processo com `status` e `fd/` com links.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

# proc_falso <limite-ou-vazio>: zera e recria a arvore. Processos: 100 (uid 0, 2 inotify e
# 1 /dev/null), 200 (uid 1000, 3 inotify: nao conta), 300 (uid 1000005, 1 inotify: conta).
proc_falso() {
    local p="$DGCLAW_RAIZ/proc" pid uid n i
    rm -rf "$p"
    mkdir -p "$p/sys/fs/inotify"
    if [ -n "$1" ]; then printf '%s\n' "$1" >"$p/sys/fs/inotify/max_user_instances"; fi
    for par in "100 0 2" "200 1000 3" "300 1000005 1"; do
        read -r pid uid n <<<"$par"
        mkdir -p "$p/$pid/fd"
        printf 'Name:\tx\nUid:\t%s\t%s\t%s\t%s\n' "$uid" "$uid" "$uid" "$uid" >"$p/$pid/status"
        for ((i = 0; i < n; i++)); do ln -s 'anon_inode:inotify' "$p/$pid/fd/$((i + 3))"; done
        ln -s /dev/null "$p/$pid/fd/99"
    done
}

for u in caddy dgclaw-web dgclaw-admin; do echo active >"$STUB_ESTADO/svc-$u"; done

echo "status: sem /proc legivel"
dgclaw status >"$TMP/o.txt" 2>&1
igual "sem o limite legivel o status ainda sai com 0" "0" "$?"
afirma "avisa que nao leu o limite, com o caminho" grep -q 'aviso  inotify: nao deu para ler o limite em .*max_user_instances' "$TMP/o.txt"

echo "status: uso abaixo de 80%"
proc_falso 128   # root usa 2 + 1 = 3 (o uid 1000 nao conta)
dgclaw status >"$TMP/o.txt" 2>&1
igual "status sai com 0" "0" "$?"
afirma "s_ok com 3 de 128 (so uid 0 e da faixa dos agentes contam)" grep -q 'ok     inotify: 3 de 128 instancias em uso pelo root' "$TMP/o.txt"

echo "status: uso acima de 80%"
proc_falso 4
dgclaw status >"$TMP/o.txt" 2>&1
igual "status continua saindo com 0 (e aviso, nao falha)" "0" "$?"
afirma "75% (3 de 4) ainda nao passa dos 80%: s_ok" grep -q 'ok     inotify: 3 de 4' "$TMP/o.txt"
proc_falso 3
dgclaw status >"$TMP/o.txt" 2>&1
igual "100% de uso: status sai com 0" "0" "$?"
afirma "aviso traz uso, limite e percentual" grep -q 'aviso  inotify: o root usa 3 de 3 instancias (100%)' "$TMP/o.txt"
afirma "aviso diz o que fazer" grep -q 'sysctl -w fs.inotify.max_user_instances=1024' "$TMP/o.txt"
afirma "aviso aponta o arquivo que o instalador grava" grep -q '/etc/sysctl.d/90-dgclaw-inotify.conf' "$TMP/o.txt"

echo "status: limite ilegivel"
proc_falso ""
dgclaw status >"$TMP/o.txt" 2>&1
igual "limite ausente: status sai com 0" "0" "$?"
afirma "limite ausente: aviso" grep -q 'nao deu para ler o limite' "$TMP/o.txt"
proc_falso abc
dgclaw status >"$TMP/o.txt" 2>&1
afirma "limite com lixo: aviso" grep -q 'nao deu para ler o limite' "$TMP/o.txt"

echo "iniciar com o container saindo 255"
proc_falso 128
criar_agente ana --nome "Ana"
dgclaw agente iniciar ana >"$TMP/o.txt" 2>&1
igual "iniciar normal sai com 0" "0" "$?"
touch "$STUB_ESTADO/saida-255"
dgclaw agente iniciar ana >"$TMP/o.txt" 2>&1
igual "iniciar com 255 sai com 1" "1" "$?"
afirma "fala de inotify" grep -q 'causa mais comum e falta de inotify' "$TMP/o.txt"
afirma "traz os numeros (3 de 128)" grep -q 'o root usa 3 de 128 instancias' "$TMP/o.txt"
afirma "diz o sysctl e o proximo passo" grep -q 'dgclaw agente iniciar ana' "$TMP/o.txt"
dgclaw agente iniciar ana --ensaio >"$TMP/o.txt" 2>&1
igual "iniciar --ensaio nao confere o estado" "0" "$?"
rm -f "$STUB_ESTADO/saida-255"

echo "criar com o container saindo 255"
preparar
proc_falso 128
touch "$STUB_ESTADO/saida-255"
# Teto alto so neste criar: com o teto de 2 s do _comum.sh e o criar levando ~1 s, a
# margem dependia da carga da maquina. Com 30 s, levar menos da metade prova que nao esperou.
inicio=$SECONDS
DGCLAW_TEMPO_ESPERA=30 criar_agente bia --nome "Bia"
rc=$?
igual "criar com 255 sai com 1" "1" "$rc"
afirma "explica inotify com os numeros" grep -q 'o root usa 3 de 128 instancias' "$TMP/saida.txt"
afirma "nao esperou o tempo de espera inteiro (o teto e 30 s)" test "$((SECONDS - inicio))" -lt 15

fim
