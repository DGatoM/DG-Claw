"""Guardas antes de injetar o /compact: agente com fila, compact recente e recuo depois de falhas."""

import inject as inj  # _lib já está no sys.path (ver auto-compact.py)

from .ambiente import env, log
from .transcript import had_compact_since

# Teto do recuo: depois de várias falhas seguidas, o auto-compact tenta no máximo a cada 4 h.
RECUO_MAX_MIN = 240


def _int_env(nome: str, padrao: int) -> int:
    try:
        return max(1, int(float(env(nome, str(padrao)))))
    except (TypeError, ValueError):
        return padrao


def agente_ocupado_no_bunker():
    """Motivo (texto) para NAO enfileirar o /compact agora, ou None se pode seguir.

    No runner o /compact entra na fila de ocioso: enfileirado atras de trabalho ele vira uma pilha
    de /compact, e o segundo seguido cai em "Not enough messages to compact." (19/11/2026, agente
    de cliente ficou horas com a fila presa). So se enfileira com o card idle e a fila vazia.
    Sem conseguir ler o estado, segue como antes (nao trava o compact por falha de leitura)."""
    if inj.resolve_mode() != "bunker":
        return None
    card = inj._bunker_estado()
    if not card:
        log("nao consegui ler o estado do card (painel fora do ar, cofre trancado ou resposta "
            "invalida); sigo sem a guarda de fila, como antes")
        return None
    status = card.get("status")
    try:
        fila = int(card.get("naFilaTotal") or 0)
    except (TypeError, ValueError):
        fila = 0
    if status != "idle" or fila > 0:
        return (f"o agente esta {status} (fila {fila}); nao enfileiro /compact, "
                f"tento no proximo ciclo")
    return None


def acabou_de_compactar(session_dir):
    """True se algum transcript tem compact_boundary nos ultimos DGCLAW_COMPACT_MIN_INTERVAL_MIN
    minutos (padrao 10): compactar de novo logo depois so tem o que recusar."""
    from datetime import datetime, timedelta, timezone
    minutos = _int_env("DGCLAW_COMPACT_MIN_INTERVAL_MIN", 10)
    corte = (datetime.now(timezone.utc) - timedelta(minutes=minutos)).isoformat()
    return had_compact_since(session_dir, corte)


def cooldown_com_recuo(cooldown_min: int, falhas: int, limite_alerta: int) -> int:
    """Cooldown em minutos. Com falhas >= limite_alerta ele dobra a cada falha (limite de 4 h)."""
    if falhas < limite_alerta:
        return cooldown_min
    return min(RECUO_MAX_MIN, cooldown_min * (2 ** falhas))
