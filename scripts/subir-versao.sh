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

ATUAL="$(tr -d '[:space:]' <"$ARQ_VERSION")"
RX='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ "$ATUAL" =~ $RX ]] || erro "o VERSION tem '$ATUAL', que nao e uma versao no formato X.Y.Z." "corrija o arquivo VERSION para algo como 1.0.0 e rode de novo."
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

# Escreve o resultado do jq por cima do arquivo (mantem permissoes e dono) so se o jq terminou bem.
jq_no_lugar() {
    local arq="$1"; shift
    local tmp; tmp="$(mktemp)"
    if ! jq --indent 2 "$@" "$arq" >"$tmp"; then
        rm -f "$tmp"
        erro "o jq nao conseguiu ler $arq." "confira se o arquivo e um JSON valido (git diff $arq)."
    fi
    cat "$tmp" >"$arq"; rm -f "$tmp"
}

printf '%s\n' "$NOVA" >"$ARQ_VERSION"
# shellcheck disable=SC2016  # o $v e do jq (--arg), nao do shell
for f in "${PACOTES[@]}"; do jq_no_lugar "$f" --arg v "$NOVA" '.version = $v'; done
# shellcheck disable=SC2016
for f in "${LOCKS[@]}"; do jq_no_lugar "$f" --arg v "$NOVA" '.version = $v | .packages[""].version = $v'; done

TMP_CL="$(mktemp)"
awk -v cab="$CABECALHO_NAO_LANCADO" -v nova="$NOVA" -v data="$DATA" '
    !feito && $0 == cab { print; print ""; print "## [" nova "] - " data; feito = 1; next }
    { print }
' "$ARQ_CHANGELOG" >"$TMP_CL"
cat "$TMP_CL" >"$ARQ_CHANGELOG"; rm -f "$TMP_CL"

cat <<PASSOS

Pronto: arquivos alterados, nada foi commitado. Proximos passos:
  1. Confira:            git diff
  2. Commit e PR:        git checkout -b release/v$NOVA && git commit -am "Versao $NOVA" && git push -u origin release/v$NOVA
                         (abra o PR, passe a revisao e espere o ok do dono do projeto)
  3. Merge do PR na main (so com o ok do dono).
  4. Tag anotada no commit do merge:
                         git checkout main && git pull
                         git tag -a v$NOVA -m "DG Claw $NOVA"
  5. Publique a tag:     git push origin v$NOVA
  6. Release no GitHub:  gh release create v$NOVA --title "DG Claw $NOVA" --notes-file <notas em portugues tecnico>
Detalhes em docs/RELEASE.md.
PASSOS
