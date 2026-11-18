#!/usr/bin/env bash
# Limites do container do agente: o calculo pelo tamanho da maquina (RAM e CPUs), a sobrescrita por
# DGCLAW_CONTAINER_MEMORIA e DGCLAW_CONTAINER_CPUS, e o `agente reparar` que sobe o container existente sem recriar
# e sem nunca reduzir o que a pessoa aumentou a mao.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

# maquina <GB de RAM> <nucleos>: define o meminfo da raiz falsa e o nproc de mentira.
maquina() {
    mkdir -p "$DGCLAW_RAIZ/proc"
    printf 'MemTotal:       %d kB\nMemFree:         100 kB\n' "$(($1 * 1024 * 1024))" >"$DGCLAW_RAIZ/proc/meminfo"
    echo "$2" >"$STUB_ESTADO/nproc"
}
# limite_criado <slug>: "<memoria> <cpus>" que o `podman create` recebeu.
limite_criado() { grep "^podman create .*--name dgclaw-$1 " "$STUB_LOG" | tail -n 1 | sed -n 's/.*--memory \([^ ]*\) --cpus \([^ ]*\) --pids-limit \([^ ]*\) .*/\1 \2 \3/p'; }
sem_env() { unset DGCLAW_CONTAINER_MEMORIA DGCLAW_CONTAINER_CPUS; }

echo "calculo pelo tamanho da maquina"
sem_env
maquina 4 1;  criar_agente a4 --nome X;  igual "4 GB e 1 CPU: 3 GB (75%), piso de 1.0 CPU" "3072m 1.0 4096" "$(limite_criado a4)"
maquina 8 2;  criar_agente a8 --nome X;  igual "8 GB e 2 CPUs: 6 GB e 1.8 CPU" "6144m 1.8 4096" "$(limite_criado a8)"
maquina 16 8; criar_agente a16 --nome X; igual "16 GB e 8 CPUs: 12 GB e 7.8 CPUs" "12288m 7.8 4096" "$(limite_criado a16)"
maquina 2 1;  criar_agente a2 --nome X;  igual "2 GB e 1 CPU: piso de 2 GB" "2048m 1.0 4096" "$(limite_criado a2)"
rm -f "$DGCLAW_RAIZ/proc/meminfo"
criar_agente asem --nome X; igual "sem meminfo: piso de 2 GB" "2048m" "$(limite_criado asem | cut -d' ' -f1)"
afirma "a criacao diz os limites usados" grep -q 'limites do container dgclaw-asem' "$TMP/saida.txt"

echo "sobrescrita por variavel"
maquina 8 2
DGCLAW_CONTAINER_MEMORIA=3g DGCLAW_CONTAINER_CPUS=1.5 criar_agente ov --nome X
igual "memoria e CPUs da variavel" "3g 1.5 4096" "$(limite_criado ov)"
DGCLAW_CONTAINER_CPUS=3 criar_agente ov2 --nome X
igual "so CPUs sobrescritas, memoria calculada" "6144m 3.0 4096" "$(limite_criado ov2)"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_CONTAINER_MEMORIA=5g\nOUTRA=linha\n' >"$ETC/dgclaw.env"
criar_agente ov3 --nome X
igual "a variavel tambem vale quando vem do dgclaw.env" "5g" "$(limite_criado ov3 | cut -d' ' -f1)"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"
DGCLAW_CONTAINER_MEMORIA=abc criar_agente ruim --nome X
nega "memoria invalida faz o criar falhar" test "$?" -eq 0
afirma "e a mensagem diz o que fazer" grep -q 'O que fazer: corrija a linha' "$TMP/saida.txt"
DGCLAW_CONTAINER_CPUS=0 criar_agente ruim2 --nome X
nega "CPUs zero faz o criar falhar" test "$?" -eq 0

echo "recriar usa o calculo"
maquina 16 4
echo imagem-nova-x >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar a8 >"$TMP/rec.txt" 2>&1
igual "recriar cria com 12 GB e 3.8 CPUs" "12288m 3.8 4096" "$(limite_criado a8)"

echo "reparar sobe o container antigo sem recriar"
maquina 8 2
echo "1073741824 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a4"   # criado antes: 1 GB, 1.0 CPU, 1024 processos
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "rodou o podman update com memoria, swap, CPUs e processos" grep -q '^podman update --memory-swap=12288m --memory=6144m --cpus=1.8 --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
nega "nao recriou" grep -q '^podman create\|^podman rm' "$STUB_LOG"
afirma "mostra o antes" grep -q 'antes:  memoria 1.0 GB, CPUs 1.0, processos 1024' "$TMP/rep.txt"
afirma "mostra o depois" grep -q 'depois: memoria 6.0 GB, CPUs 1.8, processos 4096' "$TMP/rep.txt"

echo "reparar nunca reduz o que a pessoa aumentou"
echo "17179869184 400000 100000 8192" >"$STUB_ESTADO/lim-dgclaw-a8"   # 16 GB, 4 CPUs, 8192 processos
: >"$STUB_LOG"; dgclaw agente reparar a8 >"$TMP/rep.txt" 2>&1
nega "nenhum podman update" grep -q '^podman update' "$STUB_LOG"
afirma "avisa que nada mudou" grep -q 'nada foi mudado' "$TMP/rep.txt"
echo "8589934592 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a8"   # 8 GB (acima de 6), CPUs abaixo, processos abaixo
: >"$STUB_LOG"; dgclaw agente reparar a8 >"$TMP/rep.txt" 2>&1
nega "memoria acima do calculado nao entra no update" grep -q '^podman update.*--memory' "$STUB_LOG"
afirma "CPUs e processos sobem" grep -q '^podman update --cpus=1.8 --pids-limit=4096 dgclaw-a8' "$STUB_LOG"
afirma "a memoria ficou em 8 GB" grep -q '^8589934592 ' "$STUB_ESTADO/lim-dgclaw-a8"
echo "0 0 100000 0" >"$STUB_ESTADO/lim-dgclaw-a8"   # tudo sem limite
: >"$STUB_LOG"; dgclaw agente reparar a8 >"$TMP/rep.txt" 2>&1
nega "sem limite nao ganha limite" grep -q '^podman update' "$STUB_LOG"

echo "podman sem suporte ao update"
echo "1073741824 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a4"
touch "$STUB_ESTADO/update-sem-suporte"
dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "o reparar continua e termina com 0" "0" "$?"
afirma "avisa em portugues o que fazer" grep -q 'dgclaw agente recriar a4' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-sem-suporte"
touch "$STUB_ESTADO/update-sem-swap"
echo "1073741824 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a4"
dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "sem --memory-swap o reparar termina com 0" "0" "$?"
afirma "avisa do flag que nao foi aceito" grep -q "nao aceitou 'podman update --memory-swap" "$TMP/rep.txt"
afirma "os outros limites foram aplicados" grep -q 'depois: .*CPUs 1.8, processos 4096' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-sem-swap"
touch "$STUB_ESTADO/inspect-limites-falha"
dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "se nao da para ler os limites o reparar segue" "0" "$?"
afirma "e avisa" grep -q 'nao consegui ler os limites atuais' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/inspect-limites-falha"

fim
