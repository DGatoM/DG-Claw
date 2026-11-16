#!/usr/bin/env bash
# lib/uso-coletor.sh: junta, de UMA casa de agente, o que a secao "O que este DG Claw usa" precisa.
#
# Roda como root, num processo a parte e sob `timeout` (lib/uso-atualizacao.sh), porque a casa e gravavel pelo
# proprio agente: tudo o que existe la e DADO NAO CONFIAVEL. Por isso o coletor nunca devolve texto livre. Ele
# escreve no arquivo de saida so linhas de formato fixo (campos separados por TAB):
#   rotinas<TAB>N | scripts<TAB>N | puladosgrandes<TAB>N | canal<TAB>WhatsApp|Telegram | identidade<TAB>1
#   rotina<TAB>rotina-N | skill<TAB>propria | skill<TAB>oficial<TAB>nome (so nome igual a skill distribuida pelo DG Claw)
#   ref<TAB>rotina-N|script-N<TAB>arq|cli<TAB>referencia   (so caracteres de caminho ou de comando)
#   lim<TAB>texto fixo do coletor
# Nomes de rotina nunca saem. Quem consome confere cada referencia contra a lista confiavel (diff da versao, ajuda do bin/dgclaw) antes de mostrar qualquer coisa.
#
# Uso: uso-coletor.sh <casa do agente> <arquivo de saida> [lista de skills distribuidas, uma por linha]
set -uo pipefail

MAX_ARQ=262144      # bytes por arquivo lido
MAX_ROTINAS=200
MAX_SCRIPTS=500
MAX_SKILLS=300
MAX_REFS=2000       # referencias UNICAS por agente

casa="${1:?casa}"; saida="${2:?saida}"; oficiais="${3:-/dev/null}"
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

# copiar_seguro <arquivo> <copia>: copia o arquivo da casa para um temporario do host pelo helper em Python, que abre
# sem seguir atalho nem bloquear, confere pelo mesmo descritor que e arquivo comum dentro da casa e le no maximo
# 256 KiB + 1 byte. Devolve o codigo do helper: 0 copiou, 10 nao e arquivo comum, 11 grande demais, 12 fora da casa,
# 13 sumiu. Nenhum outro programa do host abre o arquivo da casa: grep, jq e cia so veem a copia.
LER_PY="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/uso-ler.py"
copiar_seguro() {
    local rc=0
    timeout 10 python3 -I "$LER_PY" "$casa_real" "$1" "$2" 2>/dev/null || rc=$?
    return "$rc"
}

# --- rotinas -----------------------------------------------------------------------------------
m="$casa/.dgclaw/self-crons.json"
copia="$(mktemp)"; reftmp="$(mktemp)"; trap 'rm -f "$copia" "$reftmp" "$reftmp.u"' EXIT
rc_m=0
if [ -L "$casa/.dgclaw" ]; then rc_m=10; else copiar_seguro "$m" "$copia" || rc_m=$?; fi
case "$rc_m" in
    13) emite rotinas 0 ;;
    10) emite lim "o manifesto de rotinas nao e arquivo comum (atalho, FIFO ou pasta); pulado" ;;
    11) emite lim "o manifesto de rotinas passa de 256 KB; nao li" ;;
    0)
        tmpj="$(mktemp)"
        if grep -v '^#' "$copia" | jq -r '
                (.crons // {}) | (if type == "array" then .[] else to_entries[] end)
                | ((if type == "object" and has("value") and has("key") then .value else . end)
                   | (.poke // .command // .cmd // "") | tostring | @base64)' >"$tmpj" 2>/dev/null; then
            total="$(grep -c . "$tmpj" || true)"
            n=0
            while IFS= read -r poke64; do
                n=$((n + 1))
                [ "$n" -le "$MAX_ROTINAS" ] || break
                emite rotina "rotina-$n"
                printf '%s' "$poke64" | base64 -d 2>/dev/null | tr -d '\000' | refs | while IFS=$'\t' read -r tipo ref; do
                    printf '%s\t%s\t%s\n' "rotina-$n" "$tipo" "$ref" >>"$reftmp"
                done
            done <"$tmpj"
            emite rotinas "$total"
            if [ "$total" -gt "$MAX_ROTINAS" ]; then emite lim "mais de $MAX_ROTINAS rotinas; li so as primeiras $MAX_ROTINAS"; fi
        else
            emite lim "o manifesto de rotinas nao e um JSON valido; nao li"
        fi
        rm -f "$tmpj" ;;
    *) emite lim "o manifesto de rotinas nao pode ser lido com seguranca; pulado" ;;
esac

# --- skills (so os nomes; quem consome decide se mostra) ----------------------------------------
if [ -L "$casa/.claude" ] || [ -L "$casa/.claude/skills" ]; then
    emite lim "a pasta .claude ou skills e um atalho; nao listei as skills"
else
    nsk=0
    while IFS= read -r -d '' sk; do
        nsk=$((nsk + 1))
        if [ "$nsk" -gt "$MAX_SKILLS" ]; then emite lim "mais de $MAX_SKILLS skills; listei so as primeiras $MAX_SKILLS"; break; fi
        nome="${sk##*/}"
        # O nome nunca sai do coletor, a nao ser que seja IGUAL a uma skill distribuida pelo DG Claw (lista de fora da casa).
        if [[ "$nome" =~ ^[a-z0-9][a-z0-9._-]{0,40}$ ]] && grep -qxF -- "$nome" "$oficiais" 2>/dev/null; then emite skill oficial "$nome"; else emite skill propria; fi
    # Ordem fixa (sort, LC_ALL=C): o find devolve na ordem do disco, que muda de uma maquina para outra, e os ids skill-N do
    # relatorio e o corte das "primeiras N" dependem dela.
    done < <(find -P "$casa/.claude/skills" -mindepth 1 -maxdepth 1 -print0 2>/dev/null | LC_ALL=C sort -z | head -z -n "$((MAX_SKILLS + 1))")
fi

# --- scripts proprios (casa e skills proprias); -print0 de ponta a ponta, sem seguir atalho ----------
ns=0; grandes=0; naocomuns=0
while IFS= read -r -d '' f; do
    ns=$((ns + 1))
    if [ "$ns" -gt "$MAX_SCRIPTS" ]; then emite lim "mais de $MAX_SCRIPTS scripts; li so os primeiros $MAX_SCRIPTS"; break; fi
    rc_f=0; copiar_seguro "$f" "$copia" || rc_f=$?
    case "$rc_f" in
        0) ;;
        11) grandes=$((grandes + 1)); continue ;;
        *) naocomuns=$((naocomuns + 1)); continue ;;
    esac
    refs <"$copia" | while IFS=$'\t' read -r tipo ref; do
        printf '%s\t%s\t%s\n' "script-$ns" "$tipo" "$ref" >>"$reftmp"
    done
done < <(find -P "$casa" -maxdepth 5 \( -name node_modules -o -name .git -o -name .dgclaw -o -name memory -o -name uploads \
            -o -name projects -o -name backups -o -name logs -o -name .cache -o -name .npm -o -name .local \) -prune \
            -o -type f \( -name '*.sh' -o -name '*.py' -o -name '*.mjs' -o -name '*.js' -o -name '*.md' -path '*/.claude/skills/*' \) -print0 2>/dev/null \
            | LC_ALL=C sort -z | head -z -n "$((MAX_SCRIPTS + 1))")
emite scripts "$((ns > MAX_SCRIPTS ? MAX_SCRIPTS : ns))"
if [ "$grandes" -gt 0 ]; then emite puladosgrandes "$grandes"; fi
if [ "$naocomuns" -gt 0 ]; then emite puladosnaocomuns "$naocomuns"; fi

# --- referencias: uma vez cada por origem (rotina ou script) + tipo + referencia, no maximo MAX_REFS por agente ------------------------------
awk -F'\t' '!visto[substr($1, 1, 6) FS $2 FS $3]++' "$reftmp" >"$reftmp.u"
total_refs="$(grep -c . "$reftmp.u" || true)"
head -n "$MAX_REFS" "$reftmp.u" | while IFS=$'\t' read -r origem tipo ref; do emite ref "$origem" "$tipo" "$ref"; done
if [ "$total_refs" -gt "$MAX_REFS" ]; then emite lim "mais de $MAX_REFS referencias unicas; cruzei so as primeiras $MAX_REFS"; fi

# --- canais (so existencia) e identidade -----------------------------------------------------------
if [ -d "$casa/.dgclaw/whatsapp" ] && [ ! -L "$casa/.dgclaw/whatsapp" ]; then emite canal WhatsApp; fi
if [ -f "$casa/.dgclaw/telegram/.env" ] && [ ! -L "$casa/.dgclaw/telegram" ]; then emite canal Telegram; fi
if [ -f "$casa/IDENTITY.md" ] || [ -f "$casa/PERSONALITY.md" ]; then emite identidade 1; fi
exit 0
