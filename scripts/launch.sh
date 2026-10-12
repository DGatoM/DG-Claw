#!/bin/bash
# launch.sh — Sobe a sessao longeva do assistente DG Claw.
#
# Chamado pelo servico systemd dgclaw-<slug>.service. Le a config do assistente
# em <workspace>/.dgclaw/config.sh, monta a identidade e da exec no `claude`.
#
# DOIS CANAIS, E SO UM E OBRIGATORIO:
#   - o PAINEL (DG Chat) e o canal padrao e esta sempre ligado. A pessoa escreve
#     na aba Conversa, o texto e datilografado nesta sessao pelo _lib/inject.py,
#     e o agente responde pela tool `mcp__dgchat__reply`, servida pelo servidor
#     MCP que este script fia aqui embaixo. Ver docs/CANAL-DG-CHAT.md.
#   - o TELEGRAM e um PLUGUE OPCIONAL. Com TELEGRAM_STATE_DIR na config, entra o
#     `--channels`; sem ele, a sessao sobe igual e conversa so pelo painel. Isso
#     tira o BotFather do caminho critico de quem acabou de instalar.
#   Os dois caem na MESMA sessao, entao a aba Conversa mostra a thread inteira,
#   em ordem, sem sincronizar nada (quem le e o _lib/thread_log.py).
#
# A config (gerada pelo wizard /dgclaw:setup) deve exportar pelo menos:
#   DGCLAW_NAME, DGCLAW_SLUG, DGCLAW_WORKSPACE
# E opcionalmente:
#   TELEGRAM_STATE_DIR         (liga o canal Telegram; vazio = so o painel)
#   CLAUDE_BIN                 (path do binario claude; default = autodetect)
#   BUN_BIN_DIR                (dir do bun; default = ~/.bun/bin)
#   DGCLAW_CLAUDE_CONFIG_DIR   (config dir onde o plugin telegram esta instalado;
#                               vazio = usa o default ~/.claude)
#   DGCHAT_URL                 (base do agents-server, quando o agente vive num
#                               card da plataforma; vazio = DG Claw sozinho)
#
# NB: rodar sob systemd exige PTY (use o ExecStart com `script`, ver
# install-service.sh) e, como root, IS_SANDBOX=1 (setado aqui automaticamente).

set -uo pipefail

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
    echo "launch.sh: config nao encontrada (passe o path de config.sh)" >&2
    exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG"

: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"

export DGCLAW_WORKSPACE

# Telegram: plugue opcional. Ate 11/08/2026 a falta de TELEGRAM_STATE_DIR matava
# o servico aqui, o que obrigava a criar bot no BotFather antes de o agente poder
# dizer a primeira palavra. Agora ele sobe sem, e conversa pelo painel.
TELEGRAM_LIGADO=0
if [ -n "${TELEGRAM_STATE_DIR:-}" ]; then
    TELEGRAM_LIGADO=1
    export TELEGRAM_STATE_DIR
fi

# --- PROTOTIPO MULTIMODELO (Frente D, 01/10/2026; desenho em docs/PLANO-MULTIMODELO.md) ---
# O Claude Code continua sendo o motor; so troca QUEM responde por baixo, apontando
# ANTHROPIC_BASE_URL para um endpoint no formato da API da Anthropic (OpenRouter, ou um
# proxy/provedor compativel). Sem DGCLAW_MODEL_PROVIDER, ou com "claude", NADA aqui roda e
# o agente sobe exatamente como antes, na assinatura do dono.
#   DGCLAW_MODEL_PROVIDER  claude (padrao) | openrouter | custom
#   DGCLAW_MODEL_NAME      id do modelo como o provedor escreve. Obrigatorio fora do claude
#   DGCLAW_MODEL_BASE_URL  obrigatorio no custom; no openrouter o padrao e https://openrouter.ai/api
#   DGCLAW_MODEL_API_KEY   a chave. Vem do COFRE do painel (nome termina em _API_KEY, passa na
#                          lista de permitidos), que o config.sh carrega de /run/dgclaw/<slug>.env.
#                          Alternativas: DGCLAW_MODEL_API_KEY_FILE, ou OPENROUTER_API_KEY no openrouter.
#   DGCLAW_MODEL_CONTEXT   opcional: janela real do modelo em tokens (ex.: 128000)
# Testado em 01/10/2026 com o Claude Code 2.1.287 contra um servidor falso local: o pedido vai
# para a URL, tool use (Bash) funciona; o --channels e IGNORADO ("Channels are not currently
# available"). Por isso o Telegram oficial sai do ar neste modo, e a conversa fica no painel.
PROVEDOR="${DGCLAW_MODEL_PROVIDER:-claude}"
if [ "$PROVEDOR" != "claude" ]; then
    case "$PROVEDOR" in
        openrouter) URL_MODELO="${DGCLAW_MODEL_BASE_URL:-https://openrouter.ai/api}"
                    CHAVE_MODELO="${DGCLAW_MODEL_API_KEY:-${OPENROUTER_API_KEY:-}}" ;;
        custom)     URL_MODELO="${DGCLAW_MODEL_BASE_URL:-}"
                    CHAVE_MODELO="${DGCLAW_MODEL_API_KEY:-}" ;;
        *) echo "launch.sh: DGCLAW_MODEL_PROVIDER='$PROVEDOR' nao existe. Use claude, openrouter ou custom." >&2
           echo "           Corrija em $CONFIG e reinicie o servico." >&2
           exit 1 ;;
    esac
    if [ -z "$CHAVE_MODELO" ] && [ -n "${DGCLAW_MODEL_API_KEY_FILE:-}" ] && [ -r "$DGCLAW_MODEL_API_KEY_FILE" ]; then
        CHAVE_MODELO="$(tr -d '\r\n' < "$DGCLAW_MODEL_API_KEY_FILE")"
    fi
    FALTA=""
    [ -z "${DGCLAW_MODEL_NAME:-}" ] && FALTA="$FALTA DGCLAW_MODEL_NAME"
    [ -z "$URL_MODELO" ] && FALTA="$FALTA DGCLAW_MODEL_BASE_URL"
    [ -z "$CHAVE_MODELO" ] && FALTA="$FALTA DGCLAW_MODEL_API_KEY"
    if [ -n "$FALTA" ]; then
        # Sair com erro, e nao cair no Claude em silencio: o dono escolheu outro modelo e
        # pagaria a conta errada sem saber. O valor da chave nunca aparece em log.
        echo "launch.sh: o provedor '$PROVEDOR' foi escolhido, mas falta:$FALTA." >&2
        echo "           A chave vai no Cofre do painel com o nome DGCLAW_MODEL_API_KEY; o resto em $CONFIG." >&2
        echo "           Para voltar ao Claude, apague DGCLAW_MODEL_PROVIDER da config (ou ponha claude)." >&2
        exit 1
    fi
    export ANTHROPIC_BASE_URL="$URL_MODELO"
    export ANTHROPIC_AUTH_TOKEN="$CHAVE_MODELO"   # vai como Authorization: Bearer
    export ANTHROPIC_API_KEY=""                    # vazio de proposito (doc do OpenRouter)
    export ANTHROPIC_MODEL="$DGCLAW_MODEL_NAME"
    # Os apelidos tambem apontam pro modelo escolhido. Sem isso, subagente pedindo "sonnet" e
    # tarefa de fundo (titulo, resumo) iriam pedir claude-* ao provedor, que cobraria Claude.
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$DGCLAW_MODEL_NAME"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$DGCLAW_MODEL_NAME"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$DGCLAW_MODEL_NAME"
    # Provedor que nao e a Anthropic recusa os campos beta (400 "Extra inputs are not permitted").
    export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
    [ -n "${DGCLAW_MODEL_CONTEXT:-}" ] && export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$DGCLAW_MODEL_CONTEXT"
    MODELO_FORCADO="$DGCLAW_MODEL_NAME"
    if [ "$TELEGRAM_LIGADO" = "1" ]; then
        echo "launch.sh: modelo '$DGCLAW_MODEL_NAME' via $PROVEDOR. O Telegram oficial so funciona" >&2
        echo "           com login da Anthropic, entao fica DESLIGADO neste modo: converse pelo painel." >&2
        TELEGRAM_LIGADO=0
    fi
    # O plugin do Telegram carrega e faz polling mesmo sem --channels. Apontado para uma pasta
    # vazia, ele sai sem token, em vez de consumir as mensagens do bot e joga-las fora.
    unset TELEGRAM_BOT_TOKEN
    export TELEGRAM_STATE_DIR="$DGCLAW_WORKSPACE/.dgclaw/telegram-desligado"
    echo "launch.sh: motor Claude Code, modelo '$DGCLAW_MODEL_NAME' via $PROVEDOR ($URL_MODELO)." >&2
fi
# --- fim do prototipo multimodelo ---

# --- Config dir do claude (causa-raiz de "plugin telegram not installed") ---
# O plugin telegram + o login vivem num config dir especifico. Se o ambiente
# herdou um CLAUDE_CONFIG_DIR custom que NAO tem o plugin, o --channels quebra.
# Regra: usa o dir que o wizard gravou (onde instalou o telegram); senao, o
# default. CLAUDE_CONFIG_DIR=$HOME/.claude NAO e o mesmo que o default
# (faria o claude ler $HOME/.claude/.claude.json interno), entao a gente
# UNSET pra cair no default de verdade ($HOME/.claude.json + dir $HOME/.claude).
if [ -n "${DGCLAW_CLAUDE_CONFIG_DIR:-}" ]; then
    export CLAUDE_CONFIG_DIR="$DGCLAW_CLAUDE_CONFIG_DIR"
else
    unset CLAUDE_CONFIG_DIR
fi

# Como root, --permission-mode bypassPermissions exige IS_SANDBOX=1
# (senao: "--dangerously-skip-permissions cannot be used with root privileges").
[ "$(id -u)" = "0" ] && export IS_SANDBOX=1

# Bun no PATH (o MCP server do plugin telegram roda em Bun)
BUN_BIN_DIR="${BUN_BIN_DIR:-$HOME/.bun/bin}"
export PATH="$BUN_BIN_DIR:$HOME/.local/bin:$PATH"

# Binario do claude
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DGCLAW_WORKSPACE" || exit 1

# --- O canal do painel (DG Chat) -------------------------------------------
# O servidor MCP que da ao agente as tools `reply` e `send_file`. Sem ele o
# agente RECEBE a mensagem escrita no painel e nao tem como responder: o
# thread_log.py so conta como fala dele o que sai por uma tool de envio, entao a
# resposta em texto puro nao chega em ninguem e a tela fica com a pergunta da
# pessoa e silencio embaixo. Foi assim ate 11/08/2026.
#
# O caminho sai do SCRIPT_DIR, entao vale nas duas arvores: o repo do plugin e a
# copia estavel do agente em <ws>/.dgclaw/plugin/.
DGCHAT_MCP_SERVER="$SCRIPT_DIR/dgchat-mcp/server.mjs"
DGCHAT_DIR="$DGCLAW_WORKSPACE/.dgclaw/dgchat"
DGCHAT_MCP_CONFIG="$DGCLAW_WORKSPACE/.dgclaw/dgchat.mcp.json"
MCP_ARGS=()

if [ ! -f "$DGCHAT_MCP_SERVER" ]; then
    # Gritar alto: a sessao ainda sobe (o Telegram, se plugado, continua
    # funcionando), mas o painel fica so-leitura e a dona precisa saber por que.
    echo "launch.sh: NAO ACHEI o servidor do canal em $DGCHAT_MCP_SERVER." >&2
    echo "           O agente vai subir SEM a tool de resposta do painel, entao quem" >&2
    echo "           escrever la nao vai receber resposta. Quase sempre isto e a copia" >&2
    echo "           do plugin (.dgclaw/plugin/) mais velha que o painel: atualize a" >&2
    echo "           copia e reinstale o painel, que os dois tem que ser da mesma versao." >&2
elif ! command -v node >/dev/null 2>&1; then
    echo "launch.sh: node nao esta no PATH, entao o canal do painel nao sobe." >&2
    echo "           Instale o node (o proprio claude roda nele) e reinicie o servico." >&2
else
    mkdir -p "$DGCHAT_DIR"
    # Escrito a cada boot de proposito: o caminho do servidor muda quando o
    # agente e importado ou a copia do plugin e atualizada, e um mcp.json antigo
    # apontando para um arquivo que sumiu deixa o agente mudo sem dizer nada.
    cat > "$DGCHAT_MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "dgchat": {
      "command": "node",
      "args": ["$DGCHAT_MCP_SERVER"]
    }
  }
}
EOF
    # NUNCA acrescentar --strict-mcp-config aqui: ele derrubaria os MCPs globais,
    # inclusive o do proprio Telegram.
    MCP_ARGS=(--mcp-config "$DGCHAT_MCP_CONFIG")
    export DGCHAT_AGENT="$DGCLAW_SLUG"
    export DGCHAT_OUTBOUND="$DGCHAT_DIR/outbound.jsonl"
    # DGCHAT_URL fica como veio da config: vazio (DG Claw sozinho) e o normal, e
    # e o que faz a tool responder "entregue" em vez de prometer reconexao de
    # janela que nao existe. Ver docs/CANAL-DG-CHAT.md.
fi

# O id da conversa do painel. Mesmo default do panel/lib/conversa.js; a
# identidade precisa dele para mostrar ao agente um envelope de exemplo que
# casa com o que ele vai receber de verdade.
export DGCLAW_CHAT_ID="${DGCLAW_CHAT_ID:-c_$DGCLAW_SLUG}"
export DGCLAW_TELEGRAM_LIGADO="$TELEGRAM_LIGADO"

# Monta identidade (AGENT.md + regras de canal) num arquivo temporario
# shellcheck disable=SC1091
source "$SCRIPT_DIR/bootstrap-identity.sh" "$DGCLAW_WORKSPACE"

# Mantem o identity file vivo ate o claude sair
trap - EXIT
trap "rm -f '$IDENTITY_FILE'" EXIT TERM INT

# Modelo do agente (DGCLAW_MODEL na config; default opus). O dono pode trocar por sonnet ou
# haiku, ou deixar vazio pra usar o padrao da conta dele. Vazio = nao passa --model nenhum,
# que e diferente de passar um valor errado e o claude recusar subir.
MODELO_ARGS=()
[ -n "${DGCLAW_MODEL:-}" ] && MODELO_ARGS=(--model "$DGCLAW_MODEL")
# Fora do Claude (prototipo multimodelo, la em cima) o modelo e o do provedor escolhido.
[ -n "${MODELO_FORCADO:-}" ] && MODELO_ARGS=(--model "$MODELO_FORCADO")


# O canal do Telegram so entra se o dono plugou um bot. Sem ele a sessao sobe
# igual, e o painel continua sendo o canal padrao.
CANAL_ARGS=()
[ "$TELEGRAM_LIGADO" = "1" ] && CANAL_ARGS=(--channels plugin:telegram@claude-plugins-official)

exec "$CLAUDE_BIN" \
    "${CANAL_ARGS[@]}" \
    "${MCP_ARGS[@]}" \
    --append-system-prompt-file "$IDENTITY_FILE" \
    --permission-mode bypassPermissions \
    "${MODELO_ARGS[@]}" \
    --name "dgclaw-$DGCLAW_SLUG"
