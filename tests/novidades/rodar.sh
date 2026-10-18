#!/usr/bin/env bash
# Testa scripts/novidades-hook.mjs (aviso de novidades depois de atualizar) com node, num app e num
# workspace temporarios. Nao encosta no sistema.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$AQUI/../../scripts/novidades-hook.mjs"
command -v node >/dev/null || { echo "falta o node no PATH" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
APP="$TMP/app"; WS="$TMP/ws"
mkdir -p "$APP" "$WS/.dgclaw"
FALHAS=0; TESTES=0
ok() { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }
igual() { if [ "$2" = "$3" ]; then ok "$1"; else mal "$1 (esperado '$2', veio '$3')"; fi; }
tem() { if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else mal "$1 (nao achei '$2' em: $3)"; fi; }
nao_tem() { if printf '%s' "$3" | grep -qF -- "$2"; then mal "$1 (achei '$2')"; else ok "$1"; fi; }

# roda <stdin>: o gancho com o prompt dado no stdin; imprime o stdout.
roda() { printf '%s' "$1" | DGCLAW_APP="$APP" DGCLAW_WORKSPACE="$WS" node "$HOOK"; }
CONVERSA='{"prompt":"<dgchat from=\"Ana\" chat=\"c_x\" msg=\"p1\" ts=\"1\">oi</dgchat>"}'
ROTINA='{"prompt":"[batimento] hora de rodar a rotina"}'
contexto() { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null; }

cat >"$APP/CHANGELOG.md" <<'MD'
# Changelog

## [Não lançado]

### Adicionado

- Lousa para o agente desenhar no chat.
- Quadro de avisos com lembretes que insistem
  até o dono confirmar.

## [1.0.0] - 2026-10-17

### Adicionado

- Primeiro acesso por link.
MD
printf 'config\nexport DGCLAW_OWNER='"'"'Ana'"'"'\n' >"$WS/.dgclaw/config.sh"

echo "agente antigo (sem arquivo de visto)"
printf 'v1-aaaaaaaaaaaa\n' >"$APP/VERSAO"
saida="$(roda "$ROTINA")"
igual "turno de rotina nao gasta o aviso" "" "$saida"
if [ ! -e "$WS/.dgclaw/novidades-visto.json" ]; then ok "rotina nao gravou o visto"; else mal "rotina gravou o visto"; fi
saida="$(roda "$CONVERSA")"; ctx="$(contexto "$saida")"
tem "avisa na conversa" "O DG Claw foi atualizado" "$ctx"
tem "diz de onde veio" "de uma versão anterior para v1-aaaaaaaaaaaa" "$ctx"
tem "traz item da secao nova" "Lousa para o agente desenhar no chat." "$ctx"
tem "junta a continuacao do item" "lembretes que insistem até o dono confirmar" "$ctx"
nao_tem "nao traz a versao antiga" "Primeiro acesso por link" "$ctx"
tem "usa o nome do dono" "avise Ana" "$ctx"
igual "grava o visto com a versao" "v1-aaaaaaaaaaaa" "$(jq -r .versao "$WS/.dgclaw/novidades-visto.json")"
igual "grava os 3 itens vistos" "3" "$(jq '.itens | length' "$WS/.dgclaw/novidades-visto.json")"
igual "segunda conversa: sem saida" "" "$(roda "$CONVERSA")"

echo "versao igual"
igual "versao igual: sem saida" "" "$(roda "$CONVERSA")"

echo "atualizacao com item novo"
cat >"$APP/CHANGELOG.md" <<'MD'
# Changelog

## [Não lançado]

### Adicionado

- Modo monitor de cards.
- Lousa para o agente desenhar no chat.
- Quadro de avisos com lembretes que insistem
  até o dono confirmar.

## [1.0.0] - 2026-10-17

### Adicionado

- Primeiro acesso por link.
MD
printf 'v1-bbbbbbbbbbbb\n' >"$APP/VERSAO"
ctx="$(contexto "$(roda "$CONVERSA")")"
tem "diz de v1-aaaa para v1-bbbb" "de v1-aaaaaaaaaaaa para v1-bbbbbbbbbbbb" "$ctx"
tem "traz so o item novo" "Modo monitor de cards." "$ctx"
nao_tem "nao repete o que ele ja viu" "Lousa para o agente" "$ctx"
igual "visto avancou" "v1-bbbbbbbbbbbb" "$(jq -r .versao "$WS/.dgclaw/novidades-visto.json")"
igual "depois do aviso: sem saida" "" "$(roda "$CONVERSA")"

echo "versao nova sem item novo no CHANGELOG"
printf 'v1-cccccccccccc\n' >"$APP/VERSAO"
igual "sem novidade: sem saida" "" "$(roda "$CONVERSA")"
igual "mas o visto avanca" "v1-cccccccccccc" "$(jq -r .versao "$WS/.dgclaw/novidades-visto.json")"

echo "texto longo e cortado"
{ printf '# Changelog\n\n## [Não lançado]\n\n### Adicionado\n\n'; for i in $(seq 1 40); do printf -- '- Novidade numero %s com bastante texto para ocupar espaco no bloco injetado, repetindo palavras e palavras e palavras.\n' "$i"; done; } >"$APP/CHANGELOG.md"
printf 'v1-dddddddddddd\n' >"$APP/VERSAO"
ctx="$(contexto "$(roda "$CONVERSA")")"
if [ "${#ctx}" -le 2600 ]; then ok "bloco cabe em ~2500 caracteres (${#ctx})"; else mal "bloco grande demais (${#ctx})"; fi
tem "avisa que cortou" "e mais algumas novidades menores" "$ctx"

echo "agente novo (semeado) nao recebe aviso"
rm -rf "$WS/.dgclaw/novidades-visto.json"
printf 'v1-eeeeeeeeeeee\n' >"$APP/VERSAO"
printf '%s' '' | DGCLAW_APP="$APP" DGCLAW_WORKSPACE="$WS" node "$HOOK" --semear
igual "semear sai com 0" "0" "$?"
igual "agente semeado: sem saida" "" "$(roda "$CONVERSA")"
printf 'v1-ffffffffffff\n' >"$APP/VERSAO"
printf '%s\n- Item que so existe depois.\n' "$(cat "$APP/CHANGELOG.md")" >"$APP/CHANGELOG.md"
ctx="$(contexto "$(roda "$CONVERSA")")"
tem "depois de atualizar, o semeado recebe so o item novo" "Item que so existe depois." "$ctx"
nao_tem "e nao os que ja nasceram com ele" "Novidade numero 1 " "$ctx"

echo "falhas saem com 0, sem texto, e anotam o log"
LOG="$WS/.dgclaw/logs/novidades-hook.log"
rm -f "$WS/.dgclaw/novidades-visto.json" "$LOG"
mv "$APP/CHANGELOG.md" "$APP/CHANGELOG.bak"
saida="$(roda "$CONVERSA")"; rc=$?
igual "CHANGELOG ausente: sem saida" "" "$saida"
igual "CHANGELOG ausente: sai com 0" "0" "$rc"
tem "CHANGELOG ausente: anota no log" "CHANGELOG" "$(cat "$LOG" 2>/dev/null)"
printf 'isso nao e um changelog\nsem itens\n' >"$APP/CHANGELOG.md"
saida="$(roda "$CONVERSA")"; rc=$?
igual "CHANGELOG estranho: sem saida" "" "$saida"
igual "CHANGELOG estranho: sai com 0" "0" "$rc"
tem "CHANGELOG estranho: anota no log" "nenhum item" "$(cat "$LOG")"
mv "$APP/CHANGELOG.bak" "$APP/CHANGELOG.md"
rm -f "$APP/VERSAO"
saida="$(roda "$CONVERSA")"; rc=$?
igual "VERSAO ausente: sem saida" "" "$saida"
igual "VERSAO ausente: sai com 0" "0" "$rc"
tem "VERSAO ausente: anota no log" "VERSAO" "$(cat "$LOG")"
printf 'v1-gggggggggggg\n' >"$APP/VERSAO"
printf '{quebrado' >"$WS/.dgclaw/novidades-visto.json"
ctx="$(contexto "$(roda "$CONVERSA")")"
tem "visto ilegivel: trata como agente antigo" "O DG Claw foi atualizado" "$ctx"
tem "visto ilegivel: anota no log" "ilegível" "$(cat "$LOG")"

printf '%s: %s verificacoes, %s falharam\n' "$(basename "$0")" "$TESTES" "$FALHAS"
[ "$FALHAS" -eq 0 ]
