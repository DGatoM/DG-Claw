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
echo "2147483648 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a4"   # criado antes: 2 GB, 1.0 CPU, 1024 processos (o padrao antigo)
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "rodou o podman update com memoria, swap (mesma folga de 2 GB do container) , CPUs e processos" grep -q '^podman update --memory-swap=8589934592 --memory=6144m --cpus=1.8 --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
nega "nao recriou" grep -q '^podman create\|^podman rm' "$STUB_LOG"
afirma "mostra o antes" grep -q 'antes:  memoria 2.0 GB, CPUs 1.0, processos 1024' "$TMP/rep.txt"
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
echo "0 0 100000 0" >"$STUB_ESTADO/lim-dgclaw-a8"   # tudo sem limite (max)
: >"$STUB_LOG"; dgclaw agente reparar a8 >"$TMP/rep.txt" 2>&1
igual "sem limite (max): o reparar termina com 0" "0" "$?"
nega "sem limite nunca vira teto finito: nenhum podman update" grep -q '^podman update' "$STUB_LOG"
afirma "o antes mostra tudo sem limite" grep -q 'antes:  memoria sem limite, CPUs sem limite, processos sem limite' "$TMP/rep.txt"
afirma "e continua tudo sem limite no cgroup" grep -q '^0 0 ' "$STUB_ESTADO/lim-dgclaw-a8"

echo "podman sem suporte ao update"
echo "2147483648 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a4"
touch "$STUB_ESTADO/update-sem-suporte"
dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "o reparar continua e termina com 0" "0" "$?"
afirma "avisa em portugues que o valor entra na proxima recriacao" grep -q 'proxima vez que o agente for recriado' "$TMP/rep.txt"
nega "e nao manda recriar na mao" grep -q 'dgclaw agente recriar' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-sem-suporte"
touch "$STUB_ESTADO/update-sem-swap"
echo "2147483648 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a4"
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

echo "CPU sem limite (-1) e processos no padrao antigo (1024): so o que e finito sobe; o sem limite fica como esta"
echo "2147483648 -1 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "quota -1 nao derruba a leitura: sobem memoria e processos, sem --cpus" grep -q '^podman update --memory-swap=8589934592 --memory=6144m --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
nega "CPUs sem limite nao entram no update" grep -q '^podman update.*--cpus' "$STUB_LOG"
afirma "mostra o antes com CPUs sem limite" grep -q 'antes:  memoria 2.0 GB, CPUs sem limite, processos 1024' "$TMP/rep.txt"
afirma "e as CPUs continuam sem limite depois" grep -q '^6442450944 -1 ' "$STUB_ESTADO/lim-dgclaw-a4"
echo "2147483648 -1 100000 -1 -1" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "pids -1 e swap -1 leem sem erro; so a memoria sobe, com swap ilimitado" grep -q '^podman update --memory-swap=-1 --memory=6144m dgclaw-a4' "$STUB_LOG"
nega "processos sem limite nao entram no update" grep -q '^podman update.*--pids-limit' "$STUB_LOG"

echo "memoria sem limite e processos sem limite (max) nao sao mexidos; pids.max=0 literal e teto finito"
maquina 8 2
echo "0 100000 100000 0 0" >"$STUB_ESTADO/lim-dgclaw-a4"   # memoria e processos sem limite (max), CPUs 1.0
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "o reparar termina com 0" "0" "$?"
afirma "so as CPUs (finitas, padrao antigo) sobem" grep -q '^podman update --cpus=1.8 dgclaw-a4' "$STUB_LOG"
nega "memoria e processos sem limite nao entram no update" grep -q '^podman update.*\(--memory\|--pids-limit\)' "$STUB_LOG"
afirma "o cgroup continua com memoria e processos sem limite" grep -q '^0 180000 100000 0 ' "$STUB_ESTADO/lim-dgclaw-a4"
echo "2147483648 100000 100000 zero 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"   # pids.max = 0 literal (teto finito)
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "pids.max=0: o reparar termina com 0" "0" "$?"
afirma "0 literal aparece como 0, nao como sem limite" grep -q 'antes:  memoria 2.0 GB, CPUs 1.0, processos 0' "$TMP/rep.txt"
afirma "e e escolha do dono: mantido, fora do update" grep -q 'mantido: processos em 0 no container dgclaw-a4.*escolha do dono' "$TMP/rep.txt"
nega "o update nao leva --pids-limit" grep -q '^podman update.*--pids-limit' "$STUB_LOG"
afirma "o pids.max continua 0" grep -q '^6442450944 180000 100000 zero ' "$STUB_ESTADO/lim-dgclaw-a4"

echo "CPU arredonda para cima (so para exibir; fora do padrao antigo nao muda)"
echo "8589934592 5000 100000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a8"   # 0.05 CPU
: >"$STUB_LOG"; dgclaw agente reparar a8 >"$TMP/rep.txt" 2>&1
afirma "0.05 CPU vira 0.1 e nao 'sem limite'" grep -q 'antes:  memoria 8.0 GB, CPUs 0.1, processos 4096' "$TMP/rep.txt"
nega "0.05 CPU e escolha do dono: nao sobe" grep -q '^podman update' "$STUB_LOG"
afirma "e o log diz que foi mantido e por que" grep -q 'mantido: CPUs em 0.1 no container dgclaw-a8.*escolha do dono' "$TMP/rep.txt"

echo "swap: a politica vigente e preservada"
echo "2147483648 100000 100000 4096 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"   # swap igual a memoria: sem swap
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "sem swap continua sem swap" grep -q '^podman update --memory-swap=6442450944 --memory=6144m --cpus=1.8 dgclaw-a4' "$STUB_LOG"
echo "2147483648 100000 100000 4096 -1" >"$STUB_ESTADO/lim-dgclaw-a4"   # swap ilimitado
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "swap ilimitado continua ilimitado" grep -q '^podman update --memory-swap=-1 --memory=6144m --cpus=1.8 dgclaw-a4' "$STUB_LOG"
echo "2147483648 100000 100000 4096 -1" >"$STUB_ESTADO/lim-dgclaw-a4"

echo "o atalho da imagem atual nao olha os limites"
maquina 8 2
echo imagem-estavel >"$STUB_ESTADO/imagem-id"
echo imagem-estavel >"$STUB_ESTADO/img-dgclaw-a8"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a8"
: >"$STUB_LOG"; dgclaw agente recriar a8 >"$TMP/rec.txt" 2>&1
afirma "mesma imagem, limites baixos: continua 'nada a recriar'" grep -q 'nada a recriar' "$TMP/rec.txt"
nega "nao recriou" grep -q '^podman create' "$STUB_LOG"

echo "limites efetivos vem do cgroup, nao do HostConfig"
maquina 8 2
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
rm -rf "$DGCLAW_RAIZ/sys/fs/cgroup"; touch "$STUB_ESTADO/cgroup-ausente"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "sem arquivos de cgroup o reparar termina com 0" "0" "$?"
nega "e nao muda nada" grep -q '^podman update' "$STUB_LOG"
afirma "e avisa que nao leu" grep -q 'nao consegui ler os limites atuais' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/cgroup-ausente"
echo "swap: memory.swap.max e so o swap, entao 2 GB de swap atual vira memoria nova + 2 GB"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "swap = memoria nova + swap atual" grep -q '^podman update --memory-swap=8589934592 --memory=6144m' "$STUB_LOG"
afirma "diz que vale para o container ligado e o definitivo vem na recriacao" grep -q 'vale para o container ligado.*proxima vez que o agente for recriado' "$TMP/rep.txt"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
touch "$STUB_ESTADO/update-sem-efeito"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "update que nao mudou nada: avisa depois de reler" grep -q 'continuou abaixo do calculado' "$TMP/rep.txt"
nega "e nao diz que aumentou" grep -q 'aumentados' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-sem-efeito"

echo "CPU: so o padrao antigo (1.0 exato) sobe; o resto e escolha do dono"
echo "8589934592 175000 100000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a8"   # 1.75 CPU, alvo 1.8
: >"$STUB_LOG"; dgclaw agente reparar a8 >"$TMP/rep.txt" 2>&1
nega "175000/100000 (1.75) nao e o padrao antigo: fica como esta" grep -q '^podman update' "$STUB_LOG"
afirma "e o resumo diz que nada foi mudado" grep -q 'nada foi mudado: os limites abaixo do calculado' "$TMP/rep.txt"
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
echo "2147483648 100000 100000 4096 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "a linha com \$(...) nao foi executada" test -e "$DGCLAW_RAIZ/pwned"
afirma "o alvo vem das duas linhas literais (3g e 1.5, aspas tiradas)" grep -q '^podman update --memory-swap=5368709120 --memory=3072m --cpus=1.5 dgclaw-a4' "$STUB_LOG"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"

echo "cada controlador e lido sozinho"
maquina 8 2
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; touch "$STUB_ESTADO/cgroup-sem-swap"
dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "sem memory.swap.max a memoria nao e tocada" grep -q '^podman update.*--memory' "$STUB_LOG"
afirma "processos sobem mesmo assim" grep -q '^podman update --cpus=1.8 --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
afirma "avisa da memoria que nao leu" grep -q 'nao consegui ler a memoria' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/cgroup-sem-swap"

echo "o resultado vem da releitura, recurso por recurso"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
touch "$STUB_ESTADO/update-cpu-sem-efeito"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "CPUs continuaram abaixo: aviso proprio" grep -q 'CPUs do container dgclaw-a4 continuou abaixo' "$TMP/rep.txt"
afirma "memoria e processos subiram" grep -q 'subiram em dgclaw-a4: memoria processos' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-cpu-sem-efeito"

echo "swap em bytes"
echo "2147483648 100000 100000 4096 $((2147483648 + 524288))" >"$STUB_ESTADO/lim-dgclaw-a4"   # 512 KiB de swap
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "--memory-swap = memoria nova + 512 KiB, em bytes" grep -q "^podman update --memory-swap=$((6144 * 1048576 + 524288)) --memory=6144m" "$STUB_LOG"
afirma "o swap de 512 KiB foi conferido e mantido" grep -q "^$((6144 * 1048576)) .* $((6144 * 1048576 + 524288))\$" "$STUB_ESTADO/lim-dgclaw-a4"
nega "sem aviso de memoria abaixo" grep -q 'memoria do container dgclaw-a4 continuou abaixo' "$TMP/rep.txt"

echo "limite escolhido pelo dono fica como esta"
maquina 8 2
echo "1073741824 50000 100000 4096 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"   # 1 GiB e 0.5 CPU: escolha do dono
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "o reparar termina com 0" "0" "$?"
nega "nenhum podman update" grep -q '^podman update' "$STUB_LOG"
afirma "a memoria continua em 1 GiB e a CPU em 0.5" grep -q '^1073741824 50000 ' "$STUB_ESTADO/lim-dgclaw-a4"
afirma "o log diz que a memoria foi mantida e por que" grep -q 'mantido: memoria em 1.0 GB no container dgclaw-a4.*escolha do dono' "$TMP/rep.txt"
afirma "o log diz que as CPUs foram mantidas" grep -q 'mantido: CPUs em 0.5 no container dgclaw-a4' "$TMP/rep.txt"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"   # 2g, 1.0 e 1024: padrao antigo
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "o padrao antigo (2g, 1.0, 1024) sobe" grep -q '^podman update --memory-swap=8589934592 --memory=6144m --cpus=1.8 --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
echo "2147483648 100000 100000 2048 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"   # so os processos fora do padrao
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "cada recurso e julgado sozinho: memoria e CPUs sobem" grep -q '^podman update --memory-swap=8589934592 --memory=6144m --cpus=1.8 dgclaw-a4' "$STUB_LOG"
afirma "e os 2048 processos ficam" grep -q 'mantido: processos em 2048' "$TMP/rep.txt"

echo "comentario no fim da linha do dgclaw.env, nos tres caminhos"
maquina 8 2
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_CONTAINER_MEMORIA=4g # teto do agente\nDGCLAW_CONTAINER_CPUS=1.5   # duas casas\n' >"$ETC/dgclaw.env"
criar_agente com1 --nome X
igual "criar: 4g e 1.5" "4g 1.5 4096" "$(limite_criado com1)"
echo imagem-nova-com >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar com1 --forcar >"$TMP/rec.txt" 2>&1
igual "recriar: 4g e 1.5" "4g 1.5 4096" "$(limite_criado com1)"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "reparar: alvo 4096m e 1.5" grep -q '^podman update --memory-swap=6442450944 --memory=4096m --cpus=1.5 --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_CONTAINER_MEMORIA="3g" # entre aspas\n' >"$ETC/dgclaw.env"
criar_agente com2 --nome X
igual "valor entre aspas seguido de comentario" "3g" "$(limite_criado com2 | cut -d' ' -f1)"
echo "a variavel de ambiente vence o arquivo, igual nos tres caminhos"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_CONTAINER_MEMORIA=4g # arquivo\n' >"$ETC/dgclaw.env"
DGCLAW_CONTAINER_MEMORIA=3g criar_agente com3 --nome X
igual "criar: a variavel (3g) vence o arquivo (4g)" "3g" "$(limite_criado com3 | cut -d' ' -f1)"
: >"$STUB_LOG"; DGCLAW_CONTAINER_MEMORIA=3g dgclaw agente recriar com3 --forcar >"$TMP/rec.txt" 2>&1
igual "recriar: a variavel vence o arquivo" "3g" "$(limite_criado com3 | cut -d' ' -f1)"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; DGCLAW_CONTAINER_MEMORIA=3g dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "reparar: a variavel vence o arquivo" grep -q -- '--memory=3072m' "$STUB_LOG"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"

echo "limite que some depois do update e falha, nao aumento"
maquina 8 2
touch "$STUB_ESTADO/update-cpu-vira-max"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "CPUs: o aviso diz que o limite sumiu" grep -q 'o limite de CPUs do container dgclaw-a4 sumiu' "$TMP/rep.txt"
nega "CPUs nao aparecem como subiram" grep -q 'subiram em dgclaw-a4:.*CPUs' "$TMP/rep.txt"
afirma "memoria e processos, que subiram de verdade, continuam como subiram" grep -q 'subiram em dgclaw-a4: memoria processos' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-cpu-vira-max"
touch "$STUB_ESTADO/update-mem-vira-max"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "memoria: o aviso diz que o limite sumiu" grep -q 'o limite de memoria do container dgclaw-a4 sumiu' "$TMP/rep.txt"
nega "memoria nao aparece como subiu" grep -q 'subiram em dgclaw-a4:.*memoria' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-mem-vira-max"
touch "$STUB_ESTADO/update-pids-vira-max"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "processos: o aviso diz que o limite sumiu" grep -q 'o limite de processos do container dgclaw-a4 sumiu' "$TMP/rep.txt"
nega "processos nao aparecem como subiram" grep -q 'subiram em dgclaw-a4:.*processos' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-pids-vira-max"

echo "limite que sumiu: a primeira chamada falha, a segunda (cgroup normal) deixa o que esta sem limite como esta"
maquina 8 2
touch "$STUB_ESTADO/update-cpu-vira-max"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nao_zero=$?
nega "a primeira chamada termina com codigo diferente de zero" test "$nao_zero" -eq 0
# shellcheck disable=SC2016 # as crases fazem parte do texto procurado
afirma "e diz FALHA e qual limite" grep -q 'FALHA: o limite de CPUs do container dgclaw-a4 sumiu' "$TMP/rep.txt"
# shellcheck disable=SC2016 # as crases fazem parte do texto procurado
afirma "manda recriar o agente com --forcar" grep -q 'recrie o agente: `dgclaw agente recriar a4 --forcar`' "$TMP/rep.txt"
# shellcheck disable=SC2016
afirma "avisa que o --forcar pula a conferencia de arquivos so do container" grep -q 'O --forcar tambem pula a conferencia de arquivos que so existem dentro do container, entao copie para a casa do agente' "$TMP/rep.txt"
# shellcheck disable=SC2016
afirma "e manda conferir o teto com reparar" grep -q 'Depois confira o teto com `dgclaw agente reparar a4`' "$TMP/rep.txt"
# shellcheck disable=SC2016
afirma "e diz que repetir o reparo nao devolve o limite" grep -q 'dgclaw agente reparar a4` de novo nao devolve o limite' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-cpu-vira-max"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "a segunda chamada termina com 0" "0" "$?"
nega "e nao converte as CPUs sem limite em teto finito" grep -q '^podman update' "$STUB_LOG"
afirma "as CPUs continuam sem limite" grep -q '^6442450944 0 ' "$STUB_ESTADO/lim-dgclaw-a4"

echo "mudanca colateral de finito para finito: so CPU pedida, memoria personalizada muda"
maquina 8 2
echo "1073741824 100000 100000 4096 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"   # 1 GB (escolha do dono), CPUs no padrao antigo
touch "$STUB_ESTADO/update-cpu-mexe-mem"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "o reparar termina com codigo diferente de zero" test "$?" -eq 0
afirma "e diz FALHA com valor anterior e observado" grep -q 'FALHA: a memoria do container dgclaw-a4 mudou sem ter sido pedida depois do podman update: valor anterior 1073741824 bytes, observado 2147483648 bytes' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-cpu-mexe-mem"

echo "CPU: 50000 50000 e escolha do dono (so o par exato 100000 100000 e o padrao antigo)"
maquina 8 2
echo "8589934592 50000 50000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "o reparar termina com 0" "0" "$?"
nega "nao roda o update" grep -q '^podman update' "$STUB_LOG"
afirma "o cpu.max continua 50000 50000" grep -q '^8589934592 50000 50000 ' "$STUB_ESTADO/lim-dgclaw-a4"

echo "swap finito que vira sem limite depois do update e falha, mesmo sem o reparo ter mexido nele"
maquina 8 2
echo "8589934592 100000 100000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a4"   # 8 GB, swap de 8 GB; so as CPUs sobem
touch "$STUB_ESTADO/update-swap-vira-max"
rm -f "$STUB_ESTADO/update-feito"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "o reparar termina com codigo diferente de zero" test "$?" -eq 0
afirma "o aviso diz que o limite de swap sumiu" grep -q 'FALHA: o limite de swap do container dgclaw-a4 sumiu' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-swap-vira-max"

echo "um controlador legivel antes e nao relido depois e falha, mesmo com os outros respondendo"
maquina 8 2
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
rm -f "$STUB_ESTADO/update-feito"; touch "$STUB_ESTADO/cpu-nao-relido"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "o reparar termina com codigo diferente de zero" test "$?" -eq 0
afirma "diz qual controlador nao foi relido" grep -q 'FALHA: nao consegui reler as CPUs (cpu.max) do container dgclaw-a4' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/cpu-nao-relido" "$STUB_ESTADO/update-feito"

echo "teto acima do pedido e falha com esperado e observado; swap mais permissivo e falha propria"
for caso in mem cpu pids; do
    echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
    rm -f "$STUB_ESTADO/update-feito"; touch "$STUB_ESTADO/update-$caso-acima"
    : >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
    nega "$caso acima do pedido: codigo diferente de zero" test "$?" -eq 0
    afirma "$caso acima do pedido: diz esperado e observado" grep -q 'FALHA: .*acima do pedido.*esperado .*observado' "$TMP/rep.txt"
    rm -f "$STUB_ESTADO/update-$caso-acima" "$STUB_ESTADO/update-feito"
done
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
touch "$STUB_ESTADO/update-swap-mais"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "swap mais permissivo: codigo diferente de zero" test "$?" -eq 0
afirma "swap mais permissivo: falha propria do swap com esperado e observado" grep -q 'FALHA: o swap do container dgclaw-a4 ficou mais permissivo.*esperado no maximo.*observado' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-swap-mais" "$STUB_ESTADO/update-feito"

echo "releitura que falha depois do update e falha"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
rm -f "$STUB_ESTADO/update-feito"; touch "$STUB_ESTADO/releitura-falha"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "o reparar termina com codigo diferente de zero" test "$?" -eq 0
afirma "diz que rodou o update e nao conseguiu reler" grep -q 'FALHA: rodei o podman update em dgclaw-a4, mas nao consegui reler os limites' "$TMP/rep.txt"
afirma "e diz o que fazer" grep -q 'Confira com: podman inspect dgclaw-a4 e rode de novo' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/releitura-falha" "$STUB_ESTADO/update-feito"

echo "dgclaw.env com espaco no comeco e com export, nos tres caminhos"
maquina 8 2
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nexport DGCLAW_CONTAINER_MEMORIA=1g\n  DGCLAW_CONTAINER_CPUS=0.5\n' >"$ETC/dgclaw.env"
criar_agente ex1 --nome X
igual "criar: export e espaco inicial valem" "1g 0.5 4096" "$(limite_criado ex1)"
echo imagem-nova-ex >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar ex1 --forcar >"$TMP/rec.txt" 2>&1
igual "recriar: export e espaco inicial valem" "1g 0.5 4096" "$(limite_criado ex1)"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n \texport   DGCLAW_CONTAINER_MEMORIA=4g\n\tDGCLAW_CONTAINER_CPUS=1.5\n' >"$ETC/dgclaw.env"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "reparar: export e espaco inicial valem" grep -q '^podman update --memory-swap=6442450944 --memory=4096m --cpus=1.5 --pids-limit=4096 dgclaw-a4' "$STUB_LOG"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"

fim
