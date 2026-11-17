#!/bin/bash
# confiar-pastas.sh - funcao para quem sobe o `claude` fora do runner (servico do canal, crons).
#
#   . "<scripts>/_lib/confiar-pastas.sh"
#   confiar_pastas <pasta> [<pasta> ...]
#
# Marca hasTrustDialogAccepted no .claude.json que ESTE processo vai usar (o do CLAUDE_CONFIG_DIR,
# ou $HOME/.claude.json quando nao ha), pelo helper confiar-pastas.py. Sem isto o Claude Code 2.1.326
# abre o dialogo "Is this a directory you created or one you trust?" para o cwd e para cada --add-dir,
# e uma sessao sem ninguem no teclado fica parada nele. Nunca derruba quem chamou: se nao conseguir,
# escreve o aviso (o que falhou, em que arquivo, o que fazer) em stderr e devolve 1.
_CONFIAR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

confiar_pastas() {
    local json helper="$_CONFIAR_LIB_DIR/confiar-pastas.py"
    if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
        json="$CLAUDE_CONFIG_DIR/.claude.json"
    else
        json="${HOME:-/root}/.claude.json"
    fi
    if [ ! -f "$helper" ]; then
        echo "aviso: nao achei $helper; as pastas $* nao foram marcadas como confiaveis em $json. Se o Claude abrir o dialogo de confianca, o agente fica parado nele; atualize o DG Claw." >&2
        return 1
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        echo "aviso: python3 ausente; as pastas $* nao foram marcadas como confiaveis em $json. Instale o python3 (apt install python3)." >&2
        return 1
    fi
    python3 -I "$helper" "$json" "$@" || {
        echo "aviso: nao consegui marcar $* como confiaveis em $json (motivo na linha acima). Se o Claude abrir o dialogo de confianca, o agente fica parado nele." >&2
        return 1
    }
}
