---
name: setup
description: Wizard de instalacao do DG Claw — cria um assistente pessoal seu no Telegram, com nome, personalidade e memoria, rodando 24/7 na VPS. Use quando o usuario rodar /dgclaw:setup, pedir pra "instalar o DG Claw", "criar meu assistente", "configurar o bot", ou comecar a montar um assistente do zero.
user-invocable: true
---

# /dgclaw:setup — Wizard de instalacao do DG Claw

Voce conduz uma pessoa (possivelmente leiga) a criar o assistente dela no
Telegram, do zero, na VPS. Va com calma, **um passo de cada vez**, explicando
cada peca em 1-2 frases ANTES de executar, e confirmando antes de seguir. Fale
em portugues do Brasil, tom acolhedor. Se der erro, explique simples e so siga
quando resolver.

## Checklist — MOSTRE e va marcando

No comeco, cole o checklist abaixo. **A cada passo concluido, reescreva o
checklist** trocando `[ ]` por `[x]` no item feito — assim a pessoa sempre ve o
que ja foi e **o que ainda falta pra terminar**. Sempre que mandar o checklist,
diga em 1 linha qual e o proximo item.

```
INSTALACAO DO DG CLAW — progresso
[ ] 1. Pre-requisitos (claude, bun, python, plugin telegram)
[ ] 2. Nome e personalidade
[ ] 3. Usuario + workspace do agente
[ ] 4. Bot do Telegram criado + servico no ar
[ ] 5. Pareamento (so voce fala com ele)
[ ] 6. Memoria + consolidacao noturna
[ ] 7. Painel de memoria (opcional)
[ ] 8. Conectar Google (opcional)
[ ] 9. Checagem final (doctor) — tudo certo
```

## Passo 0 — Plugin dir + config dir

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(d=$(find "$HOME/.claude/plugins" -path '*dgclaw*/.claude-plugin/plugin.json' 2>/dev/null | head -1); [ -n "$d" ] && cd "$(dirname "$(dirname "$d")")" && pwd)}"
echo "PLUGIN_ROOT=$PLUGIN_ROOT"
echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-(default ~/.claude)}"
```

Guarde os dois. **Importante:** o plugin telegram e o login precisam existir no
config dir que o SERVICO vai usar. Se houver um `CLAUDE_CONFIG_DIR` custom (ex:
sandbox), a gente vai gravar isso na config pra o servico usar o mesmo dir.

## Passo 1 — Boas-vindas e modelo mental

```
   VOCE  <--Telegram-->  [ BOT ]  <-->  [ CEREBRO: Claude Code ]
                                              |
                                       [ MEMORIA em arquivos ]
                                       [ vive 24/7 no systemd ]
```
3 frases: (1) o cerebro e o Claude; (2) a conversa e num bot do Telegram; (3) tem
memoria em arquivos e fica ligado 24h. Pergunte se pode comecar.

## Passo 2 — Pre-requisitos  → marque [1]

```bash
command -v claude && claude --version || echo "FALTA claude"
command -v python3 >/dev/null && echo "python3 ok" || echo "FALTA python3"
command -v bun >/dev/null || [ -x "$HOME/.bun/bin/bun" ] && echo "bun ok" || echo "FALTA bun"
```
- `claude` ausente → a pessoa instala o Claude Code antes (ver docs/AULA.md). Pare.
- `bun` ausente → `curl -fsSL https://bun.sh/install | bash` e `export PATH="$HOME/.bun/bin:$PATH"`.

Plugin telegram **no config dir do servico** (use o mesmo CLAUDE_CONFIG_DIR do
Passo 0, se houver):
```bash
claude plugin list 2>/dev/null | grep -qi telegram && echo "telegram ok" \
  || echo "FALTA telegram -> /plugin install telegram@claude-plugins-official"
```
Se faltar, peca pra rodar `/plugin install telegram@claude-plugins-official` +
`/reload-plugins` (na MESMA sessao/config) e so entao siga.

## Passo 3 — Nome e personalidade  → marque [2]

Pergunte um de cada vez: (1) nome do assistente; (2) personalidade em texto livre
(tom, jeito, como te trata); (3) como voce quer ser chamado (o "dono"). Derive
`SLUG` (minusculo, sem acento/espaco).

## Passo 4 — Usuario + workspace + copia estavel  → marque [3]

O assistente roda como **root (o lider)**, mas mora no espaco de um **usuario
dedicado** — assim cada agente fica separado e o root (voce/eu) pode consertar
qualquer um. Tambem copiamos os scripts pra um local **estavel** (a pasta de
instalacao do plugin pode ser limpa pelo sistema).

```bash
SLUG=tina            # ajuste
NOME="Tina"          # ajuste
DONO="Danilo"        # ajuste
HOJE=$(date +%Y-%m-%d)

# usuario dedicado do agente (sem shell de login); workspace = home dele
AGENT_USER="dgclaw-$SLUG"
id "$AGENT_USER" >/dev/null 2>&1 || sudo useradd -m -s /usr/sbin/nologin "$AGENT_USER"
WORKSPACE="$(getent passwd "$AGENT_USER" | cut -d: -f6)"   # /home/dgclaw-<slug>
sudo mkdir -p "$WORKSPACE/memory" "$WORKSPACE/.dgclaw/logs"

# templates -> arquivos do agente
for f in AGENT.md CLAUDE.md MEMORY.md working-memory.md; do
  sudo sed -e "s/{{NOME}}/$NOME/g" -e "s/{{SLUG}}/$SLUG/g" \
       -e "s/{{DONO}}/$DONO/g" -e "s/{{DATA}}/$HOJE/g" \
       "$PLUGIN_ROOT/templates/$f.tmpl" | sudo tee "$WORKSPACE/$f" >/dev/null
done

# COPIA ESTAVEL do plugin (scripts/hooks/templates) -> .dgclaw/plugin
STABLE="$WORKSPACE/.dgclaw/plugin"
sudo mkdir -p "$STABLE"
sudo cp -r "$PLUGIN_ROOT/scripts" "$PLUGIN_ROOT/templates" "$STABLE/"
PLUGIN_ROOT="$STABLE"   # daqui pra frente, use a copia estavel
```

Depois **edite o `AGENT.md`** trocando `{{PERSONALIDADE}}` pela descricao dada
(Edit/Write) e leia de volta pra confirmar.

## Passo 5 — Bot do Telegram + servico + pareamento  → marca [4] e [5]

### 5.1 BotFather
Conduza: `/newbot` no **@BotFather** → nome → @username (termina em `bot`) →
copie o **token** `123456789:AAH...`.

### 5.2 Token + config + subir o servico
```bash
STATE_DIR="$HOME/.claude/dgclaw-channels/$SLUG/telegram"
mkdir -p "$STATE_DIR/inbox"
TOKEN="123456789:AAH..."   # cole o do BotFather
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN" > "$STATE_DIR/.env"; chmod 600 "$STATE_DIR/.env"
cp "$PLUGIN_ROOT/templates/access.json.tmpl" "$STATE_DIR/access.json"  # comeca em pairing

# config do agente. Grava DGCLAW_CLAUDE_CONFIG_DIR so se houver um custom
# (senao o servico usa o default ~/.claude, onde o telegram esta instalado).
CCD=""
[ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ "$CLAUDE_CONFIG_DIR" != "$HOME/.claude" ] && CCD="$CLAUDE_CONFIG_DIR"
sudo tee "$WORKSPACE/.dgclaw/config.sh" >/dev/null <<EOF
export DGCLAW_NAME="$NOME"
export DGCLAW_SLUG="$SLUG"
export DGCLAW_WORKSPACE="$WORKSPACE"
export TELEGRAM_STATE_DIR="$STATE_DIR"
export DGCLAW_PLUGIN_ROOT="$PLUGIN_ROOT"
$( [ -n "$CCD" ] && echo "export DGCLAW_CLAUDE_CONFIG_DIR=\"$CCD\"" || echo "# usa config dir default (~/.claude)" )
# export BUN_BIN_DIR="\$HOME/.bun/bin"
EOF
sudo chmod 600 "$WORKSPACE/.dgclaw/config.sh"

# dono dos arquivos = o usuario do agente (root acessa tudo)
sudo chown -R "$AGENT_USER:$AGENT_USER" "$WORKSPACE"

# sobe o servico (install-service trata: PTY, IS_SANDBOX, trust, skip-dangerous)
sudo bash "$PLUGIN_ROOT/scripts/install-service.sh" "$WORKSPACE/.dgclaw/config.sh"
```
O `install-service.sh` ja imprime se ficou ATIVO. Se nao, ele mostra o log — leia
e conserte (ou rode o doctor no Passo 9). **So marque [4] quando estiver ATIVO.**

### 5.3 Pedir mensagem e parear sozinho
Diga: **"Abra seu bot @<username> e mande qualquer mensagem. Ele responde um
codigo — nao copie nada, eu pego."** Espere, entao:
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
d["dmPolicy"]="allowlist"; d["allowFrom"]=sorted(set(d.get("allowFrom",[])+[str(sender)])); d["pending"]={}
json.dump(d,open(f,"w"),indent=2); print("APPROVED", sender)
PY
)
  echo "$RES"; case "$RES" in APPROVED*) break;; esac; sleep 2
done
```
O servidor rele o access.json sozinho (nao precisa restart). Se `APPROVED <id>`:
diga "achei voce (id `<id>`), travei o bot pra so voce" e **marque [5]**. Peca pra
ela mandar outra msg — agora responde o assistente.

## Passo 6 — Memoria + consolidacao noturna  → marque [6]

3 frases: curto prazo (`working-memory.md`), longo prazo (`MEMORY.md`), e o
**recall automatico local** (acha linhas relacionadas antes de responder — sem
chave/servico externo). Ja vem ligado. A **consolidacao noturna** (o proprio
Claude organiza a memoria de madrugada) e recomendada:
```bash
sudo bash "$PLUGIN_ROOT/scripts/install-consolidate-timer.sh" "$WORKSPACE/.dgclaw/config.sh" 04:00
```

## Passo 7 — Painel de memoria (opcional)  → marque [7]
```bash
sudo bash "$PLUGIN_ROOT/scripts/install-panel-service.sh" "$WORKSPACE/.dgclaw/config.sh" 8200
```
Passe a **URL com token** que o script imprime. (Na VPS so-IPv6, use o IPv6 entre
colchetes ou um tunel SSH.)

## Passo 8 — Conectar Google (opcional)  → marque [8]
Se quiser Drive/Gmail/Calendar, chame `/dgclaw:connect`.

## Passo 9 — Checagem final (doctor)  → marque [9]

Rode o doctor pra validar TUDO e consertar o que der:
```bash
sudo bash "$PLUGIN_ROOT/scripts/doctor.sh" "$WORKSPACE/.dgclaw/config.sh"
```
- Se terminar com **">> TUDO CERTO."**: avise a pessoa que esta tudo funcionando,
  marque o checklist 100%, e peca um ultimo "oi" pro bot.
- Se sobrar `[FALTA]`: liste em linguagem simples **o que ainda falta** pra
  terminar e resolva item a item (ver skill `/dgclaw:doctor`). Nao declare
  "tudo certo" enquanto houver item faltando.

### Resumo pra fechar
- Conversar: mandar mensagem pro bot no Telegram.
- Memoria: ele anota e lembra sozinho, e consolida toda noite; da pra editar pelo painel.
- `/reset` zera a conversa, mas a memoria em arquivo fica.
- Comandos: `/dgclaw:service`, `/dgclaw:memory`, `/dgclaw:connect`, `/dgclaw:doctor`.
- Mudar personalidade: editar `AGENT.md` e `sudo systemctl restart dgclaw-$SLUG`.
