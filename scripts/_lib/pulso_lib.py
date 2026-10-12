#!/usr/bin/env python3
"""pulso_lib.py (DG Claw) — registro no ledger do Pulso (camada de PRECISAO) p/ crons .py.

ZERO path hardcoded de maquina/agente. O ledger vai pra
DGCLAW_PULSO_DIR (default <ws>/.dgclaw/logs/pulso), derivado de DGCLAW_WORKSPACE.

Uso:
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "_lib"))
    from pulso_lib import pulso, pulso_auto

    pulso("ok", "12 itens")                  # registro explicito
    pulso("erro", "rebuild falhou")

    with pulso_auto("build-wm"):             # context manager: ok se sair limpo,
        ...                                  # erro se levantar excecao
        ...

O id default vem do nome do arquivo do script chamador (basename sem extensao).
Sobrescreva via PULSO_ID no ambiente ou pulso_auto("id-explicito").
"""
import json
import os
import sys
import datetime
from contextlib import contextmanager

_EXPLICIT = {"done": False}


def _ledger_dir() -> str:
    d = os.environ.get("DGCLAW_PULSO_DIR")
    if d:
        return d
    ws = os.environ.get("DGCLAW_WORKSPACE")
    if ws:
        return os.path.join(ws, ".dgclaw", "logs", "pulso")
    return os.environ.get(
        "PULSO_LEDGER_DIR", os.path.join(os.getcwd(), ".dgclaw", "logs", "pulso")
    )


def _default_id() -> str:
    if os.environ.get("PULSO_ID"):
        return os.environ["PULSO_ID"]
    main = sys.argv[0] or "desconhecido"
    base = os.path.basename(main)
    for ext in (".py", ".sh"):
        if base.endswith(ext):
            base = base[: -len(ext)]
    return base


def pulso_write(pid: str, status: str, detalhe: str = "") -> None:
    if not pid:
        return
    try:
        ledger = _ledger_dir()
        os.makedirs(ledger, exist_ok=True)
        day = datetime.date.today().isoformat()
        rec = {
            "ts": datetime.datetime.now().astimezone().isoformat(),
            "id": pid,
            "status": status,
            "detalhe": (detalhe or "").replace("\n", " ")[:500],
        }
        with open(os.path.join(ledger, f"{day}.jsonl"), "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        pass  # nunca derruba o chamador


def pulso(status: str, detalhe: str = "", pid: str = None) -> None:
    _EXPLICIT["done"] = True
    pulso_write(pid or _default_id(), status, detalhe)


@contextmanager
def pulso_auto(pid: str = None):
    _EXPLICIT["done"] = False
    real_id = pid or _default_id()
    try:
        yield
    except BaseException as e:  # noqa: BLE001
        if not _EXPLICIT["done"]:
            pulso_write(real_id, "erro", f"{type(e).__name__}: {e}")
        raise
    else:
        if not _EXPLICIT["done"]:
            pulso_write(real_id, "ok", "")
