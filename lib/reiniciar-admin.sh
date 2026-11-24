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
log "Admin reiniciado; esperando ele responder em $URL/api/saude com o terminal vivo (ate ${ESPERA}s)."

# O runner abre a porta HTTP ANTES de subir o terminal: /api/saude ja responde 200, mas com agente.ptyVivo false, e nesse
# intervalo o POST em /input receberia 409 NO_PTY. Por isso a espera so termina quando a saude responde E o terminal esta vivo,
# dentro do mesmo prazo ESPERA (sem prazo novo).
command -v jq >/dev/null 2>&1 || { log "falta o jq, entao nao montei o aviso. O resumo esta em $RESUMO."; exit 1; }
voltou=0; respondeu=0
for ((i = 0; i < ESPERA; i++)); do
    if saude="$(curl -fsS --max-time 3 "$URL/api/saude" 2>/dev/null)"; then
        respondeu=1
        # So o terminal do proprio Admin conta: um ptyVivo true de sessoes[] (uma sessao paralela) nao prova que ele esta pronto.
        if printf '%s' "$saude" | jq -e '.agente.ptyVivo == true' >/dev/null 2>&1; then voltou=1; break; fi
    fi
    sleep 1
done
if [ "$voltou" != 1 ]; then
    if [ "$respondeu" = 1 ]; then
        log "o Admin respondeu em $URL/api/saude, mas o terminal dele (agente.ptyVivo) nao ficou pronto em ${ESPERA}s, entao nao consegui avisar o resultado a ele. O resumo esta em $RESUMO. Veja: journalctl -u dgclaw-admin -n 50"
    else
        log "o Admin nao respondeu em ${ESPERA}s, entao nao consegui avisar o resultado a ele. O resumo esta em $RESUMO. Veja: journalctl -u dgclaw-admin -n 50"
    fi
    exit 1
fi

if [ ! -r "$TOKEN_ARQ" ]; then
    log "nao consegui ler o token do Admin em $TOKEN_ARQ, entao nao mandei o aviso. O resumo esta em $RESUMO."
    exit 1
fi

texto="<plataforma recado=\"atualizacao-terminou\">A atualizacao do DG Claw terminou e voce acabou de reiniciar com o codigo novo. Este e um aviso da plataforma, nao uma mensagem escrita pelo dono. Leia o resumo em $RESUMO (o log completo esta em $LOG) e conte ao dono, pelo chat e em palavras simples, o resultado: a versao de antes e a nova, onde ficou o backup, como voltar atras, e quais agentes ficaram bem e quais ficaram com problema (e o que fazer com eles). Se algum agente ficou com problema, ofereca consertar agora.</plataforma>"
corpo="$(jq -n --arg t "$texto" '{text: $t, submit: true}')"

cfg="$(mktemp)"; chmod 600 "$cfg"
trap 'rm -f "$cfg"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_ARQ")" >"$cfg"

# O runner responde 200 quando o agente recebeu o texto, 202 com data.entregaIncerta quando o texto PODE ter sido digitado e ele
# nao sabe se o agente o recebeu (um 202 sem entregaIncerta e o recado na fila). Repetir o pedido na incerteza executaria o aviso duas
# vezes, entao a entrega incerta NAO e repetida: fica registrada para o dono conferir, com o resumo preservado.
# O curl roda SEM -f: com ele, qualquer HTTP >= 400 virava o codigo 22 e era repetido, inclusive um 504 de gateway, que pode vir
# DEPOIS de o pedido ter sido encaminhado ao runner. Aqui o status e o `code` do JSON de erro decidem:
#   - repete so quando status e code garantem que nada foi escrito no terminal: 409 NAO_ENTROU, ENVIO_PENDENTE, CAIXA_COM_RASCUNHO,
#     TELA_BLOQUEADA, ENTRADA_RECUSADA ou NO_PTY (o runner recusa antes de digitar, sem terminal vivo); 500 NAO_ACORDOU (a sessao
#     nao acordou e o texto nao foi guardado em fila nenhuma); 429 ENVIOS_DEMAIS; 507 FILA_NAO_GRAVADA;
#   - qualquer outro 4xx (401, 403, 400...) e recusa antes do envio, que repetir nao conserta: falha com exit 1, sem repetir;
#   - qualquer 5xx (fora o 507 acima) ou status inesperado: a entrega e incerta (exit 3), sem repetir.
# Do curl: 6 (host nao resolvido) e 7 (conexao recusada) repetem; qualquer outro codigo pode ter acontecido DEPOIS do envio.
# O log diz o status e o code, nunca o corpo inteiro da resposta.
for tentativa in 1 2 3; do
    resposta="$(printf '%s' "$corpo" | curl -sS --max-time 20 --config "$cfg" -X POST \
            -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}' \
            "$URL/api/agents/admin/input")"
    rc=$?
    if [ "$rc" -eq 0 ]; then
        status="${resposta##*$'\n'}"
        # O status vai para o log: so entra se for mesmo 3 digitos.
        [[ "$status" =~ ^[0-9]{3}$ ]] || status="vazio"
        dados="${resposta%$'\n'*}"
        if [ "$status" = 202 ] && [ "$(printf '%s' "$dados" | jq -r '.data.entregaIncerta // false' 2>/dev/null)" = true ]; then
            log "ATENCAO: a entrega do aviso ao Admin e INCERTA (o runner respondeu 202 com entregaIncerta: o texto pode ter sido digitado e nao se sabe se o Admin o recebeu). Nao repeti o pedido, para nao avisar duas vezes. Confira a conversa do Admin; se o aviso nao apareceu, peca a ele que leia o resumo em $RESUMO."
            exit 3
        fi
        # 200 so conta com JSON valido, success true e data.enviado true (o que o runner devolve quando o agente recebeu o texto); 202
        # so conta como fila com JSON valido, success true e data.enfileirado true. Qualquer outra combinacao de 200 ou 202 (corpo
        # vazio, JSON invalido, sem a confirmacao) nao prova nada: a entrega e incerta e nao se repete.
        if [ "$status" = 200 ] || [ "$status" = 202 ]; then
            campo=enviado
            [ "$status" = 202 ] && campo=enfileirado
            if [ "$(printf '%s' "$dados" | jq -r --arg c "$campo" 'if .success == true and .data[$c] == true then "sim" else "nao" end' 2>/dev/null)" = sim ]; then
                if [ "$status" = 200 ]; then
                    log "o Admin recebeu o aviso do resultado (tentativa $tentativa) e vai contar ao dono. Resumo: $RESUMO"
                else
                    log "o aviso do resultado ficou na fila do Admin (tentativa $tentativa) e ele vai contar ao dono quando ficar livre. Resumo: $RESUMO"
                fi
                exit 0
            fi
            log "ATENCAO: o runner respondeu HTTP $status sem a confirmacao esperada (o corpo veio vazio, invalido ou sem data.$campo), entao a entrega do aviso ao Admin e INCERTA. Nao repeti o pedido, para nao avisar duas vezes. Confira a conversa do Admin; se o aviso nao apareceu, peca a ele que leia o resumo em $RESUMO."
            exit 3
        fi
        codigo="$(printf '%s' "$dados" | jq -r '.code // empty | tostring | .[0:40]' 2>/dev/null)"
        # O code vem do corpo da resposta e vai para o log: so entra se for um dos que o runner devolve em POST /input
        # (runner/src/servidor.ts); qualquer outro valor (inclusive com quebra de linha ou texto forjado) vira CODIGO_DESCONHECIDO.
        case "$codigo" in
            "" | NAO_ENTROU | ENVIO_PENDENTE | CAIXA_COM_RASCUNHO | TELA_BLOQUEADA | ENTRADA_RECUSADA | ENVIOS_DEMAIS | FILA_NAO_GRAVADA | TEXTO_GRANDE_DEMAIS \
                | SEM_LOGIN | SEM_CHAVE | RESTRICAO_CONTA | LOGIN_EXPIRADO | NO_PTY | NAO_ACORDOU | SEM_CAPACIDADE | ESC_SO_IMEDIATO \
                | RUNNER_SEM_TOKEN | SEM_TOKEN | TOKEN_ERRADO | RESPOSTA_EM_ANDAMENTO | MUITO_RAPIDO | ERRO_INTERNO | AGENTE_DE_OUTRO_RUNNER | RUNNER_DE_UM_AGENTE | ROTA_INEXISTENTE) ;;
            *) codigo="CODIGO_DESCONHECIDO" ;;
        esac
        repetir=0
        case "$status:$codigo" in
            409:NAO_ENTROU|409:ENVIO_PENDENTE|409:CAIXA_COM_RASCUNHO|409:TELA_BLOQUEADA|409:ENTRADA_RECUSADA|409:NO_PTY|500:NAO_ACORDOU|429:ENVIOS_DEMAIS|507:FILA_NAO_GRAVADA)
                repetir=1 ;;
        esac
        if [ "$repetir" = 1 ]; then
            log "o runner recusou o aviso sem escrever nada (HTTP $status, code $codigo, tentativa $tentativa de 3)."
        else
            case "$status" in
                4[0-9][0-9])
                    log "o runner recusou o aviso ao Admin antes de enviar (HTTP $status, code ${codigo:-sem code}). Nao repeti o pedido: repetir nao resolve. O resumo da atualizacao esta em $RESUMO: peca ao Admin que o leia."
                    exit 1 ;;
                *)
                    log "ATENCAO: o POST em $URL/api/agents/admin/input respondeu HTTP ${status:-vazio} (code ${codigo:-sem code}) depois de poder ter sido enviado, entao a entrega do aviso ao Admin e INCERTA. Nao repeti o pedido, para nao avisar duas vezes. Confira a conversa do Admin; se o aviso nao apareceu, peca a ele que leia o resumo em $RESUMO."
                    exit 3 ;;
            esac
        fi
    else
        case "$rc" in
            6|7) ;;
            *)
                log "ATENCAO: o POST em $URL/api/agents/admin/input terminou com o codigo $rc do curl, depois de poder ter sido enviado, entao a entrega do aviso ao Admin e INCERTA. Nao repeti o pedido, para nao avisar duas vezes. Confira a conversa do Admin; se o aviso nao apareceu, peca a ele que leia o resumo em $RESUMO."
                exit 3 ;;
        esac
        log "o POST em $URL/api/agents/admin/input falhou (codigo $rc do curl, tentativa $tentativa de 3)."
    fi
    sleep 5
done
log "nao consegui avisar o Admin. O resumo da atualizacao esta em $RESUMO: peca a ele que o leia."
exit 1
