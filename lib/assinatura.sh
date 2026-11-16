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
# Modelo de confianca (por que a ancora vem do codigo ja instalado):
#   - A chave publica fica em seguranca/assinatura/allowed_signers, no repositorio. Mas um atacante que
#     controla o repositorio trocaria esse arquivo junto com o codigo. Por isso a ANCORA e lida do
#     commit que esta instalado agora (HEAD do clone, antes de baixar nada), nunca da versao nova. A
#     versao nova so e aceita se for assinada pela chave que ja confiavamos. Troca de chave = a versao
#     que traz a chave nova vem assinada pela chave antiga.
#   - Primeira adocao: quem ainda nao tem o arquivo (instalacao antiga) nao tem ancora. Esse e o unico
#     momento sem verificacao: o aviso mostra a impressao digital da chave que passa a valer, para
#     conferir com a que o Danilo divulgou FORA do repositorio. Quem quer evitar ate isso entrega o
#     arquivo de fora com --chave-assinatura, ou recusa a adocao com --exigir-assinatura.
#   - O git roda neutralizado na verificacao (sem config global nem de sistema, sem hooks, com o
#     programa de assinatura e o arquivo de chaves fixados na linha de comando).
#   - Nao existe opcao para "pular a assinatura". Quem precisa instalar algo sem assinatura atualiza o
#     clone a mao e usa --sem-baixar, sabendo o que esta fazendo.
# Passo a passo de quem assina e de quem atualiza: docs/ASSINATURA.md.

ASS_ARQ_REL="seguranca/assinatura/allowed_signers"
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

# _ass_ancora: monta o arquivo de chaves que serve de ancora. Origem, na ordem: o arquivo que a pessoa
# entregou (--chave-assinatura) e o allowed_signers do commit instalado agora (HEAD do clone).
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
        ATU_ASSINATURA_CHAVE="$tmp"
        ASS_ORIGEM="o arquivo que voce entregou ($ATU_CHAVE_EXTERNA)"
        return 0
    fi
    if _git show "HEAD:$ASS_ARQ_REL" >"$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        ATU_ASSINATURA_CHAVE="$tmp"
        ASS_ORIGEM="a versao que esta instalada ($ASS_ARQ_REL)"
        return 0
    fi
    rm -f "$tmp"
    ATU_ASSINATURA_CHAVE=""
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
# Define ATU_ASSINATURA e, no modo "ativa", ASS_DESTINO (o commit da tag assinada mais nova) e
# ATU_ASSINATURA_TAG. Falha, explicando, se houver versao nova sem assinatura valida.
assinatura_resolver() {
    local candidato="${1:-}" atual tags t commit saida recusadas="" achou=0
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
        if [ "$commit" = "$atual" ] || _ass_git merge-base --is-ancestor "$commit" "$atual" 2>/dev/null; then break; fi
        if [ "$(_ass_git cat-file -t "refs/tags/$t" 2>/dev/null)" != tag ]; then
            recusadas="$recusadas $t(tag sem assinatura)"; continue
        fi
        if ! saida="$(_ass_git verify-tag "$t" 2>&1)"; then
            recusadas="$recusadas $t(assinatura invalida ou de outra chave)"; continue
        fi
        if ! _ass_git merge-base --is-ancestor "$atual" "$commit" 2>/dev/null; then
            falha "a versao assinada $t nao continua a partir do que esta instalado aqui (o clone $ATU_REPO divergiu do projeto)." \
                  "veja a diferenca: cd $ATU_REPO && git log --oneline --graph --all -20. Guarde o que for seu em outra branch e deixe o clone igual ao GitHub, ou peca ajuda. Nada foi mudado."
        fi
        if ! _ass_git cat-file -e "$commit:$ASS_ARQ_REL" 2>/dev/null; then
            falha "a versao assinada $t nao traz mais o arquivo de chaves ($ASS_ARQ_REL); instalar deixaria o DG Claw sem conferir assinatura nas proximas vezes." \
                  "nao instalei. Avise quem mantem o DG Claw: uma versao assinada nao pode remover a chave. Nada foi mudado."
        fi
        ASS_DESTINO="$commit"; ATU_ASSINATURA_TAG="$t"; achou=1
        ok "versao $t: assinatura valida ($(printf '%s' "$saida" | grep -m1 -oE 'SHA256:[A-Za-z0-9+/]+' || printf 'chave fixada'))"
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
    if [ "$commit" != "$ASS_DESTINO" ] || ! _ass_git verify-tag "$ATU_ASSINATURA_TAG" >/dev/null 2>&1; then
        falha "a tag $ATU_ASSINATURA_TAG mudou (ou deixou de ser valida) entre a conferencia e o download. Nao instalei nada." \
              "isso nao deveria acontecer. Avise quem mantem o DG Claw e rode de novo depois. O backup ja foi feito; nada mais foi mudado."
    fi
}

# assinatura_exigir_head: antes de rodar o install.sh como root, o que esta no clone e exatamente a versao assinada.
assinatura_exigir_head() {
    [ "$ATU_ASSINATURA" = ativa ] && [ -n "$ASS_DESTINO" ] || return 0
    [ "$ENSAIO" != 1 ] || return 0
    local head
    head="$(_git rev-parse HEAD)"
    [ "$head" = "$ASS_DESTINO" ] \
        || falha "o clone ($ATU_REPO) esta em ${head:0:10}, e a versao assinada ${ATU_ASSINATURA_TAG:-aceita} e ${ASS_DESTINO:0:10}. Nao rodei o instalador, porque ele roda como root." \
                 "deixe o clone exatamente na versao assinada (cd $ATU_REPO && git merge --ff-only $ASS_DESTINO) ou rode: sudo dgclaw atualizar. Seus dados estao no backup."
}
