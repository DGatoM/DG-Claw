#!/usr/bin/env bash
# lib/firewall.sh: a cerca de rede dos containers dos agentes.
#
# Roda no boot (dgclaw-firewall.service) e toda vez que um agente nasce. Sao tres
# camadas, e cada uma fecha um caminho diferente:
#
#   DGCLAW_HOST    (mangle e filter, INPUT) o agente falando com a PROPRIA MAQUINA
#                  que o hospeda. O gateway da rede dele (10.89.x.1) E o host: sem esta
#                  cadeia ele alcanca o sshd na 22 e o Caddy na 80, que servem tudo
#                  o que existe aqui. Fica nas DUAS tabelas pelo mesmo motivo do
#                  DGCLAW_EGRESS abaixo: em rede criada com --disable-dns o netavark 1.16
#                  (modo iptables) insere `-A INPUT -j NETAVARK_INPUT` na posicao 1 do
#                  filter INPUT, com ACCEPT de udp/tcp na porta 53 para a rede do agente,
#                  ANTES do nosso salto (medido em servidor real). Entre o start do
#                  container e o rodar_firewall, e sempre que o netavark reinsere, o
#                  agente alcancaria a porta 53 do host. O mangle INPUT roda antes do
#                  filter INPUT e o netavark nao usa o mangle; a cerca da filter fica como
#                  segunda trava.
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
# Idempotente: rodar de novo recria as cadeias (montando a nova ao lado e trocando, sem janela:
# ver cadeia_publicar) e deixa exatamente UM salto por cadeia de origem, sempre na posicao 1.
# Se alguem (o netavark, por exemplo) empurrou o nosso salto para baixo, ele e reinserido no
# topo antes de os antigos serem apagados, para nunca haver um instante sem o salto.
set -euo pipefail

REDE_AGENTES=10.89.0.0/16

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

# saltos_remover <tabela> <cadeia-origem> <cadeia-destino>: apaga TODOS os nossos saltos para o
# destino, de baixo para cima (para o numero dos de cima nao mudar).
saltos_remover() {
    local n
    for n in $(posicoes_do_salto "$1" "$2" "$3" | sort -rn); do
        iptables -w -t "$1" -D "$2" "$n"
    done
}

# cadeia_existe <tabela> <cadeia>
cadeia_existe() { iptables -w -t "$1" -L "$2" -n >/dev/null 2>&1; }

# cadeia_tem_final <tabela> <cadeia>: a ultima regra e DROP ou RETURN (a cadeia fecha o caminho).
cadeia_tem_final() {
    iptables -w -t "$1" -S "$2" 2>/dev/null | grep '^-A ' | tail -n 1 | grep -Eq -- '-j (DROP|RETURN)$'
}

# cadeia_tem_salto <tabela> <origem> <cadeia>
cadeia_tem_salto() { [ -n "$(posicoes_do_salto "$1" "$2" "$3")" ]; }

# cadeia_recuperar <tabela> <origem> <nome> <final>: trata a <nome>_NOVA que sobrou de uma troca
# interrompida. A regra e nunca tirar a UNICA cerca ativa:
#  - se <nome> existe e tem salto, ela ainda protege: a _NOVA e sobra e sai (sem salto, depois -F/-X);
#  - senao a _NOVA pode ser a unica protecao (a execucao parou depois de tirar os saltos da antiga):
#    a troca e CONCLUIDA, nao desfeita. A _NOVA sem salto e sem final e so um rascunho e e descartada.
cadeia_recuperar() {
    local tabela="$1" origem="$2" nome="$3" final="$4" nova="${3}_NOVA"
    cadeia_existe "$tabela" "$nova" || return 0
    if cadeia_existe "$tabela" "$nome" && cadeia_tem_salto "$tabela" "$origem" "$nome"; then
        saltos_remover "$tabela" "$origem" "$nova"
        iptables -w -t "$tabela" -F "$nova"
        iptables -w -t "$tabela" -X "$nova"
        return 0
    fi
    if ! cadeia_tem_final "$tabela" "$nova"; then
        if ! cadeia_tem_salto "$tabela" "$origem" "$nova"; then
            iptables -w -t "$tabela" -F "$nova"
            iptables -w -t "$tabela" -X "$nova"
            return 0
        fi
        # Tem salto mas ficou sem o final: fecha o caminho ja, sem tirar o salto.
        iptables -w -t "$tabela" -A "$nova" -j "$final"
    fi
    if cadeia_existe "$tabela" "$nome"; then
        # sem salto (testado acima): nao protege nada
        iptables -w -t "$tabela" -F "$nome"
        iptables -w -t "$tabela" -X "$nome"
    fi
    iptables -w -t "$tabela" -E "$nova" "$nome"
    salto_garantir "$tabela" "$origem" "$nome"
}

# cadeia_publicar <tabela> <origem> <nome> <preencher> <final>: troca a cadeia <nome> pela versao
# nova SEM JANELA. Esvaziar a cadeia com -F e recolocar as regras deixaria, por um instante, o salto
# apontando para uma cadeia vazia: nesse intervalo o pacote do agente seguiria para o ACCEPT do
# netavark (porta 53 do host, ou rede privada) e as conexoes abertas na janela passariam pelo
# ESTABLISHED. Entao: monta <nome>_NOVA com as regras completas (a funcao <preencher> recebe a
# tabela e o nome da cadeia), poe o salto para ela no topo, so depois tira os saltos para a antiga,
# esvazia e apaga a antiga, e renomeia a nova (o salto acompanha o rename). Nunca existe salto
# para cadeia vazia ou sem o ultimo DROP/RETURN, e nunca se faz -F em cadeia com salto.
cadeia_publicar() {
    local tabela="$1" origem="$2" nome="$3" preencher="$4" final="$5" nova="${3}_NOVA"
    cadeia_recuperar "$tabela" "$origem" "$nome" "$final"
    iptables -w -t "$tabela" -N "$nova"
    "$preencher" "$tabela" "$nova"
    if cadeia_existe "$tabela" "$nome"; then
        iptables -w -t "$tabela" -I "$origem" 1 -s "$REDE_AGENTES" -j "$nova"
        saltos_remover "$tabela" "$origem" "$nome"
        iptables -w -t "$tabela" -F "$nome"
        iptables -w -t "$tabela" -X "$nome"
    fi
    iptables -w -t "$tabela" -E "$nova" "$nome"
    salto_garantir "$tabela" "$origem" "$nome"
}

# regras_egress <tabela> <cadeia>: as redes privadas que o agente nao alcanca.
regras_egress() {
    local rede
    for rede in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8; do
        iptables -w -t "$1" -A "$2" -d "$rede" -j DROP
    done
    iptables -w -t "$1" -A "$2" -j RETURN
}

# regras_host <tabela> <cadeia>: o que o agente pode (so resposta) e nao pode (o resto) com o host.
regras_host() {
    iptables -w -t "$1" -A "$2" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -w -t "$1" -A "$2" -j DROP
}

# cerca_egress <tabela>: monta a cadeia DGCLAW_EGRESS na tabela e liga ao FORWARD.
cerca_egress() { cadeia_publicar "$1" FORWARD DGCLAW_EGRESS regras_egress RETURN; }

# cerca_host <tabela>: monta a cadeia DGCLAW_HOST na tabela e liga ao INPUT.
cerca_host() { cadeia_publicar "$1" INPUT DGCLAW_HOST regras_host DROP; }

# trava_exclusiva: duas execucoes sobrepostas (dois agentes subindo juntos) corromperiam a troca de
# cadeias: uma trataria a _NOVA da outra como sobra e daria -F nela depois de ela virar a unica
# cerca ativa. O `iptables -w` so serializa comando a comando, entao a execucao inteira leva uma
# trava exclusiva, mantida no descritor 9 ate o processo acabar. Sem a trava nao se mexe em regra.
trava_exclusiva() {
    local trava="${DGCLAW_FIREWALL_TRAVA:-/run/dgclaw-firewall.lock}" espera="${DGCLAW_FIREWALL_TRAVA_ESPERA:-120}"
    command -v flock >/dev/null 2>&1 || {
        echo "dgclaw-firewall: o comando flock nao existe nesta maquina, e ele impede duas aplicacoes da cerca ao mesmo tempo. Nao mexi em nenhuma regra. Instale com: apt-get install -y util-linux" >&2
        exit 1
    }
    if [ -L "$trava" ]; then
        echo "dgclaw-firewall: $trava e um link simbolico, e eu nao o sigo. Nao mexi em nenhuma regra. Remova o link (rm $trava) e rode de novo." >&2
        exit 1
    fi
    umask 077
    exec 9>"$trava" || {
        echo "dgclaw-firewall: nao consegui abrir o arquivo de trava $trava. Nao mexi em nenhuma regra. Confira se a pasta existe e se voce e root." >&2
        exit 1
    }
    flock -w "$espera" 9 || {
        echo "dgclaw-firewall: outra aplicacao da cerca segurou a trava $trava por mais de ${espera}s. Nao mexi em nenhuma regra. Veja quem segura com: fuser -v $trava (ou lsof $trava); rodar de novo costuma resolver." >&2
        exit 1
    }
}

main() {
    trava_exclusiva
    command -v iptables >/dev/null 2>&1 || {
        echo "dgclaw-firewall: o comando iptables nao existe nesta maquina. Instale com: apt-get install -y iptables" >&2
        exit 1
    }

    # --- o agente contra o host (mangle primeiro, filter como reforco) ---
    cerca_host mangle
    cerca_host filter

    # --- o agente contra outras redes privadas (mangle primeiro, filter como reforco) ---
    cerca_egress mangle
    cerca_egress filter

    echo "cerca dos agentes aplicada ($REDE_AGENTES)"
}

main "$@"
