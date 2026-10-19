"""Modo restart: bloco de carry-over na working-memory e reinício da unidade da sessão."""

import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import inject as inj  # _lib já está no sys.path (ver auto-compact.py)

from .ambiente import env, log, resolve_working_memory
from .estado import notify_owner


# ─── modo RESTART-COM-CARRY-OVER (TIOCSTI-independente) ───────────────────────
# Em hosts onde a injecao na sessao viva nao funciona (kernel com
# dev.tty.legacy_tiocsti=0 E sem tmux: ex. sessao sob `expect`/`script`), o /compact
# injetado vira TEXTO colado e NUNCA executa, o contexto nunca baixa. A unica alavanca
# confiavel ai e `systemctl restart` do servico da sessao: o launch NAO usa --resume, entao
# a sessao volta history-zero (~base) e a continuidade vem do working-memory.md, que o
# CLAUDE.md manda reler no boot. Antes de reiniciar, gravamos no working-memory um bloco
# CARRY-OVER com o LOG CANONICO da thread do canal (o que o dono VE), pra a sessao fresca
# acordar sabendo a conversa recente. Opt-in via DGCLAW_COMPACT_MODE=restart.

CARRYOVER_START = "<!-- DG-ALIVE-CARRYOVER START (auto-compact) -->"


CARRYOVER_END = "<!-- DG-ALIVE-CARRYOVER END -->"


def _load_thread_log():
    """Importa _lib/thread_log.py (degrada gracioso se faltar)."""
    try:
        import thread_log  # _lib ja esta no sys.path (igual ao inject)
        return thread_log
    except Exception as e:
        log(f"aviso: nao consegui importar thread_log: {e}")
        return None


def build_carryover_block(channel: str, ctx: int, threshold: int, reason: str = None) -> str:
    """Monta o bloco CARRY-OVER: nota de restart + log canonico da thread do canal."""
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    name = env("DGCLAW_NAME") or "voce"
    if reason is None:
        reason = (f"Reiniciada em {now} porque o contexto cruzou {ctx // 1000}k "
                  f"(teto {threshold // 1000}k).")
    try:
        last_n = int(float(env("DGCLAW_CARRYOVER_THREAD_N", "14")))
    except (TypeError, ValueError):
        last_n = 14

    tl = _load_thread_log()
    thread_md = ""
    if tl:
        try:
            sess = tl.find_session(channel)
            if sess:
                events = tl.build_thread_log(sess, last=last_n)
                thread_md = tl.format_md(events)
        except Exception as e:
            log(f"aviso: falha ao montar thread log: {e}")
    if not thread_md:
        thread_md = "_(thread recente indisponivel neste restart)_"

    return f"""{CARRYOVER_START}
## 🔄 Carry-over — acordei agora

*{reason}
Voce e a MESMA {name} — so esta com a sessao fresca pra rodar leve. Continue de onde parou
usando esta working-memory + o diario de hoje.*

**Thread recente do canal (o que o dono VE, em ordem).** Mensagens curtas dele
("sim", "pode resumir", "e ai?") se referem as MAIS RECENTES daqui — inclusive as que
seus crons postaram (marcadas *via cron*). Resolva o referente contra esta thread ANTES de
responder; so pergunte "qual?" se ela realmente nao permitir inferir:

{thread_md}
{CARRYOVER_END}"""


def write_carryover(workspace: Path, channel: str, ctx: int, threshold: int,
                    dry_run: bool = False, reason: str = None) -> str:
    """Insere/atualiza o bloco CARRY-OVER no fim do working-memory.md (idempotente:
    substitui o bloco gerenciado anterior). Devolve o texto do bloco."""
    block = build_carryover_block(channel, ctx, threshold, reason=reason)
    wm = resolve_working_memory(workspace)
    if dry_run:
        log(f"DRY-RUN — carry-over montado ({len(block)} chars), NAO escrevi em {wm}")
        return block
    try:
        body = wm.read_text() if wm.exists() else ""
        if CARRYOVER_START in body and CARRYOVER_END in body:
            pre = body.split(CARRYOVER_START)[0].rstrip()
            post = body.split(CARRYOVER_END, 1)[1].lstrip("\n")
            body = (pre + "\n" + post).rstrip()
        body = body.rstrip() + "\n\n" + block + "\n"
        wm.parent.mkdir(parents=True, exist_ok=True)
        tmp = wm.with_suffix(wm.suffix + ".tmp")
        tmp.write_text(body)
        tmp.replace(wm)
        log(f"carry-over escrito em {wm}")
    except Exception as e:
        log(f"aviso: falha ao escrever carry-over em {wm}: {e}")
    return block


def service_main_pid(svc: str) -> int:
    try:
        out = subprocess.run(["systemctl", "show", svc, "-p", "MainPID", "--value"],
                             capture_output=True, text=True, timeout=15).stdout.strip()
        return int(out) if out.isdigit() else 0
    except Exception:
        return 0


def pid_da_sessao(svc: str, channel: str = None) -> int:
    """PID que prova "sessao nova subiu", para QUALQUER tipo de unidade.

    Conserto de 16/09/2026, vindo de um caso real num agente pessoal. O MainPID sozinho so serve
    para unidade `Type=simple`. Unidade `Type=forking` com `RemainAfterExit=yes` (o
    ExecStart e um `tmux new-session -d`, que devolve na hora) faz o systemd reportar
    **MainPID=0 SEMPRE**, entao a condicao `new_pid != old_pid` nunca podia ser
    verdadeira: o verificador esperava 90 segundos e gritava "nao confirmei boot" com o
    servico active e a sessao no ar.

    E isso nao era so barulho: `restart_and_verify` devolvia False e o `if ok` la embaixo
    ENGOLIA o poke de retomada. Um alarme errado cancelando a retomada de uma tarefa viva.

    O analogo honesto do MainPID, quando ele e 0, e o PID do processo `claude` daquele
    canal, que e exatamente o que o _lib/inject ja sabe achar."""
    pid = service_main_pid(svc)
    if pid:
        return pid
    if channel:
        try:
            achado, _pts = inj.find_pts(channel)
            return int(achado) if achado else 0
        except Exception:
            pass  # sem o pid pela busca de pts, devolve 0 e quem chama trata como "nao achei"
    return 0


def restart_and_verify(svc: str, before_ctx: int, dry_run: bool = False,
                       channel: str = None) -> bool:
    """Reinicia o servico e VERIFICA pela SAUDE do systemd (MainPID novo + active estavel),
    NAO pelo contexto do transcript.

    Por que nao medir contexto pos-restart: a sessao fresca de --channels fica OCIOSA
    esperando a 1a mensagem do canal e NAO materializa transcript ate la. Medir contexto
    logo apos cai no .jsonl velho (morto) e da falso-negativo. Como o launch nao usa
    --resume, um MainPID novo e estavel == sessao fresca == contexto resetado (comeca em
    ~base na 1a atividade). Essa e a prova confiavel."""
    if dry_run:
        log(f"DRY-RUN — reiniciaria {svc} e verificaria saude (PID novo + active estavel)")
        return True

    old_pid = pid_da_sessao(svc, channel)
    try:
        subprocess.run(["systemctl", "restart", svc], check=True, timeout=60,
                       capture_output=True)
    except Exception as e:
        log(f"falha no systemctl restart {svc}: {e}")
        notify_owner(f"dieta-contexto: falha ao reiniciar {svc}. "
                     f"Contexto seguia em {before_ctx // 1000}k.")
        return False

    log(f"{svc} reiniciado (pid antigo {old_pid}) — verificando boot (ate 90s)...")
    deadline = time.monotonic() + 90
    stable_since = None
    while time.monotonic() < deadline:
        time.sleep(6)
        try:
            active = subprocess.run(["systemctl", "is-active", svc],
                                    capture_output=True, text=True, timeout=15).stdout.strip()
        except Exception:
            active = "unknown"
        new_pid = pid_da_sessao(svc, channel)
        # Sem PID nos DOIS lados, nao da pra comparar nada. Antes isso virava False, e
        # o False engolia o poke. Agora, se o servico esta active e estavel, a gente
        # aceita dizendo EXATAMENTE o que foi e o que nao foi provado: nao cancelar a
        # retomada de uma tarefa viva vale mais do que a prova que nao da pra ter.
        sem_pid = (old_pid == 0 and new_pid == 0)
        if active == "active" and (sem_pid or (new_pid and new_pid != old_pid)):
            if stable_since is None:
                stable_since = time.monotonic()
            elif time.monotonic() - stable_since >= 10:
                if sem_pid:
                    log(f"sessao no ar ({svc} active e estavel). NAO consegui ler PID de "
                        f"sessao nem pelo MainPID nem pelo canal, entao o reset do contexto "
                        f"nao esta provado, so o servico. Sigo em frente: engolir o poke de "
                        f"retomada por falta de prova e pior que a falta de prova.")
                else:
                    log(f"sessao fresca no ar (pid {new_pid}, active, estavel). "
                        f"Contexto resetado — comeca em ~base na 1a msg do canal.")
                return True
        else:
            stable_since = None
    final_active = subprocess.run(["systemctl", "is-active", svc],
                                  capture_output=True, text=True).stdout.strip()
    log(f"aviso: nao confirmei boot estavel pos-restart (is-active={final_active})")
    notify_owner(f"dieta-contexto: reiniciei {svc} mas nao confirmei boot estavel "
                 f"(is-active={final_active}). Da uma conferida.")
    return False
