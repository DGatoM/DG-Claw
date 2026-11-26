#!/usr/bin/env bash
# Limites do container do agente: o calculo pelo tamanho da maquina (RAM e CPUs), a sobrescrita por
# DGCLAW_CONTAINER_MEMORIA e DGCLAW_CONTAINER_CPUS, e o `agente reparar` que sobe o container existente sem recriar
# e sem nunca reduzir o que a pessoa aumentou a mao. Todo agente recebe RAM - reserva como teto de protecao; o principal
# (primeiro criado que ainda existe) e o protegido (oom, memory.low num slice proprio) e os adicionais tem um nivel de
# prioridade (alta, normal, baixa). O criar de um adicional confere o risco de memoria (lib/limites.sh).
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
# create_de <slug>: a ultima linha de `podman create` do agente.
create_de() { grep "^podman create .*--name dgclaw-$1 " "$STUB_LOG" | tail -n 1; }
# mb_bytes <MB>: bytes, para escrever o uso e os limites falsos.
mb_bytes() { echo $(($1 * 1048576)); }
sem_env() { unset DGCLAW_CONTAINER_MEMORIA DGCLAW_CONTAINER_CPUS; }


# nova_raiz: apaga a raiz falsa e comeca outra (registro e agentes.json vazios), para o agente seguinte ser o principal.
nova_raiz() { rm -rf "$TMP"; preparar; sem_env; }

echo "principal: reserva de 1536 MB ou 15% da RAM, o que for maior; o resto e do primeiro agente"
nova_raiz; maquina 4 1;  criar_agente a4 --nome X;  igual "4 GB e 1 CPU: 4096 - 1536 = 2560m, piso de 1.0 CPU" "2560m 1.0 4096" "$(limite_criado a4)"
afirma "a criacao diz que e o principal e mostra a reserva" grep -q 'limites do container dgclaw-a4.*agente principal.*reserva de 1536 MB' "$TMP/saida.txt"
nova_raiz; maquina 7 2;  criar_agente a7 --nome X;  igual "7 GB: reserva 1536 (15% = 1075 perde), principal com 5632m" "5632m 1.8 4096" "$(limite_criado a7)"
nova_raiz; maquina 8 2;  criar_agente a8 --nome X;  igual "8 GB e 2 CPUs: 6656m e 1.8 CPU" "6656m 1.8 4096" "$(limite_criado a8)"
nova_raiz; maquina 16 8; criar_agente a16 --nome X; igual "16 GB e 8 CPUs: reserva 15% (2457) vence os 1536, principal com 13927m e 7.8 CPUs" "13927m 7.8 4096" "$(limite_criado a16)"
nova_raiz; maquina 2 1;  criar_agente a2 --nome X;  igual "2 GB e 1 CPU: sobraria 512 MB, vale o piso de 2048m" "2048m 1.0 4096" "$(limite_criado a2)"
nova_raiz; rm -f "$DGCLAW_RAIZ/proc/meminfo"
criar_agente asem --nome X; igual "sem meminfo: piso de 2 GB" "2048m" "$(limite_criado asem | cut -d' ' -f1)"
afirma "a criacao diz os limites usados" grep -q 'limites do container dgclaw-asem' "$TMP/saida.txt"

echo "principal: protegido (oom, reservation e slice proprio)"
nova_raiz; maquina 8 2; criar_agente pa --nome X
c="$(create_de pa)"
afirma "oom_score_adj -900" grep -q -- '--oom-score-adj -900 ' <<<"$c"
afirma "memory-reservation = 50% de (8192 - 1536) = 3328m" grep -q -- '--memory-reservation 3328m ' <<<"$c"
afirma "cgroup-parent com sublinhado, nao hifen" grep -q -- '--cgroup-parent dgclaw_principal.slice ' <<<"$c"
nega "sem memory.high no principal" grep -q -- 'memory.high' <<<"$c"
slice="$DGCLAW_RAIZ/etc/systemd/system/dgclaw_principal.slice"
afirma "o arquivo do slice foi gravado" test -f "$slice"
igual "e traz o MemoryLow" "$(printf '[Unit]\nDescription=DG Claw: agente principal (memoria protegida)\n\n[Slice]\nMemoryLow=3328M\n')" "$(cat "$slice")"
afirma "o systemd foi recarregado" grep -q '^systemctl daemon-reload' "$STUB_LOG"
afirma "e o MemoryLow foi posto no slice em execucao" grep -q '^systemctl set-property --runtime dgclaw_principal.slice MemoryLow=3328M' "$STUB_LOG"
afirma "a criacao diz o papel, a garantia e o oom" grep -q 'prioridade do container dgclaw-pa: agente principal, protegido: oom_score_adj -900, memoria protegida de 3328 MB' "$TMP/saida.txt"
ino="$(stat -c %i "$slice")"
echo imagem-nova-s1 >"$STUB_ESTADO/imagem-id"
dgclaw agente recriar pa --forcar >"$TMP/rec.txt" 2>&1
igual "recriar com o mesmo conteudo nao regrava o slice (mesmo inode)" "$ino" "$(stat -c %i "$slice")"
maquina 16 4
echo imagem-nova-s2 >"$STUB_ESTADO/imagem-id"
dgclaw agente recriar pa --forcar >"$TMP/rec.txt" 2>&1
afirma "com outra RAM o slice e regravado com a garantia nova ((16384 - 2457) / 2 = 6963)" grep -q '^MemoryLow=6963M$' "$slice"
nova_raiz; maquina 4 1; criar_agente p4 --nome X
afirma "4 GB: garantia (4096 - 1536) / 2 = 1280m" grep -q -- '--memory-reservation 1280m ' <<<"$(create_de p4)"
nova_raiz; maquina 2 1; criar_agente p2 --nome X
afirma "2 GB: a garantia sobe ao piso de 1024m" grep -q -- '--memory-reservation 1024m ' <<<"$(create_de p2)"
nova_raiz; maquina 8 2; DGCLAW_CONTAINER_MEMORIA=512m criar_agente po --nome X
afirma "garantia nunca passa do --memory aplicado (512m)" grep -q -- '--memory-reservation 512m ' <<<"$(create_de po)"
afirma "e o slice leva 512M" grep -q '^MemoryLow=512M$' "$DGCLAW_RAIZ/etc/systemd/system/dgclaw_principal.slice"
nova_raiz; rm -f "$DGCLAW_RAIZ/proc/meminfo"; criar_agente ps --nome X
c="$(create_de ps)"
afirma "sem meminfo: oom -900 continua" grep -q -- '--oom-score-adj -900 ' <<<"$c"
nega "sem meminfo: sem reservation" grep -q -- '--memory-reservation' <<<"$c"
nega "sem meminfo: sem cgroup-parent" grep -q -- '--cgroup-parent' <<<"$c"
nega "sem meminfo: nenhum slice gravado" test -e "$DGCLAW_RAIZ/etc/systemd/system/dgclaw_principal.slice"
echo "ensaio nao grava o slice"
nova_raiz; maquina 8 2
dgclaw --ensaio agente criar en --nome X >"$TMP/saida.txt" 2>&1
nega "nenhum slice no ensaio" test -e "$DGCLAW_RAIZ/etc/systemd/system/dgclaw_principal.slice"
nega "e nenhum systemctl rodou" grep -q '^systemctl' "$STUB_LOG"
echo "falha ao gravar o slice vira aviso e nao impede a criacao"
nova_raiz; maquina 8 2
mkdir -p "$DGCLAW_RAIZ/etc/systemd"; : >"$DGCLAW_RAIZ/etc/systemd/system"   # arquivo no lugar da pasta: o mkdir falha
criar_agente pf --nome X
igual "o criar termina com 0" "0" "$?"
afirma "o container foi criado" grep -q '^podman create .*--name dgclaw-pf ' "$STUB_LOG"
afirma "o aviso explica que a reserva fica sem efeito" grep -q 'aviso.*nao consegui gravar .*dgclaw_principal.slice.*reserva de 3328 MB dele fica sem efeito' "$TMP/saida.txt"
nova_raiz; maquina 8 2
STUB_DAEMON_RELOAD_FALHA=1 criar_agente pd --nome X
igual "daemon-reload que falha: o criar termina com 0" "0" "$?"
afirma "e avisa que a reserva fica sem efeito" grep -q 'aviso.*daemon-reload falhou.*sem efeito' "$TMP/saida.txt"

echo "todos os agentes recebem RAM - reserva como teto, nao uma fatia"
nova_raiz; maquina 16 4
criar_agente pri --nome X
criar_agente ad1 --nome X
criar_agente ad2 --nome X
igual "principal: 16384 - 2457 = 13927m" "13927m 3.8 4096" "$(limite_criado pri)"
igual "adicional 1: o mesmo teto" "13927m 3.8 4096" "$(limite_criado ad1)"
igual "adicional 2: o mesmo teto" "13927m 3.8 4096" "$(limite_criado ad2)"
nega "sem aviso de memoria apertada" grep -q 'aviso' "$TMP/saida.txt"
nega "o aviso de 'sobra pouca memoria' nao existe mais" grep -q 'sobra pouca memoria\|nao sobra memoria' "$TMP/saida.txt"
afirma "a criacao do adicional diz o papel e que e teto de protecao" grep -q 'limites do container dgclaw-ad2.*agente adicional.*teto de protecao' "$TMP/saida.txt"
c="$(create_de ad1)"
nega "adicional sem reservation" grep -q -- '--memory-reservation' <<<"$c"
nega "adicional sem cgroup-parent" grep -q -- '--cgroup-parent' <<<"$c"

echo "adicional: o nivel decide o oom_score_adj e o memory.high (bytes inteiros)"
mem=13927
igual "normal (padrao): oom 300 e memory.high em 75%" "--oom-score-adj 300 --cgroup-conf memory.high=$((mem * 1048576 * 75 / 100))" "$(create_de ad1 | sed -n 's/.*\(--oom-score-adj [0-9]* --cgroup-conf memory.high=[0-9]*\).*/\1/p')"
criar_agente ad3 --nome X --prioridade alta
c="$(create_de ad3)"
afirma "alta: oom 0" grep -q -- '--oom-score-adj 0 ' <<<"$c"
nega "alta: sem memory.high" grep -q -- 'memory.high' <<<"$c"
criar_agente ad4 --nome X --prioridade baixa
igual "baixa: oom 700 e memory.high em 50%" "--oom-score-adj 700 --cgroup-conf memory.high=$((mem * 1048576 / 2))" "$(create_de ad4 | sed -n 's/.*\(--oom-score-adj [0-9]* --cgroup-conf memory.high=[0-9]*\).*/\1/p')"
igual "a flag --prioridade gravou a linha do ad4 no arquivo" "baixa" "$(awk -F'\t' '$1 == "ad4" {print $2}' "$ETC/prioridades")"
igual "e o arquivo e 0600" "600" "$(stat -c %a "$ETC/prioridades")"
afirma "a criacao diz o nivel" grep -q 'prioridade do container dgclaw-ad4: agente adicional, prioridade baixa: oom_score_adj 700, memory.high de 6963 MB' "$TMP/saida.txt"
criar_agente adx --nome X --prioridade urgente
nega "prioridade invalida faz o criar falhar" test "$?" -eq 0
afirma "e a mensagem diz os valores" grep -q 'use --prioridade alta, normal ou baixa' "$TMP/saida.txt"
nega "e nada foi criado" grep -q '^podman create .*dgclaw-adx' "$STUB_LOG"
echo "memory.high so existe com --memory; com sobrescrita parte da sobrescrita"
DGCLAW_CONTAINER_MEMORIA=4g criar_agente ad5 --nome X
igual "4g normal: memory.high em 75% de 4096 MB" "memory.high=$((4096 * 1048576 * 75 / 100))" "$(create_de ad5 | sed -n 's/.*\(memory.high=[0-9]*\).*/\1/p')"
nova_raiz; rm -f "$DGCLAW_RAIZ/proc/meminfo"; criar_agente q1 --nome X; criar_agente q2 --nome X --mesmo-assim
igual "sem meminfo o adicional tem 2048m e memory.high em 75% disso" "2048m memory.high=$((2048 * 1048576 * 75 / 100))" "$(limite_criado q2 | cut -d' ' -f1) $(create_de q2 | sed -n 's/.*\(memory.high=[0-9]*\).*/\1/p')"

echo "dgclaw agente prioridade: mostra, grava sem perder linha alheia e diz quando vale"
nova_raiz; maquina 16 4
criar_agente pri --nome X; criar_agente ad1 --nome X
dgclaw agente prioridade ad1 >"$TMP/pri.txt" 2>&1
afirma "sem nivel: mostra normal (o padrao)" grep -q 'Prioridade de memoria do agente ad1: normal' "$TMP/pri.txt"
dgclaw agente prioridade pri >"$TMP/pri.txt" 2>&1
afirma "o principal: diz que e o protegido" grep -q 'O agente pri e o principal.*sempre a protecao maior' "$TMP/pri.txt"
# Uma linha alheia, uma linha de outro agente antes e uma depois: so a do ad1 muda, na mesma posicao.
printf 'outro\talta\nad1\talta\nzz\tbaixa\nlinha sem tab\n' >"$ETC/prioridades"; chmod 600 "$ETC/prioridades"
dgclaw agente prioridade ad1 baixa >"$TMP/pri.txt" 2>&1
igual "o comando termina com 0" "0" "$?"
igual "troca so a linha do ad1 e preserva as outras na ordem" "$(printf 'outro\talta\nad1\tbaixa\nzz\tbaixa\nlinha sem tab\n')" "$(cat "$ETC/prioridades")"
igual "o arquivo continua 0600" "600" "$(stat -c %a "$ETC/prioridades")"
afirma "diz que passa a valer no proximo recriar" grep -q 'proxima vez que o agente for recriado' "$TMP/pri.txt"
afirma "e o comando para valer ja, com o aviso do --forcar" grep -q 'dgclaw agente recriar ad1 --forcar.*O --forcar pula a conferencia de arquivos que so existem dentro do container' "$TMP/pri.txt"
dgclaw agente prioridade ad1 >"$TMP/pri.txt" 2>&1
afirma "agora mostra baixa" grep -q 'Prioridade de memoria do agente ad1: baixa' "$TMP/pri.txt"
dgclaw agente prioridade ad1 normal >"$TMP/pri.txt" 2>&1
igual "e volta para normal na mesma linha" "$(printf 'outro\talta\nad1\tnormal\nzz\tbaixa\nlinha sem tab\n')" "$(cat "$ETC/prioridades")"
dgclaw agente prioridade ad1 media >"$TMP/pri.txt" 2>&1
nega "nivel invalido falha" test "$?" -eq 0
afirma "dizendo os niveis" grep -q 'use alta, normal ou baixa' "$TMP/pri.txt"
dgclaw agente prioridade Nao_Existe alta >"$TMP/pri.txt" 2>&1
nega "slug invalido falha" test "$?" -eq 0
dgclaw agente prioridade fantasma alta >"$TMP/pri.txt" 2>&1
nega "agente que nao existe falha" test "$?" -eq 0
afirma "com a mensagem" grep -q "o agente 'fantasma' nao existe" "$TMP/pri.txt"
nega "e nao gravou o fantasma" grep -q '^fantasma' "$ETC/prioridades"
dgclaw agente prioridade pri baixa >"$TMP/pri.txt" 2>&1
igual "marcar o principal termina com 0" "0" "$?"
afirma "e avisa que so vale se ele deixar de ser o principal" grep -q 'aviso.*principal.*so vale se ele deixar de ser o principal' "$TMP/pri.txt"
igual "mas guarda o nivel" "baixa" "$(awk -F'\t' '$1 == "pri" {print $2}' "$ETC/prioridades")"
dgclaw agente prioridade ad1 alta >/dev/null 2>&1
echo imagem-nova-pr >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
afirma "o recriar aplica o nivel novo (alta: oom 0, sem memory.high)" test "$(create_de ad1 | grep -c -- '--oom-score-adj 0 ')" -eq 1
nega "o nivel novo substituiu o antigo (nao ficou oom 700)" grep -q -- '--oom-score-adj 700' <<<"$(create_de ad1)"
: >"$STUB_LOG"; dgclaw agente recriar pri --forcar >"$TMP/rec.txt" 2>&1
afirma "o principal ignora o nivel baixo: oom -900" grep -q -- '--oom-score-adj -900 ' <<<"$(create_de pri)"
echo "ensaio de prioridade nao grava"
cp "$ETC/prioridades" "$TMP/prio-antes"
dgclaw --ensaio agente prioridade ad1 baixa >"$TMP/pri.txt" 2>&1
igual "o arquivo ficou igual" "$(cat "$TMP/prio-antes")" "$(cat "$ETC/prioridades")"
nova_raiz; maquina 8 2
dgclaw --ensaio agente criar en2 --nome X --prioridade baixa >"$TMP/saida.txt" 2>&1
nega "ensaio do criar com --prioridade nao cria o arquivo" test -e "$ETC/prioridades"
afirma "mas anuncia o que gravaria" grep -q 'ensaio.*gravaria a prioridade baixa do agente en2' "$TMP/saida.txt"
nova_raiz; maquina 8 2
criar_agente pa --nome X
nega "sem linha no arquivo, o --prioridade ausente nao cria o arquivo" test -e "$ETC/prioridades"
dgclaw agente prioridade pa normal >/dev/null 2>&1
igual "e o comando cria o arquivo 0600 quando ele nao existe" "600" "$(stat -c %a "$ETC/prioridades")"

echo "conferencia de risco no criar de um adicional (nunca no principal, no recriar nem no reparar)"
nova_raiz; maquina 8 2        # disponivel: 8192 - 1536 = 6656 MB
criar_agente pri --nome X
igual "o principal nao e conferido: sai com 0" "0" "$?"
mb_bytes 5000 >"$STUB_ESTADO/uso-dgclaw-pri"
: >"$STUB_LOG"
criar_agente ad1 --nome X
nega "uso 5000 MB + media 5000 MB = 10000 > 6656: o criar falha" test "$?" -eq 0
afirma "explica os numeros e a saida certa" grep -q 'com o agente ad1 esta VPS fica no limite de memoria: os 1 agentes usam hoje 5000 MB (media de 5000 MB cada) e, com mais um, a previsao e de 10000 MB para 6656 MB disponiveis (RAM de 8192 MB menos a reserva de 1536 MB para o sistema e o DG Claw). O certo e aumentar a memoria da VPS ou criar outra VPS para este agente' "$TMP/saida.txt"
afirma "traz a dica do --mesmo-assim" grep -q 'dgclaw agente criar ad1 ... --mesmo-assim' "$TMP/saida.txt"
nega "nenhum container, rede ou casa" bash -c "grep -q '^podman create .*dgclaw-ad1\|^podman network create .*dgclaw-ad1' '$STUB_LOG' || test -e '$LIB/agentes/ad1'"
nega "nada no agentes.json" grep -q '"ad1"' "$ETC/agentes.json"
nega "nada reservado no registro" grep -q '^ad1' "$ETC/registro.tsv"
criar_agente ad1 --nome X --mesmo-assim
igual "com --mesmo-assim o criar termina com 0" "0" "$?"
afirma "o aviso traz os mesmos numeros e a responsabilidade" grep -q 'aviso.*previsao e de 10000 MB para 6656 MB disponiveis.*por sua conta e risco' "$TMP/saida.txt"
afirma "e o container foi criado" grep -q '^podman create .*--name dgclaw-ad1 ' "$STUB_LOG"
echo "agente ligado cujo uso nao deu para ler e risco: bloqueia e diz quem"
nova_raiz; maquina 8 2
criar_agente pri --nome X
touch "$STUB_ESTADO/uso-ilegivel"
criar_agente ad1 --nome X
nega "sem memory.current legivel o criar falha" test "$?" -eq 0
afirma "a mensagem diz quais nao foram lidos e por que" grep -q 'Nao consegui ler o uso de memoria de pri (agente ligado sem memory.current legivel' "$TMP/saida.txt"
afirma "com a dica do --mesmo-assim" grep -q 'dgclaw agente criar ad1 ... --mesmo-assim' "$TMP/saida.txt"
criar_agente ad1 --nome X --mesmo-assim
igual "com --mesmo-assim segue" "0" "$?"
afirma "e o aviso traz o mesmo texto" grep -q 'aviso.*Nao consegui ler o uso de memoria de pri.*por sua conta e risco' "$TMP/saida.txt"
rm -f "$STUB_ESTADO/uso-ilegivel"
echo "container criado e ainda nao ligado entra na previsao com a media; parado conta 0 e fora da media"
nova_raiz; maquina 8 2        # disponivel 6656
criar_agente pri --nome X
mb_bytes 3000 >"$STUB_ESTADO/uso-dgclaw-pri"
criar_agente ad1 --nome X
igual "pri 3000 + novo 3000 = 6000 <= 6656: passa" "0" "$?"
mb_bytes 3000 >"$STUB_ESTADO/uso-dgclaw-ad1"
echo created >"$STUB_ESTADO/c-dgclaw-ad1"
criar_agente ad2 --nome X
nega "ad1 so criado (entra com M = 3000): 3000 + 3000 + 3000 = 9000 > 6656, falha" test "$?" -eq 0
afirma "o texto diz que entrou na conta com a media" grep -q 'previsao e de 9000 MB para 6656 MB.*Os agentes ad1 foram criados e ainda nao ligaram, entao entraram na conta com a media de 3000 MB' "$TMP/saida.txt"
echo exited >"$STUB_ESTADO/c-dgclaw-ad1"
mb_bytes 9000 >"$STUB_ESTADO/uso-dgclaw-ad1"
criar_agente ad2 --nome X
igual "ad1 parado: conta 0 e nao entra na media (so o pri, 3000): passa" "0" "$?"
echo running >"$STUB_ESTADO/c-dgclaw-ad1"; rm -f "$STUB_ESTADO/uso-dgclaw-ad1"
echo "MemAvailable e o que o novo agente deve usar"
nova_raiz; maquina 16 4
criar_agente pri --nome X
mb_bytes 3000 >"$STUB_ESTADO/uso-dgclaw-pri"
printf 'MemTotal:       %d kB\nMemAvailable:   %d kB\n' "$((16 * 1024 * 1024))" "$((2000 * 1024))" >"$DGCLAW_RAIZ/proc/meminfo"
criar_agente ad1 --nome X
nega "M de 3000 MB com 2000 MB disponiveis: falha" test "$?" -eq 0
afirma "o texto diz o MemAvailable" grep -q 'MemAvailable) e de 2000 MB, menos que os 3000 MB que o novo agente e os 0 ainda nao ligados devem usar (1 x a media de 3000 MB)' "$TMP/saida.txt"
printf 'MemTotal:       %d kB\nMemAvailable:   %d kB\n' "$((16 * 1024 * 1024))" "$((8000 * 1024))" >"$DGCLAW_RAIZ/proc/meminfo"
criar_agente ad1 --nome X
igual "com 8000 MB disponiveis passa" "0" "$?"
echo "agentes criados e ainda nao ligados entram no MemAvailable: M x (pendentes + 1)"
nova_raiz; maquina 16 4
criar_agente pri --nome X
printf 'MemTotal:       %d kB\nMemAvailable:   %d kB\n' "$((16 * 1024 * 1024))" "$((5000 * 1024))" >"$DGCLAW_RAIZ/proc/meminfo"
mb_bytes 1000 >"$STUB_ESTADO/uso-dgclaw-pri"
printf 'MemTotal:       %d kB\nMemAvailable:   %d kB\n' "$((16 * 1024 * 1024))" "$((8000 * 1024))" >"$DGCLAW_RAIZ/proc/meminfo"
criar_agente adp --nome X
echo created >"$STUB_ESTADO/c-dgclaw-adp"
mb_bytes 3000 >"$STUB_ESTADO/uso-dgclaw-pri"
printf 'MemTotal:       %d kB\nMemAvailable:   %d kB\n' "$((16 * 1024 * 1024))" "$((5000 * 1024))" >"$DGCLAW_RAIZ/proc/meminfo"
criar_agente adq --nome X
nega "M 3000 x 2 = 6000 > 5000 MB disponiveis: falha" test "$?" -eq 0
afirma "o texto diz o calculo com os pendentes" grep -q 'menos que os 6000 MB que o novo agente e os 1 ainda nao ligados devem usar (2 x a media de 3000 MB)' "$TMP/saida.txt"
echo "container parado conta 0"
nova_raiz; maquina 8 2
criar_agente pri --nome X
mb_bytes 9000 >"$STUB_ESTADO/uso-dgclaw-pri"; echo exited >"$STUB_ESTADO/c-dgclaw-pri"
criar_agente ad2 --nome X
igual "pri parado com memory.current alto: nao conta, o criar passa" "0" "$?"
echo running >"$STUB_ESTADO/c-dgclaw-pri"
echo "sem a RAM total (sem MemTotal) o criar de um adicional e risco: precisa de --mesmo-assim"
rm -f "$DGCLAW_RAIZ/proc/meminfo"
criar_agente ad3 --nome X
nega "sem meminfo: falha" test "$?" -eq 0
afirma "o texto diz que nao leu a RAM total" grep -q 'nao consegui ler a RAM total da maquina (MemTotal em /proc/meminfo)' "$TMP/saida.txt"
criar_agente ad3 --nome X --mesmo-assim
igual "com --mesmo-assim passa" "0" "$?"
echo "VPS pequena demais (RAM - reserva abaixo de 2048 MB) e risco"
nova_raiz; maquina 2 1
criar_agente p2 --nome X
igual "o principal passa" "0" "$?"
criar_agente a2 --nome X
nega "o adicional falha" test "$?" -eq 0
afirma "o texto diz que a VPS e pequena demais para mais de um agente" grep -q 'a VPS e pequena demais para mais de um agente: tem 2048 MB de RAM.*sobram 512 MB' "$TMP/saida.txt"
criar_agente a2 --nome X --mesmo-assim
igual "com --mesmo-assim passa" "0" "$?"
echo "so pula a conferencia quando o proprio container ja esta ligado"
nova_raiz; maquina 8 2
criar_agente pri --nome X; criar_agente adr --nome X
mb_bytes 5000 >"$STUB_ESTADO/uso-dgclaw-pri"
criar_agente adr --nome X
igual "ligado: o criar de novo pula a conferencia" "0" "$?"
echo exited >"$STUB_ESTADO/c-dgclaw-adr"
criar_agente adr --nome X
nega "parado: confere normalmente (e falha, 5000 + 5000 > 6656)" test "$?" -eq 0
afirma "dizendo os numeros sem contar o proprio agente" grep -q 'os 1 agentes usam hoje 5000 MB' "$TMP/saida.txt"
rm -f "$STUB_ESTADO/uso-dgclaw-pri"
maquina 8 2
echo "recriar e reparar nunca sao barrados pela conferencia"
nova_raiz; maquina 8 2
criar_agente pri --nome X; criar_agente ad2 --nome X
echo imagem-nova-r1 >"$STUB_ESTADO/imagem-id"
mb_bytes 9000 >"$STUB_ESTADO/uso-dgclaw-ad2"
dgclaw agente recriar ad2 --forcar >"$TMP/rec.txt" 2>&1
igual "recriar com a maquina cheia termina com 0" "0" "$?"
nega "e nao fala em risco de memoria" grep -q 'fica no limite de memoria' "$TMP/rec.txt"
dgclaw agente reparar ad2 >"$TMP/rep.txt" 2>&1
igual "reparar com a maquina cheia termina com 0" "0" "$?"
nega "e nao fala em risco de memoria" grep -q 'fica no limite de memoria' "$TMP/rep.txt"
rm -f "$STUB_ESTADO"/uso-*

echo "recriar nunca reduz a memoria de um agente que ja existe"
nova_raiz; maquina 8 2        # calculado: 6656m
criar_agente pri --nome X; criar_agente ad1 --nome X
echo imagem-nova-n1 >"$STUB_ESTADO/imagem-id"
echo "$(mb_bytes 10240) 100000 100000 4096" >"$STUB_ESTADO/lim-dgclaw-ad1"
: >"$STUB_LOG"; dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
igual "atual 10240 MB, maior que o calculado: o container novo fica com 10240m" "10240m" "$(limite_criado ad1 | cut -d' ' -f1)"
afirma "o texto diz que manteve" grep -q 'mantido o limite atual de 10240 MB, maior que o calculado (6656 MB); o DG Claw nunca reduz o limite de um agente que ja existe' "$TMP/rec.txt"
afirma "e o memory.high parte do limite mantido (75% de 10240 MB)" grep -q -- "memory.high=$((10240 * 1048576 * 75 / 100))" <<<"$(create_de ad1)"
echo "$(mb_bytes 3072) 100000 100000 4096" >"$STUB_ESTADO/lim-dgclaw-ad1"
echo imagem-nova-n2 >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
igual "atual 3072 MB, menor que o calculado: sobe para 6656m" "6656m" "$(limite_criado ad1 | cut -d' ' -f1)"
nega "e nao diz que manteve" grep -q 'mantido o limite atual' "$TMP/rec.txt"
echo "$(mb_bytes 10240) 100000 100000 4096" >"$STUB_ESTADO/lim-dgclaw-pri"
echo imagem-nova-n3 >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar pri --forcar >"$TMP/rec.txt" 2>&1
igual "o principal tambem nao e reduzido" "10240m" "$(limite_criado pri | cut -d' ' -f1)"
afirma "e a garantia continua dentro do limite" grep -q -- '--memory-reservation 3328m ' <<<"$(create_de pri)"
echo "a sobrescrita do dono vence o 'nunca reduz'"
echo "$(mb_bytes 10240) 100000 100000 4096" >"$STUB_ESTADO/lim-dgclaw-ad1"
echo imagem-nova-n4 >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; DGCLAW_CONTAINER_MEMORIA=4g dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
igual "4g escolhido vale, mesmo menor que o atual" "4g" "$(limite_criado ad1 | cut -d' ' -f1)"
nega "e nao diz que manteve" grep -q 'mantido o limite atual' "$TMP/rec.txt"
echo "container sem limite continua sem limite, e avisa"
echo "0 100000 100000 4096" >"$STUB_ESTADO/lim-dgclaw-ad1"
echo imagem-nova-n5 >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
nega "o create nao leva --memory" grep -q -- '--memory ' <<<"$(create_de ad1)"
nega "nem memory.high (sem teto, nada a 75%)" grep -q -- 'memory.high' <<<"$(create_de ad1)"
afirma "o aviso diz que esta sem teto e como por um (DGCLAW_CONTAINER_MEMORIA)" grep -q 'aviso.*esta sem limite de memoria.*DGCLAW_CONTAINER_MEMORIA' "$TMP/rec.txt"
echo "container parado: o HostConfig.Memory guardado vale"
echo "$(mb_bytes 10240) 100000 100000 4096" >"$STUB_ESTADO/lim-dgclaw-ad1"
rm -rf "$DGCLAW_RAIZ/sys/fs/cgroup"   # o cgroup falso da rodada anterior ficaria ali
echo exited >"$STUB_ESTADO/c-dgclaw-ad1"; touch "$STUB_ESTADO/cgroup-ausente" "$STUB_ESTADO/memoria-persistida"
: >"$STUB_LOG"; dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
igual "parado com 10240 MB persistidos: mantido" "10240m" "$(limite_criado ad1 | cut -d' ' -f1)"
rm -f "$STUB_ESTADO/cgroup-ausente" "$STUB_ESTADO/memoria-persistida"
echo "memory.max do cgroup vale mesmo sem memory.swap.max; HostConfig.Memory (valor da criacao) menor nao reduz"
echo "$(mb_bytes 10240) 100000 100000 4096" >"$STUB_ESTADO/lim-dgclaw-ad1"
echo running >"$STUB_ESTADO/c-dgclaw-ad1"; rm -rf "$DGCLAW_RAIZ/sys/fs/cgroup"
touch "$STUB_ESTADO/cgroup-sem-swap"; mb_bytes 2048 >"$STUB_ESTADO/hostconfig-mem-dgclaw-ad1"
echo imagem-nova-a1 >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
igual "cgroup 10 GiB, HostConfig 2 GiB, sem swap.max: mantem 10240m" "10240m" "$(limite_criado ad1 | cut -d' ' -f1)"
rm -f "$STUB_ESTADO/cgroup-sem-swap" "$STUB_ESTADO/hostconfig-mem-dgclaw-ad1"
echo "container parado com HostConfig.Memory ilegivel: o recriar falha antes de mexer em qualquer coisa"
echo exited >"$STUB_ESTADO/c-dgclaw-ad1"; rm -rf "$DGCLAW_RAIZ/sys/fs/cgroup"; touch "$STUB_ESTADO/cgroup-ausente"
echo imagem-nova-a2 >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
nega "o recriar falha" test "$?" -eq 0
afirma "diz que nao leu o HostConfig.Memory do container parado e que nada foi mexido" grep -q 'nao consegui ler o limite de memoria atual do container parado dgclaw-ad1 (HostConfig.Memory do podman).*o container nao foi parado, removido nem recriado' "$TMP/rec.txt"
nega "nenhum stop, rm, create nem kill" grep -q '^podman stop\|^podman rm\|^podman create\|^podman kill' "$STUB_LOG"
: >"$STUB_LOG"; DGCLAW_CONTAINER_MEMORIA=4g dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
igual "com DGCLAW_CONTAINER_MEMORIA o recriar segue" "0" "$?"
rm -f "$STUB_ESTADO/cgroup-ausente"
echo "container exists com erro (125): falha antes de mexer em qualquer coisa; so o codigo 1 (ausente) libera"
echo imagem-nova-a2b >"$STUB_ESTADO/imagem-id"
touch "$STUB_ESTADO/exists-erro"
: >"$STUB_LOG"; dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
nega "o recriar falha" test "$?" -eq 0
afirma "diz o codigo e que nada foi mexido" grep -q 'nao consegui saber se o container dgclaw-ad1 existe (podman container exists terminou com codigo 125).*o container nao foi parado, removido nem recriado' "$TMP/rec.txt"
nega "nenhum stop, rm, create nem kill" grep -q '^podman stop\|^podman rm\|^podman create\|^podman kill' "$STUB_LOG"
: >"$STUB_LOG"; DGCLAW_CONTAINER_MEMORIA=4g dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
igual "com DGCLAW_CONTAINER_MEMORIA o recriar segue" "0" "$?"
rm -f "$STUB_ESTADO/exists-erro"
echo "container ligado com memory.max ilegivel: o recriar para antes de mexer em qualquer coisa"
echo running >"$STUB_ESTADO/c-dgclaw-ad1"; rm -rf "$DGCLAW_RAIZ/sys/fs/cgroup"; touch "$STUB_ESTADO/cgroup-ausente" "$STUB_ESTADO/memoria-persistida"
echo "$(mb_bytes 1024) 100000 100000 4096" >"$STUB_ESTADO/lim-dgclaw-ad1"
echo imagem-nova-a3 >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
nega "o recriar falha" test "$?" -eq 0
afirma "diz que nao leu o limite atual e que nada foi mexido" grep -q 'nao consegui ler o limite de memoria atual do container dgclaw-ad1.*esta running.*o container nao foi parado, removido nem recriado' "$TMP/rec.txt"
afirma "com a saida: DGCLAW_CONTAINER_MEMORIA ou podman inspect" grep -q 'defina DGCLAW_CONTAINER_MEMORIA.*podman inspect dgclaw-ad1.*rode de novo' "$TMP/rec.txt"
nega "nenhum stop, rm nem create" grep -q '^podman stop\|^podman rm\|^podman create\|^podman kill' "$STUB_LOG"
: >"$STUB_LOG"; DGCLAW_CONTAINER_MEMORIA=4g dgclaw agente recriar ad1 --forcar >"$TMP/rec.txt" 2>&1
igual "com DGCLAW_CONTAINER_MEMORIA o recriar segue" "0" "$?"
rm -f "$STUB_ESTADO/cgroup-ausente" "$STUB_ESTADO/memoria-persistida"

echo "reparar: so 1024 a 2048 MiB e padrao antigo; abaixo de 1024 MiB e escolha do dono"
nova_raiz; maquina 8 2
criar_agente pri --nome X; criar_agente ad --nome X
echo "$(mb_bytes 768) 100000 100000 4096 $(mb_bytes 1536)" >"$STUB_ESTADO/lim-dgclaw-ad"
: >"$STUB_LOG"; dgclaw agente reparar ad >"$TMP/rep.txt" 2>&1
nega "768 MiB fica como esta" grep -q '^podman update.*--memory' "$STUB_LOG"
afirma "e diz que foi mantido" grep -q 'mantido: memoria em 0.8 GB' "$TMP/rep.txt"
echo "1024 MiB (o piso dos adicionais do #147) sobe"
echo "$(mb_bytes 1024) 100000 100000 4096 $(mb_bytes 2048)" >"$STUB_ESTADO/lim-dgclaw-ad"
: >"$STUB_LOG"; dgclaw agente reparar ad >"$TMP/rep.txt" 2>&1
afirma "sobe para 6656m" grep -q -- '--memory=6656m' "$STUB_LOG"

echo "reparar: padrao antigo so em MiB inteiros; o principal so aceita 2 GiB exatos"
nova_raiz; maquina 16 4
criar_agente pri --nome X; criar_agente ad --nome X
echo "$(mb_bytes 1536) 100000 100000 4096 $(mb_bytes 3072)" >"$STUB_ESTADO/lim-dgclaw-pri"
: >"$STUB_LOG"; dgclaw agente reparar pri >"$TMP/rep.txt" 2>&1
nega "principal com 1536 MiB: mantido" grep -q '^podman update.*--memory' "$STUB_LOG"
echo "$(mb_bytes 2048) 100000 100000 4096 $(mb_bytes 4096)" >"$STUB_ESTADO/lim-dgclaw-pri"
: >"$STUB_LOG"; dgclaw agente reparar pri >"$TMP/rep.txt" 2>&1
afirma "principal com 2048 MiB exatos: sobe" grep -q '^podman update.*--memory=13927m' "$STUB_LOG"
echo "$(( $(mb_bytes 1536) + 4096 )) 100000 100000 4096 $(mb_bytes 3072)" >"$STUB_ESTADO/lim-dgclaw-ad"
: >"$STUB_LOG"; dgclaw agente reparar ad >"$TMP/rep.txt" 2>&1
nega "adicional com 1536 MiB + 4096 bytes: mantido" grep -q '^podman update.*--memory' "$STUB_LOG"
echo "$(mb_bytes 1536) 100000 100000 4096 $(mb_bytes 3072)" >"$STUB_ESTADO/lim-dgclaw-ad"
: >"$STUB_LOG"; dgclaw agente reparar ad >"$TMP/rep.txt" 2>&1
afirma "adicional com 1536 MiB: sobe" grep -q '^podman update.*--memory=13927m' "$STUB_LOG"

echo "numeros de slug parecidos (01 e 001) nao se confundem no awk"
nova_raiz; maquina 8 2
criar_agente pri --nome X; criar_agente 001 --nome X; criar_agente 01 --nome X
printf '001\talta\n' >"$ETC/prioridades"; chmod 600 "$ETC/prioridades"
dgclaw agente prioridade 01 baixa >/dev/null 2>&1
igual "gravar o 01 preserva a linha do 001" "$(printf '001\talta\n01\tbaixa\n')" "$(cat "$ETC/prioridades")"
dgclaw agente prioridade 001 >"$TMP/pri.txt" 2>&1
afirma "a leitura do 001 nao devolve o nivel do 01" grep -q 'agente 001: alta' "$TMP/pri.txt"
dgclaw agente prioridade 01 >"$TMP/pri.txt" 2>&1
afirma "e a do 01 devolve o dele" grep -q 'agente 01: baixa' "$TMP/pri.txt"

echo "consulta mostra o que o podman registrou e se bate com o papel atual"
nova_raiz; maquina 8 2
criar_agente pri --nome X; criar_agente ad --nome X
dgclaw agente prioridade pri >"$TMP/pri.txt" 2>&1
afirma "principal: mostra oom, reservation e cgroup-parent registrados" grep -q 'O podman registrou para dgclaw-pri: oom_score_adj -900, memory-reservation 3489660928 bytes, cgroup-parent "dgclaw_principal.slice"' "$TMP/pri.txt"
afirma "e diz que bate" grep -q 'Isso bate com o papel atual do agente' "$TMP/pri.txt"
afirma "para aplicar: recriar --forcar com o cuidado do --forcar" grep -q 'Para aplicar: dgclaw agente recriar pri --forcar (o --forcar pula a conferencia' "$TMP/pri.txt"
nega "nao recomenda mais o reparar para conferir" grep -q 'reparar' "$TMP/pri.txt"
echo "0|0||" >"$STUB_ESTADO/prio-dgclaw-pri"
dgclaw agente prioridade pri >"$TMP/pri.txt" 2>&1
afirma "sem as protecoes: diz que NAO bate e o esperado" grep -q 'Isso NAO bate com o papel atual do agente (esperado: oom_score_adj -900, memory-reservation de 3328 MB (3489660928 bytes) e cgroup-parent dgclaw_principal.slice)' "$TMP/pri.txt"
dgclaw agente reparar pri >"$TMP/rep.txt" 2>&1
afirma "o reparar continua dando o info de protecoes faltantes" grep -q 'ainda nao tem as protecoes de memoria do papel atual do agente pri' "$TMP/rep.txt"
echo "-900|1048576000|dgclaw_principal.slice|" >"$STUB_ESTADO/prio-dgclaw-pri"
dgclaw agente prioridade pri >"$TMP/pri.txt" 2>&1
afirma "reserva antiga diferente: NAO bate" grep -q 'Isso NAO bate' "$TMP/pri.txt"
afirma "e mostra os dois valores" grep -q 'Registrado: memory-reservation 1048576000 bytes; esperado: 3489660928 bytes' "$TMP/pri.txt"
dgclaw agente reparar pri >"$TMP/rep.txt" 2>&1
afirma "o info do reparar tambem dispara com a reserva antiga" grep -q 'ainda nao tem as protecoes de memoria do papel atual do agente pri' "$TMP/rep.txt"
dgclaw agente prioridade ad >"$TMP/pri.txt" 2>&1
afirma "adicional que bate: mostra e nao pede recriar" bash -c "grep -q 'Isso bate' '$TMP/pri.txt' && ! grep -q 'Para aplicar' '$TMP/pri.txt'"
touch "$STUB_ESTADO/inspect-limites-falha"
dgclaw agente prioridade ad >"$TMP/pri.txt" 2>&1
afirma "inspect que falha: diz que nao conseguiu ler" grep -q 'Nao consegui ler o que o podman registrou para o container dgclaw-ad' "$TMP/pri.txt"
rm -f "$STUB_ESTADO/inspect-limites-falha"

echo "sobrescrita vence para qualquer agente"
nova_raiz; maquina 8 2
DGCLAW_CONTAINER_MEMORIA=3g DGCLAW_CONTAINER_CPUS=1.5 criar_agente ov --nome X
igual "principal: memoria e CPUs da variavel" "3g 1.5 4096" "$(limite_criado ov)"
afirma "a garantia nao passa do limite aplicado (3072m)" grep -q -- '--memory-reservation 3072m ' <<<"$(create_de ov)"
nega "cabe: sem aviso" grep -q 'aviso' "$TMP/saida.txt"
DGCLAW_CONTAINER_MEMORIA=3g criar_agente ov1 --nome X
igual "adicional: a variavel vence o calculo" "3g 1.8 4096" "$(limite_criado ov1)"
DGCLAW_CONTAINER_MEMORIA=7g criar_agente ov2 --nome X
igual "adicional: 7g tambem vale" "7g" "$(limite_criado ov2 | cut -d' ' -f1)"
nega "e nao avisa de excesso da soma dos tetos (ela nao faz mais sentido)" grep -q 'soma dos limites' "$TMP/saida.txt"
nova_raiz; maquina 8 2
DGCLAW_CONTAINER_CPUS=3 criar_agente ov3 --nome X
igual "so CPUs sobrescritas, memoria calculada (principal)" "6656m 3.0 4096" "$(limite_criado ov3)"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_CONTAINER_MEMORIA=5g\nOUTRA=linha\n' >"$ETC/dgclaw.env"
criar_agente ov4 --nome X
igual "a variavel tambem vale quando vem do dgclaw.env" "5g" "$(limite_criado ov4 | cut -d' ' -f1)"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"
DGCLAW_CONTAINER_MEMORIA=abc criar_agente ruim --nome X
nega "memoria invalida faz o criar falhar" test "$?" -eq 0
afirma "e a mensagem diz o que fazer" grep -q 'O que fazer: corrija a linha' "$TMP/saida.txt"
DGCLAW_CONTAINER_CPUS=0 criar_agente ruim2 --nome X
nega "CPUs zero faz o criar falhar" test "$?" -eq 0

echo "o principal e o de menor numero no registro, nao o primeiro do agentes.json"
nova_raiz; maquina 8 2
criar_agente aa --nome X; criar_agente bb --nome X
igual "aa (n 1) e o principal" "6656m" "$(limite_criado aa | cut -d' ' -f1)"
afirma "bb e adicional" grep -q 'limites do container dgclaw-bb.*agente adicional' "$TMP/saida.txt"
# troca a ordem do agentes.json (aa vai para o fim, como agentes_registrar faz): a ordem do arquivo nao decide.
jq '.agentes |= (sort_by(.slug) | reverse)' "$ETC/agentes.json" >"$TMP/ag.json" && cp "$TMP/ag.json" "$ETC/agentes.json"
: >"$STUB_LOG"; echo imagem-nova-p >"$STUB_ESTADO/imagem-id"
dgclaw agente recriar aa --forcar >"$TMP/rec.txt" 2>&1
igual "recriar aa com o agentes.json em outra ordem: continua principal (6656m)" "6656m" "$(limite_criado aa | cut -d' ' -f1)"
afirma "o texto diz principal" grep -q 'agente principal' "$TMP/rec.txt"
echo "remover o principal passa o posto ao proximo menor numero"
dgclaw agente remover aa --sim >"$TMP/rem.txt" 2>&1
nega "aa saiu do agentes.json" jq -e '.agentes | map(.slug) | index("aa") != null' "$ETC/agentes.json"
: >"$STUB_LOG"; echo imagem-nova-q >"$STUB_ESTADO/imagem-id"
dgclaw agente recriar bb --forcar >"$TMP/rec.txt" 2>&1
igual "bb vira o principal e recria com 6656m" "6656m" "$(limite_criado bb | cut -d' ' -f1)"
afirma "o texto diz principal" grep -q 'dgclaw-bb.*agente principal' "$TMP/rec.txt"

nova_raiz; maquina 8 2; criar_agente a4 --nome X
echo "recriar usa o calculo (o principal a4, em 16 GB)"
maquina 16 4
echo imagem-nova-x >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"; dgclaw agente recriar a4 >"$TMP/rec.txt" 2>&1
igual "recriar cria com 16384 - 2457 = 13927m e 3.8 CPUs" "13927m 3.8 4096" "$(limite_criado a4)"

echo "reparar sobe o container antigo sem recriar"
maquina 8 2
echo "2147483648 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a4"   # criado antes: 2 GB, 1.0 CPU, 1024 processos (o padrao antigo)
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "rodou o podman update com memoria, swap (mesma folga de 2 GB do container), CPUs e processos" grep -q '^podman update --memory-swap=9126805504 --memory=6656m --cpus=1.8 --pids-limit=4096 idfalso-dgclaw-a4' "$STUB_LOG"
nega "nao recriou" grep -q '^podman create\|^podman rm' "$STUB_LOG"
afirma "mostra o antes" grep -q 'antes:  memoria 2.0 GB, CPUs 1.0, processos 1024' "$TMP/rep.txt"
afirma "mostra o depois" grep -q 'depois: memoria 6.5 GB, CPUs 1.8, processos 4096' "$TMP/rep.txt"

echo "reparar sobe principal e adicional do padrao antigo, e conta das protecoes que faltam"
nova_raiz; maquina 8 2
criar_agente pri --nome X; criar_agente ad --nome X
echo "2147483648 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-pri"
echo "2147483648 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-ad"
: >"$STUB_LOG"; dgclaw agente reparar pri >"$TMP/rep.txt" 2>&1
afirma "o principal sobe para 6656m" grep -q '^podman update --memory-swap=9126805504 --memory=6656m' "$STUB_LOG"
afirma "o texto manda recriar para sobreviver ao reinicio (vale para todos)" grep -q 'o podman nao guarda o ajuste de memoria do agente pri.*dgclaw agente recriar pri --forcar' "$TMP/rep.txt"
: >"$STUB_LOG"; dgclaw agente reparar ad >"$TMP/rep.txt" 2>&1
afirma "o adicional tambem sobe para 6656m" grep -q '^podman update --memory-swap=9126805504 --memory=6656m' "$STUB_LOG"
afirma "e o log mostra o papel dele" grep -q 'agente adicional' "$TMP/rep.txt"
afirma "o texto de reinicio vale tambem para ele" grep -q 'o podman nao guarda o ajuste de memoria do agente ad.*dgclaw agente recriar ad --forcar' "$TMP/rep.txt"
nega "container que ja tem as protecoes: sem info de protecoes" grep -q 'ainda nao tem as protecoes' "$TMP/rep.txt"
echo "container sem as protecoes do papel atual: so um info, o reparar nao mexe"
echo "0|0||" >"$STUB_ESTADO/prio-dgclaw-pri"
: >"$STUB_LOG"; dgclaw agente reparar pri >"$TMP/rep.txt" 2>&1
afirma "principal: diz que as protecoes entram com o recriar --forcar" grep -q 'ainda nao tem as protecoes de memoria do papel atual do agente pri (principal, protegido).*dgclaw agente recriar pri --forcar' "$TMP/rep.txt"
nega "e o reparar nao rodou update de oom, reservation nem cgroup" grep -q '^podman update.*\(oom\|reservation\|cgroup\)' "$STUB_LOG"
echo "0|0||" >"$STUB_ESTADO/prio-dgclaw-ad"
dgclaw agente reparar ad >"$TMP/rep.txt" 2>&1
afirma "adicional: o oom de 300 que falta entra no mesmo aviso" grep -q 'ainda nao tem as protecoes de memoria do papel atual do agente ad (adicional, prioridade normal)' "$TMP/rep.txt"
echo "reparar sobe o valor que o #147 deu a um adicional, e mantem a escolha do dono"
nova_raiz; maquina 16 4
criar_agente pri --nome X; criar_agente ad --nome X
echo "$(mb_bytes 1639) 380000 100000 4096 $(mb_bytes 3278)" >"$STUB_ESTADO/lim-dgclaw-ad"
: >"$STUB_LOG"; dgclaw agente reparar ad >"$TMP/rep.txt" 2>&1
afirma "1639 MiB (<= 2048 e abaixo do calculado) conta como padrao antigo e sobe para 13927m" grep -q "^podman update --memory-swap=$((13927 * 1048576 + 1639 * 1048576)) --memory=13927m" "$STUB_LOG"
echo "$(mb_bytes 2048) 380000 100000 4096 $(mb_bytes 4096)" >"$STUB_ESTADO/lim-dgclaw-ad"
: >"$STUB_LOG"; dgclaw agente reparar ad >"$TMP/rep.txt" 2>&1
afirma "2048 MiB tambem" grep -q -- '--memory=13927m' "$STUB_LOG"
echo "$(mb_bytes 3072) 380000 100000 4096 $(mb_bytes 6144)" >"$STUB_ESTADO/lim-dgclaw-ad"
: >"$STUB_LOG"; dgclaw agente reparar ad >"$TMP/rep.txt" 2>&1
nega "3 GiB e escolha do dono: nao entra no update" grep -q '^podman update' "$STUB_LOG"
afirma "o log diz que manteve e que o padrao antigo e de ate 2 GB" grep -q 'mantido: memoria em 3.0 GB no container dgclaw-ad.*memoria de 1 a 2 GB.*escolha do dono' "$TMP/rep.txt"
afirma "o limite continua em 3 GiB" grep -q "^$(mb_bytes 3072) " "$STUB_ESTADO/lim-dgclaw-ad"
nova_raiz; maquina 8 2; criar_agente a4 --nome X

nova_raiz; maquina 8 2; criar_agente a4 --nome X

echo "reparar nunca reduz o que a pessoa aumentou"
echo "17179869184 400000 100000 8192" >"$STUB_ESTADO/lim-dgclaw-a4"   # 16 GB, 4 CPUs, 8192 processos
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "nenhum podman update" grep -q '^podman update' "$STUB_LOG"
afirma "avisa que nada mudou" grep -q 'nada foi mudado' "$TMP/rep.txt"
echo "8589934592 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-a4"   # 8 GB (acima de 6,5), CPUs abaixo, processos abaixo
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "memoria acima do calculado nao entra no update" grep -q '^podman update.*--memory' "$STUB_LOG"
afirma "CPUs e processos sobem" grep -q '^podman update --cpus=1.8 --pids-limit=4096 idfalso-dgclaw-a4' "$STUB_LOG"
afirma "a memoria ficou em 8 GB" grep -q '^8589934592 ' "$STUB_ESTADO/lim-dgclaw-a4"
echo "0 0 100000 0" >"$STUB_ESTADO/lim-dgclaw-a4"   # tudo sem limite (max)
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "sem limite (max): o reparar termina com 0" "0" "$?"
nega "sem limite nunca vira teto finito: nenhum podman update" grep -q '^podman update' "$STUB_LOG"
afirma "o antes mostra tudo sem limite" grep -q 'antes:  memoria sem limite, CPUs sem limite, processos sem limite' "$TMP/rep.txt"
afirma "e continua tudo sem limite no cgroup" grep -q '^0 0 ' "$STUB_ESTADO/lim-dgclaw-a4"

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
: >"$STUB_LOG"; DGCLAW_CONTAINER_MEMORIA=4GB dgclaw agente recriar a4 --forcar >"$TMP/rec.txt" 2>&1
nega "memoria invalida faz o recriar falhar" test "$?" -eq 0
afirma "a mensagem cita a variavel" grep -q 'DGCLAW_CONTAINER_MEMORIA' "$TMP/rec.txt"
nega "o podman nao recebeu stop, rm nem create" grep -q '^podman stop\|^podman rm\|^podman create\|^podman kill' "$STUB_LOG"

echo "CPU sem limite (-1) e processos no padrao antigo (1024): so o que e finito sobe; o sem limite fica como esta"
echo "2147483648 -1 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "quota -1 nao derruba a leitura: sobem memoria e processos, sem --cpus" grep -q '^podman update --memory-swap=9126805504 --memory=6656m --pids-limit=4096 idfalso-dgclaw-a4' "$STUB_LOG"
nega "CPUs sem limite nao entram no update" grep -q '^podman update.*--cpus' "$STUB_LOG"
afirma "mostra o antes com CPUs sem limite" grep -q 'antes:  memoria 2.0 GB, CPUs sem limite, processos 1024' "$TMP/rep.txt"
afirma "e as CPUs continuam sem limite depois" grep -q '^6979321856 -1 ' "$STUB_ESTADO/lim-dgclaw-a4"
echo "2147483648 -1 100000 -1 -1" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "pids -1 e swap -1 leem sem erro; so a memoria sobe, com swap ilimitado" grep -q '^podman update --memory-swap=-1 --memory=6656m idfalso-dgclaw-a4' "$STUB_LOG"
nega "processos sem limite nao entram no update" grep -q '^podman update.*--pids-limit' "$STUB_LOG"

echo "memoria sem limite e processos sem limite (max) nao sao mexidos; pids.max=0 literal e teto finito"
maquina 8 2
echo "0 100000 100000 0 0" >"$STUB_ESTADO/lim-dgclaw-a4"   # memoria e processos sem limite (max), CPUs 1.0
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "o reparar termina com 0" "0" "$?"
afirma "so as CPUs (finitas, padrao antigo) sobem" grep -q '^podman update --cpus=1.8 idfalso-dgclaw-a4' "$STUB_LOG"
nega "memoria e processos sem limite nao entram no update" grep -q '^podman update.*\(--memory\|--pids-limit\)' "$STUB_LOG"
afirma "o cgroup continua com memoria e processos sem limite" grep -q '^0 180000 100000 0 ' "$STUB_ESTADO/lim-dgclaw-a4"
echo "2147483648 100000 100000 zero 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"   # pids.max = 0 literal (teto finito)
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "pids.max=0: o reparar termina com 0" "0" "$?"
afirma "0 literal aparece como 0, nao como sem limite" grep -q 'antes:  memoria 2.0 GB, CPUs 1.0, processos 0' "$TMP/rep.txt"
afirma "e e escolha do dono: mantido, fora do update" grep -q 'mantido: processos em 0 no container dgclaw-a4.*escolha do dono' "$TMP/rep.txt"
nega "o update nao leva --pids-limit" grep -q '^podman update.*--pids-limit' "$STUB_LOG"
afirma "o pids.max continua 0" grep -q '^6979321856 180000 100000 zero ' "$STUB_ESTADO/lim-dgclaw-a4"

echo "CPU arredonda para cima (so para exibir; fora do padrao antigo nao muda)"
echo "8589934592 5000 100000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a4"   # 0.05 CPU
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "0.05 CPU vira 0.1 e nao 'sem limite'" grep -q 'antes:  memoria 8.0 GB, CPUs 0.1, processos 4096' "$TMP/rep.txt"
nega "0.05 CPU e escolha do dono: nao sobe" grep -q '^podman update' "$STUB_LOG"
afirma "e o log diz que foi mantido e por que" grep -q 'mantido: CPUs em 0.1 no container dgclaw-a4.*escolha do dono' "$TMP/rep.txt"

echo "swap: a politica vigente e preservada"
echo "2147483648 100000 100000 4096 2147483648" >"$STUB_ESTADO/lim-dgclaw-a4"   # swap igual a memoria: sem swap
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "sem swap continua sem swap" grep -q '^podman update --memory-swap=6979321856 --memory=6656m --cpus=1.8 idfalso-dgclaw-a4' "$STUB_LOG"
echo "2147483648 100000 100000 4096 -1" >"$STUB_ESTADO/lim-dgclaw-a4"   # swap ilimitado
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "swap ilimitado continua ilimitado" grep -q '^podman update --memory-swap=-1 --memory=6656m --cpus=1.8 idfalso-dgclaw-a4' "$STUB_LOG"
echo "2147483648 100000 100000 4096 -1" >"$STUB_ESTADO/lim-dgclaw-a4"

echo "o atalho da imagem atual nao olha os limites"
maquina 8 2
echo imagem-estavel >"$STUB_ESTADO/imagem-id"
echo imagem-estavel >"$STUB_ESTADO/img-dgclaw-a4"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente recriar a4 >"$TMP/rec.txt" 2>&1
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
afirma "swap = memoria nova + swap atual" grep -q '^podman update --memory-swap=9126805504 --memory=6656m' "$STUB_LOG"
afirma "diz que vale para o container ligado e o definitivo vem na recriacao" grep -q 'vale para o container ligado.*proxima vez que o agente for recriado' "$TMP/rep.txt"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
touch "$STUB_ESTADO/update-sem-efeito"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "update que nao mudou nada: avisa depois de reler" grep -q 'continuou abaixo do calculado' "$TMP/rep.txt"
nega "e nao diz que aumentou" grep -q 'aumentados' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-sem-efeito"

echo "CPU: so o padrao antigo (1.0 exato) sobe; o resto e escolha do dono"
echo "8589934592 175000 100000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a4"   # 1.75 CPU, alvo 1.8
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "175000/100000 (1.75) nao e o padrao antigo: fica como esta" grep -q '^podman update' "$STUB_LOG"
afirma "e o resumo diz que nada foi mudado" grep -q 'nada foi mudado: os limites abaixo do calculado' "$TMP/rep.txt"
echo "8589934592 180000 100000 4096 17179869184" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "180000/100000 ja e o alvo" grep -q '^podman update' "$STUB_LOG"

echo "memoria da variavel abaixo de 512m e erro"
DGCLAW_CONTAINER_MEMORIA=256m dgclaw agente recriar a4 --forcar >"$TMP/rec.txt" 2>&1
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
afirma "o alvo vem das duas linhas literais (3g e 1.5, aspas tiradas)" grep -q '^podman update --memory-swap=5368709120 --memory=3072m --cpus=1.5 idfalso-dgclaw-a4' "$STUB_LOG"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"

echo "cada controlador e lido sozinho"
maquina 8 2
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"
: >"$STUB_LOG"; touch "$STUB_ESTADO/cgroup-sem-swap"
dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "sem memory.swap.max a memoria nao e tocada" grep -q '^podman update.*--memory' "$STUB_LOG"
afirma "processos sobem mesmo assim" grep -q '^podman update --cpus=1.8 --pids-limit=4096 idfalso-dgclaw-a4' "$STUB_LOG"
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
afirma "--memory-swap = memoria nova + 512 KiB, em bytes" grep -q "^podman update --memory-swap=$((6656 * 1048576 + 524288)) --memory=6656m" "$STUB_LOG"
afirma "o swap de 512 KiB foi conferido e mantido" grep -q "^$((6656 * 1048576)) .* $((6656 * 1048576 + 524288))\$" "$STUB_ESTADO/lim-dgclaw-a4"
nega "sem aviso de memoria abaixo" grep -q 'memoria do container dgclaw-a4 continuou abaixo' "$TMP/rep.txt"

echo "limite escolhido pelo dono fica como esta"
maquina 8 2
echo "3221225472 50000 100000 4096 6442450944" >"$STUB_ESTADO/lim-dgclaw-a4"   # 3 GiB e 0.5 CPU: escolha do dono
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "o reparar termina com 0" "0" "$?"
nega "nenhum podman update" grep -q '^podman update' "$STUB_LOG"
afirma "a memoria continua em 3 GiB e a CPU em 0.5" grep -q '^3221225472 50000 ' "$STUB_ESTADO/lim-dgclaw-a4"
afirma "o log diz que a memoria foi mantida e por que" grep -q 'mantido: memoria em 3.0 GB no container dgclaw-a4.*escolha do dono' "$TMP/rep.txt"
afirma "o log diz que as CPUs foram mantidas" grep -q 'mantido: CPUs em 0.5 no container dgclaw-a4' "$TMP/rep.txt"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"   # 2g, 1.0 e 1024: padrao antigo
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "o padrao antigo (2g, 1.0, 1024) sobe" grep -q '^podman update --memory-swap=9126805504 --memory=6656m --cpus=1.8 --pids-limit=4096 idfalso-dgclaw-a4' "$STUB_LOG"
echo "2147483648 100000 100000 2048 4294967296" >"$STUB_ESTADO/lim-dgclaw-a4"   # so os processos fora do padrao
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
afirma "cada recurso e julgado sozinho: memoria e CPUs sobem" grep -q '^podman update --memory-swap=9126805504 --memory=6656m --cpus=1.8 idfalso-dgclaw-a4' "$STUB_LOG"
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
afirma "reparar: alvo 4096m e 1.5" grep -q '^podman update --memory-swap=6442450944 --memory=4096m --cpus=1.5 --pids-limit=4096 idfalso-dgclaw-a4' "$STUB_LOG"
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
afirma "diz que nao tentou restaurar nem parou o container" grep -q 'O DG Claw NAO tentou restaurar o valor de antes e NAO parou o container' "$TMP/rep.txt"
# shellcheck disable=SC2016 # as crases fazem parte do texto procurado
afirma "manda recriar o agente com --forcar" grep -q 'recrie o agente: `dgclaw agente recriar a4 --forcar`' "$TMP/rep.txt"
# shellcheck disable=SC2016
afirma "avisa que o --forcar pula a conferencia de arquivos so do container" grep -q 'O --forcar pula a conferencia de arquivos que so existem dentro do container, entao copie para a casa do agente' "$TMP/rep.txt"
# shellcheck disable=SC2016
afirma "e manda conferir o teto com reparar" grep -q 'Depois confira o teto com `dgclaw agente reparar a4`' "$TMP/rep.txt"
# shellcheck disable=SC2016
afirma "e diz que repetir o reparo nao devolve o limite" grep -q 'dgclaw agente reparar a4` de novo nao devolve o limite' "$TMP/rep.txt"
nega "o container nao foi parado" grep -q '^podman stop' "$STUB_LOG"
nega "e o DG Claw nao tentou restaurar (so o update do alvo)" grep -q '^podman update --cpu-period' "$STUB_LOG"
rm -f "$STUB_ESTADO/update-cpu-vira-max"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
igual "a segunda chamada termina com 0" "0" "$?"
nega "e nao converte as CPUs sem limite em teto finito" grep -q '^podman update' "$STUB_LOG"
afirma "as CPUs continuam sem limite" grep -q '^6979321856 0 ' "$STUB_ESTADO/lim-dgclaw-a4"

echo "mudanca colateral de finito para finito: so CPU pedida, memoria personalizada muda"
maquina 8 2
echo "3221225472 100000 100000 4096 6442450944" >"$STUB_ESTADO/lim-dgclaw-a4"   # 3 GB (escolha do dono), CPUs no padrao antigo
touch "$STUB_ESTADO/update-cpu-mexe-mem"
: >"$STUB_LOG"; dgclaw agente reparar a4 >"$TMP/rep.txt" 2>&1
nega "o reparar termina com codigo diferente de zero" test "$?" -eq 0
afirma "e diz FALHA com valor anterior e observado" grep -q 'FALHA: a memoria do container dgclaw-a4 mudou sem ter sido pedida depois do podman update: valor anterior 3221225472 bytes, observado 4294967296 bytes' "$TMP/rep.txt"
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
afirma "reparar: export e espaco inicial valem" grep -q '^podman update --memory-swap=6442450944 --memory=4096m --cpus=1.5 --pids-limit=4096 idfalso-dgclaw-a4' "$STUB_LOG"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"

echo "principal com adicionais antigos: sem aviso de excesso, e o principal sobe sem ser reduzido"
nova_raiz; maquina 8 2
criar_agente pri --nome X; criar_agente ad1 --nome X; criar_agente ad2 --nome X; criar_agente ad3 --nome X
for a in pri ad1 ad2 ad3; do echo "2147483648 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-$a"; done
: >"$STUB_LOG"; dgclaw agente reparar pri >"$TMP/rep.txt" 2>&1
nega "nenhum aviso da soma dos tetos" grep -q 'soma dos tetos\|passa em' "$TMP/rep.txt"
afirma "o principal subiu para o maximo, sem ser reduzido" grep -q '^podman update --memory-swap=[0-9]* --memory=6656m' "$STUB_LOG"
echo "criar o primeiro agente nao avisa nada"
nova_raiz; maquina 8 2
criar_agente solo --nome X
nega "sem outros agentes: sem aviso" grep -q 'aviso' "$TMP/saida.txt"

echo "dois criar em sequencia: o container que ainda nao esta no agentes.json conta como existente"
nova_raiz; maquina 8 2
criar_agente pa --nome X
igual "pa e o principal" "6656m" "$(limite_criado pa | cut -d' ' -f1)"
# O primeiro criar parou no meio do caminho do ponto de vista do segundo: o container existe e o registro tem o numero, mas o
# agentes.json ainda nao tem o agente (ele entra no fim do criar).
jq '.agentes |= map(select(.slug != "pa"))' "$ETC/agentes.json" >"$TMP/ag.json" && cp "$TMP/ag.json" "$ETC/agentes.json"
nega "pa nao esta no agentes.json" jq -e '.agentes | map(.slug) | index("pa") != null' "$ETC/agentes.json"
criar_agente pb --nome X
afirma "o segundo e adicional, nao principal" grep -q 'limites do container dgclaw-pb.*agente adicional' "$TMP/saida.txt"
echo "agente removido (container sumiu) nao conta, mesmo com linha sobrando no registro"
nova_raiz; maquina 8 2
criar_agente pa --nome X
jq '.agentes |= map(select(.slug != "pa"))' "$ETC/agentes.json" >"$TMP/ag.json" && cp "$TMP/ag.json" "$ETC/agentes.json"
rm -f "$STUB_ESTADO/c-dgclaw-pa"
criar_agente pb --nome X
afirma "sem o container de pa, pb e o principal" grep -q 'limites do container dgclaw-pb.*agente principal' "$TMP/saida.txt"

echo "trava dos limites: pega do calculo ate o create, solta depois, e com ela ocupada o comando falha com a mensagem"
nova_raiz; maquina 8 2
rm -f "$STUB_ESTADO/fd6-aberto" "$STUB_ESTADO/fd7-aberto"
criar_agente ta --nome X
afirma "o criar termina normalmente" test -f "$ETC/travas/limites.lock"
afirma "a trava foi solta no fim (da para pegar sem esperar)" flock -n -x "$ETC/travas/limites.lock" true
nega "nenhuma chamada ao podman herdou o descritor 7 (o conmon seguraria a trava)" test -e "$STUB_ESTADO/fd7-aberto"
nega "nem o descritor 6" test -e "$STUB_ESTADO/fd6-aberto"
( flock -x "$ETC/travas/limites.lock" sleep 6 ) &
sleep 1
: >"$STUB_LOG"
DGCLAW_TRAVA_LIMITES_ESPERA=1 criar_agente tb --nome X
nega "com a trava ocupada o criar falha" test "$?" -eq 0
afirma "e a mensagem diz que a trava dos limites esta com outro comando" grep -q 'esta segurando a trava dos limites' "$TMP/saida.txt"
afirma "e o que fazer" grep -q 'O que fazer: espere o outro comando terminar' "$TMP/saida.txt"
nega "nada foi criado" grep -q '^podman create .*dgclaw-tb' "$STUB_LOG"
nega "nenhuma casa foi criada" test -e "$LIB/agentes/tb"
echo imagem-nova-t >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"
DGCLAW_TRAVA_LIMITES_ESPERA=1 dgclaw agente recriar ta --forcar >"$TMP/rec.txt" 2>&1
nega "com a trava ocupada o recriar falha" test "$?" -eq 0
afirma "com a mesma mensagem" grep -q 'esta segurando a trava dos limites' "$TMP/rec.txt"
nega "e nao parou nem removeu o container" grep -q '^podman stop\|^podman rm' "$STUB_LOG"
wait
: >"$STUB_LOG"
dgclaw agente recriar ta --forcar >"$TMP/rec.txt" 2>&1
igual "liberada a trava, o recriar termina com 0" "0" "$?"
afirma "e a trava fica solta no fim" flock -n -x "$ETC/travas/limites.lock" true
nega "o recriar tambem nao deixou o descritor 7 nem o 6 para o podman" test -e "$STUB_ESTADO/fd7-aberto" -o -e "$STUB_ESTADO/fd6-aberto"

echo "trava por agente: reparar e recriar do mesmo agente nao rodam juntos"
mkdir -p "$ETC/travas"
( flock -x "$ETC/travas/agentes/ta.lock" sleep 6 ) &
sleep 1
DGCLAW_TRAVA_AGENTE_ESPERA=1 dgclaw agente reparar ta >"$TMP/rep.txt" 2>&1
nega "reparar com a trava do agente ocupada falha" test "$?" -eq 0
afirma "com mensagem em portugues" grep -q "esta segurando .*travas/agentes/ta.lock ha mais de 1s" "$TMP/rep.txt"
afirma "e o que fazer" grep -q 'O que fazer: espere o outro comando terminar' "$TMP/rep.txt"
echo imagem-nova-u >"$STUB_ESTADO/imagem-id"
: >"$STUB_LOG"
DGCLAW_TRAVA_AGENTE_ESPERA=1 dgclaw agente recriar ta --forcar >"$TMP/rec.txt" 2>&1
nega "recriar com a trava do agente ocupada falha" test "$?" -eq 0
afirma "com a mesma mensagem" grep -q "esta segurando .*travas/agentes/ta.lock" "$TMP/rec.txt"
nega "e nao mexeu no container" grep -q '^podman stop\|^podman rm\|^podman create' "$STUB_LOG"
wait
: >"$STUB_LOG"
dgclaw agente recriar ta --forcar >"$TMP/rec.txt" 2>&1
igual "o recriar chama o reparar por dentro sem travar em si mesmo" "0" "$?"
afirma "e o reparar de dentro rodou" grep -q 'Conferindo os limites de memoria, CPU e processos' "$TMP/rec.txt"
afirma "a trava do agente solta no fim" flock -n -x "$ETC/travas/agentes/ta.lock" true
dgclaw agente reparar ta >"$TMP/rep.txt" 2>&1
igual "o reparar sozinho termina com 0" "0" "$?"
nega "nenhuma chamada ao podman herdou os descritores 6 e 7" test -e "$STUB_ESTADO/fd6-aberto" -o -e "$STUB_ESTADO/fd7-aberto"
nega "slug invalido nao vira nome de arquivo" test -e "$ETC/travas/..lock"

echo "o ID do container, nao o nome, guia o reparo; ID trocado no meio e FALHA"
maquina 8 2
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-ta"
: >"$STUB_LOG"; dgclaw agente reparar ta >"$TMP/rep.txt" 2>&1
igual "sem troca, o reparar termina com 0" "0" "$?"
afirma "o podman update vai para o ID e nao para o nome" grep -q '^podman update .* idfalso-dgclaw-ta$' "$STUB_LOG"
nega "e nenhum update foi pelo nome" grep -q '^podman update .* dgclaw-ta$' "$STUB_LOG"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-ta"
touch "$STUB_ESTADO/update-troca-id"
: >"$STUB_LOG"; dgclaw agente reparar ta >"$TMP/rep.txt" 2>&1
nega "ID que muda no meio: codigo diferente de zero" test "$?" -eq 0
afirma "a mensagem diz que o container foi trocado no meio do reparo e manda rodar de novo" grep -q 'FALHA: o container dgclaw-ta foi trocado no meio do reparo dos limites.*Rode de novo' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-troca-id" "$STUB_ESTADO/id-dgclaw-ta" "$STUB_ESTADO/update-feito"

echo "valor relido abaixo do que era antes e FALHA, sem restaurar (memoria, CPUs e processos)"
for caso in mem cpu pids; do
    case "$caso" in
        mem) nome_r="memoria"; cab="o limite de memoria do container dgclaw-ta ficou abaixo do que era antes do podman update (antes 2147483648 bytes, relido 1073741824 bytes)" ;;
        cpu) nome_r="CPUs"; cab="o limite de CPUs do container dgclaw-ta ficou abaixo do que era antes do podman update (antes cpu.max de 100000 a cada 100000, relido 50000 a cada 100000)" ;;
        pids) nome_r="processos"; cab="o limite de processos do container dgclaw-ta ficou abaixo do que era antes do podman update (antes 1024, relido 512)" ;;
    esac
    rm -f "$STUB_ESTADO/update-feito"
    echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-ta"
    touch "$STUB_ESTADO/update-$caso-menor"
    : >"$STUB_LOG"; dgclaw agente reparar ta >"$TMP/rep.txt" 2>&1
    igual "$caso: o codigo de saida e 1" "1" "$?"
    afirma "$caso: FALHA diz o antes e o relido" grep -q "FALHA: $cab" "$TMP/rep.txt"
    afirma "$caso: diz que nao tentou restaurar nem parou o container" grep -q 'O DG Claw NAO tentou restaurar o valor de antes e NAO parou o container' "$TMP/rep.txt"
    # shellcheck disable=SC2016 # as crases fazem parte do texto procurado
    afirma "$caso: manda recriar com --forcar e conferir com reparar" grep -q 'recriar ta --forcar`.*Depois confira o teto com `dgclaw agente reparar ta`' "$TMP/rep.txt"
    nega "$caso: nao aparece como subiu" grep -q "subiram em dgclaw-ta:.*$nome_r" "$TMP/rep.txt"
    nega "$caso: o container nao foi parado" grep -q '^podman stop' "$STUB_LOG"
    afirma "$caso: houve um unico podman update (sem restauracao)" test "$(grep -c '^podman update' "$STUB_LOG")" -eq 1
    rm -f "$STUB_ESTADO/update-$caso-menor" "$STUB_ESTADO/update-feito"
done
rm -f "$STUB_ESTADO/update-feito"
echo "menor que antes mas ainda acima do alvo nao existe; igual ao antes (update sem efeito) nao e reducao"
echo "2147483648 100000 100000 1024 4294967296" >"$STUB_ESTADO/lim-dgclaw-ta"
touch "$STUB_ESTADO/update-sem-efeito"
: >"$STUB_LOG"; dgclaw agente reparar ta >"$TMP/rep.txt" 2>&1
igual "update sem efeito: so aviso, codigo 0" "0" "$?"
nega "e nao fala em reducao" grep -q 'abaixo do que era antes' "$TMP/rep.txt"
rm -f "$STUB_ESTADO/update-sem-efeito" "$STUB_ESTADO/update-feito"

echo "permissao das travas: pasta 700 e arquivos 600, inclusive quando ja existiam abertos"
modo() { stat -c %a "$1"; }
nova_raiz; maquina 8 2
criar_agente pm --nome X
igual "depois de um criar: a pasta das travas e 700" "700" "$(modo "$ETC/travas")"
igual "a trava dos limites e 600" "600" "$(modo "$ETC/travas/limites.lock")"
dgclaw agente reparar pm >"$TMP/rep.txt" 2>&1
igual "depois de um reparar: a trava do agente e 600" "600" "$(modo "$ETC/travas/agentes/pm.lock")"
chmod 755 "$ETC/travas"; chmod 644 "$ETC/travas/limites.lock" "$ETC/travas/agentes/pm.lock"
ino_l="$(stat -c %i "$ETC/travas/limites.lock")"; ino_p="$(stat -c %i "$ETC/travas/agentes/pm.lock")"
dgclaw agente reparar pm >"$TMP/rep.txt" 2>&1
igual "pasta aberta que ja existia volta para 700" "700" "$(modo "$ETC/travas")"
igual "trava do agente aberta volta para 600" "600" "$(modo "$ETC/travas/agentes/pm.lock")"
igual "e o arquivo e o mesmo (inode), nao foi recriado" "$ino_p" "$(stat -c %i "$ETC/travas/agentes/pm.lock")"
echo imagem-nova-m >"$STUB_ESTADO/imagem-id"
dgclaw agente recriar pm --forcar >"$TMP/rec.txt" 2>&1
igual "o recriar termina com 0" "0" "$?"
igual "trava dos limites aberta que ja existia volta para 600" "600" "$(modo "$ETC/travas/limites.lock")"
igual "e o arquivo e o mesmo (inode)" "$ino_l" "$(stat -c %i "$ETC/travas/limites.lock")"
rm -f "$ETC/travas/limites.lock"; chmod 755 "$ETC/travas"
criar_agente pn --nome X
igual "criar sem o arquivo e com a pasta aberta: arquivo novo 600" "600" "$(modo "$ETC/travas/limites.lock")"
igual "e a pasta vira 700" "700" "$(modo "$ETC/travas")"

echo "recriar: o inventario lento nao segura a trava dos limites; ela so e pega perto da troca"
nova_raiz; maquina 8 2
criar_agente pi --nome X
echo imagem-nova-i >"$STUB_ESTADO/imagem-id"
echo 4 >"$STUB_ESTADO/inventario-demora"
rm -f "$STUB_ESTADO/inventario-em-curso"
dgclaw agente recriar pi --forcar >"$TMP/rec.txt" 2>&1 &
rec_pid=$!
for _ in $(seq 1 50); do [ -e "$STUB_ESTADO/inventario-em-curso" ] && break; sleep 0.2; done
afirma "o inventario esta rodando" test -e "$STUB_ESTADO/inventario-em-curso"
afirma "e outro processo pega a trava dos limites na hora" flock -n -x "$ETC/travas/limites.lock" true
wait "$rec_pid"
igual "o recriar termina com 0" "0" "$?"
rm -f "$STUB_ESTADO/inventario-demora"
echo "recriar: inventario que passa do prazo falha com mensagem em portugues, sem mexer no container"
echo imagem-nova-j >"$STUB_ESTADO/imagem-id"
echo 5 >"$STUB_ESTADO/inventario-demora"
: >"$STUB_LOG"
DGCLAW_PRAZO_INVENTARIO=1 dgclaw agente recriar pi >"$TMP/rec.txt" 2>&1
nega "sem --forcar o recriar para" test "$?" -eq 0
afirma "a mensagem diz que o dpkg-query nao respondeu no prazo" grep -q "dpkg-query' dentro do container dgclaw-pi nao respondeu em 1s" "$TMP/rec.txt"
nega "e nada foi parado nem removido" grep -q '^podman stop\|^podman rm' "$STUB_LOG"
rm -f "$STUB_ESTADO/inventario-demora"

fim

echo "trava por agente: agente chamado limites nao colide com a trava global"
nova_raiz
maquina 8 2
criar_agente limites --nome X
echo "2147483648 100000 100000 1024" >"$STUB_ESTADO/lim-dgclaw-limites"
dgclaw agente reparar limites >"$TMP/rep.txt" 2>&1
igual "o reparar do agente 'limites' termina sem esperar por si mesmo" "0" "$?"
afirma "a trava do agente fica em travas/agentes/" test -f "$ETC/travas/agentes/limites.lock"
