#!/bin/bash
# test-canal-dgchat.sh — Prova a FIACAO do canal do painel, do lado do launch.
#
# A bancada do servidor MCP (scripts/dgchat-mcp/test-server.mjs) prova que as
# tools funcionam. Esta aqui prova a outra metade, que e onde o canal costuma
# quebrar de verdade: o `claude` sobe com o `--mcp-config` certo, o Telegram e
# mesmo opcional, e a identidade que o agente le fala das tools que ele TEM.
#
# O truque: CLAUDE_BIN aponta para um `claude` de mentira, que so despeja os
# proprios argumentos e uma copia do system prompt num diretorio. Nada real sobe.
#
# Uso: bash scripts/test-canal-dgchat.sh

set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FALHAS=0
ok()     { echo "✅ $1"; }
falhou() { echo "❌ $1" >&2; FALHAS=$((FALHAS + 1)); }

RAIZ="$(mktemp -d /tmp/dgclaw-canal-XXXXXX)"
trap 'rm -rf "$RAIZ"' EXIT

# ── o claude de mentira ─────────────────────────────────────────────────────
FAKE="$RAIZ/claude-de-mentira"
cat > "$FAKE" <<'EOF'
#!/bin/bash
# Despeja os argumentos (um por linha, para o grep nao se confundir com espaco)
# e uma copia do system prompt, que o launch.sh apaga no trap ao sair.
printf '%s\n' "$@" > "$DESPEJO/argv.txt"
anterior=""
for a in "$@"; do
    [ "$anterior" = "--append-system-prompt-file" ] && cp "$a" "$DESPEJO/identidade.txt"
    anterior="$a"
done
exit 0
EOF
chmod +x "$FAKE"

# ── um agente de mentira ────────────────────────────────────────────────────
# Cria <ws> com config.sh. `telegram` define se TELEGRAM_STATE_DIR entra.
montar() {
    local slug="$1" telegram="$2"
    local ws="$RAIZ/$slug"
    mkdir -p "$ws/.dgclaw"
    {
        echo "export DGCLAW_NAME=\"Agente $slug\""
        echo "export DGCLAW_SLUG=\"$slug\""
        echo "export DGCLAW_WORKSPACE=\"$ws\""
        echo "export DGCLAW_OWNER=\"Marta\""
        [ "$telegram" = "com" ] && echo "export TELEGRAM_STATE_DIR=\"$ws/.telegram\""
    } > "$ws/.dgclaw/config.sh"
    echo "# Sou o agente de teste." > "$ws/AGENT.md"
    echo "$ws"
}

# Roda o launch.sh contra esse agente e devolve o dir do despejo.
subir() {
    local ws="$1" slug="$2"
    local despejo="$RAIZ/despejo-$slug"
    mkdir -p "$despejo"
    DESPEJO="$despejo" CLAUDE_BIN="$FAKE" \
        bash "$AQUI/launch.sh" "$ws/.dgclaw/config.sh" > "$despejo/stdout.txt" 2> "$despejo/stderr.txt"
    echo "$despejo"
}

# ── 1. sintaxe ──────────────────────────────────────────────────────────────
if bash -n "$AQUI/launch.sh" && bash -n "$AQUI/bootstrap-identity.sh"; then
    ok "1. launch.sh e bootstrap-identity.sh passam no bash -n"
else
    falhou "1. erro de sintaxe no launch.sh ou no bootstrap-identity.sh"
fi

# ── 2. SEM Telegram: sobe assim mesmo ───────────────────────────────────────
# Ate 11/08/2026 isto morria em "config sem TELEGRAM_STATE_DIR", o que obrigava
# a criar bot no BotFather antes de o agente poder dizer a primeira palavra.
WS_SEM="$(montar so-painel sem)"
D_SEM="$(subir "$WS_SEM" so-painel)"
if [ -f "$D_SEM/argv.txt" ]; then
    ok "2. agente SEM Telegram sobe (o painel e o canal padrao, o bot e plugue)"
else
    falhou "2. agente sem Telegram nao subiu: $(tail -3 "$D_SEM/stderr.txt")"
fi
if ! grep -qx -- "--channels" "$D_SEM/argv.txt" 2>/dev/null; then
    ok "2b. e sobe sem --channels, em vez de apontar para um bot que nao existe"
else
    falhou "2b. passou --channels num agente sem Telegram"
fi

# ── 3. o --mcp-config ───────────────────────────────────────────────────────
MCP_JSON="$WS_SEM/.dgclaw/dgchat.mcp.json"
if grep -qx -- "--mcp-config" "$D_SEM/argv.txt" 2>/dev/null && grep -qx -- "$MCP_JSON" "$D_SEM/argv.txt"; then
    ok "3. o canal do painel entra por --mcp-config"
else
    falhou "3. nao passou --mcp-config: $(tr '\n' ' ' < "$D_SEM/argv.txt")"
fi
# --strict-mcp-config derrubaria os MCPs globais, inclusive o do Telegram.
if ! grep -qx -- "--strict-mcp-config" "$D_SEM/argv.txt" 2>/dev/null; then
    ok "3b. e NAO entra --strict-mcp-config, que derrubaria os MCPs globais"
else
    falhou "3b. passou --strict-mcp-config"
fi
SERVIDOR="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['mcpServers']['dgchat']['args'][0])" "$MCP_JSON" 2>/dev/null)"
if [ -n "$SERVIDOR" ] && [ -f "$SERVIDOR" ]; then
    ok "3c. o mcp.json aponta para um server.mjs que existe de verdade ($(basename "$(dirname "$SERVIDOR")")/$(basename "$SERVIDOR"))"
else
    falhou "3c. o mcp.json aponta para '$SERVIDOR', que nao existe"
fi

# ── 4. a identidade de quem so tem o painel ─────────────────────────────────
# A regra tem que falar da tool que ele TEM. Ensinar a de Telegram a um agente
# sem Telegram e mandar ele procurar uma ferramenta que nao esta na caixa.
ID_SEM="$D_SEM/identidade.txt"
if grep -q "mcp__dgchat__reply" "$ID_SEM" 2>/dev/null && grep -q "REGRA ZERO DO CANAL DG CHAT" "$ID_SEM"; then
    ok "4. a identidade ensina a responder pelo painel"
else
    falhou "4. a identidade nao tem a REGRA ZERO do DG Chat"
fi
if ! grep -q "REGRA ZERO DO CANAL TELEGRAM" "$ID_SEM" 2>/dev/null; then
    ok "4b. e nao ensina a do Telegram para quem nao tem Telegram"
else
    falhou "4b. ensinou a regra do Telegram a um agente sem Telegram"
fi
if grep -q 'chat="c_so-painel"' "$ID_SEM" 2>/dev/null; then
    ok "4c. o envelope de exemplo traz o chat de verdade deste agente (c_so-painel)"
else
    falhou "4c. o envelope de exemplo nao casa com o chat real: $(grep -o 'chat="[^"]*"' "$ID_SEM" | head -1)"
fi

# ── 5. COM Telegram: os dois canais ─────────────────────────────────────────
WS_COM="$(montar com-bot com)"
D_COM="$(subir "$WS_COM" com-bot)"
if grep -qx -- "--channels" "$D_COM/argv.txt" 2>/dev/null && grep -qx -- "--mcp-config" "$D_COM/argv.txt"; then
    ok "5. agente COM Telegram sobe com os dois canais"
else
    falhou "5. faltou canal: $(tr '\n' ' ' < "$D_COM/argv.txt")"
fi
ID_COM="$D_COM/identidade.txt"
if grep -q "REGRA ZERO DO CANAL DG CHAT" "$ID_COM" 2>/dev/null \
   && grep -q "REGRA ZERO DO CANAL TELEGRAM" "$ID_COM" \
   && grep -q "RESPONDA NO CANAL EM QUE ELE FALOU" "$ID_COM"; then
    ok "5b. a identidade tem as duas regras e diz como escolher entre elas"
else
    falhou "5b. a identidade de quem tem os dois canais esta incompleta"
fi

# ── 6. o modo da entrega ────────────────────────────────────────────────────
# Sem agents-server, DGCHAT_URL tem que ficar vazio: e o que faz a tool responder
# "entregue" em vez de prometer uma reconexao de janela que nao existe.
if ! grep -q "DGCHAT_URL" "$MCP_JSON" 2>/dev/null && [ -z "${DGCHAT_URL:-}" ]; then
    ok "6. DG Claw sozinho nao inventa DGCHAT_URL (modo transcript)"
else
    falhou "6. apareceu DGCHAT_URL num agente sem plataforma"
fi

# ── 7. servidor sumido: grita, mas nao derruba o agente ─────────────────────
# O caso real e a copia do plugin (.dgclaw/plugin/) mais velha que o painel.
WS_ORFAO="$(montar orfao com)"
D_ORFAO="$RAIZ/despejo-orfao"
mkdir -p "$D_ORFAO"
FALSO_PLUGIN="$RAIZ/plugin-velho"
mkdir -p "$FALSO_PLUGIN"
cp "$AQUI/launch.sh" "$AQUI/bootstrap-identity.sh" "$FALSO_PLUGIN/"
DESPEJO="$D_ORFAO" CLAUDE_BIN="$FAKE" \
    bash "$FALSO_PLUGIN/launch.sh" "$WS_ORFAO/.dgclaw/config.sh" \
    > "$D_ORFAO/stdout.txt" 2> "$D_ORFAO/stderr.txt"
if [ -f "$D_ORFAO/argv.txt" ] && ! grep -qx -- "--mcp-config" "$D_ORFAO/argv.txt"; then
    ok "7. sem o server.mjs o agente ainda sobe (o Telegram dele continua servindo)"
else
    falhou "7. o agente morreu ou fiou um --mcp-config sem servidor"
fi
if grep -q "NAO ACHEI o servidor do canal" "$D_ORFAO/stderr.txt" 2>/dev/null \
   && grep -q "mesma versao" "$D_ORFAO/stderr.txt"; then
    ok "7b. e o registro diz o que falta e qual e a causa provavel (copia desatualizada)"
else
    falhou "7b. faltou o aviso no log: $(tail -3 "$D_ORFAO/stderr.txt")"
fi

echo ""
if [ "$FALHAS" -gt 0 ]; then
    echo "$FALHAS verificacao(oes) falharam." >&2
    exit 1
fi
echo "Fiacao do canal DG Chat: tudo verde."
