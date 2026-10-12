#!/usr/bin/env bash
# Teste do dgclaw-agente com API do Telegram e runner falsos. Uso: bash bin/test/dgclaw-agente.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$AQUI/../dgclaw-agente"
T="$(mktemp -d)"
trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
FALHAS=0; N=0
ok() { N=$((N+1)); if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FALHOU $1"; FALHAS=$((FALHAS+1)); fi; }

BOT_FAKE="123456789:AAFakeFakeFakeFakeFakeFakeFakeFake_x1"
RUNNER_FAKE="runner-segredo-de-teste-123"
export LOG="$T/log.jsonl" PORTA_ARQ="$T/porta" BOT_VALIDO="$BOT_FAKE" RUNNER_BEARER="$RUNNER_FAKE" COM_MENSAGEM=0
: > "$LOG"
node "$AQUI/falso.js" & SRV=$!
for _ in $(seq 50); do [ -s "$PORTA_ARQ" ] && break; sleep 0.1; done
PORTA="$(cat "$PORTA_ARQ")"

export HOME="$T/casa"; mkdir -p "$HOME"
export DGCLAW_UID=1000 DGCLAW_TIPO=agente
export DGCLAW_TELEGRAM_API="http://127.0.0.1:$PORTA"
export DGCLAW_RUNNER_URL="http://127.0.0.1:$PORTA" DGCLAW_AGENTE_ID=ag-1
printf '%s\n' "$RUNNER_FAKE" > "$T/runner.tok"
unset DGCLAW_RUNNER_TOKEN_FILE RUNNER_TOKEN_FILE

# Admin recusado (por tipo e por uid)
DGCLAW_TIPO=admin "$BIN" canal status >/dev/null 2>"$T/e"; c=$?
ok "admin por tipo recusado (codigo 2)" $([ $c = 2 ] && echo 0 || echo 1)
grep -q "Admin nao tem canal externo" "$T/e"; ok "mensagem do admin explica" $?
DGCLAW_UID=0 DGCLAW_TIPO=agente "$BIN" canal status >/dev/null 2>&1; c=$?
ok "uid 0 recusado" $([ $c = 2 ] && echo 0 || echo 1)

# Regex do token
echo "abc" | "$BIN" canal telegram token >"$T/o" 2>"$T/e"; c=$?
ok "token fora do formato recusado" $([ $c != 0 ] && echo 0 || echo 1)
[ ! -e "$HOME/.dgclaw/telegram/.env" ]; ok "nada gravado com token invalido" $?

# Token com formato certo mas que o Telegram nao conhece
echo "999999999:AAOutroOutroOutroOutroOutroOutro_zz" | "$BIN" canal telegram token >"$T/o" 2>"$T/e"; c=$?
ok "token recusado pelo Telegram" $([ $c != 0 ] && echo 0 || echo 1)
grep -q "recusou o token" "$T/e"; ok "erro diz o que fazer" $?

# Token bom: ps nao pode ver o token enquanto o curl roda. Segura o servidor com um atraso via monitor de ps.
( for _ in $(seq 200); do ps -eo args | grep -F "$BOT_FAKE" | grep -v grep >> "$T/ps.txt"; sleep 0.02; done ) & MON=$!
echo "$BOT_FAKE" | "$BIN" canal telegram token >"$T/o" 2>"$T/e"; c=$?
ok "token valido aceito" $([ $c = 0 ] && echo 0 || echo 1)
[ "$(cat "$T/o")" = "@meu_teste_bot" ]; ok "imprime so @username" $?
! grep -qF "$BOT_FAKE" "$T/o" "$T/e"; ok "token nao aparece na saida" $?
ENVF="$HOME/.dgclaw/telegram/.env"
[ "$(stat -c %a "$ENVF")" = 600 ]; ok ".env com 600" $?
[ "$(stat -c %a "$HOME/.dgclaw/telegram")" = 700 ]; ok "pasta telegram com 700" $?
[ "$(cat "$ENVF")" = "TELEGRAM_BOT_TOKEN=$BOT_FAKE" ]; ok ".env no formato do plugin" $?

# parear sem mensagem
"$BIN" canal telegram parear >"$T/o" 2>"$T/e"; c=$?
ok "parear sem mensagem falha" $([ $c != 0 ] && echo 0 || echo 1)
grep -q "ninguem escreveu" "$T/e"; ok "parear explica que ninguem escreveu" $?

# ligar sem allowlist
"$BIN" canal telegram ligar >"$T/o" 2>"$T/e"; c=$?
ok "ligar recusa sem allowlist" $([ $c != 0 ] && echo 0 || echo 1)
[ ! -e "$HOME/.dgclaw/canais.json" ]; ok "canais.json nao criado na recusa" $?

# ligar sem token (outra casa)
H0="$HOME"; HOME="$T/vazia" "$BIN" canal telegram ligar >/dev/null 2>"$T/e"; c=$?
ok "ligar recusa sem token" $([ $c != 0 ] && echo 0 || echo 1)
grep -q "falta o token" "$T/e"; ok "mensagem de falta de token" $?

# parear com mensagens
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -f "$PORTA_ARQ"
COM_MENSAGEM=1 node "$AQUI/falso.js" & SRV=$!
for _ in $(seq 50); do [ -s "$PORTA_ARQ" ] && break; sleep 0.1; done
P2="$(cat "$PORTA_ARQ")"
export DGCLAW_TELEGRAM_API="http://127.0.0.1:$P2" DGCLAW_RUNNER_URL="http://127.0.0.1:$P2"
"$BIN" canal telegram parear >"$T/o" 2>"$T/e"; c=$?
ok "parear com mensagens funciona" $([ $c = 0 ] && echo 0 || echo 1)
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.pessoas.length===1&&d.pessoas[0].chat_id==="555111"&&d.pessoas[0].username==="@maria_s"&&d.pessoas[0].nome==="Maria Silva"?0:1)' "$T/o"
ok "parear lista so a pessoa privada, sem duplicata" $?
! grep -qF "$BOT_FAKE" "$T/o" "$T/e"; ok "parear nao vaza token" $?
"$BIN" canal telegram parear --confirmar abc >/dev/null 2>&1; ok "confirmar exige numero" $([ $? != 0 ] && echo 0 || echo 1)
"$BIN" canal telegram parear --confirmar 555111 >"$T/o" 2>&1; ok "confirmar grava allowlist" $?
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.dmPolicy==="allowlist"&&JSON.stringify(d.allowFrom)==="[\"555111\"]"&&typeof d.groups==="object"&&typeof d.pending==="object"?0:1)' "$HOME/.dgclaw/telegram/access.json"
ok "access.json no formato do plugin" $?
[ "$(stat -c %a "$HOME/.dgclaw/telegram/access.json")" = 600 ]; ok "access.json 600" $?

# ligar sem arquivo de token do runner: salva e sai 3
: > "$LOG"
"$BIN" canal telegram ligar >"$T/o" 2>"$T/e"; c=$?
ok "ligar sem token do runner sai com 3" $([ $c = 3 ] && echo 0 || echo 1)
grep -q "Reiniciar" "$T/e"; ok "explica o botao Reiniciar" $?
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.versao===1&&d.telegram.ligado===true&&d.telegram.estado_dir===process.argv[2]?0:1)' "$HOME/.dgclaw/canais.json" "$HOME/.dgclaw/telegram"
ok "canais.json gravado mesmo assim" $?
[ "$(stat -c %a "$HOME/.dgclaw/canais.json")" = 600 ]; ok "canais.json 600" $?
! grep -q reiniciar "$LOG"; ok "nao chamou o runner sem token" $?

# ligar com token do runner: chama reiniciar com Bearer
echo '{"versao":1,"whatsapp":{"ligado":false},"telegram":{"ligado":false}}' > "$HOME/.dgclaw/canais.json"
: > "$LOG"
DGCLAW_RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram ligar >"$T/o" 2>"$T/e"; c=$?
ok "ligar com runner funciona" $([ $c = 0 ] && echo 0 || echo 1)
grep -q '"url":"/api/agents/ag-1/reiniciar"' "$LOG" && grep -q "\"auth\":\"Bearer $RUNNER_FAKE\"" "$LOG"; ok "restart chamado com Bearer" $?
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.whatsapp&&d.telegram.ligado===true?0:1)' "$HOME/.dgclaw/canais.json"
ok "preserva outros canais" $?
RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram ligar >/dev/null 2>&1; ok "aceita RUNNER_TOKEN_FILE" $?
"$BIN" canal status > "$T/o"; grep -q "Telegram: ligado" "$T/o"; ok "status ligado" $?
! grep -qF "$BOT_FAKE" "$T/o"; ok "status sem segredo" $?

# runner fora do ar: salva e sai 4
DGCLAW_RUNNER_URL="http://127.0.0.1:1" DGCLAW_RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram ligar >/dev/null 2>"$T/e"; c=$?
ok "runner fora do ar sai com 4" $([ $c = 4 ] && echo 0 || echo 1)

# desligar mantem, desligar --apagar apaga
DGCLAW_RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram desligar >/dev/null 2>&1; ok "desligar ok" $?
[ -f "$HOME/.dgclaw/telegram/.env" ]; ok "desligar mantem o token" $?
grep -q '"ligado": false' "$HOME/.dgclaw/canais.json"; ok "canais.json desligado" $?
DGCLAW_RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram desligar --apagar >/dev/null 2>&1; ok "desligar --apagar ok" $?
[ ! -e "$HOME/.dgclaw/telegram" ]; ok "pasta telegram apagada" $?
"$BIN" canal status | grep -q "nao configurado"; ok "status apos apagar" $?

# token nunca apareceu no argv de nenhum processo
kill $MON 2>/dev/null; wait $MON 2>/dev/null
[ ! -s "$T/ps.txt" ]; ok "token nunca apareceu no ps" $?

echo "---"; echo "$((N-FALHAS))/$N passaram"
[ $FALHAS = 0 ]
