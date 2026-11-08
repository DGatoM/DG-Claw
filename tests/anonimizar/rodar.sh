#!/usr/bin/env bash
# Testa o motor de anonimizacao de documentos (anonimizar/motor.py) e o instalador opcional dele
# (lib/anonimizar-instalar.sh, em modo --ensaio e com falhas simuladas). Sem rede e sem root.
# Se existir um python com pypdf, python-docx e openpyxl (DGCLAW_ANON_PYTHON), os testes de documento tambem rodam.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
PY="${DGCLAW_ANON_PYTHON:-python3}"
command -v "$PY" >/dev/null || { echo "falta o python3 no PATH" >&2; exit 1; }
rc=0

echo "--- anonimizar/test_motor.py"
"$PY" -I "$REPO/anonimizar/test_motor.py" || rc=1

echo "--- tests/anonimizar/test_instalador.sh"
bash "$AQUI/test_instalador.sh" || rc=1

exit "$rc"
