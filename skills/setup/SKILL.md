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

## Passo 5 — Criar o bot, subir e parear (automatico)

A ideia: o assistente **conecta primeiro**, voce manda uma mensagem pro bot, e o
proprio assistente **captura quem e voce** e libera o acesso. Sem caçar ID em
@userinfobot (que e o que mais trava leigos).

### 5.1 Criar o bot no BotFather

Conduza, esperando a pessoa fazer cada passo:

1. No Telegram, abra conversa com **@BotFather** e mande `/newbot`.
2. Ele pede um **nome** (pode ter espaco, ex: "Tina Assistente").
3. Depois um **@username** unico terminando em `bot` (ex: `tina_dg_bot`).
4. Ele responde com um **token** tipo `123456789:AAH...`. Peca esse token.

### 5.2 Gravar token + config e subir o bot

```bash
STATE_DIR="$HOME/.claude/dgclaw-channels/$SLUG/telegram"
mkdir -p "$STATE_DIR/inbox"

TOKEN="123456789:AAH..."   # cole o do BotFather
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN" > "$STATE_DIR/.env"
chmod 600 "$STATE_DIR/.env"

# access.json comeca em modo "pairing" (template ja vem assim): o bot responde
# um codigo pra quem mandar msg, e a gente aprova logo abaixo.
cp "$PLUGIN_ROOT/templates/access.json.tmpl" "$STATE_DIR/access.json"

# config do assistente (o servico le isto)
cat > "$WORKSPACE/.dgclaw/config.sh" <<EOF
export DGCLAW_NAME="$NOME"
export DGCLAW_SLUG="$SLUG"
export DGCLAW_WORKSPACE="$WORKSPACE"
export TELEGRAM_STATE_DIR="$STATE_DIR"
export DGCLAW_PLUGIN_ROOT="$PLUGIN_ROOT"
# export BUN_BIN_DIR="\$HOME/.bun/bin"
EOF
chmod 600 "$WORKSPACE/.dgclaw/config.sh"

# sobe o servico 24/7 (precisa sudo). O bot fica online pra receber sua msg.
sudo bash "$PLUGIN_ROOT/scripts/install-service.sh" "$WORKSPACE/.dgclaw/config.sh"
sleep 5
systemctl is-active "dgclaw-$SLUG" && echo "bot online" || journalctl -u "dgclaw-$SLUG" --no-pager -n 20
```

### 5.3 Pedir a mensagem e parear sozinho

Diga: **"Agora abre o seu bot @<username> no Telegram e manda qualquer mensagem
(ex: 'oi'). Ele vai te responder um codigo — nao precisa copiar nada, eu pego."**

Espere a pessoa avisar que mandou, entao leia o pareamento pendente e **aprove
automaticamente** (poll ate aparecer, ~30s):

```bash
for i in $(seq 1 15); do
  RES=$(python3 - "$STATE_DIR/access.json" <<'PY'
import json,sys
f=sys.argv[1]
try: d=json.load(open(f))
except Exception: print("WAIT"); sys.exit()
p=d.get("pending",{})
if not p: print("WAIT"); sys.exit()
code=next(iter(p)); sender=p[code]["senderId"]
d["dmPolicy"]="allowlist"
d["allowFrom"]=sorted(set(d.get("allowFrom",[])+[str(sender)]))
d["pending"]={}
json.dump(d,open(f,"w"),indent=2)
print("APPROVED", sender)
PY
)
  echo "$RES"; case "$RES" in APPROVED*) break;; esac
  sleep 2
done

# reinicia pra carregar a allowlist nova
sudo systemctl restart "dgclaw-$SLUG"
```

- Se saiu `APPROVED <id>`: diga "achei voce (id `<id>`), liberei seu acesso e
  travei o bot pra so voce". 
- Se ficou em `WAIT`: a msg ainda nao chegou — confirme que ela mandou pro bot
  certo e que o servico esta `active`; tente o bloco de novo.

### 5.4 Confirmar

Peca pra ela **mandar outra mensagem** pro bot. Agora quem responde e o
assistente (com o nome e personalidade dele), nao mais o codigo. Confirmado isso,
o canal esta pronto.

## Passo 6 — Memoria (tudo no Claude, sem API externa)

Explique em 3 frases:
- **Curto prazo** (`working-memory.md`): o "agora" — tarefas e contexto recente.
- **Longo prazo** (`MEMORY.md`): o que vale pra sempre. Sobrevive ao `/reset`.
- **Recall automatico**: antes de responder, o assistente procura nesses arquivos
  por linhas relacionadas a sua mensagem e "lembra" sozinho. **E local, sem
  chave nenhuma** — nao usa servico externo.

Os arquivos ja foram criados no Passo 4 e o recall ja vem ligado (e um hook do
plugin). **Nao precisa configurar nada aqui** — a memoria ja funciona.

### Consolidacao noturna (recomendado)

Pra memoria nao virar bagunca, todo dia de madrugada o **proprio assistente**
(Claude, sem API externa) le o `working-memory.md`, promove o que e duradouro pro
`MEMORY.md` e limpa o resto. Pergunte se quer ligar (recomende que sim) e o
horario (default 04:00):

```bash
sudo bash "$PLUGIN_ROOT/scripts/install-consolidate-timer.sh" "$WORKSPACE/.dgclaw/config.sh" 04:00
# testar agora (opcional):
sudo systemctl start "dgclaw-$SLUG-consolidate.service"
cat "$WORKSPACE/.dgclaw/logs/consolidate.log"
```

Explique: e o "sono" do assistente — ele organiza as memorias enquanto voce dorme.

## Passo 7 — Painel de memoria (opcional)

Um mini site pra voce **ver e editar** a memoria pelo navegador (curto prazo,
longo prazo e notas), salvando direto nos arquivos. Pergunte se quer ligar:

```bash
sudo bash "$PLUGIN_ROOT/scripts/install-panel-service.sh" "$WORKSPACE/.dgclaw/config.sh" 8200
```

O script mostra a **URL com token** (`http://SEU_IP:8200/?t=...`). Passe essa URL
pra pessoa abrir no navegador. Diga que o que ela editar e salvar ali vale na
proxima conversa do assistente.

## Passo 8 — Conectar Google (opcional)

Pergunte se ela quer que o assistente acesse Drive/Gmail/Calendar. Se sim,
chame a skill `/dgclaw:connect` (ela guia os connectors nativos do Claude).
Se nao, siga.

## Passo 9 — Resumo final

Feche com um resumo simples e util:

- Como conversar: e so mandar mensagem pro bot no Telegram.
- A memoria: ele anota sozinho, lembra sozinho e consolida toda noite. Voce pode
  pedir "lembra que ..." ou editar pelo painel.
- `/reset` ou `/new` no Telegram zera a conversa, mas a memoria em arquivo fica.
- Onde mora tudo: `WORKSPACE` (mostre o path).
- Comandos uteis: `/dgclaw:service` (liga/desliga/status/logs),
  `/dgclaw:memory` (memoria/painel/consolidacao), `/dgclaw:connect` (Google).
- Pra mudar a personalidade depois: edite `AGENT.md` e
  `systemctl restart dgclaw-$SLUG`.

Parabens — o assistente esta no ar.
