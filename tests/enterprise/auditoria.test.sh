#!/usr/bin/env bash
# lib/enterprise/auditoria.sh: nivel pessoal nao grava; corrente; trava; modo; erros que se explicam.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
export DGCLAW_QUEM=testador
ARQ="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"

# conferir: quem confere e o Node (o mesmo codigo que o painel usa), para provar que as duas pontas casam.
conferir() {
    ARQ="$ARQ" node -e '
        const { criarAuditoria } = require(process.argv[1] + "/web/lib/auditoria");
        const r = criarAuditoria({ caminho: process.env.ARQ }).verificar();
        console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1)' "$REPO"
}

echo "auditoria: nivel pessoal"
lib auditar teste '{"a":1}'
nega "pessoal: nada e gravado" test -e "$ARQ"

echo "auditoria: escritorio grava a corrente"
nivel_na_raiz escritorio
afirma "grava um evento" lib auditar agente.criar '{"slug":"ana"}'
afirma "grava outro" lib auditar nivel.definir '{"nivel":"empresa"}'
afirma "evento sem dados vira {}" lib auditar sem.dados
igual "tres linhas" 3 "$(wc -l <"$ARQ" | tr -d ' ')"
igual "arquivo 600" 600 "$(stat -c %a "$ARQ")"
igual "campos do contrato" "ts,evento,quem,origem,dados,ant,hash" "$(head -1 "$ARQ" | jq -r 'keys_unsorted | join(",")')"
igual "origem cli" cli "$(head -1 "$ARQ" | jq -r .origem)"
igual "quem vem do DGCLAW_QUEM" testador "$(head -1 "$ARQ" | jq -r .quem)"
igual "a primeira linha parte do zero" "0000000000000000000000000000000000000000000000000000000000000000" "$(sed -n 1p "$ARQ" | jq -r .ant)"
igual "a segunda aponta para o hash da primeira" "$(sed -n 1p "$ARQ" | jq -r .hash)" "$(sed -n 2p "$ARQ" | jq -r .ant)"
igual "o hash e o sha256 de ant + linha sem hash" \
    "$(sed -n 2p "$ARQ" | jq -r .hash)" \
    "$(sed -n 2p "$ARQ" | sed 's/,"hash":"[0-9a-f]*"}$/}/' | { printf '%s' "$(sed -n 1p "$ARQ" | jq -r .hash)"; cat | tr -d '\n'; } | sha256sum | cut -d' ' -f1)"
afirma "o Node confere a corrente que o bash escreveu" conferir
nega "nenhuma trava sobrando" test -e "$ARQ.trava"

echo "auditoria: adulteracao"
cp "$ARQ" "$TMP/bom.jsonl"
sed -i 's/"slug":"ana"/"slug":"eva"/' "$ARQ"
nega "linha alterada quebra a corrente" conferir
conferir >"$TMP/o.txt" 2>&1
afirma "a conferencia aponta a linha 1" grep -q '"quebradaEm":1' "$TMP/o.txt"
cp "$TMP/bom.jsonl" "$ARQ"

echo "auditoria: trava"
mkdir "$ARQ.trava"
touch -d '2 minutes ago' "$ARQ.trava"
lib auditar depois.da.trava.velha >"$TMP/o.txt" 2>&1
igual "trava velha nao impede" 0 "$?"
afirma "avisa que removeu a trava velha" grep -q "provavelmente morreu" "$TMP/o.txt"
nega "a trava velha saiu" test -e "$ARQ.trava"
mkdir "$ARQ.trava"
DGCLAW_AUDITORIA_ESPERA_DS=3 lib auditar preso >"$TMP/o.txt" 2>&1
igual "trava recente: desiste com erro" 1 "$?"
afirma "o erro diz o que fazer" grep -q "O que fazer" "$TMP/o.txt"
igual "nada foi gravado sem a trava" 4 "$(wc -l <"$ARQ" | tr -d ' ')"
rmdir "$ARQ.trava"

echo "auditoria: entradas ruins e ensaio"
nega "dados que nao sao objeto sao recusados" lib auditar x '[1,2]'
nega "dados que nao sao JSON sao recusados" lib auditar x 'isso nao e json'
nega "sem nome de evento" lib auditar
printf 'linha cortada' >>"$ARQ"
lib auditar depois.do.corte >"$TMP/o.txt" 2>&1
afirma "ultima linha sem hash: avisa e segue" grep -q "nao tem hash valido" "$TMP/o.txt"
nega "a conferencia aponta o corte" conferir
ENSAIO=1 lib auditar so.ensaio >"$TMP/o.txt" 2>&1
afirma "no ensaio nao grava, so anuncia" grep -q "ensaio" "$TMP/o.txt"
igual "o ensaio nao gravou" 6 "$(wc -l <"$ARQ" | tr -d ' ')"

echo "auditoria: unicode e aspas"
rm -f "$ARQ"
lib auditar acento "$(jq -nc '{texto: "ação \"difícil\" 😀"}')" >/dev/null
lib auditar acento2 '{}' >/dev/null
afirma "acento e aspas fecham a conta" conferir

echo "auditoria: nivel volta para pessoal"
nivel_na_raiz pessoal
rm -f "$ARQ"
lib auditar x
nega "volta a nao gravar" test -e "$ARQ"

fim
