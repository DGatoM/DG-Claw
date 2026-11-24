#!/usr/bin/env bash
# smoke-entrega.sh: confere o basico de uma VPS de cliente antes da entrega. Roda no servidor, como root.
#
#   sudo bash /opt/dgclaw/app/scripts/smoke-entrega.sh
#
# So faz leituras simples, de saida curta, que o agente nao controla: a versao instalada, a rota /api/saude do
# painel, o estado das unidades do host e, para cada agente do registro, podman container exists e podman inspect
# (estado e limite de memoria). Nada roda dentro do container e nada do que o agente grava e interpretado.
# O resto do checklist fica a mao (docs/ENTREGA-CLIENTE.md).
# Saida: 0 sem FALHA (pode haver AVISO e INCONCLUSIVO), 1 com ao menos uma FALHA, 2 uso errado ou
# ferramenta ausente. INCONCLUSIVO quer dizer que nao deu para medir: nao e OK nem FALHA.
#
# Env (usadas pelos testes): DGCLAW_RAIZ (raiz falsa).
set -uo pipefail

R="${DGCLAW_RAIZ:-}"

USO='uso: sudo bash /opt/dgclaw/app/scripts/smoke-entrega.sh'
if [ "$#" -gt 0 ]; then
    case "$1" in
        --ajuda|-h) echo "$USO"; exit 0 ;;
        *) echo "este script nao recebe argumento. $USO" >&2; exit 2 ;;
    esac
fi

for f in jq podman curl systemctl; do
    command -v "$f" >/dev/null 2>&1 || { echo "falta o programa '$f' no PATH. Rode o smoke no servidor do DG Claw, onde ele ja vem instalado." >&2; exit 2; }
done

FALHAS=0
PAINEL_AGENTES=""
AVISOS=0
INCONCLUSIVOS=0
ok()    { printf '  OK     [%s] %s\n' "$1" "$2"; }
aviso() { AVISOS=$((AVISOS + 1)); printf '  AVISO  [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
falha() { FALHAS=$((FALHAS + 1)); printf '  FALHA  [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
inconclusivo() { INCONCLUSIVOS=$((INCONCLUSIVOS + 1)); printf '  INCONCLUSIVO [%s] %s\n         O que fazer: %s\n' "$1" "$2" "$3"; }
# so_digitos <texto> <maximo de caracteres>: verdadeiro se for um numero curto.
so_digitos() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le "$2" ]; }

printf 'Smoke de entrega\n\n'

# --- 1. Versao instalada ---------------------------------------------------------------------------
printf '1. Versao instalada\n'
VERSAO="$(head -c 64 "$R/opt/dgclaw/app/VERSION" 2>/dev/null | head -n 1)"
if [ -n "$VERSAO" ] && [[ "$VERSAO" =~ ^[0-9A-Za-z._+-]+$ ]]; then
    ok 1 "DG Claw $VERSAO"
else
    inconclusivo 1 "nao consegui ler a versao em /opt/dgclaw/app/VERSION (arquivo ausente, ilegivel ou fora do formato)." "confira a instalacao com: sudo dgclaw status"
fi

# --- 2. Painel -------------------------------------------------------------------------------------
printf '\n2. Painel\n'
PORTA="$(sed -n 's/^DGCLAW_PORTA_PAINEL=//p' "$R/etc/dgclaw/dgclaw.env" 2>/dev/null | head -n 1)"
[ -n "$PORTA" ] || PORTA=8300
if ! so_digitos "$PORTA" 5 || [ "$PORTA" -lt 1 ] || [ "$PORTA" -gt 65535 ]; then
    inconclusivo 2 "a linha DGCLAW_PORTA_PAINEL do /etc/dgclaw/dgclaw.env nao e uma porta valida, entao nao sei onde o painel escuta." "confira essa linha com a equipe e rode o smoke de novo"
else
    # So a rota /api/saude do DG Claw conta (resposta curta, sem seguir redirecionamento): outro servico na porta nao passa.
    saude="$(curl -q -s --noproxy '*' --fail --max-time 10 "http://127.0.0.1:$PORTA/api/saude" 2>/dev/null | head -c 4096; printf 'rc=%s' "${PIPESTATUS[0]}")"
    curl_rc="${saude##*rc=}"; saude="${saude%rc=*}"
    if [ "$curl_rc" = 0 ] && printf '%s' "$saude" | jq -e 'type == "object" and .ok == true and has("registro_ok")' >/dev/null 2>&1; then
        if ! printf '%s' "$saude" | jq -e '.registro_ok == true' >/dev/null 2>&1; then
            falha 2 "o painel respondeu na porta $PORTA, mas informou que nao consegue ler o registro de agentes (registro_ok diferente de true)." "veja o servico com: sudo systemctl status dgclaw-web"
        elif printf '%s' "$saude" | jq -e '.login_trancado == true' >/dev/null 2>&1; then
            falha 2 "o painel respondeu na porta $PORTA, mas o login esta trancado: falta o usuario, a senha ainda nao foi cadastrada ou o hash nao vale." "conclua o primeiro acesso (sudo dgclaw primeiro-acesso) ou corrija a credencial do painel com a equipe"
        elif ! printf '%s' "$saude" | jq -e '.login_trancado == false' >/dev/null 2>&1; then
            inconclusivo 2 "o painel respondeu na porta $PORTA, mas sem o campo login_trancado no formato esperado." "confira a versao instalada com: sudo dgclaw status"
        elif ! PAINEL_AGENTES="$(printf '%s' "$saude" | jq -er '.agentes | numbers | select(. >= 0 and . == floor)' 2>/dev/null)"; then
            # Quantos registros o painel aceitou (Admin incluido), para comparar com o agentes.json no passo 4.
            PAINEL_AGENTES=""
            inconclusivo 2 "o painel respondeu na porta $PORTA, mas sem a contagem de agentes no formato esperado." "confira a versao instalada com: sudo dgclaw status"
        else
            ok 2 "o painel do DG Claw respondeu na porta $PORTA (/api/saude)"
        fi
    else
        falha 2 "o painel do DG Claw nao respondeu na porta $PORTA (/api/saude sem a resposta esperada; curl saiu com $curl_rc)." "veja o servico com: sudo systemctl status dgclaw-web"
    fi
fi

# --- 3. Servicos do host ---------------------------------------------------------------------------
printf '\n3. Servicos do host\n'
for unidade in dgclaw-web dgclaw-admin; do
    estado="$(systemctl is-active "$unidade" 2>/dev/null | head -n 1)"
    if [ "$estado" = active ]; then ok 3 "$unidade ativo"
    else falha 3 "$unidade nao esta ativo." "rode: sudo systemctl status $unidade"; fi
done

# --- 4. Agentes ------------------------------------------------------------------------------------
printf '\n4. Agentes\n'
AGENTES_JSON="$R/etc/dgclaw/agentes.json"
if [ ! -s "$AGENTES_JSON" ]; then
    inconclusivo 4 "nao achei ou nao consegui ler $AGENTES_JSON." "rode o smoke no servidor do DG Claw, como root, e confira com: dgclaw agente listar"
else
    # O painel (web/lib/registro.js) descarta item que nao e objeto, sem runner, sem agente_id, com slug invalido ou
    # repetido. A comparacao vem antes da leitura dos campos, e os agentes validos sao conferidos mesmo assim.
    TOTAL="$(jq -r '.agentes | arrays | length' "$AGENTES_JSON" 2>/dev/null)"
    if [ -n "$PAINEL_AGENTES" ] && [ -n "$TOTAL" ] && [ "$PAINEL_AGENTES" != "$TOTAL" ]; then
        falha 4 "o painel carregou $PAINEL_AGENTES dos $TOTAL registros do agentes.json: algum registro foi descartado e esse agente nao aparece no painel." "confira com a equipe: dgclaw agente listar"
    fi
    # Mesma regra do painel (web/lib/registro.js): sem "tipo", e agente (o slug "admin" e o Admin). Todo registro que
    # nao e o Admin e conferido, seja qual for o tipo, como no diagnostico. Cada linha sai como
    # "<igual|diverge> <slug>": diverge quando o campo "container" do registro nao e vazio nem dgclaw-<slug>.
    if ! SLUGS="$(jq -r '.agentes[] | objects | ((.tipo | strings | gsub("^\\s+|\\s+$"; "")) // "") as $tp | (if $tp != "" then $tp elif .slug == "admin" then "admin" else "agente" end) as $t | select($t != "admin") | (.slug | if type == "string" and test("\\A[a-z0-9][a-z0-9-]{0,31}\\z") then . else "-" end) as $s | ((.container // "") | tostring) as $c | (if $c == "" or $c == ("dgclaw-" + $s) then "igual" else "diverge" end) + " " + $s' "$AGENTES_JSON" 2>/dev/null)"; then
        inconclusivo 4 "o registro de agentes nao pode ser lido." "confira com: dgclaw agente listar"
    elif [ -z "$SLUGS" ]; then
        aviso 4 "o registro nao tem nenhum agente." "crie o agente do cliente antes da entrega (dgclaw agente criar)"
    else
        while read -r reg slug; do
            if [ "${#slug}" -gt 32 ] || ! [[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
                inconclusivo 4 "um agente do registro tem nome fora do formato e nao foi conferido." "confira com: dgclaw agente listar"
                continue
            fi
            if [ "$reg" != igual ]; then
                inconclusivo 4 "o registro aponta para o agente $slug um container diferente de dgclaw-$slug, entao o smoke nao confere esse agente." "confira o registro com a equipe: dgclaw agente listar"
                continue
            fi
            c="dgclaw-$slug"
            podman container exists "$c" >/dev/null 2>&1; rc=$?
            if [ "$rc" -eq 1 ]; then
                falha 4 "o container $c nao existe." "confira com a equipe: dgclaw agente listar"
                continue
            elif [ "$rc" -ne 0 ]; then
                inconclusivo 4 "o podman nao respondeu sobre o container $c." "rode o smoke de novo; se repetir, confira: sudo systemctl status podman"
                continue
            fi
            rodando="$(podman inspect -f '{{.State.Running}}' "$c" 2>/dev/null | head -n 1)"
            case "$rodando" in
                true) ok 4 "$c rodando" ;;
                false) falha 4 "$c esta parado." "rode: dgclaw agente iniciar $slug"; continue ;;
                *) inconclusivo 4 "nao consegui ler o estado de $c." "rode o smoke de novo"; continue ;;
            esac
            mem="$(podman inspect -f '{{.HostConfig.Memory}}' "$c" 2>/dev/null | head -n 1)"
            if ! so_digitos "$mem" 15; then
                inconclusivo 4 "nao consegui ler o limite de memoria de $c." "rode o smoke de novo"
            elif [ "$mem" -eq 0 ]; then
                falha 4 "$c esta sem limite de memoria." "registre e confira com a equipe"
            elif [ "$mem" -lt 2147483648 ]; then
                aviso 4 "$c tem $((mem / 1048576)) MB, abaixo de 2 GB." "confira com a equipe a configuracao de memoria (DGCLAW_CONTAINER_MEMORIA) e a folga da VPS antes de atribuir a causa"
            else
                ok 4 "$c com limite de memoria de $((mem / 1048576)) MB"
            fi
        done <<<"$SLUGS"
    fi
fi

cat <<'FIM'

A conferir a mao (docs/ENTREGA-CLIENTE.md):
  - Chave SSH da equipe e suporte temporario revogado
  - OOM recente no journal do kernel
  - RAM do servidor contra o teto do container, CPU e processos (pids)
  - Sistema operacional e ffmpeg do servidor
  - Microfone no web.env e nomes do cofre contra as skills
  - Card de teste nos dois motores, YouTube e yt-dlp, render do Chrome e ffmpeg do container
  - Login do dono pelo celular e troca da senha
  - Skills do cliente e sessao principal

FIM
printf 'Resumo: %s falha(s), %s aviso(s), %s inconclusivo(s).\n' "$FALHAS" "$AVISOS" "$INCONCLUSIVOS"
if [ "$FALHAS" -gt 0 ]; then
    printf 'NAO entregue a VPS: corrija as linhas FALHA acima e rode o smoke de novo.\n'
    exit 1
fi
printf 'Sem falhas. Resolva ou justifique os avisos, repita os INCONCLUSIVOS a mao e faca a lista "a conferir a mao".\n'
exit 0
