#!/usr/bin/env bash
# As rotinas que rodam sozinhas dentro da caixa (reflexao, batimento, cron) nao executam o que o agente grava.
# O agente grava a working-memory e a propria casa (cwd das rotinas): um """ dentro do texto, ou um
# datetime.py / json.py plantado na casa, nao pode virar codigo. Python sempre com -I (nao poe o cwd nem
# PYTHONPATH no caminho) e conteudo de arquivo entra como dado, nunca dentro do texto do programa.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
REFL="$REPO/scripts/reflection.sh"

echo "varredura: nenhum python3 - / -c / -m sem -I nos scripts"
ruins="$(grep -rnE '\bpython3?( +-c\b| +-m\b| +-([ \t]|$)| +<<| +2>|$)' "$REPO/scripts" --include='*.sh' | grep -vE 'python3? +-I' | grep -vE '^[^:]+:[0-9]+:\s*#' || true)"
igual "todo python3 de linha de comando/stdin usa -I" "" "$ruins"

echo "working-memory com aspas triplas nao executa codigo"
CASA="$TMP/casa"; mkdir -p "$CASA"
cat >"$TMP/busca.py" <<'PY'
import sys; sys.stdin.read(); print('{"recall": "ok"}')
PY
# o bloco real do reflection.sh: de `RECALL=$(` ate o `)` que fecha
bloco="$(awk '/^    RECALL=\$\(/ && !f {f=1} f {print} f && /^\)$/ {exit}' "$REFL")"
afirma "achei o bloco do eco do passado no reflection.sh" test -n "$bloco"
printf '%s\n' "$bloco" >"$TMP/bloco.sh"
ataque=$'normal """ + __import__("os").system("touch '"$TMP"'/MARCA-ASPAS") + """ fim'
( cd "$CASA" && WM_INPUT="$ataque" ECHO_SEARCH="$TMP/busca.py" LOG="$TMP/log" bash -c 'WM_INPUT=$WM_INPUT; . "$1"; printf "%s" "$RECALL" >"$2"' _ "$TMP/bloco.sh" "$TMP/recall.txt" ) >/dev/null 2>&1
nega "o codigo dentro da working-memory nao rodou (sem marcador)" test -e "$TMP/MARCA-ASPAS"
igual "e o eco do passado segue funcionando" "ok" "$(cat "$TMP/recall.txt" 2>/dev/null)"

echo "modulo plantado na casa (datetime.py, json.py) nao executa"
for m in datetime json os; do printf 'import os\nopen("%s/MARCA-%s","w").close()\n' "$TMP" "$m" >"$CASA/$m.py"; done
( cd "$CASA" && WM_INPUT="oi" ECHO_SEARCH="$TMP/busca.py" LOG="$TMP/log" bash -c '. "$1"' _ "$TMP/bloco.sh" ) >/dev/null 2>&1
nega "json.py plantado na casa nao rodou (eco do passado)" test -e "$TMP/MARCA-json"
# o bloco da conversa: do CONVERSA=$( ate o import do thread_log (logo depois do sys.path.insert)
awk '/^CONVERSA=\$\(/ && !f {f=1} f {print} f && /^import thread_log/ {print "PYCONV"; print ")"; exit}' "$REFL" >"$TMP/conv.sh"
afirma "achei o bloco da conversa no reflection.sh" test -s "$TMP/conv.sh"
( cd "$CASA" && PLUGIN="$REPO" TODAY=2026-01-01 LOG="$TMP/log" bash -c '. "$1"' _ "$TMP/conv.sh" ) >/dev/null 2>&1
nega "datetime.py plantado na casa nao rodou (conversa do dia)" test -e "$TMP/MARCA-datetime"
nega "os.py plantado na casa nao rodou" test -e "$TMP/MARCA-os"

fim
