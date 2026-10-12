#!/usr/bin/env python3
"""openrouter-credit-alert.py — (OPCIONAL) Monitora o saldo de credito da conta OpenRouter e
avisa o dono ANTES de zerar.

POR QUE: se a pessoa virtual usa OpenRouter pra algum poder (ex: blog/SEO, pesquisa, modelos
auxiliares) e o credito zera, esses fluxos falham com HTTP 402 silenciosamente. Este monitor
pega cedo e avisa o dono pra recarregar.

OPCIONAL DE VERDADE: se DGCLAW_OPENROUTER_KEY nao estiver setada, e um NO-OP SILENCIOSO
(exit 0, sem barulho). So roda se o dono opta por usar OpenRouter e expoe a chave.

Niveis (saldo = total_credits - total_usage):
  - < AVISO  (DGCLAW_OPENROUTER_WARN, default $5):   alerta amarelo "recarrega logo"
  - < CRITICO (DGCLAW_OPENROUTER_CRIT, default $1.5): alerta vermelho "vai parar"
Anti-spam: so alerta na MUDANCA de nivel (state file). Quando recarrega e o saldo sobe,
re-arma os alertas e avisa que voltou ao normal.

Notificacao SEMPRE via scripts/notify-owner.sh (Bot API; sem markdown). ZERO dado pessoal.

ENV:
  DGCLAW_OPENROUTER_KEY        (gatilho) a chave da OpenRouter. Ausente = no-op silencioso.
                                  Alternativa: DGCLAW_OPENROUTER_KEY_FILE aponta um arquivo
                                  com a chave (preferivel — nao deixa a chave no env do timer).
  DGCLAW_OPENROUTER_WARN       (opcional) limiar amarelo (default 5)
  DGCLAW_OPENROUTER_CRIT       (opcional) limiar vermelho (default 1.5)
  DGCLAW_WORKSPACE             (opcional) raiz do ws — define onde fica o state file
  DGCLAW_PLUGIN_ROOT           (opcional) raiz do plugin (pra achar notify-owner.sh)
  DGCLAW_OPENROUTER_STATE      (opcional) override do caminho do state file

Cron sugerido: a cada 2h. Instale como um poder/timer se for usar.
Uso:  python3 openrouter-credit-alert.py [<config.sh>]
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def load_config_arg():
    """Se passado um config.sh como argv[1] e os DGCLAW_* nao estao no ambiente, sourceia."""
    if len(sys.argv) > 1 and sys.argv[1] and not sys.argv[1].startswith("-"):
        cfg = os.path.abspath(sys.argv[1])
        if os.path.isfile(cfg) and not os.environ.get("DGCLAW_OPENROUTER_KEY"):
            out = subprocess.run(
                ["bash", "-c", f'set -a; source "{cfg}"; set +a; env -0 | grep -z "^DGCLAW_" || true'],
                capture_output=True,
            )
            for chunk in out.stdout.split(b"\x00"):
                if not chunk:
                    continue
                try:
                    k, _, v = chunk.decode().partition("=")
                except Exception:
                    continue
                if k.startswith("DGCLAW_"):
                    os.environ.setdefault(k, v)


def get_key() -> str | None:
    """Resolve a chave: env direto, ou arquivo apontado por DGCLAW_OPENROUTER_KEY_FILE."""
    key = os.environ.get("DGCLAW_OPENROUTER_KEY", "").strip()
    if key:
        return key
    kf = os.environ.get("DGCLAW_OPENROUTER_KEY_FILE", "").strip()
    if kf and os.path.isfile(kf):
        try:
            return Path(kf).read_text(encoding="utf-8").strip() or None
        except OSError:
            return None
    return None


def state_path() -> Path:
    p = os.environ.get("DGCLAW_OPENROUTER_STATE")
    if p:
        return Path(p)
    ws = os.environ.get("DGCLAW_WORKSPACE")
    if ws:
        return Path(ws) / ".dgclaw" / "logs" / "openrouter-credit-state.json"
    return Path("/tmp/dgclaw-openrouter-credit-state.json")


def fetch_balance(key: str):
    import requests  # import tardio: so quando ha chave (no-op nao precisa do dep)
    for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
        os.environ.pop(k, None)
    r = requests.get(
        "https://openrouter.ai/api/v1/credits",
        headers={"Authorization": f"Bearer {key}"}, timeout=30,
    )
    r.raise_for_status()
    d = r.json()["data"]
    return d["total_credits"] - d["total_usage"], d["total_credits"], d["total_usage"]


def level(bal: float, warn: float, crit: float) -> str:
    if bal < crit:
        return "critico"
    if bal < warn:
        return "aviso"
    return "ok"


def notify(msg: str):
    ws = os.environ.get("DGCLAW_WORKSPACE", "")
    plugin = os.environ.get("DGCLAW_PLUGIN_ROOT") or (f"{ws}/.dgclaw/plugin" if ws else "")
    script = f"{plugin}/scripts/notify-owner.sh" if plugin else ""
    if not script or not os.path.isfile(script):
        # fallback: tenta o irmao no mesmo diretorio deste script
        sib = Path(__file__).resolve().parent / "notify-owner.sh"
        script = str(sib) if sib.is_file() else ""
    if not script:
        print(f"[openrouter-credit-alert] notify-owner.sh nao encontrado — msg: {msg}", file=sys.stderr)
        return
    subprocess.run(["bash", script, msg], check=False, timeout=30)


def main():
    load_config_arg()
    key = get_key()
    if not key:
        # NO-OP SILENCIOSO: a feature e opcional e nao foi habilitada.
        return

    warn = float(os.environ.get("DGCLAW_OPENROUTER_WARN", "5"))
    crit = float(os.environ.get("DGCLAW_OPENROUTER_CRIT", "1.5"))

    try:
        bal, total, _used = fetch_balance(key)
    except Exception as e:
        print(f"[openrouter-credit-alert] erro consultando saldo: {e}", file=sys.stderr)
        return  # erro de rede nao deve derrubar o timer; tenta de novo no proximo ciclo

    lvl = level(bal, warn, crit)
    state = state_path()
    prev_lvl = "ok"
    try:
        prev_lvl = json.loads(state.read_text()).get("level", "ok")
    except Exception:
        pass

    print(f"saldo OpenRouter: ${bal:.2f} (de ${total:.0f}) — nivel {lvl}")

    if lvl != prev_lvl:
        if lvl == "critico":
            notify(f"🔴 OpenRouter CRITICO: saldo ${bal:.2f}! Fluxos que usam OpenRouter vao "
                   f"FALHAR (HTTP 402). Recarrega ja em https://openrouter.ai/settings/credits")
        elif lvl == "aviso":
            notify(f"🟡 OpenRouter baixo: saldo ${bal:.2f}. Recarrega logo pra nao parar nada que "
                   f"depende dele. https://openrouter.ai/settings/credits")
        elif lvl == "ok" and prev_lvl in ("aviso", "critico"):
            notify(f"🟢 OpenRouter recarregado: saldo ${bal:.2f}. Alertas re-armados.")

    try:
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps({"level": lvl, "saldo": round(bal, 2)}))
    except OSError as e:
        print(f"[openrouter-credit-alert] nao gravei o state: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
