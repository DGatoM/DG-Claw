#!/usr/bin/env bash
# Testa scripts/checar-boletins.mjs (aviso de seguranca) contra um GitHub falso e um Admin falso, os mesmos
# do aviso de nova versao (tests/aviso-atualizacao/servidor-falso.mjs). Raiz falsa (DGCLAW_RAIZ): nada
# encosta no sistema nem na internet.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$AQUI/../../scripts/checar-boletins.mjs"
FALSO="$AQUI/../aviso-atualizacao/servidor-falso.mjs"
command -v node >/dev/null || { echo "falta o node no PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "falta o jq no PATH" >&2; exit 1; }

TMP="$(mktemp -d)"
SERVIDOR_PID=""
trap '[ -z "$SERVIDOR_PID" ] || kill "$SERVIDOR_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

FALHAS=0; TESTES=0
ok() { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }
igual() { if [ "$2" = "$3" ]; then ok "$1"; else mal "$1 (esperado '$2', veio '$3')"; fi; }
tem() { if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else mal "$1 (nao achei '$2' em: ${3:0:300})"; fi; }
nao_tem() { if printf '%s' "$3" | grep -qF -- "$2"; then mal "$1 (achei '$2')"; else ok "$1"; fi; }

CENARIO="$TMP/cenario.json"
REQ="$TMP/requisicoes.log"; ADMINLOG="$TMP/admin.log"
: >"$REQ"; : >"$ADMINLOG"; echo '{}' >"$CENARIO"
node "$FALSO" "$CENARIO" "$TMP/porta" "$REQ" "$ADMINLOG" &
SERVIDOR_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/porta" ] && break; sleep 0.1; done
[ -s "$TMP/porta" ] || { echo "o servidor falso nao subiu" >&2; exit 1; }
BASE="http://127.0.0.1:$(cat "$TMP/porta")"
SEGREDO_DO_TESTE="teste-$(date +%s%N)-$RANDOM$RANDOM"
TEXTO_LIVRE="DETALHE-LIVRE-QUE-NAO-PODE-IR-AO-ADMIN"

raiz_nova() {
    RAIZ="$TMP/raiz-$RANDOM$RANDOM"
    mkdir -p "$RAIZ/etc/dgclaw/runner" "$RAIZ/opt/dgclaw/app/seguranca" "$RAIZ/var/log/dgclaw"
    printf 'DGCLAW_DOMINIO=x.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    [ $# -eq 0 ] || printf '%s\n' "$@" >>"$RAIZ/etc/dgclaw/dgclaw.env"
    printf '%s\n' "$SEGREDO_DO_TESTE" >"$RAIZ/etc/dgclaw/runner/admin.token"
    mkdir -p "$RAIZ/var/lib/dgclaw/web/atualizacao"; chmod 700 "$RAIZ/var/lib/dgclaw/web/atualizacao"
    : >"$RAIZ/var/lib/dgclaw/web/atualizacao/.trava-boletins"
    ESTADO="$RAIZ/var/lib/dgclaw/web/atualizacao/boletins.json"
    AVISADOS="$RAIZ/var/lib/dgclaw/web/atualizacao/boletins-avisados.json"
    LOG="$RAIZ/var/log/dgclaw/checar-boletins.log"
    INSTALADO="$RAIZ/opt/dgclaw/app/seguranca/boletins.json"
    : >"$REQ"; : >"$ADMINLOG"
}

roda() {
    RC=0
    env -i PATH="$PATH" DGCLAW_RAIZ="$RAIZ" DGCLAW_BOLETINS_URL="${URL:-$BASE/DGatoM/DG-Claw/main/seguranca/boletins.json}" \
        DGCLAW_ADMIN_URL="${ADMIN:-$BASE}" flock -w 30 "$RAIZ/var/lib/dgclaw/web/atualizacao/.trava-boletins" node "$SCRIPT" >"$TMP/out.txt" 2>"$TMP/err.txt" || RC=$?
    OUT="$(cat "$TMP/out.txt")"; ERR="$(cat "$TMP/err.txt")"
}

# bol <id> [campo=json ...]: um boletim valido, com ajustes em jq ("fonte_url=null" apaga o campo).
bol() {
    local id="$1"; shift
    local j
    j="$(jq -n --arg id "$id" --arg d "$TEXTO_LIVRE" '{id: $id, relacionados: [], severidade: "CRITICAL", componente: "Pillow", acao: "atualizar-dgclaw",
        titulo: "Vulnerabilidade no Pillow", detalhe: $d, o_que_muda: "A imagem passa a usar o Pillow 13.", publicado_em: "2026-10-21T21:28:09Z",
        boletim_em: "2026-10-31T10:00:00Z", fonte_url: "https://github.com/advisories/x", noticia_url: null}')"
    for ajuste in "$@"; do j="$(printf '%s' "$j" | jq -c ".${ajuste%%=*} = ${ajuste#*=}")"; done
    printf '%s' "$j"
}
# publica <versao> <boletim>...: o boletins.json "do GitHub" no cenario.
publica() {
    local versao="$1"; shift
    local arq="$TMP/remoto.json"
    if [ $# -eq 0 ]; then printf '{"versao": %s, "boletins": []}' "$versao" >"$arq"
    else printf '%s\n' "$@" | jq -s --argjson v "$versao" '{versao: $v, boletins: .}' >"$arq"; fi
    jq -n --rawfile b "$arq" '{raw: {"boletins.json": {body: $b}}}' >"$CENARIO"
}
campo() { jq -r "$1" "$ESTADO"; }
recados() { grep -c . "$ADMINLOG" || true; }

echo "sem boletins no GitHub"
raiz_nova
publica 2
roda
igual "sai 0" 0 "$RC"
igual "nenhum pendente" 0 "$(campo '.pendentes | length')"
igual "sem erro" null "$(campo .erro)"
igual "estado 600" 600 "$(stat -c %a "$ESTADO")"
igual "pasta do estado 700" 700 "$(stat -c %a "$RAIZ/var/lib/dgclaw/web/atualizacao")"
igual "nenhum recado" 0 "$(recados)"
tem "stdout diz que nada foi instalado" "Nada foi baixado nem instalado" "$OUT"

echo "boletim novo: pendente e um recado ao Admin"
raiz_nova
publica 2 "$(bol GHSA-AAAA-1111)"
roda
igual "sai 0" 0 "$RC"
igual "um pendente" 1 "$(campo '.pendentes | length')"
igual "id" GHSA-AAAA-1111 "$(campo '.pendentes[0].id')"
igual "verificado_em preenchido" true "$(campo '.verificado_em | length > 10')"
igual "um recado ao Admin" 1 "$(recados)"
RECADO="$(jq -r '.corpo | fromjson | .text' "$ADMINLOG")"
igual "credencial certa no cabecalho" "Bearer $SEGREDO_DO_TESTE" "$(jq -r .auth "$ADMINLOG")"
igual "o recado espera o Admin ficar ocioso (injectWhenIdle)" true "$(jq -r '.corpo | fromjson | .injectWhenIdle' "$ADMINLOG")"
igual "o corpo so tem text e injectWhenIdle" "injectWhenIdle,text" "$(jq -r '.corpo | fromjson | keys | join(",")' "$ADMINLOG")"
tem "recado marcado como plataforma" '<plataforma recado="boletim-de-seguranca">' "$RECADO"
tem "recado traz o id" "GHSA-AAAA-1111" "$RECADO"
tem "recado traz a gravidade" "crítica" "$RECADO"
tem "recado manda olhar o painel" "painel" "$RECADO"
# shellcheck disable=SC2016  # as crases fazem parte do texto procurado, nada a expandir
tem "recado proibe atualizar sem o sim do dono" 'NUNCA rode `dgclaw atualizar` sem o sim explícito do dono' "$RECADO"
nao_tem "recado nao traz texto livre do boletim (detalhe)" "$TEXTO_LIVRE" "$RECADO"
nao_tem "recado nao traz o componente" "Pillow" "$RECADO"
nao_tem "recado nao traz o titulo" "Vulnerabilidade no Pillow" "$RECADO"
nao_tem "stdout e log nao trazem o texto livre" "$TEXTO_LIVRE" "$OUT$ERR$(cat "$LOG")"
igual "guardou o id avisado" true "$(jq -r '.ids | has("GHSA-AAAA-1111")' "$AVISADOS")"

echo "segunda rodada: o mesmo id nao avisa de novo; um id novo avisa so ele"
roda
igual "continua com 1 recado" 1 "$(recados)"
publica 2 "$(bol GHSA-AAAA-1111)" "$(bol GHSA-BBBB-2222 'severidade="LOW"')"
roda
igual "dois pendentes" 2 "$(campo '.pendentes | length')"
igual "mais um recado, so do novo" 2 "$(recados)"
igual "mais grave primeiro" GHSA-AAAA-1111 "$(campo '.pendentes[0].id')"
tem "o segundo recado e do id novo" "GHSA-BBBB-2222" "$(tail -n 1 "$ADMINLOG")"

echo "a versao instalada ja tem o boletim: nao e pendente"
raiz_nova
printf '{"versao": 2, "boletins": [%s]}\n' "$(bol GHSA-AAAA-1111 'relacionados=["GHSA-CCCC-3333"]')" >"$INSTALADO"
publica 2 "$(bol GHSA-AAAA-1111)" "$(bol GHSA-CCCC-3333)" "$(bol GHSA-DDDD-4444)"
roda
igual "sai 0" 0 "$RC"
igual "so o que a instalacao nao tem (o relacionado tambem conta como coberto)" GHSA-DDDD-4444 "$(campo '.pendentes | map(.id) | join(",")')"
igual "um recado, so do pendente" 1 "$(recados)"

echo "so atualizar-dgclaw se resolve pela versao instalada; as outras acoes pedem prova"
raiz_nova
printf '{"versao": 2, "boletins": [%s,%s,%s,%s]}\n' "$(bol GHSA-DGCL-0001)" "$(bol GHSA-SIST-0002 'acao="atualizar-sistema"')" \
    "$(bol GHSA-SIST-0003 'acao="atualizar-sistema"' 'relacionados=["CVE-2026-33333"]')" "$(bol GHSA-AGUA-0004 'acao="aguardar"')" >"$INSTALADO"
publica 2 "$(bol GHSA-DGCL-0001)" "$(bol GHSA-SIST-0002 'acao="atualizar-sistema"')" \
    "$(bol GHSA-SIST-0003 'acao="atualizar-sistema"' 'relacionados=["CVE-2026-33333"]')" "$(bol GHSA-AGUA-0004 'acao="aguardar"')"
roda
igual "atualizar-dgclaw resolvido; sistema e aguardar seguem pendentes" "GHSA-AGUA-0004,GHSA-SIST-0002,GHSA-SIST-0003" "$(campo '.pendentes | map(.id) | sort | join(",")')"
mkdir -p "$RAIZ/var/lib/dgclaw/web/seguranca"
printf '{"ja_tratadas": [{"id": "GHSA-SIST-0002", "componente": "openssl", "como": "corrigido na versao instalada"}, {"id": "CVE-2026-33333", "componente": "x", "como": "aplicado sozinho em 31/10"}, {"id": "GHSA-AGUA-0004", "componente": "y", "como": "mitigado em 31/10: algo"}]}\n' >"$RAIZ/var/lib/dgclaw/web/seguranca/ronda.json"
roda
igual "a ronda local resolve o id e o relacionado; mitigado nao resolve" "GHSA-AGUA-0004" "$(campo '.pendentes | map(.id) | sort | join(",")')"

echo "arquivo instalado ausente = lista vazia; corrompido = falha que se explica"
raiz_nova
rm -f "$INSTALADO"
publica 2 "$(bol GHSA-AAAA-1111)"
roda
igual "ausente: sai 0 e tudo e pendente" 1 "$(campo '.pendentes | length')"
raiz_nova
printf '{quebrado' >"$INSTALADO"
publica 2 "$(bol GHSA-AAAA-1111)"
roda
igual "corrompido: sai 1" 1 "$RC"
tem "diz qual arquivo" "$INSTALADO" "$ERR"
tem "diz o que fazer" "dgclaw atualizar" "$ERR"

echo "validacao do contrato"
raiz_nova
publica 2 "$(bol GHSA-SEMF-0001 'fonte_url=null')" \
          "$(bol GHSA-HTTP-0002 'fonte_url="http://exemplo.org/x"')" \
          "$(bol GHSA-CTRL-0003 'componente="Pil\u0007low"')" \
          "$(bol GHSA-NOTI-0004 'noticia_url="http://exemplo.org/n"')" \
          "$(bol GHSA-ENUM-0005 'severidade="URGENTE"')" \
          "$(bol GHSA-ACAO-0006 'acao="rodar-comando"')" \
          "$(bol GHSA-LONG-0007 "detalhe=\"$(printf 'x%.0s' $(seq 1 601))\"")" \
          "$(bol 'id ruim')" \
          "$(bol GHSA-BOM-00008)"
roda
igual "sai 0 (descartar boletim ruim nao e falha)" 0 "$RC"
igual "so o valido sobra" GHSA-BOM-00008 "$(campo '.pendentes | map(.id) | join(",")')"
LOGTXT="$(cat "$LOG")"
tem "log explica: sem fonte" "sem fonte_url" "$LOGTXT"
tem "log explica: http recusado" "fonte_url não começa com https://" "$LOGTXT"
tem "log explica: caractere de controle" "componente tem caractere de controle" "$LOGTXT"
tem "log explica: noticia http" "noticia_url não começa com https://" "$LOGTXT"
tem "log explica: severidade" "severidade fora da lista" "$LOGTXT"
tem "log explica: acao" "acao fora da lista" "$LOGTXT"
tem "log explica: tamanho" "detalhe passa de 600" "$LOGTXT"
tem "log explica: id" "id fora do formato" "$LOGTXT"
igual "so o valido foi avisado ao Admin" 1 "$(recados)"

echo "versao 1 (antiga) ainda e lida; versao desconhecida e recusada"
raiz_nova
V1="$(jq -n '{id: "GHSA-VELH-0001", severidade: "HIGH", componente: "Pillow", acao: "atualizar-dgclaw", titulo: "Antigo", detalhe: "texto", publicado_em: "2026-10-01T00:00:00Z", fonte_url: "https://github.com/advisories/y"}')"
publica 1 "$V1"
roda
igual "v1 com fonte: pendente" GHSA-VELH-0001 "$(campo '.pendentes[0].id')"
igual "o_que_muda ausente vira vazio" "" "$(campo '.pendentes[0].o_que_muda')"
V1SEM="$(printf '%s' "$V1" | jq -c 'del(.fonte_url) | .id = "GHSA-VELH-0002"')"
publica 1 "$V1SEM"
roda
igual "v1 sem fonte: descartado" 0 "$(campo '.pendentes | length')"
publica 3 "$(bol GHSA-AAAA-1111)"
roda
igual "versao 3: sai 1" 1 "$RC"
tem "diz que o formato nao e aceito" "formato que não aceito" "$ERR"

echo "falha de rede mantem os pendentes anteriores e registra o erro"
raiz_nova
publica 2 "$(bol GHSA-AAAA-1111)"
roda
igual "primeira rodada: 1 pendente" 1 "$(campo '.pendentes | length')"
URL="http://127.0.0.1:1/seguranca/boletins.json" roda
igual "falha: sai 1" 1 "$RC"
igual "mantem o pendente" GHSA-AAAA-1111 "$(campo '.pendentes[0].id')"
tem "o erro explica o que falhou, com a URL" "http://127.0.0.1:1/seguranca/boletins.json" "$(campo .erro.motivo)"
tem "o erro diz o que fazer" "Confira a conexão" "$(campo .erro.motivo)"
tem "stderr tem a mesma mensagem" "Não consegui falar com" "$ERR"
igual "o erro tem data" true "$(campo '.erro.quando | length > 10')"
roda
igual "volta a funcionar e limpa o erro" null "$(campo .erro)"

echo "HTTP 404 e erro com explicacao"
raiz_nova
echo '{}' >"$CENARIO"
roda
igual "sai 1" 1 "$RC"
tem "explica o 404" "HTTP 404" "$ERR"
igual "estado gravado com lista vazia e erro" 0 "$(campo '.pendentes | length')"

echo "Admin fora do ar: o id fica sem marca e o recado sai na rodada seguinte"
raiz_nova
publica 2 "$(bol GHSA-AAAA-1111)"
jq '. + {admin: {status: 500}}' "$CENARIO" >"$TMP/c2.json" && mv "$TMP/c2.json" "$CENARIO"
roda
igual "sai 0" 0 "$RC"
igual "nao marcou como avisado" false "$([ -e "$AVISADOS" ] && echo true || echo false)"
tem "log diz que tenta de novo" "tento de novo" "$(cat "$LOG")"
publica 2 "$(bol GHSA-AAAA-1111)"
roda
igual "agora marcou" true "$(jq -r '.ids | has("GHSA-AAAA-1111")' "$AVISADOS")"

echo "desligado no dgclaw.env"
raiz_nova DGCLAW_BOLETINS_SEGURANCA=0
publica 2 "$(bol GHSA-AAAA-1111)"
roda
igual "sai 0" 0 "$RC"
igual "marca desligado" true "$(campo .desligado)"
igual "nenhum pendente" 0 "$(campo '.pendentes | length')"
igual "nao consultou o GitHub" 0 "$(grep -c . "$REQ" || true)"
igual "nenhum recado" 0 "$(recados)"

echo "Admin so por 127.0.0.1: o token nao sai da maquina"
raiz_nova
publica 2 "$(bol GHSA-AAAA-1111)"
ADMIN="http://admin.exemplo.org" roda
igual "nenhum recado foi enviado" 0 "$(recados)"
tem "log explica a recusa" "Recusei mandar o token do Admin" "$(cat "$LOG")"
nao_tem "o token nao aparece em lugar nenhum" "$SEGREDO_DO_TESTE" "$OUT$ERR$(cat "$LOG")"

printf '\n%s verificacoes, %s com falha.\n' "$TESTES" "$FALHAS"
[ "$FALHAS" -eq 0 ]
