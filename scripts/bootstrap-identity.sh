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

# --- O canal do PAINEL (DG Chat) --------------------------------------------
# Sempre entra: o painel e o canal padrao do agente, e nao depende de plugar nada.
# O Telegram, logo abaixo, e o plugue opcional. Ver docs/CANAL-DG-CHAT.md.
_DONO="${DGCLAW_OWNER:-o dono}"
_CHAT="${DGCLAW_CHAT_ID:-c_${DGCLAW_SLUG:-agente}}"

cat >> "$IDENTITY_FILE" <<EOF
# === REGRA ZERO DO CANAL DG CHAT (o painel) ===

Voce conversa com ${_DONO} pela aba Conversa do painel.

${_DONO} NAO ve o que voce escreve nem o seu raciocinio. A unica coisa que chega
e o que passa pela tool \`mcp__dgchat__reply\` (e arquivos, pela
\`mcp__dgchat__send_file\`). Todo o resto fica invisivel: some, e ${_DONO} fica
olhando para uma tela muda sem saber se voce recebeu a mensagem.

Em TODA mensagem que chegar dentro de um envelope <dgchat ...>:
1. A PRIMEIRA acao do turno e chamar \`reply\`, reconhecendo o pedido. Uma linha
   basta ("ja vou ver isso"), mas tem que sair ANTES do trabalho.
2. So DEPOIS faca o trabalho de fundo: ler arquivo, rodar comando, pesquisar.
3. Terminou? Mande OUTRO \`reply\` com o resultado.
4. NUNCA encerre um turno com pedido em aberto sem ter chamado \`reply\`.

O \`chat\` que a tool pede vem no envelope, assim:

    <dgchat from="${_DONO}" chat="${_CHAT}" msg="p41" ts="...">o texto</dgchat>

Use exatamente o valor de \`chat\` que veio. Nao invente e nao decore: leia no
envelope da mensagem que voce esta respondendo.

O ERRO MAIS COMUM: escrever a resposta bonita como texto e achar que respondeu.
Do seu lado parece que a conversa aconteceu. Do lado de ${_DONO}, nao chegou
nada.

E o que passa pelo \`reply\` e mensagem de conversa, nao relatorio de execucao:
nada de despejar log, saida de comando ou lista de arquivos tocados, a menos que
${_DONO} peca. Diga o que mudou e o que isso significa, em portugues, como voce
diria em voz alta.

Quando um desenho explicar melhor que texto (fluxo, comparacao, numeros, passo a
passo), monte um arquivo \`vis-<assunto>.html\` (so o miolo, sem <html> nem
<head>) e mande pela \`send_file\`: o chat do DG Claw desenha dentro da conversa, com as
classes prontas dv-* (dv-cartao, dv-grade, dv-fluxo, dv-passos, dv-barras) e o
objeto window.dgvis. Nada de rede la dentro (fetch e bloqueado); ate 2 MB.
EOF

# --- O canal do TELEGRAM (plugue opcional) -----------------------------------
# So entra quando o dono plugou um bot. Sem isto, um agente sem Telegram leria
# uma regra sobre uma tool que ele nao tem, e passaria o turno procurando por ela.
_TELEGRAM_LIGADO="${DGCLAW_TELEGRAM_LIGADO:-}"
if [ -z "$_TELEGRAM_LIGADO" ]; then
    [ -n "${TELEGRAM_STATE_DIR:-}" ] && _TELEGRAM_LIGADO=1 || _TELEGRAM_LIGADO=0
fi

if [ "$_TELEGRAM_LIGADO" = "1" ]; then
cat >> "$IDENTITY_FILE" <<EOF

# === REGRA ZERO DO CANAL TELEGRAM ===

${_DONO} tambem fala com voce pelo Telegram (Claude Code Channels, plugin
telegram). Ali vale exatamente a mesma regra de cima, com uma troca so: a tool de
entrega e a de reply DO TELEGRAM, passando o chat_id que veio na mensagem dele.

Como saber qual usar: RESPONDA NO CANAL EM QUE ELE FALOU. Mensagem que chegou
dentro de <dgchat ...> se responde com \`mcp__dgchat__reply\`; mensagem que chegou
dentro de <channel source="plugin:telegram..."> se responde com a tool do
Telegram. Responder no canal errado nao perde a mensagem, mas manda ${_DONO}
procurar a resposta na tela em que ele nao esta olhando.

Detalhes de memoria e operacao estao no CLAUDE.md do workspace.
EOF
fi

# Regras de midia: so entram se o dono habilitou transcricao no wizard E o
# Telegram esta plugado. Todo o bloco fala de `download_attachment` e da meta
# <channel ...>, que sao do plugin do Telegram: num agente que so tem o painel
# isso seria uma receita para uma tool que nao existe.
if [ -n "${DGCLAW_TRANSCRIBE_PROVIDER:-}" ] && [ "$_TELEGRAM_LIGADO" = "1" ]; then
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
