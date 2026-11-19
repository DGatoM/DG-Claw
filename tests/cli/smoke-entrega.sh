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
export DGCLAW_SMOKE_ESPERA=2
CASA="$DGCLAW_RAIZ/var/lib/dgclaw/agentes/ana/home"
CG="$DGCLAW_RAIZ/sys/fs/cgroup/machine.slice/libpod-abc.scope"
HOME_FALSA="$STUB_ESTADO/home"   # a casa do agente "dentro do container" (o stub redireciona para ela)

# Raiz falsa: Ubuntu 24.04, 16 GB de RAM, ffmpeg no servidor, agente ana com duas skills.
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
cgroup() { printf '%s\n' "$1" >"$CG/memory.max"; printf '%s\n' "$2" >"$CG/pids.max"; }
skills_padrao() { # as duas skills de sempre, na casa falsa do agente
    mkdir -p "$HOME_FALSA/.claude/skills/groq-audio" "$HOME_FALSA/.claude/skills/gemini-gratuito"
    printf 'Use a GROQ_API_KEY do cofre.\n' >"$HOME_FALSA/.claude/skills/groq-audio/SKILL.md"
    printf 'Use a GEMINI_API_KEY do cofre.\n' >"$HOME_FALSA/.claude/skills/gemini-gratuito/SKILL.md"
}
smoke() { bash "$SMOKE" "$@" >"$TMP/s.txt" 2>&1; }
limpar_estado() { find "$STUB_ESTADO" -mindepth 1 -delete; cofre_com GROQ_API_KEY GEMINI_API_KEY; skills_padrao; cgroup 4294967296 8192; printf 'GROQ_API_KEY=gsk_segredo_do_teste\nOUTRA=1\n' >"$ETC/web.env"; : >"$STUB_LOG"; }

echo "smoke-entrega: tudo certo"
limpar_estado
smoke ana --video https://exemplo.com/video
igual "sai com 0" "0" "$?"
afirma "item 1 OK" grep -q 'OK     \[1\] Ubuntu 24.04' "$TMP/s.txt"
afirma "item 3 OK no pids.max" grep -q 'OK     \[3\] pids.max do container: 8192' "$TMP/s.txt"
afirma "item 3 OK no TasksMax" grep -q 'OK     \[3\] TasksMax .*2400' "$TMP/s.txt"
afirma "item 3 OK no OOMPolicy" grep -q 'OK     \[3\] OOMPolicy=continue' "$TMP/s.txt"
afirma "item 3 OK sem OOM" grep -q 'OK     \[3\] nenhum OOM' "$TMP/s.txt"
afirma "item 5 OK no microfone (web.env)" grep -q 'OK     \[5\] o servico Web tem chave para o microfone e o audio: GROQ_API_KEY' "$TMP/s.txt"
nega "nao mostra o valor da chave do web.env" grep -q 'gsk_segredo' "$TMP/s.txt"
afirma "item 5 OK nas skills" grep -q 'OK     \[5\] toda chave citada pelas skills' "$TMP/s.txt"
afirma "item 6 OK no yt-dlp.conf" grep -q 'OK     \[6\] /etc/yt-dlp.conf tem a diretiva --js-runtimes node' "$TMP/s.txt"
afirma "item 6 OK no perfil da Tela" grep -q 'OK     \[6\] o perfil da Tela existe' "$TMP/s.txt"
afirma "item 6 deixa o YouTube PENDENTE" grep -q 'PENDENTE \[6\] autenticacao do YouTube' "$TMP/s.txt"
afirma "a varredura das skills roda como agente, com --user" grep -q 'podman exec --user agente dgclaw-ana sh -c' "$STUB_LOG"
afirma "o download usa pasta privada e apaga so ela" grep -q 'rm -rf -- /tmp/smoke-entrega.abc123$' "$STUB_LOG"
nega "nao usa o /tmp fixo antigo" grep -q 'smoke-entrega-yt' "$STUB_LOG"
afirma "item 6 OK no download" grep -q 'OK     \[6\] o yt-dlp baixou' "$TMP/s.txt"
afirma "item 7 OK sem sobra de Chrome" grep -q 'OK     \[7\] render headless terminou' "$TMP/s.txt"
afirma "item 8 OK no servidor e no container" bash -c "grep -c 'OK     \[8\]' '$TMP/s.txt' | grep -qx 2"
afirma "item 11 OK com a sessao de pe" grep -q 'OK     \[11\] a sessao principal' "$TMP/s.txt"
afirma "chamou o reparar" grep -q '^dgclaw agente reparar ana' "$STUB_LOG"
nega "nao imprime FALHA" grep -q 'FALHA' "$TMP/s.txt"
afirma "lista o que fica a mao" grep -q 'Conferir a mao' "$TMP/s.txt"
nega "nao mostra valor de chave (so o nome)" grep -q 'abcd' "$TMP/s.txt"
nega "a chave revogada nao conta" grep -q 'VELHA_API_KEY' "$TMP/s.txt"

echo "smoke-entrega: avisos nao derrubam (memoria, CPU, 26.04, sem --video)"
limpar_estado
printf 'ID=ubuntu\nVERSION_ID="26.04"\n' >"$DGCLAW_RAIZ/etc/os-release"
cgroup 2147483648 8192; echo 1000000000 >"$STUB_ESTADO/nano"; echo stop >"$STUB_ESTADO/oompolicy"
echo /opt/venv/bin/yt-dlp >"$STUB_ESTADO/yt-path"; : >"$STUB_ESTADO/sem-yt-config"
smoke ana
igual "sai com 0 so com avisos" "0" "$?"
afirma "avisa do 26.04" grep -q 'AVISO  \[1\] Ubuntu 26.04' "$TMP/s.txt"
afirma "avisa da memoria com o comando" grep -q 'podman update --memory 7g dgclaw-ana' "$TMP/s.txt"
afirma "avisa da CPU" grep -q 'AVISO  \[3\] o container tem 1 CPU' "$TMP/s.txt"
afirma "avisa do OOMPolicy (a partir da 1.1.1)" grep -q 'AVISO  \[3\] OOMPolicy.*1.1.1' "$TMP/s.txt"
afirma "avisa do yt-dlp fora do /usr/local/bin" grep -q 'AVISO  \[6\] o yt-dlp esta em /opt/venv/bin/yt-dlp' "$TMP/s.txt"
afirma "avisa que o download nao rodou" grep -q 'AVISO  \[6\] o download de teste nao rodou' "$TMP/s.txt"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$DGCLAW_RAIZ/etc/os-release"

echo "smoke-entrega: skill cita chave que falta no cofre"
limpar_estado
cofre_com GROQ_API_KEY
smoke ana
igual "so aviso, sai com 0" "0" "$?"
afirma "avisa da GEMINI_API_KEY" grep -q "AVISO  \[5\] a skill 'gemini-gratuito' cita GEMINI_API_KEY" "$TMP/s.txt"

echo "smoke-entrega: varias FALHAS"
limpar_estado
cofre_com GEMINI_API_KEY
printf 'OUTRA=1\n' >"$ETC/web.env"
cgroup 4294967296 1024; echo 153 >"$STUB_ESTADO/tasksmax"; echo 3 >"$STUB_ESTADO/nrestarts"
: >"$STUB_ESTADO/oom-journal"; : >"$STUB_ESTADO/sem-ffmpeg-container"; : >"$STUB_ESTADO/chrome-sobra"
: >"$STUB_ESTADO/yt-falha"
printf '%s' '{"ok":true,"agente":{"slug":"ana","status":"idle","ptyVivo":false},"sessoes":[{"id":"p1","tipo":"paralela","status":"working","ptyVivo":true}]}' >"$STUB_ESTADO/saude.json"
smoke ana --video https://exemplo.com/video
igual "sai com 1" "1" "$?"
afirma "FALHA no pids.max" grep -q 'FALHA  \[3\] pids.max do container e 1024' "$TMP/s.txt"
afirma "FALHA no TasksMax com o que fazer" grep -q 'FALHA  \[3\] TasksMax do dgclaw-runner e 153' "$TMP/s.txt"
afirma "FALHA no NRestarts" grep -q 'FALHA  \[3\] o runner reiniciou sozinho 3' "$TMP/s.txt"
afirma "FALHA no OOM" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias' "$TMP/s.txt"
afirma "FALHA sem chave de microfone no web.env" grep -q 'FALHA  \[5\] o web.env nao tem GROQ_API_KEY' "$TMP/s.txt"
afirma "FALHA no yt-dlp com o codigo" grep -q 'FALHA  \[6\] o yt-dlp falhou (codigo 1)' "$TMP/s.txt"
nega "a saida do yt-dlp nao entra no relatorio" grep -q 'not a bot' "$TMP/s.txt"
afirma "as dicas de recriar nao mandam --forcar" bash -c "! grep -q -- 'recriar ana --forcar' '$TMP/s.txt'"
afirma "a dica de recriar manda olhar antes de perder" grep -q 'decida com o dono antes de qualquer perda' "$TMP/s.txt"
afirma "FALHA com Chrome sobrando" grep -q 'FALHA  \[7\] sobraram 2 processo' "$TMP/s.txt"
afirma "FALHA sem ffmpeg no container" grep -q 'FALHA  \[8\] ffmpeg nao esta no container' "$TMP/s.txt"
afirma "FALHA com a sessao principal parada" grep -q 'FALHA  \[11\] a sessao principal do agente ana esta parada' "$TMP/s.txt"
afirma "o resumo manda nao entregar" grep -q 'NAO entregue a VPS' "$TMP/s.txt"

echo "smoke-entrega: runner nao volta, reparar falha"
limpar_estado
: >"$STUB_ESTADO/runner-mudo"
smoke ana
igual "runner mudo: sai com 1" "1" "$?"
afirma "FALHA do runner sem resposta" grep -q 'FALHA  \[11\] o runner nao respondeu' "$TMP/s.txt"
rm -f "$STUB_ESTADO/runner-mudo"; : >"$STUB_ESTADO/reparar-falha"
smoke ana
igual "reparar falho: sai com 1" "1" "$?"
afirma "FALHA do reparar com o codigo" grep -q 'FALHA  \[11\] dgclaw agente reparar ana saiu com codigo 1\.' "$TMP/s.txt"
rm -f "$STUB_ESTADO/reparar-falha"; : >"$STUB_LOG"
smoke ana --sem-reparar
afirma "--sem-reparar nao chama o reparar" bash -c "! grep -q 'agente reparar' '$STUB_LOG'"

echo "smoke-entrega: memoria e processos sem limite no cgroup"
limpar_estado
cgroup max max
smoke ana
igual "sem limite: sai com 1" "1" "$?"
afirma "FALHA sem limite de processos" grep -q 'FALHA  \[3\] o container dgclaw-ana esta sem limite de processos' "$TMP/s.txt"
afirma "FALHA sem limite de memoria" grep -q 'FALHA  \[3\] o container dgclaw-ana esta sem limite de memoria' "$TMP/s.txt"
limpar_estado
echo /machine.slice/../../etc >"$STUB_ESTADO/cgpath"
smoke ana
afirma "caminho de cgroup invalido: INCONCLUSIVO, nao FALHA nem OK" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o limite de processos' "$TMP/s.txt"
nega "caminho invalido nao vira OK de pids" grep -q 'OK     \[3\] pids.max' "$TMP/s.txt"

echo "smoke-entrega: erro de leitura e INCONCLUSIVO (journal, Chrome, varredura, OOMPolicy)"
limpar_estado
: >"$STUB_ESTADO/journal-erro"; : >"$STUB_ESTADO/chrome-erro"; : >"$STUB_ESTADO/scan-erro"; echo inventado >"$STUB_ESTADO/oompolicy"
smoke ana
igual "so inconclusivo e aviso: sai com 0" "0" "$?"
afirma "journal com erro: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[3\] nao consegui ler o journal' "$TMP/s.txt"
nega "journal com erro nao diz 'nenhum OOM'" grep -q 'nenhum OOM' "$TMP/s.txt"
afirma "contagem do Chrome com erro: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[7\] nao consegui contar' "$TMP/s.txt"
afirma "varredura com erro: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[5\] nao consegui varrer as skills' "$TMP/s.txt"
nega "varredura com erro nao diz que esta tudo no cofre" grep -q 'toda chave citada' "$TMP/s.txt"
afirma "OOMPolicy fora da lista fechada: aviso fixo" grep -q 'AVISO  \[3\] o OOMPolicy do runner veio com um valor que nao conheco' "$TMP/s.txt"
nega "o valor de fora nao e impresso" grep -q 'inventado' "$TMP/s.txt"
afirma "o resumo conta os inconclusivos" grep -qE 'Resumo: 0 falha.*[1-9][0-9]* inconclusivo' "$TMP/s.txt"

echo "smoke-entrega: varredura de skills (.claude e .agents, sublinhados internos, sem seguir link)"
limpar_estado
mkdir -p "$HOME_FALSA/.agents/skills/aviso-telegram" "$HOME_FALSA/.claude/skills/so-link" "$STUB_ESTADO/fora"
printf 'export TELEGRAM_BOT_TOKEN=...\n' >"$HOME_FALSA/.agents/skills/aviso-telegram/run.sh"
printf 'Use a FORA_DO_AGENTE_API_KEY.\n' >"$STUB_ESTADO/fora/SKILL.md"
ln -s "$STUB_ESTADO/fora" "$HOME_FALSA/.claude/skills/so-link/dentro"
ln -s "$STUB_ESTADO/fora" "$HOME_FALSA/.claude/skills/link-da-skill"
smoke ana
afirma "acha TELEGRAM_BOT_TOKEN (sublinhado interno) em .agents/skills" grep -q "AVISO  \[5\] a skill 'aviso-telegram' cita TELEGRAM_BOT_TOKEN" "$TMP/s.txt"
nega "nao segue link para fora da pasta do agente" grep -q 'FORA_DO_AGENTE_API_KEY' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/sem-pasta-skills"
rm -rf "$HOME_FALSA/.claude" "$HOME_FALSA/.agents"
smoke ana
afirma "sem pasta de skills: aviso" grep -q 'AVISO  \[5\] nao achei a pasta de skills' "$TMP/s.txt"

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

echo "smoke-entrega: download sem arquivo final e pasta privada"
limpar_estado
: >"$STUB_ESTADO/yt-vazio"
smoke ana --video https://exemplo.com/video
afirma "codigo 0 sem arquivo final: FALHA" grep -q 'FALHA  \[6\] o yt-dlp falhou (codigo 0) ou nao deixou um arquivo final' "$TMP/s.txt"
limpar_estado
: >"$STUB_ESTADO/mktemp-erro"
smoke ana --video https://exemplo.com/video
afirma "sem pasta privada: INCONCLUSIVO no download" grep -q 'INCONCLUSIVO \[6\] nao consegui criar a pasta privada' "$TMP/s.txt"
nega "sem pasta privada nao baixa nada" grep -q 'yt-dlp --no-playlist' "$STUB_LOG"

echo "smoke-entrega: sessao principal parada com paralela ativa, outro agente na porta, formato ilegivel"
limpar_estado
printf '%s' '{"ok":true,"agente":{"slug":"ana","status":"idle","ptyVivo":false},"sessoes":[{"id":"p1","tipo":"paralela","status":"working","ptyVivo":true}]}' >"$STUB_ESTADO/saude.json"
smoke ana
igual "principal parada: sai com 1" "1" "$?"
afirma "FALHA da principal parada" grep -q 'FALHA  \[11\] a sessao principal do agente ana esta parada' "$TMP/s.txt"
printf '%s' '{"ok":true,"agente":{"slug":"outra","status":"idle","ptyVivo":true}}' >"$STUB_ESTADO/saude.json"
smoke ana
afirma "slug de outro agente: FALHA" grep -q 'FALHA  \[11\] o runner na porta 4301 respondeu, mas' "$TMP/s.txt"
printf '%s' '"texto"' >"$STUB_ESTADO/saude.json"
smoke ana
afirma "JSON fora do formato: INCONCLUSIVO" grep -q 'INCONCLUSIVO \[11\]' "$TMP/s.txt"
printf '%s' '{"ok":true,"agente":{"slug":"ana","status":"working","ptyVivo":true}}' >"$STUB_ESTADO/saude.json"
smoke ana
igual "principal viva (working): sai com 0" "0" "$?"

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
