# Providers {#provedores}

A provider is the AI engine behind an agent. DG Claw uses two unmodified official programs: `claude` (Anthropic's
Claude Code) and `codex` (OpenAI's Codex CLI). Each agent selects one of them and a payment method. The
`providers/catalogo.json` file is the single list read by the panel, scripts and Admin.

| Provider | Status | Description |
| --- | --- | --- |
| `claude` | Ready | Claude Code. Claude Opus 5.5, Claude Sonnet 5.5 and Claude Haiku 5.5 models (aliases `opus`, `sonnet` and `haiku`). Opus is the default |
| `codex` | Partial | Codex CLI. Models come from Codex's own list, which changes every week. Some Claude features are missing (see the table below) |
| `gemini` | In development | Gemini CLI. It is in the catalog but marked unavailable; the switching dialog shows it disabled with the reason. See [em-desenvolvimento.md](em-desenvolvimento.md) |

Do not confuse the `gemini` provider with the `gemini-gratuito` skill: the skill only connects a free Google AI
Studio key for video analysis, and works with any engine.

## Choose and change the engine and payment method {#escolher-e-trocar-o-motor-e-a-forma-de-pagar}

**What it is.** Each agent has a provider, model and payment method, shown in the "Model and authentication" card
at the top of the panel's `aba:status` tab (for example, "Claude Opus 5.5, on subscription").
**How to request it.** During creation, the Admin uses `--provedor` and `--auth`. Afterwards, the owner selects
**Change** on the card and chooses the provider, model and payment method, or asks the Admin. Switching closes
the current conversation and starts a new one, with the agent's memory intact.
**Payment methods.**

| Method | Available for | How it works |
| --- | --- | --- |
| Subscription | `claude` (Pro or Max plan) and `codex` (ChatGPT Plus, Pro and similar plans) | Fixed monthly price, within plan limits. The agent signs in to the account once through assisted login |
| Subscription without connectors | `claude` only | The same plan, through a long-lived access token (`CLAUDE_CODE_OAUTH_TOKEN`, generated with `claude setup-token`). Suitable for agents without Gmail, Calendar or Drive |
| API | `claude` (`ANTHROPIC_API_KEY`) and `codex` (`OPENAI_API_KEY`) | Pay for actual token usage directly through the developer account. The key stays in the agent's vault |

**Login.** Assisted login is available at `/conectar` and in the chat's "sign in to account" card (see
[conversa-e-telas.md](conversa-e-telas.md)): the owner selects **Generate login link**, signs in, and, for Claude,
pastes back the code shown on the page; for Codex, enters a code in the browser. DG Claw never reads, copies or
stores one agent's login file for another agent.
**API key.** When switching to API access, the dialog asks for a key if the vault does not have one. The panel
checks its format (Anthropic keys start with `sk-ant-`; OpenAI keys with `sk-`), saves it in the vault and restarts
the agent. The key never goes into a log or appears in any response.
**Requirements.** An account with the selected provider. Each person uses their own account.
**Limits.** The card turns yellow when the selected configuration differs from what the program confirms
(for example, "configured for API, but the key is not in the Vault" or "the agent is not signed in to the
subscription"); the text explains what to do.
**If something goes wrong.** Follow the card's instructions. If the agent has no signal, the Admin runs
`dgclaw agente reparar <slug>`. More information:
[../../panel/docs/PROVEDOR-NA-TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PROVEDOR-NA-TELA.md),
[../PROVEDORES.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PROVEDORES.md) and [../../web/docs/CONECTAR-CONTA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/CONECTAR-CONTA.md).

## Differences between Claude and Codex {#o-que-muda-entre-claude-e-codex}

The project's goal is for Codex agents to have everything Claude agents have, except Anthropic-exclusive products.
The official record, updated with each change, is [../PARIDADE-CODEX.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PARIDADE-CODEX.md). Below is a summary
of the 6 November 2026 assessment, provided as a reference and not repeated by me:

| Feature | Claude | Codex |
| --- | --- | --- |
| Chat, attachments, visuals, voice, Board, reminders, vault, cards, monitor mode, security scan | Works | Works |
| WhatsApp | Works | Works (not tested live) |
| Telegram | Works | Unavailable: Claude-exclusive |
| Gmail, Calendar and Drive (connectors) | Works with subscription | Unavailable: Claude-exclusive |
| Permission requests and multiple-choice questions in chat | Works | Does not work: the runner reports that the provider does not expose this; use the agent's terminal |
| Compaction notice in chat | Works | Does not work |
| Memory search on every message, startup context, automatic compaction, health and safe mode | Works | Not yet working |
| Per-message costs (`aba:costs` tab) | Works | Does not work |
| Terminal-free routines (reflection, Instagram posts and comments) | Works | Does not work |
| Subagents, web search, notice board, DG Claw skills | Works | Partial |
| `/dgclaw:*` commands | Works | Unavailable: Claude plugin namespace |
| Subscription usage meter | Works | Works |

In practice, a Codex agent can chat, work, use the Board and cards, and receive WhatsApp messages. Anyone who needs
Telegram, Gmail or permission requests in chat should use Claude.

## Risk of account suspension {#risco-de-bloqueio-da-conta}

The full analysis, citing Anthropic's and OpenAI's rules, is in
[../RISCO-DE-BLOQUEIO-DE-CONTA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RISCO-DE-BLOQUEIO-DE-CONTA.md). The conclusions of the 12 October 2026 research,
which must be reviewed when terms change, are:

- Running the unmodified official program on your own VPS, signed in to the account of the person using it,
  is not prohibited by either company's written rules. We found no reliable report of suspension for this reason.
- The remaining risk is volume: many simultaneous sessions running around the clock hit plan limits sooner and
  differ from the usual individual usage those limits assume. For continuous, heavy work, an API key is recommended.
- An agent serving another person should use that person's credentials (their subscription or API key).
  Serving customers on your subscription is the prohibited situation in the document's table. A customer trial
  only makes sense for a short period with an end date.
- What caused account suspensions in 2026 was extracting subscription login from Claude Code to use in another
  program. DG Claw does not do that.
- WhatsApp has a separate risk: the number can be banned (see [canais.md](canais.md)).

## Subscription usage {#uso-da-assinatura}

The percentage used in the 5-hour and weekly windows appears in the panel's Status tab and under ☰,
Subscription usage. See [conversa-e-telas.md](conversa-e-telas.md).
