#!/usr/bin/env bash
# lib/enterprise/retencao.sh: retencao de dados (`dgclaw retencao`) e exclusao por titular (`dgclaw titular`).
#
# O trabalho pesado (varrer transcripts, bancos, anexos e logs) e do Python 3 da biblioteca padrao:
# scripts/enterprise/retencao.py e titular.py. Aqui ficam os comandos, a leitura da protecao
# `retencao_dias`, a auditoria, o timer diario e o logrotate.
#
# Inventario do que existe e de como cada coisa e tratada: docs/enterprise/DADOS-PESSOAIS.md.
# Precisa de lib/comum.sh, lib/protecoes.sh e lib/enterprise/auditoria.sh carregados antes.

_RET_UNIDADE="dgclaw-retencao"
_RET_LOGROTATE_ARQ="$R/etc/logrotate.d/dgclaw-enterprise"

_ret_script() { printf '%s/scripts/enterprise/%s' "${APP_DIR:?}" "$1"; }

# _ret_exigir_python <script>: o python3 e o script precisam existir; senao diz o que fazer.
_ret_exigir_python() {
    local s
    s="$(_ret_script "$1")"
    command -v python3 >/dev/null 2>&1 \
        || falha "o python3 nao foi encontrado nesta maquina." "instale com: apt-get install -y python3 (o instalador do DG Claw ja faz isso)."
    [ -f "$s" ] || falha "nao achei $s." "reinstale o DG Claw para recolocar a pasta scripts/enterprise/."
}

# --- retencao ---------------------------------------------------------------------------------------
_ret_aplicar() {
    local agente="" dias resumo rc=0 args
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --agente) [ "$#" -ge 2 ] || falha "faltou o nome do agente depois de --agente." "use: dgclaw retencao aplicar --agente <slug>"
                      agente="$2"; shift 2 ;;
            *) falha "a opcao '$1' nao existe em 'retencao aplicar'." "use: dgclaw retencao aplicar [--agente <slug>] [--ensaio]" ;;
        esac
    done
    dias="$(protecao_valor retencao_dias)" || return 1
    if [ "$dias" -eq 0 ]; then
        info "retencao desligada (retencao_dias = 0, sem prazo): nada a fazer. Para ligar: dgclaw nivel ajustar retencao_dias <dias>"
        return 0
    fi
    _ret_exigir_python retencao.py
    resumo="$(mktemp)"
    args=(--agentes-json "$DG_AGENTES_JSON" --dias "$dias" --resumo-json "$resumo")
    if [ -n "$agente" ]; then args+=(--agente "$agente"); else args+=(--log-dir "$DG_LOG" --web-data "${DGCLAW_WEB_DATA:-$DG_LIB/web}"); fi
    if [ "$ENSAIO" = 1 ]; then args+=(--ensaio); fi
    python3 "$(_ret_script retencao.py)" "${args[@]}" || rc=$?
    if [ "$ENSAIO" != 1 ] && [ -s "$resumo" ]; then
        auditar_aviso retencao_aplicada "$(jq -c --arg a "$agente" '. + {agente: $a} | del(.pulados, .erros) + {pulados: (.pulados|length), erros: (.erros|length)}' "$resumo" 2>/dev/null || jq -nc --arg d "$dias" '{dias: ($d|tonumber), observacao: "resumo ilegivel"}')"
    fi
    rm -f "$resumo"
    if [ "$rc" -ne 0 ]; then
        printf 'O que fazer: leia as linhas "Nao deu certo" acima; o que nao falhou foi aplicado. Corrija a causa e rode de novo: dgclaw retencao aplicar\n' >&2
    fi
    return "$rc"
}

ent_cmd_retencao() {
    local sub="${1:-}"
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        aplicar) _ret_aplicar "$@" ;;
        *) falha "o subcomando 'retencao ${sub}' nao existe." "use: dgclaw retencao aplicar [--agente <slug>] [--ensaio]" ;;
    esac
}

# --- exclusao por titular ------------------------------------------------------------------------
_tit_rodar() {
    local acao="$1" termos=() agente="" confirmar=0 apagar_anexos=0 backup=0 resumo rc=0 args
    shift
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --termo) [ "$#" -ge 2 ] || falha "faltou o termo depois de --termo." "use: dgclaw titular $acao \"Maria Souza\" --termo 123.456.789-01"
                     termos+=("$2"); shift 2 ;;
            --agente) [ "$#" -ge 2 ] || falha "faltou o nome do agente depois de --agente." "use: dgclaw titular $acao ... --agente <slug>"
                      agente="$2"; shift 2 ;;
            --confirmar) confirmar=1; shift ;;
            --apagar-anexos) apagar_anexos=1; shift ;;
            --*) falha "a opcao '$1' nao existe em 'titular $acao'." "use: dgclaw titular buscar <termo> [--termo <outro>] [--agente <slug>]  |  dgclaw titular apagar <termo> ... --confirmar [--apagar-anexos]" ;;
            *) termos+=("$1"); shift ;;
        esac
    done
    [ "${#termos[@]}" -gt 0 ] || falha "faltou o termo a procurar (nome, CPF, e-mail ou telefone)." "use: dgclaw titular $acao \"Maria Souza\" --termo 123.456.789-01"
    if [ "$acao" = apagar ] && [ "$confirmar" != 1 ] && [ "$ENSAIO" != 1 ]; then
        falha "apagar por titular nao se desfaz e voce nao mandou --confirmar." "confira antes o que sera apagado com: dgclaw titular buscar <termo>; depois repita o comando de apagar com --confirmar."
    fi
    _ret_exigir_python titular.py
    if protecao_ligada backup; then backup="$(protecao_valor backup_retencao_dias)" || return 1; fi
    # No ensaio, apagar vira busca: mostra o que seria apagado sem mexer em nada.
    local acao_py="$acao"
    if [ "$ENSAIO" = 1 ]; then acao_py=buscar; info "[ensaio] mostrando so o que seria apagado; nada sera alterado."; fi
    resumo="$(mktemp)"
    args=("$acao_py" --termos-stdin --agentes-json "$DG_AGENTES_JSON" --recibos-dir "$DG_LIB/titulares"
          --web-data "${DGCLAW_WEB_DATA:-$DG_LIB/web}" --log-dir "$DG_LOG" --auditoria "$DG_LOG/auditoria.jsonl"
          --backup-dias "$backup" --resumo-json "$resumo")
    if [ -n "$agente" ]; then args+=(--agente "$agente"); fi
    if [ "$apagar_anexos" = 1 ]; then args+=(--apagar-anexos); fi
    # Os termos vao por stdin: dado pessoal nao precisa aparecer duas vezes na lista de processos.
    printf '%s\n' "${termos[@]}" | python3 "$(_ret_script titular.py)" "${args[@]}" || rc=$?
    if [ "$acao_py" = apagar ] && [ -s "$resumo" ]; then
        auditar_aviso titular_apagado "$(jq -c '{hash: .hash, ocorrencias: .ocorrencias, pendencias: .pendencias, agentes: .agentes, erros: .erros}' "$resumo")"
    fi
    rm -f "$resumo"
    case "$rc" in
        0) ;;
        2) printf 'Parte do pedido ficou pendente (linhas "pendente" acima), por isso o codigo de saida e 2. Resolva cada uma e repita o comando: ele so mexe no que ainda tiver o termo.\n' >&2 ;;
        *) printf 'O que fazer: leia as linhas "Nao deu certo" acima, corrija a causa e repita o comando.\n' >&2 ;;
    esac
    return "$rc"
}

ent_cmd_titular() {
    local sub="${1:-}"
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        buscar|apagar) _tit_rodar "$sub" "$@" ;;
        *) falha "o subcomando 'titular ${sub}' nao existe." "use: dgclaw titular buscar <termo> [--termo <outro>] [--agente <slug>]  |  dgclaw titular apagar <termo> ... --confirmar [--apagar-anexos]" ;;
    esac
}

# --- timer diario e logrotate ---------------------------------------------------------------------
_ret_escrever_unidades() {
    local bin="${DG_BIN#"$R"}/dgclaw"
    escrever_arquivo "$DG_UNITS/$_RET_UNIDADE.service" 644 <<FIM
[Unit]
Description=DG Claw: aplica o prazo de retencao dos dados
Documentation=file:${DG_APP#"$R"}/docs/enterprise/DADOS-PESSOAIS.md

[Service]
Type=oneshot
ExecStart=$bin retencao aplicar
Nice=10
IOSchedulingClass=idle
FIM
    escrever_arquivo "$DG_UNITS/$_RET_UNIDADE.timer" 644 <<FIM
[Unit]
Description=DG Claw: retencao de dados, todo dia de madrugada

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
FIM
}

# _ret_escrever_logrotate <dias>: o log do runner de cada agente cresce sem limite e ele nao entra na
# varredura por idade (o arquivo e modificado o tempo todo); o logrotate corta por dia e apaga o velho.
_ret_escrever_logrotate() {
    local dias="$1" log="${DG_LOG#"$R"}" casas="${DG_LIB#"$R"}/agentes"
    escrever_arquivo "$_RET_LOGROTATE_ARQ" 644 <<FIM
# Gerado pelo DG Claw (lib/enterprise/retencao.sh). Mesmo prazo de retencao_dias = $dias.
# A trilha de auditoria ($log/auditoria.jsonl) nao entra: ela nao termina em .log e nunca e apagada por idade.
$log/*.log $casas/*/home/.dgclaw/logs/*.log {
    daily
    rotate $dias
    maxage $dias
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
}
FIM
}

# _ret_sincronizar: liga (ou desliga) o timer e o logrotate conforme retencao_dias. Idempotente.
_ret_sincronizar() {
    local dias
    dias="$(protecao_valor retencao_dias)" || return 1
    if [ "$dias" -gt 0 ]; then
        _ret_escrever_unidades
        _ret_escrever_logrotate "$dias"
        executar systemctl daemon-reload
        executar systemctl enable --now "$_RET_UNIDADE.timer"
        ok "retencao de $dias dia(s): timer diario $_RET_UNIDADE.timer e logrotate instalados"
    elif [ -e "$DG_UNITS/$_RET_UNIDADE.timer" ] || [ -e "$_RET_LOGROTATE_ARQ" ]; then
        executar systemctl disable --now "$_RET_UNIDADE.timer"
        executar rm -f "$DG_UNITS/$_RET_UNIDADE.timer" "$DG_UNITS/$_RET_UNIDADE.service" "$_RET_LOGROTATE_ARQ"
        executar systemctl daemon-reload
        info "retencao_dias = 0: timer e logrotate de retencao removidos."
    fi
}

ent_instalar_retencao() { _ret_sincronizar; }
ent_aplicar_retencao() { _ret_sincronizar; }

ent_status_retencao() {
    protecao_ligada retencao_dias || return 0
    if [ "$(systemctl is-active "$_RET_UNIDADE.timer" 2>/dev/null)" = active ]; then
        s_ok "retencao: $(protecao_valor retencao_dias) dia(s), timer diario ativo"
    else
        s_aviso "retencao: $(protecao_valor retencao_dias) dia(s), mas o timer $_RET_UNIDADE.timer nao esta ativo. Rode: dgclaw protecoes aplicar"
    fi
}
