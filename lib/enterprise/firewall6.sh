#!/usr/bin/env bash
# lib/enterprise/firewall6.sh: cerca IPv6 dos agentes (protecao `container_endurecido`).
#
# O podman cria as redes dos agentes sem IPv6, mas a cerca garante: todo IPv6 que entra, sai ou
# atravessa as pontes dgclaw-* e barrado, e a ponte fica com `disable_ipv6=1`.
#
# Dois jeitos de usar:
#   - executado (bash firewall6.sh): e o que lib/firewall.sh faz no fim, na unidade dgclaw-firewall e a cada
#     agente que nasce. Mexe so no ip6tables; as regras v4 e a ordem da tabela mangle ficam como estao
#     (armadilha 4 do DESENHO).
#   - carregado com source (bin/dgclaw): so define funcoes.
# Sem /etc/dgclaw/protecoes.json (nivel pessoal) nao faz nada e sai com 0.

_FW6_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FW6_CADEIA=DGCLAW_V6

# fw6_pontes: uma ponte (interface) por linha, das redes dgclaw-*. DGCLAW_PONTES (separadas por espaco) substitui
# a descoberta, para teste e para quem sabe o que esta fazendo.
fw6_pontes() {
    local rede ponte
    if [ -n "${DGCLAW_PONTES:-}" ]; then
        # shellcheck disable=SC2086 # a lista e de nomes simples separados por espaco, de proposito
        printf '%s\n' $DGCLAW_PONTES
        return 0
    fi
    command -v podman >/dev/null 2>&1 || { aviso "o podman nao existe nesta maquina; nao ha ponte dgclaw-* para cercar."; return 0; }
    while IFS= read -r rede; do
        case "$rede" in dgclaw-*) ;; *) continue ;; esac
        ponte="$(podman network inspect "$rede" --format '{{.NetworkInterface}}' 2>/dev/null)" || ponte=""
        if [ -z "$ponte" ]; then
            aviso "nao consegui ler a interface da rede $rede (podman network inspect); ela ficou sem a cerca IPv6. Rode de novo: bash $_FW6_DIR/firewall6.sh"
            continue
        fi
        printf '%s\n' "$ponte"
    done < <(podman network ls --format '{{.Name}}' 2>/dev/null)
}

# fw6_salto_garantir <cadeia-origem>: deixa o salto para DGCLAW_V6 uma vez so, no topo.
fw6_salto_garantir() {
    local origem="$1"
    while ip6tables -w -C "$origem" -j "$FW6_CADEIA" 2>/dev/null; do
        ip6tables -w -D "$origem" -j "$FW6_CADEIA"
    done
    ip6tables -w -I "$origem" 1 -j "$FW6_CADEIA"
}

fw6_aplicar() {
    local ponte pontes=() n=0
    while IFS= read -r ponte; do
        [ -n "$ponte" ] || continue
        # O nome vai para regra e para caminho de sysctl: so o que uma interface de verdade pode ter.
        [[ "$ponte" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || { aviso "ignorei a interface '${ponte:0:30}': nome fora do padrao do kernel."; continue; }
        pontes+=("$ponte")
    done < <(fw6_pontes)

    command -v ip6tables >/dev/null 2>&1 || falha "o comando ip6tables nao existe nesta maquina." \
        "instale com: apt-get install -y iptables   e rode de novo: bash $_FW6_DIR/firewall6.sh"

    if ip6tables -w -L "$FW6_CADEIA" -n >/dev/null 2>&1; then
        ip6tables -w -F "$FW6_CADEIA"
    else
        ip6tables -w -N "$FW6_CADEIA"
    fi
    for ponte in "${pontes[@]}"; do
        ip6tables -w -A "$FW6_CADEIA" -i "$ponte" -j DROP
        ip6tables -w -A "$FW6_CADEIA" -o "$ponte" -j DROP
        sysctl -q -w "net.ipv6.conf.$ponte.disable_ipv6=1" \
            || aviso "nao consegui desligar o IPv6 da ponte $ponte (sysctl). A regra do ip6tables continua barrando; confira com: sysctl net.ipv6.conf.$ponte.disable_ipv6"
        n=$((n + 1))
    done
    ip6tables -w -A "$FW6_CADEIA" -j RETURN
    for ponte in INPUT OUTPUT FORWARD; do fw6_salto_garantir "$ponte"; done
    echo "cerca IPv6 aplicada ($n ponte(s))"
}

fw6_main() {
    local raiz
    raiz="$(cd "$_FW6_DIR/../.." && pwd)"
    APP_DIR="${APP_DIR:-$raiz}"
    # shellcheck source=lib/comum.sh
    . "$raiz/lib/comum.sh"
    # Sem a escolha gravada o nivel e pessoal: nada a fazer, e nem precisa do jq nem da matriz.
    [ -s "$DG_ETC/protecoes.json" ] || exit 0
    # shellcheck source=lib/protecoes.sh
    . "$raiz/lib/protecoes.sh"
    protecao_ligada container_endurecido || exit 0
    fw6_aplicar
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -euo pipefail
    fw6_main "$@"
fi
