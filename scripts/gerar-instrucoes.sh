#!/usr/bin/env bash
# Gera as instrucoes dos agentes e do Admin para os dois motores a partir de UMA fonte por par,
# para o CLAUDE.md e o AGENTS.md nunca divergirem (docs/PARIDADE-CODEX.md).
#
#   templates/instrucoes-agente.md.tmpl      -> templates/CLAUDE.md.tmpl   e templates/AGENTS.md.tmpl
#   templates/admin/instrucoes-admin.md.tmpl -> templates/admin/CLAUDE.md e templates/admin/AGENTS.md
#
# Marcadores na fonte (cada um sozinho na sua linha, sem aninhar):
#   <!-- so:claude -->  ... <!-- /so -->   so entra na versao do Claude
#   <!-- so:codex -->   ... <!-- /so -->   so entra na versao do Codex
#   {{SKILL:nome}}                          vira /dgclaw:nome no Claude e nome no Codex
# O resto do texto e comum. Os campos {{NOME}}, {{DONO}} etc. passam intactos (o bin/dgclaw os preenche).
#
# Uso: bash scripts/gerar-instrucoes.sh            regrava os quatro arquivos gerados
#      bash scripts/gerar-instrucoes.sh --conferir nao grava; sai com 1 se algum estiver diferente da fonte
#      bash scripts/gerar-instrucoes.sh --stdout <fonte> <claude|codex>   imprime um so (usado pelo teste)
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# gerar <fonte> <motor>: imprime o texto do motor. Erra se um marcador estiver mal formado.
gerar() {
    local fonte="$1" motor="$2"
    [ -f "$fonte" ] || { echo "gerar-instrucoes: a fonte $fonte nao existe." >&2; return 1; }
    case "$motor" in claude|codex) ;; *) echo "gerar-instrucoes: motor '$motor' invalido (use claude ou codex)." >&2; return 1 ;; esac
    awk -v motor="$motor" -v fonte="$fonte" '
        function falha(msg) { printf "gerar-instrucoes: %s:%d: %s\n", fonte, NR, msg > "/dev/stderr"; erro = 1; exit 1 }
        /^<!-- so:(claude|codex) -->[[:space:]]*$/ {
            if (bloco != "") falha("marcador aberto dentro de outro (" bloco ")")
            bloco = $0; sub(/^<!-- so:/, "", bloco); sub(/ -->.*/, "", bloco); next
        }
        /^<!-- \/so -->[[:space:]]*$/ {
            if (bloco == "") falha("<!-- /so --> sem abertura")
            bloco = ""; next
        }
        /<!-- \/?so/ { falha("marcador fora do formato (precisa estar sozinho na linha)") }
        {
            if (bloco != "" && bloco != motor) next
            linha = $0
            while (match(linha, /\{\{SKILL:[a-z0-9-]+\}\}/)) {
                nome = substr(linha, RSTART + 8, RLENGTH - 10)
                linha = substr(linha, 1, RSTART - 1) (motor == "claude" ? "/dgclaw:" : "") nome substr(linha, RSTART + RLENGTH)
            }
            print linha
        }
        END { if (!erro && bloco != "") { printf "gerar-instrucoes: %s: bloco %s nunca foi fechado\n", fonte, bloco > "/dev/stderr"; exit 1 } }
    ' "$fonte"
}

PARES=(
    "templates/instrucoes-agente.md.tmpl|templates/CLAUDE.md.tmpl|templates/AGENTS.md.tmpl"
    "templates/admin/instrucoes-admin.md.tmpl|templates/admin/CLAUDE.md|templates/admin/AGENTS.md"
)

principal() {
    if [ "${1:-}" = "--stdout" ]; then gerar "${2:?fonte}" "${3:?motor}"; return; fi
    local modo="gravar" par fonte c x tmp ruins=0
    [ "${1:-}" = "--conferir" ] && modo="conferir"
    cd "$RAIZ"
    for par in "${PARES[@]}"; do
        IFS='|' read -r fonte c x <<<"$par"
        tmp="$(mktemp)"
        # shellcheck disable=SC2064
        trap "rm -f '$tmp'" RETURN
        for alvo in "claude|$c" "codex|$x"; do
            gerar "$fonte" "${alvo%%|*}" >"$tmp" || return 1
            if [ "$modo" = "conferir" ]; then
                if ! cmp -s "$tmp" "${alvo#*|}"; then
                    echo "desatualizado: ${alvo#*|} (rode: bash scripts/gerar-instrucoes.sh)" >&2; ruins=1
                fi
            else
                cmp -s "$tmp" "${alvo#*|}" 2>/dev/null || { cp "$tmp" "${alvo#*|}"; echo "gravado: ${alvo#*|}"; }
            fi
        done
        rm -f "$tmp"; trap - RETURN
    done
    return "$ruins"
}

principal "$@"
