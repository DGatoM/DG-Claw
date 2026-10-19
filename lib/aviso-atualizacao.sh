#!/usr/bin/env bash
# lib/aviso-atualizacao.sh: a parte do aviso de nova versao que mora na CLI (docs/AVISO-DE-ATUALIZACAO.md).
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Usa as funcoes dele e da lib/comum.sh
# (falha, ok, info, aviso, executar, definir_linha_env, exigir_ferramentas, s_ok, s_aviso...).
# shellcheck disable=SC2154
#
#   dgclaw atualizar --checar              roda a checagem agora (so le o GitHub; nao baixa nem instala nada)
#   dgclaw atualizar --aviso ligar|desligar troca a linha DGCLAW_AVISO_ATUALIZACAO do dgclaw.env e liga/desliga o timer
#   dgclaw status                           uma linha "atualizacao: ..." (aviso_atualizacao_status)

AVISO_UNIDADE_TIMER="dgclaw-checar-atualizacao.timer"
AVISO_UNIDADE_SERVICO="dgclaw-checar-atualizacao.service"

# aviso_limpa: tira caracteres de controle do que vai para o terminal (o estado guarda texto que nasceu no GitHub).
aviso_limpa() { tr -d '\000-\010\013-\037\177'; }

# aviso_com_trava <comando...>: roda o comando sob `flock` no .trava da pasta do estado, o mesmo arquivo que a
# unidade systemd usa. Assim checagem do timer, checagem manual e --aviso nunca se sobrepoem. Espera ate
# DGCLAW_AVISO_ESPERA_TRAVA segundos (padrao 90); sem conseguir, falha dizendo o que fazer. O .trava so existe:
# nunca e apagado nem trocado (trocar o arquivo no meio de uma checagem quebraria a trava).
aviso_com_trava() {
    local dir="$DG_LIB/web/atualizacao" espera="${DGCLAW_AVISO_ESPERA_TRAVA:-90}" rc=0
    local trava="$dir/.trava"
    install -d -m 700 "$dir"
    if [ ! -e "$trava" ]; then touch "$trava"; chmod 600 "$trava"; fi
    flock -w "$espera" -E 75 "$trava" "$@" || rc=$?
    if [ "$rc" -eq 75 ]; then
        falha "outra checagem de versao segurou a trava $trava por mais de ${espera}s." \
            "veja se ela travou (systemctl status $AVISO_UNIDADE_SERVICO; para parar: systemctl stop $AVISO_UNIDADE_SERVICO) e rode de novo."
    fi
    return "$rc"
}

# aviso_checar: roda scripts/checar-atualizacao.mjs agora, sob a trava. A saida e o codigo sao os dele.
aviso_checar() {
    local script="$APP_DIR/scripts/checar-atualizacao.mjs" rc=0
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] flock %s node %s\n' "$DG_LIB/web/atualizacao/.trava" "$script"
        return 0
    fi
    exigir_ferramentas node flock
    [ -f "$script" ] || falha "nao achei $script, entao nao ha como checar." \
        "reinstale o DG Claw (sudo ./install.sh --usuario <nome>); o instalador copia esse arquivo."
    aviso_com_trava node "$script" || rc=$?
    return "$rc"
}

# aviso_confere_estado <true|false>: so anuncia sucesso depois de ler, no estado gravado, que "desligado" e o esperado.
aviso_confere_estado() {
    local esperado="$1" arq="$DG_LIB/web/atualizacao/estado.json" atual
    [ "$ENSAIO" != 1 ] || return 0
    atual="$(jq -r '.desligado' "$arq" 2>/dev/null)" || atual=""
    [ "$atual" = "$esperado" ] && return 0
    falha "a linha do dgclaw.env e o timer ja foram trocados, mas o estado gravado em $arq ainda nao diz desligado=$esperado (veio: ${atual:-ilegivel})." \
        "rode de novo: sudo dgclaw atualizar --aviso $([ "$esperado" = true ] && echo desligar || echo ligar). Se repetir, veja /var/log/dgclaw/checar-atualizacao.log."
}

# aviso_definir <ligar|desligar>: troca SO a linha DGCLAW_AVISO_ATUALIZACAO (as outras ficam como estao),
# liga ou desliga o timer e SO ENTAO espera a trava e roda a checagem, que grava o estado novo. Uma checagem
# que ja estava rodando termina antes (a trava), e como ela releia o dgclaw.env antes de gravar, nao sobrescreve o
# "desligado". Sem o timer instalado (instalacao anterior ao aviso), a linha fica gravada e vale quando o
# instalador rodar.
aviso_definir() {
    local acao="$1" valor
    case "$acao" in
        ligar) valor=1 ;;
        desligar) valor=0 ;;
        *) falha "'--aviso $acao' nao existe." "use: dgclaw atualizar --aviso ligar   ou   dgclaw atualizar --aviso desligar" ;;
    esac
    [ -f "$DG_ETC/dgclaw.env" ] || falha "o DG Claw nao parece instalado aqui: falta $DG_ETC/dgclaw.env." \
        "instale primeiro: sudo ./install.sh --usuario <nome>"
    exigir_ferramentas jq
    definir_linha_env "$DG_ETC/dgclaw.env" DGCLAW_AVISO_ATUALIZACAO "$valor"
    if [ ! -f "$DG_UNITS/$AVISO_UNIDADE_TIMER" ]; then
        aviso "gravei DGCLAW_AVISO_ATUALIZACAO=$valor, mas o timer do aviso ainda nao esta instalado neste servidor. Rode sudo dgclaw atualizar (ou sudo ./install.sh) uma vez e ele passa a obedecer essa linha."
        return 0
    fi
    if [ "$acao" = ligar ]; then
        executar systemctl enable --now "$AVISO_UNIDADE_TIMER"
        aviso_checar || aviso "o aviso foi ligado, mas a checagem de agora falhou (veja a mensagem acima). O timer tenta de novo sozinho."
        aviso_confere_estado false
        ok "aviso de nova versao ligado: confere a cada 6 horas. Ver o resultado: dgclaw status"
    else
        executar systemctl disable --now "$AVISO_UNIDADE_TIMER"
        executar systemctl stop "$AVISO_UNIDADE_SERVICO"
        # Sem rede: com a linha em 0 a checagem so grava "desligado", e a faixa do painel some na hora.
        aviso_checar || aviso "a checagem que grava o estado 'desligado' saiu com erro (veja acima)."
        aviso_confere_estado true
        ok "aviso de nova versao desligado: o servidor nao consulta mais o GitHub. Para ligar: dgclaw atualizar --aviso ligar"
    fi
}

# aviso_atualizacao_main <argumentos de 'atualizar' que sao do aviso>
aviso_atualizacao_main() {
    local args=() a
    for a in "$@"; do
        if [ "$a" = --simular ]; then ENSAIO=1; else args+=("$a"); fi
    done
    set -- ${args[@]+"${args[@]}"}
    case "${1:-}" in
        --checar)
            [ $# -eq 1 ] || falha "'--checar' so aceita --simular junto (veio: $*)." "use: dgclaw atualizar --checar"
            aviso_checar ;;
        --aviso)
            [ $# -eq 2 ] || falha "'--aviso' precisa de ligar ou desligar." "use: dgclaw atualizar --aviso ligar   ou   dgclaw atualizar --aviso desligar"
            aviso_definir "$2" ;;
        *) falha "opcao do aviso desconhecida: ${1:-}" "veja as opcoes com: dgclaw --ajuda" ;;
    esac
}

# aviso_atualizacao_status: a linha "atualizacao: ..." do `dgclaw status`. Nunca derruba o status:
# problema para ler o estado vira aviso, nao falha (o aviso de versao nao e essencial).
aviso_atualizacao_status() {
    local arq="$DG_LIB/web/atualizacao/estado.json" saida disp motivo erro de para
    # O status ja carregou o dgclaw.env com `source`, que tira as aspas do valor.
    if [ "${DGCLAW_AVISO_ATUALIZACAO:-1}" = 0 ]; then
        s_ok "atualizacao: aviso desligado (para ligar: sudo dgclaw atualizar --aviso ligar)"
        return 0
    fi
    if [ ! -f "$arq" ]; then
        s_ok "atualizacao: ainda nao verificado (a primeira checagem sai logo depois da instalacao; para ver agora: sudo dgclaw atualizar --checar)"
        return 0
    fi
    if ! saida="$(jq -r '[(.disponivel // false), (.motivo // "-"), (.erro.motivo // "-"),
                          (.instalado.versao // (.instalado.commit // "?" | .[0:7])),
                          (.publicado.versao // (.publicado.commit // "?" | .[0:7]))] | @tsv' "$arq" 2>&1)"; then
        s_aviso "atualizacao: nao consegui ler $arq ($(printf '%s' "$saida" | head -n 1 | aviso_limpa)). Refaca com: sudo dgclaw atualizar --checar"
        return 0
    fi
    # "-" marca campo vazio: o read junta tabs seguidos e deslocaria os campos.
    IFS=$'\t' read -r disp motivo erro de para <<<"$saida"
    [ "$motivo" != "-" ] || motivo=""
    [ "$erro" != "-" ] || erro=""
    de="$(printf '%s' "$de" | aviso_limpa)"; para="$(printf '%s' "$para" | aviso_limpa)"
    if [ "$disp" = true ]; then
        s_aviso "atualizacao: versao nova disponivel ($de → $para), rode: sudo dgclaw atualizar"
    elif [ -n "$motivo" ]; then
        case "$motivo" in
            instalacao-fora-do-github) s_ok "atualizacao: sem como comparar (esta instalacao veio de um commit que nao esta no GitHub oficial)" ;;
            instalacao-a-frente-da-branch|instalacao-divergente-da-branch) s_ok "atualizacao: sem aviso (esta instalacao nao e uma versao anterior da branch oficial)" ;;
            *) s_ok "atualizacao: sem aviso ($(printf '%s' "$motivo" | aviso_limpa))" ;;
        esac
    elif [ -z "$erro" ]; then
        s_ok "atualizacao: em dia"
    fi
    if [ -n "$erro" ]; then
        s_aviso "atualizacao: a ultima checagem falhou: $(printf '%s' "$erro" | aviso_limpa)"
    fi
}
