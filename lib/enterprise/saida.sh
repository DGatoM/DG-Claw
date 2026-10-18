#!/usr/bin/env bash
# lib/enterprise/saida.sh: saida controlada para a internet (protecao `saida`, bloco H): `dgclaw saida ...`.
#
# O proxy mora em saida/ (Node, sem dependencia) e roda como o servico dgclaw-saida, sem privilegio. Aqui ficam:
# o gancho que poe o proxy no ambiente do agente, a sincronizacao do geral.json que o proxy le (ele nao pode ler o
# protecoes.json, que e 600 do root), a unidade do systemd, os comandos e a auditoria. A cerca de rede esta em
# firewall-saida.sh. Detalhes e o que so se prova numa VPS real: docs/enterprise/SAIDA.md.
#
# Nivel pessoal (saida = livre): nada daqui age. Precisa de lib/comum.sh, lib/protecoes.sh e lib/agentes.sh.

_SAI_USUARIO="dgclaw-saida"
_SAI_UNIDADE="dgclaw-saida"
_SAI_PORTA=3128
_SAI_SLUG_RX='^[a-z0-9][a-z0-9-]{1,30}$'

_sai_dir() { printf '%s/saida' "$DG_ETC"; }
_sai_log() { printf '%s/saida' "$DG_LOG"; }

_sai_cli() {
    local acao="$1"; shift
    command -v node >/dev/null 2>&1 || falha "o node nao foi encontrado nesta maquina." "o instalador do DG Claw instala o Node 22; rode-o de novo ou instale com: apt-get install -y nodejs"
    node "${APP_DIR:?}/saida/cli.js" "$acao" "$@" --etc "$DG_ETC" --log "$(_sai_log)" --base "$APP_DIR/config/saida-base.json"
}

# saida_agentes: "slug n" de cada agente que existe (esta no registro e tem casa). DGCLAW_SAIDA_EXCLUIR tira um da lista
# (o `agente remover` chama o gancho antes de a casa sair do lugar).
saida_agentes() {
    local slug uid n
    [ -f "$DG_REGISTRO" ] || return 0
    while IFS=$'\t' read -r slug uid n || [ -n "$slug" ]; do
        [[ "$slug" =~ $_SAI_SLUG_RX ]] || continue
        [[ "${n:-}" =~ ^[0-9]+$ ]] || continue
        [ "$slug" != "${DGCLAW_SAIDA_EXCLUIR:-}" ] || continue
        [ -d "$DG_LIB/agentes/$slug" ] || continue
        printf '%s %s\n' "$slug" "$n"
    done <"$DG_REGISTRO"
}

saida_numero() { awk -F'\t' -v s="$1" '$1 == s {print $3; exit}' "$DG_REGISTRO" 2>/dev/null; }

# saida_modo_agente <slug>: o modo que vale. O da matriz, ou o do agente se for mais firme (nunca mais solto).
saida_modo_agente() {
    local slug="$1" geral ag="" arq
    geral="$(protecao_valor saida)" || return 1
    if [ "$geral" = livre ]; then printf 'livre'; return 0; fi
    arq="$(_sai_dir)/$slug.json"
    if [ -s "$arq" ]; then
        ag="$(jq -r '.modo // empty' "$arq" 2>/dev/null)" || {
            aviso "${arq#"$R"} nao e um JSON valido; ignorei o modo proprio do agente $slug e vale o da instalacao ($geral). Corrija ou apague o arquivo."
            ag=""
        }
    fi
    case "$ag" in
        bloqueio) printf 'bloqueio' ;;
        registro) if [ "$geral" = bloqueio ]; then printf 'bloqueio'; else printf 'registro'; fi ;;
        *) printf '%s' "$geral" ;;
    esac
}

# _sai_pastas: a pasta de config (2750 root:dgclaw-saida) e a do registro (750 dgclaw-saida).
_sai_pastas() {
    local gid uid
    executar install -d -m 2750 "$(_sai_dir)"
    executar install -d -m 750 "$(_sai_log)"
    gid="$(getent group "$_SAI_USUARIO" 2>/dev/null | cut -d: -f3)" || gid=""
    uid="$(getent passwd "$_SAI_USUARIO" 2>/dev/null | cut -d: -f3)" || uid=""
    if [ -n "$gid" ] && [ -n "$uid" ]; then
        dono "0:$gid" "$(_sai_dir)"
        dono "$uid:$gid" "$(_sai_log)"
    elif [ -z "$R" ] && [ "$ENSAIO" != 1 ]; then
        aviso "o usuario $_SAI_USUARIO ainda nao existe, entao o proxy nao conseguira ler ${DG_ETC#"$R"}/saida. Rode: dgclaw protecoes aplicar"
    fi
}

# saida_sincronizar: grava o geral.json (modo da instalacao, retencao e os agentes com numero e provedor) que o proxy le.
# Em `livre` so reescreve se o arquivo ja existe (para o proxy fechar o que tinha aberto); senao nao cria nada.
saida_sincronizar() {
    local modo dias linhas slug n prov
    modo="$(protecao_valor saida)" || return 1
    if [ "$modo" = livre ] && [ ! -e "$(_sai_dir)/geral.json" ]; then return 0; fi
    dias="$(protecao_valor retencao_dias)" || return 1
    linhas=""
    if [ "$modo" != livre ]; then
        while read -r slug n; do
            [ -n "$slug" ] || continue
            prov="$(agentes_obter "$slug" | jq -r '.provedor // empty')" || prov=""
            if [ -z "$prov" ] && [ "$slug" = "${C_SLUG:-}" ]; then prov="${C_PROVEDOR:-}"; fi
            linhas+="$slug"$'\t'"$n"$'\t'"${prov:-claude}"$'\n'
        done < <(saida_agentes)
    fi
    _sai_pastas
    # shellcheck disable=SC2016 # $m e $d sao variaveis do jq
    printf '%s' "$linhas" | jq -Rn --arg m "$modo" --argjson d "$dias" \
        '{versao: 1, modo: $m, retencao_dias: $d,
          agentes: ([inputs | select(length > 0) | split("\t") | {key: .[0], value: {n: (.[1] | tonumber), provedor: .[2]}}] | from_entries)}' \
        | escrever_arquivo "$(_sai_dir)/geral.json" 640
}

# _sai_aplicar_cerca: reaplica a cerca (lib/enterprise/firewall-saida.sh). Em raiz falsa nao toca no iptables, a menos
# que o teste traga o proprio comando em DGCLAW_FIREWALL_SAIDA_CMD.
_sai_aplicar_cerca() {
    if [ -n "${DGCLAW_FIREWALL_SAIDA_CMD:-}" ]; then
        executar bash -c "$DGCLAW_FIREWALL_SAIDA_CMD"
    elif [ -n "$R" ]; then
        info "raiz falsa em uso (DGCLAW_RAIZ): cerca da saida controlada nao aplicada"
    else
        executar bash "${APP_DIR:?}/lib/enterprise/firewall-saida.sh"
        ok "cerca da saida controlada aplicada"
    fi
}

# --- ganchos --------------------------------------------------------------------------------------------

# O container recebe o proxy no ambiente. O --http-proxy=false do bin/dgclaw continua (ele cuida do proxy do HOST);
# estas variaveis sao explicitas e apontam para o proxy do DG Claw no gateway da rede do agente.
ent_args_container_saida() {
    local -n _ent_sai_args="$1"
    local slug="$2" modo n url v
    modo="$(saida_modo_agente "$slug")" || return 1
    [ "$modo" != livre ] || return 0
    n="$(saida_numero "$slug")"
    [ -n "$n" ] || n="${C_N:-}"
    [[ "$n" =~ ^[0-9]+$ ]] || falha "nao achei o numero de rede do agente $slug em ${DG_REGISTRO#"$R"}, e sem ele nao sei o endereco do proxy." \
        "rode de novo o mesmo comando; se repetir, confira o arquivo com: cat ${DG_REGISTRO#"$R"}"
    url="http://10.89.$n.1:$_SAI_PORTA"
    for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do _ent_sai_args+=(--env "$v=$url"); done
    for v in NO_PROXY no_proxy; do _ent_sai_args+=(--env "$v=localhost,127.0.0.1,::1"); done
}

# Antes de o container ligar o proxy ja precisa conhecer o agente: o teste de isolamento do `agente criar` passa por ele.
ent_antes_de_iniciar_saida() {
    [ "$(protecao_valor saida)" != livre ] || return 0
    saida_sincronizar
}

ent_depois_de_remover_saida() {
    local slug="$1"
    [ -e "$(_sai_dir)/geral.json" ] || return 0
    DGCLAW_SAIDA_EXCLUIR="$slug" saida_sincronizar
    DGCLAW_SAIDA_EXCLUIR="$slug" _sai_aplicar_cerca
}

# sai_proxy_esperado <slug>: 0 quando o proxy do DG Claw e esperado no ambiente do agente (conferir_saida_internet).
ent_saida_proxy_esperado() { [ "$(saida_modo_agente "$1")" != livre ]; }

# Prova da saida controlada de dentro do container, no `agente criar`. Falhou, o agente para (rodar_isolamento).
ent_saida_testar() {
    local slug="$1" cmd modo prov
    modo="$(saida_modo_agente "$slug")" || return 1
    [ "$modo" != livre ] || return 0
    if [ -n "${DGCLAW_SAIDA_TESTE_CMD:-}" ]; then
        cmd="$DGCLAW_SAIDA_TESTE_CMD"
    elif [ -n "$R" ]; then
        info "raiz falsa em uso (DGCLAW_RAIZ): teste da saida controlada nao executado"
        return 0
    else
        cmd="bash $APP_DIR/scripts/enterprise/teste-saida.sh"
    fi
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] rodaria o teste da saida controlada ($modo): $cmd $slug"; return 0; fi
    prov="$(agentes_obter "$slug" | jq -r '.provedor // empty')" || prov=""
    if [ -z "$prov" ] && [ "$slug" = "${C_SLUG:-}" ]; then prov="${C_PROVEDOR:-}"; fi
    bash -c "$cmd \"\$1\" \"\$2\" \"\$3\"" _ "$slug" "$modo" "${prov:-claude}"
}

# _sai_defasado <slug>: 0 (e diz) se o container existe e nao tem o proxy no ambiente.
_sai_defasado() {
    local c="dgclaw-$1"
    podman container exists "$c" >/dev/null 2>&1 || return 1
    podman inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null | grep -q '^HTTPS_PROXY=' && return 1
    return 0
}

_sai_avisar_defasados() {
    local slug n
    while read -r slug n; do
        [ -n "$slug" ] || continue
        if [ "$(saida_modo_agente "$slug")" != livre ] && _sai_defasado "$slug"; then
            aviso "o container do agente $slug foi criado antes da saida controlada e esta sem o proxy no ambiente (no bloqueio ele fica sem internet). Para recriar (a casa fica): dgclaw agente recriar $slug --sim"
        fi
    done < <(saida_agentes)
}

# --- servico --------------------------------------------------------------------------------------------

_sai_escrever_unidade() {
    escrever_arquivo "$DG_UNITS/$_SAI_UNIDADE.service" 644 <<FIM
[Unit]
Description=DG Claw: proxy de saida dos agentes
Documentation=file:/opt/dgclaw/app/docs/enterprise/SAIDA.md
After=network-online.target podman.service
Wants=network-online.target

[Service]
User=$_SAI_USUARIO
Group=$_SAI_USUARIO
ExecStart=/usr/bin/node /opt/dgclaw/app/saida/servidor.js
Environment=DGCLAW_ETC=/etc/dgclaw
Environment=DGCLAW_LOG_SAIDA=/opt/dgclaw/saida-log
Restart=always
RestartSec=3
UMask=0027
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
BindPaths=/var/log/dgclaw/saida:/opt/dgclaw/saida-log
ReadOnlyPaths=/etc/dgclaw/saida /opt/dgclaw/app

[Install]
WantedBy=multi-user.target
FIM
}

# _sai_servico: liga (ou desliga) o servico conforme `saida`. Idempotente.
_sai_servico() {
    local modo
    modo="$(protecao_valor saida)" || return 1
    if [ "$modo" != livre ]; then
        if ! getent passwd "$_SAI_USUARIO" >/dev/null 2>&1; then
            executar useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$_SAI_USUARIO"
        fi
        # O ponto de montagem do registro (a unidade o espelha para dentro do servico, que nao atravessa /var/log/dgclaw).
        executar install -d -m 755 "${DG_OPT}/saida-log"
        _sai_pastas
        saida_sincronizar
        _sai_escrever_unidade
        executar systemctl daemon-reload
        executar systemctl enable "$_SAI_UNIDADE.service"
        executar systemctl restart "$_SAI_UNIDADE.service"
        ok "saida controlada em modo $modo: proxy $_SAI_UNIDADE ligado (porta $_SAI_PORTA no gateway de cada agente)"
    elif [ -e "$DG_UNITS/$_SAI_UNIDADE.service" ]; then
        saida_sincronizar
        executar systemctl disable --now "$_SAI_UNIDADE.service"
        executar rm -f "$DG_UNITS/$_SAI_UNIDADE.service"
        executar systemctl daemon-reload
        info "saida = livre: proxy $_SAI_UNIDADE desligado e unidade removida (o registro em ${DG_LOG#"$R"}/saida fica ate a retencao)."
    else
        saida_sincronizar
    fi
    _sai_aplicar_cerca
    [ "$modo" = livre ] || _sai_avisar_defasados
}

ent_instalar_saida() { _sai_servico; }
ent_aplicar_saida() { _sai_servico; }

ent_status_saida() {
    local modo slug n
    modo="$(protecao_valor saida)" || return 0
    [ "$modo" != livre ] || return 0
    if [ "$(systemctl is-active "$_SAI_UNIDADE.service" 2>/dev/null)" = active ]; then
        s_ok "saida controlada: modo $modo, proxy $_SAI_UNIDADE ativo"
    else
        s_mal "saida controlada em modo $modo, mas o proxy $_SAI_UNIDADE nao esta ativo (os agentes ficam sem internet no bloqueio). Veja: journalctl -u $_SAI_UNIDADE -n 30; religue com: dgclaw protecoes aplicar"
    fi
    while read -r slug n; do
        [ -n "$slug" ] || continue
        if [ "$(saida_modo_agente "$slug")" != livre ] && _sai_defasado "$slug"; then
            s_aviso "agente $slug: container criado antes da saida controlada, sem o proxy no ambiente (dgclaw agente recriar $slug --sim)"
        fi
    done < <(saida_agentes)
}

# --- comandos -------------------------------------------------------------------------------------------

_sai_exigir_ligada() {
    [ "$(protecao_valor saida)" != livre ] && return 0
    falha "a saida dos agentes esta livre (nivel $(protecao_nivel)), entao nao ha lista nem registro para mexer." \
        "suba o nivel (dgclaw nivel definir escritorio) ou ligue so a saida (dgclaw nivel ajustar saida registro) e depois rode: dgclaw protecoes aplicar"
}

_sai_resumo() {
    local modo slug n
    modo="$(protecao_valor saida)" || return 1
    printf 'Saida dos agentes para a internet: %s (nivel %s)\n' "$modo" "$(protecao_nivel)"
    if [ "$modo" = livre ]; then
        printf '  Nada e controlado nem anotado. Para ligar: dgclaw nivel ajustar saida registro\n'
        return 0
    fi
    while read -r slug n; do
        [ -n "$slug" ] || continue
        printf '  %s: %s\n' "$slug" "$(saida_modo_agente "$slug")"
    done < <(saida_agentes)
    printf 'Detalhes de um agente: dgclaw saida mostrar <agente>\n'
}

ent_cmd_saida() {
    local sub="${1:-}" slug
    if [ "$#" -gt 0 ]; then shift; fi
    exigir_ferramentas jq
    case "$sub" in
        ""|resumo) _sai_resumo ;;
        mostrar|relatorio)
            slug="${1:-}"
            [ -n "$slug" ] || falha "faltou o nome do agente." "use: dgclaw saida $sub <agente>"
            _sai_exigir_ligada
            saida_sincronizar
            _sai_cli "$sub" "$@" ;;
        permitir|remover)
            [ "$#" -eq 2 ] || falha "faltou o agente ou o dominio." "use: dgclaw saida $sub <agente> <dominio>   (exemplo: dgclaw saida permitir ana '*.empresa.com.br')"
            _sai_exigir_ligada
            saida_sincronizar
            _sai_cli "$sub" "$@" || return $?
            auditar_aviso "saida.$sub" "$(jq -nc --arg s "$1" --arg d "$2" '{slug: $s, dominio: $d}')" ;;
        modo)
            [ "$#" -eq 2 ] || falha "faltou o agente ou o modo." "use: dgclaw saida modo <agente> <registro|bloqueio>"
            _sai_exigir_ligada
            saida_sincronizar
            _sai_cli modo "$@" || return $?
            _sai_aplicar_cerca
            auditar_aviso saida.modo "$(jq -nc --arg s "$1" --arg m "$2" '{slug: $s, modo: $m}')"
            if [ "$2" = bloqueio ]; then
                info "Antes de confiar no bloqueio, confira o que o agente usa: dgclaw saida relatorio $1"
            fi ;;
        sincronizar)
            saida_sincronizar
            _sai_aplicar_cerca ;;
        *) falha "o subcomando 'saida ${sub}' nao existe." "use: dgclaw saida [mostrar <agente> | permitir <agente> <dominio> | remover <agente> <dominio> | modo <agente> <modo> | relatorio <agente> [--dias N]]" ;;
    esac
}
