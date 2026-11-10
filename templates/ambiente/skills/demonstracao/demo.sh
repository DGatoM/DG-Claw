#!/usr/bin/env bash
# demo.sh: o jeito de falar com o Portão do modo demonstração (skill demonstracao).
# Lê o token em ~/.dgclaw/demo.token e o endereço em ~/.dgclaw/demo.url. Nada é enviado nem lido sem o clique da pessoa na tela:
# cada comando de pedido só cria um cartão, e o resultado sai pelos comandos estado-*.
#
#   demo.sh contato <linha> <nome>                    pede para abrir a conversa de um contato (cria um cartão de leitura)
#   demo.sh estado-contato <id>                       aguardando | liberado | recusado | expirado (liberado traz o contato e o ref)
#   demo.sh conversa <ref> [limite]                   as mensagens mais recentes de um contato liberado (limite de 1 a 200, padrão 60)
#   demo.sh enviar-whatsapp --linha L (--ref R | --telefone T) (--texto "..." | --texto-arquivo F) [--anexo CAMINHO]...
#   demo.sh enviar-email --para E --assunto A (--texto "..." | --texto-arquivo F) [--anexo CAMINHO]...
#   demo.sh estado-envio <id>                         aguardando | enviando | enviado | recusado | expirado | falhou
#
# Saídas: o JSON do Portão no stdout. Código 0 deu certo; 1 uso errado; 2 falta token ou endereço; 3 o Portão não respondeu;
# 4 o Portão recusou (o motivo sai no stderr, em português); 5 erro do lado do Portão.
set -euo pipefail
umask 077

erro() { echo "demo.sh: $*" >&2; }
die() { local c="$1"; shift; erro "$*"; exit "$c"; }

command -v jq >/dev/null || die 2 "o jq não foi encontrado neste container. Avise quem mantém a imagem do agente."
command -v curl >/dev/null || die 2 "o curl não foi encontrado neste container. Avise quem mantém a imagem do agente."

ARQ_TOKEN="${DGCLAW_DEMO_TOKEN_ARQUIVO:-$HOME/.dgclaw/demo.token}"
ARQ_URL="${DGCLAW_DEMO_URL_ARQUIVO:-$HOME/.dgclaw/demo.url}"
[ -r "$ARQ_TOKEN" ] || die 2 "não achei o token do Portão em $ARQ_TOKEN. Este agente não está no modo demonstração, ou a instalação ficou incompleta: avise o dono."
[ -r "$ARQ_URL" ] || die 2 "não achei o endereço do Portão em $ARQ_URL. Avise o dono."
TOKEN="$(tr -d '[:space:]' <"$ARQ_TOKEN")"
BASE="$(tr -d '[:space:]' <"$ARQ_URL")"
BASE="${BASE%/}"
[ -n "$TOKEN" ] || die 2 "o arquivo $ARQ_TOKEN está vazio. Avise o dono."
case "$BASE" in http://*|https://*) ;; *) die 2 "o endereço em $ARQ_URL não começa com http:// nem https://. Avise o dono." ;; esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# portao <METODO> <caminho> [arquivo-do-corpo]: faz o pedido e traduz o resultado em código de saída.
portao() {
    local metodo="$1" caminho="$2" corpo="${3:-}" status
    local args=(-sS --max-time 40 -X "$metodo" -o "$TMP/resp" -w '%{http_code}' -K "$TMP/cab" -H 'Accept: application/json')
    # O token vai por arquivo de configuração do curl, não pela linha de comando (que qualquer processo lê em /proc).
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" >"$TMP/cab"
    [ -z "$corpo" ] || args+=(-H 'Content-Type: application/json' --data-binary "@$corpo")
    if ! status="$(curl "${args[@]}" "$BASE$caminho" 2>"$TMP/curl.err")"; then
        die 3 "não consegui falar com o Portão em $BASE ($(tr '\n' ' ' <"$TMP/curl.err" | head -c 200)). Nada foi pedido. Tente de novo em instantes e, se repetir, avise o dono."
    fi
    cat "$TMP/resp"; echo
    case "$status" in
        2??) return 0 ;;
        4??) die 4 "o Portão recusou ($status): $(jq -r '.erro // "sem explicação"' "$TMP/resp" 2>/dev/null || echo "resposta que não é JSON")" ;;
        *) die 5 "o Portão falhou ($status): $(jq -r '.erro // "sem explicação"' "$TMP/resp" 2>/dev/null || echo "resposta que não é JSON")" ;;
    esac
}

id_valido() { [[ "$1" =~ ^[0-9a-fA-F-]{36}$ ]] || die 1 "\"$1\" não parece um id do Portão (36 caracteres, com hífens). Use o id que o pedido devolveu."; }

# Lê as opções dos comandos de envio e monta o corpo JSON em $TMP/corpo.json.
monta_envio() {
    local canal="$1"; shift
    local linha="" ref="" telefone="" para="" assunto="" texto="" tem_texto=0 anexos=()
    while [ $# -gt 0 ]; do
        [ $# -ge 2 ] || die 1 "falta o valor depois de $1."
        case "$1" in
            --linha) linha="$2" ;;
            --ref) ref="$2" ;;
            --telefone) telefone="$2" ;;
            --para) para="$2" ;;
            --assunto) assunto="$2" ;;
            --texto) texto="$2"; tem_texto=1 ;;
            --texto-arquivo) [ -r "$2" ] || die 1 "não consigo ler o arquivo de texto $2."; texto="$(cat "$2")"; tem_texto=1 ;;
            --anexo) anexos+=("$2") ;;
            *) die 1 "opção desconhecida: $1." ;;
        esac
        shift 2
    done
    [ "$tem_texto" = 1 ] || die 1 "falta o texto: use --texto \"...\" ou --texto-arquivo <arquivo>."
    local anexos_json="[]"
    if [ "${#anexos[@]}" -gt 0 ]; then anexos_json="$(printf '%s\n' "${anexos[@]}" | jq -R . | jq -s .)"; fi
    if [ "$canal" = whatsapp ]; then
        [ -n "$linha" ] || die 1 "falta --linha (a linha de WhatsApp, como aparece no pedido do dono)."
        { [ -n "$ref" ] || [ -n "$telefone" ]; } || die 1 "falta o destino: --ref <ref de um contato liberado> ou --telefone <número com DDI>."
        jq -n --arg linha "$linha" --arg ref "$ref" --arg tel "$telefone" --arg texto "$texto" --argjson anexos "$anexos_json" \
            '{canal:"whatsapp", linha:$linha, texto:$texto, anexos:$anexos} + (if $ref != "" then {ref:$ref} else {} end) + (if $tel != "" then {telefone:$tel} else {} end)' >"$TMP/corpo.json"
    else
        [ -n "$para" ] || die 1 "falta --para (o endereço de e-mail)."
        [ -n "$assunto" ] || die 1 "falta --assunto."
        jq -n --arg para "$para" --arg assunto "$assunto" --arg texto "$texto" --argjson anexos "$anexos_json" \
            '{canal:"email", para:$para, assunto:$assunto, texto:$texto, anexos:$anexos}' >"$TMP/corpo.json"
    fi
}

[ $# -ge 1 ] || die 1 "diga o comando: contato, estado-contato, conversa, enviar-whatsapp, enviar-email ou estado-envio. Veja o começo deste arquivo."
CMD="$1"; shift
case "$CMD" in
    contato)
        [ $# -ge 2 ] || die 1 "uso: demo.sh contato <linha> <nome>"
        jq -n --arg linha "$1" --arg nome "$2" '{linha:$linha, nome:$nome}' >"$TMP/corpo.json"
        portao POST /api/demo/v1/contato "$TMP/corpo.json"
        erro "Cartão criado. Diga ao usuário: confirme na tela. Depois acompanhe com: demo.sh estado-contato <id>"
        ;;
    estado-contato)
        [ $# -eq 1 ] || die 1 "uso: demo.sh estado-contato <id>"
        id_valido "$1"
        portao GET "/api/demo/v1/contato/$1"
        ;;
    conversa)
        if [ $# -lt 1 ] || [ $# -gt 2 ]; then die 1 "uso: demo.sh conversa <ref> [limite]"; fi
        id_valido "$1"
        portao GET "/api/demo/v1/contato/$1/conversa?limite=${2:-60}"
        ;;
    enviar-whatsapp|enviar-email)
        monta_envio "${CMD#enviar-}" "$@"
        portao POST /api/demo/v1/envio "$TMP/corpo.json"
        erro "Cartão criado. Diga ao usuário: confirme na tela. Depois acompanhe com: demo.sh estado-envio <id>. Se for recusado, não reenvie."
        ;;
    estado-envio)
        [ $# -eq 1 ] || die 1 "uso: demo.sh estado-envio <id>"
        id_valido "$1"
        portao GET "/api/demo/v1/envio/$1"
        ;;
    *) die 1 "comando desconhecido: $CMD. Use contato, estado-contato, conversa, enviar-whatsapp, enviar-email ou estado-envio." ;;
esac
