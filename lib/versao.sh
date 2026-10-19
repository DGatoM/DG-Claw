#!/usr/bin/env bash
# lib/versao.sh: a versao e o commit que estao INSTALADOS, lidos do dgclaw.env (o install.sh
# grava DGCLAW_VERSAO a partir do arquivo VERSION e DGCLAW_COMMIT do clone).
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Quem chama ja rodou carregar_env_dgclaw.

# versao_texto: "1.0.0 (commit abc123def456)"; sai com 1 e nao imprime nada se a versao nao foi registrada.
versao_texto() {
    local v="${DGCLAW_VERSAO:-}" c="${DGCLAW_COMMIT:-}"
    [ -n "$v" ] || return 1
    if [ -n "$c" ]; then printf '%s (commit %s)' "$v" "${c:0:12}"; else printf '%s' "$v"; fi
}

# versao_linha: a primeira linha do `dgclaw status`.
versao_linha() {
    local t
    if t="$(versao_texto)"; then printf 'DG Claw %s\n' "$t"
    else printf 'DG Claw: versao nao registrada: rode sudo dgclaw atualizar ou ./install.sh de novo\n'; fi
}

# versao_main: `dgclaw versao`, so a versao e o commit.
versao_main() {
    [ $# -eq 0 ] || falha "'versao' nao tem opcoes (recebi: $*)." "use: dgclaw versao"
    carregar_env_dgclaw
    local t
    t="$(versao_texto)" || falha "o DG Claw nao registrou a versao instalada (falta DGCLAW_VERSAO em $DG_ETC/dgclaw.env)." \
        "rode sudo dgclaw atualizar ou ./install.sh de novo dentro do clone; o instalador anota a versao."
    printf '%s\n' "$t"
}
