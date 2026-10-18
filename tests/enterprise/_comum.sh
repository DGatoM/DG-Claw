#!/usr/bin/env bash
# shellcheck disable=SC2034 # as variaveis daqui sao usadas pelos testes que carregam este arquivo
# Ajudantes dos testes enterprise: reaproveita os da CLI (raiz falsa, stubs, afirma/igual/fim)
# e acrescenta `lib`, que roda uma funcao das libs num bash novo, como a CLI faz.
# shellcheck source=tests/cli/_comum.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../cli/_comum.sh"

ENT_STUBS="$AQUI/../enterprise/stubs"
CLI_COPIA=""
MATRIZ="$REPO/config/protecoes-matriz.json"

# lib <funcao> [args...]: carrega comum.sh, protecoes.sh e lib/enterprise/*.sh e chama a funcao.
lib() {
    bash -c 'set -euo pipefail
        REPO="$1"; shift
        APP_DIR="$REPO"
        . "$REPO/lib/comum.sh"
        . "$REPO/lib/protecoes.sh"
        shopt -s nullglob
        for f in "$REPO"/lib/enterprise/*.sh; do . "$f"; done
        "$@"' _ "$REPO" "$@"
}

# nivel_na_raiz <nivel> [json-extra-de-ajustes]: grava um protecoes.json direto, sem passar pela lib.
nivel_na_raiz() {
    printf '{"versao":1,"nivel":"%s","ajustes":%s,"org_uuid":"","atualizado_em":"2026-01-01T00:00:00Z"}\n' "$1" "${2:-{\}}" >"$ETC/protecoes.json"
    chmod 600 "$ETC/protecoes.json"
}

# app_copia: copia o necessario do repo para $TMP/app (a CLI acha o APP_DIR pelo proprio caminho),
# para o teste poder largar um lib/enterprise/zz-*.sh de mentira sem sujar o repositorio.
# Devolve o caminho da CLI copiada em $CLI_COPIA.
app_copia() {
    mkdir -p "$TMP/app"
    cp -r "$REPO/bin" "$REPO/lib" "$REPO/config" "$REPO/templates" "$REPO/scripts" "$REPO/VERSION" "$TMP/app/"
    CLI_COPIA="$TMP/app/bin/dgclaw"
}
