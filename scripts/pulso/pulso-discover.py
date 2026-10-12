#!/usr/bin/env python3
"""pulso-discover.py (DG Claw) — descobre AUTOMATICAMENTE o que deve rodar hoje.

NADA de nomes/paths de um agente especifico (white-label). A lista de
componentes monitorados e DESCOBERTA dinamicamente de TRES
fontes, todas derivadas do SLUG do agente (DGCLAW_SLUG):

  1. powers.json          — catalogo de poderes (DGCLAW_WORKSPACE/.dgclaw/powers.json).
                            Cada poder com enabled=true vira um componente "poder". Seus
                            cron_timers[] (nomes de unit dgclaw-<slug>-<x>) sao casados
                            com os timers systemd descobertos na fonte 2.
  2. timers dgclaw-<slug>-*  — os timers de vida + de poder instalados via systemd.
                            Cada um vira um componente, com horarios expandidos do
                            OnCalendar / intervalo do OnUnitActiveSec.
  3. dgclaw-<slug>.service     — o servico principal (a sessao --channels viva que serve
                            o canal). Componente do tipo "servico" (checado por is-active).

Criou um timer/poder -> aparece. Removeu -> some. Mudou horario -> muda aqui. ZERO
hardcode. ZERO dado pessoal (so o slug, que o dono escolheu).

Saida (--json): lista de componentes esperados com horarios expandidos pra data alvo.
Quem calcula estado (verde/vermelho/apagada) e o pulso-status.py.

Env:
  DGCLAW_SLUG       (obrigatorio) — identifica as units dgclaw-<slug>-* e dgclaw-<slug>.
  DGCLAW_WORKSPACE  (opcional)    — pra achar o powers.json.
  DGCLAW_POWERS_FILE(opcional)    — override do path do powers.json.
"""
import json
import os
import re
import subprocess
import sys
import datetime


def _slug() -> str:
    s = os.environ.get("DGCLAW_SLUG", "").strip()
    if not s:
        sys.stderr.write("pulso-discover: DGCLAW_SLUG nao setado\n")
    return s


def _powers_file() -> str:
    f = os.environ.get("DGCLAW_POWERS_FILE")
    if f:
        return f
    ws = os.environ.get("DGCLAW_WORKSPACE", os.getcwd())
    return os.path.join(ws, ".dgclaw", "powers.json")


_SYSTEMCTL_WARNED = False


def _run(cmd, timeout=15) -> str:
    """Roda um comando e devolve stdout (ou "" se rc!=0). Em ambiente SEM systemd
    (container/WSL1/etc) o systemctl nao existe — avisamos UMA vez no stderr pra a
    descoberta vazia nao parecer 'tudo apagado' enganosamente."""
    global _SYSTEMCTL_WARNED
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.stdout if out.returncode == 0 else ""
    except FileNotFoundError:
        if cmd and cmd[0] == "systemctl" and not _SYSTEMCTL_WARNED:
            sys.stderr.write("pulso-discover: systemctl indisponivel — descoberta de "
                             "timers/servicos vazia (ambiente sem systemd?)\n")
            _SYSTEMCTL_WARNED = True
        return ""
    except Exception as e:
        sys.stderr.write(f"pulso-discover: falha rodando {' '.join(cmd[:2])}: "
                         f"{type(e).__name__}\n")
        return ""


# ─── expansao de campos cron / OnCalendar ────────────────────────────────────
def expand_field(field, lo, hi):
    """Expande um campo cron (min/hora/dom/mes/dow) num set de inteiros."""
    result = set()
    for part in str(field).split(","):
        part = part.strip()
        if not part:
            continue
        step = 1
        if "/" in part:
            base, step_s = part.split("/", 1)
            try:
                step = int(step_s)
            except ValueError:
                step = 1
        else:
            base = part
        if base == "*":
            start, end = lo, hi
        elif "-" in base:
            a, b = base.split("-", 1)
            try:
                start, end = int(a), int(b)
            except ValueError:
                continue
        else:
            try:
                start = int(base)
            except ValueError:
                continue
            end = hi if "/" in part else start
        for v in range(start, end + 1, max(step, 1)):
            if lo <= v <= hi:
                result.add(v)
    return result


# OnCalendar do systemd e mais simples que cron, mas cobrimos os formatos que o
# install-timers.sh gera: "*-*-* HH:MM:SS" e "Dow *-*-* HH:MM:SS".
_DOW_MAP = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


def parse_oncalendar(expr, date):
    """Recebe um valor OnCalendar e a data alvo. Retorna (runs_today, [slots HH:MM]).

    Suporta:
      *-*-* HH:MM:SS                 (diario)
      HH:MM[:SS]                     (diario, forma curta)
      Mon..Fri *-*-* HH:MM:SS        (dias da semana)
      Mon,Wed *-*-* HH:MM:SS
    """
    expr = expr.strip()
    if not expr:
        return False, []
    parts = expr.split()
    dow_spec = None
    timepart = None

    # ultimo token com ':' e a hora; um token de dow (com letras) vem antes
    for tok in parts:
        if ":" in tok:
            timepart = tok
        elif re.search(r"[A-Za-z]", tok):
            dow_spec = tok
    if timepart is None:
        # forma "*-*-*" sem hora explicita: nao tratamos (raro nos nossos timers)
        return False, []

    # filtro de dia da semana
    if dow_spec:
        wanted = set()
        for chunk in dow_spec.split(","):
            chunk = chunk.strip().lower()
            if ".." in chunk:
                a, b = chunk.split("..", 1)
                ai, bi = _DOW_MAP.get(a[:3]), _DOW_MAP.get(b[:3])
                if ai is not None and bi is not None:
                    rng = range(ai, bi + 1) if ai <= bi else list(range(ai, 7)) + list(range(0, bi + 1))
                    wanted.update(rng)
            else:
                di = _DOW_MAP.get(chunk[:3])
                if di is not None:
                    wanted.add(di)
        if date.weekday() not in wanted:
            return False, []

    # hora
    hms = timepart.split(":")
    try:
        hh = int(hms[0]); mm = int(hms[1]) if len(hms) > 1 else 0
    except ValueError:
        return False, []
    return True, [f"{hh:02d}:{mm:02d}"]


def parse_onactivesec(val):
    """Converte OnUnitActiveSec (ex.: 30min, 1h, 1800) em minutos (int) ou None."""
    val = val.strip().lower()
    m = re.match(r"^(\d+)\s*(s|sec|m|min|h|hr|hour)?", val)
    if not m:
        return None
    n = int(m.group(1)); unit = m.group(2) or "s"
    if unit in ("s", "sec"):
        return max(1, round(n / 60))
    if unit in ("m", "min"):
        return n
    if unit in ("h", "hr", "hour"):
        return n * 60
    return n


# ─── descoberta dos timers dgclaw-<slug>-* ─────────────────────────────────
def discover_timers(slug, date):
    """Le os .timer do systemd cujo nome bate dgclaw-<slug>-*. Pra cada um,
    extrai OnCalendar/OnUnitActiveSec e a Description do .service par. Retorna
    lista de dicts de componente."""
    comps = []
    if not slug:
        return comps
    pattern = f"dgclaw-{slug}-"
    units = []
    out = _run(["systemctl", "list-unit-files", "--type=timer", "--all",
                "--no-pager", "--plain", "--no-legend"])
    for line in out.splitlines():
        cols = line.split()
        if not cols:
            continue
        unit = cols[0]
        if unit.startswith(pattern) and unit.endswith(".timer"):
            units.append(unit)

    for tunit in units:
        name = tunit[len(pattern):-len(".timer")]  # ex.: reflection, heartbeat
        props = _run(["systemctl", "show", tunit,
                      "--property=TimersCalendar", "--property=TimersMonotonic",
                      "--no-pager"])
        cal_exprs, mono = [], None
        for ln in props.splitlines():
            if ln.startswith("TimersCalendar="):
                # formato: { OnCalendar=*-*-* 23:30:00 ; next_elapse=... }
                for m in re.finditer(r"OnCalendar=([^;}]+)", ln):
                    cal_exprs.append(m.group(1).strip())
            elif ln.startswith("TimersMonotonic="):
                v = ln.split("=", 1)[1].strip()
                if v and v != "":
                    mono = v

        slots = []
        runs_today = True
        if cal_exprs:
            runs_today = False
            for expr in cal_exprs:
                ok, sl = parse_oncalendar(expr, date)
                if ok:
                    runs_today = True
                    slots.extend(sl)
        interval = None
        if not slots:
            # timer por intervalo (OnUnitActiveSec). Le o valor cru da unit.
            cat = _run(["systemctl", "cat", tunit])
            mm = re.search(r"OnUnitActiveSec=(\S+)", cat)
            if mm:
                interval = parse_onactivesec(mm.group(1))

        # descricao humana do service par (sem dado pessoal — vem do template)
        desc = _run(["systemctl", "show", f"dgclaw-{slug}-{name}.service",
                     "--property=Description", "--no-pager"]).strip()
        desc = desc.split("=", 1)[1].strip() if "=" in desc else name

        if not runs_today:
            continue

        slots = sorted(set(slots))
        n = len(slots)
        if interval is not None and not slots:
            kind = "frequente"
        else:
            kind = "pontual"
        comps.append({
            "id": name,
            "nome": desc or name,
            "fonte_descoberta": "timer",
            "unit": tunit,
            "kind": kind,
            "slots": slots if kind == "pontual" else [],
            "n_slots": n,
            "intervalo_min": interval if kind == "frequente" else None,
        })
    return comps


# ─── descoberta do servico principal dgclaw-<slug>.service ────────────────────
def discover_main_service(slug):
    if not slug:
        return []
    unit = f"dgclaw-{slug}.service"
    out = _run(["systemctl", "list-unit-files", f"{unit}", "--no-pager",
                "--plain", "--no-legend"])
    if not out.strip():
        return []
    desc = _run(["systemctl", "show", unit, "--property=Description",
                 "--no-pager"]).strip()
    desc = desc.split("=", 1)[1].strip() if "=" in desc else unit
    return [{
        "id": "svc-main",
        "nome": desc or f"Sessao viva ({slug})",
        "fonte_descoberta": "service",
        "unit": unit,
        "kind": "servico",
        "slots": [], "n_slots": 0, "intervalo_min": None,
    }]


# ─── descoberta dos poderes ativos (powers.json) ─────────────────────────────
def discover_powers():
    """Le powers.json. Cada poder enabled=true vira um componente "poder". Seus
    cron_timers[] (nomes de unit) sao expostos pra o status casar com os timers."""
    comps = []
    pf = _powers_file()
    try:
        with open(pf) as f:
            data = json.load(f)
    except Exception:
        return comps
    for p in data.get("powers", []):
        if not p.get("enabled"):
            continue
        if p.get("id") == "core":
            continue  # core nao e um cron, e o nucleo sempre-ligado
        comps.append({
            "id": "power-" + str(p.get("id", "?")),
            "nome": p.get("name", p.get("id", "?")),
            "fonte_descoberta": "power",
            "kind": "poder",
            "cron_timers": list(p.get("cron_timers", []) or []),
            "slots": [], "n_slots": 0, "intervalo_min": None,
        })
    return comps


def discover(date):
    slug = _slug()
    comps = []
    comps.extend(discover_main_service(slug))
    comps.extend(discover_timers(slug, date))
    comps.extend(discover_powers())

    # ordena: servico, depois pontuais por horario, frequentes, poderes
    def sort_key(c):
        kind_rank = {"servico": 0, "pontual": 1, "frequente": 2, "poder": 3}.get(c["kind"], 4)
        first_slot = c["slots"][0] if c.get("slots") else "~"
        return (kind_rank, first_slot, c["id"])
    comps.sort(key=sort_key)
    return {"date": date.isoformat(), "slug": slug, "componentes": comps}


def main():
    date = datetime.date.today()
    args = sys.argv[1:]
    as_json = "--json" in args
    for a in args:
        if a.startswith("--date="):
            date = datetime.date.fromisoformat(a.split("=", 1)[1])
    data = discover(date)
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    print(f"# Pulso — componentes esperados em {data['date']} "
          f"(slug={data['slug'] or '?'}, {len(data['componentes'])} componentes)\n")
    for c in data["componentes"]:
        when = (",".join(c["slots"]) if c["kind"] == "pontual"
                else f"~{c['intervalo_min']}min" if c["kind"] == "frequente"
                else c["kind"])
        print(f"  [{c['fonte_descoberta'][:3]}] {c['id']:<28} {when}")


if __name__ == "__main__":
    main()
