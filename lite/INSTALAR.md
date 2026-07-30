# Como instalar o DG Claw Lite (a partir desta pasta)

> Estas instruções servem tanto pra você quanto pro próprio Claude — se você
> recebeu esta pasta num .zip, pode simplesmente abrir o Claude Code e pedir:
> **"descompacta esse zip e instala o plugin que está dentro, seguindo o
> INSTALAR.md dele"**.

## Passo a passo

1. Descompacte o .zip em qualquer lugar do computador (ex.: a pasta Documentos).
   Anote o caminho da pasta descompactada (a que contém este arquivo).

2. Abra o **Claude Code** (instalado e logado com sua assinatura Pro ou Max).

3. Rode, um por vez, dentro do Claude Code:

   ```
   /plugin marketplace add <caminho da pasta descompactada>
   /plugin install dgclaw-lite@dgclaw-lite
   /plugin install telegram@claude-plugins-official
   /reload-plugins
   /dgclaw-lite:setup
   ```

4. O `/dgclaw-lite:setup` conduz todo o resto, um passo de cada vez:
   check-up, nome e personalidade do seu agente, bot no Telegram, primeira
   partida e os testes.

## Alternativa (direto do GitHub, sem zip)

```
/plugin marketplace add DGatoM/DG-Claw-Lite
/plugin install dgclaw-lite@dgclaw-lite
/plugin install telegram@claude-plugins-official
/reload-plugins
/dgclaw-lite:setup
```

## Requisitos

- Claude Code instalado e logado (assinatura Pro ou Max) — https://claude.com/claude-code
- Telegram no celular
- Windows, Mac ou Linux — **nenhum outro programa é necessário**
