#!/usr/bin/env bash
# Ajudantes dos testes da CLI: uma raiz falsa por teste, o PATH com os programas de
# mentira (tests/cli/stubs) e as comparacoes. Carregado com `source`.
#
# Nada aqui encosta no sistema de verdade: DGCLAW_RAIZ faz todo caminho viver na
# pasta temporaria, e podman, systemctl, ss, curl e iptables sao os de mentira.

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
CLI="$REPO/bin/dgclaw"
FALHAS=0
TESTES=0

preparar() {
    TMP="$(mktemp -d)"
    export DGCLAW_RAIZ="$TMP/raiz"
    export STUB_ESTADO="$TMP/estado"
    export STUB_LOG="$TMP/podman.log"
    export DGCLAW_TEMPO_ESPERA=2
    export DGCLAW_TEMPO_PARTIDA=1
    export NO_COLOR=1
    mkdir -p "$DGCLAW_RAIZ/etc/dgclaw" "$STUB_ESTADO"
    : >"$STUB_LOG"
    PATH="$AQUI/stubs:$PATH"
    export PATH
    printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$DGCLAW_RAIZ/etc/dgclaw/dgclaw.env"
    # O gravador da senha da Tela de verdade (panel/bin/tela-senha.js) e de outro codigo;
    # aqui entra o de mentira, que recebe o caminho em $1 e a senha pelo STDIN.
    export DGCLAW_TELA_SENHA_CMD="\"$AQUI/stubs/tela-senha-falso\" \"\$1\""
    # shellcheck disable=SC2034 # usadas pelos testes que carregam este arquivo
    ETC="$DGCLAW_RAIZ/etc/dgclaw"
    # shellcheck disable=SC2034
    LIB="$DGCLAW_RAIZ/var/lib/dgclaw"
    trap 'rm -rf "$TMP"' EXIT
}

dgclaw() { "$CLI" "$@"; }

# criar_agente <args>: roda `agente criar` guardando a saida em $TMP/saida.txt.
criar_agente() { dgclaw agente criar "$@" >"$TMP/saida.txt" 2>&1; }

ok() { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }

# afirma "<descricao>" <comando...>: passa se o comando sai com 0.
afirma() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then ok "$desc"; else mal "$desc"; fi
}
# nega "<descricao>" <comando...>: passa se o comando sai com codigo diferente de 0.
nega() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then mal "$desc"; else ok "$desc"; fi
}
igual() {
    local desc="$1" esperado="$2" obtido="$3"
    if [ "$esperado" = "$obtido" ]; then ok "$desc"
    else mal "$desc (esperado '$esperado', veio '$obtido')"; fi
}

# marcar_settings_alheio <slug>: poe no settings.json do agente uma linha que o DG Claw nao controla
# (outra chave de hooks e uma chave solta). Depois de qualquer comando, ela tem de continuar la.
marcar_settings_alheio() {
    local st="$LIB/agentes/$1/home/.claude/settings.json"
    jq '.hooks.PostToolUse = [{matcher: "Read", hooks: [{type: "command", command: "echo alheio"}]}] | .minhaLinha = "do-aluno"' "$st" >"$st.novo" \
        && mv -f "$st.novo" "$st" && chmod 444 "$st"
}

# confere_travas <slug> <quando>: as tres travas (sem Bash, sem enviar arquivo, escrita so em
# relatorios) estao no runner.json e no settings.json, o gancho esta uma vez so, a linha alheia
# sobreviveu e o restricoes.json e o mesmo de antes ($RESTR_HASH_<slug> guardado por guardar_restricoes).
confere_travas() {
    local s="$1" q="$2" rj="$LIB/agentes/$1/runner/runner.json" st="$LIB/agentes/$1/home/.claude/settings.json"
    afirma "$q: runner.json trava Bash, BashOutput e KillShell" jq -e '(.config.denyTools | index("Bash")) != null and (.config.denyTools | index("BashOutput")) != null and (.config.denyTools | index("KillShell")) != null' "$rj"
    afirma "$q: runner.json trava os dois envios de arquivo" jq -e '(.config.denyTools | index("mcp__dgchat__send_file")) != null and (.config.denyTools | index("mcp__dgchat__whatsapp_send_file")) != null' "$rj"
    afirma "$q: send_file saiu dos allowTools e as respostas de texto ficaram" jq -e '(.config.allowTools | index("mcp__dgchat__send_file")) == null and (.config.allowTools | index("mcp__dgchat__whatsapp_send_file")) == null and (.config.allowTools | index("mcp__dgchat__reply")) != null and (.config.allowTools | index("mcp__dgchat__whatsapp_reply")) != null' "$rj"
    afirma "$q: runner.json continua com os ganchos e o resto" jq -e '.config.promptHooks | length == 2' "$rj"
    afirma "$q: o gancho de escrita esta no settings.json, uma vez so" jq -e '[.hooks.PreToolUse[]?.hooks[]? | select(.command | test("escrita-restrita-hook"))] | length == 1' "$st"
    afirma "$q: a linha alheia do settings.json sobreviveu" jq -e '.minhaLinha == "do-aluno" and .hooks.PostToolUse[0].hooks[0].command == "echo alheio" and .skipDangerousModePermissionPrompt == true' "$st"
    afirma "$q: restricoes.json intacto" bash -c "[ \"\$(sha256sum <'$LIB/agentes/$s/runner/restricoes.json')\" = \"$(cat "$TMP/restr-hash-$s" 2>/dev/null)\" ]"
    igual "$q: restricoes.json continua 444 de root" "444" "$(stat -c %a "$LIB/agentes/$s/runner/restricoes.json")"
}
guardar_restricoes() { sha256sum <"$LIB/agentes/$1/runner/restricoes.json" >"$TMP/restr-hash-$1"; }

fim() {
    printf '%s: %s verificacoes, %s falharam\n' "$(basename "$0")" "$TESTES" "$FALHAS"
    [ "$FALHAS" -eq 0 ]
}
