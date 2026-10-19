"""Leitura do transcript da sessão viva: tamanho do contexto, ociosidade e compactações."""

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import inject as inj  # _lib já está no sys.path (ver auto-compact.py)


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
    customTitle nunca bate e a busca voltava vazia, o auto-compact virava no-op eterno
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
      - o ULTIMO evento do transcript e do tipo 'assistant' (turno terminou), se for 'user'
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


def had_compact_since(session_dir: Path, iso_ts: str) -> bool:
    """True se algum transcript tem um marcador de compactacao (compact_boundary /
    isCompactSummary) com timestamp posterior a iso_ts. E o RECIBO deterministico de que
    o /compact realmente rodou, o equivalente, pro auto-compact, do ACK dos pokes de texto.
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
                        pass  # ts malformado numa linha: ignora so essa linha
        except OSError:
            continue
    return False
