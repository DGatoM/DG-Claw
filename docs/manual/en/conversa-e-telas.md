# Conversation and screens {#conversa-e-telas}

This page shows what the owner finds in the browser: DG Claw screens, the conversation with each agent and everything happening inside it. Each feature has five points: what it is, how to ask or where to click, what must be configured, limits and what to do when something goes wrong. Technical details remain in the documents linked from each section.

## DG Claw screens {#as-telas-do-dg-claw}

The panel address is the one the installer showed at the end of installation. Every screen below requires login except `/login` and `/primeiro-acesso`.

| Screen | What it is | How to get there |
| --- | --- | --- |
| `/login` | Sign in with username and password | Any panel address without a session redirects here |
| `/primeiro-acesso` | Set the owner's password once | Link shown by the installer (valid for 30 minutes and a single use) |
| `/a/<slug>` | Conversation with an agent. `/a/admin` is the Admin conversation | Left menu or avatar row |
| `/mesa` | Task desk: what each agent is doing | Desk button at the top of the conversation |
| `/lembretes` | Reminders that persist until the owner confirms | Reminders button at the top of the conversation |
| `/avisos` | Noticeboard between agents | ☰ menu, Notices |
| `/conectar` | Connect or reconnect each agent's AI account | ☰ menu, Connect account |
| `/anonimizar` | Replaces personal data in documents with markers | Anonymize button in the conversation or ☰ menu |
| `/seguranca` | Security patrol, bulletins and emergency button | ☰ menu, Security. See [seguranca.md](seguranca.md) |
| `/logs` | History of what each agent did (messages, commands, files), read-only and owner-only | Admin's ☰ menu, Logs. See [LOGS.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/LOGS.md) |
| `/manual` | This documentation inside the panel | ☰ menu, Manual |
| `/colaboradores` | Invite someone else to talk to an agent | ☰ menu, Invite collaborator. See [agentes.md](agentes.md) |
| `/trocar-senha` | Collaborator changes the temporary password | Collaborator arrives here on first access |

Each agent's panel is at `/p/<slug>/`, with the tabs in the [Agent panel](#painel-do-agente) table.

Every screen has a **Tutorial** button beside its title. It gives a guided tour: dims the rest of the screen and explains, part by part, what each thing is, how it works and why it is there. Sections with a `?` have a tour of their own. The tour is the quickest way to learn a new screen.

## Signing in to the panel {#entrar-no-painel}

**What it is.** DG Claw's single entrance. The installer shows the address, username and first-access link.
**How to use it.** Open the `/primeiro-acesso` link, set a password (at least 12 characters), then sign in through `/login` from then on.
**Requires.** Nothing beyond the panel address.
**Limits.** Consecutive password errors temporarily block attempts, and the screen says how many seconds remain. The first-access link is valid once and for 30 minutes.
**If something goes wrong.** Expired or lost link: on the server, `sudo dgclaw primeiro-acesso` generates another and invalidates the old one. Forgotten password: the Admin or terminal can change it with `dgclaw senha trocar`. More in [atualizar-e-backup.md](atualizar-e-backup.md) and [referencia-admin.md](referencia-admin.md).

## The conversation {#a-conversa}

**What it is.** Browser chat, each agent's main channel. Telegram and WhatsApp are optional (see [canais.md](canais.md)) and feed into the same conversation.
**How to use it.** Open `/a/<slug>`, write and send. The response appears when the agent sends it. The header shows "agent has no signal" when its service does not respond. Header buttons (Desk, Sessions, Reminders, unread and others) show only their icons; their names appear on hover or in a screen reader. The Voice button (speaker) groups reading responses aloud and continuous conversation: tapping it opens a box with both controls, each showing whether it is on or off, and the button is highlighted whenever either is on. On mobile, the row of agent avatars scrolls sideways, with a shadow on the edge where more agents remain, and the current agent always stays visible.
**Requires.** A created agent with its AI account connected (see [provedores.md](provedores.md)).
**Limits.** The conversation shows what the agent sends through chat. An agent working silently looks idle, so it should announce when it begins something lengthy.
**If something goes wrong.** "Agent has no signal": ask the Admin for `dgclaw agente reparar <slug>` (see [agentes.md](agentes.md)). Login request: the conversation opens the account sign-in card described in [Connect account](#conectar-conta).
More in [../CONVERSA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CONVERSA.md).

### First agent {#primeiro-agente}

**What it is.** The first time, **I want to create my first agent** opens a conversation with the Admin. A form collects name, role, tone, owner name and an optional photo. The Admin creates the agent, and the screen follows each real stage: request received, creation, account connection, test.
**Limits.** The final introduction appears only after the agent actually responds to the test.
**If something goes wrong.** The screen shows the failed stage and the Admin resumes the same request. Walkthrough in [../../web/docs/PRIMEIRO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/PRIMEIRO-AGENTE.md).

### Switching agents, unread messages and badges {#trocar-de-agente-nao-lidas-e-selos}

**What it is.** The left menu and avatar row show who is working (three dots), who has finished and you have not read it (red dot), and who needs you (amber circle with "!"). The **unread** button marks the current conversation as unread.
**Requires.** Nothing. Your phone receives "needs you" and "finished" notifications if [device notifications](#avisos-no-aparelho) are enabled.
**Limits.** When the agent's service does not respond, the badge has no state: it never incorrectly shows "idle".
More in [../../web/docs/ESTADO-DOS-AGENTES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ESTADO-DOS-AGENTES.md).

### Permission requests and agent questions {#pedidos-de-permissao-e-perguntas-do-agente}

**What it is.** When the agent needs permission or wants the owner to choose among options, a card appears in the conversation. The agent waits until the owner decides.
**Limits.** This depends on the engine: it works on Claude; permission requests and multiple-choice questions do not yet work on Codex (see [provedores.md](provedores.md)).
**If something goes wrong.** A card does not appear: the menu's "needs you" badge shows the agent is waiting. More in [../../web/docs/TRILHA-E-PERMISSAO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/TRILHA-E-PERMISSAO.md).

### Stop the agent {#parar-o-agente}

**What it is.** While the agent is working, the "is working" banner gains a **Stop** button. It sends Esc, just like pressing Esc in the terminal: if a turn was in progress, it usually stops within moments (a running command may continue executing, and on Codex this applies even to foreground work; check before changing the same files), without restarting the agent or losing the conversation. It does not ask for confirmation.
**Requires.** Being the owner. Collaborators do not have the button.
**Limits.** A command the agent left running in the background may continue. Stop does not apply while the agent waits for permission or a question: answer on the card. Wait 3 seconds between taps because two consecutive Esc presses lock the session. Works on Claude and Codex.
**If something goes wrong.** The screen explains why. If it says the agent has no open session, there is nothing to stop. If it says the agent service is old, ask the Admin to update it. More in [../../web/docs/PARAR.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/PARAR.md).

### Media, links and files (Shared) {#midias-links-e-arquivos-compartilhados}

**What it is.** Tapping the agent's photo or name opens a list of everything exchanged in the conversation, organized into media, links and files tabs.
**Limits.** Loads 20 items per page; thumbnails are generated on the server with `ffmpeg`, prepared by the installer. The list is stored on the device for up to 30 days.
**If something goes wrong.** A missing thumbnail shows an icon and the cause. More in [../../web/docs/MIDIAS-CACHE.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MIDIAS-CACHE.md).

## Attachments {#anexos}

**What it is.** The paperclip 📎 sends photos, videos, audio and PDFs, several at once. Files arrive in the agent's folder and their paths appear in the message text.
**Limits.** Up to 10 attachments per message. The entire upload is capped at 50 MB (`DGCLAW_WEB_MAX_UPLOAD_MB` in `web.env`). A message with an attachment never becomes a slash command.
**If something goes wrong.** The screen shows the uploaded size and limit. File too large: split it into two messages.

## Voice: speak and listen {#voz-falar-e-ouvir}

**What it is.** 🎤 records audio that the panel transcribes and sends to the agent as text. The voice button (speaker) in the header opens two controls: "Read responses aloud", which makes the agent speak its responses, and "Continuous conversation", which starts recording again after each response.
**Requires.** A key in `web.env`. Transcription accepts `GROQ_API_KEY` (free), `ELEVENLABS_API_KEY` or `OPENAI_API_KEY`, in this preference order: ElevenLabs, Groq, OpenAI. For the agent to speak, only `ELEVENLABS_API_KEY`, plus a voice selected for the agent. The agent has the `groq-audio` skill, guiding the owner to connect Groq ("I want to speak by audio").
**Limits.** The response is read in chunks (the first up to 450 characters, later ones up to 1200, at most 40 chunks). Tables, code and links are not spoken. Transcribed audio reaches the agent marked `[áudio transcrito]`, and it knows the transcription may contain errors.
**If something goes wrong.** Without a key, the screen hides the buttons and the route responds with the reason ("missing GROQ_API_KEY..."). Ask the Admin: "Connect Groq so I can speak by audio."
More in [../CONVERSA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CONVERSA.md).

## Slash commands {#comandos-de-barra}

**What it is.** A message starting with `/` is a command for the agent's engine. Typing `/` at the start of the field opens the list of available commands: native commands working in DG Claw mode and the agent's skills.
**Examples.** `/compact` summarizes the conversation and frees context, `/clear` starts a clean conversation, `/context` shows how much session memory is occupied, `/model sonnet` changes the model, and `/agenda me lembra amanhã às 9h` runs the `agenda` skill.
**Limits.** Commands opening terminal menus or screens (`/config`, `/memory`, `/resume` and similar) appear grayed out with the reason and are refused. To send a message starting with a slash as ordinary text, use two slashes (`//texto`). Native commands do not run on Telegram; on WhatsApp a slash is always text.
**If something goes wrong.** Unknown commands return suggestions for similar names; unavailable commands return the reason and what to do.
More in [../../web/docs/COMANDOS-DE-BARRA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COMANDOS-DE-BARRA.md).

## Visuals in conversation (the whiteboard) {#visuais-na-conversa-a-lousa}

**What it is.** The agent responds with a visual inside the bubble: animated numbers, comparisons, timelines, step-by-step instructions, simple charts and choice buttons. This is the whiteboard. The `visuais-na-conversa` skill teaches the agent to use it.
**How to ask.** "Explain this on the whiteboard" or "send the overview on the whiteboard". Responses with structure, numbers or comparisons go to the whiteboard without asking.
**Limits.** Each visual is a `vis-<assunto>.html` file up to 2 MB, without internet. A visual's button only asks the agent something after the owner taps Send in the confirmation bar (up to 500 characters). Text to copy comes in a box with a **Copy** button.
**If something goes wrong.** Empty visual or error banner: ask the agent to send it again under another name.
More in [../VISUAIS.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/VISUAIS.md) and examples in [../VISUAIS-EXEMPLOS](https://github.com/DGatoM/DG-Claw/blob/main/docs/VISUAIS-EXEMPLOS).

## Password field in conversation (vault) {#campo-de-senha-na-conversa-cofre}

**What it is.** When the agent needs a key, the conversation shows a card with a password field and **Save to vault**. The value goes straight to the agent's vault without passing through the conversation, history or model.
**Limits.** Saving restarts the agent so the key takes effect; the conversation resumes where it stopped. Only the owner uses this card.
**If something goes wrong.** More in [../COFRE-NA-CONVERSA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/COFRE-NA-CONVERSA.md) and [agentes.md](agentes.md).

## Hidden mode (the eye 👁) {#modo-escondido-o-olhinho}

**What it is.** 👁 replaces names, monetary amounts, emails, phone numbers, CPF, CNPJ and keys in all on-screen messages with asterisks. It lets you show the panel in a class without exposing clients. Tapping hidden text reveals only that message.
**Requires.** The automatic filter (email, amounts, CPF and similar) works without anything else. To also hide people and company names, `web.env` needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Ask the Admin: "Turn on full hidden mode."
**Limits.** Until a message has been analyzed, it stays covered ("hiding..."). If analysis fails, it remains covered with an explanation. Photos and videos in hidden messages are blurred. Collaborators do not have the eye.
More in [../MODO-ESCONDIDO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-ESCONDIDO.md).

## Anonymize documents {#anonimizar-documentos}

**What it is.** When enabled for an agent, documents sent through the paperclip arrive without personal data, replaced by markers such as `[PESSOA_1]` and `[CPF_1]`. The owner reads everything in full: **View with real data** shows original text on their screen, and **Download final version** returns the file with real data instead of markers.
**How to enable it.** Open `/anonimizar`, choose the agent and enable it. The full name detector is installed from the same screen with a button.
**Limits.** Only applies to the browser conversation's paperclip, not anything arriving through WhatsApp, Telegram or email. No detector finds 100% of names: for very sensitive documents, check with **View table**. Scanned PDFs are refused. Final versions can only be returned for `.docx`, `.xlsx`, `.pptx`, `.md`, `.txt`, `.csv` and `.json`. The table is encrypted on the server, with the key in `/etc/dgclaw/anonimizar.chave`: keep this key with your backup, because real data cannot be restored without it.
**If something goes wrong.** More in [../ANONIMIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ANONIMIZAR.md) and [../../web/docs/ANONIMIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ANONIMIZAR.md).

## Reminders {#lembretes}

**What it is.** A persistent reminder. The agent schedules it for the owner ("remind me tomorrow at 9 a.m. to call the accountant") and, at the scheduled time, it rings again every few minutes until the owner taps **Done** or **Snooze**. It appears in three places simultaneously: a ⏰ banner at the top of any conversation, a device notification and a note to the agent (which notifies through Telegram or WhatsApp if configured).
**How to ask.** Tell the agent what and when in conversation. The `lembretes` skill handles the rest. The list is at `/lembretes`.
**Requires.** Nothing beyond Web running. For notifications with the screen closed, enable [device notifications](#avisos-no-aparelho).
**Limits.** Repeats every 5 minutes by default, at most 12 times (the cap can be raised to 60). Does not depend on an open agent session: Web triggers it independently and resumes automatically after a restart. Uses the server timezone (`DGCLAW_WEB_TZ` changes it).
**If something goes wrong.** A reminder that missed its time appears as missed in the list. More in [../../web/docs/LEMBRETES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/LEMBRETES.md). For the agent's own appointments rather than the owner's, see [memoria-e-rotinas.md](memoria-e-rotinas.md).

## Device notifications {#avisos-no-aparelho}

**What it is.** Phone and computer notifications, even with the screen closed, for reminders, Desk, focus mode, "Someone needs you" and "Someone finished".
**How to enable them.** Tap **Enable notifications on this device** in the sidebar or reminders screen. Enable once per device. The two agent notification types can be disabled separately.
**Requires.** On Android and computers, an ordinary browser (Chrome, Edge, Firefox). On iPhone, DG Claw must be installed on the home screen (iOS 16.4 or newer); when Safari opens it as a website, the button explains this.
**Limits.** Do not delete the key pair stored in `push/vapid.json`: a new pair invalidates all devices, and each needs to enable notifications again.
**If something goes wrong.** **Send test** shows whether the push service refused and why. More in [../../web/docs/AVISOS-NO-APARELHO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/AVISOS-NO-APARELHO.md).

## Focus mode {#modo-foco}

**What it is.** A short list of what the owner wants to finish now, beside the conversation. The agent builds the list and the owner checks items on screen. With the next message, the agent learns which items were checked.
**How to ask.** "Set up my focus for today." The `foco` skill handles the rest.
**Limits.** Up to 50 items per list, each up to 300 characters. Each agent has its own list. On mobile the list becomes a collapsed banner at the top of the conversation.
**If something goes wrong.** If saving a check fails, the item returns to its previous state and the screen explains why. More in [../../web/docs/MODO-FOCO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MODO-FOCO.md).

## Delivery and request alerts {#alertas-de-entrega-e-de-pedido}

**What it is.** The agent starts a response with `[ENTREGA]` when something important is ready, or `[PEDIDO]` when it has stopped waiting for a decision. The screen colors the bubble and puts an icon (✅ or ⚠️) in the stack on the right. Tapping the icon goes to the message and removes it.
**Limits.** Acknowledging a request does not authorize it: the answer is given in conversation. There is no expiry or management screen. Works for both engines and responses through DG Chat, Telegram and WhatsApp.
More in [../../web/docs/ALERTAS.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ALERTAS.md).

## Subscription usage {#uso-da-assinatura}

**What it is.** Shows how much of each agent subscription's 5-hour and weekly windows has been used. It appears in the agent panel's Status and ☰ menu, Subscription usage. Colors are green below 70%, amber from 70% to 89% and red from 90%.
**How the agent uses it.** Before a heavy task it checks its own usage. Above 90% in the 5-hour window, it warns the owner.
**Limits.** The number comes from Claude Code itself (status line) or Codex (conversation file), with each response. Before the first response, the field is empty, meaning "not yet measured", never zero. An agent paying by API key has no window.
More in [../../web/docs/USO-DA-ASSINATURA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/USO-DA-ASSINATURA.md).

## Connect account {#conectar-conta}

**What it is.** `/conectar` and the conversation's "sign in to account" card connect or reconnect each agent's AI account. There is one card per agent, Admin first. When an agent is not signed in, the panel automatically opens "Sign in to your agents".
**How to use it.** Tap **Generate login link**, open the page, sign in with the account and paste the code back. Codex has no code to paste back: the page shows a code to enter in the browser.
**Limits.** One login at a time. The link lasts a few minutes and is only generated when you tap the button.
**If something goes wrong.** See [provedores.md](provedores.md) and [../../web/docs/CONECTAR-CONTA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/CONECTAR-CONTA.md).

## Task desk and Noticeboard {#mesa-de-tarefas-e-quadro-de-avisos}

These two screens are agent tools, explained in [agentes.md](agentes.md). The Desk is at `/mesa` and the board at `/avisos`.

## Agent panel {#painel-do-agente}

Each agent has a panel at `/p/<slug>/` with tabs. Invited collaborators see tabs read-only and never change the vault, API keys, AI account, channels or Screen (see [agentes.md](agentes.md)).

| Tab | Purpose | More |
| --- | --- | --- |
| `aba:conversa` | Conversation inside the panel, the same as `/a/<slug>` | [../CONVERSA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CONVERSA.md) |
| `aba:status` | Home page: monthly numbers, model and payment method, working memory, routines | [../../panel/docs/PROVEDOR-NA-TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PROVEDOR-NA-TELA.md) |
| `aba:memory` | Agent memory files, to read and correct | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `aba:operations` | System routines with recent execution history and the live session | [../../panel/docs/OPERACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/OPERACOES.md) |
| `aba:sessoes` | Agent's parallel sessions (cards) | [agentes.md](agentes.md) |
| `aba:costs` | Monthly cost by category and routine, compared to the defined cap | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `aba:como` | "How the agent works inside" text, with actual numbers alongside | [../RADIOGRAFIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RADIOGRAFIA.md) |
| `aba:identity` | Who the agent is, in editable text files | [agentes.md](agentes.md) |
| `aba:personality` | Numbers controlling its manner and goals | [agentes.md](agentes.md) |
| `aba:apps` | What the agent produced independently, stage by stage | [../../panel/docs/ABA-APPS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/ABA-APPS.md) |
| `aba:skills` | Agent's skills and each one's location | [agentes.md](agentes.md) |
| `aba:integracoes` | Map of the external systems the agent is connected to, with colors showing actual use of each one | [../../panel/docs/INTEGRACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/INTEGRACOES.md) |
| `aba:rotinas` | Appointments the agent scheduled at the owner's request | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `aba:arquivos` | Agent's folder (Folder tab): view, download and upload files | [../../panel/docs/PASTA-E-ASSETS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PASTA-E-ASSETS.md) |
| `aba:tela` | Agent's browser, where the owner signs in | [agentes.md](agentes.md) |
| `aba:socorro` | On-call assistant when the agent stops or responds strangely | [agentes.md](agentes.md) |
| `aba:cofre` | Agent service keys and panel API keys | [agentes.md](agentes.md) |
| `aba:posts` | Instagram publications. Only with `instagram` enabled | [agentes.md](agentes.md) |
| `aba:followers` | Instagram followers and comments. Only with `instagram` enabled | [agentes.md](agentes.md) |
| `aba:reunioes` | Attended meetings. In development, stays locked | [em-desenvolvimento.md](em-desenvolvimento.md) |

## The manual inside the panel {#o-manual-dentro-do-painel}

**What it is.** This documentation, opened in the browser at `/manual` (☰ menu, **Manual**). Search filters the page list by title. Agents read the same content through `GET /api/v1/manual/docs.md`, without credentials, through the mailbox (`dgclaw-api`).
**Limits.** The screen only reads: nothing writes to the manual. Links to documents outside `docs/manual/` appear as paths without clickable links. Invited collaborators cannot open the manual screen.
**If something goes wrong.** "Manual missing": the installation lacks `docs/manual/`, and updating DG Claw is the solution. More in [../../web/docs/MANUAL.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MANUAL.md).
