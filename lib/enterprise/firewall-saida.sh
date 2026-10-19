#!/usr/bin/env bash
# lib/enterprise/firewall-saida.sh: a cerca da saida controlada (protecao `saida`, bloco H).
#
# Dois jeitos de usar, como o firewall6.sh:
#   - executado (bash firewall-saida.sh): e o que lib/firewall.sh faz no fim, na unidade dgclaw-firewall, a cada
#     agente que nasce e quando o modo muda (dgclaw saida modo, dgclaw protecoes aplicar).
#   - carregado com source (bin/dgclaw): so define funcoes.
#
# O que ele monta, numa cadeia propria chamada DGCLAW-SAIDA em duas tabelas:
#   filter, ligada ao INPUT na posicao 1: deixa o agente falar com o PROXY dele, e so com ele
#       (-s 10.89.N.0/24 -d 10.89.N.1 -p tcp --dport 3128 -j ACCEPT), antes de a cadeia DGCLAW_HOST derrubar tudo o que
#       vai para a propria maquina. Vale nos modos registro e bloqueio.
#   mangle, ligada ao FORWARD na posicao 2: no modo bloqueio, derruba toda saida do agente que passaria pela
#       maquina (a internet inteira). Sem o proxy ele nao fala com ninguem.
#
# Ordem (armadilha 4 do DESENHO): o salto da mangle fica DEPOIS do salto DGCLAW_EGRESS, que continua na posicao 1,
# do jeito que lib/firewall.sh o deixa. Nenhuma regra de DGCLAW_EGRESS, DGCLAW_HOST nem a ordem delas muda. A mangle
# e a camada que decide, porque o netavark reescreve a ordem da tabela filter a cada container que sobe.
# O salto do INPUT fica na posicao 1, na frente do DGCLAW_HOST; quando lib/firewall.sh roda de novo ele recoloca o
# DGCLAW_HOST na frente, e este script (que roda logo depois, no fim do firewall.sh) devolve o nosso ao topo.
#
# Sem /etc/dgclaw/protecoes.json (nivel pessoal) nao faz nada e sai com 0, sem tocar no iptables. Com o arquivo e a
# saida em `livre`, so desfaz o que tiver sobrado de um nivel mais alto.

_FWS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FWS_CADEIA=DGCLAW-SAIDA
FWS_REDE=10.89.0.0/16
FWS_PORTA=3128

# fws_posicoes <tabela> <origem>: numero (1 = topo) de cada regra que e o nosso salto, um por linha.
fws_posicoes() {
    iptables -w -t "$1" -S "$2" | grep '^-A ' \
        | awk -v alvo="-A $2 -s $FWS_REDE -j $FWS_CADEIA" '$0 == alvo { print NR }' || true
}

# fws_salto_garantir <tabela> <origem> <posicao>: deixa o salto UMA vez so, na posicao pedida.
fws_salto_garantir() {
    local tabela="$1" origem="$2" pos="$3" posicoes n
    posicoes="$(fws_posicoes "$tabela" "$origem")"
    if [ "$(printf '%s\n' "$posicoes" | head -n 1)" != "$pos" ]; then
        iptables -w -t "$tabela" -I "$origem" "$pos" -s "$FWS_REDE" -j "$FWS_CADEIA"
        posicoes="$(fws_posicoes "$tabela" "$origem")"
    fi
    # Copias a mais saem de baixo para cima, para o numero das de cima nao mudar.
    for n in $(printf '%s\n' "$posicoes" | awk -v p="$pos" '$1 != p' | sort -rn); do
        iptables -w -t "$tabela" -D "$origem" "$n"
    done
}

fws_cadeia_existe() { iptables -w -t "$1" -L "$FWS_CADEIA" -n >/dev/null 2>&1; }

# fws_cadeia_zerar <tabela>: cria a cadeia ou esvazia a que ja existe.
fws_cadeia_zerar() {
    if fws_cadeia_existe "$1"; then iptables -w -t "$1" -F "$FWS_CADEIA"; else iptables -w -t "$1" -N "$FWS_CADEIA"; fi
}

# fws_desfazer <tabela> <origem>: tira o salto e a cadeia, se existirem. Nao cria nada.
fws_desfazer() {
    local tabela="$1" origem="$2" n
    fws_cadeia_existe "$tabela" || return 0
    for n in $(fws_posicoes "$tabela" "$origem" | sort -rn); do
        iptables -w -t "$tabela" -D "$origem" "$n"
    done
    iptables -w -t "$tabela" -F "$FWS_CADEIA"
    iptables -w -t "$tabela" -X "$FWS_CADEIA"
}

fws_aplicar() {
    local slug n modo n_proxy=0 n_bloq=0 primeira
    command -v iptables >/dev/null 2>&1 || falha "o comando iptables nao existe nesta maquina." \
        "instale com: apt-get install -y iptables   e rode de novo: bash $_FWS_DIR/firewall-saida.sh"

    if [ "$(protecao_valor saida)" = livre ]; then
        fws_desfazer filter INPUT
        fws_desfazer mangle FORWARD
        return 0
    fi

    # A mangle so recebe o salto se a cerca base ja estiver la: e ela que ocupa a posicao 1.
    primeira="$(iptables -w -t mangle -S FORWARD | grep '^-A ' | head -n 1 || true)"
    if [ "$primeira" != "-A FORWARD -s $FWS_REDE -j DGCLAW_EGRESS" ]; then
        falha "a cerca base dos agentes (DGCLAW_EGRESS na tabela mangle) nao esta aplicada, e a saida controlada vai depois dela." \
            "rode: systemctl restart dgclaw-firewall   (ou: bash ${APP_DIR:-/opt/dgclaw/app}/lib/firewall.sh) e repita."
    fi

    fws_cadeia_zerar filter
    fws_cadeia_zerar mangle
    while read -r slug n; do
        [ -n "$slug" ] || continue
        modo="$(saida_modo_agente "$slug")" || return 1
        case "$modo" in
            registro|bloqueio)
                iptables -w -t filter -A "$FWS_CADEIA" -s "10.89.$n.0/24" -d "10.89.$n.1/32" -p tcp --dport "$FWS_PORTA" -j ACCEPT
                n_proxy=$((n_proxy + 1)) ;;
        esac
        if [ "$modo" = bloqueio ]; then
            iptables -w -t mangle -A "$FWS_CADEIA" -s "10.89.$n.0/24" -j DROP
            n_bloq=$((n_bloq + 1))
        fi
    done < <(saida_agentes)
    iptables -w -t filter -A "$FWS_CADEIA" -j RETURN
    iptables -w -t mangle -A "$FWS_CADEIA" -j RETURN
    fws_salto_garantir filter INPUT 1
    fws_salto_garantir mangle FORWARD 2
    echo "cerca da saida controlada aplicada ($n_proxy agente(s) com proxy, $n_bloq em bloqueio)"
}

fws_main() {
    local raiz
    raiz="$(cd "$_FWS_DIR/../.." && pwd)"
    APP_DIR="${APP_DIR:-$raiz}"
    # shellcheck source=lib/comum.sh
    . "$raiz/lib/comum.sh"
    # Sem a escolha gravada o nivel e pessoal: nada a fazer, e nem precisa do jq nem da matriz.
    [ -s "$DG_ETC/protecoes.json" ] || exit 0
    # shellcheck source=lib/protecoes.sh
    . "$raiz/lib/protecoes.sh"
    # shellcheck source=lib/enterprise/saida.sh
    . "$_FWS_DIR/saida.sh"
    fws_aplicar
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -euo pipefail
    fws_main "$@"
fi
