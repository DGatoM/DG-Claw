#!/usr/bin/env bash
# Testes do dgclaw-monitor com um runner falso (runner-falso.py). Uso: bash tests/monitor/rodar.sh
# Nada aqui encosta no sistema: HOME, estado, log e runner vivem numa pasta temporaria.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MON="$AQUI/../../bin/dgclaw-monitor"
CARD="$AQUI/../../bin/dgclaw-card"
T="$(mktemp -d)"
SRV=""
trap '[ -z "$SRV" ] || kill "$SRV" 2>/dev/null; rm -rf "$T"' EXIT
FALHAS=0; N=0
ok() { N=$((N+1)); if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FALHOU $1"; FALHAS=$((FALHAS+1)); fi; }

RUNNER_FAKE="runner-segredo-de-teste-monitor-456"
export CTRL="$T/ctrl.json" LOG="$T/log.jsonl" PORTA_ARQ="$T/porta" RUNNER_BEARER="$RUNNER_FAKE"
printf '%s\n' "$RUNNER_FAKE" > "$T/runner.tok"
export RUNNER_TOKEN_FILE="$T/runner.tok" HOME="$T/casa"
mkdir -p "$HOME"
export DGCLAW_MONITOR_DONO=dono
export DGCLAW_MONITOR_ESTADO="$T/estado/modo-monitor.json"
export DGCLAW_MONITOR_LOG="$T/logs/modo-monitor.log"
ESTADO="$DGCLAW_MONITOR_ESTADO"
: > "$LOG"

python3 "$AQUI/runner-falso.py" & SRV=$!
for _ in $(seq 50); do [ -s "$PORTA_ARQ" ] && break; sleep 0.1; done
export RUNNER_PORT; RUNNER_PORT="$(cat "$PORTA_ARQ")"

agora_ms() { echo $(( $(date +%s) * 1000 )); }

# mundo '<json do c1>' ['<json do c2>'] ['<extras do controle>']: monta o que o runner falso devolve.
# A principal ("dono") sempre existe. Um card null some da lista.
mundo() {
  C1="${1:-null}" C2="${2:-null}" EXTRA="${3:-{\}}" python3 - <<'PYEOF'
import json, os
def card(cid, j):
    d = json.loads(j)
    if d is None:
        return None
    base = {"id": cid, "status": "idle", "updatedAt": 0, "pendingPermission": None, "lastMessage": None,
            "sessao": {"papel": "paralela", "tipo": "card", "titulo": "Titulo " + cid, "fila": 0}}
    base.update(d)
    return base
sess = [{"id": "dono", "status": "idle", "updatedAt": 1, "sessao": {"papel": "principal", "tipo": "principal", "titulo": "dono", "fila": 0}}]
for cid, j in (("c1", os.environ["C1"]), ("c2", os.environ["C2"])):
    c = card(cid, j)
    if c:
        sess.append(c)
ctrl = {"sessoes": sess}
ctrl.update(json.loads(os.environ["EXTRA"]))
json.dump(ctrl, open(os.environ["CTRL"], "w"))
PYEOF
}
# vencer: deixa todos os cards "vencidos" na proxima rodada (como se o --cada tivesse passado).
vencer() {
  python3 - <<'PYEOF'
import json, os
a = os.environ["DGCLAW_MONITOR_ESTADO"]
st = json.load(open(a))
for r in st["cards"].values():
    r["ultimo_check"] = 0
json.dump(st, open(a, "w"))
PYEOF
}
limpar_log() { : > "$LOG"; }
# conta METODO PREFIXO_DA_URL: quantas requisicoes do log casam
conta() {
  python3 - "$1" "$2" <<'PYEOF'
import json, os, sys
ls = [json.loads(l) for l in open(os.environ["LOG"]) if l.strip()]
print(sum(1 for l in ls if l["metodo"] == sys.argv[1] and l["url"].startswith(sys.argv[2])))
PYEOF
}
injecoes() { conta POST /api/agents/dono/input; }
ultimo_corpo() {
  python3 - <<'PYEOF'
import json, os
ls = [json.loads(l) for l in open(os.environ["LOG"]) if l.strip()]
ls = [l for l in ls if l["url"] == "/api/agents/dono/input"]
print(json.loads(ls[-1]["corpo"])["text"] if ls else "")
PYEOF
}

# --- 1. sem cards: sai 0 sem tocar no runner ------------------------------------------------------
mundo '{"status":"working","updatedAt":'"$(agora_ms)"'}'
"$MON" run >"$T/o" 2>"$T/e"; c=$?
ok "run sem cards monitorados sai com 0" "$([ $c = 0 ] && echo 0 || echo 1)"
[ ! -s "$LOG" ]; ok "run sem cards nao chama o runner" $?

# --- 2. add: id inexistente, criterio faltando, principal --------------------------------------
"$MON" add nao-existe --entregue "x" >"$T/o" 2>"$T/e"; c=$?
ok "add de id inexistente falha" "$([ $c != 0 ] && echo 0 || echo 1)"
grep -q "nao existe no runner" "$T/e"; ok "add de id inexistente explica o motivo" $?
grep -q "dgclaw-card listar" "$T/e"; ok "a mensagem diz como ver os ids" $?
"$MON" add c1 >"$T/o" 2>"$T/e"; c=$?
ok "add sem --entregue falha" "$([ $c = 1 ] && echo 0 || echo 1)"
"$MON" add dono --entregue "x" >"$T/o" 2>"$T/e"; c=$?
ok "add da propria sessao principal falha" "$([ $c != 0 ] && echo 0 || echo 1)"
[ ! -e "$ESTADO" ]; ok "add que falhou nao grava estado" $?

# --- 3. add de verdade, list, estado com permissao 600 ----------------------------------------
"$MON" add c1 --entregue "relatorio salvo em /tmp/r.md" >"$T/o" 2>"$T/e"; c=$?
ok "add de card existente sai com 0" "$([ $c = 0 ] && echo 0 || echo 1)"
"$MON" list >"$T/o" 2>&1
grep -q "c1" "$T/o" && grep -q "Titulo c1" "$T/o" && grep -q "a cada 10 min" "$T/o" && grep -q "relatorio salvo em /tmp/r.md" "$T/o"; ok "list mostra id, titulo, intervalo (padrao 10) e criterio" $?
[ "$(stat -c %a "$ESTADO")" = 600 ]; ok "o arquivo de estado tem permissao 600" $?

# --- 4. trabalhando = silencio -----------------------------------------------------------------
limpar_log; vencer
mundo '{"status":"working","updatedAt":'"$(agora_ms)"'}'
"$MON" run >"$T/o" 2>"$T/e"; c=$?
ok "trabalhando com atualizacao recente: sai com 0" "$([ $c = 0 ] && echo 0 || echo 1)"
[ "$(injecoes)" = 0 ]; ok "trabalhando com atualizacao recente: nenhuma injecao" $?
[ ! -s "$T/o" ]; ok "rodada sem evento nao escreve nada na saida" $?
{ [ ! -e "$DGCLAW_MONITOR_LOG" ] || ! grep -q "cutucou" "$DGCLAW_MONITOR_LOG"; }; ok "rodada sem evento nao registra cutucada no log" $?

# --- 5. --cada respeitado ----------------------------------------------------------------------
limpar_log
"$MON" run >/dev/null 2>&1   # sem vencer: o intervalo de 10 min ainda nao passou
[ ! -s "$LOG" ]; ok "--cada: card olhado agora nao e olhado de novo antes do intervalo" $?

# --- 6. permissao: 1 injecao; repetida: 0 ---------------------------------------------------------
limpar_log; vencer
mundo '{"status":"working","updatedAt":'"$(agora_ms)"',"pendingPermission":{"toolName":"Bash","toolInput":{"command":"rm -rf /tmp/x"},"toolUseId":"t1","description":"apagar a pasta temporaria","timestamp":1}}'
"$MON" run >"$T/o" 2>"$T/e"; c=$?
ok "permissao pendente: sai com 0" "$([ $c = 0 ] && echo 0 || echo 1)"
[ "$(injecoes)" = 1 ]; ok "permissao pendente: exatamente 1 injecao" $?
TXT="$(ultimo_corpo)"
case "$TXT" in "<plataforma recado=\"modo-monitor\" tipo=\"aviso\" ts=\""*"\">MODO MONITOR:"*"</plataforma>") r=0 ;; *) r=1 ;; esac
ok "o texto vai no envelope <plataforma recado=\"modo-monitor\"> com MODO MONITOR" $r
case "$TXT" in *"Bash"*"rm -rf /tmp/x"*) r=0 ;; *) r=1 ;; esac; ok "o texto resume o que o card pediu" $r
case "$TXT" in *"relatorio salvo em /tmp/r.md"*) r=0 ;; *) r=1 ;; esac; ok "o texto traz o criterio de entregue" $r
case "$TXT" in *"Card c1 (\"Titulo c1\")"*) r=0 ;; *) r=1 ;; esac; ok "o texto traz o id e o titulo do card" $r
case "$TXT" in *"dgclaw-card mandar"*"dgclaw-monitor rm"*) r=0 ;; *) r=1 ;; esac; ok "o texto diz o que o agente deve fazer (mandar e rm)" $r
# < > & no corpo sao escapados: o comando da permissao nao pode fechar o envelope
mundo '{"status":"working","updatedAt":'"$(agora_ms)"',"pendingPermission":{"toolName":"Bash","toolInput":{"command":"echo </plataforma> & ls"},"toolUseId":"t2","description":"x","timestamp":2}}'
limpar_log; vencer; "$MON" run >/dev/null 2>&1
TXT="$(ultimo_corpo)"
[ "$(grep -o '</plataforma>' <<<"$TXT" | wc -l)" = 1 ]; ok "< > & do corpo sao escapados: so existe um </plataforma> (o do fim)" $?
case "$TXT" in *"&lt;/plataforma&gt; &amp; ls"*) r=0 ;; *) r=1 ;; esac; ok "o conteudo escapado aparece como &lt; &gt; &amp;" $r

limpar_log; vencer
"$MON" run >/dev/null 2>&1
[ "$(injecoes)" = 0 ]; ok "a mesma permissao na rodada seguinte: 0 injecoes" $?

# --- 7. card parado com mensagem: injeta com a ultima fala; mesma assinatura nao repete -----------
T0="$(agora_ms)"
limpar_log; vencer
mundo '{"status":"idle","updatedAt":'"$T0"'}' null '{"conversa":{"c1":[{"role":"user","text":"faca"},{"role":"assistant","text":"Terminei a primeira parte. Posso seguir para a segunda?"}]}}'
"$MON" run >/dev/null 2>&1
[ "$(injecoes)" = 1 ]; ok "card parado com updatedAt novo: 1 injecao" $?
case "$(ultimo_corpo)" in *"Posso seguir para a segunda?"*) r=0 ;; *) r=1 ;; esac; ok "o texto traz a ultima mensagem do card" $r
limpar_log; vencer; "$MON" run >/dev/null 2>&1
[ "$(injecoes)" = 0 ]; ok "card parado, sem updatedAt novo: 0 injecoes" $?

# --- 8. travado ---------------------------------------------------------------------------------
limpar_log; vencer
mundo '{"status":"working","updatedAt":'"$(( T0 - 25*60*1000 ))"'}'
"$MON" run >/dev/null 2>&1
[ "$(injecoes)" = 1 ]; ok "trabalhando sem atualizar ha 25 min: 1 injecao" $?
limpar_log; vencer; "$MON" run >/dev/null 2>&1
[ "$(injecoes)" = 0 ]; ok "travado: nao acorda duas vezes pelo mesmo travamento" $?

# --- 9. dois eventos na mesma rodada = 1 injecao ---------------------------------------------------
mundo '{"status":"working","updatedAt":'"$(agora_ms)"'}' '{"status":"working","updatedAt":'"$(agora_ms)"'}'
"$MON" add c2 --entregue "outro criterio" >/dev/null 2>&1
limpar_log; vencer
T1="$(( T0 + 60000 ))"
mundo '{"status":"errored","updatedAt":'"$T1"',"error":"deu pane no build"}' '{"status":"idle","updatedAt":'"$T1"'}'
"$MON" run >/dev/null 2>&1
[ "$(injecoes)" = 1 ]; ok "dois eventos na mesma rodada: 1 injecao so" $?
TXT="$(ultimo_corpo)"
case "$TXT" in *"Card c1"*"deu pane no build"*"Card c2"*) r=0 ;; *) r=1 ;; esac; ok "a mensagem unica traz os dois cards (e o erro)" $r
case "$TXT" in *"2 cards"*) r=0 ;; *) r=1 ;; esac; ok "a mensagem unica diz que sao 2 cards" $r
"$MON" rm c2 >/dev/null 2>&1; ok "rm tira o card do monitor" $?
{ "$MON" list | grep -q "^c2"; } && r=1 || r=0; ok "rm: o card nao aparece mais no list" $r

# --- 10. card caido: resume sem injecao; resume falhou: injecao -----------------------------------
# Antes: c1 estava trabalhando (ultimo_status working). Depois: virou resumable.
mundo '{"status":"working","updatedAt":'"$(agora_ms)"'}'
limpar_log; vencer; "$MON" run >/dev/null 2>&1
mundo '{"status":"resumable","updatedAt":'"$(agora_ms)"'}' null '{"resume":"ok"}'
limpar_log; vencer; "$MON" run >/dev/null 2>&1
[ "$(conta POST /api/agents/c1/resume)" = 1 ]; ok "card que caiu: o monitor chama o resume sozinho" $?
[ "$(injecoes)" = 0 ]; ok "card que caiu e voltou: nenhuma injecao" $?
mundo '{"status":"working","updatedAt":'"$(agora_ms)"'}'
limpar_log; vencer; "$MON" run >/dev/null 2>&1
mundo '{"status":"resumable","updatedAt":'"$(( $(agora_ms) + 1000 ))"'}' null '{"resume":"falha"}'
limpar_log; vencer; "$MON" run >/dev/null 2>&1
[ "$(conta POST /api/agents/c1/resume)" = 1 ]; ok "resume que falha: ele tentou o resume" $?
[ "$(injecoes)" = 1 ]; ok "resume que falhou: 1 injecao" $?
case "$(ultimo_corpo)" in *"resume automatico falhou"*"sem capacidade"*) r=0 ;; *) r=1 ;; esac; ok "a injecao diz que o resume falhou e por que" $r

# --- 11. sumiu: 1 injecao, uma vez so ---------------------------------------------------------
mundo null
limpar_log; vencer; "$MON" run >/dev/null 2>&1
[ "$(injecoes)" = 1 ]; ok "card que sumiu da lista: 1 injecao" $?
limpar_log; vencer; "$MON" run >/dev/null 2>&1
[ "$(injecoes)" = 0 ]; ok "card que sumiu: nao acorda de novo" $?

# --- 12. injecao que falha nao grava a assinatura (tenta na rodada seguinte) -----------------------
"$MON" rm c1 >/dev/null 2>&1
mundo '{"status":"working","updatedAt":'"$(agora_ms)"'}'
"$MON" add c1 --cada 1 --entregue "teste" >/dev/null 2>&1
mundo '{"status":"errored","updatedAt":'"$(( $(agora_ms) + 5000 ))"',"error":"x"}' null '{"input":"falha"}'
limpar_log; vencer; "$MON" run >"$T/o" 2>"$T/e"; c=$?
ok "injecao recusada pelo runner: a rodada sai com 6" "$([ $c = 6 ] && echo 0 || echo 1)"
grep -q "SEM_LOGIN" "$T/e"; ok "o erro traz o codigo do runner" $?
mundo '{"status":"errored","updatedAt":'"$(( $(agora_ms) + 5000 ))"',"error":"x"}' null '{"input":"ok"}'
limpar_log; vencer; "$MON" run >/dev/null 2>&1
[ "$(injecoes)" = 1 ]; ok "depois que o runner volta a aceitar, o aviso perdido e entregue" $?

# --- 13. o segredo do runner nao vaza ---------------------------------------------------------------
{ ! grep -rqF "$RUNNER_FAKE" "$T/estado" "$T/logs"; }; ok "o token nao aparece no estado nem no log" $?
python3 - "$LOG" "$RUNNER_FAKE" <<'PYEOF'
import json, sys
ls = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
sys.exit(0 if ls and all(l["auth"] == "Bearer " + sys.argv[2] for l in ls) else 1)
PYEOF
ok "o Bearer chega certo em todas as chamadas (e so no cabecalho)" $?
RUNNER_TOKEN_FILE=/nao/existe "$MON" add c1 --entregue x >/dev/null 2>"$T/e"; c=$?
ok "sem arquivo de token: sai com 3 e explica" "$([ $c = 3 ] && grep -q "RUNNER_TOKEN_FILE" "$T/e" && echo 0 || echo 1)"

# --- 14. runner fora 3 rodadas seguidas --------------------------------------------------------------
PORTA_LIVRE="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
c=0
for _ in 1 2 3; do vencer; RUNNER_PORT="$PORTA_LIVRE" "$MON" run >/dev/null 2>"$T/e"; c=$?; done
ok "runner fora: a rodada sai com 2 e diz o que fazer" "$([ $c = 2 ] && grep -q "Reiniciar no painel" "$T/e" && echo 0 || echo 1)"
grep -q "runner fora (3a rodada seguida)" "$DGCLAW_MONITOR_LOG"; ok "runner fora: 3 rodadas seguidas ficam no log" $?
grep -q "nao entregue" "$DGCLAW_MONITOR_LOG"; ok "runner fora: o aviso nao pode ser entregue, e isso fica no log para tentar de novo" $?
python3 -c 'import json,os;st=json.load(open(os.environ["DGCLAW_MONITOR_ESTADO"]));assert st["runner_falhas"]==3 and not st["runner_cutucado"]'; ok "runner fora: contador em 3 e aviso ainda pendente" $?
limpar_log; vencer; "$MON" run >/dev/null 2>&1
python3 -c 'import json,os;st=json.load(open(os.environ["DGCLAW_MONITOR_ESTADO"]));assert st["runner_falhas"]==0'; ok "runner de volta: o contador zera" $?

# --- 15. dgclaw-card abrir --monitor ---------------------------------------------------------------------
limpar_log
"$CARD" abrir --provedor codex --titulo "T" --pedido "faca" --monitor >"$T/o" 2>"$T/e"; c=$?
ok "abrir --monitor sem --entregue falha" "$([ $c = 1 ] && echo 0 || echo 1)"
grep -q -- "--entregue" "$T/e"; ok "a mensagem pede o --entregue" $?
[ ! -s "$LOG" ]; ok "abrir --monitor sem --entregue nao abre card nenhum (nenhuma chamada ao runner)" $?
"$CARD" abrir --provedor codex --titulo "T" --pedido "faca" --entregue "x" >"$T/o" 2>"$T/e"; c=$?
ok "abrir --entregue sem --monitor falha" "$([ $c = 1 ] && echo 0 || echo 1)"
# caminho feliz: o card novo (c2) existe no runner
mundo '{"status":"working","updatedAt":'"$(agora_ms)"'}' '{"status":"working","updatedAt":'"$(agora_ms)"'}' '{"novo_id":"c2"}'
"$CARD" abrir --provedor codex --titulo "T" --pedido "faca" --monitor --entregue "arquivo pronto" --cada 3 >"$T/o" 2>"$T/e"; c=$?
ok "abrir --monitor --entregue sai com 0" "$([ $c = 0 ] && echo 0 || echo 1)"
"$MON" list | grep -q "^c2.*a cada 3 min"; ok "abrir --monitor deixou o card c2 monitorado a cada 3 min" $?
# o add falha (o runner nao lista o card novo): o card fica aberto e a saida e 8, com o comando a mao
mundo '{"status":"working","updatedAt":'"$(agora_ms)"'}' null '{"novo_id":"c9"}'
"$CARD" abrir --provedor codex --titulo "T" --pedido "faca" --monitor --entregue "arquivo pronto" >"$T/o" 2>"$T/e"; c=$?
ok "add que falha: abrir sai com 8" "$([ $c = 8 ] && echo 0 || echo 1)"
grep -q "c9 esta aberto" "$T/e" && grep -q "NAO ligou" "$T/e" && grep -q "dgclaw-monitor add c9 --entregue" "$T/e"; ok "add que falha: a mensagem diz que o card ficou sem monitor e como ligar a mao" $?
[ "$(head -1 "$T/o")" = "c9" ]; ok "add que falha: o id do card ainda e impresso" $?

# --- 16. ajuda ----------------------------------------------------------------------------------------------
"$MON" ajuda | grep -q "dgclaw-monitor run"; ok "ajuda mostra os comandos" $?
"$MON" nada >/dev/null 2>&1; c=$?; ok "subcomando desconhecido sai com 1" "$([ $c = 1 ] && echo 0 || echo 1)"

echo
echo "tests/monitor: $N verificacoes, $FALHAS falharam"
[ "$FALHAS" -eq 0 ]
