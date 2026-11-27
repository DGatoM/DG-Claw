# Manual maintenance issues {#pendencias-do-manual}

This page lists DG Claw items that lack documentation or conflict with the code, for the manual's maintainers
to resolve. Base: `main` at commit `fcb79a6`. When an older document disagrees with this manual, follow the manual,
because it was checked against the code.

## Documents that contradict the code {#documentos-que-contradizem-o-codigo}

| Document | What it says | What the code does |
| --- | --- | --- |
| `templates/ambiente/admin.md` | The owner can also invite a collaborator through the API | `/api/v1/colaboradores` only accepts the owner's session. This will be addressed by Admin-created collaborators, [in development](em-desenvolvimento.md) |
| `web/docs/COLABORADORES.md`, `docs/BOLETINS-DE-SEGURANCA.md` | The Admin operates the Web routes | The Web only creates a session through the owner's cookie or an agent's mailbox, and the Admin has no mailbox |
| `docs/SEGURANCA.md` | Only Caddy's port is open | The installer opens ports 22, 80 and 443 |
| `docs/SEGURANCA.md` | Blocking after 10 incorrect passwords | That applies to direct panel login. Owner login uses 5 per account and 20 per IP |
| `docs/EMERGENCIA.md` | The scan route is available to agents | The route is owner-only; an agent receives 403 |
| `docs/MEMORIA-SEMANTICA.md`, `docs/MEMORY-HOOK.md` | The installer downloads the memory model | `install.sh` does not install the model |
| `docs/QUADRO-DE-AVISOS.md`, `docs/MEMORIA-SEMANTICA.md` | The `avisos.py` and `memory-recall.sh` hooks run for every message | I could not find them wired into agent creation. This needs checking on a server |
| `docs/POKES.md`, `docs/MEMORY-HOOK.md` | Delivery through keystrokes | Current DG Claw delivers through the runner |
| `docs/PROVEDORES.md` | Codex has no hooks | `docs/PARIDADE-CODEX.md` records native Codex hooks |
| `panel/public/js/app.js` (Sessions tab) | Permission decisions can only be made in DG Telegram | `panel/docs/SESSOES.md` describes decisions on the screen itself |
| `templates/ambiente/agente.md` | Instructs agents to use the `tela` and `canais` skills | Agent creation enables 14 skills, leaving these two out |

## Outdated documents {#documentos-desatualizados}

- `docs/RADIOGRAFIA.md` stopped at 17 October: it only discusses Claude and does not mention the Board, sessions,
  collaborators or Anonymize. It supplies the panel's `aba:como` text. Until it is revised, this manual's map
  serves as the overview.
- `docs/COMO-FUNCIONA.md`, `docs/SESSAO-PRINCIPAL.md` and `docs/CANAL-DG-CHAT.md` still describe Telegram as the main channel.
- `docs/PARIDADE-CODEX.md` contains old line numbers and an old base commit.
- The `doctor`, `importar`, `panel`, `service`, `uninstall`, `connect`, `report` and `powers` skills use vocabulary
  from the former plugin.

## No dedicated documentation {#sem-documento-proprio}

- Telegram channel: only the commands in the `canais` skill exist.
- Chat routes (`/api/v1/agents` and their subroutes) and several routes in each agent's panel: the
  [reference](referencia-admin.md) identifies them.
- Tutorial (`web/public/tour.js`).

## To check on a real server {#a-conferir-em-um-servidor-de-verdade}

- Routine notifications in an installation that only uses panel chat: `scripts/notify-owner.sh` depends on Telegram
  or another configured transport, so the owner may not receive these notifications.
- Tests that exist but are not included in `tests/rodar.sh`: `scripts/test-gmail-permissao.sh`,
  `scripts/test-canal-dgchat.sh`, `scripts/test-falas-personalidade.sh`, `scripts/test-teste-isolamento.sh`,
  `scripts/memory_index/test_conversas_fts.py`, `scripts/test_build_working_memory.py` and
  `scripts/test_auto_compact_assentar.py`.
