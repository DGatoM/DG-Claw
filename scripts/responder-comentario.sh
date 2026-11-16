#!/usr/bin/env bash
# responder-comentario.sh: unica porta pela qual o cron de comentarios responde no Instagram.
#
# Uso:  bash responder-comentario.sh <id-do-comentario> <texto da resposta...>
#       (sem texto nos argumentos, o texto vem do stdin)
#
# Por que existe: o cron roda uma sessao do Claude com texto de terceiros (os comentarios) na frente.
# Em vez de dar a ela a chamada livre ao ig-publish.py (conta, token e endpoint a escolha dela), a
# sessao so pode chamar este script, que:
#   - aceita um id numerico e so responde a um comentario que o scrape desta rodada trouxe;
#   - nunca responde duas vezes ao mesmo comentario (.replied_comments);
#   - le a conta e o token da configuracao do agente, nunca de argumento;
#   - limita o tamanho do texto (2200 caracteres, o teto do Instagram) e rejeita caractere de controle;
#   - grava sozinho o registro (.replied_comments e data/comments.jsonl).
# Saida: 0 respondeu; 2 entrada recusada (a mensagem diz o motivo); 1 falha ao falar com o Instagram.
set -uo pipefail

CONFIG="${DGCLAW_CONFIG:-}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
erro() { echo "responder-comentario: $1" >&2; exit "${2:-2}"; }

[ $# -ge 1 ] || erro "faltou o id do comentario. Uso: responder-comentario.sh <id numerico> <texto>"
ID="$1"; shift
if ! [[ "$ID" =~ ^[0-9]{5,30}$ ]]; then
    erro "o id do comentario precisa ser so numeros (5 a 30 digitos); recebi '${ID:0:40}'. Use o commentId exato de data/scraped_comments.json."
fi

if [ $# -ge 1 ]; then TEXTO="$*"; else TEXTO="$(cat)"; fi
[ -n "${TEXTO//[[:space:]]/}" ] || erro "o texto da resposta esta vazio. Escreva a resposta como segundo argumento."
if [ "${#TEXTO}" -gt 2200 ]; then
    erro "o texto tem ${#TEXTO} caracteres e o Instagram aceita no maximo 2200. Encurte a resposta."
fi
if printf '%s' "$TEXTO" | LC_ALL=C grep -q $'[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'; then
    erro "o texto tem caractere de controle (invisivel). Reescreva a resposta so com texto normal."
fi

[ -n "$CONFIG" ] || erro "a variavel DGCLAW_CONFIG nao esta definida (o cron define). Rode pelo cron de comentarios." 2
[ -f "$CONFIG" ] || erro "a configuracao do agente nao existe em '$CONFIG'." 2
# shellcheck disable=SC1090
source "$CONFIG"
WS="${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
IG_JSON="$WS/.dgclaw/instagram.json"
SCRAPE="$WS/data/scraped_comments.json"
REPLIED="$WS/.replied_comments"

[ -f "$SCRAPE" ] || erro "nao achei $SCRAPE. O scrape desta rodada precisa ter rodado antes de responder." 2
[ -f "$IG_JSON" ] || erro "nao achei $IG_JSON (configuracao do Instagram do agente)." 2

if [ -f "$REPLIED" ] && grep -qxF -- "$ID" "$REPLIED"; then
    erro "o comentario $ID ja foi respondido (consta em .replied_comments). Nao respondo duas vezes." 2
fi

# A conta e o token vem do instagram.json; o id precisa estar no scrape.
TOKEN_ARQ="$(DGCLAW_ID="$ID" DGCLAW_SCRAPE="$SCRAPE" DGCLAW_IG_JSON="$IG_JSON" DGCLAW_WS="$WS" python3 -I - <<'PY'
import json, os, sys
try:
    scrape = json.load(open(os.environ["DGCLAW_SCRAPE"], encoding="utf-8"))
    cfg = json.load(open(os.environ["DGCLAW_IG_JSON"], encoding="utf-8"))
except (OSError, ValueError) as e:
    sys.stderr.write(f"nao consegui ler o scrape ou o instagram.json: {e}\n")
    sys.exit(3)
ids = {str(c.get("commentId")) for c in (scrape.get("comments") or []) if isinstance(c, dict)}
if os.environ["DGCLAW_ID"] not in ids:
    sys.stderr.write("esse id nao esta entre os comentarios do scrape desta rodada\n")
    sys.exit(4)
print(cfg.get("tokenPath") or os.path.join(os.environ["DGCLAW_WS"], ".instagram_token"))
PY
)"
rc=$?
case $rc in
    0) ;;
    4) erro "o id $ID nao esta entre os comentarios de data/scraped_comments.json. So respondo a comentario que o scrape trouxe; confira o commentId." 2 ;;
    *) erro "nao consegui validar o id contra o scrape (veja a mensagem acima)." 2 ;;
esac

MSG_ARQ="$(mktemp)" || erro "nao consegui criar um arquivo temporario para a resposta." 1
trap 'rm -f "$MSG_ARQ"' EXIT
printf '%s' "$TEXTO" >"$MSG_ARQ"
SAIDA="$(python3 "$DIR/ig-publish.py" reply-comment --comment-id "$ID" --message-file "$MSG_ARQ" --token-file "$TOKEN_ARQ" 2>&1)" || {
    echo "responder-comentario: o Instagram recusou a resposta ao comentario $ID: ${SAIDA:0:400}" >&2
    echo "Nao gravei como respondido; ele volta na proxima rodada." >&2
    exit 1
}

printf '%s\n' "$ID" >>"$REPLIED"
mkdir -p "$WS/data"
DGCLAW_ID="$ID" DGCLAW_TXT="$TEXTO" python3 -I -c '
import json, os, datetime
agora = datetime.datetime.now()
print(json.dumps({"date": agora.strftime("%F"), "time": agora.strftime("%H:%M"),
                  "commentId": os.environ["DGCLAW_ID"], "myReply": os.environ["DGCLAW_TXT"]}, ensure_ascii=False))
' >>"$WS/data/comments.jsonl"
echo "ok: resposta enviada ao comentario $ID."
