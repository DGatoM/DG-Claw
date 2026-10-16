#!/usr/bin/env bash
# Roda todos os testes do DG Claw v1 de uma vez e sai com codigo != 0 se algum falhar.
#
#   1. tests/cli        a CLI dgclaw, numa raiz falsa com stubs
#   2. tests/instalador o install.sh e o lib/firewall.sh, tambem em raiz falsa
#   3. web/test         o DG Claw Web (node --test)
#   4. painel           panel/test-*.mjs, um por um (saida 3 = parte pulada, ex.: sem chave de teste)
#   5. python           scripts/_lib/test_*.py, um por um
#   5b. bin             bin/test/*.test.sh (dgclaw-agente e dgclaw-card, com Telegram e runner falsos)
#   6. runner           compila numa pasta temporaria e roda os *.test.js do dist
#   7. cofre            scripts/test-cofre-nomes.sh e as duas linhas dele na unidade do runner
#   8. shellcheck       nos scripts do instalador, da CLI e dos testes
#   9. whatsapp         canais/whatsapp/test (node --test): a ponte do WhatsApp com Baileys e runner falsos,
#                       mais a conferencia do package-lock.json
#  10. mcp              scripts/dgchat-mcp/test-server.mjs: a bancada do servidor MCP do DG Chat
#
# Nada aqui encosta no sistema de verdade: nao cria container, rede nem unidade.
#
# Uso: bash tests/rodar.sh
# Env: SHELLCHECK=<binario>      shellcheck a usar (padrao: o do PATH)
#      DGCLAW_TESTES_PULAR=runner,shellcheck   pula partes, separadas por virgula
#      DGCLAW_TEST_NODE_PATH=<node_modules>    onde os testes do painel acham o express
#                                              (padrao: NODE_PATH, ou panel/node_modules se existir)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PULAR=",${DGCLAW_TESTES_PULAR:-},"
RUINS=()
PULADOS=()

parte() {
    local nome="$1"; shift
    if [[ "$PULAR" == *",$nome,"* ]]; then
        printf '\n=== %s: pulado (DGCLAW_TESTES_PULAR)\n' "$nome"
        PULADOS+=("$nome")
        return 0
    fi
    printf '\n=== %s\n' "$nome"
    if "$@"; then
        printf '=== %s: ok\n' "$nome"
    else
        printf '=== %s: FALHOU (codigo %s)\n' "$nome" "$?"
        RUINS+=("$nome")
    fi
}

testes_runner() {
    command -v npm >/dev/null || { echo "falta o npm no PATH; instale o Node 22 ou rode com DGCLAW_TESTES_PULAR=runner" >&2; return 1; }
    # Compila fora do repo: o runner/dist nao esta no .gitignore e nao pode sobrar no working tree.
    local tmp rc=0
    tmp="$(mktemp -d)"
    tar -C "$REPO/runner" --exclude=node_modules --exclude=dist -cf - . | tar -C "$tmp" -xf -
    (
        cd "$tmp" || exit 1
        npm ci --no-audit --no-fund >"$tmp/npm.log" 2>&1 \
            || { echo "npm ci do runner falhou; fim do log:" >&2; tail -20 "$tmp/npm.log" >&2; exit 1; }
        # O "build" do runner usa o tsconfig.build.json, que deixa os testes de fora da
        # imagem; quem compila COM os testes e roda e o "npm test" (tsc + node --test).
        # Fora do repo o caminho relativo do catalogo nao existe: aponta o do repo.
        DGCLAW_CATALOGO="$REPO/providers/catalogo.json" npm test
    ) || rc=$?
    rm -rf "$tmp"
    return "$rc"
}

testes_painel() {
    local np="${DGCLAW_TEST_NODE_PATH:-${NODE_PATH:-}}" t nome rc ruins=0
    if [ -z "$np" ] && [ -d "$REPO/panel/node_modules" ]; then np="$REPO/panel/node_modules"; fi
    [ -n "$np" ] || echo "aviso: sem DGCLAW_TEST_NODE_PATH, NODE_PATH nem panel/node_modules; os testes que sobem o painel por HTTP vao se declarar pulados" >&2
    for t in "$REPO"/panel/test-*.mjs; do
        nome="panel/$(basename "$t")"
        printf -- '--- %s\n' "$nome"
        rc=0
        (cd "$REPO/panel" && DGCLAW_TEST_NODE_PATH="$np" NODE_PATH="$np" node "$(basename "$t")") || rc=$?
        case "$rc" in
            0) ;;
            # Saida 3 e o jeito combinado de dizer "rodei, mas parte ficou pulada" (ex.: o
            # test-provedor sem as chaves de teste no ambiente). Nao e verde nem e falha.
            3) PULADOS+=("$nome (parte pulada, codigo 3)") ;;
            *) echo "FALHOU: $nome (codigo $rc)"; ruins=1 ;;
        esac
    done
    return "$ruins"
}

testes_python() {
    command -v python3 >/dev/null || { echo "falta o python3 no PATH; instale ou rode com DGCLAW_TESTES_PULAR=python" >&2; return 1; }
    local t rc ruins=0
    for t in "$REPO"/scripts/_lib/test_*.py; do
        printf -- '--- scripts/_lib/%s\n' "$(basename "$t")"
        rc=0
        python3 "$t" || rc=$?
        [ "$rc" -eq 0 ] || { echo "FALHOU: scripts/_lib/$(basename "$t") (codigo $rc)"; ruins=1; }
    done
    return "$ruins"
}

testes_cofre() {
    bash "$REPO/scripts/test-cofre-nomes.sh" || return 1
    # Sem estas duas linhas na unidade, o runner do container nao le os nomes do cofre e
    # tira do agente as chaves que vieram dele (a OPENAI_API_KEY, por exemplo).
    local u="$REPO/container/units/dgclaw-runner.service" ruins=0
    grep -q '^Environment=DGCLAW_COFRE_ARQUIVO=/run/dgclaw-cofre-nomes$' "$u" \
        || { echo "FALHOU: $u sem Environment=DGCLAW_COFRE_ARQUIVO=/run/dgclaw-cofre-nomes"; ruins=1; }
    grep -q '^ExecStartPre=+-/bin/bash /opt/dgclaw/app/scripts/cofre-nomes.sh ' "$u" \
        || { echo "FALHOU: $u sem o ExecStartPre=+- do cofre-nomes.sh (roda como root antes do runner)"; ruins=1; }
    [ "$ruins" = 0 ] && echo "  ok     a unidade do runner chama o cofre-nomes e aponta o arquivo"
    return "$ruins"
}

testes_shellcheck() {
    local sc="${SHELLCHECK:-shellcheck}"
    command -v "$sc" >/dev/null || { echo "nao achei o shellcheck ('$sc'); instale, aponte SHELLCHECK=<binario> ou rode com DGCLAW_TESTES_PULAR=shellcheck" >&2; return 1; }
    (
        cd "$REPO" || exit 1
        arquivos=(install.sh bin/dgclaw lib/*.sh tests/rodar.sh tests/cli/*.sh tests/cli/stubs/*
                  tests/instalador/*.sh scripts/cofre-nomes.sh scripts/test-cofre-nomes.sh)
        "$sc" -x "${arquivos[@]}"
    )
}

testes_bin() {
    local t ruins=0
    for t in "$REPO"/bin/test/*.test.sh; do
        printf -- '--- bin/test/%s\n' "$(basename "$t")"
        bash "$t" || { echo "FALHOU: bin/test/$(basename "$t")"; ruins=1; }
    done
    return "$ruins"
}

parte cli bash "$REPO/tests/cli/rodar.sh"
parte instalador bash "$REPO/tests/instalador/rodar.sh"
parte web node --test "$REPO/web/test/"
parte painel testes_painel
parte python testes_python
parte bin testes_bin
parte runner testes_runner
parte cofre testes_cofre
parte shellcheck testes_shellcheck
parte whatsapp node --test "$REPO/canais/whatsapp/test/"
parte mcp node "$REPO/scripts/dgchat-mcp/test-server.mjs"

printf '\n'
[ "${#PULADOS[@]}" -eq 0 ] || printf 'Pulado: %s\n' "${PULADOS[@]}"
if [ "${#RUINS[@]}" -gt 0 ]; then
    printf 'Falharam: %s. Role para cima ate o "=== <nome>" de cada um para ver o motivo.\n' "${RUINS[*]}"
    exit 1
fi
printf 'Todos os testes passaram.\n'
