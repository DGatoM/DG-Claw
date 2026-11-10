#!/usr/bin/env bash
# O bin/dgclaw-demo-reset (reset do modo demonstracao), numa raiz falsa e com o dgclaw e o curl de mentira.
# Confere: move e nao apaga, preserva identidade e login, recoloca a semente com o dono certo, a sessao do runner
# nao sobra, o slug e validado, e toda falha explica o motivo e deixa o que ja saiu guardado.
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
RESET="$REPO/bin/dgclaw-demo-reset"
FALHAS=0
TESTES=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok() { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }
afirma() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else mal "$d"; fi; }
nega() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then mal "$d"; else ok "$d"; fi; }
igual() { if [ "$2" = "$3" ]; then ok "$1"; else mal "$1 (esperado '$2', veio '$3')"; fi; }

# Como root, a casa vira de outro uid (o que acontece de verdade, com o container sem root); senao fica do usuario atual.
if [ "$(id -u)" = 0 ]; then DONO_U=4242; DONO_G=4343; else DONO_U="$(id -u)"; DONO_G="$(id -g)"; fi

# monta <nome>: raiz falsa nova em $TMP/<nome> com a casa, os dados do painel e a semente.
monta() {
    R="$TMP/$1"
    CASA="$R/var/lib/dgclaw/agentes/nova/home"
    DADOS="$R/var/lib/dgclaw/web"
    SEM="$R/var/lib/dgclaw/demo-semente/nova"
    mkdir -p "$CASA/.claude/projects/-home-agente" "$CASA/.claude/skills/x" "$CASA/.plataforma/dgchat" "$CASA/memory" "$CASA/arquivos" \
             "$DADOS/demo/cartoes" "$DADOS/mesa" "$SEM/memory" "$SEM/arquivos" "$R/etc/dgclaw"
    echo '{"conversa":"cliente antigo"}' >"$CASA/.claude/projects/-home-agente/sessao.jsonl"
    echo '{"cmd":"x"}' >"$CASA/.claude/history.jsonl"
    echo '{"token":"login"}' >"$CASA/.claude/.credentials.json"
    echo skill >"$CASA/.claude/skills/x/SKILL.md"
    echo "# identidade" >"$CASA/AGENT.md"
    echo "# regras" >"$CASA/CLAUDE.md"
    echo identidade >"$CASA/.plataforma/identidade.md"
    echo '{"sessionId":"sessao-antiga"}' >"$CASA/.plataforma/runner-state.json"
    echo '{"a":1}' >"$CASA/.plataforma/dgchat/outbound.jsonl"
    echo "memoria do cliente anterior" >"$CASA/memory/2026-11-08.md"
    echo "# memoria" >"$CASA/MEMORY.md"
    echo "proposta" >"$CASA/arquivos/proposta.pdf"
    echo '{"id":"c1"}' >"$DADOS/demo/cartoes/c1.json"
    echo '{"evento":"x"}' >"$DADOS/demo/auditoria.jsonl"
    echo '{"tarefas":[]}' >"$DADOS/mesa/tarefas.json"
    echo "# memoria semente" >"$SEM/MEMORY.md"
    echo "base da empresa" >"$SEM/memory/base.md"
    echo "boas-vindas" >"$SEM/arquivos/boas-vindas.txt"
    printf '{"agentes":[{"slug":"nova","runner":"http://127.0.0.1:1"}]}' >"$R/etc/dgclaw/agentes.json"
    chown -R "$DONO_U:$DONO_G" "$CASA"
    export STUB_LOG="$R/dgclaw.log" STUB_CASA="$CASA"
    : >"$STUB_LOG"
    unset STUB_RUNNER_FORA STUB_ESCREVE_MEMORIA STUB_FALHA_PARAR STUB_ESCREVE_ROLLOUT
}

roda() { # roda [args...]: a saida fica em $R/saida.txt e o codigo em $RC
    DGCLAW_RAIZ="$R" DGCLAW_CLI="$AQUI/stubs/dgclaw" DGCLAW_DEMO_ESPERA=2 PATH="$AQUI/stubs:$PATH" "$RESET" "$@" >"$R/saida.txt" 2>&1
    RC=$?
}
arquivo_dir() { find "$R/var/lib/dgclaw/demo-arquivo/nova" -mindepth 1 -maxdepth 1 -type d | sort | tail -1; }

echo "reset: o slug e validado antes de qualquer coisa"
monta slug
for ruim in "../x" "Nova" "a b" "" "-x" "$(printf 'a%.0s' {1..40})"; do
    roda "$ruim"
    nega "slug '${ruim:0:12}' e recusado" test "$RC" = 0
done
afirma "nada foi parado nem movido com slug ruim" test ! -s "$STUB_LOG"
afirma "a conversa antiga continua onde estava" test -f "$CASA/.claude/projects/-home-agente/sessao.jsonl"

echo "reset: caminho feliz"
monta feliz
roda nova --dados "$DADOS"
igual "sai com 0" 0 "$RC"
ARQ="$(arquivo_dir)"
afirma "a saida conta as etapas (==>)" grep -q '^==> Parando o agente nova' "$R/saida.txt"
afirma "a conversa antiga foi guardada no arquivo, nao apagada" test -f "$ARQ/casa/.claude/projects/-home-agente/sessao.jsonl"
nega "a conversa antiga saiu da casa" test -e "$CASA/.claude/projects/-home-agente/sessao.jsonl"
afirma "o historico de comandos foi guardado" test -f "$ARQ/casa/.claude/history.jsonl"
afirma "a memoria antiga foi guardada" test -f "$ARQ/casa/memory/2026-11-08.md"
nega "a memoria antiga saiu da casa" test -e "$CASA/memory/2026-11-08.md"
afirma "o arquivo do cliente foi guardado" test -f "$ARQ/casa/arquivos/proposta.pdf"
nega "o arquivo do cliente saiu da casa" test -e "$CASA/arquivos/proposta.pdf"
afirma "a fila de mensagens da conversa foi guardada" test -f "$ARQ/casa/.plataforma/dgchat/outbound.jsonl"
afirma "os cartoes do painel foram guardados" test -f "$ARQ/web/demo/cartoes/c1.json"
afirma "a mesa foi guardada" test -f "$ARQ/web/mesa/tarefas.json"
nega "os cartoes saíram da pasta do painel" test -e "$DADOS/demo/cartoes/c1.json"
afirma "a auditoria do painel fica onde estava" test -f "$DADOS/demo/auditoria.jsonl"
afirma "o login continua" grep -q login "$CASA/.claude/.credentials.json"
afirma "a identidade continua" grep -q identidade "$CASA/AGENT.md"
afirma "o CLAUDE.md continua" test -f "$CASA/CLAUDE.md"
afirma "a identidade do ambiente continua" test -f "$CASA/.plataforma/identidade.md"
afirma "as skills continuam" test -f "$CASA/.claude/skills/x/SKILL.md"
afirma "a semente voltou (memoria)" grep -q semente "$CASA/MEMORY.md"
afirma "a semente voltou (pasta)" test -f "$CASA/memory/base.md"
afirma "a semente voltou (arquivos)" test -f "$CASA/arquivos/boas-vindas.txt"
igual "o dono da semente copiada e o dono da casa" "$DONO_U:$DONO_G" "$(stat -c '%u:%g' "$CASA/memory/base.md")"
igual "o dono do MEMORY.md copiado e o dono da casa" "$DONO_U:$DONO_G" "$(stat -c '%u:%g' "$CASA/MEMORY.md")"
igual "a pasta recriada tem o dono da casa" "$DONO_U:$DONO_G" "$(stat -c '%u:%g' "$CASA/.plataforma/dgchat")"
igual "a sessao do runner e nova (sem --resume da antiga)" '{"sessionId":"sessao-nova"}' "$(tr -d '\n' <"$CASA/.plataforma/runner-state.json")"
afirma "o estado antigo do runner esta no arquivo" grep -q sessao-antiga "$ARQ/casa/.plataforma/runner-state.json"
igual "a pasta de arquivo e 700" 700 "$(stat -c '%a' "$ARQ")"
igual "a pasta base do arquivo e 700" 700 "$(stat -c '%a' "$R/var/lib/dgclaw/demo-arquivo/nova")"
igual "parou e depois iniciou, nessa ordem" "dgclaw agente parar nova|dgclaw agente iniciar nova" "$(paste -sd'|' "$STUB_LOG")"
afirma "o manifesto lista o que saiu" grep -q 'casa/.claude/projects' "$ARQ/MANIFESTO.txt"

echo "reset: rodar de novo guarda em outra pasta e nao apaga o primeiro"
echo "outra conversa" >"$CASA/arquivos/outro.txt"
STUB_SESSAO_NOVA=sessao-terceira roda nova --dados "$DADOS"
igual "segundo reset sai com 0" 0 "$RC"; [ "$RC" = 0 ] || sed "s/^/    | /" "$R/saida.txt"
igual "ha duas pastas de arquivo" 2 "$(find "$R/var/lib/dgclaw/demo-arquivo/nova" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
afirma "o primeiro arquivo continua inteiro" test -f "$ARQ/casa/arquivos/proposta.pdf"

echo "reset: a semente com atalho e recusada antes de mexer"
monta atalho
ln -s /etc/passwd "$SEM/memory/atalho"
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "explica o motivo" grep -q 'tem atalhos' "$R/saida.txt"
afirma "a conversa antiga continua na casa" test -f "$CASA/.claude/projects/-home-agente/sessao.jsonl"
afirma "o agente nem foi parado" test ! -s "$STUB_LOG"

echo "reset: a semente nao pode trazer identidade nem login"
monta ident
echo "# outra identidade" >"$SEM/AGENT.md"
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "explica que identidade nao sai" grep -q 'AGENT.md' "$R/saida.txt"
afirma "a identidade original continua" grep -q '# identidade' "$CASA/AGENT.md"

echo "reset: atalho dentro da casa nao leva o root para fora dela"
monta link
mkdir -p "$TMP/fora/projects"
echo "nao mexa" >"$TMP/fora/projects/x"
rm -rf "$CASA/.claude/projects"
ln -s "$TMP/fora" "$CASA/.claude/projects"
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "explica o atalho" grep -q 'atalho' "$R/saida.txt"
afirma "o que esta fora da casa nao foi tocado" test -f "$TMP/fora/projects/x"
afirma "a mensagem avisa que o agente ficou parado" grep -q 'ficou PARADO' "$R/saida.txt"

echo "reset: runner que nao volta"
monta runner
export STUB_RUNNER_FORA=1
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "diz que o runner nao respondeu e onde olhar" grep -q 'o runner não respondeu' "$R/saida.txt"
afirma "o que saiu continua guardado" test -f "$(arquivo_dir)/casa/memory/2026-11-08.md"
unset STUB_RUNNER_FORA

echo "reset: memoria antiga que reaparece reprova a conferencia"
monta memoria
export STUB_ESCREVE_MEMORIA=1
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "diz que ha memoria que nao veio da semente" grep -q 'memória que não veio da semente' "$R/saida.txt"
unset STUB_ESCREVE_MEMORIA

echo "reset: sessao antiga que continua reprova a conferencia"
monta sessao
export STUB_SESSAO_NOVA=sessao-antiga
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "diz que o runner manteve a sessao antiga" grep -q 'continua com a sessão antiga' "$R/saida.txt"
unset STUB_SESSAO_NOVA

echo "reset: agente que nao para"
monta parar
export STUB_FALHA_PARAR=1
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "explica que nao parou" grep -q 'não consegui parar' "$R/saida.txt"
afirma "nada foi movido" test -f "$CASA/.claude/projects/-home-agente/sessao.jsonl"
unset STUB_FALHA_PARAR

echo "reset: atalho plantado onde a semente tem arquivo nao leva o root para fora"
monta plantado
mkdir -p "$TMP/host" "$TMP/hostdir"
echo "arquivo do host" >"$TMP/host/alvo.txt"
echo "intacto" >"$TMP/hostdir/config.txt"
mkdir -p "$SEM/.config/app" "$SEM/.local/app" "$CASA/.config/app"
echo "da semente" >"$SEM/.config/app/config.txt"
echo "da semente" >"$SEM/.local/app/dado.txt"
ln -s "$TMP/host/alvo.txt" "$CASA/.config/app/config.txt"
ln -s "$TMP/hostdir" "$CASA/.local"
roda nova --dados "$DADOS"
igual "sai com 0" 0 "$RC"; [ "$RC" = 0 ] || sed "s/^/    | /" "$R/saida.txt"
ARQ="$(arquivo_dir)"
igual "o arquivo do host nao foi tocado" "arquivo do host" "$(cat "$TMP/host/alvo.txt")"
igual "a pasta do host nao ganhou arquivo" "config.txt" "$(ls "$TMP/hostdir")"
igual "o conteudo do host continua" "intacto" "$(cat "$TMP/hostdir/config.txt")"
afirma "a semente chegou no lugar (arquivo)" grep -q 'da semente' "$CASA/.config/app/config.txt"
nega "o lugar nao e mais atalho (arquivo)" test -L "$CASA/.config/app/config.txt"
nega "o lugar nao e mais atalho (pasta)" test -L "$CASA/.local"
afirma "a semente chegou no lugar (pasta)" test -f "$CASA/.local/app/dado.txt"
afirma "o atalho de arquivo foi guardado, nao apagado" test -L "$ARQ/casa-substituido/.config/app/config.txt"
afirma "o atalho de pasta foi guardado, nao apagado" test -L "$ARQ/casa-substituido/.local"
nega "sobrou pasta de preparo" test -n "$(find "$CASA" -maxdepth 1 -name '.dgclaw-semente.*' -print -quit)"

echo "reset: pasta de topo da semente (dados/, plano-b/) volta inteira, e o que o agente mexeu vai para o arquivo"
monta topo
mkdir -p "$SEM/dados/base" "$SEM/plano-b" "$CASA/dados/base" "$CASA/dados/trabalho" "$CASA/plano-b"
echo "original" >"$SEM/dados/base/kit.txt"
echo "plano da semente" >"$SEM/plano-b/plano.txt"
echo "kit alterado" >"$CASA/dados/base/kit.txt"
echo "feito na reuniao" >"$CASA/dados/trabalho/x.txt"
echo "plano mexido" >"$CASA/plano-b/plano.txt"
echo "extra" >"$CASA/plano-b/extra.txt"
chown -R "$DONO_U:$DONO_G" "$CASA"
roda nova --dados "$DADOS"
igual "sai com 0" 0 "$RC"; [ "$RC" = 0 ] || sed "s/^/    | /" "$R/saida.txt"
ARQ="$(arquivo_dir)"
igual "dados/ e o da semente" "original" "$(cat "$CASA/dados/base/kit.txt")"
nega "o trabalho da reuniao saiu de dados/" test -e "$CASA/dados/trabalho"
nega "o extra saiu de plano-b/" test -e "$CASA/plano-b/extra.txt"
igual "plano-b/ e o da semente" "plano da semente" "$(cat "$CASA/plano-b/plano.txt")"
afirma "o trabalho alterado esta no arquivo" grep -q 'feito na reuniao' "$ARQ/casa-substituido/dados/trabalho/x.txt"
afirma "o kit alterado esta no arquivo" grep -q 'kit alterado' "$ARQ/casa-substituido/dados/base/kit.txt"
afirma "o extra esta no arquivo" test -f "$ARQ/casa-substituido/plano-b/extra.txt"
igual "o dono de dados/ e o da casa" "$DONO_U:$DONO_G" "$(stat -c '%u:%g' "$CASA/dados/base/kit.txt")"
afirma "a identidade continua" grep -q identidade "$CASA/AGENT.md"

echo "reset: historicos de sessao do Claude e dos dois modos do Codex"
monta historicos
mkdir -p "$CASA/.codex/sessions/2026/11/08" "$CASA/.plataforma/codex-api/x/sessions/2026/11/08" "$CASA/.plataforma/codex-api/y/archived_sessions" "$CASA/.claude/session-env/s"
echo '{"r":1}' >"$CASA/.codex/sessions/2026/11/08/rollout-a.jsonl"
echo '{"r":2}' >"$CASA/.plataforma/codex-api/x/sessions/2026/11/08/rollout-b.jsonl"
echo '{"r":3}' >"$CASA/.plataforma/codex-api/y/archived_sessions/rollout-c.jsonl"
echo '{"h":1}' >"$CASA/.codex/history.jsonl"
echo x >"$CASA/.codex/state_5.sqlite"
echo x >"$CASA/.claude/session-env/s/env"
echo '{"auth":"assinatura"}' >"$CASA/.codex/auth.json"
echo '{"auth":"api"}' >"$CASA/.plataforma/codex-api/x/auth.json"
echo sha >"$CASA/.plataforma/codex-api/x/.dgclaw-chave.sha256"
chown -R "$DONO_U:$DONO_G" "$CASA"
roda nova --dados "$DADOS"
igual "sai com 0" 0 "$RC"; [ "$RC" = 0 ] || sed "s/^/    | /" "$R/saida.txt"
ARQ="$(arquivo_dir)"
afirma "rollout da assinatura guardado" test -f "$ARQ/casa/.codex/sessions/2026/11/08/rollout-a.jsonl"
afirma "rollout do Codex por API guardado" test -f "$ARQ/casa/.plataforma/codex-api/x/sessions/2026/11/08/rollout-b.jsonl"
afirma "sessao arquivada do Codex por API guardada" test -f "$ARQ/casa/.plataforma/codex-api/y/archived_sessions/rollout-c.jsonl"
afirma "historico do Codex guardado" test -f "$ARQ/casa/.codex/history.jsonl"
afirma "banco de estado do Codex guardado" test -f "$ARQ/casa/.codex/state_5.sqlite"
afirma "session-env do Claude guardado" test -f "$ARQ/casa/.claude/session-env/s/env"
igual "nenhum rollout sobrou na casa" "" "$(find "$CASA" -name 'rollout-*' -print)"
afirma "auth.json da assinatura continua" grep -q assinatura "$CASA/.codex/auth.json"
afirma "auth.json da API continua" grep -q '"api"' "$CASA/.plataforma/codex-api/x/auth.json"
afirma "o hash da chave continua" test -f "$CASA/.plataforma/codex-api/x/.dgclaw-chave.sha256"

echo "reset: rollout que reaparece reprova a conferencia"
monta rollout
export STUB_ESCREVE_ROLLOUT=1
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "diz que ainda ha historico de sessao" grep -q 'ainda há histórico de sessão' "$R/saida.txt"
unset STUB_ESCREVE_ROLLOUT

echo "reset: dois resets ao mesmo tempo"
monta trava
mkdir -p "$R/var/lock"
(
    exec 8>"$R/var/lock/dgclaw-demo-reset-nova.lock"
    flock 8
    roda nova --dados "$DADOS"
    echo "$RC" >"$R/rc-trava.txt"
)
igual "o segundo reset recusa" 1 "$(cat "$R/rc-trava.txt")"
afirma "diz que ja ha um em andamento" grep -q 'já existe um reset' "$R/saida.txt"

printf 'demo-reset: %s verificacoes, %s falharam\n' "$TESTES" "$FALHAS"
[ "$FALHAS" -eq 0 ]
