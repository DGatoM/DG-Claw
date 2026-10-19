#!/usr/bin/env bash
# lib/enterprise/cofre-cifrado.sh: cofre dos agentes cifrado em repouso (protecao `cofre_cifrado`).
# O lado Node (gravar e revogar chaves pelo Web) e web/lib/ent/cofre-cifrado.js; os dois seguem o mesmo layout:
#
#   <casa>/cofre/cofre.env.cred          o cofre cifrado com `systemd-creds encrypt --name=dgclaw-cofre-<slug>`
#                                        (chave do host; TPM2 se houver). E a unica copia no disco.
#   /run/dgclaw/cofres/<slug>/cofre.env  a copia em claro, so em RAM (tmpfs), pasta 700 e arquivo 600 do root do
#                                        container. O container monta ESTA pasta em /run/dgclaw/cofre no lugar
#                                        de <casa>/cofre (ent_args_container_cofre_cifrado).
#
# Quem abre a copia em RAM: `dgclaw cofre abrir` (unidade dgclaw-cofre.service, no boot) e o gancho
# ent_antes_de_iniciar_cofre (a cada `agente iniciar`). O valor das chaves nunca vai para argv nem para log.
# Comandos: dgclaw cofre migrar | abrir [slug] | status.

_cofre_ram() { printf '%s' "${DGCLAW_COFRES_RAM:-$R/run/dgclaw/cofres}"; }
_cofre_casa() { printf '%s/%s' "${DG_CASAS:-$DG_LIB/agentes}" "$1"; }
_cofre_creds() { printf '%s' "${DGCLAW_SYSTEMD_CREDS:-systemd-creds}"; }
_COFRE_SLUG_RX='^[a-z0-9][a-z0-9-]{1,30}$'

# _cofre_cifrar <slug> <claro> <destino.cred>: valor pelo stdin do systemd-creds, blob direto no destino (600).
_cofre_cifrar() {
    local slug="$1" claro="$2" cred="$3" tmp
    tmp="$(mktemp "$(dirname "$cred")/.cofre.cred.XXXXXX")"
    if ! "$(_cofre_creds)" encrypt "--name=dgclaw-cofre-$slug" --with-key=auto - "$tmp" <"$claro" 2>"$tmp.erro"; then
        local motivo
        motivo="$(tr '\n' ' ' <"$tmp.erro" | head -c 200)"
        rm -f "$tmp" "$tmp.erro"
        falha "o systemd-creds nao cifrou o cofre do agente $slug (${motivo:-sem mensagem})." \
            "confira se funciona com: systemd-creds --version  e se esta maquina tem /var/lib/systemd/credential.secret. O cofre em claro nao foi tocado."
    fi
    rm -f "$tmp.erro"
    chmod 600 "$tmp"
    mv -f "$tmp" "$cred"
}

# _cofre_decifrar <slug> <cred>: o texto claro no stdout. Erro: mensagem e codigo 1 (quem chama decide).
_cofre_decifrar() {
    local slug="$1" cred="$2" erro
    erro="$(mktemp)"
    if ! "$(_cofre_creds)" decrypt "--name=dgclaw-cofre-$slug" "$cred" - 2>"$erro"; then
        printf 'Nao deu certo: nao consegui decifrar %s (%s).\nO que fazer: confira o systemd-creds (systemd-creds --version) e se o arquivo esta inteiro. As chaves nao foram alteradas.\n' \
            "${cred#"$R"}" "$(tr '\n' ' ' <"$erro" | head -c 200)" >&2
        rm -f "$erro"
        return 1
    fi
    rm -f "$erro"
}

# _cofre_dono <slug>: uid:gid da pasta do cofre na casa (o root do container, visto do host).
_cofre_dono() { stat -c '%u:%g' "$(_cofre_casa "$1")/cofre"; }

# _cofre_ram_gravar <slug>: texto claro pelo stdin -> /run/dgclaw/cofres/<slug>/cofre.env (600, dono do container).
_cofre_ram_gravar() {
    local slug="$1" dono
    dono="$(_cofre_dono "$slug")" || return 1
    criar_pasta 700 0:0 "$(_cofre_ram)"
    criar_pasta 700 "$dono" "$(_cofre_ram)/$slug"
    escrever_arquivo "$(_cofre_ram)/$slug/cofre.env" 600 "$dono"
}

# cofre_abrir_um <slug>: deixa a copia em RAM pronta. Cofre cifrado: decifra. Cofre ainda em claro: cifra
# agora (e abre). Sem cofre nenhum (agente de outro layout): avisa e segue.
cofre_abrir_um() {
    local slug="$1" casa cred claro
    [[ "$slug" =~ $_COFRE_SLUG_RX ]] || falha "o nome curto '${slug:0:40}' nao e valido." "use o slug do agente (veja: dgclaw agente listar)."
    casa="$(_cofre_casa "$slug")"
    cred="$casa/cofre/cofre.env.cred"; claro="$casa/cofre/cofre.env"
    if [ ! -e "$cred" ]; then
        if [ -e "$claro" ]; then cofre_migrar_um "$slug"; return $?; fi
        aviso "o agente $slug nao tem cofre em $casa/cofre; nada a abrir."
        return 0
    fi
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] decifraria $cred para $(_cofre_ram)/$slug/cofre.env"; return 0; fi
    _cofre_decifrar "$slug" "$cred" | _cofre_ram_gravar "$slug" || return 1
    ok "cofre do agente $slug aberto em memoria"
}

# cofre_migrar_um <slug>: cifra o cofre.env em claro, confere, abre a copia em RAM e so entao apaga o claro.
cofre_migrar_um() {
    local slug="$1" casa cred claro n conferido
    casa="$(_cofre_casa "$slug")"
    cred="$casa/cofre/cofre.env.cred"; claro="$casa/cofre/cofre.env"
    [ -e "$claro" ] || { info "agente $slug: nao ha cofre em claro (ja esta cifrado ou nao tem cofre)."; return 0; }
    # grep -c devolve 1 quando conta zero linhas (cofre vazio); o 0 impresso e o que interessa.
    n="$(grep -Ec '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$claro" || true)"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] cifraria $claro ($n chave(s)) para $cred, abriria a copia em memoria e apagaria o claro"; return 0; fi
    _cofre_cifrar "$slug" "$claro" "$cred"
    # Prova de que a copia cifrada devolve exatamente o que estava em claro, ANTES de apagar o claro.
    conferido="$(_cofre_decifrar "$slug" "$cred" | sha256sum | cut -d' ' -f1)" \
        || falha "o cofre do agente $slug foi cifrado mas nao consegui conferir a copia." "o cofre em claro continua em $claro; nada foi apagado. Resolva o systemd-creds e rode de novo: dgclaw cofre migrar"
    if [ "$conferido" != "$(sha256sum <"$claro" | cut -d' ' -f1)" ]; then
        rm -f "$cred"
        falha "a copia cifrada do cofre do agente $slug nao bate com o original (a conferencia falhou)." "o cofre em claro continua em $claro; nada foi apagado. Rode de novo: dgclaw cofre migrar"
    fi
    _cofre_ram_gravar "$slug" <"$claro"
    rm -f "$claro"
    ok "cofre do agente $slug cifrado ($n chave(s)); o arquivo em claro foi apagado do disco"
    # Cofre vazio (agente recem-criado) nao tem o que registrar.
    if [ "${n:-0}" -gt 0 ]; then auditar_aviso cofre.migrar "$(jq -nc --arg s "$slug" --argjson n "${n:-0}" '{slug: $s, chaves: $n}')"; fi
}

# _cofre_slugs: os agentes do agentes.json que tem pasta de cofre na casa.
_cofre_slugs() {
    local slug
    while IFS= read -r slug; do
        [ -n "$slug" ] || continue
        [ -d "$(_cofre_casa "$slug")/cofre" ] && printf '%s\n' "$slug"
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
}

_cofre_exigir_ligado() {
    protecao_ligada cofre_cifrado || falha "a protecao cofre_cifrado esta desligada neste nivel ($(protecao_nivel))." \
        "ligue com: dgclaw nivel definir escritorio   (ou: dgclaw nivel ajustar cofre_cifrado true)"
}

_cofre_status() {
    local slug claro cred algum=0 casa
    printf '%-20s %-10s %s\n' AGENTE ESTADO DETALHE
    while IFS= read -r slug; do
        algum=1
        casa="$(_cofre_casa "$slug")"
        claro="$casa/cofre/cofre.env"; cred="$claro.cred"
        if [ -e "$cred" ] && [ ! -e "$claro" ]; then
            printf '%-20s %-10s %s\n' "$slug" cifrado "$( [ -s "$(_cofre_ram)/$slug/cofre.env" ] && echo 'copia em memoria aberta' || echo 'copia em memoria FECHADA (dgclaw cofre abrir)')"
        elif [ -e "$claro" ]; then
            printf '%-20s %-10s %s\n' "$slug" EM-CLARO "rode: dgclaw cofre migrar"
        else
            printf '%-20s %-10s %s\n' "$slug" vazio "sem cofre.env"
        fi
    done < <(_cofre_slugs)
    [ "$algum" = 1 ] || echo "nenhum agente com cofre."
}

ent_cmd_cofre() {
    local sub="${1:-status}" slug
    if [ "$#" -gt 0 ]; then shift; fi
    exigir_ferramentas jq
    case "$sub" in
        status) _cofre_status ;;
        migrar)
            _cofre_exigir_ligado
            passo "Cifrando os cofres que estao em claro"
            local feitos=0
            while IFS= read -r slug; do
                if [ -e "$(_cofre_casa "$slug")/cofre/cofre.env" ]; then cofre_migrar_um "$slug"; feitos=$((feitos + 1)); fi
            done < <(_cofre_slugs)
            [ "$feitos" -gt 0 ] || info "nenhum cofre em claro: tudo o que existe ja esta cifrado."
            info "os agentes que ja existem so passam a ler da copia em memoria quando o container for recriado (dgclaw protecoes aplicar mostra quais; recriar: dgclaw agente recriar <slug> --forcar)." ;;
        abrir)
            _cofre_exigir_ligado
            if [ "$#" -gt 0 ]; then cofre_abrir_um "$1"
            else
                while IFS= read -r slug; do cofre_abrir_um "$slug"; done < <(_cofre_slugs)
            fi ;;
        *) falha "o subcomando 'cofre $sub' nao existe." "use: dgclaw cofre status | migrar | abrir [slug]" ;;
    esac
}

# --- ganchos -------------------------------------------------------------------------------

# Troca a montagem do cofre: no lugar de <casa>/cofre entra /run/dgclaw/cofres/<slug>. Em vez de
# acrescentar uma segunda --volume (o podman recusaria dois destinos iguais), percorre o array do podman
# e reescreve SO o elemento `<casa>/cofre:/run/dgclaw/cofre:ro`. A pasta em RAM tem de existir antes do
# `podman create`, por isso a abertura acontece aqui.
ent_args_container_cofre_cifrado() {
    local -n _ent_cofre_args="$1"
    local slug="$2" i
    protecao_ligada cofre_cifrado || return 0
    cofre_abrir_um "$slug" || return 1
    for i in "${!_ent_cofre_args[@]}"; do
        if [[ "${_ent_cofre_args[$i]}" == *"/cofre:/run/dgclaw/cofre:ro" ]]; then
            _ent_cofre_args[i]="$(_cofre_ram)/$slug:/run/dgclaw/cofre:ro"
            return 0
        fi
    done
    falha "nao achei a montagem do cofre no podman create do agente $slug." \
        "isso e um erro do DG Claw (o gancho ent_args_container_cofre_cifrado nao reconheceu a --volume do cofre); abra uma issue."
}

# Antes de ligar o container: a copia em RAM precisa estar aberta (depois de um reboot ela some).
ent_antes_de_iniciar_cofre() {
    protecao_ligada cofre_cifrado || return 0
    cofre_abrir_um "$1"
}

# Agente removido: a copia em claro que estava em RAM sai junto. E tmpfs, nao ha o que guardar.
ent_depois_de_remover_cofre() {
    local d
    protecao_ligada cofre_cifrado || return 0
    [[ "$1" =~ $_COFRE_SLUG_RX ]] || return 0
    d="$(_cofre_ram)/$1"
    if [ -d "$d" ]; then rm -rf -- "$d"; fi
}

ent_aplicar_cofre() {
    protecao_ligada cofre_cifrado || return 0
    ent_cmd_cofre migrar
}

ent_status_cofre() {
    local slug claros=0 total=0
    protecao_ligada cofre_cifrado || return 0
    while IFS= read -r slug; do
        total=$((total + 1))
        if [ -e "$(_cofre_casa "$slug")/cofre/cofre.env" ]; then claros=$((claros + 1)); fi
    done < <(_cofre_slugs)
    if [ "$claros" -eq 0 ]; then s_ok "cofre cifrado: $total agente(s), nenhum cofre em claro no disco"
    else s_aviso "cofre cifrado ligado, mas $claros de $total agente(s) ainda tem o cofre em claro no disco. Rode: dgclaw cofre migrar"; fi
}

ent_instalar_cofre() {
    cat <<'FIM' | escrever_arquivo "$DG_UNITS/dgclaw-cofre.service" 644
[Unit]
Description=DG Claw: abre em memoria os cofres cifrados dos agentes
# Os cofres cifrados ficam dentro da casa dos agentes, que pode estar no disco cifrado.
After=dgclaw-disco.service
Wants=dgclaw-disco.service
# Antes de qualquer container ligar (o podman reinicia os agentes no boot) e antes do Web.
Before=podman.service podman-restart.service dgclaw-web.service dgclaw-admin.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/dgclaw cofre abrir

[Install]
WantedBy=multi-user.target
FIM
    executar systemctl daemon-reload
    executar systemctl enable dgclaw-cofre.service
    ok "unidade dgclaw-cofre.service instalada (abre os cofres cifrados no boot)"
    info "se ja ha agentes com cofre em claro: dgclaw cofre migrar   (e dgclaw protecoes aplicar para recriar os containers)"
}
