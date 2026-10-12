# Pokes e verificação de recibo (DG Claw)

Um **poke** é como um cron de vida faz o assistente trabalhar **dentro da sessão `--channels` viva**
(a mesma que serve o bot Telegram), na assinatura flat do dono, em vez de chamar `claude -p`
(que queima crédito de API). O cron faz o prep determinístico e *injeta* o trabalho na sessão; a
próprio assistente executa lá.

Este doc explica **os dois tipos de poke**, **como saber se um poke deu certo** (recibo) e
**como criar um cron novo** já com verificação.

---

## 1. Os dois tipos de poke: qual mecanismo usar

| Tipo | O que é | Transporte | Como se confirma que deu certo (recibo) |
|---|---|---|---|
| **Poke de texto (NL)** | uma tarefa em linguagem natural (reflexão, heartbeat, proatividade, self-cron) | `inject_session` → keystroke (TIOCSTI default / tmux) de `"leia <pokefile> e execute"` | **ACK explícito**: o assistente roda `poke-ack.sh` no fim (a instrução já vai no pokefile). Rede de segurança opcional: um **artefato** esperado (ex: `memory/<data>.md`) escrito após o envio. |
| **Comando de TUI** | um slash-command do Claude Code, ex `/compact` | keystroke de `"/compact"` (NÃO dá pra mandar por mensagem, slash-command não é mensagem) | **marcador no transcript**: `compact_boundary`. O `auto-compact.py` confere sozinho e alerta se não aparecer. |

> **Importante:** não existe transporte "relay" (mensagem real de Telegram que entra na fila do
> canal) neste plugin, isso depende de um userbot, que o plugin não embute. O transporte é sempre
> **keystroke**. A robustez vem da **camada de verificação** (abaixo), não do transporte: a
> verificação funciona igual independente de como o poke foi entregue.

### Por que a verificação é necessária
A injeção por keystroke só "pega" quando a sessão está **ociosa**. Se um turno do dono está em voo,
os keystrokes se perdem em silêncio. O plugin já tenta mitigar com guarda de ociosidade
(`--require-idle` no `inject.py`, `looks_idle` no auto-compact), mas isso só *adia*, não garante
que rodou. A camada de recibo fecha o ciclo: **confere, re-injeta e alerta**.

---

## 2. Como funciona a camada de recibo (ACK)

Arquivos (todos em `scripts/`):
- `_lib/poke_ledger.py`: o ledger: registra pendentes, grava recibos, lista. CLI + biblioteca.
- `poke-ack.sh`: o **assistente** roda no fim de um poke verificável (escreve o recibo).
- `poke-verify.py`: o **verificador** (timer 15min): varre pendentes vencidos, confere recibo,
  re-injeta, escala. **Determinístico, ZERO token LLM** (só lê arquivos).

Estado, sob `<workspace>/.dgclaw/pokes/`:
```
pending/<key>.json   poke aguardando recibo
done/<key>           marcador de sucesso (ACK ou artefato detectado)
failed/<key>.json    escalado (esgotou retries sem recibo), flag p/ build-wm/dono
acks.log             auditoria append-only
```

Ciclo de um poke verificável:
1. O cron exporta `DGCLAW_POKE_VERIFY=1` (+ opções) e chama `inject_session`.
2. `inject_session` anexa a instrução de ACK no pokefile **e** registra o pendente no ledger
   (mesmo se a sessão estiver ocupada e o poke for adiado, assim o verificador re-injeta depois).
3. O assistente executa e, no fim, roda `bash .../poke-ack.sh <slug> <key>` → grava `done/<key>`.
4. `poke-verify.py` (timer), ao vencer o prazo:
   - **recibo presente** (ACK ou artefato fresco) → resolve, fim.
   - **ausente, com retries** → roda o `retrigger` (re-injeta) e empurra o prazo.
   - **ausente, esgotado** → marca `failed/`, **alerta o dono** via `notify-owner.sh`.

---

## 3. Como criar um cron novo já verificado

### 3a. Cron de poke de texto (o caso comum)
No seu script de cron (`scripts/meu-cron.sh`), monte o `$PROMPT` e, **antes** de `inject_session`,
exporte as opções de verificação:

```bash
source "$PLUGIN/scripts/_lib/inject.sh"

export DGCLAW_POKE_VERIFY=1                       # liga o recibo
export DGCLAW_POKE_KEY="meu-cron-${TODAY}"        # chave estável por dia (default: <tag>-<data>)
export DGCLAW_POKE_ARTIFACT="memory/${TODAY}.md"  # opcional: artefato = recibo extra (rel ao ws)
export DGCLAW_POKE_DEADLINE_SEC=1500              # 1ª conferência ~25min após enviar
export DGCLAW_POKE_MAX_RETRIES=2                  # re-injeta até 2x
export DGCLAW_POKE_RETRY_INTERVAL_SEC=1200        # 20min entre tentativas
export DGCLAW_POKE_RETRIGGER="bash ${PLUGIN}/scripts/meu-cron.sh ${CONFIG}"  # como re-injetar

inject_session "$SLUG" meu-cron <<< "$PROMPT"
```

E o `$PROMPT` deve **instruir o assistente a deixar o artefato** (se você usar artefato), o
`poke-ack.sh` a própria `inject_session` adiciona automaticamente ao pokefile, o assistente só roda.

**Pegadinha da meia-noite:** se a chave/artefato dependem da data e a retentativa pode cruzar 00h,
fixe a data no `retrigger` (passe-a por env e leia-a no topo do script), como faz o `reflection.sh`:
```bash
TODAY="${MEU_CRON_DATE:-$(date +%F)}"
export DGCLAW_POKE_RETRIGGER="MEU_CRON_DATE=${TODAY} bash ${PLUGIN}/scripts/meu-cron.sh ${CONFIG}"
```

Por fim, registre o timer em `install-life-timers.sh` (uma linha na array `TIMERS[]`).

### 3b. Cron de comando de TUI (ex: outro slash-command)
Não use a camada de ACK (o assistente não "executa" um slash-command, então não tem como o assistente rodar o
ACK). Verifique pelo **efeito determinístico no transcript**, como o `auto-compact.py` faz com
`compact_boundary` (ver `had_compact_since`). Injete via `inject._inject_tiocsti`/`_inject_tmux`,
e num próximo ciclo confira o marcador; alerte o dono se não aparecer N vezes.

---

## 4. Diagnóstico rápido
```bash
# pendentes agora
python3 scripts/_lib/poke_ledger.py list --ws "$DGCLAW_WORKSPACE"
# só os vencidos (o verificador agiria nesses)
python3 scripts/_lib/poke_ledger.py list --ws "$DGCLAW_WORKSPACE" --due
# histórico de recibos / falhas
cat "$DGCLAW_WORKSPACE/.dgclaw/pokes/acks.log"
# falhas escaladas (flag p/ o dono / build-wm)
ls "$DGCLAW_WORKSPACE/.dgclaw/pokes/failed/"
# log do verificador
tail "$DGCLAW_WORKSPACE/.dgclaw/logs/poke-verify.log"
```
