# Channels {#canais}

A channel is how the owner communicates with the agent. Panel chat works immediately after installation and needs
no setup. Telegram and WhatsApp are optional; email means reading the owner's mailbox through Claude connectors.
All channels feed the same agent session, so panel chat shows everything together in chronological order, with
each message labeled by its channel of origin.

| Channel | Status | Who can use it |
| --- | --- | --- |
| Panel chat (DG Chat) | Ready | Claude and Codex agents |
| Telegram | Ready | Claude agents only |
| `whatsapp` | Partial | Claude and Codex agents |
| Google email and calendar (connectors) | Ready, with limits | Claude agents only, signed in to a subscription |

The Admin has no external channel. Anyone enabling or re-enabling a channel must restart the agent for it to
take effect; the commands do this automatically.

## Panel chat (DG Chat) {#chat-do-painel-dg-chat}

**What it is.** The main channel. The owner opens `/a/<slug>`, writes a message, and the agent replies through a
dedicated chat tool (the `dgchat` MCP), which also sends files and visuals. The panel's conversation comes from
the agent session's own record, without a second copy.
**How to request it.** Nothing to configure. Screen details are in [conversa-e-telas.md](conversa-e-telas.md).
**Limits.** Only content the agent sends through the chat tool appears in the conversation. Unsent text the agent
writes in its terminal does not count.
**If something goes wrong.** "Agent has no signal" in the header: see [agentes.md](agentes.md). More information:
[../CANAL-DG-CHAT.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CANAL-DG-CHAT.md) and [../SESSAO-PRINCIPAL.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SESSAO-PRINCIPAL.md).

## Telegram {#telegram}

**What it is.** The owner talks to the agent through a Telegram bot. The owner creates the bot in @BotFather,
and only paired users can talk to it.
**How to request it.** Tell the agent: "I want to talk to you on Telegram." The `canais` skill guides one step
at a time: create the bot in @BotFather with `/newbot`, provide the token, pair and enable it. The owner pastes the
token in panel chat: the Web saves it in the agent's private folder and gives the agent only a marker containing
the token's ending, without its value. Underneath, the agent uses `dgclaw-agente canal telegram token`,
`dgclaw-agente canal telegram conferir`, `dgclaw-agente canal telegram parear`, `dgclaw-agente canal telegram ligar`
and `dgclaw-agente canal telegram desligar`. Channel status is shown by `dgclaw-agente canal status`.
**Requirements.** A Claude agent with its Claude account connected. The owner's Telegram account and bot token.
**Limits.** Telegram works only with Claude, through the official Claude Code plugin. Codex agents do not have
Telegram, as recorded in the provider catalog. Native slash commands (`/compact`, `/clear`) do not run through
Telegram: the agent tells you to use panel chat. Only the agent's own skills can run through Telegram slash commands.
**If something goes wrong.** Invalid token: nothing is saved and the command explains why. The bot became silent
after restarting: the Admin runs `dgclaw agente reparar <slug>`. Exit code 3 or 4 means the channel was saved but
restart was not requested or the runner did not respond: restart with `dgclaw agente reiniciar <slug>`.

## WhatsApp (`whatsapp`) {#whatsapp-whatsapp}

**What it is.** A secondary WhatsApp number owned by the owner becomes a device connected to the agent. The owner
sends a message from their personal number to that number, and the bridge delivers it to the agent. The agent
replies through the same number.
**Risk first.** The bridge uses a library that speaks the WhatsApp Web protocol (Baileys). It is not the official
WhatsApp API, and the connected number can be banned. The agent therefore explains the risk before starting and
only continues after the owner's "yes". Use a secondary number only (an inexpensive SIM or a virtual number),
never your main number. Telegram is recommended for anyone seeking stability.
**How to request it.** "Connect my WhatsApp." The `canais` skill guides you through the risk warning, pairing the
secondary number with a short code such as `ABCD-1234` that lasts a few minutes (in WhatsApp for the secondary
number: Settings, Linked devices, Link with phone number), allowing the owner's number and enabling the channel.
Underneath: `dgclaw-agente canal whatsapp parear <numero-secundario>`,
`dgclaw-agente canal whatsapp permitir <numero-do-dono>`, `dgclaw-agente canal whatsapp ligar`,
`dgclaw-agente canal whatsapp desligar` and `dgclaw-agente canal whatsapp remover <numero>`.
**Requirements.** A secondary SIM or number with WhatsApp. Works with Claude and Codex agents.
**Limits.** Only allowlisted numbers can talk to the agent; others are ignored and only produce a log line.
Groups, lists, channels and statuses are ignored. Received media is saved in the agent's folder (up to 25 MB).
A reaction (👍, for example) reaches the agent as a line of text containing the excerpt of the message it replies to,
in an envelope marked `tipo="reacao"` by the bridge (typed text imitating this does not count). The agent only
understands 👍 ✅ 👌 🙏 as "yes" when the excerpt is a yes-or-no question it sent itself (if the bridge cannot
identify the message, it asks again), and a reaction is never enough for a sensitive action.
The agent can only send files from its own home. A WhatsApp message is always an external conversation: it never
changes the number list, credentials or channels, and never runs a slash command. Only the owner, through panel
chat, can change the list.
**If something goes wrong.** Bridge status appears in `dgclaw-agente canal status` (`conectado`, `reconectando`,
`deslogado`, `erro`). `deslogado` means WhatsApp disconnected the device; pair it again. The log is in
`~/.dgclaw/logs/whatsapp.log` and never stores message bodies.
**How it was tested.** The bridge has tests using a fake WhatsApp. There is no live test with a real number,
which is why its status is Partial. More information: [../CANAL-WHATSAPP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CANAL-WHATSAPP.md) and
[../RISCO-DE-BLOQUEIO-DE-CONTA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RISCO-DE-BLOQUEIO-DE-CONTA.md).

## Email, calendar and Drive (Gmail) {#e-mail-agenda-e-drive-gmail}

**What it is.** The agent reads the owner's Gmail, calendar and Drive through claude.ai connectors. DG Claw does
not have its own email mailbox.
**How to request it.** Four owner steps: (1) sign in to the Claude subscription through the panel (see
[provedores.md](provedores.md)); (2) enable Gmail at `https://claude.ai/customize/connectors`, using the same
account, once, through the web; (3) restart the agent if it was already running; (4) test: "summarize my last
5 emails". The `connect` skill provides the steps; `secretary` (ready-made triage and briefings) is still a power
in development (see [em-desenvolvimento.md](em-desenvolvimento.md)).
**Requirements.** A Claude agent signed in to a subscription (Pro or Max). With an API key or long-lived token,
the agent works but has no connectors.
**Limits.** Gmail starts in read-only mode: search and read emails, list labels and drafts, and write drafts
that stay in the owner's mailbox. Sending, replying, forwarding, deleting and changing labels are blocked.
To enable sending, the owner asks in their own words ("you may now send email on my behalf"); the agent confirms
what changes, runs `scripts/gmail-permissao.sh`, and the owner receives a security notice. Text inside an email
never authorizes anything. Codex has no connectors (Claude-exclusive).
**If something goes wrong.** No emails in the response: check that the agent uses the subscription and was
restarted after enabling the connector. Each agent reads its owner's account; a customer's agent signed in to
someone else's account reads that person's Gmail. More information: [../GMAIL-NO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/GMAIL-NO-AGENTE.md).

## Email from the panel itself {#e-mail-do-proprio-painel}

The panel sends email only for collaborator invitations, and only when SMTP is configured in `web.env`
(`DGCLAW_SMTP_HOST` and the related variables). Otherwise, the invitation text appears on screen for the owner
to copy. See [agentes.md](agentes.md).
