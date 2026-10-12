#!/bin/bash
# memory-recall.sh — UserPromptSubmit hook do DG Claw. Faz 3 coisas (tudo local):
#   1. RECALL: traz trechos de conversas antigas e da memoria ligados a mensagem do dono.
#   2. CHAT-TAIL: registra a fala do dono no fio (pro re-contexto pos-compact).
#   3. AVISO DE TAMANHO: conta as trocas; se a conversa ficou longa, sugere a
#      compactacao (a agente avisa o dono e o contexto e preservado no pos-compact).
#
# DE ONDE VEM O RECALL (01/10/2026)
#   Fonte padrao: a busca em conversas (scripts/memory_index/conversas_fts.py), um indice
#   SQLite FTS5 local sobre as conversas do agente e os arquivos de memoria. Funciona sem
#   chave, sem rede e sem custo, e e ligada de fabrica (o timer conversas-fts mantem o
#   indice em dia). Enquanto o indice nao existe (agente recem-instalado, ou um Python sem
#   FTS5), cai no recall antigo por palavra-chave (memory_recall_local.py), que le os
#   arquivos direto.
#   COMPLEMENTO SEMANTICO (05/10/2026): quando a busca em conversas nao acha nada e a
#   mensagem tem palavra estranha (nome, sigla, termo que nao e do vocabulario de sempre),
#   roda a busca rapida da memoria semantica (memory_search_fast.py: primeiro o termo
#   escrito, depois o modelo local EmbeddingGemma ou o Gemini). Custa ~2 s na KVM 1 so
#   nesse caso, com teto duro pra caber nos 8 s do hook. Sem indice semantico, nao roda.
#   DGCLAW_SEMANTIC_RECALL=off desliga; com o hook-memory-inject.sh ligado
#   (DGCLAW_MEMORY_HOOK=1) tambem nao roda, pra nao buscar duas vezes.
#
# ORCAMENTO DE CONTEXTO: no maximo 3 trechos curtos (~220 caracteres) por mensagem, e so
# quando o casamento e bom (duas palavras da mensagem no mesmo trecho, ou uma palavra rara).
# E so para fala do DONO por um canal: poke de rotina nao dispara busca, porque alem de
# gastar contexto a toa, uma rotina publica nunca pode receber trecho de conversa privada.
#
# A conversa precisa continuar mesmo se isto quebrar: o hook sempre sai 0. Mas erro nao e
# engolido: vai para .dgclaw/logs/memory-recall.log, com o que falhou.

set +e
WORKSPACE="${DGCLAW_WORKSPACE:-$PWD}"
SCRIPTS="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/scripts/memory_index"
RECALL_LOCAL="$SCRIPTS/memory_recall_local.py"
FTS="$SCRIPTS/conversas_fts.py"
FTS_DB="${DGCLAW_CONVERSAS_DB:-$WORKSPACE/.dgclaw/memory_index/conversas.db}"
TAIL="$WORKSPACE/.dgclaw/chat-tail.md"
CNT="$WORKSPACE/.dgclaw/turns.count"
LOGF="$WORKSPACE/.dgclaw/logs/memory-recall.log"
COMPACT_AT=40   # avisa a partir de ~40 trocas desde a ultima compactacao
mkdir -p "$(dirname "$TAIL")" "$(dirname "$LOGF")" 2>/dev/null

logerr() { printf '[%s] %s\n' "$(date '+%F %T')" "$1" >> "$LOGF" 2>/dev/null; }

HOOK_INPUT=$(cat)

# O prompt cru (com o envelope do canal) e o texto limpo da fala.
PROMPT_RAW=$(printf '%s' "$HOOK_INPUT" | python3 -c "
import json, sys
try:
    print(json.loads(sys.stdin.read()).get('prompt','') or '')
except Exception as e:
    sys.stderr.write(f'entrada do hook nao e JSON: {e}')
" 2>>"$LOGF")
[ -z "$PROMPT_RAW" ] && exit 0

# Recado de rotina (poke) nao e fala do dono: nao entra no fio nem dispara recall.
case "$PROMPT_RAW" in
    *"/tmp/dgclaw-poke-"*|*"<plataforma "*) exit 0 ;;
esac

USER_TEXT=$(printf '%s' "$PROMPT_RAW" | python3 -c "
import re, sys
p = sys.stdin.read()
for tag in ('channel', 'dgchat'):
    p = re.sub(r'<%s\b[^>]*>' % tag, '', p); p = re.sub(r'</%s>' % tag, '', p)
print(p.strip())
" 2>>"$LOGF")
[ -z "$USER_TEXT" ] && exit 0

# --- chat-tail: registra a fala do dono ---
{ printf 'Dono: %s\n' "$(printf '%s' "$USER_TEXT" | tr '\n' ' ' | cut -c1-500)" >> "$TAIL"
  L=$(wc -l < "$TAIL"); [ "${L:-0}" -gt 80 ] && tail -n 80 "$TAIL" > "$TAIL.tmp" && mv "$TAIL.tmp" "$TAIL"
} 2>>"$LOGF"

# --- contador de trocas + aviso de compactacao ---
N=$(cat "$CNT" 2>/dev/null); N=$((${N:-0}+1)); echo "$N" > "$CNT" 2>>"$LOGF"
COMPACT_NOTE=""
if [ "$N" -ge "$COMPACT_AT" ] && [ $(( N % 10 )) -eq 0 ]; then
    COMPACT_NOTE="A conversa ja esta longa ($N mensagens). Logo o sistema vai resumir o contexto automaticamente, e voce NAO vai perder o fio (ele e re-injetado). Pode avisar o dono, em tom leve, que voce esta organizando a memoria pra manter a conversa fluida."
fi

# --- recall: busca em conversas (padrao) ou palavra-chave nos arquivos (enquanto nao ha indice) ---
extrai_recall='import json,sys
raw=sys.stdin.read()
if not raw.strip(): sys.exit(0)
try: r=json.loads(raw)
except Exception as e:
    sys.stderr.write(f"saida do recall nao e JSON: {e}: {raw[:200]}"); sys.exit(0)
print(r.get("recall") or "")'

T0=$(date +%s%3N)
RC=""
if [ -f "$FTS" ] && [ -f "$FTS_DB" ]; then
    # o codigo de saida do timeout precisa sair de dentro da substituicao de comando
    SAIDA=$(printf '%s' "$PROMPT_RAW" | python3 -c "import json,sys; print(json.dumps({'input': sys.stdin.read()}))" \
        | DGCLAW_WORKSPACE="$WORKSPACE" timeout 4 python3 "$FTS" --workspace "$WORKSPACE" recall 2>>"$LOGF"
        echo "__rc=${PIPESTATUS[2]}")
    RC="${SAIDA##*__rc=}"
    [ "$RC" = "124" ] && logerr "a busca em conversas passou de 4s e foi abandonada nesta mensagem (indice grande demais ou travado por outro processo?)"
    [ "$RC" != "0" ] && [ "$RC" != "124" ] && logerr "a busca em conversas saiu com codigo $RC (detalhe nas linhas acima deste log)"
    RECALL_TEXT=$(printf '%s' "${SAIDA%__rc=*}" | python3 -c "$extrai_recall" 2>>"$LOGF")
else
    RECALL_TEXT=$(printf '%s' "$USER_TEXT" | python3 -c "import json,sys; print(json.dumps({'input': sys.stdin.read()}))" \
        | DGCLAW_WORKSPACE="$WORKSPACE" timeout 5 python3 "$RECALL_LOCAL" 2>>"$LOGF" \
        | python3 -c "$extrai_recall" 2>>"$LOGF")
fi

# --- complemento semantico: so quando a busca em conversas voltou vazia ---
FAST="$SCRIPTS/memory_search_fast.py"
IDX="${DGCLAW_MEMORY_INDEX_DIR:-$WORKSPACE/.dgclaw/memory_index}"
if [ -z "$RECALL_TEXT" ] && [ "$RC" != "124" ] && [ "${DGCLAW_SEMANTIC_RECALL:-on}" != "off" ] \
   && [ "${DGCLAW_MEMORY_HOOK:-0}" != "1" ] && [ -f "$FAST" ] \
   && [ -f "$IDX/chunks.db" ] && [ -f "$IDX/baseline-vocab.json" ]; then
    # o hook inteiro tem 8 s (hooks.json); a busca semantica fica com o que sobrar ate 6,5 s,
    # no maximo 3 s. Menos de 1,5 s nao da nem pra subir o modelo: nem tenta.
    SOBRA_MS=$(( 6500 - ($(date +%s%3N) - T0) ))
    [ "$SOBRA_MS" -gt 3000 ] && SOBRA_MS=3000
    if [ "$SOBRA_MS" -ge 1500 ]; then
        SEM=$(printf '%s' "$USER_TEXT" | python3 -c "import json,sys; print(json.dumps({'input': sys.stdin.read()}))" \
            | DGCLAW_WORKSPACE="$WORKSPACE" timeout "$((SOBRA_MS / 1000)).$((SOBRA_MS % 1000 / 100))" \
              nice -n 5 python3 "$FAST" 2>>"$LOGF"
            echo "__rc=${PIPESTATUS[2]}")
        SRC="${SEM##*__rc=}"
        [ "$SRC" = "124" ] && logerr "a busca semantica passou de ${SOBRA_MS}ms e foi abandonada nesta mensagem (maquina ocupada? veja docs/MEMORIA-SEMANTICA.md)"
        # orcamento de contexto: no maximo ~700 caracteres, igual ao teto da busca em conversas
        RECALL_TEXT=$(printf '%s' "${SEM%__rc=*}" | python3 -c "$extrai_recall" 2>>"$LOGF" \
            | python3 -c "import sys; t=sys.stdin.read().strip(); print(t if len(t)<=700 else t[:700].rstrip()+' (...)')" 2>>"$LOGF")
    fi
fi

# --- quarentena do modo de seguranca: a mensagem que travou o agente nao volta pelo recall ---
# As duas buscas leem as conversas antigas, inclusive a que fez ele travar. Ver _lib/quarentena.py.
QUAR="$SCRIPTS/../_lib/quarentena.py"
if [ -n "$RECALL_TEXT" ] && [ -f "$QUAR" ] && { [ -d "$WORKSPACE/.dgclaw/quarentena" ] || [ -f "$WORKSPACE/.dgclaw/modo-seguro.json" ]; }; then
    RECALL_TEXT=$(printf '%s' "$RECALL_TEXT" | timeout 3 python3 "$QUAR" filtrar-linhas --workspace "$WORKSPACE" 2>>"$LOGF") \
        || { logerr "o filtro da quarentena falhou nesta mensagem; por seguranca o recall nao entrou"; RECALL_TEXT=""; }
fi

CTX=""
[ -n "$RECALL_TEXT" ] && CTX="$RECALL_TEXT"
[ -n "$COMPACT_NOTE" ] && CTX="${CTX:+$CTX

}$COMPACT_NOTE"
[ -z "$CTX" ] && exit 0

CTX="$CTX" python3 -c "
import json, os
print(json.dumps({'hookSpecificOutput': {'hookEventName':'UserPromptSubmit','additionalContext': os.environ['CTX']}}, ensure_ascii=False))
" 2>>"$LOGF"
exit 0
