#!/usr/bin/env bash
# smoke-entrega.sh: confere uma VPS de cliente antes da entrega. Roda no servidor, como root.
#
#   sudo bash scripts/smoke-entrega.sh <agente> [--video <url>] [--sem-reparar]
#
# Automatiza os itens 1, 3, 5, 6, 7, 8 e 11 do checklist (docs/ENTREGA-CLIENTE.md). Cada item
# imprime OK, AVISO ou FALHA com a causa e o que fazer. O resto sai como lista "conferir a mao".
# Saida: 0 sem FALHA (pode haver AVISO), 1 com ao menos uma FALHA, 2 uso errado ou ferramenta ausente.
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
IFS=$'\t' read -r RUNNER CASA PROVEDOR <<<"$REG"
PORTA="${RUNNER##*:}"

FALHAS=0
AVISOS=0
# Tira o que nao e texto simples antes de mostrar na tela (a saida de dentro do container e do agente).
limpar() { LC_ALL=C tr -c 'A-Za-z0-9 ._/@+:,=%()<>-' '?' | cut -c1-200; }
ok()    { printf '  OK     [%s] %s\n' "$1" "$2"; }
aviso() { AVISOS=$((AVISOS + 1)); printf '  AVISO  [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
falha() { FALHAS=$((FALHAS + 1)); printf '  FALHA  [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
# cx: comando como root dentro do container. ca: o mesmo como o usuario agente.
cx() { timeout 60 podman exec "$C" "$@"; }
ca() { timeout "${PRAZO:-60}" podman exec -u agente "$C" "$@"; }
# contar_chrome: quantos processos chrome ha no container (0 se nenhum).
contar_chrome() { local n; n="$(cx pgrep -c chrome 2>/dev/null)"; case "$n" in ''|*[!0-9]*) n=0 ;; esac; printf '%s' "$n"; }

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
estado="$(podman inspect -f '{{.State.Status}}' "$C" 2>/dev/null)"
if [ "$estado" != running ]; then
    falha 3 "o container $C esta '${estado:-ausente}'." "ligue com: dgclaw agente iniciar $SLUG (se nao existir, o agente nao foi criado direito: dgclaw agente reparar $SLUG)"
    CONTAINER_OK=0
else
    CONTAINER_OK=1
    lim="$(podman inspect -f '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' "$C" 2>/dev/null)"
    read -r pids_lim mem_lim nano_cpus <<<"$lim"
    case "${pids_lim:-x}" in *[!0-9-]*) pids_lim="" ;; esac
    case "${mem_lim:-x}" in *[!0-9]*) mem_lim="" ;; esac
    case "${nano_cpus:-x}" in *[!0-9]*) nano_cpus="" ;; esac

    # pids.max: o cgroup de dentro do container e o que vale de verdade.
    pids_cg="$(cx cat /sys/fs/cgroup/pids.max 2>/dev/null | head -n 1)"
    if [ "$pids_cg" = max ]; then
        ok 3 "pids.max do container: sem limite"
    elif [ -n "$pids_cg" ] && [ "$pids_cg" -ge 4096 ] 2>/dev/null; then
        ok 3 "pids.max do container: $pids_cg (minimo 4096)"
    elif [ -n "$pids_cg" ] && [ "$pids_cg" -ge 0 ] 2>/dev/null; then
        falha 3 "pids.max do container e $pids_cg, abaixo de 4096. Com pouco processo o agente cai sozinho e o card nasce parado." \
            "recrie o container com o limite certo: dgclaw agente recriar $SLUG --forcar"
    else
        falha 3 "nao consegui ler /sys/fs/cgroup/pids.max dentro do container $C." "confira o container: podman exec $C cat /sys/fs/cgroup/pids.max"
    fi
    if [ -n "$pids_lim" ] && [ "$pids_lim" -gt 0 ] && [ "$pids_lim" -lt 4096 ]; then
        falha 3 "o podman guarda PidsLimit=$pids_lim para o container (abaixo de 4096)." "recrie o container: dgclaw agente recriar $SLUG --forcar"
    fi

    ram_kb="$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\) kB.*/\1/p' "$R/proc/meminfo" 2>/dev/null | head -n 1)"
    ram_gb=0
    [ -n "$ram_kb" ] && ram_gb=$((ram_kb / 1024 / 1024))
    if [ -z "$mem_lim" ]; then
        aviso 3 "nao consegui ler o limite de memoria do container." "confira: podman inspect -f '{{.HostConfig.Memory}}' $C"
    elif [ "$mem_lim" -eq 0 ]; then
        ok 3 "memoria do container: sem limite (o servidor tem ${ram_gb} GB)"
    elif [ "$mem_lim" -le 2147483648 ] && [ "$ram_gb" -gt 4 ]; then
        sug=$((ram_gb / 2)); [ "$sug" -ge 3 ] || sug=3
        aviso 3 "o container tem 2 GB de memoria e o servidor tem ${ram_gb} GB. Render, Chrome da Tela e card paralelo apertam em 2 GB." \
            "suba o limite: podman update --memory ${sug}g $C (vale ate o container ser recriado; depois de recriar, rode o smoke de novo)"
    else
        ok 3 "memoria do container: $((mem_lim / 1048576)) MB (servidor com ${ram_gb} GB)"
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
    if [ "$tasks" = infinity ] || { [ -n "$tasks" ] && [ "$tasks" -ge 2400 ] 2>/dev/null; }; then
        ok 3 "TasksMax da unidade do runner: $tasks (minimo 2400)"
    elif [ -n "$tasks" ] && [ "$tasks" -ge 0 ] 2>/dev/null; then
        falha 3 "TasksMax do dgclaw-runner e $tasks, abaixo de 2400. O Claude principal aborta e o card nasce parado." \
            "atualize o DG Claw (dgclaw atualizar) e recrie o agente: dgclaw agente recriar $SLUG --forcar"
    else
        falha 3 "nao consegui ler o TasksMax do dgclaw-runner dentro do container." "confira: podman exec $C systemctl show -p TasksMax dgclaw-runner"
    fi

    oom_pol="$(cx systemctl show -p OOMPolicy --value dgclaw-runner 2>/dev/null | head -n 1)"
    if [ "$oom_pol" = continue ]; then
        ok 3 "OOMPolicy=continue na unidade do runner"
    else
        aviso 3 "OOMPolicy da unidade do runner e '${oom_pol:-desconhecida}', e o esperado e 'continue' (a partir da 1.1.1). Sem isso, um processo morto por falta de memoria derruba o runner todo." \
            "atualize o DG Claw quando a 1.1.1 sair. Ate la, vigie o journal do runner (item abaixo)."
    fi

    nrest="$(cx systemctl show -p NRestarts --value dgclaw-runner 2>/dev/null | head -n 1)"
    if [ "$nrest" = 0 ]; then
        ok 3 "o runner nao reiniciou sozinho (NRestarts=0)"
    elif [ -n "$nrest" ] && [ "$nrest" -gt 0 ] 2>/dev/null; then
        falha 3 "o runner reiniciou sozinho $nrest vez(es) (NRestarts=$nrest). Algo derrubou o runner." \
            "leia o motivo: podman exec $C journalctl -u dgclaw-runner --no-pager | tail -n 80. Depois de resolver, reinicie o runner (item 11) e rode o smoke de novo."
    else
        aviso 3 "nao consegui ler o NRestarts do runner." "confira: podman exec $C systemctl show -p NRestarts dgclaw-runner"
    fi

    oom_c="$(cx journalctl -u dgclaw-runner --since '7 days ago' --no-pager -q 2>/dev/null | grep -ciE 'out of memory|oom-kill|oom_kill|killed process')"
    oom_h="$(journalctl -k --since '7 days ago' --no-pager -q 2>/dev/null | grep -ciE 'out of memory|oom-kill|killed process')"
    case "$oom_c" in ''|*[!0-9]*) oom_c=0 ;; esac
    case "$oom_h" in ''|*[!0-9]*) oom_h=0 ;; esac
    if [ "$oom_c" -eq 0 ] && [ "$oom_h" -eq 0 ]; then
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
        falha 8 "ffmpeg nao esta no container $C. Video, audio e carrossel dependem dele." "a imagem esta velha ou incompleta: dgclaw imagem construir, depois dgclaw agente recriar $SLUG --forcar"
    fi
else
    aviso 8 "ffmpeg do container nao conferido: o container nao esta de pe." "resolva o item 3 e rode de novo."
fi

# --- 5. Cofre --------------------------------------------------------------------------------------
printf '\n5. Cofre e chaves das skills (so os nomes, nunca os valores)\n'
cofre_json="$("$CLI" agente cofre "$SLUG" listar --json 2>/dev/null)"
if ! printf '%s' "$cofre_json" | jq -e '.chaves' >/dev/null 2>&1; then
    falha 5 "nao consegui listar o cofre do agente $SLUG." "rode a mao e leia a mensagem: dgclaw agente cofre $SLUG listar"
else
    NOMES="$(printf '%s' "$cofre_json" | jq -r '.chaves[] | select((.revogadaEm // "") == "") | .envName' | sort -u)"
    total="$(printf '%s\n' "$NOMES" | sed '/^$/d' | wc -l | tr -d ' ')"
    ok 5 "o cofre tem $total chave(s) ativa(s): $(printf '%s\n' "$NOMES" | sed '/^$/d' | paste -sd, - | sed 's/,/, /g' | limpar)"
    if printf '%s\n' "$NOMES" | grep -qx 'GROQ_API_KEY'; then
        ok 5 "GROQ_API_KEY esta no cofre (microfone e audio do agente)"
    else
        falha 5 "GROQ_API_KEY nao esta no cofre. Sem ela o microfone do chat e a transcricao de audio nao funcionam." \
            "guarde a chave do cliente: printf %s \"\$CHAVE\" | dgclaw agente cofre $SLUG guardar GROQ_API_KEY"
    fi
    skills_dir="$CASA/.claude/skills"
    if [ -z "$CASA" ] || [ ! -d "$skills_dir" ]; then
        aviso 5 "nao achei a pasta de skills do agente (${skills_dir:-sem home_host no registro}); nao deu para cruzar as skills com o cofre." \
            "confira a mao (item 10 do checklist): ls <casa do agente>/.claude/skills"
    else
        faltou_algum=0
        for sd in "$skills_dir"/*/; do
            [ -d "$sd" ] || continue
            sk="$(basename "$sd")"
            while IFS= read -r nome; do
                [ -n "$nome" ] || continue
                if ! printf '%s\n' "$NOMES" | grep -qx "$nome"; then
                    faltou_algum=1
                    aviso 5 "a skill '$(printf '%s' "$sk" | limpar)' cita $nome e essa chave nao esta no cofre." \
                        "se o cliente usa essa skill: printf %s \"\$CHAVE\" | dgclaw agente cofre $SLUG guardar $nome. Se a skill nao sera usada, ignore."
                fi
            done < <(grep -rhoE --include='*.md' --include='*.sh' --include='*.py' --include='*.js' --include='*.mjs' '\b[A-Z][A-Z0-9]*_(API_KEY|TOKEN)\b' "$sd" 2>/dev/null | sort -u)
        done
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
        falha 6 "o yt-dlp nao esta no PATH do agente." "a imagem esta velha: dgclaw imagem construir, depois dgclaw agente recriar $SLUG --forcar"
    elif [ "$ytpath" = /usr/local/bin/yt-dlp ]; then
        ok 6 "yt-dlp em /usr/local/bin/yt-dlp"
    else
        aviso 6 "o yt-dlp esta em $(printf '%s' "$ytpath" | limpar) e nao em /usr/local/bin (a partir da 1.1.1). Fora do /usr/local/bin, um processo sem o PATH do venv nao o acha." \
            "confira que o agente o acha pelo painel (peça um download curto no card de teste). Quando a 1.1.1 sair, atualize."
    fi
    if ca grep -qE 'cookies-from-browser|^--cookies' /home/agente/.config/yt-dlp/config >/dev/null 2>&1; then
        ok 6 "yt-dlp configurado para ler os cookies da Tela (.config/yt-dlp/config)"
    else
        aviso 6 "o arquivo .config/yt-dlp/config do agente nao existe ou nao le os cookies da Tela (a partir da 1.1.1). Sem isso o YouTube pede 'confirme que voce nao e um robo'." \
            "entre no YouTube pela Tela (dgclaw agente tela $SLUG) e crie o arquivo com a linha --cookies-from-browser apontando para o perfil /home/agente/.tela-chrome."
    fi
    if [ -z "$VIDEO" ]; then
        aviso 6 "o download de teste nao rodou: faltou --video <url>." \
            "depois de entrar no YouTube pela Tela com a conta do cliente, rode de novo com: --video <url de um video curto>"
    else
        PRAZO=150 ca rm -f /tmp/smoke-entrega-yt.mp4 >/dev/null 2>&1
        saida_yt="$(PRAZO=150 ca yt-dlp --no-playlist --no-progress -f 'worst[ext=mp4]/worst' --max-filesize 30M -o '/tmp/smoke-entrega-yt.%(ext)s' -- "$VIDEO" 2>&1)"
        rc=$?
        if [ "$rc" -eq 0 ] && PRAZO=30 ca sh -c 'ls /tmp/smoke-entrega-yt.* >/dev/null 2>&1'; then
            ok 6 "o yt-dlp baixou o video de teste"
        else
            falha 6 "o yt-dlp falhou (codigo $rc): $(printf '%s' "$saida_yt" | tail -n 1 | limpar)" \
                "se pede login ou 'nao e um robo', refaca o login do YouTube pela Tela com a conta do cliente (item 6 do checklist). Se for outro erro: podman exec -u agente $C yt-dlp -v <url>"
        fi
        PRAZO=30 ca sh -c 'rm -f /tmp/smoke-entrega-yt.*' >/dev/null 2>&1
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
    antes="$(contar_chrome)"
    PRAZO=90 ca google-chrome-stable --headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/smoke-entrega-chrome --dump-dom about:blank >/dev/null 2>&1
    rc=$?
    sleep 3
    depois="$(contar_chrome)"
    PRAZO=30 ca rm -rf /tmp/smoke-entrega-chrome >/dev/null 2>&1
    if [ "$rc" -ne 0 ]; then
        falha 7 "o Chrome headless nao rodou (codigo $rc). Render de carrossel e video nao vai funcionar." \
            "rode a mao e leia o erro: podman exec -u agente $C google-chrome-stable --headless=new --no-sandbox --dump-dom about:blank"
    elif [ "$depois" -gt "$antes" ]; then
        falha 7 "sobraram $((depois - antes)) processo(s) do Chrome depois do render (antes: $antes, depois: $depois; o Chrome da Tela continua vivo e esta na conta)." \
            "o render nao esta sendo encerrado. Use o dgclaw-pesado --timeout (a partir da 1.1.1) e mate o resto: podman exec $C pkill -f smoke-entrega-chrome"
    else
        ok 7 "render headless terminou e nao sobrou Chrome (antes: $antes, depois: $depois; a conta inclui o Chrome da Tela)"
    fi
fi

# --- 11. Reparar e reiniciar o runner --------------------------------------------------------------
printf '\n11. Sessao principal de pe depois de reparar e reiniciar o runner\n'
if [ "$REPARAR" = 0 ]; then
    aviso 11 "pulado por --sem-reparar." "rode sem essa opcao antes de entregar."
elif [ "$CONTAINER_OK" != 1 ]; then
    falha 11 "o container $C nao esta de pe, entao nao ha o que reparar." "resolva o item 3 e rode de novo."
else
    saida_rep="$("$CLI" agente reparar "$SLUG" 2>&1)"
    rc=$?
    if [ "$rc" -ne 0 ]; then
        falha 11 "dgclaw agente reparar $SLUG saiu com codigo $rc: $(printf '%s' "$saida_rep" | tail -n 1 | limpar)" "rode a mao e leia a mensagem inteira: dgclaw agente reparar $SLUG"
    else
        ok 11 "dgclaw agente reparar $SLUG terminou sem erro"
        if ! cx systemctl restart dgclaw-runner >/dev/null 2>&1; then
            falha 11 "nao consegui reiniciar o dgclaw-runner dentro do container." "veja: podman exec $C journalctl -u dgclaw-runner --no-pager | tail -n 50"
        else
            t=0; saudavel=0
            while [ "$t" -lt "$ESPERA" ]; do
                if curl -fsS --max-time 3 "http://127.0.0.1:$PORTA/api/saude" >/dev/null 2>&1; then saudavel=1; break; fi
                sleep 1; t=$((t + 1))
            done
            if [ "$saudavel" != 1 ]; then
                falha 11 "o runner nao respondeu em 127.0.0.1:$PORTA/api/saude em ${ESPERA}s depois de reiniciar." \
                    "veja: podman exec $C journalctl -u dgclaw-runner --no-pager | tail -n 50 e tente: dgclaw agente reiniciar $SLUG"
            else
                ok 11 "o runner voltou e responde em 127.0.0.1:$PORTA/api/saude"
                t=0; de_pe=0
                while [ "$t" -lt "$ESPERA" ]; do
                    if cx pgrep -f '(^|/)(claude|codex)( |$)' >/dev/null 2>&1; then de_pe=1; break; fi
                    sleep 1; t=$((t + 1))
                done
                if [ "$de_pe" = 1 ]; then ok 11 "a sessao principal ($PROVEDOR) esta de pe"
                else
                    aviso 11 "nao vi o processo da sessao principal em ${ESPERA}s depois de reiniciar o runner." \
                        "abra o painel do agente e confira o estado da sessao principal. Se estiver parada: dgclaw agente reiniciar $SLUG"
                fi
            fi
        fi
    fi
fi

# --- O que nao da para automatizar -----------------------------------------------------------------
cat <<FIM

Conferir a mao (detalhes em docs/ENTREGA-CLIENTE.md):
  2.  A chave SSH da equipe foi posta na criacao ou recriacao da VPS na Hostinger (anexar depois nao vale).
  4.  Card de teste: sessao paralela, pedido curto, primeiro turno respondido, conversa aparece ao clicar.
      Repita nos dois motores (Claude e Codex).
  5.  Chave provisoria da equipe trocada pela do cliente (o smoke so confere os nomes).
  6.  Login do YouTube pela Tela (VNC) com a conta do cliente, antes do download de teste.
  9.  Login do dono pelo celular (largura 390), com usuario em maiuscula automatica; troca de senha em
      /trocar-senha (a partir da 1.1.1); senha entregue por canal seguro.
  10. Skills do cliente na pasta certa, com dono (chown) e CLAUDE_PLUGIN_ROOT resolvido.
  12. Skills com texto do cliente (assinatura, nome do programa, encerramento): sem nome de outro cliente
      nem do modelo.

FIM
printf 'Resumo: %s falha(s), %s aviso(s).\n' "$FALHAS" "$AVISOS"
if [ "$FALHAS" -gt 0 ]; then
    printf 'NAO entregue a VPS: corrija as linhas FALHA acima e rode o smoke de novo.\n'
    exit 1
fi
printf 'Sem falhas. Resolva ou justifique os avisos e faca a lista "conferir a mao".\n'
exit 0
