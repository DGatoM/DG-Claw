#!/usr/bin/env bash
# lib/reiniciar-admin.sh <resumo> <log> <arquivo do token>
#
# Rodado pelo systemd-run, uns segundos depois de `dgclaw atualizar` terminar (ver
# atualizar_agendar_reinicio_do_admin em lib/atualizar.sh). Como o Admin pode ser quem disparou a
# atualizacao, reiniciar o servico dele mata a sessao no meio e o dono nunca recebia o resultado.
# Este roteiro cobre isso: reinicia o Admin, espera ele responder e MANDA UMA MENSAGEM a ele
# pedindo que leia o resumo e conte o resultado ao dono.
#
# O token do Admin e lido do arquivo aqui dentro e vai ao curl por um arquivo de configuracao
# temporario (modo 600): nunca na linha de comando (o ps mostraria) nem no log.
# Variaveis opcionais: DGCLAW_ADMIN_URL (padrao http://127.0.0.1:4300), DGCLAW_ESPERA_ADMIN
# (segundos esperando o Admin responder, padrao 60).
set -uo pipefail

RESUMO="${1:-}"; LOG="${2:-}"; TOKEN_ARQ="${3:-}"
URL="${DGCLAW_ADMIN_URL:-http://127.0.0.1:4300}"
ESPERA="${DGCLAW_ESPERA_ADMIN:-60}"

if [ -n "$LOG" ] && [ -d "$(dirname "$LOG")" ]; then exec >>"$LOG" 2>&1; fi
log() { printf '[reiniciar-admin %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

if [ -z "$RESUMO" ] || [ -z "$TOKEN_ARQ" ]; then
    log "uso errado: faltam argumentos (resumo, log, arquivo do token). Nao reiniciei nada."
    exit 2
fi

if ! systemctl restart dgclaw-admin; then
    log "o 'systemctl restart dgclaw-admin' falhou. Veja: journalctl -u dgclaw-admin -n 50. O resumo da atualizacao esta em $RESUMO."
    exit 1
fi
log "Admin reiniciado; esperando ele responder em $URL/api/saude (ate ${ESPERA}s)."

voltou=0
for ((i = 0; i < ESPERA; i++)); do
    if curl -fsS --max-time 3 "$URL/api/saude" >/dev/null 2>&1; then voltou=1; break; fi
    sleep 1
done
if [ "$voltou" != 1 ]; then
    log "o Admin nao respondeu em ${ESPERA}s, entao nao consegui avisar o resultado a ele. O resumo esta em $RESUMO. Veja: journalctl -u dgclaw-admin -n 50"
    exit 1
fi

if [ ! -r "$TOKEN_ARQ" ]; then
    log "nao consegui ler o token do Admin em $TOKEN_ARQ, entao nao mandei o aviso. O resumo esta em $RESUMO."
    exit 1
fi
command -v jq >/dev/null 2>&1 || { log "falta o jq, entao nao montei o aviso. O resumo esta em $RESUMO."; exit 1; }

texto="<plataforma recado=\"atualizacao-terminou\">A atualizacao do DG Claw terminou e voce acabou de reiniciar com o codigo novo. Este e um aviso da plataforma, nao uma mensagem escrita pelo dono. Leia o resumo em $RESUMO (o log completo esta em $LOG) e conte ao dono, pelo chat e em palavras simples, o resultado: a versao de antes e a nova, onde ficou o backup, como voltar atras, e quais agentes ficaram bem e quais ficaram com problema (e o que fazer com eles). Se algum agente ficou com problema, ofereca consertar agora.</plataforma>"
corpo="$(jq -n --arg t "$texto" '{text: $t, submit: true}')"

cfg="$(mktemp)"; chmod 600 "$cfg"
trap 'rm -f "$cfg"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_ARQ")" >"$cfg"

# O runner responde 200 quando o agente recebeu o texto, 202 com data.entregaIncerta quando o texto PODE ter sido digitado e ele
# nao sabe se o agente o recebeu (um 202 sem entregaIncerta e o recado na fila). Repetir o pedido na incerteza executaria o aviso duas
# vezes, entao a entrega incerta NAO e repetida: fica registrada para o dono conferir, com o resumo preservado.
for tentativa in 1 2 3; do
    if resposta="$(printf '%s' "$corpo" | curl -sS -f --max-time 20 --config "$cfg" -X POST \
            -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}' \
            "$URL/api/agents/admin/input")"; then
        status="${resposta##*$'\n'}"
        dados="${resposta%$'\n'*}"
        if [ "$status" = 202 ] && [ "$(printf '%s' "$dados" | jq -r '.data.entregaIncerta // false' 2>/dev/null)" = true ]; then
            log "ATENCAO: a entrega do aviso ao Admin e INCERTA (o runner respondeu 202 com entregaIncerta: o texto pode ter sido digitado e nao se sabe se o Admin o recebeu). Nao repeti o pedido, para nao avisar duas vezes. Confira a conversa do Admin; se o aviso nao apareceu, peca a ele que leia o resumo em $RESUMO."
            exit 3
        fi
        if [ "$status" = 202 ]; then
            log "o aviso do resultado ficou na fila do Admin (tentativa $tentativa) e ele vai contar ao dono quando ficar livre. Resumo: $RESUMO"
        else
            log "o Admin recebeu o aviso do resultado (tentativa $tentativa) e vai contar ao dono. Resumo: $RESUMO"
        fi
        exit 0
    else
        rc=$?
        # Repetir so e seguro quando o pedido nao chegou a sair ou o runner o recusou: 6 (host nao resolvido), 7 (conexao recusada)
        # e 22 (HTTP >= 400 com -f: o runner respondeu e nao entregou). Qualquer outro codigo (28 tempo esgotado, 52 resposta vazia,
        # 56 conexao cortada...) pode ter acontecido DEPOIS do envio: repetir avisaria o Admin duas vezes.
        case "$rc" in
            6|7|22) ;;
            *)
                log "ATENCAO: o POST em $URL/api/agents/admin/input terminou com o codigo $rc do curl, depois de poder ter sido enviado, entao a entrega do aviso ao Admin e INCERTA. Nao repeti o pedido, para nao avisar duas vezes. Confira a conversa do Admin; se o aviso nao apareceu, peca a ele que leia o resumo em $RESUMO."
                exit 3 ;;
        esac
    fi
    log "o POST em $URL/api/agents/admin/input falhou (codigo $rc do curl, tentativa $tentativa de 3)."
    sleep 5
done
log "nao consegui avisar o Admin. O resumo da atualizacao esta em $RESUMO: peca a ele que o leia."
exit 1
