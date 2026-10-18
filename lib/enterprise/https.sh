#!/usr/bin/env bash
# lib/enterprise/https.sh: HTTPS endurecido no Caddy (protecao `https_endurecido`).
#
# O gerador do Caddyfile (bloco_caddy, em lib/comum.sh) chama ent_caddy_extra para pedir linhas extras
# dentro do bloco do site. No nivel pessoal a funcao nao imprime nada e o Caddyfile sai igual ao de sempre.
# Os cabecalhos do lado do Web (CSP, cookie `__Host-`) estao em web/lib/ent/seguranca-web.js.
# Detalhes e o que fica de fora: docs/enterprise/TRAVAS.md, secao "HTTPS endurecido".
#
# Os cabecalhos com `?` na frente so valem quando o Web nao mandou o proprio (a pagina de visual do chat manda
# `Referrer-Policy: no-referrer` e a gente nao quer enfraquecer isso). O HSTS e a retirada do `Server` valem sempre.

_HTTPS_MARCA="# DG Claw: cabecalhos de HTTPS endurecido (protecao https_endurecido)"

# Imprime as linhas que entram no bloco do site (com tabulacao). Vazio quando a protecao esta desligada.
ent_caddy_extra() {
    protecao_ligada https_endurecido || return 0
    printf '\t%s\n' "$_HTTPS_MARCA"
    printf '\theader {\n'
    printf '\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"\n'
    printf '\t\t?X-Content-Type-Options "nosniff"\n'
    printf '\t\t?Referrer-Policy "same-origin"\n'
    printf '\t\t?Permissions-Policy "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()"\n'
    printf '\t\t-Server\n'
    printf '\t}\n'
}

# Arquivo do Caddy que o DG Claw escreveu (o Caddyfile dele ou o conf.d), ou vazio se nenhum dos dois existe.
_https_arquivo_caddy() {
    local cf="$R/etc/caddy/Caddyfile" confd="$R/etc/caddy/conf.d/dgclaw.caddy"
    if [ -f "$confd" ]; then printf '%s' "$confd"; return 0; fi
    if [ -f "$cf" ] && grep -q '^# DG Claw' "$cf"; then printf '%s' "$cf"; fi
}

# Reescreve o site do DG Claw no Caddy com (ou sem) os cabecalhos, valida e recarrega. Se o Caddy recusar,
# devolve o arquivo ao que era: o Caddy em producao nunca fica com configuracao quebrada.
_https_reescrever() {
    local dominio="${DOMINIO:-${DGCLAW_DOMINIO:-}}" cf="$R/etc/caddy/Caddyfile" confd="$R/etc/caddy/conf.d/dgclaw.caddy"
    local bk_cf="" bk_confd="" tem_cf=0 tem_confd=0 log
    if [ -z "$dominio" ]; then
        falha "nao sei qual e o dominio do painel, entao nao consegui reescrever o Caddy com os cabecalhos de HTTPS." \
            "confira DGCLAW_DOMINIO em $DG_ETC/dgclaw.env (ou rode: dgclaw dominio trocar <dominio>) e depois: dgclaw protecoes aplicar"
    fi
    if [ -f "$cf" ]; then tem_cf=1; bk_cf="$(cat "$cf")"; fi
    if [ -f "$confd" ]; then tem_confd=1; bk_confd="$(cat "$confd")"; fi
    escrever_site_caddy "$dominio"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] validaria e recarregaria o Caddy"; return 0; fi
    log="$(mktemp)"
    if ! caddy validate --config "$cf" --adapter caddyfile >"$log" 2>&1; then
        if [ "$tem_cf" = 1 ]; then printf '%s\n' "$bk_cf" >"$cf"; fi
        if [ "$tem_confd" = 1 ]; then printf '%s\n' "$bk_confd" >"$confd"; else rm -f "$confd"; fi
        local motivo
        motivo="$(tail -n 3 "$log" | tr '\n' ' ')"
        rm -f "$log"
        falha "o Caddy recusou a configuracao com os cabecalhos de HTTPS (caddy validate: $motivo). Voltei o arquivo ao que era; nada mudou." \
            "veja o erro completo com: caddy validate --config $cf --adapter caddyfile. Se persistir, desligue com: dgclaw nivel ajustar https_endurecido false (so se o nivel permitir)."
    fi
    rm -f "$log"
    if systemctl is-active --quiet caddy; then executar systemctl reload caddy; fi
    ok "Caddy reescrito e recarregado (cabecalhos de HTTPS do nivel $(protecao_nivel))"
}

ent_instalar_https() {
    protecao_ligada https_endurecido || return 0
    ent_exigir caddy
    _https_reescrever
}

# So reescreve quando o Caddyfile esta diferente do que a protecao pede (ligada sem cabecalhos, ou desligada com eles).
ent_aplicar_https() {
    local arq tem=0
    command -v caddy >/dev/null 2>&1 || { protecao_ligada https_endurecido && ent_exigir caddy; return 0; }
    arq="$(_https_arquivo_caddy)"
    [ -n "$arq" ] || { protecao_ligada https_endurecido && aviso "o Caddy nao tem um site escrito pelo DG Claw (so ele pode receber os cabecalhos). Se voce mantem o Caddyfile na mao, acrescente no bloco do site as linhas de: dgclaw https cabecalhos"; return 0; }
    if grep -qF "$_HTTPS_MARCA" "$arq"; then tem=1; fi
    if protecao_ligada https_endurecido; then
        if [ "$tem" = 1 ]; then ok "Caddy ja esta com os cabecalhos de HTTPS"; return 0; fi
    else
        if [ "$tem" = 0 ]; then return 0; fi
    fi
    carregar_env_dgclaw
    _https_reescrever
}

ent_status_https() {
    local arq
    protecao_ligada https_endurecido || return 0
    arq="$(_https_arquivo_caddy)"
    if [ -z "$arq" ]; then s_aviso "HTTPS endurecido ligado, mas o Caddyfile nao e do DG Claw: confira os cabecalhos na mao (dgclaw https cabecalhos)"; return 0; fi
    if grep -qF "$_HTTPS_MARCA" "$arq"; then s_ok "HTTPS endurecido: HSTS e cabecalhos no Caddy"
    else s_aviso "HTTPS endurecido ligado, mas o Caddy ainda esta sem os cabecalhos. Rode: dgclaw protecoes aplicar"; fi
}

# dgclaw https cabecalhos: imprime as linhas, para quem mantem o Caddyfile na mao.
ent_cmd_https() {
    case "${1:-}" in
        cabecalhos) ent_caddy_extra | sed 's/^\t//'; protecao_ligada https_endurecido || info "(a protecao https_endurecido esta desligada neste nivel; nada a acrescentar)" ;;
        *) falha "o subcomando 'https ${1:-}' nao existe." "use: dgclaw https cabecalhos" ;;
    esac
}
