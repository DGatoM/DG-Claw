#!/usr/bin/env bash
# Testa scripts/heartbeat.sh: o batimento so injeta o poke quando a secao "Quero Falar com o <dono> Sobre"
# tem conteudo novo (ou passou o prazo), respeita a marca [a partir de AAAA-MM-DD] e so grava o estado
# depois que a injecao volta 0. Workspace, plugin e sessao falsos: nada encosta no sistema.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$AQUI/../../scripts/heartbeat.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FALHAS=0; TESTES=0
ok() { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }
igual() { if [ "$2" = "$3" ]; then ok "$1"; else mal "$1 (esperado '$2', veio '$3')"; fi; }
tem() { if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else mal "$1 (nao achei '$2' em: ${3:0:300})"; fi; }

WS="$TMP/ws"; PLUGIN="$TMP/plugin"
mkdir -p "$WS/.dgclaw/logs" "$PLUGIN/scripts/_lib"
cat >"$WS/.dgclaw/config.sh" <<CFG
DGCLAW_WORKSPACE="$WS"
DGCLAW_SLUG=teste
DGCLAW_OWNER=Marta
DGCLAW_NAME=Ana
CFG
cat >"$PLUGIN/scripts/build-working-memory.py" <<'PY'
import sys
sys.exit(0)
PY
INJ="$TMP/injecoes.log"; RCF="$TMP/rc"
cat >"$PLUGIN/scripts/_lib/inject.sh" <<FAKE
is_session_alive() { return 0; }
inject_session() { cat >/dev/null; echo "\$1 \$2" >> "$INJ"; return "\$(cat "$RCF")"; }
FAKE
STATE="$WS/.dgclaw/state/heartbeat.state"
LOG="$WS/.dgclaw/logs/heartbeat.log"

# batida [VAR=valor ...]: um batimento; ecoa o numero total de injecoes ate agora
batida() {
    env DGCLAW_PLUGIN_ROOT="$PLUGIN" "$@" bash "$SCRIPT" "$WS/.dgclaw/config.sh" >/dev/null 2>&1
    RC=$?
    N="$(wc -l <"$INJ" | tr -d ' ')"
}
# secao <linha...>: reescreve a working-memory so com essas linhas na secao
secao() {
    {
        printf '# WM\n\n## Agora\n- x\n\n## Quero Falar com o Marta Sobre\n<!-- comentario -->\n'
        [ $# -eq 0 ] || printf '%s\n' "$@"
        printf '\n## Outra\n- y\n'
    } >"$WS/working-memory.md"
}
zera() { : >"$INJ"; : >"$LOG"; rm -rf "$WS/.dgclaw/state"; echo 0 >"$RCF"; }

HOJE="$(date +%F)"; AMANHA="$(date -d '+1 day' +%F)"; ONTEM="$(date -d '-1 day' +%F)"

echo "heartbeat: secao sem linha real"
zera; secao "- (placeholder)"
batida; igual "placeholder e comentario nao acordam o agente" 0 "$N"
tem "o log diz que nao havia nada a fazer" "nada a fazer" "$(cat "$LOG")"

echo "heartbeat: mesmo conteudo nao repete"
zera; secao "- lembrar de perguntar do formato"
batida; igual "1o batimento injeta" 1 "$N"
afirma_estado() { if [ -s "$STATE" ]; then ok "$1"; else mal "$1"; fi; }
afirma_estado "grava o estado depois do poke"
batida; igual "2o batimento com o mesmo conteudo nao injeta" 1 "$N"
tem "o log explica por que nao acordou" "mesmo assunto ja levado ao agente" "$(cat "$LOG")"
secao "- lembrar de perguntar do formato" "- outro assunto"
batida; igual "conteudo mudou: injeta" 2 "$N"
secao "-   outro assunto   " "- lembrar de perguntar do formato"
batida; igual "outra ordem de linhas e outro conteudo: injeta" 3 "$N"
secao "-   outro assunto   " "- lembrar de perguntar do formato"
batida; igual "espacos nas pontas nao mudam a assinatura" 3 "$N"

echo "heartbeat: prazo de repeticao"
zera; secao "- assunto parado"
batida
HASH_ATUAL="$(cut -d' ' -f1 "$STATE")"
printf '%s %s\n' "$HASH_ATUAL" "$(( $(date +%s) - 25 * 3600 ))" >"$STATE"
batida; igual "mesmo conteudo com estado de 25h atras: injeta" 2 "$N"
printf '%s %s\n' "$HASH_ATUAL" "$(( $(date +%s) - 25 * 3600 ))" >"$STATE"
batida DGCLAW_HEARTBEAT_REPETIR_H=48; igual "com prazo de 48h, 25h ainda nao injeta" 2 "$N"
batida DGCLAW_HEARTBEAT_REPETIR_H=abc; igual "prazo invalido usa 24h (25h atras injeta)" 3 "$N"
tem "o log avisa do prazo invalido" "nao e um numero inteiro positivo" "$(cat "$LOG")"

echo "heartbeat: linhas adiadas"
zera; secao "- ligar pro fornecedor [a partir de $AMANHA]"
batida; igual "data futura: nao injeta" 0 "$N"
secao "- ligar pro fornecedor [a partir de $ONTEM]"
batida; igual "data passada: injeta" 1 "$N"
zera; secao "- ligar pro fornecedor [a partir de $HOJE]"
batida; igual "data de hoje: injeta" 1 "$N"
zera; secao "- ligar pro fornecedor [a partir de amanha]"
batida; igual "data malformada: a linha conta" 1 "$N"
zera; secao "- [A partir de $AMANHA] adiado" "- este vale"
batida; igual "uma linha adiada e outra real: injeta" 1 "$N"
zera; secao "- adiado [a partir de $AMANHA]"
batida; secao "- adiado [a partir de $AMANHA]" "- real agora"
batida; igual "linha nova junto da adiada: injeta" 1 "$N"
zera; secao "- prazo [a partir de 2026-13-01]"
batida; igual "mes 13 nao existe: a linha conta" 1 "$N"
zera; secao "- prazo [a partir de 2099-02-30]"
batida; igual "30 de fevereiro nao existe: a linha conta" 1 "$N"
zera; secao "- prazo [a partir de 2096-02-29]"
batida; igual "29/02 de ano bissexto futuro: fica quieta" 0 "$N"
zera; secao "- prazo [a partir de 2099-02-29]"
batida; igual "29/02 de ano comum: a linha conta" 1 "$N"
zera; secao "- adiado duas vezes [a partir de $ONTEM] [a partir de $AMANHA]"
batida; igual "vale a ultima marca (futura): fica quieta" 0 "$N"
zera; secao "- adiado [a partir de $AMANHA] [a partir de $ONTEM]"
batida; igual "vale a ultima marca (passada): injeta" 1 "$N"

echo "heartbeat: estado so depois do sucesso"
zera; secao "- assunto"
echo 75 >"$RCF"; batida
igual "sessao ocupada (75) sai 0" 0 "$RC"
igual "75: tentou injetar" 1 "$N"
if [ -e "$STATE" ]; then mal "75: nao grava estado"; else ok "75: nao grava estado"; fi
echo 0 >"$RCF"; batida; igual "proximo batimento injeta de novo" 2 "$N"
afirma_estado "e agora grava o estado"
zera; secao "- assunto"; echo 1 >"$RCF"; batida
igual "falha real propaga o rc" 1 "$RC"
if [ -e "$STATE" ]; then mal "falha: nao grava estado"; else ok "falha: nao grava estado"; fi

echo "heartbeat: override e estado corrompido"
zera; secao "- assunto"
batida; batida DGCLAW_HEARTBEAT_FORCE=1
igual "DGCLAW_HEARTBEAT_FORCE=1 injeta mesmo com o mesmo conteudo" 2 "$N"
echo "lixo qualquer" >"$STATE"
batida; igual "estado corrompido: injeta" 3 "$N"
tem "o log explica o estado corrompido" "ilegivel ou fora do formato" "$(cat "$LOG")"
if grep -qE '^[0-9a-f]{64} [0-9]+$' "$STATE"; then ok "o estado volta ao formato certo"; else mal "o estado volta ao formato certo ($(cat "$STATE"))"; fi

printf '\n%s testes, %s falhas\n' "$TESTES" "$FALHAS"
[ "$FALHAS" -eq 0 ]
