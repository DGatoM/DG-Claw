---
name: setup
description: Wizard de instalacao do DG Claw — cria um assistente pessoal seu no Telegram, com nome, personalidade e memoria, rodando 24/7 na VPS. Use quando o usuario rodar /dgclaw:setup, pedir pra "instalar o DG Claw", "criar meu assistente", "configurar o bot", ou comecar a montar um assistente do zero.
user-invocable: true
---

# /dgclaw:setup — Wizard de instalacao do DG Claw

Voce esta conduzindo uma pessoa (possivelmente leiga) a criar o assistente
pessoal dela no Telegram, do zero, na VPS. Va com calma, **um passo de cada
vez**, explicando cada peca em 1-2 frases ANTES de executar, e confirmando antes
de seguir. Fale em portugues do Brasil, tom acolhedor. Nunca despeje tudo de uma
vez.

Se em qualquer passo der erro, explique em linguagem simples o que aconteceu e
como resolver, e so siga quando estiver resolvido.

## Passo 0 — Resolver o diretorio do plugin

Rode e guarde o resultado:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(d=$(find "$HOME/.claude/plugins" -path '*dgclaw*/.claude-plugin/plugin.json' 2>/dev/null | head -1); [ -n "$d" ] && cd "$(dirname "$(dirname "$d")")" && pwd)}"
echo "PLUGIN_ROOT=$PLUGIN_ROOT"
```

Se vier vazio, peca pra pessoa confirmar que instalou o plugin
(`/plugin install dgclaw@dgclaw`) e pare aqui.

## Passo 1 — Boas-vindas e modelo mental

Mostre, em texto simples, o que vamos montar (pode colar este desenho):

```
   VOCE  <--Telegram-->  [ BOT ]  <-->  [ CEREBRO: Claude Code ]
                                              |
                                       [ MEMORIA em arquivos ]
                                       [ vive 24/7 no systemd ]
```

Explique em 3 frases: (1) o cerebro e o Claude Code; (2) a conversa acontece num
bot do Telegram; (3) ele tem memoria em arquivos e fica ligado o tempo todo.
Pergunte se pode comecar.

## Passo 2 — Pre-requisitos

Cheque o ambiente e instale o que faltar (avise antes de instalar):

```bash
command -v claude && claude --version || echo "FALTA claude"
command -v python3 && python3 --version || echo "FALTA python3"
command -v git || echo "FALTA git"
command -v bun || echo "FALTA bun"
```

- Se faltar `claude`: a pessoa precisa instalar o Claude Code antes (veja
  docs/AULA.md). Pare e oriente.
- Se faltar `bun`: o servidor do Telegram roda em Bun. Instale com
  `curl -fsSL https://bun.sh/install | bash` e depois garanta o PATH
  (`export PATH="$HOME/.bun/bin:$PATH"`). Avise que esta instalando.
- `python3` e `git` quase sempre ja existem.

Cheque tambem se o **plugin telegram oficial** esta instalado (o DG Claw usa ele
como ponte de mensagens):

```bash
ls "$HOME/.claude/plugins/cache/claude-plugins-official/telegram" 2>/dev/null && echo "telegram OK" || echo "FALTA telegram plugin"
```

Se faltar, peca pra pessoa rodar, na sessao do Claude:
`/plugin install telegram@claude-plugins-official` e depois `/reload-plugins`,
e so entao continue.

## Passo 3 — Nome e personalidade

Pergunte (uma coisa de cada vez):

1. **Qual o nome do assistente?** (ex: Tina, Max, Jarvis)
2. **Como ele deve ser?** Personalidade em texto livre — tom, jeito, o que
   curte, como trata voce. Quanto mais rico, melhor. (ex: "Direto, bem-humorado,
   meio sarcastico, me chama de chefe, gosta de futebol e odeia textao.")
3. **Como voce quer ser chamado?** (o "dono" — ex: Danilo, chefe)

Derive um `SLUG` do nome: minusculo, sem acento, sem espaco (ex: "Tina" -> tina).
Defina o workspace: `WORKSPACE="$HOME/dgclaw/$SLUG"`.

## Passo 4 — Criar o workspace a partir dos templates

```bash
SLUG=tina            # ajuste
NOME="Tina"          # ajuste
DONO="Danilo"        # ajuste
WORKSPACE="$HOME/dgclaw/$SLUG"
HOJE=$(date +%Y-%m-%d)

mkdir -p "$WORKSPACE/memory" "$WORKSPACE/.dgclaw/logs"

# Copia os templates trocando os placeholders
for f in AGENT.md CLAUDE.md MEMORY.md working-memory.md; do
  sed -e "s/{{NOME}}/$NOME/g" -e "s/{{SLUG}}/$SLUG/g" \
      -e "s/{{DONO}}/$DONO/g" -e "s/{{DATA}}/$HOJE/g" \
      "$PLUGIN_ROOT/templates/$f.tmpl" > "$WORKSPACE/$f"
done
```

Agora **abra o `AGENT.md`** e substitua o bloco `{{PERSONALIDADE}}` pela
descricao que a pessoa deu (use o Edit/Write). Leia de volta pra ela confirmar
que ficou com a cara certa. Deixe ela ajustar o texto se quiser.

## Passo 5 — Criar o bot no Telegram

Explique e conduza (passo a passo, esperando a pessoa fazer cada um):

1. No Telegram, abra conversa com **@BotFather** e mande `/newbot`.
2. Ele pede um **nome** (pode ter espaco, ex: "Tina Assistente").
3. Depois pede um **@username** unico terminando em `bot` (ex: `tina_dg_bot`).
4. O BotFather responde com um **token** tipo `123456789:AAH...`. Peca esse token.
5. Peca tambem o **ID numerico** dela no Telegram: abrir conversa com
   **@userinfobot** e copiar o numero (ex: `969847482`). Isso garante que SO ela
   fala com o bot.

Com token e ID em maos, grave o estado isolado do canal (cada assistente tem o
seu, pra rodar varios bots na mesma maquina sem conflito):

```bash
STATE_DIR="$HOME/.claude/dgclaw-channels/$SLUG/telegram"
mkdir -p "$STATE_DIR/inbox"

TOKEN="123456789:AAH..."   # cole o do BotFather
MEU_ID="969847482"         # cole o do @userinfobot

printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN" > "$STATE_DIR/.env"
chmod 600 "$STATE_DIR/.env"

sed -e "s/\"dmPolicy\": \"pairing\"/\"dmPolicy\": \"allowlist\"/" \
    -e "s/\"allowFrom\": \[\]/\"allowFrom\": [\"$MEU_ID\"]/" \
    "$PLUGIN_ROOT/templates/access.json.tmpl" > "$STATE_DIR/access.json"
```

Explique: com `allowlist` + o ID dela, ninguem mais consegue acionar o bot.

## Passo 6 — Memoria

Explique as 3 camadas em 3 frases (curto prazo `working-memory.md`, longo prazo
`MEMORY.md`, e a busca semantica que "acende sozinha"). Os dois arquivos ja foram
criados no Passo 4 — a memoria em arquivo **ja funciona**.

A busca semantica (opcional) deixa o assistente lembrar de coisas por
semelhanca, mesmo sem palavra exata. Ela precisa de uma chave gratis do Google
(Gemini). Pergunte se a pessoa quer ligar agora:

- **Quer ligar:** peca a chave em https://aistudio.google.com/apikey (free tier),
  e rode o primeiro indice:
  ```bash
  export GEMINI_API_KEY="AIza..."
  DGCLAW_WORKSPACE="$WORKSPACE" GEMINI_API_KEY="$GEMINI_API_KEY" \
      python3 "$PLUGIN_ROOT/scripts/memory_index/reindex.py" --workspace "$WORKSPACE"
  ```
  Guarde a chave pra config do Passo 7.
- **Nao quer agora:** tudo bem, a memoria em arquivo funciona. Da pra ligar
  depois com `/dgclaw:memory`.

## Passo 7 — Gravar a config do assistente

```bash
cat > "$WORKSPACE/.dgclaw/config.sh" <<EOF
# Config do assistente DG Claw "$NOME"
export DGCLAW_NAME="$NOME"
export DGCLAW_SLUG="$SLUG"
export DGCLAW_WORKSPACE="$WORKSPACE"
export TELEGRAM_STATE_DIR="$STATE_DIR"
export DGCLAW_PLUGIN_ROOT="$PLUGIN_ROOT"
# Opcional — busca semantica de memoria:
$( [ -n "${GEMINI_API_KEY:-}" ] && echo "export GEMINI_API_KEY=\"$GEMINI_API_KEY\"" || echo "# export GEMINI_API_KEY=\"...\"" )
# Opcional — caminho do bun, se nao estiver no PATH padrao:
# export BUN_BIN_DIR="\$HOME/.bun/bin"
EOF
chmod 600 "$WORKSPACE/.dgclaw/config.sh"
cat "$WORKSPACE/.dgclaw/config.sh"
```

## Passo 8 — Subir o servico 24/7

Explique: o systemd e o que mantem o assistente ligado e o reinicia se cair.
Precisa de sudo/root.

```bash
sudo bash "$PLUGIN_ROOT/scripts/install-service.sh" "$WORKSPACE/.dgclaw/config.sh"
sleep 4
systemctl status "dgclaw-$SLUG" --no-pager | head -20
```

Confira nas toras que conectou no Telegram:

```bash
journalctl -u "dgclaw-$SLUG" --no-pager -n 30
```

Peca pra pessoa **mandar um "oi" pro bot dela no Telegram** e confirmar que
respondeu. Se nao responder, cheque os logs e o token.

## Passo 9 — Conectar Google (opcional)

Pergunte se ela quer que o assistente acesse Drive/Gmail/Calendar. Se sim,
chame a skill `/dgclaw:connect` (ela guia os connectors nativos do Claude).
Se nao, siga.

## Passo 10 — Resumo final

Feche com um resumo simples e util:

- Como conversar: e so mandar mensagem pro bot no Telegram.
- A memoria: ele anota sozinho; voce pode pedir "lembra que ...".
- `/reset` ou `/new` no Telegram zera a conversa, mas a memoria em arquivo fica.
- Onde mora tudo: `WORKSPACE` (mostre o path).
- Comandos uteis: `/dgclaw:service` (liga/desliga/status/logs),
  `/dgclaw:memory` (memoria), `/dgclaw:connect` (Google).
- Pra mudar a personalidade depois: edite `AGENT.md` e
  `systemctl restart dgclaw-$SLUG`.

Parabens — o assistente esta no ar.
