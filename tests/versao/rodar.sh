#!/usr/bin/env bash
# Consistencia das versoes do repositorio: VERSION, runner/package.json, panel/package.json,
# runner/package-lock.json (.version e .packages[""].version) e o primeiro cabecalho "## [X.Y.Z]" lancado do
# CHANGELOG precisam dizer o mesmo numero. Roteiro da release: docs/RELEASE.md.
# Uso: bash tests/versao/rodar.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Mesmo limite do leitor do aviso (RX_VERSAO_REMOTA em scripts/checar-atualizacao.mjs): ate 4 digitos por parte.
RX='^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'  # sem zero a esquerda (semver)
TESTES=0; FALHAS=0
ok()  { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }

fim() { printf '\nversao: %s verificacoes, %s falharam\n' "$TESTES" "$FALHAS"; [ "$FALHAS" -eq 0 ]; }

echo "nenhum caminho da versao e link simbolico"
for rel in VERSION CHANGELOG.md runner panel runner/package.json panel/package.json runner/package-lock.json; do
    if [ -L "$REPO/$rel" ]; then
        mal "$rel e link simbolico"
    else
        ok "$rel nao e link simbolico"
    fi
done
if [ "$FALHAS" -ne 0 ]; then fim; exit $?; fi

# valida <caminho> <campo> <valor>: so imprime valor que passou na regex; senao encerra.
valida() {
    if [[ "$3" =~ $RX ]]; then
        ok "$1: $2 = $3"
    else
        mal "$1: campo $2 fora do formato X.Y.Z"
        fim; exit $?
    fi
}

echo "versoes no formato X.Y.Z"
V="$(<"$REPO/VERSION")"   # o $(...) tira so o fim de linha; espaco dentro do valor reprova pela regex
valida VERSION "conteudo" "$V"
RUNNER="$(jq -r '.version // ""' "$REPO/runner/package.json")" || { mal "runner/package.json: nao consegui ler o JSON"; fim; exit $?; }
valida runner/package.json version "$RUNNER"
PANEL="$(jq -r '.version // ""' "$REPO/panel/package.json")" || { mal "panel/package.json: nao consegui ler o JSON"; fim; exit $?; }
valida panel/package.json version "$PANEL"
LOCK_RAIZ="$(jq -r '.version // ""' "$REPO/runner/package-lock.json")" || { mal "runner/package-lock.json: nao consegui ler o JSON"; fim; exit $?; }
valida runner/package-lock.json ".version" "$LOCK_RAIZ"
LOCK_PACOTE="$(jq -r '.packages[""].version // ""' "$REPO/runner/package-lock.json")" || { mal "runner/package-lock.json: nao consegui ler o JSON"; fim; exit $?; }
valida runner/package-lock.json '.packages[""].version' "$LOCK_PACOTE"
CL="$(sed -n 's/^## \[\([0-9][^]]*\)\].*/\1/p' "$REPO/CHANGELOG.md" | head -n 1)"
valida CHANGELOG.md "primeiro cabecalho lancado" "$CL"

echo "os valores batem"
for par in "runner/package.json:$RUNNER" "panel/package.json:$PANEL" "runner/package-lock.json (.version):$LOCK_RAIZ" \
           "runner/package-lock.json (.packages[\"\"].version):$LOCK_PACOTE" "CHANGELOG.md (primeiro cabecalho lancado):$CL"; do
    if [ "${par##*:}" = "$V" ]; then ok "${par%:*} = VERSION ($V)"; else mal "${par%:*} = ${par##*:}, diferente de VERSION ($V)"; fi
done

fim
