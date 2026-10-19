#!/usr/bin/env bash
# scripts/revisao-adversarial.sh <numero-do-pr> [--so-preparar]
#
# Prepara (e, sem --so-preparar, roda) a revisão adversarial de segurança do Codex num PR do DG Claw.
# Roteiro completo: docs/REVISAO-ADVERSARIAL.md.
#
# Por que este script existe em vez de um comando de uma linha:
#   - nada que vem do PR (nome de branch, texto, arquivos) entra num comando de shell ou de sed: só o
#     número do PR, validado como dígitos, e dois SHAs validados como 40 hex;
#   - o roteiro da pergunta é lido da main (base confiável), nunca da branch em revisão, para o PR não
#     conseguir reescrever as instruções do próprio revisor;
#   - o Codex roda numa cópia isolada da BASE, então o AGENTS.md que ele carrega sozinho é o da main;
#     a versão do PR ele lê com `git show <sha>:<caminho>`;
#   - base e PR ficam fixados por SHA, e o resultado diz qual commit foi revisado. Commit novo no PR
#     depois do LIMPO pede rodada nova.
#
# Variável opcional: DGCLAW_ROTEIRO_REVISAO=<arquivo> usa um roteiro de fora do repositório (útil
# enquanto a main ainda não tem docs/revisao-adversarial-prompt.txt). Nunca aponte para um arquivo
# do próprio PR.
set -euo pipefail

falha() { printf 'revisao-adversarial: %s\n' "$1" >&2; [ -n "${2:-}" ] && printf '  o que fazer: %s\n' "$2" >&2; exit 1; }

validar_sha() {
    [[ "$2" =~ ^[0-9a-f]{40}$ ]] || falha "o $1 resolvido ('$2') não é um SHA de 40 caracteres hexadecimais." "confira 'git fetch origin' e o número do PR."
}

preparar() {
    local pr="$1" repo base head dir roteiro texto
    repo="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)" \
        || falha "não achei o repositório a partir de $(dirname "${BASH_SOURCE[0]}")." "rode o script de dentro de um clone do DG Claw."

    git -C "$repo" fetch --quiet --no-tags origin \
        "+refs/heads/main:refs/dgclaw-revisao/base" \
        "+refs/pull/$pr/head:refs/dgclaw-revisao/pr-$pr" \
        || falha "o git fetch da main e do PR #$pr falhou." "confira a rede e se o PR #$pr existe no GitHub."
    base="$(git -C "$repo" rev-parse --verify --quiet "refs/dgclaw-revisao/base^{commit}")" || base=""
    head="$(git -C "$repo" rev-parse --verify --quiet "refs/dgclaw-revisao/pr-$pr^{commit}")" || head=""
    validar_sha "commit da main" "$base"
    validar_sha "commit do PR #$pr" "$head"

    dir="$(mktemp -d "${TMPDIR:-/tmp}/dgclaw-revisao-$pr.XXXXXX")"
    git -C "$repo" worktree add --quiet --detach "$dir/base" "$base" \
        || falha "não consegui criar a cópia isolada da main em $dir/base." "veja 'git worktree list' e apague cópias velhas com 'git worktree remove'."

    if [ -n "${DGCLAW_ROTEIRO_REVISAO:-}" ]; then
        [ -f "$DGCLAW_ROTEIRO_REVISAO" ] || falha "DGCLAW_ROTEIRO_REVISAO aponta para '$DGCLAW_ROTEIRO_REVISAO', que não existe." "use o caminho de uma cópia confiável do roteiro."
        roteiro="$(cat "$DGCLAW_ROTEIRO_REVISAO")"
    else
        roteiro="$(git -C "$repo" show "$base:docs/revisao-adversarial-prompt.txt" 2>/dev/null)" \
            || falha "a main ($base) ainda não tem docs/revisao-adversarial-prompt.txt." "defina DGCLAW_ROTEIRO_REVISAO com uma cópia confiável do roteiro, fora do PR."
    fi

    # Substituição por expansão do bash, sem sed nem eval: os três valores já foram validados.
    texto="${roteiro//__PR__/$pr}"
    texto="${texto//__BASE__/$base}"
    texto="${texto//__HEAD__/$head}"
    printf '%s\n' "$texto" >"$dir/pergunta.txt"
    printf 'pr=%s\nbase=%s\nrevisado=%s\nquando=%s\n' "$pr" "$base" "$head" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$dir/REVISAO.txt"

    PASTA="$dir"; COMMIT_REVISADO="$head"
}

main() {
    local pr="${1:-}" so_preparar=0
    [ "${2:-}" = "--so-preparar" ] && so_preparar=1
    [[ "$pr" =~ ^[0-9]{1,7}$ ]] || falha "uso: scripts/revisao-adversarial.sh <numero-do-pr> [--so-preparar]" "passe só o número do PR, por exemplo 42."

    PASTA=""; COMMIT_REVISADO=""
    preparar "$pr"

    if [ "$so_preparar" = 1 ]; then
        printf 'Pergunta pronta em %s/pergunta.txt\n' "$PASTA"
        printf 'Rode o revisor (só leitura) com a pasta %s/base como raiz.\n' "$PASTA"
        printf 'Commit revisado: %s\n' "$COMMIT_REVISADO"
        printf 'Depois: git worktree remove %s/base && rm -r %s\n' "$PASTA" "$PASTA"
        return 0
    fi

    command -v codex >/dev/null || falha "não achei o comando codex." "instale e faça login no Codex CLI, ou use --so-preparar e rode o revisor por outro caminho."
    trap 'git worktree remove --force "$PASTA/base" >/dev/null 2>&1 || printf "revisao-adversarial: sobrou a cópia %s/base; apague com git worktree remove\n" "$PASTA" >&2' EXIT
    codex exec --sandbox read-only -C "$PASTA/base" -o "$PASTA/resultado.md" - <"$PASTA/pergunta.txt" >/dev/null \
        || falha "o codex exec falhou." "veja se o Codex CLI está logado (codex login) e rode de novo."
    cat "$PASTA/resultado.md"
    printf '\n(resultado salvo em %s/resultado.md; commit revisado %s)\n' "$PASTA" "$COMMIT_REVISADO"
}

main "$@"
