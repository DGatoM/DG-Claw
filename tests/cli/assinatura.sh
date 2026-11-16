#!/usr/bin/env bash
# lib/assinatura.sh: o `dgclaw atualizar` so instala versao (tag vX.Y.Z) assinada pela chave que
# JA estava no codigo instalado. Usa chaves SSH descartaveis, um "GitHub" local e git de verdade.
# Cobre: tag valida; sem assinatura; chave errada; atacante que troca a chave no commit novo (a
# ancora e a instalada, nao a nova); tag leve; versao que remove a chave; sem ancora (adocao, com
# impressao digital, --exigir-assinatura e --chave-assinatura); config hostil no clone; tag que muda
# depois da conferencia; HEAD diferente do assinado.
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
    ATU_REPO="$CLONE"; ATU_EXIGIR_ASSINATURA=0; ATU_CHAVE_EXTERNA=""; ATU_ASSINATURA=""
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
afirma "diz assinatura invalida ou de outra chave" grep -q 'assinatura invalida ou de outra chave' "$TMP/s.txt"

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

fim
