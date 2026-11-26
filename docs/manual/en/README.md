# DG Claw manual {#manual-do-dg-claw}

This manual gives a realistic account of what DG Claw does today, where to ask for each thing and how thoroughly each statement has been checked. It was written for the DG Claw owner, who does not need to be a programmer, and for the Admin to read before acting. Detailed content lives in the documents linked from each page.

## How to read the "What DG Claw does today" table {#como-ler-a-tabela-o-que-o-dg-claw-faz-hoje}

- **Status.** `Ready` means the feature is in `main` and has an automated test covering the claim in that row. `Partial` means it exists, but with a limit stated in the row (only one engine, no live test, requires a manual step). `In development` means it is not released, even if code or documentation exists: do not rely on it.
- **Where to ask.** Where the owner clicks, or the phrase they say to the agent or Admin.
- **How it was verified.** `test` with the file covering the feature, or `read in code` when I found no test and checked only by reading. I never wrote "tested" for something I only read. An existing test that does not run in `tests/rodar.sh` is marked "outside the suite".
- **Page.** Where the feature is explained.

Test paths are relative to the repository root.

## What DG Claw does today {#o-que-o-dg-claw-faz-hoje}

### Conversation and screens {#conversa-e-telas}

| Feature | Status | Where to ask | How it was verified | Page |
| --- | --- | --- | --- | --- |
| Sign in to the panel and create the first password | Ready | `/login`, `/primeiro-acesso` | test: `web/test/auth.test.js`, `web/test/primeiro-acesso.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Conversation with the agent (browser chat) | Ready | `/a/<slug>` | test: `web/test/api.test.js`, `web/test/thread.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| First agent through the Admin | Ready | "I want to create my first agent" button | test: `web/test/onboarding.test.js`, `web/test/primeiro-acesso.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Status badges, "unread" and agent menu | Ready | Left menu | test: `web/test/estados.test.js`, `web/test/nao-lidas.test.js`, `web/test/vigia-atencao.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Permission request and multiple-choice question in conversation | Partial (Claude only) | Card appearing in the conversation | test: `web/test/trilha.test.js`, `web/test/pergunta.test.js`; Codex limit read in `runner/src/sessao.ts` | [conversa-e-telas.md](conversa-e-telas.md) |
| Media, links and files (Shared) | Ready | Agent's photo or name | test: `web/test/compartilhados.test.js`, `web/test/midias-cache.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Attachments (up to 10 per message, 50 MB) | Ready | Paperclip 📎 | test: `web/test/grava-anexo.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Voice: record, transcribe and listen | Ready, with key | 🎤, 🔊 and 🔁 buttons | test: `web/test/voz-groq.test.js`, `web/test/voz-fatiar.test.js`, `web/test/voz-fila.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Slash commands | Ready | Type `/` in the conversation | test: `web/test/comandos.test.js`, `web/test/barra.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Whiteboard (visuals in conversation) | Ready | "Explain this on the whiteboard" | test: `web/test/visuais.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Password field in conversation (vault) | Ready | The agent shows the card | test: `web/test/campo-cofre.test.js`, `web/test/cofre-agente.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Hidden mode (👁) | Ready | 👁 button | test: `web/test/sigilo.test.js`, `web/test/sigilo-tela.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Anonymize documents | Ready | `/anonimizar` | test: `web/test/anonimizar.test.js`, `web/test/anonimizar-tela.test.js`, `tests/anonimizar/rodar.sh` | [conversa-e-telas.md](conversa-e-telas.md) |
| Persistent reminders | Ready | `/lembretes` or "remind me to..." | test: `web/test/lembretes.test.js`, `web/test/lembretes-tela.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Device notifications (web push) | Ready | "Enable notifications on this device" | test: `web/test/push.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Focus mode | Ready | "Set up my focus for today" | test: `web/test/foco.test.js`, `web/test/foco-hook.test.js`, `web/test/foco-tela.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Delivery and request alerts | Ready | Stack to the right of the conversation | test: `web/test/alertas.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Subscription usage | Ready | Panel status, ☰ Subscription usage | test: `web/test/uso.test.js`, `runner/src/uso.test.ts` | [conversa-e-telas.md](conversa-e-telas.md) |
| Connect AI account | Ready | `/conectar` | test: `web/test/conectar-rota.test.js`, `web/test/conectar-puro.test.js`, `web/test/login-conversa.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Tutorial (guided tour) on each screen | Partial (no automated test) | Tutorial button | read in code (`web/public/tour.js`); only tests of screens mentioning Tutorial exist | [conversa-e-telas.md](conversa-e-telas.md) |
| Agent panel: Status, Operations, Skills, Folder | Ready | `/p/<slug>/` | test: `panel/test-operacoes.mjs`, `panel/test-skills.mjs`, `panel/test-arquivos-sem-pasta.mjs`, `panel/test-wm-status.mjs` | [conversa-e-telas.md](conversa-e-telas.md) |
| Agent panel: Apps tab | Partial (no automated test) | `aba:apps` | read in code (`panel/lib/apps.js`) | [conversa-e-telas.md](conversa-e-telas.md) |
| Manual inside the panel | Ready | `/manual`, ☰ Manual menu | test: `web/test/manual.test.js`, `web/test/manual-tela.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |

### Agents {#agentes}

| Feature | Status | Where to ask | How it was verified | Page |
| --- | --- | --- | --- | --- |
| Create, list, stop, restart, repair, recreate and remove agents | Ready | Admin: "create an agent" | test: `tests/cli/criar.sh`, `tests/cli/gestao.sh`, `tests/cli/recriar.sh` | [agentes.md](agentes.md) |
| Identity and personality (edit and save again) | Ready | `aba:identity`, `aba:personality` | test: `tests/cli/criar.sh`, `tests/ambiente/rodar.sh`, `panel/test-memoria-editar.mjs` | [agentes.md](agentes.md) |
| Task desk | Ready | `/mesa` | test: `web/test/mesa.test.js`, `web/test/mesa-tela.test.js`, `bin/test/dgclaw-mesa.test.sh` | [agentes.md](agentes.md) |
| Request queue (Desk's Requests tab) | Ready | `/mesa`, first tab | test: `web/test/pedidos.test.js`, `web/test/pedidos-tela.test.js`, `bin/test/dgclaw-mesa.test.sh` | [agentes.md](agentes.md) |
| Noticeboard between agents | Ready | `/avisos` | test: `web/test/avisos.test.js`, `web/test/avisos-tela.test.js`, `web/test/avisos-ponta.test.js`; I did not find `hooks/avisos.py`, which would inject notices with every message, connected during agent creation (API reading exists) | [agentes.md](agentes.md) |
| Screen (agent's browser) | Ready | "Browser" menu, `aba:tela` | test: `tests/tela/rodar.sh`, `tests/cli/tela.sh`, `panel/test-tela.mjs` | [agentes.md](agentes.md) |
| Sessions and cards (mini-Bunker) | Ready | `aba:sessoes`, "open a card" | test: `panel/test-sessoes-local.mjs`, `bin/test/dgclaw-card.test.sh`, `runner/src/sessoes-modo.test.ts` | [agentes.md](agentes.md) |
| Card monitor mode | Ready | The agent enables it itself | test: `tests/monitor/rodar.sh` | [agentes.md](agentes.md) |
| Vault and panel API keys | Ready | `aba:cofre`, `dgclaw agente cofre` | test: `panel/test-cofre.mjs`, `panel/test-chaves-api.mjs`, `tests/cli/cofre.sh` | [agentes.md](agentes.md) |
| Help (on-call assistant) | Partial (Claude only) | `aba:socorro` | test: `panel/test-saude.mjs`; Claude-only use read in `panel/lib/socorro.js` | [agentes.md](agentes.md) |
| Collaborator invited by the owner | Ready | `/colaboradores` | test: `web/test/colaboradores.test.js`, `web/test/colaboradores-revisao.test.js` | [agentes.md](agentes.md) |
| Collaborator created by the Admin (`dgclaw colaborador`) | In development | Does not exist yet | not verified: command does not exist in this branch's CLI | [em-desenvolvimento.md](em-desenvolvimento.md) |
| 14 skills connected to the agent at creation | Partial (no automated test) | Ask in Portuguese or use `/` in the conversation | read in code (`bin/dgclaw`, skills loop); `lista-rapida` and `foco` have their own tests | [agentes.md](agentes.md) |
| Repository skills without automatic connection (`canais`, `cards`, `mesa`, `tela`, `socorro`, `lista-rapida` and those from the old plugin) | Partial | Check before promising | read in code; `scripts/_lib/test_lista_rapida.py` covers only the quick list | [agentes.md](agentes.md) |
| `instagram` power | Partial | "Enable Instagram" | test for timers only: `scripts/_lib/test_install_ig_timers.py`; rest read in code | [agentes.md](agentes.md) |
| `meetings`, `crm` and `secretary` powers | In development | Locked | read in code (`panel/lib/poderes.js`, `powers/*/POWER.md`) | [em-desenvolvimento.md](em-desenvolvimento.md) |

### Channels {#canais}

| Feature | Status | Where to ask | How it was verified | Page |
| --- | --- | --- | --- | --- |
| Panel chat (DG Chat) | Ready | `/a/<slug>` | test: `scripts/dgchat-mcp/test-server.mjs` | [canais.md](canais.md) |
| Telegram | Ready (Claude only) | "I want to talk to you on Telegram" | test: `bin/test/dgclaw-agente.test.sh`, `runner/src/canais.test.ts`, `web/test/token-telegram.test.js` | [canais.md](canais.md) |
| `whatsapp` | Partial | "Connect my WhatsApp" | test with fake WhatsApp: `canais/whatsapp/test/ponte.test.mjs`, `bin/test/dgclaw-agente.test.sh`; no live test | [canais.md](canais.md) |
| Gmail, Calendar and Drive through Claude connectors | Partial (Claude subscription only) | "Summarize my latest emails" | send safeguard test: `scripts/test-gmail-permissao.sh` (outside the suite); connectors read in `docs/GMAIL-NO-AGENTE.md` | [canais.md](canais.md) |

### Providers {#provedores}

| Feature | Status | Where to ask | How it was verified | Page |
| --- | --- | --- | --- | --- |
| `claude` (Claude Code) | Ready | Admin: `--provedor claude` | test: `runner/src/claude-motor.test.ts`, `runner/src/sessao-claude.test.ts` | [provedores.md](provedores.md) |
| `codex` (Codex CLI) | Partial | Admin: `--provedor codex` | test: `runner/src/codex-motor.test.ts`, `runner/src/sessao-codex.test.ts`; gaps in [../PARIDADE-CODEX.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PARIDADE-CODEX.md) | [provedores.md](provedores.md) |
| `gemini` (Gemini CLI) | In development | Grayed out in provider switching | read in code (`providers/catalogo.json`, `"disponivel": false`) | [provedores.md](provedores.md) |
| Change provider, model and payment method | Ready | Status, Change button | test: `panel/test-provedor.mjs`, `runner/src/servidor-provedor.test.ts` | [provedores.md](provedores.md) |
| Assisted login and API key | Ready | `/conectar`, Vault tab | test: `runner/src/login.test.ts`, `web/test/conectar-rota.test.js` | [provedores.md](provedores.md) |

### Memory and routines {#memoria-e-rotinas}

| Feature | Status | Where to ask | How it was verified | Page |
| --- | --- | --- | --- | --- |
| File-based memory and panel reader/editor | Ready | `aba:memory` | test: `panel/test-memoria-editar.mjs`, `panel/test-wm-status.mjs` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Daily notebook (`working-memory.md`) | Ready | Rebuilt at 7 a.m. | test outside the suite: `scripts/test_build_working_memory.py` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Search past conversations | Ready | "Remember when I mentioned..." | test outside the suite: `scripts/memory_index/test_conversas_fts.py` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Semantic memory (search by meaning) | Partial | Ask the Admin to install the model | read in code (`scripts/install-embedding-local.sh`, `scripts/install-timers.sh`) | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Brain X-ray (`aba:status`, `aba:como`) | Ready | `aba:status` | test: `panel/test-memoria-editar.mjs` (`/api/cerebro` route) | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Nightly reflection, heartbeat, watcher and pokes | Partial (complete only on Claude) | Automatic | partial test: `scripts/_lib/test_inject_ociosidade.py`, `scripts/test_auto_compact_assentar.py` (outside the suite); schedules read in `scripts/install-timers.sh` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Agent routines and schedule | Ready | "Send me the summary every day at 9 a.m." | test: `scripts/_lib/test_rotina_usuario.py`, `scripts/_lib/test_rotina_e_sessao_morta.py` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Costs and spending cap | Partial (Claude only) | `aba:costs` | test: `panel/test-teto-gastos.mjs`; Codex limit read in [../PARIDADE-CODEX.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PARIDADE-CODEX.md) | [memoria-e-rotinas.md](memoria-e-rotinas.md) |

### Security {#seguranca}

| Feature | Status | Where to ask | How it was verified | Page |
| --- | --- | --- | --- | --- |
| Security patrol | Ready | `/seguranca` | test: `tests/ronda/rodar.sh`, `web/test/ronda-painel.test.js` | [seguranca.md](seguranca.md) |
| Security bulletins | Ready | `/seguranca` | test: `tests/boletins/rodar.sh`, `web/test/seguranca.test.js` | [seguranca.md](seguranca.md) |
| Emergency button | Ready | `/seguranca`, `dgclaw emergencia` | test: `tests/emergencia/rodar.sh` | [seguranca.md](seguranca.md) |
| Agent health and safe mode | Partial (Claude only) | Agent badge, `aba:socorro` | test: `scripts/_lib/test_saude_sessao.py`, `scripts/_lib/test_reinicio.py`, `scripts/_lib/test_quarentena.py`, `panel/test-saude.mjs` | [seguranca.md](seguranca.md) |
| Agent isolation and firewall | Ready | Automatic at creation | test in a fake root: `tests/instalador/rodar.sh`; real proof is on the server, as [../ARQUITETURA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ARQUITETURA.md) explains | [seguranca.md](seguranca.md) |
| Adversarial review of changes | Ready | Project process | test: `tests/revisao-adversarial/rodar.sh` | [seguranca.md](seguranca.md) |
| Face ID (`/cadeado`) | In development | Does not exist yet | not verified: no screen or route in this branch's code | [em-desenvolvimento.md](em-desenvolvimento.md) |

### Updates and backup {#atualizacao-e-backup}

| Feature | Status | Where to ask | How it was verified | Page |
| --- | --- | --- | --- | --- |
| Update DG Claw | Ready | Admin: "update DG Claw" | test: `tests/cli/atualizar.sh` | [atualizar-e-backup.md](atualizar-e-backup.md) |
| Backup and restore | Ready | `dgclaw backup`, `dgclaw restaurar` | test: `tests/cli/backup.sh` | [atualizar-e-backup.md](atualizar-e-backup.md) |
| New-version notification | Ready | Panel banner | test: `tests/aviso-atualizacao/rodar.sh`, `web/test/atualizacao.test.js` | [atualizar-e-backup.md](atualizar-e-backup.md) |
| What's new after an update | Ready | Automatic | test: `tests/novidades/rodar.sh` | [atualizar-e-backup.md](atualizar-e-backup.md) |
| Installation and remote installation | Ready | `install.sh`, `dgclaw instalacao-remota` | test: `tests/instalador/rodar.sh`, `tests/cli/instalacao-remota.sh` | [atualizar-e-backup.md](atualizar-e-backup.md) |

### Customization {#personalizacao}

| Feature | Status | Where to ask | How it was verified | Page |
| --- | --- | --- | --- | --- |
| Customization register that survives updates | Ready | Admin: "customize this" | test: `tests/cli/personalizacoes.sh` | [personalizar.md](personalizar.md) |
| Change the panel address to a custom domain | Ready | Admin: "I want my own domain" | test: `tests/cli/dominio.sh` | [personalizar.md](personalizar.md) |
| Replace the panel page | In development | Does not exist yet | not verified | [em-desenvolvimento.md](em-desenvolvimento.md) |

## Page index {#indice-das-paginas}

| Page | What it covers |
| --- | --- |
| [conversa-e-telas.md](conversa-e-telas.md) | Screens, conversation, attachments, voice, slash commands, whiteboard, hidden mode, Anonymize, reminders, notifications, focus, alerts, subscription usage and panel tabs |
| [agentes.md](agentes.md) | Creating and caring for agents, identity, Desk, noticeboard, Screen, sessions, monitor mode, vault, help, collaborators, skills and powers |
| [canais.md](canais.md) | Panel chat, Telegram, `whatsapp` and Gmail |
| [provedores.md](provedores.md) | `claude`, `codex` and `gemini`, login, API key, parity and account suspension risk |
| [memoria-e-rotinas.md](memoria-e-rotinas.md) | Memory, search, brain X-ray, nighttime routines, pokes, reminders, schedule and costs |
| [seguranca.md](seguranca.md) | Patrol, bulletins, emergency, health and isolation |
| [atualizar-e-backup.md](atualizar-e-backup.md) | Updates, backup, restore and version notices |
| [personalizar.md](personalizar.md) | How to change DG Claw without losing the change in the next update |
| [o-que-nao-faz.md](o-que-nao-faz.md) | What DG Claw does not do, so nobody promises too much |
| [em-desenvolvimento.md](em-desenvolvimento.md) | What has not been released yet |
| [referencia-admin.md](referencia-admin.md) | Routes, commands and options for the Admin and API operators |
| [pendencias.md](pendencias.md) | Discrepancies between documentation and code, or questions still unanswered |
