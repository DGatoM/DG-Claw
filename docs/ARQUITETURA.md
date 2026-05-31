# Arquitetura do DG Claw (visao tecnica, com ASCII)

Pra quem quer entender por dentro. Continua acessivel, mas aqui aparecem os
nomes reais (systemd, Channels, MCP, hooks).

---

## Visao geral

O DG Claw nao reinventa nada: ele monta, de forma guiada, a mesma arquitetura
que os assistentes de producao (Isa/Jarbas) usam — **Claude Code Channels**.

```
   TELEGRAM (app no seu celular)
        |
        |  Bot API (long polling)
        v
   +-------------------------------------------------------------+
   |  VPS (Linux)                                                |
   |                                                             |
   |  systemd: dgclaw-<slug>.service   (Restart=always)         |
   |     |                                                       |
   |     v                                                       |
   |  claude --channels plugin:telegram@claude-plugins-official  |
   |     |        ^                                              |
   |     |        |  injeta msg / envia reply                   |
   |     |   +----+-----------------------------+                |
   |     |   |  MCP server do plugin telegram   |  (roda em Bun) |
   |     |   |  faz o polling do bot            |                |
   |     |   +----------------------------------+                |
   |     |                                                       |
   |     v                                                       |
   |  Sessao Claude longeva (viva em RAM 24/7)                   |
   |     - system prompt = AGENT.md + regras de canal           |
   |     - project instructions = CLAUDE.md (do workspace)      |
   |     - hook UserPromptSubmit = recall de memoria            |
   |     - tools: Bash, arquivos, + connectors Google (opcional)|
   |                                                             |
   |  Workspace ~/dgclaw/<slug>/                                |
   |     AGENT.md  CLAUDE.md  MEMORY.md  working-memory.md       |
   |     memory/   .dgclaw/config.sh   .dgclaw/logs/             |
   +-------------------------------------------------------------+
```

Ponto-chave: a sessao fica **viva em RAM**. O prompt de sistema fica "quente"
no cache, entao as respostas comecam rapido (~1s). Isso e diferente do modelo
antigo (daemon que dava `claude --print` a cada mensagem, mais lento e mais caro).

---

## Os dois "Claudes" (nao confunda)

Durante a instalacao existem DUAS sessoes do Claude:

```
  +-------------------------+        +-----------------------------+
  |  SESSAO ADMIN           |        |  SESSAO DO BOT              |
  |  voce, no terminal      |        |  systemd, --channels        |
  |  roda /plugin install   | cria-> |  e quem CONVERSA no Telegram|
  |  roda /dgclaw:setup     |        |  fica viva 24/7             |
  +-------------------------+        +-----------------------------+
```

O **wizard** roda na sessao admin e constroi tudo que a sessao do bot precisa
(workspace, token, config, servico systemd). O **plugin** e instalado a nivel de
usuario, entao as duas sessoes enxergam suas skills e hooks.

---

## Fluxo de uma mensagem (detalhado)

```
  1. Voce manda "oi" no Telegram
  2. MCP server (Bun) recebe via Bot API e injeta na sessao como:
        <channel source="telegram" chat_id="123">oi</channel>
  3. HOOK UserPromptSubmit dispara (memory-recall.sh):
        - tira o wrapper <channel>
        - pega as palavras "fora do comum" da mensagem
        - procura essas palavras nos arquivos de memoria (local, sem API)
        - se achar linhas relacionadas -> injeta "MEMORIA RELACIONADA: ..."
  4. Claude le tudo (system prompt + CLAUDE.md + msg + memoria injetada)
  5. PRIMEIRA acao: chama a tool reply (senao voce nao recebe nada!)
  6. Faz o trabalho (Bash, arquivos, Google...) e manda reply com o resultado
  7. Atualiza working-memory.md / MEMORY.md se aprendeu algo
```

---

## A memoria por dentro (tudo local, sem API externa)

Recall (a cada mensagem) e consolidacao (toda noite) — nenhum servico de fora:

```
  RECALL (memory_recall_local.py, no hook UserPromptSubmit)
     |  pega palavras "fora do comum" da sua mensagem
     |  procura (sem acento, case-insensitive) nas linhas de
     |  MEMORY.md + working-memory.md + memory/*.md
     v
  injeta as linhas que casaram -> "MEMORIA RELACIONADA: ..." -> Claude "lembra"
  (busca por palavra-chave: instantanea, gratis, zero dependencia)

  CONSOLIDACAO (consolidate.sh, via timer systemd ~04:00)
     |  o PROPRIO claude (claude -p, sem API externa) le os arquivos
     |  promove o que e duradouro: working-memory.md --> MEMORY.md
     |  limpa o working-memory (tira o que ja foi feito/obsoleto)
     v
  MEMORY.md fica enxuto e organizado pro recall do dia seguinte
```

- **Por que sem embeddings?** Pra nao depender de nenhuma chave/servico externo
  (ex: Google). A memoria de um assistente pessoal e pequena e curada — busca por
  palavra-chave + consolidacao noturna do proprio Claude da conta.
- **Degrada sozinho:** sem arquivos de memoria, o hook nao faz nada e a conversa
  segue normal.
- **Custo:** recall = zero (local). Consolidacao = uma chamada Claude por noite.

---

## Anatomia do workspace

```
  ~/dgclaw/<slug>/
  |
  +-- AGENT.md            identidade (nome + personalidade) -> vai no system prompt
  +-- CLAUDE.md           regras de operacao (memoria, canal, sessoes)
  +-- MEMORY.md           memoria de longo prazo
  +-- working-memory.md   memoria de curto prazo
  +-- memory/             notas/diarios extras (opcional)
  +-- .dgclaw/
        +-- config.sh      NAME, SLUG, WORKSPACE, STATE_DIR
        +-- logs/          logs do recall e da consolidacao

  ~/.claude/dgclaw-channels/<slug>/telegram/
  |
  +-- .env               TELEGRAM_BOT_TOKEN (isolado por assistente)
  +-- access.json        dmPolicy=allowlist + seu ID numerico

  /etc/systemd/system/dgclaw-<slug>.service
  |
  +-- mantem a sessao do bot viva e a reinicia se cair
```

O `TELEGRAM_STATE_DIR` ser separado por assistente e o que permite rodar
**varios bots na mesma VPS** sem um pisar no outro.

---

## Componentes do plugin (o que voce instala)

```
  dgclaw/  (o repo = o marketplace = o plugin)
  +-- .claude-plugin/plugin.json        identidade do plugin
  +-- .claude-plugin/marketplace.json   se anuncia como marketplace
  +-- skills/  setup, memory, connect, service   (os comandos /dgclaw:*)
  +-- hooks/   hooks.json + memory-recall.sh      (recall automatico)
  +-- scripts/ launch.sh, install-service.sh, bootstrap-identity.sh,
  |            consolidate.sh, install-consolidate-timer.sh,
  |            panel.py, install-panel-service.sh,
  |            memory_index/memory_recall_local.py
  +-- templates/  AGENT/CLAUDE/MEMORY/working-memory/access (modelos)
  +-- docs/    COMO-FUNCIONA, ARQUITETURA, AULA, FLUXOS-AULA
```

---

## Por que plugin (e nao um instalador solto)?

- **Distribuicao oficial:** `/plugin marketplace add` + `/plugin install` e o
  caminho nativo do Claude Code. Atualiza com versionamento.
- **Skills se auto-anunciam:** o `/dgclaw:setup` aparece sozinho; o aluno nao
  decora comando.
- **Hooks viajam junto:** o recall de memoria ja vem ativo na sessao do bot,
  sem configuracao manual.
- **Se apoia no plugin telegram oficial** em vez de reimplementar a ponte —
  menos codigo nosso, mais robusto.
