#!/bin/bash
# poke-ack.sh — Recibo deterministico que a PERSONA roda no fim de um poke verificavel.
# A instrucao com a chave certa ja vem escrita no proprio poke-file; a persona so executa.
#
#   bash <plugin>/scripts/poke-ack.sh <slug> <key>
#
# Efeito: escreve o marcador de sucesso (done/<key>) que o verificador (poke-verify.py)
# procura — assim ele sabe que o poke foi REALMENTE recebido e concluido, e nao re-injeta.
# Self-localiza o workspace pelo proprio caminho (.../.dgclaw/plugin/scripts/poke-ack.sh),
# entao nao precisa de config nem env. Idempotente: rodar duas vezes nao quebra nada.

set -uo pipefail

SLUG="${1:-}"
KEY="${2:-}"
if [ -z "$SLUG" ] || [ -z "$KEY" ]; then
    echo "uso: poke-ack.sh <slug> <key>" >&2
    exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER="$SCRIPT_DIR/_lib/poke_ledger.py"

# WS = .../<ws>/.dgclaw/plugin/scripts  -> sobe 3 niveis (scripts->plugin->.dgclaw->ws)
WS="${DGCLAW_WORKSPACE:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"

python3 "$LEDGER" ack --ws "$WS" --key "$KEY"
ACK_RC=$?

# Reflexao concluida: confere se o MEMORY.md nao encolheu demais na consolidacao (e restaura
# a copia de antes se encolheu). Falha aqui nao muda o rc do recibo, mas fica no log.
case "$KEY" in
    reflection-*)
        REFLOG="$WS/.dgclaw/logs/reflection.log"
        mkdir -p "$(dirname "$REFLOG")" 2>/dev/null
        if ! python3 "$SCRIPT_DIR/_lib/memoria_guarda.py" conferir --ws "$WS" >> "$REFLOG" 2>&1; then
            echo "[$(date '+%F %T')] poke-ack ($KEY): a conferencia do MEMORY.md saiu com codigo diferente de 0 (3 = restaurou a versao anterior; outro = nao consegui conferir). Detalhes nas linhas acima." >> "$REFLOG"
        fi
        ;;
esac

exit "$ACK_RC"
