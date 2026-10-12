#!/usr/bin/env bash
# Faz o papel do panel/bin/senha-hash.js nos testes: senha no STDIN, hash numa linha
# no STDOUT, codigo != 0 se tiver menos de 12 caracteres. O hash depende da senha
# (para o teste ver que uma senha nova troca o hash), mas nao a revela.
set -euo pipefail
IFS= read -r senha || true
if [ "${#senha}" -lt 12 ]; then echo "senha curta" >&2; exit 2; fi
# shellcheck disable=SC2016 # os $ fazem parte do formato do hash, nao sao variaveis
printf 'scrypt$teste$%s\n' "$(printf '%s' "$senha" | sha256sum | cut -d' ' -f1)"
