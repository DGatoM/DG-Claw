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

# Raiz falsa: Ubuntu 24.04, 16 GB de RAM, ffmpeg no servidor, agente ana com duas skills.
mkdir -p "$DGCLAW_RAIZ/etc" "$DGCLAW_RAIZ/proc" "$DGCLAW_RAIZ/usr/bin" "$CASA/.claude/skills/groq-audio" "$CASA/.claude/skills/gemini-gratuito"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$DGCLAW_RAIZ/etc/os-release"
printf 'MemTotal:       16384000 kB\n' >"$DGCLAW_RAIZ/proc/meminfo"
printf '#!/bin/sh\n' >"$DGCLAW_RAIZ/usr/bin/ffmpeg"; chmod +x "$DGCLAW_RAIZ/usr/bin/ffmpeg"
printf 'Use a GROQ_API_KEY do cofre.\n' >"$CASA/.claude/skills/groq-audio/SKILL.md"
printf 'Use a GEMINI_API_KEY do cofre.\n' >"$CASA/.claude/skills/gemini-gratuito/SKILL.md"
jq -n --arg casa "$CASA" '{versao: 1, agentes: [{slug: "ana", tipo: "agente", runner: "127.0.0.1:4301", home_host: $casa, provedor: "claude"}]}' \
    >"$ETC/agentes.json"
cofre_com() { # <nome>...: o cofre falso com essas chaves (e uma revogada, que nao conta)
    local n j='[{"envName":"VELHA_API_KEY","revogadaEm":"2026-01-01T00:00:00Z"}'
    for n in "$@"; do j+=",{\"envName\":\"$n\",\"ultimos4\":\"abcd\",\"revogadaEm\":null}"; done
    printf '{"ok":true,"chaves":%s]}' "$j" >"$STUB_ESTADO/cofre.json"
}
smoke() { bash "$SMOKE" "$@" >"$TMP/s.txt" 2>&1; }
limpar_estado() { find "$STUB_ESTADO" -mindepth 1 -delete; cofre_com GROQ_API_KEY GEMINI_API_KEY; : >"$STUB_LOG"; }

echo "smoke-entrega: tudo certo"
limpar_estado
smoke ana --video https://exemplo.com/video
igual "sai com 0" "0" "$?"
afirma "item 1 OK" grep -q 'OK     \[1\] Ubuntu 24.04' "$TMP/s.txt"
afirma "item 3 OK no pids.max" grep -q 'OK     \[3\] pids.max do container: sem limite' "$TMP/s.txt"
afirma "item 3 OK no TasksMax" grep -q 'OK     \[3\] TasksMax .*2400' "$TMP/s.txt"
afirma "item 3 OK no OOMPolicy" grep -q 'OK     \[3\] OOMPolicy=continue' "$TMP/s.txt"
afirma "item 3 OK sem OOM" grep -q 'OK     \[3\] nenhum OOM' "$TMP/s.txt"
afirma "item 5 OK com o GROQ" grep -q 'OK     \[5\] GROQ_API_KEY esta no cofre' "$TMP/s.txt"
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
echo 2147483648 >"$STUB_ESTADO/mem"; echo 1000000000 >"$STUB_ESTADO/nano"; echo oomfalta >"$STUB_ESTADO/oompolicy"
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
echo 1024 >"$STUB_ESTADO/pids-max"; echo 153 >"$STUB_ESTADO/tasksmax"; echo 3 >"$STUB_ESTADO/nrestarts"
: >"$STUB_ESTADO/oom-journal"; : >"$STUB_ESTADO/sem-ffmpeg-container"; : >"$STUB_ESTADO/chrome-sobra"
: >"$STUB_ESTADO/yt-falha"; : >"$STUB_ESTADO/sem-sessao"
smoke ana --video https://exemplo.com/video
igual "sai com 1" "1" "$?"
afirma "FALHA no pids.max" grep -q 'FALHA  \[3\] pids.max do container e 1024' "$TMP/s.txt"
afirma "FALHA no TasksMax com o que fazer" grep -q 'FALHA  \[3\] TasksMax do dgclaw-runner e 153' "$TMP/s.txt"
afirma "FALHA no NRestarts" grep -q 'FALHA  \[3\] o runner reiniciou sozinho 3' "$TMP/s.txt"
afirma "FALHA no OOM" grep -q 'FALHA  \[3\] OOM nos ultimos 7 dias' "$TMP/s.txt"
afirma "FALHA sem GROQ" grep -q 'FALHA  \[5\] GROQ_API_KEY nao esta no cofre' "$TMP/s.txt"
afirma "FALHA no yt-dlp com a causa" grep -q 'FALHA  \[6\] o yt-dlp falhou .*not a bot' "$TMP/s.txt"
afirma "FALHA com Chrome sobrando" grep -q 'FALHA  \[7\] sobraram 2 processo' "$TMP/s.txt"
afirma "FALHA sem ffmpeg no container" grep -q 'FALHA  \[8\] ffmpeg nao esta no container' "$TMP/s.txt"
afirma "AVISO sem a sessao principal" grep -q 'AVISO  \[11\] nao vi o processo da sessao principal' "$TMP/s.txt"
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
afirma "FALHA do reparar com a mensagem" grep -q 'FALHA  \[11\] dgclaw agente reparar ana saiu com codigo 1: erro simulado' "$TMP/s.txt"
rm -f "$STUB_ESTADO/reparar-falha"; : >"$STUB_LOG"
smoke ana --sem-reparar
afirma "--sem-reparar nao chama o reparar" bash -c "! grep -q 'agente reparar' '$STUB_LOG'"

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
