# Reference for the Admin and agents {#referencia-para-o-admin-e-para-os-agentes}

This page is the manual's technical layer. It lists DG Claw commands and routes one by one, explains what each does, who may call it and where to find detailed documentation. Its readers are the Admin, an agent operating the system, or a person needing the exact address. Owner-facing pages are in the other files in this folder.

Items between `inventario:inicio` and `inventario:fim` are checked against the code by `bash tests/docs-em-dia/rodar.sh`. If a route or command is added, renamed or removed, the test fails until this list is corrected.

## Who may call {#quem-pode-chamar}

| Label | Who it is | How they authenticate |
| --- | --- | --- |
| Owner | The person owning DG Claw, signed in through the browser | Login session cookie (`/login`). At `/p/<slug>/`, Web forwards to the agent panel with its own secret |
| Collab | A collaborator invited to **one** agent | Collaborator session cookie. Web only allows their agent through (`web/lib/escopo.js`) |
| Mailbox | A work agent inside the container | `dgclaw-api`, which leaves a request in `~/.dgclaw/caixa/` ([CAIXA-DO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CAIXA-DO-AGENTE.md)). Only routes enabled with `caixa.permitir` |
| Key | Another assistant (the Admin, for example) operating **one** agent's panel | `Authorization: Bearer dgc_...`, created in that agent's Vault tab ([COFRE-POR-API.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/COFRE-POR-API.md)) |
| Root | Whoever runs as root on the server: the Admin or the owner in the terminal | `sudo dgclaw ...` |
| Public | Anyone who can reach the address | No login |

Rules applying everywhere:

- Web routes (`/api/v1/...`) require the owner's session. The code has no machine credential for Web: the Admin has neither a mailbox nor a key for them. Exceptions are in each row's "Who" column.
- A panel API key cannot create, list or revoke API keys, or change the Screen password.
- A new Web route without the agent's `slug` in its path starts closed to collaborators (403) until someone enables it in `web/lib/escopo.js`.
- Every error returns its reason in Portuguese and the correct status. `null` means "not measured", never zero.

<!-- inventario:inicio -->

## Server commands (`dgclaw`) {#comandos-do-servidor-dgclaw}

Run as root: `sudo dgclaw <comando>`. `--ensaio` applies to any command and shows what would happen without changing anything. Who: Root. General details in [ATUALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ATUALIZAR.md) and `dgclaw --ajuda`. The exception is `dgclaw emergencia`, which ignores `--ensaio` and acts for real: to view the plan without changing anything, use `dgclaw emergencia simular`.

### Agents {#agentes}

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw agente criar` | Creates a work agent: its own machine, panel and conversation. Accepts `--nome`, `--provedor`, `--auth`, `--modelo`, `--papel`, `--jeito`, `--dono`, `--canal`, `--avatar`, `--cor`. Running again resumes where it stopped | [ARQUITETURA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ARQUITETURA.md) |
| `dgclaw agente listar` | Lists agents and whether they are running (`--json` for machines) | [ARQUITETURA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ARQUITETURA.md) |
| `dgclaw agente parar` | Stops the agent. Requires the `slug` | [ARQUITETURA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ARQUITETURA.md) |
| `dgclaw agente iniciar` | Starts a stopped agent | [ARQUITETURA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ARQUITETURA.md) |
| `dgclaw agente reiniciar` | Stops and starts again. For a stuck agent; do not use for updates | [ATUALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ATUALIZAR.md) |
| `dgclaw agente reparar` | Rewrites `config.sh` and rebuilds the inside (runner, panel and routines) | [ATUALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ATUALIZAR.md) |
| `dgclaw agente recriar` | Replaces the container with the new image while keeping home, vault, ports and routines. `--forcar` recreates even with the same image | [ATUALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ATUALIZAR.md) |
| `dgclaw agente prioridade` | Shows or changes the agent's memory priority (`alta`, `normal` or `baixa`). Takes effect on the next recreation | [TELA-DO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/TELA-DO-AGENTE.md) |
| `dgclaw agente identidade` | Rewrites only `identidade.md`; takes effect in the next session | [PERSONALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PERSONALIZAR.md) |
| `dgclaw agente cofre` | Stores, revokes, lists or applies agent API keys (`guardar`, `revogar`, `listar`, `aplicar`). The value always comes through STDIN | [COFRE-POR-API.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/COFRE-POR-API.md) |
| `dgclaw agente tela` | Checks the agent's Screen and lists what is missing line by line | [TELA-DO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/TELA-DO-AGENTE.md) |
| `dgclaw agente tela-senha` | Changes the Screen password (6 to 8 ASCII characters, through STDIN) | [TELA-DO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/TELA-DO-AGENTE.md) |
| `dgclaw agente youtube` | Enables or disables use of Screen cookies by the agent's `yt-dlp` (`conta-dedicada sim\|nao`, off by default; only with a Google account dedicated to the agent) | [CHANGELOG.md](https://github.com/DGatoM/DG-Claw/blob/main/CHANGELOG.md) |
| `dgclaw agente restricoes` | Shows or changes agent restrictions (`--sem-bash`, `--sem-enviar-arquivo`, `--escrita-so-em` or `--escrita-livre`). They stay outside the container and return automatically on create, repair, recreate and update. Does not apply to the Admin or, in this version, Codex agents | [RESTRICOES-DO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RESTRICOES-DO-AGENTE.md) |
| `dgclaw agente remover` | Takes the agent offline without deleting it: home moves to `/var/lib/dgclaw/aposentados/`. Asks for confirmation, or `--sim` | [ATUALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ATUALIZAR.md) |

### Collaborators: invite someone to use an agent {#colaboradores-convidar-quem-vai-usar-um-agente}

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw colaborador criar` | Creates someone's access to an agent (`<agente> <email>`) and shows an invitation ready to copy, with address, login and temporary password | [agentes.md](agentes.md) |
| `dgclaw colaborador listar` | Lists collaborators and the agents each can access | [agentes.md](agentes.md) |
| `dgclaw colaborador reenviar` | Generates a new temporary password and shows the invitation again | [agentes.md](agentes.md) |
| `dgclaw colaborador revogar` | Removes access and ends the person's sessions. If they connected the agent's AI account, that account stays connected and the command warns about it | [agentes.md](agentes.md) |
| `dgclaw colaborador ajuda` | Shows command usage | [agentes.md](agentes.md) |

### DG support: temporary SSH key access {#suporte-dg-acesso-temporario-por-chave-ssh}

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw suporte ligar` | Allows the support team access with a temporary SSH key (`--chave '<linha>' [--dias N]`, default 7 days, maximum 30). After expiry, the server automatically refuses the key | [PROJETO-DE-CLIENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PROJETO-DE-CLIENTE.md) |
| `dgclaw suporte desligar` | Removes support keys and lists open root SSH sessions. With `--derrubar-sessoes`, ends all except the command caller's session | [PROJETO-DE-CLIENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PROJETO-DE-CLIENTE.md) |
| `dgclaw suporte status` | Shows support keys, their validity, expired keys and open root sessions | [PROJETO-DE-CLIENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PROJETO-DE-CLIENTE.md) |
| `dgclaw suporte limpar` | Removes only expired keys (a daily timer already does this) | [PROJETO-DE-CLIENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PROJETO-DE-CLIENTE.md) |

### Panel: domain, password and first access {#painel-dominio-senha-e-primeiro-acesso}

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw dominio mostrar` | Shows the current panel domain and VPS public IP | [atualizar-e-backup.md](atualizar-e-backup.md) |
| `dgclaw dominio trocar` | Moves the panel to a custom domain. Checks DNS first and changes nothing if it does not point correctly (`--sem-conferir-dns` skips the check) | [atualizar-e-backup.md](atualizar-e-backup.md) |
| `dgclaw senha trocar` | Changes the panel password (at least 12 characters, new password through STDIN) and restarts Web | [atualizar-e-backup.md](atualizar-e-backup.md) |
| `dgclaw primeiro-acesso` | Generates a new first-access link (single use, valid for 30 minutes); invalidates the previous one | [SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SEGURANCA.md) |
| `dgclaw instalacao-remota` | For a team that installed on someone else's VPS: changes the password to a strong one and shows the handover message once. Do not run on an owner-installed system | [INSTALL.md](https://github.com/DGatoM/DG-Claw/blob/main/INSTALL.md) |

### Image, status and version {#imagem-estado-e-versao}

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw imagem status` | Says whether the agent image is ready, building or failed (`--exigir-pronta` exits with an error if not ready) | [ATUALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ATUALIZAR.md) |
| `dgclaw imagem construir` | Builds the image in the background, or immediately with `--agora` | [ATUALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ATUALIZAR.md) |
| `dgclaw status` | Checks that all essentials are running; exits with an error if something is down | [atualizar-e-backup.md](atualizar-e-backup.md) |
| `dgclaw versao` | Shows the installed version and commit | [atualizar-e-backup.md](atualizar-e-backup.md) |

### Update, backup and restore {#atualizar-backup-e-restaurar}

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw atualizar` | Downloads the new version, backs up, reinstalls and recreates agents. Options: `--simular`, `--repo`, `--forcar-local`, `--sem-baixar`, `--sem-backup-agentes`, `--sem-voltar-sozinho`, `--ok-do-dono`, `--segundo-plano`, `--checar`, `--aviso ligar` or `desligar`, `--voltar <pasta>` | [ATUALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/ATUALIZAR.md), [AVISO-DE-ATUALIZACAO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/AVISO-DE-ATUALIZACAO.md) |
| `dgclaw backup` | Creates a verified backup in `/var/backups/dgclaw/<data>-manual`. Options: `--sem-casas` (excludes agent memory and conversations) and `--simular` | [BACKUP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/BACKUP.md) |
| `dgclaw backup listar` | Lists backups: date, reason, version, size and whether agent homes are included | [BACKUP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/BACKUP.md) |
| `dgclaw restaurar` | Restores configuration, data and Admin from a backup after saving the current state. `--simular` and `--mesmo-assim` | [BACKUP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/BACKUP.md) |
| `dgclaw personalizacoes levantar` | Lists program customizations (register, clone, installer copies, Admin conversations) | [PERSONALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PERSONALIZAR.md) |
| `dgclaw personalizacoes conferir` | Checks the register against the new version and reports overlaps; changes nothing | [PERSONALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PERSONALIZAR.md) |
| `dgclaw personalizacoes concluir` | Marks the pending inventory as complete | [PERSONALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PERSONALIZAR.md) |

### API keys and remote support {#chaves-de-api-e-suporte-remoto}

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw chave-api criar` | Creates an API key (`--nome "<nome>" --escopo diagnostico`); value appears only once | [DIAGNOSTICO-REMOTO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/DIAGNOSTICO-REMOTO.md) |
| `dgclaw chave-api listar` | Lists keys: name, ending, last access and whether revoked (`--json`) | [DIAGNOSTICO-REMOTO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/DIAGNOSTICO-REMOTO.md) |
| `dgclaw chave-api revogar <id>` | Immediately invalidates the key; the record stays in the list with the date | [DIAGNOSTICO-REMOTO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/DIAGNOSTICO-REMOTO.md) |

### Security patrol {#ronda-de-seguranca}

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw seguranca ajuda` | Shows patrol help | [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca estado` | Last run, next run, whether partial and findings per level (`--json`) | [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca resumo` | New findings, already cleaned up for reading (`--todos` includes all) | [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca rodar` | Runs a check now (`--sem-avisar` sends no note to the Admin) | [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca aplicar` | Applies a catalog action for a finding. Only with the owner's approval | [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca desfazer` | Reverts an applied action by record number | [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca inventario` | What the patrol knows about this installation (`--json`, `--refazer`) | [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca pedido` | Executes a panel request saved in a file. Called by the systemd unit; not for manual use | [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca pedido-todos` | Executes the panel request queue. Also called by systemd | [RONDA-DE-SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RONDA-DE-SEGURANCA.md) |

### Emergency button {#botao-de-emergencia}

Disconnects the server from the internet, keeping only Tailscale access. If nobody confirms within 5 minutes, it reconnects automatically.
The order is `simular`, `preparar`, `cortar --codigo <c>`, `confirmar`, and `religar --codigo <c>` once the emergency passes.

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw emergencia estado` | Says whether disconnected or normal, and what is stopped | [EMERGENCIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/EMERGENCIA.md) |
| `dgclaw emergencia simular` | Shows the plan and firewall file without changing anything | [EMERGENCIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/EMERGENCIA.md) |
| `dgclaw emergencia preparar` | Generates a single-use code (valid for 2 minutes) and shows the plan | [EMERGENCIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/EMERGENCIA.md) |
| `dgclaw emergencia cortar` | Takes the server offline. Requires the code; `--isolar-saida` also blocks outbound traffic | [EMERGENCIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/EMERGENCIA.md) |
| `dgclaw emergencia confirmar` | Cancels automatic reconnection | [EMERGENCIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/EMERGENCIA.md) |
| `dgclaw emergencia religar` | Returns to normal and tests that everything is back. Requires a new code | [EMERGENCIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/EMERGENCIA.md) |

## Commands inside the agent {#comandos-de-dentro-do-agente}

Run in the container as user `agente`.

### `dgclaw-agente` (channels) {#dgclaw-agente-canais}

Who: the work agent at the owner's request. The Admin is refused (exit code 2): it has no external channel.

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw-agente canal status` | Shows enabled channels | [channels skill](https://github.com/DGatoM/DG-Claw/blob/main/skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram token` | Stores the bot token (through STDIN) | [channels skill](https://github.com/DGatoM/DG-Claw/blob/main/skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram conferir` | Checks the token and shows the bot's `@` | [channels skill](https://github.com/DGatoM/DG-Claw/blob/main/skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram parear` | Pairs the owner with the bot (`--confirmar <chat_id>`) | [channels skill](https://github.com/DGatoM/DG-Claw/blob/main/skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram ligar` | Enables the Telegram channel | [channels skill](https://github.com/DGatoM/DG-Claw/blob/main/skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram desligar` | Disables the channel (`--apagar` removes the connection) | [channels skill](https://github.com/DGatoM/DG-Claw/blob/main/skills/canais/SKILL.md) |
| `dgclaw-agente canal whatsapp parear` | Pairs a secondary number and prints only the code | [CANAL-WHATSAPP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp permitir` | Adds the owner's number to the allowlist | [CANAL-WHATSAPP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp remover` | Removes a number from the allowlist | [CANAL-WHATSAPP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp grupo` | Lists, allows or removes groups the agent can write to through Z-API (`listar`, `liberar <id>`, `remover <id>`) | [CANAL-WHATSAPP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp ligar` | Enables the WhatsApp bridge | [CANAL-WHATSAPP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp desligar` | Disables the bridge (`--apagar` removes pairing) | [CANAL-WHATSAPP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp retomar` | Resumes sending after the ban safeguards have stopped it, once the owner has checked the number | [CANAL-WHATSAPP.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CANAL-WHATSAPP.md) |

### `dgclaw-card` (parallel sessions) {#dgclaw-card-sessoes-paralelas}

Who: the work agent (and Admin), talking to its own runner at `127.0.0.1`. The token never appears on the command line.

| Command | Purpose | Details |
| --- | --- | --- |
| `dgclaw-card ajuda` | Shows command usage | [MODO-MONITOR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-MONITOR.md) |
| `dgclaw-card abrir` | Opens a card (parallel session, optionally in another provider) and delivers the request. `--monitor` enables the watcher | [MODO-MONITOR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-MONITOR.md) |
| `dgclaw-card mandar` | Sends a message to an open card | [MODO-MONITOR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-MONITOR.md) |
| `dgclaw-card estado` | Reports the card's state | [MODO-MONITOR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-MONITOR.md) |
| `dgclaw-card esperar` | Waits for a card response (default 900 seconds) | [MODO-MONITOR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-MONITOR.md) |
| `dgclaw-card ler` | Reads the card's latest messages | [MODO-MONITOR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-MONITOR.md) |
| `dgclaw-card listar` | Lists cards created through this route | [MODO-MONITOR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-MONITOR.md) |
| `dgclaw-card fechar` | Closes the card | [MODO-MONITOR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-MONITOR.md) |

## Web routes {#rotas-do-web}

Served by DG Claw Web. Who: Owner unless the column says otherwise. Collab only where explicitly listed.

### Sign in, sign out and account {#entrar-sair-e-conta}

| Route | Purpose | Who | Details |
| --- | --- | --- | --- |
| `/api/login-estado` | Tells the login screen whether login is available or locked, and why | Public | [SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SEGURANCA.md) |
| `/api/primeiro-acesso` | Receives the new first-access password (POST, with the link code) | Public, with single-use code | [SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SEGURANCA.md) |
| `/sair` | Ends the session and returns to `/login` | Owner, Collab | [SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SEGURANCA.md) |
| `/api/saude` | Web liveness response: agent count, whether the agent list is readable and whether login is locked | Public | [SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SEGURANCA.md) |
| `/api/v1/eu` | Reports who is signed in, their role (owner or collaborator) and whether a password change is required | Owner, Collab | [COLABORADORES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COLABORADORES.md) |
| `/api/v1/eu/senha` | Collaborator changes their own password (POST) | Collab | [COLABORADORES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COLABORADORES.md) |
| `/api/v1/dono/senha` | Signed-in owner changes the panel password, providing the current one (POST) | Owner | [seguranca.md](seguranca.md) |
| `/api/v1/colaboradores` | Lists, invites (POST), resends invitations and revokes collaborator access | **Owner session only**. Collab and Mailbox receive 403 | [COLABORADORES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COLABORADORES.md) |
| `/api/v1/logs` | Reads agent history for Logs (agent list, events and search), read-only | **Owner session only**. Collab receives 403; agents and Admin using tokens cannot access it | [LOGS.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/LOGS.md) |
| `/api/v1/login` | Documentation for AI account login inside conversation (`/api/v1/agents/<slug>/login`: view, start, send code, cancel) | Owner. Collab receives 403 | [LOGIN-NA-CONVERSA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/LOGIN-NA-CONVERSA.md) |
| `/api/v1/conectar` | Documentation for Connect account | Owner, Collab (notice read-only) | [CONECTAR-CONTA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/CONECTAR-CONTA.md) |
| `/api/v1/modal-login` | Saves the choice for "Sign in to your agents" (`/api/v1/modal-login/preferencia`) | Owner | [CONECTAR-CONTA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/CONECTAR-CONTA.md) |

### Conversation with agents {#conversa-com-os-agentes}

| Route | Purpose | Who | Details |
| --- | --- | --- | --- |
| `/api/v1/agents` | Lists agents (collaborator sees only their own) | Owner, Collab | No dedicated document |
| `/api/v1/agents/:slug/messages` | Reads conversation messages | Owner, Collab (own agent only) | No dedicated document |
| `/api/v1/agents/:slug/send` | Sends a message to the agent | Owner, Collab | [CONVERSA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CONVERSA.md) |
| `/api/v1/agents/:slug/stream` | Follows the conversation live | Owner, Collab | No dedicated document |
| `/api/v1/agents/:slug/wait` | Waits for the agent's response | Owner, Collab | No dedicated document |
| `/api/v1/agents/:slug/upload` | Attaches a file | Owner, Collab | No dedicated document |
| `/api/v1/agents/:slug/permissao` | Answers an agent permission request | Owner, Collab (with their name recorded) | [TRILHA-E-PERMISSAO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/TRILHA-E-PERMISSAO.md) |
| `/api/v1/agents/:slug/pergunta` | Answers an agent multiple-choice question | Owner, Collab | [TRILHA-E-PERMISSAO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/TRILHA-E-PERMISSAO.md) |
| `/api/v1/agents/:slug/reiniciar` | Restarts the agent session | Owner, Collab | No dedicated document |
| `/api/v1/agents/:slug/parar` | Stops what the agent is doing (one Esc in the session) | Owner. Collab receives 403 | [PARAR.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/PARAR.md) |
| `/api/v1/agents/:slug/avatar` | Agent photo | Owner, Collab | No dedicated document |
| `/api/v1/agents/:slug/compartilhados` | Conversation media and file collection | Owner, Collab | [MIDIAS-CACHE.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MIDIAS-CACHE.md) |
| `/api/v1/agents/:slug/lido` | Marks the conversation read up to a message | Owner, Collab | [ESTADO-DOS-AGENTES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/agents/:slug/nao-lido` | Marks (POST) or unmarks (DELETE) the conversation as unread | Owner, Collab | [ESTADO-DOS-AGENTES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/agents/:slug/vendo` | Reports that the person is viewing the conversation, avoiding unnecessary notifications | Owner, Collab | [ESTADO-DOS-AGENTES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/agents/:slug/comandos` | Agent slash-command catalog | Owner. Collab receives 403 | [COMANDOS-DE-BARRA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COMANDOS-DE-BARRA.md) |
| `/api/v1/agents/:slug/comando` | Executes a slash command | Owner. Collab receives 403 | [COMANDOS-DE-BARRA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COMANDOS-DE-BARRA.md) |
| `/api/v1/agents/:slug/alertas` | Conversation alerts (list, acknowledge at `/visto`, read source message) | Owner, Collab | [ALERTAS.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ALERTAS.md) |
| `/api/v1/alertas` | Conversation alert documentation | Owner, Collab | [ALERTAS.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ALERTAS.md) |
| `/api/v1/comandos` | Slash-command documentation | Owner, Collab | [COMANDOS-DE-BARRA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COMANDOS-DE-BARRA.md) |
| `/api/v1/trilha` | Action trail and permission documentation | Owner, Collab | [TRILHA-E-PERMISSAO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/TRILHA-E-PERMISSAO.md) |
| `/api/v1/parar` | Stop button documentation | Owner, Collab (read-only) | [PARAR.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/PARAR.md) |
| `/api/v1/nao-lidas` | Unread message count per agent | Owner, Collab (own agent only) | [ESTADO-DOS-AGENTES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/estados` | Each agent's state (working, needs you, finished, idle, no signal) | Owner. Mailbox receives 403 | [ESTADO-DOS-AGENTES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/compartilhados` | Media collection documentation | Owner, Collab | [MIDIAS-CACHE.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MIDIAS-CACHE.md) |
| `/api/v1/media` | Serves conversation media (`/api/v1/media/:id`, thumbnail, and `/visual` for visuals) | Owner, Collab (own agent's media only) | [MIDIAS-CACHE.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MIDIAS-CACHE.md) |
| `/api/v1/transcribe` | Transcribes audio (POST) | Owner, Collab | No dedicated document (mentioned in [COLABORADORES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COLABORADORES.md)) |
| `/api/v1/tts` | Reads text aloud (POST); `/api/v1/tts/cota` shows the voice quota | Owner, Collab | [CONVERSA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CONVERSA.md) |
| `/api/v1/sigilo` | Asks the model for text spans to hide in hidden mode (POST); `/api/v1/sigilo/estado` says whether the model is enabled | Owner | [MODO-ESCONDIDO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MODO-ESCONDIDO.md), [SIGILO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/SIGILO.md) |

### Whole-system functions {#funcoes-da-caixa-inteira}

| Route | Purpose | Who | Details |
| --- | --- | --- | --- |
| `/api/v1/lembretes` | Reminders (list, create, edit, pause, resume, delete; `/disparar` triggers one now; confirm or snooze an occurrence) | Owner, Mailbox (each agent changes its own) | [LEMBRETES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/LEMBRETES.md) |
| `/api/v1/foco` | Focus mode: each agent's item list (read, replace, append, check, delete) and change events | Owner, Mailbox | [MODO-FOCO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MODO-FOCO.md) |
| `/api/v1/tarefas` | Task desk | Owner (all), Mailbox (creates for itself, changes its own) | [MESA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MESA.md) |
| `/api/v1/pedidos` | Request queue (agent creates and moves its own items; owner opens, marks done and cancels) | Owner (all), Mailbox (own only) | [PEDIDOS.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/PEDIDOS.md) |
| `/api/v1/uso` | How much of each agent's subscription has been used (`null` means "not measured") | Owner, Mailbox (own agent only) | [USO-DA-ASSINATURA.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/USO-DA-ASSINATURA.md) |
| `/api/v1/avisos` | Noticeboard between agents and owner (post, read, remove); `/injecao` shows text injected into the agent conversation and `/preferencias` shows effective owner preferences | Owner, Mailbox | [QUADRO-DE-AVISOS.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/QUADRO-DE-AVISOS.md) |
| `/api/v1/caixa` | Agent mailbox documentation | Owner, Collab | [CAIXA-DO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/CAIXA-DO-AGENTE.md) |
| `/api/v1/cofre` | Documentation for the vault in conversation (the vault itself belongs to each agent's panel) | Owner, Mailbox (documentation only) | [COFRE-NA-CONVERSA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/COFRE-NA-CONVERSA.md) |
| `/api/v1/anonimizar` | Document anonymization: `/estado`, `/testar`, `/detector/instalar`, and per-agent configuration, table, documents and `/final/:id` | Owner. Documentation is public | [ANONIMIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ANONIMIZAR.md) |
| `/api/v1/push` | Device notifications: key, subscriptions, preferences and test | Owner | [AVISOS-NO-APARELHO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/AVISOS-NO-APARELHO.md) |
| `/api/v1/onboarding` | First-agent request handled by the Admin: follow (GET) and create (POST); `/animacao-vista` and `/cartao-dispensado` | Owner | [PRIMEIRO-AGENTE.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/PRIMEIRO-AGENTE.md) |
| `/api/v1/manual` | Manual pages as text (`/api/v1/manual/:nome.md`); public index at `/api/v1/manual/docs.md` | Owner, Mailbox. Only the index is public | [Manual README](README.md) |
| `/manual` | Manual reading screen | Owner | [Manual README](README.md) |

### Updates and security {#atualizacao-e-seguranca}

| Route | Purpose | Who | Details |
| --- | --- | --- | --- |
| `/api/v1/atualizacao` | Reports a new version and summarizes changes; `/descansar` (POST with published commit) dismisses the banner until another version appears | Owner. Mailbox receives 403 | [ATUALIZACAO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/ATUALIZACAO.md) |
| `/api/v1/integracoes` | Faulty integrations: the red banner, `/lembrar` (postpones 1 hour), `/silenciar` and `/reativar` (POST with agent and integration), `/automatico` (POST: calls the Admin automatically, off by default) | Owner only: collaborators and mailbox receive 403 | [INTEGRACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/INTEGRACOES.md) |
| `/api/v1/seguranca` | DG Claw security notices: `/boletins`, and per-id `/adiar` and `/dispensar` | Owner. Mailbox receives 403 | [SEGURANCA-BOLETINS.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/SEGURANCA-BOLETINS.md) |
| `/api/v1/seguranca/ronda` | Patrol results and requests to apply, schedule and undo (`/ronda/:id/aplicar`) | Owner | [RONDA-PAINEL.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/RONDA-PAINEL.md) |
| `/api/v1/seguranca/emergencia` | Emergency button state and `preparar`, `cortar` and `religar` requests | Owner | [RONDA-PAINEL.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/RONDA-PAINEL.md) |
| `/api/v1/chaves-api` | Remote-support API keys: list (GET), create (POST, token appears only once) and revoke (DELETE `?id=<código>`) | Owner. Mailbox receives 403 | [DIAGNOSTICO-REMOTO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/DIAGNOSTICO-REMOTO.md) |
| `/api/v1/diagnostico` | Machine and agent health, read-only (GET and HEAD); `/api/v1/diagnostico/docs.md` is public | Owner, or key with `diagnostico` scope | [DIAGNOSTICO-REMOTO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/DIAGNOSTICO-REMOTO.md) |
| `/suporte` | Remote support screen: create, list and revoke keys | Owner | [DIAGNOSTICO-REMOTO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/DIAGNOSTICO-REMOTO.md) |
| `/api/v1/cadeado` | Face ID: state, enable, unlock, devices, passkeys and lock timeout; routes listed at `/api/v1/cadeado/docs.md` | Owner and collaborator, each with only their own passkeys. Mailbox cannot reach it | [CADEADO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/CADEADO.md) |
| `/face-id` | Face ID screen: enable on this device, choose timeout and remove passkeys | Owner and collaborator | [CADEADO.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/CADEADO.md) |

### Page entry points {#entrada-de-paginas}

Screens served by Web. All require login except `/login` and `/primeiro-acesso`.

| Address | Purpose | Who |
| --- | --- | --- |
| `/login` | Sign-in screen | Public |
| `/primeiro-acesso` | Set a password through the single-use link | Public, with code |
| `/trocar-senha` | Change collaborator's temporary password | Collab |
| `/seguranca` | Security screen: notices, patrol and emergency button | Owner |
| `/p/:slug` | Forwards to the agent panel (`/p/<slug>/`) with the proxy secret | Owner, Collab (own agent only, limited writing) |

### Branding (white label) {#marca-white-label}

Public routes without login because the sign-in screen also uses the name, logo and colors. Details in [WHITE-LABEL.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/WHITE-LABEL.md).

| Route | What it does |
| --- | --- |
| `/marca.css` | Brand colors and fonts in Web. In each agent panel, `GET /marca.css` |
| `/manifest.webmanifest` | Installed app name and icons |
| `GET /marca/favicon` | Brand favicon in each agent panel |
| `GET /marca/icone-app` | Installed app icon in each agent panel |
| `GET /marca/logo` | Brand logo in each agent panel (center of the Integrations tab when the agent has no photo) |

## Routes in each agent's panel {#rotas-do-painel-de-cada-agente}

Each agent has its own panel. The Owner arrives through `/p/<slug>/`; the Admin and other assistants use an agent **Key** (`dgc_...`). Who: Owner and Key unless the row says otherwise. Collaborators only read and have no vault, API keys, AI account, Screen, channel credentials, chat or help ([COLABORADORES.md](https://github.com/DGatoM/DG-Claw/blob/main/web/docs/COLABORADORES.md)).

### Core, health and help {#nucleo-saude-e-socorro}

| Route | Purpose | Details |
| --- | --- | --- |
| `GET /` | Opens the panel home page (also `GET /index.html`) | No dedicated document |
| `GET /login.html` | Panel sign-in screen when accessed directly | [SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SEGURANCA.md) |
| `POST /login` | Signs in to the panel with a password | [SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SEGURANCA.md) |
| `POST /logout` | Signs out; `GET /logout` only leads to the sign-in screen | [SEGURANCA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SEGURANCA.md) |
| `GET /api/agents` | This machine's agent for the menu selector | No dedicated document |
| `GET /api/config` | Panel configuration and which blocks to enable | No dedicated document |
| `GET /api/overview` | Mood, session, today's posts and pending-item summary for Status | No dedicated document |
| `GET /api/powers` | Lists powers and whether installed | No dedicated document |
| `GET /api/emotions` | Emotion state; empty if DG Alive extension is not installed | No dedicated document |
| `GET /api/thoughts` | Agent thoughts (present, recent past and future), goals and proactivity | No dedicated document |
| `GET /api/saude` | Agent response diagnosis (`ativo`, `atencao`, `inativo`, `indeterminado`) | [SAUDE-E-MODO-SEGURO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SAUDE-E-MODO-SEGURO.md) |
| `POST /api/saude/reiniciar` | Restarts agent normally or in safe mode | [SAUDE-E-MODO-SEGURO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SAUDE-E-MODO-SEGURO.md) (button screen; route not listed) |
| `GET /api/socorro/estado` | Help session state | [SOCORRO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/SOCORRO.md) |
| `POST /api/socorro/mensagem` | Talks to the help Claude | [SOCORRO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/SOCORRO.md) |
| `POST /api/socorro/encerrar` | Ends help session | [SOCORRO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/SOCORRO.md) |
| `GET /api/pulso` | Operational health of agent components | [OPERACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/OPERACOES.md) |

### Conversation and sessions {#conversa-e-sessoes}

| Route | Purpose | Details |
| --- | --- | --- |
| `GET /api/chat/mensagens` | Reads Conversation tab messages | No dedicated document |
| `POST /api/chat/mensagem` | Sends a message to the agent | No dedicated document |
| `POST /api/chat/parar` | Interrupts the current turn | No dedicated document |
| `POST /api/chat/reativar` | Reactivates the stopped session | No dedicated document |
| `POST /api/chat/transcrever` | Transcribes audio (collaborators may also use it) | No dedicated document |
| `/api/sessoes` | Lists, creates and controls agent sessions. Accepts any method; paths containing a session code provide archive, delete, decide, message, key, resume, handoff, attachment and other operations | [SESSOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/SESSOES.md) |
| `GET /api/sessoes-config` | Sessions tab configuration | [SESSOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/SESSOES.md) |
| `GET /api/costs/overview` | Costs: overview | No dedicated document |
| `GET /api/costs/executions` | Costs: execution list | No dedicated document |
| `GET /api/costs/execution/:sessionId` | Costs: execution details | No dedicated document |
| `POST /api/costs/analyze` | Requests cost analysis | No dedicated document |

### Memory, routines and operations {#memoria-rotinas-e-operacoes}

| Route | Purpose | Details |
| --- | --- | --- |
| `GET /api/memory` | Lists memory files | No dedicated document |
| `GET /api/memory/file` | Reads a memory file (with a size cap) | No dedicated document |
| `GET /api/memoria/arquivo` | Reads a memory file through the panel reader | [CEREBRO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/CEREBRO.md) |
| `PUT /api/memoria/arquivo` | Edits a memory file. Becomes a permanent instruction; Owner and Key only | [CEREBRO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/CEREBRO.md) |
| `GET /api/working-memory` | Agent working memory | [MEMORIA-DE-TRABALHO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/MEMORIA-DE-TRABALHO.md) |
| `GET /api/working-memory/status` | Working-memory health for the Status card | [MEMORIA-DE-TRABALHO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/MEMORIA-DE-TRABALHO.md) |
| `GET /api/personality` | Agent personality | No dedicated document |
| `GET /api/personality/changelog` | Personality change history | No dedicated document |
| `GET /api/identity` | Identity files opened by the reader | No dedicated document |
| `GET /api/diary` | Agent diary | No dedicated document |
| `GET /api/cerebro` | Memory X-ray: files the agent reads, gathered on one screen | [CEREBRO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/CEREBRO.md) |
| `GET /api/radiografia` | "How your agent works inside" text (the X-ray), read from the installed copy | [RADIOGRAFIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RADIOGRAFIA.md) |
| `GET /api/integracoes` | Agent's integrations map: state of each connected system (WhatsApp, Instagram, transcription and others), read from the record maintained by `dgclaw-integracao` | [INTEGRACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/INTEGRACOES.md) |
| `POST /api/integracoes/:id/desligar` | Disables an integration on the map (owner preference; does not change the system itself) | [INTEGRACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/INTEGRACOES.md) |
| `POST /api/integracoes/:id/ligar` | Undoes disabling | [INTEGRACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/INTEGRACOES.md) |
| `GET /api/operacoes` | System operations in small squares | [OPERACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/OPERACOES.md) |
| `GET /api/operations/crons` | Lists fixed routines | No dedicated document |
| `GET /api/operations/logs` | Reads agent logs | No dedicated document |
| `GET /api/operations/session` | Session state for Operations | No dedicated document |
| `GET /api/rotinas` | Schedule: timers currently in systemd | No dedicated document |
| `GET /api/rotinas/usuario` | Routines created by the owner or agent | [OPERACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/OPERACOES.md) |
| `GET /api/skills` | Agent skills read from disk | No dedicated document |

### Files and apps {#arquivos-e-apps}

| Route | Purpose | Details |
| --- | --- | --- |
| `GET /api/arquivos` | Lists the agent folder | [PASTA-E-ASSETS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PASTA-E-ASSETS.md) |
| `PUT /api/arquivos` | Writes a text file (up to 2 MB) | [PASTA-E-ASSETS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PASTA-E-ASSETS.md) |
| `DELETE /api/arquivos` | Deletes a file or folder | [PASTA-E-ASSETS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PASTA-E-ASSETS.md) |
| `GET /api/arquivos/conteudo` | Reads file content | [PASTA-E-ASSETS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PASTA-E-ASSETS.md) |
| `GET /api/arquivos/baixar` | Downloads a file | [PASTA-E-ASSETS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PASTA-E-ASSETS.md) |
| `POST /api/arquivos/upload` | Uploads a file to the folder | [PASTA-E-ASSETS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PASTA-E-ASSETS.md) |
| `GET /api/apps` | Lists agent apps | [ABA-APPS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos` | Lists app content | [ABA-APPS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos/:slug` | Content item details | [ABA-APPS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos/:slug/assets` | Lists a content item's assets | [ABA-APPS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos/:slug/asset/:nome` | Opens an asset | [ABA-APPS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos/:slug/arquivo/:nome` | Opens a content item's file | [ABA-APPS.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/ABA-APPS.md) |
| `POST /api/apps/:app/conteudos/:slug/compartilhar` | Publishes a content item's script as a single HTML file and returns a link to send to someone without a password | No dedicated document |

### Vault, API keys, AI account and Screen {#cofre-chaves-de-api-conta-de-ia-e-tela}

| Route | Purpose | Who | Details |
| --- | --- | --- | --- |
| `GET /api/cofre` | Lists stored keys (who stored them, when, last 4 characters; never the value) | Owner, Key | [COFRE.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/COFRE.md) |
| `POST /api/cofre` | Stores a key; `aplicar: true` restarts the agent in the same call | Owner, Key | [COFRE-POR-API.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/COFRE-POR-API.md) |
| `DELETE /api/cofre` | Revokes a stored key | Owner, Key | [COFRE.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/COFRE.md) |
| `POST /api/cofre/aplicar` | Restarts the agent to use the vault | Owner, Key | [COFRE-POR-API.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/COFRE-POR-API.md) |
| `GET /api/chaves-api` | Lists panel API keys | **Owner with session only**. Key receives 403 | [COFRE.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/COFRE.md) |
| `POST /api/chaves-api` | Creates an API key (value appears only in the response) | **Owner with session only** | [COFRE.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/COFRE.md) |
| `DELETE /api/chaves-api` | Revokes an API key (adds a date without deleting the record) | **Owner with session only** | [COFRE.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/COFRE.md) |
| `GET /api/provedor` | Agent provider, model and payment method | Owner, Key. Collab receives 403 | [PROVEDOR-NA-TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PROVEDOR-NA-TELA.md) |
| `POST /api/provedor` | Changes provider, model or payment method | Owner, Key | [PROVEDOR-NA-TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PROVEDOR-NA-TELA.md) |
| `GET /api/provedor/login` | AI account login state, with link and code | Owner, Key | [PROVEDOR-NA-TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PROVEDOR-NA-TELA.md) |
| `POST /api/provedor/login` | Starts account login | Owner, Key | [PROVEDOR-NA-TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PROVEDOR-NA-TELA.md) |
| `POST /api/provedor/login/codigo` | Submits the code returned by the account | Owner, Key | [PROVEDOR-NA-TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PROVEDOR-NA-TELA.md) |
| `DELETE /api/provedor/login` | Cancels login in progress | Owner, Key | [PROVEDOR-NA-TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PROVEDOR-NA-TELA.md) |
| `GET /api/uso` | This agent's subscription usage (5-hour and weekly windows) | Owner, Key | [PROVEDOR-NA-TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/PROVEDOR-NA-TELA.md) |
| `GET /api/tela` | Agent Screen state (remote browser) | Owner. Collab receives 403 | [TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/TELA.md) |
| `PUT /api/tela/senha` | Changes the Screen password | **Owner with session only**. Key receives 403 | [TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/TELA.md) |
| `GET /tela/novnc/*` | Screen noVNC client files | Owner | [TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/TELA.md) |
| `WS /tela/websockify` | Screen video channel. Key cannot open it | **Owner with session only** | [TELA.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/TELA.md) |

### Powers: Instagram and meetings {#poderes-instagram-e-reunioes}

Require the power installed; without it, the tab shows a lock and the route returns 423.

| Route | Purpose | Details |
| --- | --- | --- |
| `GET /api/posts` | Instagram posts (`instagram` power) | [POWER.md](https://github.com/DGatoM/DG-Claw/blob/main/powers/instagram/POWER.md) (describes the power; routes have no document) |
| `GET /api/posts/stats` | Post statistics | [POWER.md](https://github.com/DGatoM/DG-Claw/blob/main/powers/instagram/POWER.md) (describes the power; routes have no document) |
| `GET /api/comments/recent` | Recent comments | [POWER.md](https://github.com/DGatoM/DG-Claw/blob/main/powers/instagram/POWER.md) (describes the power; routes have no document) |
| `GET /api/followers/top` | Followers who interact most | [POWER.md](https://github.com/DGatoM/DG-Claw/blob/main/powers/instagram/POWER.md) (describes the power; routes have no document) |
| `GET /api/followers/stats` | Follower statistics | [POWER.md](https://github.com/DGatoM/DG-Claw/blob/main/powers/instagram/POWER.md) (describes the power; routes have no document) |
| `GET /api/reunioes` | Lists recorded meetings (`meetings` power) | [POWER.md](https://github.com/DGatoM/DG-Claw/blob/main/powers/meetings/POWER.md) (describes the power; routes have no document) |
| `GET /api/reunioes/:id` | Meeting details | [POWER.md](https://github.com/DGatoM/DG-Claw/blob/main/powers/meetings/POWER.md) (describes the power; routes have no document) |
| `GET /api/reunioes/:id/audio.wav` | Meeting audio | [POWER.md](https://github.com/DGatoM/DG-Claw/blob/main/powers/meetings/POWER.md) (describes the power; routes have no document) |

<!-- inventario:fim -->

## What is not here yet {#o-que-ainda-nao-esta-aqui}

Code items without dedicated documentation are in [pendencias.md](pendencias.md). Features not yet in `main` are in [em-desenvolvimento.md](em-desenvolvimento.md).
