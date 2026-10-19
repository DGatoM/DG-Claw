#!/usr/bin/env bash
# lib/enterprise/nivel.sh: `dgclaw nivel ...` e `dgclaw protecoes aplicar`.
#
# O nivel e os ajustes moram em /etc/dgclaw/protecoes.json (lib/protecoes.sh). Mudar o arquivo
# muda o que o Web e a CLI enxergam na hora; levar a mudanca para dentro dos agentes que ja
# existem e o `dgclaw protecoes aplicar`, que roda os ganchos ent_aplicar_* de cada bloco.

_NIVEL_AVISO_APLICAR="rode \`dgclaw protecoes aplicar\` para levar a mudanca aos agentes que ja existem (os novos ja nascem certos)."

_nivel_mostrar() {
    local nivel org chave valor padrao trava marca
    nivel="$(protecao_nivel)"
    org="$(protecao_org)"
    printf 'Nivel de protecao: %s\n' "$nivel"
    printf 'Organizacao (forceLoginOrgUUID): %s\n\n' "${org:-nao definida}"
    printf '%-24s %-12s %-12s %s\n' "PROTECAO" "VALOR" "PADRAO" ""
    while IFS=$'\t' read -r chave padrao trava; do
        valor="$(protecao_valor "$chave")" || return 1
        marca=""
        if [ "$trava" = true ]; then marca="travado"; fi
        if [ "$valor" != "$padrao" ]; then marca="${marca:+$marca, }ajustado"; fi
        printf '%-24s %-12s %-12s %s\n' "$chave" "$valor" "$padrao" "$marca"
    done < <(jq -r --arg n "$nivel" '.chaves | to_entries[] | [.key, (.value.nivel[$n] | tostring), ((.value.travado[$n] // false) | tostring)] | @tsv' "$(_prot_matriz)")
    if [ "$nivel" = pessoal ]; then
        printf '\nNivel pessoal: nenhuma protecao enterprise esta ligada; o DG Claw age como sempre agiu.\n'
    fi
}

# _nivel_com_auditoria <evento> <json> <comando...>: roda a mudanca de nivel e audita. Se a trilha
# estava ligada ANTES, o evento entra antes da mudanca (rebaixar para um nivel sem auditoria
# tambem fica registrado); se estava desligada, entra depois (subir de nivel liga a trilha, e a
# primeira linha dela e a propria mudanca).
_nivel_com_auditoria() {
    local evento="$1" dados="$2" antes
    shift 2
    antes="$(protecao_valor auditoria)" || return 1
    if [ "$antes" != nao ]; then
        auditar_aviso "$evento" "$dados"
        "$@" || return $?
    else
        "$@" || return $?
        auditar_aviso "$evento" "$dados"
    fi
}

ent_cmd_nivel() {
    local sub="${1:-mostrar}" antes novo
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        mostrar) _prot_matriz_ok && _nivel_mostrar ;;
        definir)
            [ "$#" -eq 1 ] || falha "faltou o nivel (ou veio mais de um argumento)." "use: dgclaw nivel definir <pessoal|escritorio|empresa|regulado>"
            case " $PROT_NIVEIS " in *" $1 "*) ;; *) protecao_gravar_nivel "$1"; return 1 ;; esac
            antes="$(protecao_nivel)"
            _nivel_com_auditoria nivel.definir "$(jq -nc --arg de "$antes" --arg para "$1" '{de: $de, para: $para}')" \
                protecao_gravar_nivel "$1" || return 1
            ok "nivel de protecao: $antes -> $1"
            info "$_NIVEL_AVISO_APLICAR" ;;
        ajustar)
            [ "$#" -eq 2 ] || falha "faltou a chave ou o valor." "use: dgclaw nivel ajustar <chave> <valor>   (veja as chaves com: dgclaw nivel)"
            antes="$(protecao_valor "$1")" || return 1
            protecao_ajustar "$1" "$2" || return 1
            novo="$(protecao_valor "$1")"
            ok "$1: $antes -> $novo"
            # Depois da mudanca: a trava impede que um ajuste desligue a trilha que ja estava ligada.
            auditar_aviso nivel.ajustar "$(jq -nc --arg c "$1" --arg de "$antes" --arg para "$novo" '{chave: $c, de: $de, para: $para}')"
            info "$_NIVEL_AVISO_APLICAR" ;;
        org)
            [ "$#" -eq 1 ] || falha "faltou o UUID da organizacao." "use: dgclaw nivel org <uuid>   (o identificador da organizacao no console da Anthropic)"
            protecao_org "$1" || return 1
            ok "organizacao gravada: $1"
            auditar_aviso nivel.org "$(jq -nc --arg u "$1" '{org_uuid: $u}')"
            info "$_NIVEL_AVISO_APLICAR" ;;
        *) falha "o subcomando 'nivel $sub' nao existe." "use: dgclaw nivel [mostrar] | definir <nivel> | ajustar <chave> <valor> | org <uuid>" ;;
    esac
}

ent_cmd_protecoes() {
    local sub="${1:-}" quantos
    case "$sub" in
        aplicar)
            quantos="$(compgen -A function ent_aplicar_ | wc -l | tr -d ' ')"
            passo "Aplicando as protecoes do nivel $(protecao_nivel) aos agentes"
            if [ "$quantos" -eq 0 ]; then
                info "nenhuma protecao desta versao precisa ser levada aos agentes que ja existem."
            else
                ent_rodar_ganchos ent_aplicar_ || return $?
                ok "protecoes aplicadas ($quantos bloco(s))"
            fi
            auditar_aviso protecoes.aplicar "$(jq -nc --arg n "$(protecao_nivel)" '{nivel: $n}')" ;;
        *) falha "o subcomando 'protecoes ${sub}' nao existe." "use: dgclaw protecoes aplicar" ;;
    esac
}
