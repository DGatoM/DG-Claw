#!/usr/bin/env bash
# lib/enterprise/politicas.sh: politicas gerenciadas do Claude Code por agente (protecoes `politicas_claude` e
# `travas_externas`). Detalhes, o que e o que nao e garantia e como testar na maquina real: docs/enterprise/POLITICAS.md.
#
# Para cada agente, o host escreve <casa>/politicas/managed-settings.json (dono root do host, 644, pasta 755) e o container
# monta a pasta SO LEITURA em /etc/claude-code, que e onde o Claude Code procura as "managed settings" no Linux.
# Fonte conferida em 18/10/2026:
#   https://code.claude.com/docs/en/managed-settings   ("Linux and WSL: /etc/claude-code/managed-settings.json")
#   https://code.claude.com/docs/en/authentication      (secao "Restrict login to your organization")
# Nada nele o agente consegue editar: o arquivo e do root do host, a montagem e :ro, e managed settings tem a prioridade
# mais alta (nem --settings nem settings.local.json mudam uma chave dele).
#
# Chaves usadas (nomes e valores da documentacao oficial):
#   forceLoginOrgUUID   o org_uuid do protecoes.json (string). Login em outra organizacao e recusado na partida.
#   forceLoginMethod    "claudeai" (assinatura). NAO usamos "console": a doc diz que, com qualquer uma das duas chaves
#                       (forceLoginMethod ou forceLoginOrgUUID), o Claude Code bloqueia ANTHROPIC_API_KEY na partida.
#                       Por isso o agente de SETOR (chave de API da empresa) nao recebe nenhuma das duas; ver POLITICAS.md.
#   cleanupPeriodDays   retencao_dias, quando maior que zero (o Claude Code apaga as conversas dele depois desse prazo).
#   permissions.deny    as ferramentas de envio do Gmail (travas_externas), tiradas por N horas na liberacao temporaria.
# NAO desligamos nenhum metodo de login do binario (armadilha 8 do DESENHO): fixamos so a organizacao, pelo recurso oficial.
#
# Codex (conferido em 18/10/2026 em https://learn.chatgpt.com/docs/enterprise/managed-configuration): o equivalente e
# /etc/codex/requirements.toml com allowed_login_methods. Montamos <casa>/politicas-codex em /etc/codex, so leitura. O Codex
# nao tem forceLoginOrgUUID nem conectores do claude.ai: a trava do Gmail nao se aplica a ele (ver POLITICAS.md).
#
# Ganchos: ent_args_container_politicas (monta), ent_aplicar_politicas (regrava e reinicia o runner), ent_status_politicas.
# Precisa de lib/comum.sh, lib/agentes.sh, lib/protecoes.sh e lib/enterprise/auditoria.sh.

POL_CLAUDE_DESTINO="/etc/claude-code"
POL_CODEX_DESTINO="/etc/codex"
_POL_MCP_GMAIL="mcp__claude_ai_Gmail__"
# Mesmas listas de scripts/gmail-permissao.sh (o teste tests/enterprise/travas.test.sh confere que continuam iguais).
# shellcheck disable=SC2034 # lidas por lib/enterprise/travas.sh e pelo jq abaixo
POL_GMAIL_ENVIO=(send_message reply forward 'send*' 'reply*' 'forward*')
POL_GMAIL_ALTERA=(apply_sensitive_message_label apply_sensitive_thread_label create_label delete_draft delete_label
    label_message label_thread mark_message_spam mark_thread_spam trash_message trash_thread unlabel_message unlabel_thread
    unmark_message_spam unmark_thread_spam untrash_message untrash_thread update_label update_message_labels)

_pol_casa() { printf '%s/%s' "${DG_CASAS:-$DG_LIB/agentes}" "$1"; }
_pol_dir() { printf '%s/politicas' "$(_pol_casa "$1")"; }
_pol_dir_codex() { printf '%s/politicas-codex' "$(_pol_casa "$1")"; }
_pol_travas_arq() { printf '%s/travas/%s.json' "$DG_ETC" "$1"; }

_pol_ligada() { protecao_ligada politicas_claude || protecao_ligada travas_externas; }

# Provedor do agente: o da criacao em andamento, ou o do agentes.json. Padrao claude.
_pol_provedor() {
    local slug="$1" v=""
    if [ "${C_SLUG:-}" = "$slug" ] && [ -n "${C_PROVEDOR:-}" ]; then v="$C_PROVEDOR"
    else v="$(agentes_obter "$slug" 2>/dev/null | jq -r '.provedor // empty' 2>/dev/null)" || v=""; fi
    printf '%s' "${v:-claude}"
}

# Uso do agente (credencial_empresa): pessoa, setor ou vazio. Na criacao em andamento vale o C_USO.
_pol_uso() {
    local slug="$1" v=""
    if [ "${C_SLUG:-}" = "$slug" ] && [ -n "${C_USO:-}" ]; then v="$C_USO"
    else v="$(agentes_obter "$slug" 2>/dev/null | jq -r '.uso // empty' 2>/dev/null)" || v=""; fi
    printf '%s' "$v"
}

# Forma de pagar do agente: assinatura ou api. Na criacao vale o C_AUTH; depois, o runner.json da casa.
_pol_forma_de_pagar() {
    local slug="$1" v="" rj
    if [ "${C_SLUG:-}" = "$slug" ] && [ -n "${C_AUTH:-}" ]; then v="$C_AUTH"
    else
        rj="$(_pol_casa "$slug")/runner/runner.json"
        if [ -f "$rj" ]; then v="$(jq -r '.config.auth // empty' "$rj" 2>/dev/null)" || v=""; fi
    fi
    printf '%s' "${v:-assinatura}"
}

# Esta liberado o envio de e-mail deste agente agora? (liberacao temporaria, dgclaw travas liberar)
_pol_envio_liberado() {
    local arq ate agora
    arq="$(_pol_travas_arq "$1")"
    [ -s "$arq" ] || return 1
    ate="$(jq -r '.liberado_ate // 0' "$arq" 2>/dev/null)" || return 1
    agora="$(( $(agora_ms) / 1000 ))"
    [[ "$ate" =~ ^[0-9]+$ ]] && [ "$ate" -gt "$agora" ]
}

# O managed-settings.json do agente, no stdout.
_pol_json() {
    local slug="$1" org metodo="" retencao uso forma deny_envio=1 deny_json='[]' item
    org="$(protecao_org)"
    retencao="$(protecao_valor retencao_dias 2>/dev/null)" || retencao=0
    uso="$(_pol_uso "$slug")"; forma="$(_pol_forma_de_pagar "$slug")"
    # Agente de setor (ou que paga pela API) nao pode levar forceLogin*: o Claude Code bloquearia a chave de API na partida.
    if protecao_ligada politicas_claude && [ "$uso" != setor ] && [ "$forma" != api ]; then metodo=claudeai; fi
    if protecao_ligada travas_externas; then
        if _pol_envio_liberado "$slug"; then deny_envio=0; fi
        local itens=()
        if [ "$deny_envio" = 1 ]; then for item in "${POL_GMAIL_ENVIO[@]}"; do itens+=("${_POL_MCP_GMAIL}$item"); done; fi
        for item in "${POL_GMAIL_ALTERA[@]}"; do itens+=("${_POL_MCP_GMAIL}$item"); done
        deny_json="$(printf '%s\n' "${itens[@]}" | jq -R . | jq -sc .)"
    fi
    # shellcheck disable=SC2016 # os $ sao variaveis do jq
    jq -n --arg org "$org" --arg metodo "$metodo" --argjson dias "${retencao:-0}" --argjson deny "$deny_json" --argjson ret "$(protecao_ligada politicas_claude && echo true || echo false)" '
        {}
        + (if $ret and $metodo != "" then {forceLoginMethod: $metodo} else {} end)
        + (if $ret and $metodo != "" and $org != "" then {forceLoginOrgUUID: $org} else {} end)
        + (if $ret and $dias > 0 then {cleanupPeriodDays: $dias} else {} end)
        + (if ($deny | length) > 0 then {permissions: {deny: $deny}} else {} end)'
}

# O requirements.toml do Codex, no stdout (so a forma de entrar; ver o cabecalho).
_pol_toml_codex() {
    local slug="$1" metodo
    if [ "$(_pol_uso "$slug")" = setor ] || [ "$(_pol_forma_de_pagar "$slug")" = api ]; then metodo=api; else metodo=chatgpt; fi
    printf '# Gerado pelo DG Claw (lib/enterprise/politicas.sh). Nao edite: o proximo "dgclaw protecoes aplicar" sobrescreve.\n'
    printf '# Fonte: https://learn.chatgpt.com/docs/enterprise/managed-configuration (conferido em 18/10/2026).\n'
    printf 'allowed_login_methods = ["%s"]\n' "$metodo"
}

# _pol_gravar <caminho> <conteudo>: grava (root, 644) so se mudou. Codigo 0 = gravou, 10 = ja estava igual.
_pol_gravar() {
    local alvo="$1" conteudo="$2"
    if [ -f "$alvo" ] && [ "$(cat "$alvo")" = "$conteudo" ]; then return 10; fi
    printf '%s\n' "$conteudo" | escrever_arquivo "$alvo" 644 0:0
}

# pol_gerar <slug>: escreve os arquivos de politica do agente. Codigo 0 = mudou algo, 10 = tudo igual.
pol_gerar() {
    local slug="$1" prov rc=0 dir cj
    prov="$(_pol_provedor "$slug")"
    if ! _pol_ligada; then
        # Protecao desligada: o arquivo que sobrou de antes sai, para o agente deixar de herdar regra que nao vale mais.
        dir="$(_pol_dir "$slug")"
        if [ -e "$dir/managed-settings.json" ] && [ "$ENSAIO" != 1 ]; then rm -f -- "$dir/managed-settings.json"; return 0; fi
        return 10
    fi
    if [ "$prov" = codex ]; then
        dir="$(_pol_dir_codex "$slug")"
        criar_pasta 755 0:0 "$dir"
        _pol_gravar "$dir/requirements.toml" "$(_pol_toml_codex "$slug")" || rc=$?
        return "$rc"
    fi
    dir="$(_pol_dir "$slug")"
    criar_pasta 755 0:0 "$dir"
    cj="$(_pol_json "$slug")" || return 1
    _pol_gravar "$dir/managed-settings.json" "$cj" || rc=$?
    return "$rc"
}

_pol_reiniciar_runner() {
    local slug="$1" c="dgclaw-$1"
    [ "$ENSAIO" = 1 ] && { info "[ensaio] reiniciaria o runner do agente $slug"; return 0; }
    if [ "$(podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" != running ]; then return 0; fi
    executar podman exec "$c" systemctl restart dgclaw-runner >/dev/null
    ok "runner do agente $slug reiniciado para ler as politicas novas"
}

# O container tem a montagem das politicas? (container criado antes da protecao nao tem.)
_pol_montado() {
    local slug="$1" destino="$POL_CLAUDE_DESTINO"
    [ "$(_pol_provedor "$slug")" = codex ] && destino="$POL_CODEX_DESTINO"
    podman container exists "dgclaw-$slug" >/dev/null 2>&1 || return 0
    podman inspect -f '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' "dgclaw-$slug" 2>/dev/null | grep -qxF "$destino"
}

# --- ganchos -------------------------------------------------------------------------------

# Acrescenta a montagem so leitura da pasta de politicas. A pasta e os arquivos precisam existir antes do `podman create`.
ent_args_container_politicas() {
    local -n _ent_pol_args="$1"
    local slug="$2" prov
    _pol_ligada || return 0
    pol_gerar "$slug" || { local rc=$?; [ "$rc" -eq 10 ] || return "$rc"; }
    prov="$(_pol_provedor "$slug")"
    if [ "$prov" = codex ]; then _ent_pol_args+=(--volume "$(_pol_dir_codex "$slug"):$POL_CODEX_DESTINO:ro")
    else _ent_pol_args+=(--volume "$(_pol_dir "$slug"):$POL_CLAUDE_DESTINO:ro"); fi
}

# `dgclaw protecoes aplicar`: regrava o arquivo de cada agente e reinicia o runner dos que mudaram. Container criado antes
# da protecao nao tem a montagem: nao recriamos sozinhos (derrubaria o agente e levaria o que ele instalou fora da casa),
# dizemos o comando.
ent_aplicar_politicas() {
    local slug rc alguma=0
    while IFS= read -r slug; do
        rc=0; pol_gerar "$slug" || rc=$?
        if [ "$rc" -ne 0 ] && [ "$rc" -ne 10 ]; then return "$rc"; fi
        if _pol_ligada; then
            if ! _pol_montado "$slug"; then
                alguma=1
                aviso "o container do agente $slug foi criado antes das politicas e nao tem a montagem de $POL_CLAUDE_DESTINO. Para recriar (a casa fica): dgclaw agente recriar $slug --forcar"
            elif [ "$rc" -eq 0 ]; then
                _pol_reiniciar_runner "$slug"
            fi
        elif [ "$rc" -eq 0 ]; then
            _pol_reiniciar_runner "$slug"
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    if _pol_ligada && [ "$alguma" = 0 ]; then ok "politicas do Claude Code em dia em todos os agentes"; fi
    if protecao_ligada politicas_claude && [ -z "$(protecao_org)" ]; then
        aviso "a organizacao (forceLoginOrgUUID) nao esta definida: o login pessoal do Claude NAO esta bloqueado. Defina com: dgclaw nivel org <uuid>"
    fi
}

ent_status_politicas() {
    local slug defasados=""
    _pol_ligada || return 0
    while IFS= read -r slug; do
        if ! _pol_montado "$slug"; then
            defasados="${defasados:+$defasados, }$slug"
        elif [ "$(_pol_provedor "$slug")" != codex ] && [ ! -s "$(_pol_dir "$slug")/managed-settings.json" ]; then
            defasados="${defasados:+$defasados, }$slug"
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    if [ -n "$defasados" ]; then s_aviso "politicas do Claude Code: agente(s) sem a politica montada: $defasados (dgclaw protecoes aplicar; depois dgclaw agente recriar <slug> --forcar)"
    else s_ok "politicas do Claude Code montadas so leitura em todos os agentes"; fi
    if protecao_ligada politicas_claude && [ -z "$(protecao_org)" ]; then
        s_aviso "organizacao (forceLoginOrgUUID) nao definida: o login pessoal do Claude NAO esta bloqueado. Defina com: dgclaw nivel org <uuid>"
    fi
}
