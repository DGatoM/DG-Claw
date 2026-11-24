#!/usr/bin/env bash
# smoke-entrega.sh: confere uma VPS de cliente antes da entrega. Roda no servidor, como root.
#
#   sudo bash /opt/dgclaw/app/scripts/smoke-entrega.sh <agente>
#
# Automatiza os itens 1, 3, 5 (microfone e nomes do cofre) e 8 (so o ffmpeg do servidor) do checklist
# (docs/ENTREGA-CLIENTE.md). So faz leituras do servidor que o agente nao controla: podman inspect, podman container
# exists, o cgroup do container no host, o journal do KERNEL do servidor (journalctl _TRANSPORT=kernel no host),
# o web.env e a CLI do cofre. Nada roda dentro do container (nenhum podman exec): o agente tem sudo la dentro, entao
# qualquer programa executado la pode ter sido trocado. TasksMax, OOMPolicy e NRestarts do runner, o journal do
# runner, yt-dlp e perfil da Tela (6), render do Chrome (7), ffmpeg do container (8) e o cruzamento das skills com
# o cofre (5) ficam a mao. Cada item imprime OK, AVISO, FALHA ou INCONCLUSIVO (nao deu para medir: erro de leitura
# nao e OK nem FALHA) com a causa e o que fazer. O resto sai como lista "conferir a mao".
# Saida: 0 sem FALHA (pode haver AVISO e INCONCLUSIVO), 1 com ao menos uma FALHA, 2 uso errado
# ou ferramenta ausente. As mensagens sao fixas e so entram contagens validadas ou o que o servidor ja conhece.
#
# O que este script NAO faz: mostrar valor de chave do cofre (so os nomes), apagar coisa do agente
# ou do servidor. Reparar o agente e reiniciar o runner ficam a mao, so para uma falha diagnosticada.
#
# Env (usadas pelos testes): DGCLAW_RAIZ (raiz falsa), DGCLAW_CLI (o dgclaw a chamar).
set -u

R="${DGCLAW_RAIZ:-}"
CLI="${DGCLAW_CLI:-dgclaw}"

USO='uso: sudo bash /opt/dgclaw/app/scripts/smoke-entrega.sh <agente>'
SLUG=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --ajuda|-h) echo "$USO"; exit 0 ;;
        -*) echo "opcao desconhecida: $1. $USO" >&2; exit 2 ;;
        *)
            [ -z "$SLUG" ] || { echo "so um agente por vez. $USO" >&2; exit 2; }
            SLUG="$1"; shift ;;
    esac
done
[ -n "$SLUG" ] || { echo "faltou dizer o agente. $USO" >&2; exit 2; }
case "$SLUG" in
    *[!a-z0-9-]*|-*) echo "'$SLUG' nao e um nome de agente valido (letras minusculas, numeros e hifen). $USO" >&2; exit 2 ;;
esac

for f in jq podman; do
    command -v "$f" >/dev/null 2>&1 || { echo "falta o programa '$f' no PATH. Instale com: apt-get install -y $f" >&2; exit 2; }
done

AGENTES_JSON="$R/etc/dgclaw/agentes.json"
[ -s "$AGENTES_JSON" ] || { echo "nao achei $AGENTES_JSON, entao nao sei quais agentes existem. Rode o smoke no servidor do DG Claw, como root." >&2; exit 2; }
REG="$(jq -r --arg s "$SLUG" '.agentes[] | select(.slug == $s and .tipo == "agente") | def n: if . == "" then "-" else . end; [((.runner // "") | tostring | n), ((.home_host // "") | tostring | n), (.provedor // "?"), ((.container // "") | tostring | n)] | @tsv' "$AGENTES_JSON" 2>/dev/null | head -n 1)"
[ -n "$REG" ] || { echo "o agente '$SLUG' nao esta em $AGENTES_JSON. Veja os que existem com: dgclaw agente listar" >&2; exit 2; }
IFS=$'\t' read -r _ _ PROVEDOR CONT_REG <<<"$REG"
# Nome do container: sempre dgclaw-<slug>, que e o que a CLI opera. O campo "container" do registro, se vier, tem que ser esse mesmo.
C="dgclaw-$SLUG"
if [ -n "$CONT_REG" ] && [ "$CONT_REG" != "-" ]; then
    case "$CONT_REG" in
        dgclaw-|dgclaw-*[!a-z0-9-]*) CONT_REG="" ;;
        dgclaw-*) ;;
        *) CONT_REG="" ;;
    esac
    [ -n "$CONT_REG" ] || { echo "o nome de container registrado para o agente nao e valido (esperado: dgclaw- e letras minusculas, numeros e hifen). Confira o registro com: dgclaw agente listar" >&2; exit 2; }
    [ "$CONT_REG" = "$C" ] || { echo "o registro aponta o container $CONT_REG, mas a CLI dgclaw opera sobre $C. Por isso o smoke nao segue nem recomenda iniciar ou recriar. A equipe deve conferir o registro com dgclaw agente listar antes de qualquer acao." >&2; exit 2; }
fi

FALHAS=0
AVISOS=0
INCONCLUSIVOS=0
# Tira o que nao e texto simples antes de mostrar na tela (a saida de dentro do container e do agente).
limpar() { LC_ALL=C tr -c 'A-Za-z0-9 ._/@+:,=%()<>-' '?' | cut -c1-200; }
ok()    { printf '  OK     [%s] %s\n' "$1" "$2"; }
aviso() { AVISOS=$((AVISOS + 1)); printf '  AVISO  [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
falha() { FALHAS=$((FALHAS + 1)); printf '  FALHA  [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
inconclusivo() { INCONCLUSIVOS=$((INCONCLUSIVOS + 1)); printf '  INCONCLUSIVO [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
# desc_cobertura <horas>: o periodo de fato examinado (dias completos e horas, sem arredondar para cima). O "7 dias"
# nao sai daqui: so o chamador o diz, quando a primeira entrada do journal e anterior ou igual ao corte da janela.
desc_cobertura() {
    if [ "$1" -lt 24 ]; then printf 'menos de 1 dia (%s hora(s))' "$1"
    else printf '%s dia(s) completo(s) (%s horas)' "$(($1 / 24))" "$1"; fi
}
# so_digitos <texto> <maximo de caracteres>: verdadeiro se for um numero curto.
so_digitos() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le "$2" ]; }
# contar_oom <comando...>: quantas linhas de falta de memoria (eventos do OOM killer do kernel) o comando mostra
# (o comando precisa imprimir "-o short-unix"; a janela de 7 dias ja vem do --since do proprio comando). So a
# contagem fica guardada, o texto do journal passa direto pelo filtro (conta so a mensagem do kernel, e so se ela
# COMECA com um padrao de OOM, para a linha de auditoria com "oom-kill:constraint=" no caminho nao contar). A leitura tem limite de 1 MiB: se passar
# disso sem nenhuma ocorrencia no que foi lido, sai com 98 e nada (saida cortada, INCONCLUSIVO); se ja achou
# ocorrencia, sai com 97 e a contagem parcial (e FALHA, com nota de contagem parcial). Se o comando terminar com erro
# (journal ilegivel, prazo) depois de ja ter mostrado ocorrencia, tambem sai com 97 e a contagem parcial. Erro sem
# nenhuma ocorrencia sai com 1 e nada: isso e INCONCLUSIVO, nao "zero".
contar_oom() {
    local r linha n bytes rc
    r="$("$@" 2>/dev/null | head -c 1048577 | LC_ALL=C awk 'BEGIN { n = 0; b = 0 } { b += length($0) + 1; m = $0; sub(/^[^ ]+ [^ ]+ kernel: /, "", m); if (tolower(m) ~ /^(out of memory: killed process|memory cgroup out of memory|oom-kill:constraint=|oom_reaper: reaped process|[^=]* invoked oom-killer: gfp_mask=)/) n++ } END { print n, b }'; printf 'rc=%s' "${PIPESTATUS[0]}")"
    rc="${r##*rc=}"; linha="${r%%$'\n'*}"
    read -r n bytes <<<"$linha"
    so_digitos "$n" 9 || return 1
    so_digitos "$bytes" 9 || return 1
    [ "$bytes" -le 1048578 ] || return 1
    if [ "$bytes" -gt 1048576 ]; then
        [ "$n" -gt 0 ] || return 98
        printf '%s' "$n"
        return 97
    fi
    if [ "$rc" != 0 ]; then
        [ "$n" -gt 0 ] || return 1
        printf '%s' "$n"
        return 97
    fi
    printf '%s' "$n"
}
# ler_cpu <caminho validado>: "<quota> <periodo>" do cpu.max do cgroup do container, no host (quota "max" = sem limite).
ler_cpu() {
    local v q p
    v="$(head -c 64 "$R/sys/fs/cgroup$1/cpu.max" 2>/dev/null | head -n 1)"
    read -r q p _ <<<"$v"
    case "$q" in max) ;; *) so_digitos "$q" 15 || return 1 ;; esac
    so_digitos "$p" 15 || return 1
    [ "$p" -gt 0 ] || return 1
    printf '%s %s' "$q" "$p"
}
# ler_cgroup <caminho validado> <arquivo>: o valor (numero ou "max") do arquivo do cgroup do container, no host.
ler_cgroup() {
    local v
    v="$(head -c 64 "$R/sys/fs/cgroup$1/$2" 2>/dev/null | head -n 1)"
    case "$v" in max) ;; ''|*[!0-9]*) return 1 ;; esac
    printf '%s' "$v"
}

printf 'Smoke de entrega do agente %s (motor: %s)\n\n' "$SLUG" "$PROVEDOR"

# --- 1. Ubuntu ------------------------------------------------------------------------------------
printf '1. Versao do Ubuntu\n'
if [ -r "$R/etc/os-release" ]; then
    # Le o arquivo como texto, sem carregar (source) o que ele tem dentro.
    os_id="$(sed -n 's/^ID=//p' "$R/etc/os-release" | head -n 1 | tr -d '"')"
    os_ver="$(sed -n 's/^VERSION_ID=//p' "$R/etc/os-release" | head -n 1 | tr -d '"')"
    so="${os_id:-?} ${os_ver:-?}"
    if [ -z "$os_id" ] || [ -z "$os_ver" ]; then so="incompleto"; fi
    case "$so" in
        incompleto) inconclusivo 1 "o /etc/os-release nao traz ID e VERSION_ID, entao nao sei qual e o sistema." "confira a mao: cat /etc/os-release. Nao reinstale a VPS por causa disso." ;;
        "ubuntu 24.04"|"ubuntu 22.04") ok 1 "Ubuntu ${so#ubuntu } (versao testada)" ;;
        "ubuntu 26.04") aviso 1 "Ubuntu 26.04: o DG Claw foi feito e testado no 24.04; o 26.04 tem funcionado, mas pode ter instabilidade." \
            "se a VPS ainda nao tem dados do cliente e a entrega nao tem pressa, recrie a VPS com Ubuntu 24.04 (com dados, so com copia recuperavel e decisao do dono). Se ficar no 26.04, confira com atencao o item 3 abaixo e os itens 6 e 7 da lista a mao." ;;
        *) falha 1 "sistema '$(printf '%s' "$so" | limpar)': o DG Claw so instala em Ubuntu 22.04, 24.04 ou 26.04." "nao entregue. Reinstalar a VPS apaga cofre, conversas e configuracoes: so com uma copia recuperavel dos dados e com a decisao do dono." ;;
    esac
else
    inconclusivo 1 "nao consegui ler $R/etc/os-release, entao nao sei qual e o sistema." "confira o sistema com: cat /etc/os-release. Nao reinstale a VPS por causa disso."
fi

# --- 3. Limites do container e da unidade do runner ----------------------------------------------
printf '\n3. Limites do container e do runner\n'
RECRIAR_DICA="o dgclaw agente recriar $SLUG pode recriar o container na hora. Antes, num terminal seu (nunca no chat do Admin, porque nomes e conteudos ali sao escolhidos pelo agente), confira o que existe so na camada gravavel do container (o inventario do recriar ignora /tmp, /var/tmp, /var/log e /var/cache: o que o cliente guardou ali precisa ser copiado para a casa antes), decida com o dono antes de qualquer perda e so entao rode: dgclaw agente recriar $SLUG. Depois rode o smoke de novo: o item so fecha quando a releitura mostrar o valor certo. Se o recriar responder que nada havia a recriar, o container nao mudou e o item continua aberto."
podman container exists "$C" >/dev/null 2>&1; existe_rc=$?
estado=""
if [ "$existe_rc" -eq 0 ]; then
    estado="$(podman inspect -f '{{.State.Status}}' "$C" 2>/dev/null | head -c 64 | head -n 1)"
    case "$estado" in
        running|created|exited|paused|stopped|stopping|configured|initialized|removing|unknown) ;;
        '') estado=vazio ;;
        *) estado="fora da lista" ;;
    esac
fi
if [ "$estado" != running ]; then
    if [ "$existe_rc" -eq 1 ]; then
        falha 3 "o container $C nao existe." "confira com dgclaw agente listar se o agente foi criado; um agente sem container precisa ser recriado pela equipe."
    elif [ "$existe_rc" -ne 0 ]; then
        inconclusivo 3 "nao consegui consultar o podman (codigo $existe_rc), entao nao sei se o container $C existe." "rode o smoke de novo; se repetir, confira num terminal seu: podman container exists $C; echo \$? (0 = existe, 1 = nao existe, outro codigo = o podman nao respondeu). Nao altere nada ate saber o estado."
    elif [ "$estado" = vazio ] || [ "$estado" = "fora da lista" ]; then
        inconclusivo 3 "o podman nao devolveu um estado valido para o container $C ($estado)." "rode o smoke de novo; se repetir, confira num terminal seu: podman inspect -f '{{.State.Status}}' $C"
    else
        falha 3 "o container $C esta '$estado'." "ligue com: dgclaw agente iniciar $SLUG"
    fi
else
    lim="$(podman inspect -f '{{.HostConfig.PidsLimit}}' "$C" 2>/dev/null | head -c 64 | head -n 1)"
    read -r pids_lim _ <<<"$lim"
    case "${pids_lim:-x}" in *[!0-9-]*) pids_lim="" ;; esac

    # Memoria e processos: o que vale e o cgroup do container, lido no host (max = sem limite).
    cg_path="$(podman inspect -f '{{.State.CgroupPath}}' "$C" 2>/dev/null | head -n 1)"
    cg_ok=0
    case "$cg_path" in
        /*)
            case "$cg_path" in
                *[!A-Za-z0-9_.:/@-]*|*..*|*//*) ;;
                *) cg_ok=1 ;;
            esac ;;
    esac
    mem_cg=""; pids_cg=""; cpu_cg=""
    if [ "$cg_ok" = 1 ]; then
        mem_cg="$(ler_cgroup "$cg_path" memory.max)"
        pids_cg="$(ler_cgroup "$cg_path" pids.max)"
        cpu_cg="$(ler_cpu "$cg_path")"
    fi

    if [ -z "$pids_cg" ]; then
        inconclusivo 3 "nao consegui ler o limite de processos (pids.max) do cgroup do container $C no servidor." \
            "confira: podman inspect -f '{{.State.CgroupPath}}' $C e leia pids.max em /sys/fs/cgroup<esse caminho>"
    elif [ "$pids_cg" = max ]; then
        falha 3 "o container $C esta sem limite de processos (pids.max=max). Um laco descontrolado do agente pode travar o servidor." \
            "$RECRIAR_DICA"
    elif [ "$pids_cg" -ge 4096 ]; then
        ok 3 "pids.max do container: $pids_cg (minimo 4096)"
    else
        falha 3 "pids.max do container e $pids_cg, abaixo de 4096. Com pouco processo o agente cai sozinho e o card nasce parado." "$RECRIAR_DICA"
    fi
    if [ -n "$pids_lim" ] && [ "$pids_lim" -gt 0 ] && [ "$pids_lim" -lt 4096 ]; then
        falha 3 "o podman guarda PidsLimit=$pids_lim para o container (abaixo de 4096)." "$RECRIAR_DICA"
    fi

    ram_kb="$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\) kB.*/\1/p' "$R/proc/meminfo" 2>/dev/null | head -n 1)"
    ram_gb=0
    [ -n "$ram_kb" ] && ram_gb=$((ram_kb / 1024 / 1024))
    if [ -z "$mem_cg" ]; then
        inconclusivo 3 "nao consegui ler o limite de memoria (memory.max) do cgroup do container $C no servidor." \
            "confira: podman inspect -f '{{.State.CgroupPath}}' $C e leia memory.max em /sys/fs/cgroup<esse caminho>"
    elif [ "$mem_cg" = max ]; then
        falha 3 "o container $C esta sem limite de memoria (memory.max=max, o servidor tem ${ram_gb} GB). Um render pesado pode derrubar o servidor inteiro." \
            "configure DGCLAW_CONTAINER_MEMORIA (a partir da 1.1.1) com um valor que caiba na RAM da VPS, deixando folga para o sistema e o Admin, e recrie o container. $RECRIAR_DICA"
    elif [ "$mem_cg" -lt 2147483648 ]; then
        aviso 3 "o container $C tem limite de memoria de $((mem_cg / 1048576)) MB, abaixo dos 2 GB que o DG Claw aplica na criacao. Render, Chrome da Tela e card paralelo caem com pouca memoria." \
            "se ninguem configurou DGCLAW_CONTAINER_MEMORIA (a partir da 1.1.1) de proposito, recrie o container. $RECRIAR_DICA"
    elif [ -n "$ram_kb" ] && [ "$mem_cg" -ge $((ram_kb * 1024)) ]; then
        aviso 3 "o container $C tem limite de memoria de $((mem_cg / 1048576)) MB, que e igual ou maior que a RAM do servidor (${ram_gb} GB). O teto nao protege o servidor: um render pesado esgota a RAM antes de chegar nele." \
            "nesta versao o container nasce com teto fixo de 2 GB. Se a VPS tem 2 GB de RAM ou menos, ela e pequena demais: troque o plano. Se o teto esta acima de 2 GB, alguem mudou o container a mao; nao corrija com podman update (o ajuste se perde quando o container para e volta). A partir da 1.1.1, configure DGCLAW_CONTAINER_MEMORIA com um valor que caiba na RAM, recrie e confira de novo depois de reiniciar o container."
    elif [ "$mem_cg" -eq 2147483648 ] && [ "$ram_gb" -gt 4 ]; then
        sug=$((ram_gb / 2)); [ "$sug" -ge 3 ] || sug=3
        aviso 3 "o container tem limite de memoria de $((mem_cg / 1048576)) MB (2 GB) e o servidor tem ${ram_gb} GB. Render, Chrome da Tela e card paralelo apertam em 2 GB." \
            "nesta versao o teto e fixo na criacao do container. Nao use podman update: o ajuste se perde quando o container para e volta. A partir da 1.1.1, configure DGCLAW_CONTAINER_MEMORIA (por exemplo ${sug}g), recrie e confira de novo depois de reiniciar o container."
    else
        ok 3 "memoria do container: $((mem_cg / 1048576)) MB (servidor com ${ram_gb} GB)"
    fi

    cpus_host="$(nproc 2>/dev/null)"
    case "$cpus_host" in ''|*[!0-9]*) cpus_host=1 ;; esac
    # CPU: o que vale e o cpu.max do cgroup do container ("<quota> <periodo>", quota max = sem limite).
    if [ -z "$cpu_cg" ]; then
        inconclusivo 3 "nao consegui ler o limite de CPU (cpu.max) do cgroup do container $C no servidor." \
            "confira: podman inspect -f '{{.State.CgroupPath}}' $C e leia cpu.max em /sys/fs/cgroup<esse caminho>"
    else
        read -r cpu_q cpu_p <<<"$cpu_cg"
        if [ "$cpu_q" = max ]; then
            ok 3 "CPU do container: sem limite ($cpus_host nucleos no servidor)"
        elif [ "$cpu_q" -le "$cpu_p" ] && [ "$cpus_host" -gt 1 ]; then
            sug=$((cpus_host / 2)); [ "$sug" -ge 2 ] || sug=2
            aviso 3 "o container tem 1 CPU (ou menos) e o servidor tem $cpus_host nucleos." \
                "nesta versao o limite de CPU e fixo na criacao do container (1 CPU). Nao use podman update: o ajuste se perde quando o container para e volta. Registre o aviso na entrega."
        else
            cpu_c=$((cpu_q * 100 / cpu_p))
            ok 3 "CPU do container: $((cpu_c / 100)).$(printf '%02d' $((cpu_c % 100))) (servidor com $cpus_host nucleos)"
        fi
    fi

    # Kernel do servidor: _TRANSPORT=kernel (o -k so olha o boot atual e perderia um OOM de antes de um reinicio).
    # Duas consultas no host: a contagem de OOM so na janela de 7 dias e a cobertura (a entrada mais recente igual ou
    # anterior ao corte: se existe, o historico do journal alcanca o inicio da janela, mesmo com o kernel quieto).
    agora="$(date +%s)"; corte=$((agora - 7 * 86400))
    oom_n="$(contar_oom timeout 60 journalctl _TRANSPORT=kernel --since "@$corte" --no-pager -q -o short-unix)"; rc_k=$?
    parcial=0
    if [ "$rc_k" -eq 97 ]; then rc_k=0; parcial=1; fi
    # A cobertura so e medida com a contagem lida inteira e sem OOM, e so vale com o journalctl terminando em 0.
    cob=""; cob7=0
    if [ "$rc_k" -eq 0 ] && [ "$parcial" -eq 0 ] && [ "$oom_n" -eq 0 ]; then
        # Primeira entrada da janela (141 = SIGPIPE do head). Sem ela a janela esta vazia: nao ha o que concluir.
        prim_saida="$(timeout 60 journalctl _TRANSPORT=kernel --since "@$corte" --no-pager -q -o short-unix 2>/dev/null | head -n 1; printf 'rc=%s' "${PIPESTATUS[0]}")"
        prim_rc="${prim_saida##*rc=}"; prim_linha="${prim_saida%%$'\n'*}"; prim_ts="${prim_linha%% *}"; prim_ts="${prim_ts%%.*}"
        cov_saida="$(timeout 60 journalctl _TRANSPORT=kernel --until "@$corte" -r -n 1 --no-pager -q -o short-unix 2>/dev/null | head -c 4096; printf 'rc=%s' "${PIPESTATUS[0]}")"
        cov_rc="${cov_saida##*rc=}"; cov_linha="${cov_saida%%$'\n'*}"; cov_ts="${cov_linha%% *}"; cov_ts="${cov_ts%%.*}"
        if ! so_digitos "$cov_rc" 3 || [ "$cov_rc" -ne 0 ] || ! so_digitos "$prim_rc" 3 || { [ "$prim_rc" -ne 0 ] && [ "$prim_rc" -ne 141 ]; }; then
            rc_k=1
        elif ! so_digitos "$prim_ts" 12; then
            : # janela sem nenhuma entrada: cai no ultimo ramo (INCONCLUSIVO), mesmo com historico anterior ao corte
        elif so_digitos "$cov_ts" 12 && [ "$cov_ts" -le "$corte" ]; then
            cob7=1; cob="7 dias"
        else
            # O historico nao alcanca o corte: o periodo examinado vem da primeira entrada da janela.
            horas=$(( (agora - prim_ts) / 3600 )); [ "$horas" -ge 0 ] || horas=0
            cob="$(desc_cobertura "$horas")"
        fi
    fi
    # A linha do kernel sozinha nao diz que o agente estourou o proprio teto: so a leitura humana das linhas oom-kill
    # (oom_memcg e task_memcg) diz. Por isso a dica nunca manda aumentar a memoria direto.
    oom_dica="a contagem sozinha nao diz de quem era o processo nem qual limite estourou, entao nao aumente o teto do agente por causa dela. Num terminal seu (nunca no chat do Admin), leia as linhas de OOM com journalctl _TRANSPORT=kernel --since '7 days ago' -o cat | grep -iE '^(out of memory: killed process|memory cgroup out of memory|oom-kill:constraint=|oom_reaper: reaped process|[^=]* invoked oom-killer: gfp_mask=)' e veja a data, o oom_memcg (o cgroup cujo limite estourou) e o task_memcg (quem foi morto). So com o oom_memcg igual ao cgroup do container $C o agente estourou o proprio teto. Com o oom_memcg de um ancestral, de outro servico ou com OOM do servidor inteiro (CONSTRAINT_NONE), o ajuste e nesse limite ou no plano da VPS. Nunca aumente o teto do agente direto."
    oom_cmd="journalctl _TRANSPORT=kernel --since '7 days ago' --no-pager -q -o cat | grep -ciE '^(out of memory: killed process|memory cgroup out of memory|oom-kill:constraint=|oom_reaper: reaped process|[^=]* invoked oom-killer: gfp_mask=)'; echo \"journalctl=\${PIPESTATUS[0]} grep=\${PIPESTATUS[1]}\""
    oom_leitura="num terminal seu, leia a janela toda: $oom_cmd. A contagem so vale com journalctl=0 e grep=0 ou 1 (grep=2 e erro), e este item continua INCONCLUSIVO ate essa leitura ser feita. Veja tambem se o journal e persistente (ls /var/log/journal) e rode o smoke de novo."
    if [ "$rc_k" -ne 0 ]; then
        inconclusivo 3 "nao consegui ler o journal do kernel do servidor dos ultimos 7 dias (erro, prazo ou saida cortada em 1 MiB). Isso nao quer dizer zero eventos de falta de memoria." \
            "$oom_leitura"
    elif [ "$oom_n" -gt 0 ]; then
        nota_parcial=""
        [ "$parcial" -eq 0 ] || nota_parcial=" (contagem parcial: a leitura do journal do kernel do servidor foi cortada em 1 MiB ou terminou com erro, entao ha pelo menos essas linhas)"
        falha 3 "OOM nos ultimos 7 dias: $oom_n linha(s) no journal do kernel do servidor${nota_parcial}." \
            "$oom_dica"
    elif [ "$cob7" -eq 1 ]; then
        ok 3 "nenhum OOM no journal do kernel do servidor (cobertura do kernel: $cob)"
    elif [ -n "$cob" ]; then
        inconclusivo 3 "nenhum OOM achado, mas o journal do kernel do servidor so cobre $cob, e nao os 7 dias inteiros (journal volatil, reinicio ou VPS criada ha menos de 7 dias)." \
            "se a VPS foi criada ha menos de 7 dias, isso e esperado: registre a cobertura na entrega. Senao, confira se o journal e persistente (ls /var/log/journal) e leia a janela a mao: $oom_cmd. A contagem so vale com journalctl=0 e grep=0 ou 1 (grep=2 e erro)."
    else
        inconclusivo 3 "nenhum OOM achado, mas o journal do kernel do servidor nao mostrou nenhuma entrada nos ultimos 7 dias, entao nao sei o que cobre." \
            "$oom_leitura"
    fi
fi

# --- 8. ffmpeg (so o do servidor; o do container e a mao) ----------------------------------------
printf '\n8. ffmpeg no servidor\n'
if command -v ffmpeg >/dev/null 2>&1 || [ -x "$R/usr/bin/ffmpeg" ]; then
    ok 8 "ffmpeg presente no servidor"
else
    falha 8 "ffmpeg nao esta no servidor. As miniaturas de video e foto do painel ficam sem previa." "apt-get install -y ffmpeg"
fi

# --- 5. Microfone e cofre --------------------------------------------------------------------------
printf '\n5. Microfone do chat e nomes das chaves do cofre (so os nomes, nunca os valores)\n'
# Microfone: o servico Web le a chave do proprio arquivo de ambiente (web.env). O arquivo e lido como texto
# (nunca executado) e so o veredito "tem valor" sai; o valor nunca e impresso. Vale a ULTIMA atribuicao.
WEBENV="$R/etc/dgclaw/web.env"
# Uma leitura so, em fluxo e limitada: o head le ate 1 MiB + 1 byte e o awk conta os bytes lidos e devolve so os
# nomes das chaves com valor (nenhuma copia do arquivo vai para o disco). Confere o codigo do head e o tamanho.
env_rc=1; env_tam=0; mic=""
if [ -r "$WEBENV" ]; then
    env_saida="$(head -c 1048577 "$WEBENV" 2>/dev/null | LC_ALL=C awk '
        { b += length($0) + 1 }
        /^[[:space:]]*(export[[:space:]]+)?(GROQ|OPENAI|ELEVENLABS)_API_KEY[[:space:]]*=/ {
            k = $0; sub(/^[[:space:]]*(export[[:space:]]+)?/, "", k); sub(/[[:space:]]*=.*$/, "", k)
            v = $0; sub(/^[^=]*=/, "", v)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
            if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) { v = substr(v, 2, length(v) - 2); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v) }
            tem[k] = (length(v) > 0) ? 1 : 0
            cont[k]++
        }
        END {
            print b + 0
            n = split("ELEVENLABS_API_KEY GROQ_API_KEY OPENAI_API_KEY", ordem, " ")
            for (i = 1; i <= n; i++) if (cont[ordem[i]] > 1) dup = dup (dup == "" ? "" : ", ") ordem[i]
            if (dup != "") { print "DUPLICADA " dup; exit }
            for (i = 1; i <= n; i++) if (tem[ordem[i]] == 1) lista = lista (lista == "" ? "" : ", ") ordem[i]
            print (lista == "" ? "NENHUMA" : lista)
        }' 2>/dev/null; printf 'rc=%s' "${PIPESTATUS[0]}")"
    env_rc="${env_saida##*rc=}"; env_corpo="${env_saida%rc=*}"
    env_tam="${env_corpo%%$'\n'*}"; mic="${env_corpo#*$'\n'}"; mic="${mic%%$'\n'*}"
    so_digitos "$env_tam" 9 || env_rc=1
    so_digitos "$env_rc" 3 || env_rc=1
fi
if [ "$env_rc" -ne 0 ]; then
    inconclusivo 5 "nao consegui ler o arquivo de ambiente do servico Web ($(printf '%s' "$WEBENV" | limpar)), entao nao sei se o microfone tem chave." \
        "confira a mao a ultima linha de GROQ_API_KEY, OPENAI_API_KEY e ELEVENLABS_API_KEY no web.env (so se tem valor, sem mostrar o valor)"
elif [ "$env_tam" -gt 1048576 ]; then
    inconclusivo 5 "o web.env passa de 1 MiB e a leitura foi cortada, entao a ultima atribuicao das chaves do microfone pode ter ficado de fora." \
        "confira a mao a ultima linha de GROQ_API_KEY, OPENAI_API_KEY e ELEVENLABS_API_KEY no web.env (so se tem valor, sem mostrar o valor)"
else
    case "$mic" in
        DUPLICADA\ *) inconclusivo 5 "o web.env tem mais de uma atribuicao da mesma chave de microfone (${mic#DUPLICADA }), com ou sem export. O servico carrega o arquivo de dois jeitos, entao qual linha ele usa fica ambigua e nao sei qual chave esta valendo." \
            "deixe uma unica linha simples NOME=valor para cada chave no web.env (sem mostrar o valor), reinicie o Web (sudo systemctl restart dgclaw-web) e rode o smoke de novo" ;;
        NENHUMA) falha 5 "o web.env nao tem ELEVENLABS_API_KEY, GROQ_API_KEY nem OPENAI_API_KEY com valor (ausentes, vazias ou com uma atribuicao vazia por ultimo). Sem uma delas o microfone do chat e a transcricao de audio nao funcionam." \
            "ponha a chave do cliente no web.env (sem mostrar o valor) e reinicie o Web: sudo systemctl restart dgclaw-web" ;;
        ELEVENLABS_API_KEY|GROQ_API_KEY|OPENAI_API_KEY|*", "*) 
            case "$mic" in *[!A-Z_,\ ]*) inconclusivo 5 "nao consegui interpretar o web.env." "confira a mao as linhas das chaves de microfone do web.env" ;;
                *) ok 5 "o servico Web tem chave para o microfone e o audio (a ultima atribuicao tem valor): $mic" ;; esac ;;
        *) inconclusivo 5 "nao consegui interpretar o web.env." "confira a mao as linhas das chaves de microfone do web.env" ;;
    esac
fi

# Cofre: so os NOMES das chaves ativas. Cruzar com o que as skills do cliente citam e passo a mao (item 5 do guia).
cofre_saida="$("$CLI" agente cofre "$SLUG" listar --json 2>/dev/null | head -c 1048577; printf 'rc=%s' "${PIPESTATUS[0]}")"
cofre_rc="${cofre_saida##*rc=}"; cofre_json="${cofre_saida%rc=*}"
if ! so_digitos "$cofre_rc" 3 || [ "$cofre_rc" -ne 0 ] || [ "${#cofre_json}" -gt 1048576 ] || [ -z "${cofre_json//[[:space:]]/}" ]; then
    inconclusivo 5 "a consulta ao cofre do agente $SLUG nao devolveu uma resposta valida (CLI com erro, sem saida ou saida grande demais). Isso nao quer dizer cofre vazio." "rode o smoke de novo; se repetir, num terminal seu: dgclaw agente cofre $SLUG listar --json | jq -r '.chaves[] | select((.revogadaEm // \"\") == \"\") | .envName'; echo \${PIPESTATUS[0]} (codigo diferente de 0 = a consulta falhou). Nao use a listagem em texto: ela mostra o final dos valores e as chaves revogadas."
elif ! printf '%s' "$cofre_json" | jq -s -e 'length==1 and (.[0] | type=="object" and .ok==true and (.chaves|type=="array"))' >/dev/null 2>&1; then
    inconclusivo 5 "a resposta da consulta ao cofre do agente $SLUG nao veio no formato esperado (um objeto com ok verdadeiro e a lista de chaves)." "rode o smoke de novo; se repetir, num terminal seu: dgclaw agente cofre $SLUG listar --json | jq -r '.chaves[] | select((.revogadaEm // \"\") == \"\") | .envName'; echo \${PIPESTATUS[0]} (codigo diferente de 0 = a consulta falhou). Nao use a listagem em texto: ela mostra o final dos valores e as chaves revogadas."
else
    NOMES="$(printf '%s' "$cofre_json" | jq -r '.chaves[] | select((.revogadaEm // "") == "") | .envName' | sort -u)"
    total="$(printf '%s\n' "$NOMES" | sed '/^$/d' | wc -l | tr -d ' ')"
    ok 5 "o cofre tem $total chave(s) ativa(s). Confira a mao contra as skills do cliente (passo 5 do guia). Nomes:"
    while IFS= read -r nome; do
        [ -n "$nome" ] || continue
        if [ "${#nome}" -le 64 ] && [[ "$nome" =~ ^[A-Z][A-Z0-9_]*$ ]]; then printf '           %s\n' "$nome"
        else printf '           (nome fora do formato)\n'; fi
    done <<<"$NOMES"
fi

# --- O que nao da para automatizar -----------------------------------------------------------------
cat <<FIM

Conferir a mao (detalhes em docs/ENTREGA-CLIENTE.md):
  2.  A chave SSH da equipe: se nao funcionou, nao recrie a VPS; use o acesso temporario do suporte. Na
      entrega, o suporte temporario revogado (dgclaw suporte status), a chave permanente da equipe fora do
      authorized_keys e as chaves de diagnostico provisorias revogadas (dgclaw chave-api listar e revogar <id>).
  3.  TasksMax, OOMPolicy e NRestarts do runner, lidos num terminal seu (nunca no chat do Admin). Esperado:
      TasksMax 2400 ou mais, OOMPolicy continue (a partir da 1.1.1), NRestarts 0. Esses valores saem de dentro
      do container, onde o agente tem sudo, entao servem de apoio e nao de prova: nao confie no que aparece na
      tela como prova. O journal do runner, se quiser
      ler, tambem so num terminal seu e so como indicio: o texto dele pode vir do agente.
  4.  Card de teste: sessao paralela, pedido curto, primeiro turno respondido, conversa aparece ao clicar.
      Repita nos dois motores (Claude e Codex).
  5.  Cruzar os nomes do cofre (listados acima) com as chaves que as skills do cliente citam, e trocar a
      chave provisoria da equipe pela do cliente.
  6.  YouTube e yt-dlp, num terminal seu (nunca no chat do Admin): yt-dlp em /usr/local/bin, diretiva
      --js-runtimes node ativa no /etc/yt-dlp.conf do container, perfil da Tela existente e login do YouTube
      pela Tela (VNC) com uma conta dedicada ao agente, mais o diagnostico agente.<agente>.youtube (a partir da
      1.1.1) ou o download curto do guia. O smoke nao executa nada disso.
  7.  Render do Chrome: num card de teste, peca um render curto (com dgclaw-pesado --timeout a partir da 1.1.1,
      ou com timeout), confira que terminou e depois que nao sobrou Chrome.
  8.  ffmpeg do container: no card de teste, peca ao agente ffmpeg -version, ou rode num terminal seu.
  9.  Login do dono pelo celular (largura 390): entre com o usuario na grafia cadastrada e confira que o campo de
      usuario nao capitaliza sozinho (autocapitalize="none"); a equivalencia de maiusculas nao existe nesta
      versao. No fim, o proprio cliente
      troca a senha em terminal privado (sudo dgclaw senha trocar; nesta versao o painel nao troca a senha do
      dono) e confirma que a antiga nao entra mais; a equipe nao fica sabendo a senha final.
  10. Skills do cliente na pasta certa, com dono (chown) e CLAUDE_PLUGIN_ROOT resolvido.
  11. Conferir a sessao principal: mande um pedido curto e confira que ela responde. O reparo
      (dgclaw agente reparar) fica para uma falha diagnosticada.
  12. Skills com texto do cliente (assinatura, nome do programa, encerramento): sem nome de outro cliente
      nem do modelo.

FIM
printf 'Resumo: %s falha(s), %s aviso(s), %s inconclusivo(s).\n' "$FALHAS" "$AVISOS" "$INCONCLUSIVOS"
if [ "$FALHAS" -gt 0 ]; then
    printf 'NAO entregue a VPS: corrija as linhas FALHA acima e rode o smoke de novo.\n'
    exit 1
fi
printf 'Sem falhas. Resolva ou justifique os avisos, repita os INCONCLUSIVOS a mao e faca a lista "conferir a mao".\n'
exit 0
