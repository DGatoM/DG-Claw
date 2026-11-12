#!/usr/bin/env bash
# docs-em-dia: confere que o manual (docs/manual/*.md) acompanha o codigo.
#
# O inventario sai do CODIGO (scripts/docs-inventario.mjs) e o checar.mjs compara com o manual:
# item do codigo sem citacao, excecao sem justificativa ou obsoleta, link quebrado, travessao no
# meio de frase e item documentado na referencia que sumiu do codigo.
#
# Antes de olhar o manual de verdade, uma bancada com um manual FALSO prova que cada falha acontece
# (um verificador que nunca reprova nao serve para nada).
#
# Uso: bash tests/docs-em-dia/rodar.sh [--json]
# Saida: 0 = em dia, 1 = manual defasado, 2 = o proprio verificador quebrou (nunca passa em silencio).
# Env: DOCS_MANUAL_DIR=<pasta>   confere outra pasta no lugar de docs/manual (a bancada nao usa)
#
# Rapido e sem rede: so Node e bash.
set -uo pipefail

# O manual ja existe: a falta do docs/manual/README.md e defasagem (saida 1).
PERMITIR_MANUAL_AUSENTE=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECAR=("$REPO/tests/docs-em-dia/checar.mjs")
JSON=()
[ "${1:-}" = "--json" ] && JSON=(--json)

command -v node >/dev/null || { echo "docs-em-dia: falta o node no PATH (precisa do Node 22). Instale e rode de novo." >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
RUINS=0
OUT=""

# caso <nome> <saida esperada> <texto que a saida deve conter ("" = qualquer)> <VAR=valor...>: roda o checar.
caso() {
    local nome="$1" esperado="$2" contem="$3" rc=0
    shift 3
    OUT="$(env "$@" node "${CHECAR[0]}" 2>&1)" || rc=$?
    if [ "$rc" != "$esperado" ]; then
        printf '  FALHOU %s: esperava saida %s e veio %s. Saida:\n%s\n' "$nome" "$esperado" "$rc" "$OUT" >&2
        RUINS=$((RUINS + 1)); return
    fi
    if [ -n "$contem" ] && ! grep -qF -- "$contem" <<<"$OUT"; then
        printf '  FALHOU %s: a saida nao menciona "%s". Saida:\n%s\n' "$nome" "$contem" "$OUT" >&2
        RUINS=$((RUINS + 1)); return
    fi
    printf '  ok     %s\n' "$nome" >&2
}

# ---------------------------------------------------------------- manual e inventario falsos
INV="$TMP/inv.json"
cat >"$INV" <<'JSON'
{"telas":[{"id":"/mesa","origem":"web/server.js:1"},{"id":"aba:conversa","origem":"panel/public/index.html:1"}],
 "rotas":[{"id":"/api/v1/foco","origem":"web/server.js:2"},{"id":"GET /api/arquivos","origem":"panel/rotas/arquivos.js:3"}],
 "rotas_detalhe":[{"id":"/api/v1/foco/docs.md","origem":"web/lib/foco.js:4"}],
 "comandos":[{"id":"dgclaw agente criar","origem":"bin/dgclaw:5"}],
 "skills":[{"id":"agenda","origem":"skills/agenda/SKILL.md:1"}],
 "powers":[{"id":"crm","origem":"powers/crm"}],
 "canais":[{"id":"whatsapp","origem":"canais/whatsapp"}],
 "provedores":[{"id":"claude","origem":"providers/catalogo.json:1"}]}
JSON
CAB=$'# Excecoes de teste\n'

novo_manual() { # novo_manual <pasta>: manual verde
    local d="$1"
    mkdir -p "$d"
    cat >"$d/README.md" <<'MD'
# Manual

A tela `/mesa` e a aba:conversa existem. A familia /api/v1/foco e a rota GET /api/arquivos tambem.
Para criar use dgclaw agente criar. A skill `agenda`, o power `crm`, o canal `whatsapp` e o provedor `claude` estao aqui.

Veja o [guia](guia.md#primeiros-passos) e a [referencia](referencia-admin.md).

## Titulo com — travessao

| coluna — com travessao | b |
| --- | --- |

- **Rotulo** — o travessao logo depois do rotulo da lista e separador.

```
bloco de codigo — com travessao
```
MD
    printf '# Guia\n\n## Primeiros passos\n\nTexto.\n' >"$d/guia.md"
    cat >"$d/referencia-admin.md" <<'MD'
# Referencia

<!-- inventario:inicio -->
- GET /api/arquivos
- `/api/v1/foco/docs.md`
- dgclaw agente criar meu-agente
<!-- inventario:fim -->
MD
    printf '%s' "$CAB" >"$d/excecoes.tsv"
}

echo "bancada do verificador (manual falso):" >&2
M="$TMP/m"; novo_manual "$M"
caso "manual falso em dia" 0 "manual em dia" DOCS_MANUAL_DIR="$M" DOCS_INVENTARIO_ARQUIVO="$INV"

# item novo no codigo, sem doc
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));j.comandos.push({id:"dgclaw agente sumir",origem:"bin/dgclaw:99"});require("fs").writeFileSync(process.argv[2],JSON.stringify(j))' "$INV" "$TMP/inv-novo.json"
caso "item novo sem doc reprova" 1 "dgclaw agente sumir" DOCS_MANUAL_DIR="$M" DOCS_INVENTARIO_ARQUIVO="$TMP/inv-novo.json"
caso "a mensagem traz a origem" 1 "bin/dgclaw:99" DOCS_MANUAL_DIR="$M" DOCS_INVENTARIO_ARQUIVO="$TMP/inv-novo.json"
# ... e a excecao com justificativa o libera
cp -r "$M" "$TMP/m-exc"; printf '%scomando\tdgclaw agente sumir\tcomando interno de teste\n' "$CAB" >"$TMP/m-exc/excecoes.tsv"
caso "excecao justificada libera" 0 "manual em dia" DOCS_MANUAL_DIR="$TMP/m-exc" DOCS_INVENTARIO_ARQUIVO="$TMP/inv-novo.json"

# excecao sem justificativa
cp -r "$M" "$TMP/m-sem"; printf '%scomando\tdgclaw agente sumir\t\n' "$CAB" >"$TMP/m-sem/excecoes.tsv"
caso "excecao sem justificativa reprova" 1 "sem justificativa" DOCS_MANUAL_DIR="$TMP/m-sem" DOCS_INVENTARIO_ARQUIVO="$TMP/inv-novo.json"

# excecao obsoleta
cp -r "$M" "$TMP/m-obs"; printf '%scomando\tdgclaw nao-existe\tfoi removido\n' "$CAB" >"$TMP/m-obs/excecoes.tsv"
caso "excecao obsoleta reprova" 1 "obsoleta" DOCS_MANUAL_DIR="$TMP/m-obs" DOCS_INVENTARIO_ARQUIVO="$INV"

# link quebrado (arquivo e ancora)
cp -r "$M" "$TMP/m-link"; printf '\nVeja [isto](nao-existe.md).\n' >>"$TMP/m-link/README.md"
caso "link para arquivo inexistente reprova" 1 "nao-existe.md" DOCS_MANUAL_DIR="$TMP/m-link" DOCS_INVENTARIO_ARQUIVO="$INV"
cp -r "$M" "$TMP/m-anc"; printf '\nVeja [isto](guia.md#titulo-que-nao-existe).\n' >>"$TMP/m-anc/README.md"
caso "ancora inexistente reprova" 1 "titulo-que-nao-existe" DOCS_MANUAL_DIR="$TMP/m-anc" DOCS_INVENTARIO_ARQUIVO="$INV"

# travessao e meia-risca no meio de frase
cp -r "$M" "$TMP/m-tr"; printf '\nIsto e uma frase \xe2\x80\x94 com travessao no meio.\n' >>"$TMP/m-tr/guia.md"
caso "travessao em frase reprova" 1 "travessao" DOCS_MANUAL_DIR="$TMP/m-tr" DOCS_INVENTARIO_ARQUIVO="$INV"
cp -r "$M" "$TMP/m-mr"; printf '\nOutra frase \xe2\x80\x93 com meia-risca.\n' >>"$TMP/m-mr/guia.md"
caso "meia-risca em frase reprova" 1 "meia-risca" DOCS_MANUAL_DIR="$TMP/m-mr" DOCS_INVENTARIO_ARQUIVO="$INV"

# item documentado na referencia que sumiu do codigo
cp -r "$M" "$TMP/m-sumiu"; sed -i 's#^<!-- inventario:fim -->#- POST /api/v1/foco-antigo/x\n- dgclaw agente apagar-tudo\n<!-- inventario:fim -->#' "$TMP/m-sumiu/referencia-admin.md"
caso "rota que sumiu do codigo reprova" 1 "/api/v1/foco-antigo/x" DOCS_MANUAL_DIR="$TMP/m-sumiu" DOCS_INVENTARIO_ARQUIVO="$INV"
caso "comando que sumiu do codigo reprova" 1 "dgclaw agente apagar-tudo" DOCS_MANUAL_DIR="$TMP/m-sumiu" DOCS_INVENTARIO_ARQUIVO="$INV"

# --json: uma linha JSON por achado, com os cinco campos
cp -r "$M" "$TMP/m-j"; rc=0
JOUT="$(DOCS_MANUAL_DIR="$TMP/m-j" DOCS_INVENTARIO_ARQUIVO="$TMP/inv-novo.json" node "${CHECAR[0]}" --json 2>&1)" || rc=$?
if [ "$rc" = 1 ] && [ "$(wc -l <<<"$JOUT")" = 1 ] && node -e 'const o=JSON.parse(process.argv[1]);for(const k of ["tipo","item","origem","falta_em","como_resolver"])if(!o[k])process.exit(1)' "$JOUT"; then
    echo "  ok     --json: um JSON por linha com tipo, item, origem, falta_em e como_resolver" >&2
else
    printf '  FALHOU --json: saida %s:\n%s\n' "$rc" "$JOUT" >&2; RUINS=$((RUINS + 1))
fi

# saida 2: o verificador quebrado nunca passa em silencio
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));j.skills=[];require("fs").writeFileSync(process.argv[2],JSON.stringify(j))' "$INV" "$TMP/inv-vazio.json"
caso "inventario com lista zerada sai 2" 2 "skills" DOCS_MANUAL_DIR="$M" DOCS_INVENTARIO_ARQUIVO="$TMP/inv-vazio.json"
mkdir -p "$TMP/raiz-vazia"
caso "extrator sem os arquivos do codigo sai 2" 2 "extrator" DOCS_MANUAL_DIR="$M" DOCS_RAIZ="$TMP/raiz-vazia"
cp -r "$M" "$TMP/m-sem-exc"; rm "$TMP/m-sem-exc/excecoes.tsv"
caso "manual sem excecoes.tsv sai 2" 2 "excecoes.tsv" DOCS_MANUAL_DIR="$TMP/m-sem-exc" DOCS_INVENTARIO_ARQUIVO="$INV"
caso "pasta do manual inexistente sai 2" 2 "nao existe" DOCS_MANUAL_DIR="$TMP/nao-ha" DOCS_INVENTARIO_ARQUIVO="$INV"

# extrator: determinismo e a presenca de itens que existem de verdade
a="$(node "$REPO/scripts/docs-inventario.mjs" | md5sum)"; b="$(node "$REPO/scripts/docs-inventario.mjs" | md5sum)"
if [ "$a" = "$b" ]; then echo "  ok     o inventario e deterministico (duas rodadas, mesma saida)" >&2
else echo "  FALHOU o inventario muda entre duas rodadas" >&2; RUINS=$((RUINS + 1)); fi
REAL="$(node "$REPO/scripts/docs-inventario.mjs" 2>&1)" || { echo "  FALHOU o extrator quebrou no repositorio real:" >&2; echo "$REAL" >&2; exit 2; }
for esperado in '"/api/v1/lembretes"' '"/mesa"' '"dgclaw agente criar"' '"GET /api/arquivos"' '"agenda"' '"claude"'; do
    if grep -qF -- "$esperado" <<<"$REAL"; then :; else echo "  FALHOU o inventario real nao tem $esperado" >&2; RUINS=$((RUINS + 1)); fi
done
[ "$RUINS" = 0 ] && echo "  ok     o inventario real tem as ancoras conhecidas" >&2

if [ "$RUINS" -gt 0 ]; then
    echo "docs-em-dia: a bancada do verificador falhou em $RUINS caso(s); o verificador esta quebrado (nao confie no resultado)." >&2
    exit 2
fi

# ---------------------------------------------------------------- o manual de verdade
MANUAL="${DOCS_MANUAL_DIR:-$REPO/docs/manual}"
if [ ! -f "$MANUAL/README.md" ]; then
    if [ "$PERMITIR_MANUAL_AUSENTE" = 1 ] && [ -z "${DOCS_MANUAL_DIR:-}" ]; then
        echo "docs-em-dia: aviso: ainda nao existe $MANUAL/README.md (o manual esta sendo escrito). Rodei so a bancada." >&2
        exit 0
    fi
    echo "docs-em-dia: falta $MANUAL/README.md. O manual do DG Claw precisa ter um README.md que apresente as demais paginas; crie-o." >&2
    exit 1
fi
node "${CHECAR[0]}" "${JSON[@]}"
