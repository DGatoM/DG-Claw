#!/usr/bin/env bash
# lib/colaborador.sh: o comando `dgclaw colaborador` (convidar e gerenciar quem conversa com UM agente).
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Usa as funcoes dele e da lib/comum.sh
# (falha, info, aviso, exigir_ferramentas, carregar_env_dgclaw...).
# shellcheck disable=SC2154
#
#   dgclaw colaborador criar <agente> <email> [--nome X] [--json]
#   dgclaw colaborador listar [agente] [--json]
#   dgclaw colaborador reenviar <id-ou-email> [--json]
#   dgclaw colaborador revogar <id-ou-email> [--json]
#
# Quem faz o trabalho e o DG Claw Web (a regra do convite, a senha temporaria, o e-mail e a lista ficam la). Este comando
# fala com ele por um socket Unix local, <pasta de dados do Web>/admin.sock, que so o root abre: nao passa por senha do
# painel nem pela internet. O corpo do pedido e montado pelo jq e vai ao curl pelo stdin, e a resposta nunca passa por
# arquivo, porque ela traz a senha temporaria. Referencia: web/docs/COLABORADORES.md.

colaborador_ajuda() {
    cat <<'FIM'
dgclaw colaborador: convida alguem para conversar com UM agente de trabalho (nunca com o Admin).

  dgclaw colaborador criar <agente> <email> [--nome "<Nome>"] [--json]
      Cria o acesso. O e-mail e o login da pessoa. Mostra o texto do convite pronto para copiar (endereco, login e
      senha temporaria, que vale 7 dias e a pessoa troca no primeiro acesso). Se o servidor tiver e-mail configurado,
      o convite tambem sai por e-mail.
      Exemplo:  sudo dgclaw colaborador criar ana maria@empresa.com --nome "Maria"
  dgclaw colaborador listar [<agente>] [--json]
      Mostra os colaboradores (e se ja entraram, se a senha temporaria venceu ou se foram revogados).
  dgclaw colaborador reenviar <id-ou-email> [--json]
      Gera uma senha temporaria nova e derruba as sessoes da pessoa. Mostra o convite de novo.
  dgclaw colaborador revogar <id-ou-email> [--json]
      Tira o acesso e derruba as sessoes. A conta de IA que a pessoa tenha conectado no agente continua la.
FIM
}

# colab_socket: o caminho do socket do Web. A pasta de dados e a do servico (DGCLAW_WEB_DATA do web.env, se houver).
colab_socket() {
    local dir=""
    if [ -f "$DG_ETC/web.env" ]; then
        dir="$(sed -n "s/^DGCLAW_WEB_DATA=//p;T;q" "$DG_ETC/web.env" | tr -d "'\"")"
    fi
    printf '%s/admin.sock' "${dir:-$DG_LIB/web}"
}

# colab_chamar <METODO> <caminho> [corpo-json]: define COLAB_STATUS e COLAB_CORPO. Falha se o Web nao responde.
colab_chamar() {
    local metodo="$1" caminho="$2" corpo="${3:-}" sock resp rc=0
    sock="$(colab_socket)"
    if [ -n "$corpo" ]; then
        resp="$(printf '%s' "$corpo" | curl -sS --max-time 40 --unix-socket "$sock" -X "$metodo" \
            -H 'Content-Type: application/json' --data-binary @- -w $'\n%{http_code}' "http://dgclaw$caminho" 2>&1)" || rc=$?
    else
        resp="$(curl -sS --max-time 40 --unix-socket "$sock" -X "$metodo" -w $'\n%{http_code}' "http://dgclaw$caminho" 2>&1)" || rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
        falha "nao consegui falar com o DG Claw Web pelo socket $sock (curl saiu com $rc: $(printf '%s' "$resp" | head -c 200 | tr '\n' ' '))." \
            "veja se o Web esta de pe: systemctl status dgclaw-web. Se ele acabou de ser atualizado, reinicie-o: sudo systemctl restart dgclaw-web (o socket nasce no inicio)."
    fi
    COLAB_STATUS="${resp##*$'\n'}"
    COLAB_CORPO="${resp%$'\n'*}"
}

# colab_erro <o que estava fazendo>: sai com a falha no padrao "o que houve / o que fazer", usando o `erro` da API.
colab_erro() {
    local motivo
    motivo="$(printf '%s' "$COLAB_CORPO" | jq -r '.erro // empty' 2>/dev/null || true)"
    [ -n "$motivo" ] || motivo="o Web respondeu algo que nao entendi: $(printf '%s' "$COLAB_CORPO" | head -c 200 | tr '\n' ' ')"
    case "$COLAB_STATUS" in
        404) falha "$1 (HTTP 404): $motivo" "confira o nome do agente ou o e-mail com: dgclaw colaborador listar" ;;
        409) falha "$1 (HTTP 409): $motivo" "veja quem ja tem acesso com: dgclaw colaborador listar" ;;
        5??) falha "$1 (HTTP $COLAB_STATUS): $motivo" "veja o log do Web: journalctl -u dgclaw-web -n 50" ;;
        *) falha "$1 (HTTP $COLAB_STATUS): $motivo" "corrija o que a mensagem aponta e rode de novo." ;;
    esac
}

# colab_resolve_id <id-ou-email>: imprime o id do colaborador ativo.
colab_resolve_id() {
    local alvo="$1" id
    if [[ "$alvo" =~ ^[A-Za-z0-9_-]{8,64}$ ]]; then printf '%s' "$alvo"; return 0; fi
    [[ "$alvo" == *@* ]] || falha "'$alvo' nao parece um id nem um e-mail." "use o e-mail da pessoa ou o id que aparece em: dgclaw colaborador listar"
    colab_chamar GET /api/v1/colaboradores
    [ "$COLAB_STATUS" = 200 ] || colab_erro "nao consegui listar os colaboradores"
    id="$(printf '%s' "$COLAB_CORPO" | jq -r --arg e "$(printf '%s' "$alvo" | tr '[:upper:]' '[:lower:]')" \
        '[.colaboradores[] | select(.email == $e and .estado != "revogado")][0].id // empty')"
    [ -n "$id" ] || falha "nao achei colaborador ativo com o e-mail $alvo." "veja a lista com: dgclaw colaborador listar"
    printf '%s' "$id"
}

# colab_mostrar_convite <json>: o texto do convite para copiar, mais o que o dono precisa saber.
colab_mostrar_convite() {
    local json="$1" texto aviso_web enviado motivo
    texto="$(printf '%s' "$json" | jq -r '.convite.texto // empty')"
    [ -n "$texto" ] || falha "o Web respondeu sem o texto do convite." "rode: dgclaw colaborador reenviar <e-mail> para gerar uma senha nova."
    printf '%s\n' "$texto"
    aviso_web="$(printf '%s' "$json" | jq -r '.convite.aviso // empty')"
    [ -z "$aviso_web" ] || aviso "$aviso_web"
    enviado="$(printf '%s' "$json" | jq -r '.convite.email_enviado')"
    if [ "$enviado" = true ]; then
        info "O convite tambem foi enviado por e-mail."
    else
        motivo="$(printf '%s' "$json" | jq -r '.convite.email_motivo // empty')"
        info "O e-mail nao saiu${motivo:+ ($motivo)}. Copie o texto acima e mande para a pessoa."
    fi
}

colaborador_criar() {
    local json=0 nome="" args=() agente email corpo base=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --json) json=1 ;;
            --nome) [ $# -ge 2 ] || falha "'--nome' precisa de um valor." "exemplo: --nome \"Maria\""; nome="$2"; shift ;;
            --*) falha "a opcao '$1' nao existe em 'colaborador criar'." "veja as opcoes com: dgclaw colaborador ajuda" ;;
            *) args+=("$1") ;;
        esac
        shift
    done
    [ "${#args[@]}" -eq 2 ] || falha "faltou o agente ou o e-mail (recebi ${#args[@]} argumento(s))." "use: dgclaw colaborador criar <agente> <email> [--nome \"Nome\"]"
    agente="${args[0]}"; email="${args[1]}"
    exigir_ferramentas jq curl
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] pediria ao Web para criar o acesso de $email ao agente $agente e mostraria o convite (nada foi criado)"
        return 0
    fi
    carregar_env_dgclaw
    [ -z "${DGCLAW_DOMINIO:-}" ] || base="https://$DGCLAW_DOMINIO"
    corpo="$(jq -n --arg agente "$agente" --arg email "$email" --arg nome "$nome" --arg base "$base" \
        '{agente: $agente, email: $email} + (if $nome != "" then {nome: $nome} else {} end) + (if $base != "" then {base: $base} else {} end)')"
    colab_chamar POST /api/v1/colaboradores "$corpo"
    [ "$COLAB_STATUS" = 201 ] || colab_erro "nao consegui criar o acesso de $email ao agente $agente"
    if [ "$json" = 1 ]; then printf '%s\n' "$COLAB_CORPO"; else colab_mostrar_convite "$COLAB_CORPO"; fi
}

colaborador_listar() {
    local json=0 agente="" a
    for a in "$@"; do
        case "$a" in
            --json) json=1 ;;
            --*) falha "a opcao '$a' nao existe em 'colaborador listar'." "veja as opcoes com: dgclaw colaborador ajuda" ;;
            *) [ -z "$agente" ] || falha "so da para filtrar por um agente (recebi '$agente' e '$a')." "use: dgclaw colaborador listar [agente]"; agente="$a" ;;
        esac
    done
    exigir_ferramentas jq curl
    local caminho=/api/v1/colaboradores
    if [ -n "$agente" ]; then caminho="$caminho?agente=$(jq -rn --arg v "$agente" '$v|@uri')"; fi
    colab_chamar GET "$caminho"
    [ "$COLAB_STATUS" = 200 ] || colab_erro "nao consegui listar os colaboradores"
    if [ "$json" = 1 ]; then printf '%s\n' "$COLAB_CORPO"; return 0; fi
    if [ "$(printf '%s' "$COLAB_CORPO" | jq '.colaboradores | length')" -eq 0 ]; then
        info "Nenhum colaborador${agente:+ no agente $agente}."
        return 0
    fi
    {
        printf 'ID\tAGENTE\tE-MAIL\tESTADO\tNOME\n'
        printf '%s' "$COLAB_CORPO" | jq -r '.colaboradores[] | [.id, .agente, .email, .estado, (.nome // "")] | @tsv'
    } | if command -v column >/dev/null 2>&1; then column -t -s $'\t'; else cat; fi
}

colaborador_reenviar() {
    local json=0 args=() a id corpo base=""
    for a in "$@"; do
        case "$a" in
            --json) json=1 ;;
            --*) falha "a opcao '$a' nao existe em 'colaborador reenviar'." "veja as opcoes com: dgclaw colaborador ajuda" ;;
            *) args+=("$a") ;;
        esac
    done
    [ "${#args[@]}" -eq 1 ] || falha "faltou o id ou o e-mail do colaborador." "use: dgclaw colaborador reenviar <id-ou-email>"
    exigir_ferramentas jq curl
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] pediria ao Web uma senha temporaria nova para ${args[0]}, derrubaria as sessoes dele e mostraria o convite (nada foi mudado)"
        return 0
    fi
    carregar_env_dgclaw
    [ -z "${DGCLAW_DOMINIO:-}" ] || base="https://$DGCLAW_DOMINIO"
    id="$(colab_resolve_id "${args[0]}")"
    corpo="$(jq -n --arg base "$base" 'if $base != "" then {base: $base} else {} end')"
    colab_chamar POST "/api/v1/colaboradores/$id/reenviar" "$corpo"
    [ "$COLAB_STATUS" = 200 ] || colab_erro "nao consegui reenviar o convite de ${args[0]}"
    if [ "$json" = 1 ]; then printf '%s\n' "$COLAB_CORPO"; else colab_mostrar_convite "$COLAB_CORPO"; fi
}

colaborador_revogar() {
    local json=0 args=() a id contas
    for a in "$@"; do
        case "$a" in
            --json) json=1 ;;
            --*) falha "a opcao '$a' nao existe em 'colaborador revogar'." "veja as opcoes com: dgclaw colaborador ajuda" ;;
            *) args+=("$a") ;;
        esac
    done
    [ "${#args[@]}" -eq 1 ] || falha "faltou o id ou o e-mail do colaborador." "use: dgclaw colaborador revogar <id-ou-email>"
    exigir_ferramentas jq curl
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] pediria ao Web para revogar o acesso de ${args[0]} e derrubar as sessoes dele (nada foi mudado)"
        return 0
    fi
    id="$(colab_resolve_id "${args[0]}")"
    colab_chamar DELETE "/api/v1/colaboradores/$id"
    [ "$COLAB_STATUS" = 200 ] || colab_erro "nao consegui revogar o acesso de ${args[0]}"
    if [ "$json" = 1 ]; then printf '%s\n' "$COLAB_CORPO"; return 0; fi
    ok "acesso de $(printf '%s' "$COLAB_CORPO" | jq -r '.colaborador.email') revogado; as sessoes dele foram derrubadas."
    printf '%s' "$COLAB_CORPO" | jq -r '(.avisos // [])[]' | while IFS= read -r linha; do aviso "$linha"; done
    contas="$(printf '%s' "$COLAB_CORPO" | jq -r '(.contas_de_ia // []) | join(", ")')"
    if [ -n "$contas" ]; then
        aviso "essa pessoa conectou (ou deixou em andamento) a conta de IA do agente $contas, e a conta continua conectada. Se quiser trocar, entre com a sua conta em Conectar conta no painel."
    fi
}

colaborador_main() {
    local sub="${1:-}"
    [ $# -eq 0 ] || shift
    case "$sub" in
        criar) colaborador_criar "$@" ;;
        listar) colaborador_listar "$@" ;;
        reenviar) colaborador_reenviar "$@" ;;
        revogar) colaborador_revogar "$@" ;;
        ""|ajuda) colaborador_ajuda ;;
        *) falha "'colaborador $sub' nao existe." "veja os comandos com: dgclaw colaborador ajuda" ;;
    esac
}
