#!/usr/bin/env bash
# bin/dgclaw-pesado no caminho SEM gerente systemd do usuário (XDG_RUNTIME_DIR vazio): validação dos
# argumentos, código de saída, teto de tempo, stdin, e o recolhimento do que o comando deixa para trás.
# Uso: bash bin/test/dgclaw-pesado.test.sh
# shellcheck disable=SC2015,SC2181,SC2016  # "teste && ok || mal" é o formato desta bateria
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PESADO="$REPO/bin/dgclaw-pesado"
TMP="$(mktemp -d)" || exit 1
[ -n "$TMP" ] && [ -d "$TMP" ] || { echo "dgclaw-pesado.test: não consegui criar a pasta temporária" >&2; exit 1; }
ruins=0
ok()  { printf '  ok     %s\n' "$1"; }
mal() { printf '  FALHOU %s\n' "$1"; ruins=$((ruins + 1)); }

FORA=""
cleanup() {
    [ -z "$FORA" ] || kill "$FORA" 2>/dev/null
    local f
    for f in "$TMP"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
    rm -rf "${TMP:?}"
}
trap cleanup EXIT

# Sem socket do systemd nesta pasta, o script cai no caminho de grupo de processos.
mkdir -p "$TMP/run"
export XDG_RUNTIME_DIR="$TMP/run"
unset DGCLAW_PESADO DGCLAW_PESADO_TIMEOUT DGCLAW_PESADO_MEM

echo "dgclaw-pesado: argumentos"
"$PESADO" 2>/dev/null; [ $? -eq 2 ] && ok "sem comando sai com 2" || mal "sem comando"
"$PESADO" --mem 12x -- true 2>/dev/null; [ $? -eq 2 ] && ok "--mem inválido sai com 2" || mal "--mem inválido"
"$PESADO" --mem 2GG -- true 2>/dev/null; [ $? -eq 2 ] && ok "--mem 2GG sai com 2" || mal "--mem 2GG"
"$PESADO" --mem 2G5 -- true 2>/dev/null; [ $? -eq 2 ] && ok "--mem 2G5 sai com 2" || mal "--mem 2G5"
"$PESADO" --mem "" -- true 2>/dev/null; [ $? -eq 2 ] && ok "--mem vazio sai com 2" || mal "--mem vazio"
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

echo "dgclaw-pesado: comando que começa com hífen e teto de tempo com TERM ignorado"
"$PESADO" -- --help >/dev/null 2>&1; rc=$?
[ "$rc" -eq 127 ] && ok "comando começando com - não vira opção do nice (127)" || mal "-- --help saiu com $rc"
t0=$SECONDS
"$PESADO" --timeout 1 -- sh -c 'trap "" TERM; sleep 30' 2>/dev/null; rc=$?
[ "$rc" -eq 124 ] && ok "KILL depois do TERM ignorado ainda devolve 124 ($((SECONDS - t0)) s)" || mal "TERM ignorado: código $rc"

echo "dgclaw-pesado: NOME=valor depois do separador não vira env"
export SEGREDO_TESTE=xyz
saida="$("$PESADO" -- SEGREDO_FALSO=abc 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && [[ "$saida" != *xyz* ]]; then ok "NOME=valor não imprime o ambiente (código $rc)"; else mal "NOME=valor vazou o ambiente ou saiu 0 (código $rc)"; fi
saida="$("$PESADO" --timeout 5 -- SEGREDO_FALSO=abc 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && [[ "$saida" != *xyz* ]]; then ok "o mesmo com --timeout (código $rc)"; else mal "com --timeout vazou ou saiu 0 (código $rc)"; fi
saida="$("$PESADO" -- --help 2>&1)"; rc=$?
if [ "$rc" -eq 127 ] && [[ "$saida" != *Usage* ]] && [[ "$saida" != *Uso:* ]]; then ok "-- --help sai com 127 sem imprimir ajuda"; else mal "-- --help: código $rc"; fi
unset SEGREDO_TESTE

echo "dgclaw-pesado: TMPDIR com apóstrofo"
mkdir -p "$TMP/it's"
tmpa="$(TMPDIR="$TMP/it's" mktemp -d)"
"$PESADO" -- sh -c 'sleep 300 & echo $! > "$1"; exit 0' _ "$tmpa/neto3.pid" 2>/dev/null; rc=$?
neto3="$(cat "$tmpa/neto3.pid" 2>/dev/null)"
sleep 0.3
if [ "$rc" -eq 0 ] && [ -n "$neto3" ] && ! kill -0 "$neto3" 2>/dev/null; then ok "caminho com apóstrofo funciona e o neto morre"; else mal "apóstrofo: código $rc, neto '$neto3'"; fi

echo "dgclaw-pesado: threads limitadas pelas CPUs"
printf '100000 100000\n' > "$TMP/cpumax"
v="$(DGCLAW_PESADO_CGROUP_CPUMAX_ARQ="$TMP/cpumax" OPENBLAS_NUM_THREADS=48 OMP_NUM_THREADS=abc MKL_NUM_THREADS="" "$PESADO" -- sh -c 'echo "$OPENBLAS_NUM_THREADS $OMP_NUM_THREADS $MKL_NUM_THREADS $NUMEXPR_NUM_THREADS"' 2>/dev/null)"
[ "$v" = "1 1 1 1" ] && ok "cota de 1 CPU: 48, inválido e vazio viram 1" || mal "threads com 1 CPU: '$v'"
printf 'max 100000\n' > "$TMP/cpumax"
v="$(DGCLAW_PESADO_CGROUP_CPUMAX_ARQ="$TMP/cpumax" OMP_NUM_THREADS=1 "$PESADO" -- sh -c 'echo "$OMP_NUM_THREADS"' 2>/dev/null)"
[ "$v" = "1" ] && ok "OMP_NUM_THREADS=1 fica 1 mesmo com várias CPUs" || mal "OMP 1: '$v'"

echo "dgclaw-pesado: teto de memória padrão"
# O systemd-run falso só imprime o teto escolhido; o caminho com gerente não roda aqui.
mkdir -p "$TMP/run2/systemd" "$TMP/bin"
python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "$TMP/run2/systemd/private"
printf '#!/bin/sh\nfor a in "$@"; do case "$a" in MemoryMax=*) echo "$a";; esac; done\nexit 0\n' > "$TMP/bin/systemd-run"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/systemctl"
chmod +x "$TMP/bin/systemd-run" "$TMP/bin/systemctl"
teto() { printf '%s\n' "$1" > "$TMP/memmax"; XDG_RUNTIME_DIR="$TMP/run2" PATH="$TMP/bin:$PATH" DGCLAW_PESADO_CGROUP_MEMMAX_ARQ="$TMP/memmax" "$PESADO" -- true 2>/dev/null; }
[ "$(teto 2147483648)" = "MemoryMax=1228M" ] && ok "2 GiB de container -> teto de 1228M (60%)" || mal "2 GiB: $(teto 2147483648)"
[ "$(teto max)" = "MemoryMax=2500M" ] && ok "memory.max = max -> 2500M" || mal "max: $(teto max)"
[ "$(teto 17179869184)" = "MemoryMax=2500M" ] && ok "container grande -> limitado a 2500M" || mal "16 GiB: $(teto 17179869184)"
[ "$(XDG_RUNTIME_DIR="$TMP/run2" PATH="$TMP/bin:$PATH" "$PESADO" --mem 1G -- true 2>/dev/null)" = "MemoryMax=1G" ] && ok "--mem manda sobre o padrão" || mal "--mem 1G"
[ "$(XDG_RUNTIME_DIR="$TMP/run2" PATH="$TMP/bin:$PATH" "$PESADO" --mem 400m -- true 2>/dev/null)" = "MemoryMax=400M" ] && ok "sufixo minúsculo vira maiúsculo (o systemd só aceita 400M)" || mal "--mem 400m"

echo "dgclaw-pesado: recolhe o que sobrou"
sleep 300 & FORA=$!
"$PESADO" -- sh -c 'sleep 300 & echo $! > "$1"; exit 0' _ "$TMP/neto.pid" 2>/dev/null; rc=$?
neto="$(cat "$TMP/neto.pid" 2>/dev/null)"
[ "$rc" -eq 0 ] && ok "comando que deixa neto sai com 0" || mal "código com neto: $rc"
sleep 0.3
if [ -n "$neto" ] && ! kill -0 "$neto" 2>/dev/null; then ok "o neto em segundo plano morreu ao fim"; rm -f "$TMP/neto.pid"; else mal "o neto sobrou (pid $neto)"; fi
kill -0 "$FORA" 2>/dev/null && ok "um processo iniciado fora do invólucro continua vivo" || mal "o processo de fora morreu"

echo "dgclaw-pesado: sinal no invólucro"
"$PESADO" -- sh -c 'sleep 300 & echo $! > "$1"; wait' _ "$TMP/neto2.pid" 2>/dev/null &
inv=$!
for _ in $(seq 1 20); do [ -s "$TMP/neto2.pid" ] && break; sleep 0.2; done
kill -TERM "$inv"; wait "$inv" 2>/dev/null; rc=$?
neto2="$(cat "$TMP/neto2.pid" 2>/dev/null)"
sleep 0.3
[ "$rc" -eq 143 ] && ok "TERM no invólucro sai com 143" || mal "código após TERM: $rc"
if [ -n "$neto2" ] && ! kill -0 "$neto2" 2>/dev/null; then ok "TERM no invólucro também recolhe o comando e o neto"; rm -f "$TMP/neto2.pid"; else mal "sobrou processo após TERM (pid $neto2)"; fi

echo
if [ "$ruins" -eq 0 ]; then echo "dgclaw-pesado: tudo ok"; else echo "dgclaw-pesado: $ruins falha(s)"; exit 1; fi
