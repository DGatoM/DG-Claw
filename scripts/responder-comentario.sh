#!/usr/bin/env bash
# responder-comentario.sh: unica porta pela qual o cron de comentarios responde no Instagram.
#
# Uso:  bash responder-comentario.sh <id-do-comentario> <texto da resposta...>
#       (sem texto nos argumentos, o texto vem do stdin)
#       bash responder-comentario.sh --pular <id-do-comentario>   (nao vai responder a esse)
#
# Por que existe: o cron roda uma sessao do Claude com texto de terceiros (os comentarios) na frente.
# Em vez de dar a ela a chamada livre ao ig-publish.py (conta, token e endpoint a escolha dela), a
# sessao so pode chamar este script, que:
#   - aceita um id numerico e so responde a um comentario do scrape que o PROPRIO cron fez nesta rodada
#     (carimbo data/.scrape-ok com hora e sha256 do arquivo; a sessao nao escreve nele);
#   - nunca responde duas vezes ao mesmo comentario: trava (flock), reserva o id em .replied_comments
#     ANTES de enviar e desfaz a reserva se o Instagram recusar (a sessao nao edita esse arquivo);
#   - le a conta e o token da configuracao do agente, nunca de argumento;
#   - limita o tamanho do texto (2200 caracteres, o teto do Instagram) e rejeita caractere de controle;
#   - grava sozinho o registro (.replied_comments e data/comments.jsonl).
# Saida: 0 respondeu; 2 entrada recusada (a mensagem diz o motivo); 1 o Instagram recusou (nada publicado);
#        5 resultado INCERTO (pode ter publicado; a reserva do id fica).
set -uo pipefail

CONFIG="${DGCLAW_CONFIG:-}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
erro() { echo "responder-comentario: $1" >&2; exit "${2:-2}"; }

PULAR=0
if [ "${1:-}" = "--pular" ]; then PULAR=1; shift; fi
[ $# -ge 1 ] || erro "faltou o id do comentario. Uso: responder-comentario.sh <id numerico> <texto>  ou  --pular <id numerico>"
ID="$1"; shift
if ! [[ "$ID" =~ ^[0-9]{5,30}$ ]]; then
    erro "o id do comentario precisa ser so numeros (5 a 30 digitos); recebi '${ID:0:40}'. Use o commentId exato de data/scraped_comments.json."
fi

if [ "$PULAR" = 1 ]; then
    TEXTO=""
elif [ $# -ge 1 ]; then TEXTO="$*"; else TEXTO="$(cat)"; fi
[ "$PULAR" = 1 ] || [ -n "${TEXTO//[[:space:]]/}" ] || erro "o texto da resposta esta vazio. Escreva a resposta como segundo argumento."
if [ "$PULAR" != 1 ] && [ "${#TEXTO}" -gt 2200 ]; then
    erro "o texto tem ${#TEXTO} caracteres e o Instagram aceita no maximo 2200. Encurte a resposta."
fi
if [ "$PULAR" != 1 ] && printf '%s' "$TEXTO" | LC_ALL=C grep -q $'[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'; then
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

# O scrape precisa ser o desta rodada: o cron o faz antes da sessao e grava o carimbo "epoch sha256".
CARIMBO="$WS/data/.scrape-ok"
[ -f "$CARIMBO" ] || erro "nao achei o carimbo $CARIMBO. O scrape desta rodada nao foi feito pelo cron; nao respondo com dados velhos." 2
read -r CAR_EPOCH CAR_SHA _ <"$CARIMBO" || erro "nao consegui ler o carimbo $CARIMBO." 2
[[ "$CAR_EPOCH" =~ ^[0-9]{9,12}$ ]] || erro "o carimbo $CARIMBO esta ilegivel. Rode o cron de comentarios de novo." 2
IDADE=$(( $(date +%s) - CAR_EPOCH ))
if [ "$IDADE" -lt -60 ] || [ "$IDADE" -gt 7200 ]; then
    erro "o scrape tem $((IDADE / 60)) minutos (o limite e 120). Nao respondo com comentarios velhos; o cron faz um scrape novo na proxima rodada." 2
fi
SHA_ATUAL="$(sha256sum "$SCRAPE" | cut -d' ' -f1)" || erro "nao consegui calcular o sha256 de $SCRAPE." 2
[ "$SHA_ATUAL" = "$CAR_SHA" ] || erro "o arquivo $SCRAPE mudou depois do scrape do cron (sha256 diferente do carimbo). Recuso." 2

command -v flock >/dev/null 2>&1 || erro "o comando flock nao esta instalado; sem ele nao garanto que o mesmo comentario nao seja respondido duas vezes. Instale o pacote util-linux." 1
exec 9>"$WS/.replied_comments.lock" || erro "nao consegui criar a trava $WS/.replied_comments.lock (permissao ou disco cheio)." 1
flock -w 120 9 || erro "outra resposta ficou com a trava por mais de 2 minutos; tente de novo na proxima rodada." 1

if [ -f "$REPLIED" ] && grep -qxF -- "$ID" "$REPLIED"; then
    erro "o comentario $ID ja foi respondido ou pulado (consta em .replied_comments). Nao respondo duas vezes." 2
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

TAM_ANTES="$( [ -f "$REPLIED" ] && stat -c %s "$REPLIED" || echo 0 )"
if [ "$PULAR" = 1 ]; then
    printf '%s\n' "$ID" >>"$REPLIED" || erro "nao consegui gravar $REPLIED: o comentario $ID NAO foi marcado como pulado. Confira permissao e espaco em disco." 1
    echo "ok: comentario $ID marcado como pulado."
    exit 0
fi

MSG_ARQ="$(mktemp)" || erro "nao consegui criar um arquivo temporario para a resposta." 1
trap 'rm -f "$MSG_ARQ"' EXIT
printf '%s' "$TEXTO" >"$MSG_ARQ"
# Reserva o id ANTES de enviar: se o processo for morto no meio, o pior caso e um comentario sem
# resposta (volta so se o dono apagar a linha), nunca duas respostas.
printf '%s\n' "$ID" >>"$REPLIED" || erro "nao consegui gravar $REPLIED (reserva do comentario $ID). Nao enviei nada. Confira permissao e espaco em disco." 1
SAIDA="$(python3 "$DIR/ig-publish.py" reply-comment --comment-id "$ID" --message-file "$MSG_ARQ" --token-file "$TOKEN_ARQ" 2>&1)"
RC_IG=$?
if [ "$RC_IG" -ne 0 ]; then
    case "$RC_IG" in
        1|2)
            # Recusa CONFIRMADA (a Graph API respondeu com erro, ou o script parou antes de enviar):
            # nada foi publicado, entao a reserva pode ser desfeita.
            truncate -s "$TAM_ANTES" "$REPLIED" || echo "responder-comentario: ATENCAO: nao consegui desfazer a reserva de $ID em $REPLIED; apague a ultima linha na mao se quiser tentar de novo." >&2
            echo "responder-comentario: o Instagram recusou a resposta ao comentario $ID: ${SAIDA:0:400}" >&2
            echo "Nao gravei como respondido; ele volta na proxima rodada." >&2
            exit 1 ;;
        *)
            # Resultado DESCONHECIDO (rede caiu, tempo esgotado, erro 5xx, processo morto): o Instagram
            # pode ter publicado. A reserva FICA, para nunca responder duas vezes ao mesmo comentario.
            mkdir -p "$WS/data" 2>/dev/null && printf '%s %s\n' "$(date '+%F %T')" "$ID" >>"$WS/data/respostas-incertas.txt" 2>/dev/null
            echo "responder-comentario: resultado INCERTO ao responder o comentario $ID (codigo $RC_IG): ${SAIDA:0:300}" >&2
            echo "Mantive o id em .replied_comments para nao responder duas vezes. Confira na conta do Instagram: se a resposta NAO apareceu, apague a linha $ID de .replied_comments para ele voltar na proxima rodada." >&2
            exit 5 ;;
    esac
fi

mkdir -p "$WS/data"
DGCLAW_ID="$ID" DGCLAW_TXT="$TEXTO" python3 -I -c '
import json, os, datetime
agora = datetime.datetime.now()
print(json.dumps({"date": agora.strftime("%F"), "time": agora.strftime("%H:%M"),
                  "commentId": os.environ["DGCLAW_ID"], "myReply": os.environ["DGCLAW_TXT"]}, ensure_ascii=False))
' >>"$WS/data/comments.jsonl" || { echo "responder-comentario: a resposta ao comentario $ID FOI enviada e consta em .replied_comments, mas nao consegui gravar data/comments.jsonl. Confira permissao e disco." >&2; exit 1; }
echo "ok: resposta enviada ao comentario $ID."
