#!/usr/bin/env bash
# lib/personalizacoes.sh: as personalizacoes do programa feitas pelo Admin sobrevivem a `dgclaw atualizar`.
#
# Carregado com `source` pelo bin/dgclaw, depois de lib/atualizar.sh, nunca executado. Usa as
# funcoes e variaveis dele e da lib/comum.sh (_git, ATU_REPO, ATU_SEM_BAIXAR, falha, ok, info...),
# por isso as "nao definidas aqui" abaixo sao de la.
# shellcheck disable=SC2154,SC2034
#
# O combinado: cada personalizacao do programa vira um commit na branch local `personalizacoes`
# do clone, e ganha uma entrada em $DG_ADMIN/PERSONALIZACOES.md (fora do app, a atualizacao nao
# toca nele). Na atualizacao:
#   - se a versao nova mexe num arquivo que uma personalizacao tambem mexeu, PARA antes do
#     backup (nada foi mudado) com uma frase pronta para o Admin repassar ao dono;
#   - se nao cruza, guarda uma copia da branch e reaplica por cima (git rebase origin/main).
# Nunca `reset --hard`, nunca `clean`, nunca apaga branch.

PERS_ATIVO=0            # 1 quando o passo de baixar deve reaplicar (em vez do git pull)
PERS_N=0                # quantas personalizacoes (entradas ativas do registro; ou commits, se o registro estiver vazio)
PERS_N_COMMITS=0        # commits da branch que estao acima da base oficial
PERS_REAPLICADAS=0      # quantas foram reaplicadas de verdade (para o resumo)
PERS_COPIA=""           # branch com a copia de antes

personalizacoes_registro() { printf '%s' "${DGCLAW_PERSONALIZACOES:-$DG_ADMIN/PERSONALIZACOES.md}"; }
_pers_ramo() { printf '%s' "${DGCLAW_RAMO_PERSONALIZACOES:-personalizacoes}"; }
_pers_oficial() { printf 'origin/%s' "${DGCLAW_RAMO_OFICIAL:-main}"; }

# personalizacoes_ler: linhas "titulo<TAB>arquivo" das entradas ATIVAS do registro (uma por arquivo;
# entrada sem arquivo sai com o arquivo vazio). Ignora blocos cercados por ``` (o modelo de exemplo)
# e entradas cuja linha "- Situacao:" nao seja "ativa".
personalizacoes_ler() {
    local reg; reg="$(personalizacoes_registro)"
    [ -f "$reg" ] || return 0
    awk '
        function fecha(   i) {
            if (titulo != "" && ativa) {
                if (n == 0) printf "%s\t\n", titulo
                for (i = 1; i <= n; i++) printf "%s\t%s\n", titulo, arq[i]
            }
            titulo = ""; n = 0; ativa = 1
        }
        BEGIN { cerca = 0; titulo = ""; n = 0; ativa = 1 }
        { sub(/\r$/, "") }
        /^[ \t]*```/ { cerca = !cerca; next }
        cerca { next }
        /^## / { fecha(); titulo = substr($0, 4); sub(/[ \t]+$/, "", titulo); next }
        titulo == "" { next }
        /^- Arquivos:/ {
            resto = $0
            while (match(resto, /`[^`]+`/)) {
                n++; arq[n] = substr(resto, RSTART + 1, RLENGTH - 2)
                resto = substr(resto, RSTART + RLENGTH)
            }
            next
        }
        /^- Situa[^:]*:/ {
            v = $0; sub(/^- Situa[^:]*:[ \t]*/, "", v); sub(/[ \t]+$/, "", v)
            ativa = (tolower(v) == "ativa")
            next
        }
        END { fecha() }
    ' "$reg"
}

# _pers_juntar: lista em linhas (stdin) -> "a, b e c".
_pers_juntar() {
    local itens=() l out="" i
    while IFS= read -r l; do if [ -n "$l" ]; then itens+=("$l"); fi; done
    for i in "${!itens[@]}"; do
        if [ "$i" -eq 0 ]; then out="${itens[$i]}"
        elif [ "$i" -eq $((${#itens[@]} - 1)) ]; then out+=" e ${itens[$i]}"
        else out+=", ${itens[$i]}"; fi
    done
    printf '%s' "$out"
}

# personalizacoes_conferir: roda no modo atualizar, depois de achar e conferir o clone.
personalizacoes_conferir() {
    personalizacoes_avisar_pendente
    if [ "${PERS_SO_CONFERIR:-0}" != 1 ]; then personalizacoes_trava_atualizar; fi
    git_do_clone "$ATU_REPO" rev-parse --git-dir >/dev/null 2>&1 || return 0
    local ramo ramo_pers oficial reg ativas n_reg n_arq tem_ramo=0
    ramo_pers="$(_pers_ramo)"; oficial="$(_pers_oficial)"; reg="$(personalizacoes_registro)"
    ramo="$(_git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    ativas="$(personalizacoes_ler)"
    n_reg="$(printf '%s\n' "$ativas" | cut -f1 | sort -u | grep -c . || true)"
    n_arq="$(printf '%s\n' "$ativas" | cut -f2 | grep -c . || true)"
    _git show-ref --verify --quiet "refs/heads/$ramo_pers" && tem_ramo=1

    # Clone fora da branch das personalizacoes: a atualizacao instalaria a versao SEM elas. Vale
    # tambem com --sem-baixar (o app e refeito a partir do clone, seja qual for a branch).
    if [ "$ramo" != "$ramo_pers" ]; then
        local no_repo=0 fora=0 f
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            if [ "$tem_ramo" = 1 ] && _git cat-file -e "$ramo_pers:$f" 2>/dev/null; then no_repo=1
            elif _git cat-file -e "HEAD:$f" 2>/dev/null; then no_repo=1; fi
        done < <(printf '%s\n' "$ativas" | cut -f2)
        if [ "$tem_ramo" = 1 ]; then fora="$(_git rev-list --count "$ramo_pers" --not --remotes 2>/dev/null || printf 0)"; fi
        if [ "$no_repo" = 1 ] || [ "$fora" -gt 0 ]; then
            local msg_ramo
            msg_ramo="o registro ($reg) lista $n_reg personalizacao(oes) no programa (arquivos do repositorio: $([ "$no_repo" = 1 ] && printf sim || printf nao)) e a branch '$ramo_pers' tem $fora commit(s) que nao estao no GitHub, mas o clone $ATU_REPO esta na branch '$ramo', nao na '$ramo_pers'. Atualizar assim instalaria a versao oficial SEM as personalizacoes."
            if [ "${ATU_SEM_PERS:-0}" = 1 ]; then
                aviso "$msg_ramo Sigo mesmo assim porque veio --sem-personalizacoes (o dono decidiu instalar sem elas); a copia delas fica no backup e na branch '$ramo_pers'."
                return 0
            elif [ "${PERS_SO_CONFERIR:-0}" = 1 ]; then
                aviso "$msg_ramo Para incluir as personalizacoes: git -C $ATU_REPO switch $ramo_pers"
                return 0
            fi
            falha "$msg_ramo" "volte o clone para a branch das personalizacoes (git -C $ATU_REPO switch $ramo_pers) e rode de novo. Se o dono decidiu instalar sem elas, rode com --sem-personalizacoes. Nada foi mudado (parei antes do backup)."
        fi
    fi

    if [ "$ATU_SEM_BAIXAR" = 1 ]; then
        info "--sem-baixar: sem download, entao nao confiro as personalizacoes do programa contra a versao nova."
        return 0
    fi
    if [ "$ramo" != "$ramo_pers" ]; then
        if [ "$n_arq" -gt 0 ] || [ "$tem_ramo" = 1 ]; then
            aviso "o registro ($reg) lista $n_reg personalizacao(oes) no programa, mas o clone esta na branch '$ramo', nao na '$ramo_pers'. Elas podem ficar de fora da versao nova. Para conferir: git -C $ATU_REPO branch"
        else
            ok "nenhuma personalizacao do programa registrada"
        fi
        return 0
    fi

    info "git fetch origin: so atualiza as referencias remotas, nao mexe em nenhum arquivo (vale tambem na simulacao)."
    _git fetch origin >/dev/null 2>&1 \
        || falha "o 'git fetch origin' falhou em $ATU_REPO (sem internet, ou o GitHub nao respondeu), e preciso dele para conferir as personalizacoes contra a versao nova." \
                 "confira a internet (curl -I https://github.com) e rode de novo. Nada foi mudado."
    local base novo_arq pers_arq cruzados n_novos
    base="$(_git merge-base HEAD "$oficial" 2>/dev/null)" \
        || falha "nao achei o ponto em comum entre a branch '$ramo_pers' e '$oficial' em $ATU_REPO." \
                 "veja o historico: git -C $ATU_REPO log --oneline --graph --all -20. Nada foi mudado."
    novo_arq="$(_git diff --name-only "$base" "$oficial" | sort -u)"
    pers_arq="$( { _git diff --name-only "$base" HEAD; \
        printf '%s\n' "$ativas" | cut -f2 | while IFS= read -r f; do
            if [ -n "$f" ] && _git cat-file -e "HEAD:$f" 2>/dev/null; then printf '%s\n' "$f"; fi
        done; } | sort -u)"
    cruzados="$(comm -12 <(printf '%s\n' "$novo_arq" | grep . || true) <(printf '%s\n' "$pers_arq" | grep . || true))"
    n_novos="$(printf '%s\n' "$novo_arq" | grep -c . || true)"
    PERS_N_COMMITS="$(_git rev-list --count "$base..HEAD")"; export PERS_N_COMMITS
    PERS_N="$n_reg"; [ "$PERS_N" -gt 0 ] || PERS_N="$PERS_N_COMMITS"

    info "personalizacoes: $n_reg no registro, $PERS_N_COMMITS commit(s) na branch '$ramo_pers'; a versao nova muda $n_novos arquivo(s)."
    if [ "$base" = "$(_git rev-parse "$oficial")" ]; then
        export PERS_ATIVO=1
        ok "suas personalizacoes ja estao por cima da versao mais nova"
        return 0
    fi
    if [ -z "$cruzados" ]; then
        # Nao cruza por nome, mas pode conflitar mesmo assim (commit seguido de revert, por exemplo):
        # ensaia o rebase numa worktree descartavel, antes do backup.
        local conflitos erc=0
        conflitos="$(_pers_ensaio_rebase "$(_git rev-parse "$oficial")")" || erc=$?
        if [ "$erc" -eq 1 ]; then cruzados="$conflitos"; fi
    fi
    if [ -z "$cruzados" ]; then
        export PERS_ATIVO=1
        ok "nenhum arquivo personalizado e mexido pela versao nova; elas serao reaplicadas por cima"
        return 0
    fi

    local f t lista="" titulos="" arqs
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        t="$(printf '%s\n' "$ativas" | awk -F'\t' -v f="$f" '$2 == f { print $1 }' | _pers_juntar)"
        lista+="     $f: ${t:-(sem entrada no registro)}"$'\n'
        titulos+="$(printf '%s\n' "$ativas" | awk -F'\t' -v f="$f" '$2 == f { print $1 }')"$'\n'
    done <<<"$cruzados"
    titulos="$(printf '%s\n' "$titulos" | { grep . || true; } | sort -u | sed 's/.*/"&"/' | _pers_juntar)"
    arqs="$(printf '%s\n' "$cruzados" | _pers_juntar)"
    local frase
    if [ -z "$titulos" ]; then
        frase="Uma personalizacao do programa tem uma inconsistencia com esta atualizacao: a versao nova tambem mexe em $arqs. Posso ajustar a personalizacao para voce atualizar e manter tudo funcionando? Ate agora nada foi mudado."
    elif [ "$(printf '%s\n' "$titulos" | grep -o '" e "\|", "' | wc -l)" -gt 0 ]; then
        frase="As personalizacoes $titulos tem uma inconsistencia com esta atualizacao: a versao nova tambem mexe em $arqs. Posso ajustar as personalizacoes para voce atualizar e manter tudo funcionando? Ate agora nada foi mudado."
    else
        frase="A personalizacao $titulos tem uma inconsistencia com esta atualizacao: a versao nova tambem mexe em $arqs. Posso ajustar a personalizacao para voce atualizar e manter tudo funcionando? Ate agora nada foi mudado."
    fi
    local msg_cruza="a versao nova mexe em arquivo que uma personalizacao sua tambem mexeu, entao nao reaplico sozinho:
${lista%$'\n'}
   Frase pronta para o Admin repassar ao dono: \"$frase\""
    local oque_fazer="leia o capitulo \"Personalizacao que cruza com a versao nova\" em $DG_OPT/app/docs/ATUALIZAR.md; em resumo, guarde uma copia (git -C $ATU_REPO branch $ramo_pers-antes-\$(date +%Y%m%d)), reaplique a mao com git -C $ATU_REPO rebase $oficial resolvendo o conflito, atualize a entrada no registro ($reg) e rode sudo dgclaw atualizar de novo."
    if [ "${PERS_SO_CONFERIR:-0}" = 1 ]; then
        aviso "$msg_cruza"
        info "O que fazer: $oque_fazer Nada foi mudado."
        return 0
    fi
    falha "$msg_cruza" "nada foi mudado (parei antes do backup). Se o dono disser sim: $oque_fazer"
}

# _pers_ensaio_rebase <destino>: ensaia `git rebase <destino>` numa worktree descartavel (o clone, a
# branch e o app ficam como estao). Sai com 0 se encaixa, 1 se conflita (imprime os arquivos em
# conflito, um por linha) e 2 se nao deu para ensaiar (avisa). A worktree e so desta funcao e
# sempre e removida, com sucesso ou erro.
_pers_ensaio_rebase() {
    local destino="$1" tmp conf="" saida="" rc=0
    tmp="$(mktemp -d)" || { aviso "nao consegui criar uma pasta temporaria para ensaiar a reaplicacao das personalizacoes; sigo sem o ensaio (se houver conflito, a reaplicacao para depois do backup, sem perder nada)."; return 2; }
    if ! saida="$(_git worktree add --detach "$tmp" HEAD 2>&1)"; then
        aviso "nao consegui criar a worktree de ensaio em $tmp (git worktree add: $(printf '%s' "$saida" | tail -n 1)); sigo sem o ensaio da reaplicacao."
        rmdir "$tmp" 2>/dev/null || true
        _git worktree prune >/dev/null 2>&1 || true
        return 2
    fi
    if ! saida="$(git_do_clone "$tmp" -c user.name=dgclaw -c user.email=dgclaw@localhost -c core.hooksPath=/dev/null rebase "$destino" 2>&1)"; then
        conf="$(git_do_clone "$tmp" diff --name-only --diff-filter=U 2>/dev/null || true)"
        # So limpa a worktree de ensaio (ela e removida logo abaixo); o clone de verdade nao foi tocado.
        git_do_clone "$tmp" rebase --abort >/dev/null 2>&1 || true
        if [ -n "$conf" ]; then printf '%s\n' "$conf"; rc=1
        else
            aviso "o ensaio da reaplicacao falhou sem apontar arquivo em conflito ($(printf '%s' "$saida" | tail -n 2 | tr '\n' ' ')); sigo, mas a reaplicacao pode parar depois do backup."
            rc=2
        fi
    fi
    if ! _git worktree remove --force "$tmp" >/dev/null 2>&1; then
        aviso "nao consegui remover a worktree de ensaio $tmp; remova com: git -C $ATU_REPO worktree remove --force $tmp"
    fi
    _git worktree prune >/dev/null 2>&1 || true
    return "$rc"
}

# personalizacoes_trava_atualizar: duas atualizacoes ao mesmo tempo nao podem ler relatorios, baixar e
# instalar uma por cima da outra. Nao uso o DG_TRAVA (flock): o `dgclaw agente recriar` que a
# atualizacao chama por dentro pega essa mesma trava e esperaria 30 segundos por ela. Aqui a trava e
# uma pasta com o pid do dono, em /opt/dgclaw (fora de /etc/dgclaw, que o backup confere); pid que
# ja morreu e trava velha e e retomada.
personalizacoes_trava_atualizar() {
    [ "$ENSAIO" != 1 ] || return 0
    local dir="$DG_OPT/.atualizar.trava" dono=""
    ( umask 077; mkdir -p "$DG_OPT" ) || falha "nao consegui criar $DG_OPT para a trava da atualizacao." "confira a permissao e o espaco em disco e rode de novo. Nada foi mudado."
    if ! ( umask 077; mkdir "$dir" ) 2>/dev/null; then
        dono="$(cat "$dir/pid" 2>/dev/null || true)"
        if [ -n "$dono" ] && [ "$dono" != "$$" ] && kill -0 "$dono" 2>/dev/null && tr '\0' ' ' <"/proc/$dono/cmdline" 2>/dev/null | grep -q dgclaw; then
            falha "ja existe outra atualizacao do DG Claw rodando (pid $dono, trava $dir)." \
                  "espere ela terminar (systemctl list-units 'dgclaw-atualizar-*') e rode de novo. Se tiver certeza de que nao ha nenhuma, apague a pasta da trava: rmdir $dir (apague o arquivo pid dentro dela antes)."
        fi
    fi
    printf '%s\n' "$$" >"$dir/pid" || falha "nao consegui gravar o pid em $dir/pid." "confira a permissao de $DG_OPT e rode de novo. Nada foi mudado."
}

# personalizacoes_guardar_app <pasta do backup>: grava app.tar.gz (o programa instalado inteiro, sem
# node_modules) no backup e confere que abre. Assim --voltar tambem tem o programa de antes, mesmo
# quando o instalador do commit de destino e antigo e nao conhece a pasta de migracao.
personalizacoes_guardar_app() {
    local dest="$1" rc=0
    [ -d "$DG_APP" ] || { info "nao existe $DG_APP; o backup fica sem app.tar.gz."; return 0; }
    ( umask 077; tar -C "$DG_APP" --exclude=node_modules -czf "$dest/app.tar.gz" . ) || rc=$?
    if [ "$rc" -gt 1 ]; then
        falha "o tar nao conseguiu guardar o programa instalado ($DG_APP) em $dest/app.tar.gz (codigo $rc)." \
              "veja se ha espaco em disco (df -h $DG_BACKUPS) e rode de novo; nada foi mudado."
    fi
    tar -tzf "$dest/app.tar.gz" >/dev/null 2>&1 \
        || falha "o $dest/app.tar.gz foi criado, mas o tar nao consegue abri-lo (esta corrompido)." \
                 "nao sigo sem uma copia do programa que abre. Veja o espaco em disco (df -h) e rode de novo; nada foi mudado."
    chmod 600 "$dest/app.tar.gz"
}

# personalizacoes_reservar_pasta <caminho-base>: imprime uma pasta nova, reservada de forma atomica
# (mkdir sem -p num laco; ganha sufixo -2, -3... se o nome ja existir). Na simulacao so escolhe o nome.
personalizacoes_reservar_pasta() {
    local base="$1" n=1 pasta="$1"
    if [ "$ENSAIO" = 1 ]; then
        while [ -e "$pasta" ]; do n=$((n + 1)); pasta="$base-$n"; done
        printf '%s' "$pasta"; return 0
    fi
    ( umask 077; mkdir -p "$(dirname "$base")" ) \
        || falha "nao consegui criar $(dirname "$base")." "confira a permissao e o espaco em disco (df -h; ls -ld $(dirname "$base")) e rode de novo. Nada foi mudado."
    while ! ( umask 077; mkdir "$pasta" ) 2>/dev/null; do
        [ -e "$pasta" ] || falha "nao consegui criar a pasta $pasta." "confira a permissao e o espaco em disco (df -h; ls -ld $(dirname "$base")) e rode de novo. Nada foi mudado."
        n=$((n + 1)); pasta="$base-$n"
    done
    printf '%s' "$pasta"
}

# personalizacoes_baixar: no lugar do git pull, reaplica a branch por cima da versao nova.
personalizacoes_baixar() {
    local oficial ramo_pers copia antes depois n=1 base destino
    oficial="$(_pers_oficial)"; ramo_pers="$(_pers_ramo)"
    # O hash que o relatorio mostrou ao dono (ATU_DESTINO); sem ele, o que origin/main e agora.
    destino="${ATU_DESTINO:-$(_git rev-parse "$oficial")}"
    base="$(date +%Y%m%d-%H%M%S)"; copia="$ramo_pers-antes-$base"
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] guardaria a branch em $copia e reaplicaria $PERS_N personalizacao(oes) com git rebase $oficial"
        return 0
    fi
    antes="$(_git rev-parse HEAD)"
    if [ "$antes" = "$destino" ] || [ "$(_git merge-base HEAD "$destino")" = "$destino" ]; then
        ok "o clone ja esta na versao mais nova do GitHub, com as personalizacoes por cima (nada a reaplicar)"
        return 0
    fi
    while _git show-ref --verify --quiet "refs/heads/$copia"; do n=$((n + 1)); copia="$ramo_pers-antes-$base-$n"; done
    _git branch "$copia" HEAD || falha "nao consegui criar a branch de copia '$copia' em $ATU_REPO." \
        "confira o git do clone (git -C $ATU_REPO status). O backup ja foi feito; nada mais foi mudado."
    local erro
    if ! erro="$(_git -c user.name=dgclaw -c user.email=dgclaw@localhost rebase "$destino" 2>&1)"; then
        local aborto=""
        _git rebase --abort >/dev/null 2>&1 \
            || aborto=" ATENCAO: o 'git rebase --abort' tambem falhou; confira o clone com git -C $ATU_REPO status antes de qualquer coisa."
        falha "a reaplicacao das personalizacoes por cima da versao nova nao encaixou (git rebase ${destino:0:12} em $ATU_REPO): $(printf '%s' "$erro" | tail -n 3 | tr '\n' ' ')$aborto" \
              "a branch '$ramo_pers' ficou como estava, com uma copia em '$copia'. O backup ja foi feito e nada mais mudou. Leia o capitulo \"Personalizacao que cruza com a versao nova\" em $DG_OPT/app/docs/ATUALIZAR.md: com o sim do dono, reaplique a mao (git -C $ATU_REPO rebase $destino), atualize o registro $(personalizacoes_registro) e rode sudo dgclaw atualizar de novo."
    fi
    depois="$(_git rev-parse HEAD)"
    PERS_REAPLICADAS="$PERS_N"; PERS_COPIA="$copia"
    ok "reapliquei $PERS_N personalizacao(oes) por cima da versao nova: ${antes:0:10} -> ${depois:0:10} (copia de antes em $copia)"
}

# personalizacoes_linha_resumo: linhas do resumo final (nada se nao reaplicou).
personalizacoes_linha_resumo() {
    [ "${PERS_REAPLICADAS:-0}" -gt 0 ] || return 0
    printf '  Personalizacoes reaplicadas: %s (registro em %s). Teste cada uma pelo "Como testar" do registro.\n' "$PERS_REAPLICADAS" "$(personalizacoes_registro)"
    [ -z "$PERS_COPIA" ] || printf '  Copia das personalizacoes de antes: branch %s no clone\n' "$PERS_COPIA"
}

# --- marcador de levantamento pendente e o comando `dgclaw personalizacoes` ---------------------

_pers_dir_migracao() { printf '%s' "$DG_ADMIN/personalizacoes-migracao"; }

# personalizacoes_avisar_pendente: o instalador deixa PENDENTE quando guardou uma copia do app ou
# quando a instalacao e anterior ao registro. Nao bloqueia nada, so lembra.
personalizacoes_avisar_pendente() {
    local m; m="$(_pers_dir_migracao)/PENDENTE"
    [ -s "$m" ] || return 0
    aviso "ha um levantamento de personalizacoes pendente desde $(head -n 1 "$m" | cut -f1). O Admin deve rodar: sudo dgclaw personalizacoes levantar (e, ao terminar, sudo dgclaw personalizacoes concluir)."
}

# _pers_pasta_mais_recente: a pasta de migracao mais nova (a data esta no nome); cria uma se nao houver.
_pers_pasta_mais_recente() {
    local base pasta
    base="$(_pers_dir_migracao)"
    pasta="$(find "$base" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)"
    if [ -z "$pasta" ]; then
        pasta="$base/$(date +%Y%m%d-%H%M%S)"
        ( umask 077; install -d -m 700 "$DG_ADMIN" "$base" "$pasta" ) \
            || falha "nao consegui criar $pasta para guardar o levantamento." "confira a permissao e o espaco de $base e rode de novo."
    fi
    printf '%s' "$pasta"
}

# _pers_edicoes_claude <prefixo> ...: "data<TAB>arquivo<TAB>sessao" das edicoes do Admin (Claude) nos
# caminhos dados. SO caminho, data e nome da sessao: nunca o conteudo do arquivo nem da mensagem.
_pers_edicoes_claude() {
    local dir="$R/root/.claude/projects/-opt-dgclaw-admin" f
    [ -d "$dir" ] || return 0
    local prefixos; prefixos="$(printf '%s\n' "$@" | jq -R . | jq -sc .)"
    for f in "$dir"/*.jsonl; do
        [ -f "$f" ] || continue
        jq -r --argjson pre "$prefixos" --arg sessao "$(basename "$f" .jsonl)" '
            def citado($s): ($s | type) == "string" and ([$pre[] as $p | ($s | contains($p))] | any);
            select(.type == "assistant") | .timestamp as $t
            | (.message.content // [])[]? | select(.type == "tool_use")
            | if (.name == "Edit" or .name == "Write" or .name == "MultiEdit" or .name == "NotebookEdit") then
                  (.input.file_path // .input.notebook_path // empty) as $a
                  | select(citado($a)) | [$t, $a, $sessao] | @tsv
              elif .name == "Bash" then
                  # Do comando sai so o caminho citado: a linha inteira pode carregar uma chave.
                  # So tokens que COMECAM num prefixo, com caracteres de caminho (sem @, : ou =): o que vem
                  # depois de um @ ou de um = pode ser a chave inteira.
                  (.input.command // "") as $c
                  | select(citado($c))
                  | ([$pre[] as $p | $c | scan(($p | gsub("(?<k>[^A-Za-z0-9_/-])"; "\\\(.k)")) + "/[A-Za-z0-9._/+-]+")] | unique)[]
                  | [$t, ("(comando no terminal) " + .), $sessao] | @tsv
              else empty end' "$f" 2>/dev/null || printf '%s\t(nao consegui ler este arquivo de conversa)\t%s\n' "?" "$(basename "$f")"
    done
}

# _pers_edicoes_codex <prefixo> ...: o mesmo, a partir das sessoes do Codex (so caminhos e datas).
_pers_edicoes_codex() {
    local dir="$R/root/.codex/sessions" f p padrao ts linha
    [ -d "$dir" ] || return 0
    padrao="$(printf '%s\n' "$@" | sed 's/[][\.*^$/]/\\&/g' | paste -sd'|')"
    while IFS= read -r f; do
        while IFS= read -r linha; do
            ts="$(printf '%s' "$linha" | grep -oE '"timestamp":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
            while IFS= read -r p; do
                [ -n "$p" ] && printf '%s\t%s\t%s\n' "${ts:-?}" "$p" "$(basename "$f" .jsonl)"
            done < <(printf '%s' "$linha" | grep -oE "($padrao)/[A-Za-z0-9._/@+-]+" | sort -u)
        done < <(grep -aE "($padrao)/" "$f" 2>/dev/null || true)
    done < <(find "$dir" -type f -name '*.jsonl' 2>/dev/null | sort)
}

# _pers_stashes <clone>: um bloco por stash com a data, a mensagem (SO se for dgclaw-atualizar-*; senao
# "(mensagem omitida)") e os nomes dos arquivos. Nunca o conteudo.
_pers_stashes() {
    local repo="$1" ref data msg arqs achou=0
    while IFS= read -r ref; do
        [ -n "$ref" ] || continue
        achou=1
        data="$(git_do_clone "$repo" log -1 --format='%ad' --date=short "$ref" 2>/dev/null || printf '?')"
        msg="$(git_do_clone "$repo" log -1 --format='%s' "$ref" 2>/dev/null || true)"
        if ! [[ "$msg" =~ ^(On\ [^:]+:\ )?dgclaw-atualizar-[0-9-]+$ ]]; then msg="(mensagem omitida)"; fi
        printf '    %s %s %s\n' "$ref" "$data" "$msg"
        arqs="$(git_do_clone "$repo" stash show --name-only --include-untracked "$ref" 2>/dev/null \
            || git_do_clone "$repo" stash show --name-only "$ref" 2>/dev/null || true)"
        if [ -n "$arqs" ]; then printf '%s\n' "$arqs" | sed 's/^/        /'; fi
    done < <(git_do_clone "$repo" stash list --format='%gd' 2>/dev/null || true)
    if [ "$achou" = 0 ]; then printf '    (nenhuma)\n'; fi
}

# personalizacoes_levantar: LEVANTAMENTO.md na pasta de migracao mais recente (e na tela).
personalizacoes_levantar() {
    local pasta saida repo="${DGCLAW_REPO:-}" reg commit branch sujo n_ativas l prefixos=("/opt/dgclaw/app")
    pasta="$(_pers_pasta_mais_recente)"; saida="$pasta/LEVANTAMENTO.md"; reg="$(personalizacoes_registro)"
    commit="$(_env_de "$DG_ETC/dgclaw.env" DGCLAW_COMMIT)"
    [ -z "$repo" ] || [ ! -d "$repo" ] || prefixos+=("$repo")
    {
        printf '# Levantamento de personalizacoes do programa\n\nGerado em %s. So caminhos e datas: nenhum conteudo de arquivo ou de conversa.\n\n' "$(date '+%d/%m/%Y %H:%M:%S')"

        printf '## 1. O registro\n\n'
        if [ -f "$reg" ]; then
            n_ativas="$(personalizacoes_ler | cut -f1 | sort -u | grep -c . || true)"
            printf -- '- %s existe, com %s entrada(s) ativa(s).\n' "$reg" "$n_ativas"
        else
            printf -- '- %s NAO existe. Rode ./install.sh do clone novo para criar o modelo.\n' "$reg"
        fi

        printf '\n## 2. O clone\n\n'
        if [ -n "$repo" ] && git_do_clone "$repo" rev-parse --git-dir >/dev/null 2>&1; then
            branch="$(git_do_clone "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
            printf -- '- Clone: %s, branch: %s\n' "$repo" "${branch:-desconhecida}"
            sujo="$(git_do_clone "$repo" status --porcelain 2>/dev/null || true)"
            printf -- '- Alteracoes nao commitadas:\n%s\n' "${sujo:+$(printf '%s\n' "$sujo" | sed 's/^/    /')}"
            [ -n "$sujo" ] || printf '    (nenhuma)\n'
            # Mensagem de commit e de stash pode carregar segredo colado pelo Admin: so hash, data e nomes de arquivo.
            printf -- '- Commits locais que nao estao no GitHub (hash, data e arquivos; sem a mensagem):\n'
            l="$(git_do_clone "$repo" log --branches --not --remotes --format='%h %ad' --date=short --name-only 2>/dev/null | { grep . || true; } || true)"
            if [ -n "$l" ]; then printf '%s\n' "$l" | sed 's/^/    /'; else printf '    (nenhum)\n'; fi
            printf -- '- Alteracoes guardadas (git stash; a mensagem so aparece quando e uma dgclaw-atualizar-*, das atualizacoes antigas):\n'
            _pers_stashes "$repo"
            printf -- '- Arquivos que diferem entre o commit instalado (%s) e o HEAD:\n' "${commit:0:12}"
            if [ -n "$commit" ]; then
                l="$(git_do_clone "$repo" diff --name-only "$commit" HEAD 2>/dev/null || true)"
                if [ -n "$l" ]; then printf '%s\n' "$l" | sed 's/^/    /'; else printf '    (nenhum)\n'; fi
            else
                printf '    (o dgclaw.env nao anota o commit instalado; nao tenho como comparar)\n'
            fi
        else
            printf -- '- Nao achei o clone git (DGCLAW_REPO=%s). Esta parte ficou de fora.\n' "${repo:-vazio}"
        fi

        printf '\n## 3. Copias guardadas pelo instalador\n\n'
        local lista achou=0
        while IFS= read -r lista; do
            achou=1
            printf -- '- %s\n' "$(dirname "$lista")"
            sed 's/^/    /' "$lista"
        done < <(find "$(_pers_dir_migracao)" -mindepth 2 -maxdepth 2 -name LISTA.txt 2>/dev/null | sort)
        [ "$achou" = 1 ] || printf -- '- (nenhuma)\n'

        printf '\n## 4. Arquivos que o Admin editou, segundo as conversas dele\n\n'
        printf 'Formato: data, arquivo, sessao.\n\n'
        if command -v jq >/dev/null 2>&1; then
            printf '### Claude\n\n'
            l="$(_pers_edicoes_claude "${prefixos[@]}" | sort -u)"
            if [ -n "$l" ]; then printf '%s\n' "$l" | awk -F'\t' '{ printf "- %s  %s  (sessao %s)\n", $1, $2, $3 }'; else printf -- '- (nenhuma)\n'; fi
        else
            printf -- '- A parte do Claude ficou de fora: o jq nao esta instalado (apt-get install -y jq).\n'
        fi
        printf '\n### Codex\n\n'
        l="$(_pers_edicoes_codex "${prefixos[@]}" | sort -u)"
        if [ -n "$l" ]; then printf '%s\n' "$l" | awk -F'\t' '{ printf "- %s  %s  (sessao %s)\n", $1, $2, $3 }'; else printf -- '- (nenhuma)\n'; fi
    } >"$saida" || falha "nao consegui gravar o levantamento em $saida." "confira o espaco e a permissao de $pasta e rode de novo."
    chmod 600 "$saida"
    cat "$saida"
    printf '\n(gravado em %s)\n' "$saida"
}

# personalizacoes_concluir: o levantamento terminou; troca o marcador PENDENTE por CONCLUIDO-<data>.
personalizacoes_concluir() {
    local dir m novo reg; dir="$(_pers_dir_migracao)"; m="$dir/PENDENTE"; reg="$(personalizacoes_registro)"
    [ -f "$reg" ] || falha "o registro de personalizacoes nao existe ($reg), entao nao dou o levantamento por concluido." \
        "crie o registro (rode ./install.sh do clone, que copia o modelo) e escreva nele as personalizacoes que o levantamento achou; depois rode: sudo dgclaw personalizacoes concluir"
    if [ ! -e "$m" ]; then ok "nao havia levantamento pendente; nada a fazer"; return 0; fi
    novo="$dir/CONCLUIDO-$(date +%Y%m%d-%H%M%S)"
    mv "$m" "$novo" || falha "nao consegui renomear $m para $novo." "confira a permissao de $dir."
    ok "levantamento concluido: $m virou $novo"
}

personalizacoes_main() {
    local sub="${1:-}"; [ $# -eq 0 ] || shift
    case "$sub" in
        levantar|conferir|concluir) ;;
        "") falha "faltou dizer o que fazer com as personalizacoes." "use: levantar, conferir ou concluir (veja dgclaw --ajuda)." ;;
        *) falha "'personalizacoes $sub' nao existe." "use: levantar, conferir ou concluir (veja dgclaw --ajuda)." ;;
    esac
    [ $# -eq 0 ] || falha "'personalizacoes $sub' nao recebe argumentos (veio: $*)." "rode so: sudo dgclaw personalizacoes $sub"
    exigir_ferramentas git
    carregar_env_dgclaw
    case "$sub" in
        levantar) personalizacoes_levantar ;;
        concluir) personalizacoes_concluir ;;
        conferir)
            ATU_SEM_BAIXAR=0; ATU_FORCAR_LOCAL=0; ATU_MODO=conferir; PERS_SO_CONFERIR=1
            atualizar_achar_repo ""
            personalizacoes_conferir ;;
    esac
}

# --- "o que muda": o dono le (e autoriza) antes de qualquer atualizacao ---------------------------

# _om_motivos <arquivo>: por que mexer neste arquivo merece atencao (um motivo por linha; vazio = nenhum).
_om_motivos() {
    local f="$1" b
    b="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"
    case "$f" in
        install.sh) echo "e o instalador: roda como root e mexe na maquina inteira" ;;
        lib/firewall.sh) echo "regras de rede e isolamento dos agentes" ;;
        lib/*) echo "instalador e comandos de administracao (rodam como root)" ;;
        container/*) echo "o que o agente enxerga dentro da caixa" ;;
        hooks/*|*/hooks/*) echo "ganchos de seguranca" ;;
        bin/*) echo "comandos do dgclaw" ;;
        web/server.js|panel/server.js) echo "rotas novas podem abrir acesso ao painel" ;;
    esac
    case "$b" in
        *cofre*|*segredo*|*token*|*senha*|*auth*|*login*|*sessao*|*proxy*) echo "credenciais e acesso" ;;
        *.sql|*banco*|*db*|*migr*) echo "dados (banco, migracao)" ;;
    esac
}

# _om_relatorio <origem> <destino>: o texto do relatorio, em ASCII, no stdout.
_om_relatorio() {
    local de="$1" para="$2" head="${3:-}" novos n lista linhas stat f motivos pontos="" np=0 max=40 velho
    printf 'O QUE MUDA NA ATUALIZACAO\n'
    if [ -z "$de" ]; then
        # Sem o commit instalado (ou sem ponto em comum) nao ha intervalo para listar: mostra o que der.
        printf '  Nao sei qual versao esta instalada, entao nao consigo dizer o que muda. A versao de destino e %s.\n\n' "${para:0:10}"
        printf 'Ultimos commits da versao de destino:\n'
        _git log --oneline --no-merges -n 10 "$para" | sed 's/^/  /'
        stat=""
    else
        n="$(_git rev-list --count --no-merges "$de..$para")"
        printf '  de %s para %s (%s commit(s))\n\n' "${de:0:10}" "${para:0:10}" "$n"
        printf 'Commits novos:\n'
        lista="$(_git log --oneline --no-merges "$de..$para")"
        printf '%s\n' "$lista" | head -n "$max" | sed 's/^/  /'
        linhas="$(printf '%s\n' "$lista" | grep -c . || true)"
        if [ "$linhas" -gt "$max" ]; then printf '  e mais %s\n' "$((linhas - max))"; fi
        stat="$(_git diff --stat "$de" "$para" | tail -n 1)"
    fi
    printf '\nTamanho: %s\n' "${stat:-sem diferenca de arquivos}"
    if [ -n "$head" ] && [ -n "$de" ] && [ "$head" != "$para" ]; then
        # Branch das personalizacoes: o que sera instalado e o HEAD reaplicado por cima do destino.
        printf '\nNo seu clone (branch das personalizacoes), ainda nao instalado (hash, data e arquivos):\n'
        _git log --format='%h %ad' --date=short --name-only "$de..$head" | { grep . || true; } | head -n "$max" | sed 's/^/  /'
    fi

    printf '\nItens novos no CHANGELOG:\n'
    if novos="$(_om_changelog "$de" "$para")"; then
        if [ -n "$novos" ]; then printf '%s\n' "$novos" | sed 's/^/  /'; else printf '  (nenhum item novo no CHANGELOG)\n'; fi
    else
        printf '  (nao consegui ler o CHANGELOG.md da versao nova; leia os commits acima)\n'
    fi

    printf '\nPontos de atencao:\n'
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        motivos="$(_om_motivos "$f" | _pers_juntar)"
        [ -n "$motivos" ] || continue
        np=$((np + 1))
        if [ "$np" -le "$max" ]; then pontos+="  $f: $motivos"$'\n'; fi
    done < <(_git diff --name-only "$de" "$para")
    if [ "$np" -eq 0 ]; then printf '  nenhum arquivo de area sensivel foi alterado.\n'
    else
        printf '%s' "$pontos"
        if [ "$np" -gt "$max" ]; then printf '  e mais %s arquivo(s)\n' "$((np - max))"; fi
    fi
    velho="$(personalizacoes_registro)"
    printf '\nSuas personalizacoes estao no registro %s.\n' "$velho"
    printf '\nVersao de destino (para conferencia, nao precisa ler):\nDESTINO=%s\n' "$para"
    if [ -n "$head" ]; then printf 'HEAD=%s\n' "$head"; fi
    printf '\nAntes de instalar: leia o que muda, diga ao dono em linguagem simples se ve algum risco para os arquivos, os dados ou as personalizacoes dele e espere o ok. Com o ok: sudo dgclaw atualizar --ok-do-dono --segundo-plano\n'
}

# _om_changelog <origem> <destino>: linhas de item que o CHANGELOG do destino tem e o da origem nao
# (so as duas primeiras secoes: [Nao lancado] e a ultima versao). Falha se nao conseguir ler o novo.
_om_changelog() {
    local novo velho
    novo="$(_git show "$2:CHANGELOG.md" 2>/dev/null)" || return 1
    velho="$(_git show "$1:CHANGELOG.md" 2>/dev/null || true)"
    printf '%s\n' "$novo" | awk '/^## /{s++} s>=1 && s<=2' | grep -E '^[-*] ' \
        | grep -vxF -f <(printf '%s\n' "$velho") | cut -c1-200 | head -n 30 || true
}

# _om_exigir_ok <motivo> <arquivo do relatorio ou vazio>: sem --ok-do-dono (e fora da simulacao),
# para aqui, antes do backup.
_om_exigir_ok() {
    local motivo="$1" arq="${2:-}"
    if [ "${ATU_OK_DONO:-0}" = 1 ]; then ok "ok do dono recebido (--ok-do-dono): sigo com a atualizacao"; return 0; fi
    if [ "$ENSAIO" = 1 ]; then
        info "a atualizacao de verdade vai exigir --ok-do-dono, depois que o dono ler o relatorio acima."
        return 0
    fi
    falha "$motivo e eu ainda nao tenho o ok do dono.${arq:+ O relatorio esta em $arq.}" \
          "mostre ${arq:+o relatorio }ao dono em linguagem simples (diga se ve risco para os arquivos, os dados ou as personalizacoes dele), espere o ok e rode: sudo dgclaw atualizar --ok-do-dono --segundo-plano. Nada foi mudado (parei antes do backup)."
}

# atualizar_o_que_muda: roda antes do backup. Mostra o que a versao nova traz e, sempre que o que vai ser
# instalado difere do instalado (ou nao da para saber), nao deixa a atualizacao de verdade seguir sem
# o ok do dono (--ok-do-dono). Define ATU_DESTINO: o hash EXATO que o relatorio mostrou e que o passo de
# baixar instala. Com --ok-do-dono, se a versao mudou desde o relatorio que o dono viu, para e pede
# que ele veja o novo.
atualizar_o_que_muda() {
    local de="" real="" para="" head="" ramo n arq ts sem_base=0 difere=0 por_que="" prev prev_dest prev_arq
    ATU_DESTINO=""
    ATU_ETAPA="lendo o que muda"
    passo "Lendo o que a versao nova muda (antes de instalar qualquer coisa)"
    if ! git_do_clone "$ATU_REPO" rev-parse --git-dir >/dev/null 2>&1; then
        aviso "o clone $ATU_REPO nao e um repositorio git: nao tenho como listar o que muda."
        _om_exigir_ok "nao consigo ler o que a atualizacao muda (sem git)" ""
        return 0
    fi
    if [ "${PERS_ATIVO:-0}" = 1 ]; then
        para="$(_git rev-parse "$(_pers_oficial)" 2>/dev/null || true)"
        head="$(_git rev-parse HEAD 2>/dev/null || true)"
    elif [ "$ATU_SEM_BAIXAR" = 1 ]; then
        para="$(_git rev-parse HEAD 2>/dev/null || true)"
    else
        _git fetch >/dev/null 2>&1 \
            || falha "o 'git fetch' falhou em $ATU_REPO (sem internet, ou o GitHub nao respondeu), e preciso dele para ler o que a versao nova muda." \
                     "confira a internet (curl -I https://github.com) e rode de novo. Nada foi mudado."
        ramo="$(_git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
        para="$(_git rev-parse '@{u}' 2>/dev/null || true)"
        if [ -z "$para" ]; then
            aviso "a branch '${ramo:-solta}' do clone nao acompanha nenhuma branch remota; leio o que muda contra origin/${DGCLAW_RAMO_OFICIAL:-main}. O download vai reclamar disso depois, se for o caso."
            para="$(_git rev-parse "origin/${DGCLAW_RAMO_OFICIAL:-main}" 2>/dev/null || true)"
        fi
    fi
    if [ -z "$para" ]; then
        aviso "nao achei a versao de destino para ler o que muda."
        _om_exigir_ok "nao consegui descobrir a versao de destino da atualizacao" ""
        return 0
    fi
    ATU_DESTINO="$para"

    # O instalado de verdade. "HEAD do clone" e so um palpite do atualizar_descobrir_commit_antigo: sem base.
    real="${ATU_COMMIT_ANTIGO:-}"
    if [ -z "$real" ] || [ "${ATU_COMMIT_ORIGEM:-}" = "HEAD do clone" ] || ! _git cat-file -e "$real^{commit}" 2>/dev/null; then
        sem_base=1; real=""
    fi
    if [ "$sem_base" = 1 ]; then
        difere=1; por_que="nao sei qual versao esta instalada"
    elif [ "${PERS_ATIVO:-0}" = 1 ]; then
        # Duas pontas: o destino oficial e o HEAD (o oficial com as personalizacoes por cima).
        if [ "$(_git rev-list --count "$real..$para" 2>/dev/null || printf 1)" -gt 0 ] || [ "$(_git rev-list --count "$real..$head" 2>/dev/null || printf 1)" -gt 0 ]; then
            difere=1; por_que="ha commits novos do GitHub ou das personalizacoes que ainda nao estao instalados"
        fi
    elif [ "$para" != "$real" ]; then
        difere=1; por_que="a versao de destino e diferente da instalada"
    fi
    if [ "$difere" = 0 ]; then ok "nada novo para instalar"; return 0; fi

    de="$real"
    if [ -z "$de" ]; then
        de="$(_git merge-base HEAD "$para" 2>/dev/null || true)"
    elif ! _git merge-base --is-ancestor "$de" "$para" 2>/dev/null; then
        de="$(_git merge-base "$de" "$para" 2>/dev/null || true)"
    fi

    ts="$(date +%Y%m%d-%H%M%S)"
    arq="${DGCLAW_ATUALIZAR_LOG:+${DGCLAW_ATUALIZAR_LOG%.log}.o-que-muda.txt}"
    arq="${arq:-$DG_LOG/dgclaw-atualizar-$ts.o-que-muda.txt}"
    # O relatorio mais recente que existia ANTES deste (o que o dono pode ter visto): le agora, antes de gravar o novo.
    prev_dest=""; prev_arq=""
    prev="$(find "$(dirname "$arq")" -maxdepth 1 -name '*.o-que-muda.txt' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2- || true)"
    if [ -n "$prev" ]; then
        prev_arq="$prev"; prev_dest="$(sed -n 's/^DESTINO=//p' "$prev" | head -n 1)"
    fi
    ( umask 027; mkdir -p "$DG_LOG"; _om_relatorio "$de" "$para" "$head" >"$arq" ) \
        || falha "nao consegui gravar o relatorio em $arq." "confira a pasta e o espaco em disco (ls -ld $DG_LOG; df -h $DG_LOG). Nada foi mudado."
    cat "$arq"
    info "relatorio gravado em $arq"
    if [ "${ATU_OK_DONO:-0}" = 1 ] && [ -n "$prev_dest" ] && [ "$prev_dest" != "$para" ]; then
        # Relatorio velho de uma atualizacao que ja foi instalada nao conta como "o que o dono viu".
        if [ -n "$real" ] && { [ "$prev_dest" = "$real" ] || _git merge-base --is-ancestor "$prev_dest" "$real" 2>/dev/null; }; then
            prev_dest=""
        else
            falha "a versao a instalar mudou desde o relatorio que foi mostrado ao dono (antes ${prev_dest:0:10}, em $prev_arq; agora ${para:0:10}). O relatorio novo ja foi gravado em $arq." \
                  "mostre o relatorio novo (acima) ao dono em linguagem simples, espere o ok e rode de novo: sudo dgclaw atualizar --ok-do-dono --segundo-plano. Nada foi mudado (parei antes do backup)."
        fi
    fi
    n="$(_git rev-list --count --no-merges "${de:-$para}..$para" 2>/dev/null || printf 0)"
    _om_exigir_ok "a atualizacao muda o que esta instalado ($por_que; $n commit(s) novo(s) no GitHub)" "$arq"
}
