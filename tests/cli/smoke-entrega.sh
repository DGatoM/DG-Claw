#!/usr/bin/env bash
# scripts/smoke-entrega.sh: um caso todo OK e casos com FALHA, com podman, journalctl, nproc, curl e
# dgclaw de mentira (tests/cli/stubs-entrega) e uma raiz falsa (DGCLAW_RAIZ). Nada toca o sistema.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
SMOKE="$REPO/scripts/smoke-entrega.sh"

preparar
# A limpeza entre os casos apaga $STUB_ESTADO: sem a pasta temporaria criada, o teste para antes de apagar qualquer coisa.
case "${TMP:-}" in /*) [ -d "$TMP" ] || { echo "smoke-entrega: o mktemp -d falhou" >&2; exit 1; } ;; *) echo "smoke-entrega: o mktemp -d falhou" >&2; exit 1 ;; esac
[ "$STUB_ESTADO" = "$TMP/estado" ] || { echo "smoke-entrega: STUB_ESTADO fora da pasta temporaria" >&2; exit 1; }
PATH="$AQUI/stubs-entrega:$PATH"
export PATH
export DGCLAW_CLI="$AQUI/stubs-entrega/dgclaw-falso"
CASA="$DGCLAW_RAIZ/var/lib/dgclaw/agentes/ana/home"
CG="$DGCLAW_RAIZ/sys/fs/cgroup/machine.slice/libpod-abc.scope"

# Raiz falsa: Ubuntu 24.04, 16 GB de RAM, ffmpeg no servidor, agente ana.
mkdir -p "$DGCLAW_RAIZ/etc" "$DGCLAW_RAIZ/proc" "$DGCLAW_RAIZ/usr/bin" "$CG"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$DGCLAW_RAIZ/etc/os-release"
printf 'MemTotal:       16384000 kB\n' >"$DGCLAW_RAIZ/proc/meminfo"
printf '#!/bin/sh\n' >"$DGCLAW_RAIZ/usr/bin/ffmpeg"; chmod +x "$DGCLAW_RAIZ/usr/bin/ffmpeg"
printf 'GROQ_API_KEY=gsk_segredo_do_teste\nOUTRA=1\n' >"$ETC/web.env"
jq -n --arg casa "$CASA" '{versao: 1, agentes: [{slug: "ana", tipo: "agente", runner: "127.0.0.1:4301", home_host: $casa, provedor: "claude"}]}' \
    >"$ETC/agentes.json"
cofre_com() { # <nome>...: o cofre falso com essas chaves (e uma revogada, que nao conta)
    local n j='[{"envName":"VELHA_API_KEY","revogadaEm":"2026-01-01T00:00:00Z"}'
    for n in "$@"; do j+=",{\"envName\":\"$n\",\"ultimos4\":\"abcd\",\"revogadaEm\":null}"; done
    printf '{"ok":true,"chaves":%s]}' "$j" >"$STUB_ESTADO/cofre.json"
}
cgroup() { printf '%s\n' "$1" >"$CG/memory.max"; printf '%s\n' "$2" >"$CG/pids.max"; printf '%s\n' "${3:-max 100000}" >"$CG/cpu.max"; }
smoke() { bash "$SMOKE" "$@" >"$TMP/s.txt" 2>&1; }
limpar_estado() { find "$STUB_ESTADO" -mindepth 1 -delete; cofre_com GROQ_API_KEY GEMINI_API_KEY; cgroup 4294967296 8192; printf 'GROQ_API_KEY=gsk_segredo_do_teste\nOUTRA=1\n' >"$ETC/web.env"; : >"$STUB_LOG"; }

echo "smoke-entrega: tudo certo"
limpar_estado
smoke ana
igual "sai com 0" "0" "$?"
afirma "item 1 OK" grep -q 'OK     \[1\] Ubuntu 24.04' "$TMP/s.txt"
afirma "item 3 OK no pids.max" grep -q 'OK     \[3\] pids.max do container: 8192' "$TMP/s.txt"
nega "o smoke nao executa nada dentro do container (nenhum podman exec)" grep -q 'podman exec' "$STUB_LOG"
afirma "a lista a mao traz a leitura do runner num terminal do dono" grep -q 'systemctl show -p TasksMax -p OOMPolicy -p NRestarts dgclaw-runner' "$TMP/s.txt"
afirma "a lista a mao diz que serve de apoio e nao de prova" grep -q 'servem de apoio e nao de prova' "$TMP/s.txt"
afirma "item 3 OK sem OOM" grep -q 'OK     \[3\] nenhum OOM' "$TMP/s.txt"
afirma "item 5 OK no microfone (web.env)" grep -q 'OK     \[5\] o servico Web tem chave para o microfone e o audio (a ultima atribuicao tem valor): GROQ_API_KEY' "$TMP/s.txt"
afirma "item 3 OK na CPU (sem limite)" grep -q 'OK     \[3\] CPU do container: sem limite' "$TMP/s.txt"
afirma "item 3 OK no kernel com a cobertura" grep -q 'OK     \[3\] nenhum OOM no journal do kernel do servidor (cobertura do kernel: 7 dias)' "$TMP/s.txt"
afirma "o kernel e lido sem -k (todo o periodo, nao so o boot)" grep -q 'journalctl _TRANSPORT=kernel --since 7 days ago --no-pager -q -o short-unix' "$STUB_LOG"
nega "nao usa journalctl -k" grep -qE 'journalctl -k' "$STUB_LOG"
nega "nao mostra o valor da chave do web.env" grep -q 'gsk_segredo' "$TMP/s.txt"
afirma "item 5 lista so os nomes do cofre" grep -q 'OK     \[5\] o cofre tem 2 chave(s) ativa(s): GEMINI_API_KEY, GROQ_API_KEY' "$TMP/s.txt"
nega "nao afirma que toda chave citada esta no cofre" grep -q 'toda chave citada' "$TMP/s.txt"
nega "nao varre as skills no container" grep -q 'FIM-DA-VARREDURA' "$STUB_LOG"
afirma "item 8 OK so no servidor" bash -c "grep -c 'OK     \[8\]' '$TMP/s.txt' | grep -qx 1"
nega "nao imprime PENDENTE" grep -q 'PENDENTE' "$TMP/s.txt"
nega "nao imprime FALHA" grep -q 'FALHA' "$TMP/s.txt"
afirma "lista o que fica a mao" grep -q 'Conferir a mao' "$TMP/s.txt"
nega "nao mostra valor de chave (so o nome)" grep -q 'abcd' "$TMP/s.txt"
nega "a chave revogada nao conta" grep -q 'VELHA_API_KEY' "$TMP/s.txt"

echo "smoke-entrega: avisos nao derrubam (memoria, CPU, 26.04)"
limpar_estado
printf 'ID=ubuntu\nVERSION_ID="26.04"\n' >"$DGCLAW_RAIZ/etc/os-release"
cgroup 2147483648 8192 "100000 100000"
smoke ana
igual "sai com 0 so com avisos" "0" "$?"
afirma "avisa do 26.04" grep -q 'AVISO  \[1\] Ubuntu 26.04' "$TMP/s.txt"
afirma "avisa da memoria sem podman update" grep -q "DGCLAW_CONTAINER_MEMORIA (por exemplo 7g)" "$TMP/s.txt"
afirma "avisa da CPU" grep -q 'AVISO  \[3\] o container tem 1 CPU' "$TMP/s.txt"
nega "nenhuma dica manda podman update de memoria ou CPU" grep -qE 'podman update --(memory|cpus) [0-9<]' "$TMP/s.txt"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$DGCLAW_RAIZ/etc/os-release"

echo "smoke-entrega: varias FALHAS"
limpar_estado
cofre_com GEMINI_API_KEY
printf 'OUTRA=1\n' >"$ETC/web.env"
cgroup 4294967296 1024
: >"$STUB_ESTADO/oom-host"
smoke ana
igual "sai com 1" "1" "$?"
afirma "FALHA no pids.max" grep -q 'FALHA  \[3\] pids.max do container e 1024' "$TMP/s.txt"
afirma "FALHA no OOM" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias' "$TMP/s.txt"
afirma "FALHA sem chave de microfone no web.env" grep -q 'FALHA  \[5\] o web.env nao tem ELEVENLABS_API_KEY, GROQ_API_KEY nem OPENAI_API_KEY' "$TMP/s.txt"
afirma "as dicas de recriar nao mandam --forcar" bash -c "! grep -q -- 'recriar ana --forcar' '$TMP/s.txt'"
afirma "a dica de recriar manda conferir a camada gravavel fora do chat do Admin" grep -q 'num terminal seu (nunca no chat do Admin' "$TMP/s.txt"
nega "a dica de recriar nao manda abrir podman diff" grep -q 'podman diff' "$TMP/s.txt"
afirma "a dica de recriar avisa que pode recriar na hora" grep -q 'pode recriar o container na hora' "$TMP/s.txt"
nega "a dica de recriar nao a apresenta como so listar" grep -q 'ele lista e para' "$TMP/s.txt"
afirma "o resumo manda nao entregar" grep -q 'NAO entregue a VPS' "$TMP/s.txt"
nega "OOM nao manda aumentar o teto do agente direto" grep -q 'aumente o teto de memoria do agente' "$TMP/s.txt"
afirma "a dica de recriar exige a releitura e avisa do 'nada a recriar'" grep -q 'nada havia a recriar, o container nao mudou e o item continua aberto' "$TMP/s.txt"
afirma "a dica de recriar cita o que o inventario ignora" grep -q 'ignora /tmp, /var/tmp, /var/log e /var/cache' "$TMP/s.txt"
echo "smoke-entrega: dica de OOM com oom_memcg"
afirma "a dica de OOM manda ver o oom_memcg e o task_memcg" grep -q 'oom_memcg (o cgroup cujo limite estourou) e o task_memcg (quem foi morto)' "$TMP/s.txt"
afirma "a dica de OOM cita o OOM do servidor inteiro" grep -q 'CONSTRAINT_NONE' "$TMP/s.txt"
afirma "a dica de OOM manda nunca aumentar o teto direto" grep -q 'Nunca aumente o teto do agente direto' "$TMP/s.txt"

echo "smoke-entrega: memoria e processos sem limite no cgroup"
limpar_estado
cgroup max max
smoke ana
igual "sem limite: sai com 1" "1" "$?"
afirma "FALHA sem limite de processos" grep -q 'FALHA  \[3\] o container dgclaw-ana esta sem limite de processos' "$TMP/s.txt"
afirma "FALHA sem limite de memoria" grep -q 'FALHA  \[3\] o container dgclaw-ana esta sem limite de memoria' "$TMP/s.txt"
afirma "a correcao cita DGCLAW_CONTAINER_MEMORIA (a partir da 1.1.1), sem numero de RAM" grep -q 'configure DGCLAW_CONTAINER_MEMORIA (a partir da 1.1.1) com' "$TMP/s.txt"
nega "a correcao nao sugere podman update --memory" grep -qE 'sem limite de memoria.*podman update|podman update --memory [0-9]+g dgclaw-ana \(vale ate o container ser recriado\). Para' "$TMP/s.txt"
limpar_estado
echo /machine.slice/../../etc >"$STUB_ESTADO/cgpath"
smoke ana
afirma "caminho de cgroup invalido: INCONCLUSIVO, nao FALHA nem OK" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o limite de processos' "$TMP/s.txt"
nega "caminho invalido nao vira OK de pids" grep -q 'OK     \[3\] pids.max' "$TMP/s.txt"

echo "smoke-entrega: erro de leitura do journal e INCONCLUSIVO"
limpar_estado
: >"$STUB_ESTADO/journal-host-erro"
smoke ana
igual "so inconclusivo: sai com 0" "0" "$?"
afirma "journal com erro: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal' "$TMP/s.txt"
nega "journal com erro nao diz 'nenhum OOM'" grep -q 'nenhum OOM' "$TMP/s.txt"
afirma "o resumo conta os inconclusivos" grep -qE 'Resumo: 0 falha.*[1-9][0-9]* inconclusivo' "$TMP/s.txt"

echo "smoke-entrega: --video nao existe mais"
smoke ana --video https://exemplo.com/video
igual "--video nao existe mais: sai com 2" "2" "$?"


echo "smoke-entrega: CPU pelo cpu.max do cgroup"
limpar_estado
cgroup 4294967296 8192 "200000 100000"
smoke ana
afirma "2 CPUs de quota: OK com o numero" grep -q 'OK     \[3\] CPU do container: 2.00' "$TMP/s.txt"
cgroup 4294967296 8192 "150000 100000"
smoke ana
afirma "quota fracionada: 1.50" grep -q 'OK     \[3\] CPU do container: 1.50' "$TMP/s.txt"
cgroup 4294967296 8192 "100000 100000"
smoke ana
afirma "1 CPU em servidor maior: AVISO" grep -q 'AVISO  \[3\] o container tem 1 CPU' "$TMP/s.txt"
rm -f "$CG/cpu.max"
smoke ana
afirma "cpu.max ilegivel: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o limite de CPU' "$TMP/s.txt"
printf 'lixo\n' >"$CG/cpu.max"
smoke ana
afirma "cpu.max fora do formato: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o limite de CPU' "$TMP/s.txt"

echo "smoke-entrega: kernel em 7 dias (cobertura real do journal)"
limpar_estado
echo 2 >"$STUB_ESTADO/kernel-dias"
smoke ana
afirma "journal do kernel com 2 dias: INCONCLUSIVO com a cobertura real" grep -q 'INCONCLUSIVO \[3\] nenhum OOM achado.*2 dia(s) completo(s) (48 horas)' "$TMP/s.txt"
nega "journal do kernel com 2 dias: nenhum OK de OOM" grep -q 'OK     \[3\] nenhum OOM' "$TMP/s.txt"
rm -f "$STUB_ESTADO/kernel-dias"; echo 145 >"$STUB_ESTADO/kernel-horas"
smoke ana
afirma "journal do kernel com 6 dias e 1 hora: nao arredonda para 7" grep -q 'INCONCLUSIVO \[3\].*6 dia(s) completo(s) (145 horas)' "$TMP/s.txt"
nega "6 dias e 1 hora nao vira OK de 7 dias" grep -q 'cobertura do kernel: 7 dias' "$TMP/s.txt"
echo "smoke-entrega: zero OOM com a primeira entrada de 2 horas atras"
echo 2 >"$STUB_ESTADO/kernel-horas"
smoke ana
afirma "primeira entrada de 2 horas: INCONCLUSIVO com menos de 1 dia" grep -q 'INCONCLUSIVO \[3\] nenhum OOM achado.*menos de 1 dia' "$TMP/s.txt"
nega "primeira entrada de 2 horas: nenhum OK de OOM" grep -q 'OK     \[3\] nenhum OOM' "$TMP/s.txt"
afirma "a dica do OOM usa o filtro completo" grep -qF 'out of memory|oom-kill|oom_kill|killed process' "$TMP/s.txt"
afirma "a dica do OOM confere o grep" grep -qF 'PIPESTATUS[1]' "$TMP/s.txt"
rm -f "$STUB_ESTADO/kernel-horas"
: >"$STUB_ESTADO/kernel-vazio"
smoke ana
afirma "journal do kernel sem entradas: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nenhum OOM achado, mas o journal do kernel' "$TMP/s.txt"
rm -f "$STUB_ESTADO/kernel-vazio"; : >"$STUB_ESTADO/oom-host"
smoke ana
afirma "OOM no kernel: FALHA" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias' "$TMP/s.txt"
afirma "OOM so no kernel: diz que nao da para atribuir" grep -q 'a contagem sozinha nao diz de quem era o processo' "$TMP/s.txt"
nega "OOM so no kernel: nao manda aumentar o teto do agente" grep -q 'aumente o teto de memoria do agente' "$TMP/s.txt"
rm -f "$STUB_ESTADO/oom-host"; : >"$STUB_ESTADO/journal-host-erro"
smoke ana
afirma "journal do kernel com erro: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal do kernel' "$TMP/s.txt"
echo "smoke-entrega: cobertura so vale com o journalctl saindo com 0"
limpar_estado
: >"$STUB_ESTADO/kernel-saida-erro"
smoke ana
afirma "kernel imprime linha com timestamp e sai com 1: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal do kernel' "$TMP/s.txt"
nega "kernel que sai com 1 nao vira OK" grep -q 'OK     \[3\] nenhum OOM' "$TMP/s.txt"
nega "kernel que sai com 1 nao mostra cobertura" grep -q 'cobertura do kernel' "$TMP/s.txt"
echo "smoke-entrega: dica do INCONCLUSIVO de OOM"
# shellcheck disable=SC2016  # texto literal, nao expande
afirma "a dica le a janela toda e mostra o codigo do journalctl e do grep" grep -qF 'journalctl=${PIPESTATUS[0]} grep=${PIPESTATUS[1]}' "$TMP/s.txt"
nega "a dica nao usa -n 0 (pede zero registros e nao examina nada)" grep -q -- '-n 0' "$TMP/s.txt"
afirma "a dica diz que o item continua INCONCLUSIVO ate a leitura" grep -q 'continua INCONCLUSIVO ate essa leitura ser feita' "$TMP/s.txt"
afirma "a dica manda ver a persistencia do journal" grep -q '/var/log/journal' "$TMP/s.txt"
echo "smoke-entrega: kernel lido, zero OOM, 8 dias de historico: OK com 7 dias"
limpar_estado
echo 8 >"$STUB_ESTADO/kernel-dias"
smoke ana
igual "8 dias de historico: sai com 0" "0" "$?"
afirma "8 dias de historico: OK com cobertura de 7 dias" grep -q 'OK     \[3\] nenhum OOM no journal do kernel do servidor (cobertura do kernel: 7 dias)' "$TMP/s.txt"

echo "smoke-entrega: chaves de microfone no web.env (ultima atribuicao, valor vazio, sem executar o arquivo)"
limpar_estado
printf 'GROQ_API_KEY=""\n' >"$ETC/web.env"
smoke ana
afirma "GROQ_API_KEY com aspas vazias: FALHA" grep -q 'FALHA  \[5\] o web.env nao tem ELEVENLABS_API_KEY, GROQ_API_KEY nem OPENAI_API_KEY com valor' "$TMP/s.txt"
printf "GROQ_API_KEY=''\n" >"$ETC/web.env"
smoke ana
afirma "GROQ_API_KEY com aspas simples vazias: FALHA" grep -q 'FALHA  \[5\] o web.env nao tem ELEVENLABS_API_KEY, GROQ_API_KEY nem OPENAI_API_KEY com valor' "$TMP/s.txt"
printf 'GROQ_API_KEY=gsk_antiga_segredo\nOUTRA=1\nGROQ_API_KEY=\n' >"$ETC/web.env"
smoke ana
afirma "atribuicao antiga seguida de uma vazia (duplicata): INCONCLUSIVO" grep -q 'INCONCLUSIVO \[5\] o web.env tem mais de uma atribuicao da mesma chave de microfone (GROQ_API_KEY)' "$TMP/s.txt"
nega "nao mostra o valor antigo" grep -q 'gsk_antiga' "$TMP/s.txt"
printf 'GROQ_API_KEY=\nexport GROQ_API_KEY="gsk_nova_segredo"\n' >"$ETC/web.env"
smoke ana
afirma "vazia e depois com export (duplicata): INCONCLUSIVO, linha ambigua" grep -q 'INCONCLUSIVO \[5\] o web.env tem mais de uma atribuicao da mesma chave de microfone (GROQ_API_KEY)' "$TMP/s.txt"
nega "duplicata nao vira OK" grep -q 'OK     \[5\] o servico Web' "$TMP/s.txt"
nega "nao mostra o valor novo" grep -q 'gsk_nova' "$TMP/s.txt"
printf 'GROQ_API_KEY=gsk_a\nOPENAI_API_KEY=sk_b\nGROQ_API_KEY=gsk_c\n' >"$ETC/web.env"
smoke ana
afirma "duas GROQ com valor: INCONCLUSIVO mesmo havendo outra chave" grep -q 'INCONCLUSIVO \[5\] o web.env tem mais de uma atribuicao' "$TMP/s.txt"
printf 'export GROQ_API_KEY=gsk_nova_segredo\n' >"$ETC/web.env"
smoke ana
afirma "uma so atribuicao com export e valor: OK" grep -q 'OK     \[5\] o servico Web tem chave para o microfone e o audio (a ultima atribuicao tem valor): GROQ_API_KEY' "$TMP/s.txt"
printf 'OPENAI_API_KEY=sk_x\n' >"$ETC/web.env"
smoke ana
afirma "so OPENAI_API_KEY com valor: OK" grep -q 'OK     \[5\] o servico Web tem chave para o microfone e o audio (a ultima atribuicao tem valor): OPENAI_API_KEY' "$TMP/s.txt"
printf 'GROQ_API_KEY=gsk_x\nGROQ_API_KEY=""\n' >"$ETC/web.env"
smoke ana
afirma "GROQ com valor e depois vazia (duplicata): INCONCLUSIVO" grep -q 'INCONCLUSIVO \[5\] o web.env tem mais de uma atribuicao da mesma chave de microfone (GROQ_API_KEY)' "$TMP/s.txt"
printf '%s\nGROQ_API_KEY=gsk_x\n' "\$(touch $TMP/executou)" >"$ETC/web.env"
smoke ana
nega "o web.env e lido como texto, nunca executado" test -e "$TMP/executou"


echo "smoke-entrega: os-release incompleto e senha"
limpar_estado
smoke ana
afirma "a troca de senha do dono e pelo terminal nesta versao" grep -q 'nesta versao o painel nao troca a senha' "$TMP/s.txt"
limpar_estado
printf 'ID=ubuntu\n' >"$DGCLAW_RAIZ/etc/os-release"
smoke ana
igual "os-release sem VERSION_ID: sem FALHA" "0" "$?"
afirma "os-release sem VERSION_ID: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[1\] o /etc/os-release nao traz ID e VERSION_ID' "$TMP/s.txt"
nega "os-release incompleto nao manda reinstalar" grep -q 'INCONCLUSIVO \[1\].*recrie a VPS' "$TMP/s.txt"
afirma "os-release incompleto: diz para nao reinstalar" grep -q 'Nao reinstale a VPS por causa disso' "$TMP/s.txt"
printf 'ID=debian\nVERSION_ID="12"\n' >"$DGCLAW_RAIZ/etc/os-release"
smoke ana
afirma "sistema incompativel: FALHA" grep -q 'FALHA  \[1\] sistema' "$TMP/s.txt"
afirma "sistema incompativel: reinstalar so com copia e decisao do dono" grep -q 'so com uma copia recuperavel dos dados e com a decisao do dono' "$TMP/s.txt"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$DGCLAW_RAIZ/etc/os-release"

echo "smoke-entrega: saida cortada em 1 MiB"
limpar_estado
: >"$STUB_ESTADO/journal-grande"
smoke ana
igual "journal acima de 1 MiB: sem FALHA, sai com 0" "0" "$?"
afirma "journal acima de 1 MiB: INCONCLUSIVO de saida cortada" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal do kernel.*saida cortada' "$TMP/s.txt"
nega "journal cortado nao diz 'nenhum OOM'" grep -q 'nenhum OOM' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/journal-oom-grande"
smoke ana
igual "OOM achado e leitura cortada em 1 MiB: sai com 1" "1" "$?"
afirma "OOM achado e leitura cortada: FALHA com nota de contagem parcial" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias.*contagem parcial' "$TMP/s.txt"
nega "OOM achado e leitura cortada nao vira INCONCLUSIVO de journal" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal' "$TMP/s.txt"
limpar_estado
cgroup 17000000000 8192
smoke ana
igual "memory.max acima da RAM: so aviso, sai com 0" "0" "$?"
afirma "memory.max igual ou maior que a RAM: AVISO" grep -q 'AVISO  \[3\] o container dgclaw-ana tem limite de memoria .* RAM do servidor' "$TMP/s.txt"
limpar_estado
cgroup 134217728 8192
printf 'MemTotal:       4096000 kB\n' >"$DGCLAW_RAIZ/proc/meminfo"
smoke ana
igual "128 MB num servidor de 4 GB: so aviso, sai com 0" "0" "$?"
afirma "128 MB: AVISO abaixo dos 2 GB, mostrando o valor lido" grep -q 'AVISO  \[3\] .*limite de memoria de 128 MB, abaixo dos 2 GB que o DG Claw aplica na criacao' "$TMP/s.txt"
nega "128 MB nao vira OK de memoria" grep -q 'OK     \[3\] memoria' "$TMP/s.txt"
printf 'MemTotal:       16384000 kB\n' >"$DGCLAW_RAIZ/proc/meminfo"
limpar_estado
smoke ana
afirma "4 GB num servidor de 16 GB: OK de memoria com o valor lido" grep -q 'OK     \[3\] memoria do container: 4096 MB' "$TMP/s.txt"
nega "4 GB num servidor de 16 GB: sem AVISO de memoria" grep -q 'AVISO  \[3\] .*memoria' "$TMP/s.txt"
cgroup 2147483648 8192
smoke ana
nega "2 GB num servidor de 16 GB: aviso sem OK de memoria junto" grep -q 'OK     \[3\] memoria' "$TMP/s.txt"
limpar_estado
{ head -c 1100000 /dev/zero | tr '\0' 'a'; printf '\nGROQ_API_KEY=\n'; } >"$ETC/web.env"
smoke ana
afirma "web.env acima de 1 MiB: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[5\] o web.env passa de 1 MiB' "$TMP/s.txt"
nega "web.env cortado nao vira OK nem FALHA de microfone" grep -qE '(OK     |FALHA  )\[5\] (o servico Web|o web.env nao tem)' "$TMP/s.txt"


echo "smoke-entrega: consulta ao cofre sem resposta valida"
limpar_estado
: >"$STUB_ESTADO/cofre-sem-saida"
smoke ana
igual "CLI do cofre sem saida: sai com 0" "0" "$?"
afirma "CLI sem saida: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[5\] a consulta ao cofre' "$TMP/s.txt"
afirma "a dica do cofre com falha usa listar --json" grep -q 'listar --json | jq -r' "$TMP/s.txt"
# shellcheck disable=SC2016  # texto literal, nao expande
afirma "a dica do cofre separa o codigo de saida" grep -qF 'echo ${PIPESTATUS[0]}' "$TMP/s.txt"
nega "a dica do cofre nao manda a listagem em texto" grep -qE 'listar"? *$' "$TMP/s.txt"
nega "CLI sem saida nao diz que o cofre tem chaves" grep -q 'OK     \[5\] o cofre' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/cofre-erro"
smoke ana
afirma "CLI com codigo de erro: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[5\] a consulta ao cofre' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/cofre-ok-falso"
smoke ana
afirma "ok falso: INCONCLUSIVO de formato" grep -q 'INCONCLUSIVO \[5\] a resposta da consulta ao cofre' "$TMP/s.txt"

echo "smoke-entrega: web.env ausente"
limpar_estado
mv "$ETC/web.env" "$ETC/web.env.guardado"
smoke ana
afirma "web.env ilegivel: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[5\] nao consegui ler o arquivo de ambiente' "$TMP/s.txt"
mv "$ETC/web.env.guardado" "$ETC/web.env"

echo "smoke-entrega: container parado e uso errado"
limpar_estado
echo exited >"$STUB_ESTADO/estado"
smoke ana
igual "container parado: sai com 1" "1" "$?"
afirma "diz como ligar" grep -q 'dgclaw agente iniciar ana' "$TMP/s.txt"
nega "container parado nao manda reparar (no bloco do item 3)" bash -c "sed -n '/^3\. /,/^8\. /p' '$TMP/s.txt' | grep -q reparar"

echo "smoke-entrega: podman container exists (inexistente, sem resposta, estado vazio)"
limpar_estado
echo 1 >"$STUB_ESTADO/existe"
smoke ana
igual "container inexistente: sai com 1" "1" "$?"
afirma "container inexistente: FALHA" grep -q 'FALHA  \[3\] o container dgclaw-ana nao existe' "$TMP/s.txt"
afirma "container inexistente: manda conferir com agente listar" grep -q 'confira com dgclaw agente listar se o agente foi criado; um agente sem container precisa ser recriado pela equipe' "$TMP/s.txt"
nega "container inexistente nao manda reparar (no bloco do item 3)" bash -c "sed -n '/^3\. /,/^8\. /p' '$TMP/s.txt' | grep -q reparar"
nega "container inexistente nao le o resto como se existisse" grep -q 'OK     \[3\] pids.max' "$TMP/s.txt"
limpar_estado
echo 125 >"$STUB_ESTADO/existe"
smoke ana
igual "podman sem responder: sem FALHA, sai com 0" "0" "$?"
afirma "podman sem responder: INCONCLUSIVO com o codigo" grep -q 'INCONCLUSIVO \[3\] nao consegui consultar o podman (codigo 125)' "$TMP/s.txt"
nega "podman sem responder nao manda reparar (no bloco do item 3)" bash -c "sed -n '/^3\. /,/^8\. /p' '$TMP/s.txt' | grep -q reparar"
nega "podman sem responder nao manda iniciar (no bloco do item 3)" bash -c "sed -n '/^3\. /,/^8\. /p' '$TMP/s.txt' | grep -q iniciar"
nega "podman sem responder nao vira FALHA de container" grep -q 'FALHA  \[3\] o container' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/estado"
smoke ana
igual "estado vazio: sem FALHA, sai com 0" "0" "$?"
afirma "estado vazio: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] o podman nao devolveu um estado valido' "$TMP/s.txt"
limpar_estado
echo inventado >"$STUB_ESTADO/estado"
smoke ana
afirma "estado fora da lista: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] o podman nao devolveu um estado valido' "$TMP/s.txt"
nega "estado fora da lista nao entra no relatorio" grep -q 'inventado' "$TMP/s.txt"
smoke
igual "sem agente: sai com 2" "2" "$?"
smoke "ana;rm"
igual "nome invalido: sai com 2" "2" "$?"
smoke outro
igual "agente inexistente: sai com 2" "2" "$?"

fim
