#!/bin/bash
# heartbeat.sh — Batimento (a cada 30min) do agente. Smart-check barato.
#
# Sempre (barato, sem Claude): roda os ganchos das extensoes instaladas e refresca a secao
# "## Agora" da working-memory, pra que a proxima sessao chegue sabendo em que pe estao as
# coisas.
#
# ONDA A (sessao viva): quando o smart-check decide que HA motivo pra agir (ver abaixo), o
# poke de proatividade e INJETADO na sessao --channels viva do agente (assinatura flat) — NAO
# mais via `claude -p` (que queima credito de API). A propria persona decide se avisa o dono e
# manda a mensagem pela tool de canal dela. Se a sessao nao estiver no ar (dono desligou o bot
# 24/7 pra poupar), o heartbeat registra "erro" no Pulso (com o que fazer) e sai 2, a CADA batimento
# (checagem logo depois do passo 1, antes do "nada a fazer"). Sessao ocupada: "ok", o poke fica
# pro proximo batimento.
#
# So injeta SE houver motivo, e a decisao e do script, nao do modelo:
#   - a secao "Quero Falar com o <dono> Sobre" tem linha real (nao comentario/placeholder). Linha
#     com a marca "[a partir de AAAA-MM-DD]" e data futura fica quieta ate la (data malformada conta);
#   - e o conteudo dessa secao (sha256) e diferente do que ja foi levado ao agente no ultimo poke,
#     ou ja passaram DGCLAW_HEARTBEAT_REPETIR_H horas (padrao 24) desde ele.
# O estado (hash e epoch do ultimo poke) fica em .dgclaw/state/heartbeat.state e so e gravado
# depois que a injecao volta 0. Sem isso, uma linha que o agente decide nao levar ao dono (e nao
# apaga) acordava o modelo a cada poucos batimentos, pra sempre, reescrevendo o cache inteiro.
# DGCLAW_HEARTBEAT_FORCE=1 pula o filtro do hash (debug/teste).
#
# Uso:  bash heartbeat.sh <.dgclaw/config.sh>

set -uo pipefail

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"

export PATH="${BUN_BIN_DIR:-$HOME/.bun/bin}:$HOME/.local/bin:$PATH"
export DGCLAW_WORKSPACE DGCLAW_PERSONA_DIR="${DGCLAW_PERSONA_DIR:-$DGCLAW_WORKSPACE/persona}"
export DGCLAW_OWNER DGCLAW_NAME
SLUG="$DGCLAW_SLUG"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$DGCLAW_WORKSPACE/.dgclaw/plugin}"
LOG="$DGCLAW_WORKSPACE/.dgclaw/logs/heartbeat.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null \
    || echo "aviso: nao consegui criar a pasta do log $(dirname "$LOG"); o batimento segue sem log. Confira a permissao do workspace." >&2
WM="$DGCLAW_WORKSPACE/working-memory.md"
cd "$DGCLAW_WORKSPACE" || exit 1

# Pulso: registra ok/erro no ledger (rc final via trap EXIT). Degrada gracioso se a lib
# nao existir. Sessao morta registra "erro" explicito e sai 2 (antes saia 0 e parecia "ok").
# shellcheck disable=SC1091
# lib ausente em instalacao antiga: o batimento roda igual, so sem registrar no ledger
source "$PLUGIN/scripts/_lib/pulso-lib.sh" 2>/dev/null && pulso_auto heartbeat

# --- 1. sempre: ganchos das extensoes + refresh do "Agora" (barato, sem Claude) ---
# Cada extensao instalada pode ter um hooks/heartbeat.sh (o DG Alive usa pra envelhecer as
# emocoes). Falha de extensao vai pro log e nao interrompe o batimento do nucleo.
EXT_DIR="$DGCLAW_WORKSPACE/.dgclaw/ext"
if [ -d "$EXT_DIR" ]; then
    while IFS= read -r ext; do
        hook="$ext/hooks/heartbeat.sh"
        [ -f "$hook" ] || continue
        if ! DGCLAW_WORKSPACE="$DGCLAW_WORKSPACE" DGCLAW_CONFIG="$CONFIG" \
             timeout 20 bash "$hook" >>"$LOG" 2>&1; then
            echo "$(date '+%F %T') heartbeat: a extensao '$(basename "$ext")' falhou no gancho heartbeat.sh (veja as linhas acima). O batimento seguiu sem ela." >> "$LOG"
        fi
    # a pasta pode sumir entre o teste -d e o find; sem extensoes, nao ha gancho a rodar
    done < <(find "$EXT_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
fi
if ! AGORA_SAIDA="$(python3 "$PLUGIN/scripts/build-working-memory.py" --agora-only 2>&1)"; then
    echo "$(date '+%F %T') heartbeat: build-working-memory.py --agora-only falhou; o 'Agora' de $WM pode estar velho. Ultimas linhas: $(printf '%s' "$AGORA_SAIDA" | tail -3 | tr '\n' ' ')" >> "$LOG"
fi

# --- 1.5 a sessao do agente esta no ar? (barato) ---
# Antes esta checagem ficava depois do "nada a fazer" e do sorteio, e na maioria dos batimentos
# o script saia 0 sem nunca olhar a sessao: agente desligado aparecia como "ok" verde no Pulso.
# shellcheck disable=SC1091
source "$PLUGIN/scripts/_lib/inject.sh"
if ! is_session_alive "$SLUG"; then
    HORA="$(date '+%H:%M')"
    MSG="a sessão do agente não estava no ar às ${HORA}, então o batimento não pôde conferir nem avisar nada. O que fazer: ligar o agente (no painel, ou com 'dgclaw agente iniciar ${SLUG}' no servidor) e conferir de novo no Pulso"
    echo "[$(date '+%F %T')] heartbeat: FALHA, ${MSG}" >> "$LOG"
    declare -F pulso >/dev/null && pulso erro "$MSG"
    exit 2
fi

# --- 2. tem algo novo pra falar com o dono? ---
HAS_NEWS=0
BLOCK=""
HOJE="$(date +%F)"
if [ -f "$WM" ]; then
    # Tira comentario, linha vazia e placeholder "- (...)". Depois tira as linhas adiadas: marca
    # "[a partir de AAAA-MM-DD]" com data futura. Data de hoje, passada ou malformada continua contando.
    BLOCK=$(awk '/^## Quero Falar com o/{f=1;next} /^## /{f=0} f' "$WM" | grep -vE '^\s*(<!--|$)' | grep -vE '^\s*-\s*\(' \
        | awk -v hoje="$HOJE" '
            # data AAAA-MM-DD que existe no calendario (mes 13 ou 31/04 nao contam como adiamento)
            function data_ok(d,   a, m, x, max) {
                if (d !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) return 0
                a = substr(d, 1, 4) + 0; m = substr(d, 6, 2) + 0; x = substr(d, 9, 2) + 0
                if (m < 1 || m > 12 || x < 1) return 0
                max = 31
                if (m == 4 || m == 6 || m == 9 || m == 11) max = 30
                if (m == 2) max = ((a % 4 == 0 && a % 100 != 0) || a % 400 == 0) ? 29 : 28
                return x <= max
            }
            {
            # vale a ULTIMA marca da linha: quem adia de novo pode acrescentar outra no fim
            l = tolower($0); d = ""
            while (match(l, /\[a partir de [^]]*\]/)) {
                d = substr(l, RSTART + 13, RLENGTH - 14); gsub(/^ +| +$/, "", d)
                l = substr(l, RSTART + RLENGTH)
            }
            if (d != "" && data_ok(d) && d > hoje) next
            print }')
    [ -n "$BLOCK" ] && HAS_NEWS=1
fi

if [ "$HAS_NEWS" = "0" ]; then
    echo "[$(date '+%F %T')] heartbeat: nada a fazer" >> "$LOG"
    exit 0
fi

# --- 3. esse mesmo conteudo ja foi levado ao agente? ---
STATE_DIR="$DGCLAW_WORKSPACE/.dgclaw/state"
STATE="$STATE_DIR/heartbeat.state"
REPETIR_H="${DGCLAW_HEARTBEAT_REPETIR_H:-24}"
if ! [[ "$REPETIR_H" =~ ^[1-9][0-9]*$ ]]; then
    echo "[$(date '+%F %T')] heartbeat: aviso, DGCLAW_HEARTBEAT_REPETIR_H='$REPETIR_H' nao e um numero inteiro positivo de horas; usando 24" >> "$LOG"
    REPETIR_H=24
fi
HASH="$(printf '%s\n' "$BLOCK" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sha256sum | cut -d' ' -f1)"
AGORA_EPOCH="$(date +%s)"

if [ "${DGCLAW_HEARTBEAT_FORCE:-0}" = "1" ]; then
    echo "[$(date '+%F %T')] heartbeat: DGCLAW_HEARTBEAT_FORCE=1, pulando o filtro do conteudo ja levado" >> "$LOG"
elif [ -f "$STATE" ]; then
    read -r OLD_HASH OLD_EPOCH _ < "$STATE" 2>/dev/null
    if [[ "${OLD_HASH:-}" =~ ^[0-9a-f]{64}$ ]] && [[ "${OLD_EPOCH:-}" =~ ^[0-9]+$ ]]; then
        if [ "$OLD_HASH" = "$HASH" ] && [ $(( AGORA_EPOCH - OLD_EPOCH )) -lt $(( REPETIR_H * 3600 )) ]; then
            echo "[$(date '+%F %T')] heartbeat: mesmo assunto ja levado ao agente em $(date -d "@$OLD_EPOCH" '+%F %T'); so acordo de novo se o conteudo mudar ou depois de ${REPETIR_H}h" >> "$LOG"
            exit 0
        fi
    else
        echo "[$(date '+%F %T')] heartbeat: o arquivo de estado $STATE esta ilegivel ou fora do formato (esperado: hash e epoch); tratando como sem poke anterior. Ele e regravado depois do proximo poke" >> "$LOG"
    fi
fi

# --- 4. ha motivo: injeta o poke de proatividade na sessao viva (fire-and-forget) ---

NAME="${DGCLAW_NAME:-a assistente}"
PROMPT="Voce e ${NAME}, num batimento interno (heartbeat). NAO e o dono falando com voce.
Olhe a working-memory.md, em especial a secao 'Quero Falar com o ${DGCLAW_OWNER:-dono} Sobre'.
Se houver algo REALMENTE digno de avisar o ${DGCLAW_OWNER:-dono} agora (um achado, um recado seu,
algo que nao pode esperar), mande a mensagem curta e natural pra ele pelo seu canal (texto corrido,
sem markdown, com no maximo 1-2 emojis) e remova a linha correspondente da working-memory.
Se NAO houver nada que justifique interromper, nao mande nada.
Ao terminar, a linha NAO pode ficar igual, senao o batimento te acorda de novo pelo mesmo assunto:
(a) se voce avisou o ${DGCLAW_OWNER:-dono} ou a linha nao vale mais, remova a linha;
(b) se prefere falar depois, mantenha a linha com UMA marca [a partir de AAAA-MM-DD] no fim
(troque a anterior, se ja houver), com a data em que quer ser lembrado. Ate la o batimento deixa essa linha quieta."

echo "[$(date '+%F %T')] heartbeat: injetando poke (conteudo novo ou prazo vencido) na sessao viva de ${SLUG}" >> "$LOG"
inject_session "$SLUG" heartbeat <<< "$PROMPT" >> "$LOG" 2>&1
RC=$?
case "$RC" in
    0)
        echo "[$(date '+%F %T')] heartbeat: poke injetado (rc=0)" >> "$LOG"
        # So agora o assunto conta como levado; rc 75 ou falha deixam o estado como estava.
        if mkdir -p "$STATE_DIR" && printf '%s %s\n' "$HASH" "$AGORA_EPOCH" > "$STATE.tmp.$$" && mv "$STATE.tmp.$$" "$STATE"; then
            :
        else
            rm -f "$STATE.tmp.$$"
            echo "[$(date '+%F %T')] heartbeat: aviso, nao consegui gravar $STATE (confira a permissao da pasta); o proximo batimento vai injetar de novo o mesmo assunto" >> "$LOG"
        fi
        ;;
    2)
        # A sessao caiu entre a checagem do passo 1.5 e a injecao: mesmo tratamento de morta.
        MSG="a sessão do agente caiu às $(date '+%H:%M') na hora de injetar o batimento. O que fazer: ligar o agente e conferir de novo no Pulso"
        echo "[$(date '+%F %T')] heartbeat: FALHA, ${MSG}" >> "$LOG"
        declare -F pulso >/dev/null && pulso erro "$MSG"
        exit 2
        ;;
    75)
        echo "[$(date '+%F %T')] heartbeat: sessao ocupada (turno em voo), o poke fica para o proximo batimento" >> "$LOG"
        declare -F pulso >/dev/null && pulso ok "sessão ocupada, o poke fica para o próximo batimento"
        exit 0
        ;;
    *) echo "[$(date '+%F %T')] heartbeat: FALHA ao injetar (rc=$RC)" >> "$LOG" ;;
esac

# rc 1/3/4 (falha REAL: lock timeout, PermissionError, erro de injecao) -> propaga como erro,
# pra o systemd/admin enxergar a colisao/deadlock em vez de falhar em silencio.
exit "$RC"
