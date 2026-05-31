# Aula: instale seu assistente DG Claw numa VPS (do zero)

Roteiro pensado pra uma turma de leigos, no periodo da tarde. Cada aluno sai com
um assistente pessoal proprio, no Telegram, rodando 24/7.

Tempo estimado: 60-90 min. Pre-requisitos do aluno: um cartao pra alugar a VPS,
uma conta no Telegram (no celular) e uma conta Claude (Pro ou Max).

> Dica pro instrutor: projete `COMO-FUNCIONA.md` nos primeiros 10 min pra dar o
> modelo mental antes de pôr a mao na massa.

---

## Visao geral da aula

```
  [1] Alugar e acessar a VPS
        |
  [2] Instalar o Claude Code e logar
        |
  [3] Criar o bot no Telegram (BotFather) e pegar seu ID
        |
  [4] Instalar o plugin DG Claw (marketplace do GitHub)
        |
  [5] Rodar /dgclaw:setup (o wizard faz o resto)
        |
  [6] Conversar com o assistente e ver a memoria funcionar
        |
  [7] (Opcional) Conectar Google
```

---

## Passo 1 — Alugar e acessar a VPS

1. Contrate uma VPS Linux (Ubuntu 22.04+ recomendado). Qualquer provedor serve;
   1-2 GB de RAM ja roda.
2. O provedor te da um **IP**, um **usuario** (`root` ou outro) e uma **senha**
   ou chave.
3. Acesse por SSH do seu computador:
   ```bash
   ssh root@SEU_IP
   ```
   (No Windows, use o terminal do PowerShell ou o app do provedor.)

> Conceito: a VPS e um computador na internet que fica sempre ligado. E por isso
> que o assistente nunca dorme.

---

## Passo 2 — Instalar o Claude Code e logar

Na VPS:

```bash
curl -fsSL https://claude.ai/install.sh | bash
# Garanta o PATH (a propria saida do instalador indica; geralmente):
export PATH="$HOME/.local/bin:$PATH"
claude --version
```

Faca login:

```bash
claude
```
Na primeira vez ele pede pra logar — siga a URL e cole o codigo. Depois saia com
`/exit` (vamos voltar ja ja).

> Conceito: o Claude Code e o "cerebro". E a mesma IA que voce usa no chat, mas
> aqui rodando no servidor, com acesso a arquivos e ao terminal.

---

## Passo 3 — Criar o bot no Telegram

No app do Telegram, no celular:

1. Procure **@BotFather** e abra a conversa.
2. Mande `/newbot`.
3. Escolha um **nome** (pode ter espaco): ex. "Tina Assistente".
4. Escolha um **@username** unico terminando em `bot`: ex. `tina_dg_bot`.
5. O BotFather responde com um **token** assim:
   `123456789:AAHfiqksKZ8...` — copie o token INTEIRO. **Nao compartilhe.**

Pegue tambem o seu **ID numerico**:

6. Procure **@userinfobot**, abra e mande qualquer coisa. Ele responde com seu
   `Id:` (um numero). Copie. Isso garante que so VOCE fala com o bot.

> Conceito: o bot e a "boca e ouvido". O token e a chave dele; o seu ID e o
> cracha que diz "essa pessoa pode falar comigo".

---

## Passo 4 — Instalar o plugin DG Claw

Volte pra VPS e abra o Claude:

```bash
claude
```

Dentro da sessao, rode (sao comandos do Claude, comecam com `/`):

```
/plugin marketplace add DGatoM/DG-Claw
/plugin install dgclaw@dgclaw
/reload-plugins
```

O DG Claw usa o plugin oficial do Telegram como ponte. Instale-o tambem:

```
/plugin install telegram@claude-plugins-official
/reload-plugins
```

> Conceito: um "plugin" e um pacote de habilidades que voce acopla ao Claude.
> O marketplace e a "loja" de onde ele vem (aqui, o repositorio no GitHub).

---

## Passo 5 — Rodar o wizard

Ainda na sessao do Claude, rode:

```
/dgclaw:setup
```

O wizard te conduz, um passo de cada vez. Ele vai:

- explicar como o assistente funciona;
- conferir pre-requisitos (e instalar o **Bun**, que o Telegram precisa);
- perguntar o **nome** e a **personalidade** do seu assistente;
- pedir o **token** do BotFather e o seu **ID**;
- criar a **memoria** (e, se voce quiser, ligar a busca semantica com uma chave
  gratis do Gemini);
- subir o **servico 24/7** no systemd.

So vá respondendo. Quando ele pedir token/ID/chave, cole o que voce separou.

> Se for ligar a busca semantica: pegue a chave gratis em
> https://aistudio.google.com/apikey (e o "free tier", nao cobra).

---

## Passo 6 — Conversar e ver a memoria

1. No Telegram, abra a conversa com o **seu bot** (o `@username` que voce criou).
2. Mande um "oi". Ele deve responder em alguns segundos.
3. Conte um fato seu: *"meu cachorro se chama Rex e eu odeio acordar cedo."*
4. Mande `/reset` (zera a conversa).
5. Pergunte: *"o que voce sabe sobre mim?"* — ele deve lembrar do Rex.
   Isso mostra a **memoria sobrevivendo ao reset**.

> Se nao responder: na VPS, `journalctl -u dgclaw-<slug> -f` mostra o que esta
> acontecendo. Quase sempre e token errado ou Bun fora do PATH. Use
> `/dgclaw:service` pra diagnosticar.

---

## Passo 7 — Conectar Google (opcional)

Na sessao do Claude:

```
/dgclaw:connect
```

Ele guia voce a autorizar Drive/Gmail/Calendar com a sua conta Google (via
`/mcp`). Depois pergunte ao bot: *"quais meus proximos eventos da agenda?"*

---

## Colinha de comandos

```
  Na VPS (terminal):
    ssh root@SEU_IP                         acessar a VPS
    journalctl -u dgclaw-<slug> -f          ver os logs do assistente
    systemctl restart dgclaw-<slug>         reiniciar (apos editar AGENT.md)

  Dentro do Claude (sessao):
    /plugin marketplace add DGatoM/DG-Claw  adicionar a "loja"
    /plugin install dgclaw@dgclaw           instalar o DG Claw
    /dgclaw:setup                           wizard de instalacao
    /dgclaw:service                         ligar/desligar/status/logs
    /dgclaw:memory                          memoria
    /dgclaw:connect                         conectar Google

  No Telegram (com o bot):
    /reset                                  zera a conversa (memoria fica)
```

---

## Erros comuns na aula (e a saida rapida)

| Sintoma | Causa provavel | Saida |
|---|---|---|
| `claude: command not found` | PATH | `export PATH="$HOME/.local/bin:$PATH"` |
| Bot nao responde | token errado / Bun fora do PATH | `/dgclaw:service` + ver logs |
| "nao autorizado" no bot | seu ID nao esta no allowlist | rever `access.json` (Passo 5) |
| Wizard nao acha o plugin | esqueceu `/reload-plugins` | rodar e tentar de novo |
| Busca semantica nao acende | sem chave Gemini ou sem indice | `/dgclaw:memory` -> reindexar |
