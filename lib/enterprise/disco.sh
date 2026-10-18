#!/usr/bin/env bash
# lib/enterprise/disco.sh: disco cifrado para os dados dos agentes (protecao `disco_cifrado`).
#
# Numa VPS normalmente nao ha disco sobrando, entao o volume cifrado e um ARQUIVO esparso
# (/var/lib/dgclaw-cofre/dados.luks, LUKS2) aberto como /dev/mapper/dgclaw-dados e montado em cima de
# /var/lib/dgclaw/agentes, o mesmo caminho de sempre: nada mais precisa mudar.
#
# HONESTIDADE (modo `auto`): a chave do volume (/etc/dgclaw/disco.chave) fica NESTA mesma maquina. Isso
# protege contra snapshot do disco, disco descartado e backup do provedor; NAO protege contra quem tem
# root com a maquina ligada (a chave esta ao alcance dele e o volume esta aberto). O modo `externo`
# (Fase 3) troca so a ORIGEM da chave: ver `disco_obter_chave`.
#
# Comandos: dgclaw disco cifrar [--tamanho 40G] | abrir | status.
# `cifrar` move dados: nunca roda sozinho numa maquina que ja tem agentes.
#
# Cota por agente (arquivo-imagem ext4 de tamanho fixo montado no lugar da casa, `DGCLAW_COTA_AGENTE`):
# NAO implementada nesta entrega, so o desenho em docs/enterprise/CONTAINER-ENDURECIDO.md.

_disco_arq() { printf '%s' "${DGCLAW_DISCO_ARQUIVO:-$R/var/lib/dgclaw-cofre/dados.luks}"; }
_disco_chave() { printf '%s/disco.chave' "$DG_ETC"; }
_disco_nome() { printf 'dgclaw-dados'; }
_disco_mapper() { printf '%s' "${DGCLAW_DISCO_MAPPER:-$R/dev/mapper/dgclaw-dados}"; }
_disco_destino() { printf '%s' "${DG_CASAS:-$DG_LIB/agentes}"; }
_disco_unidade() { printf '%s/dgclaw-disco.service' "$DG_UNITS"; }

DISCO_TAMANHO_PADRAO=40G

_disco_aviso_honestidade() {
    cat <<'FIM'
   Lembrete honesto: neste modo (auto) a chave do disco fica na propria maquina (/etc/dgclaw/disco.chave).
   Ele protege contra snapshot do disco, disco descartado e backup do provedor.
   Ele NAO protege contra quem tem root com a maquina ligada.
FIM
}

# disco_obter_chave: imprime o CAMINHO de um arquivo com a chave do volume. No modo auto e o arquivo fixo em
# /etc/dgclaw. O modo `externo` (lib/enterprise/disco-externo.sh) busca a chave fora da maquina (Tang) ou usa a frase
# que o TI digitou, grava num arquivo em RAM e imprime esse caminho: quem chama (abrir, cifrar) nao muda.
disco_obter_chave() {
    local modo chave
    modo="$(protecao_valor disco_cifrado)" || return 1
    case "$modo" in
        auto|nao)
            chave="$(_disco_chave)"
            [ -s "$chave" ] || { printf 'Nao deu certo: nao achei a chave do disco em %s.\nO que fazer: restaure o arquivo do backup (ele vai em /etc/dgclaw) ou, se o volume nunca foi criado, rode: dgclaw disco cifrar\n' "${chave#"$R"}" >&2; return 1; }
            printf '%s' "$chave" ;;
        externo) disco_externo_chave ;;
        *) printf 'Nao deu certo: valor inesperado de disco_cifrado: %s.\nO que fazer: veja dgclaw nivel.\n' "$modo" >&2; return 1 ;;
    esac
}

_disco_ligado() {
    local m
    m="$(protecao_valor disco_cifrado)" || return 1
    [ "$m" != nao ]
}

_disco_exigir_ligado() {
    _disco_ligado || falha "a protecao disco_cifrado esta desligada neste nivel ($(protecao_nivel))." \
        "ligue com: dgclaw nivel definir escritorio   (ou: dgclaw nivel ajustar disco_cifrado auto)"
}

_disco_montado() { mountpoint -q "$(_disco_destino)" 2>/dev/null; }
_disco_aberto() { [ -e "$(_disco_mapper)" ]; }

# _disco_livre_m <caminho>: MiB livres no disco onde o caminho esta (sobe ate a pasta que existe). Vazio se nao deu para ler.
_disco_livre_m() {
    local d="$1"
    # DGCLAW_DISCO_LIVRE_M so existe para os testes simularem um disco grande.
    if [ -n "${DGCLAW_DISCO_LIVRE_M:-}" ]; then printf '%s' "$DGCLAW_DISCO_LIVRE_M"; return 0; fi
    while [ ! -d "$d" ] && [ "$d" != / ] && [ "$d" != . ]; do d="$(dirname "$d")"; done
    df -B1M --output=avail "$d" 2>/dev/null | tail -n 1 | tr -d ' '
}

# _disco_tamanho_ok <valor>: 1G a 99999G ou 100M a 99999M.
_disco_tamanho_ok() { [[ "$1" =~ ^[1-9][0-9]{0,4}[GM]$ ]]; }

# _disco_abrir_mapper: abre o volume (se ainda nao esta aberto). Chave sempre por arquivo, nunca por argv.
_disco_abrir_mapper() {
    local chave
    _disco_aberto && return 0
    # Modo externo com Tang: o proprio Clevis abre (clevis luks unlock); nao ha chave em arquivo.
    if disco_externo_tang_ativo; then disco_externo_abrir_tang; return 0; fi
    chave="$(disco_obter_chave)" || return 1
    cryptsetup open --type luks2 --key-file "$chave" "$(_disco_arq)" "$(_disco_nome)" \
        || { disco_chave_limpar "$chave"; falha "o cryptsetup nao abriu $(_disco_arq)." \
                 "confira se a chave ou a frase e a do volume e se o arquivo esta inteiro (cryptsetup luksDump $(_disco_arq))."; }
    # Chave vinda de fora fica so em RAM e some assim que o volume abre (no modo auto o arquivo e o de /etc/dgclaw e fica).
    disco_chave_limpar "$chave"
}

# _disco_abrir [--boot]: --boot e da unidade do systemd no modo externo. Se nao conseguir abrir (Tang fora do ar,
# frase ainda nao digitada), NAO derruba o boot: avisa, audita e sai com 0 deixando a pasta dos agentes sem montar
# (o drop-in do podman-restart impede os containers de subirem no disco comum).
_disco_abrir() {
    if [ "${1:-}" = "--boot" ]; then
        local rc=0
        ( _disco_abrir ) || rc=$?
        if [ "$rc" -ne 0 ]; then
            aviso "DADOS TRANCADOS: o disco cifrado nao abriu no boot. Os agentes nao vao subir ate alguem abrir. Rode: dgclaw disco desbloquear (motivo acima)."
            auditar_aviso disco.trancado "$(jq -nc '{origem: "boot"}')"
        fi
        return 0
    fi
    _disco_exigir_ligado
    [ -e "$(_disco_arq)" ] || falha "o volume cifrado $(_disco_arq) nao existe." "crie com: dgclaw disco cifrar"
    ent_exigir cryptsetup mount
    _disco_abrir_mapper
    if _disco_montado; then
        info "o disco cifrado ja esta montado em $(_disco_destino)"
    else
        mkdir -p "$(_disco_destino)"
        mount "$(_disco_mapper)" "$(_disco_destino)" \
            || falha "nao consegui montar $(_disco_mapper) em $(_disco_destino)." "veja o erro acima; o volume esta aberto, entao 'mount' manual funciona depois de resolver."
        ok "disco cifrado aberto e montado em $(_disco_destino)"
    fi
}

# --- cifrar --------------------------------------------------------------------------------------------

DISCO_ETAPA=""            # onde o `cifrar` esta: antes da troca tudo se desfaz; depois, nada se apaga
DISCO_PARADOS=()          # agentes que eu parei e preciso religar
DISCO_TMP_MONTAGEM=""

_disco_religar_agentes() {
    local s
    for s in "${DISCO_PARADOS[@]}"; do
        if ent_rodar_ganchos ent_antes_de_iniciar_ "$s"; then
            podman start "dgclaw-$s" >/dev/null || aviso "nao consegui religar o agente $s. Ligue com: dgclaw agente iniciar $s"
        else
            aviso "a preparacao antes de ligar o agente $s falhou (mensagem acima); ele ficou parado. Resolva e ligue com: dgclaw agente iniciar $s"
        fi
    done
    DISCO_PARADOS=()
}

# _disco_falhou <o que falhou> <o que fazer>: desfaz o que da (so ate a troca) e sai com a mensagem.
_disco_falhou() {
    if [ "$DISCO_ETAPA" = antes ]; then
        if [ -n "$DISCO_TMP_MONTAGEM" ] && mountpoint -q "$DISCO_TMP_MONTAGEM" 2>/dev/null; then
            umount "$DISCO_TMP_MONTAGEM" || aviso "nao consegui desmontar $DISCO_TMP_MONTAGEM; desmonte a mao: umount $DISCO_TMP_MONTAGEM"
        fi
        if _disco_aberto; then
            cryptsetup close "$(_disco_nome)" || aviso "nao consegui fechar o volume $(_disco_nome); feche a mao: cryptsetup close $(_disco_nome)"
        fi
        # Este comando acabou de criar o arquivo e a chave (nao tinham dados nem existiam antes).
        rm -f "$(_disco_arq)" "$(_disco_chave)"
        _disco_religar_agentes
        falha "$1" "$2 Nada foi mudado nos dados dos agentes (eles voltaram a rodar do mesmo lugar)."
    fi
    falha "$1" "$2 ATENCAO: a troca de pasta ja aconteceu; NADA foi apagado. Os dados antigos estao em $(_disco_destino).antes-de-cifrar."
}

# _disco_amostra_confere <origem> <destino>: sha256 de ate 200 arquivos, espalhados pela lista.
_disco_amostra_confere() {
    local de="$1" para="$2" total passo i=0 f ruins=0 a b
    total="$(find "$de" -type f 2>/dev/null | wc -l)"
    passo=$(( total / 200 + 1 ))
    while IFS= read -r -d '' f; do
        i=$((i + 1))
        [ $(( i % passo )) -eq 1 ] || [ "$passo" -eq 1 ] || continue
        a="$(sha256sum <"$de/$f" | cut -d' ' -f1)"
        b=""
        if [ -f "$para/$f" ]; then b="$(sha256sum <"$para/$f" | cut -d' ' -f1)"; fi
        if [ "$a" != "$b" ]; then ruins=$((ruins + 1)); printf '   diferente na copia: %s\n' "$f" >&2; fi
    done < <(cd "$de" && find . -type f -print0 | LC_ALL=C sort -z)
    [ "$ruins" -eq 0 ]
}

_disco_cifrar() {
    local tamanho="$DISCO_TAMANHO_PADRAO" arq chave destino a livre slug cont
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --tamanho) [ "$#" -ge 2 ] || falha "faltou o valor depois de --tamanho." "use: dgclaw disco cifrar --tamanho 40G"
                       tamanho="$2"; shift 2 ;;
            *) falha "opcao desconhecida: $1" "use: dgclaw disco cifrar [--tamanho 40G]" ;;
        esac
    done
    _disco_tamanho_ok "$tamanho" || falha "o tamanho '$tamanho' nao serve." "use um numero inteiro com G ou M, por exemplo 40G ou 2048M."
    _disco_exigir_ligado
    ent_exigir jq cryptsetup rsync mkfs.ext4 mount umount mountpoint truncate sha256sum
    arq="$(_disco_arq)"; chave="$(_disco_chave)"; destino="$(_disco_destino)"
    _disco_montado && falha "$destino ja e um disco montado (provavelmente o cifrado)." "veja: dgclaw disco status"
    [ ! -e "$chave" ] || falha "ja existe uma chave de disco em $chave, mas nao ha volume em $arq." \
        "ela pode ser de um volume guardado em outro lugar; mova-a para outra pasta (nao a apague) e repita."
    [ ! -e "$arq" ] || falha "ja existe um volume cifrado em $arq." "se ele e o seu, abra com: dgclaw disco abrir. Se e lixo de uma tentativa antiga, mova-o para outra pasta e repita."
    livre="$(_disco_livre_m "$(dirname "$arq")")"
    if [[ "$livre" =~ ^[0-9]+$ ]]; then
        local pedido_m="${tamanho%[GM]}"
        [ "${tamanho: -1}" = G ] && pedido_m=$((pedido_m * 1024))
        if [ "$pedido_m" -gt "$livre" ]; then
            aviso "o volume de $tamanho e maior que o espaco livre agora (${livre}M). O arquivo e esparso e so ocupa o que for escrito, mas o disco pode encher antes de o volume encher."
        fi
    fi

    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] criaria $arq ($tamanho, esparso), a chave em $chave (400), formataria LUKS2 + ext4, copiaria $destino com rsync, conferiria, trocaria a montagem e guardaria o antigo em $destino.antes-de-cifrar"
        return 0
    fi

    passo "Cifrando os dados dos agentes ($tamanho)"
    DISCO_ETAPA=antes; DISCO_PARADOS=(); DISCO_TMP_MONTAGEM="$R/mnt/dgclaw-dados-novo"
    # Para os agentes que estao ligados: copiar casa em uso daria arquivos pela metade.
    while IFS= read -r slug; do
        [ -n "$slug" ] || continue
        cont="$(podman inspect -f '{{.State.Status}}' "dgclaw-$slug" 2>/dev/null)" || cont=""
        if [ "$cont" = running ]; then
            podman stop "dgclaw-$slug" >/dev/null || falha "nao consegui parar o agente $slug." "pare com: dgclaw agente parar $slug   e repita."
            DISCO_PARADOS+=("$slug")
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    [ "${#DISCO_PARADOS[@]}" -eq 0 ] || info "agentes parados durante a copia: ${DISCO_PARADOS[*]}"

    mkdir -p "$(dirname "$arq")"; chmod 700 "$(dirname "$arq")"
    ( umask 277; head -c 64 /dev/urandom >"$chave" ) || _disco_falhou "nao consegui gravar a chave do disco em $chave." "confira o espaco e a permissao de $(dirname "$chave")."
    chmod 400 "$chave"
    truncate -s "$tamanho" "$arq" || _disco_falhou "nao consegui criar o arquivo $arq de $tamanho." "confira o espaco livre (df -h) e tente um tamanho menor."
    chmod 600 "$arq"
    cryptsetup luksFormat --type luks2 --batch-mode --key-file "$chave" "$arq" \
        || _disco_falhou "o cryptsetup nao formatou $arq." "veja o erro acima."
    _disco_abrir_mapper || _disco_falhou "nao consegui abrir o volume recem-criado." "veja o erro acima."
    mkfs.ext4 -q -L dgclaw-dados "$(_disco_mapper)" || _disco_falhou "o mkfs.ext4 nao formatou $(_disco_mapper)." "veja o erro acima."

    mkdir -p "$DISCO_TMP_MONTAGEM"
    [ -d "$destino" ] || mkdir -p "$destino"
    mount "$(_disco_mapper)" "$DISCO_TMP_MONTAGEM" || _disco_falhou "nao consegui montar o volume novo em $DISCO_TMP_MONTAGEM." "veja o erro acima."
    info "copiando $destino para o volume cifrado (preserva donos, links, ACLs e atributos)..."
    rsync -aHAX --numeric-ids "$destino/" "$DISCO_TMP_MONTAGEM/" \
        || _disco_falhou "o rsync nao terminou a copia de $destino." "veja o erro acima."
    a="$(find "$destino" | wc -l)"; local b
    b="$(find -H "$DISCO_TMP_MONTAGEM" -mindepth 1 -not -path "$DISCO_TMP_MONTAGEM/lost+found*" | wc -l)"
    # O find da origem conta a propria pasta e o da copia nao conta a raiz nem lost+found.
    if [ $((a - 1)) -ne "$b" ]; then
        _disco_falhou "a copia tem $b itens e a origem tem $((a - 1)); nao bate." "nada foi trocado. Confira se algum agente escreveu na casa durante a copia e repita."
    fi
    _disco_amostra_confere "$destino" "$DISCO_TMP_MONTAGEM" \
        || _disco_falhou "a conferencia por checksum achou arquivo diferente na copia (lista acima)." "nada foi trocado. Repita o comando."
    ok "copia conferida: $b itens iguais e amostra de arquivos com o mesmo sha256"

    umount "$DISCO_TMP_MONTAGEM" || _disco_falhou "nao consegui desmontar $DISCO_TMP_MONTAGEM." "veja quem usa: fuser -vm $DISCO_TMP_MONTAGEM"
    # A TROCA. Dali em diante nada se desfaz sozinho e nada e apagado.
    local velho="$destino.antes-de-cifrar"
    [ ! -e "$velho" ] || velho="$velho-$(date +%Y%m%d-%H%M%S)"
    mv "$destino" "$velho" || _disco_falhou "nao consegui mover $destino para $velho." "nada foi trocado."
    DISCO_ETAPA=depois
    mkdir -p "$destino"
    if ! mount "$(_disco_mapper)" "$destino"; then
        if rmdir "$destino" 2>/dev/null && mv "$velho" "$destino"; then
            info "a pasta antiga voltou para $destino"
        else
            aviso "nao consegui devolver $velho para $destino. Os dados estao inteiros em $velho."
        fi
        DISCO_ETAPA=antes
        _disco_falhou "nao consegui montar o volume cifrado em $destino." "veja o erro acima."
    fi
    ok "disco cifrado montado em $destino; a copia antiga ficou em $velho"
    disco_instalar_unidade
    _disco_religar_agentes
    printf '\n'
    _disco_aviso_honestidade
    info "Quando tiver conferido que tudo funciona, apague a copia antiga (ela esta SEM cifra): $velho"
    if [ "$(protecao_valor disco_cifrado)" = externo ]; then
        info "Este nivel pede a chave do disco FORA da maquina. A chave local e transitoria; troque agora: dgclaw disco chave externa tang <url> --thp <thumbprint>   ou   dgclaw disco chave externa manual"
    fi
    auditar_aviso disco.cifrar "$(jq -nc --arg t "$tamanho" --arg v "$velho" --argjson n "$b" '{tamanho: $t, copia_antiga: $v, itens: $n}')"
}

# disco_instalar_unidade: a unidade que abre e monta o volume no boot, antes de tudo que usa os agentes.
disco_instalar_unidade() {
    local boot=""
    if [ "$(protecao_valor disco_cifrado)" = externo ]; then boot=" --boot"; fi
    cat <<'FIM' | sed "s|@BOOT@|$boot|" | escrever_arquivo "$(_disco_unidade)" 644
[Unit]
Description=DG Claw: abre e monta o disco cifrado dos agentes
After=local-fs.target
# Antes de tudo que le a casa dos agentes: Web, Admin, firewall, cofres e os containers.
Before=dgclaw-web.service dgclaw-admin.service dgclaw-firewall.service dgclaw-cofre.service podman.service podman-restart.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/dgclaw disco abrir@BOOT@
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
FIM
    executar systemctl daemon-reload
    executar systemctl enable dgclaw-disco.service
    ok "unidade dgclaw-disco.service instalada (abre o disco cifrado no boot)"
}

_disco_status() {
    local modo arq
    modo="$(protecao_valor disco_cifrado)"
    arq="$(_disco_arq)"
    printf 'Disco cifrado: protecao = %s\n' "$modo"
    if [ ! -e "$arq" ]; then
        printf '  volume: nao existe (%s)\n' "${arq#"$R"}"
        [ "$modo" = nao ] || printf '  a protecao esta ligada mas os dados ainda estao SEM cifra. Para cifrar: dgclaw disco cifrar [--tamanho 40G]\n'
        return 0
    fi
    printf '  volume: %s (%s de tamanho, %s ocupados de verdade)\n' "${arq#"$R"}" \
        "$(du -h --apparent-size "$arq" | cut -f1)" "$(du -h "$arq" | cut -f1)"
    printf '  chave: %s (%s)\n' "$(_disco_chave | sed "s|^$R||")" "$([ -f "$(_disco_chave)" ] && stat -c 'modo %a' "$(_disco_chave)" || echo 'AUSENTE')"
    printf '  aberto: %s\n' "$(_disco_aberto && echo sim || echo nao)"
    printf '  montado em %s: %s\n' "$(_disco_destino | sed "s|^$R||")" "$(_disco_montado && echo sim || echo nao)"
    printf '  unidade de boot: %s\n' "$([ -f "$(_disco_unidade)" ] && echo instalada || echo 'NAO instalada')"
    printf '\n'
    _disco_aviso_honestidade
}

ent_cmd_disco() {
    local sub="${1:-status}"
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        status) _disco_status ;;
        cifrar) _disco_cifrar "$@" ;;
        abrir) _disco_abrir "$@" ;;
        chave|desbloquear) disco_externo_comando "$sub" "$@" ;;   # lib/enterprise/disco-externo.sh
        *) falha "o subcomando 'disco $sub' nao existe." "use: dgclaw disco status | cifrar [--tamanho 40G] | abrir | chave externa tang|manual | desbloquear" ;;
    esac
}

# --- ganchos -------------------------------------------------------------------------------------------

ent_status_disco() {
    _disco_ligado || return 0
    if [ ! -e "$(_disco_arq)" ]; then
        s_aviso "disco cifrado ligado, mas os dados dos agentes ainda estao sem cifra. Rode: dgclaw disco cifrar"
    elif _disco_montado; then
        s_ok "disco cifrado aberto e montado em $(_disco_destino | sed "s|^$R||")"
    else
        if [ "$(protecao_valor disco_cifrado)" = externo ]; then
            s_mal "DADOS TRANCADOS: o disco cifrado nao esta montado e os agentes ficam fora do ar ate alguem abrir. Rode: dgclaw disco desbloquear (Tang: confira a rede ate ele)"
        else
            s_mal "o disco cifrado existe mas NAO esta montado: os agentes estariam gravando no disco comum. Rode: dgclaw disco abrir"
        fi
    fi
}

# Instalador. Cifrar MOVE dados: so roda sozinho numa maquina nova (sem agentes); com agentes, so avisa.
ent_instalar_disco() {
    local livre_g tam
    _disco_ligado || return 0
    if [ "$ENSAIO" = 1 ] || ! command -v cryptsetup >/dev/null 2>&1 || ! command -v rsync >/dev/null 2>&1; then
        executar apt-get install -y --no-install-recommends cryptsetup rsync e2fsprogs
    fi
    if [ -e "$(_disco_arq)" ]; then
        ok "disco cifrado ja existe ($(_disco_arq | sed "s|^$R||"))"
        return 0
    fi
    if [ "$(agentes_ler | jq '[.agentes[] | select(.tipo == "agente")] | length')" -gt 0 ] || [ -n "$(find "$(_disco_destino)" -mindepth 1 -print -quit 2>/dev/null)" ]; then
        aviso "o disco cifrado esta ligado neste nivel, mas esta maquina ja tem agentes e cifrar move os dados deles: nunca faco isso sozinho. Quando puder parar os agentes por alguns minutos: dgclaw disco cifrar [--tamanho 40G]"
        return 0
    fi
    # 70% do espaco livre, em GiB.
    livre_g="$(_disco_livre_m "$(dirname "$(_disco_arq)")")"
    [[ "$livre_g" =~ ^[0-9]+$ ]] || livre_g=0
    livre_g=$(( livre_g / 1024 ))
    tam=$(( livre_g * 70 / 100 ))
    if [ "$tam" -lt 5 ]; then
        aviso "so ha ${livre_g}G livres: pouco para um volume cifrado (minimo 5G a 70%). Libere espaco ou rode depois: dgclaw disco cifrar --tamanho <tamanho>"
        return 0
    fi
    info "maquina nova, sem agentes: criando o disco cifrado de ${tam}G (70% do livre)"
    # Subshell: `falha` sai do processo, e um disco que nao cifrou nao deve derrubar o resto da instalacao.
    ( _disco_cifrar --tamanho "${tam}G" ) \
        || aviso "nao consegui cifrar o disco agora (motivo acima). A instalacao seguiu sem disco cifrado; rode depois: dgclaw disco cifrar --tamanho ${tam}G"
}
