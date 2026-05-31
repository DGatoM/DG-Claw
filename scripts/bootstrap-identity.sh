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

# Cleanup automatico ao sair do script pai
trap "rm -f '$IDENTITY_FILE'" EXIT
