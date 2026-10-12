#!/bin/bash
# ext-event.sh — Avisa as extensoes instaladas que aconteceu alguma coisa.
#
# O nucleo do DG Claw nao sabe o que e emocao, nem precisa saber. Ele so anuncia fatos
# ("postei", "o post falhou", "chegou um comentario hostil") e quem quiser reagir reage.
# A extensao DG Alive escuta esses fatos pra mexer no humor; outra extensao pode escutar
# os mesmos fatos pra outra coisa. Sem extensao instalada, isto e um no-op silencioso.
#
# Uso:  bash ext-event.sh <evento> [json-opcional]
#   ex: bash ext-event.sh post_success
#       bash ext-event.sh comentario_hostil '{"autor":"@fulano"}'
#
# Contrato: cada extensao pode ter .dgclaw/ext/<nome>/hooks/event.sh, que recebe o evento
# em $1 e o json em $2. Extensao que falha ou trava NAO derruba quem chamou: o erro vai
# pro stderr dizendo qual extensao e qual evento, e o exit code aqui e sempre 0.

set -uo pipefail

EVENTO="${1:?Uso: ext-event.sh <evento> [json]}"
DADOS="${2:-{\}}"

WS="${DGCLAW_WORKSPACE:-}"
if [ -z "$WS" ]; then
    echo "ext-event: DGCLAW_WORKSPACE nao esta definido, entao nao sei de qual agente e o evento '$EVENTO'. Nenhuma extensao foi avisada." >&2
    exit 0
fi

EXT_DIR="$WS/.dgclaw/ext"
[ -d "$EXT_DIR" ] || exit 0

while IFS= read -r ext; do
    hook="$ext/hooks/event.sh"
    [ -f "$hook" ] || continue
    if ! DGCLAW_WORKSPACE="$WS" timeout 15 bash "$hook" "$EVENTO" "$DADOS" >/dev/null 2>&1; then
        echo "ext-event: a extensao '$(basename "$ext")' falhou ao tratar o evento '$EVENTO'. O resto seguiu normalmente. Pra ver o erro dela: DGCLAW_WORKSPACE='$WS' bash '$hook' '$EVENTO'" >&2
    fi
done < <(find "$EXT_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)

exit 0
