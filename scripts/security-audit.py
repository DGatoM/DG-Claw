#!/usr/bin/env python3
"""security-audit.py — Auditoria forense deterministica do agente DG Claw.

Generalizacao do security-audit interno: ZERO dado pessoal, tudo parametrizado por
env DGCLAW_*, e a LISTA de arquivos/servicos a monitorar e DESCOBERTA dinamicamente
(de powers.json + timers dgclaw-<slug>-* + dgclaw-<slug>.service) — nunca hardcoded.

NAO modifica nada do agente — so le arquivos/logs, compara contra baseline, e imprime
um relatorio (markdown no stdout, JSON no stderr) que o orquestrador (audit.sh) injeta
na sessao viva e/ou loga. Exit code SEMPRE 0 (so reporta; nunca quebra o cron).

Niveis (escalonam o que e checado):
  lite      — integrity + canary + egress (rapido, barato, default p/ check frequente)
  full      — lite + red-flags em conteudo persistido + action-log + memory-drift (default)
  semantic  — full + marca no JSON que a checagem semantica (LLM, opt-in) deve seguir;
              o .py em si NAO chama LLM — quem faz a parte semantica e a sessao viva.

Verificacoes:
  1. Integrity   — SHA256 dos arquivos de alma/config + scripts dos crons descobertos.
                   Drift vs baseline = alerta.
  2. Red-flags   — regex de prompt-injection em conteudo JA persistido (working-memory,
                   diarios recentes, logs do dia).
  3. Action log  — contagem de notificacoes ao dono / publicacoes / egress por dominio
                   nos logs do dia. Anomalias (target estranho, dominio fora da allowlist,
                   volume alto) = alerta.
  4. Canary      — tokens canario plantados no 1o run; se vazarem p/ output publico,
                   o agente foi comprometido.
  5. Memory drift— delta de relationships/opinions vs snapshot do run anterior.

Allowlist de dominios/targets: arquivo EDITAVEL no workspace
  (<ws>/.dgclaw/security-allowlist.json), copiado do template no 1o run. NAO hardcode.

Baseline/canary/snapshot: gerados VAZIOS no 1o run em <ws>/.dgclaw/security/.
NAO sao versionados (sao dados de instancia).

Env:
  DGCLAW_WORKSPACE      (obrigatorio)  raiz do workspace do agente
  DGCLAW_SLUG           (recomendado)  slug do agente p/ descobrir timers/servicos
  DGCLAW_PLUGIN_ROOT    (opcional)     raiz do plugin (default <ws>/.dgclaw/plugin)
  DGCLAW_PULSO_DIR      (opcional)     so usado como pista de log dir
  DGCLAW_LOG_DIR        (opcional)     dir de logs (default <ws>/.dgclaw/logs)
  DGCLAW_SECURITY_DIR   (opcional)     dir de baseline/canary (default <ws>/.dgclaw/security)
  DGCLAW_ALLOWLIST      (opcional)     path do allowlist (default <ws>/.dgclaw/security-allowlist.json)
  DGCLAW_OWNER_TELEGRAM_ID (opcional)  chat_id do dono (target legitimo p/ action-log)
  DGCLAW_AUDIT_LEVEL    (opcional)     lite|full|semantic (default full; --level vence)

Uso:
    python3 security-audit.py                  # nivel full, relatorio md + json
    python3 security-audit.py --level lite
    python3 security-audit.py --level semantic
    python3 security-audit.py --baseline       # (re)grava baseline e sai sem alarmar
    python3 security-audit.py --json-only       # so JSON no stdout
"""

import hashlib
import json
import os
import re
import sys
import glob
import secrets
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

LEVELS = ("lite", "full", "semantic")

# ──────────────────────────────────────────────────────────────────
# Resolucao de ambiente (tudo via env, zero hardcode pessoal)
# ──────────────────────────────────────────────────────────────────
def env_path(name, default=None):
    v = os.environ.get(name)
    return Path(v) if v else (Path(default) if default else None)


WORKSPACE = env_path("DGCLAW_WORKSPACE")
SLUG = os.environ.get("DGCLAW_SLUG", "").strip()

if WORKSPACE is None:
    # Sem workspace nao da pra auditar nada; reporta e sai 0 (nunca quebra o cron).
    sys.stderr.write(json.dumps({
        "overall": "SKIPPED",
        "reason": "DGCLAW_WORKSPACE nao setado",
    }) + "\n")
    print("## Auditoria de Seguranca\n\n(pulada: DGCLAW_WORKSPACE nao setado)")
    sys.exit(0)

PLUGIN_ROOT = env_path("DGCLAW_PLUGIN_ROOT", str(WORKSPACE / ".dgclaw" / "plugin"))
LOG_DIR = env_path("DGCLAW_LOG_DIR", str(WORKSPACE / ".dgclaw" / "logs"))
SECURITY_DIR = env_path("DGCLAW_SECURITY_DIR", str(WORKSPACE / ".dgclaw" / "security"))
ALLOWLIST_FILE = env_path("DGCLAW_ALLOWLIST", str(WORKSPACE / ".dgclaw" / "security-allowlist.json"))

BASELINE_FILE = SECURITY_DIR / "baseline.json"
CANARY_FILE = SECURITY_DIR / "canaries.json"
SNAPSHOT_FILE = SECURITY_DIR / "memory-snapshot.json"

OWNER_TELEGRAM_ID = os.environ.get("DGCLAW_OWNER_TELEGRAM_ID", "").strip()


# ──────────────────────────────────────────────────────────────────
# Helpers de IO
# ──────────────────────────────────────────────────────────────────
def sha256_file(path):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return default if default is not None else {}


def save_json(path, data):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False))


# ──────────────────────────────────────────────────────────────────
# Allowlist (arquivo editavel — copiado do template no 1o run)
# ──────────────────────────────────────────────────────────────────
def find_allowlist_template():
    """Procura o template de allowlist no plugin (varios layouts possiveis)."""
    candidates = []
    if PLUGIN_ROOT:
        candidates.append(PLUGIN_ROOT / "templates" / "security-allowlist.json.tmpl")
    # ao lado deste script: ../templates/...
    here = Path(__file__).resolve().parent
    candidates.append(here.parent / "templates" / "security-allowlist.json.tmpl")
    for c in candidates:
        if c and c.exists():
            return c
    return None


def load_allowlist():
    """Carrega allowlist do workspace; cria do template (ou minima) no 1o run.

    Retorna (allowed_domains:set, allowed_targets:set). Sempre inclui localhost.
    """
    if not ALLOWLIST_FILE.exists():
        tmpl = find_allowlist_template()
        if tmpl is not None:
            ALLOWLIST_FILE.parent.mkdir(parents=True, exist_ok=True)
            try:
                ALLOWLIST_FILE.write_text(tmpl.read_text())
            except OSError:
                pass
        else:
            save_json(ALLOWLIST_FILE, {
                "schema": 1,
                "allowed_domains": ["localhost", "127.0.0.1"],
                "allowed_telegram_targets": [],
            })

    data = load_json(ALLOWLIST_FILE, default={})
    domains = set(d.lower() for d in (data.get("allowed_domains") or []))
    domains |= {"localhost", "127.0.0.1"}
    targets = set(str(t) for t in (data.get("allowed_telegram_targets") or []))
    if OWNER_TELEGRAM_ID:
        targets.add(OWNER_TELEGRAM_ID)
    return domains, targets


def domain_allowed(domain, allowed):
    d = domain.lower().rstrip(".")
    if d in allowed:
        return True
    if d.endswith(".local") or d.endswith(".localhost"):
        return True
    # permite subdominios de dominios allowlistados (foo.cdn.exemplo.com p/ exemplo.com)
    for a in allowed:
        if a and d.endswith("." + a):
            return True
    return False


# Red-flag regexes p/ conteudo JA persistido (prompt-injection que passou pelo sanitizer).
RED_FLAG_PATTERNS = {
    "ignore_instr": re.compile(r"(?i)ignore (previous|prior|all|above) (instructions|prompts|rules)"),
    "system_tag":   re.compile(r"(?i)(<\s*system|\[system\]|<\/?instructions?>)"),
    "pretend":      re.compile(r"(?i)(you are now|pretend to be|act as if you (are|were))"),
    "reveal":       re.compile(r"(?i)(reveal|show|print|repeat)\s+(your|the)\s+(prompt|instructions|system)"),
    "exec":         re.compile(r"(?i)(subprocess\.|os\.system|\bexec\(|\beval\(|child_process)"),
    # ZWSP, LRM, RLM e bidi overrides — NAO inclui ZWJ/ZWNJ (usados em emoji/scripts).
    "zero_width":   re.compile(r"[​‎‏‪-‮]"),
}


# ──────────────────────────────────────────────────────────────────
# Descoberta DINAMICA de arquivos/servicos a monitorar
# ──────────────────────────────────────────────────────────────────
def discover_soul_files():
    """Arquivos de alma/config no raiz do workspace, por padrao de nome (nao lista fixa)."""
    files = []
    # arquivos canonicos de alma/identidade/regras, se existirem
    for name in (
        "SOUL.md", "IDENTITY.md", "LAWS.md", "ETHICS.md", "CREATOR.md",
        "CLAUDE.md", "PERSONALITY.md", "HEARTBEAT.md", "BOOT.md", "AGENTS.md",
        "MEMORY.md", "family.md",
    ):
        p = WORKSPACE / name
        if p.exists():
            files.append(p)
    # settings do claude
    for rel in (".claude/settings.json", ".claude/settings.local.json"):
        p = WORKSPACE / rel
        if p.exists():
            files.append(p)
    # arquivos de alma adendados por arquetipo (qualquer *-addendum.md no raiz)
    for p in WORKSPACE.glob("*-addendum.md"):
        files.append(p)
    return files


def discover_cron_scripts():
    """Scripts de vida do plugin (reflection/heartbeat/audit/post/...). Glob, nao lista fixa."""
    files = []
    if PLUGIN_ROOT and (PLUGIN_ROOT / "scripts").exists():
        sdir = PLUGIN_ROOT / "scripts"
        for pat in ("*.sh", "cron/*.sh", "_lib/*.sh", "_lib/*.py"):
            for p in sdir.glob(pat):
                files.append(p)
    return files


def discover_services():
    """Componentes a monitorar, DESCOBERTOS dinamicamente. Nunca hardcoded por nome.

    Fontes:
      - powers.json (powers habilitados + cron_timers declarados)
      - systemd timers/units `dgclaw-<slug>-*`
      - systemd unit `dgclaw-<slug>.service`
    """
    discovered = {"powers": [], "timers": [], "units": []}

    # 1. powers.json — descobre powers habilitados e timers declarados
    powers_file = WORKSPACE / ".dgclaw" / "powers.json"
    if not powers_file.exists():
        powers_file = WORKSPACE / "powers.json"
    pdata = load_json(powers_file, default={})
    for power in (pdata.get("powers") or []):
        if not isinstance(power, dict):
            continue
        if power.get("enabled"):
            discovered["powers"].append(power.get("id") or "?")
        for t in (power.get("cron_timers") or []):
            if t:
                discovered["timers"].append(str(t))

    # 2/3. systemd: timers dgclaw-<slug>-* e unit dgclaw-<slug>.service.
    # Sem slug, nao tenta adivinhar nomes — fica so com o que powers.json declarou.
    if SLUG:
        patterns = [f"dgclaw-{SLUG}-*", f"dgclaw-{SLUG}.service"]
        try:
            out = subprocess.run(
                ["systemctl", "list-unit-files", "--no-legend", "--no-pager"] + patterns,
                capture_output=True, text=True, timeout=10,
            ).stdout
            for line in out.splitlines():
                unit = line.split()[0] if line.split() else ""
                if not unit:
                    continue
                if unit.endswith(".timer"):
                    discovered["timers"].append(unit)
                elif unit.endswith(".service"):
                    discovered["units"].append(unit)
        except (OSError, subprocess.SubprocessError):
            pass

    # dedupe preservando ordem
    for k in discovered:
        seen = set()
        discovered[k] = [x for x in discovered[k] if not (x in seen or seen.add(x))]
    return discovered


# ──────────────────────────────────────────────────────────────────
# 1. Integrity
# ──────────────────────────────────────────────────────────────────
def check_integrity(update_baseline=False):
    monitored = discover_soul_files() + discover_cron_scripts()
    current = {}
    for p in monitored:
        h = sha256_file(p)
        if h is not None:
            current[str(p)] = h

    baseline = load_json(BASELINE_FILE, default={})

    if update_baseline or not baseline:
        save_json(BASELINE_FILE, current)
        return {
            "status": "BASELINE_UPDATED",
            "files_monitored": len(current),
            "changes": [],
        }

    changes = []
    for path, hash_now in current.items():
        hb = baseline.get(path)
        if hb is None:
            changes.append({"path": path, "type": "NEW"})
        elif hb != hash_now:
            changes.append({"path": path, "type": "MODIFIED"})
    for path in baseline:
        if path not in current:
            changes.append({"path": path, "type": "DELETED"})

    return {
        "status": "OK" if not changes else "DRIFT",
        "files_monitored": len(current),
        "changes": changes,
    }


# ──────────────────────────────────────────────────────────────────
# 4. Canary tokens
# ──────────────────────────────────────────────────────────────────
def check_canaries():
    canaries = load_json(CANARY_FILE, default={})
    if not canaries:
        canaries = {
            "memory_canary": f"CANARY-MEM-{secrets.token_hex(4).upper()}",
            "soul_canary": f"CANARY-SOUL-{secrets.token_hex(4).upper()}",
        }
        save_json(CANARY_FILE, canaries)
        return {"status": "PLANTED", "canaries": list(canaries.keys()), "leaks": []}

    # Onde um canario pode vazar: outputs publicos / logs de conversa, descobertos por glob.
    leak_sources = []
    for pat in ("data/*.jsonl", ".dgclaw/logs/*.log", "logs/*.log"):
        leak_sources.extend(WORKSPACE.glob(pat))
    if LOG_DIR and LOG_DIR.exists():
        leak_sources.extend(LOG_DIR.glob("*.log"))

    leaks = []
    seen = set()
    for src in leak_sources:
        if str(src) in seen or not src.exists():
            continue
        seen.add(str(src))
        try:
            content = src.read_text(errors="ignore")
        except OSError:
            continue
        for name, token in canaries.items():
            if token in content:
                leaks.append({"canary": name, "leaked_in": str(src)})

    return {
        "status": "OK" if not leaks else "LEAK_DETECTED",
        "canaries": list(canaries.keys()),
        "leaks": leaks,
    }


# ──────────────────────────────────────────────────────────────────
# Egress / action-log audit
# ──────────────────────────────────────────────────────────────────
def audit_action_logs(allowed_domains, allowed_targets):
    today = datetime.now().strftime("%Y-%m-%d")
    result = {
        "owner_notifies": 0,
        "unusual_targets": [],
        "publishes": 0,
        "egress_domains": {},
        "denies": 0,
    }

    log_files = []
    if LOG_DIR and LOG_DIR.exists():
        log_files = list(LOG_DIR.glob("*.log"))

    for log_file in log_files:
        try:
            with open(log_file, errors="ignore") as f:
                for line in f:
                    if today not in line:
                        continue
                    low = line.lower()
                    if "notify-owner" in line or "sendmessage" in low:
                        result["owner_notifies"] += 1
                        m = re.search(r"(?:target|chat_id)[=\s:]+(\d{5,})", line)
                        if m and m.group(1) not in allowed_targets:
                            result["unusual_targets"].append(m.group(1))
                    if "published" in low or "media_publish" in low or "post_published" in low:
                        result["publishes"] += 1
                    if "curl" in low or "requests" in low or " post " in low or " get " in low:
                        for m in re.finditer(r"https?://([a-zA-Z0-9.\-]+)", line):
                            d = m.group(1).lower()
                            result["egress_domains"][d] = result["egress_domains"].get(d, 0) + 1
                    if "permission denied" in low or "not allowed" in low or "egress blocked" in low:
                        result["denies"] += 1
        except OSError:
            continue

    result["unusual_domains"] = [
        {"domain": d, "count": c}
        for d, c in result["egress_domains"].items()
        if not domain_allowed(d, allowed_domains)
    ]
    # dedupe targets
    result["unusual_targets"] = sorted(set(result["unusual_targets"]))

    status = "OK"
    if result["unusual_targets"] or result["unusual_domains"]:
        status = "ANOMALY"
    if result["publishes"] > 20 or result["owner_notifies"] > 100:
        status = "ANOMALY"
    return {"status": status, **result}


# ──────────────────────────────────────────────────────────────────
# 2. Red-flags em conteudo persistido
# ──────────────────────────────────────────────────────────────────
def scan_red_flags():
    hits = []

    def scan_text(text, source):
        for name, rx in RED_FLAG_PATTERNS.items():
            m = rx.search(text)
            if m:
                hits.append({"source": source, "pattern": name, "sample": m.group(0)[:80]})
                return  # 1 hit por fonte basta

    # working-memory
    wm = WORKSPACE / "persona" / "working-memory.md"
    if not wm.exists():
        wm = WORKSPACE / "working-memory.md"
    if wm.exists():
        scan_text(wm.read_text(errors="ignore"), "working-memory.md")

    # diarios dos ultimos 2 dias
    for days_ago in range(2):
        d = (datetime.now() - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        diary = WORKSPACE / "memory" / f"{d}.md"
        if diary.exists():
            scan_text(diary.read_text(errors="ignore"), f"diary:{d}")

    # logs do dia (tail 500KB)
    today = datetime.now().strftime("%Y-%m-%d")
    if LOG_DIR and LOG_DIR.exists():
        for lf in LOG_DIR.glob("*.log"):
            try:
                size = lf.stat().st_size
                if size > 500_000:
                    with open(lf, errors="ignore") as f:
                        f.seek(size - 500_000)
                        text = f.read()
                else:
                    text = lf.read_text(errors="ignore")
            except OSError:
                continue
            if today in text:
                scan_text(text, f"log:{lf.name}")

    return {"status": "OK" if not hits else "FLAGGED", "hits": hits[:50]}


# ──────────────────────────────────────────────────────────────────
# 5. Memory drift
# ──────────────────────────────────────────────────────────────────
def memory_drift():
    current = {"relationships_count": 0, "opinions_count": 0, "opinions_list": []}

    rel = WORKSPACE / "memory" / "relationships.json"
    if rel.exists():
        data = load_json(rel, default={})
        current["relationships_count"] = len(data) if isinstance(data, (dict, list)) else 0

    op = WORKSPACE / "memory" / "opinions.json"
    if op.exists():
        data = load_json(op, default={})
        opinions = data.get("opinions") if isinstance(data, dict) else data
        if opinions is None and isinstance(data, dict):
            opinions = data
        if isinstance(opinions, list):
            current["opinions_count"] = len(opinions)
            current["opinions_list"] = [
                (o.get("topic") or o.get("subject") or str(o))[:60]
                for o in opinions if isinstance(o, dict)
            ][:20]
        elif isinstance(opinions, dict):
            current["opinions_count"] = len(opinions)
            current["opinions_list"] = list(opinions.keys())[:20]

    previous = load_json(SNAPSHOT_FILE, default={})
    drift = {}
    if previous:
        drift["relationships_delta"] = current["relationships_count"] - previous.get("relationships_count", 0)
        drift["opinions_delta"] = current["opinions_count"] - previous.get("opinions_count", 0)
        prev_ops = set(previous.get("opinions_list", []))
        curr_ops = set(current["opinions_list"])
        drift["opinions_added"] = list(curr_ops - prev_ops)
        drift["opinions_removed"] = list(prev_ops - curr_ops)

    save_json(SNAPSHOT_FILE, current)

    status = "OK"
    if drift.get("relationships_delta", 0) > 30:
        status = "SUSPICIOUS"
    if len(drift.get("opinions_added", [])) > 3:
        status = "SUSPICIOUS"
    return {"status": status, "current": current, "drift": drift}


# ──────────────────────────────────────────────────────────────────
# Relatorio consolidado
# ──────────────────────────────────────────────────────────────────
def generate_report(level="full", update_baseline=False):
    allowed_domains, allowed_targets = load_allowlist()

    report = {
        "audit_date": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "slug": SLUG or None,
        "discovered": discover_services(),
        "integrity": check_integrity(update_baseline=update_baseline),
        "canaries": check_canaries(),
        "actions": audit_action_logs(allowed_domains, allowed_targets),
    }

    if level in ("full", "semantic"):
        report["red_flags"] = scan_red_flags()
        report["memory_drift"] = memory_drift()

    # semantic: o .py NAO chama LLM. So sinaliza que a parte semantica deve seguir
    # (quem executa e a sessao viva, opt-in via DGCLAW_ENABLE_SEMANTIC_AUDIT no audit.sh).
    if level == "semantic":
        report["semantic"] = {"status": "PENDING_LLM", "note": "checagem semantica deve ser feita pela sessao viva"}

    statuses = [
        report["integrity"]["status"],
        report["canaries"]["status"],
        report["actions"]["status"],
    ]
    if "red_flags" in report:
        statuses.append(report["red_flags"]["status"])
    if "memory_drift" in report:
        statuses.append(report["memory_drift"]["status"])

    critical = {"DRIFT", "FLAGGED", "ANOMALY", "LEAK_DETECTED", "SUSPICIOUS"}
    report["overall"] = "ALERT" if any(s in critical for s in statuses) else "OK"
    return report


def format_markdown(report):
    lines = ["## Auditoria de Seguranca (deterministica)", ""]
    lines.append(f"Nivel: `{report.get('level','?')}` | Status geral: `{report['overall']}`")

    disc = report.get("discovered", {})
    n_comp = len(disc.get("powers", [])) + len(disc.get("timers", [])) + len(disc.get("units", []))
    lines.append(f"Componentes descobertos: {n_comp} "
                 f"(powers={len(disc.get('powers',[]))}, timers={len(disc.get('timers',[]))}, units={len(disc.get('units',[]))})")
    lines.append("")

    i = report["integrity"]
    icon = "[OK]" if i["status"] in ("OK", "BASELINE_UPDATED") else "[!!]"
    lines.append(f"{icon} Integrity: {i['status']} ({i['files_monitored']} arquivos)")
    for c in i.get("changes", [])[:5]:
        lines.append(f"   - {c['type']}: {c['path']}")

    c = report["canaries"]
    icon = "[OK]" if c["status"] == "OK" else ("[NEW]" if c["status"] == "PLANTED" else "[!!]")
    lines.append(f"{icon} Canaries: {c['status']} ({len(c.get('canaries', []))} plantados)")
    for l in c.get("leaks", [])[:3]:
        lines.append(f"   - LEAK: {l['canary']} vazou em {l['leaked_in']}")

    a = report["actions"]
    icon = "[OK]" if a["status"] == "OK" else "[!]"
    lines.append(f"{icon} Actions: {a['status']} — notifies={a['owner_notifies']} publishes={a['publishes']} denies={a['denies']}")
    if a.get("unusual_targets"):
        lines.append(f"   - targets anormais: {a['unusual_targets'][:3]}")
    if a.get("unusual_domains"):
        lines.append(f"   - dominios fora da allowlist: {a['unusual_domains'][:5]}")

    if "red_flags" in report:
        r = report["red_flags"]
        icon = "[OK]" if r["status"] == "OK" else "[!!]"
        lines.append(f"{icon} Red-flags: {r['status']} ({len(r['hits'])} hits)")
        for h in r["hits"][:5]:
            lines.append(f"   - {h['pattern']} em {h['source']}: {h['sample'][:60]}")

    if "memory_drift" in report:
        m = report["memory_drift"]
        d = m.get("drift", {})
        icon = "[OK]" if m["status"] == "OK" else "[!]"
        lines.append(f"{icon} Memory drift: {m['status']} — "
                     f"Drel={d.get('relationships_delta','?')} Dop={d.get('opinions_delta','?')}")
        if d.get("opinions_added"):
            lines.append(f"   - opinions_added: {d['opinions_added'][:3]}")

    if "semantic" in report:
        lines.append("[..] Semantica: PENDING_LLM (executada pela sessao viva, opt-in)")

    lines.append("")
    return "\n".join(lines)


def main():
    args = sys.argv[1:]
    update_baseline = "--baseline" in args
    json_only = "--json-only" in args

    level = os.environ.get("DGCLAW_AUDIT_LEVEL", "full").strip().lower()
    if "--level" in args:
        try:
            level = args[args.index("--level") + 1].strip().lower()
        except IndexError:
            pass
    if level not in LEVELS:
        level = "full"

    try:
        report = generate_report(level=level, update_baseline=update_baseline)
    except Exception as e:  # nunca quebra o cron
        report = {"overall": "ERROR", "error": f"{type(e).__name__}: {e}", "level": level}
        sys.stderr.write(json.dumps(report, ensure_ascii=False) + "\n")
        print(f"## Auditoria de Seguranca\n\n[ERRO] {type(e).__name__}: {e}")
        sys.exit(0)

    if json_only:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(format_markdown(report))
        sys.stderr.write(json.dumps(report, ensure_ascii=False) + "\n")

    sys.exit(0)


if __name__ == "__main__":
    main()
