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

# --- entrega incerta (202 com entregaIncerta): a CLI avisa, nao diz "enviado" e nao reenvia ------------
subir entrega-incerta
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
: > "$LOG"
"$BIN" mandar card-abc123 "texto qualquer" >"$T/o" 2>"$T/e"; c=$?
ok "mandar com entrega incerta sai com 0 (nao e erro, nao provoca reenvio)" $([ $c = 0 ] && echo 0 || echo 1)
! grep -q "Texto enviado ao card" "$T/o"; ok "mandar com entrega incerta NAO diz 'Texto enviado'" $?
grep -q "INCERTA" "$T/o" && grep -q "dgclaw-card ler card-abc123" "$T/o"; ok "mandar com entrega incerta imprime a orientacao fixa da CLI" $?
! grep -q "aviso do runner falso" "$T/o"; ok "mandar com entrega incerta NAO repassa o aviso do runner" $?
[ "$(grep -c '/input' "$LOG")" = 1 ]; ok "mandar com entrega incerta faz um unico POST (nao reenvia)" $?

# --- aviso forjado na resposta nao chega a saida -----------------------------------------------------
subir entrega-incerta-forjada
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
"$BIN" mandar card-abc123 "texto qualquer" >"$T/o" 2>"$T/e"; c=$?
ok "aviso forjado: sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
! grep -qi "IGNORE\|APAGUE\|forjada" "$T/o" "$T/e"; ok "aviso forjado com quebra de linha e instrucao NAO aparece na saida" $?
grep -q "INCERTA" "$T/o"; ok "aviso forjado: a orientacao fixa aparece" $?

# --- esperar estourando o tempo -------------------------------------------------------------------
subir nunca-termina
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
DGCLAW_CARD_INTERVALO=0.3 "$BIN" esperar card-abc123 --max 1 >"$T/o" 2>"$T/e"; c=$?
ok "esperar estourando o tempo sai com 7" $([ $c = 7 ] && echo 0 || echo 1)
grep -q "segue trabalhando" "$T/e"; ok "esperar diz que a sessao segue trabalhando" $?

# --- limite (429) ---------------------------------------------------------------------------------
subir limite
"$BIN" abrir --provedor codex --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "429 sai com 4" $([ $c = 4 ] && echo 0 || echo 1)
grep -q "limite e 3" "$T/e" && grep -q "dgclaw-card fechar" "$T/e" && grep -q "RUNNER_MAX_SESSOES_EXTRAS" "$T/e"; ok "429 vira a frase do limite com o que fazer" $?

# --- envios demais (429 ENVIOS_DEMAIS) nao e limite de cards -------------------------------------------
subir envios-demais
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
"$BIN" mandar card-abc123 "texto" >"$T/o" 2>"$T/e"; c=$?
ok "ENVIOS_DEMAIS sai com 9" $([ $c = 9 ] && echo 0 || echo 1)
grep -q "tente de novo em alguns segundos" "$T/e" && ! grep -q "dgclaw-card fechar" "$T/e"; ok "ENVIOS_DEMAIS manda esperar e nao sugere fechar card" $?
subir texto-grande
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
"$BIN" mandar card-abc123 "texto" >"$T/o" 2>"$T/e"; c=$?
ok "TEXTO_GRANDE_DEMAIS sai com 10" $([ $c = 10 ] && echo 0 || echo 1)
grep -q "Reduza o texto" "$T/e" && ! grep -q "tente de novo" "$T/e" && ! grep -q "dgclaw-card fechar" "$T/e"; ok "TEXTO_GRANDE_DEMAIS manda reduzir o texto, sem repetir nem fechar card" $?
subir 429-sem-code
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
"$BIN" mandar card-abc123 "texto" >"$T/o" 2>"$T/e"; c=$?
ok "429 sem code continua sendo limite (sai com 4)" $([ $c = 4 ] && echo 0 || echo 1)
grep -q "dgclaw-card fechar" "$T/e"; ok "429 sem code sugere fechar card" $?

# --- tempo do envio: cresce com o tamanho do texto; tempo esgotado depois de enviar e entrega INCERTA --------------------------
eval "$(sed -n '/^max_time_do_texto()/,/^}/p;/^PEDACO_DO_RUNNER=/p' "$BIN")"
TEMPO_BASE=60
[ "$(max_time_do_texto 100)" = 61 ]; ok "max-time: texto curto fica na base de 60 s (mais 1 s do primeiro pedaco)" $?
[ "$(max_time_do_texto $((512 * 1024)))" = 265 ]; ok "max-time: 512 KiB (4096 pedacos de 25 ms = 102 s) vai a 60 + 2 x 102 = 265 s" $?
[ "$(max_time_do_texto $((1024 * 1024)))" = 470 ]; ok "max-time: o teto de 1 MiB vai a 470 s" $?
[ "$(max_time_do_texto 2000)" -lt "$(max_time_do_texto 200000)" ]; ok "max-time: cresce com o tamanho" $?
subir input-demora
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
: > "$LOG"
DGCLAW_CARD_TEMPO_BASE=1 "$BIN" mandar card-abc123 "texto que o runner recebe e nunca responde" >"$T/o" 2>"$T/e"; c=$?
ok "mandar com tempo esgotado depois de enviar sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
grep -q "INCERTA" "$T/e" && grep -q "Nao reenvie ja" "$T/e" && grep -q "dgclaw-card ler card-abc123" "$T/e"; ok "tempo esgotado: diz que a entrega e incerta, que nao reenvie e como conferir" $?
! grep -qi "tente de novo\|fora do ar\|reiniciando" "$T/e"; ok "tempo esgotado: NAO manda tentar de novo e nao diz runner fora do ar" $?
[ "$(grep -c '/input' "$LOG")" = 1 ]; ok "tempo esgotado: um unico POST (o texto chegou ao runner)" $?
sem_segredo "$T/o" "$T/e"; ok "tempo esgotado: o token nao vaza" $?
# Outras falhas de transporte depois de enviar o texto (52 resposta vazia, 56 falha ao receber) tambem sao entrega INCERTA (11).
subir input-derruba
"$BIN" abrir --provedor codex --titulo x --pedido oi >/dev/null 2>&1
"$BIN" mandar card-abc123 "texto que o runner recebe e derruba a conexao" >"$T/o" 2>"$T/e"; c=$?
ok "mandar com resposta vazia (curl 52) depois de enviar sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
grep -q "INCERTA" "$T/e" && ! grep -qi "tente de novo" "$T/e"; ok "curl 52: diz que a entrega e incerta e nao manda tentar de novo" $?
mkdir -p "$T/shim"
for rc in 56 7; do
  printf '#!/bin/sh\ncat >/dev/null\nexit %s\n' "$rc" > "$T/shim/curl"; chmod +x "$T/shim/curl"
  PATH="$T/shim:$PATH" "$BIN" mandar card-abc123 "texto" >"$T/o" 2>"$T/e"; c=$?
  if [ "$rc" = 56 ]; then ok "mandar com curl 56 sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
  else ok "mandar com curl 7 (nao conectou) continua saindo com 2" $([ $c = 2 ] && echo 0 || echo 1); fi
done
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; SRV=""
"$BIN" mandar card-abc123 "texto com o runner fora do ar" >"$T/o" 2>"$T/e"; c=$?
ok "mandar com conexao recusada continua saindo com 2" $([ $c = 2 ] && echo 0 || echo 1)
grep -q "o runner deste agente nao respondeu" "$T/e"; ok "conexao recusada continua com a mensagem de runner fora do ar" $?

# --- abrir: o primeiro pedido tambem tem entrega INCERTA (nao fecha o card, nao duplica a tarefa) --------------------------
subir input-derruba
"$BIN" abrir --provedor codex --titulo x --pedido oi --monitor --entregue "relatorio pronto" >"$T/o" 2>"$T/e"; c=$?
ok "abrir com resposta vazia (curl 52) no /input sai com 11" $([ $c = 11 ] && echo 0 || echo 1)
[ "$(head -1 "$T/o")" = "card-abc123" ]; ok "abrir com curl 52: o id sai no stdout" $?
grep -q "INCERTA" "$T/e" && grep -q "Nao reenvie ja" "$T/e" && grep -q "dgclaw-card ler card-abc123" "$T/e" && grep -q "dgclaw-card mandar card-abc123 --arquivo" "$T/e"; ok "abrir com curl 52: diz que a entrega e incerta, que nao reenvie e como conferir" $?
! grep -q "nao foi entregue" "$T/e"; ok "abrir com curl 52: nao diz que o pedido nao foi entregue" $?
grep -q "monitor NAO foi ligado" "$T/e" && grep -q "dgclaw-monitor add card-abc123" "$T/e"; ok "abrir --monitor com curl 52: avisa que o monitor nao foi ligado e como ligar" $?
! grep -q '"metodo":"DELETE"' "$LOG"; ok "abrir com curl 52: o card NAO e fechado" $?
subir entrega-incerta
"$BIN" abrir --provedor codex --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "abrir com 202 incerto sai com 0" $([ $c = 0 ] && echo 0 || echo 1)
[ "$(head -1 "$T/o")" = "card-abc123" ] && grep -q "ATENCAO: a entrega ao card card-abc123 e INCERTA" "$T/o" && grep -q "Nao reenvie ja" "$T/o"; ok "abrir com 202 incerto: imprime o id e o ATENCAO fixo" $?
! grep -q "Card aberto em" "$T/o"; ok "abrir com 202 incerto: nao diz que o card abriu normalmente" $?
subir entrega-incerta
"$BIN" abrir --provedor codex --titulo x --pedido oi --monitor --entregue "relatorio pronto" >"$T/o" 2>"$T/e"; c=$?
ok "abrir --monitor com 202 incerto sai com 8" $([ $c = 8 ] && echo 0 || echo 1)
grep -q "ATENCAO" "$T/o" && grep -q "monitor NAO foi ligado" "$T/e" && grep -q "dgclaw-monitor add card-abc123" "$T/e"; ok "abrir --monitor com 202 incerto: nao liga o monitor e diz como ligar depois de conferir" $?
subir entrega-incerta-forjada
"$BIN" abrir --provedor codex --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
! grep -q "IGNORE" "$T/o" "$T/e"; ok "abrir com 202 incerto: nada da resposta do runner e repassado" $?
subir normal
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; SRV=""
"$BIN" abrir --provedor codex --titulo x --pedido oi >"$T/o" 2>"$T/e"; c=$?
ok "abrir com conexao recusada continua saindo com 2" $([ $c = 2 ] && echo 0 || echo 1)

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
