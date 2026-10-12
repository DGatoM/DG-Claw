#!/usr/bin/env python3
"""auto-compact.py (DG Claw) — Auto-compacta a sessao --channels VIVA da persona
quando o contexto passa de um teto, sem reiniciar nem intervencao manual.

A sessao viva e a MESMA que serve o canal (claude --channels ... --name dgclaw-<slug>,
subida pelo dgclaw-<slug>.service). Quando o contexto cresce, o motor compacta sozinho
no limite duro — mas isso costuma cair NO MEIO de um turno e custa caro/lento. Este cron
antecipa: estima o tamanho do contexto lendo o transcript .jsonl da sessao e, se passar
de DGCLAW_COMPACT_THRESHOLD, INJETA "/compact" na sessao viva (via _lib/inject, NUNCA
claude -p — assim a sumarizacao roda na assinatura FLAT do dono, sem queimar credito API).

Generalizado pro contrato DG Claw: ZERO hardcode de persona/paths. Tudo por env DGCLAW_*.

Salvaguardas:
  - COOLDOWN (DGCLAW_COMPACT_COOLDOWN_MIN, default 20min) gravado em state file: o
    /compact demora ~min pra baixar o contexto; sem cooldown o cron re-dispararia em cima.
  - So injeta quando a sessao parece OCIOSA (ultimo evento do transcript = assistant, e
    nenhuma escrita recente no .jsonl). Compactar no meio de um turno atrapalha a resposta.
  - A ociosidade tem ESCALADA (20/08/2026): a espera encolhe conforme o contexto passa do
    teto (quente = 1/4 da espera, critico = compacta mesmo com turno em voo). Sem isso, numa
    conversa viva a checagem adiava TODO ciclo e o contexto subia sem teto.
  - SEGUNDO PLANO (25/09/2026, modo restart): subagente assincrono ou Bash em background
    sem aviso de termino segura o restart nos niveis normal e quente. No critico reinicia e
    o poke leva a lista do que morreu. Logo antes do restart a sessao e conferida de novo.
  - POKE DE RETOMADA (20/08/2026): se a compactacao pegou tarefa pela metade, o script
    fotografa o que a persona estava fazendo, grava num arquivo e manda ela retomar depois
    que a compactacao assenta. Sem isso ela acorda muda e o dono tem que repetir o pedido.
  - Degrada gracioso: sessao morta / sem transcript / sem usage -> no-op (exit 0).
  - Notifica o dono (curto, opcional) que compactou — desliga com DGCLAW_COMPACT_NOTIFY=0.

Threshold (DGCLAW_COMPACT_THRESHOLD) aceita:
  - fracao 0<f<=1   -> fracao do limite do modelo (DGCLAW_CONTEXT_LIMIT, default 200000).
                       Ex.: 0.70 -> compacta a 70% do limite.
  - numero > 1      -> teto absoluto em tokens. Ex.: 400000.
  Default: 0.70 (= 70% do limite).

Modos (DGCLAW_COMPACT_MODE):
  inject   (default) injeta "/compact" na sessao viva via _lib/inject (bunker/TIOCSTI/tmux).
           Preserva a sessao; ideal onde a injecao funciona (painel, tmux, ou TIOCSTI vivo).
           No modo bunker (card do painel ou agente de runner proprio) o painel enfileira o
           /compact e entrega quando o card fica ocioso, entao inject e SEMPRE o modo certo la:
           o terminal e do supervisor, e reiniciar seria matar a sessao do cliente.
  restart  RESTART-COM-CARRY-OVER: grava um bloco de carry-over (log canonico da thread
           do canal) no working-memory.md e da `systemctl restart` na unit da sessao. A
           sessao volta history-zero (~base) e relê o working-memory no boot. Use em hosts
           onde a injecao NAO funciona (kernel legacy_tiocsti=0 + sem tmux, sessao sob
           expect/script). Verifica pela saude do systemd (PID novo + active estavel).

           ⚠️ PRE-REQUISITO, e o erro mais caro de cometer aqui: o modo restart SO baixa
           o contexto se o launcher da sessao subir SEM `--resume`. E o caso da Isa e do
           outros agentes pessoais (`claude --channels ...`), onde reiniciar nasce sessao nova. NAO e o
           caso de supervisor que guarda o sessionId e retoma: o agent-runner do DG Claw
           monta `claude --resume <sessionId>` no boot, entao restart ali MATA O TERMINAL
           DO CLIENTE e a sessao volta com o MESMO contexto (custo alto, beneficio zero).
           Antes de ligar restart, confira o comando real: `ps -eo args | grep claude`.
           Se aparecer `--resume`, restart NAO serve; o caminho e inject com transporte
           que escreva no PTY (slash-command digitado no terminal executa; mensagem de
           canal chega como texto e nao executa).

Env:
  DGCLAW_WORKSPACE              raiz do workspace da persona (default: cwd).
  DGCLAW_SLUG                   slug da persona (lock, --name default, state). Default "agente".
  DGCLAW_CHANNEL_NAME          override do --name alvo (default dgclaw-<slug>).
  DGCLAW_COMPACT_MODE          "inject" (default) ou "restart". Ver "Modos" acima.
  DGCLAW_CHANNEL_SERVICE       (modo restart) unit da sessao. Default dgclaw-<slug>.service.
  DGCLAW_WORKING_MEMORY        (modo restart) caminho do working-memory.md. Default
                                 <ws>/working-memory.md ou <ws>/persona/working-memory.md.
  DGCLAW_CARRYOVER_THREAD_N    (modo restart) nº de msgs da thread no carry-over. Default 14.
  DGCLAW_SESSION_DIR           dir dos transcripts .jsonl (default ~/.claude/projects/<enc>).
  DGCLAW_COMPACT_THRESHOLD     fracao (<=1) ou tokens absolutos (>1). Default 0.70.
  DGCLAW_CONTEXT_LIMIT         limite de contexto do modelo, p/ fracao. Default 200000.
  DGCLAW_COMPACT_COOLDOWN_MIN  minutos de cooldown pos-compact. Default 20.
  DGCLAW_COMPACT_IDLE_SEC      quietude minima do transcript p/ considerar ocioso. Default 45.
  DGCLAW_COMPACT_STATE         state file (cooldown). Default <ws>/.dgclaw/logs/.<slug>-compact-state.json
  DGCLAW_COMPACT_NOTIFY        "0" desliga a notificacao ao dono. Default ligado.
  DGCLAW_COMPACT_HOT_FACTOR    multiplo do teto que liga o nivel "quente" (espera cai
                                 pra 1/4). Default 2.0. Vale a regua que disparar antes:
                                 esta, ou 40% da folga entre teto e limite.
  DGCLAW_COMPACT_CRITICAL_FACTOR multiplo do teto que liga o nivel "critico" (compacta
                                 mesmo com turno em voo). Default 3.0. Idem: ou 75% da folga.
  DGCLAW_COMPACT_RESUME_POKE   "0" desliga o poke de retomada. Default ligado.
  DGCLAW_RESUME_POKE_WAIT_S    (modo restart) segundos de espera antes de acordar a sessao
                                 nova pro poke. Default 25.
  DGCLAW_RESUME_POKE_TTL_MIN   (modo inject) minutos que o poke pendente espera a
                                 compactacao assentar antes de ser descartado. Default 60.
  DGCLAW_COMPACT_SETTLE_WAIT_S (modo inject) segundos que o run que injetou o /compact
                                 espera o recibo pra mandar o "Voltei" na hora. Default 600;
                                 0 deixa o fechamento pro proximo ciclo do timer.
  DGCLAW_INJECT_CMD            comando do HOST pra escrever na sessao viva, quando nenhum
                                 transporte do plugin funciona (TIOCSTI morto + sem tmux +
                                 sem Bunker). Vence tiocsti/tmux. Destrava o modo inject
                                 nesses hosts, e serve tambem pro poke de retomada (uma env
                                 so). Placeholders {text}, {text_json}, {file}; o comando
                                 tambem recebe o texto no STDIN e em DGCLAW_POKE_TEXT.
                                 No agent-runner do DG Claw voce NAO precisa desta env: ele
                                 fala o protocolo do painel, entao o modo bunker (abaixo) ja
                                 resolve, e resolve pros 13 timers, nao so pra este.
                                 Se ainda assim quiser um comando, use ASPAS SIMPLES no corpo:
                                   curl -sf --noproxy '*' -X POST 127.0.0.1:4311/api/agents/<id>/input \
                                     -H 'Content-Type: application/json' \
                                     -d '{"text": {text_json}}'
                                 Com aspas duplas o bash cola as aspas que o {text_json} traz e
                                 o payload sai invalido no primeiro texto com espaco.
                                 ⚠️ O `-f` do curl NAO e enfeite. Sem ele o curl sai 0 mesmo
                                 com HTTP 500, e ai o rodar_comando_de_host devolve 0, o
                                 send_resume_poke diz que deu certo e o handler APAGA o poke
                                 pendente. Perdeu o envio uma vez, calou para sempre. Com -f
                                 o curl sai != 0, isto devolve 7, o pendente fica e tenta no
                                 ciclo seguinte. Vale pra qualquer transporte que voce puser
                                 aqui: ele PRECISA falhar alto quando nao entregou.
                                 ⚠️ NAO ponha "injectWhenIdle": true aqui. A fila de ocioso do
                                 runner tem UMA VAGA (promptQuandoIdle em sessao.ts) e cada
                                 novo enfileiramento APAGA o anterior, sem avisar. O /compact
                                 se repete a cada ciclo, entao um despejo se cura sozinho; o
                                 poke de retomada dispara UMA VEZ, e despejo ali e perda
                                 definitiva. E redundante de qualquer forma: este script so
                                 escreve na sessao depois de ja ter decidido que ela esta
                                 ociosa (looks_idle), ou de proposito no nivel critico, onde
                                 esperar e justamente o que nao se quer.
  DGCLAW_INJECT_MODE           "bunker" | "tiocsti" (default) | "tmux". Resolvido pelo
                                 _lib/inject: ter DGCLAW_BUNKER_CARD definido ja liga o
                                 bunker sozinho. Ver DGCLAW_BUNKER_CARD/URL no _lib/inject.py.
  DGCLAW_RESUME_POKE_ENVELOPE  "auto" (default) embrulha o poke em <plataforma> quando a
                                 persona usa o canal dgchat; "plataforma" forca; "none" manda
                                 cru. Sem isso, no agente entregue o hook stop-force-reply le
                                 o poke como a PESSOA falando e cobra resposta pelo canal.
  DGCLAW_RESUME_POKE_CMD       comando do host pra entregar o poke quando a injecao do
                                 plugin nao funciona (TIOCSTI morto, sem tmux, sem Bunker).
                                 Placeholders: {file} = caminho do arquivo do poke (texto),
                                 {text} = mensagem pronta, {text_json} = a mesma mensagem
                                 como string JSON (com aspas). O comando tambem recebe a
                                 mensagem no STDIN e nas envs DGCLAW_POKE_FILE/DGCLAW_POKE_TEXT.
                                 Ex. (runner proprio, POST /api/agents/<id>/input) — de novo
                                 com aspas SIMPLES no corpo, pelo mesmo motivo de cima:
                                   curl -sf --noproxy '*' -X POST 127.0.0.1:4311/api/agents/<id>/input \
                                     -H 'Content-Type: application/json' \
                                     -d '{"text": {text_json}}'

  DGCLAW_NAME                  nome da persona (so pra mensagem ao dono).

CLI:
  auto-compact.py                       checa e compacta se acima do teto
  auto-compact.py --dry-run             so reporta, NAO injeta
  auto-compact.py --threshold 0.6       override do teto (fracao ou tokens)
  auto-compact.py --force               ignora cooldown e checagem de ociosidade
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# reusa a lib de injecao do plugin (NAO reimplementar TIOCSTI/identificacao da sessao)
sys.path.insert(0, str(Path(__file__).resolve().parent / "_lib"))
import inject as inj  # noqa: E402  (is_session_alive, channel_name, find_pts, acquire_lock, _inject_tiocsti, lock_key)


def log(m):
    ts = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] auto-compact: {m}", flush=True)


# ─── resolucao de env (contrato DG Claw) ─────────────────────────────────────

def env(name, default=""):
    return os.environ.get(name, default)


def resolve_workspace() -> Path:
    return Path(env("DGCLAW_WORKSPACE") or os.getcwd()).resolve()


def resolve_slug() -> str:
    return env("DGCLAW_SLUG") or "agente"


def resolve_session_dir(workspace: Path) -> Path:
    override = env("DGCLAW_SESSION_DIR")
    if override:
        return Path(override).resolve()
    encoded = str(workspace).replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded


def resolve_logs_dir(workspace: Path) -> Path:
    # Mesma resolucao do watchdog.py: honra ambos os aliases (com e sem S). Se nao,
    # admin customiza DGCLAW_LOG_DIR e o state file vai parar em lugar que o doctor nao acha.
    override = env("DGCLAW_LOGS_DIR") or env("DGCLAW_LOG_DIR")
    if override:
        return Path(override).resolve()
    return workspace / ".dgclaw" / "logs"


def resolve_state_file(workspace: Path, slug: str) -> Path:
    override = env("DGCLAW_COMPACT_STATE")
    if override:
        return Path(override).resolve()
    # Nome ALINHADO com auto-compact.sh e doctor.sh (.auto-compact-state.json). Se divergir,
    # o doctor checa um arquivo e o cron grava outro -> o cooldown "some" do diagnostico.
    return resolve_logs_dir(workspace) / ".auto-compact-state.json"


def resolve_threshold(cli_threshold) -> int:
    """Resolve o teto absoluto em tokens. Aceita fracao (<=1) do CONTEXT_LIMIT ou tokens (>1)."""
    raw = cli_threshold if cli_threshold is not None else env("DGCLAW_COMPACT_THRESHOLD", "0.70")
    try:
        val = float(raw)
    except (TypeError, ValueError):
        val = 0.70
    try:
        limit = int(float(env("DGCLAW_CONTEXT_LIMIT", "200000")))
    except (TypeError, ValueError):
        limit = 200000
    if val <= 1.0:
        return int(limit * val), limit, val
    return int(val), limit, None


# ─── descoberta do transcript da sessao viva ──────────────────────────────────

def find_live_transcript(session_dir: Path, channel: str):
    """O .jsonl da sessao --channels VIVA, identificado por customTitle == channel.

    NAO usa mtime como criterio (outro arquivo no mesmo dir pode ter mtime mais novo e
    mascarar a sessao real ociosa-mas-inchada). Varre do mais recente pro mais antigo
    so pra ordem de tentativa; o match e SEMPRE por customTitle. Retorna None se nao achar.
    """
    if not session_dir.exists():
        return None
    files = list(session_dir.glob("*.jsonl"))
    if not files:
        return None
    for p in sorted(files, key=lambda f: f.stat().st_mtime, reverse=True)[:80]:
        try:
            with p.open() as f:
                for i, line in enumerate(f):
                    if i > 8:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        if json.loads(line).get("customTitle") == channel:
                            return p
                    except Exception:
                        continue
        except Exception:
            continue
    return None


def resolve_live_transcript(session_dir: Path, slug: str, channel: str):
    """O .jsonl da sessao viva, pelo caminho certo pra cada mundo.

    Sessao --channels: o match e por customTitle == channel, o contrato do launch.sh.
    Card do painel (Bunker ou runner proprio): a sessao NAO tem --name no argv, entao
    customTitle nunca bate e a busca voltava vazia — o auto-compact virava no-op eterno
    num agente que nunca compacta. La o id da sessao vem do proprio painel, que e a fonte
    da verdade, e quem sabe perguntar isso e o _lib/inject."""
    if inj.resolve_mode() == "bunker":
        achado = inj.live_transcript(slug, channel)
        return Path(achado) if achado else None
    return find_live_transcript(session_dir, channel)


def context_tokens(transcript: Path) -> int:
    """Tokens vivos no contexto = ultimo usage assistant do transcript (igual ao /context).

    Soma input + cache_creation + cache_read (o output da resposta NAO conta pro contexto
    de entrada do proximo turno; o que infla o contexto e o que volta como input/cache)."""
    last = None
    try:
        with transcript.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") == "assistant":
                    u = (o.get("message") or {}).get("usage")
                    if isinstance(u, dict):
                        last = u
                elif o.get("subtype") == "compact_boundary":
                    # Conserto 06 (Lara/Marina/Luna, 05/10/2026): logo depois de compactar, o
                    # ultimo usage ainda e o de ANTES. Sem isto o vigia via 200k pra sempre e
                    # injetava /compact a cada ciclo ("Not enough messages to compact"). Vale
                    # o tamanho pos-compactacao ate a proxima resposta trazer um usage novo.
                    pos = (o.get("compactMetadata") or {}).get("postTokens")
                    last = {"input_tokens": pos} if isinstance(pos, int) else None
    except Exception:
        return 0
    if not last:
        return 0
    return (
        (last.get("input_tokens") or 0)
        + (last.get("cache_creation_input_tokens") or 0)
        + (last.get("cache_read_input_tokens") or 0)
    )


def looks_idle(transcript: Path, idle_sec: int) -> bool:
    """Heuristica de ociosidade: a sessao NAO esta no meio de um turno.

    True quando:
      - o transcript nao foi escrito ha pelo menos `idle_sec` segundos (turno em voo escreve
        chunks continuamente), E
      - o ULTIMO evento do transcript e do tipo 'assistant' (turno terminou) — se for 'user'
        sem resposta ainda, a persona pode estar processando -> NAO compacta agora.
    Em duvida, retorna False (conservador: melhor adiar o /compact que atropelar um turno)."""
    try:
        mtime = transcript.stat().st_mtime
    except OSError:
        return False
    if (time.time() - mtime) < idle_sec:
        return False
    last_type = None
    try:
        with transcript.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                t = o.get("type")
                if t in ("user", "assistant"):
                    # Mesma regra da ponte (inject._tipo_de_turno, BL-426): depois de um
                    # /compact o transcript termina em linhas 'user' que nao sao turno de
                    # ninguem (resumo, meta, eco do comando local). Contar isso como "user
                    # sem resposta" segurava o "Voltei" ate a persona responder alguem.
                    last_type = inj._tipo_de_turno(o, t, last_type)
    except Exception:
        return False
    return last_type == "assistant"


_CHANNEL_TAG = re.compile(r"^<channel\b[^>]*>\s*", re.S)
_CHANNEL_END = re.compile(r"\s*</channel>\s*$", re.S)
_META_TYPES = {"last-prompt", "custom-title", "agent-name", "mode", "permission-mode",
               "attachment", "summary"}


def escalation_marks(threshold: int, limit: int):
    """A partir de que contexto a espera encolhe (quente) e some (critico).

    Duas reguas, vale a que disparar PRIMEIRO:
      a) multiplo do teto: 2x (quente) e 3x (critico). Serve pra teto absoluto baixo
         num modelo de janela grande (ex.: teto 150k num modelo de 1M).
      b) distancia ate o limite duro: 40% e 75% do que sobra entre teto e limite.
         Serve pro caso comum do plugin, em que o teto ja e 70% do limite e nao
         existe "2x o teto" dentro da janela.
    Sem isso a escalada nunca dispararia numa das duas configuracoes."""
    try:
        hot_f = float(env("DGCLAW_COMPACT_HOT_FACTOR", "2.0"))
        crit_f = float(env("DGCLAW_COMPACT_CRITICAL_FACTOR", "3.0"))
    except (TypeError, ValueError):
        hot_f, crit_f = 2.0, 3.0
    folga = max(0, limit - threshold)
    hot = min(threshold * hot_f, threshold + folga * 0.40)
    crit = min(threshold * crit_f, threshold + folga * 0.75)
    if crit < hot:
        crit = hot
    return int(hot), int(crit)


def _blocks(o):
    c = (o.get("message") or {}).get("content")
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    if isinstance(c, list):
        return [b for b in c if isinstance(b, dict)]
    return []


def _is_channel_msg(text):
    return isinstance(text, str) and text.lstrip().startswith("<channel")


def _strip_channel(text):
    t = _CHANNEL_TAG.sub("", text.strip())
    return _CHANNEL_END.sub("", t).strip()


def turn_snapshot(transcript: Path, max_scan: int = 600) -> dict:
    """Olha o FIM do transcript e responde: a compactacao vai pegar uma tarefa pela
    metade? E o que a persona estava fazendo?

    Considera "no meio":
      - ultimo evento e assistant com tool_use (ferramenta em voo)
      - ultimo evento e user com tool_result (resultado voltou, resposta nao saiu)
      - ultimo evento e mensagem do dono sem nenhuma resposta depois
    Turno fechado (system/turn_duration, ou assistant so com texto) NAO conta.
    O resultado alimenta o poke de retomada: sem ele a persona acorda muda e o dono
    precisa repetir o pedido (caso real: gestor parado 13h depois de um compact)."""
    snap = {"busy": False, "pending_tool": None, "pending_request": False,
            "last_user_msg": None, "last_assistant_text": None, "tools": []}
    try:
        lines = Path(transcript).read_text().splitlines()[-max_scan:]
    except Exception as e:
        log(f"turn_snapshot: nao li {transcript}: {e}")
        return snap

    evts = []
    for l in lines:
        try:
            o = json.loads(l)
        except Exception:
            continue
        if o.get("type") in _META_TYPES:
            continue
        evts.append(o)
    if not evts:
        return snap

    last = None
    for o in reversed(evts):
        t = o.get("type")
        if t == "system":
            if o.get("subtype") == "turn_duration":
                last = o
                break
            continue
        last = o
        break

    if last is not None:
        t = last.get("type")
        if t == "assistant":
            tu = [b for b in _blocks(last) if b.get("type") == "tool_use"]
            if tu:
                snap["busy"] = True
                snap["pending_tool"] = tu[-1].get("name")
        elif t == "user":
            bs = _blocks(last)
            if any(b.get("type") == "tool_result" for b in bs):
                snap["busy"] = True
            else:
                txt = "\n".join(b.get("text") or "" for b in bs if b.get("type") == "text")
                if txt.strip() and _is_channel_msg(txt):
                    snap["busy"] = True
                    snap["pending_request"] = True

    for o in reversed(evts):
        if snap["last_user_msg"] and snap["last_assistant_text"]:
            break
        t = o.get("type")
        if t == "user" and not snap["last_user_msg"]:
            txt = "\n".join(b.get("text") or "" for b in _blocks(o) if b.get("type") == "text")
            if _is_channel_msg(txt):
                snap["last_user_msg"] = _strip_channel(txt)[:800]
        elif t == "assistant" and not snap["last_assistant_text"]:
            txt = "\n".join(b.get("text") or "" for b in _blocks(o) if b.get("type") == "text")
            if txt.strip():
                snap["last_assistant_text"] = txt.strip()[:800]

    tools, seen, ordered = [], set(), []
    for o in evts[-40:]:
        if o.get("type") == "assistant":
            for b in _blocks(o):
                if b.get("type") == "tool_use" and b.get("name"):
                    tools.append(b["name"])
    for n in reversed(tools):
        if n not in seen:
            seen.add(n)
            ordered.append(n)
        if len(ordered) >= 6:
            break
    snap["tools"] = ordered
    return snap


_NOTIF_RE = re.compile(r"<task-id>([A-Za-z0-9_-]+)</task-id>(.*?)</task-notification>", re.S)
_SUMMARY_RE = re.compile(r"<summary>(.*?)</summary>", re.S)


def background_tasks(transcript: Path) -> list:
    """Trabalho que ainda vai ACORDAR a sessão: tarefa em segundo plano sem aviso de
    término, ou aviso que já chegou na fila e ela ainda não leu.

    Conserto de 25/09/2026, trazido da Isa, em duas rodadas. So importa no modo restart:
    o /compact injetado nao mata processo. O turn_snapshot só enxerga o turno: ela
    dispara trabalho em segundo plano, diz "te mando assim que sair" e FECHA o turno.
    Para o snapshot ela está parada, o idle-guard libera e o restart mata o trabalho
    junto com a sessão. Casos reais do mesmo dia: 17:15 (espera do treino), 18:15
    (subagente das animações de um agente) e 20:40 (Monitor do render da aula, com o
    aviso "renders terminaram" parado na fila havia 30s, sem ela ter lido).

    O que conta como vivo, lido na ORDEM do transcript:
      - Bash com run_in_background: `toolUseResult.backgroundTaskId`;
      - Agent assíncrono: `toolUseResult.agentId` com `isAsync`;
      - Monitor: `toolUseResult.taskId` (só quando a ferramenta é Monitor, porque o
        TaskUpdate usa a mesma chave para a lista de tarefas, que não roda nada);
      - SendMessage que REATIVA subagente já terminado: `resumedAgentId` volta a
        pender, mesmo com aviso de término antigo no arquivo.
    O que encerra: `<task-notification>` do id COM `<status>`. O Monitor manda um
    aviso por evento, sem status, e esse não encerra; só o fim do stream encerra.
    TaskStop/KillShell também encerra. O aviso pode aparecer só como
    `queue-operation`, por isso a busca é na linha crua, não em message.content.

    Fila: todo `queue-operation` enqueue com horário DEPOIS da última fala dela é
    coisa que chegou e ela não respondeu. Contar enqueue contra dequeue/remove NÃO
    serve: às 20:40 o aviso entrou e saiu da fila no mesmo segundo ("remove") e
    mesmo assim ela nunca chegou a responder.

    Passou de DGCLAW_COMPACT_BG_MAX_AGE_MIN (180) sem aviso, é órfã e não segura (senão uma perdida
    travava a dieta para sempre). Devolve [{id, tipo, descricao, idade_min}]."""
    try:
        max_age = float(env("DGCLAW_COMPACT_BG_MAX_AGE_MIN", "180"))
    except (TypeError, ValueError):
        max_age = 180.0
    try:
        stale_min = float(env("DGCLAW_COMPACT_SUBAGENT_STALE_MIN", "45"))
    except (TypeError, ValueError):
        stale_min = 45.0
    estado, fila, ultima_fala = {}, [], ""
    desc_by_use, name_by_use = {}, {}
    try:
        with transcript.open() as f:
            for line in f:
                # término (qualquer lugar da linha, inclusive dentro de queue-operation)
                if "<task-notification>" in line:
                    for tid, corpo in _NOTIF_RE.findall(line.replace("\\n", "\n")):
                        if "<status>" in corpo and tid in estado:
                            estado[tid]["vivo"] = False
                if ('"tool_use"' not in line and '"toolUseResult"' not in line
                        and '"queue-operation"' not in line and '"assistant"' not in line):
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") == "queue-operation":
                    if o.get("operation") == "enqueue":
                        txt = str(o.get("content") or "")
                        m = _SUMMARY_RE.search(txt)
                        fila.append({"ts": o.get("timestamp") or "",
                                     "descricao": (m.group(1) if m else txt)[:140]})
                    continue
                if o.get("type") == "assistant" and o.get("timestamp"):
                    ultima_fala = max(ultima_fala, o["timestamp"])
                for b in _blocks(o):
                    if b.get("type") == "tool_use":
                        inp = b.get("input") or {}
                        desc_by_use[b.get("id")] = str(inp.get("description")
                                                       or inp.get("command") or "")[:140]
                        name_by_use[b.get("id")] = b.get("name")
                        if b.get("name") in ("TaskStop", "KillShell"):
                            for k in ("task_id", "shell_id", "id"):
                                if inp.get(k) and str(inp[k]) in estado:
                                    estado[str(inp[k])]["vivo"] = False
                tur = o.get("toolUseResult")
                if not isinstance(tur, dict):
                    continue
                use_id = next((b.get("tool_use_id") for b in _blocks(o)
                               if b.get("type") == "tool_result"), None)
                ferramenta = name_by_use.get(use_id)
                tid = tipo = None
                if tur.get("backgroundTaskId"):
                    tid, tipo = tur["backgroundTaskId"], "comando em segundo plano"
                elif tur.get("isAsync") and tur.get("agentId"):
                    tid, tipo = tur["agentId"], "subagente"
                elif ferramenta == "Monitor" and tur.get("taskId"):
                    tid, tipo = tur["taskId"], "monitor"
                elif tur.get("resumedAgentId"):
                    tid, tipo = tur["resumedAgentId"], "subagente reativado"
                if not tid:
                    continue
                desc = tur.get("description") or desc_by_use.get(use_id) or ""
                if tipo == "subagente reativado" and str(tid) in estado:
                    desc = desc or estado[str(tid)]["descricao"]
                estado[str(tid)] = {"id": str(tid), "tipo": tipo, "vivo": True,
                                    "descricao": desc or "(sem descrição)",
                                    "ts": o.get("timestamp")}
    except Exception as e:
        log(f"background_tasks: nao li {transcript}: {e}")
        return []

    itens = [t for t in estado.values() if t["vivo"]]
    itens += [{"id": "fila", "tipo": "aviso na fila, ainda não lido",
               "descricao": q["descricao"], "ts": q["ts"]}
              for q in fila if q["ts"] > ultima_fala]
    now = datetime.now(timezone.utc)
    vivas = []
    for t in itens:
        idade = None
        try:
            idade = (now - datetime.fromisoformat(t["ts"].replace("Z", "+00:00"))).total_seconds() / 60
        except Exception:
            pass
        # So viva e fresca segura o restart. Orfa (sem aviso ha max_age) e subagente
        # cuja conversa propria parou de mudar ha stale_min (travado; caso de 25/09 na
        # Isa: parou 22:57 e segurou a dieta ate 01:30) NAO seguram, mas continuam na
        # lista por 24h, porque o poke precisa contar que ficou coisa devendo.
        if idade is not None and idade > 24 * 60:
            continue
        t["idade_min"], t["segura"], t["motivo"] = idade, True, ""
        # Subagente tem sinal de vida proprio (a conversa dele), entao vale ele e NAO a
        # idade: na Isa, em 27 e 28/09, dois treinos de RL de mais de 3h, escrevendo 2 a
        # 8 min antes, foram cortados pela regra de idade. A idade fica so pro que nao tem
        # sinal de vida (comando em segundo plano, monitor, fila).
        parado = None
        if t["tipo"].startswith("subagente"):
            conversa = transcript.parent / transcript.stem / "subagents" / f"agent-{t['id']}.jsonl"
            try:
                parado = (time.time() - conversa.stat().st_mtime) / 60
            except OSError:
                pass
        if parado is not None:
            if parado > stale_min:
                t["segura"] = False
                t["motivo"] = f"parou de trabalhar ha {parado:.0f} min, provavelmente travado"
        elif idade is not None and idade > max_age:
            t["segura"], t["motivo"] = False, f"sem aviso ha {idade:.0f} min, provavelmente perdida"
        vivas.append(t)
    return vivas


def _resumo_bg(bg: list) -> str:
    return "; ".join(f"{t['tipo']} '{t['descricao'][:60]}'" for t in bg)


def had_compact_since(session_dir: Path, iso_ts: str) -> bool:
    """True se algum transcript tem um marcador de compactacao (compact_boundary /
    isCompactSummary) com timestamp posterior a iso_ts. E o RECIBO deterministico de que
    o /compact realmente rodou — o equivalente, pro auto-compact, do ACK dos pokes de texto.
    (Sem isto a injecao de /compact era cega: se a sessao estava ocupada, o keystroke se
    perdia e ninguem sabia.)"""
    try:
        cutoff = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except Exception:
        return False
    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=timezone.utc)
    if not session_dir.exists():
        return False
    for p in sorted(session_dir.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)[:20]:
        try:
            if datetime.fromtimestamp(p.stat().st_mtime, timezone.utc) < cutoff:
                continue
        except OSError:
            continue
        try:
            with p.open() as f:
                for line in f:
                    if "compact" not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue
                    is_boundary = (o.get("subtype") == "compact_boundary"
                                   or o.get("isCompactSummary")
                                   or (o.get("type") == "system"
                                       and "compact" in str(o.get("subtype", ""))))
                    if not is_boundary:
                        continue
                    ts = o.get("timestamp")
                    if not ts:
                        return True  # marcador em arquivo tocado pos-cutoff
                    try:
                        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        if t.tzinfo is None:
                            t = t.replace(tzinfo=timezone.utc)
                        if t > cutoff:
                            return True
                    except Exception:
                        pass
        except OSError:
            continue
    return False


# ─── state (cooldown) ─────────────────────────────────────────────────────────

def load_state(state_file: Path) -> dict:
    try:
        return json.loads(state_file.read_text())
    except Exception:
        return {}


def save_state(state_file: Path, st: dict):
    try:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = state_file.with_suffix(state_file.suffix + ".tmp")
        tmp.write_text(json.dumps(st, indent=2))
        tmp.replace(state_file)
    except Exception as e:
        log(f"aviso: nao consegui gravar state {state_file}: {e}")


def cooldown_remaining(st: dict, cooldown_min: int) -> float:
    """Minutos restantes de cooldown (0 se ja pode disparar)."""
    last = st.get("last_compact_ts")
    if not last:
        return 0.0
    try:
        then = datetime.fromisoformat(last)
    except Exception:
        return 0.0
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    elapsed = (datetime.now(timezone.utc) - then.astimezone(timezone.utc)).total_seconds() / 60
    return max(0.0, cooldown_min - elapsed)


# ─── notificacao opcional ao dono ─────────────────────────────────────────────

def notify_owner(msg: str):
    if env("DGCLAW_COMPACT_NOTIFY", "1") == "0":
        return
    notifier = Path(__file__).resolve().parent / "notify-owner.sh"
    if not notifier.exists():
        return
    try:
        subprocess.run(["bash", str(notifier), msg],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=30, check=False)
    except Exception as e:
        log(f"aviso: notify-owner falhou: {e}")


# ─── injecao do /compact (reusa _lib/inject) ──────────────────────────────────

def inject_compact(slug: str, channel: str, dry_run: bool) -> int:
    """Injeta '/compact' na sessao viva. Wrapper fino de inject_text (mantido pelo nome
    porque outros scripts e a doc chamam assim)."""
    return inject_text(slug, channel, "/compact", dry_run)


def rodar_comando_de_host(cmd_tmpl: str, text: str, path=None, dry_run: bool = False,
                          rotulo: str = "comando de host") -> int:
    """Entrega `text` a sessao usando um comando do HOST, em vez dos transportes do plugin.

    Existe porque em host sem TIOCSTI, sem tmux e sem Bunker o plugin fica sem nenhuma
    alavanca sobre a sessao viva, mas o supervisor local costuma ter uma (ex.: o
    agent-runner do DG Claw expoe POST /api/agents/<id>/input, que escreve direto no PTY
    de que ele e dono). Slash-command digitado no PTY EXECUTA; mensagem de canal chega
    como texto e nao executa. Por isso o transporte de host destrava o modo inject.

    Placeholders: {text}, {text_json} (string JSON, com aspas), {file} (se houver arquivo).
    O comando tambem recebe o texto no STDIN e nas envs DGCLAW_POKE_TEXT/DGCLAW_POKE_FILE."""
    cmd = (cmd_tmpl.replace("{text_json}", json.dumps(text))
                   .replace("{file}", str(path) if path else "")
                   .replace("{text}", text))
    if dry_run:
        log(f"DRY-RUN — rodaria {rotulo}: {cmd}")
        return 0
    amb = dict(os.environ, DGCLAW_POKE_TEXT=text, DGCLAW_POKE_FILE=str(path or ""))
    try:
        r = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True,
                           timeout=120, input=text, env=amb)
        if r.returncode == 0:
            log(f"despachado pelo {rotulo} (o comando saiu 0; isso prova que o transporte "
            f"aceitou, NAO que o texto chegou na sessao)")
            return 0
        log(f"{rotulo} saiu {r.returncode}: {(r.stderr or '').strip()[:200]}")
        return 7
    except Exception as e:
        log(f"erro rodando {rotulo}: {e}")
        return 7


def inject_text(slug: str, channel: str, text: str, dry_run: bool) -> int:
    """Injeta um texto qualquer na sessao viva: comando de host (DGCLAW_INJECT_CMD), painel
    (bunker), TIOCSTI (default) ou tmux. Reusa a logica de _lib/inject pra achar o pts, pegar
    o lock por-slug e injetar. Retorna 0 (ok), 2 (sessao morta), 3 (sem permissao), 4 (sem
    lock), 5 (transporte falhou), 7 (comando de host falhou)."""
    # Comando de host vence os demais: configurar essa env ja e um ato explicito, e ela so
    # existe em host onde os transportes nativos nao funcionam.
    cmd_host = env("DGCLAW_INJECT_CMD")
    if cmd_host:
        return rodar_comando_de_host(cmd_host, text, dry_run=dry_run,
                                     rotulo="DGCLAW_INJECT_CMD")
    # O modo sai do _lib (inj.resolve_mode), e nao de uma leitura propria da env: ter um card
    # configurado ja diz qual e o mundo, e ler DGCLAW_INJECT_MODE por conta fazia este script
    # cair no tiocsti (e reportar "sessao morta") em host onde todos os outros timers estavam
    # falando com o painel sem problema nenhum.
    mode = inj.resolve_mode()
    key = inj.lock_key(slug, channel)

    if mode == "bunker":
        # A sessao viva e um card do painel do Bunker, ou um agente de runner proprio, que fala
        # o mesmo protocolo HTTP. Nao ha pts pra disputar nem lock por-slug a pegar: o painel
        # e o dono do terminal e ENFILEIRA o texto ate o card ficar ocioso. Quem sabe digitar
        # la e o _lib/inject; aqui so delegamos, pra existir um lugar so com essa conversa.
        if not inj.is_session_alive(slug, channel):
            return 2
        if dry_run:
            log(f"DRY-RUN (bunker) — injetaria {text!r} no card {inj._bunker_card()}")
            return 0
        ok, motivo = inj._inject_bunker(text, True)
        if not ok:
            log(f"falha ao injetar no card {inj._bunker_card()}: {motivo}")
            return 5
        log(f"{text!r} entregue ao card {inj._bunker_card()} ({motivo})")
        return 0

    if mode == "tmux":
        if not inj.is_session_alive(slug, channel):
            return 2
        if dry_run:
            log(f"DRY-RUN (tmux) — injetaria {text!r} em {channel}")
            return 0
        lock = inj.acquire_lock(key)
        if lock is None:
            return 4
        try:
            time.sleep(2)
            inj._inject_tmux(slug, text)
            time.sleep(2)
        except Exception as e:
            log(f"falha ao injetar via tmux: {e}")
            return 5
        finally:
            inj.fcntl.flock(lock, inj.fcntl.LOCK_UN)
            lock.close()
        return 0

    pid, pts = inj.find_pts(channel)
    if not pts:
        return 2
    if dry_run:
        log(f"DRY-RUN (tiocsti) — injetaria {text!r} em {pts} (pid {pid})")
        return 0
    lock = inj.acquire_lock(key)
    if lock is None:
        return 4
    try:
        time.sleep(2)
        try:
            # Enter separado, como no _lib/inject (02/10/2026): texto longo chega em rajada,
            # o TUI trata como colagem e o \r grudado no fim vira parte dela.
            inj._inject_tiocsti(pts, text)
            time.sleep(1.0)
            inj._inject_tiocsti(pts, "\r")
        except PermissionError:
            return 3
        time.sleep(4)
    except Exception as e:
        log(f"falha ao injetar via tiocsti em {pts}: {e}")
        return 5
    finally:
        inj.fcntl.flock(lock, inj.fcntl.LOCK_UN)
        lock.close()
    log(f"{text!r} injetado em {pts} (pid {pid})")
    return 0


# ─── modo RESTART-COM-CARRY-OVER (TIOCSTI-independente) ───────────────────────
# Em hosts onde a injecao na sessao viva nao funciona (kernel com
# dev.tty.legacy_tiocsti=0 E sem tmux: ex. sessao sob `expect`/`script`), o /compact
# injetado vira TEXTO colado e NUNCA executa — o contexto nunca baixa. A unica alavanca
# confiavel ai e `systemctl restart` do servico da sessao: o launch NAO usa --resume, entao
# a sessao volta history-zero (~base) e a continuidade vem do working-memory.md, que o
# CLAUDE.md manda reler no boot. Antes de reiniciar, gravamos no working-memory um bloco
# CARRY-OVER com o LOG CANONICO da thread do canal (o que o dono VE), pra a sessao fresca
# acordar sabendo a conversa recente. Opt-in via DGCLAW_COMPACT_MODE=restart.

CARRYOVER_START = "<!-- DG-ALIVE-CARRYOVER START (auto-compact) -->"
CARRYOVER_END = "<!-- DG-ALIVE-CARRYOVER END -->"


def resolve_compact_mode() -> str:
    """'restart' (restart-com-carry-over) ou 'inject' (/compact via _lib/inject, default).
    Default 'inject' pra nao mudar o comportamento de instalacoes existentes; quem roda em
    host com TIOCSTI morto e sem tmux deve setar DGCLAW_COMPACT_MODE=restart."""
    return (env("DGCLAW_COMPACT_MODE", "inject") or "inject").strip().lower()


def resolve_channel_service(slug: str) -> str:
    """Nome da unit systemd da sessao --channels viva. Override por
    DGCLAW_CHANNEL_SERVICE; default segue o contrato do DG Claw: dgclaw-<slug>.service."""
    return env("DGCLAW_CHANNEL_SERVICE") or f"dgclaw-{slug}.service"


def resolve_working_memory(workspace: Path) -> Path:
    """working-memory.md da persona — o carregador de continuidade que a sessao fresca
    rele no boot. Mesma resolucao do reflection.sh: env, <ws>/working-memory.md, ou
    <ws>/persona/working-memory.md."""
    override = env("DGCLAW_WORKING_MEMORY")
    if override:
        return Path(override).resolve()
    flat = workspace / "working-memory.md"
    persona = workspace / "persona" / "working-memory.md"
    if flat.exists():
        return flat
    if persona.exists():
        return persona
    return flat


def _load_thread_log():
    """Importa _lib/thread_log.py (degrada gracioso se faltar)."""
    try:
        import thread_log  # _lib ja esta no sys.path (igual ao inject)
        return thread_log
    except Exception as e:
        log(f"aviso: nao consegui importar thread_log: {e}")
        return None


def build_carryover_block(channel: str, ctx: int, threshold: int, reason: str = None) -> str:
    """Monta o bloco CARRY-OVER: nota de restart + log canonico da thread do canal."""
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    name = env("DGCLAW_NAME") or "voce"
    if reason is None:
        reason = (f"Reiniciada em {now} porque o contexto cruzou {ctx // 1000}k "
                  f"(teto {threshold // 1000}k).")
    try:
        last_n = int(float(env("DGCLAW_CARRYOVER_THREAD_N", "14")))
    except (TypeError, ValueError):
        last_n = 14

    tl = _load_thread_log()
    thread_md = ""
    if tl:
        try:
            sess = tl.find_session(channel)
            if sess:
                events = tl.build_thread_log(sess, last=last_n)
                thread_md = tl.format_md(events)
        except Exception as e:
            log(f"aviso: falha ao montar thread log: {e}")
    if not thread_md:
        thread_md = "_(thread recente indisponivel neste restart)_"

    return f"""{CARRYOVER_START}
## 🔄 Carry-over — acordei agora

*{reason}
Voce e a MESMA {name} — so esta com a sessao fresca pra rodar leve. Continue de onde parou
usando esta working-memory + o diario de hoje.*

**Thread recente do canal (o que o dono VE, em ordem).** Mensagens curtas dele
("sim", "pode resumir", "e ai?") se referem as MAIS RECENTES daqui — inclusive as que
seus crons postaram (marcadas *via cron*). Resolva o referente contra esta thread ANTES de
responder; so pergunte "qual?" se ela realmente nao permitir inferir:

{thread_md}
{CARRYOVER_END}"""


def write_carryover(workspace: Path, channel: str, ctx: int, threshold: int,
                    dry_run: bool = False, reason: str = None) -> str:
    """Insere/atualiza o bloco CARRY-OVER no fim do working-memory.md (idempotente:
    substitui o bloco gerenciado anterior). Devolve o texto do bloco."""
    block = build_carryover_block(channel, ctx, threshold, reason=reason)
    wm = resolve_working_memory(workspace)
    if dry_run:
        log(f"DRY-RUN — carry-over montado ({len(block)} chars), NAO escrevi em {wm}")
        return block
    try:
        body = wm.read_text() if wm.exists() else ""
        if CARRYOVER_START in body and CARRYOVER_END in body:
            pre = body.split(CARRYOVER_START)[0].rstrip()
            post = body.split(CARRYOVER_END, 1)[1].lstrip("\n")
            body = (pre + "\n" + post).rstrip()
        body = body.rstrip() + "\n\n" + block + "\n"
        wm.parent.mkdir(parents=True, exist_ok=True)
        tmp = wm.with_suffix(wm.suffix + ".tmp")
        tmp.write_text(body)
        tmp.replace(wm)
        log(f"carry-over escrito em {wm}")
    except Exception as e:
        log(f"aviso: falha ao escrever carry-over em {wm}: {e}")
    return block


def service_main_pid(svc: str) -> int:
    try:
        out = subprocess.run(["systemctl", "show", svc, "-p", "MainPID", "--value"],
                             capture_output=True, text=True, timeout=15).stdout.strip()
        return int(out) if out.isdigit() else 0
    except Exception:
        return 0


def pid_da_sessao(svc: str, channel: str = None) -> int:
    """PID que prova "sessao nova subiu", para QUALQUER tipo de unidade.

    Conserto de 16/09/2026, vindo de um caso real na Isa. O MainPID sozinho so serve
    para unidade `Type=simple`. Unidade `Type=forking` com `RemainAfterExit=yes` (o
    ExecStart e um `tmux new-session -d`, que devolve na hora) faz o systemd reportar
    **MainPID=0 SEMPRE**, entao a condicao `new_pid != old_pid` nunca podia ser
    verdadeira: o verificador esperava 90 segundos e gritava "nao confirmei boot" com o
    servico active e a sessao no ar.

    E isso nao era so barulho: `restart_and_verify` devolvia False e o `if ok` la embaixo
    ENGOLIA o poke de retomada. Um alarme errado cancelando a retomada de uma tarefa viva.

    O analogo honesto do MainPID, quando ele e 0, e o PID do processo `claude` daquele
    canal, que e exatamente o que o _lib/inject ja sabe achar."""
    pid = service_main_pid(svc)
    if pid:
        return pid
    if channel:
        try:
            achado, _pts = inj.find_pts(channel)
            return int(achado) if achado else 0
        except Exception:
            pass
    return 0


def restart_and_verify(svc: str, before_ctx: int, dry_run: bool = False,
                       channel: str = None) -> bool:
    """Reinicia o servico e VERIFICA pela SAUDE do systemd (MainPID novo + active estavel),
    NAO pelo contexto do transcript.

    Por que nao medir contexto pos-restart: a sessao fresca de --channels fica OCIOSA
    esperando a 1a mensagem do canal e NAO materializa transcript ate la. Medir contexto
    logo apos cai no .jsonl velho (morto) e da falso-negativo. Como o launch nao usa
    --resume, um MainPID novo e estavel == sessao fresca == contexto resetado (comeca em
    ~base na 1a atividade). Essa e a prova confiavel."""
    if dry_run:
        log(f"DRY-RUN — reiniciaria {svc} e verificaria saude (PID novo + active estavel)")
        return True

    old_pid = pid_da_sessao(svc, channel)
    try:
        subprocess.run(["systemctl", "restart", svc], check=True, timeout=60,
                       capture_output=True)
    except Exception as e:
        log(f"falha no systemctl restart {svc}: {e}")
        notify_owner(f"dieta-contexto: falha ao reiniciar {svc}. "
                     f"Contexto seguia em {before_ctx // 1000}k.")
        return False

    log(f"{svc} reiniciado (pid antigo {old_pid}) — verificando boot (ate 90s)...")
    deadline = time.monotonic() + 90
    stable_since = None
    while time.monotonic() < deadline:
        time.sleep(6)
        try:
            active = subprocess.run(["systemctl", "is-active", svc],
                                    capture_output=True, text=True, timeout=15).stdout.strip()
        except Exception:
            active = "unknown"
        new_pid = pid_da_sessao(svc, channel)
        # Sem PID nos DOIS lados, nao da pra comparar nada. Antes isso virava False, e
        # o False engolia o poke. Agora, se o servico esta active e estavel, a gente
        # aceita dizendo EXATAMENTE o que foi e o que nao foi provado: nao cancelar a
        # retomada de uma tarefa viva vale mais do que a prova que nao da pra ter.
        sem_pid = (old_pid == 0 and new_pid == 0)
        if active == "active" and (sem_pid or (new_pid and new_pid != old_pid)):
            if stable_since is None:
                stable_since = time.monotonic()
            elif time.monotonic() - stable_since >= 10:
                if sem_pid:
                    log(f"sessao no ar ({svc} active e estavel). NAO consegui ler PID de "
                        f"sessao nem pelo MainPID nem pelo canal, entao o reset do contexto "
                        f"nao esta provado, so o servico. Sigo em frente: engolir o poke de "
                        f"retomada por falta de prova e pior que a falta de prova.")
                else:
                    log(f"sessao fresca no ar (pid {new_pid}, active, estavel). "
                        f"Contexto resetado — comeca em ~base na 1a msg do canal.")
                return True
        else:
            stable_since = None
    final_active = subprocess.run(["systemctl", "is-active", svc],
                                  capture_output=True, text=True).stdout.strip()
    log(f"aviso: nao confirmei boot estavel pos-restart (is-active={final_active})")
    notify_owner(f"dieta-contexto: reiniciei {svc} mas nao confirmei boot estavel "
                 f"(is-active={final_active}). Da uma conferida.")
    return False


# ─── poke de retomada (compactou no meio de tarefa) ───────────────────────────
# Compactar (ou reiniciar) no meio de um turno faz a persona acordar MUDA: o dono fica
# esperando uma resposta que nunca vem e precisa repetir o pedido. Caso real: um gestor
# ficou 13h parado depois de um compact. Aqui a gente fotografa o que ela estava fazendo,
# escreve num arquivo e, depois que a compactacao assenta, manda ela ler e retomar.

def resume_poke_enabled() -> bool:
    return (env("DGCLAW_COMPACT_RESUME_POKE", "1") or "1").strip().lower() not in ("0", "off", "no")


def write_resume_poke(workspace: Path, slug: str, snap: dict, ctx: int, dry_run: bool):
    """Escreve o arquivo que a persona vai LER depois da compactacao pra retomar."""
    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d-%H%M%S")
    path = resolve_logs_dir(workspace) / f".{slug}-retomada-{stamp}.txt"
    pedido = snap.get("last_user_msg") or "(nao consegui recuperar o pedido do transcript)"
    ultima = snap.get("last_assistant_text") or "(voce nao tinha falado nada ainda sobre isso)"
    # MODO DE SEGURANCA: este recado e digitado na sessao e cita o ultimo pedido ao pe da
    # letra. Se ele for (ou repetir) a mensagem que travou o agente, o recado vira o veneno.
    # O que esta em quarentena nao e citado, e o recado lembra o que nao fazer.
    aviso_seguro = ""
    if _modo_seguro(workspace):
        try:
            import quarentena  # noqa: WPS433  (mora em _lib, ja no sys.path)
            regras = quarentena.carregar(workspace)
        except Exception as e:  # noqa: BLE001  na duvida, nao cita nada
            log(f"poke de retomada: quarentena ilegivel ({e}); nao cito o pedido nem a resposta")
            regras = None
        # A resposta a um pedido em quarentena sai junto: era o agente falando do veneno.
        pedido_fora = regras is None or regras.texto_bloqueado(pedido)
        if pedido_fora:
            pedido = "(fora deste recado: esta em quarentena pelo modo de seguranca)"
        if pedido_fora or regras.texto_bloqueado(ultima):
            ultima = "(fora deste recado: esta em quarentena pelo modo de seguranca)"
        aviso_seguro = """
MODO DE SEGURANCA LIGADO: nao abra nem leia transcripts de conversas anteriores (.jsonl
em ~/.claude/projects), nao abra .dgclaw/quarentena e nao reprocesse audios, anexos ou
transcricoes de antes do reinicio. Retome so o que esta neste recado e na working-memory.
"""
    tools = ", ".join(snap.get("tools") or []) or "(nenhuma registrada)"
    if snap.get("pending_request"):
        estado = ("O dono tinha acabado de te pedir uma coisa e voce AINDA NAO tinha "
                  "comecado a responder quando a compactacao entrou.")
    elif snap.get("pending_tool"):
        estado = (f"Voce estava com a ferramenta {snap['pending_tool']} EM VOO quando a "
                  "compactacao entrou. O resultado dela se perdeu.")
    elif snap.get("busy"):
        estado = ("Voce estava no meio do turno (resultado de ferramenta tinha voltado, "
                  "mas sua resposta nao chegou a sair) quando a compactacao entrou.")
    else:
        estado = ("Seu turno estava fechado, mas voce tinha trabalho rodando em segundo "
                  "plano (lista abaixo). O restart MATOU esse trabalho: o aviso de termino "
                  "nunca vai chegar.")
    bg = snap.get("killed_bg") or []
    if bg:
        linhas = "\n".join(f"  - {t['tipo']}: {t['descricao']}"
                           + (f" ({t['motivo']})" if t.get("motivo") else "") for t in bg)
        estado += f"""

TRABALHO EM SEGUNDO PLANO QUE O RESTART INTERROMPEU:
{linhas}
Confira no disco o que cada um chegou a produzir. O que nao terminou, relance
(subagente de novo com o mesmo objetivo, comando de novo) e entregue o que tinha
prometido ao dono."""

    corpo = f"""[retomada-poscompact] stamp={stamp} contexto_antes={ctx // 1000}k persona={slug}

IDEMPOTENCIA: se voce JA concluiu isto e JA avisou o dono, NAO refaca. Responda so o
que ficou pronto e pare. Antes de repetir qualquer passo, CONFIRA no disco, no log ou
no servico se o trabalho ja foi feito: a compactacao pode ter pego so a sua resposta,
nao a execucao.

Sua sessao foi compactada agora pra aliviar o contexto, que estava em {ctx // 1000}k.
Voce e a MESMA persona, so com a sessao leve.

{estado}

ULTIMO PEDIDO DO DONO:
---
{pedido}
---

A ULTIMA COISA QUE VOCE TINHA FALADO:
---
{ultima}
---

FERRAMENTAS QUE VOCE VINHA USANDO: {tools}
{aviso_seguro}
O QUE FAZER AGORA, NESTA ORDEM:
1. Se a pessoa mandou alguma coisa e AINDA esta esperando resposta, responda ELA
   primeiro, nem que seja uma linha dizendo que voce esta terminando. Recado de
   maquina (este aqui) nao passa na frente de gente esperando.
2. Verifique o que ja ficou pronto antes de repetir qualquer passo.
3. Retome de onde parou e conclua a tarefa.
4. Responda o dono no canal com o resultado, dizendo numa linha que houve compactacao
   no meio (pra ele entender qualquer emenda estranha).
Se o pedido acima nao permitir inferir a tarefa, pergunte curto e direto, uma pergunta
so. Nao invente tarefa que nao esta aqui.
"""
    if dry_run:
        log(f"DRY-RUN — poke de retomada montado ({len(corpo)} chars), NAO escrevi")
        return path
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(corpo)
        log(f"poke de retomada escrito em {path}")
    except Exception as e:
        log(f"falha ao escrever poke de retomada: {e}")
        return None
    return path


def usa_canal_dgchat(workspace=None, transcript=None) -> bool:
    """A persona atende um canal dgchat (agente entregue)?

    Decide pela EXISTENCIA da instalacao do canal, nao pelo rastro no transcript: uma
    persona de canal parada ha tempo pode ter 600 linhas de trabalho sem canal por cima,
    e aí o rastro some e a gente mandaria o poke cru justo onde ele nao pode ir cru.
    O transcript fica so como ultimo recurso, pra install fora do layout padrao."""
    try:
        if workspace:
            ws = Path(workspace)
            if (ws / ".plataforma" / "dgchat.mcp.json").exists():
                return True
            cfg = ws / ".dgclaw" / "panel" / "config.json"
            if cfg.exists():
                try:
                    if (json.loads(cfg.read_text()) or {}).get("chat"):
                        return True
                except Exception:
                    pass
    except Exception:
        pass
    try:
        if transcript:
            trecho = "\n".join(Path(transcript).read_text().splitlines()[-600:])
            return "<dgchat " in trecho
    except Exception:
        pass
    return False


def envelope_poke(texto: str, transcript=None, workspace=None) -> str:
    """Embrulha o poke no envelope `<plataforma>` quando a persona roda com o canal
    dgchat (agente entregue tipo Ana / Bento).

    Por que isso importa: nesses agentes o hook `stop-force-reply.py` decide se o turno
    pode fechar olhando o envelope da ultima entrada. Texto CRU e lido como "a pessoa
    falando", e o hook passa a cobrar da persona uma resposta pelo canal para uma
    mensagem que ninguem mandou. Pior: a persona tenta RESPONDER O POKE PARA O CLIENTE.
    Com `<plataforma >` o hook entende que foi recado da maquina e libera. Em card comum
    do Bunker/sessao sem dgchat, o cru esta certo.

    O hook casa por string simples (`PLATFORM_MARKER = "<plataforma "`) e so registra o
    timestamp: nao le `recado`, nao le `tipo`, e nao tem conceito de recibo. Por isso NAO
    incluimos a linha de ack do poker.ts: aquele ack e do ledger do manager-api, e recado
    que nao nasceu la nao tem o que confirmar.
    Controle: DGCLAW_RESUME_POKE_ENVELOPE = auto (default) | plataforma | none."""
    modo = (env("DGCLAW_RESUME_POKE_ENVELOPE", "auto") or "auto").strip().lower()
    if modo in ("none", "0", "off", "cru"):
        return texto
    if modo == "auto" and not usa_canal_dgchat(workspace, transcript):
        return texto
    ts = datetime.now(timezone.utc).isoformat()
    rid = f"retomada-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    limpo = texto.replace("</plataforma>", "<\\/plataforma>")
    return f'<plataforma recado="{rid}" tipo="aviso" ts="{ts}">{limpo}</plataforma>'


def send_resume_poke(slug: str, channel: str, path, dry_run: bool, transcript=None,
                     workspace=None) -> int:
    """Acorda a sessao pra retomar. Tenta o transporte de injecao do plugin
    (tiocsti/tmux/bunker) e, se falhar, o comando do host em DGCLAW_RESUME_POKE_CMD
    ({file} vira o caminho do poke). Em host sem nenhum transporte (TIOCSTI morto, sem
    tmux, sem Bunker) o dono precisa configurar esse comando, senao a persona nao volta
    sozinha e a gente avisa em vez de fingir que deu certo."""
    if not path:
        return 1
    texto = envelope_poke(f"[retomada-poscompact] leia {path} e execute", transcript, workspace)
    rc = inject_text(slug, channel, texto, dry_run)
    if rc == 0:
        log("poke de retomada despachado pela injecao do plugin")
        return 0
    # Se DGCLAW_INJECT_CMD estiver configurada, o inject_text acima JA usou o transporte do
    # host: a env abaixo e so pra quem quer um caminho DIFERENTE pro poke (raro).
    cmd = env("DGCLAW_RESUME_POKE_CMD")
    if cmd and rodar_comando_de_host(cmd, texto, path, dry_run,
                                     "DGCLAW_RESUME_POKE_CMD") == 0:
        return 0
    if not dry_run:
        name = env("DGCLAW_NAME") or slug
        notify_owner(f"auto-compact ({name}): compactei no meio de uma tarefa e NAO consegui "
                     f"acordar a sessao pra retomar (rc={rc}). Ela nao volta sozinha. "
                     f"O que ela estava fazendo esta em {path}")
    return rc or 1


def do_restart_compact(workspace: Path, slug: str, channel: str, ctx: int, threshold: int,
                       state_file: Path, st: dict, dry_run: bool,
                       transcript: Path = None, snap: dict = None,
                       nivel: str = "normal", idle_eff: int = 0) -> int:
    """Acao do modo 'restart': carry-over no working-memory + restart do servico + verify.
    Se o corte pegou tarefa pela metade, escreve o poke de retomada ANTES do restart (o
    transcript morre com ele) e manda depois que a sessao nova sobe."""
    svc = resolve_channel_service(slug)
    name = env("DGCLAW_NAME") or slug
    log(f"{ctx // 1000}k > teto -> carry-over + restart-com-verificacao ({svc})")
    # Carry-over ANTES do aviso e seguido de reconferencia (25/09/2026). Montar o bloco
    # leva ate ~18s, e na Isa era nessa janela que ela acordava sem ninguem ver. O bloco
    # e idempotente, entao escrever e depois desistir nao suja nada.
    write_carryover(workspace, channel, ctx, threshold, dry_run=dry_run)
    bg, bg_todas = [], []
    if transcript:
        snap = turn_snapshot(transcript)
        bg_todas = background_tasks(transcript)
        bg = [t for t in bg_todas if t["segura"]]
        if idle_eff > 0 and not looks_idle(transcript, idle_eff):
            log("ela voltou a trabalhar enquanto eu preparava o restart - desisto deste ciclo")
            return 0
        if bg and nivel == "normal":
            log(f"surgiu tarefa em segundo plano enquanto eu preparava o restart "
                f"({_resumo_bg(bg)}) - desisto deste ciclo")
            return 0
    snap = dict(snap or {})
    snap["killed_bg"] = bg_todas
    mid_task = (bool(snap.get("busy")) or bool(bg_todas)) and resume_poke_enabled()
    if bg:
        log(f"nivel {nivel}: {len(bg)} tarefa(s) em segundo plano vao morrer ({_resumo_bg(bg)}); "
            "a lista vai no poke de retomada")
    # AVISO ANTES: a sessao vai cair em segundos. Se o aviso so saisse depois, o dono
    # veria um silencio inexplicado e so entenderia quando ela voltasse.
    if not dry_run:
        notify_owner(f"Compactando nossa conversa pra rodar leve... ja volto. — {name}")
    poke_path = write_resume_poke(workspace, slug, snap, ctx, dry_run) if mid_task else None
    ok = restart_and_verify(svc, ctx, dry_run=dry_run, channel=channel)
    if dry_run:
        return 0
    st["last_compact_ts"] = datetime.now(timezone.utc).isoformat()
    st["ctx_at_compact"] = ctx
    st["verified"] = ok
    st["killed_bg"] = [t["descricao"][:80] for t in bg_todas]
    if transcript:
        # transcript da sessao que acabou de morrer: os proximos runs NAO medem esse
        # arquivo ate aparecer um novo (evita loop de restart — ver main passo 2)
        st["dead_transcript"] = str(transcript)
    st["consecutive_fail"] = 0 if ok else st.get("consecutive_fail", 0) + 1
    save_state(state_file, st)
    if ok:
        # O "voltei" fecha o ciclo do "ja volto". Quando houve retomada quem fala e a
        # PERSONA (o poke manda responder a pessoa), entao a maquina nao repete o recado.
        if mid_task:
            time.sleep(int(float(env("DGCLAW_RESUME_POKE_WAIT_S", "25"))))
            entregue = send_resume_poke(slug, channel, poke_path, dry_run,
                                        transcript=transcript, workspace=workspace) == 0
            if not entregue:
                notify_owner(f"Voltei da compactacao, mas o recado do que eu estava "
                             f"fazendo nao chegou. Me lembra o que voce tinha pedido que eu "
                             f"retomo na hora. — {name}")
        else:
            notify_owner(f"Voltei, contexto limpo (estava em {ctx // 1000}k). Sigo de onde "
                         f"a gente parou. — {name}")
        return 0
    return 6


# ─── fechamento do ciclo "ja volto" -> "voltei" (modo inject) ─────────────────
# Conserto 08 (05/10/2026). Antes o fechamento so rodava no PROXIMO ciclo do timer (30 min).
# Na Luna a compactacao assentou as 13:03:45, o "Voltei (estava em 157k)" so saiu as
# 13:32:58, e no mesmo run a conversa ja tinha voltado a 142k, entao 0,25 s depois saiu o
# "Compactando" do ciclo NOVO. Na thread pareceu ordem trocada. Agora o run que injeta o
# /compact espera o recibo (compact_boundary) e fecha o ciclo ali mesmo.

def fechar_ciclo_pendente(st: dict, state_file: Path, session_dir: Path, slug: str,
                          channel: str, workspace: Path, idle_sec: int) -> bool:
    """Fecha o ciclo pendente se a compactacao ja assentou. Sem tarefa na metade manda o
    "Voltei" (nao precisa de sessao ociosa: o aviso vai pro dono, nao pra sessao). Com tarefa
    na metade manda o poke de retomada, que entra NA sessao e por isso espera ela ociosa.
    True quando fechou (ou nao havia nada pendente)."""
    pend = st.get("pending_resume_poke")
    if not pend:
        return True
    if not had_compact_since(session_dir, pend.get("since") or ""):
        return False
    nome = env("DGCLAW_NAME") or slug
    arquivo = pend.get("file")
    if arquivo:
        # O modo de seguranca pode ter ligado durante a espera: poke nascido antes dele
        # levaria a sessao de volta a conversa que travou (mesma regra do main).
        marca_ms = _modo_seguro(workspace)
        if marca_ms and _antes(pend.get("ts"), marca_ms.get("ativadoEm")):
            log(f"modo de seguranca ligado desde {marca_ms.get('ativadoEm')}: descartei o poke "
                f"de retomada de {pend.get('ts')}")
            st.pop("pending_resume_poke", None)
            save_state(state_file, st)
            return True
        transcript = resolve_live_transcript(session_dir, slug, channel)
        if not transcript or not looks_idle(transcript, idle_sec):
            return False
        entregue = send_resume_poke(slug, channel, Path(arquivo), False,
                                    transcript=transcript, workspace=workspace) == 0
    else:
        ctx_antes = pend.get("ctx") or 0
        notify_owner(f"Voltei, contexto limpo"
                     + (f" (estava em {ctx_antes // 1000}k)" if ctx_antes else "")
                     + f". Sigo de onde a gente parou. — {nome}")
        entregue = True
    if entregue:
        st.pop("pending_resume_poke", None)
        save_state(state_file, st)
    return entregue


def esperar_assentar_e_fechar(st: dict, state_file: Path, session_dir: Path, slug: str,
                              channel: str, workspace: Path, idle_sec: int):
    """Depois de injetar o /compact, espera ate DGCLAW_COMPACT_SETTLE_WAIT_S (default 600 s;
    0 desliga) o recibo da compactacao, olhando a cada 10 s, e fecha o ciclo no mesmo run.
    Se nao assentar a tempo, o pendente fica no state e o proximo ciclo tenta de novo."""
    try:
        limite = float(env("DGCLAW_COMPACT_SETTLE_WAIT_S", "600"))
    except (TypeError, ValueError):
        limite = 600.0
    if limite <= 0:
        log("DGCLAW_COMPACT_SETTLE_WAIT_S=0: o fechamento do ciclo fica pro proximo run")
        return
    inicio = time.monotonic()
    while time.monotonic() - inicio < limite:
        time.sleep(min(10.0, limite))
        if fechar_ciclo_pendente(st, state_file, session_dir, slug, channel, workspace,
                                 idle_sec):
            log(f"compactacao assentou e o ciclo fechou no mesmo run "
                f"({time.monotonic() - inicio:.0f}s depois do /compact)")
            return
    log(f"a compactacao nao fechou o ciclo em {limite:.0f}s (sem compact_boundary, ou a "
        f"sessao nao ficou ociosa pro poke); fica pendente pro proximo run")


# ─── orquestracao ─────────────────────────────────────────────────────────────

def _modo_seguro(workspace: Path):
    """A marca do modo de seguranca (<ws>/.dgclaw/modo-seguro.json), ou None. Marca
    ilegivel conta como ligada AGORA: na duvida, o poke antigo nao sai."""
    p = workspace / ".dgclaw" / "modo-seguro.json"
    if not p.exists():
        return None
    try:
        m = json.loads(p.read_text())
    except (OSError, ValueError) as e:
        log(f"aviso: modo-seguro.json ilegivel ({e}); tratando como ligado agora")
        return {"ativo": True, "ativadoEm": datetime.now(timezone.utc).isoformat()}
    return m if m.get("ativo", True) else None


def _antes(a, b) -> bool:
    """a e anterior a b (ISO8601, com Z ou +00:00)? Sem data legivel, conta como
    anterior: e o lado que nao entrega o poke."""
    try:
        da = datetime.fromisoformat(str(a).replace("Z", "+00:00"))
        db = datetime.fromisoformat(str(b).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return True
    if da.tzinfo is None:
        da = da.replace(tzinfo=timezone.utc)
    if db.tzinfo is None:
        db = db.replace(tzinfo=timezone.utc)
    return da < db


def main():
    ap = argparse.ArgumentParser(description="Auto-compacta a sessao viva da persona DG Claw.")
    ap.add_argument("--threshold", default=None,
                    help="override do teto: fracao (<=1) do limite ou tokens absolutos (>1)")
    ap.add_argument("--dry-run", action="store_true", help="so reporta, NAO injeta")
    ap.add_argument("--force", action="store_true",
                    help="ignora cooldown e checagem de ociosidade")
    ap.add_argument("--ignore-cooldown", action="store_true",
                    help="fura so o cooldown, mantendo a checagem de ociosidade "
                         "(uso: restart-fresh noturno da reflexao)")
    # O runner do timer chama 'python3 auto-compact.py <config.sh>' (o config ja foi sourceado
    # pro env antes do exec). Aceitamos esse positional e o IGNORAMOS — tudo vem de DGCLAW_*.
    ap.add_argument("config", nargs="?", default=None, help=argparse.SUPPRESS)
    args = ap.parse_args()

    # OPT-IN do auto-recovery (mesmo flag do watchdog e do .sh aposentado): off = no-op puro.
    # --force NAO fura isto: se o dono desligou a auto-recuperacao, nem manual via timer compacta.
    if (env("DGCLAW_AUTO_RECOVERY", "on") or "on").lower() == "off":
        log("DGCLAW_AUTO_RECOVERY=off — auto-compact desligado (no-op)")
        return 0

    workspace = resolve_workspace()
    slug = resolve_slug()
    channel = inj.channel_name(slug)
    session_dir = resolve_session_dir(workspace)
    state_file = resolve_state_file(workspace, slug)
    threshold, limit, frac = resolve_threshold(args.threshold)

    try:
        idle_sec = int(float(env("DGCLAW_COMPACT_IDLE_SEC", "45")))
    except (TypeError, ValueError):
        idle_sec = 45
    try:
        cooldown_min = int(float(env("DGCLAW_COMPACT_COOLDOWN_MIN", "20")))
    except (TypeError, ValueError):
        cooldown_min = 20

    desc = f"{threshold // 1000}k tokens"
    if frac is not None:
        desc = f"{int(frac * 100)}% de {limit // 1000}k = {threshold // 1000}k"
    log(f"persona '{slug}' | canal '{channel}' | teto: {desc}")

    # 1) sessao viva? (no-op gracioso se morta)
    if not inj.is_session_alive(slug, channel):
        log("sessao viva nao ativa — no-op gracioso (exit 0)")
        return 0

    # 2) acha o transcript e estima o contexto
    transcript = resolve_live_transcript(session_dir, slug, channel)
    if not transcript:
        log(f"transcript da sessao '{channel}' nao encontrado em {session_dir} — no-op")
        return 0

    # Transcript MORTO (so modo restart): a sessao fresca pos-restart fica ociosa e
    # nao materializa transcript novo ate a 1a mensagem. Medir o transcript da sessao
    # ANTIGA (contexto alto congelado) causava LOOP de restart a cada timer (bug visto
    # na Isa em 01/07/2026: 48 restarts/dia silenciosos). Se o arquivo achado e o mesmo
    # registrado como morto no ultimo restart, esperamos o novo aparecer.
    st = load_state(state_file)
    dead = st.get("dead_transcript")
    if dead and str(transcript) == str(dead):
        log(f"transcript ainda e o morto do ultimo restart ({Path(dead).name}) — "
            "aguardando sessao nova materializar; no-op")
        return 0

    # 2.5) poke de retomada PENDENTE do ciclo anterior (modo inject). O /compact demora
    # minutos pra assentar, entao nao adianta acordar a persona na hora: a gente espera o
    # compact_boundary aparecer e a sessao ficar ociosa, e SO ENTAO manda ela retomar.
    pend = st.get("pending_resume_poke")
    # MODO DE SEGURANCA (01/10/2026): se a sessao foi reiniciada sem a conversa anterior
    # (ver _lib/reinicio.py), um poke de retomada nascido ANTES disso manda a persona
    # voltar ao assunto que a travou. Foi exatamente o caminho por onde o veneno voltou
    # na Isa em 30/09: o poke de retomada mandou ela reler o transcript morto. Poke assim
    # e descartado, com registro, e nunca entregue.
    if pend:
        marca_ms = _modo_seguro(workspace)
        if marca_ms and _antes(pend.get("ts"), marca_ms.get("ativadoEm")):
            log(f"modo de seguranca ligado desde {marca_ms.get('ativadoEm')}: descartei o poke de "
                f"retomada de {pend.get('ts')} (ele levaria a sessao de volta a conversa que travou)")
            st.pop("pending_resume_poke", None)
            save_state(state_file, st)
            pend = None
    if pend and not args.dry_run:
        nascido = pend.get("ts") or ""
        expirou = False
        try:
            idade = (datetime.now(timezone.utc)
                     - datetime.fromisoformat(nascido)).total_seconds() / 60
            expirou = idade > float(env("DGCLAW_RESUME_POKE_TTL_MIN", "60"))
        except Exception:
            pass
        if expirou:
            # Nao descarta em silencio: o dono ja recebeu o "ja volto" antes da compactacao,
            # e ficar sem o "voltei" e pior que um aviso feio.
            log("retomada pendente expirou sem a compactacao assentar — descartando e avisando")
            notify_owner(f"Falei que ja voltava da compactacao e ela nao assentou a tempo. "
                         f"Se eu estava no meio de alguma coisa, me lembra o que era. "
                         f"— {env('DGCLAW_NAME') or slug}")
            st.pop("pending_resume_poke", None)
            save_state(state_file, st)
        elif not fechar_ciclo_pendente(st, state_file, session_dir, slug, channel,
                                       workspace, idle_sec):
            log("poke de retomada pendente: compactacao ainda nao assentou — espero o proximo ciclo")

    ctx = context_tokens(transcript)
    if ctx == 0:
        log("sem usage no transcript ainda — no-op")
        return 0
    log(f"contexto estimado: {ctx // 1000}k tokens (teto {threshold // 1000}k)")

    if ctx <= threshold:
        if st.get("dead_transcript"):
            st.pop("dead_transcript", None)
            save_state(state_file, st)
        log("abaixo do teto — nada a fazer")
        return 0

    # 3) cooldown (--ignore-cooldown fura so o cooldown; a checagem de ociosidade fica)
    if not (args.force or args.ignore_cooldown):
        rem = cooldown_remaining(st, cooldown_min)
        if rem > 0:
            log(f"acima do teto, mas em cooldown ({rem:.0f}min restantes) — pulando")
            return 0

    # 4) ociosidade COM ESCALADA. Antes a checagem era binaria: se a sessao parecia
    # ocupada, adiava, e ponto. Numa conversa viva isso adia TODO ciclo e o contexto sobe
    # sem teto (caso real na Isa em 19/08/2026: de 150k a 604k sem uma compactacao). Agora
    # a espera encolhe conforme o excesso, e no nivel critico compacta mesmo com turno em
    # voo, porque o poke de retomada devolve a tarefa.
    snap = turn_snapshot(transcript)
    hot_at, crit_at = escalation_marks(threshold, limit)
    if ctx >= crit_at:
        nivel, idle_eff = "CRITICO", 0
    elif ctx >= hot_at:
        nivel, idle_eff = "quente", max(5, int(idle_sec / 4))
    else:
        nivel, idle_eff = "normal", idle_sec
    if not args.force and idle_eff > 0 and not looks_idle(transcript, idle_eff):
        log(f"acima do teto, mas a sessao parece OCUPADA (turno em voo; nivel {nivel}, "
            f"quente>={hot_at // 1000}k critico>={crit_at // 1000}k) — adiando compact")
        return 0
    if idle_eff == 0 and not looks_idle(transcript, idle_sec):
        como = ("turno em voo" if snap.get("busy") else "sessao ainda quentinha")
        log(f"nivel CRITICO ({ctx // 1000}k >= {crit_at // 1000}k): compacto MESMO com "
            f"{como}" + (" e devolvo a tarefa pelo poke de retomada" if snap.get("busy") else ""))

    # ── modo RESTART (TIOCSTI-independente): carry-over + systemctl restart + verify ──
    if resolve_compact_mode() == "restart":
        # Trabalho em segundo plano segura o restart igual turno em voo segura (fix
        # 25/09/2026, ver background_tasks), mas SO no nivel normal. Segurar ate o
        # critico deixou a Isa de 4 a 5h/dia acima de 300k; como o poke de retomada
        # funcionou em 9 de 9 cortes reais, do nivel quente em diante compensa compactar
        # e deixar a persona relancar (08/10/2026).
        bg = [t for t in background_tasks(transcript) if t["segura"]]
        if bg and nivel == "normal" and not args.force:
            log(f"acima do teto, mas {len(bg)} tarefa(s) em segundo plano rodando "
                f"({_resumo_bg(bg)}; nivel {nivel}) — adiando restart")
            return 0
        return do_restart_compact(workspace, slug, channel, ctx, threshold,
                                  state_file, st, args.dry_run, transcript=transcript,
                                  snap=snap, nivel=("CRITICO" if args.force else nivel),
                                  idle_eff=(0 if args.force else idle_eff))

    # 4.5) a injecao ANTERIOR surtiu efeito? Se ja injetamos antes e NENHUM compact_boundary
    # apareceu desde entao (e ainda estamos acima do teto), o /compact foi engolido (sessao
    # ocupada na hora, tipico). Conta a falha e, ao atingir o limite, alerta o dono.
    prev = st.get("last_compact_ts")
    if prev and not args.force:
        try:
            fail_k = max(1, int(float(env("DGCLAW_COMPACT_FAIL_ALERT", "2"))))
        except (TypeError, ValueError):
            fail_k = 2
        if had_compact_since(session_dir, prev):
            st["consecutive_fail"] = 0
        else:
            st["consecutive_fail"] = st.get("consecutive_fail", 0) + 1
            log(f"injecao anterior de /compact nao deixou compact_boundary "
                f"(falha {st['consecutive_fail']}/{fail_k})")
            if st["consecutive_fail"] == fail_k:
                name = env("DGCLAW_NAME") or slug
                notify_owner(
                    f"auto-compact ({name}): injetei /compact {st['consecutive_fail']}x e o "
                    f"contexto nao baixou ({ctx // 1000}k > teto). A sessao pode estar sempre "
                    f"ocupada na hora do compact, ou o transporte falhou. Da uma olhada.")
        save_state(state_file, st)

    # 5) injeta /compact
    log(f"{ctx // 1000}k > teto -> injetando /compact na sessao viva")
    # AVISO ANTES: a sumarizacao segura a persona por minutos. Sem isto a pessoa fala com
    # ela e nao recebe nada, sem saber por que.
    if not args.dry_run:
        notify_owner(f"Compactando nossa conversa pra rodar leve... ja volto. "
                     f"— {env('DGCLAW_NAME') or slug}")
    rc = inject_compact(slug, channel, args.dry_run)

    if args.dry_run:
        return 0

    if rc == 0:
        agora = datetime.now(timezone.utc).isoformat()
        st["last_compact_ts"] = agora
        st["ctx_at_compact"] = ctx
        mid_task = bool(snap.get("busy")) and resume_poke_enabled()
        # Nem o poke nem o "voltei" saem agora: o /compact ainda esta sumarizando e a
        # keystroke se perderia. Ficam PENDENTES e saem quando o compact_boundary aparecer:
        # normalmente ainda neste run (esperar_assentar_e_fechar), senao no proximo ciclo.
        # Com tarefa na metade sai o poke (e quem fala e a persona); sem tarefa sai so o
        # "voltei", pra fechar o ciclo do "ja volto".
        pk = write_resume_poke(workspace, slug, snap, ctx, args.dry_run) if mid_task else None
        st["pending_resume_poke"] = {"file": str(pk) if pk else None, "ts": agora,
                                     "since": agora, "ctx": ctx}
        save_state(state_file, st)
        log("/compact injetado — o motor vai sumarizar (demora ~min)")
        esperar_assentar_e_fechar(st, state_file, session_dir, slug, channel, workspace,
                                  idle_sec)
        return 0
    if rc == 2:
        log("sessao ficou indisponivel na hora de injetar — no-op gracioso")
        return 0
    if rc == 3:
        log("PermissionError no TIOCSTI — precisa ser root ou use DGCLAW_INJECT_MODE=tmux")
        return 3
    if rc == 4:
        log("nao consegui o lock de injecao a tempo — pulando (evita colisao de keystrokes)")
        return 4
    log(f"falha ao injetar (rc={rc})")
    return rc


if __name__ == "__main__":
    sys.exit(main())
