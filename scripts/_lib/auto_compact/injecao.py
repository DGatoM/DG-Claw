"""Entrega de texto na sessão viva (/compact e pokes) pelos transportes do host."""

import json
import os
import subprocess
import time

import inject as inj  # _lib já está no sys.path (ver auto-compact.py)

from .ambiente import env, log


# ─── injecao do /compact (reusa _lib/inject) ──────────────────────────────────

def inject_compact(slug: str, channel: str, dry_run: bool) -> int:
    """Injeta '/compact' na sessao viva. Wrapper fino de inject_text (mantido pelo nome
    porque outros scripts e a doc chamam assim)."""
    return inject_text(slug, channel, "/compact", dry_run)


def rodar_comando_de_host(cmd_tmpl: str, text: str, path=None, dry_run: bool = False,
                          rotulo: str = "comando de host") -> int:
    """Entrega `text` a sessao usando um comando do HOST, em vez dos transportes do plugin.

    Existe porque em host sem TIOCSTI, sem tmux e sem Bunker o plugin fica sem nenhuma
    alavanca sobre a sessao viva, mas o supervisor local costuma ter uma (ex.: o
    agent-runner do DG Claw expoe POST /api/agents/<id>/input, que escreve direto no PTY
    de que ele e dono). Slash-command digitado no PTY EXECUTA; mensagem de canal chega
    como texto e nao executa. Por isso o transporte de host destrava o modo inject.

    Placeholders: {text}, {text_json} (string JSON, com aspas), {file} (se houver arquivo).
    O comando tambem recebe o texto no STDIN e nas envs DGCLAW_POKE_TEXT/DGCLAW_POKE_FILE."""
    cmd = (cmd_tmpl.replace("{text_json}", json.dumps(text))
                   .replace("{file}", str(path) if path else "")
                   .replace("{text}", text))
    if dry_run:
        log(f"DRY-RUN — rodaria {rotulo}: {cmd}")
        return 0
    amb = dict(os.environ, DGCLAW_POKE_TEXT=text, DGCLAW_POKE_FILE=str(path or ""))
    try:
        r = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True,
                           timeout=120, input=text, env=amb)
        if r.returncode == 0:
            log(f"despachado pelo {rotulo} (o comando saiu 0; isso prova que o transporte "
            f"aceitou, NAO que o texto chegou na sessao)")
            return 0
        log(f"{rotulo} saiu {r.returncode}: {(r.stderr or '').strip()[:200]}")
        return 7
    except Exception as e:
        log(f"erro rodando {rotulo}: {e}")
        return 7


def inject_text(slug: str, channel: str, text: str, dry_run: bool) -> int:
    """Injeta um texto qualquer na sessao viva: comando de host (DGCLAW_INJECT_CMD), painel
    (bunker), TIOCSTI (default) ou tmux. Reusa a logica de _lib/inject pra achar o pts, pegar
    o lock por-slug e injetar. Retorna 0 (ok), 2 (sessao morta), 3 (sem permissao), 4 (sem
    lock), 5 (transporte falhou), 7 (comando de host falhou)."""
    # Comando de host vence os demais: configurar essa env ja e um ato explicito, e ela so
    # existe em host onde os transportes nativos nao funcionam.
    cmd_host = env("DGCLAW_INJECT_CMD")
    if cmd_host:
        return rodar_comando_de_host(cmd_host, text, dry_run=dry_run,
                                     rotulo="DGCLAW_INJECT_CMD")
    # O modo sai do _lib (inj.resolve_mode), e nao de uma leitura propria da env: ter um card
    # configurado ja diz qual e o mundo, e ler DGCLAW_INJECT_MODE por conta fazia este script
    # cair no tiocsti (e reportar "sessao morta") em host onde todos os outros timers estavam
    # falando com o painel sem problema nenhum.
    mode = inj.resolve_mode()
    key = inj.lock_key(slug, channel)

    if mode == "bunker":
        # A sessao viva e um card do painel do Bunker, ou um agente de runner proprio, que fala
        # o mesmo protocolo HTTP. Nao ha pts pra disputar nem lock por-slug a pegar: o painel
        # e o dono do terminal e ENFILEIRA o texto ate o card ficar ocioso. Quem sabe digitar
        # la e o _lib/inject; aqui so delegamos, pra existir um lugar so com essa conversa.
        if not inj.is_session_alive(slug, channel):
            return 2
        if dry_run:
            log(f"DRY-RUN (bunker) — injetaria {text!r} no card {inj._bunker_card()}")
            return 0
        ok, motivo = inj._inject_bunker(text, True)
        if not ok:
            log(f"falha ao injetar no card {inj._bunker_card()}: {motivo}")
            return 5
        log(f"{text!r} entregue ao card {inj._bunker_card()} ({motivo})")
        return 0

    if mode == "tmux":
        if not inj.is_session_alive(slug, channel):
            return 2
        if dry_run:
            log(f"DRY-RUN (tmux) — injetaria {text!r} em {channel}")
            return 0
        lock = inj.acquire_lock(key)
        if lock is None:
            return 4
        try:
            time.sleep(2)
            inj._inject_tmux(slug, text)
            time.sleep(2)
        except Exception as e:
            log(f"falha ao injetar via tmux: {e}")
            return 5
        finally:
            inj.fcntl.flock(lock, inj.fcntl.LOCK_UN)
            lock.close()
        return 0

    pid, pts = inj.find_pts(channel)
    if not pts:
        return 2
    if dry_run:
        log(f"DRY-RUN (tiocsti) — injetaria {text!r} em {pts} (pid {pid})")
        return 0
    lock = inj.acquire_lock(key)
    if lock is None:
        return 4
    try:
        time.sleep(2)
        try:
            # Enter separado, como no _lib/inject (02/10/2026): texto longo chega em rajada,
            # o TUI trata como colagem e o \r grudado no fim vira parte dela.
            inj._inject_tiocsti(pts, text)
            time.sleep(1.0)
            inj._inject_tiocsti(pts, "\r")
        except PermissionError:
            return 3
        time.sleep(4)
    except Exception as e:
        log(f"falha ao injetar via tiocsti em {pts}: {e}")
        return 5
    finally:
        inj.fcntl.flock(lock, inj.fcntl.LOCK_UN)
        lock.close()
    log(f"{text!r} injetado em {pts} (pid {pid})")
    return 0
