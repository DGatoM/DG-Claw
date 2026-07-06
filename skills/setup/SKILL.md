---
name: setup
description: Wizard de instalacao do DG Claw — cria um agente pessoal seu no Telegram, com nome, personalidade e memoria. Tem dois modos - LOCAL (no seu proprio computador Windows/Mac, so com a assinatura, sem servidor) e SERVIDOR (24/7 numa VPS Linux). Use quando o usuario rodar /dgclaw:setup, pedir pra "instalar o DG Claw", "criar meu assistente/agente", "configurar o bot", ou comecar a montar um assistente do zero.
user-invocable: true
---

# /dgclaw:setup — Wizard de instalação do DG Claw

Você conduz uma pessoa (possivelmente leiga) a criar o agente pessoal dela no
Telegram, do zero. Vá com calma, **um passo de cada vez**, explicando cada peça
em 1-2 frases ANTES de executar, e confirmando antes de seguir. Fale em
português do Brasil, tom acolhedor. Se der erro, explique simples e só siga
quando resolver.

## Passo 0 — Onde estamos? (escolhe o modo)

O DG Claw tem dois modos. Descubra qual é o caso ANTES de tudo:

- **MODO LOCAL** — o agente roda no computador da própria pessoa (Windows,
  macOS, ou Linux desktop). Só precisa da assinatura Pro/Max. É o modo da
  Imersão. Limitação honesta: computador desligado/dormindo = agente dormindo.
- **MODO SERVIDOR** — o agente roda 24/7 numa VPS Linux com systemd, como
  serviço. Para quem tem servidor.

Como decidir:
1. Cheque o sistema: no Windows/macOS → quase certamente LOCAL.
2. Em Linux, pergunte: "esse computador é uma VPS/servidor que fica ligado
   24h, ou é o seu computador do dia a dia?" (dica técnica: VPS costuma ter
   acesso root/ssh e sem interface gráfica).
3. Na dúvida, pergunte diretamente: "você quer o agente no SEU computador
   (liga quando você liga) ou num servidor sempre ligado?"

Decidido o modo, **leia e siga o arquivo correspondente nesta pasta da skill**:

- MODO LOCAL → leia `LOCAL.md` e siga o wizard de lá.
- MODO SERVIDOR → leia `SERVIDOR.md` e siga o wizard de lá (fluxo v0.1,
  inalterado).

Não misture os dois fluxos. Em caso de dúvida sobre o caminho dos arquivos:
eles moram em `skills/setup/` dentro da pasta de instalação do plugin
(`${CLAUDE_PLUGIN_ROOT}`).
