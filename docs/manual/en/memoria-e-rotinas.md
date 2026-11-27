# Memory and routines {#memoria-e-rotinas}

This page explains how an agent remembers what the owner said and how it works without anyone talking to it:
file-based memory, search through past conversations, the panel's view of its brain, nighttime and morning routines,
pokes, reminders and scheduling. Each feature explains what it is, how to request it or where to select it,
what must be configured, its limits and what to do when something goes wrong.

First, one rule for the rest of this page: agent memory is text in files. There is no closed database. The panel
reads the same files the agent reads; when the owner saves a correction, it goes to the same place the agent reads.

## Memory layers {#as-camadas-da-memoria}

**What they are.** Each agent stores what it learns in four places inside its home.

| Layer | File | Contents | Who writes it |
| --- | --- | --- | --- |
| Daily notebook | `working-memory.md` | Owner goals, work in progress, what the agent knows about the owner and recent conversations | A routine rebuilds it every day at 7am; the agent adds to it throughout the day |
| Long-term record | `MEMORY.md` | Lasting information: name, preferences, people, rules | The agent during nighttime reflection |
| Who the owner is | `CREATOR.md` | Who the owner is to the agent | Created during installation; changed by the owner |
| Topic folders and journal | `memory/` | One journal entry per day (`AAAA-MM-DD.md`) and topic files (preferences, people, projects, research) | The agent when it learns something |

**How to request it.** "Note that I prefer meetings in the morning." "Remember when I mentioned Paulo's contract?"
The `memory` skill searches the past and manages memory.
**Where to view and correct it.** The panel's `aba:memory` tab lists all memory files as text the owner can read
and edit manually. The `aba:status` tab shows the working-memory card (whether it is current, its size, limit and
whether the 7am rebuild ran).
**Limits.** After saving a correction, the panel offers **Tell it now**, because the agent otherwise rereads the
file at the start of the next conversation. If the agent changed the file while the owner was editing, the server
refuses the save and leaves the owner's text in the editor. Owner memory is inside the agent's home; an invited
collaborator has read-only access.
**If something goes wrong.** A red or yellow working-memory card means the 7am rebuild did not run. Check
`aba:operations`. More information: [../../panel/docs/CEREBRO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/CEREBRO.md) and
[../../panel/docs/MEMORIA-DE-TRABALHO.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/MEMORIA-DE-TRABALHO.md).

## A view inside the brain {#o-raio-x-do-cerebro}

**What it is.** Brain is the panel's view of memory: in `aba:status`, "What it knows now" has one card per live
memory file, showing when it changed ("2 h ago"), who writes it and a preview. Selecting a card opens the complete
file in the reader, which also supports editing. The `aba:como` tab shows "How the agent works inside" alongside
that agent's actual numbers.
**Limits.** File contents are escaped before display, so no markup inside them executes on screen. The text in
`aba:como` comes from [../RADIOGRAFIA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/RADIOGRAFIA.md), written on 17 October and describing Claude only.
**If something goes wrong.** If the text is missing, the panel says it has not yet been installed for that agent
rather than showing a blank screen.

## Search past conversations {#busca-em-conversas-antigas}

**What it is.** The search behind "remember when I mentioned...". It searches past conversations and notes by
word and returns the excerpt with its date. It runs on the server itself, without internet access or a key.
**How to request it.** Ask naturally ("what did I say about the contract?"). The `memory` skill performs the search.
**Requirements.** None. A routine updates the index every 15 minutes and again during the 7am rebuild.
**Limits.** It finds words, not meaning. A message that stalled the agent and was set aside by safe mode does not
return through this route.
**If something goes wrong.** If search cannot find something that exists, the index may be stale, by up to one day.
Ask the Admin to check the routine in `aba:operations`.

## Semantic memory (search by meaning) {#memoria-semantica-busca-por-sentido}

**What it is.** Search that finds meaning: "when did I arrange to meet the bookkeeper?" finds a journal entry
that says "Paulo the accountant scheduled Thursday's meeting". It uses a small model running on the VPS itself,
without a key and without sending text outside.
**Status.** Partial. The code exists and reindexing routines (daily at 4:20am) are installed, but the DG Claw v1
installer does not download the model (333 MB). Without the model, reindexing only logs that it is disabled.
Anyone wanting this feature should ask the Admin to run `scripts/install-embedding-local.sh`. The statement in
[../MEMORIA-SEMANTICA.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/MEMORIA-SEMANTICA.md) that the installer includes the model was written for the old version.
**Limits.** Automatic recall of past information only works for Claude agents (see [provedores.md](provedores.md)).
**If something goes wrong.** The Admin runs `python3 scripts/memory_index/embedder.py status` inside the agent;
it reports which model is active and why.

## Nighttime and morning routines {#rotinas-da-noite-e-da-manha}

**What they are.** Scheduled tasks the server runs automatically so the agent does not forget what happened:

| Routine | When | What it does |
| --- | --- | --- |
| Reflection | At 11:30pm on days when the owner talked to the agent | The agent reviews the day, writes the journal, updates goals and tasks and revises its understanding of the owner if something changed. A day with no owner messages is skipped (recorded in the log and Pulse), with no journal for that day; when uncertain, it runs |
| Notebook rebuild | Every day at 7am | No AI involved: today's summary becomes "yesterday" and the notebook is prepared for the new day |
| Search index | Every 15 minutes | Updates conversation search |
| Semantic reindexing | Every day at 4:20am | Updates semantic memory (only when the model is installed) |
| Heartbeat | Every 30 minutes | The agent checks whether it has a reason to contact the owner (an outstanding task, deadline or promise). Without a reason, it remains quiet |
| Watchdog | Every 5 minutes | Checks that the agent session is still running and starts it again, waiting longer between attempts. If it does not recover, it stops trying and notifies the owner |
| Automatic compaction | Every 30 minutes | When the conversation grows large, asks the agent to save memory and compact |
| Receipt verification | Every 15 minutes | Checks whether pokes arrived and retries or notifies |
| Costs | Every 5 minutes and hourly | Records tokens and notifies when monthly spending exceeds 50, 75, 90 and 100% of the limit |

**Where to view them.** `aba:operations` shows each routine with a row of squares for recent runs: green means
success, red means failure, yellow needs attention, striped yellow means "did not run when scheduled", and gray
means "no data", which never counts as success. A sentence at the top summarizes: "Everything is working" or
"2 operations need attention".
**Requirements.** None; routines are installed with the agent. The watchdog and automatic compaction are disabled
when the agent configuration contains `DGCLAW_AUTO_RECOVERY=off`.
**Limits.** With Codex, pokes and heartbeat work; features that read Claude's recorded conversation (reflection,
daily notebook and search index) only work partially, and automatic compaction does not work yet (see
[provedores.md](provedores.md)). Cost notices require a dollar limit in panel configuration (`budgetUsd`); without
one, the panel does not invent a limit. Routine notifications are only delivered to the owner when Telegram or
another transport is configured: in standalone DG Claw, only the panel shows the problem.
**If something goes wrong.** `aba:operations` shows the failed routine and its log. More information:
[../../panel/docs/OPERACOES.md](https://github.com/DGatoM/DG-Claw/blob/main/panel/docs/OPERACOES.md) and
[../SAUDE-E-MODO-SEGURO.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/SAUDE-E-MODO-SEGURO.md).

## Pokes {#pokes}

**What they are.** A poke is a task a routine injects into the agent's live session instead of making a new AI
call. The routine prepares the deterministic work and the agent executes it there, using the subscription the
owner already pays for. Reflection, heartbeat and automatic compaction are pokes.
**How to know whether it worked.** A text poke ends with a receipt the agent records (`poke-ack.sh`); a compaction
command leaves a marker in the conversation. The `poke-verify` routine checks both every 15 minutes, retries
missing deliveries and notifies the owner when attempts are exhausted.
**Limits.** Injection only takes place when the session is idle; if the owner is in the middle of a turn, the poke waits.
**If something goes wrong.** More information: [../POKES.md](https://github.com/DGatoM/DG-Claw/blob/main/docs/POKES.md). That document describes keystroke
transport from an older design; today the message goes through the runner.

## Reminders {#lembretes}

Reminders that keep notifying until the owner confirms have their own section in
[conversa-e-telas.md](conversa-e-telas.md) and the `/lembretes` screen. The Web triggers them itself, independently
of the agent session.

## Scheduling: the agent's own appointments {#agenda-compromissos-do-proprio-agente}

**What it is.** The `agenda` skill schedules work for the agent on the server, such as "send me a summary every day
at 9am". It becomes a system timer that survives restarts and triggers automatically without anyone talking to the
agent. At the scheduled time, the agent receives a message it wrote itself and performs the work.
**How to request it.** "Send me a task summary every day at 9am." To be reminded of something, use a reminder;
scheduling is for the agent's work. The skill understands that "Chrome" and "crome" in audio can mean "cron".
**Where to view it.** `aba:rotinas` lists routines and reminders the agent scheduled at the owner's request,
with the next time and the result of the previous run. The list updates automatically.
**Limits.** Scheduled work lives on the server, not in the session: closing a conversation does not cancel it.
Scheduling something "only during this current task" uses a different mechanism.
**If something goes wrong.** If scheduled work does not trigger, the Admin checks its unit in `aba:operations`
and runs `dgclaw agente reparar <slug>`.

## Costs {#custos}

**What it is.** `aba:costs` shows the agent's monthly cost by category and routine against its configured limit.
Readings come from the live session's token record, updated by a routine every 5 minutes.
**Limits.** Only works for Claude agents. Subscription usage appears separately in the usage windows (see
[conversa-e-telas.md](conversa-e-telas.md)). For an API agent, actual spending also appears in the provider's dashboard.
