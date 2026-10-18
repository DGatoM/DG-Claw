#!/usr/bin/env bash
# lib/enterprise/credencial.sh: credencial da empresa (protecao `credencial_empresa`).
#
# Com a protecao ligada, todo agente nasce com um USO:
#   pessoa  e de uma pessoa, entra com o assento (Team ou Enterprise) da propria pessoa: --auth assinatura.
#           Grava o usuario dono no agente e acrescenta o agente na lista da pessoa (multiusuario).
#   setor   e de um setor, usa a chave de API da organizacao da empresa: --auth api.
# O modo `token` (claude setup-token) tambem fica de fora: o assento e pessoal e intransferivel, e um codigo de
# longa duracao e justamente o jeito de emprestar o assento. Isso limpa a opcao do NOSSO lado (painel e Web); nao mexe
# em nada do binario do Claude Code (armadilha 8 do DESENHO). Texto completo em docs/enterprise/CREDENCIAL.md.
#
# bin/dgclaw chama dois ganchos:
#   ent_credencial_validar              (em agente_criar, depois de ler as opcoes: C_USO e C_USUARIO)
#   ent_depois_de_criar_credencial      (grava uso e dono no agentes.json e na lista da pessoa)
# No nivel pessoal, sem --uso, nada disso faz nada.

# Motivo em portugues, o mesmo que o Web mostra quando recusa o modo de longa duracao.
CREDENCIAL_MOTIVO_TOKEN="na versao empresa, cada pessoa entra com o proprio assento do Team ou do Enterprise, ou o agente usa a chave de API da empresa"

ent_credencial_validar() {
    # O Admin e criado pelo instalador do Admin isolado, com regra propria.
    if declare -F ent_admin_criando >/dev/null && ent_admin_criando; then return 0; fi
    case "${C_USO:-}" in
        ""|pessoa|setor) ;;
        *) falha "o uso '$C_USO' nao existe." "use --uso pessoa (agente de uma pessoa, entra com o assento dela) ou --uso setor (agente de um setor, usa a chave de API da empresa)." ;;
    esac
    if ! protecao_ligada credencial_empresa; then return 0; fi
    if [ -z "${C_USO:-}" ]; then
        falha "este agente precisa dizer de quem e: falta --uso pessoa|setor (a protecao credencial_empresa esta ligada no nivel $(protecao_nivel))." \
            "agente de uma pessoa: dgclaw agente criar $C_SLUG --nome \"$C_NOME\" --uso pessoa --usuario <login da pessoa>   |   agente de um setor: dgclaw agente criar $C_SLUG --nome \"$C_NOME\" --uso setor --auth api. Por que: o assento do Team ou do Enterprise e pessoal e intransferivel."
    fi
    case "$C_USO" in
        setor)
            [ "$C_AUTH" = api ] || falha "agente de setor precisa usar a chave de API da empresa (--auth api), e voce pediu --auth $C_AUTH." \
                "refaca com: dgclaw agente criar $C_SLUG --nome \"$C_NOME\" --uso setor --auth api   (depois guarde a chave da organizacao no cofre do agente). Por que: $CREDENCIAL_MOTIVO_TOKEN."
            if [ -n "${C_USUARIO:-}" ]; then aviso "agente de setor nao tem dono pessoa; ignorei --usuario $C_USUARIO."; C_USUARIO=""; fi ;;
        pessoa)
            [ "$C_AUTH" = assinatura ] || falha "agente de pessoa entra com o assento da propria pessoa (--auth assinatura), e voce pediu --auth $C_AUTH." \
                "refaca com --auth assinatura, ou, se o agente e de um setor, com --uso setor --auth api. Por que: $CREDENCIAL_MOTIVO_TOKEN."
            if protecao_ligada multiusuario; then
                [ -n "${C_USUARIO:-}" ] || falha "agente de pessoa precisa dizer de qual usuario e (falta --usuario <login>)." \
                    "veja os logins com: dgclaw usuario listar   e rode: dgclaw agente criar $C_SLUG --nome \"$C_NOME\" --uso pessoa --usuario <login>"
                _usr_exigir_existe "$C_USUARIO"
            fi ;;
    esac
}

# Grava uso e dono no agentes.json (o Web le) e acrescenta o agente na lista da pessoa.
ent_depois_de_criar_credencial() {
    local slug="$1" dono_login
    [ "$ENSAIO" != 1 ] || return 0
    [ -n "${C_USO:-}" ] || return 0
    dono_login="${C_USUARIO:-}"
    # shellcheck disable=SC2016 # os $ sao variaveis do jq
    com_trava _agentes_aplicar \
        '.agentes |= map(if .slug == $s then . + {uso: $u} + (if $d == "" then {} else {dono: $d} end) else . end)' \
        --arg s "$slug" --arg u "$C_USO" --arg d "$dono_login"
    ok "agente $slug marcado como de uso $C_USO${dono_login:+ (dono: $dono_login)}"
    if [ -n "$dono_login" ] && protecao_ligada multiusuario; then
        # O TI ve todos os agentes: a lista so importa para funcionario.
        # shellcheck disable=SC2016 # codigo jq
        _usr_mudar '.usuarios |= map(if ((.usuario | ascii_downcase) == ($u | ascii_downcase)) and .papel != "ti" and ((.agentes // []) | index($s) | not) then .agentes = ((.agentes // []) + [$s]) else . end)' \
            --arg u "$dono_login" --arg s "$slug"
    fi
    auditar_aviso agente.uso "$(jq -nc --arg s "$slug" --arg u "$C_USO" --arg d "$dono_login" '{slug: $s, uso: $u, dono: (if $d == "" then null else $d end)}')"
}

# Marca para o painel do agente: com a protecao ligada o painel nao oferece o modo de longa duracao. O arquivo mora na
# pasta de configuracao do agente (montada so leitura no container); o painel le /run/dgclaw/config/credencial-empresa.
_cred_marca() { printf '%s/%s/config/credencial-empresa' "${DG_CASAS:-$DG_LIB/agentes}" "$1"; }

_cred_gravar_marca() {
    local slug="$1" marca dono_pasta
    marca="$(_cred_marca "$slug")"
    [ -d "$(dirname "$marca")" ] || return 0
    if protecao_ligada credencial_empresa; then
        dono_pasta="$(stat -c '%u:%g' "$(dirname "$marca")" 2>/dev/null || echo 0:0)"
        printf '%s\n' "$CREDENCIAL_MOTIVO_TOKEN" | escrever_arquivo "$marca" 644 "$dono_pasta"
    elif [ -e "$marca" ] && [ "$ENSAIO" != 1 ]; then
        rm -f -- "$marca"
    fi
}

ent_depois_de_criar_credencial_marca() { _cred_gravar_marca "$1"; }

ent_aplicar_credencial() {
    local slug sem_uso=""
    while IFS= read -r slug; do
        _cred_gravar_marca "$slug"
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    protecao_ligada credencial_empresa || return 0
    sem_uso="$(agentes_ler | jq -r '[.agentes[] | select(.tipo == "agente" and ((.uso // "") == "")) | .slug] | join(", ")')"
    if [ -n "$sem_uso" ]; then
        aviso "agente(s) criado(s) antes da protecao e sem uso definido: $sem_uso. Diga de quem sao com: dgclaw agente uso <slug> pessoa|setor [--usuario <login>]"
    fi
}

ent_status_credencial() {
    local sem
    protecao_ligada credencial_empresa || return 0
    sem="$(agentes_ler | jq -r '[.agentes[] | select(.tipo == "agente" and ((.uso // "") == "")) | .slug] | join(", ")')"
    if [ -n "$sem" ]; then s_aviso "credencial da empresa: agente(s) sem uso definido (pessoa ou setor): $sem. Rode: dgclaw agente uso <slug> pessoa|setor"
    else s_ok "credencial da empresa: todo agente tem dono (pessoa) ou setor"; fi
}

# dgclaw agente uso <slug> pessoa|setor [--usuario <login>]: define o uso de um agente que ja existe.
ent_cmd_agente_uso() {
    local slug="${1:-}" uso="${2:-}" usuario=""
    if [ "$#" -ge 2 ]; then shift 2; else shift "$#"; fi
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --usuario) [ "$#" -ge 2 ] || falha "a opcao --usuario precisa de um valor." "use: dgclaw agente uso <slug> pessoa --usuario <login>"; usuario="$2"; shift 2 ;;
            *) falha "a opcao '$1' nao existe." "use: dgclaw agente uso <slug> pessoa|setor [--usuario <login>]" ;;
        esac
    done
    exigir_slug "$slug" uso
    exigir_ferramentas jq
    case "$uso" in pessoa|setor) ;; *) falha "faltou dizer o uso (ou '$uso' nao existe)." "use: dgclaw agente uso $slug pessoa --usuario <login>   ou   dgclaw agente uso $slug setor" ;; esac
    [ -n "$(agentes_obter "$slug")" ] || falha "nao conheco o agente '$slug'." "veja os que existem com: dgclaw agente listar"
    if [ "$uso" = pessoa ] && protecao_ligada multiusuario; then
        [ -n "$usuario" ] || falha "agente de pessoa precisa de --usuario <login>." "veja os logins com: dgclaw usuario listar"
        _usr_exigir_existe "$usuario"
    fi
    C_USO="$uso"; C_USUARIO="$usuario"
    ent_depois_de_criar_credencial "$slug"
}
