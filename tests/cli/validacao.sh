#!/usr/bin/env bash
# Entradas recusadas, com o motivo dito.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

for ruim in "A" "Ana" "-x" "a" "com_underscore" "com espaco" "$(printf 'a%.0s' {1..40})"; do
    nega "slug invalido recusado: '$ruim'" dgclaw agente criar "$ruim" --nome "X"
done
nega "slug 'admin' recusado" dgclaw agente criar admin --nome "Admin"
dgclaw agente criar admin --nome "Admin" >"$TMP/o.txt" 2>&1
afirma "a mensagem do admin diz que e reservado" grep -q "reservado" "$TMP/o.txt"
nega "sem --nome recusado" dgclaw agente criar ana
nega "provedor invalido recusado" dgclaw agente criar ana --nome X --provedor gpt
nega "canal invalido recusado" dgclaw agente criar ana --nome X --canal sinal
nega "cor invalida recusada" dgclaw agente criar ana --nome X --cor azul
nega "opcao desconhecida recusada" dgclaw agente criar ana --nome X --foo
nega "opcao sem valor recusada" dgclaw agente criar ana --nome
nega "nada foi criado pelas recusas" test -e "$ETC/registro.tsv"

touch "$STUB_ESTADO/sem-imagem"
dgclaw agente criar ana --nome "Ana" >"$TMP/o.txt" 2>&1
igual "imagem ausente: sai com 1" "1" "$?"
afirma "imagem ausente: diz para esperar 'dgclaw imagem status'" grep -q "dgclaw imagem status" "$TMP/o.txt"
nega "imagem ausente: nao reserva faixa" test -e "$ETC/registro.tsv"
nega "imagem ausente: nao chama podman create" grep -q '^podman create' "$STUB_LOG"

nega "comando desconhecido recusado" dgclaw coisa
afirma "--ajuda funciona e fala portugues" bash -c "'$CLI' --ajuda | grep -q 'agente criar'"
afirma "sem argumentos mostra a ajuda" bash -c "'$CLI' | grep -q 'imagem status'"

fim
