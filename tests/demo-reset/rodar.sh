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
    DADOS="$R/var/lib/dgclaw/demo-web"
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
    mkdir -p "$CASA/.dgclaw/backups/memoria" "$CASA/.dgclaw/socorro" "$CASA/.dgclaw/logs" "$CASA/.dgclaw/panel" "$CASA/.dgclaw/tela"
    echo "copia da memoria do cliente anterior" >"$CASA/.dgclaw/backups/memoria/MEMORY.md.20261108-101010"
    echo '{"msg":"socorro do cliente"}' >"$CASA/.dgclaw/socorro/2026-11-08.jsonl"
    echo '{"arquivo":"MEMORY.md"}' >"$CASA/.dgclaw/logs/edicoes-memoria.jsonl"
    echo '{"sessoes":{"x":{"nome":"cliente"}}}' >"$CASA/.dgclaw/panel/sessoes-local.json"
    echo token-demo >"$CASA/.dgclaw/demo.token"; echo http://x >"$CASA/.dgclaw/demo.url"; echo chave-crm >"$CASA/.dgclaw/crm.key"
    echo vnc >"$CASA/.dgclaw/tela/vnc.senha"
    printf 'nova\ninstancia=nova\n' >"$DADOS/demo/INSTANCIA"
    echo '{"id":"c1"}' >"$DADOS/demo/cartoes/c1.json"
    echo '{"evento":"x"}' >"$DADOS/demo/auditoria.jsonl"
    echo '{"tarefas":[]}' >"$DADOS/mesa/tarefas.json"
    echo "# memoria semente" >"$SEM/MEMORY.md"
    echo "base da empresa" >"$SEM/memory/base.md"
    echo "boas-vindas" >"$SEM/arquivos/boas-vindas.txt"
    printf '{"agentes":[{"slug":"nova","runner":"http://127.0.0.1:1","container":"dgclaw-nova"}]}' >"$R/etc/dgclaw/agentes.json"
    chown -R "$DONO_U:$DONO_G" "$CASA"
    export STUB_LOG="$R/dgclaw.log" STUB_CASA="$CASA" STUB_CTR="$R/containers"
    : >"$STUB_LOG"
    unset STUB_ESCREVE_BACKUP STUB_PODMAN_FALHA STUB_POLITICA_ERRADA STUB_POLITICA_MODO STUB_RUNNER_FORA STUB_ESCREVE_MEMORIA STUB_FALHA_PARAR STUB_ESCREVE_ROLLOUT STUB_SUDO_FICA STUB_PAINEL_ATIVO DGCLAW_DEMO_UNIDADE
}

roda() { # roda [args...]: a saida fica em $R/saida.txt e o codigo em $RC
    DGCLAW_DEMO_PELO_PAINEL="${PELO_PAINEL-1}" DGCLAW_RAIZ="$R" DGCLAW_CLI="$AQUI/stubs/dgclaw" DGCLAW_PODMAN="$AQUI/stubs/podman" DGCLAW_DEMO_ESPERA=2 PATH="$AQUI/stubs:$PATH" "$RESET" "$@" >"$R/saida.txt" 2>&1
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
igual "parou e depois iniciou, nessa ordem" "dgclaw agente parar nova|dgclaw agente iniciar nova" "$(grep "^dgclaw " "$STUB_LOG" | paste -sd'|')"
afirma "o manifesto lista o que saiu" grep -q 'casa/.claude/projects' "$ARQ/MANIFESTO.txt"

echo "reset: copias de conteudo do painel (backups da memoria, socorro, registro de edicoes) vao para o arquivo"
afirma "a copia da memoria foi guardada" grep -q anterior "$ARQ/casa/.dgclaw/backups/memoria/MEMORY.md.20261108-101010"
nega "a copia da memoria saiu da casa" test -e "$CASA/.dgclaw/backups/memoria/MEMORY.md.20261108-101010"
afirma "o historico do socorro foi guardado" test -f "$ARQ/casa/.dgclaw/socorro/2026-11-08.jsonl"
nega "o historico do socorro saiu da casa" test -e "$CASA/.dgclaw/socorro/2026-11-08.jsonl"
afirma "o registro de edicoes da memoria foi guardado" test -f "$ARQ/casa/.dgclaw/logs/edicoes-memoria.jsonl"
afirma "o registro de sessoes paralelas foi guardado" test -f "$ARQ/casa/.dgclaw/panel/sessoes-local.json"
afirma "demo.token continua" grep -q token-demo "$CASA/.dgclaw/demo.token"
afirma "demo.url continua" test -f "$CASA/.dgclaw/demo.url"
afirma "crm.key continua" grep -q chave-crm "$CASA/.dgclaw/crm.key"
afirma "a senha da tela continua" test -f "$CASA/.dgclaw/tela/vnc.senha"

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

echo "reset: copia da memoria que reaparece reprova a conferencia"
monta backup
export STUB_ESCREVE_BACKUP=1
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "diz que ainda ha copia de conteudo" grep -q 'ainda há cópia de conteúdo' "$R/saida.txt"
unset STUB_ESCREVE_BACKUP

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

echo "reset: o bloqueio dos conectores do claude.ai entra no container, depois de ligar, e e conferido"
monta politica
roda nova --dados "$DADOS"
igual "sai com 0" 0 "$RC"
MODELO_SHA="$(sha256sum <"$REPO/templates/demo/managed-settings.json" | cut -d' ' -f1)"
igual "o modelo tem o conteudo exato pedido" '{"env":{"ENABLE_CLAUDEAI_MCP_SERVERS":"false"},"permissions":{"deny":["mcp__claude_ai_Gmail","mcp__claude_ai_Google_Calendar","mcp__claude_ai_Google_Drive","mcp__claude_ai_Claude_Docs","mcp__claude_ai_Figma","mcp__claude_ai_Meta_MCP"]}}' "$(cat "$REPO/templates/demo/managed-settings.json")"
igual "o container instalado (nome vem do registro) tem o arquivo igual ao modelo" "$MODELO_SHA" "$(sha256sum <"$R/containers/dgclaw-nova/managed-settings.json" | cut -d' ' -f1)"
igual "dono e permissao dentro do container" "root:root 644" "$(cat "$R/containers/dgclaw-nova/managed-settings.json.meta")"
afirma "a saida conta a etapa do bloqueio" grep -q '^==> Instalando o bloqueio dos conectores do claude.ai' "$R/saida.txt"
igual "ordem: parar, iniciar, politica, sudo, conferir politica (sha e dono), conferir sem sudo" "dgclaw agente parar nova|dgclaw agente iniciar nova|podman exec -i -u 0 dgclaw-nova sh|podman exec -i -u 0 dgclaw-nova sh|podman exec -u 0 dgclaw-nova sha256sum|podman exec -u 0 dgclaw-nova stat|podman exec -u agente dgclaw-nova true|podman exec -u agente dgclaw-nova sudo -n true" "$(cut -c1-80 "$STUB_LOG" | sed -E 's/(sha256sum|stat) .*/\1/; s/(sh) -c.*/\1/' | paste -sd'|')"
afirma "o sudoers do agente foi movido para o nome com ponto (e nao apagado)" grep -q "mv -f /etc/sudoers.d/agente /etc/sudoers.d/.agente-demo-desligado" "$STUB_LOG"
afirma "o agente ficou sem sudo no container" test -f "$R/containers/dgclaw-nova/sudo-desligado"

echo "reset: bloqueio com conteudo errado no container reprova a conferencia final"
monta politica-errada
export STUB_POLITICA_ERRADA=1
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "explica que o conteudo nao e o certo" grep -q 'não tem o conteúdo certo' "$R/saida.txt"
afirma "avisa que o agente ficou parado de proposito" grep -q 'ficou PARADO de propósito' "$R/saida.txt"
igual "o agente foi parado de novo no fim" "dgclaw agente parar nova" "$(grep '^dgclaw agente parar' "$STUB_LOG" | tail -1)"
unset STUB_POLITICA_ERRADA

echo "reset: bloqueio com dono ou permissao errados reprova a conferencia final"
monta politica-modo
export STUB_POLITICA_MODO="agente:agente 666"
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "explica o dono e a permissao" grep -q "root:root 644" "$R/saida.txt"
unset STUB_POLITICA_MODO

echo "reset: container que nao aceita o exec reprova com o motivo"
monta politica-falha
export STUB_PODMAN_FALHA=1
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "explica que nao instalou o bloqueio" grep -q 'não consegui instalar /etc/claude-code/managed-settings.json' "$R/saida.txt"
unset STUB_PODMAN_FALHA

echo "reset: registro sem o campo container recusa antes de mexer"
monta sem-container
printf '{"agentes":[{"slug":"nova","runner":"http://127.0.0.1:1"}]}' >"$R/etc/dgclaw/agentes.json"
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "explica o campo faltando" grep -q 'campo "container"' "$R/saida.txt"
afirma "nada foi parado" test ! -s "$STUB_LOG"
afirma "a conversa antiga continua" test -f "$CASA/.claude/projects/-home-agente/sessao.jsonl"

echo "reset: modelo adulterado e recusado antes de mexer"
monta modelo-ruim
echo '{"permissions":{"deny":[]}}' >"$R/modelo.json"
DGCLAW_DEMO_POLITICA="$R/modelo.json" roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "explica o sha256" grep -q 'sha256 diferente' "$R/saida.txt"
afirma "nada foi parado" test ! -s "$STUB_LOG"

echo "reset: --so-politica so instala e confere, sem parar o agente nem mover nada"
monta so-politica
roda nova --so-politica
igual "sai com 0" 0 "$RC"; [ "$RC" = 0 ] || sed "s/^/    | /" "$R/saida.txt"
igual "o arquivo esta no container" "$MODELO_SHA" "$(sha256sum <"$R/containers/dgclaw-nova/managed-settings.json" | cut -d' ' -f1)"
nega "o agente nao foi parado nem ligado" grep -q '^dgclaw ' "$STUB_LOG"
afirma "a conversa antiga continua onde estava" test -f "$CASA/.claude/projects/-home-agente/sessao.jsonl"
nega "nao criou pasta de arquivo" test -d "$R/var/lib/dgclaw/demo-arquivo"
export STUB_POLITICA_ERRADA=1
roda nova --so-politica
nega "com conteudo errado, o modo so-politica tambem reprova" test "$RC" = 0
unset STUB_POLITICA_ERRADA

echo "reset: o agente sem sudo (o container da imagem da NOPASSWD:ALL)"
monta sem-sudo
export STUB_SUDO_FICA=1
roda nova --dados "$DADOS"
nega "se o agente ainda tem sudo no fim, reprova" test "$RC" = 0
afirma "explica que o agente ainda consegue usar sudo" grep -q 'ainda consegue usar sudo' "$R/saida.txt"
afirma "e o agente fica parado de proposito" grep -q 'ficou PARADO de propósito' "$R/saida.txt"
unset STUB_SUDO_FICA

echo "reset: falha ao instalar a politica com o agente ligado PARA o agente"
monta para-instala
export STUB_PODMAN_FALHA=1
roda nova --dados "$DADOS"
nega "sai com erro" test "$RC" = 0
afirma "avisa que o agente ficou parado de proposito" grep -q 'ficou PARADO de propósito' "$R/saida.txt"
igual "o dgclaw parar rodou depois do iniciar" "dgclaw agente parar nova|dgclaw agente iniciar nova|dgclaw agente parar nova" "$(grep '^dgclaw ' "$STUB_LOG" | paste -sd'|')"
unset STUB_PODMAN_FALHA

echo "reset: --so-politica com falha tambem para o agente"
monta so-para
export STUB_SUDO_FICA=1
roda nova --so-politica
nega "sai com erro" test "$RC" = 0
afirma "avisa que o agente ficou parado de proposito" grep -q 'ficou PARADO de propósito' "$R/saida.txt"
afirma "o agente foi parado" grep -q '^dgclaw agente parar nova' "$STUB_LOG"
unset STUB_SUDO_FICA

echo "reset: --dados e obrigatorio e nao pode ser o painel principal"
monta sem-dados
roda nova
nega "sem --dados recusa" test "$RC" = 0
afirma "explica que falta --dados" grep -q 'falta --dados' "$R/saida.txt"
afirma "nada foi parado nem movido" test ! -s "$STUB_LOG"
afirma "a Mesa continua onde estava" test -f "$DADOS/mesa/tarefas.json"
mkdir -p "$R/var/lib/dgclaw/web/mesa" "$R/var/lib/dgclaw/web/demo"
echo '{"tarefas":["de outros agentes"]}' >"$R/var/lib/dgclaw/web/mesa/tarefas.json"
printf 'nova\ninstancia=nova\n' >"$R/var/lib/dgclaw/web/demo/INSTANCIA"
roda nova --dados "$R/var/lib/dgclaw/web"
nega "o painel principal e recusado, mesmo com a marca" test "$RC" = 0
afirma "explica que e o painel principal" grep -q 'painel principal' "$R/saida.txt"
afirma "a Mesa dos outros agentes continua" test -f "$R/var/lib/dgclaw/web/mesa/tarefas.json"
afirma "nada foi parado" test ! -s "$STUB_LOG"
mkdir -p "$R/var/lib/dgclaw/web-link"; ln -s "$R/var/lib/dgclaw/web" "$R/var/lib/dgclaw/web-link/x"
roda nova --dados "$R/var/lib/dgclaw/web-link/x"
nega "atalho para o painel principal tambem e recusado" test "$RC" = 0

echo "reset: --dados sem a marca do modo demonstracao, ou com marca de outro agente, e recusado"
monta sem-marca
rm "$DADOS/demo/INSTANCIA"
roda nova --dados "$DADOS"
nega "sem a marca recusa" test "$RC" = 0
afirma "explica que falta a marca" grep -q 'não tem a marca do modo demonstração' "$R/saida.txt"
afirma "nada foi parado" test ! -s "$STUB_LOG"
printf 'outro\ninstancia=outro\n' >"$DADOS/demo/INSTANCIA"
roda nova --dados "$DADOS"
nega "marca de outro agente recusa" test "$RC" = 0
afirma "explica de quem e a marca" grep -q 'é do agente "outro"' "$R/saida.txt"
afirma "a Mesa continua" test -f "$DADOS/mesa/tarefas.json"

echo "reset: pelo terminal so roda com o painel parado"
monta terminal
export STUB_PAINEL_ATIVO=1
PELO_PAINEL= roda nova --dados "$DADOS"
nega "com o painel rodando, o reset pelo terminal recusa" test "$RC" = 0
afirma "manda usar o botao ou parar o painel" grep -q 'Novo cliente (Reset)' "$R/saida.txt"
afirma "confere a unidade dgclaw-demo@nova" grep -q 'systemctl is-active --quiet dgclaw-demo@nova' "$STUB_LOG"
nega "o agente nao foi parado" grep -q '^dgclaw ' "$STUB_LOG"
afirma "a conversa antiga continua" test -f "$CASA/.claude/projects/-home-agente/sessao.jsonl"
DGCLAW_DEMO_UNIDADE=outra.service PELO_PAINEL= roda nova --dados "$DADOS"
nega "a unidade pode ser trocada (ainda ativa, recusa)" test "$RC" = 0
afirma "a unidade trocada foi a consultada" grep -q 'is-active --quiet outra.service' "$STUB_LOG"
unset STUB_PAINEL_ATIVO
PELO_PAINEL= roda nova --dados "$DADOS"
igual "com o painel parado, roda" 0 "$RC"
monta pelo-painel
export STUB_PAINEL_ATIVO=1
roda nova --dados "$DADOS"
igual "chamado pelo painel (DGCLAW_DEMO_PELO_PAINEL=1), roda mesmo com o painel ativo" 0 "$RC"
nega "e nem consulta o systemctl" grep -q '^systemctl' "$STUB_LOG"
unset STUB_PAINEL_ATIVO
monta so-pol-painel
export STUB_PAINEL_ATIVO=1
PELO_PAINEL= roda nova --so-politica
igual "--so-politica nao precisa da trava" 0 "$RC"
unset STUB_PAINEL_ATIVO

printf 'demo-reset: %s verificacoes, %s falharam\n' "$TESTES" "$FALHAS"
[ "$FALHAS" -eq 0 ]
