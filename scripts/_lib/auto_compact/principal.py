"""Ponto de entrada: decide se compacta e como."""

import argparse
from datetime import datetime, timezone
from pathlib import Path

import inject as inj  # _lib já está no sys.path (ver auto-compact.py)

from .ambiente import env, escalation_marks, log, resolve_compact_mode, resolve_session_dir, resolve_slug, resolve_state_file, resolve_threshold, resolve_workspace
from .ciclo import esperar_assentar_e_fechar, fechar_ciclo_pendente
from .estado import _antes, _modo_seguro, cooldown_remaining, load_state, notify_owner, save_state
from .injecao import inject_compact
from .modo_restart import do_restart_compact
from .poke import resume_poke_enabled, write_resume_poke
from .tarefas import _resumo_bg, background_tasks, turn_snapshot
from .transcript import context_tokens, had_compact_since, looks_idle, resolve_live_transcript


def main():
    ap = argparse.ArgumentParser(description="Auto-compacta a sessao viva da persona DG Claw.")
    ap.add_argument("--threshold", default=None,
                    help="override do teto: fracao (<=1) do limite ou tokens absolutos (>1)")
    ap.add_argument("--dry-run", action="store_true", help="so reporta, NAO injeta")
    ap.add_argument("--force", action="store_true",
                    help="ignora cooldown e checagem de ociosidade")
    ap.add_argument("--ignore-cooldown", action="store_true",
                    help="fura so o cooldown, mantendo a checagem de ociosidade "
                         "(uso: restart-fresh noturno da reflexao)")
    # O runner do timer chama 'python3 auto-compact.py <config.sh>' (o config ja foi sourceado
    # pro env antes do exec). Aceitamos esse positional e o IGNORAMOS, tudo vem de DGCLAW_*.
    ap.add_argument("config", nargs="?", default=None, help=argparse.SUPPRESS)
    args = ap.parse_args()

    # OPT-IN do auto-recovery (mesmo flag do watchdog e do .sh aposentado): off = no-op puro.
    # --force NAO fura isto: se o dono desligou a auto-recuperacao, nem manual via timer compacta.
    if (env("DGCLAW_AUTO_RECOVERY", "on") or "on").lower() == "off":
        log("DGCLAW_AUTO_RECOVERY=off — auto-compact desligado (no-op)")
        return 0

    workspace = resolve_workspace()
    slug = resolve_slug()
    channel = inj.channel_name(slug)
    session_dir = resolve_session_dir(workspace)
    state_file = resolve_state_file(workspace, slug)
    threshold, limit, frac = resolve_threshold(args.threshold)

    try:
        idle_sec = int(float(env("DGCLAW_COMPACT_IDLE_SEC", "45")))
    except (TypeError, ValueError):
        idle_sec = 45
    try:
        cooldown_min = int(float(env("DGCLAW_COMPACT_COOLDOWN_MIN", "20")))
    except (TypeError, ValueError):
        cooldown_min = 20

    desc = f"{threshold // 1000}k tokens"
    if frac is not None:
        desc = f"{int(frac * 100)}% de {limit // 1000}k = {threshold // 1000}k"
    log(f"persona '{slug}' | canal '{channel}' | teto: {desc}")

    # 1) sessao viva? (no-op gracioso se morta)
    if not inj.is_session_alive(slug, channel):
        log("sessao viva nao ativa — no-op gracioso (exit 0)")
        return 0

    # 2) acha o transcript e estima o contexto
    transcript = resolve_live_transcript(session_dir, slug, channel)
    if not transcript:
        log(f"transcript da sessao '{channel}' nao encontrado em {session_dir} — no-op")
        return 0

    # Transcript MORTO (so modo restart): a sessao fresca pos-restart fica ociosa e
    # nao materializa transcript novo ate a 1a mensagem. Medir o transcript da sessao
    # ANTIGA (contexto alto congelado) causava LOOP de restart a cada timer (bug visto
    # num agente pessoal em 01/07/2026: 48 restarts/dia silenciosos). Se o arquivo achado e o mesmo
    # registrado como morto no ultimo restart, esperamos o novo aparecer.
    st = load_state(state_file)
    dead = st.get("dead_transcript")
    if dead and str(transcript) == str(dead):
        log(f"transcript ainda e o morto do ultimo restart ({Path(dead).name}) — "
            "aguardando sessao nova materializar; no-op")
        return 0

    # 2.5) poke de retomada PENDENTE do ciclo anterior (modo inject). O /compact demora
    # minutos pra assentar, entao nao adianta acordar a persona na hora: a gente espera o
    # compact_boundary aparecer e a sessao ficar ociosa, e SO ENTAO manda ela retomar.
    pend = st.get("pending_resume_poke")
    # MODO DE SEGURANCA (01/10/2026): se a sessao foi reiniciada sem a conversa anterior
    # (ver _lib/reinicio.py), um poke de retomada nascido ANTES disso manda a persona
    # voltar ao assunto que a travou. Foi exatamente o caminho por onde o veneno voltou
    # num agente pessoal em 30/09: o poke de retomada mandou ela reler o transcript morto. Poke assim
    # e descartado, com registro, e nunca entregue.
    if pend:
        marca_ms = _modo_seguro(workspace)
        if marca_ms and _antes(pend.get("ts"), marca_ms.get("ativadoEm")):
            log(f"modo de seguranca ligado desde {marca_ms.get('ativadoEm')}: descartei o poke de "
                f"retomada de {pend.get('ts')} (ele levaria a sessao de volta a conversa que travou)")
            st.pop("pending_resume_poke", None)
            save_state(state_file, st)
            pend = None
    if pend and not args.dry_run:
        nascido = pend.get("ts") or ""
        expirou = False
        try:
            idade = (datetime.now(timezone.utc)
                     - datetime.fromisoformat(nascido)).total_seconds() / 60
            expirou = idade > float(env("DGCLAW_RESUME_POKE_TTL_MIN", "60"))
        except Exception as e:
            log(f"poke pendente com ts ou DGCLAW_RESUME_POKE_TTL_MIN invalido (ts={nascido!r}): {e}. "
                "Nao vou expirar o poke; corrija a variavel ou apague o arquivo de poke pendente.")
        if expirou:
            # Nao descarta em silencio: o dono ja recebeu o "ja volto" antes da compactacao,
            # e ficar sem o "voltei" e pior que um aviso feio.
            log("retomada pendente expirou sem a compactacao assentar — descartando e avisando")
            notify_owner(f"Falei que ja voltava da compactacao e ela nao assentou a tempo. "
                         f"Se eu estava no meio de alguma coisa, me lembra o que era. "
                         f"— {env('DGCLAW_NAME') or slug}")
            st.pop("pending_resume_poke", None)
            save_state(state_file, st)
        elif not fechar_ciclo_pendente(st, state_file, session_dir, slug, channel,
                                       workspace, idle_sec):
            log("poke de retomada pendente: compactacao ainda nao assentou — espero o proximo ciclo")

    ctx = context_tokens(transcript)
    if ctx == 0:
        log("sem usage no transcript ainda — no-op")
        return 0
    log(f"contexto estimado: {ctx // 1000}k tokens (teto {threshold // 1000}k)")

    if ctx <= threshold:
        if st.get("dead_transcript"):
            st.pop("dead_transcript", None)
            save_state(state_file, st)
        log("abaixo do teto — nada a fazer")
        return 0

    # 3) cooldown (--ignore-cooldown fura so o cooldown; a checagem de ociosidade fica)
    if not (args.force or args.ignore_cooldown):
        rem = cooldown_remaining(st, cooldown_min)
        if rem > 0:
            log(f"acima do teto, mas em cooldown ({rem:.0f}min restantes) — pulando")
            return 0

    # 4) ociosidade COM ESCALADA. Antes a checagem era binaria: se a sessao parecia
    # ocupada, adiava, e ponto. Numa conversa viva isso adia TODO ciclo e o contexto sobe
    # sem teto (caso real num agente pessoal em 19/08/2026: de 150k a 604k sem uma compactacao). Agora
    # a espera encolhe conforme o excesso, e no nivel critico compacta mesmo com turno em
    # voo, porque o poke de retomada devolve a tarefa.
    snap = turn_snapshot(transcript)
    hot_at, crit_at = escalation_marks(threshold, limit)
    if ctx >= crit_at:
        nivel, idle_eff = "CRITICO", 0
    elif ctx >= hot_at:
        nivel, idle_eff = "quente", max(5, int(idle_sec / 4))
    else:
        nivel, idle_eff = "normal", idle_sec
    if not args.force and idle_eff > 0 and not looks_idle(transcript, idle_eff):
        log(f"acima do teto, mas a sessao parece OCUPADA (turno em voo; nivel {nivel}, "
            f"quente>={hot_at // 1000}k critico>={crit_at // 1000}k) — adiando compact")
        return 0
    if idle_eff == 0 and not looks_idle(transcript, idle_sec):
        como = ("turno em voo" if snap.get("busy") else "sessao ainda quentinha")
        log(f"nivel CRITICO ({ctx // 1000}k >= {crit_at // 1000}k): compacto MESMO com "
            f"{como}" + (" e devolvo a tarefa pelo poke de retomada" if snap.get("busy") else ""))

    # ── modo RESTART (TIOCSTI-independente): carry-over + systemctl restart + verify ──
    if resolve_compact_mode() == "restart":
        # Trabalho em segundo plano segura o restart igual turno em voo segura (fix
        # 25/09/2026, ver background_tasks), mas SO no nivel normal. Segurar ate o
        # critico deixou um agente pessoal de 4 a 5h/dia acima de 300k; como o poke de retomada
        # funcionou em 9 de 9 cortes reais, do nivel quente em diante compensa compactar
        # e deixar a persona relancar (08/10/2026).
        bg = [t for t in background_tasks(transcript) if t["segura"]]
        if bg and nivel == "normal" and not args.force:
            log(f"acima do teto, mas {len(bg)} tarefa(s) em segundo plano rodando "
                f"({_resumo_bg(bg)}; nivel {nivel}) — adiando restart")
            return 0
        return do_restart_compact(workspace, slug, channel, ctx, threshold,
                                  state_file, st, args.dry_run, transcript=transcript,
                                  snap=snap, nivel=("CRITICO" if args.force else nivel),
                                  idle_eff=(0 if args.force else idle_eff))

    # 4.5) a injecao ANTERIOR surtiu efeito? Se ja injetamos antes e NENHUM compact_boundary
    # apareceu desde entao (e ainda estamos acima do teto), o /compact foi engolido (sessao
    # ocupada na hora, tipico). Conta a falha e, ao atingir o limite, alerta o dono.
    prev = st.get("last_compact_ts")
    if prev and not args.force:
        try:
            fail_k = max(1, int(float(env("DGCLAW_COMPACT_FAIL_ALERT", "2"))))
        except (TypeError, ValueError):
            fail_k = 2
        if had_compact_since(session_dir, prev):
            st["consecutive_fail"] = 0
        else:
            st["consecutive_fail"] = st.get("consecutive_fail", 0) + 1
            log(f"injecao anterior de /compact nao deixou compact_boundary "
                f"(falha {st['consecutive_fail']}/{fail_k})")
            if st["consecutive_fail"] == fail_k:
                name = env("DGCLAW_NAME") or slug
                notify_owner(
                    f"auto-compact ({name}): injetei /compact {st['consecutive_fail']}x e o "
                    f"contexto nao baixou ({ctx // 1000}k > teto). A sessao pode estar sempre "
                    f"ocupada na hora do compact, ou o transporte falhou. Da uma olhada.")
        save_state(state_file, st)

    # 5) injeta /compact
    log(f"{ctx // 1000}k > teto -> injetando /compact na sessao viva")
    # AVISO ANTES: a sumarizacao segura a persona por minutos. Sem isto a pessoa fala com
    # ela e nao recebe nada, sem saber por que.
    if not args.dry_run:
        notify_owner(f"Compactando nossa conversa pra rodar leve... ja volto. "
                     f"— {env('DGCLAW_NAME') or slug}")
    rc = inject_compact(slug, channel, args.dry_run)

    if args.dry_run:
        return 0

    if rc == 0:
        agora = datetime.now(timezone.utc).isoformat()
        st["last_compact_ts"] = agora
        st["ctx_at_compact"] = ctx
        mid_task = bool(snap.get("busy")) and resume_poke_enabled()
        # Nem o poke nem o "voltei" saem agora: o /compact ainda esta sumarizando e a
        # keystroke se perderia. Ficam PENDENTES e saem quando o compact_boundary aparecer:
        # normalmente ainda neste run (esperar_assentar_e_fechar), senao no proximo ciclo.
        # Com tarefa na metade sai o poke (e quem fala e a persona); sem tarefa sai so o
        # "voltei", pra fechar o ciclo do "ja volto".
        pk = write_resume_poke(workspace, slug, snap, ctx, args.dry_run) if mid_task else None
        st["pending_resume_poke"] = {"file": str(pk) if pk else None, "ts": agora,
                                     "since": agora, "ctx": ctx}
        save_state(state_file, st)
        log("/compact injetado — o motor vai sumarizar (demora ~min)")
        esperar_assentar_e_fechar(st, state_file, session_dir, slug, channel, workspace,
                                  idle_sec)
        return 0
    if rc == 2:
        log("sessao ficou indisponivel na hora de injetar — no-op gracioso")
        return 0
    if rc == 3:
        log("PermissionError no TIOCSTI — precisa ser root ou use DGCLAW_INJECT_MODE=tmux")
        return 3
    if rc == 4:
        log("nao consegui o lock de injecao a tempo — pulando (evita colisao de keystrokes)")
        return 4
    log(f"falha ao injetar (rc={rc})")
    return rc
