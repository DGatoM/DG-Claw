#!/usr/bin/env bash
# lib/suporte.sh: acesso temporario do suporte DG por chave SSH (docs/PROJETO-DE-CLIENTE.md).
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Usa as funcoes dele e da lib/comum.sh
# (falha, ok, info, aviso, executar, escrever_arquivo, exigir_ferramentas, s_ok, s_aviso, agora_ms...).
# shellcheck disable=SC2154
#
#   dgclaw suporte ligar --chave '<linha ssh>' [--dias N]   grava a chave com prazo no authorized_keys do root
#   dgclaw suporte desligar                                  tira todas as chaves do suporte
#   dgclaw suporte status                                    lista as chaves, ate quando valem e as vencidas
#   dgclaw suporte limpar                                    tira so as vencidas (o timer diario chama este)
#   dgclaw status                                            uma linha "suporte: ..." (suporte_status_linha)
#
# Cada linha nossa leva `expiry-time="AAAAMMDDHHMMZ"` (o sshd recusa a chave sozinho depois do prazo,
# mesmo se ninguem limpar) e termina com o marcador `dgclaw-suporte:<id>:<AAAAMMDDHHMM>` (UTC). So linhas com
# o marcador sao tocadas: as outras chaves do root ficam exatamente como estao.

SUPORTE_DIAS_PADRAO=7
SUPORTE_DIAS_MAXIMO=30
SUPORTE_RSA_MINIMO=3072
SUPORTE_MARCADOR_RE='(^| )dgclaw-suporte:[0-9a-f]{8}:[0-9]{12}$'

suporte_arq()  { printf '%s' "$R/root/.ssh/authorized_keys"; }
suporte_log()  { printf '%s' "$DG_LOG/suporte.log"; }

# suporte_registrar <acao> <detalhes>: uma linha em suporte.log. Nunca a chave inteira, so o fingerprint.
suporte_registrar() {
    [ "$ENSAIO" != 1 ] || return 0
    local log; log="$(suporte_log)"
    install -d -m 750 "$DG_LOG"
    printf '%s %s por=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${SUDO_USER:-root}" "$2" >>"$log" \
        || falha "nao consegui gravar o registro em $log." "confira o espaco e a permissao de $DG_LOG e rode de novo."
    chmod 600 "$log"
}

# suporte_agora_s: epoch em segundos (respeita DGCLAW_AGORA_MS nos testes).
suporte_agora_s() { printf '%s' "$(( $(agora_ms) / 1000 ))"; }

# suporte_fmt_data <AAAAMMDDHHMM>: "07/11/2026 12:00 UTC".
suporte_fmt_data() {
    local f="$1"
    date -u -d "${f:0:4}-${f:4:2}-${f:6:2} ${f:8:2}:${f:10:2}" '+%d/%m/%Y %H:%M UTC' 2>/dev/null || printf '%s' "$f"
}

# suporte_fim_epoch <AAAAMMDDHHMM>: epoch (UTC) do fim. Vazio se a data for invalida.
suporte_fim_epoch() {
    local f="$1"
    date -u -d "${f:0:4}-${f:4:2}-${f:6:2} ${f:8:2}:${f:10:2}" +%s 2>/dev/null || true
}

# suporte_exigir_sshd_novo: o expiry-time so existe no OpenSSH 8.2 ou mais novo. Sem ele a chave nunca
# venceria sozinha, e acesso que deveria ser temporario viraria permanente em silencio.
suporte_exigir_sshd_novo() {
    local v maior menor
    command -v ssh >/dev/null 2>&1 || falha "nao achei o programa 'ssh' para conferir a versao do OpenSSH." \
        "instale o OpenSSH (sudo apt-get install -y openssh-server openssh-client) e rode de novo."
    v="$(ssh -V 2>&1 | head -n 1)" || true
    if [[ "$v" =~ OpenSSH_([0-9]+)\.([0-9]+) ]]; then
        maior="${BASH_REMATCH[1]}"; menor="${BASH_REMATCH[2]}"
    else
        falha "nao consegui ler a versao do OpenSSH (o 'ssh -V' respondeu: ${v:-nada})." \
            "confira o OpenSSH com 'ssh -V'. Sem a versao 8.2 ou mais nova a chave nao venceria sozinha, entao nao liguei o acesso."
    fi
    if [ "$maior" -lt 8 ] || { [ "$maior" -eq 8 ] && [ "$menor" -lt 2 ]; }; then
        falha "o OpenSSH deste servidor e o $maior.$menor, e o prazo automatico da chave (expiry-time) pede o 8.2 ou mais novo." \
            "atualize o servidor (sudo apt-get update && sudo apt-get install --only-upgrade openssh-server openssh-client; no Ubuntu 24.04 ja vem o certo) e rode de novo."
    fi
}

# suporte_validar_chave <linha>: confere a linha e preenche SUP_TIPO, SUP_BLOB, SUP_FP e SUP_ID.
# So chave publica, sem opcoes na frente (um `command=` ou `from=` de fora mudaria o que a chave pode).
suporte_validar_chave() {
    local linha="$1" tipo blob tmp saida bits
    if [[ "$linha" == *$'\n'* || "$linha" == *$'\r'* ]]; then
        falha "a chave tem mais de uma linha." "passe so a linha da chave publica, a que comeca com ssh-ed25519."
    fi
    if [[ ! "$linha" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)[[:space:]]+([A-Za-z0-9+/]+={0,3})([[:space:]].*)?$ ]]; then
        falha "a chave recebida nao e uma linha de chave publica aceita (comeca com: ${linha:0:20})." \
            "use uma chave publica que comece com ssh-ed25519 (a recomendada), ecdsa-sha2-nistp256 ou ssh-rsa de 3072 bits ou mais, sem opcoes na frente. Para criar: ssh-keygen -t ed25519"
    fi
    tipo="${BASH_REMATCH[1]}"; blob="${BASH_REMATCH[2]}"
    exigir_ferramentas ssh-keygen sha256sum
    tmp="$(mktemp)"
    printf '%s %s\n' "$tipo" "$blob" >"$tmp"
    if ! saida="$(ssh-keygen -l -f "$tmp" 2>&1)"; then
        rm -f "$tmp"
        falha "o ssh-keygen nao reconheceu a chave (${saida:0:120})." \
            "copie a linha inteira da chave publica (o arquivo .pub), sem cortar nada."
    fi
    rm -f "$tmp"
    bits="${saida%% *}"
    SUP_FP="$(printf '%s' "$saida" | awk '{print $2}')"
    if [ "$tipo" = ssh-rsa ] && [ "${bits:-0}" -lt "$SUPORTE_RSA_MINIMO" ]; then
        falha "a chave RSA tem ${bits} bits, e o minimo aceito e $SUPORTE_RSA_MINIMO." \
            "gere uma chave nova: ssh-keygen -t ed25519"
    fi
    SUP_TIPO="$tipo"; SUP_BLOB="$blob"
    SUP_ID="$(printf '%s' "$blob" | sha256sum | cut -c1-8)"
}

# suporte_blob_da_linha <linha do authorized_keys>: o corpo da chave, depois do tipo. Vazio se nao achar.
suporte_blob_da_linha() {
    local -a campos; local i
    read -ra campos <<<"$1"
    for i in "${!campos[@]}"; do
        case "${campos[$i]}" in
            ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa|ssh-dss|sk-*) printf '%s' "${campos[$((i + 1))]:-}"; return 0 ;;
        esac
    done
}

# suporte_fp_da_linha <linha>: fingerprint de uma linha do authorized_keys; "?" se nao der para calcular.
suporte_fp_da_linha() {
    local -a campos; local i tmp fp=""
    read -ra campos <<<"$1"
    for i in "${!campos[@]}"; do
        case "${campos[$i]}" in
            ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)
                tmp="$(mktemp)"
                printf '%s %s\n' "${campos[$i]}" "${campos[$((i + 1))]:-}" >"$tmp"
                fp="$(ssh-keygen -l -f "$tmp" 2>/dev/null | awk '{print $2}')" || fp=""
                rm -f "$tmp"
                break ;;
        esac
    done
    printf '%s' "${fp:-?}"
}

# suporte_fim_da_linha <linha nossa>: AAAAMMDDHHMM do marcador.
suporte_fim_da_linha() { local m="${1##* }"; printf '%s' "${m##*:}"; }

# suporte_travar: uma trava so para ligar, desligar e limpar nao se pisarem (timer x pessoa).
suporte_travar() {
    install -d -m 700 "$R/root/.ssh"
    exec 9>"$R/root/.ssh/.dgclaw-suporte.lock"
    flock -w 30 9 || falha "outro 'dgclaw suporte' segurou a trava por mais de 30 s." \
        "espere ele terminar (ou veja systemctl status dgclaw-suporte-limpar.service) e rode de novo."
}

# suporte_ler_linhas: imprime o authorized_keys (nada se nao existir).
suporte_ler_linhas() {
    local arq; arq="$(suporte_arq)"
    if [ -L "$arq" ]; then
        falha "$arq e um link, e eu nao gravo atraves de link." \
            "troque o link por um arquivo de verdade (cp --remove-destination \"\$(readlink -f $arq)\" $arq) e rode de novo."
    fi
    [ -f "$arq" ] || return 0
    cat "$arq" || falha "nao consegui ler $arq." "confira a permissao: ls -l $arq"
}

# suporte_gravar <conteudo completo>: troca o arquivo de forma atomica, modo 600, pasta 700.
suporte_gravar() {
    local arq; arq="$(suporte_arq)"
    if [ "$ENSAIO" != 1 ]; then install -d -m 700 "$(dirname "$arq")"; fi
    printf '%s' "$1" | escrever_arquivo "$arq" 600
}

suporte_ligar() {
    local chave="" dias="$SUPORTE_DIAS_PADRAO" linha novo="" conteudo="" atual agora fim fim_s ja=0 blob_l
    while [ $# -gt 0 ]; do
        case "$1" in
            --chave) [ $# -ge 2 ] || falha "falta o valor de --chave." "use: sudo dgclaw suporte ligar --chave 'ssh-ed25519 AAAA...' --dias 7"
                     chave="$2"; shift 2 ;;
            --dias)  [ $# -ge 2 ] || falha "falta o valor de --dias." "use: --dias 7 (de 1 a $SUPORTE_DIAS_MAXIMO)"
                     dias="$2"; shift 2 ;;
            *) falha "a opcao '$1' nao existe em 'suporte ligar'." "use: sudo dgclaw suporte ligar --chave 'ssh-ed25519 AAAA...' --dias 7" ;;
        esac
    done
    [ -n "$chave" ] || falha "falta a chave do suporte." "use: sudo dgclaw suporte ligar --chave 'ssh-ed25519 AAAA...' --dias 7"
    # Regex antes de qualquer aritmetica: numero gigante estouraria o [ -gt ] e o $(( )) em silencio.
    if [[ ! "$dias" =~ ^([1-9]|[12][0-9]|30)$ ]]; then
        falha "--dias deve ser um numero de 1 a $SUPORTE_DIAS_MAXIMO (veio: ${dias:0:20})." \
            "acesso do suporte e temporario de proposito. Escolha ate $SUPORTE_DIAS_MAXIMO dias e, se precisar de mais, ligue de novo quando vencer."
    fi
    suporte_validar_chave "$chave"
    suporte_exigir_sshd_novo
    suporte_travar

    agora="$(suporte_agora_s)"
    fim_s=$((agora + dias * 86400))
    fim="$(date -u -d "@$fim_s" +%Y%m%d%H%M)"
    novo="expiry-time=\"${fim}Z\" $SUP_TIPO $SUP_BLOB dgclaw-suporte:$SUP_ID:$fim"

    # Lido antes do laco: uma falha dentro de `< <(...)` nao para o script, e gravaria por cima de um arquivo nao lido.
    atual="$(suporte_ler_linhas)"
    if [ -n "$atual" ]; then
        while IFS= read -r linha || [ -n "$linha" ]; do
            blob_l="$(suporte_blob_da_linha "$linha")"
            if [ -n "$blob_l" ] && [ "$blob_l" = "$SUP_BLOB" ]; then
                if [[ "$linha" =~ $SUPORTE_MARCADOR_RE ]]; then
                    ja=1; continue
                fi
                falha "essa mesma chave ja esta em $(suporte_arq) como acesso permanente (sem prazo)." \
                    "nao mexi nela. Se ela era para ser temporaria, tire a linha na mao e ligue de novo; se e sua de verdade, use outra chave para o suporte."
            fi
            conteudo+="$linha"$'\n'
        done <<<"$atual"
    fi
    conteudo+="$novo"$'\n'
    suporte_gravar "$conteudo"
    suporte_registrar ligar "fp=$SUP_FP id=$SUP_ID dias=$dias ate=$fim$([ "$ja" = 1 ] && echo ' renovada=sim')"
    ok "acesso do suporte ligado ate $(suporte_fmt_data "$fim") ($dias dia(s)). Chave $SUP_FP, id $SUP_ID."
    info "Depois do prazo o servidor recusa a chave sozinho. Para tirar antes: sudo dgclaw suporte desligar"
}

# suporte_remover <todas|vencidas>: tira as linhas nossas (todas, ou so as vencidas) e registra cada uma.
# Imprime o numero removido na variavel SUP_REMOVIDAS.
suporte_remover() {
    local quais="$1" linha conteudo="" atual agora fim fim_s removidas=0 fp acao registros=() fps=""
    suporte_travar
    agora="$(suporte_agora_s)"
    atual="$(suporte_ler_linhas)"
    if [ -n "$atual" ]; then
        while IFS= read -r linha || [ -n "$linha" ]; do
            if [[ "$linha" =~ $SUPORTE_MARCADOR_RE ]]; then
                fim="$(suporte_fim_da_linha "$linha")"
                fim_s="$(suporte_fim_epoch "$fim")"
                # Marcador com data ilegivel conta como vencido: acesso temporario nao pode ficar para sempre.
                if [ "$quais" = todas ] || [ -z "$fim_s" ] || [ "$fim_s" -le "$agora" ]; then
                    fp="$(suporte_fp_da_linha "$linha")"
                    registros+=("fp=$fp venceria_em=$fim"); fps+="$fp "
                    removidas=$((removidas + 1))
                    continue
                fi
            fi
            conteudo+="$linha"$'\n'
        done <<<"$atual"
    fi
    if [ "$removidas" -gt 0 ]; then
        suporte_gravar "$conteudo"
        acao=limpar; [ "$quais" != todas ] || acao=desligar
        for fp in "${registros[@]}"; do suporte_registrar "$acao" "$fp"; done
    fi
    SUP_REMOVIDAS="$removidas"; SUP_FPS_REMOVIDOS="${fps% }"
}

# suporte_encerrar_sessoes <fingerprint...>: derruba as sessoes SSH abertas com as chaves que acabaram de sair.
# O sshd registra "Accepted publickey for root from IP port P ssh2: ED25519 SHA256:<fp>" no journal. Com o par
# IP:porta acha-se o processo sshd dono da conexao (ss -tnp) e encerra-se. Imprime quantas encerrou; se nao
# conseguiu identificar nenhuma, diz com clareza que pode haver sessao aberta e como derrubar.
suporte_encerrar_sessoes() {
    local fp log conexoes="" ip porta linha pid pids n=0 sem_log=0 ss_saida comm
    command -v journalctl >/dev/null 2>&1 || sem_log=1
    if [ "$sem_log" = 0 ]; then
        log="$(journalctl -u ssh.service -u sshd.service --no-pager -o cat --since '-45 days' 2>/dev/null)" || log=""
        [ -n "$log" ] || sem_log=1
    fi
    if [ "$sem_log" = 0 ] && command -v ss >/dev/null 2>&1; then
        for fp in "$@"; do
            [[ "$fp" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]] || continue
            conexoes+="$(grep -F "$fp" <<<"$log" | grep -F 'Accepted publickey for root' \
                | sed -nE 's/.*from ([0-9A-Fa-f:.]+) port ([0-9]+) .*/\1 \2/p')"$'\n'
        done
        ss_saida="$(ss -tnpH 2>/dev/null)" || ss_saida=""
        while read -r ip porta; do
            [ -n "$ip" ] || continue
            while IFS= read -r linha; do
                [[ "$linha" == *" $ip:$porta "* || "$linha" == *"[$ip]:$porta "* || "$linha" == *" $ip:$porta" || "$linha" == *"[$ip]:$porta" ]] || continue
                pids="$(grep -oE 'pid=[0-9]+' <<<"$linha" | cut -d= -f2)"
                for pid in $pids; do
                    comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"
                    [[ "$comm" == sshd* ]] || continue
                    kill -TERM "$pid" 2>/dev/null || continue
                    sleep 1
                    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
                    n=$((n + 1))
                done
            done <<<"$ss_saida"
        done < <(printf '%s' "$conexoes" | sort -u)
    fi
    if [ "$n" -gt 0 ]; then
        ok "$n sessao(oes) SSH aberta(s) com a chave do suporte foi(ram) encerrada(s)."
    else
        aviso "nao consegui identificar sessao SSH aberta com a chave do suporte ($([ "$sem_log" = 1 ] && echo 'sem acesso ao log do sshd' || echo 'nenhuma conexao dessa chave aparece ativa')). As novas entradas ja estao bloqueadas, mas pode haver uma sessao antiga aberta. Para ver: who -u ; para derrubar uma: sudo pkill -KILL -t <tty, ex. pts/0>. 'systemctl restart ssh' NAO derruba as sessoes ja abertas."
    fi
}

suporte_desligar() {
    [ $# -eq 0 ] || falha "'suporte desligar' nao tem opcoes (veio: $*)." "use: sudo dgclaw suporte desligar"
    suporte_remover todas
    if [ "$SUP_REMOVIDAS" -eq 0 ]; then
        ok "nao havia chave do suporte para tirar: o acesso ja estava desligado."
    else
        ok "acesso do suporte desligado: $SUP_REMOVIDAS chave(s) removida(s) de $(suporte_arq). As suas outras chaves ficaram como estavam."
        # shellcheck disable=SC2086 # fingerprints nao tem espaco
        suporte_encerrar_sessoes $SUP_FPS_REMOVIDOS
    fi
}

suporte_limpar() {
    [ $# -eq 0 ] || falha "'suporte limpar' nao tem opcoes (veio: $*)." "use: sudo dgclaw suporte limpar"
    suporte_remover vencidas
    ok "$SUP_REMOVIDAS chave(s) vencida(s) do suporte removida(s)."
}

suporte_status() {
    [ $# -eq 0 ] || falha "'suporte status' nao tem opcoes (veio: $*)." "use: sudo dgclaw suporte status"
    local linha atual agora fim fim_s ativas=0 vencidas=0 fp
    agora="$(suporte_agora_s)"
    atual="$(suporte_ler_linhas)"
    while IFS= read -r linha || [ -n "$linha" ]; do
        [[ "$linha" =~ $SUPORTE_MARCADOR_RE ]] || continue
        fim="$(suporte_fim_da_linha "$linha")"
        fim_s="$(suporte_fim_epoch "$fim")"
        fp="$(suporte_fp_da_linha "$linha")"
        if [ -n "$fim_s" ] && [ "$fim_s" -gt "$agora" ]; then
            printf '  ligada    %s  vale ate %s\n' "$fp" "$(suporte_fmt_data "$fim")"
            ativas=$((ativas + 1))
        else
            printf '  vencida   %s  venceu em %s\n' "$fp" "$(suporte_fmt_data "$fim")"
            vencidas=$((vencidas + 1))
        fi
    done <<<"$atual"
    if [ "$ativas" -eq 0 ] && [ "$vencidas" -eq 0 ]; then
        printf 'suporte: desligado\n'
    else
        printf 'suporte: %s chave(s) ligada(s), %s vencida(s)\n' "$ativas" "$vencidas"
    fi
    if [ "$vencidas" -gt 0 ]; then
        printf 'As vencidas ja nao entram (o servidor recusa), mas ainda estao no arquivo. Para remover: sudo dgclaw suporte limpar\n'
    fi
}

suporte_main() {
    local sub="${1:-}"
    [ $# -eq 0 ] || shift
    case "$sub" in
        ligar) suporte_ligar "$@" ;;
        desligar) suporte_desligar "$@" ;;
        status) suporte_status "$@" ;;
        limpar) suporte_limpar "$@" ;;
        *) falha "o subcomando 'suporte ${sub}' nao existe." "use: dgclaw suporte ligar|desligar|status|limpar (veja: dgclaw --ajuda)" ;;
    esac
}

# suporte_status_linha: a linha "suporte: ..." do `dgclaw status`. Nunca derruba o status.
suporte_status_linha() {
    local linha agora fim fim_s maior="" vencidas=0 conteudo
    agora="$(suporte_agora_s)"
    if ! conteudo="$(suporte_ler_linhas 2>&1)"; then
        s_aviso "suporte: nao consegui ler $(suporte_arq) ($(printf '%s' "$conteudo" | head -n 1 | tr -d '\000-\037'))"
        return 0
    fi
    while IFS= read -r linha || [ -n "$linha" ]; do
        [[ "$linha" =~ $SUPORTE_MARCADOR_RE ]] || continue
        fim="$(suporte_fim_da_linha "$linha")"
        fim_s="$(suporte_fim_epoch "$fim")"
        if [ -n "$fim_s" ] && [ "$fim_s" -gt "$agora" ]; then
            if [ -z "$maior" ] || [[ "$fim" > "$maior" ]]; then maior="$fim"; fi
        else
            vencidas=$((vencidas + 1))
        fi
    done <<<"$conteudo"
    if [ -n "$maior" ]; then
        s_aviso "suporte: ligado ate $(suporte_fmt_data "$maior") (para tirar agora: sudo dgclaw suporte desligar)"
    elif [ "$vencidas" -gt 0 ]; then
        s_aviso "suporte: desligado, mas $vencidas chave(s) vencida(s) ainda no arquivo (remova com: sudo dgclaw suporte limpar)"
    else
        s_ok "suporte: desligado"
    fi
}
