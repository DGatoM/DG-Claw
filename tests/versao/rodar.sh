#!/usr/bin/env bash
# scripts/subir-versao.sh numa copia minima do repositorio (pasta temporaria), e a consistencia das versoes do
# repositorio de verdade: VERSION, runner/package.json, panel/package.json, o lock do runner e o primeiro
# cabecalho lancado do CHANGELOG precisam dizer o mesmo numero.
# Uso: bash tests/versao/rodar.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO/scripts/subir-versao.sh"
TESTES=0; FALHAS=0
ok()  { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }
igual() { if [ "$2" = "$3" ]; then ok "$1"; else mal "$1 (esperado '$2', veio '$3')"; fi; }
tem() { case "$3" in *"$2"*) ok "$1" ;; *) mal "$1 (nao achei '$2' em: $3)" ;; esac; }

TMP="$(mktemp -d)" || { echo "nao consegui criar a pasta temporaria do teste" >&2; exit 1; }
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then echo "a pasta temporaria do teste ficou vazia" >&2; exit 1; fi
trap 'rm -rf "$TMP"' EXIT

primeira_versao_do_changelog() { sed -n 's/^## \[\([0-9][0-9.]*\)\].*/\1/p' "$1" | head -n 1; }

echo "consistencia das versoes no repositorio"
V="$(tr -d '[:space:]' <"$REPO/VERSION")"
if [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then ok "VERSION no formato X.Y.Z ($V)"; else mal "VERSION nao e X.Y.Z: '$V'"; fi
igual "runner/package.json" "$V" "$(jq -r .version "$REPO/runner/package.json")"
igual "panel/package.json" "$V" "$(jq -r .version "$REPO/panel/package.json")"
igual "runner/package-lock.json (raiz)" "$V" "$(jq -r .version "$REPO/runner/package-lock.json")"
igual "runner/package-lock.json (pacote da raiz)" "$V" "$(jq -r '.packages[""].version' "$REPO/runner/package-lock.json")"
igual "primeiro cabecalho lancado do CHANGELOG" "$V" "$(primeira_versao_do_changelog "$REPO/CHANGELOG.md")"

# nova_copia <versao> <conteudo de Nao lancado>: repositorio falso em $R, sem git.
nova_copia() {
    R="$TMP/repo-$RANDOM$RANDOM"
    mkdir -p "$R/runner" "$R/panel"
    printf '%s\n' "$1" >"$R/VERSION"
    printf '{\n  "name": "runner",\n  "version": "%s",\n  "private": true\n}\n' "$1" >"$R/runner/package.json"
    printf '{\n  "name": "panel",\n  "version": "%s",\n  "private": true\n}\n' "$1" >"$R/panel/package.json"
    printf '{\n  "name": "runner",\n  "version": "%s",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "runner",\n      "version": "%s"\n    },\n    "node_modules/x": {\n      "version": "9.9.9"\n    }\n  }\n}\n' "$1" "$1" >"$R/runner/package-lock.json"
    printf '# Changelog\n\n## [Não lançado]\n%s\n## [%s] - 2026-10-19\n\nVersao antiga.\n' "$2" "$1" >"$R/CHANGELOG.md"
}
roda() { RC=0; SAIDA="$(DGCLAW_REPO="$R" bash "$SCRIPT" "$@" 2>&1)" || RC=$?; }
confere() { # confere <versao esperada>
    igual "VERSION" "$1" "$(tr -d '[:space:]' <"$R/VERSION")"
    igual "runner/package.json" "$1" "$(jq -r .version "$R/runner/package.json")"
    igual "panel/package.json" "$1" "$(jq -r .version "$R/panel/package.json")"
    igual "lock (raiz)" "$1" "$(jq -r .version "$R/runner/package-lock.json")"
    igual "lock (pacote da raiz)" "$1" "$(jq -r '.packages[""].version' "$R/runner/package-lock.json")"
    igual "lock: dependencia nao mexe" "9.9.9" "$(jq -r '.packages["node_modules/x"].version' "$R/runner/package-lock.json")"
    igual "CHANGELOG: primeira versao lancada" "$1" "$(primeira_versao_do_changelog "$R/CHANGELOG.md")"
}
NOVIDADE=$'\n**Correção: algo.** Texto da mudança.\n'

echo "patch"
nova_copia 1.0.0 "$NOVIDADE"; roda patch
igual "sai 0" 0 "$RC"; confere 1.0.1
tem "CHANGELOG: data de hoje" "## [1.0.1] - $(date +%F)" "$(cat "$R/CHANGELOG.md")"
tem "CHANGELOG: a mudanca foi para a versao nova" "Texto da mudança." "$(sed -n '/^## \[1.0.1\]/,/^## \[1.0.0\]/p' "$R/CHANGELOG.md")"
igual "CHANGELOG: Nao lancado fica vazio" "" "$(sed -n '/^## \[Não lançado\]/,/^## \[1.0.1\]/p' "$R/CHANGELOG.md" | grep -v '^## \[' | tr -d '[:space:]')"
tem "CHANGELOG: a versao antiga continua" "Versao antiga." "$(cat "$R/CHANGELOG.md")"
tem "imprime a tag anotada no SHA do merge" "tag -a v1.0.1 \$SHA -m" "$SAIDA"
tem "imprime a conferencia da tag remota" "ls-remote origin refs/tags/v1.0.1" "$SAIDA"
tem "release com --verify-tag" "gh release create v1.0.1 --verify-tag" "$SAIDA"
tem "imprime o push da tag" "git push origin v1.0.1" "$SAIDA"

echo "minor"
nova_copia 1.4.7 "$NOVIDADE"; roda minor
igual "sai 0" 0 "$RC"; confere 1.5.0

echo "major"
nova_copia 1.4.7 "$NOVIDADE"; roda major
igual "sai 0" 0 "$RC"; confere 2.0.0

echo "recusa: Nao lancado vazio"
nova_copia 1.0.0 $'\n'; ANTES="$(cat "$R/CHANGELOG.md")"; roda patch
igual "sai 1" 1 "$RC"
tem "diz o que falhou" "esta vazia" "$SAIDA"
tem "diz o que fazer" "O que fazer" "$SAIDA"
confere 1.0.0
igual "CHANGELOG intacto" "$ANTES" "$(cat "$R/CHANGELOG.md")"

echo "recusa: versao ja existe no CHANGELOG"
nova_copia 1.0.0 "$NOVIDADE"
printf '\n## [1.0.1] - 2026-10-01\n\nJa lancada.\n' >>"$R/CHANGELOG.md"; ANTES="$(cat "$R/CHANGELOG.md")"; roda patch
igual "sai 1" 1 "$RC"
tem "diz que a versao ja existe" "1.0.1 ja existe" "$SAIDA"
igual "VERSION intacto" "1.0.0" "$(tr -d '[:space:]' <"$R/VERSION")"
igual "CHANGELOG intacto" "$ANTES" "$(cat "$R/CHANGELOG.md")"

echo "recusa: a tag ja existe"
nova_copia 1.0.0 "$NOVIDADE"
git -C "$R" init -q && git -C "$R" add -A \
    && git -C "$R" -c user.name=t -c user.email=t@example.org commit -q -m teste \
    && git -C "$R" -c user.name=t -c user.email=t@example.org tag -a v1.0.1 -m teste
roda patch
igual "sai 1" 1 "$RC"
tem "diz que a tag ja existe" "tag v1.0.1 ja existe" "$SAIDA"
igual "VERSION intacto" "1.0.0" "$(tr -d '[:space:]' <"$R/VERSION")"

echo "recusa: VERSION fora do formato, nivel invalido"
nova_copia 1.0.0 "$NOVIDADE"; printf 'v1\n' >"$R/VERSION"; roda patch
igual "sai 1" 1 "$RC"; tem "diz que nao e X.Y.Z" "X.Y.Z" "$SAIDA"
roda grande
igual "nivel invalido sai 1" 1 "$RC"
roda
igual "sem nivel sai 1" 1 "$RC"

echo "recusa: VERSION e link simbolico"
nova_copia 1.0.0 "$NOVIDADE"; mv "$R/VERSION" "$R/VERSION.real"; ln -s VERSION.real "$R/VERSION"; roda patch
igual "sai 1" 1 "$RC"; tem "diz que e link" "link simbolico" "$SAIDA"
igual "o alvo do link nao mudou" "1.0.0" "$(tr -d '[:space:]' <"$R/VERSION.real")"

echo "recusa: VERSION fora do formato nao imprime o conteudo"
nova_copia 1.0.0 "$NOVIDADE"; printf 'SEGREDO-NO-ARQUIVO\n' >"$R/VERSION"; roda patch
igual "sai 1" 1 "$RC"
case "$SAIDA" in *SEGREDO-NO-ARQUIVO*) mal "a mensagem imprimiu o conteudo do VERSION" ;; *) ok "a mensagem nao imprime o conteudo do VERSION" ;; esac

echo "recusa: arvore suja (repo git temporario)"
nova_copia 1.0.0 "$NOVIDADE"
git -C "$R" init -q && git -C "$R" add -A && git -C "$R" -c user.name=t -c user.email=t@example.org commit -q -m base
echo "sujeira" >>"$R/runner/package.json.txt"; echo x >>"$R/CHANGELOG.md"
roda patch
igual "arvore suja: sai 1" 1 "$RC"; tem "diz o que falhou" "nao commitadas" "$SAIDA"
igual "VERSION intacto" "1.0.0" "$(tr -d '[:space:]' <"$R/VERSION")"
roda --simular patch
igual "--simular so avisa (sai 0)" 0 "$RC"; tem "o aviso aparece" "AVISO" "$SAIDA"
git -C "$R" checkout -q -- CHANGELOG.md; git -C "$R" add -A runner/package.json.txt
roda patch
igual "indice sujo: sai 1" 1 "$RC"; tem "diz que e o indice" "indice" "$SAIDA"
git -C "$R" reset -q; rm -f "$R/runner/package.json.txt"; echo x >"$R/VERSION.novo"
printf 'x\n' >"$R/panel/extra.txt"
git -C "$R" -c user.name=t -c user.email=t@example.org add -A
git -C "$R" -c user.name=t -c user.email=t@example.org commit -q -m extra
roda patch
igual "arvore limpa: sai 0" 0 "$RC"; confere 1.0.1

echo "tudo ou nada: panel/package.json invalido"
nova_copia 1.0.0 "$NOVIDADE"; printf 'isto nao e json\n' >"$R/panel/package.json"
( cd "$R" && md5sum VERSION CHANGELOG.md runner/package.json panel/package.json runner/package-lock.json ) >"$TMP/antes5.txt"
roda patch
igual "sai 1" 1 "$RC"; tem "diz o que falhou" "panel/package.json" "$SAIDA"
( cd "$R" && md5sum VERSION CHANGELOG.md runner/package.json panel/package.json runner/package-lock.json ) >"$TMP/depois5.txt"
igual "os cinco arquivos ficaram identicos" "$(cat "$TMP/antes5.txt")" "$(cat "$TMP/depois5.txt")"

echo "--simular nao muda nada"
nova_copia 1.0.0 "$NOVIDADE"
( cd "$R" && find . -type f -print0 | sort -z | xargs -0 md5sum ) >"$TMP/antes.txt"
roda --simular minor
igual "sai 0" 0 "$RC"
tem "mostra a versao nova" "1.1.0" "$SAIDA"
tem "diz que nada foi alterado" "nada foi alterado" "$SAIDA"
( cd "$R" && find . -type f -print0 | sort -z | xargs -0 md5sum ) >"$TMP/depois.txt"
igual "nenhum arquivo mudou" "$(cat "$TMP/antes.txt")" "$(cat "$TMP/depois.txt")"

printf '\nversao: %s verificacoes, %s falharam\n' "$TESTES" "$FALHAS"
[ "$FALHAS" -eq 0 ]
