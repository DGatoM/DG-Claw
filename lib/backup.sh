#!/usr/bin/env bash
# lib/backup.sh: o backup conferido do DG Claw. Serve a tres comandos:
#   dgclaw backup [--sem-casas] [--simular]      backup manual, em /var/backups/dgclaw/<data>-manual
#   dgclaw backup listar                         lista os backups que existem
#   dgclaw restaurar <backup> [--simular] [--mesmo-assim]
# e ao `dgclaw atualizar` (lib/atualizar.sh), que faz o mesmo backup antes de mexer em qualquer coisa
# e usa o proprio atualizar_backup daqui.
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Usa as funcoes dele e da lib/comum.sh
# (falha, ok, info, aviso, passo, executar, estado_container...), por isso as variaveis e funcoes
# "nao definidas aqui" abaixo sao do bin/dgclaw (e personalizacoes_guardar_app / _reservar_pasta, da
# lib/personalizacoes.sh, que o bin/dgclaw tambem carrega; so sao chamadas em tempo de execucao).
# shellcheck disable=SC2154
#
# COMO ESTENDER (a edicao enterprise e quem mais vai precisar): carregue este arquivo e DEPOIS
# redefina, num arquivo seu, qualquer uma destas funcoes. Todas tem um padrao que nao faz nada:
#   backup_caminhos_extras          imprime, um por linha, caminhos absolutos que tambem entram no
#                                   backup (viram o extras.tar.gz e voltam no `restaurar`)
#   backup_aplicar_retencao <pasta> roda depois de cada backup criado, com a pasta dos backups
#                                   (/var/backups/dgclaw). O padrao NAO APAGA NADA: backup so sai
#                                   quando o dono pede. Quem implementar retencao nunca apaga o mais
#                                   recente nem um backup com motivo antes-de-restaurar ou
#                                   antes-de-voltar
#   depois_de_restaurar <pasta>     roda no fim de um `dgclaw restaurar` que deu certo
#   depois_de_atualizar <resultado> roda no fim de um `dgclaw atualizar`; o resultado e "concluida",
#                                   "incompleta" ou "voltou-sozinho"
#
# O que este arquivo NUNCA faz: apagar backup, `git reset --hard`, `git clean` ou apagar pasta de agente.

DG_BACKUPS="$R/var/backups/dgclaw"

# --- pontos de extensao (padrao: nada) ------------------------------------------------------

backup_caminhos_extras() { return 0; }
backup_aplicar_retencao() { return 0; }
depois_de_restaurar() { return 0; }
depois_de_atualizar() { return 0; }

# --- utilitarios ------------------------------------------------------------------------------

# _env_de <arquivo> <CHAVE>: valor de uma linha CHAVE=valor, sem executar o arquivo.
_env_de() {
    [ -f "$1" ] || return 0
    sed -n "s/^$2=//p;T;q" "$1"
}

# _rel <caminho absoluto>: o caminho sem o prefixo da raiz falsa e sem a barra inicial.
_rel() { local p="${1#"$R"}"; printf '%s' "${p#/}"; }

# _sha <arquivo>: so o hash.
_sha() { sha256sum <"$1" | cut -d' ' -f1; }

# _tamanho_humano <kb>
_tamanho_humano() {
    awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GB", k / 1048576; else if (k >= 1024) printf "%.0f MB", k / 1024; else printf "%d KB", k }'
}

# atualizar_pasta_backup [sufixo]: imprime a pasta nova (data e hora, com o sufixo se vier um;
# ganha um numero no fim se ja existir).
atualizar_pasta_backup() {
    personalizacoes_reservar_pasta "$DG_BACKUPS/$(date +%Y%m%d-%H%M%S)${1:+-$1}"
}

# --- o backup -------------------------------------------------------------------------------------

# _tar_backup <arquivo.tar.gz> <opcoes e caminhos do tar, relativos a raiz...>
# Cria o tar.gz relativo a raiz, aceita "arquivo mudou enquanto eu lia" (codigo 1: normal com
# agente ligado), recusa qualquer outro erro e confere que o resultado abre.
_tar_backup() {
    local alvo="$1"; shift
    local rc=0
    ( umask 077; tar --numeric-owner -C "${R:-/}" -czf "$alvo" "$@" ) || rc=$?
    case "$rc" in
        0) ;;
        1) aviso "alguns arquivos mudaram enquanto eu copiava para $(basename "$alvo") (normal com agentes ligados); a copia segue valida." ;;
        *) falha "o tar nao conseguiu criar $alvo (codigo $rc)." "veja se ha espaco em disco (df -h $DG_BACKUPS) e rode de novo; nada foi mudado." ;;
    esac
    tar -tzf "$alvo" >/dev/null 2>&1 \
        || falha "o backup $alvo foi criado, mas o tar nao consegue abri-lo (esta corrompido)." \
                 "nao sigo sem um backup que abre. Veja o espaco em disco (df -h) e rode de novo; nada foi mudado."
    chmod 600 "$alvo"
}

# atualizar_backup <pasta destino> <motivo> <sem-homes 0|1>
atualizar_backup() {
    local dest="$1" motivo="$2" sem_homes="$3" casa agentes="" f commit_manifesto ramo=""
    local caminhos=() transc=() extras=()
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] criaria o backup em $dest com: etc/dgclaw, var/lib/dgclaw$([ "$sem_homes" = 1 ] && printf ' (sem as casas dos agentes)'), opt/dgclaw/admin, transcricoes do Admin e o MANIFESTO.txt"
        return 0
    fi
    ( umask 077; mkdir -p "$dest" )
    chmod 700 "$DG_BACKUPS" "$dest"

    # config.tar.gz: /etc/dgclaw inteiro (chaves, hash da senha, agentes.json, tokens).
    [ -d "$DG_ETC" ] || falha "nao existe $DG_ETC; o DG Claw nao parece instalado." "instale primeiro: sudo ./install.sh --usuario <nome>"
    _tar_backup "$dest/config.tar.gz" "$(_rel "$DG_ETC")"

    # admin.tar.gz: a pasta do Admin (CLAUDE.md, AGENTS.md, uploads, skills).
    if [ -d "$DG_ADMIN" ]; then _tar_backup "$dest/admin.tar.gz" "$(_rel "$DG_ADMIN")"; fi

    # app.tar.gz: o programa instalado inteiro (vale para atualizar, restaurar e --voltar).
    personalizacoes_guardar_app "$dest"

    # transcricoes-admin.tar.gz: a conversa do Admin (Claude ou Codex).
    for f in "$R/root/.claude/projects/-opt-dgclaw-admin" "$R/root/.codex/sessions"; do
        if [ -d "$f" ]; then transc+=("$(_rel "$f")"); fi
    done
    if [ "${#transc[@]}" -gt 0 ]; then _tar_backup "$dest/transcricoes-admin.tar.gz" "${transc[@]}"; fi

    # dados.tar.gz: /var/lib/dgclaw (casas dos agentes, cofres, web). O pesado.
    if [ -d "$DG_LIB" ]; then
        caminhos=("$(_rel "$DG_LIB")")
        if [ "$sem_homes" = 1 ]; then
            _tar_backup "$dest/dados.tar.gz" "--exclude=$(_rel "$DG_LIB")/agentes/*/home" "${caminhos[@]}"
        else
            _tar_backup "$dest/dados.tar.gz" "${caminhos[@]}"
        fi
    fi

    # extras.tar.gz: o que uma edicao que estende o DG Claw quiser guardar junto (ver o topo).
    while IFS= read -r f; do
        if [ -e "$f" ]; then extras+=("$(_rel "$f")"); fi
    done < <(backup_caminhos_extras)
    if [ "${#extras[@]}" -gt 0 ]; then _tar_backup "$dest/extras.tar.gz" "${extras[@]}"; fi

    while IFS= read -r casa; do agentes+="${agentes:+,}$casa"; done \
        < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')

    # O commit que estava INSTALADO. Sem clone (backup manual) vem do dgclaw.env.
    commit_manifesto="$ATU_COMMIT_ANTIGO"
    if [ -z "$commit_manifesto" ] && [ -n "$ATU_REPO" ]; then commit_manifesto="$(_git rev-parse HEAD 2>/dev/null || true)"; fi
    if [ -z "$commit_manifesto" ]; then commit_manifesto="$(_env_de "$DG_ETC/dgclaw.env" DGCLAW_COMMIT)"; fi
    if [ -n "$ATU_REPO" ]; then ramo="$(_git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"; fi

    {
        printf 'MANIFESTO do backup do DG Claw\n'
        printf 'criado_em=%s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"
        printf 'motivo=%s\n' "$motivo"
        printf 'repo=%s\n' "$ATU_REPO"
        printf 'commit=%s\n' "$commit_manifesto"
        printf 'ramo=%s\n' "$ramo"
        printf 'versao=%s\n' "${DGCLAW_VERSAO:-desconhecida}"
        printf 'commit_instalado=%s\n' "$(_env_de "$DG_ETC/dgclaw.env" DGCLAW_COMMIT)"
        printf 'imagem=%s\n' "${DGCLAW_IMAGEM:-}"
        printf 'agentes=%s\n' "$agentes"
        if [ -f "$dest/app.tar.gz" ]; then printf 'app_tar_gz_sha256=%s\n' "$(_sha "$dest/app.tar.gz")"; fi
        printf 'casas_dos_agentes_no_backup=%s\n' "$([ "$sem_homes" = 1 ] && printf nao || printf sim)"
        printf '\n[sha256]\n'
        atualizar_hashes_do_manifesto
    } >"$dest/MANIFESTO.txt"
    chmod 600 "$dest/MANIFESTO.txt"
    ok "backup conferido em $dest ($(du -sh "$dest" | cut -f1))"
    info "ele guarda as chaves e o hash da senha: so o root le (pasta 700). Para voltar: sudo dgclaw restaurar $dest (mesma versao) ou sudo dgclaw atualizar --voltar $dest (volta tambem o codigo)"
    backup_aplicar_retencao "$DG_BACKUPS"
}

# atualizar_hashes_do_manifesto: "<sha256>  <caminho relativo>" de tudo o que a conferencia
# final compara. Arquivos de configuracao, do Admin, cofres e os .md de identidade e memoria.
atualizar_hashes_do_manifesto() {
    local f casa
    {
        if [ -d "$DG_ETC" ]; then find "$DG_ETC" -type f ! -name '.agentes.lock'; fi
        for f in "$DG_ADMIN/CLAUDE.md" "$DG_ADMIN/AGENTS.md" "$DG_LIB/web/sessoes.json"; do
            if [ -f "$f" ]; then printf '%s\n' "$f"; fi
        done
        for casa in "$DG_CASAS"/*/; do
            [ -d "$casa" ] || continue
            casa="${casa%/}"
            for f in "$casa/cofre/cofre.env" "$casa/home/.plataforma/identidade.md" "$casa/home/.dgclaw/self-crons.json"; do
                if [ -f "$f" ]; then printf '%s\n' "$f"; fi
            done
            if [ -d "$casa/home" ]; then find "$casa/home" -maxdepth 1 -type f -name '*.md'; fi
            if [ -d "$casa/home/memory" ]; then find "$casa/home/memory" -maxdepth 1 -type f -name '*.md'; fi
        done
    } | sort -u | while IFS= read -r f; do
        printf '%s  %s\n' "$(_sha "$f")" "$(_rel "$f")"
    done
}

# backup_conferir_pasta <pasta>: a pasta e um backup do DG Claw e todo tar dele abre. Sai da CLI
# com a explicacao se nao for. Imprime o caminho absoluto da pasta.
backup_conferir_pasta() {
    local b="$1" t
    if [ ! -d "$b" ] || [ ! -f "$b/MANIFESTO.txt" ] || [ ! -f "$b/config.tar.gz" ]; then
        falha "'$b' nao parece um backup do DG Claw (falta a pasta, o MANIFESTO.txt ou o config.tar.gz)." \
              "veja os backups que existem: sudo dgclaw backup listar"
    fi
    b="$(cd "$b" && pwd)"
    for t in "$b"/*.tar.gz; do
        tar -tzf "$t" >/dev/null 2>&1 \
            || falha "o arquivo $t do backup nao abre (esta corrompido ou incompleto). Nada foi mudado." \
                     "use outro backup (sudo dgclaw backup listar) ou, se este e o unico, copie-o para fora do servidor antes de mexer: tar -tzf $t mostra o erro."
    done
    printf '%s' "$b"
}

# backup_agentes_novos <MANIFESTO>: imprime (separados por espaco) os agentes que existem agora e
# nao existiam no backup. Restaurar o agentes.json do backup os tiraria do painel.
backup_agentes_novos() {
    local manifesto="$1" slug novos=""
    while read -r slug; do
        [ -n "$slug" ] || continue
        if ! printf ',%s,' "$(_env_de "$manifesto" agentes)" | grep -qF ",$slug,"; then novos+=" $slug"; fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    printf '%s' "$novos"
}

# --- dgclaw backup ----------------------------------------------------------------------------------

backup_main() {
    local sem_homes=0 a
    if [ "${1:-}" = listar ]; then shift; backup_listar "$@"; return; fi
    while [ $# -gt 0 ]; do
        a="$1"
        case "$a" in
            --sem-casas) sem_homes=1 ;;
            --simular) ENSAIO=1 ;;
            *) falha "a opcao '$a' nao existe em 'backup'." "use: sudo dgclaw backup [--sem-casas] [--simular]  ou  sudo dgclaw backup listar" ;;
        esac
        shift
    done
    exigir_ferramentas jq tar sha256sum
    carregar_env_dgclaw
    [ -f "$DG_ETC/dgclaw.env" ] || falha "o DG Claw nao parece instalado aqui: falta $DG_ETC/dgclaw.env." "instale primeiro: sudo ./install.sh --usuario <nome>"
    if [ "$ENSAIO" = 1 ]; then printf 'SIMULACAO: nada sera mudado; so mostro o que seria feito.\n'; fi
    if [ "$sem_homes" = 1 ]; then aviso "--sem-casas: as casas dos agentes (memoria e conversas) NAO entram no backup."; fi

    local dest
    dest="$(atualizar_pasta_backup manual)"
    passo "Fazendo o backup"
    atualizar_backup "$dest" manual "$sem_homes"
    if [ "$ENSAIO" = 1 ]; then printf '\nSimulacao terminada: nada foi mudado.\n'; return 0; fi
    printf '\nBackup pronto.\n'
    printf '  Pasta:      %s\n' "$dest"
    printf '  Tamanho:    %s\n' "$(du -sh "$dest" | cut -f1)"
    printf '  Para voltar: sudo dgclaw restaurar %s\n' "$dest"
    printf '  Ele guarda chaves e senhas: copie para fora do servidor so por canal seguro (scp ou rsync, ver docs/BACKUP.md).\n'
}

# backup_listar: uma linha por backup, do mais antigo ao mais novo.
backup_listar() {
    [ $# -eq 0 ] || falha "'backup listar' nao tem opcoes (recebi: $*)." "use: sudo dgclaw backup listar"
    if [ ! -d "$DG_BACKUPS" ] || [ -z "$(find "$DG_BACKUPS" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]; then
        printf 'Ainda nao ha backups em %s. Para fazer um: sudo dgclaw backup\n' "$DG_BACKUPS"
        return 0
    fi
    local d m tam casas
    printf '%-34s %-19s %-18s %-12s %-8s %s\n' PASTA DATA MOTIVO VERSAO TAMANHO CASAS
    while IFS= read -r d; do
        m="$d/MANIFESTO.txt"
        tam="$(du -sh "$d" | cut -f1)"
        if [ ! -f "$m" ]; then
            printf '%-34s %-19s %-18s %-12s %-8s %s\n' "$(basename "$d")" - "incompleto (sem MANIFESTO.txt)" - "$tam" -
            continue
        fi
        casas="$(_env_de "$m" casas_dos_agentes_no_backup)"
        printf '%-34s %-19s %-18s %-12s %-8s %s\n' "$(basename "$d")" "$(_env_de "$m" criado_em | cut -c1-19)" \
            "$(_env_de "$m" motivo)" "$(_env_de "$m" versao)" "$tam" "${casas:--}"
    done < <(find "$DG_BACKUPS" -mindepth 1 -maxdepth 1 -type d | sort)
    printf '\nPara voltar a um deles: sudo dgclaw restaurar %s/<pasta>\n' "$DG_BACKUPS"
}

# --- dgclaw restaurar ---------------------------------------------------------------------------------

# _restaurar_extrair <tar> <rotulo> <backup agora>: extrai por cima, sem apagar o que for mais novo.
_restaurar_extrair() {
    tar -xzf "$1" -C "${R:-/}" --numeric-owner \
        || falha "nao consegui restaurar $1 ($2)." "os agentes ja foram parados; o estado de antes de restaurar esta em $3. Veja a mensagem do tar acima e rode de novo,"
}

# _restaurar_conferir <backup>: depois de extrair, confere por sha256 o que o manifesto guardou
# de configuracao, Admin e cofres. Define RES_PROBLEMAS.
RES_PROBLEMAS=0
_restaurar_conferir() {
    local b="$1" hash rel arq
    RES_PROBLEMAS=0
    while read -r hash rel; do
        [ -n "$rel" ] || continue
        case "$rel" in
            etc/dgclaw/*|opt/dgclaw/admin/*|var/lib/dgclaw/agentes/*/cofre/cofre.env) ;;
            *) continue ;;
        esac
        arq="$R/$rel"
        if [ ! -f "$arq" ]; then
            RES_PROBLEMAS=$((RES_PROBLEMAS + 1)); printf '   FALHOU  %s deveria ter voltado e nao esta aqui\n' "$rel" >&2
        elif [ "$(_sha "$arq")" != "$hash" ]; then
            RES_PROBLEMAS=$((RES_PROBLEMAS + 1)); printf '   FALHOU  %s voltou diferente do que estava no backup\n' "$rel" >&2
        fi
    done < <(sed -n '/^\[sha256\]$/,$p' "$b/MANIFESTO.txt" | tail -n +2)
    if [ "$RES_PROBLEMAS" -eq 0 ]; then ok "configuracao, Admin e cofres estao identicos aos do backup"; fi
}

restaurar_main() {
    local pasta="" mesmo_assim=0 a b versao_backup versao_atual novos antes slug ligados="" resumo_arq log_arq
    while [ $# -gt 0 ]; do
        a="$1"
        case "$a" in
            --simular) ENSAIO=1 ;;
            --mesmo-assim) mesmo_assim=1 ;;
            -*) falha "a opcao '$a' nao existe em 'restaurar'." "use: sudo dgclaw restaurar <pasta-do-backup> [--simular] [--mesmo-assim]" ;;
            *) [ -z "$pasta" ] || falha "recebi duas pastas ('$pasta' e '$a') e so restauro uma por vez." "use: sudo dgclaw restaurar <pasta-do-backup>"; pasta="$a" ;;
        esac
        shift
    done
    [ -n "$pasta" ] || falha "faltou dizer qual backup restaurar." "veja os que existem com 'sudo dgclaw backup listar' e rode: sudo dgclaw restaurar /var/backups/dgclaw/<pasta>"
    exigir_ferramentas jq tar sha256sum podman
    carregar_env_dgclaw
    [ -f "$DG_ETC/dgclaw.env" ] || falha "o DG Claw nao parece instalado aqui: falta $DG_ETC/dgclaw.env." "instale primeiro: sudo ./install.sh --usuario <nome>"
    if [ "$ENSAIO" = 1 ]; then printf 'SIMULACAO: nada sera mudado; so mostro o que seria feito.\n'; fi

    passo "Conferindo o backup $pasta"
    b="$(backup_conferir_pasta "$pasta")"
    ok "o backup tem MANIFESTO.txt e todos os arquivos abrem"

    versao_backup="$(_env_de "$b/MANIFESTO.txt" versao)"
    versao_atual="${DGCLAW_VERSAO:-desconhecida}"
    if [ "$versao_backup" != "$versao_atual" ] && [ "$mesmo_assim" != 1 ]; then
        falha "o backup e da versao '${versao_backup:-desconhecida}' e o DG Claw instalado e '$versao_atual'. Restaurar so os dados e a configuracao de uma versao no codigo de outra pode deixar o sistema inconsistente. Nada foi mudado." \
              "para voltar codigo e dados juntos: sudo dgclaw atualizar --voltar $b. Se tem certeza de que quer so os dados e a configuracao: sudo dgclaw restaurar $b --mesmo-assim"
    fi
    if [ "$versao_backup" != "$versao_atual" ]; then aviso "versao do backup ($versao_backup) diferente da instalada ($versao_atual); sigo por causa do --mesmo-assim."; fi

    novos="$(backup_agentes_novos "$b/MANIFESTO.txt")"
    if [ -n "$novos" ] && [ "$mesmo_assim" != 1 ]; then
        falha "estes agentes foram criados DEPOIS desse backup:$novos. Restaurar o agentes.json do backup os tiraria do painel (as pastas deles ficam, mas eles somem da lista). Nada foi mudado." \
              "se quer restaurar mesmo assim: sudo dgclaw restaurar $b --mesmo-assim. Se nao, escolha um backup mais recente: sudo dgclaw backup listar"
    fi

    while IFS= read -r slug; do
        [ -n "$slug" ] || continue
        if [ "$(estado_container "$slug")" = running ]; then ligados+=" $slug"; fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')

    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] faria antes um backup do estado de agora (motivo antes-de-restaurar), com as casas dos agentes"
        info "[ensaio] pararia os agentes que estao ligados:${ligados:- nenhum}"
        info "[ensaio] restauraria etc/dgclaw, opt/dgclaw/admin e var/lib/dgclaw$([ "$(_env_de "$b/MANIFESTO.txt" casas_dos_agentes_no_backup)" = sim ] || printf ' (sem as casas, que o backup nao tem)') por cima do que esta aqui, sem apagar arquivos novos"
        info "[ensaio] religaria os agentes e agendaria o reinicio do Admin para o fim"
        printf '\nSimulacao terminada: nada foi mudado.\n'
        return 0
    fi

    passo "Guardando o estado de agora (para poder desfazer a restauracao)"
    antes="$(atualizar_pasta_backup antes-de-restaurar)"
    atualizar_backup "$antes" antes-de-restaurar 0

    passo "Parando os agentes que estao ligados"
    for slug in $ligados; do agente_acao parar "$slug"; done
    if [ -z "$ligados" ]; then info "nenhum agente estava ligado"; fi

    passo "Restaurando configuracao, Admin e dados do backup"
    _restaurar_extrair "$b/config.tar.gz" "a configuracao em /etc/dgclaw" "$antes"
    if [ -f "$b/admin.tar.gz" ]; then _restaurar_extrair "$b/admin.tar.gz" "a pasta do Admin" "$antes"; fi
    if [ -f "$b/dados.tar.gz" ]; then _restaurar_extrair "$b/dados.tar.gz" "os dados em /var/lib/dgclaw" "$antes"; fi
    if [ -f "$b/extras.tar.gz" ]; then _restaurar_extrair "$b/extras.tar.gz" "os arquivos extras" "$antes"; fi
    ok "restaurado (a conversa do Admin nao e tocada, para nao voltar o chat em que voce esta)"
    if [ "$(_env_de "$b/MANIFESTO.txt" casas_dos_agentes_no_backup)" != sim ]; then
        aviso "esse backup foi feito sem as casas dos agentes (--sem-casas): a memoria e as conversas dos agentes ficaram como estavam."
    fi
    _restaurar_conferir "$b"

    passo "Religando os agentes que estavam ligados"
    for slug in $ligados; do agente_acao iniciar "$slug"; done
    if [ -z "$ligados" ]; then info "nenhum a religar"; fi

    log_arq="${DGCLAW_ATUALIZAR_LOG:-$DG_LOG/dgclaw-restaurar-$(date +%Y%m%d-%H%M%S).log}"
    resumo_arq="${log_arq%.log}.resumo.txt"
    ( umask 027; mkdir -p "$DG_LOG"
      printf 'Restaurei o backup %s (feito em %s, versao %s).\n  Backup do estado de antes de restaurar: %s\n  Para desfazer esta restauracao: sudo dgclaw restaurar %s\n  Se o painel (dgclaw-web) ainda mostrar valores antigos, reinicie-o de fora do chat: sudo systemctl restart dgclaw-web\n' \
          "$b" "$(_env_de "$b/MANIFESTO.txt" criado_em)" "$versao_backup" "$antes" "$antes" >"$resumo_arq" ) \
        || falha "nao consegui gravar o resumo em $resumo_arq." "confira o espaco e a permissao de $DG_LOG; a restauracao em si ja terminou."

    passo "Reiniciando o Admin (por ultimo)"
    if [ "$RES_PROBLEMAS" -gt 0 ]; then
        aviso "a conferencia acusou $RES_PROBLEMAS problema(s); deixo o Admin como esta, para voce nao perder o chat enquanto resolve."
        printf '\nRestaurei, mas com %s problema(s) (linhas FALHOU acima). O estado de antes esta em %s: sudo dgclaw restaurar %s desfaz.\n' "$RES_PROBLEMAS" "$antes" "$antes" >&2
        return 1
    fi
    atualizar_agendar_reinicio_do_admin "$resumo_arq" "$log_arq"
    depois_de_restaurar "$b"
    printf '\nRestaurado o backup %s.\n' "$b"
    printf '  Backup do estado de antes: %s\n' "$antes"
    printf '  Para desfazer: sudo dgclaw restaurar %s\n' "$antes"
    printf '  O Admin reinicia em alguns segundos. O painel (dgclaw-web) so le o web.env ao subir: se ele mostrar valores antigos, rode sudo systemctl restart dgclaw-web de fora do chat.\n'
}
