# DG Claw

> Seu agente pessoal no Telegram, com nome, personalidade e memória — rodando
> no **seu computador** (modo local) ou 24/7 numa **VPS** (modo servidor).

DG Claw é um plugin do **Claude Code**. Um wizard guiado (`/dgclaw:setup`)
monta tudo: check-up da máquina, bot do Telegram, persona, memória e launcher.
Ideal pra quem nunca programou.

## Modo Local vs Modo Servidor

| | 🖥️ **Modo Local** (v0.2) | ☁️ **Modo Servidor** (v0.1) |
|---|---|---|
| Onde roda | Seu Windows/Mac (ou Linux desktop) | VPS Linux, systemd |
| O que precisa | Só assinatura Pro/Max (sem API key, sem servidor) | VPS com root |
| Disponibilidade | Enquanto o computador estiver ligado | 24/7 |
| Como liga | Dois cliques no launcher `Iniciar <Nome>` | serviço systemd |
| Pra quem | Alunos/iniciantes; a Imersão usa este | Quem já tem VPS |

O wizard detecta o ambiente e conduz o modo certo.

## O pitch honesto (modo local)

O motor do agente é **100% Claude Code nativo**: a sessão
`claude --continue --channels plugin:telegram@claude-plugins-official` numa
pasta É o agente — Telegram e terminal caem na mesma conversa contínua, a
memória persistente e a compactação automática são nativas, tarefas agendadas
são nativas. **A pasta é o agente.**

O DG Claw agrega a camada que o nativo não tem:

- **Wizard leigo** com check-up da máquina (`/dgclaw:setup`)
- **Persona pronta** (CLAUDE.md com regras de canal, memória e proatividade)
- **Hooks Bun** (cross-platform) que preservam o fio literal da conversa do
  Telegram através das compactações e avisam o dono antes de compactar
- **Launcher de 1 clique** por sistema (.command / .bat)
- **Painel web local** (http://localhost:8200): status, memória editável, fio
  da conversa (`/dgclaw:panel`)
- **notify.ts**: ponte "qualquer coisa → Telegram" (tarefas agendadas avisam
  o dono sem conflitar com o canal)
- **Doctor** que conserta os defeitos conhecidos (`/dgclaw:doctor`) +
  `TROUBLESHOOTING.md` pra leigo na pasta do agente

Limitações francas: computador desligado/dormindo = agente dormindo; mensagem
mandada com ele offline se perde (reenviar); nunca abrir o launcher 2×.

## Instalação rápida

Com o Claude Code instalado e logado (Pro/Max):

```
/plugin marketplace add DGatoM/DG-Claw
/plugin install dgclaw@dgclaw
/plugin install telegram@claude-plugins-official
/reload-plugins
/dgclaw:setup
```

O wizard cuida do resto. Modo servidor do zero (incluindo alugar a VPS):
[`docs/AULA.md`](docs/AULA.md). Roteiro da Imersão: [`docs/IMERSAO.md`](docs/IMERSAO.md).

## Comandos

| Comando | O que faz | Modo |
|---|---|---|
| `/dgclaw:setup` | Wizard de instalação (detecta local × servidor) | ambos |
| `/dgclaw:doctor` | Diagnostica e conserta (token, 409, cache mudo, hooks…) | ambos |
| `/dgclaw:panel` | Liga/desliga o painel local (localhost:8200) | local |
| `/dgclaw:service` | Liga/desliga/status do serviço systemd | servidor |
| `/dgclaw:memory` | Gerencia memória; consolidação noturna e painel | servidor |
| `/dgclaw:connect` | Conecta Google Drive/Gmail/Calendar | ambos |

## Memória (modo local)

| Camada | Onde | Papel |
|---|---|---|
| Curto prazo | `working-memory.md` na pasta | o "agora"; editável no painel |
| Longo prazo | memória nativa do Claude Code | automática; o CLAUDE.md ensina O QUE anotar (preferências, pessoas, fatos de vida) |
| Fio do Telegram | `.dgclaw/chat-tail.md` (hook) | as últimas mensagens reais sobrevivem à compactação |

**Nenhuma API externa. Nenhuma chave de terceiros.**

## Estrutura do plugin

```
.claude-plugin/   plugin.json + marketplace.json
skills/           setup (LOCAL.md + SERVIDOR.md), doctor, panel, memory, connect, service
local/            MODO LOCAL: hooks Bun, painel, scripts (scaffold, notify,
                  checkup, doctor), templates (persona, launcher, troubleshooting)
hooks/            hooks de plugin do modo servidor (dispatch.ts + bash v0.1)
scripts/          modo servidor v0.1: install-service, doctor.sh, panel.py, ...
templates/        modo servidor v0.1: AGENT, CLAUDE, MEMORY, working-memory, access
docs/             COMO-FUNCIONA, ARQUITETURA, AULA, FLUXOS-AULA, IMERSAO
```

## Licença

MIT (veja LICENSE).
