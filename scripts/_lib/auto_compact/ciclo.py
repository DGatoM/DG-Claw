"""Fechamento do ciclo de compactação: espera o contexto assentar e avisa que voltou."""

import time
from pathlib import Path

from .ambiente import env, log
from .estado import _antes, _modo_seguro, notify_owner, save_state
from .poke import send_resume_poke
from .transcript import had_compact_since, looks_idle, resolve_live_transcript


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
