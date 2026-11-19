# shellcheck shell=bash
# lib/limites.sh: limites de memoria e de CPU dos containers dos agentes (carregado com source por bin/dgclaw).
#
# O container do agente nasce com um teto de memoria e de CPU. Um teto fixo e pequeno demais numa maquina
# grande (um subagente com imagem passou de 1,2 GB e o cgroup matou o processo) e grande demais numa pequena,
# entao o valor sai do tamanho da VPS:
#   memoria = o maior entre 2 GB e 75% da RAM total (le $R/proc/meminfo);
#   CPUs    = o maior entre 1.0 e (nucleos - 0.2), com uma casa decimal (le `nproc`).
# O piso (2 GB e 1.0) e o valor que o DG Claw usava antes. A sobra (25% da RAM e 0.2 CPU) fica para o servidor e
# para o Admin. Quem quiser outro valor define no /etc/dgclaw/dgclaw.env:
#   DGCLAW_CONTAINER_MEMORIA=4g     (numero seguido de m ou g)
#   DGCLAW_CONTAINER_CPUS=1.5       (numero com ate uma casa decimal)
# O limite de processos nao entra aqui: e fixo em LIMITE_PIDS.

LIMITE_PIDS=4096
LIMITE_MEM_PISO_MB=2048

# limites_calcular: preenche LIM_MEM_MB (inteiro), LIM_MEM_ARG (valor do --memory), LIM_CPUS_DEC (decimos de CPU,
# inteiro) e LIM_CPUS_ARG (valor do --cpus). Valor estranho em variavel de sobrescrita e erro, nao palpite.
# shellcheck disable=SC2034 # lidas por quem carrega este arquivo
limites_calcular() {
    local total_kb="" n mb dec
    if [ -r "$R/proc/meminfo" ]; then
        total_kb="$(awk '/^MemTotal:/ { print $2; exit }' "$R/proc/meminfo" 2>/dev/null)"
    fi
    case "$total_kb" in ''|*[!0-9]*) total_kb=0 ;; esac
    mb=$((total_kb * 75 / 100 / 1024))
    [ "$mb" -ge "$LIMITE_MEM_PISO_MB" ] || mb="$LIMITE_MEM_PISO_MB"
    LIM_MEM_MB="$mb"
    LIM_MEM_ARG="${mb}m"
    if [ -n "${DGCLAW_CONTAINER_MEMORIA:-}" ]; then
        case "$DGCLAW_CONTAINER_MEMORIA" in
            [1-9]*[mg]) ;;
            *) falha "DGCLAW_CONTAINER_MEMORIA='$DGCLAW_CONTAINER_MEMORIA' (em $DG_ETC/dgclaw.env ou no ambiente) nao serve: precisa ser um numero inteiro seguido de m ou g, como 4g ou 3072m." \
                "corrija a linha, por exemplo DGCLAW_CONTAINER_MEMORIA=4g, ou apague-a para o DG Claw calcular pelo tamanho da maquina." ;;
        esac
        case "${DGCLAW_CONTAINER_MEMORIA%[mg]}" in *[!0-9]*) falha "DGCLAW_CONTAINER_MEMORIA='$DGCLAW_CONTAINER_MEMORIA' nao serve: so digitos antes do m ou do g." "use por exemplo 4g." ;; esac
        LIM_MEM_ARG="$DGCLAW_CONTAINER_MEMORIA"
        LIM_MEM_MB="${DGCLAW_CONTAINER_MEMORIA%[mg]}"
        [ "${DGCLAW_CONTAINER_MEMORIA: -1}" = g ] && LIM_MEM_MB=$((LIM_MEM_MB * 1024))
    fi
    n="$(nproc 2>/dev/null || true)"
    case "$n" in ''|*[!0-9]*|0) n=1 ;; esac
    dec=$((n * 10 - 2))
    [ "$dec" -ge 10 ] || dec=10
    LIM_CPUS_DEC="$dec"
    LIM_CPUS_ARG="$((dec / 10)).$((dec % 10))"
    if [ -n "${DGCLAW_CONTAINER_CPUS:-}" ]; then
        case "$DGCLAW_CONTAINER_CPUS" in
            [0-9]|[0-9][0-9]|[0-9].[0-9]|[0-9][0-9].[0-9]) ;;
            *) falha "DGCLAW_CONTAINER_CPUS='$DGCLAW_CONTAINER_CPUS' (em $DG_ETC/dgclaw.env ou no ambiente) nao serve: precisa ser um numero com ate uma casa decimal, como 2 ou 1.5." \
                "corrija a linha, por exemplo DGCLAW_CONTAINER_CPUS=1.5, ou apague-a para o DG Claw calcular pelo tamanho da maquina." ;;
        esac
        dec="${DGCLAW_CONTAINER_CPUS/./}"
        case "$DGCLAW_CONTAINER_CPUS" in *.*) ;; *) dec="${dec}0" ;; esac
        [ "$((10#$dec))" -gt 0 ] || falha "DGCLAW_CONTAINER_CPUS='$DGCLAW_CONTAINER_CPUS' nao serve: precisa ser maior que zero." "use por exemplo 1.5."
        LIM_CPUS_DEC="$((10#$dec))"
        LIM_CPUS_ARG="$((LIM_CPUS_DEC / 10)).$((LIM_CPUS_DEC % 10))"
    fi
}

_limites_mb_texto() { awk -v mb="$1" 'BEGIN { printf "%.1f GB", mb / 1024 }'; }

# limites_ler_atuais <container>: preenche ATU_MEM_MB, ATU_CPUS_DEC, ATU_PIDS e ATU_SWAP_MB com o que o container tem
# agora (0 = sem limite) e ATU_SWAP_RAW com o MemorySwap cru (-1 = ilimitado, 0 = nao definido). O podman devolve -1
# em CpuQuota, MemorySwap e PidsLimit quando nao ha limite: isso vira 0, nao erro. A CPU arredonda para CIMA (com
# minimo de 1 decimo quando ha quota), para 0.05 CPU nao virar "sem limite". Cada campo e validado sozinho.
# Retorna 1 se o podman nao respondeu ou respondeu algo que nao e numero.
# shellcheck disable=SC2034 # lidas por quem carrega este arquivo
limites_ler_atuais() {
    local c="$1" saida mem quota periodo pids swap
    saida="$(podman inspect -f '{{.HostConfig.Memory}} {{.HostConfig.CpuQuota}} {{.HostConfig.CpuPeriod}} {{.HostConfig.PidsLimit}} {{.HostConfig.MemorySwap}}' "$c" 2>/dev/null)" || return 1
    read -r mem quota periodo pids swap <<<"$saida"
    case "$mem" in ''|*[!0-9]*) return 1 ;; esac
    case "$periodo" in ''|*[!0-9]*) return 1 ;; esac
    case "$quota" in -1) quota=0 ;; ''|*[!0-9]*) return 1 ;; esac
    case "$pids" in -1) pids=0 ;; ''|*[!0-9]*) return 1 ;; esac
    case "$swap" in -1) ;; ''|*[!0-9]*) return 1 ;; esac
    ATU_MEM_MB=$((mem / 1048576))
    ATU_CPUS_DEC=0
    if [ "$quota" -gt 0 ] && [ "$periodo" -gt 0 ]; then
        ATU_CPUS_DEC=$(((quota * 10 + periodo - 1) / periodo))
        [ "$ATU_CPUS_DEC" -ge 1 ] || ATU_CPUS_DEC=1
    fi
    ATU_PIDS="$pids"
    ATU_SWAP_RAW="$swap"
    ATU_SWAP_MB=0
    if [ "$swap" != -1 ] && [ "$swap" -gt 0 ]; then ATU_SWAP_MB=$((swap / 1048576)); fi
}

_limites_resumo() {
    local mem="sem limite" cpus="sem limite" pids="sem limite"
    [ "$1" -gt 0 ] && mem="$(_limites_mb_texto "$1")"
    [ "$2" -gt 0 ] && cpus="$(( $2 / 10 )).$(( $2 % 10 ))"
    [ "$3" -gt 0 ] && pids="$3"
    printf 'memoria %s, CPUs %s, processos %s' "$mem" "$cpus" "$pids"
}

# limites_ajustar_existente <slug>: poe o container que ja existe no limite calculado, SEM recriar, com
# `podman update`. So sobe: o que a pessoa aumentou a mao (ou o que esta sem limite) nao e tocado. Se o podman
# da maquina nao tem o `update` ou nao aceita um dos flags, avisa e segue (nunca derruba o reparar).
limites_ajustar_existente() {
    local slug="$1" c="dgclaw-$1" args=() grupos=() ok_flags=() f sw
    limites_calcular
    if [ "$ENSAIO" = 1 ]; then
        info "limites calculados para esta maquina: memoria $LIM_MEM_ARG, CPUs $LIM_CPUS_ARG, processos $LIMITE_PIDS"
        return 0
    fi
    if ! limites_ler_atuais "$c"; then
        aviso "nao consegui ler os limites atuais do container $c (podman inspect). Os limites ficam como estao; para conferir: podman inspect $c"
        return 0
    fi
    info "antes:  $(_limites_resumo "$ATU_MEM_MB" "$ATU_CPUS_DEC" "$ATU_PIDS")"
    if [ "$ATU_MEM_MB" -gt 0 ] && [ "$ATU_MEM_MB" -lt "$LIM_MEM_MB" ]; then
        # O swap vai antes da memoria (o limite de memoria nao pode passar do de memoria+swap) e mantem a politica de
        # swap que o container ja tem: ilimitado continua ilimitado, sem swap continua sem swap, e com swap mantem a mesma folga.
        if [ "$ATU_SWAP_RAW" = -1 ]; then sw="-1"
        elif [ "$ATU_SWAP_RAW" = 0 ]; then sw="$((LIM_MEM_MB * 2))m"
        elif [ "$ATU_SWAP_MB" -le "$ATU_MEM_MB" ]; then sw="${LIM_MEM_MB}m"
        else sw="$((LIM_MEM_MB + ATU_SWAP_MB - ATU_MEM_MB))m"; fi
        grupos+=("--memory-swap=$sw --memory=${LIM_MEM_MB}m")
    fi
    if [ "$ATU_CPUS_DEC" -gt 0 ] && [ "$ATU_CPUS_DEC" -lt "$LIM_CPUS_DEC" ]; then grupos+=("--cpus=$LIM_CPUS_ARG"); fi
    if [ "$ATU_PIDS" -gt 0 ] && [ "$ATU_PIDS" -lt "$LIMITE_PIDS" ]; then grupos+=("--pids-limit=$LIMITE_PIDS"); fi
    if [ "${#grupos[@]}" -eq 0 ]; then
        ok "os limites do container ja estao iguais ou acima do calculado ($(_limites_resumo "$LIM_MEM_MB" "$LIM_CPUS_DEC" "$LIMITE_PIDS")); nada foi mudado"
        return 0
    fi
    # Os grupos sao palavras sem espaco dentro (valores numericos), entao a divisao sem aspas e segura.
    # shellcheck disable=SC2206
    for f in "${grupos[@]}"; do args+=($f); done
    if podman update "${args[@]}" "$c" >/dev/null 2>&1; then
        ok "limites do container $c aumentados sem recriar"
    else
        # Um flag que o podman desta maquina nao aceita nao pode impedir os outros: tenta um por vez
        # (memoria e swap sempre juntos, numa chamada so).
        for f in "${grupos[@]}"; do
            # shellcheck disable=SC2086
            if podman update $f "$c" >/dev/null 2>&1; then ok_flags+=("$f")
            else aviso "o podman desta maquina nao aceitou 'podman update $f $c'. Esse limite continua como estava; para aplicar, recrie o agente: dgclaw agente recriar $slug"; fi
        done
        [ "${#ok_flags[@]}" -eq 0 ] || ok "aplicado: ${ok_flags[*]}"
    fi
    if limites_ler_atuais "$c"; then info "depois: $(_limites_resumo "$ATU_MEM_MB" "$ATU_CPUS_DEC" "$ATU_PIDS")"; fi
}

# limites_abaixo_do_calculado <container>: retorna 0 se memoria, CPU ou processos do container existente estao
# ABAIXO do calculado (mesmo criterio de limites_ajustar_existente; sem limite nao conta). Exige limites_calcular antes.
# Retorna 1 se estao em dia ou se nao deu para ler.
limites_abaixo_do_calculado() {
    limites_ler_atuais "$1" || return 1
    { [ "$ATU_MEM_MB" -gt 0 ] && [ "$ATU_MEM_MB" -lt "$LIM_MEM_MB" ]; } && return 0
    { [ "$ATU_CPUS_DEC" -gt 0 ] && [ "$ATU_CPUS_DEC" -lt "$LIM_CPUS_DEC" ]; } && return 0
    { [ "$ATU_PIDS" -gt 0 ] && [ "$ATU_PIDS" -lt "$LIMITE_PIDS" ]; } && return 0
    return 1
}
