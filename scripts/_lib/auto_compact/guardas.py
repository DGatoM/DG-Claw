"""Guardas antes de injetar o /compact: agente com fila, compact recente e recuo depois de falhas."""

import inject as inj  # _lib já está no sys.path (ver auto-compact.py)

from .ambiente import env
from .transcript import had_compact_since_arquivo

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
    Sem conseguir ler o estado (rede, cofre trancado, JSON invalido) NAO segue: adia para o proximo
    ciclo, porque enfileirar as cegas e o que empilha /compact."""
    if inj.resolve_mode() != "bunker":
        return None
    card = inj._bunker_estado()
    if not card:
        return ("nao consegui ler o estado do card (painel fora do ar, cofre trancado ou resposta "
                "invalida); nao enfileiro /compact as cegas, adio para o proximo ciclo")
    status = card.get("status")
    try:
        fila = int(card.get("naFilaTotal") or 0)
    except (TypeError, ValueError):
        fila = 0
    if status != "idle" or fila > 0:
        return (f"o agente esta {status} (fila {fila}); nao enfileiro /compact, "
                f"tento no proximo ciclo")
    return None


def acabou_de_compactar(transcript):
    """True se o transcript da sessao viva tem compact_boundary nos ultimos
    DGCLAW_COMPACT_MIN_INTERVAL_MIN minutos (padrao 10): compactar de novo logo depois so tem o
    que recusar. Olha so o transcript vivo: uma sessao paralela no mesmo workspace compactando
    nao pode bloquear a principal."""
    from datetime import datetime, timedelta, timezone
    minutos = _int_env("DGCLAW_COMPACT_MIN_INTERVAL_MIN", 10)
    corte = (datetime.now(timezone.utc) - timedelta(minutes=minutos)).isoformat()
    return had_compact_since_arquivo(transcript, corte)


def cooldown_com_recuo(cooldown_min: int, falhas: int, limite_alerta: int) -> int:
    """Cooldown em minutos. Com falhas >= limite_alerta ele dobra a cada falha (limite de 4 h)."""
    # Contador vindo de arquivo de estado: so inteiro >= 0 vale, e o expoente tem teto para a potencia
    # nao crescer sem limite.
    if isinstance(falhas, bool) or not isinstance(falhas, int) or falhas < 0:
        falhas = 0
    if falhas < limite_alerta:
        return cooldown_min
    return min(RECUO_MAX_MIN, cooldown_min * (2 ** min(falhas, 8)))
