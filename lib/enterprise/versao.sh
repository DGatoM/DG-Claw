#!/usr/bin/env bash
# lib/enterprise/versao.sh: `dgclaw versao` e o registro /etc/dgclaw/versao.
#
# O instalador chama versao_gravar a cada instalacao e atualizacao. O registro e um JSON
# {versao, commit, data} (644: nao tem segredo). A versao vem do arquivo VERSION na raiz do codigo.

_VERSAO_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# versao_do_codigo [<pasta do codigo>]: imprime o conteudo do VERSION, ou "desconhecida".
versao_do_codigo() {
    local pasta="${1:-${APP_DIR:-$_VERSAO_LIB_DIR/../..}}" v=""
    if [ -r "$pasta/VERSION" ]; then v="$(tr -d '[:space:]' <"$pasta/VERSION")"; fi
    printf '%s' "${v:-desconhecida}"
}

# versao_gravar [<pasta do codigo>]: grava $DG_ETC/versao com versao, commit (se a pasta tem git) e data.
versao_gravar() {
    local pasta="${1:-${APP_DIR:-$_VERSAO_LIB_DIR/../..}}" versao commit
    versao="$(versao_do_codigo "$pasta")"
    # Sem .git (zip, ou /opt/dgclaw/app) nao ha commit para dizer: o campo fica vazio.
    commit="$(git -C "$pasta" rev-parse --short=12 HEAD 2>/dev/null)" || commit=""
    jq -nc --arg v "$versao" --arg c "$commit" --arg d "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{versao: $v, commit: $c, data: $d}' | escrever_arquivo "$DG_ETC/versao" 644
}

ent_cmd_versao() {
    local arq="$DG_ETC/versao" v c d
    if [ -s "$arq" ] && jq -e 'type == "object"' "$arq" >/dev/null 2>&1; then
        v="$(jq -r '.versao // "desconhecida"' "$arq")"
        c="$(jq -r '.commit // ""' "$arq")"
        d="$(jq -r '.data // ""' "$arq")"
        printf 'DG Claw %s' "$v"
        if [ -n "$c" ]; then printf ' (commit %s)' "$c"; fi
        if [ -n "$d" ]; then printf ', instalado em %s' "$d"; fi
        printf '\n'
    else
        printf 'DG Claw %s (sem o registro %s: ele passa a existir na proxima instalacao ou atualizacao)\n' "$(versao_do_codigo)" "$arq"
    fi
    printf 'Nivel de protecao: %s\n' "$(protecao_nivel)"
}
