#!/bin/bash
# doctor.sh — Diagnostico + auto-conserto de um assistente DG Claw.
#
# Uso:  bash doctor.sh <config.sh>
# Roda os checks das travas conhecidas do claude --channels sob systemd,
# conserta as deterministicas (trust, skip-dangerous) e diz o que falta.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${1:?Uso: doctor.sh <config.sh>}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG"; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"

SLUG="${DGCLAW_SLUG:?}"; WS="${DGCLAW_WORKSPACE:?}"; STATE="${TELEGRAM_STATE_DIR:?}"
if [ -n "${DGCLAW_CLAUDE_CONFIG_DIR:-}" ]; then
    CFGJSON="$DGCLAW_CLAUDE_CONFIG_DIR/.claude.json"; PLUGENV="CLAUDE_CONFIG_DIR=$DGCLAW_CLAUDE_CONFIG_DIR"
else
    CFGJSON="/root/.claude.json"; PLUGENV=""
fi
BUN_BIN_DIR="${BUN_BIN_DIR:-$HOME/.bun/bin}"
PASS=0; FAIL=0; FIX=0
ok(){ echo "  [ OK ] $1"; PASS=$((PASS+1)); }
bad(){ echo "  [FALTA] $1"; FAIL=$((FAIL+1)); }
fix(){ echo "  [CONSERTADO] $1"; FIX=$((FIX+1)); }

echo "=== DG Claw doctor: $DGCLAW_NAME ($SLUG) ==="

# 1. binarios
command -v claude >/dev/null 2>&1 && ok "claude encontrado" || bad "claude NAO esta no PATH"
{ command -v bun >/dev/null 2>&1 || [ -x "$BUN_BIN_DIR/bun" ]; } && ok "bun encontrado" || bad "bun ausente (curl -fsSL https://bun.sh/install | bash)"

# 2. plugin telegram instalado no config dir certo
if env $PLUGENV claude plugin list 2>/dev/null | grep -qi "telegram"; then
    ok "plugin telegram instalado no config dir do servico"
else
    bad "plugin telegram NAO esta no config dir do servico -> rode: $PLUGENV claude plugin install telegram@claude-plugins-official"
fi

# 3. trust + onboarding (auto-conserta)
if python3 -c "import json,sys; d=json.load(open('$CFGJSON')); p=d.get('projects',{}).get('$WS',{}); sys.exit(0 if p.get('hasTrustDialogAccepted') else 1)" 2>/dev/null; then
    ok "trust do workspace aceito"
else
    python3 - "$CFGJSON" "$WS" <<'PY' 2>/dev/null && fix "trust do workspace gravado"
import json,os,sys
path,ws=sys.argv[1],sys.argv[2]
try: d=json.load(open(path))
except Exception: d={}
d.setdefault("projects",{}); pr=d["projects"].get(ws,{})
pr["hasTrustDialogAccepted"]=True; pr["hasCompletedProjectOnboarding"]=True
d["projects"][ws]=pr; d["hasCompletedOnboarding"]=True
json.dump(d,open(path,"w"),indent=2)
PY
fi

# 4. skipDangerousModePermissionPrompt (local settings; auto-conserta)
LS="$WS/.claude/settings.local.json"
if python3 -c "import json,sys; sys.exit(0 if json.load(open('$LS')).get('skipDangerousModePermissionPrompt') else 1)" 2>/dev/null; then
    ok "skipDangerousModePermissionPrompt ligado (local settings)"
else
    mkdir -p "$WS/.claude"
    python3 - "$LS" <<'PY' 2>/dev/null && fix "skipDangerousModePermissionPrompt gravado em local settings"
import json,sys
path=sys.argv[1]
try: d=json.load(open(path))
except Exception: d={}
d["skipDangerousModePermissionPrompt"]=True
json.dump(d,open(path,"w"),indent=2)
PY
fi

# 5. unit: PTY + IS_SANDBOX
UNIT="/etc/systemd/system/dgclaw-$SLUG.service"
if [ -f "$UNIT" ]; then
    grep -q "/usr/bin/script" "$UNIT" && ok "unit usa PTY (script)" || bad "unit SEM PTY (reinstale com install-service.sh)"
    grep -q "IS_SANDBOX=1" "$UNIT" && ok "IS_SANDBOX=1 no unit" || bad "unit sem IS_SANDBOX=1 (bypass falha como root)"
else
    bad "unit systemd nao existe (rode install-service.sh)"
fi

# 6. servico ativo
if systemctl is-active --quiet "dgclaw-$SLUG" 2>/dev/null; then
    ok "servico dgclaw-$SLUG ativo"
else
    bad "servico dgclaw-$SLUG NAO esta ativo"
fi

# 6b. fix needs-auth do canal (ExecStartPre) — bot fica mudo apos restart sem isso
if [ -f "$UNIT" ] && grep -q "prestart-clear-tg-authcache" "$UNIT"; then
    ok "fix needs-auth do canal presente (ExecStartPre limpa o cache antes do start)"
else
    bad "fix needs-auth do canal AUSENTE no unit (bot pode ficar mudo apos restart) -> reinstale com install-service.sh"
fi

# 6c. chave needs-auth presa AGORA no cache (canal sera pulado no proximo start ate limpar)
CACHEDIR="${DGCLAW_CLAUDE_CONFIG_DIR:-/root/.claude}"
CACHE="$CACHEDIR/mcp-needs-auth-cache.json"
if [ -f "$CACHE" ] && grep -q 'plugin:telegram:telegram' "$CACHE" 2>/dev/null; then
    bash "$SCRIPT_DIR/prestart-clear-tg-authcache.sh" "$CACHEDIR" 2>/dev/null && fix "chave needs-auth do telegram estava presa no cache — limpei (reinicie dgclaw-$SLUG)"
else
    ok "cache needs-auth limpo (sem plugin:telegram:telegram preso)"
fi

# 6d. watchdog de runtime do canal (auto-instala se faltar)
WDTIMER="dgclaw-${SLUG}-channel-watchdog.timer"
if systemctl is-active --quiet "$WDTIMER" 2>/dev/null; then
    ok "watchdog do canal ativo ($WDTIMER, a cada 2 min)"
else
    bash "$SCRIPT_DIR/install-channel-watchdog.sh" "$CONFIG" >/dev/null 2>&1 && fix "watchdog do canal instalado/ativado ($WDTIMER)" || bad "watchdog do canal AUSENTE -> rode install-channel-watchdog.sh \"$CONFIG\""
fi

# 6e. veredito REAL do canal (nao basta is-active): poller telegram vivo?
if systemctl is-active --quiet "dgclaw-$SLUG" 2>/dev/null; then
    if bash "$SCRIPT_DIR/channel-health.sh" "$CONFIG" >/dev/null 2>&1; then
        ok "canal telegram conectado de verdade (poller vivo)"
    else
        bad "servico ATIVO mas canal telegram NAO conectou (bot mudo) — o watchdog deve reiniciar em <=2 min; ou: systemctl restart dgclaw-$SLUG"
    fi
fi

# 7. pareamento (allowlist)
if python3 -c "import json,sys; d=json.load(open('$STATE/access.json')); sys.exit(0 if d.get('allowFrom') else 1)" 2>/dev/null; then
    ok "Telegram pareado (allowFrom preenchido)"
else
    bad "Telegram ainda nao pareado (mande msg pro bot e aprove no wizard)"
fi

# 8. erros recentes no log
if journalctl -u "dgclaw-$SLUG" --no-pager -n 40 2>/dev/null | grep -qiE "cannot be used with root|Input must be provided|plugin not installed|trust"; then
    bad "log mostra erro conhecido -> veja: journalctl -u dgclaw-$SLUG -n 40"
else
    ok "sem erros conhecidos no log recente"
fi

echo ""
echo "=== resumo: $PASS ok, $FIX consertados, $FAIL faltando ==="
if [ "$FIX" -gt 0 ]; then echo ">> consertei itens — reiniciando o servico"; systemctl restart "dgclaw-$SLUG" 2>/dev/null; fi
[ "$FAIL" -eq 0 ] && echo ">> TUDO CERTO." || echo ">> ainda faltam $FAIL item(ns) acima (alguns precisam de acao manual)."
exit 0
