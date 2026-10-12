# Thread Hook: thread real do canal + working-memory na 1a msg (opt-in, default OFF)

Numa DM do assistente (sessao `--channels` viva), ANTES de o assistente responder, este hook
`UserPromptSubmit` injeta como `additionalContext`:

1. **A THREAD REAL DO CANAL**, as ultimas N mensagens que o dono esta vendo no Telegram, em
   ordem, INCLUINDO o que os crons postaram pra ele. Resolve o bug recorrente do "pode
   resumir → qual post?": o assistente ancora no ultimo poke de cron que entrou no meio da
   sessao, enquanto o dono se refere ao que apareceu no chat dele. Os dois passam a ler a
   mesma coisa.
2. **A WORKING-MEMORY COMPLETA (só na 1a mensagem de cada sessao)**, bloco
   "📌 WORKING-MEMORY COMPLETA". Sessao nova/rotacionada nascia sem as pendencias e o assistente
   perguntava "qual projeto?" sobre algo de ontem, porque o protocolo economico so le o
   header. Com isto a sessao nasce sabendo tudo; nos turnos seguintes vale o diff de header.

Script: `scripts/inject-telegram-thread.py`. Backport generalizado do hook homonimo da Isa
(sem nada hardcoded: paths/slug/janela por env `DGCLAW_*`). Reusa `scripts/_lib/thread_log.py`
(o mesmo extrator que o `auto-compact.py` usa no restart-com-carry-over).

---

## Como funciona (pipeline)

1. **Gates** (qualquer um falha → `exit 0`, nada injetado):
   - `DGCLAW_THREAD_HOOK=1` (opt-in; default OFF)
   - `DGCLAW_PRIVATE_CONTEXT=1` (so contexto privado do dono)
   - prompt e uma mensagem REAL do canal (`<channel source="...">` no inicio), poke de
     cron/heartbeat/permission-reply nao dispara.
2. Se e a **1a msg desta sessao** (`session_id` inedito no state file), monta o bloco WM
   completa (cap de `DGCLAW_THREAD_WM_MAX_CHARS`) e marca a sessao ANTES de devolver (se o
   turno falhar/retry, perde-se 1 injecao em vez de injetar milhares de tokens em loop).
3. Reconstroi a thread do transcript vivo via `thread_log.build_thread_log` (dono inbound +
   envios do assistente, marcados direta/cron), filtra pela **janela recente**, mescla o
   **outbound log opcional**, ordena por tempo real e pega as **ultimas N**.
4. Emite `hookSpecificOutput.additionalContext` com os blocos. Senao, stdout vazio.

**REGRA DE OURO:** nunca quebra a DM. Todo caminho de erro/ausencia → `exit 0` sem output.

---

## Gates e parametros (envs)

| Env | Default | Efeito |
|-----|---------|--------|
| `DGCLAW_THREAD_HOOK` | `0` (OFF) | `=1` liga o hook. Default desligado. |
| `DGCLAW_PRIVATE_CONTEXT` | `0` | `=1` so em sessao PRIVADA do dono (DM). Spawns publicos (ronda/post) nao setam → nada injetado (a thread e a WM podem conter conteudo pessoal). |
| `DGCLAW_THREAD_INJECT_N` | `10` | quantas mensagens da thread injetar. |
| `DGCLAW_THREAD_INJECT_WINDOW_H` | `8` | janela recente (horas) para considerar as mensagens. |
| `DGCLAW_THREAD_INJECT_MAX_CHARS` | `320` | truncagem por mensagem. |
| `DGCLAW_THREAD_WM_MAX_CHARS` | `60000` | trava de seguranca do bloco WM completa. |
| `DGCLAW_THREAD_WM_KEEP_SESSIONS` | `20` | quantas sessoes lembrar no state (poda as mais antigas). |
| `DGCLAW_THREAD_WM_STATE` | `<ws>/.dgclaw/logs/hook-thread-wm-sessions.json` | state das sessoes ja injetadas. |
| `DGCLAW_OUTBOUND_LOG` |, (opcional) | jsonl do que os crons postaram FORA da sessao viva. Ver nota abaixo. |
| `DGCLAW_WORKING_MEMORY` | `<ws>/working-memory.md` ou `<ws>/persona/working-memory.md` | caminho da working-memory. |
| `DGCLAW_CHANNEL_SOURCE` | `plugin:telegram:telegram` | marca do `<channel source="...">` do inbound. |
| `DGCLAW_CHANNEL_NAME` | `dgclaw-<slug>` | customTitle da sessao (fallback pra achar o transcript). |
| `DGCLAW_SESSION_DIR` | `~/.claude/projects/<ws com '/'→'-'>` | dir dos transcripts `.jsonl`. |
| `DGCLAW_SLUG` | `agente` | slug (deriva o `--name` do canal). |

Envs herdadas do `.dgclaw/config.sh` (passado como 1o argv ou `DGCLAW_CONFIG`):
`DGCLAW_WORKSPACE`, `DGCLAW_SLUG`, etc. O hook faz um parse leve do config (linhas
`KEY=VALUE`) e injeta no ambiente sem sobrescrever o que ja existe.

Log: `<ws>/.dgclaw/logs/hook-telegram-thread.log`.

---

## Nota: outbound log dos crons (diferenca pro DG Claw base)

Nos assistentes do autor, os crons postam via um script próprio que grava um arquivo `*-outbound.jsonl`, a
fonte que o hook mescla pra pegar posts de cron que NAO passam pela tool de reply da sessao.

No DG Claw, os crons falam com o dono via `scripts/notify-owner.sh` (Bot API direto), que
**nao grava outbound log**. Consequencias:

- Envios do assistente que passam pela **tool de reply da sessao viva** (resposta direta e a
  maioria dos pokes de cron, que executam DENTRO da sessao) APARECEM na thread, o
  `thread_log` os extrai do transcript. Esse e o caminho principal e cobre o caso do bug.
- Mensagens postadas por processo **totalmente separado** (`notify-owner.sh`) so entram na
  thread se voce apontar `DGCLAW_OUTBOUND_LOG` pra um jsonl no formato
  `{"ts": "<local ISO>", "text": "...", "kind": "text", "source": "cron"}` e fizer o cron
  anexar uma linha ali ao enviar. Sem isso, o hook simplesmente ignora (degrada gracioso) -
  nada quebra, apenas essas linhas nao aparecem na thread injetada.

---

## Como LIGAR

### 1. Registrar o hook no `settings.json` do workspace

```sh
bash "$DGCLAW_PLUGIN_ROOT/scripts/install-thread-hook.sh" "$WS/.dgclaw/config.sh"
# remover:  ... install-thread-hook.sh "$WS/.dgclaw/config.sh" --off
```

O instalador escreve, em `<ws>/.claude/settings.json`, um `UserPromptSubmit` apontando pro
hook com paths absolutos (idempotente; rerodar nao duplica). Nao edita o dgclaw-plugin.

### 2. Exportar os gates no launch da sessao viva

No script que sobe o `claude --channels` do assistente, ANTES de subir o `claude`:

```sh
export DGCLAW_THREAD_HOOK=1
export DGCLAW_PRIVATE_CONTEXT=1      # SO na sessao privada do dono (DM)
```

Sem essas flags o hook sai 0 na hora (inerte), nao muda o comportamento de instalacoes
existentes.

---

## Garantias de seguranca

- **Nunca quebra a DM**: todo caminho de erro/ausencia faz `exit 0` sem output.
- **Default OFF**: sem `DGCLAW_THREAD_HOOK=1`, nao faz nada.
- **So privado**: sem `DGCLAW_PRIVATE_CONTEXT=1`, nao injeta thread nem working-memory.
- **Só antes de msg real do dono**: pokes de cron/heartbeat nao disparam a injecao.
- **WM 1x por sessao**: marca a sessao ANTES de devolver → sem loop de re-injecao em retry.
