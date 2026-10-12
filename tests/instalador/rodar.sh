#!/usr/bin/env bash
# Roda todos os casos de tests/instalador/casos.sh e sai com codigo != 0 se algum falhar.
# Nenhum caso encosta no sistema de verdade: tudo vai para uma raiz falsa (DGCLAW_RAIZ) e
# os comandos do sistema (apt-get, systemctl, ufw...) sao stubs de tests/instalador/stubs/.
#
# Uso: bash tests/instalador/rodar.sh [parte-do-nome-do-caso]
set -uo pipefail

# shellcheck source=tests/instalador/ajuda.sh
. "$(dirname "${BASH_SOURCE[0]}")/ajuda.sh"
# shellcheck source=tests/instalador/casos.sh
. "$AQUI/casos.sh"

main() {
    local filtro="${1:-}" total=0 ruins=0 caso rc
    local casos
    casos="$(compgen -A function | grep '^caso_' | sort)"
    for caso in $casos; do
        if [ -n "$filtro" ] && [[ "$caso" != *"$filtro"* ]]; then continue; fi
        total=$((total + 1))
        printf '%s\n' "- $caso"
        (
            trap 'if [ -n "${TMP:-}" ]; then rm -rf "$TMP"; fi' EXIT
            FALHAS=0
            "$caso"
            [ "$FALHAS" -eq 0 ]
        )
        rc=$?
        if [ "$rc" -ne 0 ]; then
            ruins=$((ruins + 1))
            printf '  RESULTADO: FALHOU\n'
        fi
    done
    printf '\n%s casos, %s com falha.\n' "$total" "$ruins"
    [ "$ruins" -eq 0 ]
}

main "$@"
