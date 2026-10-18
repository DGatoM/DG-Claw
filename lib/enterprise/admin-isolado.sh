#!/usr/bin/env bash
# lib/enterprise/admin-isolado.sh: bloco C, o Admin sem root no host (protecao `admin_isolado`).
#
# Hoje o Admin e um Claude Code como root no host, em bypassPermissions, que roda `sudo dgclaw ...` no shell. Uma
# instrucao escondida num log ou documento colado no chat vira root no servidor. Com `admin_isolado`:
#   - o Admin passa a ser um agente em container, igual aos outros, e so faz PEDIDOS ao servico de controle
#     (controle/servidor.js), que e deterministico, sem LLM, e tem uma lista fechada de operacoes;
#   - o que e perigoso espera um humano aprovar no painel (web/lib/ent/aprovacoes.js).
# Detalhes, operacoes e fluxos: docs/enterprise/CONTROLE.md.
#
# Comandos:
#   dgclaw admin isolar                  cria o Admin em container, desliga o Admin do host (reversivel)
#   dgclaw admin host                    volta ao modo antigo (so onde a protecao nao e travada)
#   dgclaw admin status                  em que modo esta, e se ha manutencao aberta
#   dgclaw admin manutencao abrir <5-60> [--por quem]   liga o Admin antigo (root) por N minutos
#   dgclaw admin manutencao fechar [--auto]             fecha antes do prazo (o prazo fecha sozinho)
#   dgclaw admin manutencao status
#
# Ganchos: ent_instalar_admin_isolado (instalador), ent_aplicar_admin_isolado (`protecoes aplicar`),
# ent_depois_de_criar_admin_isolado (identidade do novo Admin), ent_status_admin (`dgclaw status`).
# Precisa de lib/comum.sh, lib/agentes.sh, lib/protecoes.sh e lib/enterprise/auditoria.sh.

_ADM_UNID_HOST="dgclaw-admin.service"
_ADM_UNID_MANUT="dgclaw-admin-manutencao.service"
_ADM_UNID_CONTROLE="dgclaw-controle.service"
_ADM_TIMER_FECHA="dgclaw-admin-manutencao-fecha"
_ADM_SLUG_MANUT="admin-manutencao"

# Cópia do registro do Admin do host (agentes.json), guardada para `admin host` e para a manutencao.
_adm_backup() { printf '%s/admin-host.json' "$DG_ETC"; }
# Estado da manutencao aberta; o Web le este arquivo para o aviso no topo do chat (web/lib/ent/controle-rotas.js).
_adm_estado_manutencao() { printf '%s/web/controle/manutencao.json' "$DG_LIB"; }
_adm_cli() { printf '%s' "${DGCLAW_BIN_CLI:-$DG_BIN/dgclaw}"; }

# O `agente criar` consulta isto para saber que esta criando o Admin (slug reservado, tipo e papel no registro).
ent_admin_criando() { [ "${DGCLAW_CRIANDO_ADMIN:-}" = 1 ]; }

# _adm_isolado_agora: o Admin registrado e o de container? (o registro do container tem o campo `container`)
_adm_isolado_agora() {
    local obj
    [ -s "$DG_AGENTES_JSON" ] || return 1
    obj="$(agentes_obter admin 2>/dev/null)" || return 1
    [ -n "$obj" ] && [ -n "$(jq -r '.container // empty' <<<"$obj")" ]
}

# ent_admin_unidades: o servico que mantem o Admin de pe (`dgclaw status`, monitor, atualizar): o controle quando o Admin
# ja esta em container, o proprio dgclaw-admin enquanto ele ainda roda no host (inclusive com a protecao ligada e o
# isolar ainda por fazer; nesse caso o `dgclaw status` avisa por ent_status_admin).
ent_admin_unidades() {
    if _adm_isolado_agora; then printf 'dgclaw-controle'; else printf 'dgclaw-admin'; fi
}

# ent_admin_porta: a porta do runner do Admin (4300 no host; a do container, depois de isolar).
ent_admin_porta() {
    local runner=""
    if [ -s "$DG_AGENTES_JSON" ]; then runner="$(agentes_obter admin 2>/dev/null | jq -r '.runner // empty' 2>/dev/null)" || runner=""; fi
    runner="${runner##*:}"
    if [[ "$runner" =~ ^[0-9]+$ ]]; then printf '%s' "$runner"; else printf '4300'; fi
}

# _adm_escrever <arquivo> <modo>: grava o STDIN se mudou. Devolve 0 se gravou, 1 se ja estava igual.
_adm_escrever() {
    local alvo="$1" modo="$2" novo
    novo="$(cat)"
    if [ -f "$alvo" ] && [ "$(cat "$alvo")" = "$novo" ]; then return 1; fi
    printf '%s\n' "$novo" | escrever_arquivo "$alvo" "$modo"
    return 0
}

# ---------------------------------------------------------------------------------------------------------------
# Unidades do systemd
# ---------------------------------------------------------------------------------------------------------------

# O controle roda como root e chama o dgclaw (podman, firewall, Caddy). Por isso o endurecimento e curto: cada linha
# abaixo foi escolhida porque NAO atrapalha o podman, e as que atrapalhariam ficam de fora, com o motivo.
#   PrivateTmp=yes            /tmp proprio: o que os comandos filhos deixam la nao e visto por outros servicos.
#   ProtectHome=read-only     /home e /root so para leitura: o controle nunca grava na casa de ninguem (as casas dos
#                             agentes ficam em /var/lib/dgclaw, nao em /home).
#   ProtectKernelTunables=yes /proc/sys e /sys somente leitura para o controle. O podman rootful cria containers pelo
#                             runc, que ajusta o kernel por dentro do namespace do container, nao por este mount.
#   ProtectControlGroups=no   de proposito: o podman cria cgroups para cada container; negar isto quebra `podman start`.
#   UMask=0077                arquivo que o controle cria nasce 600.
# FICAM DE FORA, porque filtros de seguranca (seccomp, capabilities, no_new_privs) sao herdados pelos filhos e pelos
# containers que o controle inicia, e quebrariam o sudo dentro dos agentes (armadilha 2 do DESENHO), o apt e o runc:
#   NoNewPrivileges, CapabilityBoundingSet, SystemCallFilter, RestrictSUIDSGID, RestrictNamespaces, RestrictRealtime,
#   LockPersonality, MemoryDenyWriteExecute, ProtectKernelModules, ProtectClock.
# ProtectSystem tambem fica de fora: o `dgclaw` grava em /etc/dgclaw, /etc/caddy, /etc/systemd/system e /var; a lista de
# ReadWritePaths ficaria grande e fragil. TESTE MANUAL: subir, criar e remover um agente, trocar o dominio.
_adm_unidade_controle() {
    cat <<'FIM'
[Unit]
Description=DG Claw Controle (servico deterministico, sem IA, que executa a lista fechada de operacoes do Admin)
After=network-online.target podman.service
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=DGCLAW_CONTROLE_SOCK=/run/dgclaw/controle.sock
Environment=DGCLAW_BIN=/usr/local/bin/dgclaw
Environment=DGCLAW_AGENTES=/etc/dgclaw/agentes.json
Environment=DGCLAW_WEB_DATA=/var/lib/dgclaw/web
Environment=DGCLAW_PROTECOES=/etc/dgclaw/protecoes.json
Environment=DGCLAW_AUDITORIA=/var/log/dgclaw/auditoria.jsonl
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/node /opt/dgclaw/app/controle/servidor.js
Restart=always
RestartSec=3
PrivateTmp=yes
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectControlGroups=no
UMask=0077

[Install]
WantedBy=multi-user.target
FIM
}

# O Admin antigo (root no host), mas so sob demanda: nao e habilitado no boot e quem o liga e a manutencao de emergencia.
_adm_unidade_manutencao() {
    cat <<'FIM'
[Unit]
Description=DG Claw Admin em manutencao de emergencia (root no servidor; fecha sozinho, ver dgclaw admin manutencao)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/dgclaw/app/runner
Environment=HOME=/root RUNNER_AGENT_FILE=/opt/dgclaw/admin/.plataforma/runner.json RUNNER_PORT=4300 RUNNER_BIND=127.0.0.1 RUNNER_LOG=/var/log/dgclaw/admin-runner.log RUNNER_TOKEN_FILE=/etc/dgclaw/runner/admin.token IS_SANDBOX=1
Environment=PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment="RUNNER_LOGIN_HINT=Abra o painel do agente e use o botão Entrar com a assinatura."
UnsetEnvironment=CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT ANTHROPIC_API_KEY
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3
FIM
}

# O Web continua como root (o inventario esta em docs/enterprise/WEB-SEM-ROOT.md), mas ganha o sandbox que nao
# atrapalha o que ele faz hoje (podman exec, systemd-creds, escrita em /etc/dgclaw e na pasta de dados).
#   PrivateTmp, ProtectHome=read-only, ProtectKernelTunables, UMask: os mesmos motivos do controle.
#   ProtectSystem=full        /usr e /etc somente leitura; o Web precisa gravar so em /etc/dgclaw (senha do painel), liberado abaixo.
#   ReadWritePaths            /etc/dgclaw. /var/lib/dgclaw e /var/log/dgclaw ficam fora de /usr e /etc, entao ja sao gravaveis.
_adm_dropin_web() {
    cat <<'FIM'
# Gerado por dgclaw (bloco C, admin_isolado). Sandbox do Web; nao editar. Para tirar: dgclaw admin host (ou apague este arquivo).
[Service]
PrivateTmp=yes
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectSystem=full
ReadWritePaths=/etc/dgclaw
UMask=0077
FIM
}

# _adm_instalar_unidades: escreve as unidades, o drop-in do Web e liga o controle. Idempotente.
_adm_instalar_unidades() {
    local web_mudou=0
    ent_exigir jq
    executar install -d -m 750 "$DG_LOG"
    executar install -d -m 700 "$DG_LIB/web/controle"
    # _adm_escrever devolve 1 quando o arquivo ja estava igual; so o drop-in do Web usa isso (reiniciar o Web so se mudou).
    if _adm_unidade_controle | _adm_escrever "$DG_UNITS/$_ADM_UNID_CONTROLE" 644; then info "unidade $_ADM_UNID_CONTROLE escrita"; fi
    if _adm_unidade_manutencao | _adm_escrever "$DG_UNITS/$_ADM_UNID_MANUT" 644; then info "unidade $_ADM_UNID_MANUT escrita"; fi
    executar install -d -m 755 "$DG_UNITS/dgclaw-web.service.d"
    if _adm_dropin_web | _adm_escrever "$DG_UNITS/dgclaw-web.service.d/20-enterprise-controle.conf" 644; then web_mudou=1; fi
    executar systemctl daemon-reload
    executar systemctl enable "$_ADM_UNID_CONTROLE"
    executar systemctl restart "$_ADM_UNID_CONTROLE"
    ok "servico de controle ligado (socket /run/dgclaw/controle.sock)"
    if [ "$web_mudou" = 1 ]; then
        executar systemctl restart dgclaw-web.service
        ok "sandbox do systemd aplicado ao Web (o Web reiniciou)"
    fi
}

# ---------------------------------------------------------------------------------------------------------------
# isolar / host
# ---------------------------------------------------------------------------------------------------------------

_ADM_PAPEL="Cuida da maquina e dos outros agentes: pede ao servico de controle para criar, ligar, parar, reparar e remover agentes, e conta ao dono o que aconteceu."
_ADM_JEITO="Direto e calmo, em portugues do Brasil, sem jargao tecnico."

_adm_isolar() {
    exigir_ferramentas jq podman systemctl
    ent_exigir rsync
    local atual prov
    atual="$(agentes_obter admin 2>/dev/null || true)"
    [ -n "$atual" ] || falha "nao achei o Admin no registro de agentes (${DG_AGENTES_JSON#"$R"})." \
        "rode o instalador (./install.sh) para criar o Admin do host antes de isolar."
    carregar_env_dgclaw
    if ! protecao_ligada admin_isolado; then
        protecao_ajustar admin_isolado true || return 1
        ok "protecao admin_isolado ligada"
    fi

    passo "Servico de controle e sandbox do Web"
    _adm_instalar_unidades

    if [ -z "$(jq -r '.container // empty' <<<"$atual")" ]; then
        printf '%s\n' "$atual" | escrever_arquivo "$(_adm_backup)" 600
        ok "registro do Admin do host guardado em ${DG_ETC#"$R"}/admin-host.json (para o dgclaw admin host)"
    fi
    prov="$(jq -r '.provedor // "claude"' <<<"$atual")"
    case "$prov" in claude|codex) ;; *) prov=claude ;; esac

    passo "Criando o Admin em container"
    # O agente criar le esta variavel (ent_admin_criando) para aceitar o nome admin e registrar tipo e papel certos.
    DGCLAW_CRIANDO_ADMIN=1 agente_criar admin --nome "Admin" --provedor "$prov" --auth assinatura \
        --papel "$_ADM_PAPEL" --jeito "$_ADM_JEITO" --avatar "🛠️" --cor "#64748b"

    passo "Desligando o Admin do host"
    executar systemctl disable --now "$_ADM_UNID_HOST"
    ok "o Admin antigo (root no servidor) esta desligado e desabilitado; a pasta ${DG_ADMIN#"$R"} continua intacta"
    auditar_aviso admin.isolar "$(jq -nc --arg p "$prov" '{provedor: $p, modo: "container"}')"
    info "Falta o Admin entrar na conta do Claude: abra o painel dele (menu, Admin) e use Entrar com a assinatura."
    info "A conversa antiga do Admin do host nao e levada: a memoria e as instrucoes foram copiadas, o historico fica em /root/.claude."
    info "Para voltar ao modo antigo: dgclaw admin host (so onde o nivel de protecao permite)."
}

_adm_host() {
    exigir_ferramentas jq podman systemctl
    local bk
    bk="$(_adm_backup)"
    [ -s "$bk" ] || falha "nao tenho a copia do registro do Admin do host (${bk#"$R"}), entao nao sei voltar ao modo antigo." \
        "reinstale o DG Claw (./install.sh), que recria o Admin do host, e rode de novo."
    if protecao_ligada admin_isolado; then
        protecao_ajustar admin_isolado false || return 1
        ok "protecao admin_isolado desligada"
    fi
    if [ -f "$(_adm_estado_manutencao)" ]; then _adm_manut_fechar manual; fi

    passo "Voltando ao Admin do host"
    if [ "$ENSAIO" = 1 ] || podman container exists dgclaw-admin >/dev/null 2>&1; then
        executar podman stop dgclaw-admin
        ok "container do Admin parado (a casa dele fica em ${DG_CASAS:-/var/lib/dgclaw/agentes}/admin, para um novo dgclaw admin isolar)"
    fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] devolveria o registro do Admin do host ao agentes.json"
    else
        agentes_registrar <"$bk"
    fi
    executar systemctl enable --now "$_ADM_UNID_HOST"
    executar systemctl disable --now "$_ADM_UNID_CONTROLE"
    ok "Admin do host de volta (root no servidor, em bypassPermissions); o servico de controle foi desligado"
    auditar_aviso admin.host "$(jq -nc '{modo: "host"}')"
}

# ---------------------------------------------------------------------------------------------------------------
# Manutencao de emergencia
# ---------------------------------------------------------------------------------------------------------------

_adm_manut_abrir() {
    local minutos="" por="desconhecido" a fecha_ms agora obj
    while [ $# -gt 0 ]; do
        case "$1" in
            --por) [ $# -ge 2 ] || falha "falta o valor de --por." "use: dgclaw admin manutencao abrir <minutos> --por <quem>"
                   por="$2"; shift 2 ;;
            -*) falha "a opcao '$1' nao existe em 'admin manutencao abrir'." "use: dgclaw admin manutencao abrir <minutos de 5 a 60> [--por quem]" ;;
            *) [ -z "$minutos" ] || falha "sobrou '$1' na linha (ja recebi $minutos minutos)." "use: dgclaw admin manutencao abrir <minutos de 5 a 60>"
               minutos="$1"; shift ;;
        esac
    done
    if ! [[ "$minutos" =~ ^[0-9]{1,3}$ ]] || [ "$((10#$minutos))" -lt 5 ] || [ "$((10#$minutos))" -gt 60 ]; then
        falha "os minutos da manutencao precisam ser um numero de 5 a 60 (recebi '${minutos:-nada}')." "use: dgclaw admin manutencao abrir 15"
    fi
    minutos=$((10#$minutos))
    [[ "$por" =~ ^[A-Za-z0-9_.:@-]{1,80}$ ]] || falha "o nome de quem abre ('${por:0:40}') tem caracteres que nao aceito." "use so letras, numeros e _ . : @ -"
    exigir_ferramentas jq systemctl
    protecao_ligada admin_isolado || falha "a manutencao de emergencia so existe com o Admin isolado (protecao admin_isolado)." \
        "neste nivel o Admin do host ja esta no ar: nada a abrir."
    [ -s "$(_adm_backup)" ] || falha "nao tenho a copia do registro do Admin do host (${DG_ETC#"$R"}/admin-host.json)." \
        "reinstale o DG Claw (./install.sh) para recriar o Admin do host e tente de novo."
    [ -f "$DG_ADMIN/.plataforma/runner.json" ] || [ "$ENSAIO" = 1 ] || falha "o Admin do host nao esta instalado (falta ${DG_ADMIN#"$R"}/.plataforma/runner.json)." \
        "rode o instalador (./install.sh) e tente de novo."
    if [ -f "$(_adm_estado_manutencao)" ]; then
        a="$(jq -r '.fecha_ms // empty' "$(_adm_estado_manutencao)" 2>/dev/null || true)"
        falha "ja existe uma manutencao aberta${a:+ (fecha em $(date -d "@$((a / 1000))" '+%H:%M' 2>/dev/null || echo "$a"))}." \
            "use o Admin dela ou feche antes: dgclaw admin manutencao fechar"
    fi
    agora="$(agora_ms)"
    fecha_ms=$((agora + minutos * 60 * 1000))
    passo "Abrindo a manutencao de emergencia por $minutos minutos"
    # shellcheck disable=SC2016 # os $ sao variaveis do jq
    obj="$(jq -c --arg s "$_ADM_SLUG_MANUT" '.slug = $s | .nome = "Admin (manutencao)" | .subtitulo = "Manutencao de emergencia: root no servidor" | .avatar = "⚠️" | .cor = "#c0392b" | del(.papel)' "$(_adm_backup)")" \
        || falha "o jq nao leu a copia do registro do Admin (${DG_ETC#"$R"}/admin-host.json)." "confira com: jq . ${DG_ETC#"$R"}/admin-host.json"
    jq -nc --argjson a "$agora" --argjson f "$fecha_ms" --argjson m "$minutos" --arg p "$por" --arg s "$_ADM_SLUG_MANUT" \
        '{aberta_em: $a, fecha_em: $f, fecha_ms: $f, minutos: $m, por: $p, slug: $s}' | escrever_arquivo "$(_adm_estado_manutencao)" 600
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] registraria $_ADM_SLUG_MANUT no agentes.json"; else printf '%s\n' "$obj" | agentes_registrar; fi
    executar systemctl start "$_ADM_UNID_MANUT"
    executar systemd-run --on-active="${minutos}min" --unit="$_ADM_TIMER_FECHA" \
        --description="Fecha a manutencao de emergencia do Admin" "$(_adm_cli)" admin manutencao fechar --auto
    auditar_aviso manutencao_aberta "$(jq -nc --argjson m "$minutos" --arg p "$por" --argjson f "$fecha_ms" '{minutos: $m, por: $p, fecha_em: $f}')"
    ok "Admin antigo (root) no ar por $minutos minutos; o chat dele aparece no painel como \"Admin (manutencao)\""
    info "Fecha sozinho. Antes disso: dgclaw admin manutencao fechar"
}

# _adm_manut_fechar <auto|manual>: idempotente.
_adm_manut_fechar() {
    local motivo="${1:-manual}" por=""
    exigir_ferramentas jq systemctl
    if [ -f "$(_adm_estado_manutencao)" ]; then por="$(jq -r '.por // empty' "$(_adm_estado_manutencao)" 2>/dev/null || true)"; fi
    passo "Fechando a manutencao de emergencia"
    if [ "$ENSAIO" = 1 ] || systemctl is-active "${_ADM_UNID_MANUT%.service}" >/dev/null 2>&1; then
        executar systemctl stop "$_ADM_UNID_MANUT"
    fi
    if [ "$motivo" = manual ] && { [ "$ENSAIO" = 1 ] || systemctl is-active "$_ADM_TIMER_FECHA.timer" >/dev/null 2>&1; }; then
        executar systemctl stop "$_ADM_TIMER_FECHA.timer"
    fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] tiraria $_ADM_SLUG_MANUT do agentes.json e apagaria o estado da manutencao"
    else
        agentes_remover "$_ADM_SLUG_MANUT"
        rm -f "$(_adm_estado_manutencao)"
    fi
    auditar_aviso manutencao_fechada "$(jq -nc --arg m "$motivo" --arg p "$por" '{motivo: $m, aberta_por: $p}')"
    ok "manutencao fechada ($motivo): o Admin do host esta desligado outra vez"
}

_adm_manut_status() {
    local f
    f="$(_adm_estado_manutencao)"
    if [ ! -f "$f" ]; then printf 'Nenhuma manutencao de emergencia aberta.\n'; return 0; fi
    # shellcheck disable=SC2016 # codigo jq
    jq -r '"Manutencao aberta por \(.por) ate \(.fecha_ms / 1000 | strflocaltime("%H:%M")) (\(.minutos) minutos)."' "$f"
}

_adm_status() {
    if _adm_isolado_agora; then
        printf 'Admin: em container (isolado). Pede ao servico de controle; o perigoso espera o TI aprovar no painel.\n'
        printf 'Servico de controle: %s\n' "$(systemctl is-active "${_ADM_UNID_CONTROLE%.service}" 2>/dev/null || true)"
    else
        printf 'Admin: no host (modo antigo, root no servidor).\n'
        if protecao_ligada admin_isolado; then printf 'A protecao admin_isolado esta ligada e o Admin ainda nao foi isolado: rode dgclaw admin isolar.\n'; fi
    fi
    _adm_manut_status
}

ent_cmd_admin() {
    local sub="${1:-status}"
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        isolar) _adm_isolar "$@" ;;
        host) _adm_host "$@" ;;
        status) _adm_status ;;
        manutencao)
            local acao="${1:-status}"
            if [ "$#" -gt 0 ]; then shift; fi
            case "$acao" in
                abrir) _adm_manut_abrir "$@" ;;
                fechar)
                    case "${1:-}" in
                        "") _adm_manut_fechar manual ;;
                        --auto) _adm_manut_fechar auto ;;
                        *) falha "a opcao '$1' nao existe em 'admin manutencao fechar'." "use: dgclaw admin manutencao fechar" ;;
                    esac ;;
                status) _adm_manut_status ;;
                *) falha "'admin manutencao $acao' nao existe." "use: dgclaw admin manutencao abrir <minutos> | fechar | status" ;;
            esac ;;
        *) falha "'admin $sub' nao existe." "use: dgclaw admin isolar | host | status | manutencao abrir|fechar|status" ;;
    esac
}

# ---------------------------------------------------------------------------------------------------------------
# Ganchos
# ---------------------------------------------------------------------------------------------------------------

# Roda DENTRO do `agente criar admin`, depois do registro: poe a identidade do Admin isolado (no lugar da do agente
# comum) e copia a memoria e as instrucoes do Admin do host. Usa C_HOME e C_UG, definidos pelo agente_criar.
ent_depois_de_criar_admin_isolado() {
    local slug="${1:-}" tpl="$APP_DIR/templates/admin-isolado" h="${C_HOME:-}" ug="${C_UG:-}" arq skill
    ent_admin_criando || return 0
    [ "$slug" = admin ] || return 0
    if [ -z "$h" ] || [ -z "$ug" ]; then
        falha "o gancho do Admin isolado nao recebeu a casa (C_HOME) nem o uid (C_UG) do agente_criar." "isto e um erro do DG Claw; abra uma issue com a saida acima."
    fi
    for arq in CLAUDE.md AGENTS.md; do
        [ -f "$tpl/$arq" ] || falha "falta o modelo $tpl/$arq do Admin isolado." "a copia do DG Claw em $APP_DIR esta incompleta; reinstale com o instalador."
        escrever_arquivo "$h/$arq" 644 "$ug" <"$tpl/$arq"
    done
    for skill in "$tpl"/skills/*/; do
        [ -d "$skill" ] || continue
        executar install -d -m 755 "$h/.claude/skills/$(basename "$skill")"
        executar rsync -a "$skill" "$h/.claude/skills/$(basename "$skill")/"
        dono "$ug" "$h/.claude/skills/$(basename "$skill")"
    done
    if [ -d "$DG_ADMIN" ]; then
        executar rsync -a --exclude=.plataforma --exclude=.dgclaw "$DG_ADMIN/" "$h/admin-anterior/"
        dono "$ug" "$h/admin-anterior"
        ok "memoria e instrucoes do Admin do host copiadas para a casa do novo Admin (pasta admin-anterior); a original continua em ${DG_ADMIN#"$R"}"
    fi
    ok "identidade do Admin isolado escrita (fala com a maquina so pelo dgclaw-controle)"
}

ent_instalar_admin_isolado() {
    protecao_ligada admin_isolado || return 0
    passo "Admin isolado (servico de controle)"
    _adm_instalar_unidades
    if _adm_isolado_agora; then
        info "o Admin ja esta em container."
        return 0
    fi
    carregar_env_dgclaw
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] isolaria o Admin (dgclaw admin isolar) se a imagem dos agentes ja estiver pronta"
        return 0
    fi
    if podman image exists "$DGCLAW_IMAGEM" >/dev/null 2>&1; then
        "$(_adm_cli)" admin isolar
    else
        aviso "a imagem dos agentes ainda esta sendo construida, entao o Admin continua no host por enquanto. Quando ela ficar pronta (dgclaw imagem status), rode: dgclaw admin isolar"
    fi
}

ent_aplicar_admin_isolado() {
    protecao_ligada admin_isolado || return 0
    if [ -z "$(agentes_obter admin 2>/dev/null)" ]; then
        info "admin isolado: nao ha Admin no registro de agentes, entao nao ha o que isolar (o instalador cria o Admin do host)."
        return 0
    fi
    _adm_instalar_unidades
    if ! _adm_isolado_agora; then _adm_isolar; fi
}

ent_status_admin() {
    protecao_ligada admin_isolado || return 0
    if _adm_isolado_agora; then
        if [ "$(estado_container admin)" = running ]; then s_ok "Admin em container (isolado)"
        else s_mal "o container do Admin esta $(estado_container admin). Veja: podman logs dgclaw-admin"; fi
        if [ "$(systemctl is-active "${_ADM_UNID_CONTROLE%.service}" 2>/dev/null)" = active ]; then s_ok "servico de controle de pe"
        else s_mal "o servico de controle esta parado. Veja: journalctl -u dgclaw-controle -n 50  (ligar: systemctl restart dgclaw-controle)"; fi
    else
        s_aviso "a protecao admin_isolado esta ligada, mas o Admin ainda roda no host. Rode: dgclaw admin isolar"
    fi
    if [ -f "$(_adm_estado_manutencao)" ]; then s_aviso "manutencao de emergencia ABERTA: $(_adm_manut_status)"; fi
}
