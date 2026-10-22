#!/usr/bin/env bash
# lib/firewall.sh: a cerca de rede dos containers dos agentes.
#
# Roda no boot (dgclaw-firewall.service) e toda vez que um agente nasce. Sao tres
# camadas, e cada uma fecha um caminho diferente:
#
#   DGCLAW_HOST    (filter, INPUT) o agente falando com a PROPRIA MAQUINA que o
#                  hospeda. O gateway da rede dele (<faixa>.x.1, por padrao 10.89.x.1)
#                  E o host: sem esta cadeia ele alcanca o sshd na 22 e o Caddy na 80,
#                  que servem tudo o que existe aqui.
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
# (gateway <faixa>.x.1) passa pelo INPUT, nunca pelo FORWARD; e a internet nao e rede
# privada. Entao o DROP de redes privadas no FORWARD nao corta nada legitimo.
#
# O que continua passando e a internet. O agente precisa falar com a API do
# provedor e com o resto do mundo, e filtrar por dominio pediria um proxy, que e
# outra obra. O que importa aqui e o lado de dentro, e o lado de dentro fica fechado.
#
# A faixa dos agentes (REDE_AGENTES) vem do DGCLAW_FAIXA_REDE do dgclaw.env (padrao 10.89.0.0/16;
# o instalador grava com --faixa-rede). Todo salto para as nossas cadeias casa so com
# `-s <faixa>`: container que nao e do DG Claw v1 (outro sistema, outra faixa) nunca cai na cerca.
# Se a faixa mudou desde a ultima vez, os saltos da faixa antiga sao removidos (o novo entra antes).
#
# Idempotente: rodar de novo recria as cadeias do zero e deixa exatamente UM salto
# por cadeia de origem, sempre na posicao 1. Se alguem (o netavark, por exemplo)
# empurrou o nosso salto para baixo, ele e reinserido no topo antes de os antigos
# serem apagados, para nunca haver um instante sem o salto.
set -euo pipefail

# faixa_lida: o DGCLAW_FAIXA_REDE do dgclaw.env, lido com sed e nunca com `source` (o arquivo e so
# dado). Este script roda como root pelo systemd e e independente do lib/comum.sh, por isso a
# validacao do formato (um /16 privado) repete a de comum.sh: faixa_rede_valida.
FAIXA_PADRAO=10.89.0.0/16

faixa_valida() {
    local oct='(0|[1-9][0-9]{0,2})' a b
    [[ "$1" =~ ^$oct\.$oct\.0\.0/16$ ]] || return 1
    a="${BASH_REMATCH[1]}"; b="${BASH_REMATCH[2]}"
    [ "$a" -le 255 ] && [ "$b" -le 255 ] || return 1
    case "$a" in
        10) return 0 ;;
        172) [ "$b" -ge 16 ] && [ "$b" -le 31 ] ;;
        192) [ "$b" -eq 168 ] ;;
        *) return 1 ;;
    esac
}

faixa_lida() {
    local env="${DGCLAW_RAIZ:-}/etc/dgclaw/dgclaw.env" v=""
    if [ -f "$env" ]; then v="$(sed -n 's/^DGCLAW_FAIXA_REDE=//p;T;q' "$env")"; fi
    v="${v:-$FAIXA_PADRAO}"
    faixa_valida "$v" || {
        echo "dgclaw-firewall: a faixa de rede '$v' (DGCLAW_FAIXA_REDE em $env) nao serve: precisa ser um /16 privado com os dois ultimos numeros 0, por exemplo 10.91.0.0/16. Corrija a linha e rode de novo: bash $0" >&2
        exit 1
    }
    printf '%s' "$v"
}

REDE_AGENTES=""

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

# saltos_de_outra_faixa <tabela> <cadeia-origem> <cadeia-destino>: numero de linha de cada salto
# NOSSO (`-s <faixa> -j <destino>`) cuja faixa nao e a atual, ex.: sobra de uma faixa anterior.
# So olha regra que salta para a nossa cadeia: qualquer outra regra e de outra pessoa e nao se toca.
saltos_de_outra_faixa() {
    iptables -w -t "$1" -S "$2" | grep '^-A ' \
        | awk -v pre="-A $2 -s " -v suf=" -j $3" -v atual="$REDE_AGENTES" '
            index($0, pre) == 1 && substr($0, length($0) - length(suf) + 1) == suf {
                f = substr($0, length(pre) + 1, length($0) - length(pre) - length(suf))
                if (f != atual && f !~ /[[:space:]]/) print NR
            }' || true
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
    # So agora, com o salto certo ja no topo, apaga os de faixa antiga (de baixo para cima).
    extras="$(saltos_de_outra_faixa "$tabela" "$origem" "$destino" | sort -rn)"
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
    REDE_AGENTES="$(faixa_lida)" || exit 1
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
}

main "$@"
