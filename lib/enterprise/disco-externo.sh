#!/usr/bin/env bash
# lib/enterprise/disco-externo.sh: a chave do disco cifrado FORA da VPS (protecao `disco_cifrado` = externo).
#
# O modo `auto` (lib/enterprise/disco.sh) deixa a chave do volume na propria maquina. No regulado ela sai de la:
#
#   tang    um servidor Tang da empresa guarda a metade que falta (Clevis). No boot a VPS pergunta ao Tang
#           e abre o volume sozinha. Sem rede para o Tang, a VPS sobe SEM os dados dos agentes e o monitor alerta.
#   manual  o TI digita uma frase depois de cada reinicio: `dgclaw disco desbloquear`. Ate la o Web mostra
#           "dados trancados, aguardando desbloqueio" e os containers dos agentes nao sobem.
#
# Comandos:
#   dgclaw disco chave externa tang <url> [--thp <thumbprint>] [--confirmar]
#   dgclaw disco chave externa manual [--confirmar]
#   dgclaw disco desbloquear
#   dgclaw disco chave status
#
# ORDEM SEGURA (o volume nunca fica sem metodo valido): 1) o metodo novo e ADICIONADO a um slot novo do LUKS;
# 2) abrir o volume com ele e TESTADO (cryptsetup --test-passphrase), duas vezes; 3) so entao, e so com
# --confirmar, a chave local (/etc/dgclaw/disco.chave) sai do slot e o arquivo e apagado com shred. Esse ultimo
# passo e o unico destrutivo. Sem --confirmar o comando para no passo 2 e a chave local continua valendo.
#
# O que sobe o volume no boot e a unidade dgclaw-disco.service (lib/enterprise/disco.sh), que no modo externo roda
# `dgclaw disco abrir --boot`: se nao conseguir abrir, nao derruba o boot, grava o aviso e deixa a pasta dos
# agentes SEM montar. Um drop-in no podman-restart.service (ConditionPathIsMountPoint) impede que os containers
# subam gravando no disco comum no lugar do volume cifrado.
#
# Frase e chave: nunca em argv nem em log. A frase vem do terminal sem eco (ou do STDIN, para automacao), passa
# por um arquivo 600 numa pasta em RAM (/run/dgclaw/disco) e e apagado com shred logo depois.

_dext_estado() { printf '%s/disco-externo.json' "$DG_ETC"; }
_dext_ram() { printf '%s/run/dgclaw/disco' "$R"; }
_dext_chave_ram() { printf '%s/disco.chave' "$(_dext_ram)"; }
_dext_dropin() { printf '%s/podman-restart.service.d/30-dgclaw-disco.conf' "$DG_UNITS"; }

_dext_metodo() {
    [ -s "$(_dext_estado)" ] || return 0
    jq -r '.metodo // empty' "$(_dext_estado)" 2>/dev/null || true
}
_dext_campo() { jq -r --arg c "$1" '.[$c] // empty' "$(_dext_estado)" 2>/dev/null || true; }

_dext_externo() { [ "$(protecao_valor disco_cifrado)" = externo ]; }

_dext_preparar_ram() {
    mkdir -p "$(_dext_ram)"
    chmod 700 "$(_dext_ram)"
}

# disco_chave_limpar <caminho>: apaga com shred a chave temporaria em RAM. Nao mexe em nada fora dela.
disco_chave_limpar() {
    case "$1" in
        "$(_dext_ram)"/*) [ ! -e "$1" ] || shred -u "$1" || aviso "o shred nao apagou $1; apague a mao: rm -f $1" ;;
    esac
}

# _dext_gravar_estado <json>
_dext_gravar_estado() { printf '%s\n' "$1" | escrever_arquivo "$(_dext_estado)" 600; }

# --- ler a frase -----------------------------------------------------------------------------------------

# _dext_ler_frase <mensagem> <confirmar:0|1>: deixa a frase em DEXT_FRASE. Terminal: sem eco. Sem terminal (automacao):
# a primeira linha do STDIN, e a segunda como confirmacao.
DEXT_FRASE=""
_dext_ler_frase() {
    local msg="$1" confirmar="$2" a="" b=""
    if [ -t 0 ]; then
        read -r -s -p "$msg: " a || falha "nao consegui ler a frase do terminal." "rode de novo num terminal interativo."
        printf '\n' >&2
        if [ "$confirmar" = 1 ]; then
            read -r -s -p "Digite a frase de novo para confirmar: " b || falha "nao consegui ler a confirmacao da frase." "rode de novo num terminal interativo."
            printf '\n' >&2
        fi
    else
        IFS= read -r a || falha "nao recebi a frase pelo STDIN." "digite no terminal, ou mande a frase numa linha pelo STDIN (nunca por argumento)."
        if [ "$confirmar" = 1 ]; then IFS= read -r b || falha "nao recebi a confirmacao da frase (segunda linha do STDIN)." "mande a frase duas vezes, uma por linha."; fi
    fi
    if [ "$confirmar" = 1 ] && [ "$a" != "$b" ]; then
        falha "as duas digitacoes da frase nao sao iguais." "repita o comando e digite a mesma frase nas duas vezes."
    fi
    [ -n "$a" ] || falha "a frase veio vazia." "digite uma frase."
    DEXT_FRASE="$a"
}

# _dext_frase_para_arquivo <arquivo>: grava DEXT_FRASE (sem quebra de linha) num arquivo 600 e esquece a variavel.
_dext_frase_para_arquivo() {
    ( umask 077; printf '%s' "$DEXT_FRASE" >"$1" ) || falha "nao consegui gravar a frase temporaria em $1." "confira se ${1%/*} existe e tem espaco (e uma pasta em RAM)."
    chmod 600 "$1"
    DEXT_FRASE=""
}

# --- gancho do disco_obter_chave -------------------------------------------------------------------------

# disco_externo_chave: imprime o caminho de um arquivo com a chave do volume, vinda de fora da maquina.
disco_externo_chave() {
    local metodo vol
    metodo="$(_dext_metodo)"
    vol="$(_disco_arq)"
    case "$metodo" in
        tang)
            ent_exigir clevis
            _dext_preparar_ram
            if ! ( umask 077; clevis luks pass -d "$vol" -s "$(_dext_campo slot)" >"$(_dext_chave_ram)" ) 2>/dev/null || [ ! -s "$(_dext_chave_ram)" ]; then
                disco_chave_limpar "$(_dext_chave_ram)"
                printf 'Nao deu certo: o servidor Tang %s nao entregou a chave do disco (rede fora, Tang parado ou chave trocada).\nO que fazer: confira se este servidor alcanca o Tang (curl -fsS %s/adv >/dev/null) e repita: dgclaw disco abrir. Ate la os dados dos agentes ficam trancados.\n' "$(_dext_campo url)" "$(_dext_campo url)" >&2
                return 1
            fi
            printf '%s' "$(_dext_chave_ram)" ;;
        manual)
            if [ -s "$(_dext_chave_ram)" ]; then printf '%s' "$(_dext_chave_ram)"; return 0; fi
            printf 'Nao deu certo: os dados dos agentes estao trancados, aguardando o desbloqueio (a chave do disco e uma frase que so o TI sabe).\nO que fazer: rode no servidor: dgclaw disco desbloquear\n' >&2
            return 1 ;;
        "")
            # Modo externo escolhido mas nenhum metodo configurado ainda: a chave local transitoria do `disco cifrar` vale.
            if [ -s "$(_disco_chave)" ]; then
                aviso "o disco esta no modo externo mas a chave ainda e a LOCAL (${DG_ETC#"$R"}/disco.chave). Troque por uma chave fora da maquina: dgclaw disco chave externa tang <url>  ou  dgclaw disco chave externa manual"
                printf '%s' "$(_disco_chave)"
                return 0
            fi
            printf 'Nao deu certo: o disco esta no modo externo e nao ha chave configurada nem arquivo de chave local.\nO que fazer: configure com dgclaw disco chave externa tang <url>  ou  dgclaw disco chave externa manual. Se o volume ja existia, restaure %s do backup.\n' "$(_disco_chave | sed "s|^$R||")" >&2
            return 1 ;;
        *)
            printf 'Nao deu certo: o metodo "%s" em %s nao existe.\nO que fazer: use tang ou manual: dgclaw disco chave externa tang <url>\n' "$metodo" "$(_dext_estado | sed "s|^$R||")" >&2
            return 1 ;;
    esac
}

# disco_externo_tang_ativo: o volume abre por Tang (e ja nao depende da chave local)?
disco_externo_tang_ativo() { _dext_externo && [ "$(_dext_metodo)" = tang ]; }

# disco_externo_abrir_tang: abre o volume com `clevis luks unlock` (o mesmo que a unidade de boot usa).
disco_externo_abrir_tang() {
    ent_exigir clevis
    clevis luks unlock -d "$(_disco_arq)" -n "$(_disco_nome)" \
        || falha "o Clevis nao abriu $(_disco_arq | sed "s|^$R||") pelo Tang $(_dext_campo url)." \
                 "confira se este servidor alcanca o Tang (curl -fsS $(_dext_campo url)/adv >/dev/null). Sem rede para ele os dados dos agentes ficam trancados; o monitor avisa."
}

# --- checagens de volume ---------------------------------------------------------------------------------

_dext_exigir_volume() {
    [ -e "$(_disco_arq)" ] || falha "o volume cifrado $(_disco_arq | sed "s|^$R||") nao existe." "crie primeiro com: dgclaw disco cifrar"
    ent_exigir cryptsetup jq shred
}

# _dext_testar_com_arquivo <arquivo-de-chave>: o cryptsetup aceita esta chave? (nao abre nada)
_dext_testar_com_arquivo() {
    cryptsetup open --test-passphrase --key-file "$1" "$(_disco_arq)" >/dev/null 2>&1
}

# _dext_remover_chave_local: tira o disco.chave do LUKS e apaga o arquivo. So depois de testar o metodo novo.
_dext_remover_chave_local() {
    local chave
    chave="$(_disco_chave)"
    if [ ! -e "$chave" ]; then info "nao ha chave local para remover (${chave#"$R"} ja nao existe)."; return 0; fi
    cryptsetup luksRemoveKey --batch-mode "$(_disco_arq)" "$chave" \
        || falha "o cryptsetup nao removeu a chave local do volume." "o volume continua abrindo com ela e com o metodo novo; nada se perdeu. Veja o erro acima e repita com --confirmar."
    if _dext_testar_com_arquivo "$chave"; then
        falha "depois de remover, a chave local ainda abre o volume." "o apagamento nao foi feito (guardei o arquivo). Confira com: cryptsetup luksDump $(_disco_arq | sed "s|^$R||")"
    fi
    shred -u "$chave" || aviso "a chave local saiu do volume (nao abre mais nada), mas o shred nao apagou o arquivo ${chave#"$R"}; apague a mao: shred -u ${chave#"$R"}"
    ok "a chave local foi removida do volume e o arquivo apagado com shred"
}

_dext_explicar_remocao() {
    cat <<'FIM'
   O que o --confirmar faz (e o unico passo que nao se desfaz):
     1. confere de novo que o metodo externo abre o volume;
     2. tira a chave local (/etc/dgclaw/disco.chave) do volume;
     3. apaga o arquivo da chave local com shred.
   Depois disso, SEM o metodo externo ninguem abre o volume, nem este servidor, nem o backup do /etc/dgclaw.
   Guarde uma copia do cabecalho do volume em lugar seguro: cryptsetup luksHeaderBackup <volume> --header-backup-file <arquivo>
FIM
}

_dext_garantir_dropin() {
    # A unidade de boot do modo externo roda `abrir --boot`; uma instalada no modo auto precisa ser refeita.
    if [ -f "$(_disco_unidade)" ] && ! grep -q -- 'disco abrir --boot' "$(_disco_unidade)"; then disco_instalar_unidade; fi
    printf '# Gerado por dgclaw (disco cifrado externo). Os containers so sobem com o volume cifrado montado.\n[Unit]\nConditionPathIsMountPoint=%s\n' \
        "${DG_CASAS:-$DG_LIB/agentes}" | _dext_escrever_dropin "$(_dext_dropin)"
}

# _dext_escrever_dropin <arquivo>: grava o STDIN em 644 e recarrega o systemd se mudou.
_dext_escrever_dropin() {
    local alvo="$1" novo
    novo="$(cat)"
    if [ -f "$alvo" ] && [ "$(cat "$alvo")" = "$novo" ]; then return 0; fi
    printf '%s\n' "$novo" | escrever_arquivo "$alvo" 644
    executar systemctl daemon-reload
}

_dext_ajustar_protecao() {
    if [ "$(protecao_valor disco_cifrado)" != externo ]; then
        protecao_ajustar disco_cifrado externo || return 1
        ok "protecao disco_cifrado = externo"
    fi
}

# --- tang ------------------------------------------------------------------------------------------------

_DEXT_RX_URL='^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
_DEXT_RX_THP='^[A-Za-z0-9_-]{27,64}$'

# _dext_thp_do_adv <url>: imprime o thumbprint das chaves de assinatura do anuncio do Tang. Vazio se nao conseguiu.
_dext_thp_do_adv() {
    local adv
    adv="$(curl -fsS --max-time 20 "$1/adv" 2>/dev/null)" || return 1
    # Receita do proprio clevis-encrypt-tang: payload do JWS -> chaves de assinatura -> thumbprint.
    printf '%s' "$adv" | jose fmt -j- -Og payload -SyOg keys -Af- 2>/dev/null | jose jwk use -i- -r -u verify -o- 2>/dev/null | jose jwk thp -i- 2>/dev/null
}

# _dext_slot_tang <url>: numero do slot Clevis do Tang com essa URL (o ultimo, se houver mais de um). Vazio se nao tem.
_dext_slot_tang() {
    # Formato da lista: 1: tang '{"url":"http://tang","thp":"..."}'  (o numero do slot vem antes do primeiro ":")
    clevis luks list -d "$(_disco_arq)" 2>/dev/null | awk -v u="$1" '/^[0-9]+: tang / && index($0, "\"" u "\"") {sub(/:.*/, ""); print}' | tail -n 1
}

_dext_tang() {
    local url="" thp="" confirmar=0 chave cfg slot jaexiste=0 vol
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --thp) [ "$#" -ge 2 ] || falha "faltou o valor depois de --thp." "use: dgclaw disco chave externa tang <url> --thp <thumbprint>"
                   thp="$2"; shift 2 ;;
            --confirmar) confirmar=1; shift ;;
            -*) falha "opcao desconhecida: $1" "use: dgclaw disco chave externa tang <url> [--thp <thumbprint>] [--confirmar]" ;;
            *) [ -z "$url" ] || falha "sobrou '$1' na linha (a url ja e $url)." "use: dgclaw disco chave externa tang <url> [--thp <thumbprint>] [--confirmar]"
               url="${1%/}"; shift ;;
        esac
    done
    [ -n "$url" ] || falha "faltou o endereco do servidor Tang." "use: dgclaw disco chave externa tang http://tang.suaempresa.com.br [--thp <thumbprint>]"
    [[ "$url" =~ $_DEXT_RX_URL ]] || falha "o endereco '${url:0:80}' nao parece uma URL de Tang." "use algo como http://tang.suaempresa.com.br ou https://tang.suaempresa.com.br:7500 (so letras, numeros, ponto, hifen e barra)."
    _disco_exigir_ligado
    _dext_exigir_volume
    ent_exigir clevis curl
    vol="$(_disco_arq)"; chave="$(_disco_chave)"

    if [ -z "$thp" ]; then
        local visto
        visto="$(_dext_thp_do_adv "$url")" || visto=""
        if [ -n "$visto" ]; then
            falha "o servidor Tang respondeu com o thumbprint $visto e eu NAO confio nele as cegas: quem responde na rede pode ser outro servidor." \
                  "no servidor Tang rode 'tang-show-keys' (ou jose jwk thp -i <chave de assinatura>), compare com $visto e, se for o mesmo, repita com: dgclaw disco chave externa tang $url --thp $visto"
        fi
        falha "nao consegui ler o anuncio do Tang em $url/adv para mostrar o thumbprint." \
              "confira se este servidor alcanca $url (curl -fsS $url/adv). Ou pegue o thumbprint no proprio Tang ('tang-show-keys') e repita com --thp <thumbprint>."
    fi
    [[ "$thp" =~ $_DEXT_RX_THP ]] || falha "o thumbprint '${thp:0:40}' nao tem o formato certo (27 a 64 letras, numeros, - e _)." "copie exatamente o que o 'tang-show-keys' mostrou no servidor Tang."
    if [ ! -s "$chave" ] && [ "$(_dext_metodo)" != tang ]; then
        falha "nao ha chave local (${chave#"$R"}) para autorizar a adicao do Tang ao volume." "restaure o arquivo do backup do /etc/dgclaw, ou adicione o Tang com a frase atual (cryptsetup + clevis luks bind) e rode depois: dgclaw disco chave externa status"
    fi

    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] adicionaria um slot Clevis/Tang ($url, thp confirmado) ao volume, testaria a abertura duas vezes e${confirmar:+ (com --confirmar)} $([ "$confirmar" = 1 ] && echo 'removeria a chave local com shred' || echo 'pararia ai')"
        return 0
    fi

    slot="$(_dext_slot_tang "$url")"
    if [ -n "$slot" ]; then
        jaexiste=1
        info "o volume ja tem um slot Clevis/Tang para $url (slot $slot); so vou testar."
    else
        passo "Adicionando o Tang ao volume (a chave local continua valendo)"
        cfg="$(jq -nc --arg u "$url" --arg t "$thp" '{url: $u, thp: $t}')"
        # O Clevis confere o thumbprint contra as chaves que o Tang anuncia e recusa se nao baterem.
        clevis luks bind -f -d "$vol" -k "$chave" tang "$cfg" \
            || falha "o clevis luks bind nao conseguiu ligar o volume ao Tang $url (o thumbprint informado pode nao ser o do servidor, ou a rede nao chega nele)." \
                     "confira o thumbprint com 'tang-show-keys' no servidor Tang e a rede (curl -fsS $url/adv). Nada foi mudado no volume."
        slot="$(_dext_slot_tang "$url")"
        [ -n "$slot" ] || falha "o bind terminou bem, mas nao achei o slot do Tang na lista do clevis (clevis luks list -d $vol)." "confira a lista com esse comando; se o slot existe, repita este comando."
    fi

    passo "Testando que o Tang abre o volume (sem abrir de verdade)"
    _dext_testar_tang "$slot" || falha "o Tang nao abriu o volume no teste (slot $slot)." "confira a rede ate $url. A chave local continua valendo; nada foi removido."
    ok "o Tang $url abre o volume (slot $slot)"
    _dext_gravar_estado "$(jq -nc --arg u "$url" --arg t "$thp" --argjson s "$slot" --arg e "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{metodo: "tang", url: $u, thp: $t, slot: $s, em: $e}')"
    _dext_ajustar_protecao
    _dext_garantir_dropin
    if [ "$jaexiste" = 0 ]; then auditar_aviso disco.chave_externa "$(jq -nc --arg u "$url" '{metodo: "tang", url: $u, chave_local_removida: false}')"; fi

    if [ "$confirmar" != 1 ]; then
        printf '\n'
        info "A chave local AINDA abre o volume. Para o disco depender so do Tang:"
        _dext_explicar_remocao
        info "Se estiver de acordo: dgclaw disco chave externa tang $url --thp $thp --confirmar"
        return 0
    fi
    passo "Removendo a chave local (passo sem volta)"
    _dext_explicar_remocao
    _dext_testar_tang "$slot" || falha "o Tang nao abriu o volume no segundo teste, entao NAO removi a chave local." "confira a rede ate $url e repita."
    _dext_remover_chave_local
    _dext_testar_tang "$slot" || aviso "ATENCAO: depois de remover a chave local, o teste com o Tang falhou. O volume pode estar sem metodo valido: abra um chamado e NAO reinicie o servidor. Veja: cryptsetup luksDump $vol"
    auditar_aviso disco.chave_externa "$(jq -nc --arg u "$url" '{metodo: "tang", url: $u, chave_local_removida: true}')"
    ok "o disco agora depende do Tang. No boot, sem rede para ele, a VPS sobe sem os dados dos agentes e o monitor avisa."
}

# _dext_testar_tang <slot>: a senha que o Tang devolve abre o volume? (so testa)
_dext_testar_tang() {
    clevis luks pass -d "$(_disco_arq)" -s "$1" 2>/dev/null | cryptsetup open --test-passphrase --key-file - "$(_disco_arq)" >/dev/null 2>&1
}

# --- manual ----------------------------------------------------------------------------------------------

_dext_manual() {
    local confirmar=0 tmp chave vol
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --confirmar) confirmar=1; shift ;;
            *) falha "opcao desconhecida: $1" "use: dgclaw disco chave externa manual [--confirmar]" ;;
        esac
    done
    _disco_exigir_ligado
    _dext_exigir_volume
    vol="$(_disco_arq)"; chave="$(_disco_chave)"
    [ -s "$chave" ] || falha "nao ha chave local (${chave#"$R"}) para autorizar a adicao da frase ao volume." "restaure o arquivo do backup do /etc/dgclaw."
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] leria uma frase do terminal, adicionaria ao volume, testaria e$([ "$confirmar" = 1 ] && echo ' removeria a chave local com shred' || echo ' pararia ai')"
        return 0
    fi
    passo "Frase de desbloqueio (o TI digita depois de cada reinicio)"
    info "Use uma frase longa (20 caracteres ou mais) e guarde-a em dois lugares seguros. Sem ela, depois de remover a chave local, ninguem abre os dados."
    _dext_ler_frase "Frase nova" 1
    if [ "${#DEXT_FRASE}" -lt 20 ]; then DEXT_FRASE=""; falha "a frase tem menos de 20 caracteres." "escolha uma frase mais longa."; fi
    _dext_preparar_ram
    tmp="$(_dext_ram)/frase-nova"
    trap 'disco_chave_limpar "$(_dext_ram)/frase-nova"' EXIT
    _dext_frase_para_arquivo "$tmp"
    if _dext_testar_com_arquivo "$tmp"; then
        info "essa frase ja abre o volume; nao adiciono de novo."
    else
        cryptsetup luksAddKey --key-file "$chave" "$vol" "$tmp" \
            || falha "o cryptsetup nao adicionou a frase ao volume." "nada foi mudado; a chave local continua valendo. Veja o erro acima."
    fi
    _dext_testar_com_arquivo "$tmp" || falha "a frase recem-adicionada nao abriu o volume no teste." "a chave local continua valendo; nada foi removido. Repita o comando."
    ok "a frase abre o volume (testado sem abrir de verdade)"
    disco_chave_limpar "$tmp"
    trap - EXIT
    _dext_gravar_estado "$(jq -nc --arg e "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{metodo: "manual", em: $e}')"
    _dext_ajustar_protecao
    _dext_garantir_dropin
    auditar_aviso disco.chave_externa "$(jq -nc --argjson c "$([ "$confirmar" = 1 ] && echo true || echo false)" '{metodo: "manual", chave_local_removida: $c}')"
    if [ "$confirmar" != 1 ]; then
        printf '\n'
        info "A chave local AINDA abre o volume. Para o disco depender so da frase:"
        _dext_explicar_remocao
        info "Se estiver de acordo, repita: dgclaw disco chave externa manual --confirmar (digite a MESMA frase; ela nao e adicionada de novo)."
        return 0
    fi
    passo "Removendo a chave local (passo sem volta)"
    _dext_explicar_remocao
    _dext_remover_chave_local
    ok "o disco agora depende da frase. Depois de cada reinicio: dgclaw disco desbloquear"
}

# --- desbloquear -----------------------------------------------------------------------------------------

_dext_religar_agentes() {
    local slug estado parados=()
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] religaria os containers dos agentes"; return 0; fi
    systemctl start --no-block podman-restart.service || aviso "nao consegui pedir ao systemd para religar os containers (podman-restart.service). Ligue a mao: dgclaw agente iniciar <agente>"
    while IFS= read -r slug; do
        [ -n "$slug" ] || continue
        estado="$(estado_container "$slug")"
        if [ "$estado" != running ]; then parados+=("$slug"); fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    if [ "${#parados[@]}" -gt 0 ]; then
        info "agentes que ainda aparecem parados (podem estar subindo; se continuarem): ${parados[*]}. Ligue com: dgclaw agente iniciar <agente>"
    fi
}

_dext_desbloquear() {
    local metodo
    _disco_exigir_ligado
    ent_exigir cryptsetup jq shred
    _dext_externo || falha "o disco cifrado esta no modo '$(protecao_valor disco_cifrado)', que abre sozinho no boot." "o desbloqueio manual e do modo externo. Para abrir agora: dgclaw disco abrir"
    metodo="$(_dext_metodo)"
    if [ "$metodo" = manual ]; then
        if _disco_montado; then info "o disco cifrado ja esta montado em $(_disco_destino): nada a desbloquear."; return 0; fi
        [ "$ENSAIO" != 1 ] || { info "[ensaio] leria a frase e abriria o volume"; return 0; }
        _dext_ler_frase "Frase do disco" 0
        _dext_preparar_ram
        trap 'disco_chave_limpar "$(_dext_chave_ram)"' EXIT
        _dext_frase_para_arquivo "$(_dext_chave_ram)"
    elif [ "$metodo" = tang ]; then
        info "o disco usa o Tang ($(_dext_campo url)); tentando abrir por ele."
    fi
    _disco_abrir
    disco_chave_limpar "$(_dext_chave_ram)"
    trap - EXIT
    _dext_religar_agentes
    auditar_aviso disco.desbloquear "$(jq -nc --arg m "${metodo:-local}" '{metodo: $m}')"
    ok "dados destrancados"
}

# --- status ----------------------------------------------------------------------------------------------

_dext_status() {
    local metodo
    metodo="$(_dext_metodo)"
    printf 'Chave do disco: protecao = %s\n' "$(protecao_valor disco_cifrado)"
    case "$metodo" in
        tang) printf '  metodo: Tang (%s), slot %s, configurado em %s\n' "$(_dext_campo url)" "$(_dext_campo slot)" "$(_dext_campo em)" ;;
        manual) printf '  metodo: frase digitada pelo TI (configurado em %s)\n' "$(_dext_campo em)" ;;
        *) printf '  metodo: nenhum configurado ainda\n' ;;
    esac
    printf '  chave local (%s): %s\n' "${DG_ETC#"$R"}/disco.chave" "$([ -e "$(_disco_chave)" ] && echo 'AINDA EXISTE (qualquer pessoa com root abre o volume)' || echo 'removida')"
}

ent_cmd_disco_chave() {
    local sub="${1:-status}" metodo
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        status) _dext_status ;;
        externa)
            metodo="${1:-}"
            if [ "$#" -gt 0 ]; then shift; fi
            case "$metodo" in
                tang) _dext_tang "$@" ;;
                manual) _dext_manual "$@" ;;
                *) falha "faltou o metodo da chave externa (recebi '${metodo:-nada}')." "use: dgclaw disco chave externa tang <url> --thp <thumbprint>   ou   dgclaw disco chave externa manual" ;;
            esac ;;
        *) falha "'disco chave $sub' nao existe." "use: dgclaw disco chave status | externa tang <url> | externa manual" ;;
    esac
}

# disco_externo_comando <sub> [args]: chamado pelo ent_cmd_disco (lib/enterprise/disco.sh) para os subcomandos novos.
disco_externo_comando() {
    local sub="$1"; shift
    case "$sub" in
        chave) ent_cmd_disco_chave "$@" ;;
        desbloquear) _dext_desbloquear "$@" ;;
    esac
}

# --- ganchos ---------------------------------------------------------------------------------------------

ent_status_disco_externo() {
    _dext_externo || return 0
    case "$(_dext_metodo)" in
        tang) s_ok "chave do disco: Tang $(_dext_campo url)" ;;
        manual) s_ok "chave do disco: frase do TI (depois de reiniciar: dgclaw disco desbloquear)" ;;
        *) s_aviso "disco no modo externo, mas a chave ainda e a local. Configure: dgclaw disco chave externa tang <url>  ou  dgclaw disco chave externa manual" ;;
    esac
    if [ -e "$(_disco_arq)" ] && [ -n "$(_dext_metodo)" ] && [ -e "$(_disco_chave)" ]; then
        s_aviso "o metodo externo esta configurado, mas a chave local ainda existe em ${DG_ETC#"$R"}/disco.chave. Remova com: dgclaw disco chave externa ... --confirmar"
    fi
}

ent_instalar_disco_externo() {
    _dext_externo || return 0
    passo "Disco cifrado com chave externa"
    if [ "$ENSAIO" = 1 ] || ! command -v clevis >/dev/null 2>&1; then
        executar apt-get install -y --no-install-recommends clevis clevis-luks jose
    fi
    _dext_garantir_dropin
    if [ -z "$(_dext_metodo)" ]; then
        info "Falta escolher de onde vem a chave do disco: dgclaw disco chave externa tang <url> --thp <thumbprint>  ou  dgclaw disco chave externa manual"
    fi
}

ent_aplicar_disco_externo() {
    _dext_externo || return 0
    _dext_garantir_dropin
    [ -n "$(_dext_metodo)" ] || aviso "o disco esta no modo externo sem metodo configurado: dgclaw disco chave externa tang <url> --thp <thumbprint>  ou  dgclaw disco chave externa manual"
}

# Monitor (bloco F): dados trancados sao um problema que alguem precisa ver.
_mon_checar_disco_trancado() {
    local metodo
    _dext_externo || return 0
    [ -e "$(_disco_arq)" ] || return 0
    if ! _disco_montado; then
        metodo="$(_dext_metodo)"
        _mon_problema "disco-trancado" "Os dados dos agentes estao TRANCADOS: o disco cifrado nao esta aberto/montado em ${DG_LIB#"$R"}/agentes (metodo: ${metodo:-nenhum})." \
            "$([ "$(_dext_metodo)" = tang ] && echo "Confira se este servidor alcanca o Tang ($(_dext_campo url)) e rode: dgclaw disco abrir" || echo "Rode no servidor: dgclaw disco desbloquear (o TI digita a frase).") Ate la os agentes ficam fora do ar."
    fi
}
