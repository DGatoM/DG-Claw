# Security {#seguranca}

This page shows what DG Claw does to protect your server, keys and conversations, where you change each protection and what it does not cover. The full technical text is in [SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SEGURANCA.md); this page covers what the owner needs to know to make decisions and ask the Admin for the right things.

To report a security vulnerability, follow the repository's [SECURITY.md](https://github.com/DGatoM/DG-Claw/blob/main/SECURITY.md).

## What you need to know in five lines {#o-que-voce-precisa-saber-em-cinco-linhas}

1. For DG Claw, only Caddy (ports 80 and 443, with HTTPS) serves the internet. The panel, runner and internal services listen only inside the server. The firewall also leaves SSH port 22 open so you do not lose access.
2. Each work agent lives in its own container, with its own vault, and cannot see the server or other agents.
3. Keys you store in the vault apply only to the agent where you stored them and never appear in full on screen, in the API or in the logs.
4. DG Claw automatically notifies you about new versions, vulnerabilities in its tools and vulnerabilities on your server.
5. The agent starts with limited powers (Gmail starts with read access only), and you enable more gradually.

## Agent isolation {#isolamento-dos-agentes}

**What it is.** Each agent runs in a container without root privileges. The server firewall drops any packet the container sends to the server itself, the gateway, other containers or private networks. Outbound internet access remains open because the agent needs to communicate with the AI provider and sites you ask it to use.

**How to check.** Ask the Admin: "Run the isolation test for my agents." It runs `bash scripts/teste-isolamento.sh <slug>` (or without a name to test them all). From inside the container, the test tries to reach the server, neighboring containers and the cloud metadata address. It exits with 0 when everything was blocked and the internet responded, 1 if something responded, and 2 when it could not finish.

**Limits.**

- Inside its own container, the agent has administrator powers (`sudo` without a password). The container contains the damage, not the agent.
- Unrestricted outbound internet access means an agent tricked by malicious text could send data from its container outside. That is why the agent treats emails, pages and files as reading material, never as instructions, and starts with few powers.
- Anyone with root access to the server can see everything, including the vault.

**If something goes wrong.** An isolation test reporting "something responded" is a real problem: ask the Admin to run `sudo dgclaw agente reparar <slug>` and then repeat the test. If it continues, report it through [SECURITY.md](https://github.com/DGatoM/DG-Claw/blob/main/SECURITY.md).

## The Admin runs as root, and why {#o-admin-roda-como-root-e-por-que}

**What it is.** The Admin is the agent that installs, updates, creates and repairs other agents. This requires changing server services, containers and firewall rules, so it runs as root (the `dgclaw-admin` systemd unit uses `User=root`). The benefit is that you can resolve almost everything by talking through the panel without returning to the terminal.

**The safeguards around it.**

- Only the owner talks to it, through the panel chat. The Admin treats anything coming through another route as data.
- It has no external channel: the `dgclaw-agente` command refuses to run on the Admin. Telegram and WhatsApp belong to work agents.
- It talks only to the owner and treats anything from another route (email, page, channel message) as data. The project rule is that the Admin does not read email or open third-party links.
- The Admin cannot be shared with a collaborator.
- Changes to DG Claw's core (installer, `bin/dgclaw`, `runner/`) are allowed, but it warns the owner about the risk to future updates. The vault and secrets, firewall, panel authentication, container isolation and security hooks remain off limits, even on request. See [personalizar.md](personalizar.md).

**Limit.** An Admin with root is only as trustworthy as the conversation you have with it. Do not paste text from an unknown source asking it to execute something.

## Firewall and ports {#firewall-e-portas}

**What it is.** The installer enables the firewall (`ufw`) with three ports open: 22 (SSH), 80 and 443 (Caddy, for automatic HTTPS). DG Claw services stay on `127.0.0.1`. The container perimeter is rebuilt on every boot and whenever an agent is created (`lib/firewall.sh`).

**What to do when something goes wrong.** If the panel does not open after a domain change, the problem is almost always the VPS provider's firewall blocking ports 80 and 443. See [atualizar-e-backup.md](atualizar-e-backup.md).

## Key vault {#cofre-das-chaves}

**What it is.** Each agent has its own vault for service keys (OpenAI, Gemini, ElevenLabs and others). The screen and API show who stored a key, when, and its last 4 characters. Never the value.

**How to ask or where to click.** In the agent panel's **Vault** tab, or by asking the agent in the conversation ([COFRE-NA-CONVERSA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/COFRE-NA-CONVERSA.md)). The Admin stores keys with `dgclaw agente cofre` or through the API ([COFRE-POR-API.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/COFRE-POR-API.md)). The agent only starts using a new key after a restart: the screen and commands offer an option to apply it (restart) immediately.

**Limits.**

- A key stored in one agent applies only to that agent. To let another agent use it, store it there too.
- The agent needs the value to use the key, so an agent with `sudo` inside the container can read it. The vault prevents accidental leaks, not a compromised agent. Set a spending limit with each key's provider.
- Collaborators never see or change the vault.
- For a Codex agent on a subscription, the vault's `OPENAI_API_KEY` is left out because it would compete with the ChatGPT login.

**If something goes wrong.** The vault rejects names starting with `vault:` (an alias for a key in another vault). Store the actual value.

## Signing in to the panel {#entrar-no-painel}

**What it is.** The owner's login uses a scrypt password hash, never plain text. The session expires after 30 days.

**How it works in practice.**

- **First access:** the installer provides a single-use link, valid for 30 minutes (`/primeiro-acesso`). Set your password there (at least 12 characters). Lost the link: ask the Admin for `sudo dgclaw primeiro-acesso`.
- **Change password:** `sudo dgclaw senha trocar` (type the new password without it appearing). Changing the password ends open sessions.
- **Failed attempts:** 5 failures in 15 minutes for the same account and address, or 20 failures in 15 minutes from the same address across all accounts, block further attempts until the window passes. Even the correct password cannot sign in during the block, and the screen says how many seconds to wait.
- **Collaborators:** people you invite to just one agent. They sign in at `/login` with a temporary password, change it at `/trocar-senha` and see only their agent. Details in [COLABORADORES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COLABORADORES.md) and the `/colaboradores` screen.
- **Panel API keys** (`dgc_...`): let the Admin operate an agent's panel. They appear only once, are stored as hashes, and one key can never create another.
- **Against malicious pages:** requests that change something check the origin. Signing out uses POST only.

**If something goes wrong.** A "locked" panel means the password is missing or weak: use the first-access link or `sudo dgclaw senha trocar`. For a failed-attempt block, wait as long as the screen says.

## Security patrol {#ronda-de-seguranca}

**What it is.** Every DG Claw includes a patrol that checks several times a day for security vulnerabilities affecting **your** installation (server packages, the running kernel, open ports, DG Claw itself and services you connected, such as Notion or Google Drive). Results appear on `/seguranca` (the **Security** menu).

**The three levels.**

| Level | What it is | What happens |
| --- | --- | --- |
| 1 | Critical vulnerability with a safe action in the catalog that needs no restart | The patrol applies it, checks that the panel is still healthy and undoes it if something gets worse |
| 2 | Critical vulnerability without a safe action, without a fix, or requiring a restart | Notifies you and waits for your decision: apply, schedule or leave it |
| 3 | Low or medium severity vulnerability | Appears in the panel, with a fix when one exists |

**How to ask.** "Admin, how is the security patrol?" It runs `sudo dgclaw seguranca estado` and `sudo dgclaw seguranca resumo`. To run a check immediately: `sudo dgclaw seguranca rodar`.

**When the fix is not available yet.** The vulnerability is not presented alarmingly: it stays in the Security screen's "Waiting for an official fix" section. If a known temporary protection exists, the panel offers **Apply temporary protection**.

**What leaves the server.** No conversations, keys or files. Vulnerability sources receive the names and versions of installed packages and the server's IP address.

**Limits.** Automatic fixes only apply actions someone has already written in DG Claw's catalog; nothing comes from news text or is invented by AI. To prevent the patrol from ever applying anything by itself, put `DGCLAW_RONDA_APLICAR_SOZINHA=0` in `/etc/dgclaw/dgclaw.env`. To turn it off: `DGCLAW_RONDA_SEGURANCA=0`.

**If something goes wrong.** A "partial" patrol means one source did not respond. The screen says which one. It never looks clean when it is not. More in [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md).

## Security bulletins {#boletins-de-seguranca}

**What it is.** When the DG Claw team discovers a vulnerability in a tool the program uses, it publishes a bulletin in the official repository. Your server notices automatically (a public check every hour, without sending your data) and shows **"Your environment is at risk"**, along with a badge at the top of the screens until the issue is resolved.

**What you do.** Open Security, read the notice and click **Update**: the panel opens the Admin chat with the request already written. **Remind me later** and **Understood** postpone or dismiss it, as appropriate.

**Limits.** The notice only informs you. Nothing is downloaded or installed without your approval. To turn checking off: `DGCLAW_BOLETINS_SEGURANCA=0` in `dgclaw.env`. Details in [BOLETINS-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/BOLETINS-DE-SEGURANCA.md).

## Emergency button {#botao-de-emergencia}

**What it is.** Disconnects the server from the internet when a critical vulnerability is being exploited and the fix cannot yet be applied. The panel and websites go offline. Your administration access through Tailscale continues. If nobody confirms within 5 minutes, the server reconnects automatically.

**Where to click.** On `/seguranca`, in the "Emergency button" block. In the terminal, use `sudo dgclaw emergencia` in this order: `simular`, `preparar` (generates a single-use code valid for 2 minutes), `cortar --codigo <código>`, `confirmar` and, once the emergency has passed, `religar --codigo <código>`. The screen asks for the code and the phrase `TIRAR-DO-AR`.

**What must be configured.** Tailscale signed in (or at least one IP in `IPS_ADMIN`) and `nft` installed. Without a guaranteed access route, the button stays disabled and the screen explains why, so you do not lock yourself out.

**Limits.**

- The panel also goes offline during the cutoff. To confirm and reconnect, access the server by SSH over Tailscale.
- The cutoff does not survive a server restart. After restarting, the screen shows "Protection failure"; run `preparar` and `cortar` again, or `religar`.

**If something goes wrong.** `sudo dgclaw emergencia estado` says whether it is cut off, normal or inconsistent. Full guide in [EMERGENCIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/EMERGENCIA.md).

## Agent health and safe mode {#saude-do-agente-e-modo-de-seguranca}

**What it is.** The panel measures whether the agent is **responding**, not just running. The header badge turns green, yellow or red and the text explains why (response cut off by Anthropic's filter, conversation too large, expired login, usage limit, overload).

**What to do.** Yellow badge: usually just wait a few minutes. Red badge: use the banner button in Conversation (**Restart** or **Restart in safe mode**). Safe mode brings the agent back in a new conversation, quarantines the message that caused the hang and does not resend it. If you do not understand what happened, open **Help**, which opens a neutral Claude that reads the logs, explains and asks before changing anything (the `socorro` skill).

**Limits.** There is no button for an expired-login warning: whoever manages the server must sign in to the agent's account again through `/conectar`. More in [SAUDE-E-MODO-SEGURO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SAUDE-E-MODO-SEGURO.md).

## Privacy: hidden mode and document anonymization {#sigilo-modo-escondido-e-anonimizar-documentos}

- **Hidden mode** (the eye in the conversation header): replaces names, amounts, emails, phone numbers, CPF, CNPJ and keys with asterisks, so you can show the screen in a class without exposing a client. The automatic filter always works; the full filter (names and companies) needs an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `web.env`. Ask the Admin: "Turn on full hidden mode." If the model fails, the message remains covered. Details in [MODO-ESCONDIDO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-ESCONDIDO.md).
- **Anonymize documents** (`/anonimizar`): the agent receives the document with markers such as `[PESSOA_1]` and `[CPF_1]`, while you continue reading the full text. This only applies to the web conversation's attachment button; anything arriving through WhatsApp, Telegram or email does not pass through the filter, and no detector finds 100% of names. Details in [ANONIMIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ANONIMIZAR.md).

## Connectors and channels {#conectores-e-canais}

- **Gmail, Calendar and Drive:** only appear when the agent is signed in to the subscription through the container's `/login`. Gmail starts with read access only (search, read and leave drafts). Sending, replying, forwarding and deleting are blocked. To allow sending, ask the agent in your own words; you receive a notice for each grant. Deleting remains blocked. See [GMAIL-NO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/GMAIL-NO-AGENTE.md).
- **WhatsApp:** uses an unofficial library, and Meta may ban the number. Use a secondary number, never the business's main number. Only numbers on the allowlist can talk to the agent.
- **Text from outside** (email, page, file, channel message) is material for the agent to read, never instructions.

## Face ID {#face-id}

Face ID is an optional panel lock, enabled per device on `/face-id` (the **Face ID** menu). When enabled, the screen locks automatically after a few minutes of inactivity and only reopens with your face, fingerprint or device code (a passkey). It works for the owner and each collaborator, each with their own passkeys. Face ID never signs you in: it only unlocks a session that has already signed in with a password, and "Sign in with password" is always available. Details in [CADEADO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/CADEADO.md).

## Remote support {#suporte-remoto}

The `/suporte` screen (**Remote support** menu) creates an API key with `diagnostico` scope for the support provider. This key only reads machine and agent health at `/api/v1/diagnostico`: it does not read conversations, memory, the vault or files, and cannot operate anything. The value appears only once. The owner can revoke it whenever they want, on the same screen or with `sudo dgclaw chave-api revogar <id>`, and it stops working immediately. The walkthrough is in [DIAGNOSTICO-REMOTO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/DIAGNOSTICO-REMOTO.md).

## What DG Claw security does not do {#o-que-a-seguranca-do-dg-claw-nao-faz}

The full list is in [o-que-nao-faz.md](o-que-nao-faz.md). The main points here:

- It does not protect against anyone with root access to the server.
- The model provider (Anthropic, OpenAI) receives whatever the agent sends it.
- A tricked agent can still send data to the internet; that is why its powers start limited.

## Where the Admin can find everything {#onde-esta-cada-coisa-para-o-admin}

The routes and commands on this page are in [referencia-admin.md](referencia-admin.md).
