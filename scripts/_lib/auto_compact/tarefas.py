"""O que a persona estava fazendo: foto do turno e tarefas em segundo plano."""

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from .ambiente import env, log


_CHANNEL_TAG = re.compile(r"^<channel\b[^>]*>\s*", re.S)


_CHANNEL_END = re.compile(r"\s*</channel>\s*$", re.S)


_META_TYPES = {"last-prompt", "custom-title", "agent-name", "mode", "permission-mode",
               "attachment", "summary"}


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

    Conserto de 25/09/2026, trazido de um agente pessoal, em duas rodadas. So importa no modo restart:
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
            pass  # ts ausente ou invalido: idade fica None e a tarefa e tratada como sem idade conhecida
        # So viva e fresca segura o restart. Orfa (sem aviso ha max_age) e subagente
        # cuja conversa propria parou de mudar ha stale_min (travado; caso de 25/09 na
        # agente pessoal: parou 22:57 e segurou a dieta ate 01:30) NAO seguram, mas continuam na
        # lista por 24h, porque o poke precisa contar que ficou coisa devendo.
        if idade is not None and idade > 24 * 60:
            continue
        t["idade_min"], t["segura"], t["motivo"] = idade, True, ""
        # Subagente tem sinal de vida proprio (a conversa dele), entao vale ele e NAO a
        # idade: num agente pessoal, em 27 e 28/09, dois treinos de RL de mais de 3h, escrevendo 2 a
        # 8 min antes, foram cortados pela regra de idade. A idade fica so pro que nao tem
        # sinal de vida (comando em segundo plano, monitor, fila).
        parado = None
        if t["tipo"].startswith("subagente"):
            conversa = transcript.parent / transcript.stem / "subagents" / f"agent-{t['id']}.jsonl"
            try:
                parado = (time.time() - conversa.stat().st_mtime) / 60
            except OSError:
                pass  # conversa do subagente sumiu: sem sinal de vida, vale a regra de idade
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
