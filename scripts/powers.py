#!/usr/bin/env python3
"""
powers.py (DG Claw) — CRUD do catalogo de poderes (powers.json).

powers.json e a fonte da verdade lida por DOIS consumidores:
  - os crons (checam `enabled` antes de mexer em qualquer coisa de um poder)
  - o painel robusto (mostra a aba travada/ativa conforme `enabled`)

Local: $DGCLAW_WORKSPACE/.dgclaw/powers.json
       (ou via --file <path>)

Comandos:
  list                       imprime o catalogo (json)
  get <id>                   imprime um poder (json)
  is-enabled <id>            rc 0 se ativo, 1 se travado (pros crons)
  enable <id> [--timers a,b] marca enabled=true, grava cron_timers e instalado_em
  disable <id>               marca enabled=false (preserva dados)
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path


def powers_file():
    for i, a in enumerate(sys.argv):
        if a == "--file" and i + 1 < len(sys.argv):
            return Path(sys.argv[i + 1])
    ws = os.environ.get("DGCLAW_WORKSPACE", os.getcwd())
    return Path(ws) / ".dgclaw" / "powers.json"


PF = powers_file()


def load():
    if PF.exists():
        return json.loads(PF.read_text())
    return {"schema": 1, "powers": []}


def save(d):
    PF.parent.mkdir(parents=True, exist_ok=True)
    d["updatedAt"] = datetime.utcnow().isoformat() + "Z"
    PF.write_text(json.dumps(d, indent=2, ensure_ascii=False))


def find(d, pid):
    for p in d.get("powers", []):
        if p.get("id") == pid:
            return p
    return None


def main():
    # parsing simples (ignora o par --file <path> ja consumido em powers_file)
    clean = []
    skip = False
    for i, a in enumerate(sys.argv[1:]):
        if skip:
            skip = False; continue
        if a == "--file":
            skip = True; continue
        clean.append(a)

    if not clean:
        print(__doc__); sys.exit(1)
    cmd = clean[0]
    d = load()

    if cmd == "list":
        print(json.dumps(d, indent=2, ensure_ascii=False)); return

    if cmd == "get":
        p = find(d, clean[1]);
        print(json.dumps(p, indent=2, ensure_ascii=False) if p else "null")
        return

    if cmd == "is-enabled":
        p = find(d, clean[1])
        sys.exit(0 if (p and p.get("enabled")) else 1)

    if cmd == "enable":
        pid = clean[1]
        p = find(d, pid)
        if not p:
            print(f"poder desconhecido: {pid}", file=sys.stderr); sys.exit(1)
        p["enabled"] = True
        p["instalado_em"] = datetime.utcnow().isoformat() + "Z"
        p.pop("locked_reason", None)
        if "--timers" in clean:
            t = clean[clean.index("--timers") + 1]
            p["cron_timers"] = [x for x in t.split(",") if x]
        save(d)
        print(json.dumps(p, ensure_ascii=False)); return

    if cmd == "disable":
        pid = clean[1]
        p = find(d, pid)
        if not p:
            print(f"poder desconhecido: {pid}", file=sys.stderr); sys.exit(1)
        p["enabled"] = False
        p["locked_reason"] = "Desativado pelo dono. Reative com /dgclaw:powers install " + pid
        save(d)
        print(json.dumps(p, ensure_ascii=False)); return

    print(f"comando desconhecido: {cmd}", file=sys.stderr); sys.exit(1)


if __name__ == "__main__":
    main()
