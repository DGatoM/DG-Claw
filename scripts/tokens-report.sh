#!/bin/bash
# tokens-report.sh (DG Claw) — resumo de tokens/custo da persona ao longo de N dias.
# Agrega TODOS os *-tokens.jsonl do logDir (schema unificado) via jq.
#
# Tudo parametrizado por env do contrato DG Claw. ZERO hardcode de persona/paths.
#
# Env:
#   DGCLAW_WORKSPACE   (obrigatorio na pratica) — raiz do workspace da persona.
#   DGCLAW_LOGS_DIR    (opcional)               — onde estao os *-tokens.jsonl.
#                          Default: <ws>/.dgclaw/logs
#
# Uso:  tokens-report.sh [dias]          (default: 7)
#       tokens-report.sh [dias] --json   (saida so JSON, pro painel/automacao)

set -uo pipefail

DIAS="${1:-7}"
JSON_ONLY=0
[ "${2:-}" = "--json" ] && JSON_ONLY=1
[ "${1:-}" = "--json" ] && { JSON_ONLY=1; DIAS=7; }

WS="${DGCLAW_WORKSPACE:?tokens-report: DGCLAW_WORKSPACE nao setado}"
LOG_DIR="${DGCLAW_LOGS_DIR:-$WS/.dgclaw/logs}"

# Junta todas as linhas dos *-tokens.jsonl. Se nao houver nenhum, sai gracioso.
shopt -s nullglob
FILES=("$LOG_DIR"/*-tokens.jsonl)
if [ "${#FILES[@]}" -eq 0 ]; then
    if [ "$JSON_ONLY" = "1" ]; then
        echo '{"dias":'"$DIAS"',"execucoes":0,"custo_total_usd":0,"por_cron":[],"por_dia":[]}'
    else
        echo "Sem dados de tokens em $LOG_DIR ainda."
    fi
    exit 0
fi

DESDE=$(date -d "-${DIAS} days" -Iseconds)

# Stream de todas as linhas validas no periodo -> array unico no jq.
REPORT=$(cat "${FILES[@]}" 2>/dev/null \
    | jq -c --arg desde "$DESDE" 'select(type=="object" and (.timestamp // "") >= $desde)' \
    | jq -s --argjson dias "$DIAS" '
    {
        dias: $dias,
        execucoes: length,
        erros: (map(select(.is_error == true)) | length),
        custo_total_usd: (map(.total_cost_usd // 0) | add // 0 | . * 10000 | round / 10000),
        custo_medio_usd: (if length > 0 then (map(.total_cost_usd // 0) | add / length | . * 10000 | round / 10000) else 0 end),
        input_tokens_total:  (map(.usage.input_tokens // 0) | add // 0),
        output_tokens_total: (map(.usage.output_tokens // 0) | add // 0),
        cache_read_total:     (map(.usage.cache_read_input_tokens // 0) | add // 0),
        cache_creation_total: (map(.usage.cache_creation_input_tokens // 0) | add // 0),
        tokens_totais_efetivos: (map((.usage.input_tokens // 0) + (.usage.output_tokens // 0) + (.usage.cache_creation_input_tokens // 0) + (.usage.cache_read_input_tokens // 0)) | add // 0),
        por_cron: (group_by(.cron) | map({
            cron: (.[0].cron // "?"),
            n: length,
            custo_usd: (map(.total_cost_usd // 0) | add // 0 | . * 10000 | round / 10000)
        }) | sort_by(-.custo_usd)),
        por_dia: (group_by((.timestamp // "")[0:10]) | map({
            dia: ((.[0].timestamp // "")[0:10]),
            n: length,
            custo_usd: (map(.total_cost_usd // 0) | add // 0 | . * 10000 | round / 10000)
        }) | sort_by(.dia))
    }
')

if [ "$JSON_ONLY" = "1" ]; then
    echo "$REPORT"
    exit 0
fi

echo "=== Tokens/custo da persona — ultimos $DIAS dias (desde $DESDE) ==="
echo "$REPORT" | jq -r '
    "Execucoes: \(.execucoes)  (erros: \(.erros))",
    "Custo total: $\(.custo_total_usd)   |   medio/execucao: $\(.custo_medio_usd)",
    "Tokens: in=\(.input_tokens_total) out=\(.output_tokens_total) cacheR=\(.cache_read_total) cacheW=\(.cache_creation_total)  (efetivo: \(.tokens_totais_efetivos))"
'
echo
echo "--- Por cron (ultimos $DIAS dias) ---"
echo "$REPORT" | jq -r '.por_cron[] | "  \(.cron): \(.n)x  $\(.custo_usd)"'
echo
echo "--- Por dia (ultimos $DIAS dias) ---"
echo "$REPORT" | jq -r '.por_dia[] | "  \(.dia): \(.n)x  $\(.custo_usd)"'
