#!/usr/bin/env bash
# lib/firewall.sh: a cerca de rede dos containers dos agentes.
#
# Roda no boot (dgclaw-firewall.service) e toda vez que um agente nasce. Sao tres
# camadas, e cada uma fecha um caminho diferente:
#
#   DGCLAW_HOST    (filter, INPUT) o agente falando com a PROPRIA MAQUINA que o
#                  hospeda. O gateway da rede dele (10.89.x.1) E o host: sem esta
#                  cadeia ele alcanca o sshd na 22 e o Caddy na 80, que servem tudo
#                  o que existe aqui.
#   DGCLAW_EGRESS  (filter, FORWARD) o agente falando com qualquer outra rede
#                  privada: a bridge padrao do podman, a tailnet, a rede da casa de
#                  alguem.
#   DGCLAW_EGRESS  (mangle, FORWARD) a MESMA cerca, repetida na tabela mangle. Existe
#                  porque o netavark (podman 4.9) reinsere `-j NETAVARK_FORWARD` na
#                  posicao 1 do FORWARD da filter toda vez que uma rede nasce ou um
#                  container sobe, e o NETAVARK_FORWARD tem um `-s <rede do agente>
#                  -j ACCEPT` por rede. Resultado medido na KVM de teste (17/10/2026):
#                  o salto da nossa cadeia ficava na posicao 2 e o 2o agente alcancava
#                  a caixa do 1o. Como o mangle FORWARD e percorrido ANTES do filter
#                  FORWARD, e o netavark nao usa o mangle, o DROP acontece la e a
#                  ordem que o netavark impoe na filter deixa de importar. A cerca da
#                  filter continua como segunda trava.
#
# Por que a camada do mangle e segura: o trafego do agente para o proprio host
# (gateway 10.89.x.1) passa pelo INPUT, nunca pelo FORWARD; e a internet nao e rede
# privada. Entao o DROP de redes privadas no FORWARD nao corta nada legitimo.
#
# O que continua passando e a internet. O agente precisa falar com a API do
# provedor e com o resto do mundo, e filtrar por dominio pediria um proxy, que e
# outra obra. O que importa aqui e o lado de dentro, e o lado de dentro fica fechado.
#
# Idempotente: rodar de novo recria as cadeias do zero e deixa exatamente UM salto
# por cadeia de origem, sempre na posicao 1. Se alguem (o netavark, por exemplo)
# empurrou o nosso salto para baixo, ele e reinserido no topo antes de os antigos
# serem apagados, para nunca haver um instante sem o salto.
set -euo pipefail

REDE_AGENTES=10.89.0.0/16

# cadeia_zerar <tabela> <nome>: cria a cadeia, ou esvazia se ja existe. Conferir antes
# com -L evita esconder erro de verdade (iptables ausente, sem permissao) atras de um
# 2>/dev/null.
cadeia_zerar() {
    if iptables -w -t "$1" -L "$2" -n >/dev/null 2>&1; then
        iptables -w -t "$1" -F "$2"
    else
        iptables -w -t "$1" -N "$2"
    fi
}

# posicoes_do_salto <tabela> <cadeia-origem> <cadeia-destino>: imprime o numero de
# linha (1 = topo) de cada regra que e o nosso salto, uma por linha.
posicoes_do_salto() {
    iptables -w -t "$1" -S "$2" | grep '^-A ' \
        | awk -v alvo="-A $2 -s $REDE_AGENTES -j $3" '$0 == alvo { print NR }' || true
}

# salto_garantir <tabela> <cadeia-origem> <cadeia-destino>: deixa o salto UMA vez so,
# na posicao 1. Nao basta conferir com -C: o netavark empurra o nosso salto para baixo
# e um -C que acha o salto na posicao 2 acharia que esta tudo certo.
salto_garantir() {
    local tabela="$1" origem="$2" destino="$3" primeira extras n
    primeira="$(posicoes_do_salto "$tabela" "$origem" "$destino" | head -n 1)"
    if [ "$primeira" != 1 ]; then
        iptables -w -t "$tabela" -I "$origem" 1 -s "$REDE_AGENTES" -j "$destino"
    fi
    # Apaga as copias antigas de baixo para cima, para o numero das de cima nao mudar.
    extras="$(posicoes_do_salto "$tabela" "$origem" "$destino" | awk '$1 > 1' | sort -rn)"
    for n in $extras; do
        iptables -w -t "$tabela" -D "$origem" "$n"
    done
}

# cerca_egress <tabela>: monta a cadeia DGCLAW_EGRESS na tabela e liga ao FORWARD.
cerca_egress() {
    local tabela="$1" rede
    cadeia_zerar "$tabela" DGCLAW_EGRESS
    for rede in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8; do
        iptables -w -t "$tabela" -A DGCLAW_EGRESS -d "$rede" -j DROP
    done
    iptables -w -t "$tabela" -A DGCLAW_EGRESS -j RETURN
    salto_garantir "$tabela" FORWARD DGCLAW_EGRESS
}

main() {
    command -v iptables >/dev/null 2>&1 || {
        echo "dgclaw-firewall: o comando iptables nao existe nesta maquina. Instale com: apt-get install -y iptables" >&2
        exit 1
    }

    # --- o agente contra o host ---
    cadeia_zerar filter DGCLAW_HOST
    iptables -w -A DGCLAW_HOST -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -w -A DGCLAW_HOST -j DROP
    salto_garantir filter INPUT DGCLAW_HOST

    # --- o agente contra outras redes privadas (mangle primeiro, filter como reforco) ---
    cerca_egress mangle
    cerca_egress filter

    echo "cerca dos agentes aplicada ($REDE_AGENTES)"

    # Enterprise: cerca IPv6 (lib/enterprise/firewall6.sh). Nao faz nada no nivel pessoal e nao mexe
    # nas regras acima nem na ordem da tabela mangle.
    local fw6
    fw6="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/enterprise/firewall6.sh"
    if [ -f "$fw6" ]; then
        bash "$fw6" || { echo "dgclaw-firewall: a cerca IPv6 (enterprise) falhou; leia a mensagem acima. As regras IPv4 ja estao aplicadas." >&2; exit 1; }
    fi

    # Enterprise: cerca da saida controlada (lib/enterprise/firewall-saida.sh). Roda por ultimo: recoloca o salto dela
    # depois do DGCLAW_EGRESS (mangle) e no topo do INPUT. No nivel pessoal nao faz nada e nao toca no iptables.
    local fws
    fws="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/enterprise/firewall-saida.sh"
    if [ -f "$fws" ]; then
        bash "$fws" || { echo "dgclaw-firewall: a cerca da saida controlada (enterprise) falhou; leia a mensagem acima. As regras anteriores ja estao aplicadas." >&2; exit 1; }
    fi
}

main "$@"
