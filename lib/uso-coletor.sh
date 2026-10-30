#!/usr/bin/env bash
# lib/uso-coletor.sh: junta, de UMA casa de agente, o que a secao "O que este DG Claw usa" precisa.
#
# Roda como root, num processo a parte e sob `timeout` (lib/uso-atualizacao.sh), porque a casa e gravavel pelo
# proprio agente: tudo o que existe la e DADO NAO CONFIAVEL. Por isso o coletor nunca devolve texto livre. Ele
# escreve no arquivo de saida so linhas de formato fixo (campos separados por TAB):
#   rotinas<TAB>N | scripts<TAB>N | puladosgrandes<TAB>N | canal<TAB>WhatsApp|Telegram | identidade<TAB>1
#   rotina<TAB>rotina-N<TAB>nome-ou-vazio | skill<TAB>nome | skillfora<TAB>1
#   ref<TAB>rotina-N|script-N<TAB>arq|cli<TAB>referencia   (so caracteres de caminho ou de comando)
#   lim<TAB>texto fixo do coletor
# Nomes so saem se casarem com a regex estrita; o resto vira vazio ou "fora do padrao". Quem consome ainda confere
# cada referencia contra a lista confiavel (diff da versao, ajuda do bin/dgclaw) antes de mostrar qualquer coisa.
#
# Uso: uso-coletor.sh <casa do agente> <arquivo de saida>
set -uo pipefail

MAX_ARQ=262144      # bytes por arquivo lido
MAX_ROTINAS=200
MAX_SCRIPTS=500
NOME_RE='^[a-z0-9][a-z0-9._-]{0,40}$'

casa="${1:?casa}"; saida="${2:?saida}"
casa_real="$(realpath -e -- "$casa" 2>/dev/null)" || { echo "lim	casa ilegivel" >>"$saida"; exit 0; }

emite() { printf '%s\t' "$1" >>"$saida"; shift; local IFS=$'\t'; printf '%s\n' "$*" >>"$saida"; }

# refs: le texto no STDIN e emite "arq<TAB>caminho" e "cli<TAB>comando [sub]" (quem chama poe o prefixo).
refs() {
    local txt; txt="$(head -c "$MAX_ARQ")"
    printf '%s\n' "$txt" \
        | grep -oE '(/opt/dgclaw/app|\$\{?DGCLAW_PLUGIN_ROOT\}?|\.dgclaw/plugin)/[A-Za-z0-9_./@-]+' 2>/dev/null \
        | sed -E 's#^(/opt/dgclaw/app|\$\{?DGCLAW_PLUGIN_ROOT\}?|\.dgclaw/plugin)/##; s#[.,;:]+$##' \
        | grep . | sed 's/^/arq\t/' | sort -u || true
    printf '%s\n' "$txt" \
        | grep -oE '(^|[^A-Za-z0-9_./-])dgclaw [a-z][a-z-]*( [a-z][a-z-]*)?' 2>/dev/null \
        | sed -E 's/^[^d]?dgclaw //' | grep . | sed 's/^/cli\t/' | sort -u || true
}

# dentro_da_casa <arquivo>: arquivo regular, sem ser atalho, cujo caminho resolvido continua dentro da casa.
dentro_da_casa() {
    local f="$1" real
    [ -f "$f" ] && [ ! -L "$f" ] || return 1
    real="$(realpath -e -- "$f" 2>/dev/null)" || return 1
    [[ "$real" == "$casa_real"/* ]]
}

# --- rotinas -----------------------------------------------------------------------------------
m="$casa/.dgclaw/self-crons.json"
if [ -L "$casa/.dgclaw" ] || [ -L "$m" ]; then
    emite lim "o manifesto de rotinas e um atalho; nao li"
elif [ -e "$m" ]; then
    if ! dentro_da_casa "$m"; then
        emite lim "o manifesto de rotinas nao e um arquivo regular dentro da casa; nao li"
    elif [ "$(stat -c %s "$m" 2>/dev/null || echo 0)" -gt "$MAX_ARQ" ]; then
        emite lim "o manifesto de rotinas passa de 256 KB; nao li"
    else
        tmpj="$(mktemp)"
        if grep -v '^#' "$m" | jq -r '
                (.crons // {}) | (if type == "array" then .[] else to_entries[] | (.value + {name: .key}) end)
                | [((.name // "") | tostring | @base64), ((.poke // .command // .cmd // "") | tostring | @base64)] | @tsv' >"$tmpj" 2>/dev/null; then
            total="$(grep -c . "$tmpj" || true)"
            n=0
            while IFS=$'\t' read -r nome64 poke64; do
                [ -n "$nome64$poke64" ] || continue
                n=$((n + 1))
                [ "$n" -le "$MAX_ROTINAS" ] || break
                nome="$(printf '%s' "$nome64" | base64 -d 2>/dev/null | tr -d '\000' | head -c 80)"
                if [ -n "$nome" ] && [[ ! "$nome" =~ $NOME_RE ]]; then nome="?"; fi
                emite rotina "rotina-$n" "$nome"
                printf '%s' "$poke64" | base64 -d 2>/dev/null | tr -d '\000' | refs | while IFS=$'\t' read -r tipo ref; do
                    emite ref "rotina-$n" "$tipo" "$ref"
                done
            done <"$tmpj"
            emite rotinas "$total"
            if [ "$total" -gt "$MAX_ROTINAS" ]; then emite lim "mais de $MAX_ROTINAS rotinas; li so as primeiras $MAX_ROTINAS"; fi
        else
            emite lim "o manifesto de rotinas nao e um JSON valido; nao li"
        fi
        rm -f "$tmpj"
    fi
else
    emite rotinas 0
fi

# --- skills (so nomes que passam na regex) -------------------------------------------------------
if [ -L "$casa/.claude" ] || [ -L "$casa/.claude/skills" ]; then
    emite lim "a pasta .claude ou skills e um atalho; nao listei as skills"
else
    for sk in "$casa/.claude/skills"/*; do
        [ -e "$sk" ] || [ -L "$sk" ] || continue
        nome="${sk##*/}"
        if [[ "$nome" =~ $NOME_RE ]]; then emite skill "$nome"; else emite skillfora 1; fi
    done
fi

# --- scripts proprios (casa e skills proprias); -print0 de ponta a ponta, sem seguir atalho ----------
ns=0; grandes=0
while IFS= read -r -d '' f; do
    ns=$((ns + 1))
    if [ "$ns" -gt "$MAX_SCRIPTS" ]; then emite lim "mais de $MAX_SCRIPTS scripts; li so os primeiros $MAX_SCRIPTS"; break; fi
    dentro_da_casa "$f" || continue
    if [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -gt "$MAX_ARQ" ]; then grandes=$((grandes + 1)); continue; fi
    refs <"$f" | while IFS=$'\t' read -r tipo ref; do
        emite ref "script-$ns" "$tipo" "$ref"
    done
done < <(find -P "$casa" -maxdepth 5 \( -name node_modules -o -name .git -o -name .dgclaw -o -name memory -o -name uploads \
            -o -name projects -o -name backups -o -name logs -o -name .cache -o -name .npm -o -name .local \) -prune \
            -o -type f \( -name '*.sh' -o -name '*.py' -o -name '*.mjs' -o -name '*.js' -o -name '*.md' -path '*/.claude/skills/*' \) -print0 2>/dev/null \
            | sort -z | head -z -n "$((MAX_SCRIPTS + 1))")
emite scripts "$((ns > MAX_SCRIPTS ? MAX_SCRIPTS : ns))"
if [ "$grandes" -gt 0 ]; then emite puladosgrandes "$grandes"; fi

# --- canais (so existencia) e identidade -----------------------------------------------------------
if [ -d "$casa/.dgclaw/whatsapp" ] && [ ! -L "$casa/.dgclaw/whatsapp" ]; then emite canal WhatsApp; fi
if [ -f "$casa/.dgclaw/telegram/.env" ] && [ ! -L "$casa/.dgclaw/telegram" ]; then emite canal Telegram; fi
if [ -f "$casa/IDENTITY.md" ] || [ -f "$casa/PERSONALITY.md" ]; then emite identidade 1; fi
exit 0
