"""Compactação pelo modo restart (carry-over, reinício e poke)."""

import time
from datetime import datetime, timezone
from pathlib import Path

from .ambiente import env, log, resolve_channel_service
from .carryover import restart_and_verify, write_carryover
from .estado import notify_owner, save_state
from .poke import resume_poke_enabled, send_resume_poke, write_resume_poke
from .tarefas import _resumo_bg, background_tasks, turn_snapshot
from .transcript import looks_idle


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
    # leva ate ~18s, e num agente pessoal era nessa janela que ela acordava sem ninguem ver. O bloco
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
        # arquivo ate aparecer um novo (evita loop de restart, ver main passo 2)
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
