#!/usr/bin/env bash
# Testa o motor da ronda de seguranca (seguranca/ronda/ronda.py) contra fontes falsas (OSV, KEV, USN, Hacker News, NVD,
# GitHub e Admin num servidor local) e comandos de mentira no PATH (dpkg-query, ss, sysctl, nft, needrestart...).
# Sem rede e sem root: tudo numa raiz falsa (DGCLAW_RAIZ).
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null || { echo "falta o python3 no PATH" >&2; exit 1; }
exec python3 -I "$AQUI/test_ronda.py" "$@"
