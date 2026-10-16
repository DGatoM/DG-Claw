#!/usr/bin/env bash
# Roda todos os testes da CLI e sai com erro se algum falhar.
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
falhou=0
for t in "$AQUI"/criar.sh "$AQUI"/validacao.sh "$AQUI"/gestao.sh "$AQUI"/cofre.sh "$AQUI"/inotify.sh; do
    printf '\n== %s\n' "$(basename "$t")"
    bash "$t" || falhou=1
done
if [ "$falhou" -ne 0 ]; then
    printf '\nHOUVE FALHAS nos testes da CLI.\n' >&2
    exit 1
fi
printf '\nTestes da CLI: tudo certo.\n'
