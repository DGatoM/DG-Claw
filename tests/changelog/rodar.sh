#!/usr/bin/env bash
# O CHANGELOG fala com a pessoa dona do DG Claw, nunca com o modelo. O Admin lê as subseções
# "Como atualizar" antes de aplicar uma versão (docs/ATUALIZAR.md), e o aviso de novidades mostra o
# CHANGELOG aos agentes: frase que dá ordem a um assistente ali tem cara de injeção de prompt.
# Regra em CLAUDE.md ("Passo manual de atualização vai no CHANGELOG").
# Uso: bash tests/changelog/rodar.sh [arquivo]   (padrão: o CHANGELOG.md do repositório)
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALVO="${1:-$AQUI/../../CHANGELOG.md}"

# Frases dirigidas ao modelo. Comparação sem diferenciar maiúsculas.
PROIBIDAS=(
    'você é um agente'
    'voce e um agente'
    'você é uma ia'
    'você é o admin'
    'o assistente deve'
    'o agente deve'
    'o modelo deve'
    'a ia deve'
    'ia, faça'
    'agente, faça'
    'assistente, faça'
    'ignore as instruções'
    'ignore instruções anteriores'
)

principal() {
    local falhas=0 frase achados
    if [ ! -f "$ALVO" ]; then
        printf 'changelog: não achei %s. Rode a partir do repositório ou passe o caminho do CHANGELOG.\n' "$ALVO" >&2
        return 1
    fi
    echo "changelog: o texto fala com a pessoa, não com o modelo ($ALVO)"
    for frase in "${PROIBIDAS[@]}"; do
        if achados="$(grep -niF -- "$frase" "$ALVO")"; then
            falhas=$((falhas + 1))
            printf '  FALHOU "%s" aparece no CHANGELOG:\n%s\n' "$frase" "$achados"
        else
            printf '  ok     sem "%s"\n' "$frase"
        fi
    done
    if [ "$falhas" -gt 0 ]; then
        printf '\n%d frase(s) dirigida(s) ao modelo. Reescreva falando com a pessoa dona do DG Claw, com o porquê em uma frase (ver a regra no CLAUDE.md).\n' "$falhas"
        return 1
    fi
    echo "changelog: tudo certo"
}

principal "$@"
