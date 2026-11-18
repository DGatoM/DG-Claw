#!/usr/bin/env bash
# bin/dgclaw-pesado no caminho SEM gerente systemd do usuário (XDG_RUNTIME_DIR vazio): validação dos
# argumentos, código de saída, teto de tempo, stdin, e o recolhimento do que o comando deixa para trás.
# Uso: bash bin/test/dgclaw-pesado.test.sh
# shellcheck disable=SC2015,SC2181  # "teste && ok || mal" é o formato desta bateria
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PESADO="$REPO/bin/dgclaw-pesado"
TMP="$(mktemp -d)"
ruins=0
ok()  { printf '  ok     %s\n' "$1"; }
mal() { printf '  FALHOU %s\n' "$1"; ruins=$((ruins + 1)); }

FORA=""
cleanup() {
    [ -z "$FORA" ] || kill "$FORA" 2>/dev/null
    for f in "$TMP"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
    rm -rf "$TMP"
}
trap cleanup EXIT

# Sem socket do systemd nesta pasta, o script cai no caminho de grupo de processos.
mkdir -p "$TMP/run"
export XDG_RUNTIME_DIR="$TMP/run"
unset DGCLAW_PESADO DGCLAW_PESADO_TIMEOUT DGCLAW_PESADO_MEM

echo "dgclaw-pesado: argumentos"
"$PESADO" 2>/dev/null; [ $? -eq 2 ] && ok "sem comando sai com 2" || mal "sem comando"
"$PESADO" --mem 12x -- true 2>/dev/null; [ $? -eq 2 ] && ok "--mem inválido sai com 2" || mal "--mem inválido"
"$PESADO" --timeout abc -- true 2>/dev/null; [ $? -eq 2 ] && ok "--timeout inválido sai com 2" || mal "--timeout inválido"
"$PESADO" --timeout -5 -- true 2>/dev/null; [ $? -eq 2 ] && ok "--timeout negativo sai com 2" || mal "--timeout negativo"
"$PESADO" --timeout 0 -- true 2>/dev/null; [ $? -eq 0 ] && ok "--timeout 0 significa sem teto" || mal "--timeout 0"

echo "dgclaw-pesado: código de saída e stdin"
"$PESADO" -- sh -c 'exit 7' 2>/dev/null; [ $? -eq 7 ] && ok "repassa o código do comando" || mal "código do comando"
[ "$(echo x | "$PESADO" -- cat 2>/dev/null)" = "x" ] && ok "o stdin chega ao comando" || mal "stdin"
DGCLAW_PESADO=1 "$PESADO" -- sh -c 'exit 5'; [ $? -eq 5 ] && ok "já dentro de um dgclaw-pesado, só executa" || mal "execução direta"

echo "dgclaw-pesado: teto de tempo"
t0=$SECONDS
"$PESADO" --timeout 1 -- sleep 30 2>/dev/null; rc=$?
[ "$rc" -eq 124 ] && [ $((SECONDS - t0)) -lt 8 ] && ok "estouro do tempo sai com 124 em poucos segundos" || mal "timeout (código $rc, $((SECONDS - t0)) s)"
DGCLAW_PESADO_TIMEOUT=1 "$PESADO" -- sleep 30 2>/dev/null; [ $? -eq 124 ] && ok "DGCLAW_PESADO_TIMEOUT vale como padrão" || mal "timeout por variável"

echo "dgclaw-pesado: recolhe o que sobrou"
sleep 300 & FORA=$!
"$PESADO" -- sh -c "sleep 300 & echo \$! > '$TMP/neto.pid'; exit 0" 2>/dev/null; rc=$?
neto="$(cat "$TMP/neto.pid" 2>/dev/null)"
[ "$rc" -eq 0 ] && ok "comando que deixa neto sai com 0" || mal "código com neto: $rc"
sleep 0.3
if [ -n "$neto" ] && ! kill -0 "$neto" 2>/dev/null; then ok "o neto em segundo plano morreu ao fim"; else mal "o neto sobrou (pid $neto)"; fi
kill -0 "$FORA" 2>/dev/null && ok "um processo iniciado fora do invólucro continua vivo" || mal "o processo de fora morreu"

echo "dgclaw-pesado: sinal no invólucro"
"$PESADO" -- sh -c "sleep 300 & echo \$! > '$TMP/neto2.pid'; wait" 2>/dev/null &
inv=$!
for _ in $(seq 1 20); do [ -s "$TMP/neto2.pid" ] && break; sleep 0.2; done
kill -TERM "$inv"; wait "$inv" 2>/dev/null; rc=$?
neto2="$(cat "$TMP/neto2.pid" 2>/dev/null)"
sleep 0.3
[ "$rc" -eq 143 ] && ok "TERM no invólucro sai com 143" || mal "código após TERM: $rc"
if [ -n "$neto2" ] && ! kill -0 "$neto2" 2>/dev/null; then ok "TERM no invólucro também recolhe o comando e o neto"; else mal "sobrou processo após TERM (pid $neto2)"; fi

echo
if [ "$ruins" -eq 0 ]; then echo "dgclaw-pesado: tudo ok"; else echo "dgclaw-pesado: $ruins falha(s)"; exit 1; fi
