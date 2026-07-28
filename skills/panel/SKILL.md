---
name: panel
description: Liga/desliga o painel web do agente DG Claw modo local (memoria, status, fio da conversa em http://localhost:8200). Use quando o usuario rodar /dgclaw:panel, pedir pra "abrir o painel", "ver a memoria do agente", "fechar o painel", ou perguntar como ver o que o agente esta pensando/lembrando.
user-invocable: true
---

# /dgclaw:panel — Painel do agente (modo local)

Painel web local (só este computador enxerga): status vivo/mudo, medidor de
memória de trabalho, working-memory e memória de longo prazo editáveis, fio da
conversa do Telegram e log de compactações.

## Achar a pasta do agente

Se a sessão já está na pasta do agente (existe `.dgclaw/config.json` aqui),
use-a. Senão, procure por `Agente*/.dgclaw/config.json` no home da pessoa e
confirme qual agente é.

> Modo servidor (VPS, `.dgclaw/config.sh`)? Este painel não é pra lá — use o
> painel do modo servidor (`scripts/install-panel-service.sh`, skill
> /dgclaw:memory).

## Ligar

```bash
cd "<pasta do agente>" && bun .dgclaw/panel/panel.ts
```

Rode **em segundo plano** (o painel fica servindo). Ele imprime a URL —
peça pra pessoa abrir **http://localhost:8200** (ou a porta do
`.dgclaw/config.json`). Se der "porta em uso", o painel provavelmente já está
ligado — só passe a URL.

## Desligar

O painel grava o PID em `.dgclaw/panel.pid`. Encerre esse processo
(`kill <pid>` no Mac/Linux; `taskkill /PID <pid>` no Windows) e apague o
arquivo se sobrar.

## O que explicar pra pessoa (1x)

- 🟢 ocioso / 🟠 trabalhando / 🔴 mudo (sessão fechada — abrir o launcher).
- O medidor mostra o quão perto está a próxima "organização de memória"
  (compactação automática) — é normal e o agente avisa antes.
- Editar a memória pelo painel vale na conversa seguinte; o agente também
  anota sozinho.
