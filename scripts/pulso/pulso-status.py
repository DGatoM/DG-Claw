#!/usr/bin/env python3
"""pulso-status.py (DG Claw) — calcula o ESTADO de cada componente esperado hoje.

Combina pulso-discover.py (o que deveria rodar) com 3 camadas de sinal:
  1. ledger  (preciso)  — DGCLAW_PULSO_DIR/<data>.jsonl (carimbo do pulso_auto)
  2. log     (fallback) — mtime do log do componente na janela + grep de erro
  3. systemd            — is-active (pro servico principal e timers travados)

Estados (as luzinhas):
  pendente   (apagada)  — hora ainda nao chegou
  ok         (verde)    — rodou na janela
  erro       (vermelho) — rodou e falhou
  faltou     (vermelho) — venceu a janela e nao rodou
  aguardando (amarelo)  — passou do horario mas ainda dentro da janela
  sem-sinal  (cinza)    — sem log e sem ledger (componente sem retrofit ainda)

pct = ok / (ok + erro + faltou)  -> % do que ja venceu e passou.
Saida: tabela CLI (default) ou --json (painel/report).

Env (parametrizado, ZERO hardcode):
  DGCLAW_PULSO_DIR  ledger (default <ws>/.dgclaw/logs/pulso).
  DGCLAW_WORKSPACE  base p/ derivar ledger e os logs <ws>/.dgclaw/logs/<id>.log.
"""
import json
import os
import re
import subprocess
import sys
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DISCOVER = os.path.join(HERE, "pulso-discover.py")

JANELA_PONTUAL_MIN = 90          # tolerancia p/ um cron pontual rodar
ERR_RE = re.compile(r"(Traceback|ERROR|Exception|rc=[1-9]|Unauthorized|exit [1-9]|FAILED|❌)", re.I)
DUE = ("ok", "erro", "faltou")   # estados que contam no denominador do pct


def _ledger_dir() -> str:
    d = os.environ.get("DGCLAW_PULSO_DIR")
    if d:
        return d
    ws = os.environ.get("DGCLAW_WORKSPACE", os.getcwd())
    return os.path.join(ws, ".dgclaw", "logs", "pulso")


def _logs_dir() -> str:
    ws = os.environ.get("DGCLAW_WORKSPACE", os.getcwd())
    return os.path.join(ws, ".dgclaw", "logs")


def load_discover(date):
    out = subprocess.run(
        ["python3", DISCOVER, "--json", f"--date={date.isoformat()}"],
        capture_output=True, text=True, timeout=40,
    )
    if not out.stdout.strip():
        return {"date": date.isoformat(), "componentes": []}
    return json.loads(out.stdout)


def load_ledger(date):
    by_id = {}
    path = os.path.join(_ledger_dir(), f"{date.isoformat()}.jsonl")
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = rec.get("ts", "")
                try:
                    dt = datetime.datetime.fromisoformat(ts).astimezone().replace(tzinfo=None)
                except Exception:
                    continue
                by_id.setdefault(rec.get("id", ""), []).append(
                    (dt, rec.get("status", ""), rec.get("detalhe", ""))
                )
    except FileNotFoundError:
        pass
    for v in by_id.values():
        v.sort()
    return by_id


def _log_path_for(comp):
    """Convencao do plugin: <ws>/.dgclaw/logs/<id>.log."""
    return os.path.join(_logs_dir(), f"{comp['id']}.log")


def log_mtime(path):
    try:
        return datetime.datetime.fromtimestamp(os.path.getmtime(path))
    except Exception:
        return None


def log_has_error(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 8000))
            tail = f.read().decode("utf-8", "replace")
        return bool(ERR_RE.search(tail))
    except Exception:
        return False


def service_active(unit):
    try:
        out = subprocess.run(["systemctl", "is-active", unit],
                             capture_output=True, text=True, timeout=10)
        return out.stdout.strip() == "active"
    except Exception:
        return False


def _dt(date, hhmm):
    h, m = hhmm.split(":")
    return datetime.datetime.combine(date, datetime.time(int(h), int(m)))


def eval_process(c, date, now, ledger):
    cid = c["id"]
    led = ledger.get(cid, [])
    log = _log_path_for(c)
    mt = log_mtime(log)

    # ── servico principal: vivo = is-active ──
    if c["kind"] == "servico":
        ok = service_active(c.get("unit", ""))
        st = "ok" if ok else "erro"
        return {"resumo": st, "slots": [{"hora": "—", "estado": st}]}

    # ── poder: o estado e o agregado dos timers que ele acopla (cron_timers) ──
    # Aqui so reportamos se o poder esta ativo; o detalhe por timer vem dos
    # proprios timers (descobertos separadamente). Tratamos como "ok" informativo.
    if c["kind"] == "poder":
        return {"resumo": "ok", "slots": [{"hora": "ativo", "estado": "ok"}]}

    # ── frequente (intervalo) ──
    if c["kind"] == "frequente":
        win = max((c.get("intervalo_min") or 30) * 2, 20)
        cutoff = now - datetime.timedelta(minutes=win)
        recent = [e for e in led if e[0] >= cutoff]
        if recent:
            st = "erro" if any(e[1] == "erro" for e in recent) else "ok"
        elif led:
            st = "faltou"            # tem ledger (registra todo run) e nada recente -> parou
        elif mt and mt >= cutoff:
            st = "erro" if log_has_error(log) else "ok"
        else:
            st = "sem-sinal"
        return {"resumo": st, "slots": [{"hora": "continuo", "estado": st}]}

    # ── pontual ──
    slots = c["slots"]
    passed = [s for s in slots if _dt(date, s) <= now]
    latest_passed = passed[-1] if passed else None
    multislot = len(slots) > 1
    has_ledger = bool(led)
    states = []
    for s in slots:
        due = _dt(date, s)
        deadline = due + datetime.timedelta(minutes=JANELA_PONTUAL_MIN)
        if now < due:
            states.append((s, "pendente"))
            continue
        # 1) ledger: entrada perto deste slot
        lo = due - datetime.timedelta(minutes=15)
        hi = deadline + datetime.timedelta(minutes=30)
        matched = [e for e in led if lo <= e[0] <= hi]
        if matched:
            st = "erro" if any(e[1] == "erro" for e in matched) else "ok"
            states.append((s, st))
            continue
        if has_ledger and multislot:
            states.append((s, "faltou" if now > deadline else "aguardando"))
            continue
        # 2) log fallback
        if mt:
            if multislot and s != latest_passed:
                states.append((s, "sem-sinal"))
                continue
            if mt >= due - datetime.timedelta(minutes=5):
                states.append((s, "erro" if log_has_error(log) else "ok"))
            elif now > deadline:
                states.append((s, "faltou"))
            else:
                states.append((s, "aguardando"))
            continue
        # 3) sem nada confiavel: log nem ledger -> nao da pra afirmar morte
        states.append((s, "sem-sinal" if now <= deadline else "faltou"
                       if has_ledger else "sem-sinal"))

    order = ["erro", "faltou", "aguardando", "ok", "pendente", "sem-sinal"]
    resumo = min((st for _, st in states), key=lambda x: order.index(x)) if states else "sem-sinal"
    return {"resumo": resumo, "slots": [{"hora": h, "estado": st} for h, st in states]}


def build(date):
    disc = load_discover(date)
    ledger = load_ledger(date)
    today = datetime.date.today()
    if date < today:
        now = datetime.datetime.combine(date, datetime.time(23, 59))
    elif date > today:
        now = datetime.datetime.combine(date, datetime.time(0, 0))
    else:
        now = datetime.datetime.now()

    procs = []
    counts = {"ok": 0, "erro": 0, "faltou": 0, "aguardando": 0, "pendente": 0, "sem-sinal": 0}
    for c in disc["componentes"]:
        ev = eval_process(c, date, now, ledger)
        for sl in ev["slots"]:
            if sl["estado"] in counts:
                counts[sl["estado"]] += 1
        procs.append({**c, "resumo": ev["resumo"], "estados": ev["slots"]})

    due_total = counts["ok"] + counts["erro"] + counts["faltou"]
    pct = round(100 * counts["ok"] / due_total) if due_total else 100
    problemas = [
        {"id": p["id"], "nome": p["nome"],
         "crit": "alta" if p["kind"] in ("servico",) else "media",
         "resumo": p["resumo"]}
        for p in procs if p["resumo"] in ("erro", "faltou")
    ]
    return {
        "date": date.isoformat(),
        "slug": disc.get("slug", ""),
        "now": now.strftime("%H:%M"),
        "pct": pct,
        "counts": counts,
        "due_total": due_total,
        "problemas": problemas,
        "processos": procs,
    }


ICON = {"ok": "\U0001f7e2", "erro": "\U0001f534", "faltou": "\U0001f534",
        "aguardando": "\U0001f7e1", "pendente": "⚫", "sem-sinal": "⚪"}


def main():
    date = datetime.date.today()
    args = sys.argv[1:]
    for a in args:
        if a.startswith("--date="):
            date = datetime.date.fromisoformat(a.split("=", 1)[1])
    data = build(date)
    if "--json" in args:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    c = data["counts"]
    print(f"# Pulso {data['date']} @ {data['now']}  —  {data['pct']}% OK "
          f"(\U0001f7e2{c['ok']} \U0001f534{c['erro']+c['faltou']} "
          f"\U0001f7e1{c['aguardando']} ⚫{c['pendente']} ⚪{c['sem-sinal']})\n")
    for p in data["processos"]:
        print(f"  {ICON.get(p['resumo'],'?')} {p['id']:<28} {p['kind']:<9} {p['resumo']}")
    if data["problemas"]:
        print("\n  PROBLEMAS:")
        for pb in data["problemas"]:
            print(f"   \U0001f534 [{pb['crit']}] {pb['id']} — {pb['resumo']}")


if __name__ == "__main__":
    main()
