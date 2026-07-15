#!/bin/bash
# bootstrap-identity.sh — Monta o arquivo de system prompt (identidade) do assistente.
#
# Uso:  source bootstrap-identity.sh <workspace>
# Resultado: variavel IDENTITY_FILE com o path de um arquivo temporario contendo
#            AGENT.md + as regras de canal (Channels/Telegram).
#
# Versao DG Claw: SEM sistema de emocoes / persona / BOND. So a identidade que o
# dono escreveu em AGENT.md, mais as regras fixas do canal Telegram.

_WORKSPACE="${1:?Uso: source bootstrap-identity.sh <workspace>}"
IDENTITY_FILE=$(mktemp /tmp/dgclaw-identity-XXXXXX.txt)

# Dir dos scripts do plugin (este arquivo mora nele). Usado pra dizer ao
# assistente o caminho absoluto do transcribe.py. Como este script e SOURCED,
# BASH_SOURCE[0] aponta pra ele mesmo, nao pro launch.sh.
_PLUGIN_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Identidade que o dono definiu no wizard
if [ -f "$_WORKSPACE/AGENT.md" ]; then
    cat "$_WORKSPACE/AGENT.md" >> "$IDENTITY_FILE"
    echo -e "\n---\n" >> "$IDENTITY_FILE"
fi

# Regras fixas do canal (iguais pra todo assistente DG Claw)
cat >> "$IDENTITY_FILE" <<'EOF'
# === REGRA ZERO DO CANAL TELEGRAM ===

Voce conversa via Claude Code Channels (plugin telegram). O dono NAO ve seu
texto nem seu raciocinio — ele so recebe algo quando voce chama a tool de reply
do Telegram (passando o chat_id da mensagem dele).

Em TODA mensagem que ele mandar:
1. A PRIMEIRA acao do turno e chamar a tool de reply (reconheca/responda).
2. So DEPOIS faca o trabalho de fundo (ler arquivo, rodar comando, etc).
3. Terminou o trabalho? Mande OUTRO reply com o resultado.
4. NUNCA encerre um turno com mensagem em aberto sem ter chamado reply.

Detalhes de memoria e operacao estao no CLAUDE.md do workspace.
EOF

# Regras de midia — so entram se o dono habilitou transcricao no wizard.
# Sem isso o assistente nao sabe que TEM como transcrever e responde
# "nao consigo ouvir audio" mesmo com o script instalado.
if [ -n "${DGCLAW_TRANSCRIBE_PROVIDER:-}" ]; then
    cat >> "$IDENTITY_FILE" <<EOF

# === AUDIO E IMAGEM NO TELEGRAM ===

Voce RECEBE audio e imagem. A mensagem que chega tem uma meta <channel ...>:

- **attachment_kind="voice"** (ou "audio") = mensagem de voz. Faca assim:
  1. reply curto reconhecendo ("recebi seu audio, ja escuto").
  2. tool download_attachment com o attachment_file_id da meta -> devolve o path local.
  3. Bash: ${_PLUGIN_SCRIPTS}/transcribe.py <path> -> a transcricao sai no stdout.
  4. Trate a transcricao como se ele tivesse DIGITADO aquilo e responda o pedido.
- **image_path="..."** na meta = foto. Basta Read no path (voce enxerga imagem
  nativamente, nao precisa de ferramenta externa).
- **attachment_kind="document"** = arquivo. download_attachment + Read.

Regras:
- NUNCA diga que nao consegue ouvir audio: voce consegue, e via transcribe.py.
- A transcricao e automatica (STT) e pode errar nome proprio e palavra tecnica.
  Se algo sair sem sentido, deduza pelo contexto; se for um fato que muda a
  acao (numero, nome, um "nao"), confirme com ele em vez de adivinhar.
- Audio longo pode levar ~30s. Por isso o reply do passo 1 vem ANTES.
EOF
fi

# Cleanup automatico ao sair do script pai
trap "rm -f '$IDENTITY_FILE'" EXIT
