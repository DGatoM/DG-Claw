# What DG Claw does not do {#o-que-o-dg-claw-nao-faz}

This page exists to prevent anyone from promising something the product does not deliver, either to a customer
or to themselves. Each row was checked against the code or the area's official documentation, gives the reason
in one sentence and, where an alternative exists, explains what to do instead. Work in progress is listed in
[em-desenvolvimento.md](em-desenvolvimento.md); subscription-specific Claude and Codex features are described in
[PARIDADE-CODEX.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PARIDADE-CODEX.md).

## Admin and agents {#admin-e-agentes}

| DG Claw does not... | Reason | What to do instead |
| --- | --- | --- |
| Give the Admin an external channel (Telegram, WhatsApp) | The Admin runs as root; a public channel would give root to whoever sent a message. The `dgclaw-agente` command refuses to run there (exit code 2) | Enable the channel on a work agent |
| Have the Admin read email or open third-party links | Project rules require the Admin to talk only to the owner through panel chat, treating anything from another path as data | Ask a work agent to read and summarize the email |
| Let the Admin invite a collaborator through the API | `/api/v1/colaboradores` routes only accept the owner's browser session; the Admin has no Web credential | Send the invitation on `/colaboradores` (agent menu, "Invite collaborator"). The Admin invitation command is [in development](em-desenvolvimento.md) |
| Share the Admin with a collaborator | The Admin can see the whole server. The API refuses an invitation for it (400 error) | Share a work agent |
| Give an agent access to the server or neighboring agents | Each agent stays in a non-root container behind a firewall that drops traffic to the server, gateway, other containers and private networks | To use server features (reminders, Board, notifications), the agent asks through its mailbox (`dgclaw-api`), which only executes allowlisted routes |
| Prevent an agent from sending data to the internet | Internet egress remains open because the agent must contact the AI provider. Protection means starting with few powers and treating external text as material, not instructions | Set a spending limit for each vault key and enable powers gradually |
| Protect against someone with root on the server | Root can see everything, including the vault | Protect VPS SSH access and use the emergency button if you suspect an intrusion |

## Keys, vault and login {#chaves-cofre-e-login}

| DG Claw does not... | Reason | What to do instead |
| --- | --- | --- |
| Display a saved key's value | The vault only shows who saved it, when, and its last 4 characters | Save it again if you lost the value; only you have it |
| Share a key between agents | Each agent has its own vault so a leak does not spread beyond one agent | Save the key separately in each agent that needs it |
| Hide a key from a compromised agent | The agent needs the value to use the key; with `sudo` inside the container, it can read it | Set a spending limit at the provider for each key |
| Let a panel API key create another key | A leaked key cannot generate a replacement | Create keys through the Vault tab after signing in with your password |
| Let a panel API key change the Screen password | The Screen controls a browser signed in to your systems | Change it in the Screen tab or with `dgclaw agente tela-senha` on the server |
| Use the vault's `OPENAI_API_KEY` for a Codex agent on subscription | It would compete with the ChatGPT login | Use ChatGPT subscription login for the agent |
| Let a collaborator access the vault, change the AI account or write to memory | The panel would record the action as yours, and memory and files become permanent agent instructions | Do it yourself, or talk to the agent through chat |
| Allow two collaborators on one agent | The API refuses an invitation when the agent already has an active collaborator (409 error) | Revoke current access before inviting someone else |

## Channels and connectors {#canais-e-conectores}

| DG Claw does not... | Reason | What to do instead |
| --- | --- | --- |
| Chat through WhatsApp groups, channels or statuses | The bridge ignores groups, lists, channels, statuses and reactions; it only handles direct chats from allowlisted numbers | Use a direct chat with an allowed number |
| Accept any WhatsApp number | The agent only replies to people the owner allowed. Numbers outside the list are discarded without a reply | `dgclaw-agente canal whatsapp permitir <número>` |
| Guarantee WhatsApp against a ban | The bridge uses an unofficial library, and Meta can ban the number | Use a secondary number, never the business's main one ([RISCO-DE-BLOQUEIO-DE-CONTA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RISCO-DE-BLOQUEIO-DE-CONTA.md)) |
| Receive large or unknown media types through WhatsApp | Images, audio, video and documents are accepted up to 25 MB. Unsupported types arrive as an "unsupported type" notice. Agent file uploads are limited to 64 MB and allowed folders | Send the file through the web chat attachment button |
| Anonymize content received through WhatsApp, Telegram or email | Anonymization only operates on web chat attachments | Send the document through the chat attachment button |
| Send email through the agent by default | Gmail starts read-only: the agent searches, reads and leaves drafts. Sending, replying, forwarding and deleting are blocked | Ask the agent in your own words to enable sending. Deletion remains blocked |
| Provide claude.ai connectors (Gmail, Calendar, Drive) to API-key-only users or users of a `claude setup-token` token | Connectors only appear with subscription login performed through the container's `/login` | Sign in to the agent's account through `/conectar` |

## Claude and Codex {#claude-e-codex}

| DG Claw does not... | Reason | What to do instead |
| --- | --- | --- |
| Display a Codex agent's permission request or multiple-choice question in the panel | The runner returns 501 (`PERMISSAO_SO_CLAUDE`, `PERGUNTA_SO_CLAUDE`): Codex does not expose those requests to it | Answer through the agent's terminal or use a Claude agent |
| Connect Telegram to a Codex agent | The Codex engine ignores Telegram's channel (`--channels`) | Use a Claude agent for Telegram. WhatsApp is listed as Codex-compatible but has not been tested live |
| Apply Claude's per-tool permission rules and hooks to Codex | Codex does not read Claude's configuration file; the runner logs what it ignored | See the parity table in [PARIDADE-CODEX.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PARIDADE-CODEX.md) |

## Protection, notices and emergency {#protecao-avisos-e-emergencia}

| DG Claw does not... | Reason | What to do instead |
| --- | --- | --- |
| Install an update without your approval | New-version notifications and bulletins only inform you | Tell the Admin "yes"; it runs `dgclaw atualizar --ok-do-dono` |
| Automatically fix every vulnerability | The scan only applies actions a person previously wrote into its closed catalog; today that catalog contains one temporary protection | Ask the Admin to analyze and apply the fix with your approval |
| Keep the emergency cutoff after a server restart | The cutoff is intentionally held in memory; after restarting, the screen shows "Protection failure" | Run `sudo dgclaw emergencia preparar` and `cortar` again, or `religar` |
| Keep the panel online during an emergency cutoff | The panel is served by the same proxy that is shut down | Confirm and restore access through SSH over Tailscale |
| Hide a conversation from the AI model through hidden mode | It only replaces what appears on your screen with asterisks | Use document anonymization to prevent the agent from seeing the data |
| Guarantee 100% anonymization | No detector finds every name. Without the detector installed, only document numbers, phone numbers and email addresses are replaced | Review sensitive documents and install the name detector |

## Backup and restoration {#backup-e-restauracao}

| DG Claw does not... | Reason | What to do instead |
| --- | --- | --- |
| Include the program, image and containers in a backup | They come from GitHub and are rebuilt by the installer, keeping backups smaller | Reinstall with `dgclaw atualizar` or `dgclaw imagem construir` |
| Save programs installed inside the container outside the agent's home | The container is rebuilt on every update | Record what you installed and install it again after each update |
| Save memory and conversations with `dgclaw backup --sem-casas` | That option excludes agent homes | Make a full backup |
| Restore the Admin conversation | Restoration leaves it untouched so your current chat does not travel back in time | The Admin conversation is backed up, but restoration leaves it as it is |
| Restore agent homes when rolling back an update | `dgclaw atualizar --voltar` restores configuration and Admin, not agent data | For data, use `dgclaw restaurar` with a backup from the same version |
| Restore a backup from a different version without warning | One version's configuration and data may not work with another version's code | Use `--mesmo-assim` only if you know what you are doing |
| Delete old backups | No DG Claw command deletes a backup | Ask the Admin to delete a specific one; it never deletes the newest backup |
| Keep an off-VPS copy | A backup kept only on the server disappears with the server | Copy it using `scp` or `rsync` ([BACKUP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/BACKUP.md)) |

## Powers and usage limits {#poderes-e-limites-de-uso}

| DG Claw does not... | Reason | What to do instead |
| --- | --- | --- |
| Display Instagram and Meetings tabs without the corresponding power installed | The route returns 423 and the tab shows a lock | Ask the Admin to install the power (`instagram` or `meetings`) |
| Give an agent another agent's subscription usage | Through the mailbox, `GET /api/v1/uso` returns only that agent's usage | The owner sees all agents in the panel under ☰ > Subscription usage |
| Give collaborators the Board, Reminders and subscription usage | These are global across all agents | Ask the owner |
