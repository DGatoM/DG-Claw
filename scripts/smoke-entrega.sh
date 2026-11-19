#!/usr/bin/env bash
# smoke-entrega.sh: confere uma VPS de cliente antes da entrega. Roda no servidor, como root.
#
#   sudo bash scripts/smoke-entrega.sh <agente> [--sem-reparar]
#
# Automatiza os itens 1, 3, 5 (microfone e nomes do cofre), 6 (so o que se le sem baixar nada), 7, 8 e 11 do
# checklist (docs/ENTREGA-CLIENTE.md). Cruzar as skills com o cofre (5) e o login do YouTube (6) ficam a mao. Cada item
# imprime OK, AVISO, FALHA ou INCONCLUSIVO (nao deu para medir: erro de leitura nao e OK nem FALHA) com a
# causa e o que fazer; PENDENTE e o que o dono confirma depois. O resto sai como lista "conferir a mao".
# Saida: 0 sem FALHA (pode haver AVISO, INCONCLUSIVO e PENDENTE), 1 com ao menos uma FALHA, 2 uso errado
# ou ferramenta ausente. Texto vindo de dentro do container (caminho, nome, saida de comando) nunca vai para o
# relatorio: as mensagens sao fixas e so entram contagens validadas ou o que o servidor ja conhece. Toda
# captura de saida do container passa por limite de bytes; estourou o limite ou veio fora do formato, e INCONCLUSIVO.
#
# O que este script NAO faz: mostrar valor de chave do cofre (so os nomes), apagar coisa do agente
# ou do servidor. O item 11 chama `dgclaw agente reparar` e reinicia o runner; --sem-reparar pula isso.
#
# Env (usadas pelos testes): DGCLAW_RAIZ (raiz falsa), DGCLAW_CLI (o dgclaw a chamar),
#   DGCLAW_SMOKE_ESPERA (segundos de espera do runner e da sessao, padrao 90).
set -u

R="${DGCLAW_RAIZ:-}"
CLI="${DGCLAW_CLI:-dgclaw}"
ESPERA="${DGCLAW_SMOKE_ESPERA:-90}"

USO='uso: sudo bash scripts/smoke-entrega.sh <agente> [--sem-reparar]'
SLUG=""
REPARAR=1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --sem-reparar) REPARAR=0; shift ;;
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
case "$ESPERA" in ''|*[!0-9]*) ESPERA=90 ;; esac

for f in jq podman curl; do
    command -v "$f" >/dev/null 2>&1 || { echo "falta o programa '$f' no PATH. Instale com: apt-get install -y $f" >&2; exit 2; }
done

C="dgclaw-$SLUG"
AGENTES_JSON="$R/etc/dgclaw/agentes.json"
[ -s "$AGENTES_JSON" ] || { echo "nao achei $AGENTES_JSON, entao nao sei quais agentes existem. Rode o smoke no servidor do DG Claw, como root." >&2; exit 2; }
REG="$(jq -r --arg s "$SLUG" '.agentes[] | select(.slug == $s and .tipo == "agente") | [(.runner // ""), (.home_host // ""), (.provedor // "?")] | @tsv' "$AGENTES_JSON" 2>/dev/null | head -n 1)"
[ -n "$REG" ] || { echo "o agente '$SLUG' nao esta em $AGENTES_JSON. Veja os que existem com: dgclaw agente listar" >&2; exit 2; }
IFS=$'\t' read -r RUNNER _ PROVEDOR <<<"$REG"
PORTA="${RUNNER##*:}"

FALHAS=0
AVISOS=0
INCONCLUSIVOS=0
PENDENTES=0
# Tira o que nao e texto simples antes de mostrar na tela (a saida de dentro do container e do agente).
limpar() { LC_ALL=C tr -c 'A-Za-z0-9 ._/@+:,=%()<>-' '?' | cut -c1-200; }
ok()    { printf '  OK     [%s] %s\n' "$1" "$2"; }
aviso() { AVISOS=$((AVISOS + 1)); printf '  AVISO  [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
falha() { FALHAS=$((FALHAS + 1)); printf '  FALHA  [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
inconclusivo() { INCONCLUSIVOS=$((INCONCLUSIVOS + 1)); printf '  INCONCLUSIVO [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
pendente() { PENDENTES=$((PENDENTES + 1)); printf '  PENDENTE [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
# cx: comando como root dentro do container. ca: o mesmo como o usuario agente.
cx() { timeout 60 podman exec "$C" "$@"; }
ca() { timeout "${PRAZO:-60}" podman exec --user agente "$C" "$@"; }
# capt <comando...>: roda o comando e devolve a saida, no maximo CAPLIM bytes (padrao 4096). Devolve o codigo do
# comando; se a saida passar do limite, devolve 99 e nada (o chamador trata como INCONCLUSIVO).
capt() {
    local o rc
    o="$(LC_ALL=C; "$@" 2>/dev/null | LC_ALL=C head -c "$(( ${CAPLIM:-4096} + 1 ))"; exit "${PIPESTATUS[0]}")"; rc=$?
    [ "$(printf '%s' "$o" | LC_ALL=C wc -c)" -le "${CAPLIM:-4096}" ] || return 99
    printf '%s' "$o"
    return "$rc"
}
# so_digitos <texto> <maximo de caracteres>: verdadeiro se for um numero curto.
so_digitos() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le "$2" ]; }
# contar_chrome: quantos processos chrome ha no container (0 se nenhum). Erro de leitura, limite estourado ou
# formato estranho = sem saida e codigo 1.
contar_chrome() {
    local n rc
    n="$(capt cx pgrep -c chrome)"; rc=$?
    so_digitos "$n" 9 || return 1
    [ "$rc" -le 1 ] || return 1
    printf '%s' "$n"
}
# contar_oom <comando...>: quantas linhas de falta de memoria o comando mostra (so o numero fica guardado, o
# texto do journal passa direto pelo grep). Se o proprio comando falhar (journal ilegivel, container mudo),
# imprime nada e sai com 1: isso e INCONCLUSIVO, nao "zero".
contar_oom() {
    local r n rc
    r="$("$@" 2>/dev/null | grep -ciE 'out of memory|oom-kill|oom_kill|killed process'; printf 'rc=%s' "${PIPESTATUS[0]}")"
    rc="${r##*rc=}"; n="${r%%$'\n'*}"
    [ "$rc" = 0 ] || return 1
    so_digitos "$n" 9 || return 1
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
    case "$so" in
        "ubuntu 24.04"|"ubuntu 22.04") ok 1 "Ubuntu ${so#ubuntu } (versao testada)" ;;
        "ubuntu 26.04") aviso 1 "Ubuntu 26.04: o DG Claw foi feito e testado no 24.04; o 26.04 tem funcionado, mas pode ter instabilidade." \
            "se a entrega nao tem pressa, recrie a VPS com Ubuntu 24.04. Se ficar no 26.04, confira com atencao os itens 3, 6 e 7 abaixo." ;;
        *) falha 1 "sistema '$(printf '%s' "$so" | limpar)': o DG Claw so instala em Ubuntu 22.04, 24.04 ou 26.04." "recrie a VPS com Ubuntu 24.04." ;;
    esac
else
    falha 1 "nao consegui ler $R/etc/os-release." "confira o sistema com: cat /etc/os-release"
fi

# --- 3. Limites do container e da unidade do runner ----------------------------------------------
printf '\n3. Limites do container e do runner\n'
RECRIAR_DICA="o dgclaw agente recriar $SLUG pode recriar o container na hora. Antes, olhe so em leitura o que existe so dentro dele (podman diff $C e podman inspect $C), decida com o dono antes de qualquer perda e so entao rode: dgclaw agente recriar $SLUG"
estado="$(podman inspect -f '{{.State.Status}}' "$C" 2>/dev/null | head -c 64 | head -n 1)"
case "$estado" in
    running|created|exited|paused|stopped|stopping|configured|initialized|removing|unknown) ;;
    '') estado=ausente ;;
    *) estado="em estado desconhecido" ;;
esac
if [ "$estado" != running ]; then
    falha 3 "o container $C esta '$estado'." "ligue com: dgclaw agente iniciar $SLUG (se nao existir, o agente nao foi criado direito: dgclaw agente reparar $SLUG)"
    CONTAINER_OK=0
else
    CONTAINER_OK=1
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
            "ponha um limite: podman update --memory $((ram_gb > 6 ? ram_gb / 2 : 3))g $C (vale ate o container ser recriado). Para ficar de vez, $RECRIAR_DICA"
    elif [ "$mem_cg" -le 2147483648 ] && [ "$ram_gb" -gt 4 ]; then
        sug=$((ram_gb / 2)); [ "$sug" -ge 3 ] || sug=3
        aviso 3 "o container tem 2 GB de memoria e o servidor tem ${ram_gb} GB. Render, Chrome da Tela e card paralelo apertam em 2 GB." \
            "suba o limite: podman update --memory ${sug}g $C (vale ate o container ser recriado; depois de recriar, rode o smoke de novo)"
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
                "suba o limite: podman update --cpus $sug $C (vale ate o container ser recriado)"
        else
            cpu_c=$((cpu_q * 100 / cpu_p))
            ok 3 "CPU do container: $((cpu_c / 100)).$(printf '%02d' $((cpu_c % 100))) (servidor com $cpus_host nucleos)"
        fi
    fi

    tasks="$(capt cx systemctl show -p TasksMax --value dgclaw-runner | head -n 1)"
    case "$tasks" in infinity) ;; *) so_digitos "$tasks" 12 || tasks="" ;; esac
    if [ "$tasks" = infinity ] || { [ -n "$tasks" ] && [ "$tasks" -ge 2400 ]; }; then
        ok 3 "TasksMax da unidade do runner: $tasks (minimo 2400)"
    elif [ -n "$tasks" ]; then
        falha 3 "TasksMax do dgclaw-runner e $tasks, abaixo de 2400. O Claude principal aborta e o card nasce parado." \
            "atualize o DG Claw (dgclaw atualizar) e, se for preciso imagem nova, confira que dgclaw imagem construir --agora terminou com sucesso. Depois: $RECRIAR_DICA"
    else
        inconclusivo 3 "nao consegui ler o TasksMax do dgclaw-runner dentro do container." "confira: podman exec $C systemctl show -p TasksMax dgclaw-runner"
    fi

    oom_pol="$(capt cx systemctl show -p OOMPolicy --value dgclaw-runner | head -n 1)"
    case "$oom_pol" in
        continue) ok 3 "OOMPolicy=continue na unidade do runner" ;;
        stop|kill)
            aviso 3 "OOMPolicy da unidade do runner e '$oom_pol', e o esperado e 'continue' (a partir da 1.1.1). Sem isso, um processo morto por falta de memoria derruba o runner todo." \
                "atualize o DG Claw quando a 1.1.1 sair. Ate la, vigie o journal do runner (item abaixo)." ;;
        '') inconclusivo 3 "nao consegui ler o OOMPolicy do dgclaw-runner dentro do container." "confira: podman exec $C systemctl show -p OOMPolicy dgclaw-runner" ;;
        *) aviso 3 "o OOMPolicy do runner veio com um valor que nao conheco (esperado: continue, stop ou kill)." "confira: podman exec $C systemctl show -p OOMPolicy dgclaw-runner" ;;
    esac

    nrest="$(capt cx systemctl show -p NRestarts --value dgclaw-runner | head -n 1)"
    so_digitos "$nrest" 9 || nrest=""
    if [ "$nrest" = 0 ]; then
        ok 3 "o runner nao reiniciou sozinho (NRestarts=0)"
    elif [ -n "$nrest" ]; then
        falha 3 "o runner reiniciou sozinho $nrest vez(es) (NRestarts=$nrest). Algo derrubou o runner." \
            "leia o motivo: podman exec $C journalctl -u dgclaw-runner --no-pager | tail -n 80. Depois de resolver, reinicie o runner (item 11) e rode o smoke de novo."
    else
        aviso 3 "nao consegui ler o NRestarts do runner." "confira: podman exec $C systemctl show -p NRestarts dgclaw-runner"
    fi

    # Kernel do servidor: _TRANSPORT=kernel (o -k so olha o boot atual e perderia um OOM de antes de um reinicio).
    # A cobertura real e medida pela entrada mais antiga que o journal ainda guarda dentro dos 7 dias.
    oom_c="$(contar_oom cx journalctl -u dgclaw-runner --since '7 days ago' --no-pager -q)"; rc_c=$?
    oom_h="$(contar_oom timeout 60 journalctl _TRANSPORT=kernel --since '7 days ago' --no-pager -q)"; rc_h=$?
    primeira="$(timeout 60 journalctl _TRANSPORT=kernel --since '7 days ago' --no-pager -q -o short-unix 2>/dev/null | head -n 1 | head -c 64)"
    ts_ini="${primeira%%.*}"; ts_ini="${ts_ini%% *}"
    cobertura=""
    if so_digitos "$ts_ini" 12; then
        dias_k=$(( ($(date +%s) - ts_ini) / 86400 )); [ "$dias_k" -ge 0 ] || dias_k=0
        if [ "$dias_k" -ge 6 ]; then cobertura="7 dias"
        elif [ "$dias_k" -eq 0 ]; then cobertura="menos de 1 dia, porque e o que o journal do kernel guarda"
        else cobertura="$dias_k dia(s), porque e o que o journal do kernel guarda"; fi
    fi
    if [ "$rc_c" -ne 0 ] || [ "$rc_h" -ne 0 ]; then
        inconclusivo 3 "nao consegui ler o journal dos ultimos 7 dias (do runner, do kernel do servidor ou os dois). Isso nao quer dizer zero eventos de falta de memoria." \
            "leia a mao: podman exec $C journalctl -u dgclaw-runner --since '7 days ago' --no-pager | grep -i 'out of memory' e journalctl _TRANSPORT=kernel --since '7 days ago' | grep -i 'out of memory'"
    elif [ "$oom_c" -eq 0 ] && [ "$oom_h" -eq 0 ]; then
        if [ -n "$cobertura" ]; then
            ok 3 "nenhum OOM no journal do runner (7 dias) nem no do kernel do servidor (cobertura do kernel: $cobertura)"
        else
            inconclusivo 3 "nenhum OOM achado, mas o journal do kernel do servidor nao mostrou nenhuma entrada nos ultimos 7 dias, entao nao sei o que ele cobre." \
                "confira a mao: journalctl _TRANSPORT=kernel --since '7 days ago' | head e se o journal e persistente (ls /var/log/journal)"
        fi
    else
        falha 3 "OOM nos ultimos 7 dias: $oom_c linha(s) no journal do runner e $oom_h no kernel do servidor." \
            "veja quem foi morto: journalctl _TRANSPORT=kernel --since '7 days ago' | grep -i 'out of memory'. Suba a memoria do container (podman update --memory <N>g $C) e a do plano da VPS, se for o caso."
    fi
fi

# --- 8. ffmpeg -------------------------------------------------------------------------------------
printf '\n8. ffmpeg no servidor e no container\n'
if command -v ffmpeg >/dev/null 2>&1 || [ -x "$R/usr/bin/ffmpeg" ]; then
    ok 8 "ffmpeg presente no servidor"
else
    falha 8 "ffmpeg nao esta no servidor. As miniaturas de video e foto do painel ficam sem previa." "apt-get install -y ffmpeg"
fi
if [ "$CONTAINER_OK" = 1 ]; then
    if ca sh -c 'command -v ffmpeg' >/dev/null 2>&1; then
        ok 8 "ffmpeg presente no container"
    else
        falha 8 "ffmpeg nao esta no container $C. Video, audio e carrossel dependem dele." "a imagem esta velha ou incompleta: dgclaw imagem construir --agora (confira que terminou com sucesso), depois $RECRIAR_DICA"
    fi
else
    aviso 8 "ffmpeg do container nao conferido: o container nao esta de pe." "resolva o item 3 e rode de novo."
fi

# --- 5. Microfone e cofre --------------------------------------------------------------------------
printf '\n5. Microfone do chat e nomes das chaves do cofre (so os nomes, nunca os valores)\n'
# Microfone: o servico Web le a chave do proprio arquivo de ambiente (web.env). O arquivo e lido como texto
# (nunca executado) e so o veredito "tem valor" sai; o valor nunca e impresso. Vale a ULTIMA atribuicao.
WEBENV="$R/etc/dgclaw/web.env"
if [ ! -r "$WEBENV" ]; then
    inconclusivo 5 "nao consegui ler o arquivo de ambiente do servico Web ($(printf '%s' "$WEBENV" | limpar)), entao nao sei se o microfone tem chave." \
        "confira a mao a ultima linha de GROQ_API_KEY, OPENAI_API_KEY e ELEVENLABS_API_KEY no web.env (so se tem valor, sem mostrar o valor)"
else
    mic="$(head -c 1048576 "$WEBENV" 2>/dev/null | LC_ALL=C awk '
        /^[[:space:]]*(export[[:space:]]+)?(GROQ|OPENAI|ELEVENLABS)_API_KEY[[:space:]]*=/ {
            k = $0; sub(/^[[:space:]]*(export[[:space:]]+)?/, "", k); sub(/[[:space:]]*=.*$/, "", k)
            v = $0; sub(/^[^=]*=/, "", v)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
            if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) { v = substr(v, 2, length(v) - 2); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v) }
            tem[k] = (length(v) > 0) ? 1 : 0
        }
        END {
            n = split("ELEVENLABS_API_KEY GROQ_API_KEY OPENAI_API_KEY", ordem, " ")
            for (i = 1; i <= n; i++) if (tem[ordem[i]] == 1) lista = lista (lista == "" ? "" : ", ") ordem[i]
            print (lista == "" ? "NENHUMA" : lista)
        }' 2>/dev/null)"
    case "$mic" in
        NENHUMA) falha 5 "o web.env nao tem ELEVENLABS_API_KEY, GROQ_API_KEY nem OPENAI_API_KEY com valor (ausentes, vazias ou com uma atribuicao vazia por ultimo). Sem uma delas o microfone do chat e a transcricao de audio nao funcionam." \
            "ponha a chave do cliente no web.env (sem mostrar o valor) e reinicie o Web: sudo systemctl restart dgclaw-web" ;;
        ELEVENLABS_API_KEY|GROQ_API_KEY|OPENAI_API_KEY|*", "*) 
            case "$mic" in *[!A-Z_,\ ]*) inconclusivo 5 "nao consegui interpretar o web.env." "confira a mao as linhas das chaves de microfone do web.env" ;;
                *) ok 5 "o servico Web tem chave para o microfone e o audio (a ultima atribuicao tem valor): $mic" ;; esac ;;
        *) inconclusivo 5 "nao consegui interpretar o web.env." "confira a mao as linhas das chaves de microfone do web.env" ;;
    esac
fi

# Cofre: so os NOMES das chaves ativas. Cruzar com o que as skills do cliente citam e passo a mao (item 5 do guia).
cofre_json="$("$CLI" agente cofre "$SLUG" listar --json 2>/dev/null | head -c 1048576)"
if ! printf '%s' "$cofre_json" | jq -e '.chaves' >/dev/null 2>&1; then
    falha 5 "nao consegui listar o cofre do agente $SLUG." "rode a mao e leia a mensagem: dgclaw agente cofre $SLUG listar"
else
    NOMES="$(printf '%s' "$cofre_json" | jq -r '.chaves[] | select((.revogadaEm // "") == "") | .envName' | sort -u)"
    total="$(printf '%s\n' "$NOMES" | sed '/^$/d' | wc -l | tr -d ' ')"
    ok 5 "o cofre tem $total chave(s) ativa(s): $(printf '%s\n' "$NOMES" | sed '/^$/d' | paste -sd, - | sed 's/,/, /g' | limpar). Confira a mao contra as skills do cliente (passo 5 do guia)."
fi

# --- 6. yt-dlp -------------------------------------------------------------------------------------
printf '\n6. yt-dlp e perfil da Tela (o login do YouTube e a mao)\n'
if [ "$CONTAINER_OK" != 1 ]; then
    aviso 6 "yt-dlp nao conferido: o container nao esta de pe." "resolva o item 3 e rode de novo."
else
    ytpath="$(capt ca sh -c 'command -v yt-dlp')"; rc=$?
    ytpath="${ytpath%%$'\n'*}"
    if [ "$rc" -eq 1 ] && [ -z "$ytpath" ]; then
        falha 6 "o yt-dlp nao esta no PATH do agente." "a imagem esta velha: dgclaw imagem construir --agora (confira que terminou com sucesso), depois $RECRIAR_DICA"
    elif [ "$rc" -ne 0 ]; then
        inconclusivo 6 "nao consegui perguntar ao container onde esta o yt-dlp (erro, prazo ou resposta grande demais)." "confira: podman exec --user agente $C sh -c 'command -v yt-dlp'"
    elif [ "$ytpath" = /usr/local/bin/yt-dlp ]; then
        ok 6 "yt-dlp em /usr/local/bin/yt-dlp"
    else
        aviso 6 "o yt-dlp do agente nao esta em /usr/local/bin (a partir da 1.1.1 ele fica la). Fora dali, um processo sem o PATH do venv nao o acha." \
            "veja onde ele esta: podman exec --user agente $C sh -c 'command -v yt-dlp'. Quando a 1.1.1 sair, atualize."
    fi
    # (a) a diretiva --js-runtimes node, ativa (nao comentada), na configuracao global do container.
    ca grep -qE '^[[:space:]]*--js-runtimes[[:space:]]+node([[:space:]]|$)' /etc/yt-dlp.conf >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
        ok 6 "/etc/yt-dlp.conf tem a diretiva --js-runtimes node ativa"
    elif [ "$rc" -eq 1 ]; then
        aviso 6 "o /etc/yt-dlp.conf do container nao tem a diretiva ativa --js-runtimes node (ausente ou comentada). Sem ela o yt-dlp nao resolve o desafio do YouTube." \
            "atualize o DG Claw e confira que dgclaw imagem construir --agora terminou com sucesso. Depois: $RECRIAR_DICA"
    else
        inconclusivo 6 "nao consegui ler o /etc/yt-dlp.conf dentro do container." "confira: podman exec --user agente $C cat /etc/yt-dlp.conf"
    fi
    # (b) o perfil da Tela, onde ficam os logins.
    ca test -d /home/agente/.tela-chrome >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
        ok 6 "o perfil da Tela existe (/home/agente/.tela-chrome)"
    elif [ "$rc" -eq 1 ]; then
        aviso 6 "o perfil da Tela (/home/agente/.tela-chrome) ainda nao existe: a Tela nunca foi aberta." \
            "abra a Tela do agente (dgclaw agente tela $SLUG) e entre no YouTube com uma conta dedicada ao agente."
    else
        inconclusivo 6 "nao consegui conferir o perfil da Tela dentro do container." "confira: podman exec --user agente $C ls -ld /home/agente/.tela-chrome"
    fi
    # (c) o login do YouTube e o download nao se medem daqui: sao a mao (passo 6 do guia).
    pendente 6 "login do YouTube e download: o smoke nao baixa nada nem mede o login." \
        "entre na Tela com a conta dedicada ao agente e confira o diagnostico agente.$SLUG.youtube (a partir da 1.1.1). Antes disso, rode a mao: podman exec --user agente $C yt-dlp --cookies-from-browser \"chrome+basictext:/home/agente/.tela-chrome\" -F <url de um video curto>"
fi

# --- 7. Render headless sem sobra de Chrome --------------------------------------------------------
printf '\n7. Render headless nao deixa Chrome para tras\n'
if [ "$CONTAINER_OK" != 1 ]; then
    aviso 7 "render nao testado: o container nao esta de pe." "resolva o item 3 e rode de novo."
elif ! ca sh -c 'command -v google-chrome-stable' >/dev/null 2>&1; then
    aviso 7 "nao ha google-chrome-stable no container (imagem fora do amd64 usa o Chromium do Playwright)." \
        "teste um render curto a mao, no card de teste, e confira o Chrome depois (item 7 do checklist)."
else
    # Perfil descartavel numa pasta privada desta execucao, criada dentro do container; so ela e apagada.
    dir_ch="$(PRAZO=30 capt ca mktemp -d /tmp/smoke-entrega.XXXXXX | head -n 1)"
    case "$dir_ch" in
        /tmp/smoke-entrega.??????)
            antes="$(contar_chrome)"; rc_a=$?
            PRAZO=90 ca google-chrome-stable --headless=new --no-sandbox --disable-gpu --user-data-dir="$dir_ch/perfil" --dump-dom about:blank >/dev/null 2>&1
            rc=$?
            sleep 3
            depois="$(contar_chrome)"; rc_d=$?
            PRAZO=30 ca rm -rf -- "$dir_ch" >/dev/null 2>&1
            if [ "$rc" -ne 0 ]; then
                falha 7 "o Chrome headless nao rodou (codigo $rc). Render de carrossel e video nao vai funcionar." \
                    "rode a mao e leia o erro: podman exec --user agente $C google-chrome-stable --headless=new --no-sandbox --dump-dom about:blank"
            elif [ "$rc_a" -ne 0 ] || [ "$rc_d" -ne 0 ]; then
                inconclusivo 7 "nao consegui contar os processos do Chrome no container (antes ou depois do render). Isso nao quer dizer que nao sobrou nada." \
                    "confira a mao: podman exec $C pgrep -c chrome (antes e depois de um render curto)"
            elif [ "$depois" -gt "$antes" ]; then
                falha 7 "sobraram $((depois - antes)) processo(s) do Chrome depois do render (antes: $antes, depois: $depois; o Chrome da Tela continua vivo e esta na conta)." \
                    "o render nao esta sendo encerrado. Use o dgclaw-pesado --timeout (a partir da 1.1.1) e mate o resto: podman exec $C pkill -f smoke-entrega"
            else
                ok 7 "render headless terminou e nao sobrou Chrome (antes: $antes, depois: $depois; a conta inclui o Chrome da Tela)"
            fi ;;
        *)
            inconclusivo 7 "nao consegui criar a pasta privada do render de teste dentro do container." "confira: podman exec --user agente $C mktemp -d /tmp/smoke-entrega.XXXXXX" ;;
    esac
fi

# --- 11. Reparar e reiniciar o runner --------------------------------------------------------------
printf '\n11. Sessao principal de pe depois de reparar e reiniciar o runner\n'
if [ "$REPARAR" = 0 ]; then
    aviso 11 "pulado por --sem-reparar." "rode sem essa opcao antes de entregar."
elif [ "$CONTAINER_OK" != 1 ]; then
    falha 11 "o container $C nao esta de pe, entao nao ha o que reparar." "resolva o item 3 e rode de novo."
elif ! so_digitos "$PORTA" 5 || [ "$PORTA" -lt 1 ] || [ "$PORTA" -gt 65535 ]; then
    falha 11 "a porta do runner em $AGENTES_JSON nao e um numero de 1 a 65535, entao nao sei onde conferir a saude." "confira o campo runner do agente $SLUG em $AGENTES_JSON e rode: dgclaw agente reparar $SLUG"
else
    # A saida do reparar nao entra no relatorio (so o codigo de saida): vai para o lixo na origem.
    "$CLI" agente reparar "$SLUG" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then
        falha 11 "dgclaw agente reparar $SLUG saiu com codigo $rc." "rode a mao e leia a mensagem inteira: dgclaw agente reparar $SLUG"
    else
        ok 11 "dgclaw agente reparar $SLUG terminou sem erro"
        if ! cx systemctl restart dgclaw-runner >/dev/null 2>&1; then
            falha 11 "nao consegui reiniciar o dgclaw-runner dentro do container." "veja: podman exec $C journalctl -u dgclaw-runner --no-pager | tail -n 50"
        else
            # Confere no JSON do /api/saude o agente PEDIDO (slug, estado e ptyVivo da sessao principal);
            # processo claude/codex solto ou sessao paralela ativa nao valem. Vira so uma palavra fixa.
            t=0; respondeu=0; veredito=""
            while [ "$t" -lt "$ESPERA" ]; do
                corpo="$(CAPLIM=65536 capt curl -fsS --noproxy '*' --max-time 3 "http://127.0.0.1:$PORTA/api/saude")"; rc_curl=$?
                if [ "$rc_curl" -eq 99 ]; then
                    # Resposta maior que o limite: nao se interpreta.
                    respondeu=1; veredito="ilegivel"; break
                elif [ -n "$corpo" ]; then
                    respondeu=1
                    veredito="$(printf '%s' "$corpo" | jq -r --arg s "$SLUG" 'try (if (.agente.slug // "") != $s then "outro" elif .agente.ptyVivo != true then "parada" elif ((.agente.status // "") | IN("idle", "working", "waiting_input")) | not then "estado" else "viva" end) catch "ilegivel"' 2>/dev/null)"
                    [ "$veredito" = viva ] && break
                fi
                sleep 1; t=$((t + 1))
            done
            if [ "$respondeu" != 1 ]; then
                falha 11 "o runner nao respondeu em 127.0.0.1:$PORTA/api/saude em ${ESPERA}s depois de reiniciar." \
                    "veja: podman exec $C journalctl -u dgclaw-runner --no-pager | tail -n 50 e tente: dgclaw agente reiniciar $SLUG"
            else
                ok 11 "o runner voltou e responde em 127.0.0.1:$PORTA/api/saude"
                case "$veredito" in
                    viva) ok 11 "a sessao principal do agente $SLUG ($PROVEDOR) esta de pe" ;;
                    outro) falha 11 "o runner na porta $PORTA respondeu, mas o /api/saude nao e do agente $SLUG." "confira a porta do agente em /etc/dgclaw/agentes.json e rode: dgclaw agente reparar $SLUG" ;;
                    parada) falha 11 "a sessao principal do agente $SLUG esta parada (ptyVivo falso) depois de ${ESPERA}s. Uma sessao paralela ativa nao a substitui." \
                        "abra o painel do agente e confira o estado da sessao principal. Se estiver parada: dgclaw agente reiniciar $SLUG" ;;
                    estado) falha 11 "a sessao principal do agente $SLUG esta com terminal vivo, mas em estado fora do esperado (nem idle, nem working, nem waiting_input)." \
                        "abra o painel do agente e confira o estado dela. Se estiver parada ou com erro: dgclaw agente reiniciar $SLUG" ;;
                    *) inconclusivo 11 "o /api/saude respondeu, mas num formato que nao consegui ler." "confira a mao: curl -s http://127.0.0.1:$PORTA/api/saude" ;;
                esac
            fi
        fi
    fi
fi

# --- O que nao da para automatizar -----------------------------------------------------------------
cat <<FIM

Conferir a mao (detalhes em docs/ENTREGA-CLIENTE.md):
  2.  A chave SSH da equipe: se nao funcionou, nao recrie a VPS; use o acesso temporario do suporte. Na
      entrega, o suporte temporario revogado (dgclaw suporte status) e a chave permanente da equipe fora do
      authorized_keys.
  4.  Card de teste: sessao paralela, pedido curto, primeiro turno respondido, conversa aparece ao clicar.
      Repita nos dois motores (Claude e Codex).
  5.  Cruzar os nomes do cofre (listados acima) com as chaves que as skills do cliente citam, e trocar a
      chave provisoria da equipe pela do cliente.
  6.  Login do YouTube pela Tela (VNC) com uma conta dedicada ao agente e o item de diagnostico
      agente.<agente>.youtube (a partir da 1.1.1), ou o yt-dlp a mao. O smoke deixa PENDENTE e nao baixa nada.
  9.  Login do dono pelo celular (largura 390), com usuario em maiuscula automatica. No fim, o proprio cliente
      troca a senha em terminal privado (sudo dgclaw senha trocar) ou pelo painel e confirma que a antiga nao
      entra mais; a equipe nao fica sabendo a senha final.
  10. Skills do cliente na pasta certa, com dono (chown) e CLAUDE_PLUGIN_ROOT resolvido.
  12. Skills com texto do cliente (assinatura, nome do programa, encerramento): sem nome de outro cliente
      nem do modelo.

FIM
printf 'Resumo: %s falha(s), %s aviso(s), %s inconclusivo(s), %s pendente(s).\n' "$FALHAS" "$AVISOS" "$INCONCLUSIVOS" "$PENDENTES"
if [ "$FALHAS" -gt 0 ]; then
    printf 'NAO entregue a VPS: corrija as linhas FALHA acima e rode o smoke de novo.\n'
    exit 1
fi
printf 'Sem falhas. Resolva ou justifique os avisos, repita os INCONCLUSIVOS a mao e faca a lista "conferir a mao".\n'
exit 0
