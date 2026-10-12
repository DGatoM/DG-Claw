#!/usr/bin/env bash
# lib/firewall.sh: a cerca de rede dos containers dos agentes.
#
# Roda no boot (dgclaw-firewall.service) e toda vez que um agente nasce. Sao duas
# cadeias, e cada uma fecha um caminho diferente:
#
#   DGCLAW_HOST    o agente falando com a PROPRIA MAQUINA que o hospeda. O gateway
#                  da rede dele (10.89.x.1) E o host: sem esta cadeia ele alcanca
#                  o sshd na 22 e o Caddy na 80, que servem tudo o que existe aqui.
#   DGCLAW_EGRESS  o agente falando com qualquer outra rede privada: a bridge
#                  padrao do podman, a tailnet, a rede da casa de alguem.
#
# O que continua passando e a internet. O agente precisa falar com a API do
# provedor e com o resto do mundo, e filtrar por dominio pediria um proxy, que e
# outra obra. O que importa aqui e o lado de dentro, e o lado de dentro fica fechado.
#
# Idempotente: rodar de novo recria as duas cadeias do zero e nao duplica o salto
# de INPUT nem o de FORWARD (confere com `iptables -C` antes de inserir).
set -euo pipefail

REDE_AGENTES=10.89.0.0/16

# cadeia_zerar <nome>: cria a cadeia, ou esvazia se ja existe. Conferir antes com -L
# evita esconder erro de verdade (iptables ausente, sem permissao) atras de um 2>/dev/null.
cadeia_zerar() {
    if iptables -w -L "$1" -n >/dev/null 2>&1; then
        iptables -w -F "$1"
    else
        iptables -w -N "$1"
    fi
}

# salto_garantir <cadeia-origem> <cadeia-destino>: poe o salto no topo, uma vez so.
salto_garantir() {
    if ! iptables -w -C "$1" -s "$REDE_AGENTES" -j "$2" 2>/dev/null; then
        iptables -w -I "$1" 1 -s "$REDE_AGENTES" -j "$2"
    fi
}

main() {
    command -v iptables >/dev/null 2>&1 || {
        echo "dgclaw-firewall: o comando iptables nao existe nesta maquina. Instale com: apt-get install -y iptables" >&2
        exit 1
    }

    # --- o agente contra o host ---
    cadeia_zerar DGCLAW_HOST
    iptables -w -A DGCLAW_HOST -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -w -A DGCLAW_HOST -j DROP
    salto_garantir INPUT DGCLAW_HOST

    # --- o agente contra outras redes privadas ---
    cadeia_zerar DGCLAW_EGRESS
    local rede
    for rede in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8; do
        iptables -w -A DGCLAW_EGRESS -d "$rede" -j DROP
    done
    iptables -w -A DGCLAW_EGRESS -j RETURN
    salto_garantir FORWARD DGCLAW_EGRESS

    echo "cerca dos agentes aplicada ($REDE_AGENTES)"
}

main "$@"
