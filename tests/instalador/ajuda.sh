# shellcheck shell=bash
# Ajudantes dos testes do instalador (carregado com source por rodar.sh).
# Cada caso roda numa pasta temporaria propria, com uma RAIZ falsa (DGCLAW_RAIZ), um
# repositorio falso (so o suficiente para o instalador achar o que procura) e stubs
# no PATH que registram toda chamada.

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
# shellcheck disable=SC2034 # usada pelos casos, em casos.sh
PAINEL_PW='uma-frase-comprida-123'
FALHAS=0

afirma() { # afirma "<descricao>" <comando de teste...>
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then return 0; fi
    printf '      FALHOU: %s\n' "$desc"
    FALHAS=$((FALHAS + 1))
}
nega() { # nega "<descricao>" <comando...>: o comando precisa FALHAR
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
        printf '      FALHOU: %s\n' "$desc"
        FALHAS=$((FALHAS + 1))
    fi
}
tem() { grep -qF -- "$2" "$1"; }          # arquivo contem o texto
modo_e() { [ "$(stat -c %a "$1")" = "$2" ]; } # arquivo tem esse modo
vazio() { [ -z "$(find "$1" -mindepth 1 2>/dev/null)" ]; }
contar() { grep -cF -- "$2" "$1" || true; } # quantas linhas contem o texto (0 se nenhuma)
igual() { [ "$1" = "$2" ]; }

# novo_cenario: cria TMP, RAIZ, repositorio falso e variaveis de ambiente do teste.
novo_cenario() {
    TMP="$(mktemp -d)"
    RAIZ="$TMP/raiz"
    FALSO="$TMP/repo"
    SAIDA="$TMP/saida.txt"
    mkdir -p "$RAIZ" "$FALSO"
    cp "$REPO/install.sh" "$FALSO/install.sh"
    cp -r "$REPO/lib" "$FALSO/lib"
    mkdir -p "$FALSO/.claude-plugin" "$FALSO/bin" "$FALSO/web" "$FALSO/runner" "$FALSO/container" \
        "$FALSO/templates/admin" "$FALSO/skills/criar-agente" "$FALSO/scripts/dgchat-mcp" \
        "$FALSO/tests" "$FALSO/.git" "$FALSO/web/node_modules"
    echo '{"name":"dgclaw","version":"1.0.0-teste"}' >"$FALSO/.claude-plugin/plugin.json"
    printf '#!/bin/sh\necho dgclaw falso\n' >"$FALSO/bin/dgclaw"; chmod +x "$FALSO/bin/dgclaw"
    echo 'console.log("web")' >"$FALSO/web/server.js"
    echo '{"name":"web"}' >"$FALSO/web/package.json"
    echo '{"name":"runner"}' >"$FALSO/runner/package.json"
    echo 'FROM scratch' >"$FALSO/container/Containerfile"
    echo '# Admin (Claude)' >"$FALSO/templates/admin/CLAUDE.md"
    echo '# Admin (Codex)' >"$FALSO/templates/admin/AGENTS.md"
    echo '# criar-agente' >"$FALSO/skills/criar-agente/SKILL.md"
    echo '//' >"$FALSO/scripts/dgchat-mcp/server.mjs"
    echo x >"$FALSO/tests/nao-deve-ir.txt"
    echo x >"$FALSO/.git/nao-deve-ir"
    echo x >"$FALSO/web/node_modules/nao-deve-ir"
    STUB_LOG="$TMP/stub.log"
    : >"$STUB_LOG"
    EXTRA_ENV=()
    ENV_BASE=(
        "HOME=$TMP" "PATH=$AQUI/stubs:/usr/bin:/bin" "NO_COLOR=1"
        "DGCLAW_RAIZ=$RAIZ" "DGCLAW_PULAR_CHECAGENS=1"
        "DGCLAW_SENHA_HASH_CMD=$AQUI/senha-hash-falso.sh"
        "DGCLAW_STUB_LOG=$STUB_LOG" "DGCLAW_STUB_ESTADO=$TMP/estado"
        "DGCLAW_ESPERA_CERT=5"
    )
}

# instalar <senha ou vazio> <argumentos do install.sh...>
# A senha entra pelo STDIN, como na vida real. Variaveis extras do cenario: EXTRA_ENV=(NOME=valor ...).
instalar() {
    local entrada="$1"; shift
    local rc=0
    if [ -n "$entrada" ]; then
        printf '%s\n' "$entrada" | env -i "${ENV_BASE[@]}" "${EXTRA_ENV[@]}" bash "$FALSO/install.sh" "$@" >"$SAIDA" 2>&1 || rc=$?
    else
        env -i "${ENV_BASE[@]}" "${EXTRA_ENV[@]}" bash "$FALSO/install.sh" "$@" </dev/null >"$SAIDA" 2>&1 || rc=$?
    fi
    return "$rc"
}

limpar_cenario() { rm -rf "$TMP"; }
