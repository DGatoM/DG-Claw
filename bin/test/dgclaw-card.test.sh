#!/usr/bin/env bash
# Teste do dgclaw-card com um runner falso (falso-runner.js). Uso: bash bin/test/dgclaw-card.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$AQUI/../dgclaw-card"
T="$(mktemp -d)"
SRV=""
trap '[ -z "$SRV" ] || kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
FALHAS=0; N=0
ok() { N=$((N+1)); if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FALHOU $1"; FALHAS=$((FALHAS+1)); fi; }

RUNNER_FAKE="runner-segredo-de-teste-card-123"
export LOG="$T/log.jsonl" PORTA_ARQ="$T/porta" RUNNER_BEARER="$RUNNER_FAKE"
printf '%s\n' "$RUNNER_FAKE" > "$T/runner.tok"
export RUNNER_TOKEN_FILE="$T/runner.tok" DGCLAW_CARD_INTERVALO=0.2
export HOME="$T/casa"; mkdir -p "$HOME"

subir() { # $1 = modo do runner falso
  [ -z "$SRV" ] || { kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; }
  rm -f "$PORTA_ARQ"; : > "$LOG"
  MODO="$1" node "$AQUI/falso-runner.js" & SRV=$!
  for _ in $(seq 50); do [ -s "$PORTA_ARQ" ] && break; sleep 0.1; done
  export RUNNER_PORT="$(cat "$PORTA_ARQ")"
}
sem_segredo() { ! grep -qF "$RUNNER_FAKE" "$@"; }

# --- fluxo normal: abrir, esperar, ler, listar, fechar -------------------------------------------
subir normal
( for _ in $(seq 300); do ps -eo args | grep -F "$RUNNER_FAKE" | grep -v grep >> "$T/ps.txt"; sleep 0.02; done ) & MON=$!
"$BIN" abrir --provedor codex --titulo "Revisao" --pedido 'Revise o arquivo "a.md" com \barra e acento: ação' >"$T/o" 2>"$T/e"; c=$?
ok "abrir sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
[ "$(head -1 "$T/o")" = "card-abc123" ]; ok "abrir imprime o id na primeira linha" $?
grep -q "dgclaw-card esperar card-abc123" "$T/o"; ok "abrir diz como acompanhar" $?
node -e '
  const l = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
  const a = l[0], b = l[1];
  const ca = JSON.parse(a.corpo), cb = JSON.parse(b.corpo);
  const certo = a.metodo === "POST" && a.url === "/api/sessoes" && ca.tipo === "card" && ca.provedor === "codex" && ca.titulo === "Revisao" && !("auth" in ca)
    && b.metodo === "POST" && b.url === "/api/agents/card-abc123/input" && cb.submit === true
    && cb.text === "Revise o arquivo \"a.md\" com \\barra e acento: ação";
  process.exit(certo ? 0 : 1)' "$LOG"
ok "abrir faz POST /api/sessoes e depois /input com o pedido intacto (aspas, barra, acento)" $?
# O token vai pelo ambiente: no argv, o monitor do ps (que ainda roda aqui) o pegaria e a conferencia do ps falharia sozinha.
TOKEN_ESPERADO="$RUNNER_FAKE" node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);process.exit(l.length>=2&&l.every(x=>x.auth==="Bearer "+process.env.TOKEN_ESPERADO)?0:1)' "$LOG"
ok "o Bearer chega certo em todas as chamadas" $?

"$BIN" esperar card-abc123 --max 20 >"$T/o2" 2>"$T/e2"; c=$?
ok "esperar sai com 0 quando o turno acaba" $([ $c = 0 ] && echo 0 || echo 1)
"$BIN" ler card-abc123 --n 2 >"$T/o3" 2>"$T/e3"; c=$?
ok "ler sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
grep -q "^\[resposta\]" "$T/o3" && grep -q "Resposta do card sobre" "$T/o3"; ok "ler mostra a resposta do assistente" $?
"$BIN" estado card-abc123 >"$T/o4" 2>"$T/e4"; c=$?
grep -q "provedor: codex | auth: assinatura" "$T/o4" && grep -q "titulo: Revisao" "$T/o4"; ok "estado mostra provedor, auth e titulo" $?
"$BIN" listar >"$T/o5" 2>"$T/e5"
[ "$(wc -l < "$T/o5")" = 1 ] && grep -q "^card-abc123	Revisao	codex	idle$" "$T/o5"; ok "listar mostra so os cards (nao a principal nem os bastidores)" $?
"$BIN" fechar card-abc123 >"$T/o6" 2>"$T/e6"; c=$?
ok "fechar sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
grep -q '"metodo":"DELETE","url":"/api/sessoes/card-abc123"' "$LOG"; ok "fechar faz DELETE /api/sessoes/<id>" $?
"$BIN" listar 2>&1 | grep -q "Nenhum card aberto"; ok "listar depois de fechar diz que nao ha cards" $?
kill $MON 2>/dev/null; wait $MON 2>/dev/null
sem_segredo "$T"/o "$T"/e "$T"/o[2-6] "$T"/e[2-6]; ok "o token nao aparece em nenhuma saida" $?
[ ! -s "$T/ps.txt" ]; ok "o token nao aparece no ps enquanto o curl roda" $?

# --- pedido pelo stdin, mandar --------------------------------------------------------------------
subir normal
printf 'pedido pelo pipe' | "$BIN" abrir --provedor claude --auth api --modelo m1 --titulo "Pipe" >"$T/o" 2>"$T/e"; c=$?
ok "abrir aceita o pedido pelo stdin" $([ $c = 0 ] && echo 0 || echo 1)
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const a=JSON.parse(l[0].corpo);process.exit(a.auth==="api"&&a.modelo==="m1"&&a.provedor==="claude"&&JSON.parse(l[1].corpo).text==="pedido pelo pipe"?0:1)' "$LOG"
ok "auth e modelo vao no corpo; o texto do pipe vira o pedido" $?
printf 'mais um detalhe' > "$T/extra.txt"
"$BIN" mandar card-abc123 --arquivo "$T/extra.txt" >"$T/o" 2>"$T/e"; c=$?
ok "mandar --arquivo funciona" $([ $c = 0 ] && echo 0 || echo 1)
tail -1 "$LOG" | grep -q 'mais um detalhe'; ok "mandar entrega o texto do arquivo" $?

# --- esperar estourando o tempo -------------------------------------------------------------------
subir nunca-termina
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
DGCLAW_CARD_INTERVALO=0.3 "$BIN" esperar card-abc123 --max 1 >"$T/o" 2>"$T/e"; c=$?
ok "esperar estourando o tempo sai com 7" $([ $c = 7 ] && echo 0 || echo 1)
grep -q "segue trabalhando" "$T/e"; ok "esperar diz que a sessao segue trabalhando" $?

# --- o pedido nao vira turno (202 enfileirado, mas o CLI nunca aceita) -----------------------------
subir sem-turno
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "pedido que nao vira turno sai com 9" $([ $c = 9 ] && echo 0 || echo 1)
grep -q "card card-abc123 foi criado" "$T/e" && grep -q "NAO esta trabalhando" "$T/e" && grep -q "dgclaw-card estado card-abc123" "$T/e" && grep -q "nao reenvie por conta propria" "$T/e" && ! grep -q "reenvie com" "$T/e"; ok "a mensagem diz o id, que nao esta trabalhando, e manda conferir sem reenviar" $?
! grep -q "Card aberto" "$T/o"; ok "sem turno nao imprime 'Card aberto'" $?
"$BIN" estado card-abc123 >"$T/o" 2>"$T/e"; grep -q "sem primeiro turno ainda" "$T/o"; ok "estado de card sem turno diz 'sem primeiro turno ainda'" $?
"$BIN" ler card-abc123 >"$T/o" 2>"$T/e"; grep -q "ainda nao virou turno" "$T/o" && grep -q "NAO esta trabalhando" "$T/o"; ok "ler de card sem turno diz o motivo (e nao so 'sem mensagens')" $?
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar card sem turno recusa com 10" $([ $c = 10 ] && echo 0 || echo 1)
grep -q -- "--forcar" "$T/e" && grep -q "jogar o pedido fora" "$T/e"; ok "a recusa explica e pede --forcar" $?
! grep -q '"metodo":"DELETE"' "$LOG"; ok "a recusa nao chamou o DELETE" $?
"$BIN" fechar card-abc123 --forcar >"$T/o" 2>"$T/e"; c=$?
ok "fechar --forcar fecha" $([ $c = 0 ] && echo 0 || echo 1)
grep -q '"metodo":"DELETE","url":"/api/sessoes/card-abc123"' "$LOG"; ok "--forcar faz o DELETE" $?

# --- o pedido vira turno depois de ~2 s: abrir espera e sai com 0 ---------------------------------
subir turno-lento
"$BIN" abrir --provedor codex --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "pedido que vira turno em ~2 s sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
[ "$(head -1 "$T/o")" = "card-abc123" ] && grep -q "Card aberto" "$T/o"; ok "com turno, a saida e a de sempre" $?
subir sem-turno
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 0 >"$T/o" 2>"$T/e"; c=$?
ok "--espera-turno 0 desliga a espera (saida 0 mesmo sem turno)" $([ $c = 0 ] && echo 0 || echo 1)
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno abc >/dev/null 2>&1; ok "--espera-turno invalido recusado" $([ $? = 1 ] && echo 0 || echo 1)

# --- 9 com --monitor: o monitor ja foi cadastrado antes da espera -----------------------------------
# Estado e log do monitor ficam no diretorio temporario do teste, nunca no HOME real (nenhum outro teste da
# bateria chama o monitor: so os que passam --monitor, todos abaixo desta linha).
export DGCLAW_MONITOR_ESTADO="$T/monitor/estado.json" DGCLAW_MONITOR_LOG="$T/monitor/log"
subir sem-turno
rm -rf "$T/monitor"
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 1 --monitor --entregue "relatorio salvo" >"$T/o" 2>"$T/e"; c=$?
ok "9 com --monitor sai com 9" $([ $c = 9 ] && echo 0 || echo 1)
grep -q "card-abc123" "$DGCLAW_MONITOR_ESTADO" 2>/dev/null; ok "o monitor ficou cadastrado mesmo no caminho do 9" $?
grep -q "Monitorando o card card-abc123" "$T/e"; ok "o caminho do 9 diz que o monitor esta ligado" $?

# --- falha ao cadastrar o monitor: erro explicito (8) com o que fazer ------------------------------
subir normal
rm -rf "$T/monitor"
DGCLAW_MONITOR_DONO=card-abc123 "$BIN" abrir --provedor codex --titulo x --pedido oi --monitor --entregue "feito" >"$T/o" 2>"$T/e"; c=$?
ok "monitor que nao liga sai com 8" $([ $c = 8 ] && echo 0 || echo 1)
grep -q "monitor NAO ligou" "$T/e" && grep -q "dgclaw-monitor add card-abc123" "$T/e"; ok "a falha do monitor diz o motivo e o comando para ligar a mao" $?
! grep -q "Card aberto" "$T/o"; ok "monitor que falhou nao imprime 'Card aberto'" $?

# --- nao deu para observar o estado: 11, nunca 9 nem 0 ---------------------------------------------
subir leitura-403
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 1 >"$T/o" 2>"$T/e"; c=$?
ok "estado recusado (403) sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
grep -q "nao consegui confirmar se o card card-abc123 aceitou o pedido" "$T/e" && grep -q "HTTP 403" "$T/e" && grep -q "dgclaw-card estado card-abc123" "$T/e"; ok "a mensagem do 11 traz o motivo e o que fazer" $?
! grep -q "Card aberto" "$T/o"; ok "11 nao imprime 'Card aberto'" $?
subir leitura-503
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 1 >"$T/o" 2>"$T/e"; c=$?
ok "estado com erro 503 sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
subir sem-contador
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 5 >"$T/o" 2>"$T/e"; c=$?
ok "200 sem o contador turnosAceitos sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
grep -q "turnosAceitos" "$T/e"; ok "o 11 sem contador cita o contador" $?
subir leitura-403
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 1 --monitor --entregue "feito" >"$T/o" 2>"$T/e"; c=$?
ok "11 com --monitor sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
grep -q "card-abc123" "$DGCLAW_MONITOR_ESTADO" 2>/dev/null; ok "o monitor tambem ficou cadastrado no caminho do 11" $?

# --- fechar sem prova de turno: consulta falhou ou sem contador -> 10 ----------------------------------
subir leitura-503
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 0 >/dev/null 2>&1
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar com a leitura em 503 recusa com 10" $([ $c = 10 ] && echo 0 || echo 1)
grep -q -- "--forcar" "$T/e" && grep -q "HTTP 503" "$T/e"; ok "a recusa por 503 diz o motivo e pede --forcar" $?
! grep -q '"metodo":"DELETE"' "$LOG"; ok "recusa por 503 nao chamou o DELETE" $?
"$BIN" fechar card-abc123 --forcar >/dev/null 2>&1; ok "--forcar fecha mesmo sem conseguir ler" $?
subir sem-contador
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 0 >/dev/null 2>&1
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar com resposta sem contador recusa com 10" $([ $c = 10 ] && echo 0 || echo 1)
grep -q "turnosAceitos" "$T/e"; ok "a recusa sem contador cita o contador" $?
subir normal
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar card que teve turno fecha sem --forcar" $([ $c = 0 ] && echo 0 || echo 1)

# --- fechar: so o pedido do usuario na conversa nao prova turno; resposta do agente (runner reiniciado) prova ---
subir so-pedido
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 0 >/dev/null 2>&1
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar com so o pedido do usuario na conversa recusa com 10" $([ $c = 10 ] && echo 0 || echo 1)
! grep -q '"metodo":"DELETE"' "$LOG"; ok "so o pedido do usuario: nenhum DELETE" $?
subir restaurado
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 0 >/dev/null 2>&1
"$BIN" estado card-abc123 >"$T/o" 2>"$T/e"; ! grep -q "sem primeiro turno" "$T/o"; ok "estado de card restaurado (resposta do agente na conversa) nao diz 'sem primeiro turno'" $?
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar card restaurado com resposta do agente fecha sem --forcar" $([ $c = 0 ] && echo 0 || echo 1)

# --- abrir: card em erro depois de aceitar o pedido sai com 12 ----------------------------------------------
subir erro-turno
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "pedido aceito e turno que falhou (errored) sai com 12" $([ $c = 12 ] && echo 0 || echo 1)
grep -q "aceitou o pedido, mas o turno falhou" "$T/e" && grep -q "dgclaw-card ler card-abc123" "$T/e"; ok "o 12 diz o que houve e manda ler" $?
! grep -q "Card aberto" "$T/o"; ok "12 nao imprime 'Card aberto'" $?

# --- espera: consulta que demora mais que o prazo e limitada, e sai com 11 ------------------------------------
subir lento-leitura
ini=$SECONDS
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
dur=$((SECONDS - ini))
ok "consulta que demora sai com 11 (e nao 9)" $([ $c = 11 ] && echo 0 || echo 1)
ok "a espera respeita o prazo (levou ${dur}s, menos que a demora de 6 s da consulta)" $([ "$dur" -le 5 ] && echo 0 || echo 1)

# --- limite (429) ---------------------------------------------------------------------------------
subir limite
"$BIN" abrir --provedor codex --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "429 sai com 4" $([ $c = 4 ] && echo 0 || echo 1)
grep -q "limite e 3" "$T/e" && grep -q "dgclaw-card fechar" "$T/e" && grep -q "RUNNER_MAX_SESSOES_EXTRAS" "$T/e"; ok "429 vira a frase do limite com o que fazer" $?

# --- sem login ------------------------------------------------------------------------------------
subir sem-login
"$BIN" abrir --provedor codex --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "sem login sai com 5" $([ $c = 5 ] && echo 0 || echo 1)
grep -q "o Codex deste agente ainda nao esta conectado" "$T/e" && grep -q "cartao Modelo e autenticacao" "$T/e"; ok "sem login vira a frase para o dono" $?
grep -q '"metodo":"DELETE"' "$LOG"; ok "sem login fecha o card recem criado (nao ocupa vaga)" $?

# --- input falha depois de criar ------------------------------------------------------------------
subir input-falha
"$BIN" abrir --provedor claude --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "input que falha sai com 6" $([ $c = 6 ] && echo 0 || echo 1)
grep -q "card card-abc123 foi criado" "$T/e" && grep -q "dgclaw-card fechar card-abc123" "$T/e"; ok "diz que o card existe e como reenviar ou fechar" $?

# --- Bearer errado (401) e arquivo ausente --------------------------------------------------------
subir normal
printf 'outro-valor-qualquer\n' > "$T/ruim.tok"
RUNNER_TOKEN_FILE="$T/ruim.tok" "$BIN" listar >"$T/o" 2>"$T/e"; c=$?
ok "401 sai com 3" $([ $c = 3 ] && echo 0 || echo 1)
grep -q "recusou o acesso" "$T/e"; ok "401 vira a frase do token" $?
sem_segredo "$T/o" "$T/e"; ok "o valor certo nao vaza no 401" $?
: > "$T/vazio.tok"
RUNNER_TOKEN_FILE="$T/vazio.tok" "$BIN" listar >"$T/o" 2>"$T/e"; c=$?
ok "arquivo vazio sai com 3" $([ $c = 3 ] && echo 0 || echo 1)
grep -q "esta vazio" "$T/e"; ok "arquivo vazio e explicado" $?
env -u RUNNER_TOKEN_FILE "$BIN" listar >"$T/o" 2>"$T/e"; c=$?
ok "sem RUNNER_TOKEN_FILE sai com 3" $([ $c = 3 ] && echo 0 || echo 1)

# --- runner fora do ar e porta invalida -----------------------------------------------------------
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; SRV=""
"$BIN" listar >"$T/o" 2>"$T/e"; c=$?
ok "runner fora do ar sai com 2" $([ $c = 2 ] && echo 0 || echo 1)
grep -q "o runner deste agente nao respondeu" "$T/e"; ok "runner fora vira a frase certa" $?
RUNNER_PORT=abc "$BIN" listar >"$T/o" 2>"$T/e"; c=$?
ok "RUNNER_PORT nao numerico e recusado" $([ $c = 1 ] && echo 0 || echo 1)
grep -q "RUNNER_PORT precisa ser um numero" "$T/e"; ok "a recusa da porta explica" $?
RUNNER_PORT="80; rm" "$BIN" listar >/dev/null 2>&1; ok "RUNNER_PORT com lixo e recusado" $([ $? = 1 ] && echo 0 || echo 1)

# --- o endereco e fixo ----------------------------------------------------------------------------
subir normal
DGCLAW_RUNNER_URL="http://127.0.0.1:1" "$BIN" listar >/dev/null 2>&1; c=$?
ok "DGCLAW_RUNNER_URL e ignorada (continua falando com 127.0.0.1:RUNNER_PORT)" $([ $c = 0 ] && echo 0 || echo 1)

# --- uso ------------------------------------------------------------------------------------------
"$BIN" abrir --provedor gemini --titulo x --pedido y >/dev/null 2>"$T/e"; ok "provedor desconhecido recusado" $([ $? = 1 ] && echo 0 || echo 1)
"$BIN" abrir --provedor codex --pedido y >/dev/null 2>"$T/e"; ok "abrir sem titulo recusado" $([ $? = 1 ] && echo 0 || echo 1)
"$BIN" fechar "../x" >/dev/null 2>"$T/e"; ok "id com barra recusado" $([ $? = 1 ] && echo 0 || echo 1)
"$BIN" ajuda 2>&1 | grep -q "Codigos de saida"; ok "ajuda mostra os codigos de saida" $?
"$BIN" nada >/dev/null 2>&1; ok "subcomando desconhecido recusado" $([ $? = 1 ] && echo 0 || echo 1)

echo
echo "$N verificacoes, $FALHAS falha(s)"
[ "$FALHAS" = 0 ]
