#!/bin/bash
# install-ig-timers.sh — Cria/remove os timers systemd do PODER INSTAGRAM (DG Claw).
#
# Deriva os horarios do `schedule` do instagram.json (default 8h/13h/19h). Cria:
#   dgclaw-<slug>-post-8h.timer    OnCalendar 08:00   -> dgclaw-post.sh ... 8h
#   dgclaw-<slug>-post-13h.timer   OnCalendar 13:00   -> dgclaw-post.sh ... 13h
#   dgclaw-<slug>-post-19h.timer   OnCalendar 19:00   -> dgclaw-post.sh ... 19h
#   dgclaw-<slug>-comments.timer   10/30min apos cada post + de hora em hora
#                                                        -> dgclaw-comentarios.sh
#
# Cada .service: User= e HOME= do DONO DA PASTA DO AGENTE (root no plugin classico, `agente` na
#   v1; ver scripts/_lib/dono_agente.py), IS_SANDBOX=1, TZ=America/Sao_Paulo
#   (TZ obrigatorio: sem ele OnCalendar dispara em UTC e os horarios saem errados).
# ExecStart aponta pra $DGCLAW_PLUGIN_ROOT/scripts/cron/ (caminho estavel).
#
# Ao final marca o poder:  powers.py enable instagram --timers <nomes criados>
#
# Uso:
#   sudo bash install-ig-timers.sh <.dgclaw/config.sh>            # instala + ativa
#   sudo bash install-ig-timers.sh <.dgclaw/config.sh> --off      # remove + disable
#   sudo bash install-ig-timers.sh <.dgclaw/config.sh> --tz <TZ>  # timezone custom

set -euo pipefail

CONFIG="${1:?Uso: install-ig-timers.sh <.dgclaw/config.sh> [--off] [--tz TZ]}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }

MODE="install"
TZ_VAL="America/Sao_Paulo"
shift || true
while [ $# -gt 0 ]; do
    case "$1" in
        --off) MODE="off" ;;
        --tz) shift; TZ_VAL="${1:?--tz precisa de valor}" ;;
        *) echo "arg desconhecido: $1" >&2; exit 1 ;;
    esac
    shift
done

# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
SLUG="$DGCLAW_SLUG"
WS="$DGCLAW_WORKSPACE"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$WS/.dgclaw/plugin}"
ABS_CONFIG="$(readlink -f "$CONFIG")"
# Pasta das units; em producao e a do systemd, nos testes aponta para uma pasta falsa.
UNIT_DIR="${DGCLAW_SYSTEMD_DIR:-/etc/systemd/system}"
# O ajudante vem do lugar deste proprio script, nao de $PLUGIN: na v1 o plugin fica fora do
# workspace (/opt/dgclaw/app) e $PLUGIN depende do config.sh, que pode estar velho.
DONO_PY="$(dirname "${BASH_SOURCE[0]}")/_lib/dono_agente.py"
IG_JSON="$WS/.dgclaw/instagram.json"
CRON_DIR="$PLUGIN/scripts/cron"

# Lista de timers que este script gerencia (preenchida abaixo).
TIMER_NAMES=()

# Devolve ao dono da pasta do agente o que este script (rodando como root, via sudo) criou ou
# mexeu dentro do workspace; sem isso o agente nao consegue mais escrever nesses arquivos.
devolver_ao_dono() {
    python3 "$DONO_PY" chown --ws "$WS" "$@" || {
        echo "AVISO: nao consegui devolver ao dono da pasta do agente: $*. Rode o chown do aviso acima." >&2
    }
}

# ---------- modo OFF: parar/remover tudo e travar o poder ----------
if [ "$MODE" = "off" ]; then
    echo "==> desativando poder instagram para ${SLUG}"
    for unit in "${UNIT_DIR}"/dgclaw-"${SLUG}"-post-*.timer \
                "${UNIT_DIR}"/dgclaw-"${SLUG}"-post-*.service \
                "${UNIT_DIR}"/dgclaw-"${SLUG}"-comments.timer \
                "${UNIT_DIR}"/dgclaw-"${SLUG}"-comments.service; do
        [ -e "$unit" ] || continue
        base="$(basename "$unit")"
        if [[ "$base" == *.timer ]]; then
            systemctl disable --now "$base" 2>/dev/null || true
        fi
        rm -f "$unit"
    done
    systemctl daemon-reload
    python3 "$PLUGIN/scripts/powers.py" --file "$WS/.dgclaw/powers.json" disable instagram || true
    devolver_ao_dono "$WS/.dgclaw/powers.json"
    echo "==> timers removidos e poder instagram travado (abas POSTS/FOLLOWERS voltam a travar)."
    echo "    Dados preservados (data/posts.jsonl, persona/followers/, etc)."
    exit 0
fi

# ---------- horarios de post: do schedule do instagram.json, com fallback ----------
# Espera schedule:[{"time":"08:00","type":"post"}, ...] — pega so os de tipo post.
POST_TIMES=""
if [ -f "$IG_JSON" ]; then
    POST_TIMES=$(python3 -c '
import json,sys
try:
    cfg=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
sched=cfg.get("schedule") or []
times=[s.get("time") for s in sched if (s.get("type") or "post")=="post" and s.get("time")]
print(" ".join(times))
' "$IG_JSON" 2>/dev/null || true)
fi
[ -z "$POST_TIMES" ] && POST_TIMES="08:00 13:00 19:00"

# Descobre o usuario da unit ANTES de gravar qualquer coisa: se falhar, nada fica pela metade.
UNIT_DONO="$(python3 "$DONO_PY" unidade --ws "$WS")" || {
    echo "ERRO: nao consegui decidir com que usuario os timers do Instagram rodam (veja a mensagem acima)." >&2
    exit 1
}

mkdir -p "$WS/.dgclaw/logs"
devolver_ao_dono "$WS/.dgclaw" "$WS/.dgclaw/logs"

make_post_unit() {
    local label="$1" hhmm="$2"   # label ex: 8h ; hhmm ex: 08:00
    cat > "${UNIT_DIR}/dgclaw-${SLUG}-post-${label}.service" <<EOF
[Unit]
Description=DG Claw Instagram post ${label}: ${SLUG}

[Service]
Type=oneshot
${UNIT_DONO}
Environment=IS_SANDBOX=1
Environment=TZ=${TZ_VAL}
WorkingDirectory=${WS}
ExecStart=/bin/bash ${CRON_DIR}/dgclaw-post.sh ${ABS_CONFIG} ${label}
EOF
    cat > "${UNIT_DIR}/dgclaw-${SLUG}-post-${label}.timer" <<EOF
[Unit]
Description=DG Claw Instagram post ${label} (timer): ${SLUG}

[Timer]
OnCalendar=*-*-* ${hhmm}:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
    TIMER_NAMES+=("dgclaw-${SLUG}-post-${label}.timer")
}

# Monta os timers de post + acumula gatilhos de comentarios (10/30min apos cada post).
COMMENT_ONCALENDAR=()
for t in $POST_TIMES; do
    hh="${t%%:*}"; mm="${t##*:}"
    hh_num=$((10#$hh))
    label="${hh_num}h"   # 08:00 -> 8h ; 13:00 -> 13h
    make_post_unit "$label" "$(printf '%02d:%02d' "$hh_num" "$((10#$mm))")"
    # comentarios 10 e 30 min depois do post
    COMMENT_ONCALENDAR+=("*-*-* $(printf '%02d:10' "$hh_num"):00")
    COMMENT_ONCALENDAR+=("*-*-* $(printf '%02d:30' "$hh_num"):00")
done
# E de hora em hora (varredura geral), no minuto 5
COMMENT_ONCALENDAR+=("*-*-* *:05:00")

# ---------- timer de comentarios (multiplos OnCalendar) ----------
cat > "${UNIT_DIR}/dgclaw-${SLUG}-comments.service" <<EOF
[Unit]
Description=DG Claw Instagram comentarios: ${SLUG}

[Service]
Type=oneshot
${UNIT_DONO}
Environment=IS_SANDBOX=1
Environment=TZ=${TZ_VAL}
WorkingDirectory=${WS}
ExecStart=/bin/bash ${CRON_DIR}/dgclaw-comentarios.sh ${ABS_CONFIG}
EOF

{
    echo "[Unit]"
    echo "Description=DG Claw Instagram comentarios (timer): ${SLUG}"
    echo
    echo "[Timer]"
    for oc in "${COMMENT_ONCALENDAR[@]}"; do
        echo "OnCalendar=${oc}"
    done
    echo "Persistent=true"
    echo
    echo "[Install]"
    echo "WantedBy=timers.target"
} > "${UNIT_DIR}/dgclaw-${SLUG}-comments.timer"
TIMER_NAMES+=("dgclaw-${SLUG}-comments.timer")

# ---------- ativar ----------
systemctl daemon-reload
for tm in "${TIMER_NAMES[@]}"; do
    systemctl enable --now "$tm"
done

echo "==> timers de Instagram instalados e ativos:"
systemctl list-timers "dgclaw-${SLUG}-post-*" "dgclaw-${SLUG}-comments*" --no-pager 2>/dev/null | head -12 || true

# ---------- marcar o poder como ativo ----------
TIMERS_CSV=$(IFS=,; echo "${TIMER_NAMES[*]}")
python3 "$PLUGIN/scripts/powers.py" --file "$WS/.dgclaw/powers.json" enable instagram --timers "$TIMERS_CSV"
devolver_ao_dono "$WS/.dgclaw/powers.json"
echo "==> poder instagram ativado (abas POSTS/FOLLOWERS destravadas no painel)."
echo "    timers: $TIMERS_CSV"
