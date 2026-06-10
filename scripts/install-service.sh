#!/bin/bash
# install-service.sh — Cria e sobe o servico systemd do assistente DG Claw.
#
# Uso:  sudo bash install-service.sh <config.sh> [<launch.sh>]
#
# Roda o assistente como ROOT (o "lider", igual Isa/Jarbas), pois assim ele
# herda o login do claude e o plugin telegram ja instalados. O workspace pode
# pertencer a um usuario dedicado (separacao por agente) — root acessa tudo.
#
# Trata as 4 travas conhecidas do `claude --channels` sob systemd:
#   1. bypass como root      -> IS_SANDBOX=1 (no unit e no launch.sh)
#   2. precisa de TTY         -> ExecStart envelopado em `script` (PTY)
#   3. dialogos interativos    -> pre-grava trust + skipDangerousModePermissionPrompt
#   4. CLAUDE_CONFIG_DIR errado -> launch.sh resolve (default ou o gravado no config)

set -euo pipefail

CONFIG="${1:?Uso: install-service.sh <config.sh> [launch.sh]}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="${2:-$SCRIPT_DIR/launch.sh}"
[ -f "$LAUNCH" ] || { echo "launch.sh nao encontrado: $LAUNCH" >&2; exit 1; }

# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
: "${DGCLAW_NAME:?config sem DGCLAW_NAME}"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"

# Config dir do claude que o servico vai usar (onde o telegram esta instalado).
# Vazio = default. CLAUDE_CONFIG_DIR custom -> .claude.json fica dentro do dir;
# default -> .claude.json fica em $HOME/.claude.json (externo).
if [ -n "${DGCLAW_CLAUDE_CONFIG_DIR:-}" ]; then
    CONFIG_JSON="$DGCLAW_CLAUDE_CONFIG_DIR/.claude.json"
else
    CONFIG_JSON="/root/.claude.json"
fi

echo "==> pre-gravando trust + skip-dangerous (evita dialogos que travam o boot)"
# (a) trust do workspace + onboarding completo, no .claude.json do config dir
python3 - "$CONFIG_JSON" "$DGCLAW_WORKSPACE" <<'PY'
import json, os, sys
path, ws = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(path) else None
try:
    d = json.load(open(path))
except Exception:
    d = {}
d.setdefault("projects", {})
proj = d["projects"].get(ws, {})
proj["hasTrustDialogAccepted"] = True
proj["hasCompletedProjectOnboarding"] = True
d["projects"][ws] = proj
d["hasCompletedOnboarding"] = True
json.dump(d, open(path, "w"), indent=2)
print(f"   trust ok em {path} (projeto {ws})")
PY

# (b) skipDangerousModePermissionPrompt em LOCAL settings do workspace
#     (NAO em project settings — o claude ignora la por protecao de CVE).
mkdir -p "$DGCLAW_WORKSPACE/.claude"
LOCAL_SETTINGS="$DGCLAW_WORKSPACE/.claude/settings.local.json"
python3 - "$LOCAL_SETTINGS" <<'PY'
import json, sys
path = sys.argv[1]
try:
    d = json.load(open(path))
except Exception:
    d = {}
d["skipDangerousModePermissionPrompt"] = True
json.dump(d, open(path, "w"), indent=2)
print(f"   skip-dangerous ok em {path}")
PY

# --- Fix needs-auth (regressao do Claude Code): limpa a chave global do canal
# telegram do mcp-needs-auth-cache.json ANTES de cada start, senao o canal e
# pulado em silencio e o bot fica mudo a partir do 2o start/reboot.
# Copia estavel do prestart no workspace (sobrevive a reinstall do plugin) e
# resolve o config dir igual ao launch.sh (custom, ou o default /root/.claude).
mkdir -p "$DGCLAW_WORKSPACE/.dgclaw"
PRESTART="$DGCLAW_WORKSPACE/.dgclaw/prestart-clear-tg-authcache.sh"
cp "$SCRIPT_DIR/prestart-clear-tg-authcache.sh" "$PRESTART"
chmod +x "$PRESTART"
CFGDIR="${DGCLAW_CLAUDE_CONFIG_DIR:-/root/.claude}"

UNIT="/etc/systemd/system/dgclaw-${DGCLAW_SLUG}.service"
cat > "$UNIT" <<EOF
[Unit]
Description=DG Claw assistente: ${DGCLAW_NAME} (${DGCLAW_SLUG})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=IS_SANDBOX=1
Environment=TERM=xterm-256color
WorkingDirectory=${DGCLAW_WORKSPACE}
# Mitiga regressao do Claude Code: limpa o needs-auth do canal telegram antes de
# cada start (prefixo `-` = ignora erro, nunca bloqueia o boot).
ExecStartPre=-/bin/bash ${PRESTART} ${CFGDIR}
# PTY obrigatorio: sem TTY o claude --channels cai em modo --print e morre.
# `script` aloca um pty descartavel; -e propaga o exit code pro Restart.
ExecStart=/usr/bin/script -qfec "/bin/bash ${LAUNCH} ${CONFIG}" /dev/null
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "==> unit escrita em $UNIT"
systemctl daemon-reload
systemctl enable --now "dgclaw-${DGCLAW_SLUG}.service"
sleep 5
if systemctl is-active --quiet "dgclaw-${DGCLAW_SLUG}.service"; then
    echo "==> servico dgclaw-${DGCLAW_SLUG} ATIVO."
else
    echo "==> servico nao subiu — ultimas linhas do log:" >&2
    journalctl -u "dgclaw-${DGCLAW_SLUG}" --no-pager -n 25 >&2
fi
# --- Watchdog de runtime do canal (cobre o poller morrendo com o service ativo) ---
echo "==> instalando watchdog do canal telegram (timer a cada 2 min)"
bash "$SCRIPT_DIR/install-channel-watchdog.sh" "$CONFIG" || \
    echo "   (aviso: watchdog nao instalou — rode depois: install-channel-watchdog.sh \"$CONFIG\")" >&2

echo "Status:  systemctl status dgclaw-${DGCLAW_SLUG}"
echo "Logs:    journalctl -u dgclaw-${DGCLAW_SLUG} -f"
