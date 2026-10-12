#!/bin/bash
# notify-owner.sh — Manda um aviso para o DONO do agente, pelo canal que existir.
#
# Os crons (reflexao, heartbeat, watchdog, alertas de custo) rodam FORA da sessao viva,
# entao nao tem a tool de resposta do canal. Para falar com o dono, usam este script.
#
# POR QUE ELE MUDOU (01/10/2026, vistoria P0-2). Ate aqui o unico transporte era o bot
# do Telegram, e o script abortava quando TELEGRAM_STATE_DIR nao existia. Na jaula o
# canal do dono e o DG Chat (o painel da plataforma), nao o Telegram: TODO aviso de
# todo cron caia no vazio, e como o curl nao tinha -f e os chamadores jogavam a saida
# fora, ninguem soube. Um agente passou uma semana mudo por login vencido e o dono
# nao recebeu um aviso sequer.
#
# OS TRANSPORTES, em ordem. Para no primeiro que ENTREGAR:
#   1. DGCLAW_NOTIFY_CMD   comando do host (ex.: mandar pelo bot do dono). Recebe a
#                          mensagem no stdin E na env DGCLAW_NOTIFY_TEXT. rc 0 = entregue.
#   2. Telegram            o bot do dono ($TELEGRAM_STATE_DIR/.env + chat do dono). So
#                          conta como entregue com HTTP 2xx (curl -f).
#   3. Ponte HTTP (DGCHAT_URL)  POST em $DGCHAT_URL/api/dgchat/reply, a MESMA rota que a
#                          tool de resposta usa (scripts/dgchat-mcp/server.mjs). E o caminho
#                          do agente sem Telegram que conversa pelo app DG Telegram (Lara,
#                          Marina e Luna, 02/10/2026): sem isto todo aviso de cron dela caia
#                          no vazio. So conta como entregue com HTTP 2xx.
#   4. DG Chat da plataforma  uma linha no outbound.jsonl do canal, no MESMO formato que a
#                          tool de resposta do agente grava. Quem entrega e o carteiro do
#                          runner (DGCHAT_ENTREGA=disco), que le esse arquivo e manda para a
#                          janela do dono. So e usado quando esse carteiro existe: num DG
#                          Claw sozinho ninguem le o outbound, e gravar la seria fingir entrega.
#
# SAIDA: rc 0 = entregue (a ultima linha do stdout diz por onde; no Telegram a primeira e o
# HTTP code, como sempre foi, porque o pulso-report confere isso). rc 1 = NAO entregue por
# nenhum caminho, com o motivo de cada um no stderr. Toda tentativa fica registrada em
# <ws>/.dgclaw/logs/notify-owner.log. Quem chama TEM que olhar o rc: aviso que nao chegou
# e falha, nao detalhe.
#
# IMPORTANTE: sem parse_mode. O Telegram NAO renderiza markdown aqui. Texto corrido + emojis.
#
# Uso:  bash notify-owner.sh "mensagem"
#       echo "mensagem" | bash notify-owner.sh

set -uo pipefail

MSG="${1:-}"
[ -z "$MSG" ] && [ ! -t 0 ] && MSG="$(cat)"
[ -z "$MSG" ] && { echo "notify-owner: mensagem vazia, nada a mandar" >&2; exit 64; }

WS="${DGCLAW_WORKSPACE:-$PWD}"
LOG="$WS/.dgclaw/logs/notify-owner.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
registrar() { printf '[%s] %s\n' "$(date -Iseconds)" "$1" >> "$LOG" 2>/dev/null || true; }

FALHAS=()
# Corte por caractere, e nao por byte: o `cut -c` do GNU corta byte, e um acento no
# limite virava lixo no log.
CURTO="$(printf '%s' "$MSG" | tr '\n' ' ' | python3 -c 'import sys; print(sys.stdin.read()[:80])' 2>/dev/null)"

# ── 1. comando do host ──
if [ -n "${DGCLAW_NOTIFY_CMD:-}" ]; then
    SAIDA="$(printf '%s' "$MSG" | DGCLAW_NOTIFY_TEXT="$MSG" bash -c "$DGCLAW_NOTIFY_CMD" 2>&1)"
    RC=$?
    if [ "$RC" -eq 0 ]; then
        registrar "entregue por DGCLAW_NOTIFY_CMD: $CURTO"
        echo "entregue: comando do host"
        exit 0
    fi
    FALHAS+=("DGCLAW_NOTIFY_CMD saiu $RC: ${SAIDA:0:200}")
fi

# ── 2. Telegram ──
if [ -n "${TELEGRAM_STATE_DIR:-}" ]; then
    ENV_FILE="$TELEGRAM_STATE_DIR/.env"
    ACCESS="$TELEGRAM_STATE_DIR/access.json"
    TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    CHAT="${DGCLAW_OWNER_TELEGRAM_ID:-}"
    if [ -z "$CHAT" ] && [ -f "$ACCESS" ]; then
        CHAT=$(ACCESS="$ACCESS" python3 -c "import json,os;d=json.load(open(os.environ['ACCESS']));a=d.get('allowFrom',[]);print(a[0] if a else '')" 2>/dev/null)
    fi
    if [ -z "$TOKEN" ]; then
        FALHAS+=("telegram: token nao encontrado em $ENV_FILE")
    elif [[ ! "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
        FALHAS+=("telegram: o TELEGRAM_BOT_TOKEN de $ENV_FILE nao tem o formato <numero>:<letras> (aspas ou espaco sobrando?)")
    elif [ -z "$CHAT" ]; then
        FALHAS+=("telegram: chat do dono nao encontrado (DGCLAW_OWNER_TELEGRAM_ID vazio e access.json sem allowFrom)")
    else
        # A URL leva o token, e vai pelo stdin (-K -) para nao aparecer no argv, que
        # qualquer usuario da maquina le no `ps` (achado S08 da auditoria).
        CODE=$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TOKEN" | curl -sS --max-time 20 -K - \
            --data-urlencode "chat_id=${CHAT}" \
            --data-urlencode "text=${MSG}" \
            -o /dev/null -w '%{http_code}' 2>/dev/null)
        if [[ "$CODE" =~ ^2[0-9][0-9]$ ]]; then
            registrar "entregue pelo Telegram ($CODE): $CURTO"
            echo "$CODE"
            exit 0
        fi
        FALHAS+=("telegram: a API respondeu ${CODE:-sem resposta}")
    fi
fi

# ── avisos ao dono RETIDOS de proposito (DGCLAW_AVISOS_RETIDOS=1) ──
# Segura so os caminhos do DG Chat (3 e 4), que no agente de cliente caem na conversa do
# cliente. Nome proprio de proposito: DGCHAT_ENTREGA tambem e lida pela tool com que o
# AGENTE responde (dgchat-mcp), e la qualquer valor fora de "disco" vira "nao entreguei"
# e laco de repeticao. Aviso retido conta como NAO entregue, com o motivo dito.
RETIDO=""
if [ "${DGCLAW_AVISOS_RETIDOS:-0}" = "1" ]; then
    RETIDO=1
    FALHAS+=("dg chat: avisos ao dono retidos de proposito (DGCLAW_AVISOS_RETIDOS=1 no config.sh; para liberar, apague essa linha)")
fi

# ── 3. ponte HTTP do app (DGCHAT_URL) ──
if [ -z "$RETIDO" ] && [ -n "${DGCHAT_URL:-}" ]; then
    CHAT_ID="${DGCLAW_CHAT_ID:-c_${DGCLAW_SLUG:-agente}}"
    URL="${DGCHAT_URL%/}/api/dgchat/reply"
    BODY=$(MSG="$MSG" AGENTE="${DGCHAT_AGENT:-${DGCLAW_SLUG:-agente}}" CHAT_ID="$CHAT_ID" python3 -c \
        'import json,os;print(json.dumps({"agent":os.environ["AGENTE"],"chat":os.environ["CHAT_ID"],"text":os.environ["MSG"],"format":"plain"}))')
    CODE=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' --data "$BODY" "$URL" 2>/dev/null)
    if [[ "$CODE" =~ ^2[0-9][0-9]$ ]]; then
        registrar "entregue pela ponte $URL ($CODE, $CHAT_ID): $CURTO"
        echo "entregue: ponte do app ($CHAT_ID)"
        exit 0
    fi
    FALHAS+=("ponte $URL: respondeu ${CODE:-sem resposta} (a ponte do app esta no ar?)")
fi

# ── 4. DG Chat da plataforma (o carteiro do runner entrega o outbound) ──
OUTBOUND="${DGCHAT_OUTBOUND:-}"
[ -z "$OUTBOUND" ] && [ -d "$WS/.plataforma/dgchat" ] && OUTBOUND="$WS/.plataforma/dgchat/outbound.jsonl"
ENTREGA="${DGCHAT_ENTREGA:-}"
[ -z "$ENTREGA" ] && [ -d "$WS/.plataforma/dgchat" ] && ENTREGA="disco"
if [ -z "$RETIDO" ] && [ -n "$OUTBOUND" ] && [ "$ENTREGA" = "disco" ]; then
    CHAT_ID="${DGCLAW_CHAT_ID:-c_${DGCLAW_SLUG:-agente}}"
    if MSG="$MSG" OUTBOUND="$OUTBOUND" CHAT_ID="$CHAT_ID" AGENTE="${DGCHAT_AGENT:-${DGCLAW_SLUG:-agente}}" python3 - <<'PY'
import json, os, sys
from datetime import datetime, timezone
# A MESMA forma que a tool de resposta grava (scripts/dgchat-mcp/server.mjs), com a
# origem marcada: e assim que quem le o canal sabe que foi a maquina, e nao o agente.
linha = json.dumps({
    "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "agent": os.environ["AGENTE"], "kind": "text", "chat": os.environ["CHAT_ID"],
    "text": os.environ["MSG"], "format": "plain", "source": "notify-owner",
}, ensure_ascii=False)
try:
    os.makedirs(os.path.dirname(os.environ["OUTBOUND"]), exist_ok=True)
    # Uma linha inteira por write: o carteiro le por offset, e linha pela metade e o
    # tipo de coisa que ja fez ele entrar em laco.
    with open(os.environ["OUTBOUND"], "a", encoding="utf-8") as f:
        f.write(linha + "\n")
except OSError as e:
    print(f"nao consegui gravar em {os.environ['OUTBOUND']}: {e}", file=sys.stderr)
    sys.exit(1)
PY
    then
        registrar "entregue ao carteiro do DG Chat ($CHAT_ID): $CURTO"
        echo "entregue: canal do painel ($CHAT_ID)"
        exit 0
    fi
    FALHAS+=("dg chat: nao consegui gravar em $OUTBOUND")
fi

if [ ${#FALHAS[@]} -eq 0 ]; then
    FALHAS+=("nenhum canal configurado: sem DGCLAW_NOTIFY_CMD, sem TELEGRAM_STATE_DIR, sem DGCHAT_URL e sem o canal DG Chat da plataforma")
fi
for f in "${FALHAS[@]}"; do echo "notify-owner: NAO entregue: $f" >&2; done
registrar "NAO ENTREGUE ($(IFS='; '; echo "${FALHAS[*]}")): $CURTO"
echo "notify-owner: o que fazer: configure DGCLAW_NOTIFY_CMD no .dgclaw/config.sh, ou ligue o Telegram do agente." >&2
exit 1
