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
   |     memory/   memory_index/chunks.db   .dgclaw/config.sh   |
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
        - ve se tem palavra "fora do comum"
        - se tiver + houver indice: embedding + cosine no chunks.db
        - se achar algo relevante -> injeta "MEMORIA ERRANTE: ..."
  4. Claude le tudo (system prompt + CLAUDE.md + msg + memoria injetada)
  5. PRIMEIRA acao: chama a tool reply (senao voce nao recebe nada!)
  6. Faz o trabalho (Bash, arquivos, Google...) e manda reply com o resultado
  7. Atualiza working-memory.md / MEMORY.md se aprendeu algo
```

---

## A memoria semantica por dentro

```
  reindex.py  (roda quando voce manda ou periodicamente)
     |
     |  le MEMORY.md, working-memory.md, memory/*.md
     |  quebra em pedacos (~200 palavras, com sobreposicao)
     |  pra cada pedaco: pede um EMBEDDING ao Gemini (vetor de 768 numeros)
     v
  chunks.db (SQLite)         [ pedaco de texto | vetor | data | fonte ]
                                          ^
                                          |
  memory_search_fast.py  <----------------+
     |  transforma sua pergunta em vetor (Gemini)
     |  compara com todos os pedacos (similaridade do cosseno)
     |  o mais parecido, se passar do limite (0.70), e o "lembrete"
     v
  hook injeta esse lembrete no contexto -> Claude "lembra"
```

- **Embedding** = transformar texto num vetor de numeros que captura o
  *significado*. Textos parecidos -> vetores proximos. E o que permite achar por
  semelhanca em vez de palavra exata.
- **Degrada sozinho:** sem `GEMINI_API_KEY` ou sem `chunks.db`, o hook nao faz
  nada e a conversa segue normal (a memoria em arquivo continua funcionando).
- O embedding usa o **free tier** do Google AI Studio — custo praticamente zero.

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
  +-- memory_index/
  |     +-- chunks.db      indice semantico (gerado)
  +-- .dgclaw/
        +-- config.sh      NAME, SLUG, WORKSPACE, STATE_DIR, GEMINI_API_KEY
        +-- logs/          logs do hook de memoria

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
  |            memory_index/*.py
  +-- templates/  AGENT/CLAUDE/MEMORY/working-memory/access (modelos)
  +-- docs/    COMO-FUNCIONA, ARQUITETURA, AULA
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
