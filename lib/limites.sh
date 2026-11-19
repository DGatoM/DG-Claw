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

# limites_calcular: preenche LIM_MEM_MB (inteiro), LIM_MEM_ARG (valor do --memory), LIM_CPUS_DEC (decimos de CPU,
# inteiro) e LIM_CPUS_ARG (valor do --cpus). Valor estranho em variavel de sobrescrita e erro, nao palpite.
# shellcheck disable=SC2034 # lidas por quem carrega este arquivo
limites_calcular() {
    local total_kb="" n mb dec cfg_mem cfg_cpus
    # Mesmo leitor e mesma precedencia em criar, recriar e reparar (ver _limites_valor_configurado).
    cfg_mem="$(_limites_valor_configurado DGCLAW_CONTAINER_MEMORIA "$_LIM_AMB_MEMORIA")"
    cfg_cpus="$(_limites_valor_configurado DGCLAW_CONTAINER_CPUS "$_LIM_AMB_CPUS")"
    if [ -r "$R/proc/meminfo" ]; then
        total_kb="$(awk '/^MemTotal:/ { print $2; exit }' "$R/proc/meminfo" 2>/dev/null)"
    fi
    case "$total_kb" in ''|*[!0-9]*) total_kb=0 ;; esac
    mb=$((total_kb * 75 / 100 / 1024))
    [ "$mb" -ge "$LIMITE_MEM_PISO_MB" ] || mb="$LIMITE_MEM_PISO_MB"
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

# Predicados "abaixo do alvo" sobre o que limites_ler_atuais leu (sem leitura nao conta).
# Recurso SEM LIMITE (max, flag ILIM) nunca esta abaixo do alvo: o reparar nao o converte em teto finito. Um teto finito
# igual a zero (0 literal no cgroup) e escolha do dono, como qualquer outro valor que nao e o padrao antigo.
_limites_mem_abaixo() { [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ] && [ "$ATU_MEM_B" -lt $((LIM_MEM_MB * 1048576)) ]; }
_limites_cpu_abaixo() { [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ] && [ $((ATU_CPU_QUOTA * 10)) -lt $((LIM_CPUS_DEC * ATU_CPU_PERIODO)) ]; }
_limites_pids_abaixo() { [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ] && [ "$ATU_PIDS" -lt "$LIMITE_PIDS" ]; }

# O padrao antigo do DG Claw (antes do calculo pela maquina): 2 GiB, 1.0 CPU e 1024 processos. O reparar so mexe num recurso
# que ainda esta nesse valor; qualquer outro valor (acima ou abaixo do calculado) conta como escolha do dono.
_limites_mem_antiga() { [ "$ATU_MEM_ILIM" != 1 ] && [ "$ATU_MEM_B" -eq 2147483648 ]; }
_limites_cpu_antiga() { [ "$ATU_CPU_ILIM" != 1 ] && [ "$ATU_CPU_QUOTA" -eq "$ATU_CPU_PERIODO" ]; }
_limites_pids_antigo() { [ "$ATU_PIDS_ILIM" != 1 ] && [ "$ATU_PIDS" -eq 1024 ]; }

# limites_ajustar_existente <slug>: poe o container que ja existe no limite calculado, SEM recriar, com
# `podman update`. So sobe o que ainda esta no padrao antigo do DG Claw (2 GiB, 1.0 CPU, 1024 processos); o que esta sem limite
# (max) fica sem limite, e qualquer outro valor (a pessoa aumentou ou diminuiu a mao) fica como esta, e o log diz que foi mantido e por que. Se o podman
# da maquina nao tem o `update` ou nao aceita um dos flags, avisa e segue (nunca derruba o reparar). O resultado de
# cada recurso vem da RELEITURA do cgroup depois do update, nao do codigo de saida do podman.
limites_ajustar_existente() {
    local c="dgclaw-$1" args=() grupos=() f sw
    limites_calcular
    if [ "$ENSAIO" = 1 ]; then
        info "limites calculados para esta maquina: memoria $LIM_MEM_ARG, CPUs $LIM_CPUS_ARG, processos $LIMITE_PIDS"
        return 0
    fi
    if ! limites_ler_atuais "$c"; then
        aviso "nao consegui ler os limites atuais do container $c (cgroup do host). Os limites ficam como estao; para conferir: podman inspect $c"
        return 0
    fi
    info "antes:  $(_limites_resumo_atual)"
    [ "$ATU_MEM_OK" = 1 ] || aviso "nao consegui ler a memoria do container $c (memory.max e memory.swap.max no cgroup do host); ela nao foi ajustada."
    [ "$ATU_CPU_OK" = 1 ] || aviso "nao consegui ler as CPUs do container $c (cpu.max no cgroup do host); elas nao foram ajustadas."
    [ "$ATU_PIDS_OK" = 1 ] || aviso "nao consegui ler o limite de processos do container $c (pids.max no cgroup do host); ele nao foi ajustado."
    local swap_antes_b="$ATU_SWAP_B" swap_ilim_antes="$ATU_SWAP_ILIM"
    local leu_mem_antes="$ATU_MEM_OK" leu_cpu_antes="$ATU_CPU_OK" leu_pids_antes="$ATU_PIDS_OK"
    # O que era FINITO (lido e sem `max`) antes do update: se algum virar sem limite depois, e falha.
    local fin_mem_antes=0 fin_swap_antes=0 fin_cpu_antes=0 fin_pids_antes=0
    [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ] && fin_mem_antes=1
    [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_SWAP_ILIM" != 1 ] && fin_swap_antes=1
    [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ] && fin_cpu_antes=1
    [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ] && fin_pids_antes=1
    local quer_mem=0 quer_cpu=0 quer_pids=0 mantidos=()
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
    if ! podman update "${args[@]}" "$c" >/dev/null 2>&1; then
        # Um flag que o podman desta maquina nao aceita nao pode impedir os outros: tenta um por vez
        # (memoria e swap sempre juntos, numa chamada so).
        for f in "${grupos[@]}"; do
            # shellcheck disable=SC2086
            podman update $f "$c" >/dev/null 2>&1 || aviso "o podman desta maquina nao aceitou 'podman update $f $c'. Esse limite continua como estava; o valor novo entra na proxima vez que o agente for recriado (por exemplo ao atualizar a imagem com dgclaw atualizar)."
        done
    fi
    if ! limites_ler_atuais "$c"; then
        aviso "FALHA: rodei o podman update em $c, mas nao consegui reler os limites para conferir se deu certo, e nao sei como o container ficou. Confira com: podman inspect $c e rode de novo \`dgclaw agente reparar $1\`."
        return 1
    fi
    info "depois: $(_limites_resumo_atual)"
    local subiram=() abaixo=() sumiram=() falhas=()
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
    # Swap que ficou mais permissivo que antes (finito que cresceu, inclusive de 0 a positivo) e falha propria do swap.
    local swap_mais=0
    if [ "$ATU_MEM_OK" = 1 ] && [ "$leu_mem_antes" = 1 ] && [ "$swap_ilim_antes" != 1 ] && [ "$ATU_SWAP_ILIM" != 1 ] \
        && [ "$ATU_SWAP_B" -gt "$swap_antes_b" ]; then
        swap_mais=1
        falhas+=("o swap do container $c ficou mais permissivo depois do podman update: esperado no maximo $swap_antes_b bytes, observado $ATU_SWAP_B bytes")
    fi
    if [ "$quer_mem" = 1 ] && [ "$ATU_MEM_OK" = 1 ] && [ "$ATU_MEM_ILIM" != 1 ]; then
        local mem_pedida=$((LIM_MEM_MB * 1048576))
        if [ "$ATU_MEM_B" -gt "$mem_pedida" ]; then
            falhas+=("a memoria do container $c ficou acima do pedido depois do podman update: esperado $mem_pedida bytes, observado $ATU_MEM_B bytes")
        elif [ "$ATU_MEM_B" -eq "$mem_pedida" ]; then
            # Subiu = memoria exatamente no alvo e swap como era (ilimitado continua ilimitado; senao os mesmos bytes).
            if [ "$ATU_SWAP_ILIM" = "$swap_ilim_antes" ] && { [ "$ATU_SWAP_ILIM" = 1 ] || [ "$ATU_SWAP_B" -eq "$swap_antes_b" ]; }; then subiram+=("memoria")
            elif [ "$swap_mais" != 1 ]; then abaixo+=("memoria"); fi
        else abaixo+=("memoria"); fi
    fi
    if [ "$quer_cpu" = 1 ] && [ "$ATU_CPU_OK" = 1 ] && [ "$ATU_CPU_ILIM" != 1 ]; then
        local cpu_obs=$((ATU_CPU_QUOTA * 10)) cpu_esp=$((LIM_CPUS_DEC * ATU_CPU_PERIODO))
        if [ $((cpu_obs * 100)) -gt $((cpu_esp * 101)) ]; then
            falhas+=("as CPUs do container $c ficaram acima do pedido depois do podman update: esperado cpu.max de $((cpu_esp / 10)) a cada $ATU_CPU_PERIODO (${LIM_CPUS_ARG} CPUs), observado $ATU_CPU_QUOTA a cada $ATU_CPU_PERIODO")
        elif [ $((cpu_obs * 100)) -ge $((cpu_esp * 99)) ]; then subiram+=("CPUs")
        else abaixo+=("CPUs"); fi
    fi
    if [ "$quer_pids" = 1 ] && [ "$ATU_PIDS_OK" = 1 ] && [ "$ATU_PIDS_ILIM" != 1 ]; then
        if [ "$ATU_PIDS" -gt "$LIMITE_PIDS" ]; then
            falhas+=("o limite de processos do container $c ficou acima do pedido depois do podman update: esperado $LIMITE_PIDS, observado $ATU_PIDS")
        elif [ "$ATU_PIDS" -eq "$LIMITE_PIDS" ]; then subiram+=("processos")
        else abaixo+=("processos"); fi
    fi
    local rc=0
    for f in "${falhas[@]}"; do
        aviso "FALHA: $f. Veja com: podman inspect $c"
        rc=1
    done
    for f in "${sumiram[@]}"; do
        # shellcheck disable=SC2016 # as crases fazem parte do texto
        aviso "FALHA: o limite de $f do container $c sumiu. Era finito e, depois do podman update, o cgroup passou a mostrar sem limite (max); isso nao e um aumento. Rodar \`dgclaw agente reparar $1\` de novo nao devolve o limite (ele passaria a tratar o sem limite como escolha sua). Para o teto voltar, recrie o agente: \`dgclaw agente recriar $1\`. Veja com: podman inspect $c"
        rc=1
    done
    for f in "${abaixo[@]}"; do
        aviso "$f do container $c continuou abaixo do calculado depois do podman update. O limite definitivo entra na proxima vez que o agente for recriado (por exemplo ao atualizar a imagem com dgclaw atualizar)."
    done
    if [ "${#subiram[@]}" -gt 0 ]; then
        ok "subiram em $c: ${subiram[*]}. O ajuste vale para o container ligado; o limite definitivo entra na proxima vez que o agente for recriado (por exemplo ao atualizar a imagem com dgclaw atualizar)."
    fi
    return "$rc"
}
