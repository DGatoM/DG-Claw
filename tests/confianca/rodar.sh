#!/usr/bin/env bash
# Testa a confianca de pasta do Claude Code 2.1.326 (dialogo "Is this a directory you created or one you trust?"):
#   - scripts/_lib/confiar-pastas.py (o helper) e scripts/_lib/confiar-pastas.sh (a funcao dos crons e do launch)
#   - scripts/channel-watchdog.sh dizendo a causa quando o restart nao resolve
# Tudo em pasta temporaria, com systemctl e notify-owner falsos: nada encosta no sistema.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$AQUI/../.."
HELPER="$REPO/scripts/_lib/confiar-pastas.py"
LIB="$REPO/scripts/_lib/confiar-pastas.sh"
WATCHDOG="$REPO/scripts/channel-watchdog.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FALHAS=0; TESTES=0
ok() { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }
igual() { if [ "$2" = "$3" ]; then ok "$1"; else mal "$1 (esperado '$2', veio '$3')"; fi; }
tem() { if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else mal "$1 (nao achei '$2' em: ${3:0:400})"; fi; }
# jq-like sem jq: le uma chave do JSON por python, com argumentos (nunca interpolados)
chave() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); v=d
for k in sys.argv[2:]: v=v[k]
print(json.dumps(v))' "$@"; }

echo "helper confiar-pastas.py"
J="$TMP/h/.claude.json"; mkdir -p "$TMP/h"
printf '%s' '{"numStartups": 9, "theme": "light", "projects": {"/ja": {"hasTrustDialogAccepted": true, "allowedTools": ["x"]}, "/c": {"mcpServers": {}}}}' > "$J"
chmod 640 "$J"
python3 -I "$HELPER" "$J" /c /nova "/com espaco" >"$TMP/o1" 2>&1; RC=$?
igual "sai 0" 0 "$RC"
igual "chave alheia sobrevive" 9 "$(chave "$J" numStartups)"
igual "tema sobrevive" '"light"' "$(chave "$J" theme)"
igual "confianca ja existente e o resto da pasta sobrevivem" '{"hasTrustDialogAccepted": true, "allowedTools": ["x"]}' "$(chave "$J" projects /ja)"
igual "pasta existente ganha a marca sem perder o resto" '{"mcpServers": {}, "hasTrustDialogAccepted": true}' "$(chave "$J" projects /c)"
igual "pasta nova marcada" true "$(chave "$J" projects /nova hasTrustDialogAccepted | tr 'A-Z' 'a-z')"
igual "pasta com espaco no nome marcada (caminho nunca vai dentro do codigo)" true "$(chave "$J" projects "/com espaco" hasTrustDialogAccepted)"
igual "permissao do arquivo preservada" 640 "$(stat -c %a "$J")"
igual "nenhum temporario sobra" ".claude.json" "$(ls -A "$TMP/h")"
SHA="$(sha256sum "$J")"; INO="$(stat -c %i "$J")"
python3 -I "$HELPER" "$J" /c /nova >/dev/null 2>&1
igual "nada mudou: o arquivo nao e reescrito" "$SHA" "$(sha256sum "$J")"
igual "nada mudou: mesmo inode (nao houve rename)" "$INO" "$(stat -c %i "$J")"
python3 -I "$HELPER" --onboarding "$J" /onb >/dev/null 2>&1
igual "--onboarding marca o projeto" true "$(chave "$J" projects /onb hasCompletedProjectOnboarding)"
igual "--onboarding marca o arquivo" true "$(chave "$J" hasCompletedOnboarding)"

printf '%s' '{quebrado' > "$J"; SHA="$(sha256sum "$J")"
SAIDA="$(python3 -I "$HELPER" "$J" /c 2>&1)"; RC=$?
igual "JSON invalido: sai 2" 2 "$RC"
igual "JSON invalido: o arquivo NAO e apagado nem reescrito" "$SHA" "$(sha256sum "$J")"
tem "JSON invalido: a mensagem diz o arquivo" "$J" "$SAIDA"
tem "JSON invalido: a mensagem diz que nada foi alterado" "NAO foi alterado" "$SAIDA"
printf '%s' '[1,2]' > "$J"
python3 -I "$HELPER" "$J" /c >/dev/null 2>&1; igual "JSON que nao e objeto: sai 2" 2 "$?"
igual "JSON que nao e objeto: intacto" '[1,2]' "$(cat "$J")"
python3 -I "$HELPER" "$TMP/novo/.claude.json" /p >/dev/null 2>&1
igual "arquivo inexistente e criado (modo 600)" "600 true" "$(stat -c %a "$TMP/novo/.claude.json") $(chave "$TMP/novo/.claude.json" projects /p hasTrustDialogAccepted)"
python3 -I "$HELPER" >/dev/null 2>&1; igual "sem argumentos: sai 64" 64 "$?"

echo "funcao confiar_pastas (launch.sh e crons)"
CD="$TMP/cfgdir"; mkdir -p "$CD"
( export CLAUDE_CONFIG_DIR="$CD"; . "$LIB"; confiar_pastas /ws /ws2 )
igual "usa CLAUDE_CONFIG_DIR/.claude.json" "true true" "$(chave "$CD/.claude.json" projects /ws hasTrustDialogAccepted) $(chave "$CD/.claude.json" projects /ws2 hasTrustDialogAccepted)"
HM="$TMP/home"; mkdir -p "$HM"
( unset CLAUDE_CONFIG_DIR; export HOME="$HM"; . "$LIB"; confiar_pastas /ws )
igual "sem CLAUDE_CONFIG_DIR usa \$HOME/.claude.json" true "$(chave "$HM/.claude.json" projects /ws hasTrustDialogAccepted)"
printf '%s' '{x' > "$HM/.claude.json"
SAIDA="$( unset CLAUDE_CONFIG_DIR; export HOME="$HM"; . "$LIB"; confiar_pastas /ws 2>&1; echo "rc=$?" )"
tem "arquivo corrompido: avisa sem derrubar (devolve 1)" "rc=1" "$SAIDA"
tem "arquivo corrompido: o aviso explica" "nao consegui marcar /ws como confiaveis em $HM/.claude.json" "$SAIDA"
igual "arquivo corrompido: intacto" '{x' "$(cat "$HM/.claude.json")"

echo "channel-watchdog: restart que nao resolve diz a causa"
WS="$TMP/ws"; HOMEW="$TMP/homew"; BIN="$TMP/bin"; TG="$TMP/tg"
mkdir -p "$WS/.dgclaw/plugin/scripts" "$HOMEW" "$BIN" "$TG"
cat > "$WS/.dgclaw/config.sh" <<CFG
DGCLAW_WORKSPACE="$WS"
DGCLAW_SLUG=teste
TELEGRAM_STATE_DIR="$TG"
CFG
cat > "$BIN/systemctl" <<'SC'
#!/bin/bash
case "$1" in is-active) echo active;; restart) echo "restart $2" >> "$SC_LOG";; esac
exit 0
SC
chmod +x "$BIN/systemctl"
cat > "$WS/.dgclaw/plugin/scripts/notify-owner.sh" <<NO
#!/bin/bash
printf '%s\n' "\$1" >> "$TMP/avisos.txt"
NO
roda() { # roda o watchdog uma vez, com HOME falso
    env -u CLAUDE_CONFIG_DIR HOME="$HOMEW" PATH="$BIN:$PATH" SC_LOG="$TMP/systemctl.log" DGCLAW_CHANNEL_WATCHDOG_ESPERA_S=0 \
        bash "$WATCHDOG" "$WS/.dgclaw/config.sh" >/dev/null 2>&1
}
rm -f "$TMP/avisos.txt"
roda
LOGW="$(cat "$WS/.dgclaw/logs/channel-watchdog.log")"
tem "reiniciou o servico" "restart dgclaw-teste.service" "$(cat "$TMP/systemctl.log")"
tem "log diz a hipotese do dialogo de confianca" "possivel dialogo de confianca de pasta parado no boot" "$LOGW"
tem "log diz qual pasta e qual arquivo" "$WS nao esta marcado como confiavel em $HOMEW/.claude.json" "$LOGW"
tem "o dono e avisado com a causa" "possivel dialogo de confianca de pasta" "$(cat "$TMP/avisos.txt")"

rm -rf "$WS/.dgclaw/logs" "$TMP/avisos.txt"
python3 -I "$HELPER" "$HOMEW/.claude.json" "$WS" >/dev/null 2>&1
roda
LOGW="$(cat "$WS/.dgclaw/logs/channel-watchdog.log")"
tem "pasta marcada: o restart que nao resolve continua sendo avisado" "auto_restart_failed" "$LOGW"
if printf '%s' "$LOGW" | grep -qF "dialogo de confianca"; then mal "pasta marcada: nao culpa o dialogo de confianca"; else ok "pasta marcada: nao culpa o dialogo de confianca"; fi

printf '\n%s testes, %s falha(s)\n' "$TESTES" "$FALHAS"
[ "$FALHAS" -eq 0 ]
