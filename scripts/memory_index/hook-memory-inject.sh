#!/bin/bash
# hook-memory-inject.sh — UserPromptSubmit hook do DG Claw: "eco do passado" numa DM.
#
# Numa DM da pessoa virtual (sessao --channels viva), ANTES de ela responder, este hook
# roda a busca semantica na memoria DA PROPRIA persona e, se algo do passado bater com a
# mensagem, injeta um "eco do passado" como additionalContext pra ela (ela usa so se fizer
# sentido). E o backport, generalizado e PARAMETRIZADO por env DGCLAW_*, do hook de
# memoria por sessao viva — sem nada hardcoded (sem vault externo,
# sem paths de workspace fixos, sem slug fixo).
#
# Pipeline:
#   1. GATES (qualquer um falha -> exit 0, nada injetado):
#        - DGCLAW_MEMORY_HOOK=1            (opt-in; default OFF)
#        - DGCLAW_PRIVATE_CONTEXT=1        (so contexto privado do dono)
#        - memoria semantica ligada OU indice ja existente (embedder.py: modelo local
#          EmbeddingGemma ou GEMINI_API_KEY; com indice e sem provedor, vale o termo exato)
#        - scripts de busca existem          (no indice ou, desde 05/10/2026, no proprio plugin)
#   2. Le hookInput JSON do stdin (formato Claude Code: { prompt, ... }).
#   3. Extrai o texto do user (tira o wrapper <channel ...> se houver).
#   4. Roda memory_search_fast.py (fallback memory_search.py) com TIMEOUT DURO ~3s.
#   5. Se disparou: emite JSON com hookSpecificOutput.additionalContext ("eco do passado").
#      Senao: stdout vazio (nao injeta nada).
#
# REGRA DE OURO: NUNCA quebra a sessao. Qualquer erro/timeout/ausencia -> exit 0, sem output.
# A DM precisa continuar mesmo que o hook de memoria falhe.
#
# Registro do hook: ver docs/MEMORY-HOOK.md (opt-in, default OFF). O hook so faz algo se o
# dono setar DGCLAW_MEMORY_HOOK=1 e DGCLAW_PRIVATE_CONTEXT=1 no launch da sessao viva.
#
# Uso (chamado pelo Claude Code como command de UserPromptSubmit; hookInput via stdin):
#   bash hook-memory-inject.sh
# Opcional: bash hook-memory-inject.sh <.dgclaw/config.sh>  (carrega os DGCLAW_* do config)

set +e

# ─── Carrega config (opcional): 1o arg, ou DGCLAW_CONFIG ─────────────────────
# Permite registrar o hook como `bash .../hook-memory-inject.sh "$DGCLAW_CONFIG"`,
# herdando DGCLAW_WORKSPACE/SLUG/GEMINI_API_KEY/etc. Se nao vier, usa o ambiente atual.
CONFIG="${1:-${DGCLAW_CONFIG:-}}"
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    source "$CONFIG" 2>/dev/null
fi

# ─── Resolve paths/logs (best-effort; nunca aborta) ────────────────────────────
WS="${DGCLAW_WORKSPACE:-}"
SLUG="${DGCLAW_SLUG:-persona}"
INDEX_DIR="${DGCLAW_MEMORY_INDEX_DIR:-${WS:+$WS/.dgclaw/memory_index}}"
LOG_DIR="${WS:+$WS/.dgclaw/logs}"
LOG="${LOG_DIR:-/tmp}/hook-memory-inject.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null

_log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG" 2>/dev/null; }

# ─── GATE 1: opt-in (default OFF) ──────────────────────────────────────────────
if [ "${DGCLAW_MEMORY_HOOK:-0}" != "1" ]; then
    # silencioso: hook desligado por padrao. Nem loga em nivel normal pra nao poluir.
    exit 0
fi

# ─── GATE 2: contexto privado do dono ──────────────────────────────────────────
# So injeta memoria pessoal em sessao PRIVADA (DM do dono). Qualquer outro spawn
# (publico/ronda/post) nao seta DGCLAW_PRIVATE_CONTEXT=1 -> nao injeta nada.
if [ "${DGCLAW_PRIVATE_CONTEXT:-0}" != "1" ]; then
    _log "skip: contexto nao-privado (DGCLAW_PRIVATE_CONTEXT!=1)"
    exit 0
fi

# ─── GATE 3: scripts de busca (copia no indice, se houver; senao os do plugin) ──
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEARCH=""
for d in "$INDEX_DIR" "$SELF_DIR"; do
    [ -n "$d" ] || continue
    if [ -f "$d/memory_search_fast.py" ]; then SEARCH="$d/memory_search_fast.py"; break; fi
    if [ -f "$d/memory_search.py" ]; then SEARCH="$d/memory_search.py"; break; fi
done
if [ -z "$SEARCH" ]; then
    _log "skip: nenhum script de busca em '$INDEX_DIR' nem em '$SELF_DIR'"
    exit 0
fi

# ─── GATE 4: memoria semantica ligada (modelo local ou Gemini) ou indice pronto ──
EMB_MOTIVO=$(python3 "$(dirname "$SEARCH")/embedder.py" status 2>&1)
EMB_RC=$?
if [ "$EMB_RC" != "0" ] && [ ! -f "$INDEX_DIR/chunks.db" ]; then
    _log "$EMB_MOTIVO"
    exit 0
fi

# ─── Le hookInput do stdin (JSON com .prompt) ──────────────────────────────────
HOOK_INPUT=$(cat)

# Extrai o texto do user. Channels manda como:
#   <channel source="..." chat_id="..." ...>TEXTO</channel>
USER_TEXT=$(printf '%s' "$HOOK_INPUT" | python3 -c "
import json, sys, re
try:
    d = json.loads(sys.stdin.read())
    p = d.get('prompt', '') or ''
    p = re.sub(r'<channel[^>]*>', '', p)
    p = re.sub(r'</channel>', '', p)
    print(p.strip())
except Exception:
    pass
" 2>/dev/null)

if [ -z "$USER_TEXT" ]; then
    _log "empty user text, skip"
    exit 0
fi

# ─── Busca semantica com timeout DURO ~3s ──────────────────────────────────────
# O wrapper monta o payload {"input": "..."} esperado pelos scripts de busca.
# Com o modelo local o llama-server sobe na hora (~2 s numa KVM 1), entao o teto padrao
# e 5 s. A palavra rara achada escrita nem sobe o modelo e volta em milissegundos.
case "$EMB_MOTIVO" in *"local"*) _TETO=5 ;; *) _TETO=3 ;; esac
TIMEOUT_S="${DGCLAW_MEMORY_HOOK_TIMEOUT:-$_TETO}"
RESULT=$(
    printf '%s' "$USER_TEXT" | python3 -c "
import json, sys
print(json.dumps({'input': sys.stdin.read()}))
" 2>/dev/null | timeout "$TIMEOUT_S" python3 "$SEARCH" 2>>"$LOG"
)

if [ -z "$RESULT" ]; then
    _log "busca retornou vazio (timeout ${TIMEOUT_S}s? sem indice?)"
    exit 0
fi

# ─── Decide injecao. fired=true -> emite additionalContext "eco do passado" ─────
# Compativel com a saida tanto do memory_search_fast (campo 'recall') quanto do
# memory_search (campo 'recall' tambem). 'fired' so existe no fast; o full usa 'recall'
# nao-nulo como sinal. Tratamos ambos.
printf '%s' "$RESULT" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
recall = (d.get('recall') or '').strip()
fired = d.get('fired')
# fast: exige fired=True. full: nao tem 'fired' -> basta recall nao-vazio.
if fired is False:
    sys.exit(0)
if not recall:
    sys.exit(0)
out = {
    'hookSpecificOutput': {
        'hookEventName': 'UserPromptSubmit',
        'additionalContext': 'Eco do passado (use so se fizer sentido):\n' + recall,
    }
}
print(json.dumps(out, ensure_ascii=False))
" 2>/dev/null

# ─── Log de diagnostico (best-effort) ──────────────────────────────────────────
SHORT_TEXT=$(printf '%s' "$USER_TEXT" | head -c 80 | tr '\n' ' ')
SHORT_RESULT=$(printf '%s' "$RESULT" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(f\"fired={d.get('fired')} skip={d.get('skip_reason') or d.get('reason')} score={d.get('score')} dur={d.get('duration_ms')}ms\")
except Exception:
    print('(parse falhou)')
" 2>/dev/null)
_log "$SHORT_RESULT | text=$SHORT_TEXT"
exit 0
