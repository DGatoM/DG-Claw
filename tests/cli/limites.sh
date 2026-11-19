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
afirma "rodou o podman update com memoria, swap (mesma folga de 1 GB do container) , CPUs e processos" grep -q '^podman update --memory-swap=7516192768 --memory=6144m --cpus=1.8 --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
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
afirma "avisa em portugues que o valor entra na proxima recriacao" grep -q 'proxima vez que o agente for recriado' "$TMP/rep.txt"
nega "e nao manda recriar na mao" grep -q 'dgclaw agente recriar' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-sem-suporte"
touch "$STUB_ESTADO/update-sem-swap"
echo "1073741824 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "sem --memory-swap o reparar termina com 0" "0" "$?"
nega "memoria nunca vai sozinha, sem o swap, na tentativa um por vez" grep -q '^podman update --memory=' "$STUB_LOG"
afirma "avisa do flag que nao foi aceito" grep -q "nao aceitou 'podman update --memory-swap" "$TMP/rep.txt"
afirma "os outros limites foram aplicados" grep -q 'depois: .*CPUs 1.8, processos 4096' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-sem-swap"
touch "$STUB_ESTADO/inspect-limites-falha"
dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "se nao da para ler os limites o reparar segue" "0" "$?"
afirma "e avisa" grep -q 'nao consegui ler os limites atuais' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/inspect-limites-falha"

echo "recriar valida os limites antes de mexer no container"
maquina 8 2
: >"$STUB_LOG"; DGCLAW_CONTAINER_MEMORIA=4GB dgclaw agente recriar a8 --forcar >"$TMP/rec.txt" 2>&1
nega "memoria invalida faz o recriar falhar" test "$?" -eq 0
afirma "a mensagem cita a variavel" grep -q 'DGCLAW_CONTAINER_MEMORIA' "$TMP/rec.txt"
nega "o podman nao recebeu stop, rm nem create" grep -q '^podman stop\|^podman rm\|^podman create\|^podman kill' "$STUB_LOG"

echo "CPU sem limite e processos baixos (-1 e 1024)"
echo "1073741824 -1 100000 1024 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "quota -1 nao derruba a leitura: sobe memoria e processos" grep -q '^podman update --memory-swap=7516192768 --memory=6144m --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
nega "CPU sem limite continua sem limite" grep -q '^podman update.*--cpus' "$STUB_LOG"
afirma "mostra o antes com CPUs sem limite" grep -q 'antes:  memoria 1.0 GB, CPUs sem limite, processos 1024' "$TMP/rep.txt"
echo "1073741824 -1 100000 -1 -1" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "pids -1 e swap -1 leem sem erro; so a memoria sobe, com swap ilimitado" grep -q '^podman update --memory-swap=-1 --memory=6144m dgclaw-a4' "$STUB_LOG"

echo "CPU arredonda para cima"
echo "8589934592 5000 100000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a8"   # 0.05 CPU
: >"$STUB_LOG"; dgclaw agente reparar a8 >"$TMP/rep.txt" 2>&1
afirma "0.05 CPU vira 0.1 e nao 'sem limite'" grep -q 'antes:  memoria 8.0 GB, CPUs 0.1, processos 4096' "$TMP/rep.txt"
afirma "e sobe para o calculado" grep -q '^podman update --cpus=1.8 dgclaw-a8' "$STUB_LOG"

echo "swap: a politica vigente e preservada"
echo "1073741824 100000 100000 4096 1073741824" >"$STUB_ESTADO/lim-dgclaw-a4"   # swap igual a memoria: sem swap
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "sem swap continua sem swap" grep -q '^podman update --memory-swap=6442450944 --memory=6144m --cpus=1.8 dgclaw-a4' "$STUB_LOG"
echo "1073741824 100000 100000 4096 -1" >"$STUB_ESTADO/lim-dgclaw-a4"   # swap ilimitado
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "swap ilimitado continua ilimitado" grep -q '^podman update --memory-swap=-1 --memory=6144m --cpus=1.8 dgclaw-a4' "$STUB_LOG"
echo "1073741824 100000 100000 4096 -1" >"$STUB_ESTADO/lim-dgclaw-a4"

echo "o atalho da imagem atual nao olha os limites"
maquina 8 2
echo imagem-estavel >"$STUB_ESTADO/imagem-id"
echo imagem-estavel >"$STUB_ESTADO/img-dgclaw-a8"
echo "1073741824 100000 100000 1024 2147483648" >"$STUB_ESTADO/lim-dgclaw-a8"
: >"$STUB_LOG"; dgclaw agente recriar a8 >"$TMP/rec.txt" 2>&1
afirma "mesma imagem, limites baixos: continua 'nada a recriar'" grep -q 'nada a recriar' "$TMP/rec.txt"
nega "nao recriou" grep -q '^podman create' "$STUB_LOG"

echo "limites efetivos vem do cgroup, nao do HostConfig"
maquina 8 2
echo "1073741824 100000 100000 1024 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"
rm -rf "$DGCLAW_RAIZ/sys/fs/cgroup"; touch "$STUB_ESTADO/cgroup-ausente"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "sem arquivos de cgroup o reparar termina com 0" "0" "$?"
nega "e nao muda nada" grep -q '^podman update' "$STUB_LOG"
afirma "e avisa que nao leu" grep -q 'nao consegui ler os limites atuais' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/cgroup-ausente"
echo "swap: memory.swap.max e so o swap, entao 1 GB de swap atual vira memoria nova + 1 GB"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "swap = memoria nova + swap atual" grep -q '^podman update --memory-swap=7516192768 --memory=6144m' "$STUB_LOG"
afirma "diz que vale para o container ligado e o definitivo vem na recriacao" grep -q 'vale para o container ligado.*proxima vez que o agente for recriado' "$TMP/rep.txt"
echo "1073741824 100000 100000 1024 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"
touch "$STUB_ESTADO/update-sem-efeito"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "update que nao mudou nada: avisa depois de reler" grep -q 'continuou abaixo do calculado' "$TMP/rep.txt"
nega "e nao diz que aumentou" grep -q 'aumentados' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-sem-efeito"

echo "CPU: comparacao exata, arredondamento so para exibir"
echo "8589934592 175000 100000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a8"   # 1.75 CPU, alvo 1.8
: >"$STUB_LOG"; dgclaw agente reparar a8 >"$TMP/rep.txt" 2>&1
afirma "175000/100000 com alvo 1.8 e abaixo" grep -q '^podman update --cpus=1.8 dgclaw-a8' "$STUB_LOG"
echo "8589934592 180000 100000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a8"
: >"$STUB_LOG"; dgclaw agente reparar a8 >"$TMP/rep.txt" 2>&1
nega "180000/100000 ja e o alvo" grep -q '^podman update' "$STUB_LOG"

echo "memoria da variavel abaixo de 512m e erro"
DGCLAW_CONTAINER_MEMORIA=256m dgclaw agente recriar a8 --forcar >"$TMP/rec.txt" 2>&1
nega "256m falha" test "$?" -eq 0
afirma "com motivo e exemplo" grep -q '512m ou mais' "$TMP/rec.txt"
DGCLAW_CONTAINER_MEMORIA=512m criar_agente m512 --nome X
igual "512m e aceito" "512m" "$(limite_criado m512 | cut -d' ' -f1)"

echo "criar valida os limites antes de reservar qualquer coisa"
maquina 8 2
DGCLAW_CONTAINER_MEMORIA=4GB criar_agente nada --nome X
nega "memoria invalida faz o criar falhar" test "$?" -eq 0
nega "nenhuma casa foi criada" test -e "$DGCLAW_RAIZ/var/lib/dgclaw/agentes/nada"
nega "nenhuma entrada no agentes.json" grep -q '"nada"' "$ETC/agentes.json"
nega "nenhum container ou rede foi criado" grep -q '^podman create .*dgclaw-nada\|^podman network create .*dgclaw-nada' "$STUB_LOG"

echo "reparar le o dgclaw.env sem executa-lo"
maquina 8 2
# O $(...) entre aspas simples é de propósito: o arquivo precisa ter o texto literal.
# shellcheck disable=SC2016
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nslug=beta\nX=$(touch %s/pwned)\nDGCLAW_CONTAINER_MEMORIA="3g"\nDGCLAW_CONTAINER_CPUS='"'"'1.5'"'"'\n' "$DGCLAW_RAIZ" >"$ETC/dgclaw.env"
echo "1073741824 100000 100000 4096 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "a linha com \$(...) nao foi executada" test -e "$DGCLAW_RAIZ/pwned"
afirma "o alvo vem das duas linhas literais (3g e 1.5, aspas tiradas)" grep -q '^podman update --memory-swap=4294967296 --memory=3072m --cpus=1.5 dgclaw-a4' "$STUB_LOG"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"

echo "cada controlador e lido sozinho"
maquina 8 2
echo "1073741824 100000 100000 1024 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"
echo "1073741824 100000 100000 1024 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; touch "$STUB_ESTADO/cgroup-sem-swap"
dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "sem memory.swap.max a memoria nao e tocada" grep -q '^podman update.*--memory' "$STUB_LOG"
afirma "processos sobem mesmo assim" grep -q '^podman update --cpus=1.8 --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
afirma "avisa da memoria que nao leu" grep -q 'nao consegui ler a memoria' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/cgroup-sem-swap"

echo "o resultado vem da releitura, recurso por recurso"
echo "1073741824 100000 100000 1024 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"
touch "$STUB_ESTADO/update-cpu-sem-efeito"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "CPUs continuaram abaixo: aviso proprio" grep -q 'CPUs do container dgclaw-a4 continuou abaixo' "$TMP/rep.txt"
afirma "memoria e processos subiram" grep -q 'subiram em dgclaw-a4: memoria processos' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-cpu-sem-efeito"

echo "swap em bytes"
echo "1073741824 100000 100000 4096 $((1073741824 + 524288))" >"$STUB_ESTADO/lim-dgclaw-a4"   # 512 KiB de swap
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "--memory-swap = memoria nova + 512 KiB, em bytes" grep -q "^podman update --memory-swap=$((6144 * 1048576 + 524288)) --memory=6144m" "$STUB_LOG"
afirma "o swap de 512 KiB foi conferido e mantido" grep -q "^$((6144 * 1048576)) .* $((6144 * 1048576 + 524288))\$" "$STUB_ESTADO/lim-dgclaw-a4"
nega "sem aviso de memoria abaixo" grep -q 'memoria do container dgclaw-a4 continuou abaixo' "$TMP/rep.txt"

fim
