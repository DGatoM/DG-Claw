#!/bin/bash
# install-timers.sh — Cria os timers systemd que mantem o agente vivo e em dia.
#
# Os crons NAO chamam mais `claude -p` (que queima credito de
# API). reflection/audit/heartbeat fazem prep deterministico e INJETAM um poke na sessao
# --channels viva do agente (a mesma que serve o bot Telegram, subida pelo dgclaw-<slug>.service).
# A persona executa na assinatura flat do dono. build-wm continua python puro (sem Claude).
#
# Timers (rodam como root, igual ao servico principal do DG Claw):
#   dgclaw-<slug>-reflection  23:30  reflexao noturna  -> injeta poke na sessao viva
#   dgclaw-<slug>-audit       23:50  auditoria          -> checks deterministicos + poke semantico
#   dgclaw-<slug>-build-wm     7:00  rebuild da working-memory (python puro, sem Claude)
#   dgclaw-<slug>-heartbeat   30min  smart-check (decay) -> injeta poke se houver motivo
#   dgclaw-<slug>-conversas-fts 15min indice da busca em conversas (python puro, sem Claude)
#   dgclaw-<slug>-memory-reindex 4:20 indice da memoria semantica (modelo local, sem Claude)
#
# A LISTA de timers e uma ARRAY EXTENSIVEL (TIMERS[]) — ondas futuras (pulso/watchdog/etc)
# acrescentam uma linha sem reescrever a logica de geracao.
#
# Notas de integracao:
#   - root + IS_SANDBOX=1: vem do config.sh do DG Claw (herdado pelo config.sh do Alive).
#   - SEM PTY: estes sao oneshot e NAO chamam claude diretamente (injetam na sessao viva, que
#     ja roda sob `script`/PTY pelo dgclaw-<slug>.service). So o canal precisa de PTY.
#   - CLAUDE_CONFIG_DIR: o config.sh do DG Claw ja faz `unset` -> usa o ~/.claude logado.
#   - Paths estaveis: apontam pra $WS/.dgclaw/plugin/scripts (a pasta do plugin instalado some).
#   - TZ=America/Sao_Paulo no .service: senao OnCalendar usa UTC e os horarios saem errados.
#
# Uso:  sudo bash install-timers.sh <.dgclaw/config.sh> [--tz America/Sao_Paulo]

set -euo pipefail

CONFIG="${1:?Uso: install-timers.sh <.dgclaw/config.sh>}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
TZ_VAL="America/Sao_Paulo"
[ "${2:-}" = "--tz" ] && TZ_VAL="${3:?--tz precisa de valor}"

# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
SLUG="$DGCLAW_SLUG"
WS="$DGCLAW_WORKSPACE"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$WS/.dgclaw/plugin}"
ABS_CONFIG="$(readlink -f "$CONFIG")"

mkdir -p "$WS/.dgclaw/logs"

# ─── ARRAY EXTENSIVEL de timers ───────────────────────────────────────────────
# Cada linha:  "name|desc|script|oncalendar|onactivesec"
#   name         sufixo da unit (dgclaw-<slug>-<name>)
#   desc         descricao humana
#   script       basename em $PLUGIN/scripts (recebe o config.sh como arg)
#   oncalendar   valor de OnCalendar (vazio se for intervalo)
#   onactivesec  valor de OnUnitActiveSec p/ intervalos (vazio se for OnCalendar)
# Ondas futuras: so acrescentar uma linha aqui (ex: pulso, channel-watchdog).
TIMERS=(
    "reflection|reflexao noturna|reflection.sh|*-*-* 23:30:00|"
    "audit|auditoria da reflexao|audit.sh|*-*-* 23:50:00|"
    "build-wm|rebuild da working-memory|build-wm.sh|*-*-* 07:00:00|"
    "heartbeat|batimento|heartbeat.sh||30min"
    # pulso-report: pulso do dia pro dono (3x/dia, 13:00/19:00/23:58). 3 entradas em vez de
    # 1 OnCalendar multiplo porque a array carrega 1 calendario por linha (23:58 nao casa com
    # a forma 13,19:00:00). Mesma script, 3 horarios — a vida reporta de manha/tarde/fim do dia.
    "pulso-report-1|pulso do dia (13h)|pulso-report.sh|*-*-* 13:00:00|"
    "pulso-report-2|pulso do dia (19h)|pulso-report.sh|*-*-* 19:00:00|"
    "pulso-report-3|pulso do dia (23h58)|pulso-report.sh|*-*-* 23:58:00|"
    # cron-audit: auditoria noturna (23:55) dos crons/timers auto-criados (descoberta dinamica).
    "cron-audit|auditoria de crons/timers|cron-audit.sh|*-*-* 23:55:00|"
    # channels-tokens-logger: varre o transcript da sessao viva e grava custo no *-tokens.jsonl
    # (a fonte que o painel aba CUSTOS le). Frequente pra manter o overview do mes atualizado.
    "channels-tokens-logger|log de tokens da sessao viva|channels-tokens-logger.py||5min"
    # cost-alerts: thresholds de orcamento mensal (50/75/90/100%) + execucao cara. De hora em hora.
    "cost-alerts|alertas de orcamento|cost-alerts.sh||1h"
    # poke-verify: confere o RECIBO dos pokes verificaveis (reflection etc) — re-injeta se faltar
    # e alerta o dono se esgotar. Deterministico, ZERO token LLM (so le arquivos). A cada 15min;
    # no-op rapido quando nao ha pendentes. Ver docs/POKES.md.
    "poke-verify|verificador de recibo de pokes|poke-verify.py||15min"
    # conversas-fts: indice local (SQLite FTS5) da busca em conversas antigas e na memoria.
    # Incremental e sem chave: e o que faz o "lembra quando..." funcionar de fabrica. Ver
    # scripts/memory_index/conversas_fts.py. O build-wm das 7h tambem reindexa (rede de
    # seguranca), entao um agente sem este timer fica com o indice de no maximo um dia atras.
    "conversas-fts|indice da busca em conversas|conversas-fts.sh||15min"
    # memory-reindex: indice da memoria semantica (o "aquilo que ele falou em agosto" com
    # outras palavras). Incremental, nice/ionice, de madrugada pra nao disputar a CPU da
    # KVM 1 com a conversa. Sem modelo local e sem Gemini sai 0 e so registra que esta
    # desligada. Ver docs/MEMORIA-SEMANTICA.md.
    "memory-reindex|indice da memoria semantica|memory-reindex.sh|*-*-* 04:20:00|"
)

# ─── MODULO 4: timers de AUTO-RECOVERY (opt-in) ───────────────────────────────
# watchdog (5min): vigia a SESSAO --channels VIVA em si (o "corpo" da persona). Se ela morre
#   com o servico ainda "active" (TUI travada), reinicia dgclaw-<slug>.service com backoff
#   exponencial e avisa o dono. Cobre o buraco que o channel-watchdog (so canal/MCP) nao pega.
# auto-compact (30min): quando o transcript da sessao viva fica grande, INJETA um poke pedindo
#   pra propria persona salvar memoria + rodar /compact (assinatura flat, sem claude -p).
#
# Ambos sao OPT-IN via DGCLAW_AUTO_RECOVERY. Default ON (assinatura flat 24/7 quer a vida
# auto-recuperando), mas o wizard de instalacao PERGUNTA e grava a escolha no config. Com a flag = off, os
# scripts viram no-op puro (so observam/logam) — entao instalar os timers sempre e seguro;
# quem decide AGIR ou nao e o env. So evitamos criar os timers se o dono recusou explicitamente.
if [ "${DGCLAW_AUTO_RECOVERY:-on}" != "off" ]; then
    # Canonico = .py (tem cap anti-storm + backoff + respeita service DISABLED no watchdog;
    # cooldown via state file + atomicidade no auto-compact). Ambos honram DGCLAW_AUTO_RECOVERY.
    # Os .sh viraram wrappers finos pros .py (compat), mas o timer roda direto o .py.
    TIMERS+=(
        "watchdog|auto-recovery da sessao viva|watchdog.py||5min"
        "auto-compact|auto-compactacao da sessao viva|auto-compact.py||30min"
    )
    echo "==> auto-recovery LIGADO (DGCLAW_AUTO_RECOVERY=${DGCLAW_AUTO_RECOVERY:-on}): incluindo timers watchdog (5min) + auto-compact (30min)"
else
    echo "==> auto-recovery DESLIGADO (DGCLAW_AUTO_RECOVERY=off): NAO instalo watchdog/auto-compact (da pra religar depois pelo /dgclaw:setup)"
fi

# Helper: gera um par service(oneshot)+timer
make_unit() {
    local name="$1" desc="$2" exec="$3" cal="$4" active="$5"
    cat > "/etc/systemd/system/dgclaw-${SLUG}-${name}.service" <<EOF
[Unit]
Description=DG Claw ${desc}: ${SLUG}

[Service]
Type=oneshot
# Nasce como root; o vida_script do bin/dgclaw troca para User=agente/HOME=/home/agente na criacao do agente na v1.
User=root
Environment=HOME=/root
Environment=IS_SANDBOX=1
Environment=TZ=${TZ_VAL}
WorkingDirectory=${WS}
ExecStart=${exec}
EOF

    {
        echo "[Unit]"
        echo "Description=DG Claw ${desc} (timer): ${SLUG}"
        echo
        echo "[Timer]"
        [ -n "$cal" ]    && echo "OnCalendar=${cal}"
        [ -n "$active" ] && echo "OnUnitActiveSec=${active}" && echo "OnBootSec=5min"
        echo "Persistent=true"
        echo
        echo "[Install]"
        echo "WantedBy=timers.target"
    } > "/etc/systemd/system/dgclaw-${SLUG}-${name}.timer"
}

# ─── gera todos os timers a partir da array ───────────────────────────────────
# Por extensao escolhemos o "runner":
#   *.sh  -> /bin/bash <script> <config>   (o proprio script sourcia o config)
#   *.py  -> /bin/bash -c 'source <config>; exec python3 <script>'  (Python le env;
#            quem exporta DGCLAW_* e o config, entao sourciamos antes de exec)
NAMES=()
for row in "${TIMERS[@]}"; do
    IFS='|' read -r name desc script cal active <<< "$row"
    case "$script" in
        *.py)
            exec_cmd="/bin/bash -c 'set -a; source \"${ABS_CONFIG}\"; set +a; exec python3 \"${PLUGIN}/scripts/${script}\" \"${ABS_CONFIG}\"'"
            ;;
        *)
            exec_cmd="/bin/bash ${PLUGIN}/scripts/${script} ${ABS_CONFIG}"
            ;;
    esac
    make_unit "$name" "$desc" "$exec_cmd" "$cal" "$active"
    NAMES+=("$name")
done

systemctl daemon-reload
for t in "${NAMES[@]}"; do
    systemctl enable --now "dgclaw-${SLUG}-${t}.timer"
done

echo "==> timers de vida instalados e ativos:"
systemctl list-timers "dgclaw-${SLUG}-*" --no-pager 2>/dev/null | head -10 || true

# Desativa a consolidacao simples do DG Claw, se existir (a reflexao do Alive ja consolida).
if systemctl list-unit-files "dgclaw-${SLUG}-consolidate.timer" >/dev/null 2>&1; then
    if systemctl is-enabled --quiet "dgclaw-${SLUG}-consolidate.timer" 2>/dev/null; then
        systemctl disable --now "dgclaw-${SLUG}-consolidate.timer" 2>/dev/null || true
        echo "==> consolidacao simples do DG Claw (dgclaw-${SLUG}-consolidate.timer) desativada"
        echo "    (a reflexao noturna do Alive assume a consolidacao, de forma mais rica)"
    fi
fi
