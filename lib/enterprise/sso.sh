#!/usr/bin/env bash
# lib/enterprise/sso.sh: `dgclaw sso ...` (bloco G, login unico por OIDC).
#
#   dgclaw sso configurar --provedor google|microsoft|oidc --client-id <id> [--emissor <url>] [--tenant <guid>]
#                         [--dominios a.com,b.com] [--nome "<texto do botao>"] [--redirect-uri <url>]
#                         [--segredo-stdin | --segredo-arquivo <arq> | --manter-segredo]
#   dgclaw sso testar                    busca a descoberta e o JWKS do provedor
#   dgclaw sso emergencia <usuario>      marca a conta de emergencia do TI (--remover para tirar)
#   dgclaw sso status
#
# Quem faz o trabalho e web/bin/sso.js (o mesmo codigo do Web). O segredo do aplicativo nunca vai por argumento:
# sem --segredo-* e com terminal, este arquivo o pede (sem eco) e o entrega ao node pelo stdin.
# O nivel decide o modo (matriz, chave `sso`): dgclaw nivel ajustar sso opcional|padrao|obrigatorio.
# Precisa de lib/comum.sh, lib/protecoes.sh e lib/enterprise/ferramentas.sh.

# _sso_node <argumentos...>: roda web/bin/sso.js com o ambiente do servidor; o stdin passa direto.
_sso_node() {
    local js="$DG_APP/web/bin/sso.js"
    ent_exigir node
    [ -f "$js" ] || falha "nao achei o programa do login unico em $js." \
        "atualize o DG Claw (rode de novo o instalador: sudo ./install.sh --usuario <nome>) e tente outra vez."
    DGCLAW_WEB_ENV="$DG_ETC/web.env" DGCLAW_PROTECOES="$DG_ETC/protecoes.json" DGCLAW_AUDITORIA="$DG_LOG/auditoria.jsonl" \
        DGCLAW_WEB_DATA="$DG_LIB/web" DGCLAW_QUEM="${DGCLAW_QUEM:-${SUDO_USER:-${USER:-desconhecido}}}" node "$js" "$@"
}

_sso_configurar() {
    local args=("$@") tem_segredo=0 tem_provedor=0 tem_cliente=0 a seg="" v rc=0
    for a in "${args[@]}"; do
        case "$a" in
            --segredo-stdin|--segredo-arquivo|--manter-segredo) tem_segredo=1 ;;
            --provedor) tem_provedor=1 ;;
            --client-id) tem_cliente=1 ;;
            *) ;;
        esac
    done
    if [ -t 0 ]; then
        if [ "$tem_provedor" = 0 ]; then
            printf 'Provedor (google, microsoft ou oidc): ' >&2; read -r v || v=""
            args+=(--provedor "$v")
        fi
        if [ "$tem_cliente" = 0 ]; then
            printf 'Client ID do aplicativo registrado no provedor: ' >&2; read -r v || v=""
            args+=(--client-id "$v")
        fi
    fi
    if [ -z "${DGCLAW_DOMINIO:-}" ] && [ -r "$DG_ETC/dgclaw.env" ]; then
        DGCLAW_DOMINIO="$(sed -n 's/^DGCLAW_DOMINIO=//p' "$DG_ETC/dgclaw.env" | tail -n 1)"
    fi
    if [ -n "${DGCLAW_DOMINIO:-}" ]; then args+=(--dominio "$DGCLAW_DOMINIO"); fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] rodaria: node $DG_APP/web/bin/sso.js configurar (${#args[@]} argumentos; o segredo, quando houver, vai pelo stdin)"
        return 0
    fi
    if [ "$tem_segredo" = 1 ]; then _sso_node configurar "${args[@]}" || rc=$?; return "$rc"; fi
    if [ ! -t 0 ]; then
        falha "faltou o segredo do aplicativo e o stdin nao e um terminal." \
            "mande o segredo por stdin ou arquivo: printf %s \"\$SEGREDO\" | dgclaw sso configurar ... --segredo-stdin  (ou --segredo-arquivo <arq>; ou --manter-segredo para reaproveitar o atual)."
    fi
    printf 'Segredo do aplicativo (client secret; nao aparece na tela): ' >&2
    read -rs seg || seg=""
    printf '\n' >&2
    printf '%s' "$seg" | _sso_node configurar "${args[@]}" --segredo-stdin || rc=$?
    return "$rc"
}

ent_cmd_sso() {
    local sub="${1:-}" rc=0
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        configurar|testar|emergencia|status) ;;
        "") falha "faltou o subcomando de 'sso'." "use: dgclaw sso configurar | testar | emergencia <usuario> | status" ;;
        *) falha "o subcomando 'sso $sub' nao existe." "use: dgclaw sso configurar | testar | emergencia <usuario> | status" ;;
    esac
    if [ "$sub" = configurar ]; then _sso_configurar "$@"; return $?; fi
    if [ "$ENSAIO" = 1 ] && [ "$sub" != status ]; then info "[ensaio] rodaria: dgclaw sso $sub $*"; return 0; fi
    _sso_node "$sub" "$@" || rc=$?
    return "$rc"
}

# Linhas do `dgclaw status`: modo, configuracao e o uso recente da conta de emergencia.
ent_status_sso() {
    local json modo a
    protecao_ligada multiusuario || return 0
    modo="$(protecao_valor sso)" || return 0
    [ "$modo" != nao ] || return 0
    if ! command -v node >/dev/null 2>&1 || [ ! -f "$DG_APP/web/bin/sso.js" ]; then
        s_aviso "login unico: nao consegui conferir (falta o node ou o web/bin/sso.js)."; return 0
    fi
    json="$(_sso_node status --json 2>/dev/null)" || { s_aviso "login unico: o 'dgclaw sso status' falhou; rode-o para ver o motivo."; return 0; }
    if [ "$(jq -r '.configurado' <<<"$json")" = true ]; then s_ok "login unico ($modo): $(jq -r '.provedor' <<<"$json")"
    else s_aviso "login unico em modo $modo, mas sem configuracao. Rode: dgclaw sso configurar"; fi
    while IFS= read -r a; do [ -z "$a" ] || s_aviso "login unico: $a"; done < <(jq -r '.avisos[]' <<<"$json")
}
