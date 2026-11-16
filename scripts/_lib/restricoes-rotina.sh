#!/bin/bash
# restricoes-rotina.sh: conferência única das rotinas autônomas que rodam o Claude fora do runner
# (reflexão headless, crons de publicação e de comentários, consolidação). Faz "source" deste arquivo e chama:
#
#     restricoes_conferir_rotina <rotulo> <arquivo-de-log> || exit 1
#     "$CLAUDE_BIN" --print ... "${RESTRICAO_DENY_ARGS[@]}" -p "$PROMPT"
#
# Falha fechada: se o restricoes.json do agente existe (mesmo caminho do runner: RUNNER_RESTRICOES_FILE ou
# /etc/dgclaw-runner/restricoes.json) a rotina só roda se o runner compilado (runner/dist/conferir-conta-cli.js)
# aprovar a conta, com a MESMA regra de conferirContaComRestricoes. Sem o node, sem o runner compilado ou com
# qualquer dúvida, recusa. A conta é conferida a cada execução, então trocar de conta depois do login (que o
# runner só consegue recusar na sessão de conversa) também barra as rotinas. Sem restrição, nada muda e
# RESTRICAO_DENY_ARGS fica vazio. Quando aprovada com restrição, RESTRICAO_DENY_ARGS traz um
# --disallowedTools por ferramenta negada (o denyTools do runner.json).
# Regra de manutenção: mexeu na conferência do runner, mexa aqui junto.

restricoes_conferir_rotina() {
    local rotulo="${1:-rotina}" log="${2:-/dev/stderr}"
    RESTRICAO_DENY_ARGS=()
    local arq="${RUNNER_RESTRICOES_FILE:-/etc/dgclaw-runner/restricoes.json}"
    # -e e -L: link quebrado ou arquivo ilegível também contam como "existe" (falha fechada).
    if [ ! -e "$arq" ] && [ ! -L "$arq" ]; then
        return 0
    fi
    local aqui dist cli saida rc err
    aqui="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    dist="${DGCLAW_RUNNER_DIST:-$aqui/../../runner/dist}"
    cli="$dist/conferir-conta-cli.js"
    # O plugin pode ser uma copia sem o runner: cai no caminho da imagem do agente.
    [ -f "$cli" ] || cli="/opt/dgclaw/app/runner/dist/conferir-conta-cli.js"
    _restricoes_rotina_recusa() {
        echo "[$(date '+%F %T')] $rotulo: RECUSADA, o motor NAO foi chamado. $1" >> "$log"
        echo "$rotulo: recusada. $1" >&2
        return 1
    }
    if ! command -v node >/dev/null 2>&1; then
        _restricoes_rotina_recusa "O agente tem restricoes ($arq), mas nao achei o node para conferir a conta de IA. O que fazer: o dono do servidor confere a imagem do agente (dgclaw agente restricoes <nome-do-agente>)."
        return 1
    fi
    if [ ! -f "$cli" ]; then
        _restricoes_rotina_recusa "O agente tem restricoes ($arq), mas nao achei o conferidor da conta em $cli. O que fazer: atualizar o DG Claw e recriar o agente (dgclaw atualizar)."
        return 1
    fi
    err="$(mktemp)" || { _restricoes_rotina_recusa "Nao consegui criar um arquivo temporario para a conferencia da conta. O que fazer: conferir o espaco em disco e a permissao de /tmp."; return 1; }
    saida="$(node "$cli" "$rotulo" 2>"$err")"
    rc=$?
    if [ "$rc" -ne 0 ]; then
        _restricoes_rotina_recusa "$(tr '\n' ' ' <"$err")${saida:+ }"
        rm -f "$err"
        return 1
    fi
    rm -f "$err"
    local f
    while IFS= read -r f; do
        [ -n "$f" ] && RESTRICAO_DENY_ARGS+=(--disallowedTools "$f")
    done <<<"$saida"
    return 0
}
