#!/bin/bash
# test-gmail-permissao.sh: valida scripts/gmail-permissao.sh numa pasta temporaria.
# Copia o script para uma pasta com um notify-owner.sh de mentira, entao nenhum aviso
# real sai e nenhum agente nem /etc e tocado.
#
# Uso: bash scripts/test-gmail-permissao.sh

# shellcheck disable=SC2015  # A && ok || falhou e o padrao destes testes
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FALHAS=0
ok()     { echo "✅ $1"; }
falhou() { echo "❌ $1" >&2; FALHAS=$((FALHAS + 1)); }

RAIZ="$(mktemp -d /tmp/dgclaw-gmail-XXXXXX)"
trap 'rm -rf "$RAIZ"' EXIT
mkdir -p "$RAIZ/scripts" "$RAIZ/ws/.dgclaw"
cp "$AQUI/gmail-permissao.sh" "$RAIZ/scripts/"
cat > "$RAIZ/scripts/notify-owner.sh" <<'N'
#!/bin/bash
echo "$1" >> "$FAKE_AVISOS"
[ "${FAKE_NOTIFY_FALHA:-0}" != 1 ]
N
export FAKE_AVISOS="$RAIZ/avisos.txt"
S="$RAIZ/scripts/gmail-permissao.sh"
WS="$RAIZ/ws"
CFG="$WS/.dgclaw/config.sh"
echo "DGCLAW_WORKSPACE=\"$WS\"" > "$CFG"
SET="$WS/.claude/settings.local.json"
export DGCLAW_GMAIL_SEM_AVISO=1

py() { python3 -c "import json,sys; d=json.load(open('$SET')); $1"; }
conta() { py "print(sum(1 for r in d['permissions']['deny'] if r.startswith('mcp__claude_ai_Gmail__')))"; }
tem() { py "sys.exit(0 if '$1' in d['permissions']['deny'] else 1)"; }

# 1. sem settings.local.json: cria
[ ! -e "$SET" ] && bash "$S" "$CFG" leitura >/dev/null && [ -f "$SET" ] && ok "cria settings.local.json" || falhou "cria settings.local.json"
[ "$(bash "$S" "$CFG" estado | head -1)" = leitura ] && ok "estado = leitura" || falhou "estado = leitura"
tem mcp__claude_ai_Gmail__send_message && tem 'mcp__claude_ai_Gmail__send*' && tem mcp__claude_ai_Gmail__trash_thread \
    && ! tem mcp__claude_ai_Gmail__create_draft && ! tem mcp__claude_ai_Gmail__update_draft \
    && ok "leitura bloqueia envio e alteracao, deixa rascunho" || falhou "conteudo do nivel leitura"

# 2. preserva hooks, chaves e deny alheio
cat > "$SET" <<'J'
{"model":"x","hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo oi"}]}]},
 "permissions":{"allow":["Bash(ls)"],"deny":["Bash(rm -rf /)","mcp__claude_ai_Gmail__send_message"]}}
J
chmod 640 "$SET"
bash "$S" "$CFG" leitura >/dev/null
py "assert d['model']=='x' and d['hooks']['UserPromptSubmit'] and d['permissions']['allow']==['Bash(ls)'] and 'Bash(rm -rf /)' in d['permissions']['deny']" \
    && ok "preserva hooks, allow e deny alheio" || falhou "preserva hooks, allow e deny alheio"
[ "$(stat -c %a "$SET")" = 640 ] && ok "preserva permissoes do arquivo" || falhou "preserva permissoes do arquivo"
[ ! -e "$SET.tmp" ] && ok "sem arquivo temporario sobrando" || falhou "arquivo temporario sobrou"

# 3. idempotente
N1="$(conta)"; bash "$S" "$CFG" leitura >/dev/null; bash "$S" "$CFG" leitura >/dev/null
[ "$(conta)" = "$N1" ] && py "d=d['permissions']['deny']; assert len(d)==len(set(d))" && ok "leitura idempotente ($N1 regras)" || falhou "leitura idempotente"

# 4. envio tira so as de envio
bash "$S" "$CFG" envio >/dev/null
! tem mcp__claude_ai_Gmail__send_message && ! tem mcp__claude_ai_Gmail__reply && ! tem mcp__claude_ai_Gmail__forward \
    && ! tem 'mcp__claude_ai_Gmail__send*' && ! tem 'mcp__claude_ai_Gmail__reply*' && ! tem 'mcp__claude_ai_Gmail__forward*' \
    && tem mcp__claude_ai_Gmail__trash_message && tem mcp__claude_ai_Gmail__delete_draft && tem 'Bash(rm -rf /)' \
    && ok "envio libera so enviar/responder/encaminhar" || falhou "envio libera so enviar/responder/encaminhar"
[ "$(bash "$S" "$CFG" estado | head -1)" = envio ] && ok "estado = envio" || falhou "estado = envio"

# 5. volta para leitura
bash "$S" "$CFG" leitura >/dev/null
[ "$(bash "$S" "$CFG" estado | head -1)" = leitura ] && tem mcp__claude_ai_Gmail__reply && ok "volta para leitura" || falhou "volta para leitura"

# 6. sem-bloqueio e parcial
echo '{"permissions":{"deny":["Bash(x)"]}}' > "$SET"
[ "$(bash "$S" "$CFG" estado | head -1)" = sem-bloqueio ] && ok "estado = sem-bloqueio" || falhou "estado = sem-bloqueio"
echo '{"permissions":{"deny":["mcp__claude_ai_Gmail__send_message"]}}' > "$SET"
[ "$(bash "$S" "$CFG" estado | head -1)" = parcial ] && ok "estado = parcial" || falhou "estado = parcial"

# 7. JSON ilegivel aborta sem mexer
echo '{ quebrado' > "$SET"
SUM="$(md5sum < "$SET")"
bash "$S" "$CFG" leitura >/dev/null 2>"$RAIZ/err.txt"; RC=$?
[ "$RC" != 0 ] && [ "$(md5sum < "$SET")" = "$SUM" ] && grep -q ilegivel "$RAIZ/err.txt" \
    && ok "JSON ilegivel aborta sem mexer" || falhou "JSON ilegivel aborta sem mexer (rc=$RC)"
bash "$S" "$CFG" estado >/dev/null 2>&1; [ "$?" != 0 ] && ok "estado tambem aborta em JSON ilegivel" || falhou "estado em JSON ilegivel"

# 8. erro de uso
bash "$S" "$CFG" talvez >/dev/null 2>&1; [ "$?" = 2 ] && ok "acao invalida sai 2" || falhou "acao invalida sai 2"
bash "$S" "$RAIZ/nao-existe.sh" estado >/dev/null 2>&1; [ "$?" != 0 ] && ok "config inexistente falha" || falhou "config inexistente"

# 9. registro gravado
LOG="$WS/.dgclaw/logs/permissoes.log"
[ -s "$LOG" ] && grep -qE '^\[[0-9-]+ [0-9:]+\] gmail: ' "$LOG" && ok "registro gravado com data" || falhou "registro gravado"

# 10. aviso: pulado, enviado, falha
echo '{}' > "$SET"; bash "$S" "$CFG" leitura >/dev/null; rm -f "$FAKE_AVISOS"
bash "$S" "$CFG" envio >/dev/null
[ ! -e "$FAKE_AVISOS" ] && ok "DGCLAW_GMAIL_SEM_AVISO=1 pula o aviso" || falhou "aviso nao foi pulado"
bash "$S" "$CFG" leitura >/dev/null
(unset DGCLAW_GMAIL_SEM_AVISO; bash "$S" "$CFG" envio >/dev/null)
grep -q "Aviso de seguranca" "$FAKE_AVISOS" 2>/dev/null && ok "avisa o dono ao liberar envio" || falhou "nao avisou o dono"
N=$(wc -l < "$FAKE_AVISOS")
(unset DGCLAW_GMAIL_SEM_AVISO; bash "$S" "$CFG" envio >/dev/null)
[ "$(wc -l < "$FAKE_AVISOS")" = "$N" ] && ok "sem mudanca, sem novo aviso" || falhou "avisou sem mudanca"
bash "$S" "$CFG" leitura >/dev/null
(unset DGCLAW_GMAIL_SEM_AVISO; FAKE_NOTIFY_FALHA=1 bash "$S" "$CFG" envio >/dev/null 2>"$RAIZ/err2.txt"; echo $? > "$RAIZ/rc")
[ "$(cat "$RAIZ/rc")" = 0 ] && grep -q "NAO saiu" "$RAIZ/err2.txt" && grep -q "FALHA ao avisar" "$LOG" \
    && ok "falha do aviso: segue, diz na saida e registra" || falhou "falha do aviso"

echo
[ "$FALHAS" = 0 ] && { echo "tudo certo"; exit 0; } || { echo "$FALHAS falha(s)" >&2; exit 1; }
