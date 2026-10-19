"""Estado em disco (cooldown, ciclo pendente), aviso ao dono e modo seguro."""

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from .ambiente import env, log


# ─── state (cooldown) ─────────────────────────────────────────────────────────

def load_state(state_file: Path) -> dict:
    try:
        return json.loads(state_file.read_text())
    except Exception:
        return {}


def save_state(state_file: Path, st: dict):
    try:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = state_file.with_suffix(state_file.suffix + ".tmp")
        tmp.write_text(json.dumps(st, indent=2))
        tmp.replace(state_file)
    except Exception as e:
        log(f"aviso: nao consegui gravar state {state_file}: {e}")


def cooldown_remaining(st: dict, cooldown_min: int) -> float:
    """Minutos restantes de cooldown (0 se ja pode disparar)."""
    last = st.get("last_compact_ts")
    if not last:
        return 0.0
    try:
        then = datetime.fromisoformat(last)
    except Exception:
        return 0.0
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    elapsed = (datetime.now(timezone.utc) - then.astimezone(timezone.utc)).total_seconds() / 60
    return max(0.0, cooldown_min - elapsed)


# ─── notificacao opcional ao dono ─────────────────────────────────────────────

def notify_owner(msg: str):
    if env("DGCLAW_COMPACT_NOTIFY", "1") == "0":
        return
    # estado.py fica em scripts/_lib/auto_compact/: o notify-owner.sh está em scripts/.
    notifier = Path(__file__).resolve().parents[2] / "notify-owner.sh"
    if not notifier.exists():
        return
    try:
        subprocess.run(["bash", str(notifier), msg],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=30, check=False)
    except Exception as e:
        log(f"aviso: notify-owner falhou: {e}")


# ─── orquestracao ─────────────────────────────────────────────────────────────

def _modo_seguro(workspace: Path):
    """A marca do modo de seguranca (<ws>/.dgclaw/modo-seguro.json), ou None. Marca
    ilegivel conta como ligada AGORA: na duvida, o poke antigo nao sai."""
    p = workspace / ".dgclaw" / "modo-seguro.json"
    if not p.exists():
        return None
    try:
        m = json.loads(p.read_text())
    except (OSError, ValueError) as e:
        log(f"aviso: modo-seguro.json ilegivel ({e}); tratando como ligado agora")
        return {"ativo": True, "ativadoEm": datetime.now(timezone.utc).isoformat()}
    return m if m.get("ativo", True) else None


def _antes(a, b) -> bool:
    """a e anterior a b (ISO8601, com Z ou +00:00)? Sem data legivel, conta como
    anterior: e o lado que nao entrega o poke."""
    try:
        da = datetime.fromisoformat(str(a).replace("Z", "+00:00"))
        db = datetime.fromisoformat(str(b).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return True
    if da.tzinfo is None:
        da = da.replace(tzinfo=timezone.utc)
    if db.tzinfo is None:
        db = db.replace(tzinfo=timezone.utc)
    return da < db
