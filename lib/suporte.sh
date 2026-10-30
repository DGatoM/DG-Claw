#!/usr/bin/env bash
# lib/suporte.sh: acesso temporario do suporte DG por chave SSH (docs/PROJETO-DE-CLIENTE.md).
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Usa as funcoes dele e da lib/comum.sh
# (falha, ok, info, aviso, executar, escrever_arquivo, exigir_ferramentas, s_ok, s_aviso, agora_ms...).
# shellcheck disable=SC2154
#
#   dgclaw suporte ligar --chave '<linha ssh>' [--dias N]   grava a chave com prazo no authorized_keys do root
#   dgclaw suporte desligar [--derrubar-sessoes]             tira as chaves; lista as sessoes de root abertas; com a opcao, encerra as outras
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
    # O id vem do fingerprint (identidade criptografica da chave), nao do texto base64: duas representacoes da mesma chave dao o mesmo id.
    SUP_ID="$(printf '%s' "$SUP_FP" | sha256sum | cut -c1-8)"
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
    # No ensaio nada e escrito, nem a pasta .ssh nem o arquivo da trava.
    if [ "$ENSAIO" = 1 ]; then return 0; fi
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

# suporte_fontes_de_chaves: imprime, um por linha, os arquivos de chaves que o sshd aceita para o root (o que o
# `sshd -T` diz, nao o que se supoe). Recusa se nao der para saber: acesso temporario sobre um permanente
# escondido num authorized_keys2 viraria "desligado" mentiroso. DGCLAW_SSHD troca o programa (testes).
suporte_fontes_de_chaves() {
    local sshd_cmd="${DGCLAW_SSHD:-sshd}" saida rc=0 linha chave valor home pad tok f
    local -a pads=()
    if ! command -v "$sshd_cmd" >/dev/null 2>&1; then
        if [ -z "${DGCLAW_SSHD:-}" ] && [ -x /usr/sbin/sshd ]; then sshd_cmd=/usr/sbin/sshd
        else
            falha "nao achei o programa 'sshd', entao nao consigo conferir de onde o servidor aceita chaves do root." \
                "instale o servidor SSH (sudo apt-get install -y openssh-server) e rode de novo. Sem essa conferencia nao liguei o acesso."
        fi
    fi
    saida="$("$sshd_cmd" -T -C user=root,host=localhost,addr=127.0.0.1 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then
        falha "o 'sshd -T' falhou com codigo $rc (${saida:0:160}), entao nao consigo conferir de onde o servidor aceita chaves do root." \
            "rode como root e confira a configuracao com: sudo sshd -T. Sem essa conferencia nao liguei o acesso."
    fi
    while IFS=' ' read -r chave valor; do
        case "${chave,,}" in
            authorizedkeyscommand)
                if [ -n "$valor" ] && [ "${valor,,}" != none ]; then
                    falha "o sshd deste servidor usa AuthorizedKeysCommand ($valor), que busca chaves fora de arquivos, e eu nao consigo conferir se a chave do suporte ja tem acesso por ali." \
                        "tire o AuthorizedKeysCommand do sshd_config (ou use outra forma de acesso para o suporte) e rode de novo."
                fi ;;
            authorizedkeysfile) read -ra pads <<<"$valor" ;;
        esac
    done <<<"$saida"
    if [ "${#pads[@]}" -eq 0 ]; then
        falha "o 'sshd -T' nao informou a linha authorizedkeysfile, entao nao sei de onde o servidor aceita chaves do root." \
            "confira com: sudo sshd -T | grep -i authorizedkeys. Sem essa conferencia nao liguei o acesso."
    fi
    home=/root
    if [ -z "$R" ]; then home="$(getent passwd root 2>/dev/null | cut -d: -f6)" || home=""; home="${home:-/root}"; fi
    for pad in "${pads[@]}"; do
        [ "${pad,,}" != none ] || continue
        f="$pad"
        f="${f//%%/$'\001'}"
        f="${f//%h/$home}"; f="${f//%u/root}"; f="${f//%U/0}"
        tok="$f"
        if [[ "$tok" == *%* ]]; then
            falha "o sshd usa um AuthorizedKeysFile com variavel que nao sei expandir ($pad)." \
                "use caminhos simples no AuthorizedKeysFile (%h, %u e %% sao os que eu entendo) e rode de novo."
        fi
        f="${f//$'\001'/%}"
        case "$f" in /*) ;; *) f="$home/$f" ;; esac
        printf '%s\n' "$R$f"
    done
}

# suporte_exigir_chave_sem_acesso_permanente: a chave nao pode estar, fora da nossa linha marcada, em nenhum arquivo
# de chaves que o sshd aceita para o root. A linha marcada do authorized_keys principal e tratada no suporte_ligar.
suporte_exigir_chave_sem_acesso_permanente() {
    local fontes arq propria linha blob_l fp_l
    fontes="$(suporte_fontes_de_chaves)" || exit 1
    propria="$(suporte_arq)"
    while IFS= read -r arq; do
        [ -n "$arq" ] || continue
        [ "$arq" != "$propria" ] || continue
        [ -e "$arq" ] || [ -L "$arq" ] || continue
        if [ ! -f "$arq" ] || [ ! -r "$arq" ]; then
            falha "o sshd aceita chaves do root em $arq, mas nao consegui ler esse arquivo, entao nao sei se a chave do suporte ja esta la." \
                "confira com: ls -l $arq (precisa ser um arquivo comum, legivel pelo root). Sem essa conferencia nao liguei o acesso."
        fi
        while IFS= read -r linha || [ -n "$linha" ]; do
            blob_l="$(suporte_blob_da_linha "$linha")"
            [ -n "$blob_l" ] || continue
            fp_l="$(suporte_fp_da_linha "$linha")"
            if [ "$fp_l" = "$SUP_FP" ]; then
                falha "essa mesma chave ja esta em $arq, que o sshd tambem aceita, como acesso permanente (sem prazo)." \
                    "nao mexi nela. Tire a linha dela desse arquivo na mao e ligue de novo; se ela e sua de verdade, use outra chave para o suporte."
            fi
        done <"$arq" || falha "nao consegui ler $arq." "confira a permissao: ls -l $arq. Sem essa conferencia nao liguei o acesso."
    done <<<"$fontes"
}

suporte_ligar() {
    local chave="" dias="$SUPORTE_DIAS_PADRAO" linha novo="" conteudo="" atual agora fim fim_s ja=0 blob_l fp_l
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
    suporte_exigir_chave_sem_acesso_permanente
    suporte_travar

    agora="$(suporte_agora_s)"
    fim_s=$((agora + dias * 86400))
    fim="$(date -u -d "@$fim_s" +%Y%m%d%H%M)"
    novo="expiry-time=\"${fim}Z\" $SUP_TIPO $SUP_BLOB dgclaw-suporte:$SUP_ID:$fim"

    # Lido antes do laco: uma falha dentro de `< <(...)` nao para o script, e gravaria por cima de um arquivo nao lido.
    atual="$(suporte_ler_linhas)"
    if [ -n "$atual" ]; then
        while IFS= read -r linha || [ -n "$linha" ]; do
            # Compara pelo fingerprint que o ssh-keygen calcula, nao pelo texto: a mesma chave pode ter mais de uma
            # representacao (byte zero a mais no modulo RSA, por exemplo).
            blob_l="$(suporte_blob_da_linha "$linha")"
            fp_l="";  if [ -n "$blob_l" ]; then fp_l="$(suporte_fp_da_linha "$linha")"; fi
            if [ -n "$fp_l" ] && [ "$fp_l" != "?" ] && [ "$fp_l" = "$SUP_FP" ]; then
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

# --- sessoes SSH de root abertas agora ------------------------------------------------------------
# Nao se adivinha pelo historico do journal quem usou qual chave: isso podia derrubar a sessao do proprio dono.
# O que se faz e listar as sessoes de root que existem AGORA, dizer qual e a de quem roda o comando, e so
# encerrar (com --derrubar-sessoes) as outras.

sup_dir_estado() { printf '%s' "$DG_LIB/suporte"; }

# suporte_cadeia_de_pais: os pids do processo atual para cima (um por linha).
suporte_cadeia_de_pais() {
    local p=$$ pp
    while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
        printf '%s\n' "$p"
        pp="$(sed 's/^.*) //' "/proc/$p/stat" 2>/dev/null | awk '{print $2}')" || pp=""
        if [ -z "$pp" ] || [ "$pp" = "$p" ]; then break; fi
        p="$pp"
    done
}

# suporte_listar_sessoes: preenche SUP_SES_PEER, SUP_SES_PIDS (pids separados por espaco), SUP_SES_INICIO e
# SUP_SES_PROPRIA (1 = a sessao de quem roda este comando). Uma entrada por conexao SSH de root.
suporte_listar_sessoes() {
    SUP_SES_PEER=(); SUP_SES_PIDS=(); SUP_SES_INICIO=(); SUP_SES_PROPRIA=(); SUP_SES_ERRO=""
    local saida linha peer pid cmd cadeia ssh_ip="" ssh_porta="" i idx pids inicio propria ss_cmd="${DGCLAW_SS:-ss}" rc=0
    # Falha na consulta NUNCA vira "nenhuma sessao": quem chama precisa dizer que nao conseguiu verificar.
    if ! command -v "$ss_cmd" >/dev/null 2>&1; then SUP_SES_ERRO="o programa ss nao esta instalado (pacote iproute2)"; return 1; fi
    if [ ! -r /proc/self/stat ]; then SUP_SES_ERRO="nao consegui ler o /proc"; return 1; fi
    saida="$("$ss_cmd" -tnpH 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then SUP_SES_ERRO="o ss saiu com codigo $rc"; return 1; fi
    while IFS= read -r linha; do
        [ -n "$linha" ] || continue
        peer="$(awk '{print $5}' <<<"$linha")"
        if [[ "$peer" != *:* ]]; then SUP_SES_ERRO="a saida do ss veio num formato que nao entendi"; return 1; fi
    done <<<"$saida"
    cadeia=" $(suporte_cadeia_de_pais | tr '\n' ' ') "
    if [ -n "${SSH_CONNECTION:-}" ]; then read -r ssh_ip ssh_porta _ <<<"$SSH_CONNECTION"; fi
    declare -A pids_de=()
    local ordem=()
    while IFS= read -r linha; do
        [ -n "$linha" ] || continue
        peer="$(awk '{print $5}' <<<"$linha")"
        while IFS= read -r pid; do
            if [ ! -d "/proc/$pid" ]; then continue; fi   # o processo acabou de sair: nao e sessao aberta
            if ! cmd="$(cat "/proc/$pid/comm" 2>/dev/null)"; then SUP_SES_ERRO="nao consegui ler /proc/$pid/comm"; return 1; fi
            # OpenSSH ate 9.7 usa "sshd"; a partir do 9.8 a sessao autenticada e o processo "sshd-session".
            [[ "$cmd" == sshd || "$cmd" == sshd-session ]] || continue
            if ! cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)"; then SUP_SES_ERRO="nao consegui ler /proc/$pid/cmdline"; return 1; fi
            # Titulo do processo, em tres grupos: root exato (e uma sessao de root), outro usuario ou pre-autenticacao
            # (nao e), qualquer outra coisa (formato desconhecido: nao da para afirmar nada, a verificacao e inconclusiva).
            # "sshd: rootbackup@pts/1" e "sshd-session: root2 [priv]" sao de outro usuario.
            if [[ "$cmd" =~ ^(sshd|sshd-session):\ root(@[^[:space:]]+|\ \[priv\])?[[:space:]]*$ ]]; then
                :
            elif [[ "$cmd" =~ ^(sshd|sshd-session):\ (\[[a-z]+\]|[^[:space:]]+(\ \[(priv|net|accepted)\]|@[^[:space:]]+))[[:space:]]*$ ]]; then
                continue
            else
                SUP_SES_ERRO="achei um processo sshd (pid $pid) com titulo em formato que nao reconheco; nao da para saber se e sessao de root"
                return 1
            fi
            if [ -z "${pids_de[$peer]:-}" ]; then ordem+=("$peer"); fi
            pids_de[$peer]+="$pid "
        done < <(grep -oE 'pid=[0-9]+' <<<"$linha" | cut -d= -f2)
    done <<<"$saida"
    for peer in ${ordem[@]+"${ordem[@]}"}; do
        pids="${pids_de[$peer]% }"
        inicio="?"
        pid="${pids%% *}"
        inicio="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" || inicio="?"
        [ -n "$inicio" ] || inicio="?"
        propria=0
        for i in $pids; do [[ "$cadeia" == *" $i "* ]] && propria=1; done
        if [ -n "$ssh_ip" ] && { [ "$peer" = "$ssh_ip:$ssh_porta" ] || [ "$peer" = "[$ssh_ip]:$ssh_porta" ]; }; then propria=1; fi
        idx=${#SUP_SES_PEER[@]}
        SUP_SES_PEER[idx]="$peer"; SUP_SES_PIDS[idx]="$pids"; SUP_SES_INICIO[idx]="$inicio"; SUP_SES_PROPRIA[idx]="$propria"
    done
}

# suporte_contar_outras: quantas das sessoes listadas sao de outra pessoa (SUP_N_OUTRAS) e quantas ao todo (SUP_N_TOTAL).
# Pendencia compartilhada so se apaga pelo total: a sessao de quem consulta pode ser a do proprio suporte.
suporte_contar_outras() {
    local i
    SUP_N_OUTRAS=0; SUP_N_TOTAL=${#SUP_SES_PEER[@]}
    for i in "${!SUP_SES_PEER[@]}"; do
        if [ "${SUP_SES_PROPRIA[$i]}" = 0 ]; then SUP_N_OUTRAS=$((SUP_N_OUTRAS + 1)); fi
    done
}

# suporte_mostrar_sessoes: imprime a lista e define SUP_OUTRAS (quantas sao de outra pessoa).
suporte_mostrar_sessoes() {
    local i
    SUP_OUTRAS=0; SUP_VERIF_FALHOU=0
    suporte_listar_sessoes || true
    if [ -n "$SUP_SES_ERRO" ]; then
        SUP_VERIF_FALHOU=1
        printf '  nao consegui verificar as sessoes de root abertas (%s)\n' "$SUP_SES_ERRO"
        return 0
    fi
    if [ "${#SUP_SES_PEER[@]}" -eq 0 ]; then
        printf '  sessoes SSH de root abertas agora: nenhuma\n'
        return 0
    fi
    printf '  sessoes SSH de root abertas agora:\n'
    for i in "${!SUP_SES_PEER[@]}"; do
        if [ "${SUP_SES_PROPRIA[$i]}" = 1 ]; then
            printf '    - %s, desde %s  <- e a SUA sessao (a de quem roda este comando)\n' "$(printf '%s' "${SUP_SES_PEER[$i]}" | tr -cd 'A-Za-z0-9.:[]')" "${SUP_SES_INICIO[$i]}"
        else
            SUP_OUTRAS=$((SUP_OUTRAS + 1))
            printf '    - %s, desde %s\n' "$(printf '%s' "${SUP_SES_PEER[$i]}" | tr -cd 'A-Za-z0-9.:[]')" "${SUP_SES_INICIO[$i]}"
        fi
    done
}

# suporte_derrubar_outras: TERM e depois KILL nos sshd das sessoes de root que nao sao a de quem roda o comando.
# Recusa se esta sendo rodado por SSH e nao consegue dizer qual e a propria sessao (derrubaria a de quem pede).
suporte_derrubar_outras() {
    local i pid n=0
    suporte_listar_sessoes || falha "nao consegui listar as sessoes de root abertas ($SUP_SES_ERRO), entao nao derrubo nada." \
        "rode pelo console do servidor: who -u ; e derrube a sessao certa com sudo pkill -KILL -t <tty, ex. pts/1>."
    if { [ -n "${SSH_CONNECTION:-}" ] || [ -n "${SSH_CLIENT:-}" ]; } && ! [[ " ${SUP_SES_PROPRIA[*]-} " == *" 1 "* ]]; then
        falha "estou numa sessao SSH, mas nao consegui dizer qual das sessoes de root abertas e a sua; nao derrubo nada para nao te derrubar." \
              "rode pelo console do servidor (painel da Hostinger) ou confira com: who -u ; e derrube a sessao certa com sudo pkill -KILL -t <tty, ex. pts/1>."
    fi
    for i in "${!SUP_SES_PEER[@]}"; do
        [ "${SUP_SES_PROPRIA[$i]}" = 0 ] || continue
        if [ "$ENSAIO" = 1 ]; then
            printf '   [ensaio] encerraria a sessao de %s (sshd pid %s) com TERM e depois KILL\n' "$(printf '%s' "${SUP_SES_PEER[$i]}" | tr -cd 'A-Za-z0-9.:[]')" "${SUP_SES_PIDS[$i]}"
            n=$((n + 1)); continue
        fi
        for pid in ${SUP_SES_PIDS[$i]}; do
            [[ "$(cat "/proc/$pid/comm" 2>/dev/null)" == sshd || "$(cat "/proc/$pid/comm" 2>/dev/null)" == sshd-session ]] || continue
            kill -TERM "$pid" 2>/dev/null || true
        done
        sleep 1
        for pid in ${SUP_SES_PIDS[$i]}; do
            if [[ "$(cat "/proc/$pid/comm" 2>/dev/null)" == sshd || "$(cat "/proc/$pid/comm" 2>/dev/null)" == sshd-session ]] && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
        done
        n=$((n + 1))
    done
    SUP_ENCERRADAS="$n"
}

# suporte_alerta_arquivo: marca que uma chave venceu com sessao de root aberta (o dgclaw status le).
suporte_alerta_arquivo() { printf '%s' "$(sup_dir_estado)/alerta-sessoes"; }
suporte_revogadas_log() { printf '%s' "$(sup_dir_estado)/revogadas.log"; }

suporte_desligar() {
    local derrubar=0 a
    for a in "$@"; do
        case "$a" in
            --derrubar-sessoes) derrubar=1 ;;
            *) falha "a opcao '$a' nao existe em 'suporte desligar'." "use: sudo dgclaw suporte desligar [--derrubar-sessoes]" ;;
        esac
    done
    suporte_remover todas
    if [ "$SUP_REMOVIDAS" -gt 0 ]; then
        ok "$SUP_REMOVIDAS chave(s) removida(s) de $(suporte_arq). As suas outras chaves ficaram como estavam. Novas entradas com elas estao bloqueadas."
    else
        info "nao havia chave do suporte no arquivo."
    fi
    suporte_mostrar_sessoes
    if [ "$SUP_VERIF_FALHOU" = 1 ]; then
        if [ "$ENSAIO" != 1 ]; then
            install -d -m 700 "$(sup_dir_estado)"; : >"$(suporte_alerta_arquivo)"; chmod 600 "$(suporte_alerta_arquivo)"
        fi
        aviso "nao consegui verificar as sessoes de root abertas ($SUP_SES_ERRO). As novas entradas com a chave do suporte estao bloqueadas, mas NAO posso dizer que o acesso esta desligado: pode haver sessao aberta. Confira com: who -u ; derrube com sudo pkill -KILL -t <tty, ex. pts/1>. Depois rode de novo: sudo dgclaw suporte status"
        return 1
    fi
    if [ "$derrubar" = 1 ]; then
        if [ "$SUP_OUTRAS" -eq 0 ]; then
            info "nao ha outra sessao de root para encerrar."
        else
            suporte_derrubar_outras
            if [ "$ENSAIO" = 1 ]; then
                info "[ensaio] nada foi encerrado."
            else
                ok "$SUP_ENCERRADAS sessao(oes) SSH de root encerrada(s). A sua nao foi tocada."
                suporte_mostrar_sessoes
                if [ "$SUP_VERIF_FALHOU" = 1 ]; then
                    if [ "$ENSAIO" != 1 ]; then : >"$(suporte_alerta_arquivo)"; fi
                    aviso "encerrei o que achei, mas nao consegui conferir de novo ($SUP_SES_ERRO): nao posso dizer que o acesso esta desligado."
                    return 1
                fi
            fi
        fi
    fi
    if [ "$SUP_OUTRAS" -gt 0 ]; then
        # Pendencia: o dgclaw status so volta a dizer "desligado" depois que nao houver mais sessao de root aberta.
        if [ "$ENSAIO" != 1 ]; then
            install -d -m 700 "$(sup_dir_estado)"
            : >"$(suporte_alerta_arquivo)"; chmod 600 "$(suporte_alerta_arquivo)"
        fi
        aviso "as novas entradas com a chave do suporte estao bloqueadas, mas ainda ha $SUP_OUTRAS sessao(oes) de root aberta(s) (lista acima): o acesso NAO esta totalmente desligado. Para encerrar TODAS as sessoes SSH de root, menos a sua: sudo dgclaw suporte desligar --derrubar-sessoes"
        return 0
    fi
    if [ "$ENSAIO" != 1 ]; then rm -f "$(suporte_alerta_arquivo)"; fi
    if [ "$SUP_REMOVIDAS" -gt 0 ]; then ok "acesso do suporte desligado: nenhuma chave dele no arquivo e nenhuma outra sessao de root aberta."
    else ok "o acesso do suporte ja estava desligado."; fi
}

# suporte_registrar_revogadas <fingerprints...>: guarda, em /var/lib/dgclaw/suporte/revogadas.log (600, pasta 700),
# as chaves que o limpar tirou, e marca o alerta se houver sessao de root aberta.
suporte_registrar_revogadas() {
    local d log fp
    [ "$ENSAIO" != 1 ] || return 0
    d="$(sup_dir_estado)"; log="$(suporte_revogadas_log)"
    install -d -m 700 "$d"
    for fp in "$@"; do
        printf '%s revogada fp=%s motivo=vencida\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$fp" >>"$log" \
            || falha "nao consegui gravar $log." "confira o espaco e a permissao de $d."
    done
    chmod 600 "$log"
    if ! suporte_listar_sessoes; then
        printf '%s alerta: chave vencida removida, mas nao consegui verificar as sessoes de root (%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SUP_SES_ERRO" >>"$log"
        : >"$(suporte_alerta_arquivo)"; chmod 600 "$(suporte_alerta_arquivo)"
    elif [ "${#SUP_SES_PEER[@]}" -gt 0 ]; then
        printf '%s alerta: chave vencida removida, mas ha %s sessao(oes) de root aberta(s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${#SUP_SES_PEER[@]}" >>"$log"
        : >"$(suporte_alerta_arquivo)"; chmod 600 "$(suporte_alerta_arquivo)"
    else
        rm -f "$(suporte_alerta_arquivo)"
    fi
}

suporte_limpar() {
    [ $# -eq 0 ] || falha "'suporte limpar' nao tem opcoes (veio: $*)." "use: sudo dgclaw suporte limpar"
    suporte_remover vencidas
    if [ "$SUP_REMOVIDAS" -gt 0 ]; then
        # shellcheck disable=SC2086 # fingerprints nao tem espaco
        suporte_registrar_revogadas $SUP_FPS_REMOVIDOS
    fi
    ok "$SUP_REMOVIDAS chave(s) vencida(s) do suporte removida(s)."
}

suporte_status() {
    [ $# -eq 0 ] || falha "'suporte status' nao tem opcoes (veio: $*)." "use: sudo dgclaw suporte status"
    local linha atual agora fim fim_s ativas=0 vencidas=0 fp historico
    agora="$(suporte_agora_s)"
    atual="$(suporte_ler_linhas)"
    suporte_listar_sessoes || true   # antes do resumo: sem verificar as sessoes nao se anuncia "desligado"
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
    suporte_contar_outras
    historico=0
    if [ "$vencidas" -gt 0 ] || [ -e "$(suporte_alerta_arquivo)" ]; then historico=1; fi
    if [ "$ativas" -gt 0 ]; then
        printf 'suporte: %s chave(s) ligada(s), %s vencida(s)\n' "$ativas" "$vencidas"
    elif [ "$historico" = 1 ] && [ -n "$SUP_SES_ERRO" ]; then
        printf 'suporte: chave revogada ou vencida, acesso ainda nao confirmado como encerrado (nao consegui verificar as sessoes de root: %s)\n' "$SUP_SES_ERRO"
    elif [ "$historico" = 1 ] && [ "$SUP_N_TOTAL" -gt 0 ]; then
        printf 'suporte: chave revogada ou vencida, acesso ainda nao confirmado como encerrado (%s sessao(oes) de root abertas)\n' "$SUP_N_TOTAL"
    elif [ -n "$SUP_SES_ERRO" ]; then
        printf 'suporte: sem chave do suporte no arquivo, mas NAO consegui confirmar que esta desligado\n'
    elif [ "$vencidas" -gt 0 ]; then
        printf 'suporte: %s chave(s) ligada(s), %s vencida(s)\n' "$ativas" "$vencidas"
    else
        printf 'suporte: desligado\n'
    fi
    if [ "$vencidas" -gt 0 ]; then
        printf 'As vencidas ja nao entram (o servidor recusa), mas ainda estao no arquivo. Para remover: sudo dgclaw suporte limpar\n'
    fi
    suporte_mostrar_sessoes
    if [ "$SUP_OUTRAS" -gt 0 ]; then
        printf 'Para encerrar todas as sessoes SSH de root, menos a sua: sudo dgclaw suporte desligar --derrubar-sessoes\n'
    elif [ "$SUP_VERIF_FALHOU" = 1 ]; then
        if [ "$ENSAIO" != 1 ]; then
            install -d -m 700 "$(sup_dir_estado)"; : >"$(suporte_alerta_arquivo)"; chmod 600 "$(suporte_alerta_arquivo)"
        fi
        return 1
    elif [ "$SUP_N_TOTAL" -eq 0 ] && [ "$ENSAIO" != 1 ]; then
        rm -f "$(suporte_alerta_arquivo)"   # confirmado: nenhuma sessao de root aberta (nem a de quem consulta), a pendencia acabou
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
        return 0
    fi
    # Sem chave nossa valendo: antes de dizer o estado, consulta as sessoes de root (chave vencida antes do timer,
    # ou removida com sessao aberta, nao e acesso encerrado).
    if [ "$vencidas" -gt 0 ] || [ -e "$(suporte_alerta_arquivo)" ]; then
        if ! suporte_listar_sessoes; then
            s_aviso "suporte: chave revogada ou vencida, acesso ainda nao confirmado como encerrado (nao consegui verificar as sessoes de root: $SUP_SES_ERRO), veja sudo dgclaw suporte status"
            return 0
        fi
        suporte_contar_outras
        if [ "$SUP_N_TOTAL" -gt 0 ]; then
            s_aviso "suporte: chave revogada ou vencida, acesso ainda nao confirmado como encerrado ($SUP_N_TOTAL sessao(oes) de root abertas), veja sudo dgclaw suporte status"
            return 0
        fi
        if [ "$ENSAIO" != 1 ]; then rm -f "$(suporte_alerta_arquivo)"; fi
    fi
    if [ "$vencidas" -gt 0 ]; then
        s_aviso "suporte: desligado, mas $vencidas chave(s) vencida(s) ainda no arquivo (remova com: sudo dgclaw suporte limpar)"
    else
        s_ok "suporte: desligado"
    fi
}
