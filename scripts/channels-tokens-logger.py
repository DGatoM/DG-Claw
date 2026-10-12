#!/usr/bin/env python3
"""channels-tokens-logger.py (DG Claw) — extrai custo da sessao viva (channels).

Le os transcripts .jsonl da sessao viva da persona (a mesma sessao --channels que
serve o canal) e, pra cada assistant message NOVA (controle por uuid), grava 1 entry
no log de tokens com o schema unificado lido pelo painel (aba CUSTOS).

Tudo parametrizado por env do contrato DG Claw. ZERO hardcode de persona/paths.

Env:
  DGCLAW_WORKSPACE        (obrigatorio na pratica) — raiz do workspace da persona.
  DGCLAW_SLUG             (opcional)               — slug da persona; vira o sufixo
                              do `cron` (dm-<slug>-channels) e do nome do arquivo de
                              saida (<slug>-channels-tokens.jsonl). Default: "agente".
  DGCLAW_SESSION_DIR      (opcional)               — dir dos transcripts .jsonl.
                              Default: ~/.claude/projects/<encoded-workspace>, onde
                              <encoded-workspace> e o path absoluto do workspace com
                              cada '/' substituido por '-' (convencao do Claude Code).
  DGCLAW_TOKENS_LOG       (opcional)               — caminho do .jsonl de saida.
                              Default: <ws>/.dgclaw/logs/<slug>-channels-tokens.jsonl
  DGCLAW_TOKENS_STATE     (opcional)               — state file (dedup por uuid).
                              Default: <ws>/.dgclaw/logs/.<slug>-tokens-state.json
  DGCLAW_PRICING_FILE     (opcional)               — JSON de precos ($/M tokens) que
                              sobrescreve/estende a tabela embutida. Schema por modelo:
                              {"in":..,"out":..,"cw5":..,"cw1h":..,"cr":..}.
                              Default: <ws>/.dgclaw/pricing.json (se existir).

Granularidade: 1 entry por assistant message (= 1 chamada API).
Roda via timer (ex.: a cada 5min).

Schema de cada linha (casa com panel/lib/costs.js):
  timestamp, cron, tag, model, duration_ms, num_turns, total_cost_usd,
  session_id, is_error, usage, model_usage
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime


# Pricing em $/M tokens. Default 5min cache; preco de 1h cache aplicado quando
# cache_creation.ephemeral_1h_input_tokens > 0. Sobrescrevivel via DGCLAW_PRICING_FILE.
# Opus = $5/$25 (preco atual da API). cw5 = 1,25x in; cw1h = 2x in; cr = 0,1x in.
DEFAULT_PRICING = {
    "claude-opus-4-8":           {"in":  5.0, "out": 25.0, "cw5":  6.25, "cw1h": 10.0, "cr": 0.50},
    "claude-opus-4-7":           {"in":  5.0, "out": 25.0, "cw5":  6.25, "cw1h": 10.0, "cr": 0.50},
    "claude-opus-4-6":           {"in":  5.0, "out": 25.0, "cw5":  6.25, "cw1h": 10.0, "cr": 0.50},
    "claude-sonnet-4-6":         {"in":  3.0, "out": 15.0, "cw5":  3.75, "cw1h":  6.0, "cr": 0.30},
    "claude-sonnet-4-5":         {"in":  3.0, "out": 15.0, "cw5":  3.75, "cw1h":  6.0, "cr": 0.30},
    "claude-haiku-4-5":          {"in":  1.0, "out":  5.0, "cw5":  1.25, "cw1h":  2.0, "cr": 0.10},
    "claude-haiku-4-5-20251001": {"in":  1.0, "out":  5.0, "cw5":  1.25, "cw1h":  2.0, "cr": 0.10},
}
# Fallback por FAMILIA: quando o id exato nao esta na tabela (ex.: uma versao nova de
# Opus/Sonnet/Haiku), casa pela familia pelo proprio nome do modelo -> evita o bug do
# "modelo novo cai no preco velho/errado". Representante = a versao mais recente da familia.
FAMILY_REPRESENTATIVE = {
    "opus":   "claude-opus-4-8",
    "sonnet": "claude-sonnet-4-6",
    "haiku":  "claude-haiku-4-5",
}
# Ultimo recurso quando nao casa nem por familia: assume Opus pra nao subestimar.
FALLBACK_KEY = "claude-opus-4-8"


def env(name, default=""):
    return os.environ.get(name, default)


def resolve_workspace() -> Path:
    return Path(env("DGCLAW_WORKSPACE") or os.getcwd()).resolve()


def resolve_session_dir(workspace: Path) -> Path:
    override = env("DGCLAW_SESSION_DIR")
    if override:
        return Path(override).resolve()
    encoded = str(workspace).replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded


def resolve_slug() -> str:
    return env("DGCLAW_SLUG") or "agente"


def resolve_output_log(workspace: Path, slug: str) -> Path:
    override = env("DGCLAW_TOKENS_LOG")
    if override:
        return Path(override).resolve()
    return workspace / ".dgclaw" / "logs" / f"{slug}-channels-tokens.jsonl"


def resolve_state_file(workspace: Path, slug: str) -> Path:
    override = env("DGCLAW_TOKENS_STATE")
    if override:
        return Path(override).resolve()
    return workspace / ".dgclaw" / "logs" / f".{slug}-tokens-state.json"


def load_pricing(workspace: Path) -> dict:
    """Tabela embutida + override do arquivo (merge por modelo)."""
    pricing = {k: dict(v) for k, v in DEFAULT_PRICING.items()}
    override = env("DGCLAW_PRICING_FILE")
    pf = Path(override).resolve() if override else (workspace / ".dgclaw" / "pricing.json")
    if pf.exists():
        try:
            data = json.loads(pf.read_text())
            # aceita {"pricing": {...}} ou {...} direto
            table = data.get("pricing", data) if isinstance(data, dict) else {}
            for model, p in table.items():
                if isinstance(p, dict):
                    pricing[model] = {**pricing.get(model, {}), **p}
        except Exception as e:
            sys.stderr.write(f"channels-tokens-logger: pricing invalido em {pf}: {e}\n")
    return pricing


def cost_for(model: str, usage: dict, pricing: dict) -> float:
    """Calcula custo USD baseado no usage da mensagem assistant."""
    p = pricing.get(model)
    if not p:
        # id exato desconhecido: casa por familia (opus/sonnet/haiku) pelo nome do
        # modelo, usando o representante da familia (respeita override do pricing file);
        # so entao cai no FALLBACK_KEY (Opus) pra nao subestimar.
        for fam, rep in FAMILY_REPRESENTATIVE.items():
            if fam in (model or ""):
                p = pricing.get(rep)
                break
    if not p:
        p = pricing.get(FALLBACK_KEY) or DEFAULT_PRICING[FALLBACK_KEY]
    in_tok = usage.get("input_tokens", 0) or 0
    out_tok = usage.get("output_tokens", 0) or 0
    cr_tok = usage.get("cache_read_input_tokens", 0) or 0
    cw_tok = usage.get("cache_creation_input_tokens", 0) or 0
    cw_1h = (usage.get("cache_creation") or {}).get("ephemeral_1h_input_tokens", 0) or 0
    cw_5m = max(0, cw_tok - cw_1h)
    cost = (
        in_tok * p.get("in", 0) / 1e6 +
        out_tok * p.get("out", 0) / 1e6 +
        cw_5m * p.get("cw5", 0) / 1e6 +
        cw_1h * p.get("cw1h", 0) / 1e6 +
        cr_tok * p.get("cr", 0) / 1e6
    )
    return round(cost, 6)


def load_state(state_file: Path) -> dict:
    if state_file.exists():
        try:
            return json.loads(state_file.read_text())
        except Exception:
            return {}
    return {}


def save_state(state_file: Path, state: dict):
    state_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_file.with_suffix(state_file.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(state_file)


def short_model(model: str) -> str:
    if "opus" in model:
        return "opus"
    if "sonnet" in model:
        return "sonnet"
    if "haiku" in model:
        return "haiku"
    return model


def process_session(jsonl_path: Path, state: dict, out_fh, slug: str, pricing: dict) -> int:
    """Processa um transcript, escreve novas entries. Retorna count escrito.

    Dedup por uuid: o state guarda o ultimo uuid processado por session_id; numa nova
    rodada, pula tudo ate reencontrar esse uuid e segue dai pra frente.

    Dedup por requestId (fix 01/07/2026): um turno com multiplos blocos (texto +
    tool_use) grava VARIAS linhas assistant com o MESMO requestId e o mesmo usage
    final — o logger antigo escrevia 1 entry por linha e o painel somava o custo
    2-4x. Agora bufferizamos por requestId dentro do run (fica a ultima entry) e
    guardamos o ultimo requestId no state pra nao duplicar entre runs.
    """
    sid = jsonl_path.stem
    st = state.get(sid)
    # compat: state antigo era sid -> uuid (string); novo e sid -> {uuid, last_req}
    if isinstance(st, str):
        st = {"uuid": st, "last_req": None}
    elif not isinstance(st, dict):
        st = {"uuid": None, "last_req": None}
    last_uuid = st.get("uuid")
    last_req = st.get("last_req")
    written = 0
    seen_last = last_uuid is None  # se nunca processou, comeca do inicio

    try:
        with jsonl_path.open() as f:
            lines = f.readlines()
    except Exception as e:
        sys.stderr.write(f"channels-tokens-logger: erro lendo {jsonl_path}: {e}\n")
        return 0

    latest_uuid = last_uuid
    pending = {}  # requestId -> entry (ultima linha do request vence; ordem preservada)
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue

        uuid = d.get("uuid")

        # Skip ate passar do last_uuid (dedup)
        if not seen_last:
            if uuid == last_uuid:
                seen_last = True
            continue

        if d.get("type") != "assistant":
            if uuid:
                latest_uuid = uuid
            continue

        msg = d.get("message", {}) or {}
        usage = msg.get("usage") or {}
        # alguns assistant chunks nao trazem usage final (streaming intermediario)
        if not usage.get("input_tokens") and not usage.get("output_tokens") \
           and not usage.get("cache_read_input_tokens"):
            if uuid:
                latest_uuid = uuid
            continue

        model = msg.get("model", "unknown")
        cost = cost_for(model, usage, pricing)
        short = short_model(model)

        entry = {
            "timestamp": d.get("timestamp") or datetime.utcnow().isoformat() + "Z",
            "cron": f"dm-{slug}-channels",
            "tag": (d.get("requestId") or "")[:32],
            "model": short,
            "duration_ms": None,
            "num_turns": 1,
            "total_cost_usd": cost,
            "session_id": sid,
            "is_error": False,
            "usage": usage,
            "model_usage": {model: {
                "inputTokens": usage.get("input_tokens", 0),
                "outputTokens": usage.get("output_tokens", 0),
                "cacheReadInputTokens": usage.get("cache_read_input_tokens", 0),
                "cacheCreationInputTokens": usage.get("cache_creation_input_tokens", 0),
                "costUSD": cost,
            }},
        }
        # chave de dedup: requestId (linhas do mesmo request repetem o usage final);
        # sem requestId, o uuid da linha vira chave (nao deduplica, comportamento antigo)
        req = d.get("requestId") or uuid or str(len(pending))
        if req != last_req:  # metade final de request ja logado no run anterior nao re-loga
            pending[req] = entry
        if uuid:
            latest_uuid = uuid

    final_req = last_req
    for req, entry in pending.items():
        out_fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        written += 1
        final_req = req

    if latest_uuid != last_uuid or final_req != last_req:
        state[sid] = {"uuid": latest_uuid, "last_req": final_req}

    return written


def main():
    workspace = resolve_workspace()
    slug = resolve_slug()
    session_dir = resolve_session_dir(workspace)
    output_log = resolve_output_log(workspace, slug)
    state_file = resolve_state_file(workspace, slug)
    pricing = load_pricing(workspace)

    if not session_dir.exists():
        sys.stderr.write(f"channels-tokens-logger: sem dir de sessao: {session_dir}\n")
        return 0

    output_log.parent.mkdir(parents=True, exist_ok=True)
    state = load_state(state_file)
    total = 0

    with output_log.open("a") as out_fh:
        for jsonl in sorted(session_dir.glob("*.jsonl")):
            total += process_session(jsonl, state, out_fh, slug, pricing)

    save_state(state_file, state)
    print(f"channels-tokens-logger: {total} novas entries em {output_log}")
    return total


if __name__ == "__main__":
    sys.exit(0 if main() >= 0 else 1)
