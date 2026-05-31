# DG Claw

> Seu assistente pessoal no Telegram, com memoria, rodando 24/7 na sua VPS.

DG Claw e um plugin do **Claude Code** que instala e gerencia um assistente
pessoal: voce conversa por um bot do Telegram, ele lembra das suas coisas
(memoria curta, longa e busca semantica) e fica sempre ligado via systemd.
Um wizard guiado (`/dgclaw:setup`) monta tudo — ideal pra quem nunca programou.

E o **ancestral simples** dos assistentes de producao (Isa/Jarbas): mesma
arquitetura de base (Claude Code Channels), sem o sistema de personalidade/
emocoes deles — mas com a memoria completa.

```
   VOCE  <--Telegram-->  [ BOT ]  <-->  [ Claude Code ]
                                              |
                                       [ memoria em arquivos ]
                                       [ vive 24/7 no systemd ]
```

## Instalacao rapida

Numa VPS Linux, com o Claude Code ja instalado e logado:

```
/plugin marketplace add DGatoM/DG-Claw
/plugin install dgclaw@dgclaw
/plugin install telegram@claude-plugins-official
/reload-plugins
/dgclaw:setup
```

O wizard cuida do resto: nome e personalidade, criacao do bot no Telegram,
memoria, conectores Google e o servico 24/7.

Passo a passo completo (do zero, incluindo alugar a VPS e criar o bot):
veja [`docs/AULA.md`](docs/AULA.md).

## Comandos

| Comando | O que faz |
|---|---|
| `/dgclaw:setup` | Wizard de instalacao do assistente |
| `/dgclaw:service` | Liga, desliga, reinicia, status e logs |
| `/dgclaw:memory` | Explica e gerencia a memoria; liga/reindexa a busca semantica |
| `/dgclaw:connect` | Conecta Google Drive/Gmail/Calendar (connectors nativos do Claude) |

## Como funciona

- **Para leigos:** [`docs/COMO-FUNCIONA.md`](docs/COMO-FUNCIONA.md) — sem jargao, com desenhos.
- **Tecnico:** [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — diagramas, fluxos, anatomia do workspace.

## Requisitos

- VPS Linux (Ubuntu 22.04+ recomendado), com acesso root/sudo.
- Claude Code instalado e logado (Pro ou Max).
- Telegram (pra criar o bot via BotFather).
- Plugin `telegram@claude-plugins-official` (o wizard ajuda a instalar).
- Bun (o wizard instala se faltar).
- Opcional: chave gratis do Gemini (busca semantica de memoria).

## Memoria

| Camada | Arquivo | Papel |
|---|---|---|
| Curto prazo | `working-memory.md` | o "agora": tarefas e contexto recente |
| Longo prazo | `MEMORY.md` | fatos duraveis; sobrevive a `/reset` |
| Semantica (opcional) | `memory_index/chunks.db` | lembrar por semelhanca de assunto |

A busca semantica degrada sozinha: sem chave Gemini ou sem indice, a memoria em
arquivos continua funcionando normalmente.

## Estrutura do plugin

```
.claude-plugin/   plugin.json + marketplace.json
skills/           setup, memory, connect, service
hooks/            recall semantico de memoria (UserPromptSubmit)
scripts/          launch, install-service, bootstrap-identity, memory_index/
templates/        AGENT, CLAUDE, MEMORY, working-memory, access
docs/             COMO-FUNCIONA, ARQUITETURA, AULA
```

## Licenca

MIT (veja LICENSE).
