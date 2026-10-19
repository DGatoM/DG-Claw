#!/usr/bin/env bash
# lib/enterprise/usuarios.sh: `dgclaw usuario ...` (bloco B, multiusuario). E o socorro de quem perdeu o
# acesso: mexe no mesmo arquivo do Web, $DG_LIB/web/usuarios.json (600), com jq e a MESMA trava
# (`mkdir <arquivo>.trava`, trava com mais de 30 s e de processo morto). O contrato do arquivo esta
# em web/lib/usuarios-arquivo.js.
#
#   dgclaw usuario listar
#   dgclaw usuario criar <usuario> --papel ti|funcionario [--agentes a,b] [--nome "..."] [--email ...]
#   dgclaw usuario desativar <usuario>
#   dgclaw usuario link <usuario>        gera o link de senha nova (uso unico, vale 24 h)
#   dgclaw usuario zerar-2fa <usuario>   para quem perdeu o celular
#
# So funciona com a protecao `multiusuario` ligada; no nivel pessoal o arquivo nem existe. Toda acao
# vai para a auditoria. Precisa de lib/comum.sh, lib/protecoes.sh e lib/enterprise/auditoria.sh.

_USR_LINK_MS=$((24 * 60 * 60 * 1000))

_usr_arquivo() { printf '%s/web/usuarios.json' "$DG_LIB"; }

_usr_exigir_ligado() {
    protecao_ligada multiusuario && return 0
    falha "o multiusuario esta desligado no nivel '$(protecao_nivel)', entao nao ha usuarios para gerenciar." \
        "use um nivel com multiusuario (dgclaw nivel definir escritorio) e rode o comando de novo."
}

# _usr_pegar_trava: espera ate 10 s; trava de processo morto (mais de 30 s) e removida com aviso.
_usr_pegar_trava() {
    local trava tentativas=0 idade
    trava="$(_usr_arquivo).trava"
    mkdir -p "$(dirname "$trava")"
    while ! mkdir "$trava" 2>/dev/null; do
        idade=$(( $(date +%s) - $(stat -c %Y "$trava" 2>/dev/null || date +%s) ))
        if [ "$idade" -gt 30 ]; then
            aviso "a trava ${trava#"$R"} tinha $idade s (mais de 30); o processo que a criou provavelmente morreu. Estou removendo e seguindo."
            rmdir "$trava" 2>/dev/null || true
            continue
        fi
        tentativas=$((tentativas + 1))
        if [ "$tentativas" -gt 100 ]; then
            falha "nao consegui a trava dos usuarios (${trava#"$R"}) em 10 s: outro processo a segura." \
                "espere e rode de novo. Se nada estiver rodando, apague a pasta ${trava#"$R"}."
        fi
        sleep 0.1
    done
}

_usr_soltar_trava() {
    rmdir "$(_usr_arquivo).trava" 2>/dev/null || aviso "nao consegui soltar a trava $(_usr_arquivo).trava (ja tinha sumido?)."
}

# _usr_semente: o JSON inicial, com o usuario do web.env como primeiro TI (mesmo hash). Sem web.env, lista vazia.
_usr_semente() {
    local web_env="$DG_ETC/web.env" usuario="" hash=""
    if [ -f "$web_env" ]; then
        usuario="$(sed -n 's/^DGCLAW_PANEL_USER=//p;T;q' "$web_env")"
        hash="$(sed -n 's/^DGCLAW_PANEL_PASSWORD_HASH=//p;T;q' "$web_env")"
        hash="${hash#\'}"; hash="${hash%\'}"
    fi
    jq -n --arg u "$usuario" --arg h "$hash" --argjson ts "$(agora_ms)" \
        '{versao: 1, usuarios: (if $u == "" then [] else [{usuario: $u, nome: $u, email: "", papel: "ti", agentes: [], hash: $h,
          totp: {segredo: "", ativo: false, ativado_em: null, codigos_reserva: [], ultimo_passo: null},
          origem: "web.env", criado_em: $ts, desativado_em: null, ultimo_login: null}] end)}'
}

# _usr_ler: imprime o JSON do arquivo (criando-o com a semente na primeira vez, sob trava).
_usr_ler() {
    local arq
    arq="$(_usr_arquivo)"
    if [ ! -e "$arq" ] && [ "$ENSAIO" != 1 ]; then
        _usr_pegar_trava
        if [ ! -e "$arq" ]; then _usr_semente | escrever_arquivo "$arq" 600; fi
        _usr_soltar_trava
    fi
    if [ ! -e "$arq" ]; then _usr_semente; return 0; fi
    if ! jq -e '.usuarios | type == "array"' "$arq" >/dev/null 2>&1; then
        falha "${arq#"$R"} nao e um JSON valido com a lista \"usuarios\"." \
            "restaure a ultima copia boa do arquivo (veja o backup) ou corrija-o a mao; nao apague sem copia, e nele que estao as senhas e o 2FA de todos."
    fi
    cat "$arq"
}

# _usr_mudar <jq-filtro> [args do jq...]: aplica o filtro ao arquivo inteiro, sob trava, e grava.
# O filtro pode chamar `error("motivo")`; o motivo vira a mensagem de falha.
_usr_mudar() {
    local filtro="$1" arq novo rc=0
    shift
    arq="$(_usr_arquivo)"
    _usr_ler >/dev/null
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] mudaria ${arq#"$R"}"; return 0; fi
    _usr_pegar_trava
    novo="$(jq "$@" "$filtro" "$arq" 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then printf '%s\n' "$novo" | escrever_arquivo "$arq" 600 || rc=$?; fi
    _usr_soltar_trava
    if [ "$rc" -ne 0 ]; then
        falha "${novo#jq: error*: }" "confira o nome do usuario com: dgclaw usuario listar"
    fi
}

# _usr_existe <usuario>: sai com 0 se existe (sem diferenciar maiusculas).
_usr_existe() {
    _usr_ler | jq -e --arg u "$1" '.usuarios | any((.usuario | ascii_downcase) == ($u | ascii_downcase))' >/dev/null
}

_usr_exigir_existe() {
    _usr_existe "$1" || falha "nao existe o usuario '$1'." "veja os usuarios com: dgclaw usuario listar"
}

_usr_listar() {
    _usr_ler | jq -r '.usuarios[] | [.usuario, .papel, (if .desativado_em then "desativado" else "ativo" end),
        (if .totp.ativo then "2fa" else "sem 2fa" end), (if .papel == "ti" then "todos" else ((.agentes // []) | join(",") | if . == "" then "nenhum" else . end) end)] | @tsv' \
        | {
            printf '%-24s %-12s %-11s %-8s %s\n' USUARIO PAPEL SITUACAO 2FA AGENTES
            while IFS=$'\t' read -r u p s f a; do printf '%-24s %-12s %-11s %-8s %s\n' "$u" "$p" "$s" "$f" "$a"; done
        }
}

# _usr_novo_link <usuario>: troca o link de senha do usuario e imprime so o endereco (o token nunca vai para disco, so o sha256).
_usr_novo_link() {
    local usuario="$1" tk hash agora base
    tk="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
    hash="$(printf '%s' "$tk" | sha256sum | cut -d' ' -f1)"
    agora="$(agora_ms)"
    # shellcheck disable=SC2016 # codigo jq
    _usr_mudar '.usuarios |= map(if (.usuario | ascii_downcase) == ($u | ascii_downcase) then .link = {token_sha256: $h, criado: $c, expira: ($c + $l), usado_em: null} else . end)' \
        --arg u "$usuario" --arg h "$hash" --argjson c "$agora" --argjson l "$_USR_LINK_MS"
    carregar_env_dgclaw
    if [ -n "${DGCLAW_DOMINIO:-}" ]; then base="https://$DGCLAW_DOMINIO"; else base="http://127.0.0.1:8300"; fi
    printf '%s/primeiro-acesso#%s\n' "$base" "$tk"
}

_usr_criar() {
    local usuario="" papel="" agentes="" nome="" email="" validos faltam
    [ "$#" -ge 1 ] || falha "faltou o nome do usuario." "use: dgclaw usuario criar <usuario> --papel ti|funcionario [--agentes a,b]"
    usuario="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
    shift
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --papel|--agentes|--nome|--email)
                [ "$#" -ge 2 ] || falha "a opcao $1 precisa de um valor." "use: dgclaw usuario criar <usuario> --papel ti|funcionario [--agentes a,b] [--nome ...] [--email ...]"
                case "$1" in
                    --papel) papel="$2" ;;
                    --agentes) agentes="$2" ;;
                    --nome) nome="$2" ;;
                    --email) email="$2" ;;
                esac
                shift 2 ;;
            *) falha "a opcao '$1' nao existe." "use: dgclaw usuario criar <usuario> --papel ti|funcionario [--agentes a,b] [--nome ...] [--email ...]" ;;
        esac
    done
    [[ "$usuario" =~ ^[a-z0-9][a-z0-9._@-]{1,63}$ ]] || falha "o usuario '$usuario' nao vale." \
        "use de 2 a 64 caracteres, comecando por letra ou numero, so com letras minusculas, numeros, ponto, traco, sublinhado e @. Exemplo: ana.silva"
    case "$papel" in
        ti|funcionario) ;;
        *) falha "o papel '${papel:-}' nao existe." "use --papel ti ou --papel funcionario" ;;
    esac
    if [ -n "$agentes" ] && [ "$papel" = ti ]; then
        aviso "o papel ti ve todos os agentes; ignorei --agentes."
        agentes=""
    fi
    if [ -n "$agentes" ]; then
        [ -f "$DG_AGENTES_JSON" ] || falha "nao achei a lista de agentes em ${DG_AGENTES_JSON#"$R"}, entao nao consigo conferir --agentes." "crie os agentes antes (dgclaw agente criar) ou crie o usuario sem --agentes e libere depois pelo painel."
        validos="$(jq -r '.agentes[] | select((.tipo // (if .slug == "admin" then "admin" else "agente" end)) != "admin") | .slug' "$DG_AGENTES_JSON")"
        # o grep sai com 1 quando nao sobra nenhum agente inexistente, que e o caso bom
        faltam="$(tr ',' '\n' <<<"$agentes" | grep -vxF -f <(printf '%s\n' "$validos") || true)"
        if [ -n "$faltam" ]; then
            falha "nao existe agente de trabalho com o id: $(paste -sd' ' <<<"$faltam"). O Admin nao pode ser dado a um funcionario." \
                "agentes que existem: $(paste -sd' ' <<<"$validos" | sed 's/^$/(nenhum)/')"
        fi
    fi
    if _usr_existe "$usuario"; then
        falha "ja existe o usuario '$usuario'." "para mudar o que ele ve use o painel (Usuarios) ou apague o acesso com: dgclaw usuario desativar $usuario"
    fi
    # shellcheck disable=SC2016 # codigo jq
    _usr_mudar '.usuarios += [{usuario: $u, nome: (if $n == "" then $u else $n end), email: $e, papel: $p,
        agentes: ($a | split(",") | map(select(. != ""))), hash: "",
        totp: {segredo: "", ativo: false, ativado_em: null, codigos_reserva: [], ultimo_passo: null},
        origem: "cli", criado_em: $t, desativado_em: null, ultimo_login: null}]' \
        --arg u "$usuario" --arg n "$nome" --arg e "$email" --arg p "$papel" --arg a "$agentes" --argjson t "$(agora_ms)"
    ok "usuario '$usuario' criado ($papel)."
    auditar_aviso usuario_criado "$(jq -nc --arg u "$usuario" --arg p "$papel" --arg a "$agentes" '{usuario: $u, papel: $p, agentes: ($a | split(",") | map(select(. != ""))), via: "cli"}')"
    _usr_novo_link "$usuario"
    printf 'link de senha de uso unico, vale 24 h; mande a pessoa por um canal seguro. Ele nao aparece de novo.\n' >&2
}

_usr_desativar() {
    [ "$#" -eq 1 ] || falha "faltou o usuario (ou veio mais de um)." "use: dgclaw usuario desativar <usuario>"
    _usr_exigir_existe "$1"
    # shellcheck disable=SC2016 # codigo jq
    _usr_mudar '(.usuarios | map(select((.papel == "ti") and (.desativado_em == null))) | length) as $tis
        | .usuarios |= map(if (.usuario | ascii_downcase) == ($u | ascii_downcase) then
            (if .desativado_em != null then .
             elif (.papel == "ti" and $tis == 1) then error("\(.usuario) e o unico usuario TI ativo. Crie ou promova outro TI antes de desativar este (dgclaw usuario criar <usuario> --papel ti).")
             else .desativado_em = $t end) else . end)' \
        --arg u "$1" --argjson t "$(agora_ms)"
    ok "usuario '$1' desativado. As sessoes dele caem no proximo pedido ao painel."
    auditar_aviso usuario_desativado "$(jq -nc --arg u "$1" '{usuario: $u, via: "cli"}')"
}

_usr_link() {
    [ "$#" -eq 1 ] || falha "faltou o usuario (ou veio mais de um)." "use: dgclaw usuario link <usuario>"
    _usr_exigir_existe "$1"
    if _usr_ler | jq -e --arg u "$1" '.usuarios | any((.usuario | ascii_downcase) == ($u | ascii_downcase) and .desativado_em != null)' >/dev/null; then
        falha "o usuario '$1' esta desativado." "reative pelo painel (Usuarios) antes de gerar um link de senha."
    fi
    _usr_novo_link "$1"
    printf 'link de senha de uso unico, vale 24 h; o anterior deixou de valer.\n' >&2
    auditar_aviso usuario_alterado "$(jq -nc --arg u "$1" '{usuario: $u, acao: "link_de_senha", via: "cli"}')"
}

_usr_zerar_2fa() {
    [ "$#" -eq 1 ] || falha "faltou o usuario (ou veio mais de um)." "use: dgclaw usuario zerar-2fa <usuario>"
    _usr_exigir_existe "$1"
    # shellcheck disable=SC2016 # codigo jq
    _usr_mudar '.usuarios |= map(if (.usuario | ascii_downcase) == ($u | ascii_downcase) then .totp = {segredo: "", ativo: false, ativado_em: null, codigos_reserva: [], ultimo_passo: null} else . end)' --arg u "$1"
    ok "segundo fator de '$1' zerado. No proximo login a pessoa ativa de novo (se o nivel exige) e recebe codigos de reserva novos."
    auditar_aviso 2fa_desativado "$(jq -nc --arg u "$1" '{usuario: $u, motivo: "zerado pela CLI", via: "cli"}')"
}

ent_cmd_usuario() {
    local sub="${1:-}"
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        listar|criar|desativar|link|zerar-2fa) ;;
        "") falha "faltou o subcomando de 'usuario'." "use: dgclaw usuario listar | criar <usuario> --papel ti|funcionario [--agentes a,b] | desativar <usuario> | link <usuario> | zerar-2fa <usuario>" ;;
        *) falha "o subcomando 'usuario $sub' nao existe." "use: dgclaw usuario listar | criar | desativar | link | zerar-2fa" ;;
    esac
    _usr_exigir_ligado
    case "$sub" in
        listar) _usr_listar ;;
        criar) _usr_criar "$@" ;;
        desativar) _usr_desativar "$@" ;;
        link) _usr_link "$@" ;;
        zerar-2fa) _usr_zerar_2fa "$@" ;;
    esac
}
