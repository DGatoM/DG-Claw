#!/usr/bin/env bash
# lib/enterprise/admin-llm.sh: Admin desligavel (protecao `admin_llm` = false, opcao do nivel regulado).
#
# Sem Admin LLM nenhum modelo de linguagem tem mao no servidor. Quem cria e cuida de agentes e o TI, pelo
# formulario "Novo agente" do Web (que fala com o servico de controle, deterministico) e pelo `dgclaw`.
#
#   dgclaw admin desligar   para e desabilita o container do Admin (e o do host, se existir), tira o Admin do
#                           agentes.json guardando a entrada em agentes.json.admin-desligado, fecha a manutencao
#                           de emergencia se estiver aberta e grava admin_llm = false
#   dgclaw admin ligar      desfaz: devolve a entrada, religa o Admin e grava admin_llm = true
#
# `ent_admin_desligado` e usado pelo dgclaw status, pelo monitor e pelo bloco C (admin-isolado.sh) para nao
# tratar a falta do Admin como defeito. O Web decide pelo mesmo valor (web/lib/ent/admin-desligado.js).

_adl_guardado() { printf '%s.admin-desligado' "$DG_AGENTES_JSON"; }

# ent_admin_desligado: o Admin foi desligado de proposito (admin_llm = false)?
ent_admin_desligado() { [ "$(protecao_valor admin_llm 2>/dev/null || true)" = false ]; }

admin_llm_desligar() {
    local obj="" tinha_container=""
    ent_exigir jq podman systemctl
    if ent_admin_desligado && [ -z "$(agentes_obter admin 2>/dev/null || true)" ]; then
        info "o Admin ja esta desligado. Para religar: dgclaw admin ligar"
        return 0
    fi
    if ! protecao_ligada admin_isolado; then
        falha "sem o Admin nao ha quem crie agentes, e o formulario do Web so cria pelo servico de controle, que existe com o Admin isolado (protecao admin_isolado)." \
              "isole primeiro: dgclaw admin isolar   (ou suba o nivel: dgclaw nivel definir escritorio). Depois repita: dgclaw admin desligar"
    fi
    passo "Desligando o Admin (sem LLM com acesso ao servidor)"
    if [ -f "$(_adm_estado_manutencao)" ]; then
        _adm_manut_fechar manual
    fi
    obj="$(agentes_obter admin 2>/dev/null || true)"
    if [ -n "$obj" ]; then
        tinha_container="$(jq -r '.container // empty' <<<"$obj")"
        printf '%s\n' "$obj" | escrever_arquivo "$(_adl_guardado)" 600
        ok "entrada do Admin guardada em ${DG_AGENTES_JSON#"$R"}.admin-desligado (para o dgclaw admin ligar)"
    fi
    protecao_ajustar admin_llm false || return 1
    if [ -n "$tinha_container" ]; then
        if [ "$ENSAIO" = 1 ] || podman container exists dgclaw-admin >/dev/null 2>&1; then
            executar podman stop dgclaw-admin
            # Sem isto o podman-restart religaria o Admin no proximo boot (restart unless-stopped).
            executar podman update --restart=no dgclaw-admin
        fi
    fi
    if [ "$ENSAIO" = 1 ] || [ -f "$DG_UNITS/dgclaw-admin.service" ]; then
        executar systemctl disable --now dgclaw-admin.service
    fi
    if [ -n "$obj" ]; then
        if [ "$ENSAIO" = 1 ]; then info "[ensaio] tiraria o Admin do agentes.json"; else agentes_remover admin; fi
    fi
    ok "Admin desligado: sem conversa com o Admin no Web. Agentes novos: formulario Novo agente (/novo-agente) ou dgclaw agente criar"
    auditar_aviso admin.desligar "$(jq -nc --arg m "$([ -n "$tinha_container" ] && echo container || echo host)" '{modo_anterior: $m}')"
}

admin_llm_ligar() {
    local obj="" container=""
    ent_exigir jq podman systemctl
    if ! ent_admin_desligado && [ -n "$(agentes_obter admin 2>/dev/null || true)" ]; then
        info "o Admin ja esta ligado."
        return 0
    fi
    [ -s "$(_adl_guardado)" ] || falha "nao tenho a entrada guardada do Admin (${DG_AGENTES_JSON#"$R"}.admin-desligado), entao nao sei religar." \
        "recrie o Admin: dgclaw admin isolar (com o servico de controle de pe), ou reinstale o DG Claw (./install.sh)."
    obj="$(jq -c . "$(_adl_guardado)")" || falha "o arquivo ${DG_AGENTES_JSON#"$R"}.admin-desligado nao e um JSON valido." "confira com: jq . ${DG_AGENTES_JSON#"$R"}.admin-desligado"
    container="$(jq -r '.container // empty' <<<"$obj")"
    passo "Religando o Admin"
    protecao_ajustar admin_llm true || return 1
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] devolveria o Admin ao agentes.json"; else printf '%s\n' "$obj" | agentes_registrar; fi
    if [ -n "$container" ]; then
        executar podman update --restart=unless-stopped dgclaw-admin
        executar podman start dgclaw-admin
    else
        executar systemctl enable --now dgclaw-admin.service
    fi
    if [ "$ENSAIO" != 1 ]; then rm -f "$(_adl_guardado)"; fi
    ok "Admin religado"
    auditar_aviso admin.ligar "$(jq -nc --arg m "$([ -n "$container" ] && echo container || echo host)" '{modo: $m}')"
}

# Se o instalador (configurar_admin) recriou o Admin do host numa reinstalacao, desliga de novo. Roda antes dos ganchos do
# bloco C por ordem alfabetica? Nao: "admin_isolado" vem antes de "admin_llm"; por isso o bloco C tambem confere ent_admin_desligado.
ent_instalar_admin_llm() {
    ent_admin_desligado || return 0
    if [ -n "$(agentes_obter admin 2>/dev/null || true)" ] || [ -f "$DG_UNITS/dgclaw-admin.service" ]; then
        passo "Admin desligado de proposito (admin_llm = false)"
        admin_llm_desligar
    fi
}

ent_status_admin_llm() {
    if ent_admin_desligado; then
        s_ok "Admin desligado de proposito: nenhum LLM com acesso ao servidor. Agentes novos pelo formulario do Web ou por dgclaw agente criar"
        if [ -n "$(agentes_obter admin 2>/dev/null || true)" ]; then
            s_aviso "admin_llm esta desligado, mas o Admin ainda esta no agentes.json. Rode: dgclaw admin desligar"
        fi
    fi
}
