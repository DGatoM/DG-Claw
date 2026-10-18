#!/usr/bin/env bash
# lib/enterprise/auditoria-cli.sh: `dgclaw auditoria ...` (bloco G, auditoria completa e externa).
#
#   dgclaw auditoria verificar [--json]       confere a corrente inteira e diz em que linha ela quebrou
#   dgclaw auditoria selo                     o hash da ultima linha (o que o selo por hora leva)
#   dgclaw auditoria exportar [--de AAAA-MM-DD] [--ate AAAA-MM-DD] [--formato jsonl|csv] [--evento X] [--quem Y]
#                             [--origem O] [--q texto] [--saida <arquivo>]
#   dgclaw auditoria externa configurar|testar|status|enviar
#   dgclaw auditoria retencao mostrar|definir <dias>|aplicar [--confirmar]
#
# Quem faz o trabalho e web/bin/auditoria.js (o mesmo codigo do Web). A trava e a corrente sao as de
# lib/enterprise/auditoria.sh e web/lib/auditoria.js. O token do coletor externo vai por stdin ou arquivo, nunca por argumento.
# Este arquivo tambem tem a verificacao do monitor (fila externa parada) e as linhas do `dgclaw status`.
# Precisa de lib/comum.sh, lib/protecoes.sh e lib/enterprise/ferramentas.sh.

_audcli_node() {
    local js="$DG_APP/web/bin/auditoria.js"
    ent_exigir node
    [ -f "$js" ] || falha "nao achei o programa da auditoria em $js." \
        "atualize o DG Claw (rode de novo o instalador: sudo ./install.sh --usuario <nome>) e tente outra vez."
    DGCLAW_WEB_ENV="$DG_ETC/web.env" DGCLAW_PROTECOES="$DG_ETC/protecoes.json" DGCLAW_AUDITORIA="$DG_LOG/auditoria.jsonl" \
        DGCLAW_WEB_DATA="$DG_LIB/web" DGCLAW_QUEM="${DGCLAW_QUEM:-${SUDO_USER:-${USER:-desconhecido}}}" node "$js" "$@"
}

ent_cmd_auditoria() {
    local sub="${1:-}" rc=0
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        verificar|selo|exportar|externa|retencao) ;;
        "") falha "faltou o subcomando de 'auditoria'." "use: dgclaw auditoria verificar | selo | exportar | externa | retencao" ;;
        *) falha "o subcomando 'auditoria $sub' nao existe." "use: dgclaw auditoria verificar | selo | exportar | externa | retencao" ;;
    esac
    if [ "$ENSAIO" = 1 ]; then
        case "$sub" in
            verificar|selo) ;;
            *) info "[ensaio] rodaria: dgclaw auditoria $sub $* (o ensaio so confere; nada seria gravado nem enviado)"; return 0 ;;
        esac
    fi
    _audcli_node "$sub" "$@" || rc=$?
    return "$rc"
}

# Linhas do `dgclaw status`: a corrente e, no nivel externa, a fila de envio.
ent_status_auditoria_completa() {
    local nivel json ext
    nivel="$(protecao_valor auditoria)" || return 0
    case "$nivel" in completa|externa) ;; *) return 0 ;; esac
    if ! command -v node >/dev/null 2>&1 || [ ! -f "$DG_APP/web/bin/auditoria.js" ]; then
        s_aviso "auditoria $nivel: nao consegui conferir (falta o node ou o web/bin/auditoria.js)."; return 0
    fi
    if json="$(_audcli_node verificar --json 2>/dev/null)"; then
        s_ok "auditoria $nivel: corrente integra ($(jq -r '.linhas' <<<"$json") linhas em $(jq -r '.arquivos' <<<"$json") arquivo(s))"
    else
        s_mal "auditoria $nivel: a corrente esta QUEBRADA${json:+ (linha $(jq -r '.quebradaEm // "?"' <<<"$json"))}. Rode: dgclaw auditoria verificar"
    fi
    [ "$nivel" = externa ] || return 0
    ext="$(_audcli_node externa status --json 2>/dev/null)" || { s_aviso "auditoria externa: nao consegui ler o estado do envio. Rode: dgclaw auditoria externa status"; return 0; }
    if [ "$(jq -r '.configurado' <<<"$ext")" != true ]; then s_mal "auditoria externa: sem destino configurado. Rode: dgclaw auditoria externa configurar"
    elif [ "$(jq -r '.alerta' <<<"$ext")" = true ]; then s_mal "auditoria externa: fila parada ha mais de 1 hora ou corrente alterada. Rode: dgclaw auditoria externa status"
    else s_ok "auditoria externa: em dia ($(jq -r '.destino' <<<"$ext"))"; fi
}

# Verificacao do monitor (lib/enterprise/monitor.sh chama esta funcao se ela existir).
_mon_checar_auditoria_externa() {
    local estado cfg desde idade_s
    [ "$(protecao_valor auditoria)" = externa ] || return 0
    cfg="$DG_ETC/auditoria-externa.json"
    if [ ! -r "$cfg" ]; then
        _mon_problema auditoria-externa "A auditoria esta no nivel externa, mas falta o destino ($cfg), entao a trilha so existe nesta VPS." \
            "Configure com: dgclaw auditoria externa configurar"
        return 0
    fi
    estado="$DG_LIB/web/auditoria-externa-estado.json"
    [ -r "$estado" ] || return 0
    if [ "$(jq -r '.corrente_alterada // false' "$estado")" = true ]; then
        _mon_problema auditoria-externa-alterada "A trilha local mudou atras do ponto que ja tinha sido entregue ao destino externo (possivel adulteracao)." \
            "Guarde uma copia de ${DG_LOG#"$R"} e rode: dgclaw auditoria verificar"
        return 0
    fi
    desde="$(jq -r '.pendentes_desde // empty' "$estado")"
    [ -n "$desde" ] || return 0
    idade_s=$(( $(date +%s) - $(date -d "$desde" +%s 2>/dev/null || date +%s) ))
    if [ "$idade_s" -gt 3600 ]; then
        _mon_problema auditoria-externa "A fila da auditoria externa esta parada ha $((idade_s / 60)) minutos: $(jq -r '.ultimo_erro // "sem mensagem de erro"' "$estado")" \
            "Confira o destino com: dgclaw auditoria externa testar. O que ficou pendente sai sozinho quando o destino voltar."
    fi
}
