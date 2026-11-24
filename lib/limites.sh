# shellcheck shell=bash
# lib/limites.sh: limites de memoria e de CPU dos containers dos agentes (carregado com source por bin/dgclaw).
#
# O container do agente nasce com um teto de memoria e de CPU. Um teto fixo e pequeno demais numa maquina
# grande (um subagente com imagem passou de 1,2 GB e o cgroup matou o processo), e dar a CADA agente 75% da RAM
# superalocava a maquina assim que existia mais de um. A memoria agora sai de uma divisao da RAM total
# ($R/proc/meminfo):
#   RESERVA   = o maior entre 1536 MB e 15% da RAM, para o sistema e para os servicos do DG Claw (painel, Admin, rondas);
#   PRINCIPAL = o primeiro agente criado que ainda existe (o de menor numero no registro.tsv, 3a coluna; o agentes.json
#               nao serve de ordem, porque agentes_registrar move o slug para o fim). Recebe o maior entre 2048 MB e
#               RAM - reserva. Ele nunca e reduzido por causa de um agente criado depois;
#   ADICIONAL = os demais. A folga e RAM - reserva - soma dos limites de memoria dos OUTROS containers de agente (lidos do
#               cgroup; container parado ou ilegivel conta pelo valor que o calculo daria, e o texto diz que foi estimado;
#               container sem limite conta como sem folga). O limite e o menor entre 2048 MB e a folga, nunca abaixo de
#               1024 MB; com folga menor que 2048 MB o DG Claw avisa, com os numeros e como mudar.
#   CPUs      = o maior entre 1.0 e (nucleos - 0.2), com uma casa decimal (le `nproc`). Nao depende do papel.
# Quem quiser outro valor define no /etc/dgclaw/dgclaw.env (vale para qualquer agente e vence o calculo; se a soma passar
# de RAM - reserva, o DG Claw avisa, sem barrar):
#   DGCLAW_CONTAINER_MEMORIA=4g     (numero seguido de m ou g)
#   DGCLAW_CONTAINER_CPUS=1.5       (numero com ate uma casa decimal)
# O limite de processos nao entra aqui: e fixo em LIMITE_PIDS.

LIMITE_PIDS=4096
LIMITE_MEM_PISO_MB=2048          # piso do principal e teto padrao do adicional
LIMITE_MEM_RESERVA_MIN_MB=1536   # piso da reserva do sistema (a reserva e 15% da RAM quando isso passa disso)
LIMITE_MEM_ADICIONAL_MIN_MB=1024 # piso do adicional, mesmo sem folga

# O ambiente DESTE processo, guardado ao carregar o arquivo (antes de carregar_env_dgclaw, que executa o dgclaw.env e
# sobrescreveria a variavel). Assim criar, recriar e reparar leem os valores do mesmo jeito: variavel de ambiente
# primeiro; sem ela, a linha literal do dgclaw.env.
_LIM_AMB_MEMORIA="${DGCLAW_CONTAINER_MEMORIA:-}"
_LIM_AMB_CPUS="${DGCLAW_CONTAINER_CPUS:-}"

# _limites_env_literal <NOME>: le o valor de NOME do $DG_ETC/dgclaw.env SEM executar o arquivo (nada de source/eval:
# so a linha `NOME=valor`, com ou sem `export ` na frente e com espaco no comeco, a ultima vence). Como o shell faria: aspas simples ou duplas em volta sao tiradas (o que vem
# depois da aspa de fechamento, como um comentario, e ignorado) e, em valor sem aspas, um comentario no fim da linha
# (espaco e `#`) e cortado. Imprime vazio se nao achou.
_limites_env_literal() {
    local nome="$1" arq="$DG_ETC/dgclaw.env" linha val="" resto
    [ -r "$arq" ] || return 0
    while IFS= read -r linha || [ -n "$linha" ]; do
        # Espaco no comeco da linha e o prefixo `export ` (com espacos depois) sao aceitos, como o shell aceitaria.
        linha="${linha#"${linha%%[![:space:]]*}"}"
        case "$linha" in export[[:space:]]*) linha="${linha#export}"; linha="${linha#"${linha%%[![:space:]]*}"}" ;; esac
        case "$linha" in "$nome="*) val="${linha#"$nome="}" ;; esac
    done <"$arq"
    case "$val" in
        \"*)
            resto="${val#\"}"
            case "$resto" in *\"*) val="${resto%%\"*}" ;; esac ;;
        \'*)
            resto="${val#\'}"
            case "$resto" in *\'*) val="${resto%%\'*}" ;; esac ;;
        *)
            val="${val%%[[:space:]]#*}"
            val="${val%"${val##*[![:space:]]}"}" ;;
    esac
    printf '%s' "$val"
}

# _limites_valor_configurado <NOME> <valor-do-ambiente>: a variavel de ambiente vale; senao a linha literal do dgclaw.env.
_limites_valor_configurado() {
    if [ -n "$2" ]; then printf '%s' "$2"; else _limites_env_literal "$1"; fi
}

# _limites_ram_mb: RAM total da maquina em MB (0 se nao deu para ler o meminfo).
_limites_ram_mb() {
    local total_kb=""
    if [ -r "$R/proc/meminfo" ]; then
        total_kb="$(awk '/^MemTotal:/ { print $2; exit }' "$R/proc/meminfo" 2>/dev/null)"
    fi
    case "$total_kb" in ''|*[!0-9]*) total_kb=0 ;; esac
    printf '%s' $((total_kb / 1024))
}

# _limites_reserva_mb <ram-mb>: o maior entre 1536 MB e 15% da RAM.
_limites_reserva_mb() {
    local r=$(($1 * 15 / 100))
    [ "$r" -ge "$LIMITE_MEM_RESERVA_MIN_MB" ] || r="$LIMITE_MEM_RESERVA_MIN_MB"
    printf '%s' "$r"
}

# _limites_alvo_principal_mb <ram-mb> <reserva-mb>: o maior entre 2048 MB e RAM - reserva.
_limites_alvo_principal_mb() {
    local m=$(($1 - $2))
    [ "$m" -ge "$LIMITE_MEM_PISO_MB" ] || m="$LIMITE_MEM_PISO_MB"
    printf '%s' "$m"
}

# _limites_existentes: imprime (um por linha, sem repetir) os slugs dos agentes que existem: os do agentes.json (tipo
# "agente") UNIDOS aos do registro.tsv cujo container ja existe. O agente so entra no agentes.json no fim do criar, depois
# de o container subir; sem a segunda fonte, dois criar seguidos (ou um criar e o calculo de outro) nao enxergariam um ao
# outro. Agente removido (container sumiu) nao conta, mesmo com linha sobrando no registro. No ensaio nao ha podman a
# consultar, e vale so o agentes.json.
_limites_existentes() {
    local s
    {
        agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug' 2>/dev/null || true
        if [ "$ENSAIO" != 1 ] && [ -f "$DG_REGISTRO" ]; then
            while IFS= read -r s; do
                podman container exists "dgclaw-$s" >/dev/null 2>&1 </dev/null && printf '%s\n' "$s"
            done < <(awk -F'\t' 'NF >= 3 && $1 ~ /^[a-z0-9][a-z0-9-]+$/ { print $1 }' "$DG_REGISTRO")
        fi
    } | sort -u
}

# limites_principal <slug>: imprime o slug do agente principal considerando <slug> como existente: entre os agentes
# existentes (_limites_existentes) mais <slug>, o de menor numero no registro. Slug fora do registro (agente que ainda
# esta sendo criado) conta como numero infinito; empate desempata pelo nome.
limites_principal() {
    local slug="$1" s n
    {
        _limites_existentes
        printf '%s\n' "$slug"
    } | sort -u | while IFS= read -r s; do
        [ -n "$s" ] || continue
        n=""
        if [ -f "$DG_REGISTRO" ]; then
            n="$(awk -F'\t' -v s="$s" '$1 == s && NF >= 3 && $3 ~ /^[0-9]+$/ {print $3 + 0; exit}' "$DG_REGISTRO")"
        fi
        printf '%s %s\n' "${n:-999999999}" "$s"
    done | sort -k1,1n -k2,2 | head -n 1 | cut -d' ' -f2
}

# _limites_somar_outros <slug> <ram-mb> <reserva-mb> <principal>: soma o limite de memoria dos OUTROS containers de agente.
# Preenche LIM_OUTROS_MB, LIM_OUTROS_ESTIMADOS (slugs cujo valor foi estimado) e LIM_OUTROS_SEMLIMITE (slugs lidos sem
# limite, que contam como a RAM inteira: sem folga). Container parado conta pelo HostConfig.Memory guardado no podman
# (zero com consulta bem-sucedida = sem limite); consulta que falha, estimado. Usa limites_ler_atuais, entao mexe nas variaveis ATU_*.
_limites_somar_outros() {
    local slug="$1" ram="$2" reserva="$3" principal="$4" s mb bytes
    LIM_OUTROS_MB=0; LIM_OUTROS_ESTIMADOS=""; LIM_OUTROS_SEMLIMITE=""
    while IFS= read -r s; do
        if [ -z "$s" ] || [ "$s" = "$slug" ]; then continue; fi
        if [ "$ENSAIO" != 1 ] && limites_ler_atuais "dgclaw-$s" && [ "$ATU_MEM_OK" = 1 ]; then
            if [ "$ATU_MEM_ILIM" = 1 ]; then
                LIM_OUTROS_SEMLIMITE="$LIM_OUTROS_SEMLIMITE $s"; mb="$ram"
            else
                mb="$ATU_MEM_MB"
            fi
        else
            # Container parado: o cgroup nao existe, mas o podman guarda o limite com que ele foi criado. Consulta que tem
            # sucesso e devolve 0 quer dizer SEM TETO (conta como a RAM inteira); so consulta que falha ou vem vazia ou
            # ilegivel cai na estimativa.
            bytes=""
            if [ "$ENSAIO" != 1 ]; then bytes="$(podman inspect -f '{{.HostConfig.Memory}}' "dgclaw-$s" 2>/dev/null)" || bytes=""; fi
            case "$bytes" in ''|*[!0-9]*) bytes=estimar ;; *) bytes=$((10#$bytes)) ;; esac
            if [ "$bytes" = estimar ]; then
                LIM_OUTROS_ESTIMADOS="$LIM_OUTROS_ESTIMADOS $s"
                if [ "$s" = "$principal" ]; then mb="$(_limites_alvo_principal_mb "$ram" "$reserva")"; else mb="$LIMITE_MEM_PISO_MB"; fi
            elif [ "$bytes" -eq 0 ]; then
                LIM_OUTROS_SEMLIMITE="$LIM_OUTROS_SEMLIMITE $s"; mb="$ram"
            else
                mb=$((bytes / 1048576))
            fi
        fi
        LIM_OUTROS_MB=$((LIM_OUTROS_MB + mb))
    done < <(_limites_existentes)
    LIM_OUTROS_ESTIMADOS="${LIM_OUTROS_ESTIMADOS# }"; LIM_OUTROS_SEMLIMITE="${LIM_OUTROS_SEMLIMITE# }"
}

# --- trava do calculo ate o create ----------------------------------------------------------
# Dois `agente criar` ao mesmo tempo (ou um criar e um recriar) calculavam o papel e a folga de memoria antes de qualquer um
# deles ter o container: os dois se achavam o principal, ou dividiam a mesma folga. Por isso quem vai criar um container
# pega esta trava EXCLUSIVA antes de limites_calcular e so a solta depois do `podman create` (em criar_container), quando o
# container ja existe e o proximo calculo o enxerga (_limites_existentes). E o descritor 7 do processo; o podman roda com
# ele fechado (7>&-), para o conmon, que vive ate o container parar, nao segurar a trava. Sair do processo solta a trava.
# O reparar nao a usa: ele nao cria container.
DG_TRAVA_LIMITES="$DG_ETC/travas/limites.lock"

# limites_trava_pegar: espera ate DGCLAW_TRAVA_LIMITES_ESPERA segundos (padrao 900, como a trava da faixa de rede).
limites_trava_pegar() {
    [ "$ENSAIO" = 1 ] && return 0
    local espera="${DGCLAW_TRAVA_LIMITES_ESPERA:-900}"
    trava_arquivo_preparar "$DG_TRAVA_LIMITES"
    exec 7>"$DG_TRAVA_LIMITES" || falha "nao consegui abrir a trava dos limites em $DG_TRAVA_LIMITES." \
        "confira se voce e root e se a pasta $(dirname "$DG_TRAVA_LIMITES") existe e aceita gravar."
    flock -x -w "$espera" 7 || falha "outra criacao ou recriacao de agente esta segurando a trava dos limites ($DG_TRAVA_LIMITES) ha mais de ${espera}s: duas ao mesmo tempo calculariam a memoria sem enxergar uma a outra." \
        "espere o outro comando terminar e rode de novo. Se nada estiver rodando, veja quem segura com: fuser -v $DG_TRAVA_LIMITES"
}

# limites_trava_soltar: larga a trava (fecha o descritor 7).
limites_trava_soltar() { exec 7>&-; }

# limites_calcular <slug>: preenche LIM_MEM_MB (inteiro), LIM_MEM_ARG (valor do --memory), LIM_CPUS_DEC (decimos de CPU,
# inteiro) e LIM_CPUS_ARG (valor do --cpus), mais o que explica a memoria: LIM_PAPEL (principal ou adicional), LIM_RAM_MB,
# LIM_RESERVA_MB, LIM_FOLGA_MB (so adicional sem sobrescrita; vazio senao), LIM_OUTROS_MB, LIM_SOBRESCRITA (0 ou 1) e
# LIM_EXCESSO_MB (quanto a sobrescrita passa de RAM - reserva; 0 se cabe). <slug> pode ser de um agente que ainda nao
# existe. Valor estranho em variavel de sobrescrita e erro, nao palpite. Quem imprime o resultado e limites_relatar.
# shellcheck disable=SC2034 # lidas por quem carrega este arquivo
limites_calcular() {
    local slug="${1:-}" n mb dec cfg_mem cfg_cpus ram reserva principal
    [ -n "$slug" ] || falha "limites_calcular foi chamado sem o slug do agente." "isso e um erro do DG Claw; abra uma issue."
    # Mesmo leitor e mesma precedencia em criar, recriar e reparar (ver _limites_valor_configurado).
    cfg_mem="$(_limites_valor_configurado DGCLAW_CONTAINER_MEMORIA "$_LIM_AMB_MEMORIA")"
    cfg_cpus="$(_limites_valor_configurado DGCLAW_CONTAINER_CPUS "$_LIM_AMB_CPUS")"
    ram="$(_limites_ram_mb)"
    reserva="$(_limites_reserva_mb "$ram")"
    principal="$(limites_principal "$slug")"
    LIM_RAM_MB="$ram"; LIM_RESERVA_MB="$reserva"; LIM_FOLGA_MB=""; LIM_OUTROS_MB=0
    LIM_OUTROS_ESTIMADOS=""; LIM_OUTROS_SEMLIMITE=""; LIM_SOBRESCRITA=0; LIM_EXCESSO_MB=0
    if [ "$slug" = "$principal" ]; then
        LIM_PAPEL=principal
        mb="$(_limites_alvo_principal_mb "$ram" "$reserva")"
        # O principal nunca e reduzido, mas a soma dos tetos pode passar da maquina (adicionais antigos): so para avisar.
        if [ "$ram" -gt 0 ]; then
            _limites_somar_outros "$slug" "$ram" "$reserva" "$principal"
            LIM_EXCESSO_MB=$((LIM_OUTROS_MB + mb - (ram - reserva)))
            [ "$LIM_EXCESSO_MB" -gt 0 ] || LIM_EXCESSO_MB=0
        fi
    else
        LIM_PAPEL=adicional
        mb="$LIMITE_MEM_PISO_MB"
        # Sem meminfo nao ha como medir a folga: fica o padrao de 2048 MB.
        if [ "$ram" -gt 0 ]; then
            _limites_somar_outros "$slug" "$ram" "$reserva" "$principal"
            LIM_FOLGA_MB=$((ram - reserva - LIM_OUTROS_MB))
            if [ "$LIM_FOLGA_MB" -lt "$LIMITE_MEM_PISO_MB" ]; then
                mb="$LIM_FOLGA_MB"
                [ "$mb" -ge "$LIMITE_MEM_ADICIONAL_MIN_MB" ] || mb="$LIMITE_MEM_ADICIONAL_MIN_MB"
            fi
        fi
    fi
    LIM_MEM_MB="$mb"
    LIM_MEM_ARG="${mb}m"
    if [ -n "$cfg_mem" ]; then
        case "$cfg_mem" in
            [1-9]*[mg]) ;;
            *) falha "DGCLAW_CONTAINER_MEMORIA='$cfg_mem' (em $DG_ETC/dgclaw.env ou no ambiente) nao serve: precisa ser um numero inteiro seguido de m ou g, como 4g ou 3072m." \
                "corrija a linha, por exemplo DGCLAW_CONTAINER_MEMORIA=4g, ou apague-a para o DG Claw calcular pelo tamanho da maquina." ;;
        esac
        case "${cfg_mem%[mg]}" in *[!0-9]*) falha "DGCLAW_CONTAINER_MEMORIA='$cfg_mem' nao serve: so digitos antes do m ou do g." "use por exemplo 4g." ;; esac
        # Piso de 512m, conferido ANTES de converter (numero enorme nao estoura a conta): abaixo disso o agente nao sobe.
        case "${cfg_mem%[mg]}" in
            ?????????[0-9]*) falha "DGCLAW_CONTAINER_MEMORIA='$cfg_mem' nao serve: numero grande demais." "use por exemplo 4g." ;;
        esac
        if [ "${cfg_mem: -1}" = m ] && [ "$((10#${cfg_mem%m}))" -lt 512 ]; then
            falha "DGCLAW_CONTAINER_MEMORIA='$cfg_mem' nao serve: abaixo de 512m o agente nao consegue rodar." "use 512m ou mais, por exemplo 2g, ou apague a linha para o DG Claw calcular pelo tamanho da maquina."
        fi
        LIM_MEM_ARG="$cfg_mem"
        LIM_MEM_MB="${cfg_mem%[mg]}"
        [ "${cfg_mem: -1}" = g ] && LIM_MEM_MB=$((LIM_MEM_MB * 1024))
        LIM_SOBRESCRITA=1
        LIM_FOLGA_MB=""
        if [ "$ram" -gt 0 ]; then
            # Os outros ja foram somados acima, para o principal e para o adicional.
            LIM_EXCESSO_MB=$((LIM_OUTROS_MB + LIM_MEM_MB - (ram - reserva)))
            [ "$LIM_EXCESSO_MB" -gt 0 ] || LIM_EXCESSO_MB=0
        fi
    fi
    n="$(nproc 2>/dev/null || true)"
    case "$n" in ''|*[!0-9]*|0) n=1 ;; esac
    dec=$((n * 10 - 2))
    [ "$dec" -ge 10 ] || dec=10
    LIM_CPUS_DEC="$dec"
    LIM_CPUS_ARG="$((dec / 10)).$((dec % 10))"
    if [ -n "$cfg_cpus" ]; then
        case "$cfg_cpus" in
            [0-9]|[0-9][0-9]|[0-9].[0-9]|[0-9][0-9].[0-9]) ;;
            *) falha "DGCLAW_CONTAINER_CPUS='$cfg_cpus' (em $DG_ETC/dgclaw.env ou no ambiente) nao serve: precisa ser um numero com ate uma casa decimal, como 2 ou 1.5." \
                "corrija a linha, por exemplo DGCLAW_CONTAINER_CPUS=1.5, ou apague-a para o DG Claw calcular pelo tamanho da maquina." ;;
        esac
        dec="${cfg_cpus/./}"
        case "$cfg_cpus" in *.*) ;; *) dec="${dec}0" ;; esac
        [ "$((10#$dec))" -gt 0 ] || falha "DGCLAW_CONTAINER_CPUS='$cfg_cpus' nao serve: precisa ser maior que zero." "use por exemplo 1.5."
        LIM_CPUS_DEC="$((10#$dec))"
        LIM_CPUS_ARG="$((LIM_CPUS_DEC / 10)).$((LIM_CPUS_DEC % 10))"
    fi
}

# limites_relatar <container> <slug>: conta o que limites_calcular decidiu (info) e, quando a memoria esta apertada, avisa.
limites_relatar() {
    local c="$1" slug="$2" det nota=""
    if [ "$LIM_SOBRESCRITA" = 1 ]; then
        det="valor definido por DGCLAW_CONTAINER_MEMORIA"
    elif [ "$LIM_PAPEL" = principal ]; then
        det="agente principal: RAM de $LIM_RAM_MB MB menos a reserva de $LIM_RESERVA_MB MB para o sistema e o DG Claw"
    elif [ -n "$LIM_FOLGA_MB" ]; then
        det="agente adicional: RAM de $LIM_RAM_MB MB, reserva de $LIM_RESERVA_MB MB, outros agentes somam $LIM_OUTROS_MB MB, folga de $LIM_FOLGA_MB MB"
    else
        det="agente adicional: nao consegui ler a RAM da maquina, ficou o padrao de $LIMITE_MEM_PISO_MB MB"
    fi
    info "limites do container $c: memoria $LIM_MEM_ARG, CPUs $LIM_CPUS_ARG, processos $LIMITE_PIDS ($det)"
    [ -n "$LIM_OUTROS_ESTIMADOS" ] && nota=" Os limites de $LIM_OUTROS_ESTIMADOS nao puderam ser lidos (container parado ou ilegivel), entao entraram na soma pelo valor que o calculo daria (estimado)."
    if [ -n "$LIM_OUTROS_SEMLIMITE" ]; then
        nota="$nota Os containers $LIM_OUTROS_SEMLIMITE estao sem limite de memoria e contam como sem folga."
    fi
    [ -n "$LIM_OUTROS_ESTIMADOS" ] && info "limites dos outros agentes: $LIM_OUTROS_ESTIMADOS entraram na soma por estimativa (container parado ou ilegivel), pelo valor que o calculo daria."
    if [ "$LIM_SOBRESCRITA" = 1 ]; then
        if [ "$LIM_EXCESSO_MB" -gt 0 ]; then
            aviso "com DGCLAW_CONTAINER_MEMORIA=$LIM_MEM_ARG para o agente $slug, a soma dos limites passa em $LIM_EXCESSO_MB MB do que a maquina tem depois da reserva ($LIM_RAM_MB MB de RAM, $LIM_RESERVA_MB MB reservados, outros agentes somam $LIM_OUTROS_MB MB). O DG Claw aplicou o valor mesmo assim, e o servidor pode ficar sem memoria sob carga. Para mudar, ajuste a linha DGCLAW_CONTAINER_MEMORIA em $DG_ETC/dgclaw.env ou use uma VPS com mais memoria.$nota"
        fi
        return 0
    fi
    if [ "$LIM_PAPEL" = principal ]; then
        [ "$LIM_EXCESSO_MB" -gt 0 ] || return 0
        aviso "o agente principal $slug recebeu o maximo, $LIM_MEM_MB MB (RAM de $LIM_RAM_MB MB menos a reserva de $LIM_RESERVA_MB MB), e os outros agentes ja somam $LIM_OUTROS_MB MB: a soma dos tetos passa em $LIM_EXCESSO_MB MB do que a maquina tem depois da reserva. Os tetos sao limites, nao reservas: so pesa se todos os agentes usarem muita memoria ao mesmo tempo. Para aliviar, baixe o limite de um agente adicional (DGCLAW_CONTAINER_MEMORIA em $DG_ETC/dgclaw.env e dgclaw agente recriar <agente> --forcar) ou use uma VPS com mais memoria. O principal nao foi reduzido.$nota"
        return 0
    fi
    [ "$LIM_PAPEL" = adicional ] && [ -n "$LIM_FOLGA_MB" ] || return 0
    [ "$LIM_FOLGA_MB" -lt "$LIMITE_MEM_PISO_MB" ] || return 0
    if [ "$LIM_FOLGA_MB" -le 0 ]; then
        aviso "nao sobra memoria para o agente $slug: a maquina tem $LIM_RAM_MB MB, $LIM_RESERVA_MB MB ficam reservados para o sistema e o DG Claw e os outros agentes ja somam $LIM_OUTROS_MB MB (folga de $LIM_FOLGA_MB MB). O agente principal nao foi mexido. O DG Claw aplicou o piso de $LIM_MEM_MB MB a este agente, e o servidor pode ficar sem memoria sob carga. Para outro valor, ponha DGCLAW_CONTAINER_MEMORIA=<valor> (por exemplo 1536m) em $DG_ETC/dgclaw.env, o que vale para todos os agentes criados depois. A outra saida e uma VPS com mais memoria.$nota"
    else
        aviso "sobra pouca memoria para o agente $slug: a maquina tem $LIM_RAM_MB MB, $LIM_RESERVA_MB MB ficam reservados para o sistema e o DG Claw e os outros agentes somam $LIM_OUTROS_MB MB, entao a folga e de $LIM_FOLGA_MB MB (o padrao de um adicional e $LIMITE_MEM_PISO_MB MB). O agente principal nao foi mexido. O DG Claw aplicou $LIM_MEM_MB MB a este agente. Para outro valor, ponha DGCLAW_CONTAINER_MEMORIA=<valor> (por exemplo 2g) em $DG_ETC/dgclaw.env, o que vale para todos os agentes criados depois. A outra saida e uma VPS com mais memoria.$nota"
    fi
}

_limites_mb_texto() { awk -v mb="$1" 'BEGIN { printf "%.1f GB", mb / 1024 }'; }

# _limites_cgroup_valor <arquivo>: imprime o conteudo de um arquivo do cgroup; retorna 1 se nao leu.
_limites_cgroup_valor() { local v; { IFS= read -r v <"$1"; } 2>/dev/null || return 1; printf '%s' "$v"; }

# limites_ler_atuais <container>: preenche com os limites EFETIVOS do container ligado, lidos do cgroup pelo host
# ($R/sys/fs/cgroup<State.CgroupPath>/...). O HostConfig nao serve: no podman 4.9 o `podman update` muda so o cgroup em
# execucao e o HostConfig fica com o valor de criacao. Cada controlador e lido de forma independente:
#   memoria = par memory.max + memory.swap.max (o swap do cgroup v2 e SO o swap, sem a memoria): ATU_MEM_B, ATU_SWAP_B,
#             ATU_MEM_ILIM, ATU_SWAP_ILIM, ATU_MEM_MB. Se um dos dois faltar ou for ilegivel, ATU_MEM_OK=0 e a memoria nao e ajustada;
#   CPU = cpu.max cru: ATU_CPU_QUOTA, ATU_CPU_PERIODO (ATU_CPUS_DEC so para exibir, arredondado para cima), ATU_CPU_ILIM, ATU_CPU_OK;
#   processos = pids.max: ATU_PIDS, ATU_PIDS_ILIM, ATU_PIDS_OK.
# As flags ATU_*_ILIM valem 1 quando o arquivo traz `max` (sem limite); nesse caso o valor numerico fica 0, mas quem decide
# e a flag: um 0 literal no arquivo e um teto finito igual a zero, nao "sem limite". Falha de um nao cancela os outros. Retorna 1 so se o caminho do cgroup nao serve
# ou se nenhum dos tres foi lido.
# shellcheck disable=SC2034 # lidas por quem carrega este arquivo
limites_ler_atuais() {
    local c="$1" cg dir mem swap pids cpu quota periodo
    ATU_MEM_OK=0; ATU_CPU_OK=0; ATU_PIDS_OK=0
    ATU_MEM_B=0; ATU_MEM_MB=0; ATU_MEM_ILIM=0; ATU_SWAP_B=0; ATU_SWAP_ILIM=0; ATU_PIDS=0; ATU_PIDS_ILIM=0
    ATU_CPU_QUOTA=0; ATU_CPU_PERIODO=0; ATU_CPU_ILIM=0; ATU_CPUS_DEC=0
    cg="$(podman inspect -f '{{.State.CgroupPath}}' "$c" 2>/dev/null)" || return 1
    case "$cg" in /*) ;; *) return 1 ;; esac
    case "$cg" in *..*|*[!A-Za-z0-9/._:@-]*) return 1 ;; esac
    dir="$R/sys/fs/cgroup$cg"
    if mem="$(_limites_cgroup_valor "$dir/memory.max")" && swap="$(_limites_cgroup_valor "$dir/memory.swap.max")"; then
        local mem_ilim=0 swap_ilim=0
        if [ "$mem" = max ]; then mem_ilim=1; mem=0; fi
        if [ "$swap" = max ]; then swap_ilim=1; swap=0; fi
        case "$mem$swap" in ''|*[!0-9]*) ;; *)
            ATU_MEM_B="$mem"; ATU_SWAP_B="$swap"; ATU_MEM_MB=$((mem / 1048576)); ATU_MEM_OK=1
            ATU_MEM_ILIM="$mem_ilim"; ATU_SWAP_ILIM="$swap_ilim" ;;
        esac
    fi
    if pids="$(_limites_cgroup_valor "$dir/pids.max")"; then
        local pids_ilim=0
        if [ "$pids" = max ]; then pids_ilim=1; pids=0; fi
        case "$pids" in ''|*[!0-9]*) ;; *) ATU_PIDS="$pids"; ATU_PIDS_ILIM="$pids_ilim"; ATU_PIDS_OK=1 ;; esac
    fi
    if cpu="$(_limites_cgroup_valor "$dir/cpu.max")"; then
        read -r quota periodo <<<"$cpu"
        local cpu_ilim=0
        if [ "$quota" = max ]; then cpu_ilim=1; quota=0; fi
        case "$quota$periodo" in ''|*[!0-9]*) ;; *)
            if [ -n "$periodo" ] && [ "$quota" != "" ]; then
                ATU_CPU_QUOTA="$quota"; ATU_CPU_PERIODO="$periodo"; ATU_CPU_ILIM="$cpu_ilim"; ATU_CPU_OK=1
                if [ "$quota" -gt 0 ] && [ "$periodo" -gt 0 ]; then
                    ATU_CPUS_DEC=$(((quota * 10 + periodo - 1) / periodo))
                    [ "$ATU_CPUS_DEC" -ge 1 ] || ATU_CPUS_DEC=1
                fi
            fi ;;
        esac
    fi
    [ $((ATU_MEM_OK + ATU_CPU_OK + ATU_PIDS_OK)) -gt 0 ]
}

# _limites_resumo_atual: o que limites_ler_atuais leu, com "nao lido" no que nao deu para ler.
_limites_resumo_atual() {
    local mem="nao lido" cpus="nao lido" pids="nao lido"
    if [ "$ATU_MEM_OK" = 1 ]; then if [ "$ATU_MEM_ILIM" = 1 ]; then mem="sem limite"; else mem="$(_limites_mb_texto "$ATU_MEM_MB")"; fi; fi
    if [ "$ATU_CPU_OK" = 1 ]; then if [ "$ATU_CPU_ILIM" = 1 ]; then cpus="sem limite"; else cpus="$((ATU_CPUS_DEC / 10)).$((ATU_CPUS_DEC % 10))"; fi; fi
    if [ "$ATU_PIDS_OK" = 1 ]; then if [ "$ATU_PIDS_ILIM" = 1 ]; then pids="sem limite"; else pids="$ATU_PIDS"; fi; fi
    printf 'memoria %s, CPUs %s, processos %s' "$mem" "$cpus" "$pids"
}
_limites_resumo() {
    local mem="sem limite" cpus="sem limite" pids="sem limite"
    [ "$1" -gt 0 ] && mem="$(_limites_mb_texto "$1")"
    [ "$2" -gt 0 ] && cpus="$(( $2 / 10 )).$(( $2 % 10 ))"
    [ "$3" -gt 0 ] && pids="$3"
    printf 'memoria %s, CPUs %s, processos %s' "$mem" "$cpus" "$pids"
}

# --- pendencias: limite que sumiu e nao voltou -----------------------------------------------
# Se depois do `podman update` um limite que era finito aparece como `max` e a restauracao do valor anterior tambem nao
# se confirma, o container ficou sem aquele limite. Sem registro disso, a execucao seguinte leria o `max` e o trataria como
# escolha do dono. A pendencia e esse registro: $DG_ETC/limites-pendentes/<slug> (modo 600), uma linha por recurso
# (memoria, cpu ou pids). Nada de segredo: so o nome do recurso. Enquanto ela existir, o reparar trata o recurso como abaixo
# do calculado mesmo que o cgroup mostre `max`, e so a apaga quando a releitura confirma o limite finito.
# O slug vem de _LIM_PEND_SLUG, que limites_ajustar_existente define.
_LIM_PEND_SLUG=""
_limites_pend_arq() { printf '%s/limites-pendentes/%s' "$DG_ETC" "$_LIM_PEND_SLUG"; }
_limites_pend_tem() { local arq; arq="$(_limites_pend_arq)"; [ -f "$arq" ] && grep -qx -- "$1" "$arq"; }
# _limites_pend_gravar <recurso>: junta o recurso ao arquivo (sem repetir), de forma atomica; 1 se nao conseguiu gravar.
_limites_pend_gravar() {
    local arq conteudo
    arq="$(_limites_pend_arq)"
    mkdir -p "$(dirname "$arq")" 2>/dev/null && chmod 700 "$(dirname "$arq")" || return 1
    conteudo="$({ [ -f "$arq" ] && cat "$arq"; printf '%s\n' "$1"; } | sort -u)"
    printf '%s\n' "$conteudo" | escrever_arquivo "$arq" 600 2>/dev/null
}
# _limites_pend_limpar <recurso>: tira o recurso do arquivo; sem linhas sobrando, apaga o arquivo.
_limites_pend_limpar() {
    local arq resto
    arq="$(_limites_pend_arq)"
    [ -f "$arq" ] || return 0
    resto="$(grep -vx -- "$1" "$arq" || true)"
    if [ -z "$resto" ]; then rm -f "$arq"; else printf '%s\n' "$resto" | escrever_arquivo "$arq" 600; fi
}

# Predicados "abaixo do alvo" sobre o que limites_ler_atuais leu (sem leitura nao conta).
# _limites_*_valor_abaixo: so o valor, finito e menor que o calculado. Recurso SEM LIMITE (max, flag ILIM) nao esta abaixo
# do alvo por valor: o reparar nao o converte em teto finito, EXCETO com pendencia (ver acima): ai conta como abaixo.
# Um teto finito igual a zero (0 literal no cgroup) e escolha do dono, como qualquer outro valor que nao e o padrao antigo.
_limites_mem_valor_abaixo() { [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ] && [ "$ATU_MEM_B" -lt $((LIM_MEM_MB * 1048576)) ]; }
_limites_cpu_valor_abaixo() { [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ] && [ $((ATU_CPU_QUOTA * 10)) -lt $((LIM_CPUS_DEC * ATU_CPU_PERIODO)) ]; }
_limites_pids_valor_abaixo() { [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ] && [ "$ATU_PIDS" -lt "$LIMITE_PIDS" ]; }
_limites_mem_abaixo() { _limites_mem_valor_abaixo || { [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" = 1 ] && _limites_pend_tem memoria; }; }
_limites_cpu_abaixo() { _limites_cpu_valor_abaixo || { [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" = 1 ] && _limites_pend_tem cpu; }; }
_limites_pids_abaixo() { _limites_pids_valor_abaixo || { [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" = 1 ] && _limites_pend_tem pids; }; }

# O padrao antigo do DG Claw (antes do calculo pela maquina): 2 GiB, 1.0 CPU e 1024 processos. O reparar so mexe num recurso
# que ainda esta nesse valor ou que tem pendencia; qualquer outro valor (acima ou abaixo do calculado) conta como escolha do dono.
_limites_mem_antiga() { _limites_pend_tem memoria || { [ "$ATU_MEM_ILIM" != 1 ] && [ "$ATU_MEM_B" -eq 2147483648 ]; }; }
# CPU: o padrao antigo e o par exato quota 100000 e periodo 100000 (o antigo --cpus 1.0). Outro periodo (50000 50000, por
# exemplo) e escolha do dono.
_limites_cpu_antiga() { _limites_pend_tem cpu || { [ "$ATU_CPU_ILIM" != 1 ] && [ "$ATU_CPU_QUOTA" -eq 100000 ] && [ "$ATU_CPU_PERIODO" -eq 100000 ]; }; }
_limites_pids_antigo() { _limites_pend_tem pids || { [ "$ATU_PIDS_ILIM" != 1 ] && [ "$ATU_PIDS" -eq 1024 ]; }; }

# _limites_em <lista> <item>: 0 se o item esta na lista separada por espacos.
_limites_em() { [[ " $1 " == *" $2 "* ]]; }

# _limites_id_confere <container> <id> <slug>: o nome ainda aponta para o container de ID <id>? O nome e reutilizavel
# (um recriar troca o container de mesmo nome); o ID nao. Se mudou, falha dizendo que o reparo pegou um container trocado.
_limites_id_confere() {
    local atual
    atual="$(podman inspect -f '{{.Id}}' "$1" 2>/dev/null)" || atual=""
    [ "$atual" = "$2" ] && return 0
    # shellcheck disable=SC2016 # as crases fazem parte do texto
    aviso "FALHA: o container $1 foi trocado no meio do reparo dos limites: o nome passou a apontar para outro container (outro ID)${atual:+,} ${atual:-ou o container deixou de existir}. Os ajustes que eu fazia valiam para o container antigo, e nao sei como o novo esta. Rode de novo: \`dgclaw agente reparar $3\`."
    return 1
}

# _limites_restaurar <id> <recurso...> (memoria, cpu, pids): poe de volta, com outro `podman update`, o valor que o recurso
# tinha ANTES do reparo, e le o cgroup de novo para confirmar. Os valores de antes vem das variaveis *_antes de
# limites_ajustar_existente (escopo dinamico do bash: esta funcao so e chamada de la). Preenche REST_OK (confirmados) e
# REST_FALHOU (nao confirmados, ou sem valor anterior finito para voltar). Mexe nas variaveis ATU_*.
# Memoria: --memory-swap e --memory nos mesmos bytes de antes; CPUs: o par quota e periodo de antes; processos: o mesmo numero.
_limites_restaurar() {
    local id="$1" r sw tentou="" args=()
    shift
    REST_OK=""; REST_FALHOU=""
    for r in "$@"; do
        case "$r" in
            memoria)
                if [ "$fin_mem_antes" != 1 ]; then REST_FALHOU="$REST_FALHOU memoria"; continue; fi
                if [ "$swap_ilim_antes" = 1 ]; then sw="-1"; else sw="$((mem_antes_b + swap_antes_b))"; fi
                args+=("--memory-swap=$sw" "--memory=$mem_antes_b"); tentou="$tentou memoria" ;;
            cpu)
                if [ "$fin_cpu_antes" != 1 ]; then REST_FALHOU="$REST_FALHOU cpu"; continue; fi
                args+=("--cpu-period=$cpu_periodo_antes" "--cpu-quota=$cpu_quota_antes"); tentou="$tentou cpu" ;;
            pids)
                if [ "$fin_pids_antes" != 1 ]; then REST_FALHOU="$REST_FALHOU pids"; continue; fi
                args+=("--pids-limit=$pids_antes"); tentou="$tentou pids" ;;
        esac
    done
    [ -n "$tentou" ] || return 0
    podman update "${args[@]}" "$id" >/dev/null 2>&1 || true
    if ! limites_ler_atuais "$id"; then REST_FALHOU="$REST_FALHOU$tentou"; return 0; fi
    for r in $tentou; do
        case "$r" in
            memoria)
                if [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ] && [ "$ATU_MEM_B" -eq "$mem_antes_b" ] \
                    && { { [ "$swap_ilim_antes" = 1 ] && [ "$ATU_SWAP_ILIM" = 1 ]; } \
                        || { [ "$swap_ilim_antes" != 1 ] && [ "$ATU_SWAP_ILIM" != 1 ] && [ "$ATU_SWAP_B" -eq "$swap_antes_b" ]; }; }; then
                    REST_OK="$REST_OK memoria"; else REST_FALHOU="$REST_FALHOU memoria"; fi ;;
            cpu)
                if [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ] && [ "$ATU_CPU_QUOTA" -eq "$cpu_quota_antes" ] && [ "$ATU_CPU_PERIODO" -eq "$cpu_periodo_antes" ]; then
                    REST_OK="$REST_OK cpu"; else REST_FALHOU="$REST_FALHOU cpu"; fi ;;
            pids)
                if [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ] && [ "$ATU_PIDS" -eq "$pids_antes" ]; then
                    REST_OK="$REST_OK pids"; else REST_FALHOU="$REST_FALHOU pids"; fi ;;
        esac
    done
}

# _limites_det_restauracao <slug> <recurso> <nome-no-texto> <valor-anterior>: o pedaco da mensagem de FALHA que conta o que
# aconteceu com a restauracao (usa REST_OK, REST_FALHOU e PEND_GRAVADAS, preenchidos por limites_ajustar_existente).
_limites_det_restauracao() {
    local slug="$1" r="$2" nome="$3" ant="$4" arq
    arq="$(_limites_pend_arq)"
    if _limites_em "$REST_OK" "$r"; then
        printf 'Restaurei o valor de antes (%s) com outro podman update e o cgroup confirmou; o limite voltou ao que era, mas o ajuste para o valor calculado nao entrou.' "$ant"
    elif _limites_em "$PEND_GRAVADAS" "$r"; then
        # shellcheck disable=SC2016 # as crases fazem parte do texto
        printf 'A restauracao do valor de antes (%s) NAO se confirmou: o container pode estar SEM limite de %s agora. Gravei uma pendencia em %s: enquanto ela existir, `dgclaw agente reparar %s` trata esse recurso como abaixo do calculado e tenta aplicar o limite de novo, em vez de aceitar o sem limite como escolha sua. Rode-o de novo.' "$ant" "$nome" "$arq" "$slug"
    else
        # shellcheck disable=SC2016 # as crases fazem parte do texto
        printf 'A restauracao do valor de antes (%s) NAO se confirmou e nao consegui gravar a pendencia em %s: o container pode estar SEM limite de %s, e uma nova execucao de `dgclaw agente reparar %s` poderia tratar isso como escolha sua. Corrija a pasta %s (permissao e espaco) e rode-o de novo.' "$ant" "$arq" "$nome" "$slug" "$(dirname "$arq")"
    fi
}

# limites_ajustar_existente <slug>: poe o container que ja existe no limite calculado, SEM recriar, com
# `podman update`. So sobe o que ainda esta no padrao antigo do DG Claw (2 GiB, 1.0 CPU, 1024 processos); o que esta sem limite
# (max) fica sem limite, e qualquer outro valor (a pessoa aumentou ou diminuiu a mao) fica como esta, e o log diz que foi mantido e por que. Se o podman
# da maquina nao tem o `update` ou nao aceita um dos flags, avisa e segue (nunca derruba o reparar). O resultado de
# cada recurso vem da RELEITURA do cgroup depois do update, nao do codigo de saida do podman.
# Todas as leituras e os `podman update` usam o ID do container, lido uma vez no comeco: o nome e reutilizavel (um recriar
# o troca), o ID nao. No fim confere que o nome ainda aponta para o mesmo ID.
# Depois do update, o valor relido manda: limite finito que virou `max`, ou valor que ficou ABAIXO do que era antes, e FALHA
# (codigo 1), e o reparar tenta restaurar o valor de antes com outro update (_limites_restaurar). Se a restauracao nao se
# confirma, grava a pendencia do recurso (ver acima), para a proxima execucao nao aceitar o `max` como escolha do dono.
# O container NAO e parado nesses casos: o agente principal atende gente, e parar um agente e decisao do dono, nao do reparar.
limites_ajustar_existente() {
    local c="dgclaw-$1" args=() grupos=() f sw id
    limites_calcular "$1"
    if [ "$ENSAIO" = 1 ]; then
        info "limites calculados para esta maquina: memoria $LIM_MEM_ARG, CPUs $LIM_CPUS_ARG, processos $LIMITE_PIDS ($LIM_PAPEL)"
        return 0
    fi
    limites_relatar "$c" "$1"
    _LIM_PEND_SLUG="$1"
    id="$(podman inspect -f '{{.Id}}' "$c" 2>/dev/null)" || id=""
    case "$id" in
        ''|*[!A-Za-z0-9._-]*)
            aviso "nao consegui ler o ID do container $c. Os limites ficam como estao; para conferir: podman inspect $c"
            return 0 ;;
    esac
    if ! limites_ler_atuais "$id"; then
        aviso "nao consegui ler os limites atuais do container $c (cgroup do host). Os limites ficam como estao; para conferir: podman inspect $c"
        return 0
    fi
    info "antes:  $(_limites_resumo_atual)"
    [ "$ATU_MEM_OK" = 1 ] || aviso "nao consegui ler a memoria do container $c (memory.max e memory.swap.max no cgroup do host); ela nao foi ajustada."
    [ "$ATU_CPU_OK" = 1 ] || aviso "nao consegui ler as CPUs do container $c (cpu.max no cgroup do host); elas nao foram ajustadas."
    [ "$ATU_PIDS_OK" = 1 ] || aviso "nao consegui ler o limite de processos do container $c (pids.max no cgroup do host); ele nao foi ajustado."
    # Pendencia de um recurso que ja esta finito e nao abaixo do calculado: resolvida (alguem ou algo devolveu o limite).
    if _limites_pend_tem memoria && [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ] && ! _limites_mem_valor_abaixo; then _limites_pend_limpar memoria; fi
    if _limites_pend_tem cpu && [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ] && ! _limites_cpu_valor_abaixo; then _limites_pend_limpar cpu; fi
    if _limites_pend_tem pids && [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ] && ! _limites_pids_valor_abaixo; then _limites_pend_limpar pids; fi
    local pend_ini=""
    _limites_pend_tem memoria && pend_ini="$pend_ini memoria"
    _limites_pend_tem cpu && pend_ini="$pend_ini cpu"
    _limites_pend_tem pids && pend_ini="$pend_ini pids"
    local swap_antes_b="$ATU_SWAP_B" swap_ilim_antes="$ATU_SWAP_ILIM"
    local leu_mem_antes="$ATU_MEM_OK" leu_cpu_antes="$ATU_CPU_OK" leu_pids_antes="$ATU_PIDS_OK"
    # O que era FINITO (lido e sem `max`) antes do update: se algum virar sem limite depois, e falha.
    local fin_mem_antes=0 fin_swap_antes=0 fin_cpu_antes=0 fin_pids_antes=0
    [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ] && fin_mem_antes=1
    [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_SWAP_ILIM" != 1 ] && fin_swap_antes=1
    [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ] && fin_cpu_antes=1
    [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ] && fin_pids_antes=1
    local quer_mem=0 quer_cpu=0 quer_pids=0 mantidos=()
    local mem_antes_b="$ATU_MEM_B" cpu_quota_antes="$ATU_CPU_QUOTA" cpu_periodo_antes="$ATU_CPU_PERIODO" pids_antes="$ATU_PIDS"
    if _limites_mem_abaixo && ! _limites_mem_antiga; then
        mantidos+=("memoria em $(_limites_mb_texto "$ATU_MEM_MB")")
    elif _limites_mem_abaixo; then
        # O swap vai antes da memoria (o limite de memoria nao pode passar do de memoria+swap) e mantem a politica de swap
        # vigente. O --memory-swap do podman e memoria+swap e o memory.swap.max do cgroup e so o swap: ilimitado continua
        # ilimitado (-1); senao vale memoria nova + o swap que ja tinha (0 = continua sem swap), tudo em bytes.
        if [ "$ATU_SWAP_ILIM" = 1 ]; then sw="-1"; else sw="$((LIM_MEM_MB * 1048576 + ATU_SWAP_B))"; fi
        grupos+=("--memory-swap=$sw --memory=${LIM_MEM_MB}m"); quer_mem=1
    fi
    if _limites_cpu_abaixo && ! _limites_cpu_antiga; then
        mantidos+=("CPUs em $((ATU_CPUS_DEC / 10)).$((ATU_CPUS_DEC % 10))")
    elif _limites_cpu_abaixo; then grupos+=("--cpus=$LIM_CPUS_ARG"); quer_cpu=1; fi
    if _limites_pids_abaixo && ! _limites_pids_antigo; then
        mantidos+=("processos em $ATU_PIDS")
    elif _limites_pids_abaixo; then grupos+=("--pids-limit=$LIMITE_PIDS"); quer_pids=1; fi
    for f in "${mantidos[@]}"; do
        info "mantido: $f no container $c. Esse valor nao e o padrao antigo do DG Claw (2 GB, 1.0 CPU, 1024 processos), entao conta como escolha do dono e nao foi mexido."
    done
    if [ "${#grupos[@]}" -eq 0 ]; then
        if [ "${#mantidos[@]}" -gt 0 ]; then
            ok "nada foi mudado: os limites abaixo do calculado ($(_limites_resumo "$LIM_MEM_MB" "$LIM_CPUS_DEC" "$LIMITE_PIDS")) sao escolha do dono e ficam como estao"
        else
            ok "os limites do container ja estao iguais ou acima do calculado ($(_limites_resumo "$LIM_MEM_MB" "$LIM_CPUS_DEC" "$LIMITE_PIDS")); nada foi mudado"
        fi
        return 0
    fi
    # Os grupos sao palavras sem espaco dentro (valores numericos), entao a divisao sem aspas e segura.
    # shellcheck disable=SC2206
    for f in "${grupos[@]}"; do args+=($f); done
    if ! podman update "${args[@]}" "$id" >/dev/null 2>&1; then
        # Um flag que o podman desta maquina nao aceita nao pode impedir os outros: tenta um por vez
        # (memoria e swap sempre juntos, numa chamada so).
        for f in "${grupos[@]}"; do
            # shellcheck disable=SC2086
            podman update $f "$id" >/dev/null 2>&1 || aviso "o podman desta maquina nao aceitou 'podman update $f $c'. Esse limite continua como estava; o valor novo entra na proxima vez que o agente for recriado (por exemplo ao atualizar a imagem com dgclaw atualizar)."
        done
    fi
    _limites_id_confere "$c" "$id" "$1" || return 1
    if ! limites_ler_atuais "$id"; then
        # shellcheck disable=SC2016 # as crases fazem parte do texto
        aviso "FALHA: rodei o podman update em $c, mas nao consegui reler os limites para conferir se deu certo, e nao sei como o container ficou. Confira com: podman inspect $c e rode de novo \`dgclaw agente reparar $1\`."
        return 1
    fi
    info "depois: $(_limites_resumo_atual)"
    local subiram=() abaixo=() sumiram=() falhas=() reduzidos=()
    # Todo controlador que estava legivel antes (ou recebeu ajuste) e nao foi relido agora e FALHA: o teto efetivo dele e
    # desconhecido, mesmo que os outros tenham respondido.
    [ "$leu_mem_antes" = 1 ] && [ "$ATU_MEM_OK" != 1 ] && falhas+=("nao consegui reler a memoria (memory.max e memory.swap.max) do container $c depois do podman update; nao sei como ela ficou")
    [ "$leu_cpu_antes" = 1 ] && [ "$ATU_CPU_OK" != 1 ] && falhas+=("nao consegui reler as CPUs (cpu.max) do container $c depois do podman update; nao sei como elas ficaram")
    [ "$leu_pids_antes" = 1 ] && [ "$ATU_PIDS_OK" != 1 ] && falhas+=("nao consegui reler o limite de processos (pids.max) do container $c depois do podman update; nao sei como ele ficou")
    # Um limite que era finito e foi relido como "max" sumiu (nao e aumento), tenha o reparo querido mexer nele ou nao.
    [ "$fin_mem_antes" = 1 ] && [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" = 1 ] && sumiram+=("memoria")
    [ "$fin_swap_antes" = 1 ] && [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_SWAP_ILIM" = 1 ] && sumiram+=("swap")
    [ "$fin_cpu_antes" = 1 ] && [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" = 1 ] && sumiram+=("CPUs")
    [ "$fin_pids_antes" = 1 ] && [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" = 1 ] && sumiram+=("processos")
    # Valor finito que ficou ABAIXO do que era antes do update (memoria, CPUs por quota/periodo, processos): FALHA, mesmo
    # que ainda esteja acima do pedido ou que o reparo nao tenha pedido esse recurso.
    local red_mem=0 red_cpu=0 red_pids=0 red_txt_mem="" red_txt_cpu="" red_txt_pids=""
    if [ "$fin_mem_antes" = 1 ] && [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ] && [ "$ATU_MEM_B" -lt "$mem_antes_b" ]; then
        red_mem=1; reduzidos+=("memoria"); red_txt_mem="antes $mem_antes_b bytes, relido $ATU_MEM_B bytes"
    fi
    if [ "$fin_cpu_antes" = 1 ] && [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ] \
        && [ $((ATU_CPU_QUOTA * cpu_periodo_antes)) -lt $((cpu_quota_antes * ATU_CPU_PERIODO)) ]; then
        red_cpu=1; reduzidos+=("CPUs"); red_txt_cpu="antes cpu.max de $cpu_quota_antes a cada $cpu_periodo_antes, relido $ATU_CPU_QUOTA a cada $ATU_CPU_PERIODO"
    fi
    if [ "$fin_pids_antes" = 1 ] && [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ] && [ "$ATU_PIDS" -lt "$pids_antes" ]; then
        red_pids=1; reduzidos+=("processos"); red_txt_pids="antes $pids_antes, relido $ATU_PIDS"
    fi
    # Swap que ficou mais permissivo que antes (finito que cresceu, inclusive de 0 a positivo) e falha propria do swap.
    local swap_mais=0
    if [ "$ATU_MEM_OK" = 1 ] && [ "$leu_mem_antes" = 1 ] && [ "$swap_ilim_antes" != 1 ] && [ "$ATU_SWAP_ILIM" != 1 ] \
        && [ "$ATU_SWAP_B" -gt "$swap_antes_b" ]; then
        swap_mais=1
        falhas+=("o swap do container $c ficou mais permissivo depois do podman update: esperado no maximo $swap_antes_b bytes, observado $ATU_SWAP_B bytes")
    fi
    if [ "$quer_mem" = 1 ] && [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ]; then
        local mem_pedida=$((LIM_MEM_MB * 1048576))
        if [ "$red_mem" = 1 ]; then
            : # ficou abaixo do que era antes: a falha sai na secao dos reduzidos, junto com a restauracao
        elif [ "$ATU_MEM_B" -gt "$mem_pedida" ]; then
            falhas+=("a memoria do container $c ficou acima do pedido depois do podman update: esperado $mem_pedida bytes, observado $ATU_MEM_B bytes")
        elif [ "$ATU_MEM_B" -eq "$mem_pedida" ]; then
            # Subiu = memoria exatamente no alvo e swap como era (ilimitado continua ilimitado; senao os mesmos bytes).
            if [ "$ATU_SWAP_ILIM" = "$swap_ilim_antes" ] && { [ "$ATU_SWAP_ILIM" = 1 ] || [ "$ATU_SWAP_B" -eq "$swap_antes_b" ]; }; then subiram+=("memoria")
            elif [ "$swap_mais" != 1 ]; then abaixo+=("memoria"); fi
        else abaixo+=("memoria"); fi
    fi
    if [ "$quer_cpu" = 1 ] && [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ]; then
        local cpu_obs=$((ATU_CPU_QUOTA * 10)) cpu_esp=$((LIM_CPUS_DEC * ATU_CPU_PERIODO))
        if [ "$red_cpu" = 1 ]; then
            : # idem
        elif [ $((cpu_obs * 100)) -gt $((cpu_esp * 101)) ]; then
            falhas+=("as CPUs do container $c ficaram acima do pedido depois do podman update: esperado cpu.max de $((cpu_esp / 10)) a cada $ATU_CPU_PERIODO (${LIM_CPUS_ARG} CPUs), observado $ATU_CPU_QUOTA a cada $ATU_CPU_PERIODO")
        elif [ $((cpu_obs * 100)) -ge $((cpu_esp * 99)) ]; then subiram+=("CPUs")
        else abaixo+=("CPUs"); fi
    fi
    if [ "$quer_pids" = 1 ] && [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ]; then
        if [ "$red_pids" = 1 ]; then
            : # idem
        elif [ "$ATU_PIDS" -gt "$LIMITE_PIDS" ]; then
            falhas+=("o limite de processos do container $c ficou acima do pedido depois do podman update: esperado $LIMITE_PIDS, observado $ATU_PIDS")
        elif [ "$ATU_PIDS" -eq "$LIMITE_PIDS" ]; then subiram+=("processos")
        else abaixo+=("processos"); fi
    fi
    # Controlador que nao estava no pedido e era finito antes tem que ser relido igual: mudar de um finito para outro e falha.
    if [ "$quer_mem" != 1 ] && [ "$fin_mem_antes" = 1 ] && [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ] && [ "$ATU_MEM_B" -ne "$mem_antes_b" ]; then
        falhas+=("a memoria do container $c mudou sem ter sido pedida depois do podman update: valor anterior $mem_antes_b bytes, observado $ATU_MEM_B bytes")
    fi
    if [ "$quer_cpu" != 1 ] && [ "$fin_cpu_antes" = 1 ] && [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ] \
        && { [ "$ATU_CPU_QUOTA" -ne "$cpu_quota_antes" ] || [ "$ATU_CPU_PERIODO" -ne "$cpu_periodo_antes" ]; }; then
        falhas+=("as CPUs do container $c mudaram sem ter sido pedidas depois do podman update: cpu.max anterior $cpu_quota_antes a cada $cpu_periodo_antes, observado $ATU_CPU_QUOTA a cada $ATU_CPU_PERIODO")
    fi
    if [ "$quer_pids" != 1 ] && [ "$fin_pids_antes" = 1 ] && [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ] && [ "$ATU_PIDS" -ne "$pids_antes" ]; then
        falhas+=("o limite de processos do container $c mudou sem ter sido pedido depois do podman update: valor anterior $pids_antes, observado $ATU_PIDS")
    fi
    # Recurso com pendencia que continua sem limite depois do update: o ajuste nao pegou, e a pendencia fica.
    local continua=()
    _limites_em "$pend_ini" memoria && [ "$quer_mem" = 1 ] && [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" = 1 ] && continua+=("memoria")
    _limites_em "$pend_ini" cpu && [ "$quer_cpu" = 1 ] && [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" = 1 ] && continua+=("CPUs")
    _limites_em "$pend_ini" pids && [ "$quer_pids" = 1 ] && [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" = 1 ] && continua+=("processos")

    # O que o cgroup mostra agora, guardado ANTES da restauracao (ela le o cgroup de novo e sobrescreve ATU_*).
    local fin_mem_depois=0 fin_cpu_depois=0 fin_pids_depois=0
    [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ] && fin_mem_depois=1
    [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ] && fin_cpu_depois=1
    [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ] && fin_pids_depois=1
    # Restauracao: o que sumiu ou ficou abaixo do que era antes volta ao valor de antes.
    local restaurar="" r
    _limites_em "${sumiram[*]:-}" memoria || _limites_em "${sumiram[*]:-}" swap || [ "$red_mem" = 1 ] && restaurar="$restaurar memoria"
    _limites_em "${sumiram[*]:-}" CPUs || [ "$red_cpu" = 1 ] && restaurar="$restaurar cpu"
    _limites_em "${sumiram[*]:-}" processos || [ "$red_pids" = 1 ] && restaurar="$restaurar pids"
    REST_OK=""; REST_FALHOU=""; PEND_GRAVADAS=""
    if [ -n "$restaurar" ]; then
        # shellcheck disable=SC2086 # a lista e de palavras simples
        _limites_restaurar "$id" $restaurar
        info "depois da restauracao: $(_limites_resumo_atual)"
        for r in $restaurar; do
            if _limites_em "$REST_OK" "$r"; then continue; fi
            if _limites_pend_gravar "$r"; then PEND_GRAVADAS="$PEND_GRAVADAS $r"; fi
        done
    fi
    # Pendencia que valia no comeco e se resolveu: o limite esta finito de novo e este reparo nao falhou nesse recurso.
    for r in $pend_ini; do
        if _limites_em "$restaurar" "$r"; then continue; fi
        case "$r" in
            memoria) [ "$fin_mem_depois" = 1 ] && _limites_pend_limpar memoria ;;
            cpu) [ "$fin_cpu_depois" = 1 ] && _limites_pend_limpar cpu ;;
            pids) [ "$fin_pids_depois" = 1 ] && _limites_pend_limpar pids ;;
        esac
    done
    local rc=0
    for f in "${falhas[@]}"; do
        aviso "FALHA: $f. Veja com: podman inspect $c"
        rc=1
    done
    local det rk ant txt
    for f in "${reduzidos[@]}"; do
        case "$f" in
            memoria) rk=memoria; ant="$mem_antes_b bytes"; txt="$red_txt_mem" ;;
            CPUs) rk=cpu; ant="cpu.max de $cpu_quota_antes a cada $cpu_periodo_antes"; txt="$red_txt_cpu" ;;
            processos) rk=pids; ant="$pids_antes"; txt="$red_txt_pids" ;;
        esac
        det="$(_limites_det_restauracao "$1" "$rk" "$f" "$ant")"
        aviso "FALHA: $f do container $c ficou abaixo do que era antes do podman update ($txt). $det O container nao foi parado. Veja com: podman inspect $c"
        rc=1
    done
    for f in "${sumiram[@]}"; do
        case "$f" in
            memoria|swap) rk=memoria; ant="$mem_antes_b bytes de memoria" ;;
            CPUs) rk=cpu; ant="cpu.max de $cpu_quota_antes a cada $cpu_periodo_antes" ;;
            processos) rk=pids; ant="$pids_antes" ;;
        esac
        det="$(_limites_det_restauracao "$1" "$rk" "$f" "$ant")"
        # shellcheck disable=SC2016 # as crases fazem parte do texto
        aviso "FALHA: o limite de $f do container $c sumiu. Era finito e, depois do podman update, o cgroup passou a mostrar sem limite (max); isso nao e um aumento. $det O container nao foi parado. Se o limite continuar sumindo, recrie o agente: \`dgclaw agente recriar $1 --forcar\` (com a imagem atual, sem o --forcar o recriar responde \"nada a recriar\"). O --forcar tambem pula a conferencia de arquivos que so existem dentro do container, entao copie para a casa do agente antes o que precisar guardar. Depois confira o teto com \`dgclaw agente reparar $1\`. Veja com: podman inspect $c"
        rc=1
    done
    for f in "${continua[@]}"; do
        # shellcheck disable=SC2016 # as crases fazem parte do texto
        aviso "FALHA: o container $c continua sem limite de $f depois do podman update, e esse recurso tem uma pendencia em $(_limites_pend_arq) (um ajuste anterior o deixou sem limite). A pendencia fica: \`dgclaw agente reparar $1\` vai tentar aplicar o limite de novo, e ela so some quando o limite aparecer finito. Se continuar assim, recrie o agente: \`dgclaw agente recriar $1 --forcar\`. Veja com: podman inspect $c"
        rc=1
    done
    for f in "${abaixo[@]}"; do
        aviso "$f do container $c continuou abaixo do calculado depois do podman update. O limite definitivo entra na proxima vez que o agente for recriado (por exemplo ao atualizar a imagem com dgclaw atualizar)."
    done
    if [ "${#subiram[@]}" -gt 0 ]; then
        ok "subiram em $c: ${subiram[*]}. O ajuste vale para o container ligado; o limite definitivo entra na proxima vez que o agente for recriado (por exemplo ao atualizar a imagem com dgclaw atualizar)."
        if [ "$LIM_PAPEL" = principal ] && [[ " ${subiram[*]} " == *" memoria "* ]]; then
            # shellcheck disable=SC2016 # as crases fazem parte do texto
            info "o agente $1 e o principal: o podman nao guarda o ajuste de memoria quando o servidor ou o container reinicia. Para o novo limite sobreviver a um reinicio, rode \`dgclaw agente recriar $1 --forcar\` (sem o --forcar, com a imagem atual, o recriar responde \"nada a recriar\"; o --forcar pula a conferencia de arquivos que so existem dentro do container, entao copie para a casa do agente antes o que precisar guardar)."
        fi
    fi
    _limites_id_confere "$c" "$id" "$1" || rc=1
    return "$rc"
}
