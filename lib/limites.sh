# shellcheck shell=bash
# lib/limites.sh: limites de memoria e de CPU dos containers dos agentes (carregado com source por bin/dgclaw).
#
# O container do agente nasce com um teto de memoria e de CPU. Um teto fixo e pequeno demais numa maquina
# grande (um subagente com imagem passou de 1,2 GB e o cgroup matou o processo), e dividir a RAM de antemao entre os
# agentes deixava quem tem varios com 1 a 2 GB em cada um. O desenho agora e este (RAM total em $R/proc/meminfo):
#   RESERVA   = o maior entre 1536 MB e 15% da RAM, para o sistema e para os servicos do DG Claw (painel, Admin, rondas);
#   --memory  = o maior entre 2048 MB e RAM - reserva, para TODO agente (principal e adicional). Nao e uma divisao: e so a
#               protecao da maquina contra um agente que enlouquece. Os agentes usam a memoria livre, quem precisar pega;
#   PRINCIPAL = o primeiro agente criado que ainda existe (o de menor numero no registro.tsv, 3a coluna; o agentes.json
#               nao serve de ordem, porque agentes_registrar move o slug para o fim). E o protegido:
#                 --oom-score-adj -900 (o ultimo que o kernel mata),
#                 --memory-reservation = garantia G = 50% de (RAM - reserva), no minimo 1024 MB e nunca acima do --memory
#                   (vira memory.low no cgroup do container),
#                 --cgroup-parent dgclaw_principal.slice, com MemoryLow=G no arquivo $R/etc/systemd/system/dgclaw_principal.slice.
#                   O nome tem sublinhado e nao hifen de proposito: hifen em nome de slice cria hierarquia, e o pai teria
#                   memory.low 0, que anula a protecao (no cgroup v2 o memory.low do filho so vale ate o do pai);
#   ADICIONAL = os demais, com o nivel de prioridade que o dono escolheu (dgclaw agente prioridade, guardado em
#               $DG_ETC/prioridades): alta (oom 0, sem memory.high), normal (oom 300, memory.high em 75% do --memory, o padrao)
#               e baixa (oom 700, memory.high em 50%). O principal ignora o nivel;
#   CPUs      = o maior entre 1.0 e (nucleos - 0.2), com uma casa decimal (le `nproc`). Nao depende do papel.
# Sem meminfo o --memory e 2048m e nao ha reservation nem slice.
# Recriar e reparar nunca reduzem a memoria de um agente que ja existe (limites_manter_atual e limites_ajustar_existente).
# O `agente criar` de um agente que nao sera o principal confere o uso real de memoria dos existentes e recusa quando a
# previsao passa do que a maquina tem (limites_conferir_risco); --mesmo-assim segue por conta do dono.
# Quem quiser outro valor define no /etc/dgclaw/dgclaw.env (vale para qualquer agente e vence o calculo e o "nunca reduz"):
#   DGCLAW_CONTAINER_MEMORIA=4g     (numero seguido de m ou g)
#   DGCLAW_CONTAINER_CPUS=1.5       (numero com ate uma casa decimal)
# O limite de processos nao entra aqui: e fixo em LIMITE_PIDS.

LIMITE_PIDS=4096
LIMITE_MEM_PISO_MB=2048          # piso do --memory de qualquer agente
LIMITE_MEM_RESERVA_MIN_MB=1536   # piso da reserva do sistema (a reserva e 15% da RAM quando isso passa disso)
LIMITE_GARANTIA_MIN_MB=1024      # piso da garantia (memory.low) do principal
LIMITE_SLICE_PRINCIPAL="dgclaw_principal.slice"

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
            n="$(awk -F'\t' -v s="$s" '$1 "" == s "" && NF >= 3 && $3 ~ /^[0-9]+$/ {print $3 + 0; exit}' "$DG_REGISTRO")"
        fi
        printf '%s %s\n' "${n:-999999999}" "$s"
    done | sort -k1,1n -k2,2 | head -n 1 | cut -d' ' -f2
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

# DG_PRIORIDADES: o nivel de prioridade de cada agente adicional, uma linha `slug<TAB>nivel` (alta, normal ou baixa), 0600.
# Agente sem linha e normal. O arquivo e editado linha a linha por `dgclaw agente prioridade` (bin/dgclaw).
DG_PRIORIDADES="$DG_ETC/prioridades"

# _limites_nivel_de <slug>: alta, normal ou baixa. Em `agente criar --prioridade`, C_PRIORIDADE vale antes de o arquivo ser gravado.
_limites_nivel_de() {
    local slug="$1" n=""
    if [ -n "${C_PRIORIDADE:-}" ] && [ "${C_SLUG:-}" = "$slug" ]; then
        n="$C_PRIORIDADE"
    elif [ -r "$DG_PRIORIDADES" ]; then
        n="$(awk -F'\t' -v s="$slug" '$1 "" == s "" { n = $2 } END { print n }' "$DG_PRIORIDADES")"
    fi
    case "$n" in alta|normal|baixa) ;; *) n=normal ;; esac
    printf '%s' "$n"
}

# _limites_prioridade <slug>: com LIM_PAPEL, LIM_MEM_MB, LIM_RAM_MB e LIM_RESERVA_MB ja preenchidos, define o que protege o
# container: LIM_NIVEL, LIM_OOM_ADJ, LIM_RESERVA_GARANTIDA_MB (vazio se nao ha), LIM_HIGH_BYTES (vazio se nao ha) e
# LIM_CGROUP_PARENT (vazio se nao ha). Chamada de novo por limites_manter_atual quando o --memory muda.
# shellcheck disable=SC2034 # lidas por quem carrega este arquivo
_limites_prioridade() {
    local slug="$1" g pct=""
    LIM_NIVEL="$(_limites_nivel_de "$slug")"
    LIM_OOM_ADJ=""; LIM_RESERVA_GARANTIDA_MB=""; LIM_HIGH_BYTES=""; LIM_CGROUP_PARENT=""
    if [ "$LIM_PAPEL" = principal ]; then
        LIM_OOM_ADJ=-900
        # Sem meminfo nao ha como medir a garantia: sem reservation e sem slice.
        if [ "$LIM_RAM_MB" -gt 0 ]; then
            g=$(((LIM_RAM_MB - LIM_RESERVA_MB) / 2))
            [ "$g" -ge "$LIMITE_GARANTIA_MIN_MB" ] || g="$LIMITE_GARANTIA_MIN_MB"
            if [ "$LIM_MEM_MB" -gt 0 ] && [ "$g" -gt "$LIM_MEM_MB" ]; then g="$LIM_MEM_MB"; fi
            LIM_RESERVA_GARANTIDA_MB="$g"
            LIM_CGROUP_PARENT="$LIMITE_SLICE_PRINCIPAL"
        fi
    else
        case "$LIM_NIVEL" in
            alta) LIM_OOM_ADJ=0 ;;
            normal) LIM_OOM_ADJ=300; pct=75 ;;
            baixa) LIM_OOM_ADJ=700; pct=50 ;;
        esac
        if [ -n "$pct" ] && [ "$LIM_MEM_MB" -gt 0 ]; then
            LIM_HIGH_BYTES=$((LIM_MEM_MB * 1048576 * pct / 100))
        fi
    fi
}

# limites_calcular <slug>: preenche LIM_MEM_MB (inteiro), LIM_MEM_ARG (valor do --memory), LIM_CPUS_DEC (decimos de CPU,
# inteiro) e LIM_CPUS_ARG (valor do --cpus), mais o que explica a memoria: LIM_PAPEL (principal ou adicional), LIM_RAM_MB,
# LIM_RESERVA_MB, LIM_SOBRESCRITA (0 ou 1) e o que protege o container (ver _limites_prioridade): LIM_NIVEL, LIM_OOM_ADJ,
# LIM_RESERVA_GARANTIDA_MB, LIM_HIGH_BYTES e LIM_CGROUP_PARENT. <slug> pode ser de um agente que ainda nao existe. Valor
# estranho em variavel de sobrescrita e erro, nao palpite. Quem imprime o resultado e limites_relatar.
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
    LIM_RAM_MB="$ram"; LIM_RESERVA_MB="$reserva"; LIM_SOBRESCRITA=0
    if [ "$slug" = "$principal" ]; then LIM_PAPEL=principal; else LIM_PAPEL=adicional; fi
    # Todo agente recebe o mesmo teto, so como protecao: o maior entre 2048 MB e RAM - reserva (sem meminfo, 2048 MB).
    mb="$(_limites_alvo_principal_mb "$ram" "$reserva")"
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
    fi
    _limites_prioridade "$slug"
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

# limites_manter_atual <slug>: o DG Claw nunca reduz a memoria de um agente que ja existe. Chamada pelo recriar depois de
# limites_calcular e ANTES de remover o container: le o --memory atual (cgroup se o container esta ligado; parado, o
# HostConfig.Memory que o podman guardou; 0 ou max = sem limite). Sem sobrescrita: limite finito maior que o calculado
# fica; sem limite continua sem limite (e avisa); menor sobe para o calculado. DGCLAW_CONTAINER_MEMORIA vence tudo isso.
limites_manter_atual() {
    local slug="$1" c="dgclaw-$1" bytes="" mb st
    [ "$ENSAIO" != 1 ] || return 0
    [ "$LIM_SOBRESCRITA" != 1 ] || return 0
    # `container exists` devolve 0 (existe), 1 (nao existe: recriar --forcar de um agente ausente, nada a preservar) ou outro
    # codigo (125: erro do podman). So o 1 libera; qualquer outro falha, porque nao se sabe se o container existe.
    local rc=0 dica="defina DGCLAW_CONTAINER_MEMORIA (por exemplo 4g) em $DG_ETC/dgclaw.env, ou confira com: podman inspect $c, e rode de novo."
    podman container exists "$c" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 1 ]; then return 0; fi
    if [ "$rc" -ne 0 ]; then
        falha "nao consegui saber se o container $c existe (podman container exists terminou com codigo $rc). Para nao arriscar reduzir a memoria dele, o container nao foi parado, removido nem recriado." "$dica"
    fi
    # Primeiro o memory.max do cgroup, lido sozinho (nao depende de o memory.swap.max estar legivel); `max` = sem limite.
    # O HostConfig.Memory so vale para container comprovadamente parado: no podman 4.9 ele e o valor da criacao, e um
    # `podman update` so muda o cgroup, entao num container ligado ele poderia reduzir o limite.
    bytes="$(_limites_cgroup_arquivo "$c" memory.max)" || bytes=""
    if [ "$bytes" = max ]; then bytes=0; fi
    case "$bytes" in ''|*[!0-9]*)
        st="$(podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" || st=""
        case "$st" in
            exited|stopped|created|configured)
                bytes="$(podman inspect -f '{{.HostConfig.Memory}}' "$c" 2>/dev/null)" || bytes=""
                case "$bytes" in ''|*[!0-9]*)
                    falha "nao consegui ler o limite de memoria atual do container parado $c (HostConfig.Memory do podman). Para nao arriscar reduzir a memoria dele, o container nao foi parado, removido nem recriado." "$dica" ;;
                esac ;;
            *)
                falha "nao consegui ler o limite de memoria atual do container $c (memory.max do cgroup), e ele ${st:+esta $st}${st:-esta num estado que nao consegui ler}. Para nao arriscar reduzir a memoria dele, o container nao foi parado, removido nem recriado." "$dica" ;;
        esac ;;
    esac
    bytes=$((10#$bytes))
    if [ "$bytes" -eq 0 ]; then
        LIM_MEM_ARG=""; LIM_MEM_MB=0
        aviso "o container $c esta sem limite de memoria, e o DG Claw nunca reduz o limite de um agente que ja existe: o container novo tambem fica sem teto. Sem teto, um agente descontrolado pode derrubar a maquina inteira. Para botar um teto, defina DGCLAW_CONTAINER_MEMORIA (por exemplo 4g) em $DG_ETC/dgclaw.env e rode: dgclaw agente recriar $slug --forcar"
    elif [ "$bytes" -gt $((LIM_MEM_MB * 1048576)) ]; then
        mb=$(((bytes + 1048575) / 1048576))
        info "mantido o limite atual de $mb MB, maior que o calculado ($LIM_MEM_MB MB); o DG Claw nunca reduz o limite de um agente que ja existe"
        LIM_MEM_MB="$mb"; LIM_MEM_ARG="${mb}m"
    fi
    _limites_prioridade "$slug"
}

# _limites_cgroup_arquivo <container> <arquivo>: imprime o conteudo de um arquivo do cgroup do container (caminho do
# State.CgroupPath, com a mesma validacao de limites_ler_atuais); retorna 1 se nao leu.
_limites_cgroup_arquivo() {
    local cg
    cg="$(podman inspect -f '{{.State.CgroupPath}}' "$1" 2>/dev/null)" || return 1
    case "$cg" in /*) ;; *) return 1 ;; esac
    case "$cg" in *..*|*[!A-Za-z0-9/._:@-]*) return 1 ;; esac
    _limites_cgroup_valor "$R/sys/fs/cgroup$cg/$2"
}

# _limites_uso_bytes <container>: imprime o uso REAL de memoria (memory.current do cgroup, lido pelo host); retorna 1 se nao leu.
_limites_uso_bytes() {
    local v
    v="$(_limites_cgroup_arquivo "$1" memory.current)" || return 1
    case "$v" in ''|*[!0-9]*) return 1 ;; esac
    printf '%s' "$v"
}

# limites_conferir_risco <slug> <mesmo-assim 0|1>: no `agente criar` de um agente que NAO sera o principal, confere se a
# maquina aguenta mais um. Olha cada agente existente:
#   - ligado e legivel: soma o uso real (memory.current); a media M (so sobre esses) e o que o novo deve usar, e 1024 MB se nenhum foi lido;
#   - ligado e ilegivel (ou estado que o podman nao respondeu): e risco, porque nao se sabe quanto ele usa;
#   - created ou configured (criado e ainda nao ligado, como uma criacao que acabou de soltar a trava): entra na previsao com M;
#   - exited ou stopped: conta 0 e nao entra no divisor da media.
# Previsao P = U + M contra D = RAM - reserva. E risco P > D, agente ligado ilegivel, ou M maior que o MemAvailable de
# $R/proc/meminfo (se a linha existir). Com risco, falha (sem --mesmo-assim) ou avisa e segue (com ele). Sem meminfo ou no
# ensaio, nao confere. Nunca e chamada pelo recriar, pelo reparar nem pelo atualizar. Roda antes de reservar uid, portas ou casa.
limites_conferir_risco() {
    local slug="$1" mesmo="$2" pend s n=0 lidos=0 uso=0 st b naolidos="" criados="" nc=0 d p m avail txt risco=0
    [ "$ENSAIO" != 1 ] || return 0
    [ "$LIM_PAPEL" = adicional ] || return 0
    # Rodar o criar de novo num agente cujo container ja esta ligado nao acrescenta nada a maquina
    # (so se ele esta ligado: container parado ou so criado vai usar memoria quando ligar, e entra na conferencia normal.)
    if [ "$(podman inspect -f '{{.State.Status}}' "dgclaw-$slug" 2>/dev/null || true)" = running ]; then return 0; fi
    while IFS= read -r s; do
        if [ -z "$s" ] || [ "$s" = "$slug" ]; then continue; fi
        n=$((n + 1))
        st="$(podman inspect -f '{{.State.Status}}' "dgclaw-$s" 2>/dev/null)" || st=""
        case "$st" in
            '') naolidos="$naolidos $s" ;;
            exited|stopped) ;;
            created|configured) criados="$criados $s"; nc=$((nc + 1)) ;;
            *)
                if b="$(_limites_uso_bytes "dgclaw-$s")"; then
                    lidos=$((lidos + 1)); uso=$((uso + b / 1048576))
                else
                    naolidos="$naolidos $s"
                fi ;;
        esac
    done < <(_limites_existentes)
    naolidos="${naolidos# }"; criados="${criados# }"
    if [ "$lidos" -gt 0 ]; then m=$((uso / lidos)); else m=1024; fi
    uso=$((uso + nc * m))
    d=$((LIM_RAM_MB - LIM_RESERVA_MB))
    p=$((uso + m))
    pend=$((nc + 1))
    avail=""
    if [ -r "$R/proc/meminfo" ]; then
        avail="$(awk '/^MemAvailable:/ { print int($2 / 1024); exit }' "$R/proc/meminfo" 2>/dev/null)"
        case "$avail" in *[!0-9]*) avail="" ;; esac
    fi
    txt="com o agente $slug esta VPS fica no limite de memoria:"
    if [ "$LIM_RAM_MB" -le 0 ]; then
        risco=1
        txt="$txt nao consegui ler a RAM total da maquina (MemTotal em /proc/meminfo), entao nao tenho como saber se ela aguenta mais um agente."
    elif [ "$d" -lt "$LIMITE_MEM_PISO_MB" ]; then
        risco=1
        txt="$txt a VPS e pequena demais para mais de um agente: tem $LIM_RAM_MB MB de RAM, e depois da reserva de $LIM_RESERVA_MB MB para o sistema e o DG Claw sobram $d MB, menos que os $LIMITE_MEM_PISO_MB MB que um agente pode precisar."
    elif [ "$p" -gt "$d" ]; then
        risco=1
        txt="$txt os $n agentes usam hoje $uso MB (media de $m MB cada) e, com mais um, a previsao e de $p MB para $d MB disponiveis (RAM de $LIM_RAM_MB MB menos a reserva de $LIM_RESERVA_MB MB para o sistema e o DG Claw)."
        [ -z "$criados" ] || txt="$txt Os agentes $criados foram criados e ainda nao ligaram, entao entraram na conta com a media de $m MB cada."
    fi
    if [ -n "$naolidos" ]; then
        risco=1
        txt="$txt Nao consegui ler o uso de memoria de $naolidos (agente ligado sem memory.current legivel no cgroup do host), entao nao sei se a maquina aguenta mais um."
    fi
    if [ -n "$avail" ] && [ $((m * pend)) -gt "$avail" ]; then
        risco=1
        txt="$txt A memoria disponivel agora na maquina (MemAvailable) e de $avail MB, menos que os $((m * pend)) MB que o novo agente e os $nc ainda nao ligados devem usar ($pend x a media de $m MB)."
    fi
    [ "$risco" = 1 ] || return 0
    if [ "$mesmo" = 1 ]; then
        aviso "$txt Criei mesmo assim, por sua conta e risco (--mesmo-assim): o servidor pode ficar sem memoria sob carga. O certo e aumentar a memoria da VPS ou criar outra VPS para este agente."
        return 0
    fi
    falha "$txt O certo e aumentar a memoria da VPS ou criar outra VPS para este agente." \
        "nada foi criado. Para criar mesmo assim, por sua conta e risco: dgclaw agente criar $slug ... --mesmo-assim"
}

# limites_preparar_slice: so para o principal com garantia. Grava (se o conteudo mudou) o slice que carrega o MemoryLow e o
# carrega no systemd. Falha aqui vira aviso, nao impede a criacao: a reserva do principal fica sem efeito ate corrigir.
limites_preparar_slice() {
    [ "$LIM_PAPEL" = principal ] && [ -n "$LIM_RESERVA_GARANTIDA_MB" ] || return 0
    local g="$LIM_RESERVA_GARANTIDA_MB" arq="$DG_UNITS/$LIMITE_SLICE_PRINCIPAL" novo atual="" tmp=""
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] gravaria $arq com MemoryLow=${g}M e recarregaria o systemd"
        return 0
    fi
    novo="$(printf '[Unit]\nDescription=DG Claw: agente principal (memoria protegida)\n\n[Slice]\nMemoryLow=%sM\n' "$g")"
    [ ! -f "$arq" ] || atual="$(cat "$arq" 2>/dev/null || true)"
    if [ "$novo" != "$atual" ]; then
        if ! { mkdir -p "$DG_UNITS" && tmp="$(mktemp "$DG_UNITS/.$LIMITE_SLICE_PRINCIPAL.XXXXXX")" \
                && printf '%s\n' "$novo" >"$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$arq"; }; then
            [ -z "$tmp" ] || rm -f -- "$tmp"
            aviso "nao consegui gravar $arq (o slice que protege a memoria do agente principal). O agente sera criado, mas a reserva de ${g} MB dele fica sem efeito ate isso ser corrigido: confira o espaco em disco e a permissao de $DG_UNITS e rode: dgclaw agente recriar <agente> --forcar"
            return 0
        fi
    fi
    if ! systemctl daemon-reload >/dev/null 2>&1; then
        aviso "gravei $arq, mas o systemctl daemon-reload falhou. O agente sera criado, mas a reserva de ${g} MB do agente principal fica sem efeito ate o systemd ler o slice: rode systemctl daemon-reload e depois dgclaw agente recriar <agente> --forcar."
        return 0
    fi
    # O slice so existe de fato quando o primeiro container nasce nele; se ainda nao existe, o set-property falha e tudo bem.
    systemctl set-property --runtime "$LIMITE_SLICE_PRINCIPAL" "MemoryLow=${g}M" >/dev/null 2>&1 || true
}

# limites_relatar <container> <slug>: conta o que limites_calcular decidiu (info).
limites_relatar() {
    local c="$1" det prio memtxt="${LIM_MEM_ARG:-sem limite}"
    if [ "$LIM_SOBRESCRITA" = 1 ]; then
        det="agente $LIM_PAPEL: memoria definida por DGCLAW_CONTAINER_MEMORIA"
    elif [ "$LIM_RAM_MB" -gt 0 ]; then
        det="agente $LIM_PAPEL: RAM de $LIM_RAM_MB MB menos a reserva de $LIM_RESERVA_MB MB para o sistema e o DG Claw; e um teto de protecao, nao uma fatia"
    else
        det="agente $LIM_PAPEL: nao consegui ler a RAM da maquina, ficou o padrao de $LIMITE_MEM_PISO_MB MB"
    fi
    info "limites do container $c: memoria $memtxt, CPUs $LIM_CPUS_ARG, processos $LIMITE_PIDS ($det)"
    if [ "$LIM_PAPEL" = principal ]; then
        prio="agente principal, protegido: oom_score_adj $LIM_OOM_ADJ"
        if [ -n "$LIM_RESERVA_GARANTIDA_MB" ]; then
            prio="$prio, memoria protegida de $LIM_RESERVA_GARANTIDA_MB MB (memory.low, no slice $LIM_CGROUP_PARENT; protecao de melhor esforco do kernel)"
        else
            prio="$prio, sem memoria protegida (nao consegui ler a RAM da maquina)"
        fi
    else
        prio="agente adicional, prioridade $LIM_NIVEL: oom_score_adj $LIM_OOM_ADJ"
        if [ -n "$LIM_HIGH_BYTES" ]; then
            prio="$prio, memory.high de $((LIM_HIGH_BYTES / 1048576)) MB (acima disso o kernel segura o agente antes de ele pesar na maquina)"
        else
            prio="$prio, sem memory.high"
        fi
    fi
    info "prioridade do container $c: $prio"
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

# O padrao antigo do DG Claw (antes do calculo pela maquina): memoria em MiB inteiros: 2048 MiB exatos no principal e de 1024 a 2048 MiB no adicional (o 2 GiB fixo de antes e o que as versoes
# intermediarias deram aos agentes adicionais, de 1 a 2 GB; abaixo de 1024 MiB so a mao do dono), 1.0 CPU e 1024 processos. O reparar so mexe num recurso que
# ainda esta nesse valor; qualquer outro valor (por exemplo 3 GiB, mesmo abaixo do calculado) conta como escolha do dono.
# So conta valor em MiB inteiros. O principal so teve o 2 GiB exato; o adicional, de 1024 a 2048 MiB inclusive.
_limites_mem_antiga() {
    [ "$ATU_MEM_ILIM" != 1 ] && [ $((ATU_MEM_B % 1048576)) -eq 0 ] || return 1
    if [ "$LIM_PAPEL" = principal ]; then [ "$ATU_MEM_B" -eq 2147483648 ]
    else [ "$ATU_MEM_B" -ge 1073741824 ] && [ "$ATU_MEM_B" -le 2147483648 ]; fi
}
# CPU: o padrao antigo e o par exato quota 100000 e periodo 100000 (o antigo --cpus 1.0). Outro periodo (50000 50000, por
# exemplo) e escolha do dono.
_limites_cpu_antiga() { [ "$ATU_CPU_ILIM" != 1 ] && [ "$ATU_CPU_QUOTA" -eq 100000 ] && [ "$ATU_CPU_PERIODO" -eq 100000 ]; }
_limites_pids_antigo() { [ "$ATU_PIDS_ILIM" != 1 ] && [ "$ATU_PIDS" -eq 1024 ]; }

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

# _limites_ler_protecoes <container>: le o que o podman registrou na criacao (HostConfig) em PROT_OOM, PROT_RES (bytes) e
# PROT_PAI; retorna 1 se nao leu.
# shellcheck disable=SC2034 # lidas por quem carrega este arquivo
_limites_ler_protecoes() {
    local lido
    lido="$(podman inspect -f '{{.HostConfig.OomScoreAdj}}|{{.HostConfig.MemoryReservation}}|{{.HostConfig.CgroupParent}}' "$1" 2>/dev/null)" || return 1
    case "$lido" in *'|'*'|'*) ;; *) return 1 ;; esac
    IFS='|' read -r PROT_OOM PROT_RES PROT_PAI <<<"$lido"
    case "$PROT_OOM" in ''|*[!0-9-]*) return 1 ;; esac
    case "$PROT_RES" in ''|*[!0-9]*) PROT_RES=0 ;; esac
    return 0
}

# _limites_protecoes_conferem: o que _limites_ler_protecoes leu bate com LIM_* (oom do papel; no principal, tambem a reserva e o slice)?
_limites_protecoes_conferem() {
    [ "$PROT_OOM" = "$LIM_OOM_ADJ" ] || return 1
    if [ -n "$LIM_RESERVA_GARANTIDA_MB" ]; then
        [ "$PROT_RES" -eq $((LIM_RESERVA_GARANTIDA_MB * 1048576)) ] && [ "$PROT_PAI" = "$LIM_CGROUP_PARENT" ] || return 1
    fi
    return 0
}

# _limites_avisar_protecoes <container> <slug>: o reparar nao mexe em oom_score_adj, memory.reservation nem slice (o podman 4.9
# nao os atualiza de forma persistente). Se o container ja existente nao tem o que o papel e o nivel atuais pedem, so conta
# que isso entra no proximo recriar. Consulta que falha nao diz nada.
_limites_avisar_protecoes() {
    local c="$1" slug="$2" papel
    _limites_ler_protecoes "$c" || return 0
    _limites_protecoes_conferem && return 0
    if [ "$LIM_PAPEL" = principal ]; then papel="principal, protegido"; else papel="adicional, prioridade $LIM_NIVEL"; fi
    # shellcheck disable=SC2016 # as crases fazem parte do texto
    info "o container $c ainda nao tem as protecoes de memoria do papel atual do agente $slug ($papel). O reparar nao as muda; elas entram com \`dgclaw agente recriar $slug --forcar\` ou na proxima atualizacao do DG Claw que recriar o agente."
}

# limites_ajustar_existente <slug>: poe o container que ja existe no limite calculado, SEM recriar, com
# `podman update`. So sobe o que ainda esta no padrao antigo do DG Claw (memoria de 1 a 2 GiB, 1.0 CPU, 1024 processos); o que esta sem limite
# (max) fica sem limite, e qualquer outro valor (a pessoa aumentou ou diminuiu a mao) fica como esta, e o log diz que foi mantido e por que. Se o podman
# da maquina nao tem o `update` ou nao aceita um dos flags, avisa e segue (nunca derruba o reparar). O resultado de
# cada recurso vem da RELEITURA do cgroup depois do update, nao do codigo de saida do podman.
# Todas as leituras e os `podman update` usam o ID do container, lido uma vez no comeco: o nome e reutilizavel (um recriar
# o troca), o ID nao. No fim confere que o nome ainda aponta para o mesmo ID.
# Depois do update, o valor relido manda: limite finito que virou `max`, ou valor que ficou ABAIXO do que era antes, e FALHA
# (codigo 1). O reparar NAO tenta restaurar o valor de antes e NAO para o container: o agente principal atende gente, e
# parar ou mexer de novo num agente e decisao do dono, nao do reparar. A mensagem diz o que fazer.
limites_ajustar_existente() {
    local c="dgclaw-$1" args=() grupos=() f sw id
    limites_calcular "$1"
    if [ "$ENSAIO" = 1 ]; then
        info "limites calculados para esta maquina: memoria $LIM_MEM_ARG, CPUs $LIM_CPUS_ARG, processos $LIMITE_PIDS ($LIM_PAPEL)"
        return 0
    fi
    limites_relatar "$c" "$1"
    _limites_avisar_protecoes "$c" "$1"
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
        info "mantido: $f no container $c. Esse valor nao e o padrao antigo do DG Claw (memoria de 1 a 2 GB, 1.0 CPU, 1024 processos), entao conta como escolha do dono e nao foi mexido."
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
            : # ficou abaixo do que era antes: a falha sai na secao dos reduzidos
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
    local rc=0
    for f in "${falhas[@]}"; do
        aviso "FALHA: $f. Veja com: podman inspect $c"
        rc=1
    done
    # shellcheck disable=SC2016 # as crases fazem parte do texto
    local passos="O DG Claw NAO tentou restaurar o valor de antes e NAO parou o container. Rodar \`dgclaw agente reparar $1\` de novo nao devolve o limite (ele passaria a tratar o valor atual como escolha sua). Para o teto voltar, recrie o agente: \`dgclaw agente recriar $1 --forcar\` (com a imagem atual, sem o --forcar o recriar responde \"nada a recriar\"). O --forcar pula a conferencia de arquivos que so existem dentro do container, entao copie para a casa do agente antes o que precisar guardar. Depois confira o teto com \`dgclaw agente reparar $1\`. Veja com: podman inspect $c"
    local txt
    for f in "${reduzidos[@]}"; do
        case "$f" in
            memoria) txt="$red_txt_mem" ;;
            CPUs) txt="$red_txt_cpu" ;;
            processos) txt="$red_txt_pids" ;;
        esac
        aviso "FALHA: o limite de $f do container $c ficou abaixo do que era antes do podman update ($txt). $passos"
        rc=1
    done
    for f in "${sumiram[@]}"; do
        aviso "FALHA: o limite de $f do container $c sumiu. Era finito e, depois do podman update, o cgroup passou a mostrar sem limite (max); isso nao e um aumento. $passos"
        rc=1
    done
    for f in "${abaixo[@]}"; do
        aviso "$f do container $c continuou abaixo do calculado depois do podman update. O limite definitivo entra na proxima vez que o agente for recriado (por exemplo ao atualizar a imagem com dgclaw atualizar)."
    done
    if [ "${#subiram[@]}" -gt 0 ]; then
        ok "subiram em $c: ${subiram[*]}. O ajuste vale para o container ligado; o limite definitivo entra na proxima vez que o agente for recriado (por exemplo ao atualizar a imagem com dgclaw atualizar)."
        if [[ " ${subiram[*]} " == *" memoria "* ]]; then
            # shellcheck disable=SC2016 # as crases fazem parte do texto
            info "o podman nao guarda o ajuste de memoria do agente $1 quando o servidor ou o container reinicia. Para o novo limite sobreviver a um reinicio, rode \`dgclaw agente recriar $1 --forcar\` (sem o --forcar, com a imagem atual, o recriar responde \"nada a recriar\"; o --forcar pula a conferencia de arquivos que so existem dentro do container, entao copie para a casa do agente antes o que precisar guardar)."
        fi
    fi
    _limites_id_confere "$c" "$id" "$1" || rc=1
    return "$rc"
}
