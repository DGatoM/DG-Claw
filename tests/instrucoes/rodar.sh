#!/usr/bin/env bash
# O CLAUDE.md e o AGENTS.md dos agentes e do Admin nascem de UMA fonte cada
# (scripts/gerar-instrucoes.sh). Aqui se confere que:
#   a) os arquivos versionados batem com a fonte (ninguem editou o gerado a mao);
#   b) toda secao "##" da versao Claude existe na versao Codex, salvo as excecoes de motor abaixo;
#   c) nenhum marcador "<!-- so:" nem "{{SKILL:" sobra nos gerados;
#   d) o gerador recusa marcador mal formado.
# Uso: bash tests/instrucoes/rodar.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GERADOR="$REPO/scripts/gerar-instrucoes.sh"
ruins=0
ok()  { printf '  ok     %s\n' "$1"; }
mal() { printf '  FALHOU %s\n' "$1"; ruins=$((ruins + 1)); }

# Excecoes de motor: secoes que so existem na versao Claude e o porque. Cada linha e um titulo exato.
#  - O canal Telegram e o plugin de canais do Claude Code (ferramenta reply do Telegram); o Codex
#    responde pelo painel e pelo WhatsApp, cujas regras estao na identidade comum.
EXCECOES_AGENTE=(
    "## Canal Telegram — REGRA ZERO (a mais importante)"
)
EXCECOES_ADMIN=()

titulos() { grep '^## ' "$1" | sed 's/[[:space:]]*$//'; }

echo "instrucoes: os arquivos gerados batem com a fonte"
if saida="$(bash "$GERADOR" --conferir 2>&1)"; then
    ok "CLAUDE.md e AGENTS.md (agente e Admin) iguais ao que a fonte gera"
else
    mal "gerado desatualizado: $saida"
fi

confere_paridade() {
    local rotulo="$1" claude="$2" codex="$3"; shift 3
    local excecoes=("$@") t falta=0 e pula
    while IFS= read -r t; do
        pula=0
        for e in "${excecoes[@]+"${excecoes[@]}"}"; do [ "$t" = "$e" ] && pula=1; done
        [ "$pula" = 1 ] && continue
        if ! titulos "$codex" | grep -qxF -- "$t"; then
            mal "$rotulo: a versao Codex nao tem a secao \"$t\""; falta=1
        fi
    done < <(titulos "$claude")
    [ "$falta" = 0 ] && ok "$rotulo: toda secao da versao Claude existe na versao Codex"
}

echo "instrucoes: paridade de secoes"
confere_paridade "agente" "$REPO/templates/CLAUDE.md.tmpl" "$REPO/templates/AGENTS.md.tmpl" "${EXCECOES_AGENTE[@]}"
confere_paridade "Admin" "$REPO/templates/admin/CLAUDE.md" "$REPO/templates/admin/AGENTS.md" "${EXCECOES_ADMIN[@]+"${EXCECOES_ADMIN[@]}"}"

# As secoes que o levantamento de 06/11/2026 apontou como ausentes no Codex.
for s in "A lousa" "Texto pra copiar" "Quadro de avisos da equipe" "Logins de sistemas" "Agendar e coisa sua"; do
    if grep -q "^## $s" "$REPO/templates/AGENTS.md.tmpl"; then ok "AGENTS.md.tmpl tem \"$s\""; else mal "AGENTS.md.tmpl sem \"$s\""; fi
done

echo "instrucoes: sem marcador sobrando"
for f in templates/CLAUDE.md.tmpl templates/AGENTS.md.tmpl templates/admin/CLAUDE.md templates/admin/AGENTS.md; do
    if grep -nE '<!-- /?so|\{\{SKILL:' "$REPO/$f" >/dev/null; then mal "$f ainda tem marcador do gerador"; else ok "$f limpo"; fi
done
if grep -q '/dgclaw:' "$REPO/templates/AGENTS.md.tmpl"; then
    mal "AGENTS.md.tmpl chama skill por /dgclaw:nome (no Codex a skill e chamada pelo nome)"
else ok "AGENTS.md.tmpl nao usa /dgclaw:nome"; fi
if grep -q '/dgclaw:' "$REPO/templates/CLAUDE.md.tmpl"; then ok "CLAUDE.md.tmpl mantem /dgclaw:nome"; else mal "CLAUDE.md.tmpl perdeu o /dgclaw:nome"; fi

echo "instrucoes: o gerador recusa marcador mal formado"
tmp="$(mktemp -d)"
printf 'a\n<!-- so:claude -->\nb\n' >"$tmp/aberto.tmpl"
printf 'a\n<!-- /so -->\n' >"$tmp/solto.tmpl"
printf 'a <!-- so:codex --> b\n' >"$tmp/meio.tmpl"
printf 'a\n<!-- so:claude -->\n<!-- so:codex -->\nb\n<!-- /so -->\n<!-- /so -->\n' >"$tmp/aninhado.tmpl"
printf 'um\n<!-- so:claude -->\nsó claude {{SKILL:mesa}}\n<!-- /so -->\n<!-- so:codex -->\nsó codex {{SKILL:mesa}}\n<!-- /so -->\nfim\n' >"$tmp/bom.tmpl"
for f in aberto solto meio aninhado; do
    if bash "$GERADOR" --stdout "$tmp/$f.tmpl" claude >/dev/null 2>&1; then mal "gerador aceitou o marcador '$f'"; else ok "gerador recusou o marcador '$f'"; fi
done
esperado_claude=$'um\nsó claude /dgclaw:mesa\nfim'
esperado_codex=$'um\nsó codex mesa\nfim'
if [ "$(bash "$GERADOR" --stdout "$tmp/bom.tmpl" claude)" = "$esperado_claude" ]; then ok "bloco e skill do Claude"; else mal "saida do Claude errada"; fi
if [ "$(bash "$GERADOR" --stdout "$tmp/bom.tmpl" codex)" = "$esperado_codex" ]; then ok "bloco e skill do Codex"; else mal "saida do Codex errada"; fi
rm -rf "$tmp"

echo
if [ "$ruins" -gt 0 ]; then echo "instrucoes: $ruins falha(s)"; exit 1; fi
echo "instrucoes: tudo certo"
