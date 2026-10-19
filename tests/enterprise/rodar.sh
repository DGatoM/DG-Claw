#!/usr/bin/env bash
# Roda todos os tests/enterprise/*.test.sh e sai com erro se algum falhar.
# Nada aqui encosta no sistema: raiz falsa (DGCLAW_RAIZ) e comandos de mentira no PATH.
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
falhou=0
for t in "$AQUI"/*.test.sh; do
    printf '\n== %s\n' "$(basename "$t")"
    bash "$t" || falhou=1
done
if [ "$falhou" -ne 0 ]; then
    printf '\nHOUVE FALHAS nos testes enterprise.\n' >&2
    exit 1
fi
printf '\nTestes enterprise: tudo certo.\n'
