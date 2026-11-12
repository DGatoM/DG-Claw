# shellcheck shell=bash
# lib/dns-containers.sh: DNS dos containers do DG Claw (carregado com source por bin/dgclaw e por
# scripts/teste-isolamento.sh).
#
# As redes dos agentes sao criadas com --disable-dns, entao o container herda o DNS do host. Em
# servidor fisico dentro de uma rede de empresa (clinica, escritorio) esse DNS costuma ficar numa
# rede privada (ex.: 192.168.25.6), que a cerca dos agentes (lib/firewall.sh) bloqueia de proposito:
# o agente ficava sem DNS. Em vez de abrir excecao na cerca (o agente nunca deve tocar a rede
# interna), so os containers do DG Claw recebem DNS publico, por `--dns`. Nada muda no DNS global
# do podman nem nos containers de outros usos do servidor.

# ip_na_faixa_bloqueada <ipv4>: verdadeiro se o IP cai numa faixa que a cerca (lib/firewall.sh)
# bloqueia para os containers: 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 e 127/8.
ip_na_faixa_bloqueada() {
    local a b c d
    IFS=. read -r a b c d <<<"$1"
    case "$a.$b.$c.$d" in *[!0-9.]*|*..*|.*|*.) return 1 ;; esac
    [ -n "$d" ] || return 1
    [ "$a" -eq 10 ] && return 0
    [ "$a" -eq 127 ] && return 0
    [ "$a" -eq 192 ] && [ "$b" -eq 168 ] && return 0
    [ "$a" -eq 169 ] && [ "$b" -eq 254 ] && return 0
    [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
    [ "$a" -eq 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 0
    return 1
}

# dns_containers_calcular: preenche DNS_CONTAINER_ARGS (array: --dns 1.1.1.1 --dns 8.8.8.8, ou
# vazio) e DNS_HOST_PRIVADOS (os nameservers privados do host, separados por virgula). Le
# $DGCLAW_RAIZ/run/systemd/resolve/resolv.conf, ou $DGCLAW_RAIZ/etc/resolv.conf se o primeiro nao
# existir, ignorando o stub local do systemd-resolved (127.0.0.53 e 127.0.0.54).
# shellcheck disable=SC2034 # as duas variaveis sao lidas por quem carrega este arquivo
dns_containers_calcular() {
    DNS_CONTAINER_ARGS=()
    DNS_HOST_PRIVADOS=""
    local raiz="${DGCLAW_RAIZ:-}" resolv chave ns
    resolv="$raiz/run/systemd/resolve/resolv.conf"
    [ -f "$resolv" ] || resolv="$raiz/etc/resolv.conf"
    [ -f "$resolv" ] || return 0
    while read -r chave ns _; do
        [ "$chave" = nameserver ] || continue
        case "$ns" in 127.0.0.53|127.0.0.54) continue ;; esac
        if ip_na_faixa_bloqueada "$ns"; then DNS_HOST_PRIVADOS="${DNS_HOST_PRIVADOS:+$DNS_HOST_PRIVADOS, }$ns"; fi
    done <"$resolv"
    if [ -n "$DNS_HOST_PRIVADOS" ]; then DNS_CONTAINER_ARGS=(--dns 1.1.1.1 --dns 8.8.8.8); fi
}
