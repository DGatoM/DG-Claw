#!/usr/bin/env bash
# lib/assinatura.sh: a atualizacao so instala versao ASSINADA pela chave do projeto.
#
# Carregado com `source` pelo bin/dgclaw (junto com lib/atualizar.sh), nunca executado. Usa as
# funcoes de lib/comum.sh e de lib/atualizar.sh (falha, ok, info, aviso, _git).
# shellcheck disable=SC2154
#
# O problema: o `dgclaw atualizar` baixa o codigo do GitHub e roda o install.sh dele como root. Quem
# controlasse o repositorio (ou o clone) executaria codigo como root em todo servidor. A defesa e a
# assinatura: a versao so e instalada se a TAG de release (vX.Y.Z) tiver uma assinatura SSH valida
# de uma chave que ja estava no codigo instalado.
#
# Modelo de confianca:
#   - A ANCORA (a chave que vale) fica FORA do clone, em $DG_ETC/assinatura/allowed_signers (so root grava),
#     junto com dois marcadores: "ativada" (a protecao ja foi ligada nesta maquina, entao nao existe volta
#     para a adocao) e "instalado" (o commit que foi instalado depois de conferido). O clone nao e fonte de
#     confianca: quem mexe no clone nao muda a ancora. A ancora so e atualizada por uma versao assinada pela
#     chave que ja valia (troca de chave) e so depois de o instalador dessa versao terminar com sucesso.
#   - A chave publica tambem viaja no repositorio, em seguranca/assinatura/allowed_signers, mas so como
#     CANDIDATA: entra na ancora quando a versao que a traz foi aceita (assinada pela chave anterior, ou
#     na primeira adocao).
#   - Primeira adocao: quem ainda nao tem a ancora nao tem como conferir a versao que a traz. Esse e o unico
#     momento sem verificacao: o aviso mostra a impressao digital da chave que passa a valer, para
#     conferir com a que o Danilo divulgou FORA do repositorio. Quem quer evitar ate isso entrega o
#     arquivo de fora com --chave-assinatura, ou recusa a adocao com --exigir-assinatura.
#   - So assinatura SSH vale: tag assinada em outro formato (OpenPGP, X.509) e recusada, e o git roda sem
#     config global nem de sistema, sem hooks, com o programa de assinatura e o arquivo de chaves fixados
#     na linha de comando.
#   - Antes de rodar o instalador como root, o clone tem que estar exatamente na versao assinada e sem
#     arquivo rastreado alterado (conferido com um indice novo, que ignora skip-worktree).
#   - Nao existe opcao para "pular a assinatura". Quem precisa instalar algo sem assinatura atualiza o
#     clone a mao e usa --sem-baixar, sabendo o que esta fazendo.
# Passo a passo de quem assina e de quem atualiza: docs/ASSINATURA.md.

ASS_ARQ_REL="seguranca/assinatura/allowed_signers"
ASS_DIR="$DG_ETC/assinatura"
ASS_ANCORA="$ASS_DIR/allowed_signers"    # a chave que vale (fora do clone)
ASS_ATIVADA="$ASS_DIR/ativada"           # existe = a protecao ja foi ligada: nao volta para a adocao
ASS_INSTALADO="$ASS_DIR/instalado"       # o commit instalado depois de conferido
ATU_ASSINATURA=""          # ativa | adocao (vazio = nao conferido, ex.: --sem-baixar)
ATU_ASSINATURA_TAG=""      # a tag assinada que foi aceita
ATU_ASSINATURA_CHAVE=""    # arquivo temporario com o allowed_signers que serve de ancora
ATU_EXIGIR_ASSINATURA=0
ATU_CHAVE_EXTERNA=""
ASS_DESTINO=""             # o commit da tag assinada aceita (vazio = nao se aplica)

# _ass_git <argumentos>: git no clone, neutralizado para verificar assinatura.
_ass_git() {
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
        git -c safe.directory="$ATU_REPO" -C "$ATU_REPO" \
        -c core.hooksPath=/dev/null -c core.fsmonitor=false \
        -c gpg.format=ssh -c gpg.ssh.program="$(command -v ssh-keygen)" \
        -c gpg.program=/bin/false -c gpg.x509.program=/bin/false \
        -c gpg.ssh.allowedSignersFile="$ATU_ASSINATURA_CHAVE" "$@"
}

assinatura_limpar() {
    if [ -n "$ATU_ASSINATURA_CHAVE" ]; then rm -f "$ATU_ASSINATURA_CHAVE"; fi
    ATU_ASSINATURA_CHAVE=""
}

# _ass_impressoes <arquivo allowed_signers>: uma linha por chave, com a impressao digital (SHA256:...).
_ass_impressoes() {
    local arq="$1" linha chave tmp
    command -v ssh-keygen >/dev/null 2>&1 || { printf '(sem ssh-keygen para calcular a impressao digital)\n'; return 0; }
    while IFS= read -r linha; do
        case "$linha" in ''|'#'*) continue ;; esac
        # a chave e o primeiro campo que comeca com um tipo ssh (ssh-ed25519, sk-ssh-..., ecdsa-...)
        chave="$(printf '%s\n' "$linha" | awk '{for (i = 1; i < NF; i++) if ($i ~ /^(ssh-|sk-ssh-|ecdsa-sha2-)/) {print $i " " $(i + 1); exit}}')"
        [ -n "$chave" ] || { printf '(linha que nao consegui ler como chave)\n'; continue; }
        tmp="$(mktemp)" || continue
        printf '%s\n' "$chave" >"$tmp"
        ssh-keygen -lf "$tmp" 2>/dev/null | awk '{print $2}' || printf '(chave invalida)\n'
        rm -f "$tmp"
    done <"$arq"
}

# _ass_chaves_validas <arquivo>: tem pelo menos uma chave que o ssh-keygen le, e nenhuma linha vira
# autoridade certificadora (cert-authority aceitaria qualquer chave que ela assine).
_ass_chaves_validas() {
    local arq="$1" linha chave tmp n=0
    [ -s "$arq" ] || return 1
    command -v ssh-keygen >/dev/null 2>&1 || return 1
    while IFS= read -r linha || [ -n "$linha" ]; do
        case "$linha" in ''|'#'*) continue ;; esac
        case "$linha" in *cert-authority*) return 1 ;; esac
        chave="$(printf '%s\n' "$linha" | awk '{for (i = 1; i < NF; i++) if ($i ~ /^(ssh-|sk-ssh-|ecdsa-sha2-)/) {print $i " " $(i + 1); exit}}')"
        [ -n "$chave" ] || return 1
        tmp="$(mktemp)" || return 1
        printf '%s\n' "$chave" >"$tmp"
        if ssh-keygen -lf "$tmp" >/dev/null 2>&1; then n=$((n + 1)); else rm -f "$tmp"; return 1; fi
        rm -f "$tmp"
    done <"$arq"
    [ "$n" -ge 1 ]
}

# _ass_ancora: monta o arquivo de chaves que serve de ancora. Origem, na ordem: o arquivo que a pessoa
# entregou (--chave-assinatura) e a ancora gravada em $ASS_ANCORA (fora do clone). Nunca o clone.
_ass_ancora() {
    assinatura_limpar
    local tmp
    tmp="$(mktemp)" || falha "nao consegui criar um arquivo temporario para a chave de assinatura." \
        "confira o espaco em disco e a permissao de /tmp; nada foi mudado."
    chmod 600 "$tmp"
    if [ -n "$ATU_CHAVE_EXTERNA" ]; then
        if [ ! -s "$ATU_CHAVE_EXTERNA" ]; then
            rm -f "$tmp"
            falha "o arquivo de chaves '$ATU_CHAVE_EXTERNA' (--chave-assinatura) nao existe ou esta vazio." \
                  "peca a quem mantem o DG Claw o arquivo allowed_signers e passe o caminho certo. Nada foi mudado."
        fi
        cp "$ATU_CHAVE_EXTERNA" "$tmp"
        if ! _ass_chaves_validas "$tmp"; then
            rm -f "$tmp"
            falha "o arquivo de chaves '$ATU_CHAVE_EXTERNA' nao tem nenhuma chave valida (ou tem uma linha cert-authority, que nao e aceita)." \
                  "peca a quem mantem o DG Claw o allowed_signers certo (veja docs/ASSINATURA.md). Nada foi mudado."
        fi
        ATU_ASSINATURA_CHAVE="$tmp"
        ASS_ORIGEM="o arquivo que voce entregou ($ATU_CHAVE_EXTERNA)"
        return 0
    fi
    if [ -s "$ASS_ANCORA" ]; then
        cp "$ASS_ANCORA" "$tmp"
        if ! _ass_chaves_validas "$tmp"; then
            rm -f "$tmp"
            falha "a chave de assinatura gravada em $ASS_ANCORA esta ilegivel ou invalida." \
                  "nao instalei nada. Entregue o arquivo de fora: sudo dgclaw atualizar --exigir-assinatura --chave-assinatura <allowed_signers> (veja docs/ASSINATURA.md)."
        fi
        ATU_ASSINATURA_CHAVE="$tmp"
        ASS_ORIGEM="a chave gravada nesta maquina ($ASS_ANCORA)"
        return 0
    fi
    rm -f "$tmp"
    ATU_ASSINATURA_CHAVE=""
    if [ -e "$ASS_ATIVADA" ]; then
        falha "esta maquina ja confere a assinatura das versoes (marcador $ASS_ATIVADA), mas a chave gravada ($ASS_ANCORA) sumiu ou esta vazia. Voltar ao modo sem conferencia nao e permitido." \
              "nao instalei nada. Se foi voce quem apagou, entregue o arquivo de fora: sudo dgclaw atualizar --exigir-assinatura --chave-assinatura <allowed_signers>. Se nao foi, trate como incidente e avise quem mantem o DG Claw."
    fi
    return 0
}

# _ass_tag_ssh <tag>: a assinatura da tag e SSH (nao OpenPGP nem X.509).
_ass_tag_ssh() {
    local obj
    obj="$(_ass_git cat-file tag "refs/tags/$1" 2>/dev/null)" || return 1
    printf '%s\n' "$obj" | grep -q -- '^-----BEGIN SSH SIGNATURE-----' || return 1
    ! printf '%s\n' "$obj" | grep -qE -- '^-----BEGIN (PGP|SIGNED MESSAGE)'
}

# _ass_tag_valida <tag>: assinatura SSH valida pela ancora. Devolve a saida do git em ASS_SAIDA.
_ass_tag_valida() {
    ASS_SAIDA=""
    _ass_tag_ssh "$1" || return 1
    ASS_SAIDA="$(_ass_git verify-tag "$1" 2>&1)"
}

# _ass_commit_chaves <commit>: o arquivo de chaves do commit e valido (existe, tem chave, sem cert-authority).
_ass_commit_chaves() {
    local tmp rc=1
    tmp="$(mktemp)" || return 1
    if _ass_git show "$1:$ASS_ARQ_REL" >"$tmp" 2>/dev/null && _ass_chaves_validas "$tmp"; then rc=0; fi
    rm -f "$tmp"
    return $rc
}

# _ass_head_autenticado <HEAD>: o que esta no clone ja foi autenticado antes: e o commit gravado em
# $ASS_INSTALADO, ou e o commit de uma tag assinada valida, ou (com personalizacoes) e a ultima versao
# autenticada com os commits do proprio dono por cima.
_ass_head_autenticado() {
    local head="$1" inst="" t c
    [ -s "$ASS_INSTALADO" ] && inst="$(head -n 1 "$ASS_INSTALADO")"
    [[ "$inst" =~ ^[0-9a-f]{40}$ ]] || inst=""
    if [ -n "$inst" ] && [ "$head" = "$inst" ]; then return 0; fi
    if [ "${PERS_ATIVO:-0}" = 1 ] && [ -n "$inst" ] && _ass_git merge-base --is-ancestor "$inst" "$head" 2>/dev/null; then return 0; fi
    for t in $(_ass_git for-each-ref --format='%(refname:strip=2)' 'refs/tags/v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true); do
        c="$(_ass_git rev-parse --verify --quiet "refs/tags/$t^{commit}")" || continue
        [ "$c" = "$head" ] || continue
        if _ass_tag_valida "$t"; then return 0; fi
    done
    return 1
}

# _ass_persistir <arquivo de chaves> [commit]: grava a ancora, o marcador "ativada" e (se vier) o commit instalado.
_ass_persistir() {
    ( umask 022; mkdir -p "$ASS_DIR" && chmod 755 "$ASS_DIR" \
        && cp "$1" "$ASS_ANCORA.novo" && chmod 644 "$ASS_ANCORA.novo" && mv -f "$ASS_ANCORA.novo" "$ASS_ANCORA" \
        && date +%Y-%m-%d >"$ASS_ATIVADA" \
        && { [ -z "${2:-}" ] || { printf '%s\n' "$2" >"$ASS_INSTALADO.novo" && mv -f "$ASS_INSTALADO.novo" "$ASS_INSTALADO"; }; } )
}

# assinatura_persistir_antes: com a chave entregue de fora (--chave-assinatura) e ainda sem ancora gravada, grava a ancora e
# o marcador ANTES do instalador: se nao der, nada e instalado (senao a proxima rodada voltaria para a adocao).
assinatura_persistir_antes() {
    [ "$ATU_ASSINATURA" = ativa ] && [ "$ENSAIO" != 1 ] || return 0
    [ -n "$ATU_CHAVE_EXTERNA" ] && [ -s "$ATU_ASSINATURA_CHAVE" ] || return 0
    if [ -s "$ASS_ANCORA" ] && [ -e "$ASS_ATIVADA" ]; then return 0; fi
    _ass_persistir "$ATU_ASSINATURA_CHAVE" "" \
        || falha "nao consegui gravar a chave de assinatura em $ASS_DIR antes de instalar; sem ela o DG Claw voltaria a atualizar sem conferir." \
                 "confira a permissao e o espaco de $DG_ETC e rode de novo. Nada foi instalado."
}

# assinatura_gravar_estado: depois que o instalador terminou com sucesso, grava (fora do clone) a chave que
# vale, o marcador "ativada" e o commit instalado. Na primeira adocao, a chave e a da versao que acabou de ser
# instalada (a impressao digital foi mostrada antes).
assinatura_gravar_estado() {
    [ "$ENSAIO" != 1 ] || return 0
    local fonte="" commit tmp
    commit="$(_git rev-parse HEAD 2>/dev/null)" || return 0
    tmp="$(mktemp)" || { aviso "nao consegui gravar o estado da assinatura (arquivo temporario)."; return 0; }
    case "$ATU_ASSINATURA" in
        ativa)
            commit="${ASS_DESTINO:-$commit}"
            if [ -n "$ATU_ASSINATURA_TAG" ] && _ass_git show "$commit:$ASS_ARQ_REL" >"$tmp" 2>/dev/null && _ass_chaves_validas "$tmp"; then fonte="$tmp"
            elif [ -n "$ATU_CHAVE_EXTERNA" ] && [ -s "$ATU_ASSINATURA_CHAVE" ]; then fonte="$ATU_ASSINATURA_CHAVE"
            elif [ -s "$ATU_ASSINATURA_CHAVE" ]; then fonte="$ATU_ASSINATURA_CHAVE"; fi ;;
        adocao)
            if _git show "HEAD:$ASS_ARQ_REL" >"$tmp" 2>/dev/null && _ass_chaves_validas "$tmp"; then fonte="$tmp"; fi ;;
        *) rm -f "$tmp"; return 0 ;;
    esac
    if [ -n "$fonte" ]; then
        _ass_persistir "$fonte" "$commit" \
            || { rm -f "$tmp"; falha "instalei a versao, mas nao consegui gravar a chave de assinatura em $ASS_DIR; sem ela a proxima atualizacao nao seria conferida." \
                 "confira a permissao e o espaco de $DG_ETC e rode de novo: sudo dgclaw atualizar --sem-baixar"; }
    fi
    rm -f "$tmp"
    return 0
}

# _ass_aviso_adocao <commit candidato>: nao ha chave instalada ainda; mostra o que passa a valer.
_ass_aviso_adocao() {
    local para="$1" tmp imp
    if [ "$ATU_EXIGIR_ASSINATURA" = 1 ]; then
        falha "esta instalacao ainda nao tem a chave de assinatura das versoes, e voce pediu --exigir-assinatura, entao nao baixei nada." \
              "peca a quem mantem o DG Claw o arquivo allowed_signers (por um canal que NAO seja o repositorio) e rode: sudo dgclaw atualizar --exigir-assinatura --chave-assinatura <arquivo>. Veja docs/ASSINATURA.md. Nada foi mudado."
    fi
    if [ -n "$para" ] && tmp="$(mktemp)" && _git show "$para:$ASS_ARQ_REL" >"$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        imp="$(_ass_impressoes "$tmp")"
        aviso "esta e a atualizacao em que o DG Claw passa a conferir a assinatura das versoes. Como a sua instalacao ainda nao tem a chave, esta vez nao da para conferir: a chave vem junto com a versao nova."
        printf '   Impressao digital da chave que passa a valer:\n' >&2
        printf '%s\n' "$imp" | sed 's/^/     /' >&2
        printf '   Confira se ela e a mesma que o Danilo divulgou fora do repositorio (aula, site ou mensagem direta). Se for diferente, nao siga: interrompa agora (Ctrl+C) ou volte com sudo dgclaw atualizar --voltar <backup>.\n' >&2
        printf '   Para nao depender disto, entregue o arquivo de chaves de fora: sudo dgclaw atualizar --exigir-assinatura --chave-assinatura <arquivo> (veja docs/ASSINATURA.md).\n' >&2
        rm -f "$tmp"
    else
        [ -z "${tmp:-}" ] || rm -f "$tmp"
        info "esta versao ainda nao traz a chave de assinatura (seguranca/assinatura/allowed_signers), entao a atualizacao nao confere assinatura; ela passa a valer na versao que trouxer a chave."
    fi
}

# assinatura_resolver <commit que seria instalado sem assinatura>
# Define ATU_ASSINATURA e, no modo "ativa", ASS_DESTINO (o commit da tag assinada mais nova, ou o proprio
# instalado quando ele ja foi autenticado) e ATU_ASSINATURA_TAG. Falha, explicando, se houver versao nova sem
# assinatura valida ou se o que esta no clone nunca foi autenticado.
assinatura_resolver() {
    local candidato="${1:-}" atual tags t commit recusadas="" achou=0
    ASS_DESTINO=""; ATU_ASSINATURA_TAG=""; ATU_ASSINATURA=""
    ASS_ORIGEM=""
    _ass_ancora
    if [ -z "$ATU_ASSINATURA_CHAVE" ]; then
        ATU_ASSINATURA=adocao
        _ass_aviso_adocao "$candidato"
        return 0
    fi
    ATU_ASSINATURA=ativa
    command -v ssh-keygen >/dev/null 2>&1 \
        || falha "falta o ssh-keygen (pacote openssh-client), que confere a assinatura das versoes." \
                 "instale: sudo apt-get install -y openssh-client; depois rode de novo. Nada foi mudado."
    info "conferindo a assinatura das versoes (chave de $ASS_ORIGEM)"
    # Tag que ja existe aqui nao pode ser trocada pelo fetch: se o GitHub mudou uma tag, o fetch recusa e isso e sinal ruim.
    _ass_git fetch --tags origin >/dev/null 2>&1 \
        || falha "nao consegui baixar as tags de versao do GitHub (sem internet, ou uma tag que ja existia aqui foi alterada no GitHub, o que e sinal de problema)." \
                 "confira a internet (curl -I https://github.com). Se a internet esta boa, NAO force: avise quem mantem o DG Claw, que a tag foi mudada. Nada foi mudado."
    atual="$(_git rev-parse HEAD)"
    tags="$(_ass_git for-each-ref --format='%(refname:strip=2)' 'refs/tags/v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -Vr || true)"
    for t in $tags; do
        commit="$(_ass_git rev-parse --verify --quiet "refs/tags/$t^{commit}")" || continue
        # mesma versao ou anterior a que esta instalada: nada a instalar (e as seguintes, mais velhas, tambem nao)
        # Uma tag nao autenticada nunca decide nada: so a tag com assinatura valida pode encerrar a busca.
        if [ "$(_ass_git cat-file -t "refs/tags/$t" 2>/dev/null)" != tag ]; then
            if [ "$commit" != "$atual" ] && ! _ass_git merge-base --is-ancestor "$commit" "$atual" 2>/dev/null; then recusadas="$recusadas $t(tag sem assinatura)"; fi
            continue
        fi
        if ! _ass_tag_valida "$t"; then
            if [ "$commit" != "$atual" ] && ! _ass_git merge-base --is-ancestor "$commit" "$atual" 2>/dev/null; then recusadas="$recusadas $t(assinatura invalida, de outra chave ou de outro formato)"; fi
            continue
        fi
        if [ "$commit" = "$atual" ] || _ass_git merge-base --is-ancestor "$commit" "$atual" 2>/dev/null; then break; fi
        if ! _ass_commit_chaves "$commit"; then
            falha "a versao assinada $t nao traz um arquivo de chaves valido ($ASS_ARQ_REL ausente, vazio ou ilegivel); instalar deixaria o DG Claw sem conferir assinatura nas proximas vezes." \
                  "nao instalei. Avise quem mantem o DG Claw: uma versao assinada nao pode remover a chave. Nada foi mudado."
        fi
        ASS_DESTINO="$commit"; ATU_ASSINATURA_TAG="$t"; achou=1
        ok "versao $t: assinatura valida ($(printf '%s' "$ASS_SAIDA" | grep -m1 -oE 'SHA256:[A-Za-z0-9+/]+' || printf 'chave fixada'))"
        break
    done
    if [ "$achou" = 1 ] && [ -n "$recusadas" ]; then
        aviso "tem versao mais nova no GitHub sem assinatura valida, e eu a ignorei:$recusadas. Instalo so a ${ATU_ASSINATURA_TAG}, que esta assinada. Avise quem mantem o DG Claw."
    fi
    if [ "$achou" = 0 ] && [ -n "$recusadas" ]; then
        falha "ha versao nova no GitHub SEM assinatura valida da chave deste DG Claw:$recusadas. Nao instalei nada." \
              "isso pode ser uma tag que o mantenedor esqueceu de assinar, ou um ataque. Nao contorne: avise quem mantem o DG Claw e espere uma versao assinada (docs/ASSINATURA.md). Seus dados nao foram tocados."
    fi
    if [ "$achou" = 0 ]; then
        # Sem versao assinada mais nova, o que vale e o que ja esta no clone, e isso so vale se ja foi autenticado.
        if ! _ass_head_autenticado "$atual"; then
            falha "o clone ($ATU_REPO) esta em ${atual:0:10}, que nao e uma versao assinada nem o commit que esta maquina instalou depois de conferir, e nao ha versao assinada mais nova para trocar. Nao instalei nada." \
                  "se voce mesmo mudou o clone, volte para a versao oficial (cd $ATU_REPO && git fetch --tags && git checkout <tag vX.Y.Z assinada>); se nao foi voce, trate como incidente. Espere uma versao assinada (docs/ASSINATURA.md). Seus dados nao foram tocados."
        fi
        ASS_DESTINO="$atual"
        ok "nenhuma versao assinada mais nova que a instalada"
    fi
}

# assinatura_reconferir: logo antes de baixar, a tag aceita continua apontando para o mesmo commit e continua valida.
assinatura_reconferir() {
    [ "$ATU_ASSINATURA" = ativa ] && [ -n "$ATU_ASSINATURA_TAG" ] || return 0
    if [ -z "$ATU_ASSINATURA_CHAVE" ] || [ ! -s "$ATU_ASSINATURA_CHAVE" ]; then
        falha "perdi o arquivo de chaves que serve de ancora (o arquivo temporario sumiu)." "rode de novo: sudo dgclaw atualizar. Nada foi mudado alem do backup."
    fi
    local commit
    commit="$(_ass_git rev-parse --verify --quiet "refs/tags/$ATU_ASSINATURA_TAG^{commit}")" || commit=""
    if [ "$commit" != "$ASS_DESTINO" ] || ! _ass_tag_valida "$ATU_ASSINATURA_TAG"; then
        falha "a tag $ATU_ASSINATURA_TAG mudou (ou deixou de ser valida) entre a conferencia e o download. Nao instalei nada." \
              "isso nao deveria acontecer. Avise quem mantem o DG Claw e rode de novo depois. O backup ja foi feito; nada mais foi mudado."
    fi
}

# assinatura_exigir_head: antes de rodar o install.sh como root, o que esta no clone e exatamente a versao
# assinada (com personalizacoes: a versao assinada esta no historico e o clone nao tem arquivo alterado), e
# nenhum arquivo rastreado difere do commit, mesmo os marcados com skip-worktree ou assume-unchanged.
# Na volta (rollback) nao se aplica: ela devolve o commit e o estado gravados no backup.
assinatura_exigir_head() {
    [ "$ATU_ASSINATURA" = ativa ] && [ -n "$ASS_DESTINO" ] || return 0
    [ "$ENSAIO" != 1 ] || return 0
    local head base idx rc=0
    head="$(_git rev-parse HEAD)"
    if [ "${PERS_ATIVO:-0}" = 1 ]; then
        _ass_git merge-base --is-ancestor "$ASS_DESTINO" "$head" 2>/dev/null \
            || falha "o clone ($ATU_REPO) esta em ${head:0:10}, e a versao assinada ${ATU_ASSINATURA_TAG:-aceita} (${ASS_DESTINO:0:10}) nao esta no historico dele. Nao rodei o instalador, porque ele roda como root." \
                     "rode de novo: sudo dgclaw atualizar. Seus dados estao no backup."
        base="$head"
    else
        [ "$head" = "$ASS_DESTINO" ] \
            || falha "o clone ($ATU_REPO) esta em ${head:0:10}, e a versao assinada ${ATU_ASSINATURA_TAG:-aceita} e ${ASS_DESTINO:0:10}. Nao rodei o instalador, porque ele roda como root." \
                     "deixe o clone exatamente na versao assinada (cd $ATU_REPO && git merge --ff-only $ASS_DESTINO) ou rode: sudo dgclaw atualizar. Seus dados estao no backup."
        base="$ASS_DESTINO"
    fi
    # Indice novo: nao herda skip-worktree nem assume-unchanged do indice do clone.
    idx="$(mktemp -u)"
    GIT_INDEX_FILE="$idx" _ass_git read-tree "$base" >/dev/null 2>&1 \
        && GIT_INDEX_FILE="$idx" _ass_git update-index -q --refresh >/dev/null 2>&1 \
        && GIT_INDEX_FILE="$idx" _ass_git diff-files --quiet >/dev/null 2>&1 || rc=1
    rm -f "$idx"
    [ "$rc" = 0 ] \
        || falha "ha arquivo do clone ($ATU_REPO) diferente do commit ${base:0:10} (ou o clone esconde alteracoes com skip-worktree). Nao rodei o instalador, porque ele roda como root." \
                 "veja: cd $ATU_REPO && git ls-files -v | grep -v '^H' ; e: git status. Deixe o clone igual ao commit (git checkout -- . e git update-index --no-skip-worktree --no-assume-unchanged <arquivo>) ou, se a mudanca e sua, guarde-a na branch das personalizacoes. Seus dados estao no backup."
}
