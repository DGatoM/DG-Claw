# Agents {#agentes}

This page covers what the owner does with work agents: create, stop, repair and remove them, give them an identity, follow their work through the Desk, store keys, let the agent use a browser, open parallel sessions and invite another person. All skills and powers are listed at the end. Each feature explains what it is, how to ask or where to click, what must be configured, its limits and what to do when something goes wrong.

The Admin, the server's administrative session, creates and looks after agents. The owner asks in Portuguese in `/a/admin`, and the Admin runs `dgclaw` CLI commands. Commands are listed in [referencia-admin.md](referencia-admin.md).

## Create an agent {#criar-um-agente}

**What it is.** Each work agent is its own machine (a non-root container) with a home directory, identity, panel, conversation and vault. It cannot see the server, the Admin or other agents.
**How to ask.** In the Admin conversation: "Create an agent to organize my schedule." The Admin asks one question at a time (name, role, speaking style, how to address the owner) and runs `dgclaw agente criar <slug> --nome "<Nome>"`. The first time uses the form described in [conversa-e-telas.md](conversa-e-telas.md).
**Options.** `--provedor claude|codex` (default `claude`), `--auth assinatura|api` (default `assinatura`), `--modelo`, `--papel`, `--jeito`, `--dono`, `--canal chat|telegram|whatsapp` (default `chat`), `--avatar` and `--cor`.
**Requires.** The agent image ready (`dgclaw imagem status`; it is built on first creation). Then the provider account connected at `/conectar`.
**Limits.** `--canal telegram` or `whatsapp` only records the intention; connecting the channel is a separate step (see [canais.md](canais.md)). Running the same command again resumes where it stopped without duplicating anything.
**If something goes wrong.** The command explains what failed and what to do. If it stops partway through, repeat the same line.

## Stop, start, restart, repair, recreate and remove {#parar-iniciar-reiniciar-reparar-recriar-e-remover}

| Request to the Admin | Command | What it does |
| --- | --- | --- |
| "List my agents" | `dgclaw agente listar` | Shows which agents exist and which are running |
| "Stop / start / restart Ana" | `dgclaw agente parar`, `dgclaw agente iniciar`, `dgclaw agente reiniciar` | Controls the agent's container |
| "Ana's agent has a problem, fix it" | `dgclaw agente reparar <slug>` | Rewrites configuration and rebuilds the inside (runner, panel and routines) |
| (done by the update) | `dgclaw agente recriar <slug>` | Replaces the container with the new image and keeps the home directory, vault, ports and routines |
| "Take Ana offline" | `dgclaw agente remover <slug>` | Takes the agent offline without deleting it: its home moves to `/var/lib/dgclaw/aposentados/` |

**Limits.** `remover` asks for confirmation and never deletes the agent's home directory. `recriar` only acts when the image has changed (`--forcar` recreates it anyway). Stopped agents stay stopped.
**If something goes wrong.** The first step is `dgclaw agente reparar <slug>`. If the agent seems silent or odd, `aba:socorro` opens an on-call assistant (see [Help](#socorro)).

## Identity and personality {#identidade-e-personalidade}

**What it is.** The agent's identity lives in text files in its home: `AGENT.md` (who it is), `IDENTITY.md`, `PERSONALITY.md`, `MEMORY.md`, among others. The panel's `aba:identity` tab displays and edits these files; `aba:personality` shows the numbers controlling its manner and goals.
**How to ask.** "Make Ana's speaking style more direct." The agent or Admin edits the file. The owner can also edit directly in the tab. After saving, the panel offers **Tell it now**, because the agent only rereads the file at the start of the next conversation.
**Requires.** Nothing.
**Limits.** If the agent wrote to the same file while the owner was editing, the server refuses the save and leaves the owner's text in the box, with buttons to copy it or load the agent's version. To rewrite only the identity without restarting the agent, the Admin uses `dgclaw agente identidade <slug>`: it takes effect in the next session.
**If something goes wrong.** More in [../../panel/docs/CEREBRO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/CEREBRO.md) and [personalizar.md](personalizar.md).

## Task desk {#mesa-de-tarefas}

**What it is.** A single screen (`/mesa`) showing what each agent is doing, how much remains, what is blocked and what is waiting for the owner. The agent creates and updates tasks; the owner follows along and can also create, respond, complete, cancel and reopen them.
**How to ask.** "What are you doing?", "Put this on the desk", "Track this task." On the agent side, the command is `dgclaw-mesa` (`criar`, `atualizar`, `passo`, `pedir`, `travar`, `retomar`, `concluir`, `ver`). The `mesa` skill explains its use.
**Requires.** Nothing. The Desk works independently on each server without an external service.
**Limits.** A quick request does not become a task. States are `fazendo`, `travada`, `esperando_dono`, `concluida` and `cancelada`. A task in `fazendo` with no update for 45 minutes appears as "stalled?". A task waiting for the owner notifies their device. An agent only changes its own tasks. Unmeasured progress appears blank, never as zero.
**If something goes wrong.** Route errors give the reason in Portuguese. More in [../../web/docs/MESA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MESA.md) and [../MESA-DE-TAREFAS.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MESA-DE-TAREFAS.md).

## Request queue (Desk's Requests tab) {#fila-de-pedidos-aba-pedidos-da-mesa}

**What it is.** The Desk's first tab (`/mesa`): each request from the owner to an agent becomes an item, in arrival order, with state `fazendo`, `esperando_dono`, `entregue`, `feito` or `cancelado`. The agent opens the item before starting and moves it as it works; the owner follows along, opens delivered items, marks them done or cancels them.
**How to ask.** "What have I asked for that hasn't been delivered?", "Show me the request queue." On the agent side, the command is `dgclaw-mesa pedido` (`criar`, `fazendo`, `esperar`, `entregar`, `cancelar`, `listar`, `ver`).
**Requires.** Nothing. The queue lives in Web's data folder without an external service.
**Limits.** The agent never marks `feito`: a delivered request becomes `feito` when the owner opens it on screen or writes in that agent's conversation after delivery. The agent only sees and changes its own requests. The default list shows open items and those closed today and yesterday; the rest is archived and appears under "View archived". There is no watcher to automatically open an item the agent forgot. The "Request queue" rule reaches older agents by rewriting their identity (`dgclaw agente identidade <agente>`).
**If something goes wrong.** Route errors give the reason in Portuguese. More in [../../web/docs/PEDIDOS.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/PEDIDOS.md).

## Noticeboard {#quadro-de-avisos}

**What it is.** Short notes between agents: an owner's decision, preference, delivery, lesson, reference, request or daily summary. The owner sees the board at `/avisos` and can also post and remove notices.
**How to ask.** "Tell Marina the meeting has changed." The `avisos` skill guides the agent. Agents do not talk directly to one another: Web carries each notice and delivers it to each recipient's home directory.
**Requires.** Nothing; it is already enabled.
**Limits.** Up to 280 characters and 2 lines per notice, at most 20 notices per hour and 100 per day per agent. The Admin neither posts nor receives. The author is always the agent owning the mailbox through which the request arrived.
**If something goes wrong.** More in [../QUADRO-DE-AVISOS.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/QUADRO-DE-AVISOS.md). On Codex, automatic notice reading is partial (see [provedores.md](provedores.md)).

## Screen: the agent's browser {#tela-o-navegador-do-agente}

**What it is.** A real browser (Google Chrome on an amd64 server, Chromium on arm64) that the owner opens through the panel. The owner signs in to systems with their own keyboard, and the agent then works in that same signed-in browser. The site's password does not pass through the conversation.
**How to use it.** The agent menu's **Browser** item, or the panel's `aba:tela` tab. The first time, it asks for a separate Screen password of 6 to 8 characters. The `tela` skill teaches the agent to send the owner there when a site asks for a login, two-factor code or captcha.
**Requires.** An agent image with a browser (the default).
**Limits.** The Admin has no Screen. Collaborators cannot open Screen because it gives access to the agent's accounts. Logins live in `/home/agente/.tela-chrome` and travel with the agent's home directory.
**If something goes wrong.** The Admin checks with `dgclaw agente tela <slug>`, which says what is running and what is missing, and changes the password with `dgclaw agente tela-senha <slug>`. More in [../TELA-DO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/TELA-DO-AGENTE.md) and [../../panel/docs/TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/TELA.md).

## Sessions and cards (mini-Bunker) {#sessoes-e-cards-mini-bunker}

**What it is.** A card is a parallel session, in Claude or Codex, working on a request while the agent continues the conversation. `aba:sessoes` lists cards, shows what each is doing, and lets you read the conversation, send a note, attach a file, approve or deny a request, archive, resume, rename and star it. A **Sessions** button also appears at the top of the conversation.
**How to ask.** "Open a card to build the presentation." The agent uses `dgclaw-card` (`abrir`, `mandar`, `esperar`, `ler`, `listar`, `estado`, `fechar`). Long work goes to a card; anything resolved in a minute does not.
**Requires.** Nothing. The agent can open the card in another engine ("open a card in Codex"), using the `cards` skill.
**Limits.** At most 8 cards open simultaneously. The main session cannot be archived or deleted. Only the signed-in person decides a permission request (API keys are refused because an agent cannot approve its own request). Permission requests only work in Claude cards.
**If something goes wrong.** Card limit exceeded: archive and delete an old one. More in [../../panel/docs/SESSOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/SESSOES.md) and [../PROVEDORES.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PROVEDORES.md).

## Monitor mode {#modo-monitor}

**What it is.** Watches cards for long tasks on your behalf, spending nothing while nothing happens. Every 5 minutes, `dgclaw-monitor` checks the cards and only wakes the agent with a message when a card stops, finishes, asks for something or encounters an error.
**How to ask.** The agent enables it automatically when opening a card with `dgclaw-card abrir --monitor --entregue "<como saber que terminou>"`. Manually: `dgclaw-monitor add <id> --entregue "..."`, `dgclaw-monitor list`, `dgclaw-monitor rm <id>`, `dgclaw-monitor run`.
**Limits.** The default check interval is 10 minutes (`--cada` changes it). A run without events uses no model at all.
**If something goes wrong.** When a monitor-mode message arrives, the agent tells the owner which card stopped, why, and asks whether it may continue. More in [../MODO-MONITOR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-MONITOR.md).

## Vault and keys {#cofre-e-chaves}

**What it is.** The vault stores keys for services the agent uses (image generation, audio transcription, provider API key). It is in `aba:cofre`. Each agent has its own, and one agent's key does not apply to another. The owner sees who stored it, when and the last four characters, never the value.
**How to ask.** The agent shows a card with a password field in the conversation (see [conversa-e-telas.md](conversa-e-telas.md)), or the owner pastes it in the tab. The Admin stores it by command, with the value through standard input: `dgclaw agente cofre <slug> guardar NOME --aplicar`. `revogar`, `listar` and `aplicar` also exist.
**Panel API keys.** The same tab creates `dgc_...` keys for another program or agent to use the panel API. An API key cannot create another, and only the hash is stored.
**Limits.** The key and account belong to the owner: the service charges the owner for usage. Storing restarts the agent unless requested otherwise. Collaborators cannot change the vault.
**If something goes wrong.** More in [../../panel/docs/COFRE.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/COFRE.md) and [../COFRE-POR-API.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/COFRE-POR-API.md).

## Help {#socorro}

**What it is.** `aba:socorro` opens an on-call assistant when the agent does not respond, responds strangely or its badge turns yellow or red. It is another, neutral Claude that reads logs, explains what happened in Portuguese and proposes a fix. The `socorro` skill gives the Admin the same procedure.
**How to ask.** "Something happened to my agent, take a look."
**Limits.** Reading is unrestricted. For any change (restart, restore, edit, delete), it explains and waits for "yes" in the next message. It does not read secrets. The help session is temporary. It uses Claude, so it depends on the server's Claude account.
**If something goes wrong.** More in [../../panel/docs/SOCORRO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/SOCORRO.md) and [../SAUDE-E-MODO-SEGURO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SAUDE-E-MODO-SEGURO.md).

## Collaborators {#colaboradores}

**What it is.** The owner invites someone to talk to one work agent. They can use the conversation, sessions and panel pages (read-only), but not the Admin, other agents, vault, API keys, AI account, channels or Screen.
**How to invite.** Only the owner invites, through `/colaboradores` (☰ menu, **Invite collaborator**, with the agent selected). Enter the person's email, tap **Invite** and send the invitation text (or let the email be sent if SMTP is configured). The temporary password is valid for 7 days, and the person creates their own password at `/trocar-senha` on first access.
**The Admin does not invite.** `/api/v1/colaboradores` only accepts the owner's browser session: a request arriving through an agent's mailbox (`dgclaw-api`) gets 403, and I found no other way for the Admin to call this route in the code. The Admin's instruction text still suggests the API, but this description takes precedence: the Admin guides the owner to the screen.
**Limits.** An agent may have several collaborators, and each collaborator accesses only one agent. The Admin is never shared. Their messages reach the agent marked as coming from a collaborator. The owner can revoke access at any time, ending the session immediately.
**If something goes wrong.** Email not sent: the screen shows why and provides the invitation text to copy. More in [../../web/docs/COLABORADORES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COLABORADORES.md). Admin-created collaborators (`dgclaw colaborador`) are covered in [em-desenvolvimento.md](em-desenvolvimento.md).

## Skills {#skills}

A skill is a written procedure (a `SKILL.md` file) that the agent reads before doing a job. The owner asks in Portuguese and the agent chooses a skill; to invoke one directly, type `/` in the conversation (see [conversa-e-telas.md](conversa-e-telas.md)). `aba:skills` lists all the agent's skills. When the owner and agent repeat a process with 3 or more steps, `aprender` offers to save it as a custom skill and only creates it with the owner's "yes".

Creating an agent connects these 14 skills to its home: `agenda`, `lembretes`, `aprender`, `avisos`, `memory`, `foco`, `avatar`, `report`, `slide-animado`, `site-animado`, `video-animado`, `groq-audio`, `gemini-gratuito` and `visuais-na-conversa`. The Admin receives `criar-agente` and `trocar-dominio`. The rest are in the repository (`/opt/dgclaw/app/skills/`), but neither the installer nor agent creation connects them to anyone.

| Skill | Who has it | What it does |
| --- | --- | --- |
| `agenda` | agents | Schedules, lists and cancels the agent's own appointments on the machine using system timers. See [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `aprender` | agents | Saves a repeated process as an agent skill and improves it when the owner corrects it |
| `avatar` | agents | Generates or changes the agent's picture in the panel |
| `avisos` | agents | Posts to and reads the noticeboard between agents |
| `foco` | agents | Builds the focus-mode list |
| `gemini-gratuito` | agents | Connects the free Gemini key and enables video analysis |
| `groq-audio` | agents | Connects the free Groq key for audio speech and transcription |
| `lembretes` | agents | Schedules reminders that persist until the owner confirms |
| `memory` | agents | Searches past conversations and memory, and manages memory. See [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `report` | agents | Builds an error report for the author without personal data |
| `site-animado` | agents | Creates animated single-page websites in one `.html` file |
| `slide-animado` | agents | Creates animated presentations in one `.html` file, with PDF export |
| `video-animado` | agents | Creates short MP4 videos (5 to 15 seconds) from an HTML composition |
| `visuais-na-conversa` | agents | Responds with a visual (the whiteboard) instead of a long block of text |
| `criar-agente` | Admin | Guides creation of a new agent, one question at a time, through the real test |
| `trocar-dominio` | Admin | Changes the panel address to the owner's domain. See [personalizar.md](personalizar.md) |
| `canais` | in the repository | Guides Telegram and WhatsApp connection. See [canais.md](canais.md) |
| `cards` | in the repository | Opens a card in another provider (such as Codex) and reads its response |
| `mesa` | in the repository | Explains how the task Desk works to the agent |
| `tela` | in the repository | Explains how to use Screen and when to call the owner |
| `socorro` | in the repository | Help procedure for a nontechnical owner: investigate, explain, propose and check |
| `lista-rapida` | in the repository | Summarizes requests into a short grouped list with the whiteboard |
| `doctor` | in the repository | Diagnoses and fixes an assistant that will not start. Belongs to the old plugin (see note below) |
| `connect` | in the repository | Connects Drive, Gmail and Calendar through Claude connectors. See [canais.md](canais.md) |
| `importar` | in the repository | Receives an agent that ran on the person's computer (DG Claw Lite). Belongs to the old plugin |
| `panel` | in the repository | Starts and explains the panel in local and server modes. Belongs to the old plugin |
| `service` | in the repository | Starts, stops and displays logs for the assistant service. Belongs to the old plugin |
| `uninstall` | in the repository | Takes an assistant offline with a dated backup. Belongs to the old plugin |
| `instagram` | in the repository | Manages the agent's Instagram (`instagram` power, below) |
| `powers` | in the repository | Lists, installs and disables powers |

**Note on old-plugin skills.** `doctor`, `importar`, `panel`, `service`, `uninstall` and `powers` were written for a single-agent assistant installed without containers, and call scripts and services used by that model. In DG Claw v1, the equivalent comes from the Admin and `dgclaw` CLI. Check each one before offering it to someone.

**If a skill does not work.** Tell the Admin what failed and ask for `dgclaw agente reparar <slug>`. A skill sharing a name with a native command loses to it in the command bar.

## Powers {#poderes-powers}

A power is a work capability enabled for an agent. The source of truth is `.dgclaw/powers.json` in the agent's home: the panel and routines read it. `core` (memory, personality and operation) is always enabled.

| Power | Status | What it does |
| --- | --- | --- |
| `instagram` | Partial | Publishes photos and reels and replies to comments, with visual review and protection against instructions hidden in comments. Enables `aba:posts` and `aba:followers`. Requires a token and Instagram Business account. Creates posting timers (8 a.m., 1 p.m. and 7 p.m.) and comment timers |
| `meetings` | In development | Would join meetings through Recall.ai. Locked. See [em-desenvolvimento.md](em-desenvolvimento.md) |
| `crm` | In development | Would connect the agent to the owner's CRM and WhatsApp. Locked. See [em-desenvolvimento.md](em-desenvolvimento.md) |
| `secretary` | In development | Would triage email and provide calendar briefings. Locked. For Gmail and Calendar reading today, use connectors (see [canais.md](canais.md)) |

**`instagram`: how to ask and limits.** Ask the agent or Admin to "enable Instagram". Installation uses `scripts/powers.py` and `scripts/install-ig-timers.sh`, and posting and comment routines run Claude in non-terminal mode, which Codex does not yet have. Only timer creation has an automated test; there is no full-flow test in a containerized agent. That is why the status is Partial: check the flow end to end on your server before relying on it. Disabling a power preserves data (posts, followers and token), and the tabs lock again. The meetings route responds "423 power not installed" while `meetings` is disabled.
