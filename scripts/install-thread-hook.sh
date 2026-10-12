#!/bin/bash
# install-thread-hook.sh — Registra o hook UserPromptSubmit inject-telegram-thread.py no
# settings.json do WORKSPACE do agente (nao edita o dgclaw-plugin).
#
# O hook injeta, a cada mensagem do dono no canal, a THREAD REAL do Telegram (o que ele VE,
# incluindo o que os crons postaram) e — na 1a msg de cada sessao — a working-memory completa.
# Ver docs/THREAD-HOOK.md. Opt-in DUPLO: o registro so faz efeito se, no launch da sessao
# viva, o dono exportar DGCLAW_THREAD_HOOK=1 e DGCLAW_PRIVATE_CONTEXT=1. Sem as flags o
# hook sai 0 na hora (inerte) — nao muda o comportamento de instalacoes existentes.
#
# Idempotente: rerodar nao duplica. `--off` remove o registro.
#
# Uso:  bash install-thread-hook.sh <.dgclaw/config.sh>
#       bash install-thread-hook.sh <.dgclaw/config.sh> --off

set -uo pipefail

CONFIG="${1:?Uso: install-thread-hook.sh <.dgclaw/config.sh> [--off]}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
OFF=0; [ "${2:-}" = "--off" ] && OFF=1

set +u
# shellcheck disable=SC1090
source "$CONFIG"
set -u
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
WS="$DGCLAW_WORKSPACE"
CONFIG_ABS="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HOOK="$PLUGIN/scripts/inject-telegram-thread.py"
SETTINGS="$WS/.claude/settings.json"

if [ "$OFF" != "1" ] && [ ! -f "$HOOK" ]; then
    echo "hook nao encontrado: $HOOK" >&2; exit 1
fi

mkdir -p "$(dirname "$SETTINGS")" 2>/dev/null || true

# Comando literal (paths absolutos resolvidos no install — nao depende de expansao de env
# no run-time do hook). O config.sh vai como argv[1] pra o hook herdar os DGCLAW_*.
CMD="python3 \"$HOOK\" \"$CONFIG_ABS\""

OFF="$OFF" SETTINGS="$SETTINGS" HOOK="$HOOK" CMD="$CMD" python3 - <<'PY'
import json, os, sys

settings = os.environ["SETTINGS"]
hook = os.environ["HOOK"]
cmd = os.environ["CMD"]
off = os.environ["OFF"] == "1"

try:
    with open(settings, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {}
except FileNotFoundError:
    data = {}
except Exception as e:
    print(f"settings.json ilegivel ({e}) — abortando pra nao corromper", file=sys.stderr)
    sys.exit(1)

hooks = data.setdefault("hooks", {})
groups = hooks.get("UserPromptSubmit")
if not isinstance(groups, list):
    groups = []

def owns(entry):
    """True se este grupo/entry aponta pro nosso hook (dedup / remocao)."""
    for h in (entry.get("hooks") or []):
        if isinstance(h, dict) and "inject-telegram-thread.py" in (h.get("command") or ""):
            return True
    return False

# remove qualquer registro anterior do nosso hook (idempotencia)
groups = [g for g in groups if not (isinstance(g, dict) and owns(g))]

if not off:
    groups.append({
        "hooks": [{"type": "command", "command": cmd, "timeout": 8}]
    })

if groups:
    hooks["UserPromptSubmit"] = groups
elif "UserPromptSubmit" in hooks:
    del hooks["UserPromptSubmit"]
if not hooks:
    data.pop("hooks", None)

tmp = settings + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, settings)
print("removido" if off else "registrado")
PY

RC=$?
if [ "$RC" != "0" ]; then
    echo "falha ao editar $SETTINGS (rc=$RC)" >&2; exit "$RC"
fi

if [ "$OFF" = "1" ]; then
    echo "thread-hook DES-registrado de $SETTINGS."
else
    cat <<EOF
thread-hook registrado em $SETTINGS.
  hook: $HOOK
Falta LIGAR no launch da sessao viva (exporte ANTES de subir o 'claude --channels'):
  export DGCLAW_THREAD_HOOK=1
  export DGCLAW_PRIVATE_CONTEXT=1     # SO na sessao privada do dono (DM)
Sem essas flags o hook sai 0 na hora (inerte). Detalhes: docs/THREAD-HOOK.md
EOF
fi
