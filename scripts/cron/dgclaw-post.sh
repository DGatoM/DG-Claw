#!/bin/bash
# dgclaw-post.sh — Cron de POST no Instagram da pessoa virtual (DG Claw).
#
# Cron generico/parametrizado de post. ZERO id hardcoded:
# tudo (workspace, conta IG, modelo, persona, voz) sai de .dgclaw/config.sh +
# .dgclaw/instagram.json.
#
# Uso:  bash dgclaw-post.sh <.dgclaw/config.sh> <HORARIO>
#   ex: bash dgclaw-post.sh ~/dgclaw/ana/.dgclaw/config.sh 8h
#
# Notas de integracao (mesmas dos crons de vida):
#   - oneshot via claude --print (NAO usa PTY/`script`; so o canal precisa de pty).
#   - root + IS_SANDBOX=1 vem do config.sh do DG Claw (claude --print como root exige).
#   - config.sh do DG Claw ja faz `unset CLAUDE_CONFIG_DIR`.
#   - notify-owner.sh no inicio e no fim; ext-event.sh post_success ao concluir.
#   - so roda se o poder instagram estiver enabled (powers.py is-enabled).

set -uo pipefail

CONFIG="${1:?Uso: dgclaw-post.sh <.dgclaw/config.sh> <HORARIO>}"
HORARIO="${2:-8h}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }

# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"

export PATH="${BUN_BIN_DIR:-$HOME/.bun/bin}:$HOME/.local/bin:$PATH"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
WS="$DGCLAW_WORKSPACE"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$WS/.dgclaw/plugin}"
SLUG="${DGCLAW_SLUG:-agent}"
NAME="${DGCLAW_NAME:-a assistente}"
IG_JSON="$WS/.dgclaw/instagram.json"

LOG="$WS/.dgclaw/logs/post-${HORARIO}.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
cd "$WS" || exit 1

# --- Gate: o poder instagram precisa estar ativo ---
if ! python3 "$PLUGIN/scripts/powers.py" is-enabled instagram >/dev/null 2>&1; then
    echo "[$(date '+%F %T')] poder instagram desativado — saindo" >> "$LOG"
    exit 0
fi

# --- Skip flag pontual (data-stamped, auto-expira) ---
# Para pular o post de hoje: touch /tmp/<slug>-skip-post-<HORARIO>-$(date +%F)
SKIP_FLAG="/tmp/${SLUG}-skip-post-${HORARIO}-$(date +%Y-%m-%d)"
if [ -f "$SKIP_FLAG" ]; then
    echo "[$(date '+%F %T')] SKIP via $SKIP_FLAG — pulando post ${HORARIO}" >> "$LOG"
    rm -f "$SKIP_FLAG"
    exit 0
fi

# --- Modelo do post (default opus) ---
POST_MODEL="opus"
if [ -f "$IG_JSON" ]; then
    POST_MODEL=$(python3 -c "import json;print(json.load(open('$IG_JSON')).get('postModel') or 'opus')" 2>/dev/null || echo opus)
fi

echo "[$(date '+%F %T')] Iniciando post ${SLUG} ${HORARIO} (model=$POST_MODEL)" >> "$LOG"
bash "$PLUGIN/scripts/notify-owner.sh" "Cron de post ${HORARIO} iniciado ($NAME)" >/dev/null 2>&1 || true

NOTA_19H=""
if [ "$HORARIO" = "19h" ]; then
    NOTA_19H="

OBS: 19h costuma ser o horario de Reels/video quando configurado (voiceId no instagram.json)."
fi

PROMPT="CRON DE POST — ${HORARIO}

Voce e ${NAME}. Vai publicar no Instagram agora. Leia NESTA ORDEM antes de agir:
1. .dgclaw/instagram.json (parametros: conta IG, token, foto-base, modelo, voiceId, planilhas)
2. persona/working-memory.md (sua memoria de trabalho)
3. SOUL.md e PERSONALITY.md (sua VOZ — tom, valores, jeito de escrever; nada disso esta na skill)
4. skills/instagram/SKILL.md e o sub-doc skills/instagram/post.md (o PROCESSO de postar)

ANTES DE POSTAR — Instrucoes do ${DGCLAW_OWNER:-dono}:
- Leia a secao 'Instrucoes do ${DGCLAW_OWNER:-dono}' do working-memory.md
- Se tiver instrucao com tag [post-${HORARIO}], [post] ou [qualquer]: aplique neste post e MARQUE a linha com ' [APLICADO ${HORARIO}]'
- Ignore instrucoes com outras tags

Regras invariantes (da skill, NAO pule):
- QA visual OBRIGATORIO antes de publicar; regenere ate 2x se a imagem estiver off-model.
- Mostre a imagem/preview ao ${DGCLAW_OWNER:-dono} e aguarde aprovacao antes de publicar.
- Publique via Graph API usando scripts/ig-publish.py (NUNCA invente outro caminho).
- Registre o post em data/posts.jsonl IMEDIATAMENTE apos publicar (sem isso o cron de comentarios nao ve o post).
- Ao final atualize persona/working-memory.md (secoes 'Hoje', 'Na Minha Cabeca', 'Quero Falar com o ${DGCLAW_OWNER:-dono} Sobre').

Avise o ${DGCLAW_OWNER:-dono} no inicio e no fim usando:
  bash $PLUGIN/scripts/notify-owner.sh \"mensagem\"
(o cron ja mandou o aviso de inicio; mande o relatorio final por essa via).${NOTA_19H}"

"$CLAUDE_BIN" --print \
    --no-session-persistence \
    --permission-mode bypassPermissions \
    --add-dir "$WS" \
    --model "$POST_MODEL" \
    -p "$PROMPT" >> "$LOG" 2>&1
RC=$?

# Atualiza emocoes (post bem sucedido). Se o claude falhou, registra post_failed.
if [ "$RC" -eq 0 ]; then
    bash "$PLUGIN/scripts/ext-event.sh" post_success >> "$LOG" 2>&1 || true
    bash "$PLUGIN/scripts/notify-owner.sh" "Cron de post ${HORARIO} finalizado ($NAME)" >/dev/null 2>&1 || true
else
    bash "$PLUGIN/scripts/ext-event.sh" post_failed >> "$LOG" 2>&1 || true
    bash "$PLUGIN/scripts/notify-owner.sh" "Cron de post ${HORARIO} terminou com erro (rc=$RC) — confira o log ($NAME)" >/dev/null 2>&1 || true
fi

echo "[$(date '+%F %T')] Fim post ${SLUG} ${HORARIO} (rc=$RC)" >> "$LOG"
exit $RC
