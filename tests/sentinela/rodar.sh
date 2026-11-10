#!/usr/bin/env bash
# Testa a sentinela do servidor (seguranca/sentinela/sentinela.py) numa raiz falsa, sem root e sem rede: medicoes falsas,
# Telegram, pulso, Admin e SMTP em servidores locais. Nenhum comando de sistema roda de verdade.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null || { echo "falta o python3 no PATH" >&2; exit 1; }
exec python3 -I "$AQUI/test_sentinela.py" "$@"
