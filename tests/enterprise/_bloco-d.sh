#!/usr/bin/env bash
# shellcheck disable=SC2034 # as variaveis daqui sao usadas pelos testes que carregam este arquivo
# Ajudantes dos testes do bloco D (container, cofre cifrado, disco, backup): os stubs de cryptsetup, mount, restic,
# systemd-creds etc. na frente do PATH, com o log e o estado que os stubs do instalador esperam.
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "${BASH_SOURCE[0]}")/_comum.sh"
ENT_STUBS_D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stubs-d"

# stubs_d: chame depois de `preparar` (cada preparar cria uma raiz nova).
# Os stubs do bloco D ficam em tests/enterprise/stubs-d (a pasta stubs/ e do teste de atualizar).
stubs_d() {
    PATH="$ENT_STUBS_D:$PATH"
    export PATH
    export DGCLAW_STUB_LOG="$STUB_LOG" DGCLAW_STUB_ESTADO="$STUB_ESTADO"
}

# dono_de <caminho>: uid:gid de verdade (como root) ou, nos testes sem root, o que o `dono` simulado anotou.
dono_de() {
    if [ "$(id -u)" -eq 0 ]; then stat -c '%u:%g' "$1"
    else awk -v c="$1" '$2 == c {print $1}' "$DGCLAW_RAIZ/.chown-simulado" | tail -n 1; fi
}

# lib_d <funcao> [args...]: como `lib`, mas carrega tambem lib/agentes.sh (o instalador carrega; `lib` nao).
lib_d() {
    bash -c 'set -euo pipefail
        REPO="$1"; shift
        APP_DIR="$REPO"
        . "$REPO/lib/comum.sh"
        . "$REPO/lib/agentes.sh"
        . "$REPO/lib/protecoes.sh"
        shopt -s nullglob
        for f in "$REPO"/lib/enterprise/*.sh; do . "$f"; done
        "$@"' _ "$REPO" "$@"
}
