#!/usr/bin/env bash
# Teste do dgclaw-agente com API do Telegram e runner falsos. Uso: bash bin/test/dgclaw-agente.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$AQUI/../dgclaw-agente"
T="$(mktemp -d)"
trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
FALHAS=0; N=0
ok() { N=$((N+1)); if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FALHOU $1"; FALHAS=$((FALHAS+1)); fi; }

BOT_FAKE="123456789:AAFakeFakeFakeFakeFakeFakeFakeFake_x1"
RUNNER_FAKE="runner-segredo-de-teste-123"
export LOG="$T/log.jsonl" PORTA_ARQ="$T/porta" BOT_VALIDO="$BOT_FAKE" RUNNER_BEARER="$RUNNER_FAKE" COM_MENSAGEM=0
: > "$LOG"
node "$AQUI/falso.js" & SRV=$!
for _ in $(seq 50); do [ -s "$PORTA_ARQ" ] && break; sleep 0.1; done
PORTA="$(cat "$PORTA_ARQ")"

export HOME="$T/casa"; mkdir -p "$HOME"
export DGCLAW_UID=1000 DGCLAW_TIPO=agente
export DGCLAW_TELEGRAM_API="http://127.0.0.1:$PORTA"
export DGCLAW_RUNNER_URL="http://127.0.0.1:$PORTA" DGCLAW_AGENTE_ID=ag-1
printf '%s\n' "$RUNNER_FAKE" > "$T/runner.tok"
unset DGCLAW_RUNNER_TOKEN_FILE RUNNER_TOKEN_FILE

# systemctl FALSO: grava os argumentos; is-active responde pelo arquivo $SC_ATIVO; $SC_FALHA faz enable/disable falharem
mkdir -p "$T/bin"
cat > "$T/bin/systemctl-falso" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$SC_LOG"
case "$1" in
  is-active) [ -e "$SC_ATIVO" ] && exit 0 || exit 3 ;;
  enable|disable) if [ -e "$SC_FALHA" ]; then echo "Failed: unidade nao existe (teste)" >&2; exit 1; fi; exit 0 ;;
esac
SH
chmod +x "$T/bin/systemctl-falso"
export SC_LOG="$T/sc.log" SC_ATIVO="$T/sc-ativo" SC_FALHA="$T/sc-falha" PONTE_FALSA_LOG="$T/ponte.log"
export DGCLAW_SYSTEMCTL="$T/bin/systemctl-falso" DGCLAW_WHATSAPP_PONTE="$AQUI/ponte-falsa.mjs" DGCLAW_WHATSAPP_ESPERA=8
: > "$SC_LOG"; : > "$PONTE_FALSA_LOG"

# Admin recusado (por tipo e por uid)
DGCLAW_TIPO=admin "$BIN" canal status >/dev/null 2>"$T/e"; c=$?
ok "admin por tipo recusado (codigo 2)" $([ $c = 2 ] && echo 0 || echo 1)
grep -q "Admin nao tem canal externo" "$T/e"; ok "mensagem do admin explica" $?
DGCLAW_UID=0 DGCLAW_TIPO=agente "$BIN" canal status >/dev/null 2>&1; c=$?
ok "uid 0 recusado" $([ $c = 2 ] && echo 0 || echo 1)

# Regex do token
echo "abc" | "$BIN" canal telegram token >"$T/o" 2>"$T/e"; c=$?
ok "token fora do formato recusado" $([ $c != 0 ] && echo 0 || echo 1)
[ ! -e "$HOME/.dgclaw/telegram/.env" ]; ok "nada gravado com token invalido" $?

# Token com formato certo mas que o Telegram nao conhece
echo "999999999:AAOutroOutroOutroOutroOutroOutro_zz" | "$BIN" canal telegram token >"$T/o" 2>"$T/e"; c=$?
ok "token recusado pelo Telegram" $([ $c != 0 ] && echo 0 || echo 1)
grep -q "recusou o token" "$T/e"; ok "erro diz o que fazer" $?

# Token bom: ps nao pode ver o token enquanto o curl roda. Segura o servidor com um atraso via monitor de ps.
( for _ in $(seq 200); do ps -eo args | grep -F "$BOT_FAKE" | grep -v grep >> "$T/ps.txt"; sleep 0.02; done ) & MON=$!
echo "$BOT_FAKE" | "$BIN" canal telegram token >"$T/o" 2>"$T/e"; c=$?
ok "token valido aceito" $([ $c = 0 ] && echo 0 || echo 1)
[ "$(cat "$T/o")" = "@meu_teste_bot" ]; ok "imprime so @username" $?
! grep -qF "$BOT_FAKE" "$T/o" "$T/e"; ok "token nao aparece na saida" $?
ENVF="$HOME/.dgclaw/telegram/.env"
[ "$(stat -c %a "$ENVF")" = 600 ]; ok ".env com 600" $?
[ "$(stat -c %a "$HOME/.dgclaw/telegram")" = 700 ]; ok "pasta telegram com 700" $?
[ "$(cat "$ENVF")" = "TELEGRAM_BOT_TOKEN=$BOT_FAKE" ]; ok ".env no formato do plugin" $?

# parear sem mensagem
"$BIN" canal telegram parear >"$T/o" 2>"$T/e"; c=$?
ok "parear sem mensagem falha" $([ $c != 0 ] && echo 0 || echo 1)
grep -q "ninguem escreveu" "$T/e"; ok "parear explica que ninguem escreveu" $?

# ligar sem allowlist
"$BIN" canal telegram ligar >"$T/o" 2>"$T/e"; c=$?
ok "ligar recusa sem allowlist" $([ $c != 0 ] && echo 0 || echo 1)
[ ! -e "$HOME/.dgclaw/canais.json" ]; ok "canais.json nao criado na recusa" $?

# ligar sem token (outra casa)
H0="$HOME"; HOME="$T/vazia" "$BIN" canal telegram ligar >/dev/null 2>"$T/e"; c=$?
ok "ligar recusa sem token" $([ $c != 0 ] && echo 0 || echo 1)
grep -q "falta o token" "$T/e"; ok "mensagem de falta de token" $?

# parear com mensagens
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -f "$PORTA_ARQ"
COM_MENSAGEM=1 node "$AQUI/falso.js" & SRV=$!
for _ in $(seq 50); do [ -s "$PORTA_ARQ" ] && break; sleep 0.1; done
P2="$(cat "$PORTA_ARQ")"
export DGCLAW_TELEGRAM_API="http://127.0.0.1:$P2" DGCLAW_RUNNER_URL="http://127.0.0.1:$P2"
"$BIN" canal telegram parear >"$T/o" 2>"$T/e"; c=$?
ok "parear com mensagens funciona" $([ $c = 0 ] && echo 0 || echo 1)
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.pessoas.length===1&&d.pessoas[0].chat_id==="555111"&&d.pessoas[0].username==="@maria_s"&&d.pessoas[0].nome==="Maria Silva"?0:1)' "$T/o"
ok "parear lista so a pessoa privada, sem duplicata" $?
! grep -qF "$BOT_FAKE" "$T/o" "$T/e"; ok "parear nao vaza token" $?
"$BIN" canal telegram parear --confirmar abc >/dev/null 2>&1; ok "confirmar exige numero" $([ $? != 0 ] && echo 0 || echo 1)
"$BIN" canal telegram parear --confirmar 555111 >"$T/o" 2>&1; ok "confirmar grava allowlist" $?
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.dmPolicy==="allowlist"&&JSON.stringify(d.allowFrom)==="[\"555111\"]"&&typeof d.groups==="object"&&typeof d.pending==="object"?0:1)' "$HOME/.dgclaw/telegram/access.json"
ok "access.json no formato do plugin" $?
[ "$(stat -c %a "$HOME/.dgclaw/telegram/access.json")" = 600 ]; ok "access.json 600" $?

# ligar sem arquivo de token do runner: salva e sai 3
: > "$LOG"
"$BIN" canal telegram ligar >"$T/o" 2>"$T/e"; c=$?
ok "ligar sem token do runner sai com 3" $([ $c = 3 ] && echo 0 || echo 1)
grep -q "Reiniciar" "$T/e"; ok "explica o botao Reiniciar" $?
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.versao===1&&d.telegram.ligado===true&&d.telegram.estado_dir===process.argv[2]?0:1)' "$HOME/.dgclaw/canais.json" "$HOME/.dgclaw/telegram"
ok "canais.json gravado mesmo assim" $?
[ "$(stat -c %a "$HOME/.dgclaw/canais.json")" = 600 ]; ok "canais.json 600" $?
! grep -q reiniciar "$LOG"; ok "nao chamou o runner sem token" $?

# ligar com token do runner: chama reiniciar com Bearer
echo '{"versao":1,"whatsapp":{"ligado":false},"telegram":{"ligado":false}}' > "$HOME/.dgclaw/canais.json"
: > "$LOG"
DGCLAW_RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram ligar >"$T/o" 2>"$T/e"; c=$?
ok "ligar com runner funciona" $([ $c = 0 ] && echo 0 || echo 1)
grep -q '"url":"/api/agents/ag-1/reiniciar"' "$LOG" && grep -q "\"auth\":\"Bearer $RUNNER_FAKE\"" "$LOG"; ok "restart chamado com Bearer" $?
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.whatsapp&&d.telegram.ligado===true?0:1)' "$HOME/.dgclaw/canais.json"
ok "preserva outros canais" $?
RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram ligar >/dev/null 2>&1; ok "aceita RUNNER_TOKEN_FILE" $?
"$BIN" canal status > "$T/o"; grep -q "Telegram: ligado" "$T/o"; ok "status ligado" $?
! grep -qF "$BOT_FAKE" "$T/o"; ok "status sem segredo" $?

# runner fora do ar: salva e sai 4
DGCLAW_RUNNER_URL="http://127.0.0.1:1" DGCLAW_RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram ligar >/dev/null 2>"$T/e"; c=$?
ok "runner fora do ar sai com 4" $([ $c = 4 ] && echo 0 || echo 1)

# conferir: sem .env, token recusado, ok, modo errado
H1="$HOME"; HOME="$T/sem-env" "$BIN" canal telegram conferir >"$T/o" 2>"$T/e"; c=$?
ok "conferir sem .env falha" $([ $c != 0 ] && echo 0 || echo 1)
grep -q "nenhum token guardado ainda" "$T/e" && grep -q "conversa do DG Claw" "$T/e"; ok "conferir sem .env explica o que fazer" $?
mkdir -p "$T/ruim/.dgclaw/telegram"; echo "TELEGRAM_BOT_TOKEN=999999999:AAOutroOutroOutroOutroOutroOutro_zz" > "$T/ruim/.dgclaw/telegram/.env"; chmod 600 "$T/ruim/.dgclaw/telegram/.env"
HOME="$T/ruim" "$BIN" canal telegram conferir >"$T/o" 2>"$T/e"; c=$?
ok "conferir com token recusado falha" $([ $c != 0 ] && echo 0 || echo 1)
grep -q "recusou o token" "$T/e"; ok "conferir recusado usa a mesma mensagem do token" $?
! grep -q "AAOutro" "$T/o" "$T/e"; ok "conferir recusado nao vaza token" $?
"$BIN" canal telegram conferir >"$T/o" 2>"$T/e"; c=$?
ok "conferir com token bom funciona" $([ $c = 0 ] && echo 0 || echo 1)
[ "$(head -1 "$T/o")" = "@meu_teste_bot" ] && grep -q "^ok" "$T/o"; ok "conferir imprime @username e uma linha de ok" $?
! grep -qF "$BOT_FAKE" "$T/o" "$T/e"; ok "conferir nao vaza token" $?
[ ! -s "$T/e" ]; ok "conferir com 600 nao avisa nada" $?
chmod 644 "$HOME/.dgclaw/telegram/.env"
"$BIN" canal telegram conferir >"$T/o" 2>"$T/e"; c=$?
ok "conferir com modo errado ainda funciona" $([ $c = 0 ] && echo 0 || echo 1)
grep -q "644" "$T/e" && grep -q "chmod 600" "$T/e"; ok "conferir avisa do modo errado" $?
! grep -qF "$BOT_FAKE" "$T/o" "$T/e"; ok "aviso de modo nao imprime o conteudo" $?
chmod 600 "$HOME/.dgclaw/telegram/.env"

# desligar mantem, desligar --apagar apaga
DGCLAW_RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram desligar >/dev/null 2>&1; ok "desligar ok" $?
[ -f "$HOME/.dgclaw/telegram/.env" ]; ok "desligar mantem o token" $?
grep -q '"ligado": false' "$HOME/.dgclaw/canais.json"; ok "canais.json desligado" $?
DGCLAW_RUNNER_TOKEN_FILE="$T/runner.tok" "$BIN" canal telegram desligar --apagar >/dev/null 2>&1; ok "desligar --apagar ok" $?
[ ! -e "$HOME/.dgclaw/telegram" ]; ok "pasta telegram apagada" $?
"$BIN" canal status > "$T/o2"; grep -q "nao configurado" "$T/o2"; ok "status apos apagar" $?

# ------------------------------------------------------------------ WhatsApp
WA="$HOME/.dgclaw/whatsapp"

DGCLAW_TIPO=admin "$BIN" canal whatsapp permitir 11987654321 >/dev/null 2>"$T/e"; c=$?
ok "whatsapp: admin recusado (codigo 2)" $([ $c = 2 ] && echo 0 || echo 1)

# numero invalido
"$BIN" canal whatsapp permitir "12ab" >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: numero invalido recusado" $([ $c = 1 ] && echo 0 || echo 1)
grep -q "12ab" "$T/e" && grep -q "98765-4321" "$T/e"; ok "whatsapp: erro diz o que recebeu e o formato" $?
"$BIN" canal whatsapp parear "123" >/dev/null 2>&1; ok "whatsapp: parear com numero curto recusado" $([ $? = 1 ] && echo 0 || echo 1)
"$BIN" canal whatsapp frufru >/dev/null 2>"$T/e"; ok "whatsapp: subcomando desconhecido recusado" $([ $? = 1 ] && grep -q "desconhecido" "$T/e" && echo 0 || echo 1)

# ligar sem sessao e sem lista
"$BIN" canal whatsapp ligar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: ligar sem sessao recusa" $([ $c = 1 ] && grep -q "parear" "$T/e" && echo 0 || echo 1)
[ ! -e "$WA/ligado" ]; ok "whatsapp: ligar recusado nao cria 'ligado'" $?

# parear: imprime so o codigo
: > "$SC_LOG"
"$BIN" canal whatsapp parear "+55 (11) 98765-4321" >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: parear funciona" $([ $c = 0 ] && echo 0 || echo 1)
[ "$(cat "$T/o")" = "ABCD-1234" ]; ok "whatsapp: parear imprime so o codigo" $?
grep -q "parear 5511987654321" "$PONTE_FALSA_LOG"; ok "whatsapp: a ponte recebeu so os digitos" $?
[ "$(stat -c %a "$WA")" = 700 ]; ok "whatsapp: pasta com 700" $?
[ "$(stat -c %a "$HOME/.dgclaw/logs/whatsapp-pareamento.log")" = 600 ]; ok "whatsapp: log de pareamento com 600" $?
sleep 4.5

# parear recusa com unidade ativa
touch "$SC_ATIVO"
"$BIN" canal whatsapp parear 11987654321 >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: parear recusa com unidade ativa" $([ $c = 1 ] && grep -q "canal whatsapp desligar" "$T/e" && echo 0 || echo 1)
rm -f "$SC_ATIVO"

# parear recusa com sessao ja registrada
mkdir -p "$WA/sessao"; echo '{"registered": true, "segredo": "NAO-MOSTRAR"}' > "$WA/sessao/creds.json"
"$BIN" canal whatsapp parear 11987654321 >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: parear recusa com sessao registrada" $([ $c = 1 ] && grep -q "ja esta pareado" "$T/e" && grep -q "desligar --apagar" "$T/e" && echo 0 || echo 1)
rm -f "$WA/sessao/creds.json"

# parear com falha mostra o motivo
PONTE_FALSA_MODO=falha "$BIN" canal whatsapp parear 11987654321 >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: parear com falha da ponte sai com 1" $([ $c = 1 ] && echo 0 || echo 1)
grep -q "recusou o numero" "$T/e" && grep -q "whatsapp-pareamento.log" "$T/e"; ok "whatsapp: falha mostra o motivo do estado.json e o log" $?
[ ! -s "$T/o" ]; ok "whatsapp: falha nao imprime codigo" $?

# permitir: normaliza, grava 600, nao duplica (com e sem nono digito)
"$BIN" canal whatsapp permitir "(11) 98765-4321" >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: permitir funciona" $([ $c = 0 ] && echo 0 || echo 1)
[ "$(stat -c %a "$WA/permitidos.json")" = 600 ]; ok "whatsapp: permitidos.json com 600" $?
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.versao===1&&JSON.stringify(d.numeros)==="[\"+5511987654321\"]"?0:1)' "$WA/permitidos.json"
ok "whatsapp: permitir normaliza para +55..." $?
grep -q "Permitidos: +5511987654321" "$T/o"; ok "whatsapp: permitir imprime a lista" $?
"$BIN" canal whatsapp permitir "+55 11 98765-4321" >/dev/null 2>&1
"$BIN" canal whatsapp permitir "+55 11 8765-4321" >"$T/o" 2>&1
grep -q "ja estava" "$T/o"; ok "whatsapp: mesmo numero sem o nono digito nao duplica" $?
"$BIN" canal whatsapp permitir "+1 415 555 2671" >/dev/null 2>&1
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.numeros.length===2?0:1)' "$WA/permitidos.json"
ok "whatsapp: lista tem 2 numeros (sem duplicata, com o estrangeiro)" $?

# remover (com e sem nono digito), e remover de quem nao esta
"$BIN" canal whatsapp remover "+55 11 8765-4321" >"$T/o" 2>&1; c=$?
ok "whatsapp: remover acha o numero sem o nono digito" $([ $c = 0 ] && grep -q "Permitidos: +14155552671" "$T/o" && echo 0 || echo 1)
"$BIN" canal whatsapp remover "+55 21 99999-0000" >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: remover de numero ausente da erro claro" $([ $c = 1 ] && grep -q "nao esta na lista" "$T/e" && echo 0 || echo 1)
"$BIN" canal whatsapp remover "+1 415 555 2671" >/dev/null 2>&1
"$BIN" canal whatsapp remover 11987654321 >"$T/o" 2>&1; ok "whatsapp: remover o ultimo deixa a lista vazia" $(grep -q "Permitidos: nenhum" "$T/o" && echo 0 || echo 1)

# grupo: libera, nao duplica, valida o ID, remove, e arquivo ilegivel nunca vira lista vazia
GR="$WA/grupos-liberados.json"
"$BIN" canal whatsapp grupo listar >"$T/o" 2>&1; ok "whatsapp: grupo listar sem arquivo diz nenhum" $(grep -q "Grupos liberados: nenhum" "$T/o" && echo 0 || echo 1)
"$BIN" canal whatsapp grupo liberar 120363000000000001-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: grupo liberar funciona" $([ $c = 0 ] && grep -q "120363000000000001-group" "$T/o" && echo 0 || echo 1)
[ "$(stat -c %a "$GR")" = 600 ]; ok "whatsapp: grupos-liberados.json com 600" $?
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));const g=d.grupos[0];process.exit(d.versao===1&&d.grupos.length===1&&g.id==="120363000000000001-group"&&g.nome===undefined&&!isNaN(Date.parse(g.liberado_em))?0:1)' "$GR"
ok "whatsapp: grupo liberado grava id e liberado_em, sem nome" $?
"$BIN" canal whatsapp grupo liberar 120363000000000001-group >"$T/o" 2>&1; c=$?
ok "whatsapp: liberar de novo nao duplica" $([ $c = 0 ] && grep -q "ja estava liberado" "$T/o" && [ "$(grep -c '120363000000000001-group"' "$GR")" = 1 ] && echo 0 || echo 1)
for ruim in 5511987654321 abc 120363000000000001 "120363-group" "../x-group"; do
  "$BIN" canal whatsapp grupo liberar "$ruim" >"$T/o" 2>"$T/e"; c=$?
  ok "whatsapp: grupo liberar recusa o ID '$ruim'" $([ $c = 1 ] && grep -q "ID de grupo invalido" "$T/e" && echo 0 || echo 1)
done
"$BIN" canal whatsapp grupo liberar 120363000000000002-group >/dev/null 2>&1
cp "$GR" "$T/gr.antes"
"$BIN" canal whatsapp grupo liberar 120363000000000010-group "Nome extra" >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: grupo liberar com argumento extra e erro de uso e a lista fica igual" $([ $c = 1 ] && grep -q "exatamente um ID" "$T/e" && cmp -s "$GR" "$T/gr.antes" && echo 0 || echo 1)
"$BIN" canal whatsapp grupo remover 120363000000000002-group 120363000000000001-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: grupo remover com dois IDs falha e a lista fica igual" $([ $c = 1 ] && grep -q "exatamente um ID" "$T/e" && cmp -s "$GR" "$T/gr.antes" && echo 0 || echo 1)
"$BIN" canal whatsapp grupo liberar 120363000000000004-group >/dev/null 2>&1
"$BIN" canal whatsapp grupo remover 120363000000000004-group >/dev/null 2>&1
cp "$GR" "$T/gr.antes-sync"
mkdir -p "$T/sync-falso"
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/sync-falso/sync"; chmod +x "$T/sync-falso/sync"
PATH="$T/sync-falso:$PATH" "$BIN" canal whatsapp grupo remover 120363000000000002-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: grupo remover com sync que falha sai com erro e nao confirma" $([ $c != 0 ] && ! grep -q "removido" "$T/o" && cmp -s "$GR" "$T/gr.antes-sync" && echo 0 || echo 1)
# ID ja ausente: o sync da pasta e feito; falha so na primeira chamada de sync (contador em arquivo)
rm -f "$T/sync-conta"
mkdir -p "$T/sync-uma-vez"
printf '#!/usr/bin/env bash\nif [ ! -e "%s" ]; then : > "%s"; exit 1; fi\nexit 0\n' "$T/sync-conta" "$T/sync-conta" > "$T/sync-uma-vez/sync"; chmod +x "$T/sync-uma-vez/sync"
PATH="$T/sync-uma-vez:$PATH" "$BIN" canal whatsapp grupo remover 120363000000000009-group >"$T/o" 2>"$T/e"; c1=$?
ok "whatsapp: remover ID ausente com sync que falha da erro de persistencia" $([ $c1 = 1 ] && grep -q "nao consegui confirmar no disco" "$T/e" && ! grep -q "confirmada no disco" "$T/e" && echo 0 || echo 1)
PATH="$T/sync-uma-vez:$PATH" "$BIN" canal whatsapp grupo remover 120363000000000009-group >"$T/o" 2>"$T/e"; c2=$?
ok "whatsapp: remover ID ausente de novo faz o sync e confirma a ausencia" $([ $c2 = 1 ] && grep -q "ausencia esta confirmada no disco" "$T/e" && echo 0 || echo 1)
# liberar: o sync da PASTA falha so na primeira vez (o do arquivo temporario passa); a segunda chamada, com o ID ja presente, faz o sync e confirma
rm -f "$T/sync-pasta-conta"
mkdir -p "$T/sync-pasta-uma-vez"
printf '#!/usr/bin/env bash\nif [ -d "$1" ] && [ ! -e "%s" ]; then : > "%s"; exit 1; fi\nexit 0\n' "$T/sync-pasta-conta" "$T/sync-pasta-conta" > "$T/sync-pasta-uma-vez/sync"; chmod +x "$T/sync-pasta-uma-vez/sync"
PATH="$T/sync-pasta-uma-vez:$PATH" "$BIN" canal whatsapp grupo liberar 120363000000000011-group >"$T/o" 2>"$T/e"; c1=$?
ok "whatsapp: liberar com o sync da pasta falhando sai com erro de persistencia" $([ $c1 = 1 ] && grep -q "nao consegui confirmar no disco" "$T/e" && ! grep -q "liberado\." "$T/o" && echo 0 || echo 1)
PATH="$T/sync-pasta-uma-vez:$PATH" "$BIN" canal whatsapp grupo liberar 120363000000000011-group >"$T/o" 2>"$T/e"; c2=$?
ok "whatsapp: liberar de novo com o ID ja presente faz o sync e sai com sucesso" $([ $c2 = 0 ] && grep -q "120363000000000011-group" "$T/o" && echo 0 || echo 1)
# sync da pasta falha nas duas: a segunda chamada (ID ja presente) tambem sai com erro
printf '#!/usr/bin/env bash\nif [ -d "$1" ]; then exit 1; fi\nexit 0\n' > "$T/sync-falso/sync"
"$BIN" canal whatsapp grupo remover 120363000000000011-group >/dev/null 2>&1
PATH="$T/sync-falso:$PATH" "$BIN" canal whatsapp grupo liberar 120363000000000012-group >"$T/o" 2>"$T/e"; c1=$?
PATH="$T/sync-falso:$PATH" "$BIN" canal whatsapp grupo liberar 120363000000000012-group >"$T/o" 2>"$T/e"; c2=$?
ok "whatsapp: liberar com o sync da pasta falhando nas duas chamadas falha nas duas" $([ $c1 = 1 ] && [ $c2 = 1 ] && grep -q "nao consegui confirmar no disco" "$T/e" && echo 0 || echo 1)
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/sync-falso/sync"
"$BIN" canal whatsapp grupo remover 120363000000000002-group >"$T/o" 2>&1; c=$?
ok "whatsapp: grupo remover funciona" $([ $c = 0 ] && grep -q "removido" "$T/o" && ! grep -q "000002-group" "$GR" && grep -q "000001-group" "$GR" && echo 0 || echo 1)
"$BIN" canal whatsapp grupo remover 120363000000000009-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: remover grupo ausente da erro claro" $([ $c = 1 ] && grep -q "nao esta na lista" "$T/e" && echo 0 || echo 1)
echo '{"grupos":' > "$GR"
for sub in listar "liberar 120363000000000003-group" "remover 120363000000000001-group"; do
  # shellcheck disable=SC2086
  "$BIN" canal whatsapp grupo $sub >"$T/o" 2>"$T/e"; c=$?
  ok "whatsapp: grupo $sub com arquivo ilegivel recusa" $([ $c = 1 ] && grep -q "nao e uma lista valida" "$T/e" && echo 0 || echo 1)
done
[ "$(cat "$GR")" = '{"grupos":' ]; ok "whatsapp: arquivo ilegivel de grupos nao e sobrescrito" $?
# entrada malformada na lista: recusa sem alterar e aponta o indice, sem imprimir o valor
CHAVE_SEGREDO="tok""en"
printf '{"versao":1,"grupos":[{"id":"120363000000000001-group"},{"id":"valor-secreto-%s"}]}' "$CHAVE_SEGREDO" > "$GR"
cp "$GR" "$T/gr.antes"
"$BIN" canal whatsapp grupo liberar 120363000000000003-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: lista com entrada malformada recusa e aponta a entrada 2" $([ $c = 1 ] && grep -q "entrada 2" "$T/e" && ! grep -q "valor-secreto" "$T/e" "$T/o" && cmp -s "$GR" "$T/gr.antes" && echo 0 || echo 1)
# versao desconhecida: recusa sem gravar
echo '{"versao":2,"grupos":[]}' > "$GR"; cp "$GR" "$T/gr.antes"
"$BIN" canal whatsapp grupo liberar 120363000000000003-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: versao 2 da lista e recusada sem gravar" $([ $c = 1 ] && grep -q "versao" "$T/e" && cmp -s "$GR" "$T/gr.antes" && echo 0 || echo 1)
# campos extras do raiz e da entrada sobrevivem a liberar e a remover
echo '{"versao":1,"dono_nota":"fica","grupos":[{"id":"120363000000000001-group","nome":"A","liberado_em":"x","extra":42}]}' > "$GR"
"$BIN" canal whatsapp grupo liberar 120363000000000002-group >/dev/null 2>&1
"$BIN" canal whatsapp grupo remover 120363000000000002-group >/dev/null 2>&1
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(d.versao===1&&d.dono_nota==="fica"&&d.grupos.length===1&&d.grupos[0].extra===42?0:1)' "$GR"
ok "whatsapp: campos extras sobrevivem a liberar e remover" $?
# liberar e remover ao mesmo tempo: a revogacao nunca e desfeita
falhou=0
for rodada in 1 2 3 4 5 6 7 8; do
  echo '{"versao":1,"grupos":[{"id":"120363000000000001-group","nome":"A","liberado_em":"x"}]}' > "$GR"
  "$BIN" canal whatsapp grupo remover 120363000000000001-group >/dev/null 2>&1 &
  p1=$!
  "$BIN" canal whatsapp grupo liberar 120363000000000002-group >/dev/null 2>&1 &
  p2=$!
  wait "$p1" "$p2"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).grupos.map((g)=>g.id);process.exit(d.length===1&&d[0]==="120363000000000002-group"?0:1)' "$GR" || falhou=1
done
ok "whatsapp: remover A e liberar B em paralelo mantem A revogado e B liberado" $falhou
[ -f "$HOME/.dgclaw/whatsapp-grupos.trava" ] && [ ! -e "$GR.trava" ]; ok "whatsapp: a trava da lista e um arquivo estavel fora da pasta whatsapp" $?
"$BIN" canal whatsapp grupo >"$T/o" 2>"$T/e"; ok "whatsapp: grupo sem subcomando mostra o uso" $([ $? = 1 ] && grep -q "listar | liberar" "$T/e" && echo 0 || echo 1)
DGCLAW_TIPO=admin "$BIN" canal whatsapp grupo listar >/dev/null 2>&1; ok "whatsapp: admin nao mexe nos grupos (codigo 2)" $([ $? = 2 ] && echo 0 || echo 1)
rm -f "$GR"

# lista que e link simbolico: a CLI recusa, o link continua link e o alvo fica intacto
echo '{"versao":1,"grupos":[{"id":"120363000000000001-group","nome":"Antigo","liberado_em":"x"}]}' > "$T/lista-antiga.json"
cp "$T/lista-antiga.json" "$T/lista-antiga.antes"; ln -s "$T/lista-antiga.json" "$GR"
"$BIN" canal whatsapp grupo liberar 120363000000000005-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: lista que e link simbolico recusa liberar, o link fica e o alvo nao muda" $([ $c = 1 ] && [ -L "$GR" ] && grep -q "link simbolico" "$T/e" && cmp -s "$T/lista-antiga.json" "$T/lista-antiga.antes" && echo 0 || echo 1)
rm -f "$GR"
# FIFO no caminho da lista: recusa sem travar
mkfifo "$GR"
timeout 15 "$BIN" canal whatsapp grupo liberar 120363000000000005-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: lista que e FIFO recusa sem travar" $([ $c = 1 ] && grep -q "nao e um arquivo comum" "$T/e" && echo 0 || echo 1)
rm -f "$GR"
# liberar de novo um grupo ja liberado, com lista grande (saida maior que o pipe): a saida vem inteira
node -e 'const g=[];for(let i=0;i<3000;i++)g.push({id:"1203630000"+String(10000+i)+"-group",nome:"Grupo numero "+i,liberado_em:"x"});require("fs").writeFileSync(process.argv[1],JSON.stringify({versao:1,grupos:g}))' "$GR"
"$BIN" canal whatsapp grupo liberar 120363000010000-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: liberar de novo com lista grande mostra a lista inteira" $([ $c = 0 ] && grep -q "3000 grupos\|3000" "$T/o" && grep -q "120363000012999-group" "$T/o" && grep -q "ja estava liberado" "$T/e" && echo 0 || echo 1)
rm -f "$GR"
# falha de escrita (cat falso que falha): a lista anterior fica igual e a CLI sai com erro
echo '{"versao":1,"grupos":[{"id":"120363000000000001-group","nome":"A","liberado_em":"x"}]}' > "$GR"; cp "$GR" "$T/gr.antes"
mkdir -p "$T/cat-falso"; printf '#!/bin/sh\nexit 1\n' > "$T/cat-falso/cat"; chmod +x "$T/cat-falso/cat"
PATH="$T/cat-falso:$PATH" "$BIN" canal whatsapp grupo liberar 120363000000000006-group >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: falha ao escrever a lista sai com erro e mantem a lista anterior" $([ $c != 0 ] && cmp -s "$GR" "$T/gr.antes" && ! ls "$WA"/grupos-liberados.json.* >/dev/null 2>&1 && echo 0 || echo 1)
# desligar --apagar pega a mesma trava da lista: com a trava presa, ele espera; solta, e apaga
rm -f "$GR"; echo '{"versao":1,"grupos":[]}' > "$GR"
TRAVA="$HOME/.dgclaw/whatsapp-grupos.trava"
mkfifo "$T/solta"
( flock -x 9; echo preso > "$T/preso"; read -r _ < "$T/solta" ) 9>>"$TRAVA" &
LP=$!
for _ in $(seq 50); do [ -e "$T/preso" ] && break; sleep 0.1; done
"$BIN" canal whatsapp desligar --apagar >"$T/o" 2>"$T/e" &
DP=$!
sleep 1
[ -d "$WA" ] && kill -0 "$DP" 2>/dev/null; ok "whatsapp: desligar --apagar espera a trava da lista" $?
echo ok > "$T/solta"; wait "$LP" "$DP"
[ ! -e "$WA" ]; ok "whatsapp: desligar --apagar apaga depois que a trava e solta" $?
rm -f "$T/preso"
# alteracao que estava esperando a trava quando a pasta foi apagada: aborta e nao recria a pasta
mkdir -p "$WA"; chmod 700 "$HOME/.dgclaw" "$WA"; echo '{"versao":1,"grupos":[]}' > "$GR"
( flock -x 9; echo preso > "$T/preso"; read -r _ < "$T/solta" ) 9>>"$TRAVA" &
LP=$!
for _ in $(seq 50); do [ -e "$T/preso" ] && break; sleep 0.1; done
"$BIN" canal whatsapp grupo liberar 120363000000000007-group >"$T/o" 2>"$T/e" &
AP=$!
sleep 1
rm -rf "$WA"
echo ok > "$T/solta"; wait "$LP"; wait "$AP"; c=$?
ok "whatsapp: alteracao que esperava a trava nao recria a pasta apagada" $([ $c = 1 ] && [ ! -e "$WA" ] && grep -q "foi apagada" "$T/e" && echo 0 || echo 1)
rm -f "$T/preso" "$T/solta"
# pasta apagada e RECRIADA enquanto a alteracao espera a trava: aborta e a pasta nova fica sem a lista
mkfifo "$T/solta"
mkdir -p "$WA"; chmod 700 "$HOME/.dgclaw" "$WA"; echo '{"versao":1,"grupos":[]}' > "$GR"
( flock -x 9; echo preso > "$T/preso"; read -r _ < "$T/solta" ) 9>>"$TRAVA" &
LP=$!
for _ in $(seq 50); do [ -e "$T/preso" ] && break; sleep 0.1; done
"$BIN" canal whatsapp grupo liberar 120363000000000008-group >"$T/o" 2>"$T/e" &
AP=$!
sleep 1
# apaga antes de recriar: sem o descritor aberto o sistema de arquivos poderia reaproveitar o inode
rm -rf "$WA"; mkdir "$WA"; chmod 700 "$WA"
echo ok > "$T/solta"; wait "$LP"; wait "$AP"; c=$?
ok "whatsapp: pasta recriada durante a espera aborta e fica sem a lista" $([ $c = 1 ] && [ ! -e "$GR" ] && grep -q "foi apagada" "$T/e" && echo 0 || echo 1)
rm -rf "$WA"; rm -f "$T/preso" "$T/solta"

# ligar com sessao mas sem lista; depois com tudo
mkdir -p "$WA/sessao"; echo '{"registered": true}' > "$WA/sessao/creds.json"
"$BIN" canal whatsapp ligar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: ligar sem lista recusa" $([ $c = 1 ] && grep -q "permitir" "$T/e" && echo 0 || echo 1)
"$BIN" canal whatsapp permitir 11987654321 >/dev/null 2>&1
: > "$SC_LOG"
"$BIN" canal whatsapp ligar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: ligar funciona" $([ $c = 0 ] && echo 0 || echo 1)
grep -q "WhatsApp ligado." "$T/o" && grep -q "numero pessoal" "$T/o"; ok "whatsapp: ligar avisa como testar" $?
grep -qx "enable --now dgclaw-whatsapp" "$SC_LOG"; ok "whatsapp: ligar chamou enable --now" $?
[ -f "$WA/ligado" ] && [ "$(stat -c %a "$WA/ligado")" = 600 ]; ok "whatsapp: arquivo 'ligado' criado com 600" $?

# ligar com systemctl falhando apaga 'ligado'
rm -f "$WA/ligado"; touch "$SC_FALHA"
"$BIN" canal whatsapp ligar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: systemctl falho faz ligar falhar" $([ $c = 1 ] && grep -q "journalctl -u dgclaw-whatsapp" "$T/e" && echo 0 || echo 1)
[ ! -e "$WA/ligado" ]; ok "whatsapp: ligar falho apaga 'ligado'" $?
rm -f "$SC_FALHA"
"$BIN" canal whatsapp ligar >/dev/null 2>&1

# status
printf '{"versao":1,"estado":"conectado","desde":"2026-10-12T10:00:00.000Z","numero_bot":"+5511912345678","motivo":null}\n' > "$WA/estado.json"
echo '{"codigo":"ZZZZ-9999"}' > "$WA/codigo.txt"; echo "ZZZZ-9999" > "$WA/codigo"
touch "$SC_ATIVO"
"$BIN" canal status >"$T/o" 2>&1
grep -q "WhatsApp: ligado" "$T/o" && grep -q "estado: conectado" "$T/o" && grep -q "+5511912345678" "$T/o" && grep -q "permitidos: +5511987654321" "$T/o"; ok "whatsapp: status mostra ligado, estado, numero e permitidos" $?
! grep -q "ZZZZ-9999\|NAO-MOSTRAR\|registered" "$T/o"; ok "whatsapp: status nunca mostra codigo nem sessao" $?
rm -f "$SC_ATIVO"
"$BIN" canal status >"$T/o" 2>&1; grep -q "unidade nao esta rodando" "$T/o"; ok "whatsapp: status avisa ligado sem unidade ativa" $?
rm -f "$WA/codigo" "$WA/codigo.txt"

# desligar
: > "$SC_LOG"
"$BIN" canal whatsapp desligar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: desligar funciona" $([ $c = 0 ] && echo 0 || echo 1)
grep -qx "disable --now dgclaw-whatsapp" "$SC_LOG"; ok "whatsapp: desligar chamou disable --now" $?
[ ! -e "$WA/ligado" ] && [ -f "$WA/permitidos.json" ]; ok "whatsapp: desligar apaga 'ligado' e mantem a lista" $?
touch "$SC_FALHA"
"$BIN" canal whatsapp desligar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: falha do systemctl ao desligar vira aviso" $([ $c = 0 ] && grep -q "aviso" "$T/e" && echo 0 || echo 1)
rm -f "$SC_FALHA"

# desligar --apagar: logout e apaga a pasta; recusa atalho
: > "$PONTE_FALSA_LOG"
"$BIN" canal whatsapp desligar --apagar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: desligar --apagar funciona" $([ $c = 0 ] && echo 0 || echo 1)
grep -qx "logout" "$PONTE_FALSA_LOG"; ok "whatsapp: --apagar chamou o logout da ponte" $?
[ ! -e "$WA" ]; ok "whatsapp: --apagar apagou a pasta" $?
grep -q "uploads/whatsapp" "$T/o"; ok "whatsapp: --apagar avisa que os uploads ficaram" $?
# sync da pasta falha depois do rm: nao confirma a exclusao
mkdir -p "$WA"; echo '{"versao":1,"grupos":[]}' > "$WA/grupos-liberados.json"
PATH="$T/sync-falso:$PATH" "$BIN" canal whatsapp desligar --apagar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: --apagar com sync que falha sai com erro e nao confirma a exclusao" $([ $c != 0 ] && ! grep -q "dados apagados" "$T/o" && grep -q "confirmar no disco" "$T/e" && echo 0 || echo 1)
# pasta ja inexistente: ainda faz o sync da pasta pai, e so confirma se ele der certo (duas chamadas seguidas)
rm -rf "$WA"
PATH="$T/sync-falso:$PATH" "$BIN" canal whatsapp desligar --apagar >"$T/o" 2>"$T/e"; c1=$?
PATH="$T/sync-falso:$PATH" "$BIN" canal whatsapp desligar --apagar >"$T/o" 2>"$T/e"; c2=$?
ok "whatsapp: --apagar com a pasta ja apagada e sync falso falha nas duas chamadas seguidas" $([ $c1 != 0 ] && [ $c2 != 0 ] && echo 0 || echo 1)
mkdir -p "$T/alvo/sessao"; echo '{"registered": true}' > "$T/alvo/sessao/creds.json"; ln -s "$T/alvo" "$WA"
"$BIN" canal whatsapp desligar --apagar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: --apagar recusa pasta que e atalho" $([ $c = 1 ] && [ -f "$T/alvo/sessao/creds.json" ] && echo 0 || echo 1)
rm -f "$WA"
# $HOME/.dgclaw atalho para outra pasta: o rm -rf apagaria a pasta errada
mv "$HOME/.dgclaw" "$T/dgclaw-real"; mkdir -p "$T/outro/whatsapp/sessao"; echo '{"registered": true}' > "$T/outro/whatsapp/sessao/creds.json"
ln -s "$T/outro" "$HOME/.dgclaw"
"$BIN" canal whatsapp desligar --apagar >"$T/o" 2>"$T/e"; c=$?
ok "whatsapp: --apagar recusa quando um pedaco do caminho e atalho" $([ $c = 1 ] && [ -f "$T/outro/whatsapp/sessao/creds.json" ] && grep -q "atalho" "$T/e" && echo 0 || echo 1)
rm -f "$HOME/.dgclaw"; mv "$T/dgclaw-real" "$HOME/.dgclaw"
"$BIN" canal status >"$T/o" 2>&1; grep -q "WhatsApp: desligado (nao configurado)" "$T/o"; ok "whatsapp: status depois de apagar" $?

# token nunca apareceu no argv de nenhum processo
kill $MON 2>/dev/null; wait $MON 2>/dev/null
[ ! -s "$T/ps.txt" ]; ok "token nunca apareceu no ps" $?

echo "---"; echo "$((N-FALHAS))/$N passaram"
[ $FALHAS = 0 ]
