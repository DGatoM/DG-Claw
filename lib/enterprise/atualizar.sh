#!/usr/bin/env bash
# lib/enterprise/atualizar.sh: `dgclaw atualizar [--ref X] [--origem Y] [--sem-rollback]`.
#
# O codigo chega em /opt/dgclaw/app pelo install.sh (rsync do repositorio, sem .git). Atualizar e:
#   1. guardar uma copia para poder voltar (app, /etc/dgclaw inteiro e as unidades do systemd);
#   2. baixar a versao nova numa pasta temporaria;
#   3. rodar o install.sh DELA, que preserva /etc/dgclaw (usuario, dominio, provedor e senha vem do
#      que ja esta instalado);
#   4. conferir que nada do que e segredo mudou e que o sistema responde;
#   5. se algo falhou e nao houve --sem-rollback, restaurar a copia e reiniciar os servicos.
# Guarda as 3 copias mais novas em /var/lib/dgclaw/atualizacoes/ (700; tem os segredos de /etc).
#
# O que o rollback NAO desfaz: pacotes do apt, regras de firewall que o instalador novo tenha
# aplicado, o Caddyfile e imagens de container ja construidas. Tudo isso o instalador so
# acrescenta ou ajusta, e rodar de novo e seguro.

ATU_ORIGEM_PADRAO="https://github.com/DGatoM/DG-Claw.git"
ATU_GUARDAR=3

_atu_pasta() { printf '%s/atualizacoes' "$DG_LIB"; }

# _atu_assinatura: uma linha por coisa que a atualizacao NAO pode mudar, "<chave>\t<sha256>".
# web.env entra linha a linha (a chave e o nome da variavel; o valor nunca sai daqui), porque o
# instalador reescreve o arquivo e so a ordem pode mudar. Os demais entram inteiros.
_atu_assinatura() {
    local f
    if [ -f "$DG_ETC/web.env" ]; then
        # O valor so passa pelo sha256; o nome da variavel e a unica parte que vai para a saida.
        while IFS= read -r linha; do
            [[ "$linha" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
            printf 'web.env:%s\t%s\n' "${linha%%=*}" "$(printf '%s' "$linha" | sha256sum | cut -d' ' -f1)"
        done <"$DG_ETC/web.env"
    fi
    for f in "$DG_ETC"/runner/* "$DG_ETC"/proxy/* "$DG_ETC/protecoes.json" "$DG_LIB"/agentes/*/cofre/cofre.env; do
        [ -f "$f" ] || continue
        printf '%s\t%s\n' "${f#"$R"}" "$(sha256sum <"$f" | cut -d' ' -f1)"
    done
}

# _atu_conferir_preservados <assinatura-de-antes>: falha dizendo QUAIS (nunca o valor) mudaram ou sumiram.
_atu_conferir_preservados() {
    local antes="$1" depois perdidos
    depois="$(_atu_assinatura)"
    perdidos="$(comm -23 <(sort <<<"$antes") <(sort <<<"$depois") | cut -f1 | paste -sd, - | sed 's/,/, /g')"
    if [ -n "$perdidos" ]; then
        printf 'a atualizacao mudou ou apagou o que devia preservar: %s' "$perdidos"
        return 1
    fi
}

# _atu_snapshot <pasta do snapshot> <ref> <origem>
_atu_snapshot() {
    local snap="$1" ref="$2" origem="$3" necessario livre
    necessario=$(( ($(du -sk "$DG_APP" | cut -f1) + $(du -sk "$DG_ETC" | cut -f1)) * 12 / 10 + 1024 ))
    livre="$(df -Pk "$(dirname "$snap")" | awk 'NR == 2 {print $4}')"
    if [ -n "$livre" ] && [ "$livre" -lt "$necessario" ]; then
        printf 'faltam %s MB livres em %s para a copia de seguranca (tenho %s MB)' "$((necessario / 1024))" "$(dirname "${snap#"$R"}")" "$((livre / 1024))"
        return 1
    fi
    ( umask 077; mkdir "$snap" ) || { printf 'nao consegui criar %s' "${snap#"$R"}"; return 1; }
    tar --numeric-owner -C "$R/" -cpf "$snap/app.tar" "${DG_APP#"$R/"}" || { printf 'o tar de %s falhou' "${DG_APP#"$R"}"; return 1; }
    tar --numeric-owner -C "$R/" -cpf "$snap/etc.tar" "${DG_ETC#"$R/"}" || { printf 'o tar de %s falhou' "${DG_ETC#"$R"}"; return 1; }
    find "$DG_UNITS" -maxdepth 1 -name 'dgclaw*.service' -printf '%f\n' 2>/dev/null | LC_ALL=C sort >"$snap/unidades.lista"
    if [ -s "$snap/unidades.lista" ]; then
        tar --numeric-owner -C "$DG_UNITS" -cpf "$snap/unidades.tar" -T "$snap/unidades.lista" || { printf 'o tar das unidades do systemd falhou'; return 1; }
    fi
    jq -nc --arg c "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg v "$(versao_do_codigo "$DG_APP")" --arg r "$ref" --arg o "$origem" \
        '{criado: $c, versao_anterior: $v, ref: $r, origem: $o}' >"$snap/info.json"
    chmod 600 "$snap"/*
    if ! tar -tf "$snap/etc.tar" >/dev/null || ! tar -tf "$snap/app.tar" >/dev/null; then
        printf 'a copia de seguranca nao ficou legivel em %s' "${snap#"$R"}"
        return 1
    fi
}

# _atu_baixar <destino> <origem> <ref>
_atu_baixar() {
    local destino="$1" origem="$2" ref="$3" url="$2" args=(clone --quiet)
    [ -d "$origem" ] && url="file://$(cd "$origem" && pwd)"
    if [ -n "$ref" ]; then
        if [[ "$ref" =~ ^[0-9a-f]{7,40}$ ]]; then
            git "${args[@]}" -- "$url" "$destino" && git -C "$destino" checkout --quiet "$ref"
        else
            git "${args[@]}" --depth 1 --branch "$ref" -- "$url" "$destino"
        fi
    else
        git "${args[@]}" --depth 1 -- "$url" "$destino"
    fi
}

# _atu_saude: o Web responde e o `dgclaw status` do codigo instalado passa.
_atu_saude() {
    local inicio=$SECONDS espera="${DGCLAW_TEMPO_ESPERA:-60}"
    until curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:8300/api/saude; do
        if [ $((SECONDS - inicio)) -ge "$espera" ]; then
            printf 'GET http://127.0.0.1:8300/api/saude nao respondeu em %ss (veja: journalctl -u dgclaw-web -n 50)' "$espera"
            return 1
        fi
        sleep 2
    done
    if ! bash "$DG_APP/bin/dgclaw" status >"$1" 2>&1; then
        printf 'o dgclaw status terminou com erro (as linhas FALHOU estao em %s)' "${1#"$R"}"
        return 1
    fi
}

# _atu_voltar <snapshot>: devolve app, /etc/dgclaw e unidades ao que eram, e reinicia os servicos.
# O que estava no lugar (o estado falho) vai para dentro do snapshot, para estudar depois.
_atu_voltar() {
    local snap="$1" u
    mv "$DG_APP" "$snap/app-que-falhou" || { printf 'nao consegui mover %s' "${DG_APP#"$R"}"; return 1; }
    tar --numeric-owner -C "$R/" -xpf "$snap/app.tar" || { printf 'nao consegui restaurar %s' "${DG_APP#"$R"}"; return 1; }
    mv "$DG_ETC" "$snap/etc-que-falhou" || { printf 'nao consegui mover %s' "${DG_ETC#"$R"}"; return 1; }
    tar --numeric-owner -C "$R/" -xpf "$snap/etc.tar" || { printf 'nao consegui restaurar %s (a copia esta em %s/etc.tar)' "${DG_ETC#"$R"}" "${snap#"$R"}"; return 1; }
    if [ -f "$snap/unidades.tar" ]; then
        tar --numeric-owner -C "$DG_UNITS" -xpf "$snap/unidades.tar" || { printf 'nao consegui restaurar as unidades do systemd'; return 1; }
    fi
    # Unidade que so a versao nova criou: sai de cena (vai para o snapshot).
    while IFS= read -r u; do
        grep -qxF "$u" "$snap/unidades.lista" || { mkdir -p "$snap/unidades-que-falharam"; mv "$DG_UNITS/$u" "$snap/unidades-que-falharam/"; }
    done < <(find "$DG_UNITS" -maxdepth 1 -name 'dgclaw*.service' -printf '%f\n')
    systemctl daemon-reload || { printf 'systemctl daemon-reload falhou'; return 1; }
    systemctl restart dgclaw-web || { printf 'nao consegui reiniciar o dgclaw-web (veja: journalctl -u dgclaw-web -n 50)'; return 1; }
}

_atu_podar() {
    local pasta d nome n=0
    pasta="$(_atu_pasta)"
    # So apaga pasta com nome de snapshot (AAAAMMDD-HHMMSS), da mais velha para a mais nova.
    while IFS= read -r nome; do
        n=$((n + 1))
        [ "$n" -gt "$ATU_GUARDAR" ] || continue
        rm -rf -- "${pasta:?}/$nome"
    done < <(for d in "$pasta"/*/; do
                 nome="$(basename "$d")"
                 [[ "$nome" =~ ^[0-9]{8}-[0-9]{6}(-[0-9]+)?$ ]] && printf '%s\n' "$nome"
             done | LC_ALL=C sort -r)
}

# _atu_defeito: chamada pelo ent_cmd_atualizar quando uma etapa falha. Usa as variaveis locais dele
# (etapa, motivo, snap, log, antes, rollback) pelo escopo dinamico do bash. Audita, volta a copia
# (se pode) e sai com erro; nunca devolve.
_atu_defeito() {
    local desfeito="" msg
    if [ -n "${novo:-}" ]; then rm -rf -- "$novo"; fi
    auditar_aviso atualizar.falha "$(jq -nc --arg e "$etapa" --arg m "$motivo" '{etapa: $e, motivo: $m}')"
    printf '\n%sA atualizacao falhou na etapa "%s": %s%s\n' "$_C_ER" "$etapa" "$motivo" "$_C_0" >&2
    if [ "$etapa" = "copia de seguranca" ]; then
        falha "a atualizacao parou na etapa \"$etapa\" ($motivo); nada foi mudado." "resolva o que o motivo diz e rode de novo."
    fi
    if [ "$rollback" = 1 ] && [ -f "$snap/app.tar" ] && [ -f "$snap/etc.tar" ]; then
        passo "Voltando para a versao $antes"
        if msg="$(_atu_voltar "$snap")"; then
            desfeito=1
            auditar_aviso atualizar.rollback "$(jq -nc --arg v "$antes" --arg s "${snap#"$R"}" '{versao: $v, copia: $s}')"
            ok "app, ${DG_ETC#"$R"} e unidades restaurados da copia ${snap#"$R"}"
            if _atu_saude "$log.status-volta" >/dev/null 2>&1; then
                ok "a versao $antes voltou a responder"
            else
                aviso "a versao $antes foi restaurada, mas ainda nao responde: veja journalctl -u dgclaw-web -n 50"
            fi
            systemctl restart dgclaw-admin || aviso "nao consegui reiniciar o dgclaw-admin; rode: systemctl restart dgclaw-admin"
        else
            printf '%sO rollback tambem falhou:%s %s\n' "$_C_ER" "$_C_0" "$msg" >&2
        fi
    fi
    if [ -n "$desfeito" ]; then
        falha "a atualizacao falhou na etapa \"$etapa\" ($motivo); voltei para a versao $antes." \
            "leia o log ${log#"$R"} e a copia do estado que falhou em ${snap#"$R"}/. Corrija a causa e rode de novo."
    elif [ "$rollback" = 0 ]; then
        falha "a atualizacao falhou na etapa \"$etapa\" ($motivo) e, como voce pediu --sem-rollback, nada foi desfeito." \
            "leia o log ${log#"$R"}. A copia de antes da atualizacao esta em ${snap#"$R"}/ (app.tar, etc.tar e unidades.tar, todos extraiveis com tar -xpf a partir de /)."
    fi
    falha "a atualizacao falhou na etapa \"$etapa\" ($motivo) e nao consegui voltar sozinho." \
        "o sistema pode estar pela metade. A copia de antes esta em ${snap#"$R"}/ (app.tar, etc.tar e unidades.tar); leia o log ${log#"$R"} e peca ajuda a quem instalou."
}

ent_cmd_atualizar() {
    local ref="" origem="" rollback=1 usuario dominio provedor stamp snap novo log antes motivo="" etapa="" assinatura rc f
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --ref) [ "$#" -ge 2 ] || falha "a opcao --ref precisa de um valor." "use: dgclaw atualizar --ref v1.2.0"; ref="$2"; shift 2 ;;
            --origem) [ "$#" -ge 2 ] || falha "a opcao --origem precisa de um valor." "use: dgclaw atualizar --origem /pasta/do/repo (ou uma URL git)"; origem="$2"; shift 2 ;;
            --sem-rollback) rollback=0; shift ;;
            *) falha "opcao desconhecida: $1" "use: dgclaw atualizar [--ref <tag-ou-branch>] [--origem <pasta-ou-url-git>] [--sem-rollback]" ;;
        esac
    done
    [ -z "$ref" ] || [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ && "$ref" != -* ]] \
        || falha "o --ref '$ref' tem caracteres que nao aceito." "use o nome de uma tag, branch ou commit (letras, numeros, ponto, barra, hifen)."
    [[ "$origem" != -* ]] || falha "a --origem '$origem' comeca com hifen." "informe uma pasta ou uma URL git."
    exigir_ferramentas git tar jq rsync curl
    [ -d "$DG_APP" ] || falha "nao achei o app instalado em ${DG_APP#"$R"}." "o DG Claw ainda nao foi instalado nesta maquina; rode o instalador."

    carregar_env_dgclaw
    usuario="${DGCLAW_USUARIO:-$(sed -n 's/^DGCLAW_PANEL_USER=//p;T;q' "$DG_ETC/web.env" 2>/dev/null || true)}"
    dominio="${DGCLAW_DOMINIO:-}"
    provedor="${DGCLAW_PROVEDOR_ADMIN:-}"
    [ -n "$usuario" ] || falha "nao descobri o usuario do painel (faltam DGCLAW_USUARIO em $DG_ETC/dgclaw.env e DGCLAW_PANEL_USER em $DG_ETC/web.env)." \
        "rode o instalador uma vez com --usuario <nome>; depois o atualizar funciona sozinho."
    if [ -z "$origem" ]; then
        if [ -d "$DG_APP/.git" ]; then origem="$(git -C "$DG_APP" remote get-url origin 2>/dev/null)" || origem=""; fi
        origem="${origem:-$ATU_ORIGEM_PADRAO}"
    fi

    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] guardaria uma copia de ${DG_APP#"$R"}, ${DG_ETC#"$R"} e das unidades dgclaw*.service em ${DG_LIB#"$R"}/atualizacoes/<data>/"
        info "[ensaio] baixaria ${ref:-a branch padrao} de $origem, rodaria o install.sh dela, conferiria /api/saude e o dgclaw status"
        if [ "$rollback" = 1 ]; then info "[ensaio] se algo falhasse, voltaria para a copia"; else info "[ensaio] se algo falhasse, deixaria como esta (--sem-rollback)"; fi
        return 0
    fi

    stamp="$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$(_atu_pasta)"
    chmod 700 "$(_atu_pasta)"
    snap="$(_atu_pasta)/$stamp"
    [ ! -e "$snap" ] || snap="$snap-$$"
    log="$DG_LOG/atualizar-$stamp.log"
    mkdir -p "$DG_LOG"
    ( umask 077; : >"$log" )
    antes="$(versao_do_codigo "$DG_APP")"
    auditar_aviso atualizar.inicio "$(jq -nc --arg de "$antes" --arg r "$ref" --arg o "$origem" '{de: $de, ref: $r, origem: $o}')"

    passo "Guardando uma copia para poder voltar"
    etapa="copia de seguranca"
    if ! motivo="$(_atu_snapshot "$snap" "$ref" "$origem")"; then _atu_defeito; fi
    ok "copia em ${snap#"$R"}/ (app, ${DG_ETC#"$R"} e unidades; so root le)"
    _atu_podar

    passo "Baixando a versao nova de $origem${ref:+ ($ref)}"
    etapa="download"
    novo="$(_atu_pasta)/.novo-$stamp"
    rm -rf -- "$novo"
    if ! _atu_baixar "$novo" "$origem" "$ref" >>"$log" 2>&1; then
        motivo="o git nao baixou $origem${ref:+ na ref $ref} (as ultimas linhas do log: $(tail -n 3 "$log" | tr '\n' ' '))"
        _atu_defeito
    fi
    for f in install.sh VERSION; do
        [ -f "$novo/$f" ] || { motivo="o codigo baixado nao tem $f (nao parece o DG Claw)"; _atu_defeito; }
    done
    ok "versao $(versao_do_codigo "$novo") baixada (a instalada e a $antes)"

    assinatura="$(_atu_assinatura)"
    passo "Rodando o instalador da versao nova"
    etapa="instalador"
    # set +e so em volta do pipe: o codigo que interessa e o do install.sh, nao o do tee.
    set +e
    bash "$novo/install.sh" --usuario "$usuario" ${dominio:+--dominio "$dominio"} ${provedor:+--provedor "$provedor"} \
        </dev/null 2>&1 | tee -a "$log"
    rc=${PIPESTATUS[0]}
    set -e
    if [ "$rc" -ne 0 ]; then
        motivo="o install.sh da versao nova terminou com codigo $rc"
        _atu_defeito
    fi

    passo "Conferindo que nada do que e seu mudou"
    etapa="preservacao"
    if ! motivo="$(_atu_conferir_preservados "$assinatura")"; then _atu_defeito; fi
    ok "web.env, tokens, chaves de proxy e cofres iguais ao de antes"

    passo "Conferindo que o sistema responde"
    etapa="saude"
    if ! motivo="$(_atu_saude "$log.status")"; then _atu_defeito; fi
    ok "o Web responde e o dgclaw status passou"

    rm -rf -- "$novo"
    cat "$log.status" >>"$log" 2>/dev/null; rm -f "$log.status"
    auditar_aviso atualizar.sucesso "$(jq -nc --arg de "$antes" --arg para "$(versao_do_codigo "$DG_APP")" '{de: $de, para: $para}')"
    _atu_podar
    printf '\nDG Claw atualizado: %s -> %s. Log: %s\n' "$antes" "$(versao_do_codigo "$DG_APP")" "${log#"$R"}"
}
