#!/usr/bin/env bash
# Ajudantes dos testes da CLI: uma raiz falsa por teste, o PATH com os programas de
# mentira (tests/cli/stubs) e as comparacoes. Carregado com `source`.
#
# Nada aqui encosta no sistema de verdade: DGCLAW_RAIZ faz todo caminho viver na
# pasta temporaria, e podman, systemctl, ss, curl e iptables sao os de mentira.

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
CLI="$REPO/bin/dgclaw"
FALHAS=0
TESTES=0

preparar() {
    TMP="$(mktemp -d)"
    export DGCLAW_RAIZ="$TMP/raiz"
    export STUB_ESTADO="$TMP/estado"
    export STUB_LOG="$TMP/podman.log"
    export DGCLAW_TEMPO_ESPERA=2
    export DGCLAW_TEMPO_PARTIDA=1
    export NO_COLOR=1
    mkdir -p "$DGCLAW_RAIZ/etc/dgclaw" "$STUB_ESTADO"
    : >"$STUB_LOG"
    PATH="$AQUI/stubs:$PATH"
    export PATH
    printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$DGCLAW_RAIZ/etc/dgclaw/dgclaw.env"
    # shellcheck disable=SC2034 # usadas pelos testes que carregam este arquivo
    ETC="$DGCLAW_RAIZ/etc/dgclaw"
    # shellcheck disable=SC2034
    LIB="$DGCLAW_RAIZ/var/lib/dgclaw"
    trap 'rm -rf "$TMP"' EXIT
}

dgclaw() { "$CLI" "$@"; }

# criar_agente <args>: roda `agente criar` guardando a saida em $TMP/saida.txt.
criar_agente() { dgclaw agente criar "$@" >"$TMP/saida.txt" 2>&1; }

ok() { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }

# afirma "<descricao>" <comando...>: passa se o comando sai com 0.
afirma() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then ok "$desc"; else mal "$desc"; fi
}
# nega "<descricao>" <comando...>: passa se o comando sai com codigo diferente de 0.
nega() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then mal "$desc"; else ok "$desc"; fi
}
igual() {
    local desc="$1" esperado="$2" obtido="$3"
    if [ "$esperado" = "$obtido" ]; then ok "$desc"
    else mal "$desc (esperado '$esperado', veio '$obtido')"; fi
}

fim() {
    printf '%s: %s verificacoes, %s falharam\n' "$(basename "$0")" "$TESTES" "$FALHAS"
    [ "$FALHAS" -eq 0 ]
}
