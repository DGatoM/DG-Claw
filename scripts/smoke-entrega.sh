#!/usr/bin/env bash
# smoke-entrega.sh: confere uma VPS de cliente antes da entrega. Roda no servidor, como root.
#
#   sudo bash scripts/smoke-entrega.sh <agente> [--video <url>] [--sem-reparar]
#
# Automatiza os itens 1, 3, 5, 6, 7, 8 e 11 do checklist (docs/ENTREGA-CLIENTE.md). Cada item
# imprime OK, AVISO, FALHA ou INCONCLUSIVO (nao deu para medir: erro de leitura nao e OK nem FALHA) com a
# causa e o que fazer; PENDENTE e o que o dono confirma depois. O resto sai como lista "conferir a mao".
# Saida: 0 sem FALHA (pode haver AVISO, INCONCLUSIVO e PENDENTE), 1 com ao menos uma FALHA, 2 uso errado
# ou ferramenta ausente. A saida bruta de dentro do container nunca vai para o relatorio: as mensagens
# sao fixas e o que vem de fora so aparece depois de validado.
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

USO='uso: sudo bash scripts/smoke-entrega.sh <agente> [--video <url>] [--sem-reparar]'
SLUG=""
VIDEO=""
REPARAR=1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --video)
            [ "$#" -ge 2 ] || { echo "faltou a URL depois de --video. $USO" >&2; exit 2; }
            VIDEO="$2"; shift 2 ;;
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
# contar_chrome: quantos processos chrome ha no container (0 se nenhum). Erro de leitura = sem saida e codigo 1.
contar_chrome() {
    local n rc
    n="$(cx pgrep -c chrome 2>/dev/null)"; rc=$?
    case "$n" in ''|*[!0-9]*) return 1 ;; esac
    [ "$rc" -le 1 ] || return 1
    printf '%s' "$n"
}
# contar_oom <comando...>: quantas linhas de falta de memoria o comando mostra. Se o proprio comando
# falhar (journal ilegivel, container mudo), imprime nada e sai com 1: isso e INCONCLUSIVO, nao "zero".
contar_oom() {
    local r n rc
    r="$("$@" 2>/dev/null | grep -ciE 'out of memory|oom-kill|oom_kill|killed process'; printf 'rc=%s' "${PIPESTATUS[0]}")"
    rc="${r##*rc=}"; n="${r%%$'\n'*}"
    [ "$rc" = 0 ] || return 1
    case "$n" in ''|*[!0-9]*) return 1 ;; esac
    printf '%s' "$n"
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
RECRIAR_DICA="veja o que existe so dentro do container e decida com o dono antes de qualquer perda: dgclaw agente recriar $SLUG (sem --forcar, ele lista e para)"
estado="$(podman inspect -f '{{.State.Status}}' "$C" 2>/dev/null)"
if [ "$estado" != running ]; then
    falha 3 "o container $C esta '$(printf '%s' "${estado:-ausente}" | limpar)'." "ligue com: dgclaw agente iniciar $SLUG (se nao existir, o agente nao foi criado direito: dgclaw agente reparar $SLUG)"
    CONTAINER_OK=0
else
    CONTAINER_OK=1
    lim="$(podman inspect -f '{{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}}' "$C" 2>/dev/null)"
    read -r pids_lim nano_cpus <<<"$lim"
    case "${pids_lim:-x}" in *[!0-9-]*) pids_lim="" ;; esac
    case "${nano_cpus:-x}" in *[!0-9]*) nano_cpus="" ;; esac

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
    mem_cg=""; pids_cg=""
    if [ "$cg_ok" = 1 ]; then
        mem_cg="$(ler_cgroup "$cg_path" memory.max)"
        pids_cg="$(ler_cgroup "$cg_path" pids.max)"
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
    if [ -z "$nano_cpus" ]; then
        aviso 3 "nao consegui ler o limite de CPU do container." "confira: podman inspect -f '{{.HostConfig.NanoCpus}}' $C"
    elif [ "$nano_cpus" -eq 0 ]; then
        ok 3 "CPU do container: sem limite ($cpus_host nucleos no servidor)"
    elif [ "$nano_cpus" -le 1000000000 ] && [ "$cpus_host" -gt 1 ]; then
        sug=$((cpus_host / 2)); [ "$sug" -ge 2 ] || sug=2
        aviso 3 "o container tem 1 CPU e o servidor tem $cpus_host nucleos." \
            "suba o limite: podman update --cpus $sug $C (vale ate o container ser recriado)"
    else
        ok 3 "CPU do container: $((nano_cpus / 1000000000)) (servidor com $cpus_host nucleos)"
    fi

    tasks="$(cx systemctl show -p TasksMax --value dgclaw-runner 2>/dev/null | head -n 1)"
    case "$tasks" in infinity|''|*[!0-9]*) [ "$tasks" = infinity ] || tasks="" ;; esac
    if [ "$tasks" = infinity ] || { [ -n "$tasks" ] && [ "$tasks" -ge 2400 ]; }; then
        ok 3 "TasksMax da unidade do runner: $tasks (minimo 2400)"
    elif [ -n "$tasks" ]; then
        falha 3 "TasksMax do dgclaw-runner e $tasks, abaixo de 2400. O Claude principal aborta e o card nasce parado." \
            "atualize o DG Claw (dgclaw atualizar) e, se for preciso imagem nova, confira que dgclaw imagem construir --agora terminou com sucesso. Depois: $RECRIAR_DICA"
    else
        inconclusivo 3 "nao consegui ler o TasksMax do dgclaw-runner dentro do container." "confira: podman exec $C systemctl show -p TasksMax dgclaw-runner"
    fi

    oom_pol="$(cx systemctl show -p OOMPolicy --value dgclaw-runner 2>/dev/null | head -n 1)"
    case "$oom_pol" in
        continue) ok 3 "OOMPolicy=continue na unidade do runner" ;;
        stop|kill)
            aviso 3 "OOMPolicy da unidade do runner e '$oom_pol', e o esperado e 'continue' (a partir da 1.1.1). Sem isso, um processo morto por falta de memoria derruba o runner todo." \
                "atualize o DG Claw quando a 1.1.1 sair. Ate la, vigie o journal do runner (item abaixo)." ;;
        '') inconclusivo 3 "nao consegui ler o OOMPolicy do dgclaw-runner dentro do container." "confira: podman exec $C systemctl show -p OOMPolicy dgclaw-runner" ;;
        *) aviso 3 "o OOMPolicy do runner veio com um valor que nao conheco (esperado: continue, stop ou kill)." "confira: podman exec $C systemctl show -p OOMPolicy dgclaw-runner" ;;
    esac

    nrest="$(cx systemctl show -p NRestarts --value dgclaw-runner 2>/dev/null | head -n 1)"
    case "$nrest" in ''|*[!0-9]*) nrest="" ;; esac
    if [ "$nrest" = 0 ]; then
        ok 3 "o runner nao reiniciou sozinho (NRestarts=0)"
    elif [ -n "$nrest" ]; then
        falha 3 "o runner reiniciou sozinho $nrest vez(es) (NRestarts=$nrest). Algo derrubou o runner." \
            "leia o motivo: podman exec $C journalctl -u dgclaw-runner --no-pager | tail -n 80. Depois de resolver, reinicie o runner (item 11) e rode o smoke de novo."
    else
        aviso 3 "nao consegui ler o NRestarts do runner." "confira: podman exec $C systemctl show -p NRestarts dgclaw-runner"
    fi

    oom_c="$(contar_oom cx journalctl -u dgclaw-runner --since '7 days ago' --no-pager -q)"; rc_c=$?
    oom_h="$(contar_oom timeout 60 journalctl -k --since '7 days ago' --no-pager -q)"; rc_h=$?
    if [ "$rc_c" -ne 0 ] || [ "$rc_h" -ne 0 ]; then
        inconclusivo 3 "nao consegui ler o journal dos ultimos 7 dias (do runner, do kernel do servidor ou os dois). Isso nao quer dizer zero eventos de falta de memoria." \
            "leia a mao: podman exec $C journalctl -u dgclaw-runner --since '7 days ago' --no-pager | grep -i 'out of memory' e journalctl -k --since '7 days ago' | grep -i 'out of memory'"
    elif [ "$oom_c" -eq 0 ] && [ "$oom_h" -eq 0 ]; then
        ok 3 "nenhum OOM no journal dos ultimos 7 dias (container e servidor)"
    else
        falha 3 "OOM nos ultimos 7 dias: $oom_c linha(s) no journal do runner e $oom_h no kernel do servidor." \
            "veja quem foi morto: journalctl -k --since '7 days ago' | grep -i 'out of memory'. Suba a memoria do container (podman update --memory <N>g $C) e a do plano da VPS, se for o caso."
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
printf '\n5. Microfone do chat e chaves das skills (so os nomes, nunca os valores)\n'
# Microfone: o servico Web le a chave do proprio arquivo de ambiente (web.env). So a existencia da linha.
WEBENV="$R/etc/dgclaw/web.env"
if [ ! -r "$WEBENV" ]; then
    inconclusivo 5 "nao consegui ler o arquivo de ambiente do servico Web ($(printf '%s' "$WEBENV" | limpar)), entao nao sei se o microfone tem chave." \
        "confira a mao se ha GROQ_API_KEY, OPENAI_API_KEY ou ELEVENLABS_API_KEY no web.env (so a linha, sem mostrar o valor)"
else
    mic=""
    for k in GROQ_API_KEY OPENAI_API_KEY ELEVENLABS_API_KEY; do
        grep -qE "^[[:space:]]*(export[[:space:]]+)?$k=[^[:space:]]" "$WEBENV" 2>/dev/null && mic="$mic${mic:+, }$k"
    done
    if [ -n "$mic" ]; then
        ok 5 "o servico Web tem chave para o microfone e o audio: $mic"
    else
        falha 5 "o web.env nao tem GROQ_API_KEY, OPENAI_API_KEY nem ELEVENLABS_API_KEY. Sem uma delas o microfone do chat e a transcricao de audio nao funcionam." \
            "ponha a chave do cliente no web.env (sem mostrar o valor) e reinicie o Web: sudo systemctl restart dgclaw-web"
    fi
fi

# Credenciais das skills: item separado, cruzado com o cofre do agente.
cofre_json="$("$CLI" agente cofre "$SLUG" listar --json 2>/dev/null | head -c 1048576)"
if ! printf '%s' "$cofre_json" | jq -e '.chaves' >/dev/null 2>&1; then
    falha 5 "nao consegui listar o cofre do agente $SLUG." "rode a mao e leia a mensagem: dgclaw agente cofre $SLUG listar"
else
    NOMES="$(printf '%s' "$cofre_json" | jq -r '.chaves[] | select((.revogadaEm // "") == "") | .envName' | sort -u)"
    total="$(printf '%s\n' "$NOMES" | sed '/^$/d' | wc -l | tr -d ' ')"
    ok 5 "o cofre tem $total chave(s) ativa(s): $(printf '%s\n' "$NOMES" | sed '/^$/d' | paste -sd, - | sed 's/,/, /g' | limpar)"
    # A varredura roda DENTRO do container, como o usuario agente (nao le o disco do host, nao segue link),
    # com prazo e limite de volume. O fim da lista traz uma marca fixa: sem ela, a leitura foi cortada.
    # shellcheck disable=SC2016 # o script e para o sh de dentro do container
    SCAN='
for b in /home/agente/.claude/skills /home/agente/.agents/skills; do
  [ -d "$b" ] && [ ! -L "$b" ] || continue
  echo "PASTA"
  for d in "$b"/*/; do
    d="${d%/}"
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    n="${d##*/}"
    find -P "$d" -xdev -type f -size -512k \( -name "*.md" -o -name "*.sh" -o -name "*.py" -o -name "*.js" -o -name "*.mjs" \) -exec grep -hoE "\b[A-Z][A-Z0-9_]*_(API_KEY|TOKEN)\b" {} + 2>/dev/null | sort -u | head -n 40 | while IFS= read -r v; do printf "VAR %s %s\n" "$n" "$v"; done
  done
done
echo FIM-DA-VARREDURA'
    varrido="$(PRAZO=90 ca sh -c "$SCAN" 2>/dev/null | head -c 65536)"
    if ! printf '%s\n' "$varrido" | grep -qx 'FIM-DA-VARREDURA'; then
        inconclusivo 5 "nao consegui varrer as skills dentro do container (erro de leitura, prazo ou volume acima do limite). Nao sei se as chaves que elas citam estao no cofre." \
            "confira a mao (item 10 do checklist): podman exec --user agente $C ls /home/agente/.claude/skills /home/agente/.agents/skills"
    elif ! printf '%s\n' "$varrido" | grep -qx 'PASTA'; then
        aviso 5 "nao achei a pasta de skills do agente (.claude/skills ou .agents/skills) dentro do container; nao deu para cruzar as skills com o cofre." \
            "confira a mao (item 10 do checklist): podman exec --user agente $C ls /home/agente/.claude/skills /home/agente/.agents/skills"
    else
        faltou_algum=0
        while IFS=' ' read -r marca sk nome; do
            [ "$marca" = VAR ] || continue
            # Nome de skill e de variavel vieram de dentro do container: so seguem se tiverem o formato esperado.
            case "$nome" in ''|[!A-Z]*|*[!A-Z0-9_]*) continue ;; esac
            if ! printf '%s\n' "$NOMES" | grep -qx "$nome"; then
                faltou_algum=1
                aviso 5 "a skill '$(printf '%s' "$sk" | limpar)' cita $nome e essa chave nao esta no cofre." \
                    "se o cliente usa essa skill: printf %s \"\$CHAVE\" | dgclaw agente cofre $SLUG guardar $nome. Se a skill nao sera usada, ignore."
            fi
        done <<<"$varrido"
        [ "$faltou_algum" = 0 ] && ok 5 "toda chave citada pelas skills instaladas esta no cofre"
    fi
fi

# --- 6. yt-dlp -------------------------------------------------------------------------------------
printf '\n6. yt-dlp e download de video\n'
if [ "$CONTAINER_OK" != 1 ]; then
    aviso 6 "yt-dlp nao conferido: o container nao esta de pe." "resolva o item 3 e rode de novo."
else
    ytpath="$(ca sh -c 'command -v yt-dlp' 2>/dev/null | head -n 1)"
    if [ -z "$ytpath" ]; then
        falha 6 "o yt-dlp nao esta no PATH do agente." "a imagem esta velha: dgclaw imagem construir --agora (confira que terminou com sucesso), depois $RECRIAR_DICA"
    elif [ "$ytpath" = /usr/local/bin/yt-dlp ]; then
        ok 6 "yt-dlp em /usr/local/bin/yt-dlp"
    else
        aviso 6 "o yt-dlp esta em $(printf '%s' "$ytpath" | limpar) e nao em /usr/local/bin (a partir da 1.1.1). Fora do /usr/local/bin, um processo sem o PATH do venv nao o acha." \
            "confira que o agente o acha pelo painel (peca um download curto no card de teste). Quando a 1.1.1 sair, atualize."
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
            "abra a Tela do agente (dgclaw agente tela $SLUG) e entre no YouTube com a conta do cliente."
    else
        inconclusivo 6 "nao consegui conferir o perfil da Tela dentro do container." "confira: podman exec --user agente $C ls -ld /home/agente/.tela-chrome"
    fi
    # (c) a autenticacao do YouTube nao se mede daqui: o dono confirma pela Tela.
    pendente 6 "autenticacao do YouTube: quem confirma e o dono, pela Tela (o smoke nao mede o login)." \
        "peca ao dono para abrir o YouTube na Tela e confirmar que esta logado. Se o login cair depois, o diagnostico agente.$SLUG.youtube avisa."
    if [ -z "$VIDEO" ]; then
        aviso 6 "o download de teste nao rodou: faltou --video <url>." \
            "depois de entrar no YouTube pela Tela com a conta do cliente, rode de novo com: --video <url de um video curto>"
    else
        # Diretorio privado desta execucao, criado dentro do container; so ele e apagado no fim.
        dir_yt="$(PRAZO=30 ca mktemp -d /tmp/smoke-entrega.XXXXXX 2>/dev/null | head -n 1)"
        case "$dir_yt" in
            /tmp/smoke-entrega.??????)
                # A saida do yt-dlp e descartada na origem; o resultado e o codigo de saida e o arquivo final.
                PRAZO=150 ca yt-dlp --no-playlist --no-progress -f 'worst[ext=mp4]/worst' --max-filesize 30M -o "$dir_yt/video.%(ext)s" -- "$VIDEO" >/dev/null 2>&1
                rc=$?
                # shellcheck disable=SC2016
                if [ "$rc" -eq 0 ] && PRAZO=30 ca sh -c 'for f in "$1"/video.*; do case "$f" in *.part|*.ytdl|*.temp) ;; *) [ -s "$f" ] && exit 0 ;; esac; done; exit 1' _ "$dir_yt" >/dev/null 2>&1; then
                    ok 6 "o yt-dlp baixou o video de teste"
                else
                    falha 6 "o yt-dlp falhou (codigo $rc) ou nao deixou um arquivo final com conteudo." \
                        "se pede login ou 'nao e um robo', refaca o login do YouTube pela Tela com a conta do cliente (item 6 do checklist). Para ver o erro: podman exec --user agente $C yt-dlp -v <url>"
                fi
                PRAZO=30 ca rm -rf -- "$dir_yt" >/dev/null 2>&1 ;;
            *)
                inconclusivo 6 "nao consegui criar a pasta privada do download de teste dentro do container." "confira: podman exec --user agente $C mktemp -d /tmp/smoke-entrega.XXXXXX" ;;
        esac
    fi
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
    dir_ch="$(PRAZO=30 ca mktemp -d /tmp/smoke-entrega.XXXXXX 2>/dev/null | head -n 1)"
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
                corpo="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORTA/api/saude" 2>/dev/null | head -c 65536)"
                if [ -n "$corpo" ]; then
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
  5.  Chave provisoria da equipe trocada pela do cliente (o smoke so confere os nomes).
  6.  Login do YouTube pela Tela (VNC) com a conta do cliente, antes do download de teste. O dono confirma
      pela Tela (o smoke deixa PENDENTE).
  9.  Login do dono pelo celular (largura 390), com usuario em maiuscula automatica; troca de senha em
      /trocar-senha (a partir da 1.1.1); senha entregue por canal seguro.
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
