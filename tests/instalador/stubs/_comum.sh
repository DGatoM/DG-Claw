# shellcheck shell=bash
# Auxiliar dos stubs (carregado com source). Todo stub registra a chamada inteira
# (nome + argumentos) em $DGCLAW_STUB_LOG: o teste de "a senha nunca aparece em argv"
# depende disso. O estado entre chamadas (pacotes instalados, unidades ativas...) fica
# em arquivos dentro de $DGCLAW_STUB_ESTADO.
registrar() { printf '%s %s\n' "$(basename "$0")" "$*" >>"${DGCLAW_STUB_LOG:?DGCLAW_STUB_LOG nao definida}"; }
estado_dir() { mkdir -p "${DGCLAW_STUB_ESTADO:?DGCLAW_STUB_ESTADO nao definida}"; printf '%s' "$DGCLAW_STUB_ESTADO"; }
# esta_na_lista <arquivo-de-estado> <item> [lista-inicial-separada-por-espaco]
esta_na_lista() {
    local arq item="$2" extra="${3:-}" x
    arq="$(estado_dir)/$1"
    for x in $extra; do [ "$x" = "$item" ] && return 0; done
    [ -f "$arq" ] && grep -qxF "$item" "$arq"
}
