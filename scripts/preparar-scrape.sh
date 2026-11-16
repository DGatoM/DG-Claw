#!/usr/bin/env bash
# preparar-scrape.sh <.dgclaw/config.sh>: faz o scrape dos comentarios do Instagram, confere e GRAVA O CARIMBO
# (data/.scrape-ok) que o responder-comentario.sh exige. E o unico jeito de preparar uma rodada, tanto no cron
# de comentarios quanto numa rodada manual com o dono (skills/instagram/comments.md).
#
# O scrape vai para um arquivo EXCLUSIVO da rodada e so vira o oficial (data/scraped_comments.json) depois de
# conferido (data recente, posts processados); um arquivo antigo nunca ganha carimbo novo. Tudo sob a mesma
# trava do cron (data/.comentarios.lock), salvo quando o cron ja a segura (DGCLAW_LOCK_HELD=1).
# Saida: 0 pronto e carimbado | 4 falhou (a mensagem diz o motivo) | 6 outra rodada em andamento.
set -uo pipefail
CONFIG="${1:?Uso: preparar-scrape.sh <.dgclaw/config.sh>}"
[ -f "$CONFIG" ] || { echo "preparar-scrape: config nao encontrada: $CONFIG" >&2; exit 4; }
# shellcheck disable=SC1090
source "$CONFIG"
WS="${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$WS/.dgclaw/plugin}"
export DGCLAW_WORKSPACE="$WS"
falha() { echo "preparar-scrape: $1" >&2; exit 4; }
mkdir -p "$WS/data" || falha "nao consegui criar $WS/data (permissao ou disco)."
if [ "${DGCLAW_LOCK_HELD:-0}" != 1 ]; then
    exec 8>"$WS/data/.comentarios.lock" || falha "nao consegui criar a trava $WS/data/.comentarios.lock."
    flock -n 8 || { echo "preparar-scrape: outra rodada de comentarios esta em andamento; tente depois." >&2; exit 6; }
fi
CARIMBO="$WS/data/.scrape-ok"
SCRAPE_JSON="$WS/data/scraped_comments.json"
SCRAPE_NOVO="$WS/data/.scraped_comments.rodada.json"
rm -f "$CARIMBO" "$SCRAPE_NOVO"
python3 "$PLUGIN/scripts/scrape-comments.py" --posts 15 --output "$SCRAPE_NOVO" \
    || falha "scrape-comments.py --posts 15 falhou (cookies expirados, limite do Instagram ou nenhum post em data/posts.jsonl)."
python3 -I - "$SCRAPE_NOVO" <<'PYEOF' || falha "o arquivo do scrape nao passou na conferencia (veja a mensagem acima)."
import json, sys
from datetime import datetime, timezone, timedelta
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    quando = datetime.fromisoformat(d["scrapedAt"])
except (OSError, ValueError, KeyError, TypeError) as e:
    sys.stderr.write(f"scrape ilegivel ou sem scrapedAt: {e}\n"); sys.exit(1)
if quando.tzinfo is None:
    quando = quando.replace(tzinfo=timezone.utc)
if datetime.now(timezone.utc) - quando > timedelta(minutes=15):
    sys.stderr.write(f"o scrape e de {quando.isoformat()}, velho demais para ser desta rodada\n"); sys.exit(1)
if not isinstance(d.get("comments"), list) or not d.get("postsProcessed"):
    sys.stderr.write("o scrape nao processou nenhum post ou nao trouxe a lista de comentarios\n"); sys.exit(1)
PYEOF
python3 "$PLUGIN/scripts/scrape-comments.py" --update-followers --file "$SCRAPE_NOVO" \
    || falha "scrape-comments.py --update-followers falhou."
mv -f "$SCRAPE_NOVO" "$SCRAPE_JSON" || falha "nao consegui promover o scrape para $SCRAPE_JSON."
SHA="$(sha256sum "$SCRAPE_JSON" | cut -d' ' -f1)" || falha "nao consegui calcular o sha256 de $SCRAPE_JSON."
printf '%s %s\n' "$(date +%s)" "$SHA" >"$CARIMBO" || falha "nao consegui gravar o carimbo $CARIMBO."
echo "ok: scrape conferido e carimbado ($CARIMBO)."
