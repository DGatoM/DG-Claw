#!/usr/bin/env bash
# shellcheck disable=SC2046,SC2319
# Teste do dgclaw-mesa com um dgclaw-api FALSO. Uso: bash bin/test/dgclaw-mesa.test.sh
# O falso registra metodo, rota e corpo de cada chamada e devolve a resposta e o codigo configurados.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$AQUI/../dgclaw-mesa"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FALHAS=0; N=0
ok() { N=$((N+1)); if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FALHOU $1"; FALHAS=$((FALHAS+1)); fi; }

export HOME="$T/casa"; mkdir -p "$HOME"
export DGCLAW_SLUG="luna"
export FAKE_DIR="$T/fake"; mkdir -p "$FAKE_DIR"
export DGCLAW_API_BIN="$T/dgclaw-api"

cat > "$DGCLAW_API_BIN" <<'EOF'
#!/usr/bin/env bash
# Falso dgclaw-api: grava "METODO ROTA" em chamadas.log e o corpo (stdin quando o ultimo argumento e "-") em corpos.log.
printf '%s %s\n' "$1" "$2" >> "$FAKE_DIR/chamadas.log"
if [ "${3:-}" = "-" ]; then cat >> "$FAKE_DIR/corpos.log"; printf '\n' >> "$FAKE_DIR/corpos.log"; else printf '(sem corpo)\n' >> "$FAKE_DIR/corpos.log"; fi
[ ! -f "$FAKE_DIR/err" ] || cat "$FAKE_DIR/err" >&2
[ ! -f "$FAKE_DIR/resp" ] || cat "$FAKE_DIR/resp"
exit "$(cat "$FAKE_DIR/codigo" 2>/dev/null || echo 0)"
EOF
chmod +x "$DGCLAW_API_BIN"

# prepara RESP [CODIGO] [ERR]: zera o registro e define o que o falso devolve.
prepara() {
  rm -f "$FAKE_DIR"/*
  printf '%s' "$1" > "$FAKE_DIR/resp"
  printf '%s' "${2:-0}" > "$FAKE_DIR/codigo"
  [ -z "${3:-}" ] || printf '%s\n' "$3" > "$FAKE_DIR/err"
}
# rodar ARGS...: guarda saida em $T/o, erro em $T/e e o codigo em C.
rodar() { C=0; rm -f "$FAKE_DIR/chamadas.log" "$FAKE_DIR/corpos.log"; "$BIN" "$@" >"$T/o" 2>"$T/e" || C=$?; }
chamada() { sed -n "${1:-1}p" "$FAKE_DIR/chamadas.log"; }
corpo() { sed -n "${1:-1}p" "$FAKE_DIR/corpos.log"; }
# corpo_igual JSON_ESPERADO [linha]: compara como JSON, sem depender da ordem das chaves.
corpo_igual() { jq -e --argjson e "$1" '. == $e' <<<"$(corpo "${2:-1}")" >/dev/null 2>&1; }

T12='{"ok":true,"tarefa":{"id":12,"agente":"luna","titulo":"Roteiro do reels","estado":"fazendo","parada":false,"progresso":60,"motivo":null,"link":null}}'

# --- criar -------------------------------------------------------------------
prepara "$T12" 0
rodar criar --titulo "Roteiro do reels" --origem "Dono, 05/10 15h42: faz o roteiro" --tipo conteudo --passo pesquisa --passo roteiro --nota "comecando" --link "https://x.test/a" --progresso 10
ok "criar sai com 0" $([ $C = 0 ] && echo 0 || echo 1)
[ "$(chamada)" = "POST /api/v1/tarefas" ]; ok "criar faz POST /api/v1/tarefas" $?
corpo_igual '{"titulo":"Roteiro do reels","origem":"Dono, 05/10 15h42: faz o roteiro","tipo":"conteudo","passos":["pesquisa","roteiro"],"nota":"comecando","link":"https://x.test/a","progresso":10}'; ok "criar monta o corpo certo" $?
[ "$(cat "$T/o")" = 'tarefa #12 criada (fazendo) "Roteiro do reels"' ]; ok "criar imprime a frase combinada" $?

TITULO_DIFICIL=$'Aspas "duplas", \'simples\', barra \\ e $(echo pwn) `id`\nsegunda linha: ação ç ã'
prepara "$T12" 0
rodar criar --titulo "$TITULO_DIFICIL" --origem "origem com \$(touch $T/invadido) e acento é" --passo $'passo "um"\ncom quebra'
corpo_igual "$(jq -nc --arg t "$TITULO_DIFICIL" --arg o "origem com \$(touch $T/invadido) e acento é" --arg p $'passo "um"\ncom quebra' '{titulo:$t,origem:$o,passos:[$p]}')"; ok "criar leva aspas, barra, quebra de linha, \$() e acentos intactos" $?
[ ! -e "$T/invadido" ]; ok "criar nao executa \$() do texto" $?

rodar criar --origem "x"
ok "criar sem --titulo sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
grep -q -- "--titulo" "$T/e"; ok "criar sem --titulo explica o que falta" $?
rodar criar --titulo "x"
ok "criar sem --origem sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rodar criar --titulo x --origem y --progresso 150
ok "criar com progresso fora de 0 a 100 sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rodar criar --titulo x --origem y --progresso abc
ok "criar com progresso que nao e numero sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rodar criar --titulo x --origem y --bobagem 1
ok "criar com opcao desconhecida sai com 1" $([ $C = 1 ] && echo 0 || echo 1)

# --- atualizar ---------------------------------------------------------------
prepara "$T12" 0
rodar atualizar 12 --progresso 60 --nota "escrevendo o gancho" --link "https://x.test/b" --titulo "Novo titulo"
ok "atualizar sai com 0" $([ $C = 0 ] && echo 0 || echo 1)
[ "$(chamada)" = "PATCH /api/v1/tarefas/12" ]; ok "atualizar faz PATCH /api/v1/tarefas/<id>" $?
corpo_igual '{"progresso":60,"nota":"escrevendo o gancho","link":"https://x.test/b","titulo":"Novo titulo"}'; ok "atualizar manda so o que veio" $?
grep -q "tarefa #12 atualizada (fazendo, 60%)" "$T/o"; ok "atualizar imprime estado e progresso" $?
prepara "$T12" 0
rodar atualizar 12 --passo "a" --passo "b"
corpo_igual '{"passos":["a","b"]}'; ok "atualizar --passo repetido troca a lista de passos" $?
prepara '{"ok":true,"tarefa":{"id":12,"estado":"fazendo","parada":true,"progresso":null}}' 0
rodar atualizar 12 --nota "x"
grep -q "(fazendo (parada?), sem medida)" "$T/o"; ok "atualizar mostra 'sem medida' (null nao vira 0) e 'parada?'" $?
rodar atualizar 12
ok "atualizar sem nada sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rodar atualizar abc --nota x
ok "atualizar com id que nao e numero sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rodar atualizar --nota x
ok "atualizar sem id sai com 1" $([ $C = 1 ] && echo 0 || echo 1)

# --- passo -------------------------------------------------------------------
prepara "$T12" 0
rodar passo 12 1
[ "$(chamada)" = "PATCH /api/v1/tarefas/12" ] && corpo_igual '{"passo_feito":1}'; ok "passo com numero manda passo_feito numerico" $?
grep -q "tarefa #12: passo 1 feito" "$T/o"; ok "passo imprime a frase" $?
prepara "$T12" 0
rodar passo 12 "revisão \"final\"" --desfazer
corpo_igual '{"passo_desfeito":"revisão \"final\""}'; ok "passo --desfazer com texto manda passo_desfeito em texto" $?
rodar passo 12
ok "passo sem o numero sai com 1" $([ $C = 1 ] && echo 0 || echo 1)

# --- pedir, travar, retomar, concluir ----------------------------------------
prepara '{"ok":true,"tarefa":{"id":12,"estado":"esperando_dono","motivo":"gancho A ou B?","parada":false,"progresso":null}}' 0
rodar pedir 12 --motivo "gancho A ou B?"
[ "$(chamada)" = "PATCH /api/v1/tarefas/12" ] && corpo_igual '{"estado":"esperando_dono","motivo":"gancho A ou B?"}'; ok "pedir manda estado esperando_dono e motivo" $?
[ "$(cat "$T/o")" = "tarefa #12: esperando você: gancho A ou B?" ]; ok "pedir imprime 'esperando você: motivo'" $?
rodar pedir 12
ok "pedir sem motivo sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rodar pedir 12 --motivo "   "
ok "pedir com motivo em branco sai com 1" $([ $C = 1 ] && echo 0 || echo 1)

prepara '{"ok":true,"tarefa":{"id":12,"estado":"travada","motivo":"a API caiu","parada":false}}' 0
rodar travar 12 --motivo "a API caiu"
corpo_igual '{"estado":"travada","motivo":"a API caiu"}'; ok "travar manda estado travada e motivo" $?
[ "$(cat "$T/o")" = "tarefa #12: travada: a API caiu" ]; ok "travar imprime a frase" $?
rodar travar 12
ok "travar sem motivo sai com 1" $([ $C = 1 ] && echo 0 || echo 1)

prepara "$T12" 0
rodar retomar 12 --nota "dono escolheu o B"
corpo_igual '{"estado":"fazendo","nota":"dono escolheu o B"}'; ok "retomar manda estado fazendo e a nota" $?
grep -q "tarefa #12: de volta a fazendo" "$T/o"; ok "retomar imprime a frase" $?

prepara '{"ok":true,"tarefa":{"id":12,"titulo":"Roteiro do reels","estado":"concluida","link":"https://x.test/final","progresso":100}}' 0
rodar concluir 12 --link "https://x.test/final" --nota "entregue"
corpo_igual '{"estado":"concluida","link":"https://x.test/final","nota":"entregue"}'; ok "concluir manda estado concluida, link e nota" $?
[ "$(cat "$T/o")" = 'tarefa #12 concluída "Roteiro do reels" (https://x.test/final)' ]; ok "concluir imprime a frase com o link" $?
prepara '{"ok":true,"tarefa":{"id":12,"titulo":"T","estado":"concluida","link":null}}' 0
rodar concluir 12
corpo_igual '{"estado":"concluida"}'; ok "concluir sem opcoes manda so o estado" $?

# --- cancelar, vivo, ver -----------------------------------------------------
prepara '{"ok":true,"tarefa":{"id":12,"estado":"cancelada"}}' 0
rodar cancelar 12 --motivo "o dono desistiu"
[ "$(chamada)" = "DELETE /api/v1/tarefas/12" ] && corpo_igual '{"motivo":"o dono desistiu"}'; ok "cancelar faz DELETE com o motivo no corpo" $?
[ "$(cat "$T/o")" = "tarefa #12 cancelada" ]; ok "cancelar imprime a frase" $?
prepara '{"ok":true,"ja_estava":true,"tarefa":{"id":12,"estado":"cancelada"}}' 0
rodar cancelar 12
corpo_igual '{}'; ok "cancelar sem motivo manda corpo vazio" $?
grep -q "já estava cancelada" "$T/o"; ok "cancelar repetido avisa que ja estava" $?

prepara "$T12" 0
rodar vivo 12
[ "$(chamada)" = "PATCH /api/v1/tarefas/12" ] && corpo_igual '{}'; ok "vivo faz PATCH {}" $?
grep -q "sinal de vida" "$T/o"; ok "vivo imprime a frase" $?

prepara '{"ok":true,"tarefa":{"id":12,"agente":"luna","titulo":"Roteiro","estado":"fazendo","parada":false,"progresso":50,"origem":"Dono, 05/10: faz","tipo":"conteudo","nota":"no gancho","link":null,"passos":[{"texto":"pesquisa","feito":true},{"texto":"roteiro","feito":false}],"anexos":[{"rotulo":"Planilha","url":"https://x.test/p"}],"atualizada_ha_min":3,"eventos":[{"em":"2026-10-05T16:00:00-03:00","por":"agente luna","acao":"atualizou"}]}}' 0
rodar ver 12
[ "$(chamada)" = "GET /api/v1/tarefas/12" ]; ok "ver faz GET /api/v1/tarefas/<id>" $?
grep -q "^tarefa #12 \[luna\] Roteiro" "$T/o" && grep -q "1. \[x\] pesquisa" "$T/o" && grep -q "2. \[ \] roteiro" "$T/o" && grep -q "Planilha: https://x.test/p" "$T/o" && grep -q "agente luna: atualizou" "$T/o"; ok "ver mostra cabecalho, passos, anexos e historico" $?

# --- listar ------------------------------------------------------------------
LISTA='{"ok":true,"tarefas":[{"id":12,"agente":"luna","titulo":"Roteiro","estado":"esperando_dono","progresso":null,"motivo":"A ou B?","parada":false},{"id":9,"agente":"marina","titulo":"Post","estado":"fazendo","progresso":40,"motivo":null,"parada":true}]}'
prepara "$LISTA" 0
rodar listar
[ "$(chamada)" = "GET /api/v1/tarefas?agente=luna" ]; ok "listar filtra pelo meu slug" $?
grep -q '^#12 esperando_dono sem medida "Roteiro" | motivo: A ou B?$' "$T/o"; ok "listar mostra id, estado, 'sem medida', titulo e motivo" $?
grep -q '^#9 fazendo (parada?) 40% "Post"$' "$T/o"; ok "listar mostra progresso e 'parada?'" $?
rodar listar --todos
[ "$(chamada)" = "GET /api/v1/tarefas" ]; ok "listar --todos nao filtra por agente" $?
grep -q '^\[marina\] #9 ' "$T/o"; ok "listar --todos mostra de quem e cada tarefa" $?
rodar listar --dia todos
[ "$(chamada)" = "GET /api/v1/tarefas?agente=luna&dia=todos" ]; ok "listar --dia todos acrescenta dia=todos" $?
rodar listar --dia 2026-10-04 --todos
[ "$(chamada)" = "GET /api/v1/tarefas?dia=2026-10-04" ]; ok "listar --dia AAAA-MM-DD --todos" $?
rodar listar --dia ontem
ok "listar com --dia invalido sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
prepara '{"ok":true,"tarefas":[]}' 0
rodar listar
grep -q "nenhuma tarefa" "$T/o"; ok "listar sem tarefas diz que nao ha" $?
prepara "$LISTA" 0
( unset DGCLAW_SLUG; rodar listar; [ "$C" = 0 ] && [ "$(chamada)" = "GET /api/v1/tarefas" ] && grep -q "DGCLAW_SLUG" "$T/e" ); ok "listar sem DGCLAW_SLUG lista tudo e avisa no stderr" $?

# --- --retrato ---------------------------------------------------------------
mkdir -p "$HOME/.dgclaw/retratos"
printf '%s' '{"atualizado_em":"2026-10-05T16:00:00-03:00","tarefas":[{"id":12,"titulo":"Roteiro","estado":"fazendo","progresso":50,"motivo":null,"parada":false}]}' > "$HOME/.dgclaw/retratos/mesa.json"
prepara "$LISTA" 0
rodar listar --retrato
ok "listar --retrato sai com 0" $([ $C = 0 ] && echo 0 || echo 1)
[ ! -s "$FAKE_DIR/chamadas.log" ] 2>/dev/null; ok "listar --retrato nao chama o Web" $?
grep -q "última cópia" "$T/o" && grep -q "2026-10-05T16:00:00-03:00" "$T/o" && grep -q '^#12 fazendo 50% "Roteiro"$' "$T/o"; ok "listar --retrato avisa que e copia (com atualizado_em) e lista" $?
rodar listar --retrato --json
jq -e '.tarefas[0].id == 12' "$T/o" >/dev/null && grep -q "última cópia" "$T/e"; ok "listar --retrato --json: JSON limpo no stdout e aviso no stderr" $?
rodar listar --retrato --todos
ok "listar --retrato --todos sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rm -f "$HOME/.dgclaw/retratos/mesa.json"
rodar listar --retrato
ok "listar --retrato sem arquivo sai com 1 e explica" $([ $C = 1 ] && grep -q "retrato" "$T/e" && echo 0 || echo 1)

# --- --json ------------------------------------------------------------------
prepara "$T12" 0
rodar criar --titulo x --origem y --json
[ "$(cat "$T/o")" = "$T12" ]; ok "--json imprime a resposta crua da API (criar)" $?
rodar ver 12 --json
[ "$(cat "$T/o")" = "$T12" ]; ok "--json imprime a resposta crua da API (ver)" $?
rodar vivo 12 --json
[ "$(cat "$T/o")" = "$T12" ]; ok "--json imprime a resposta crua da API (vivo)" $?

# --- codigos de saida e mensagens --------------------------------------------
prepara '' 2
rodar vivo 12
ok "web fora do ar (2) repassa o 2" $([ $C = 2 ] && echo 0 || echo 1)
grep -q "não respondeu" "$T/e" && grep -q "PATCH /api/v1/tarefas/12" "$T/e"; ok "saida 2 diz o que falhou e o que fazer" $?
prepara '' 3 "dgclaw-api: a pasta da caixa nao existe"
rodar listar
ok "caixa indisponivel (3) repassa o 3" $([ $C = 3 ] && echo 0 || echo 1)
grep -q "sudo dgclaw agente reparar luna" "$T/e"; ok "saida 3 manda pedir o reparo com o slug" $?
prepara '{"ok":false,"erro":"Dados inválidos.","erros":{"motivo":"obrigatório quando o estado é travada","progresso":"deve ir de 0 a 100"}}' 4 "dgclaw-api: HTTP 400"
rodar atualizar 12 --nota x
ok "recusa 4xx repassa o 4" $([ $C = 4 ] && echo 0 || echo 1)
grep -q "Dados inválidos." "$T/e" && grep -q "motivo: obrigatório quando o estado é travada" "$T/e" && grep -q "progresso: deve ir de 0 a 100" "$T/e"; ok "saida 4 mostra a frase do erro e os erros campo a campo" $?
prepara '{"ok":false,"erro":"O agente luna só mexe nas próprias tarefas."}' 4
rodar vivo 99
grep -q "só mexe nas próprias tarefas" "$T/e"; ok "saida 4 sem 'erros' mostra so a frase" $?
prepara '{"ok":false,"erro":"O arquivo da mesa não abriu."}' 5
rodar vivo 12
ok "erro 5xx repassa o 5" $([ $C = 5 ] && echo 0 || echo 1)
grep -q "O arquivo da mesa não abriu." "$T/e"; ok "saida 5 mostra a frase do erro" $?
prepara 'isto nao e json' 0
rodar vivo 12
ok "resposta que nao e JSON nao finge sucesso (5)" $([ $C = 5 ] && echo 0 || echo 1)

# --- fila de pedidos (dgclaw-mesa pedido ...) ---------------------------------
P7='{"ok":true,"pedido":{"id":7,"agente":"luna","texto":"Dono, 12/11 10h25: refazer a capa","estado":"fazendo","motivo":null,"msg_entrega":null,"criado_em":"2026-11-12T10:25:00-03:00","historico":[{"em":"2026-11-12T10:25:00-03:00","por":"agente luna","de":null,"para":"fazendo"}]}}'
prepara "$P7" 0
rodar pedido criar --texto "Dono, 12/11 10h25: refazer a capa"
ok "pedido criar sai com 0" $([ $C = 0 ] && echo 0 || echo 1)
[ "$(chamada)" = "POST /api/v1/pedidos" ]; ok "pedido criar faz POST /api/v1/pedidos" $?
corpo_igual '{"texto":"Dono, 12/11 10h25: refazer a capa"}'; ok "pedido criar manda so o texto" $?
[ "$(cat "$T/o")" = "pedido #7 criado (fazendo)" ]; ok "pedido criar imprime o id" $?
rodar pedido criar --texto "Aspas \"x\" e \$(touch $T/invadido2) e acento é"
corpo_igual "$(jq -nc --arg t "Aspas \"x\" e \$(touch $T/invadido2) e acento é" '{texto:$t}')"; ok "pedido criar leva aspas, \$() e acentos intactos" $?
[ ! -e "$T/invadido2" ]; ok "pedido criar nao executa \$() do texto" $?
rodar pedido criar
ok "pedido criar sem --texto sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
grep -q -- "--texto" "$T/e"; ok "pedido criar sem --texto explica o que falta" $?
rodar pedido criar --texto x --bobagem 1
ok "pedido criar com opcao desconhecida sai com 1" $([ $C = 1 ] && echo 0 || echo 1)

prepara '{"ok":true,"pedido":{"id":7,"estado":"esperando_dono","motivo":"capa azul ou verde?"}}' 0
rodar pedido esperar 7 --motivo "capa azul ou verde?"
[ "$(chamada)" = "PATCH /api/v1/pedidos/7" ] && corpo_igual '{"estado":"esperando_dono","motivo":"capa azul ou verde?"}'; ok "pedido esperar faz PATCH com estado e motivo" $?
grep -q "pedido #7: esperando você: capa azul ou verde?" "$T/o"; ok "pedido esperar imprime o motivo" $?
rodar pedido esperar 7
ok "pedido esperar sem --motivo sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rodar pedido esperar --motivo x
ok "pedido esperar sem id sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
grep -q "falta o id do pedido" "$T/e"; ok "o erro de id fala em pedido, nao em tarefa" $?
rodar pedido esperar abc --motivo x
ok "pedido com id que nao e numero sai com 1" $([ $C = 1 ] && echo 0 || echo 1)

prepara '{"ok":true,"pedido":{"id":7,"estado":"fazendo"}}' 0
rodar pedido fazendo 7
[ "$(chamada)" = "PATCH /api/v1/pedidos/7" ] && corpo_igual '{"estado":"fazendo"}'; ok "pedido fazendo faz PATCH estado fazendo" $?

prepara '{"ok":true,"pedido":{"id":7,"estado":"entregue"}}' 0
rodar pedido entregar 7
[ "$(chamada)" = "PATCH /api/v1/pedidos/7" ] && corpo_igual '{"estado":"entregue"}'; ok "pedido entregar sem --msg manda so o estado" $?
[ "$(cat "$T/o")" = "pedido #7 entregue" ]; ok "pedido entregar imprime a frase" $?
rodar pedido entregar 7 --msg 3fa9c01b22d4e7a1
corpo_igual '{"estado":"entregue","msg":"3fa9c01b22d4e7a1"}'; ok "pedido entregar --msg leva o id da mensagem" $?
prepara '{"ok":true,"pedido":{"id":7,"estado":"entregue"},"aviso":"sem apontar a mensagem"}' 0
rodar pedido entregar 7
grep -q "aviso: sem apontar a mensagem" "$T/o"; ok "pedido entregar mostra o aviso do servidor" $?

prepara '{"ok":false,"erro":"O agente não marca o pedido #7 como feito."}' 4 "dgclaw-api: HTTP 403"
rodar pedido entregar 7
ok "recusa do Web em pedido sai com 4" $([ $C = 4 ] && echo 0 || echo 1)
grep -q "não marca o pedido #7 como feito" "$T/e"; ok "pedido recusado mostra a frase do Web" $?

prepara '{"ok":true,"pedido":{"id":7,"estado":"cancelado"}}' 0
rodar pedido cancelar 7 --motivo "o dono desistiu"
[ "$(chamada)" = "DELETE /api/v1/pedidos/7" ] && corpo_igual '{"motivo":"o dono desistiu"}'; ok "pedido cancelar faz DELETE com o motivo" $?
[ "$(cat "$T/o")" = "pedido #7 cancelado" ]; ok "pedido cancelar imprime a frase" $?
rodar pedido cancelar 7
ok "pedido cancelar sem --motivo sai com 1" $([ $C = 1 ] && echo 0 || echo 1)

prepara "$P7" 0
rodar pedido ver 7
[ "$(chamada)" = "GET /api/v1/pedidos/7" ]; ok "pedido ver faz GET /api/v1/pedidos/<id>" $?
grep -q "pedido #7 Dono, 12/11 10h25: refazer a capa" "$T/o" && grep -q "agente luna: - para fazendo" "$T/o"; ok "pedido ver mostra o pedido e o historico" $?

prepara '{"ok":true,"pedidos":[{"id":7,"estado":"esperando_dono","texto":"refazer a capa","motivo":"azul ou verde?"},{"id":8,"estado":"fazendo","texto":"post","motivo":null}]}' 0
rodar pedido listar
[ "$(chamada)" = "GET /api/v1/pedidos" ]; ok "pedido listar faz GET /api/v1/pedidos" $?
grep -q '^#7 esperando_dono "refazer a capa" | motivo: azul ou verde?$' "$T/o" && grep -q '^#8 fazendo "post"$' "$T/o"; ok "pedido listar imprime uma linha por pedido" $?
rodar pedido listar --dia todos
[ "$(chamada)" = "GET /api/v1/pedidos?dia=todos" ]; ok "pedido listar --dia vai na query" $?
rodar pedido listar --dia amanha
ok "pedido listar com --dia invalido sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
prepara '{"ok":true,"pedidos":[]}' 0
rodar pedido listar
grep -q "nenhum pedido." "$T/o"; ok "pedido listar vazio diz que nao ha pedido" $?
rodar pedido listar --json
[ "$(jq -c . "$T/o")" = '{"ok":true,"pedidos":[]}' ]; ok "pedido listar --json imprime a resposta crua" $?

rodar pedido
ok "pedido sem acao sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rodar pedido voar 7
ok "pedido com acao desconhecida sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
prepara '' 2
rodar pedido fazendo 7
ok "web fora do ar em pedido repassa o 2" $([ $C = 2 ] && echo 0 || echo 1)
rodar ajuda
grep -q "dgclaw-mesa pedido entregar" "$T/o"; ok "ajuda mostra os comandos de pedido" $?

# --- dgclaw-api ausente ------------------------------------------------------
( export DGCLAW_API_BIN="$T/nao-existe"; rodar vivo 12; [ "$C" = 3 ] && grep -q "não está instalada" "$T/e" && grep -q "reparar" "$T/e" ); ok "sem dgclaw-api sai com 3 e diz o que fazer" $?

# --- ajuda e uso errado ------------------------------------------------------
rodar ajuda
ok "ajuda sai com 0" $([ $C = 0 ] && echo 0 || echo 1)
grep -q "dgclaw-mesa criar" "$T/o" && grep -q "Codigos de saida" "$T/o"; ok "ajuda mostra o uso e os codigos de saida" $?
rodar
ok "sem argumentos mostra a ajuda (0)" $([ $C = 0 ] && echo 0 || echo 1)
rodar voar 12
ok "subcomando desconhecido sai com 1" $([ $C = 1 ] && echo 0 || echo 1)
rodar vivo 12 13
ok "argumento a mais sai com 1" $([ $C = 1 ] && echo 0 || echo 1)

echo
echo "$N verificacoes, $FALHAS falhas"
[ "$FALHAS" = 0 ]
