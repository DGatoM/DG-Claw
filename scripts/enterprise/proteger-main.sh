#!/usr/bin/env bash
# proteger-main.sh: liga a protecao da branch main no GitHub (PR obrigatorio, CI verde, sem force-push).
#
# PARA O DIA DO MERGE. Nao rode antes: com a protecao ligada, nem o dono empurra direto na main.
#
#   bash scripts/enterprise/proteger-main.sh                  mostra o que faria (nao muda nada)
#   bash scripts/enterprise/proteger-main.sh --aplicar        aplica
#   bash scripts/enterprise/proteger-main.sh --repo DONO/NOME --branch main --aplicar
#
# Regras aplicadas:
#   - toda mudanca entra por pull request (sem aprovacao minima: o repositorio tem um dono so;
#     suba REVISORES abaixo se um dia houver mais gente);
#   - os checks do CI precisam estar verdes e a branch do PR atualizada com a main;
#   - conversa de revisao resolvida antes do merge;
#   - sem force-push e sem apagar a main;
#   - vale tambem para administradores (enforce_admins). Em emergencia, desligue por um instante em
#     Settings > Branches e religue; o motivo de ser assim e que a regra que o dono pode furar sem
#     querer nao protege de nada.
# Precisa do `gh` logado com permissao de admin no repositorio.
set -euo pipefail

REPO="DGatoM/DG-Claw"
BRANCH="main"
APLICAR=0
REVISORES=0
# Os nomes dos jobs em .github/workflows/ci.yml e seguranca.yml.
CHECKS=(panel web runner python shell cli enterprise gitleaks)

falha() { printf 'Nao deu certo: %s\nO que fazer: %s\n' "$1" "$2" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo) [ "$#" -ge 2 ] || falha "--repo precisa de um valor." "use --repo DONO/NOME"; REPO="$2"; shift 2 ;;
        --branch) [ "$#" -ge 2 ] || falha "--branch precisa de um valor." "use --branch main"; BRANCH="$2"; shift 2 ;;
        --revisores) [ "$#" -ge 2 ] || falha "--revisores precisa de um numero." "use --revisores 1"; REVISORES="$2"; shift 2 ;;
        --aplicar) APLICAR=1; shift ;;
        *) falha "opcao desconhecida: $1" "veja o cabecalho deste arquivo." ;;
    esac
done
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || falha "o repositorio '$REPO' nao tem o formato DONO/NOME." "use --repo DGatoM/DG-Claw"
[[ "$REVISORES" =~ ^[0-9]+$ ]] || falha "--revisores '$REVISORES' nao e um numero." "use --revisores 0 ou mais."
command -v gh >/dev/null || falha "o gh (GitHub CLI) nao esta instalado." "instale em https://cli.github.com e rode: gh auth login"
command -v jq >/dev/null || falha "o jq nao esta instalado." "instale com: sudo apt-get install jq"

corpo="$(jq -n --argjson revisores "$REVISORES" --args '
    {
      required_status_checks: {strict: true, contexts: $ARGS.positional},
      enforce_admins: true,
      required_pull_request_reviews: {required_approving_review_count: $revisores, dismiss_stale_reviews: true},
      restrictions: null,
      required_conversation_resolution: true,
      allow_force_pushes: false,
      allow_deletions: false
    }' "${CHECKS[@]}")"

if [ "$APLICAR" != 1 ]; then
    printf 'Nada foi mudado. Isto seria enviado para PUT repos/%s/branches/%s/protection:\n%s\n' "$REPO" "$BRANCH" "$corpo"
    printf '\nPara aplicar de verdade: bash %s --aplicar\n' "$0"
    exit 0
fi

printf '%s' "$corpo" | gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --input - >/dev/null \
    || falha "o GitHub recusou a protecao de $REPO@$BRANCH." "confira se voce e admin do repositorio (gh auth status), se a branch existe e se os nomes dos checks conferem com os jobs do CI."
printf 'Protecao ligada em %s@%s: PR obrigatorio, checks (%s) verdes, sem force-push.\n' "$REPO" "$BRANCH" "${CHECKS[*]}"
