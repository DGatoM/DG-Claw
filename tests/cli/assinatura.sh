#!/usr/bin/env bash
# lib/assinatura.sh: o `dgclaw atualizar` so instala versao (tag vX.Y.Z) assinada pela chave que
# JA estava no codigo instalado. Usa chaves SSH descartaveis, um "GitHub" local e git de verdade.
# A ancora fica FORA do clone ($DG_ETC/assinatura). Cobre: tag valida; sem assinatura; chave errada;
# atacante que troca a chave no commit novo ou no clone (a ancora e a gravada, nao a do clone); tag
# leve; assinatura OpenPGP; versao que remove a chave, deixa o arquivo vazio ou traz cert-authority;
# sem ancora (adocao, impressao digital, --exigir-assinatura, --chave-assinatura); volta a adocao
# depois de ativada; HEAD nunca autenticado; skip-worktree; personalizacoes; estado gravado depois da
# instalacao; config hostil no clone; tag que muda depois da conferencia; HEAD diferente do assinado.
# shellcheck disable=SC2030,SC2031,SC2034 # variaveis lidas pelas funcoes de lib/assinatura.sh e lib/personalizacoes.sh
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
export GIT_AUTHOR_NAME=teste GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=teste GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# shellcheck source=lib/comum.sh
. "$REPO/lib/comum.sh"
# shellcheck source=lib/assinatura.sh
. "$REPO/lib/assinatura.sh"
_git() { git_do_clone "$ATU_REPO" "$@"; }
# lib/comum.sh tem o proprio ok() (saida do dgclaw); aqui volta o do teste, que conta.
ok() { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
ENSAIO=0

KD="$TMP/k-dono"; KA="$TMP/k-atacante"
ssh-keygen -q -t ed25519 -N '' -C dono -f "$KD"
ssh-keygen -q -t ed25519 -N '' -C atacante -f "$KA"
signers() { printf 'releases namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$1.pub")"; }
assinar() { git -C "$TRAB" -c gpg.format=ssh -c "user.signingkey=$1" tag -s -m "versao" "$2" "${3:-HEAD}"; }

# monta: um "GitHub" (bare), o repositorio de quem publica (TRAB) e o clone instalado (CLONE), no commit 1.
# $1 = com-chave | sem-chave
monta() {
    rm -rf "$TMP/o.git" "$TMP/trab" "$TMP/clone"
    TRAB="$TMP/trab"; CLONE="$TMP/clone"
    git init -q -b main "$TRAB"
    echo v1 >"$TRAB/arquivo.txt"
    if [ "$1" = com-chave ]; then
        mkdir -p "$TRAB/seguranca/assinatura"
        signers "$KD" >"$TRAB/seguranca/assinatura/allowed_signers"
    fi
    git -C "$TRAB" add -A; git -C "$TRAB" commit -q -m v1
    git clone -q --bare "$TRAB" "$TMP/o.git"
    git -C "$TRAB" remote add origin "$TMP/o.git"
    git -C "$TRAB" fetch -q origin; git -C "$TRAB" branch -q --set-upstream-to=origin/main main
    git clone -q "$TMP/o.git" "$CLONE"
    ATU_REPO="$CLONE"; ATU_EXIGIR_ASSINATURA=0; ATU_CHAVE_EXTERNA=""; ATU_ASSINATURA=""; PERS_ATIVO=0
    # O estado da maquina: com-chave = a protecao ja esta ligada (chave gravada fora do clone, commit instalado = v1).
    rm -rf "$ASS_DIR"
    if [ "$1" = com-chave ]; then
        mkdir -p "$ASS_DIR"; signers "$KD" >"$ASS_ANCORA"; date +%F >"$ASS_ATIVADA"
        git -C "$CLONE" rev-parse HEAD >"$ASS_INSTALADO"
    fi
}
novo_commit() { echo "$1" >"$TRAB/arquivo.txt"; git -C "$TRAB" commit -q -am "$1"; }
publicar() { git -C "$TRAB" push -q origin main --tags 2>/dev/null || git -C "$TRAB" push -q origin main; git -C "$TRAB" push -q origin --tags; }
# resolver: roda assinatura_resolver num subshell; saida em $TMP/s.txt, codigo em RC, destino em DEST.
resolver() {
    RC=0; DEST=""; rm -f "$TMP/vars.txt"
    ( assinatura_resolver "${1:-}"; printf 'DEST=%s\nSTATUS=%s\nTAG=%s\n' "$ASS_DESTINO" "$ATU_ASSINATURA" "$ATU_ASSINATURA_TAG" >"$TMP/vars.txt"; assinatura_limpar ) >"$TMP/s.txt" 2>&1 || RC=$?
    DEST="$(sed -n 's/^DEST=//p' "$TMP/vars.txt" 2>/dev/null)"
}

echo "tag assinada pela chave do projeto: aceita"
monta com-chave; rm -f "$TMP/vars.txt"
novo_commit v2; assinar "$KD" v1.1.0; publicar
C2="$(git -C "$TRAB" rev-parse HEAD)"
resolver
igual "sai com 0 ($(tail -n 2 "$TMP/s.txt" | tr '\n' ' '))" "0" "$RC"
igual "o destino e o commit da tag" "$C2" "$DEST"
afirma "modo ativa" grep -q '^STATUS=ativa' "$TMP/vars.txt"
afirma "diz que a assinatura e valida" grep -q 'assinatura valida' "$TMP/s.txt"
afirma "o texto mostra a impressao digital da chave" grep -q 'SHA256:' "$TMP/s.txt"

echo "ja na versao mais nova assinada: nada a instalar"
git -C "$CLONE" -c gpg.format=ssh pull -q --ff-only 2>/dev/null || git -C "$CLONE" pull -q --ff-only
resolver
afirma "sai com 0 e diz que nao ha versao mais nova" grep -q 'nenhuma versao assinada mais nova' "$TMP/s.txt"
igual "o destino e o proprio HEAD" "$C2" "$DEST"

echo "tag anotada SEM assinatura: recusa e explica"
monta com-chave
novo_commit v2; git -C "$TRAB" tag -a -m "sem assinar" v1.1.0; publicar
resolver
nega "sai com erro" test "$RC" -eq 0
afirma "diz que nao tem assinatura valida" grep -q 'SEM assinatura valida' "$TMP/s.txt"
afirma "diz o que fazer" grep -q 'Nao contorne' "$TMP/s.txt"
nega "nao chegou a definir destino" test -s "$TMP/vars.txt"

echo "tag leve (sem objeto de tag): recusa"
monta com-chave
novo_commit v2; git -C "$TRAB" tag v1.1.0; publicar
resolver
nega "sai com erro" test "$RC" -eq 0
afirma "diz tag sem assinatura" grep -q 'tag sem assinatura' "$TMP/s.txt"

echo "tag assinada por OUTRA chave: recusa"
monta com-chave
novo_commit v2; assinar "$KA" v1.1.0; publicar
resolver
nega "sai com erro" test "$RC" -eq 0
afirma "diz assinatura invalida, de outra chave ou de outro formato" grep -q 'assinatura invalida, de outra chave ou de outro formato' "$TMP/s.txt"

echo "atacante troca a chave no commit novo e assina com a dele: a ancora e a instalada, recusa"
monta com-chave
echo v2 >"$TRAB/arquivo.txt"; signers "$KA" >"$TRAB/seguranca/assinatura/allowed_signers"
git -C "$TRAB" commit -q -am "troca a chave"; assinar "$KA" v1.1.0; publicar
resolver
nega "sai com erro" test "$RC" -eq 0
afirma "recusa a versao" grep -q 'SEM assinatura valida' "$TMP/s.txt"

echo "uma versao nova assinada e uma ainda mais nova sem assinatura: instala a assinada e avisa"
monta com-chave
novo_commit v2; assinar "$KD" v1.1.0; novo_commit v3; git -C "$TRAB" tag -a -m x v1.2.0; publicar
C_V110="$(git -C "$TRAB" rev-parse "v1.1.0^{commit}")"
resolver
igual "sai com 0" "0" "$RC"
igual "o destino e a v1.1.0" "$C_V110" "$DEST"
afirma "avisa da versao ignorada" grep -q 'v1.2.0(assinatura invalida' "$TMP/s.txt"

echo "versao assinada que REMOVE o arquivo de chaves: recusa"
monta com-chave
git -C "$TRAB" rm -q -r seguranca; git -C "$TRAB" commit -q -m "sem chave"; assinar "$KD" v1.1.0; publicar
resolver
nega "sai com erro" test "$RC" -eq 0
afirma "explica que a chave nao pode sumir" grep -q 'nao pode remover a chave' "$TMP/s.txt"

echo "a rotacao de chave assinada pela chave antiga e aceita"
monta com-chave
echo v2 >"$TRAB/arquivo.txt"; { signers "$KD"; signers "$KA"; } >"$TRAB/seguranca/assinatura/allowed_signers"
git -C "$TRAB" commit -q -am "chave nova junto"; assinar "$KD" v1.1.0; publicar
resolver
igual "sai com 0" "0" "$RC"

echo "config hostil no clone nao executa programa nenhum"
monta com-chave
novo_commit v2; assinar "$KD" v1.1.0; publicar
printf '#!/bin/sh\ntouch %s/EXECUTOU\nexit 1\n' "$TMP" >"$TMP/pwn.sh"; chmod +x "$TMP/pwn.sh"
git -C "$CLONE" config gpg.ssh.program "$TMP/pwn.sh"; git -C "$CLONE" config gpg.program "$TMP/pwn.sh"; git -C "$CLONE" config core.hooksPath "$TMP"
git -C "$CLONE" config gpg.ssh.allowedSignersFile /dev/null
resolver
igual "mesmo assim aceita a tag valida" "0" "$RC"
nega "o programa do clone nao rodou" test -e "$TMP/EXECUTOU"

echo "sem chave instalada (instalacao antiga): adocao, com a impressao digital da chave nova"
monta sem-chave
novo_commit v2; mkdir -p "$TRAB/seguranca/assinatura"; signers "$KD" >"$TRAB/seguranca/assinatura/allowed_signers"
git -C "$TRAB" add -A; git -C "$TRAB" commit -q -m "traz a chave"; assinar "$KD" v1.1.0; publicar
CAND="$(git -C "$TRAB" rev-parse HEAD)"
git -C "$CLONE" fetch -q
resolver "$CAND"
igual "sai com 0 ($(tail -n 2 "$TMP/s.txt" | tr '\n' ' '))" "0" "$RC"
afirma "modo adocao" grep -q '^STATUS=adocao' "$TMP/vars.txt"
FP="$(ssh-keygen -lf "$KD.pub" | awk '{print $2}')"
afirma "mostra a impressao digital da chave que passa a valer" grep -qF "$FP" "$TMP/s.txt"
afirma "manda conferir fora do repositorio" grep -q 'fora do repositorio' "$TMP/s.txt"
afirma "destino nao e imposto (segue o fluxo de hoje)" test -z "$DEST"

echo "sem chave instalada e --exigir-assinatura: recusa e explica"
ATU_EXIGIR_ASSINATURA=1
resolver "$CAND"
nega "sai com erro" test "$RC" -eq 0
afirma "explica o que fazer" grep -q 'allowed_signers' "$TMP/s.txt"
afirma "diz que nada foi mudado" grep -q 'Nada foi mudado' "$TMP/s.txt"

echo "sem chave instalada, mas com a chave entregue de fora: confere como no modo ativo"
ATU_CHAVE_EXTERNA="$TMP/de-fora"; signers "$KD" >"$ATU_CHAVE_EXTERNA"
resolver "$CAND"
igual "sai com 0 ($(tail -n 2 "$TMP/s.txt" | tr '\n' ' '))" "0" "$RC"
afirma "modo ativa" grep -q '^STATUS=ativa' "$TMP/vars.txt"
igual "destino e o commit da tag" "$CAND" "$DEST"
signers "$KA" >"$ATU_CHAVE_EXTERNA"
resolver "$CAND"
nega "com a chave de fora ERRADA recusa" test "$RC" -eq 0
ATU_CHAVE_EXTERNA="$TMP/nao-existe"
resolver "$CAND"
nega "arquivo de chave inexistente: recusa" test "$RC" -eq 0
afirma "diz qual arquivo" grep -q 'nao-existe' "$TMP/s.txt"

echo "sem chave em nenhum lugar (versao ainda sem a chave): segue como hoje, avisando"
monta sem-chave
novo_commit v2; publicar
resolver "$(git -C "$TRAB" rev-parse HEAD)"
igual "sai com 0" "0" "$RC"
afirma "avisa que ainda nao confere assinatura" grep -q 'ainda nao traz a chave' "$TMP/s.txt"

echo "reconferir: tag que mudou depois da conferencia"
monta com-chave
novo_commit v2; assinar "$KD" v1.1.0; publicar
(
    assinatura_resolver ""
    git -C "$CLONE" commit -q --allow-empty -m "outro commit"; git -C "$CLONE" tag -f v1.1.0 HEAD >/dev/null 2>&1
    assinatura_reconferir
) >"$TMP/s.txt" 2>&1
nega "tag trocada: recusa" test "$?" -eq 0
afirma "explica" grep -q 'mudou (ou deixou de ser valida)' "$TMP/s.txt"

echo "exigir_head: o clone nao esta na versao assinada"
monta com-chave
novo_commit v2; assinar "$KD" v1.1.0; publicar
(
    assinatura_resolver ""
    ENSAIO=0
    assinatura_exigir_head
) >"$TMP/s.txt" 2>&1
nega "HEAD antigo (nao e o assinado): recusa" test "$?" -eq 0
afirma "diz que nao rodou o instalador" grep -q 'Nao rodei o instalador' "$TMP/s.txt"
(
    assinatura_resolver ""
    git -C "$CLONE" merge -q --ff-only "$ASS_DESTINO"
    assinatura_exigir_head
) >"$TMP/s.txt" 2>&1
afirma "HEAD na versao assinada: passa" test "$?" -eq 0

echo "assinatura OpenPGP (nao SSH): recusa, mesmo com a chave no chaveiro"
if command -v gpg >/dev/null 2>&1; then
    monta com-chave
    export GNUPGHOME="$TMP/gnupg"; mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
    gpg --batch -q --passphrase '' --quick-generate-key "a <a@a>" default default never >/dev/null 2>&1
    novo_commit v2
    git -C "$TRAB" -c gpg.format=openpgp -c user.signingkey=a@a tag -s -m "versao" v1.1.0 HEAD; publicar
    resolver
    nega "sai com erro" test "$RC" -eq 0
    afirma "diz que e de outro formato" grep -q 'outro formato' "$TMP/s.txt"
    unset GNUPGHOME
else
    echo "  (gpg nao instalado: caso OpenPGP pulado)"
fi

echo "o clone com chave do atacante no HEAD nao vira ancora"
monta com-chave
signers "$KA" >"$CLONE/atacante.pub"
mkdir -p "$CLONE/seguranca/assinatura"; signers "$KA" >"$CLONE/seguranca/assinatura/allowed_signers"
git -C "$CLONE" add -A; git -C "$CLONE" commit -q -m "chave do atacante"
novo_commit v2; assinar "$KA" v1.1.0; publicar
resolver
nega "tag assinada pela chave do atacante: recusa" test "$RC" -eq 0

echo "protecao ja ativada e chave gravada sumiu: nao volta para a adocao"
monta com-chave
novo_commit v2; assinar "$KD" v1.1.0; publicar
rm -f "$ASS_ANCORA"
resolver "$(git -C "$TRAB" rev-parse HEAD)"
nega "recusa" test "$RC" -eq 0
afirma "explica que voltar a adocao nao e permitido" grep -q 'nao e permitido' "$TMP/s.txt"
: >"$ASS_ANCORA"
resolver "$(git -C "$TRAB" rev-parse HEAD)"
nega "arquivo de chave vazio tambem recusa" test "$RC" -eq 0

echo "versao assinada com allowed_signers vazio ou com cert-authority: recusa"
monta com-chave
echo v2 >"$TRAB/arquivo.txt"; : >"$TRAB/seguranca/assinatura/allowed_signers"
git -C "$TRAB" commit -q -am "chave vazia"; assinar "$KD" v1.1.0; publicar
resolver
nega "vazio: recusa" test "$RC" -eq 0
afirma "explica" grep -q 'nao pode remover a chave\|arquivo de chaves valido' "$TMP/s.txt"
monta com-chave
echo v2 >"$TRAB/arquivo.txt"; printf 'releases namespaces="git" cert-authority %s\n' "$(cut -d' ' -f1,2 "$KA.pub")" >"$TRAB/seguranca/assinatura/allowed_signers"
git -C "$TRAB" commit -q -am "cert-authority"; assinar "$KD" v1.1.0; publicar
resolver
nega "cert-authority: recusa" test "$RC" -eq 0

echo "sem versao nova, HEAD nunca autenticado (chave de fora, sem tags): recusa"
monta sem-chave
echo extra >"$CLONE/arquivo.txt"; git -C "$CLONE" commit -q -am "commit local sem assinatura"
ATU_CHAVE_EXTERNA="$TMP/de-fora"; signers "$KD" >"$ATU_CHAVE_EXTERNA"
resolver ""
nega "recusa o HEAD sem assinatura" test "$RC" -eq 0
afirma "explica" grep -q 'nao e uma versao assinada' "$TMP/s.txt"
ATU_CHAVE_EXTERNA=""

echo "HEAD igual ao commit gravado como instalado: segue sem versao nova"
monta com-chave
resolver
igual "sai com 0" "0" "$RC"
igual "o destino e o proprio HEAD" "$(git -C "$CLONE" rev-parse HEAD)" "$DEST"

echo "personalizacoes: commit do dono por cima da versao instalada e aceito; versao nova assinada tambem"
monta com-chave
echo meu >"$CLONE/meu.txt"; git -C "$CLONE" add meu.txt; git -C "$CLONE" commit -q -m "personalizacao do dono"
PERS_ATIVO=1
resolver
igual "sem versao nova: sai com 0" "0" "$RC"
novo_commit v2; assinar "$KD" v1.1.0; publicar
resolver
igual "com versao nova assinada: sai com 0" "0" "$RC"
igual "o destino e a tag, nao o HEAD do dono" "$(git -C "$TRAB" rev-parse HEAD)" "$DEST"
PERS_ATIVO=0

echo "skip-worktree escondendo alteracao de arquivo rastreado: o instalador nao roda"
monta com-chave
novo_commit v2; assinar "$KD" v1.1.0; publicar
(
    assinatura_resolver ""
    git -C "$CLONE" fetch -q; git -C "$CLONE" merge -q --ff-only "$ASS_DESTINO"
    ENSAIO=0
    assinatura_exigir_head
) >"$TMP/s.txt" 2>&1
igual "limpo: passa" "0" "$?"
(
    assinatura_resolver ""
    git -C "$CLONE" merge -q --ff-only "$ASS_DESTINO" 2>/dev/null
    echo adulterado >"$CLONE/arquivo.txt"; git -C "$CLONE" update-index --skip-worktree arquivo.txt
    ENSAIO=0
    assinatura_exigir_head
) >"$TMP/s.txt" 2>&1
nega "alterado e escondido: recusa" test "$?" -eq 0
afirma "diz que ha arquivo diferente do commit" grep -q 'diferente do commit' "$TMP/s.txt"

echo "estado gravado depois da instalacao: chave, marcador e commit, fora do clone"
monta com-chave
echo v2 >"$TRAB/arquivo.txt"; { signers "$KD"; signers "$KA"; } >"$TRAB/seguranca/assinatura/allowed_signers"
git -C "$TRAB" commit -q -am "chave nova junto"; assinar "$KD" v1.1.0; publicar
(
    assinatura_resolver ""
    git -C "$CLONE" fetch -q; git -C "$CLONE" merge -q --ff-only "$ASS_DESTINO"
    ENSAIO=0
    assinatura_gravar_estado
) >"$TMP/s.txt" 2>&1
igual "a ancora ganhou a chave nova" "2" "$(grep -c namespaces "$ASS_ANCORA")"
igual "commit instalado gravado" "$(git -C "$TRAB" rev-parse HEAD)" "$(cat "$ASS_INSTALADO")"
monta sem-chave
novo_commit v2; mkdir -p "$TRAB/seguranca/assinatura"; signers "$KD" >"$TRAB/seguranca/assinatura/allowed_signers"
git -C "$TRAB" add -A; git -C "$TRAB" commit -q -m "traz a chave"; publicar
(
    git -C "$CLONE" fetch -q; git -C "$CLONE" merge -q --ff-only origin/main
    assinatura_resolver "$(git -C "$CLONE" rev-parse HEAD)" >/dev/null 2>&1
    ENSAIO=0
    assinatura_gravar_estado
) >"$TMP/s.txt" 2>&1
afirma "a adocao grava a chave da versao instalada" test -s "$ASS_ANCORA"
afirma "e liga o marcador ativada" test -e "$ASS_ATIVADA"

echo "tag leve falsa em ancestral nao congela as atualizacoes"
monta com-chave
C1="$(git -C "$TRAB" rev-parse HEAD)"
git -C "$TRAB" tag v999.0.0 "$C1"
novo_commit v2; assinar "$KD" v1.1.0; publicar
C2="$(git -C "$TRAB" rev-parse HEAD)"
resolver
igual "sai com 0" "0" "$RC"
igual "ainda acha a versao assinada" "$C2" "$DEST"

echo "falha ao gravar a primeira ancora (chave de fora): nao instala"
monta com-chave; rm -rf "$ASS_DIR"
novo_commit v2; assinar "$KD" v1.1.0; publicar
ATU_CHAVE_EXTERNA="$TMP/de-fora"; signers "$KD" >"$ATU_CHAVE_EXTERNA"
(
    assinatura_resolver ""
    ENSAIO=0
    DG_ETC_BAK="$ASS_DIR"; ASS_DIR="/proc/nao-existe/assinatura"; ASS_ANCORA="$ASS_DIR/allowed_signers"; ASS_ATIVADA="$ASS_DIR/ativada"
    assinatura_persistir_antes
) >"$TMP/s.txt" 2>&1
nega "falha de escrita aborta antes do instalador" test "$?" -eq 0
afirma "explica que nada foi instalado" grep -q 'Nada foi instalado' "$TMP/s.txt"
(
    assinatura_resolver ""
    ENSAIO=0
    assinatura_persistir_antes
) >"$TMP/s.txt" 2>&1
igual "com a pasta gravavel grava" "0" "$?"
afirma "a ancora e o marcador existem" bash -c "[ -s '$ASS_ANCORA' ] && [ -e '$ASS_ATIVADA' ]"
ATU_CHAVE_EXTERNA=""


echo "tag antiga assinada republicada com outro nome nao esconde a versao nova"
monta com-chave
novo_commit v2; assinar "$KD" v1.1.0; publicar
C2="$(git -C "$TRAB" rev-parse HEAD)"
novo_commit v3; assinar "$KD" v1.2.0
git -C "$TRAB" update-ref refs/tags/v999.0.0 "$(git -C "$TRAB" rev-parse refs/tags/v1.1.0)"
publicar
C3="$(git -C "$TRAB" rev-parse "v1.2.0^{commit}")"
resolver
igual "sai com 0" "0" "$RC"
igual "o destino e a v1.2.0, nao a tag renomeada" "$C3" "$DEST"
afirma "a conferencia de arquivos aceita a regravacao do estado de assinatura" grep -q 'etc/dgclaw/assinatura/\*)' "$REPO/lib/atualizar.sh"


echo "impressao digital de arquivo de chaves sem newline final"
printf 'releases namespaces="git" %s' "$(cut -d' ' -f1,2 "$KD.pub")" >"$TMP/sem-newline"
afirma "mostra a impressao digital mesmo sem newline" bash -c ". '$REPO/lib/comum.sh'; . '$REPO/lib/assinatura.sh'; _ass_impressoes '$TMP/sem-newline' | grep -q '^SHA256:'"

echo "volta (rollback): nao repete a conferencia da atualizacao"
afirma "atualizar_voltar zera o estado de assinatura antes de reinstalar" bash -c "sed -n '/^atualizar_voltar()/,/^}/p' '$REPO/lib/atualizar.sh' | grep -q 'ATU_ASSINATURA=\"\"; ASS_DESTINO=\"\"'"
afirma "o estado so e gravado depois que o instalador termina com sucesso" bash -c "sed -n '/^atualizar_rodar_install()/,/^}/p' '$REPO/lib/atualizar.sh' | tail -n 3 | grep -q assinatura_gravar_estado"

fim
