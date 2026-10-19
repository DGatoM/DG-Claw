"""Variáveis de ambiente (contrato DG_CLAW), caminhos e teto de contexto."""

import os
from datetime import datetime, timezone
from pathlib import Path


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
    """working-memory.md da persona: o carregador de continuidade que a sessao fresca
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
