#!/usr/bin/env python3
"""
inject-telegram-thread.py (DG Claw) — UserPromptSubmit hook da sessao --channels viva.

PROBLEMA QUE RESOLVE (backport da Isa, pedido do Danilo 30/06 e 17/07/2026):
  O DONO so ve a THREAD do canal (o chat do Telegram). Quando ele responde "pode
  resumir", ele se refere as ULTIMAS mensagens que apareceram pra ele — INCLUSIVE as
  que os crons postaram (relatorios, ronda, digest). A sessao viva da persona, porem,
  ancora no ultimo poke de cron que entrou entre a pergunta dela e a resposta do dono,
  e responde "qual post?" a um "pode resumir". Eles nao leem a mesma coisa.

  Este hook roda A CADA MENSAGEM do dono: reconstroi a thread REAL do canal (via
  _lib/thread_log.py, o mesmo extrator que o auto-compact usa no restart) mesclada
  com um outbound log OPCIONAL (crons que postam por processo separado), e injeta as
  ultimas N mensagens da janela recente como additionalContext — a mesma coisa que o
  dono esta vendo.

MELHORIA 21/07/2026 (working-memory na 1a msg da sessao):
  Sessao nova/rotacionada nascia sem as pendencias — a persona perguntava "qual
  projeto?" sobre algo de ontem — porque o protocolo economico so le o header do
  working-memory. Aqui, na PRIMEIRA mensagem do dono de cada sessao (controle por
  session_id num state file), injetamos tambem a working-memory COMPLETA (bloco
  "📌 WORKING-MEMORY COMPLETA", com cap de chars de seguranca). A sessao nasce sabendo
  tudo; nos turnos seguintes vale o diff de header de sempre.

CONTRATO DO HOOK (Claude Code UserPromptSubmit):
  - stdin: JSON com {prompt, transcript_path, session_id, ...}
  - stdout: JSON {hookSpecificOutput:{hookEventName, additionalContext}} pra injetar
  - Falha SEMPRE em silencio (exit 0, sem stdout) — a DM nao pode quebrar por isso.

ISOLAMENTO / OPT-IN (critico — igual ao hook-memory-inject):
  So injeta quando DGCLAW_THREAD_HOOK=1 (opt-in, default OFF) E
  DGCLAW_PRIVATE_CONTEXT=1 (contexto privado do dono). Qualquer outro spawn
  (publico/ronda/post) NAO seta as flags -> nao injeta nada (nao vaza). O outbound log
  e a working-memory podem conter conteudo pessoal.

GENERALIZADO pro contrato DG Claw: ZERO hardcode de persona/paths. Tudo por env DGCLAW_*.
  DGCLAW_THREAD_HOOK           opt-in (=1 liga). Default OFF.
  DGCLAW_PRIVATE_CONTEXT       gate de privacidade (=1). Default OFF.
  DGCLAW_WORKSPACE             raiz do workspace (deriva session dir, logs, WM).
  DGCLAW_SLUG                  slug da persona (deriva o --name do canal). Default "persona".
  DGCLAW_CHANNEL_NAME          override do customTitle da sessao (default dgclaw-<slug>).
  DGCLAW_CHANNEL_SOURCE        marca do <channel source="..."> do inbound.
                                 Default "plugin:telegram:telegram".
  DGCLAW_SESSION_DIR           override do dir dos transcripts .jsonl.
  DGCLAW_WORKING_MEMORY        caminho do working-memory.md (senao <ws>/working-memory.md
                                 ou <ws>/persona/working-memory.md).
  DGCLAW_OUTBOUND_LOG          (OPCIONAL) jsonl com o que os crons postaram fora da sessao
                                 (formato {ts,text,kind?,source?}). Se ausente, so a thread do
                                 transcript e usada (crons via notify-owner.sh nao aparecem —
                                 ver docs/THREAD-HOOK.md).
  DGCLAW_THREAD_INJECT_N       quantas msgs injetar. Default 10.
  DGCLAW_THREAD_INJECT_WINDOW_H  janela recente em horas. Default 8.
  DGCLAW_THREAD_INJECT_MAX_CHARS truncagem por msg. Default 320.
  DGCLAW_THREAD_WM_MAX_CHARS   trava de seguranca do bloco WM. Default 60000.
  DGCLAW_THREAD_WM_KEEP_SESSIONS  quantas sessoes lembrar no state. Default 20.
  DGCLAW_THREAD_WM_STATE       override do state file das sessoes ja injetadas.
  DGCLAW_CONFIG                (opcional) 1o argv ou env: config.sh do agente pra herdar
                                 os DGCLAW_* (igual ao hook-memory-inject).

Uso (registrado pelo Claude Code como UserPromptSubmit; hookInput via stdin):
  python3 inject-telegram-thread.py [<.dgclaw/config.sh>]
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# reusa o extrator da thread do plugin (mesmo que o auto-compact usa no restart)
sys.path.insert(0, str(Path(__file__).resolve().parent / "_lib"))
try:
    import thread_log as tl  # noqa: E402
except Exception:
    tl = None


# ─── config.sh opcional (herda DGCLAW_* como o hook-memory-inject faz via `source`) ──

def _load_config():
    """Se veio um config.sh (argv[1] ou DGCLAW_CONFIG), extrai as linhas simples
    KEY=VALUE / export KEY=VALUE e injeta no os.environ (sem sobrescrever o que ja
    existe). Best-effort e silencioso — nunca aborta."""
    path = None
    for cand in (sys.argv[1] if len(sys.argv) > 1 else None,
                 os.environ.get("DGCLAW_CONFIG")):
        if cand and os.path.isfile(cand):
            path = cand
            break
    if not path:
        return
    pat = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.split("#", 1)[0] if line.lstrip().startswith("#") else line
                m = pat.match(line.rstrip("\n"))
                if not m:
                    continue
                key, val = m.group(1), m.group(2).strip()
                if (len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'"):
                    val = val[1:-1]
                if "$" in val or "`" in val:
                    continue  # nao expandimos shell; deixa herdar do ambiente
                os.environ.setdefault(key, val)
    except Exception:
        pass


_load_config()


# ─── Config (com defaults iguais aos da Isa) ──────────────────────────────────

def _env(name, default=""):
    return os.environ.get(name, default)


def _envi(name, default):
    try:
        return int(float(_env(name) or default))
    except (TypeError, ValueError):
        return default


def _envf(name, default):
    try:
        return float(_env(name) or default)
    except (TypeError, ValueError):
        return default


SLUG = _env("DGCLAW_SLUG") or "persona"
CHANNEL_SOURCE = _env("DGCLAW_CHANNEL_SOURCE") or "plugin:telegram:telegram"
CHANNEL_NAME = _env("DGCLAW_CHANNEL_NAME") or f"dgclaw-{SLUG}"
N = _envi("DGCLAW_THREAD_INJECT_N", 10)
WINDOW_H = _envf("DGCLAW_THREAD_INJECT_WINDOW_H", 8)
MAX_CHARS = _envi("DGCLAW_THREAD_INJECT_MAX_CHARS", 320)
WM_MAX_CHARS = _envi("DGCLAW_THREAD_WM_MAX_CHARS", 60000)
WM_KEEP_SESSIONS = _envi("DGCLAW_THREAD_WM_KEEP_SESSIONS", 20)


def _workspace() -> Path:
    return Path(_env("DGCLAW_WORKSPACE") or os.getcwd()).resolve()


def _logs_dir() -> Path:
    ws = _workspace()
    override = _env("DGCLAW_LOGS_DIR") or _env("DGCLAW_LOG_DIR")
    if override:
        return Path(override).resolve()
    return ws / ".dgclaw" / "logs"


def _wm_path() -> Path:
    override = _env("DGCLAW_WORKING_MEMORY")
    if override:
        return Path(override).resolve()
    ws = _workspace()
    flat = ws / "working-memory.md"
    persona = ws / "persona" / "working-memory.md"
    if flat.exists():
        return flat
    if persona.exists():
        return persona
    return flat


def _wm_state_path() -> Path:
    override = _env("DGCLAW_THREAD_WM_STATE")
    if override:
        return Path(override).resolve()
    return _logs_dir() / "hook-thread-wm-sessions.json"


def _log_path() -> Path:
    return _logs_dir() / "hook-telegram-thread.log"


def _log(msg):
    try:
        p = _log_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().astimezone().strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def _bail(reason=""):
    if reason:
        _log(f"skip: {reason}")
    sys.exit(0)


# ─── timezone: UTC (transcript) e local do host (outbound + display) ──────────

def _epoch_utc(ts):
    """ts do transcript = UTC ISO sem tz. Devolve epoch (float)."""
    try:
        return datetime.fromisoformat((ts or "").replace("Z", "")).replace(
            tzinfo=timezone.utc).timestamp()
    except Exception:
        return 0.0


def _epoch_local(ts):
    """ts do outbound log = horario LOCAL do host (naive). Devolve epoch (float)."""
    try:
        local_tz = datetime.now().astimezone().tzinfo
        return datetime.fromisoformat(ts).replace(tzinfo=local_tz).timestamp()
    except Exception:
        return 0.0


def _hhmm(epoch):
    try:
        return datetime.fromtimestamp(epoch).strftime("%H:%M")
    except Exception:
        return "--:--"


def _clip(text):
    t = " ".join((text or "").split())
    return t[:MAX_CHARS].rstrip() + "…" if len(t) > MAX_CHARS else t


# ─── working-memory completa, injetada UMA vez por sessao ──────────────────────

def _wm_block_once(session_id):
    """Devolve a working-memory completa se esta sessao ainda nao a recebeu; senao None.
    Marca ANTES de devolver (se o turno falhar, melhor perder 1 injecao do que injetar
    milhares de tokens em loop a cada retry). Falha sempre em silencio (None)."""
    if not session_id:
        return None
    try:
        state = _wm_state_path()
        try:
            with open(state, encoding="utf-8") as f:
                seen = json.load(f)
            if not isinstance(seen, dict):
                seen = {}
        except Exception:
            seen = {}
        if session_id in seen:
            return None
        wm_file = _wm_path()
        try:
            wm = wm_file.read_text(encoding="utf-8")[:WM_MAX_CHARS]
        except Exception:
            return None
        if not wm.strip():
            return None
        seen[session_id] = datetime.now().astimezone().isoformat(timespec="seconds")
        pruned = dict(sorted(seen.items(), key=lambda kv: kv[1])[-WM_KEEP_SESSIONS:])
        state.parent.mkdir(parents=True, exist_ok=True)
        tmp = state.with_suffix(state.suffix + ".tmp")
        tmp.write_text(json.dumps(pruned, ensure_ascii=False), encoding="utf-8")
        tmp.replace(state)
        return (
            "📌 WORKING-MEMORY COMPLETA (injetada 1x porque esta sessao e nova — e a sua "
            "memoria de trabalho persistente, com as pendencias e o contexto dos projetos "
            "do dono; ela fica no seu historico daqui em diante, entao NAO precisa reler o "
            "arquivo inteiro agora):\n\n" + wm
        )
    except Exception as e:
        _log(f"wm-inject falhou: {e}")
        return None


# ─── thread do canal (via _lib/thread_log.py) ─────────────────────────────────

def _find_transcript(hook):
    t = hook.get("transcript_path")
    if t and os.path.exists(t):
        return t
    if tl is not None:
        try:
            return tl.find_session(CHANNEL_NAME)
        except Exception:
            return None
    return None


def _thread_events(transcript, floor):
    """Eventos da thread do transcript vivo, filtrados pela janela recente.
    Cada item: (epoch, origin, text). origin in {owner, persona-direct, persona-cron}."""
    events = []
    if tl is None or not transcript:
        return events
    try:
        for e in tl.build_thread_log(transcript, last=0):  # 0 = tudo; filtro e por janela
            ep = _epoch_utc(e.get("ts", ""))
            if ep >= floor:
                events.append((ep, e.get("origin", "persona-direct"), e.get("text", "")))
    except Exception as e:
        _log(f"extrator falhou: {e}")
    return events


def _outbound_events(floor):
    """Mescla o outbound log OPCIONAL (crons que postam por processo separado, fora da
    sessao viva — nao aparecem no transcript). Ausente/ilegivel -> lista vazia."""
    path = _env("DGCLAW_OUTBOUND_LOG")
    if not path or not os.path.exists(path):
        return []
    events = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                ep = _epoch_local(o.get("ts", ""))
                if ep < floor:
                    continue
                txt = o.get("text", "")
                kind = o.get("kind", "text")
                if kind != "text" and not txt:
                    txt = f"[{kind}]"
                src = o.get("source", "manual")
                origin = "persona-direct" if src == "manual" else "persona-cron"
                events.append((ep, origin, txt))
    except Exception as e:
        _log(f"outbound falhou: {e}")
    return events


def main():
    # 1) Opt-in + gate de isolamento (igual ao hook-memory-inject).
    if _env("DGCLAW_THREAD_HOOK", "0") != "1":
        _bail("hook desligado (DGCLAW_THREAD_HOOK!=1)")
    if _env("DGCLAW_PRIVATE_CONTEXT", "0") != "1":
        _bail("contexto nao-privado (DGCLAW_PRIVATE_CONTEXT!=1)")

    raw = sys.stdin.read()
    try:
        hook = json.loads(raw)
    except Exception:
        _bail("stdin nao-json")
    prompt = hook.get("prompt", "") or ""

    # 2) So injeta antes de uma mensagem REAL do dono (bloco <channel source=...>).
    #    Poke de cron / heartbeat / permission-reply -> nao injeta.
    if CHANNEL_SOURCE not in prompt[:240]:
        _bail("prompt nao-eh-inbound-do-canal")

    wm_block = _wm_block_once(hook.get("session_id"))

    now = datetime.now().timestamp()
    floor = now - WINDOW_H * 3600

    events = _thread_events(_find_transcript(hook), floor)
    events += _outbound_events(floor)

    if not events and not wm_block:
        _bail("sem eventos na janela")

    blocks = []
    if wm_block:
        blocks.append(wm_block)

    n_events = 0
    if events:
        # 3) Ordena por tempo real e pega as ultimas N.
        events.sort(key=lambda x: x[0])
        events = events[-N:]
        n_events = len(events)

        label = {"owner": "👤 Dono", "persona-direct": "🤖 (eu)",
                 "persona-cron": "🤖 (eu, via cron)"}
        lines = [f"- [{_hhmm(ep)}] {label.get(origin, origin)}: {_clip(text)}"
                 for ep, origin, text in events]

        blocks.append(
            "📱 THREAD REAL DO CANAL (o que o dono esta vendo agora, em ordem — inclui o "
            "que SEUS CRONS postaram pra ele). A mensagem dele abaixo quase sempre se refere "
            "a ESTAS mensagens, nao a ultima coisa que voce fez internamente. Resolva o "
            "referente contra esta lista ANTES de responder; so pergunte \"qual?\" se ela "
            "realmente nao permitir inferir.\n\n" + "\n".join(lines)
        )

    out = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "\n\n".join(blocks),
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    _log(f"injetou {n_events} msgs (janela {WINDOW_H}h)"
         + (" + working-memory (sessao nova)" if wm_block else ""))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        _log(f"erro fatal (silenciado): {e}")
        sys.exit(0)
