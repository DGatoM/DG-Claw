# Customize your DG Claw {#personalizar-o-seu-dg-claw}

You can ask the Admin to adjust whatever you need: a new skill, an agent's speaking style, a routine or a button.
There is one precaution: an official update replaces the program files completely, so a change made in the wrong
place disappears the next time you ask to "update DG Claw".

The complete guide, which the Admin reads before changing anything, is [PERSONALIZAR.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/PERSONALIZAR.md).
This summary covers the essentials.

## Where changes survive {#onde-a-mudanca-sobrevive}

In order of preference:

1. **Extension points that updates leave untouched.** New skills with their own names, an agent's identity and
   personality, the Admin's instructions (`CLAUDE.md` and `AGENTS.md`), agent routines, `web.env` lines and keys in
   the vault. The Admin can work directly here without a special procedure.
2. **A new, dedicated file on the `personalizacoes` branch.** A file unique to your installation rarely conflicts
   with the official version.
3. **Only as a last resort, edit a core file**, keeping the change small and isolated.

Every program change goes into the Admin's customization record (`PERSONALIZACOES.md`). That record lets the update
check whether your change overlaps with the new version.

## System-level changes: allowed, with a warning {#mudanca-no-nivel-do-sistema-pode-com-aviso}

You can request changes to DG Claw's foundations, such as a new way to create agents or an adjustment to the
`dgclaw` command, installer or `runner/`. The agreement is:

1. The Admin explains in plain language that the request affects the foundations and could cause trouble during future updates.
2. If you still want the change, the Admin makes it on the `personalizacoes` branch.
3. The Admin records in `PERSONALIZACOES.md` that the change affects the foundations.
4. At every update, it tries to keep both working. If it cannot, it stops and explains the overlap before putting
   the change live.

## What remains out of bounds, even on request {#o-que-continua-fora-mesmo-a-pedido}

- The vault and secrets (runner tokens, proxy secrets and each agent's vault).
- The firewall and network rules.
- Panel authentication (login, password hash and first-access link).
- Container isolation (the `container/` folder).
- Security hooks and isolation tests.

If a request touches any of these, the Admin explains the risk and proposes another approach. The reasons are in
[seguranca.md](seguranca.md).

## Related commands {#comandos-relacionados}

| Command | Purpose |
| --- | --- |
| `sudo dgclaw personalizacoes levantar` | Lists customizations: record, clone, installer copies and Admin conversations |
| `sudo dgclaw personalizacoes conferir` | Checks the record against the new version and reports overlaps. Changes nothing |
| `sudo dgclaw personalizacoes concluir` | Marks the pending inventory as complete |
| `sudo dgclaw atualizar --simular` | Shows, among other things, how customizations overlap with the new version |

## If something goes wrong {#se-der-erro}

- The update stopped because a customization overlaps with the new version: the Admin resolves each conflict,
  keeping the official improvement and reapplying your change on top. See [atualizar-e-backup.md](atualizar-e-backup.md).
- A factory skill you asked to change reverted: the installer rebuilds the skills it supplies. Ask for a new skill
  with its own name.
