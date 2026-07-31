# Como instalar o DG Claw Lite

> Estas instruções servem tanto pra você quanto pro próprio Claude — se você
> recebeu esta pasta num .zip, pode abrir o Claude Code e pedir:
> **"instala o plugin desta pasta seguindo o INSTALAR.md dele"**.

## Caminho 1 (recomendado) — direto do GitHub, sem zip

Dentro do Claude Code, um comando por vez:

```
/plugin marketplace add DGatoM/DG-Claw-Lite
/plugin install dgclaw-lite@dgclaw-lite
/plugin install telegram@claude-plugins-official
```

## Caminho 2 — a partir do .zip

1. Descompacte o .zip numa **pasta neutra** — Downloads ou Documentos serve.
   **NUNCA descompacte dentro da pasta que vai ser do seu agente**: aquela
   pasta é só do agente, nada de instalador ou arquivos de plugin lá dentro.
2. Anote o caminho da pasta descompactada (a que contém este arquivo).
3. No Claude Code, um comando por vez:

```
/plugin marketplace add <caminho da pasta descompactada>
/plugin install dgclaw-lite@dgclaw-lite
/plugin install telegram@claude-plugins-official
```

## ⚠️ Passo OBRIGATÓRIO — reinicie antes de rodar o wizard

Depois do `/plugin install`, **feche e reabra o Claude Code** (ou rode
`/reload-plugins`). Sem isso o wizard não é encontrado e você recebe um
**"Unknown skill"** — aconteceu em instalação real. Só então:

```
/dgclaw-lite:setup
```

O `/dgclaw-lite:setup` conduz todo o resto, um passo de cada vez: check-up,
nome e personalidade do seu agente, pasta e memória, bot no Telegram, primeira
partida com pareamento trancado e os testes.

## Requisitos

- Claude Code instalado e logado (assinatura Pro ou Max) — https://claude.com/claude-code
- Telegram no celular
- Windows, Mac ou Linux — **nenhum outro programa é necessário**
