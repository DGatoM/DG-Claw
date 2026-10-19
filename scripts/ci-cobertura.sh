#!/usr/bin/env bash
# Resume a cobertura de linhas do CI: lê <pasta>/web.lcov e <pasta>/runner.lcov, escreve a tabela
# no resumo da rodada ($GITHUB_STEP_SUMMARY, ou na tela se a variável não existir) e grava
# <pasta>/cobertura.json no formato do endpoint do shields.io.
# Uso: bash scripts/ci-cobertura.sh <pasta com os lcov>
set -euo pipefail

falha() { echo "ERRO: $1 | O que fazer: $2" >&2; exit 1; }

pasta="${1:-}"
[ -n "$pasta" ] || falha "faltou a pasta dos lcov" "rode: bash scripts/ci-cobertura.sh cobertura"
for pacote in web runner; do
  [ -s "$pasta/$pacote.lcov" ] || falha "não achei $pasta/$pacote.lcov (ou está vazio)" "rode os testes do $pacote com --test-reporter=lcov e confira o caminho do destino"
done

# Percentual de linhas = soma de LH (cobertas) sobre soma de LF (executáveis) do lcov.
linhas() { awk -F: '/^LF:/{f+=$2} /^LH:/{h+=$2} END{printf "%d %d\n", h, f}' "$1"; }
pct() { awk -v h="$1" -v f="$2" 'BEGIN{ if (f==0) print "0.0"; else printf "%.1f", 100*h/f }'; }

read -r hw fw < <(linhas "$pasta/web.lcov")
read -r hr fr < <(linhas "$pasta/runner.lcov")
if [ "$fw" -eq 0 ] || [ "$fr" -eq 0 ]; then
  falha "o lcov veio sem linhas (web=$fw, runner=$fr), então a cobertura não foi medida" "rode 'node --test --experimental-test-coverage' localmente e confira o conteúdo do lcov"
fi

ht=$((hw + hr))
ft=$((fw + fr))
pw=$(pct "$hw" "$fw")
pr=$(pct "$hr" "$fr")
pt=$(pct "$ht" "$ft")

{
  echo "### Cobertura de linhas"
  echo
  echo "| Pacote | Linhas cobertas | Linhas executáveis | Cobertura |"
  echo "| --- | ---: | ---: | ---: |"
  echo "| web | $hw | $fw | ${pw}% |"
  echo "| runner | $hr | $fr | ${pr}% |"
  echo "| **total** | $ht | $ft | **${pt}%** |"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"

inteiro=$(awk -v p="$pt" 'BEGIN{printf "%d", p + 0.5}')
if   [ "$inteiro" -ge 90 ]; then cor=brightgreen
elif [ "$inteiro" -ge 80 ]; then cor=green
elif [ "$inteiro" -ge 70 ]; then cor=yellowgreen
elif [ "$inteiro" -ge 60 ]; then cor=yellow
elif [ "$inteiro" -ge 50 ]; then cor=orange
else cor=red
fi

printf '{"schemaVersion":1,"label":"cobertura","message":"%s%%","color":"%s"}\n' "$inteiro" "$cor" > "$pasta/cobertura.json"
cat "$pasta/cobertura.json"
