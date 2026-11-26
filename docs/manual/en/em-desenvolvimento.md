# In development {#em-desenvolvimento}

This page is the manual's waiting list. It lists features the team is building that **are not yet in `main`**.
Nothing below is a promise: the name, behavior and even the existence of each item may change before release.

When an item reaches `main`, it leaves this page and is documented on the appropriate manual page (collaborators
and agents, security, or screens), with its route or command in the [Admin reference](referencia-admin.md).
The `bash tests/docs-em-dia/rodar.sh` test reports when this happens: a new feature in the code without documentation
fails the check until someone documents it in the right place. That is why the technical names below are written
as words rather than complete paths or commands, so they do not count as "documented" prematurely.

Until an item arrives, do not promise it to a customer. To find out what exists today, read
[o-que-nao-faz.md](o-que-nao-faz.md).

## Collaborator created by the Admin {#colaborador-criado-pelo-admin}

**Not yet in `main`; subject to change.**

Today, only the owner can invite a collaborator, through the collaborators screen (agent menu, "Invite collaborator"),
because the invitation routes only accept the owner's browser session. The work in progress would also let the Admin
send invitations through a server command called `dgclaw colaborador`, with actions to create, list, resend an
invitation and revoke access.

What does not change: the collaborator still has access to one agent only, never to the Admin, and still cannot
access the vault, API keys, AI account or channel credentials. See [o-que-nao-faz.md](o-que-nao-faz.md).

## Face ID (the lock) {#face-id-o-cadeado}

**Not yet in `main`; subject to change.**

Face ID access is planned, with a screen called the lock and API routes of the same name. Today, that screen and
those routes do not exist in `main`: dashboard access is password-only, as described in [seguranca.md](seguranca.md).
No further details are confirmed.
