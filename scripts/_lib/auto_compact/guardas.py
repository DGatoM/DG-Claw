"""Guardas antes de injetar o /compact: agente com fila e compact recente."""

import inject as inj  # _lib já está no sys.path (ver auto-compact.py)

from .ambiente import env
from .transcript import had_compact_since_arquivo


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
    total = card.get("naFilaTotal")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        return (f"o card veio sem um tamanho de fila valido (naFilaTotal={total!r}); "
                f"nao enfileiro /compact as cegas, adio para o proximo ciclo")
    lista = card.get("naFila")
    if isinstance(lista, list) and lista:
        total = max(total, len(lista))
    if status != "idle" or total > 0:
        return (f"o agente esta {status} (fila {total}); nao enfileiro /compact, "
                f"tento no proximo ciclo")
    return None


def acabou_de_compactar(transcript):
    """True se o transcript da sessao viva tem compact_boundary nos ultimos
    DGCLAW_COMPACT_MIN_INTERVAL_MIN minutos (padrao 10): compactar de novo logo depois so tem o
    que recusar. Olha so o transcript vivo: uma sessao paralela no mesmo workspace compactando
    nao pode bloquear a principal. So conta marcador com timestamp proprio valido (o mtime do
    arquivo nao prova nada: qualquer escrita o renova)."""
    from datetime import datetime, timedelta, timezone
    minutos = _int_env("DGCLAW_COMPACT_MIN_INTERVAL_MIN", 10)
    corte = (datetime.now(timezone.utc) - timedelta(minutes=minutos)).isoformat()
    return had_compact_since_arquivo(transcript, corte, sem_timestamp_conta=False)
