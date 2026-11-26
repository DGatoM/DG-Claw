# Updates, backups and maintenance {#atualizar-backup-e-manutencao}

This page covers what you do (or ask the Admin to do) to keep DG Claw up to date and protected against mistakes:
update, create and restore backups, change the panel domain and password, rebuild the agent image and check that
everything is running. Almost all of these are commands the Admin runs on the server; you only need to describe
what you want in ordinary language.

All commands run as root (`sudo dgclaw ...`) and accept `--ensaio`, which shows what would happen without changing
anything. The complete command list is in [referencia-admin.md](referencia-admin.md). The exception is
`dgclaw emergencia`, which ignores `--ensaio` and acts for real: to see the plan without changing anything,
use `dgclaw emergencia simular`.

## Update DG Claw {#atualizar-o-dg-claw}

**What it is.** `dgclaw atualizar` downloads the new version, creates a dated backup, reinstalls the program,
rebuilds the agent image, recreates each agent's container and checks that nothing previously present disappeared
or changed. It only restarts the Admin at the end, detached from chat, so your current conversation does not drop
halfway through.

**How to request it.** Tell the Admin: "update DG Claw". It explains what the new version contains before installing
and only continues after your approval. Updating takes 10 to 30 minutes; each agent is offline for about a minute.

**Recommended sequence.**

1. `sudo dgclaw atualizar --simular`: shows everything it would do without changing anything, and saves the
   "What changes" report (new commits, CHANGELOG items and areas needing attention in sensitive components)
   in `/var/log/dgclaw/`.
2. The Admin reads the report and explains in plain language what is coming and whether there is a risk.
3. With your approval: `sudo dgclaw atualizar --ok-do-dono --segundo-plano`. Without `--ok-do-dono`, if anything
   is new, the command stops before backup and changes nothing.
4. If the new version requires a manual step, it appears in the "How to update" subsection of `CHANGELOG.md`,
   written for you. The Admin applies it.

**Options.**

| Option | Purpose |
| --- | --- |
| `--simular` | Shows what it would do without changing anything |
| `--ok-do-dono` | Confirms that you read the "What changes" report and approved it. A real update will not proceed without it |
| `--segundo-plano` | Runs detached from the terminal and leaves its log in `/var/log/dgclaw/` (recommended for the Admin) |
| `--repo <pasta>` | Location of the DG Claw clone if the installer cannot determine it |
| `--forcar-local` | Saves local clone changes in a dated stash and continues |
| `--sem-baixar` | Skips `git fetch` and `git pull` (the clone was already updated manually) |
| `--sem-backup-agentes` | Skips backup of agent homes. Only at your request |
| `--sem-voltar-sozinho` | Stops and leaves the state as-is for investigation if the new installer or verification fails |
| `--voltar <pasta>` | Returns to the specified backup (see "Roll back") |

**What is preserved.** An update never deletes what belongs to you: `web.env` and `dgclaw.env` lines (including
voice and AI keys you added), agent lists and ports, tokens and secrets between the Web and agents, each agent's
home (memory, conversations, uploads, routines), each agent's vault, panel data (conversations, task board, device
notifications), retired agents, the Admin folder with customized `CLAUDE.md` and `AGENTS.md`, the Admin conversation
and backups. Configuration files are edited line by line; none is rewritten wholesale. Only repository copies may
be rewritten: the program in `/opt/dgclaw/app`, systemd units and the agent image. The command verifies this at the
end and fails if anything disappeared.

**When it rolls back automatically.** If the new installer exits with an error or configuration verification fails,
the command automatically undoes everything using the backup it just made. If an agent simply fails to start,
it does **not** roll back (that would repeat the container problem): the summary says "Atualizacao INCOMPLETA",
lists affected agents, and the Admin recreates each one with `sudo dgclaw agente recriar <slug> --forcar`.
The Admin is only restarted when everything is working.

**If something goes wrong.**

- *Clone with local changes:* the command stops and lists the files. Use `--forcar-local` if those changes can be stashed.
- *Low disk space:* you need the backup's size plus about 6 GB for the new image. Free space and run it again.
- *Customization overlapping with the new version:* the command stops and explains. See [personalizar.md](personalizar.md).

Complete procedure, including all known conflicts: [ATUALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ATUALIZAR.md).

## New-version notification {#aviso-de-versao-nova}

**What it is.** Every 6 hours, your server checks the official repository (public read access, no account).
When `main` contains commits missing from your installation, a banner appears in the panel: "New DG Claw version
available". **See what changed** opens the summary; **Install** opens Admin chat with the request already written;
**Not now** hides the notice until a newer version appears. The Admin also receives a message, at most once per version.

**Command-line use.** `sudo dgclaw atualizar --checar` checks immediately (only reads GitHub, without downloading or
installing). `sudo dgclaw atualizar --aviso desligar` disables automatic notifications; `--aviso ligar` enables them
again. `sudo dgclaw status` shows a line with the last check's result.

**Limits.** The server sends its IP and installed commit number. Nothing is downloaded or installed without your
approval. Details: [AVISO-DE-ATUALIZACAO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/AVISO-DE-ATUALIZACAO.md).

## Backup {#backup}

**What it is.** `dgclaw backup` saves everything belonging to you in a dated, verified folder at
`/var/backups/dgclaw/<AAAAMMDD-HHMMSS>-manual/` (root-only access). Each file is opened to check for corruption;
if any cannot be opened, the command stops and explains why.

**How to request it.** "Admin, make a backup." Or, in the terminal: `sudo dgclaw backup`. Options: `--sem-casas`
excludes agent memory and conversations (only when disk space is short), and `--simular` shows what would happen.
`sudo dgclaw backup listar` lists the date, reason, version, size and whether agent homes were included. A folder
without `MANIFESTO.txt` appears as "incompleto" and cannot be used for restoration.

**Included:**

- Configuration (`/etc/dgclaw`): `web.env`, `dgclaw.env`, `agentes.json`, tokens, secrets and the panel password hash.
- Data (`/var/lib/dgclaw`): agent homes (memory, conversations, uploads, routines), vaults and panel data.
- The Admin folder and conversation.

**Not included:** the program (`/opt/dgclaw/app`) and clone, which come from GitHub; agent images and containers,
which DG Claw rebuilds; and programs installed inside a container outside the agent's home.

**Limits.**

- A backup kept only on the VPS disappears with the VPS. Occasionally copy it elsewhere through a secure channel
  (SSH), because it contains keys and the password hash. [BACKUP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/BACKUP.md) provides `scp` and `rsync` commands.
- No DG Claw command deletes a backup. The Admin never deletes the newest backup or those the system made before
  a restoration or rollback.
- Never paste backup contents into chat: they contain secrets.

## Restore {#restaurar}

**What it is.** `dgclaw restaurar <pasta-do-backup>` restores configuration, data and Admin from a backup. Before
touching anything, it saves the current state in a backup with the reason `antes-de-restaurar`. Restoration therefore
never loses data: it can always be undone.

**How to request it.** "Admin, return to yesterday's backup." It first runs `sudo dgclaw restaurar <pasta> --simular`,
shows what will happen and only then restores.

**When it refuses.**

- The backup version differs from the installed version. To roll back code and data together, use
  `sudo dgclaw atualizar --voltar <pasta>`. To restore only data anyway, use `--mesmo-assim`.
- Agents were created after the backup (they would disappear from the panel). `--mesmo-assim` also permits this.

**What it does.** Stops agents that were running, overlays the files (without deleting anything unknown to the
backup), verifies by SHA256 that configuration, Admin and vaults are identical to the backup, starts the agents
again and schedules the Admin restart at the end. The Admin conversation is left untouched so your current chat
does not travel back in time. The panel only rereads `web.env` on startup: if it shows old values, restart with
`sudo systemctl restart dgclaw-web`.

**Undo a restoration.** `sudo dgclaw restaurar <pasta antes-de-restaurar>`. The command prints that folder at the end.

## Roll back an update {#voltar-atras-numa-atualizacao}

If an update causes trouble and you want the previous code: `sudo dgclaw atualizar --voltar <pasta>`. It performs
the same configuration and Admin restoration as `restaurar`, and also returns the clone to the backup's commit,
reinstalls, rebuilds the image and recreates agents. It does **not** restore agent homes: memory and conversations
remain as they are.

| Situation | Command |
| --- | --- |
| You deleted or damaged data, and the installed version matches the backup | `dgclaw restaurar <pasta>` |
| An update caused trouble and you want the previous code | `dgclaw atualizar --voltar <pasta>` |

## Change the panel domain {#trocar-o-dominio-do-painel}

**What it is.** Moves the panel from a test address to your own domain, such as `painel.minhaempresa.com.br`.

**How to request it.** "Admin, I want to use painel.minhaempresa.com.br." The `trocar-dominio` skill explains every
step for a nontechnical user. First create a DNS A record pointing to the VPS IP through the service where you
bought the domain. `sudo dgclaw dominio mostrar` shows the current domain and the IP to use.

**What the command does.** `sudo dgclaw dominio trocar painel.minhaempresa.com.br` checks DNS (and changes nothing
if it does not point correctly), rewrites Caddy, reloads it, saves the domain in `dgclaw.env` and waits for HTTPS
(the certificate is issued automatically).

**Limits.** The old address stops opening the panel; signed-in users must sign in again at the new address.
The password and agents remain the same. `--sem-conferir-dns` skips verification at your own risk.

**If something goes wrong.**

- *"DNS does not point here yet":* create or correct the A record (delete an old AAAA record for the same name;
  in Cloudflare, use the gray cloud) and wait for propagation, which takes minutes to a few hours.
- *"HTTPS did not respond within 90 seconds":* Caddy already has the new name. Check that ports 80 and 443 are open
  in the VPS provider's firewall. It retries automatically. To revert: `dgclaw dominio trocar <nome antigo>`.

## Panel password and first access {#senha-do-painel-e-primeiro-acesso}

- **Change the password:** `sudo dgclaw senha trocar`. At least 12 characters, entered without displaying them.
  Changes only the password line in `web.env`, deletes any pending first-access link and restarts the Web.
  Existing sessions become invalid.
- **Lost the first-access link:** `sudo dgclaw primeiro-acesso` generates a new one (single use, valid for
  30 minutes); the previous link becomes invalid.
- **Installation performed by the team on someone else's VPS:** `sudo dgclaw instalacao-remota` replaces the
  password with a strong one and shows the handover message once. Do not run it on an installation you set up
  yourself: it changes your password.

## Agent image {#imagem-dos-agentes}

The image is the "template" from which each agent's container is created. Updates already rebuild it automatically.
To inspect it, `sudo dgclaw imagem status` reports ready, building or failed (with `--exigir-pronta`, it exits with
an error unless ready). To rebuild: `sudo dgclaw imagem construir` (in the background), or add `--agora` to do it
immediately. Rebuilding the image does not change existing containers; to use the new image for an agent, run
`sudo dgclaw agente recriar <slug>` (preserves its home, vault, ports and routines).

## Check that everything is running {#conferir-se-tudo-esta-de-pe}

- `sudo dgclaw status` checks essentials and exits with an error if something is down. `FALHOU` lines explain what to fix.
- `sudo dgclaw versao` shows the installed version and commit.
- `sudo dgclaw agente listar` lists agents and reports whether they are running.

## Repair an agent {#consertar-um-agente}

| Problem | What to do |
| --- | --- |
| Agent is stuck but its container is healthy | `sudo dgclaw agente reiniciar <slug>` |
| Files or configuration are missing inside the agent | `sudo dgclaw agente reparar <slug>`: rewrites `config.sh` and rebuilds runner, panel and routines |
| Container is stuck or uses an old image | `sudo dgclaw agente recriar <slug>` (with `--forcar` if needed) |
| Agent identity changed and must be reread | `sudo dgclaw agente identidade <slug>` (takes effect in the next session) |
| Screen does not appear | `sudo dgclaw agente tela <slug>`: reports what is missing line by line |
| Agent stopped responding or behaves strangely | Panel **Help** tab (`socorro` skill) |

To take an agent offline without deleting anything: `sudo dgclaw agente remover <slug>`. Its home moves to
`/var/lib/dgclaw/aposentados/`.
