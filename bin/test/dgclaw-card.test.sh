#!/usr/bin/env bash
# Teste do dgclaw-card com um runner falso (falso-runner.js). Uso: bash bin/test/dgclaw-card.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$AQUI/../dgclaw-card"
T="$(mktemp -d)" || exit 1
SRV=""
trap '[ -z "$SRV" ] || kill $SRV 2>/dev/null; rm -rf "${T:?}"' EXIT
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
grep -q "nao terminou o turno nesse prazo" "$T/e" && ! grep -q "segue trabalhando" "$T/e"; ok "esperar estourado diz so que o prazo passou, sem afirmar que trabalha" $?

# --- o pedido nao vira turno (202 enfileirado, mas o CLI nunca aceita) -----------------------------
subir sem-turno
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "pedido que nao vira turno sai com 9" $([ $c = 9 ] && echo 0 || echo 1)
grep -q "card card-abc123 foi criado" "$T/e" && grep -q "nao observou o primeiro turno" "$T/e" && grep -q "nao prova que o card esteja parado" "$T/e" && ! grep -qi "NAO esta trabalhando" "$T/e" && grep -q "dgclaw-card estado card-abc123" "$T/e" && grep -q "nao reenvie por conta propria" "$T/e" && ! grep -q "reenvie com" "$T/e"; ok "a mensagem diz o id, que o runner nao observou o turno (sem afirmar que esta parado), e manda conferir sem reenviar" $?
! grep -q "Card aberto" "$T/o"; ok "sem turno nao imprime 'Card aberto'" $?
[ "$(head -1 "$T/o")" = "card-abc123" ] && [ "$(grep -c "card-abc123" "$T/o")" = 1 ]; ok "no 9 o id sai uma vez so, na primeira linha do stdout" $?
subir sem-turno
"$BIN" abrir --provedor claude --titulo x --pedido oi --espera-turno 2 >/dev/null 2>"$T/e2"; c=$?
ok "Claude com hook ativo e sem turno continua saindo com 9" $([ $c = 9 ] && echo 0 || echo 1)
subir sem-hook
"$BIN" abrir --provedor claude --titulo x --pedido oi --espera-turno 2 >/dev/null 2>"$T/e2"; c=$?
ok "Claude sem nenhum hook recebido sai com 11, nao 9" $([ $c = 11 ] && echo 0 || echo 1)
grep -q "nenhum hook do Claude" "$T/e2"; ok "o 11 sem hook explica o motivo" $?
subir sem-hook
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >/dev/null 2>"$T/e2"; c=$?
ok "Codex nao depende de hook: sem turno continua 9" $([ $c = 9 ] && echo 0 || echo 1)
subir sem-turno
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >/dev/null 2>&1
"$BIN" estado card-abc123 >"$T/o" 2>"$T/e"; grep -q "primeiro turno ainda nao observado pelo runner" "$T/o" && grep -q "nao prova que o card esteja parado" "$T/o" && ! grep -qi "NAO esta trabalhando\|nao virou turno" "$T/o"; ok "estado de card sem turno e neutro (nao afirma que esta parado)" $?
! grep -q '"url":"/api/agents/card-abc123/conversation' "$LOG"; ok "estado nao le a conversa (nenhum GET /conversation)" $?
"$BIN" ler card-abc123 >"$T/o" 2>"$T/e"; grep -q "nao ha terminal aberto" "$T/o" && grep -q "nao ha texto pendente" "$T/o" && grep -q "Retomar" "$T/o" && grep -q "dgclaw-card mandar" "$T/o" && ! grep -qi "NAO esta trabalhando\|foi digitado" "$T/o"; ok "ler de card parado sem fila diz que nada comeca sozinho e aponta Retomar/mandar" $?
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
subir normal
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 99999 >"$T/o" 2>"$T/e"; c=$?
ok "--espera-turno fora da faixa recusado com 1" $([ $c = 1 ] && echo 0 || echo 1)
[ ! -s "$LOG" ]; ok "--espera-turno fora da faixa recusado ANTES do primeiro POST (nenhuma chamada ao runner)" $?
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 08 >"$T/o" 2>"$T/e"; c=$?
ok "--espera-turno 08 vale 8 em base decimal (nao e erro de octal)" $([ $c = 0 ] && echo 0 || echo 1)

# --- CARD_MAX_TEMPO nunca entra no arquivo de configuracao do curl ------------------------------------------
subir normal
CARD_MAX_TEMPO=$'60\nurl = "http://127.0.0.1:1/roubo"' "$BIN" listar >"$T/o" 2>"$T/e"; c=$?
ok "CARD_MAX_TEMPO com quebra de linha e 'url =' e ignorado (sai com 0)" $([ $c = 0 ] && echo 0 || echo 1)
grep -q "CARD_MAX_TEMPO precisa ser um numero inteiro" "$T/e"; ok "o valor invalido gera aviso no stderr" $?
# Curl falso, so nesta chamada: grava os argumentos e a configuracao lida do stdin (-K -) e repassa tudo ao curl de verdade.
mkdir -p "$T/fakebin"
cat > "$T/fakebin/curl" <<'FAKE'
#!/usr/bin/env bash
{ printf 'ARGS'; printf ' [%s]' "$@"; printf '\n'; } >> "$CURL_LOG"
cfg="$(cat)"
printf '%s\n--FIM--\n' "$cfg" >> "$CURL_CFG"
printf '%s\n' "$cfg" | exec "$CURL_REAL" "$@"
FAKE
chmod +x "$T/fakebin/curl"
export CURL_REAL="$(command -v curl)"
: > "$T/curl.args"; : > "$T/curl.cfg"
CURL_LOG="$T/curl.args" CURL_CFG="$T/curl.cfg" PATH="$T/fakebin:$PATH" CARD_MAX_TEMPO=$'7\nurl = "http://127.0.0.1:1/roubo"' "$BIN" listar >"$T/o" 2>"$T/e"
[ "$(grep -c '^url *=' "$T/curl.cfg")" = 1 ] && grep -q "^url = \"http://127.0.0.1:$RUNNER_PORT/" "$T/curl.cfg"; ok "o curl recebeu exatamente uma URL, a do runner" $?
! grep -q "roubo" "$T/curl.args" "$T/curl.cfg"; ok "a URL injetada em CARD_MAX_TEMPO nao chegou ao curl (nem argumento nem configuracao)" $?
grep -q -- "\[--max-time\] \[60\]" "$T/curl.args"; ok "o prazo invalido virou 60 e chegou em --max-time" $?
: > "$T/curl.args"
CURL_LOG="$T/curl.args" CURL_CFG="$T/curl.cfg" PATH="$T/fakebin:$PATH" CARD_MAX_TEMPO=7 "$BIN" listar >/dev/null 2>&1
grep -q -- "\[--max-time\] \[7\]" "$T/curl.args"; ok "o prazo valido (7) chega em --max-time" $?
CARD_MAX_TEMPO=99999 "$BIN" listar >/dev/null 2>"$T/e"; grep -q "CARD_MAX_TEMPO precisa" "$T/e"; ok "CARD_MAX_TEMPO fora da faixa vira o padrao, com aviso" $?
CARD_MAX_TEMPO=08 "$BIN" listar >/dev/null 2>"$T/e"; c=$?; ok "CARD_MAX_TEMPO=08 e aceito em base decimal" $([ $c = 0 ] && ! grep -q "CARD_MAX_TEMPO" "$T/e" && echo 0 || echo 1)

# --- 9 com --monitor: o monitor ja foi cadastrado antes da espera -----------------------------------
# Estado e log do monitor ficam no diretorio temporario do teste, nunca no HOME real (nenhum outro teste da
# bateria chama o monitor: so os que passam --monitor, todos abaixo desta linha).
export DGCLAW_MONITOR_ESTADO="$T/monitor/estado.json" DGCLAW_MONITOR_LOG="$T/monitor/log"
subir sem-turno
rm -rf "${T:?}/monitor"
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 1 --monitor --entregue "relatorio salvo" >"$T/o" 2>"$T/e"; c=$?
ok "9 com --monitor sai com 9" $([ $c = 9 ] && echo 0 || echo 1)
grep -q "card-abc123" "$DGCLAW_MONITOR_ESTADO" 2>/dev/null; ok "o monitor ficou cadastrado mesmo no caminho do 9" $?
grep -q "Monitorando o card card-abc123" "$T/e"; ok "o caminho do 9 diz que o monitor esta ligado" $?

# --- falha ao cadastrar o monitor: erro explicito (8) com o que fazer ------------------------------
subir normal
rm -rf "${T:?}/monitor"
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

# --- fechar nao le a conversa: card restaurado (zero turnos, mas com resposta do agente na conversa) pede --forcar ---
subir restaurado
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 0 >/dev/null 2>&1
"$BIN" estado card-abc123 >"$T/o" 2>"$T/e"; ! grep -q "sem primeiro turno" "$T/o"; ok "estado de card restaurado (resposta do agente na conversa) nao diz 'sem primeiro turno'" $?
: > "$LOG"
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar com zero turnos recusa com 10 mesmo com resposta do agente na conversa" $([ $c = 10 ] && echo 0 || echo 1)
! grep -q "/conversation" "$LOG"; ok "o fechar nao le a conversa" $?
"$BIN" fechar card-abc123 --forcar >/dev/null 2>&1; ok "--forcar fecha o card restaurado" $?

# --- abrir: card em erro depois de aceitar o pedido sai com 12 ----------------------------------------------
subir erro-turno
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "pedido aceito e turno que falhou (errored) sai com 12" $([ $c = 12 ] && echo 0 || echo 1)
grep -q "aceitou o pedido, mas o turno falhou" "$T/e" && grep -q "dgclaw-card ler card-abc123" "$T/e"; ok "o 12 diz o que houve e manda ler" $?
! grep -q "Card aberto" "$T/o"; ok "12 nao imprime 'Card aberto'" $?

# --- abrir: campo de erro preenchido (card resumable com erro) nao conta como sucesso ----------------------------
subir erro-campo
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "campo de erro preenchido sai com 12 (nao com 0)" $([ $c = 12 ] && echo 0 || echo 1)
grep -q "o CLI caiu no meio do turno" "$T/e"; ok "a mensagem traz o motivo do erro" $?
[ "$(head -1 "$T/o")" = "card-abc123" ]; ok "no 12 o id tambem sai na primeira linha" $?

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
[ "$(head -1 "$T/o")" = "card-abc123" ] && grep -q "foi fechado porque o agente esta sem login" "$T/e"; ok "sem login: o id sai assim que o card existe e o aviso diz que ele foi fechado" $?

# --- input falha depois de criar: 4xx prova que nao entrou; 5xx ou resposta perdida e entrega incerta ---------------
subir input-recusado
"$BIN" abrir --provedor claude --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "input recusado (4xx) sai com 6" $([ $c = 6 ] && echo 0 || echo 1)
grep -q "card card-abc123 foi criado" "$T/e" && grep -q "nao foi entregue" "$T/e" && grep -q "dgclaw-card fechar card-abc123" "$T/e"; ok "recusa comprovada diz 'nao foi entregue' e como reenviar ou fechar" $?
[ "$(head -1 "$T/o")" = "card-abc123" ]; ok "recusa 4xx: o id sai na primeira linha" $?
subir input-falha
"$BIN" abrir --provedor claude --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "input com 5xx sai com 6" $([ $c = 6 ] && echo 0 || echo 1)
grep -q "entrega incerta: o card card-abc123" "$T/e" && grep -q "O card pode ja estar trabalhando" "$T/e" && grep -q "dgclaw-card estado card-abc123" "$T/e" && ! grep -q "nao foi entregue\|Reenvie com" "$T/e"; ok "5xx diz 'entrega incerta', manda conferir o estado e nao manda reenviar" $?
[ "$(head -1 "$T/o")" = "card-abc123" ]; ok "entrega incerta: o id sai na primeira linha" $?
subir input-perdido
"$BIN" abrir --provedor claude --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "resposta do input perdida sai com 2" $([ $c = 2 ] && echo 0 || echo 1)
grep -q "entrega incerta: o card card-abc123" "$T/e" && grep -q "NAO reenvie" "$T/e" && ! grep -q "nao foi entregue\|tente de novo" "$T/e"; ok "resposta perdida: 'entrega incerta', sem mandar tentar de novo" $?
[ "$(head -1 "$T/o")" = "card-abc123" ]; ok "resposta perdida: o id sai na primeira linha" $?
rm -rf "${T:?}/monitor"
"$BIN" abrir --provedor claude --titulo x --pedido oi --monitor --entregue "feito" >"$T/o" 2>"$T/e"; c=$?
ok "resposta perdida com --monitor continua saindo com 2" $([ $c = 2 ] && echo 0 || echo 1)
grep -q "card-abc123" "$DGCLAW_MONITOR_ESTADO" 2>/dev/null && grep -q "Monitor ligado" "$T/e" && grep -q "entrega incerta" "$T/e"; ok "entrega incerta com --monitor: o monitor e cadastrado e o aviso diz isso" $?

# --- recusas anteriores a fila: capacidade e NAO_ACORDOU ----------------------------------------------------
for modo in input-sem-capacidade input-nao-acordou; do
  subir "$modo"
  "$BIN" abrir --provedor claude --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
  ok "$modo sai com 6" $([ $c = 6 ] && echo 0 || echo 1)
  grep -q "o pedido nao foi entregue (" "$T/e" && grep -q "pode tentar de novo quando" "$T/e" && ! grep -q "entrega incerta" "$T/e"; ok "$modo diz 'nao foi entregue' e nao 'entrega incerta'" $?
  [ "$(head -1 "$T/o")" = "card-abc123" ]; ok "$modo: o id sai na primeira linha" $?
done

# --- --monitor com recusa anterior a fila: a mensagem traz o comando do monitor ------------------------------
subir input-sem-capacidade
"$BIN" abrir --provedor claude --titulo x --pedido oi --monitor --entregue "relatorio pronto" --cada 5 >"$T/o" 2>"$T/e"; c=$?
ok "503 SEM_CAPACIDADE com --monitor sai com 6" $([ $c = 6 ] && echo 0 || echo 1)
grep -q "dgclaw-monitor add card-abc123 --entregue" "$T/e" && grep -q -- "--cada 5" "$T/e"; ok "a recusa com --monitor diz o comando dgclaw-monitor add com criterio e intervalo" $?
grep -q "ANTES de reenviar ligue o monitor" "$T/e" && ! grep -q "depois de reenviar" "$T/e"; ok "a dica manda ligar o monitor ANTES de reenviar" $?
subir input-recusado
"$BIN" abrir --provedor claude --titulo x --pedido oi --monitor --entregue "feito" >"$T/o" 2>"$T/e"
grep -q "dgclaw-monitor add card-abc123" "$T/e" && ! grep -q -- "--cada" "$T/e"; ok "recusa 4xx com --monitor sem --cada diz o comando sem --cada" $?

# --- turno aceito e card esperando decisao do dono -----------------------------------------------------------------
subir aguardando-decisao
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 3 >"$T/o" 2>"$T/e"; c=$?
ok "card em waiting_input depois do turno sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
grep -q "esperando uma decisao do dono" "$T/o" && ! grep -q "dgclaw-card esperar" "$T/o"; ok "waiting_input diz que espera decisao e nao recomenda esperar" $?
grep -q "uma pergunta ou uma permissao" "$T/o" && grep -q "dgclaw-card ler card-abc123" "$T/o" && ! grep -q "Aprovar\|cartao da pergunta" "$T/o"; ok "waiting_input sem motivo conhecido nao aponta botao e manda conferir com ler" $?
subir aguardando-pergunta
"$BIN" abrir --provedor claude --titulo x --pedido oi --espera-turno 3 >"$T/o" 2>"$T/e"; c=$?
ok "waiting_input com motivo pergunta sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
grep -q "pergunta de escolha" "$T/o" && grep -q "cartao da pergunta" "$T/o" && ! grep -q "Aprovar" "$T/o"; ok "motivo pergunta: o dono responde no cartao da pergunta, sem botao de permissao" $?
subir aguardando-permissao
"$BIN" abrir --provedor claude --titulo x --pedido oi --espera-turno 3 >"$T/o" 2>"$T/e"; c=$?
ok "waiting_input com motivo permissao sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
grep -q "esperando uma decisao do dono, uma permissao" "$T/o" && grep -q "Aprovar ou Negar" "$T/o" && ! grep -q "cartao da pergunta" "$T/o"; ok "motivo permissao: botoes Aprovar ou Negar na aba Sessoes" $?
subir aguardando-motivo-estranho
"$BIN" abrir --provedor claude --titulo x --pedido oi --espera-turno 3 >"$T/o" 2>"$T/e"
grep -q "uma pergunta ou uma permissao" "$T/o" && ! grep -q "Aprovar\|cartao da pergunta" "$T/o"; ok "motivo desconhecido (login) cai no texto neutro" $?

# --- cada consulta do primeiro turno respeita o menor entre CARD_MAX_TEMPO e o que resta da espera ----------------
subir sem-turno
: > "$T/curl.args"
CURL_LOG="$T/curl.args" CURL_CFG="$T/curl.cfg" PATH="$T/fakebin:$PATH" "$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >/dev/null 2>&1
grep -q -- "\[--max-time\] \[2\]" "$T/curl.args"; ok "com o prazo padrao (60 s) e espera de 2 s, a consulta usa o que resta da espera (2 s)" $?
: > "$T/curl.args"
CURL_LOG="$T/curl.args" CURL_CFG="$T/curl.cfg" PATH="$T/fakebin:$PATH" CARD_MAX_TEMPO=1 "$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 3 >/dev/null 2>&1
[ "$(grep -c -- "\[--max-time\] \[1\]" "$T/curl.args")" -ge 3 ] && ! grep -q -- "\[--max-time\] \[3\]" "$T/curl.args"; ok "com CARD_MAX_TEMPO=1 e espera de 3 s, nenhuma consulta passa de 1 s" $?

# --- working sozinho nao confirma: so o contador ---------------------------------------------------------------
subir working-sem-turno
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 1 >"$T/o" 2>"$T/e"; c=$?
ok "working com contador 0 e hook:PreCompact nao confirma: sai com 9" $([ $c = 9 ] && echo 0 || echo 1)
! grep -q "Card aberto" "$T/o"; ok "working sem contador nao imprime 'Card aberto'" $?
"$BIN" estado card-abc123 >"$T/o3" 2>"$T/e3"
grep -q "primeiro turno ainda nao observado pelo runner" "$T/o3" && ! grep -qi "NAO esta trabalhando\|nao virou turno" "$T/o3"; ok "estado com working e contador 0 diz que o primeiro turno nao foi observado" $?
"$BIN" ler card-abc123 >"$T/o2" 2>"$T/e2"
grep -q "ainda nao observou o primeiro turno" "$T/o2" && ! grep -qi "NAO esta trabalhando" "$T/o2" && ! grep -q "trabalhando no primeiro turno" "$T/o2"; ok "ler com working e contador 0 nao diz que o pedido esta no primeiro turno" $?

# --- nome de ferramenta com "error" no statusReason nao e falha de turno ----------------------------------------
subir ferramenta-com-erro-no-nome
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "ferramenta com 'error' no nome nao vira falha de turno: sai com 0" $([ $c = 0 ] && echo 0 || echo 1)

# --- StopFailure no statusReason e falha de turno --------------------------------------------------------------
subir stop-failure
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "statusReason hook:StopFailure sai com 12" $([ $c = 12 ] && echo 0 || echo 1)
grep -q "StopFailure rate_limit" "$T/e"; ok "o 12 do StopFailure traz o motivo" $?

# --- erro de turno com o pedido ainda pendente pode ser de outra mensagem: 11, nao 12 -------------------------
for modo in erro-com-pendencia erro-motivo-com-pendencia; do
  subir "$modo"
  "$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
  ok "$modo sai com 11, nao com 12" $([ $c = 11 ] && echo 0 || echo 1)
  grep -q "vi um erro de turno" "$T/e" && grep -q "pode ser de outra mensagem" "$T/e" && ! grep -q "aceitou o pedido, mas o turno falhou" "$T/e"; ok "$modo: a mensagem cita o erro e diz que pode ser de outra mensagem" $?
done
subir erro-com-pendencia
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >/dev/null 2>"$T/e"
grep -q "falha na mensagem do painel" "$T/e"; ok "o 11 com pendencia traz o texto do erro" $?
subir erro-motivo-com-pendencia
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >/dev/null 2>"$T/e"
grep -q "StopFailure rate_limit" "$T/e"; ok "o 11 com pendencia traz o statusReason" $?

# --- Claude sem hook: estado e ler nao afirmam que o card nao trabalha ---------------------------------------
subir sem-hook
"$BIN" abrir --provedor claude --titulo x --pedido oi --espera-turno 1 >/dev/null 2>&1
"$BIN" estado card-abc123 >"$T/o" 2>"$T/e"
! grep -q "NAO esta trabalhando\|o pedido nao virou turno" "$T/o" && grep -q "nao prova que o card esteja parado" "$T/o"; ok "estado de Claude sem hook e neutro" $?
"$BIN" ler card-abc123 >"$T/o" 2>"$T/e"
! grep -q "NAO esta trabalhando\|ainda nao virou turno" "$T/o" && grep -q "nada vai comecar sozinho" "$T/o"; ok "ler de Claude sem hook e neutro" $?

# --- turno com texto ainda na fila nao confirma o pedido (mensagem do painel digitada direto no terminal) -----
subir turno-com-fila
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "turno com fila 1 nao confirma: sai com 11 no prazo" $([ $c = 11 ] && echo 0 || echo 1)
! grep -q "Card aberto" "$T/o"; ok "turno com fila 1 nao imprime 'Card aberto'" $?
grep -q "ainda ha texto pendente" "$T/e"; ok "o 11 da fila explica que ha texto na fila" $?
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar com fila 1 recusa com 10" $([ $c = 10 ] && echo 0 || echo 1)
grep -q "1 texto(s) pendente(s) no card" "$T/e"; ok "a recusa do fechar com fila cita os textos na fila" $?
"$BIN" fechar card-abc123 --forcar >/dev/null 2>&1; ok "--forcar fecha mesmo com fila" $?

# --- item sendo digitado: sessao.fila 0, mas naFilaTotal 1 (o pedido ainda nao saiu) -------------------------------
subir item-em-voo
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "turno com item em voo (fila 0, naFilaTotal 1) nao confirma: sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
! grep -q "Card aberto" "$T/o"; ok "item em voo nao imprime 'Card aberto'" $?
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar com item em voo recusa com 10" $([ $c = 10 ] && echo 0 || echo 1)

# --- recibo do Enter pendente: turno 1, fila 0, mas o runner ainda espera o recibo (o pedido pode estar na caixa) ---
subir recibo-pendente
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "turno com recibo pendente (fila 0) nao confirma: sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
! grep -q "Card aberto" "$T/o"; ok "recibo pendente nao imprime 'Card aberto'" $?
grep -q "recibo do Enter" "$T/e"; ok "o 11 do recibo pendente explica o motivo" $?
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar com recibo pendente recusa com 10" $([ $c = 10 ] && echo 0 || echo 1)
grep -q "espera o recibo de um texto digitado" "$T/e"; ok "a recusa do fechar cita o recibo pendente" $?
"$BIN" fechar card-abc123 --forcar >/dev/null 2>&1; ok "--forcar fecha mesmo com recibo pendente" $?

# --- resposta sem reciboPendente: nao da para confirmar nem fechar -------------------------------------------------
subir sem-campo-recibo
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "turno sem o campo reciboPendente sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
grep -q "reciboPendente" "$T/e"; ok "o 11 sem reciboPendente cita o campo" $?
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar sem o campo reciboPendente recusa com 10" $([ $c = 10 ] && echo 0 || echo 1)

# --- sem turno e sem naFilaTotal: 11 e nao 9 -------------------------------------------------------------------
subir sem-turno-sem-total
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "turno 0 sem naFilaTotal sai com 11 (nao 9)" $([ $c = 11 ] && echo 0 || echo 1)
grep -q "naFilaTotal" "$T/e"; ok "o 11 sem naFilaTotal cita o campo" $?

# --- resposta sem naFilaTotal: nao da para confirmar nem fechar -----------------------------------------------
subir sem-campo-fila
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "turno sem o campo da fila sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
"$BIN" fechar card-abc123 >"$T/o" 2>"$T/e"; c=$?
ok "fechar sem o campo da fila recusa com 10" $([ $c = 10 ] && echo 0 || echo 1)

# --- card sem processo vivo no prazo: contador zerado pode ser reinicio, sai com 11 e nao com 9 -----------------
subir sem-processo
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 1 >"$T/o" 2>"$T/e"; c=$?
ok "card resumable com contador 0 sai com 11, nao 9" $([ $c = 11 ] && echo 0 || echo 1)
grep -q "sem processo vivo (status resumable)" "$T/e"; ok "o 11 do card sem processo cita o status" $?

# --- turno visto, mas terminal ja fechado (resumable): nao confirma, sai com 11 ------------------------------------
subir turno-resumable
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 2 >"$T/o" 2>"$T/e"; c=$?
ok "turno visto com card resumable sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
! grep -q "Card aberto" "$T/o"; ok "turno com card resumable nao imprime 'Card aberto'" $?
grep -q "terminal do card ja esta fechado (status resumable)" "$T/e"; ok "o 11 do card fechado cita o status" $?

# --- limpeza apos SEM_LOGIN: DELETE que falha informa o id ----------------------------------------------------
subir sem-login-delete-falha
"$BIN" abrir --provedor codex --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "sem login com DELETE falho ainda sai com 5" $([ $c = 5 ] && echo 0 || echo 1)
grep -q "nao confirmei a remocao do card card-abc123" "$T/e" && [ "$(head -1 "$T/o")" = "card-abc123" ]; ok "DELETE nao 2xx informa o id e a remocao nao confirmada" $?

# --- --espera-turno 0: sai com 0, mas nao afirma que o card esta trabalhando --------------------------------------
subir sem-turno
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 0 >"$T/o" 2>"$T/e"; c=$?
ok "--espera-turno 0 sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
grep -q "NAO foi verificado" "$T/o" && ! grep -q "Card aberto" "$T/o"; ok "--espera-turno 0 diz que o aceite nao foi verificado e nao imprime 'Card aberto'" $?

# --- ler: pedido guardado na fila de card parado -> Retomar ----------------------------------------------------
subir fila-parada
"$BIN" abrir --provedor codex --titulo x --pedido oi --espera-turno 0 >/dev/null 2>&1
"$BIN" ler card-abc123 >"$T/o" 2>"$T/e"
grep -q "pedido guardado" "$T/o" && grep -q "Retomar" "$T/o" && ! grep -q "Espere com" "$T/o"; ok "ler de card parado com fila manda usar Retomar, sem mandar esperar" $?

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
