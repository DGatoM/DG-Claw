#!/usr/bin/env bash
# A versao instalada: `dgclaw status` (primeira linha), `dgclaw versao`, `dgclaw --version`, e a
# garantia de que o arquivo VERSION, o panel/package.json e o runner/package.json dizem a mesma coisa.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

echo "versoes alinhadas no repositorio"
V="$(tr -d '[:space:]' <"$REPO/VERSION")"
afirma "VERSION tem uma versao no formato N.N.N" bash -c "[[ '$V' =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]"
igual "panel/package.json esta na versao do VERSION" "$V" "$(jq -r .version "$REPO/panel/package.json")"
igual "runner/package.json esta na versao do VERSION" "$V" "$(jq -r .version "$REPO/runner/package.json")"
igual "runner/package-lock.json (raiz) esta na versao do VERSION" "$V" "$(jq -r .version "$REPO/runner/package-lock.json")"
igual "runner/package-lock.json (pacote da raiz) esta na versao do VERSION" "$V" "$(jq -r '.packages[""].version' "$REPO/runner/package-lock.json")"

echo "versao registrada"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_VERSAO=1.0.0\nDGCLAW_COMMIT=abc123def4567890abc123def4567890abc12345\n' >"$ETC/dgclaw.env"
igual "dgclaw versao" "1.0.0 (commit abc123def456)" "$(dgclaw versao 2>&1)"
igual "dgclaw --version" "1.0.0 (commit abc123def456)" "$(dgclaw --version 2>&1)"
igual "a primeira linha do status e a versao" "DG Claw 1.0.0 (commit abc123def456)" "$(dgclaw status 2>&1 | head -n 1)"

echo "so a versao, sem commit (instalou de um zip)"
printf 'DGCLAW_VERSAO=1.0.0\n' >"$ETC/dgclaw.env"
igual "dgclaw versao sem commit" "1.0.0" "$(dgclaw versao 2>&1)"

echo "versao nao registrada"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"
igual "a primeira linha do status avisa" "DG Claw: versao nao registrada: rode sudo dgclaw atualizar ou ./install.sh de novo" "$(dgclaw status 2>&1 | head -n 1)"
dgclaw versao >"$TMP/o.txt" 2>&1; rc=$?
igual "dgclaw versao falha (1)" "1" "$rc"
afirma "e diz o que fazer" grep -q 'sudo dgclaw atualizar ou ./install.sh' "$TMP/o.txt"

fim
