#!/bin/bash
# materialize-identity.sh — Gera o AGENT.md (system prompt) a partir da identidade rica.
#
# O DG Claw monta o system prompt fazendo `cat AGENT.md` (bootstrap-identity.sh). Como a
# identidade mora repartida em varios arquivos editaveis, este script MATERIALIZA todos eles
# num AGENT.md gerado, com um marcador no topo. Um AGENT.md escrito a mao (instalacao antiga)
# vai pra AGENT.md.bak antes, e so na primeira vez.
#
# Anexa, quando existirem no workspace, nesta ordem:
#   LAWS.md         leis duras/inviolaveis (acima de tudo)
#   PERSONALITY.md  tom, jeito, como trata o dono
#   IDENTITY.md     quem ele e, o que faz, contexto de trabalho
#   ETHICS.md       limites eticos do papel
#   CREATOR.md      quem e o dono e como e a relacao de trabalho
# Com a flag --include-ops, anexa tambem o AGENTS.md (manual operacional do workspace).
#
# Extensoes instaladas em .dgclaw/ext/<nome>/ podem acrescentar as proprias secoes pelo
# gancho hooks/identity.sh (e assim que o DG Alive encaixa o SOUL.md, sem que o nucleo
# precise saber que existe alma).
#
# Uso:  bash materialize-identity.sh <workspace> [--include-ops]
# Idempotente: pode rodar quantas vezes quiser (a reflexao noturna chama isto quando a
# personalidade muda). So cria o .bak uma vez (nao sobrescreve o backup original).

set -uo pipefail

WS="${1:?Uso: materialize-identity.sh <workspace> [--include-ops]}"
[ -d "$WS" ] || { echo "workspace inexistente: $WS" >&2; exit 1; }

# Flags (qualquer posicao depois do workspace).
INCLUDE_OPS=0
shift 2>/dev/null || true
for a in "$@"; do
    case "$a" in
        --include-ops) INCLUDE_OPS=1 ;;
    esac
done

MARKER="<!-- GERADO PELO DG CLAW a partir de LAWS/PERSONALITY/IDENTITY/ETHICS/CREATOR. Nao edite a mao: edite os arquivos-fonte e rode /dgclaw:doctor. -->"
AGENT="$WS/AGENT.md"
BAK="$WS/AGENT.md.bak"

# 1. Backup do AGENT.md que veio antes (so se ainda nao for um AGENT gerado e nao houver bak).
if [ -f "$AGENT" ] && ! head -1 "$AGENT" | grep -q "GERADO PELO DG CLAW"; then
    [ -f "$BAK" ] || cp "$AGENT" "$BAK"
fi

# Helper: anexa um arquivo de identidade (sem os comentarios HTML de cabecalho do template),
# seguido de um separador, mas SO se o arquivo existir e tiver conteudo util.
append_section() {
    local f="$1"
    [ -f "$f" ] || return 0
    grep -v '^<!--' "$f" | grep -v '^     ' | grep -v -- '-->$'
    echo; echo "---"; echo
}

# Helper: roda o gancho identity.sh de cada extensao instalada. O que ela imprimir entra no
# AGENT.md. Extensao que falha nao impede a identidade de ser montada: o erro sai no stderr
# dizendo qual extensao e o que aconteceu, e o AGENT.md e gerado sem aquela parte.
append_extensions() {
    local extdir="$WS/.dgclaw/ext" hook out ext
    [ -d "$extdir" ] || return 0
    while IFS= read -r ext; do
        hook="$ext/hooks/identity.sh"
        [ -f "$hook" ] || continue
        if out=$(DGCLAW_WORKSPACE="$WS" timeout 10 bash "$hook" 2>/dev/null); then
            [ -n "$out" ] || continue
            printf '%s\n' "$out"
            echo; echo "---"; echo
        else
            echo "materialize-identity: a extensao '$(basename "$ext")' falhou no gancho identity.sh e ficou de fora deste AGENT.md. Rode 'bash $hook' pra ver o erro dela." >&2
        fi
    done < <(find "$extdir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
}

# 2. Monta o novo AGENT.md.
# Ordem: LAWS (leis duras, acima de tudo) -> extensoes -> PERSONALITY -> IDENTITY -> ETHICS
#        -> CREATOR -> [AGENTS.md se --include-ops].
TMP=$(mktemp /tmp/dgclaw-agent-XXXXXX.md)
{
    echo "$MARKER"
    echo
    append_section "$WS/LAWS.md"
    append_extensions
    append_section "$WS/PERSONALITY.md"
    append_section "$WS/IDENTITY.md"
    append_section "$WS/ETHICS.md"
    append_section "$WS/CREATOR.md"
    if [ "$INCLUDE_OPS" = "1" ]; then
        append_section "$WS/AGENTS.md"
    fi
    cat <<'EOF'
# Como eu chego em cada conversa

No inicio de cada sessao eu recebo a memoria viva (a working-memory), com a data, o que
aconteceu ontem, o que esta em aberto e os recados do meu dono. E de la que eu sei em que
pe estao as coisas. Detalhes de memoria e de operacao estao no CLAUDE.md do workspace.
EOF
} > "$TMP"

mv "$TMP" "$AGENT"

# 3. Ajuste de dono: se o workspace pertence a um usuario dedicado, alinha o AGENT.md a ele.
WS_OWNER=$(stat -c '%U' "$WS" 2>/dev/null || echo root)
if [ "$WS_OWNER" != "root" ]; then
    chown "$WS_OWNER":"$(stat -c '%G' "$WS")" "$AGENT" "$BAK" 2>/dev/null || true
fi

echo "AGENT.md materializado a partir de LAWS/PERSONALITY/IDENTITY/ETHICS/CREATOR."
[ -f "$BAK" ] && echo "  (AGENT.md anterior preservado em AGENT.md.bak)"
# Sem este exit, o teste do backup acima virava o codigo de saida: quando nao havia backup,
# o script terminava com "erro" mesmo tendo funcionado, e quem chamava (instalador da
# extensao, doctor) avisava de uma falha que nao existiu.
exit 0
