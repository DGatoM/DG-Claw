#!/usr/bin/env bash
# scripts/smoke-entrega.sh: um caso todo OK e casos com FALHA, com podman, journalctl, nproc, curl e
# dgclaw de mentira (tests/cli/stubs-entrega) e uma raiz falsa (DGCLAW_RAIZ). Nada toca o sistema.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
SMOKE="$REPO/scripts/smoke-entrega.sh"

preparar
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
afirma "item 3 OK no TasksMax" grep -q 'OK     \[3\] TasksMax .*2400' "$TMP/s.txt"
afirma "item 3 OK no OOMPolicy" grep -q 'OK     \[3\] OOMPolicy=continue' "$TMP/s.txt"
afirma "item 3 OK sem OOM" grep -q 'OK     \[3\] nenhum OOM' "$TMP/s.txt"
afirma "item 5 OK no microfone (web.env)" grep -q 'OK     \[5\] o servico Web tem chave para o microfone e o audio (a ultima atribuicao tem valor): GROQ_API_KEY' "$TMP/s.txt"
afirma "item 3 OK na CPU (sem limite)" grep -q 'OK     \[3\] CPU do container: sem limite' "$TMP/s.txt"
afirma "item 3 OK no kernel com a cobertura" grep -q 'OK     \[3\] nenhum OOM no journal do runner (cobertura do runner: 7 dias) nem no do kernel do servidor (cobertura do kernel: 7 dias)' "$TMP/s.txt"
afirma "o kernel e lido sem -k (todo o periodo, nao so o boot)" grep -q 'journalctl _TRANSPORT=kernel --since 7 days ago' "$STUB_LOG"
nega "nao usa journalctl -k" grep -qE 'journalctl -k' "$STUB_LOG"
nega "nao mostra o valor da chave do web.env" grep -q 'gsk_segredo' "$TMP/s.txt"
afirma "item 5 lista so os nomes do cofre" grep -q 'OK     \[5\] o cofre tem 2 chave(s) ativa(s): GEMINI_API_KEY, GROQ_API_KEY' "$TMP/s.txt"
nega "nao afirma que toda chave citada esta no cofre" grep -q 'toda chave citada' "$TMP/s.txt"
nega "nao varre as skills no container" grep -q 'FIM-DA-VARREDURA' "$STUB_LOG"
afirma "item 6 OK no yt-dlp.conf" grep -q 'OK     \[6\] /etc/yt-dlp.conf tem a diretiva --js-runtimes node' "$TMP/s.txt"
afirma "item 6 OK no perfil da Tela" grep -q 'OK     \[6\] o perfil da Tela existe' "$TMP/s.txt"
afirma "item 6 deixa o YouTube PENDENTE" grep -q 'PENDENTE \[6\] login do YouTube e download' "$TMP/s.txt"
afirma "item 7 OK com o Chrome headless" grep -q 'OK     \[7\] o Chrome headless rodou' "$TMP/s.txt"
afirma "o render usa pasta privada e apaga so ela" grep -q 'rm -rf -- /tmp/smoke-entrega.abc123$' "$STUB_LOG"
nega "nao usa o /tmp fixo antigo" grep -q 'smoke-entrega-yt' "$STUB_LOG"
afirma "item 8 OK no servidor e no container" bash -c "grep -c 'OK     \[8\]' '$TMP/s.txt' | grep -qx 2"
nega "nao imprime FALHA" grep -q 'FALHA' "$TMP/s.txt"
afirma "lista o que fica a mao" grep -q 'Conferir a mao' "$TMP/s.txt"
nega "nao mostra valor de chave (so o nome)" grep -q 'abcd' "$TMP/s.txt"
nega "a chave revogada nao conta" grep -q 'VELHA_API_KEY' "$TMP/s.txt"

echo "smoke-entrega: avisos nao derrubam (memoria, CPU, 26.04, yt-dlp fora do lugar)"
limpar_estado
printf 'ID=ubuntu\nVERSION_ID="26.04"\n' >"$DGCLAW_RAIZ/etc/os-release"
cgroup 2147483648 8192 "100000 100000"; echo stop >"$STUB_ESTADO/oompolicy"
echo /opt/venv/bin/yt-dlp >"$STUB_ESTADO/yt-path"; : >"$STUB_ESTADO/sem-yt-config"
smoke ana
igual "sai com 0 so com avisos" "0" "$?"
afirma "avisa do 26.04" grep -q 'AVISO  \[1\] Ubuntu 26.04' "$TMP/s.txt"
afirma "avisa da memoria sem podman update" grep -q "DGCLAW_CONTAINER_MEMORIA (por exemplo 7g)" "$TMP/s.txt"
afirma "avisa da CPU" grep -q 'AVISO  \[3\] o container tem 1 CPU' "$TMP/s.txt"
nega "nenhuma dica manda podman update de memoria ou CPU" grep -qE 'podman update --(memory|cpus) [0-9<]' "$TMP/s.txt"
afirma "avisa do OOMPolicy (a partir da 1.1.1)" grep -q 'AVISO  \[3\] OOMPolicy.*1.1.1' "$TMP/s.txt"
afirma "avisa do yt-dlp fora do /usr/local/bin, com mensagem fixa" grep -q 'AVISO  \[6\] o yt-dlp do agente nao esta em /usr/local/bin' "$TMP/s.txt"
nega "o caminho vindo do container nao entra no relatorio" grep -q '/opt/venv' "$TMP/s.txt"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$DGCLAW_RAIZ/etc/os-release"

echo "smoke-entrega: varias FALHAS"
limpar_estado
cofre_com GEMINI_API_KEY
printf 'OUTRA=1\n' >"$ETC/web.env"
cgroup 4294967296 1024; echo 153 >"$STUB_ESTADO/tasksmax"; echo 3 >"$STUB_ESTADO/nrestarts"
: >"$STUB_ESTADO/oom-journal"; : >"$STUB_ESTADO/sem-ffmpeg-container"
: >"$STUB_ESTADO/yt-falha"
smoke ana
igual "sai com 1" "1" "$?"
afirma "FALHA no pids.max" grep -q 'FALHA  \[3\] pids.max do container e 1024' "$TMP/s.txt"
afirma "FALHA no TasksMax com o que fazer" grep -q 'FALHA  \[3\] TasksMax do dgclaw-runner e 153' "$TMP/s.txt"
afirma "FALHA no NRestarts" grep -q 'FALHA  \[3\] o runner reiniciou sozinho 3' "$TMP/s.txt"
afirma "FALHA no OOM" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias' "$TMP/s.txt"
afirma "FALHA sem chave de microfone no web.env" grep -q 'FALHA  \[5\] o web.env nao tem ELEVENLABS_API_KEY, GROQ_API_KEY nem OPENAI_API_KEY' "$TMP/s.txt"
afirma "as dicas de recriar nao mandam --forcar" bash -c "! grep -q -- 'recriar ana --forcar' '$TMP/s.txt'"
afirma "a dica de recriar manda pedir ao Admin a camada gravavel" grep -q 'peca ao Admin para conferir o que existe so na camada gravavel' "$TMP/s.txt"
nega "a dica de recriar nao manda abrir podman diff" grep -q 'podman diff' "$TMP/s.txt"
afirma "a dica de recriar avisa que pode recriar na hora" grep -q 'pode recriar o container na hora' "$TMP/s.txt"
nega "a dica de recriar nao a apresenta como so listar" grep -q 'ele lista e para' "$TMP/s.txt"
afirma "FALHA sem ffmpeg no container" grep -q 'FALHA  \[8\] ffmpeg nao esta no container' "$TMP/s.txt"
afirma "o resumo manda nao entregar" grep -q 'NAO entregue a VPS' "$TMP/s.txt"
afirma "OOM no journal do runner: atribui ao container" grep -q 'o journal do runner mostra que foi dentro do container dgclaw-ana' "$TMP/s.txt"
afirma "a dica de recriar exige a releitura e avisa do 'nada a recriar'" grep -q 'nada havia a recriar, o container nao mudou e o item continua aberto' "$TMP/s.txt"
afirma "a dica de recriar cita o que o inventario ignora" grep -q 'ignora /tmp, /var/tmp, /var/log e /var/cache' "$TMP/s.txt"
nega "a dica do NRestarts nao manda despejar o journal" grep -q 'tail -n 80' "$TMP/s.txt"

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

echo "smoke-entrega: erro de leitura e INCONCLUSIVO (journal, OOMPolicy)"
limpar_estado
: >"$STUB_ESTADO/journal-erro"; echo inventado >"$STUB_ESTADO/oompolicy"
smoke ana
igual "so inconclusivo e aviso: sai com 0" "0" "$?"
afirma "journal com erro: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal' "$TMP/s.txt"
nega "journal com erro nao diz 'nenhum OOM'" grep -q 'nenhum OOM' "$TMP/s.txt"
afirma "OOMPolicy fora da lista fechada: aviso fixo" grep -q 'AVISO  \[3\] o OOMPolicy do runner veio com um valor que nao conheco' "$TMP/s.txt"
nega "o valor de fora nao e impresso" grep -q 'inventado' "$TMP/s.txt"
afirma "o resumo conta os inconclusivos" grep -qE 'Resumo: 0 falha.*[1-9][0-9]* inconclusivo' "$TMP/s.txt"

echo "smoke-entrega: cookies e yt-dlp.conf (desenho novo, sem config global de cookies)"
limpar_estado
: >"$STUB_ESTADO/sem-yt-conf"; : >"$STUB_ESTADO/sem-perfil-tela"
smoke ana
afirma "sem a diretiva js-runtimes: aviso" grep -q 'AVISO  \[6\] o /etc/yt-dlp.conf do container nao tem a diretiva ativa' "$TMP/s.txt"
afirma "sem perfil da Tela: aviso" grep -q 'AVISO  \[6\] o perfil da Tela' "$TMP/s.txt"
afirma "mesmo assim o YouTube fica PENDENTE" grep -q 'PENDENTE \[6\]' "$TMP/s.txt"
nega "nao procura mais config de cookies" grep -q 'cookies-from-browser' "$STUB_LOG"
limpar_estado
: >"$STUB_ESTADO/yt-conf-erro"
smoke ana
afirma "erro lendo o yt-dlp.conf: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[6\] nao consegui ler o /etc/yt-dlp.conf' "$TMP/s.txt"
nega "a dica do yt-dlp.conf nao manda imprimir o arquivo" grep -q "cat /etc/yt-dlp.conf" "$TMP/s.txt"

echo "smoke-entrega: pasta privada do render e opcao --video removida"
limpar_estado
: >"$STUB_ESTADO/mktemp-erro"
smoke ana
afirma "sem pasta privada: INCONCLUSIVO no render" grep -q 'INCONCLUSIVO \[7\] nao consegui criar a pasta privada' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/mktemp-barra"
smoke ana
afirma "caminho com barra no sufixo: INCONCLUSIVO, sem render nem remocao" grep -q 'INCONCLUSIVO \[7\] nao consegui criar a pasta privada' "$TMP/s.txt"
nega "caminho invalido nao chega ao Chrome" grep -q 'google-chrome-stable --headless' "$STUB_LOG"
nega "caminho invalido nao chega ao rm" grep -q 'rm -rf' "$STUB_LOG"
limpar_estado
: >"$STUB_ESTADO/mktemp-casa"
smoke ana
nega "caminho fora do /tmp nao e apagado" grep -q 'rm -rf' "$STUB_LOG"
smoke ana --video https://exemplo.com/video
igual "--video nao existe mais: sai com 2" "2" "$?"

echo "smoke-entrega: saida do container fora do limite ou do formato vira INCONCLUSIVO, sem texto livre"
limpar_estado
: >"$STUB_ESTADO/yt-grande"; : >"$STUB_ESTADO/tasks-lixo"
smoke ana
afirma "caminho do yt-dlp acima do limite: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[6\] nao consegui perguntar ao container onde esta o yt-dlp' "$TMP/s.txt"
nega "o lixo do yt-dlp nao entra no relatorio" grep -q 'aaaaaaaa' "$TMP/s.txt"
afirma "TasksMax fora do formato: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o TasksMax' "$TMP/s.txt"
nega "o texto livre do container nao entra no relatorio" grep -q 'texto livre' "$TMP/s.txt"

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
afirma "journal do kernel com 2 dias: diz a cobertura real" grep -q 'cobertura do kernel: 2 dia(s) completo(s) (48 horas)' "$TMP/s.txt"
rm -f "$STUB_ESTADO/kernel-dias"; echo 145 >"$STUB_ESTADO/kernel-horas"
smoke ana
afirma "journal do kernel com 6 dias e 1 hora: nao arredonda para 7" grep -q 'cobertura do kernel: 6 dia(s) completo(s) (145 horas)' "$TMP/s.txt"
nega "6 dias e 1 hora nao vira 7 dias" grep -q 'cobertura do kernel: 7 dias' "$TMP/s.txt"
rm -f "$STUB_ESTADO/kernel-horas"
: >"$STUB_ESTADO/kernel-vazio"
smoke ana
afirma "journal do kernel sem entradas: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nenhum OOM achado, mas o journal do kernel' "$TMP/s.txt"
rm -f "$STUB_ESTADO/kernel-vazio"; : >"$STUB_ESTADO/oom-host"
smoke ana
afirma "OOM no kernel: FALHA" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias' "$TMP/s.txt"
afirma "OOM so no kernel: diz que nao da para atribuir" grep -q 'nao diz de quem era o processo morto' "$TMP/s.txt"
nega "OOM so no kernel: nao manda aumentar o teto do agente" grep -q 'aumente o teto de memoria do agente' "$TMP/s.txt"
rm -f "$STUB_ESTADO/oom-host"; : >"$STUB_ESTADO/journal-host-erro"
smoke ana
afirma "journal do kernel com erro: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal' "$TMP/s.txt"

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

echo "smoke-entrega: cobertura por fonte (runner e kernel separados)"
limpar_estado
: >"$STUB_ESTADO/runner-vazio"
smoke ana
igual "runner vazio com kernel com historico: sai com 0" "0" "$?"
afirma "runner vazio: INCONCLUSIVO so do runner" grep -q 'INCONCLUSIVO \[3\] nenhum OOM achado, mas o journal do runner nao mostrou nenhuma entrada' "$TMP/s.txt"
nega "runner vazio nao imprime OK de OOM" grep -q 'OK     \[3\] nenhum OOM' "$TMP/s.txt"
nega "o INCONCLUSIVO nao acusa o kernel" grep -q 'mas o journal do runner e o journal do kernel' "$TMP/s.txt"
limpar_estado
echo 2 >"$STUB_ESTADO/runner-dias"
smoke ana
afirma "runner com 2 dias: diz a cobertura de cada fonte" grep -q 'cobertura do runner: 2 dia(s) completo(s) (48 horas)) nem no do kernel do servidor (cobertura do kernel: 9 dias\|cobertura do kernel: 7 dias' "$TMP/s.txt"

echo "smoke-entrega: OOM num journal com o outro ilegivel, saida cortada e systemctl com erro"
limpar_estado
: >"$STUB_ESTADO/oom-journal"; : >"$STUB_ESTADO/journal-host-erro"
smoke ana
igual "OOM no runner e kernel ilegivel: sai com 1" "1" "$?"
afirma "FALHA dizendo a fonte ilegivel (kernel)" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias.*o journal do kernel do servidor ficou ilegivel' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/oom-host"; : >"$STUB_ESTADO/journal-erro"
smoke ana
igual "OOM no kernel e runner ilegivel: sai com 1" "1" "$?"
afirma "FALHA dizendo a fonte ilegivel (runner)" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias.*o journal do runner ficou ilegivel' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/journal-grande"
smoke ana
igual "journal acima de 1 MiB: sem FALHA, sai com 0" "0" "$?"
afirma "journal acima de 1 MiB: INCONCLUSIVO de saida cortada" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal do runner.*saida cortada' "$TMP/s.txt"
nega "journal cortado nao diz 'nenhum OOM'" grep -q 'nenhum OOM' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/journal-oom-grande"
smoke ana
igual "OOM achado e leitura cortada em 1 MiB: sai com 1" "1" "$?"
afirma "OOM achado e leitura cortada: FALHA com nota de contagem parcial" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias.*contagem parcial' "$TMP/s.txt"
nega "OOM achado e leitura cortada nao vira INCONCLUSIVO de journal" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/tasks-quebras"
smoke ana
afirma "capt conta os bytes brutos: 2400 mais quebras acima do limite e INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] o systemctl do TasksMax.*codigo 99' "$TMP/s.txt"
nega "capt: quebras finais nao escondem o excesso (nao vira OK)" grep -q 'OK     \[3\] TasksMax' "$TMP/s.txt"
limpar_estado
cgroup 17000000000 8192
smoke ana
igual "memory.max acima da RAM: so aviso, sai com 0" "0" "$?"
afirma "memory.max igual ou maior que a RAM: AVISO" grep -q 'AVISO  \[3\] o container dgclaw-ana tem limite de memoria .* RAM do servidor' "$TMP/s.txt"
limpar_estado
{ head -c 1100000 /dev/zero | tr '\0' 'a'; printf '\nGROQ_API_KEY=\n'; } >"$ETC/web.env"
smoke ana
afirma "web.env acima de 1 MiB: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[5\] o web.env passa de 1 MiB' "$TMP/s.txt"
nega "web.env cortado nao vira OK nem FALHA de microfone" grep -qE '(OK     |FALHA  )\[5\] (o servico Web|o web.env nao tem)' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/systemctl-erro"
smoke ana
igual "systemctl com erro: sai com 0" "0" "$?"
afirma "TasksMax com systemctl em erro: INCONCLUSIVO com o codigo" grep -q 'INCONCLUSIVO \[3\] o systemctl do TasksMax.*codigo 3' "$TMP/s.txt"
afirma "NRestarts com systemctl em erro: INCONCLUSIVO com o codigo" grep -q 'INCONCLUSIVO \[3\] o systemctl do NRestarts.*codigo 3' "$TMP/s.txt"
nega "TasksMax com erro nao vira OK" grep -q 'OK     \[3\] TasksMax' "$TMP/s.txt"

echo "smoke-entrega: resposta com NUL ou linha extra do systemctl"
limpar_estado
: >"$STUB_ESTADO/tasks-nul"
smoke ana
afirma "TasksMax com byte NUL: INCONCLUSIVO (codigo 99)" grep -q 'INCONCLUSIVO \[3\] o systemctl do TasksMax.*codigo 99' "$TMP/s.txt"
nega "NUL nao vira OK" grep -q 'OK     \[3\] TasksMax' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/tasks-duas-linhas"
smoke ana
afirma "TasksMax com linha extra: INCONCLUSIVO, nao corta" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o TasksMax' "$TMP/s.txt"
nega "linha extra nao vira OK" grep -q 'OK     \[3\] TasksMax' "$TMP/s.txt"

echo "smoke-entrega: consulta ao cofre sem resposta valida"
limpar_estado
: >"$STUB_ESTADO/cofre-sem-saida"
smoke ana
igual "CLI do cofre sem saida: sai com 0" "0" "$?"
afirma "CLI sem saida: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[5\] a consulta ao cofre' "$TMP/s.txt"
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
smoke
igual "sem agente: sai com 2" "2" "$?"
smoke "ana;rm"
igual "nome invalido: sai com 2" "2" "$?"
smoke outro
igual "agente inexistente: sai com 2" "2" "$?"

fim
