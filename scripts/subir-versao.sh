#!/usr/bin/env bash
# Sobe a versao do DG Claw: VERSION, runner/package.json, panel/package.json, o package-lock.json do runner e o
# CHANGELOG.md (o que estava em "Nao lancado" passa a ser a versao nova). Nao faz commit, tag nem push.
#
# Uso: scripts/subir-versao.sh [--simular] <patch|minor|major>
#   --simular   so mostra o que faria; nao muda nenhum arquivo.
# Env: DGCLAW_REPO=<pasta>   repositorio a alterar (padrao: o que contem este script; os testes usam uma copia).
# Roteiro completo: docs/RELEASE.md
set -euo pipefail

erro() { printf 'subir-versao: %s\n  O que fazer: %s\n' "$1" "$2" >&2; exit 1; }

SIMULAR=0
NIVEL=""
for arg in "$@"; do
    case "$arg" in
        --simular) SIMULAR=1 ;;
        patch|minor|major) [ -z "$NIVEL" ] || erro "o nivel foi dado duas vezes." "passe so um: patch, minor ou major."; NIVEL="$arg" ;;
        *) erro "argumento desconhecido: '$arg'." "uso: scripts/subir-versao.sh [--simular] <patch|minor|major>" ;;
    esac
done
[ -n "$NIVEL" ] || erro "faltou o nivel da versao." "uso: scripts/subir-versao.sh [--simular] <patch|minor|major> (correcao = patch, recurso novo = minor, mudanca que quebra = major)."

command -v jq >/dev/null || erro "o jq nao esta instalado." "instale o jq (apt install jq) e rode de novo."

REPO="${DGCLAW_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ARQ_VERSION="$REPO/VERSION"
ARQ_CHANGELOG="$REPO/CHANGELOG.md"
PACOTES=("$REPO/runner/package.json" "$REPO/panel/package.json")
LOCKS=("$REPO/runner/package-lock.json")

for f in "$ARQ_VERSION" "$ARQ_CHANGELOG" "${PACOTES[@]}" "${LOCKS[@]}"; do
    [ -f "$f" ] || erro "nao achei $f." "rode o script na raiz de um clone do DG Claw, ou aponte DGCLAW_REPO para ele."
done

for f in "$ARQ_VERSION" "$ARQ_CHANGELOG" "${PACOTES[@]}" "${LOCKS[@]}" "$REPO/runner" "$REPO/panel"; do
    [ ! -L "$f" ] || erro "${f#"$REPO"/} e um link simbolico." "troque o link pelo arquivo (ou pasta) de verdade e rode de novo; o script nao segue link para nao gravar fora do repositorio."
done

ATUAL="$(tr -d '[:space:]' <"$ARQ_VERSION")"
RX='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ "$ATUAL" =~ $RX ]] || erro "o VERSION nao esta no formato X.Y.Z." "corrija o arquivo VERSION para algo como 1.0.0 e rode de novo."
MAJOR="${BASH_REMATCH[1]}"; MINOR="${BASH_REMATCH[2]}"; PATCH="${BASH_REMATCH[3]}"
case "$NIVEL" in
    patch) PATCH=$((PATCH + 1)) ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac
NOVA="$MAJOR.$MINOR.$PATCH"
DATA="$(date +%F)"
CABECALHO_NAO_LANCADO='## [Não lançado]'

# O CHANGELOG precisa ter o cabecalho, conteudo embaixo dele e nao conhecer a versao nova.
grep -qxF "$CABECALHO_NAO_LANCADO" "$ARQ_CHANGELOG" \
    || erro "o CHANGELOG.md nao tem a linha '$CABECALHO_NAO_LANCADO'." "coloque essa linha de volta no topo, antes da primeira versao lancada, e descreva ali o que mudou."
CONTEUDO="$(awk -v cab="$CABECALHO_NAO_LANCADO" '
    $0 == cab { dentro = 1; next }
    dentro && /^## \[/ { exit }
    dentro { print }
' "$ARQ_CHANGELOG")"
[[ "$CONTEUDO" =~ [^[:space:]] ]] \
    || erro "a secao '$CABECALHO_NAO_LANCADO' do CHANGELOG.md esta vazia, entao nao ha o que lancar." "descreva o que mudou nessa secao e rode de novo."
if grep -qE "^## \[$NOVA\]" "$ARQ_CHANGELOG"; then
    erro "a versao $NOVA ja existe no CHANGELOG.md." "confira se ela ja foi lancada; se foi, o CHANGELOG ja esta certo e nao precisa subir de novo."
fi
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 && git -C "$REPO" rev-parse -q --verify "refs/tags/v$NOVA" >/dev/null; then
    erro "a tag v$NOVA ja existe neste repositorio." "veja 'git tag -l' e escolha o nivel certo (patch, minor ou major); nao reaproveite uma tag publicada."
fi

# Arvore e indice limpos: o commit da release so pode ter as mudancas deste script.
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
    SUJA=""
    git -C "$REPO" diff --quiet || SUJA="ha mudancas nao commitadas"
    git -C "$REPO" diff --cached --quiet || SUJA="ha mudancas no indice (git add) ainda sem commit"
    if [ -z "$SUJA" ] && [ -n "$(git -C "$REPO" status --porcelain --untracked-files=all -- VERSION CHANGELOG.md runner/package.json panel/package.json runner/package-lock.json)" ]; then
        SUJA="ha arquivo nao rastreado nos caminhos da release"
    fi
    if [ -n "$SUJA" ]; then
        if [ "$SIMULAR" = 1 ]; then
            printf 'AVISO: %s. Sem --simular o script recusaria; commit ou guarde (git stash) antes.\n\n' "$SUJA"
        else
            erro "$SUJA, e a release so pode levar as mudancas do script." "faca commit ou guarde as mudancas (git stash) e rode de novo; veja com git status."
        fi
    fi
fi

printf 'Versao atual: %s\nVersao nova:  %s (%s)\n' "$ATUAL" "$NOVA" "$NIVEL"
printf 'Vou alterar:\n'
printf '  VERSION: %s -> %s\n' "$ATUAL" "$NOVA"
for f in "${PACOTES[@]}"; do printf '  %s: campo version -> %s\n' "${f#"$REPO"/}" "$NOVA"; done
for f in "${LOCKS[@]}"; do printf '  %s: .version e .packages[""].version -> %s\n' "${f#"$REPO"/}" "$NOVA"; done
printf '  CHANGELOG.md: o que esta em "%s" vira "## [%s] - %s" e a secao Nao lancado fica vazia\n' "$CABECALHO_NAO_LANCADO" "$NOVA" "$DATA"

if [ "$SIMULAR" = 1 ]; then
    printf '\n--simular: nada foi alterado.\n'
    exit 0
fi

# Tudo ou nada: gera os cinco resultados em arquivos temporarios, valida, e so entao substitui. Se uma troca
# falhar, os originais (copiados antes) voltam.
TMPDIR_REL="$(mktemp -d)" || erro "nao consegui criar uma pasta temporaria." "confira o espaco em disco e o TMPDIR."
if [ -z "$TMPDIR_REL" ] || [ ! -d "$TMPDIR_REL" ]; then erro "a pasta temporaria nao existe." "confira o espaco em disco e o TMPDIR."; fi
trap 'rm -rf "$TMPDIR_REL"' EXIT
mkdir "$TMPDIR_REL/novo" "$TMPDIR_REL/orig"

ALVOS=("$ARQ_VERSION" "$ARQ_CHANGELOG" "${PACOTES[@]}" "${LOCKS[@]}")
nome_tmp() { printf '%s' "${1#"$REPO"/}" | tr '/' '_'; }

jq_para_tmp() {
    local arq="$1"; shift
    jq --indent 2 "$@" "$arq" >"$TMPDIR_REL/novo/$(nome_tmp "$arq")" \
        || erro "o jq nao conseguiu ler ${arq#"$REPO"/}." "confira se o arquivo e um JSON valido (git diff). Nenhum arquivo foi alterado."
}

printf '%s\n' "$NOVA" >"$TMPDIR_REL/novo/$(nome_tmp "$ARQ_VERSION")"
# shellcheck disable=SC2016  # o $v e do jq (--arg), nao do shell
for f in "${PACOTES[@]}"; do jq_para_tmp "$f" --arg v "$NOVA" '.version = $v'; done
# shellcheck disable=SC2016
for f in "${LOCKS[@]}"; do jq_para_tmp "$f" --arg v "$NOVA" '.version = $v | .packages[""].version = $v'; done
awk -v cab="$CABECALHO_NAO_LANCADO" -v nova="$NOVA" -v data="$DATA" '
    !feito && $0 == cab { print; print ""; print "## [" nova "] - " data; feito = 1; next }
    { print }
' "$ARQ_CHANGELOG" >"$TMPDIR_REL/novo/$(nome_tmp "$ARQ_CHANGELOG")" \
    || erro "nao consegui montar o CHANGELOG novo." "confira o CHANGELOG.md. Nenhum arquivo foi alterado."

# Validacao antes de trocar qualquer coisa.
for f in "${PACOTES[@]}" "${LOCKS[@]}"; do
    [ "$(jq -r .version "$TMPDIR_REL/novo/$(nome_tmp "$f")")" = "$NOVA" ] \
        || erro "o resultado de ${f#"$REPO"/} nao ficou com a versao $NOVA." "nenhum arquivo foi alterado; confira o JSON."
done
grep -qxF "## [$NOVA] - $DATA" "$TMPDIR_REL/novo/$(nome_tmp "$ARQ_CHANGELOG")" \
    || erro "o CHANGELOG novo nao ficou com o cabecalho da versao $NOVA." "nenhum arquivo foi alterado; confira o CHANGELOG.md."

for f in "${ALVOS[@]}"; do cp -p "$f" "$TMPDIR_REL/orig/$(nome_tmp "$f")" \
    || erro "nao consegui guardar a copia de ${f#"$REPO"/}." "nenhum arquivo foi alterado; confira o espaco em disco."; done

restaurar() {
    local g copia
    printf 'subir-versao: a troca falhou; restaurando os originais.\n' >&2
    for g in "${ALVOS[@]}"; do
        copia="$TMPDIR_REL/orig/$(nome_tmp "$g")"
        cat "$copia" >"$g" || printf '  nao consegui restaurar %s: use git checkout -- %s\n' "${g#"$REPO"/}" "${g#"$REPO"/}" >&2
    done
}
for f in "${ALVOS[@]}"; do
    novo="$TMPDIR_REL/novo/$(nome_tmp "$f")"
    if ! cat "$novo" >"$f"; then
        restaurar
        erro "nao consegui gravar ${f#"$REPO"/}." "os originais foram restaurados; confira permissoes e espaco em disco."
    fi
done

cat <<PASSOS

Pronto: arquivos alterados, nada foi commitado. Proximos passos:
  1. Confira:            git diff
  2. Commit e PR:        git checkout -b release/v$NOVA
                         git add VERSION CHANGELOG.md runner/package.json panel/package.json runner/package-lock.json
                         git diff --cached
                         git commit -m "Versao $NOVA" && git push -u origin release/v$NOVA
                         (abra o PR, passe a revisao e espere o ok do dono do projeto)
  3. Merge do PR na main (so com o ok do dono).
  4. Tag anotada no SHA do merge aprovado (nao no HEAD):
                         git fetch origin
                         SHA=\$(gh pr view <n do PR> --json mergeCommit -q .mergeCommit.oid)
                         git show \$SHA:VERSION        # tem que ser $NOVA
                         git tag -a v$NOVA \$SHA -m "DG Claw $NOVA"
  5. Publique a tag:     git push origin v$NOVA
  6. Confira a tag no GitHub e crie a release:
                         git ls-remote origin refs/tags/v$NOVA      # tem que listar a tag
                         gh release create v$NOVA --verify-tag --title "DG Claw $NOVA" --notes-file <notas em portugues tecnico>
Detalhes em docs/RELEASE.md.
PASSOS
