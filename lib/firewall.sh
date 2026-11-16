#!/usr/bin/env bash
# lib/firewall.sh: a cerca de rede dos containers dos agentes.
#
# Roda no boot (dgclaw-firewall.service) e toda vez que um agente nasce. Sao tres
# camadas, e cada uma fecha um caminho diferente:
#
#   DGCLAW_HOST    (mangle e filter, INPUT) o agente falando com a PROPRIA MAQUINA
#                  que o hospeda. O gateway da rede dele (<faixa>.x.1, por padrao 10.89.x.1) E o host: sem esta
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
# (gateway <faixa>.x.1) passa pelo INPUT, nunca pelo FORWARD; e a internet nao e rede
# privada. Entao o DROP de redes privadas no FORWARD nao corta nada legitimo.
#
# O que continua passando e a internet. O agente precisa falar com a API do
# provedor e com o resto do mundo, e filtrar por dominio pediria um proxy, que e
# outra obra. O que importa aqui e o lado de dentro, e o lado de dentro fica fechado.
#
# A faixa dos agentes (REDE_AGENTES) vem do DGCLAW_FAIXA_REDE do dgclaw.env (padrao 10.89.0.0/16;
# o instalador grava com --faixa-rede). Todo salto para as nossas cadeias, nas duas tabelas (mangle e
# filter), casa so com `-s <faixa>`: container que nao e do DG Claw v1 (outro sistema, outra faixa)
# nunca cai na cerca. Se a faixa mudou desde a ultima vez, os saltos da faixa antiga sao removidos
# (o novo entra antes).
#
# Idempotente: rodar de novo recria as cadeias (montando a nova ao lado e trocando, sem janela:
# ver cadeia_publicar) e deixa exatamente UM salto por cadeia de origem, sempre na posicao 1.
# Se alguem (o netavark, por exemplo) empurrou o nosso salto para baixo, ele e reinserido no
# topo antes de os antigos serem apagados, para nunca haver um instante sem o salto.
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
FAIXAS_EXTRAS=()

# abortar <tabela> <o que aconteceu>: sai sem mexer em mais nada. Nao pode ser chamada dentro de $(...),
# senao o exit so encerraria o subshell; por isso as consultas devolvem o resultado em variaveis globais.
abortar() {
    echo "dgclaw-firewall: $2 Parei antes de esvaziar ou apagar qualquer cadeia que ainda proteja os agentes (tabela $1). Rodar de novo resolve; se repetir, veja o estado com: iptables -w -t $1 -S" >&2
    exit 1
}

# snapshot <tabela>: guarda em SNAP a saida de `iptables -S` da tabela inteira. Se o comando FALHA,
# aborta: "falhou" nunca pode virar "nao encontrei", porque ai a cerca antiga pareceria sem saltos e
# seria esvaziada com o salto ainda apontando para ela.
snapshot() {
    local rc=0
    SNAP="$(iptables -w -t "$1" -S 2>"$ERRO_IPT")" || rc=$?
    if [ "$rc" -ne 0 ]; then
        abortar "$1" "o comando 'iptables -w -t $1 -S' falhou (codigo $rc: $(head -c 300 "$ERRO_IPT" | tr '\n' ' '))."
    fi
}

# cadeia_existe <tabela> <cadeia>
cadeia_existe() { snapshot "$1"; grep -qxF -- "-N $2" <<<"$SNAP"; }

# regras_da_cadeia <tabela> <cadeia>: REGRAS = as linhas "-A <cadeia> ..." dela, na ordem.
regras_da_cadeia() { snapshot "$1"; REGRAS="$(grep -- "^-A $2 " <<<"$SNAP" || true)"; }

# cadeia_tem_final <tabela> <cadeia>: a ultima regra e DROP ou RETURN (a cadeia fecha o caminho).
cadeia_tem_final() { regras_da_cadeia "$1" "$2"; tail -n 1 <<<"$REGRAS" | grep -Eq -- '-j (DROP|RETURN)$'; }

# cadeia_completa <tabela> <cadeia> <n-regras>: tem exatamente as regras da familia (a contagem
# esperada, ver cadeia_publicar) e fecha com DROP/RETURN. Cadeia esvaziada ou pela metade nao passa.
cadeia_completa() {
    regras_da_cadeia "$1" "$2"
    [ -n "$REGRAS" ] || return 1
    [ "$(grep -c . <<<"$REGRAS")" -eq "$3" ] && tail -n 1 <<<"$REGRAS" | grep -Eq -- '-j (DROP|RETURN)$'
}

# posicoes_do_salto <tabela> <cadeia-origem> <cadeia-destino>: POSICOES = o numero de linha
# (1 = topo) de cada regra da origem que e o nosso salto, uma por linha.
posicoes_do_salto() {
    snapshot "$1"
    POSICOES="$(grep -- "^-A $2 " <<<"$SNAP" \
        | awk -v alvo="-A $2 -s $REDE_AGENTES -j $3" '$0 == alvo { print NR }' || true)"
}

# cadeia_tem_salto <tabela> <origem> <cadeia>
cadeia_tem_salto() { posicoes_do_salto "$1" "$2" "$3"; [ -n "$POSICOES" ]; }

# saltos_de_outra_faixa <tabela> <cadeia-origem> <cadeia-destino>: numero de linha de cada salto
# NOSSO (`-s <faixa> -j <destino>`) cuja faixa nao e a atual, ex.: sobra de uma faixa anterior.
# So olha regra que salta para a nossa cadeia: qualquer outra regra e de outra pessoa e nao se toca.
# Os saltos das faixas em FAIXAS_EXTRAS (ainda com rede de agente) ficam de fora, salvo com o 4o argumento
# "todas" (usado so ao trocar a cadeia inteira: os extras ja foram repostos na cadeia nova).
saltos_de_outra_faixa() {
    snapshot "$1"
    grep -- "^-A $2 " <<<"$SNAP" \
        | awk -v pre="-A $2 -s " -v suf=" -j $3" -v atual="$REDE_AGENTES" '
            index($0, pre) == 1 && substr($0, length($0) - length(suf) + 1) == suf {
                f = substr($0, length(pre) + 1, length($0) - length(pre) - length(suf))
                if (f != atual && f !~ /[[:space:]]/) print NR, f
            }' | while read -r nr f; do
                # Faixa antiga que ainda tem rede de agente: o salto dela fica (ver faixas_extras_calcular).
                if [ "${4:-}" = todas ] || ! faixa_e_extra "$f"; then printf '%s\n' "$nr"; fi
            done || true
}

# extras_inserir <tabela> <cadeia-origem> <cadeia-destino>: poe o salto de cada faixa em FAIXAS_EXTRAS
# (faixa antiga que ainda tem rede de agente do DG Claw) para o destino, se ainda nao existir.
extras_inserir() {
    local f
    for f in "${FAIXAS_EXTRAS[@]}"; do
        snapshot "$1"
        if ! grep -qxF -- "-A $2 -s $f -j $3" <<<"$SNAP"; then
            iptables -w -t "$1" -I "$2" 1 -s "$f" -j "$3"
        fi
    done
}

# faixa_e_extra <faixa>: 0 se a faixa esta em FAIXAS_EXTRAS (o salto dela nao pode ser removido).
faixa_e_extra() {
    local f
    for f in "${FAIXAS_EXTRAS[@]}"; do [ "$f" = "$1" ] && return 0; done
    return 1
}

# salto_garantir <tabela> <cadeia-origem> <cadeia-destino>: deixa o salto UMA vez so,
# na posicao 1. Nao basta conferir com -C: o netavark empurra o nosso salto para baixo
# e um -C que acha o salto na posicao 2 acharia que esta tudo certo.
salto_garantir() {
    local tabela="$1" origem="$2" destino="$3" primeira extras n
    posicoes_do_salto "$tabela" "$origem" "$destino"
    primeira="$(head -n 1 <<<"$POSICOES")"
    if [ "$primeira" != 1 ]; then
        iptables -w -t "$tabela" -I "$origem" 1 -s "$REDE_AGENTES" -j "$destino"
    fi
    # Apaga as copias antigas de baixo para cima, para o numero das de cima nao mudar.
    posicoes_do_salto "$tabela" "$origem" "$destino"
    extras="$(awk '$1 > 1' <<<"$POSICOES" | sort -rn)"
    for n in $extras; do
        iptables -w -t "$tabela" -D "$origem" "$n"
    done
    # So agora, com o salto certo ja no topo, apaga os de faixa antiga (de baixo para cima).
    extras="$(saltos_de_outra_faixa "$tabela" "$origem" "$destino" | sort -rn)"
    for n in $extras; do
        iptables -w -t "$tabela" -D "$origem" "$n"
    done
    extras_inserir "$tabela" "$origem" "$destino"
}

# saltos_remover <tabela> <cadeia-origem> <cadeia-destino>: apaga TODOS os nossos saltos para o
# destino, de baixo para cima (para o numero dos de cima nao mudar).
saltos_remover() {
    local n lista
    posicoes_do_salto "$1" "$2" "$3"
    lista="$(sort -rn <<<"$POSICOES")"
    for n in $lista; do
        iptables -w -t "$1" -D "$2" "$n"
    done
    # Tambem os de uma faixa anterior (--faixa-rede mudou): sem isso a cadeia antiga ainda teria salto
    # apontando para ela e cadeia_remover abortaria. So saltos para a NOSSA cadeia; regra alheia nao se toca.
    lista="$(saltos_de_outra_faixa "$1" "$2" "$3" todas | sort -rn)"
    for n in $lista; do
        iptables -w -t "$1" -D "$2" "$n"
    done
}

# cadeia_remover <tabela> <cadeia>: esvazia e apaga. ANTES do -F reconsulta e confirma que nenhuma
# regra da tabela ainda salta para ela; se houver, aborta sem esvaziar (esvaziar cadeia referenciada
# abriria a janela que toda esta troca existe para evitar).
cadeia_remover() {
    snapshot "$1"
    if grep -Eq -- " -j $2\$" <<<"$SNAP"; then
        abortar "$1" "a cadeia $2 ainda tem salto apontando para ela, entao nao a esvaziei."
    fi
    iptables -w -t "$1" -F "$2"
    iptables -w -t "$1" -X "$2"
}

# cadeia_recuperar <tabela> <origem> <nome> <final> <n-regras>: trata a <nome>_NOVA que sobrou de
# uma troca interrompida. A regra e nunca tirar a UNICA cerca ativa:
#  - se <nome> tem salto E esta completa, ela protege: a _NOVA e sobra e sai (sem salto, depois -F/-X);
#  - senao (<nome> ausente, sem salto, ou esvaziada/incompleta) a _NOVA pode ser a melhor cerca: se
#    esta completa, a troca e CONCLUIDA a favor dela, nao desfeita;
#  - _NOVA incompleta e sem salto e so um rascunho e e descartada; incompleta e COM salto e fechada
#    com o final e tambem concluida (a execucao normal que segue monta uma cadeia completa).
cadeia_recuperar() {
    local tabela="$1" origem="$2" nome="$3" final="$4" total="$5" nova="${3}_NOVA"
    cadeia_existe "$tabela" "$nova" || return 0
    if cadeia_existe "$tabela" "$nome" && cadeia_tem_salto "$tabela" "$origem" "$nome" \
        && cadeia_completa "$tabela" "$nome" "$total"; then
        saltos_remover "$tabela" "$origem" "$nova"
        cadeia_remover "$tabela" "$nova"
        return 0
    fi
    if ! cadeia_completa "$tabela" "$nova" "$total"; then
        if ! cadeia_tem_salto "$tabela" "$origem" "$nova"; then
            cadeia_remover "$tabela" "$nova"
            return 0
        fi
        # Tem salto mas ficou incompleta: fecha o caminho ja, sem tirar o salto.
        if ! cadeia_tem_final "$tabela" "$nova"; then
            iptables -w -t "$tabela" -A "$nova" -j "$final"
        fi
    fi
    if ! cadeia_tem_salto "$tabela" "$origem" "$nova"; then
        iptables -w -t "$tabela" -I "$origem" 1 -s "$REDE_AGENTES" -j "$nova"
    fi
    extras_inserir "$tabela" "$origem" "$nova"
    if cadeia_existe "$tabela" "$nome"; then
        saltos_remover "$tabela" "$origem" "$nome"
        cadeia_remover "$tabela" "$nome"
    fi
    iptables -w -t "$tabela" -E "$nova" "$nome"
    salto_garantir "$tabela" "$origem" "$nome"
}

# cadeia_publicar <tabela> <origem> <nome> <preencher> <final> <n-regras>: troca a cadeia <nome> pela
# versao nova SEM JANELA. Esvaziar a cadeia com -F e recolocar as regras deixaria, por um instante, o
# salto apontando para uma cadeia vazia: nesse intervalo o pacote do agente seguiria para o ACCEPT do
# netavark (porta 53 do host, ou rede privada) e as conexoes abertas na janela passariam pelo
# ESTABLISHED. Entao: monta <nome>_NOVA com as regras completas (a funcao <preencher> recebe a
# tabela e o nome da cadeia), poe o salto para ela no topo, so depois tira os saltos para a antiga,
# esvazia e apaga a antiga, e renomeia a nova (o salto acompanha o rename). Nunca existe salto
# para cadeia vazia ou sem o ultimo DROP/RETURN, e nunca se faz -F em cadeia com salto.
cadeia_publicar() {
    local tabela="$1" origem="$2" nome="$3" preencher="$4" final="$5" total="$6" nova="${3}_NOVA"
    cadeia_recuperar "$tabela" "$origem" "$nome" "$final" "$total"
    iptables -w -t "$tabela" -N "$nova"
    "$preencher" "$tabela" "$nova"
    if cadeia_existe "$tabela" "$nome"; then
        iptables -w -t "$tabela" -I "$origem" 1 -s "$REDE_AGENTES" -j "$nova"
        extras_inserir "$tabela" "$origem" "$nova"
        saltos_remover "$tabela" "$origem" "$nome"
        cadeia_remover "$tabela" "$nome"
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
cerca_egress() { cadeia_publicar "$1" FORWARD DGCLAW_EGRESS regras_egress RETURN 7; }

# cerca_host <tabela>: monta a cadeia DGCLAW_HOST na tabela e liga ao INPUT.
cerca_host() { cadeia_publicar "$1" INPUT DGCLAW_HOST regras_host DROP 2; }

# faixas_extras_calcular: preenche FAIXAS_EXTRAS com as faixas /16 (A.B.0.0/16) DIFERENTES da atual que
# ainda tem rede de agente do DG Claw (label dgclaw.v1=1, ou dgclaw-<slug> de agente do agentes.json).
# O salto de uma faixa assim NUNCA e removido: se o dono gravou uma faixa nova no dgclaw.env (ou outro
# processo gravou, por exemplo um `agente criar` concorrente), o agente que ficou na faixa antiga
# continuaria sem passar pelas cercas. Se o podman nao responde, nao da para saber: vale o que ja
# estava no iptables (as faixas dos saltos atuais para as nossas cadeias ficam).
faixas_extras_calcular() {
    local nome linha subs resto rotulo s f json="${DGCLAW_RAIZ:-}/etc/dgclaw/agentes.json" lista="" falhou=0 nossa
    FAIXAS_EXTRAS=()
    if command -v podman >/dev/null 2>&1; then
        local nomes
        if nomes="$(podman network ls --format '{{.Name}}' 2>"$ERRO_IPT")"; then
            while IFS= read -r nome; do
                [ -n "$nome" ] || continue
                if ! linha="$(podman network inspect "$nome" --format '{{range .Subnets}}{{.Subnet}} {{end}}|{{.NetworkInterface}}|{{index .Labels "dgclaw.v1"}}' 2>>"$ERRO_IPT")"; then
                    falhou=1; continue
                fi
                subs="${linha%%|*}"; resto="${linha#*|}"; rotulo="${resto#*|}"; rotulo="${rotulo//[[:space:]]/}"
                nossa=0
                if [ "$rotulo" = 1 ]; then nossa=1
                elif [[ "$nome" == dgclaw-?* ]] && [ -f "$json" ] \
                    && grep -Eq "\"slug\"[[:space:]]*:[[:space:]]*\"${nome#dgclaw-}\"" "$json"; then nossa=1; fi
                [ "$nossa" = 1 ] || continue
                for s in $subs; do
                    [[ "$s" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+\.[0-9]+/ ]] || continue
                    f="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.0.0/16"
                    [ "$f" = "$REDE_AGENTES" ] && continue
                    faixa_e_extra "$f" || FAIXAS_EXTRAS+=("$f")
                    echo "dgclaw-firewall: a rede '$nome' do DG Claw esta em $s, fora da faixa atual $REDE_AGENTES. Mantive o salto da faixa $f na cerca, para ela continuar isolada. Para resolver: volte DGCLAW_FAIXA_REDE para $f em /etc/dgclaw/dgclaw.env, ou recrie o agente na faixa nova (sudo dgclaw agente remover <agente>) e rode a cerca de novo." >&2
                done
            done <<<"$nomes"
        else
            falhou=1
        fi
    fi
    if [ "$falhou" = 1 ]; then
        echo "dgclaw-firewall: nao consegui ler todas as redes do podman ($(head -c 200 "$ERRO_IPT" | tr '\n' ' ')). Mantive os saltos de faixa antiga que ja estavam no iptables, por seguranca." >&2
        snapshot filter
        lista="$(grep -E -- '^-A (INPUT|FORWARD) -s [^ ]+ -j DGCLAW_(HOST|EGRESS)$' <<<"$SNAP" | awk '{print $4}' | sort -u || true)"
        for f in $lista; do
            [ "$f" = "$REDE_AGENTES" ] && continue
            faixa_e_extra "$f" || FAIXAS_EXTRAS+=("$f")
        done
    fi
}

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
    REDE_AGENTES="$(faixa_lida)" || exit 1
    trava_exclusiva
    ERRO_IPT="$(mktemp)" || { echo "dgclaw-firewall: nao consegui criar um arquivo temporario (mktemp falhou). Nao mexi em nenhuma regra. Confira o espaco em /tmp e rode de novo." >&2; exit 1; }
    trap 'rm -f "$ERRO_IPT"' EXIT
    command -v iptables >/dev/null 2>&1 || {
        echo "dgclaw-firewall: o comando iptables nao existe nesta maquina. Instale com: apt-get install -y iptables" >&2
        exit 1
    }

    faixas_extras_calcular

    # --- o agente contra o host (mangle primeiro, filter como reforco) ---
    cerca_host mangle
    cerca_host filter

    # --- o agente contra outras redes privadas (mangle primeiro, filter como reforco) ---
    cerca_egress mangle
    cerca_egress filter

    echo "cerca dos agentes aplicada ($REDE_AGENTES)"
}

main "$@"
