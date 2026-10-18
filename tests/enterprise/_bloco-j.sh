#!/usr/bin/env bash
# shellcheck disable=SC2034 # as variaveis daqui sao usadas pelos testes que carregam este arquivo
# Ajudantes dos testes do bloco J (regulado): empilha os stubs do J (cryptsetup com varios slots, clevis, gpg, runsc...)
# na frente dos do bloco D. Nenhum comando de sistema de verdade roda: o teste confere nos logs que foi o stub.
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "${BASH_SOURCE[0]}")/_bloco-d.sh"
ENT_STUBS_J="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stubs-j"
ENT_STUBS_J_RUNSC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stubs-j-runsc"

# stubs_j [sem-runsc]: chame depois de `preparar`.
stubs_j() {
    stubs_d
    PATH="$ENT_STUBS_J:$PATH"
    if [ "${1:-}" != sem-runsc ]; then PATH="$ENT_STUBS_J_RUNSC:$PATH"; fi
    export PATH
    export DGCLAW_DISCO_MAPPER="$TMP/mapper/dgclaw-dados"
}
