#!/usr/bin/env python3
"""poke-verify.py — Verificador deterministico de pokes (DG Claw). ZERO token LLM.

Roda num timer (a cada ~15min). Para cada poke pendente cujo prazo venceu:
  - TEM recibo (ACK explicito OU artefato fresco) -> resolve (sucesso), tira de pending.
  - NAO tem recibo e ainda ha retries -> re-injeta (roda o `retrigger` do poke) e
    empurra o prazo.
  - NAO tem recibo e esgotou os retries -> marca FAILED, alerta o dono (notify-owner)
    e deixa a flag em pokes/failed/ (o build-wm das 7h pode abrir o dia avisando).

E o fecho do ciclo: o cron injeta o poke (fire-and-forget) e ESTE script garante que
ele REALMENTE foi recebido/concluido — sem isso a injecao era cega.

Uso:  poke-verify.py <.dgclaw/config.sh>   (a unit faz `source config; exec python3 ...`)
Env esperado (vem do config sourced): DGCLAW_WORKSPACE, DGCLAW_PLUGIN_ROOT, DGCLAW_SLUG.
"""

import os
import subprocess
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "_lib"))
import poke_ledger as L  # noqa: E402


def env(name, default=""):
    return os.environ.get(name, default)


def main():
    ws = env("DGCLAW_WORKSPACE")
    if not ws:
        print("poke-verify: sem DGCLAW_WORKSPACE — no-op", file=sys.stderr)
        return 0
    plugin = env("DGCLAW_PLUGIN_ROOT", os.path.join(ws, ".dgclaw", "plugin"))
    slug = env("DGCLAW_SLUG", "agente")
    logdir = os.path.join(ws, ".dgclaw", "logs")
    os.makedirs(logdir, exist_ok=True)
    logpath = os.path.join(logdir, "poke-verify.log")

    def log(msg):
        line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
        print(line, file=sys.stderr)
        try:
            with open(logpath, "a") as f:
                f.write(line + "\n")
        except OSError:
            pass

    def notify_owner(msg):
        script = os.path.join(plugin, "scripts", "notify-owner.sh")
        if not os.path.exists(script):
            log(f"notify-owner ausente ({script}) — alerta nao enviado: {msg}")
            return
        try:
            subprocess.run(["bash", script, msg], timeout=30,
                           capture_output=True, text=True)
        except Exception as e:
            log(f"notify-owner falhou: {e}")

    now = int(time.time())
    pendings = L.load_pending(ws)
    due = [r for r in pendings if now >= r.get("deadline_epoch", 0)]
    if not pendings:
        return 0
    log(f"slug={slug} pendentes={len(pendings)} vencidos={len(due)}")

    for rec in due:
        key = rec.get("key")
        tag = rec.get("tag", "?")
        if L.has_receipt(ws, key):
            L.resolve(ws, key, reason="receipt")
            log(f"[{key}] ✓ recibo confirmado — sucesso")
            continue

        retries_used = rec.get("retries_used", 0)
        max_retries = rec.get("max_retries", 0)
        retrigger = rec.get("retrigger") or ""

        if retries_used < max_retries and retrigger:
            L.bump_retry(ws, key)
            log(f"[{key}] sem recibo — retry {retries_used + 1}/{max_retries}: {retrigger}")
            try:
                subprocess.run(retrigger, shell=True, timeout=180,
                               capture_output=True, text=True)
            except Exception as e:
                log(f"[{key}] retrigger falhou: {e}")
        else:
            reason = "sem retrigger" if not retrigger else f"{max_retries} tentativas"
            L.mark_failed(ws, key, note=reason)
            log(f"[{key}] ✗ esgotado ({reason}) — FAILED + alerta dono")
            notify_owner(
                f"⚠️ DG Claw ({slug}): o poke '{tag}' (chave {key}) nao confirmou "
                f"recibo apos {max_retries} tentativa(s). Pode ser sessao travada ou "
                f"a rotina nao rodou. Veja .dgclaw/pokes/failed/ e .dgclaw/logs/poke-verify.log."
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
