#!/usr/bin/env bash
# Teste do dgclaw-controle com um dgclaw-api de mentira: parametros viram JSON sem passar pelo shell, o pedido pendente
# diz onde o TI aprova, a tarefa demorada e acompanhada, e os erros saem com codigo e motivo.
# Uso: bash bin/test/dgclaw-controle.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$AQUI/../dgclaw-controle"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FALHAS=0; N=0
ok() { N=$((N+1)); if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FALHOU $1"; FALHAS=$((FALHAS+1)); fi; }

ID=aaaaaaaaaaaaaaaaaaaaaaaa
cat >"$T/api" <<FIM
#!/usr/bin/env bash
# dgclaw-api de mentira: anota o que recebeu e responde conforme a rota.
printf '%s\t%s\t%s\n' "\$1" "\$2" "\${3:-}" >>"$T/chamadas.tsv"
resp() { printf '{"status":%s,"corpo":%s}\n' "\$1" "\$2"; }
case "\$1 \$2" in
  "POST /api/v1/controle/agentes.listar") resp 200 '{"ok":true,"resultado":{"agentes":[{"slug":"ana"}]}}' ;;
  "POST /api/v1/controle/imagem.status") resp 200 '{"ok":true,"resultado":{"saida":"imagem pronta"}}' ;;
  "POST /api/v1/controle/agente.remover") resp 202 '{"ok":true,"pendente":true,"aprovacao":"$ID","descricao":"Remover o agente ana."}' ;;
  "POST /api/v1/controle/agente.criar")
      resp 200 '{"ok":true,"resultado":{"tarefa":"abcdef012345","estado":"rodando"}}' ;;
  "POST /api/v1/controle/tarefa.ver")
      n=\$(cat "$T/n" 2>/dev/null || echo 0); echo \$((n+1)) >"$T/n"
      if [ -f "$T/tarefa-erro" ]; then resp 200 '{"ok":true,"resultado":{"tarefa":{"estado":"erro","erro":"o comando caiu"}}}'
      elif [ "\$n" -ge 1 ] || [ -f "$T/tarefa-pronta" ]; then resp 200 '{"ok":true,"resultado":{"tarefa":{"estado":"ok","resultado":{"saida":"ana criada"}}}}'
      else resp 200 '{"ok":true,"resultado":{"tarefa":{"estado":"rodando"}}}'; fi ;;
  "POST /api/v1/controle/agente.reparar") resp 400 '{"ok":false,"motivo":"parametros","erro":"Falta o parametro agente."}'; echo "Falta o parametro agente." >&2; exit 4 ;;
  "GET /api/v1/aprovacoes/$ID") resp 200 "{\"ok\":true,\"aprovacao\":{\"estado\":\"\$(cat "$T/estado")\"}}" ;;
  "GET /api/v1/controle/docs.md") echo "# Controle do servidor"; exit 0 ;;
  *) resp 404 '{"ok":false,"erro":"rota desconhecida"}'; exit 4 ;;
esac
FIM
chmod +x "$T/api"
export DGCLAW_API="$T/api"
corpo_enviado() { tail -n 1 "$T/chamadas.tsv" | cut -f3; }

SAIDA="$("$BIN" agentes.listar 2>"$T/err")"; RC=$?
[ "$RC" = 0 ] && [ "$(printf '%s' "$SAIDA" | jq -c .)" = '{"agentes":[{"slug":"ana"}]}' ]
ok "leitura imprime o resultado em JSON" $?

SAIDA="$("$BIN" imagem.status 2>&1)"
[ "$SAIDA" = "imagem pronta" ]
ok "resultado so com texto sai cru" $?

# shellcheck disable=SC2016 # o $(id) e de proposito: tem de chegar como texto
"$BIN" agente.criar --slug ana --nome 'Ana $(id); "x"' --papel "agenda" --espera 0 >/dev/null 2>&1
# shellcheck disable=SC2016
[ "$(corpo_enviado | jq -c .)" = '{"params":{"slug":"ana","nome":"Ana $(id); \"x\"","papel":"agenda"}}' ]
ok "parametros viram JSON sem o shell interpretar nada" $?

SAIDA="$("$BIN" agente.remover --agente ana 2>"$T/err")"; RC=$?
[ "$RC" = 0 ] && [ "$(printf '%s' "$SAIDA" | jq -r .aprovacao)" = "$ID" ]
ok "perigosa sai com 0 e o JSON do pedido pendente" $?
grep -q "NAO foi executada" "$T/err" && grep -q "/aprovacoes" "$T/err" && grep -q "dgclaw-controle pedido $ID" "$T/err"
ok "a mensagem diz que nao executou, onde o TI aprova e como acompanhar" $?

rm -f "$T/n"
SAIDA="$("$BIN" agente.criar --slug ana --nome Ana --espera 10 2>"$T/err")"; RC=$?
[ "$RC" = 0 ] && [ "$SAIDA" = "ana criada" ]
ok "operacao demorada: acompanha a tarefa ate terminar e imprime o resultado" $?

touch "$T/tarefa-erro"
"$BIN" agente.criar --slug ana --nome Ana --espera 10 >/dev/null 2>"$T/err"; RC=$?
[ "$RC" = 6 ] && grep -q "o comando caiu" "$T/err"
ok "tarefa que termina com erro sai com 6 e diz o motivo" $?
rm -f "$T/tarefa-erro"

SAIDA="$("$BIN" agente.criar --slug ana --nome Ana --espera 0 2>"$T/err")"; RC=$?
[ "$RC" = 0 ] && grep -q "dgclaw-controle tarefa abcdef012345" "$T/err"
ok "--espera 0 nao espera e diz como acompanhar" $?

"$BIN" agente.reparar >"$T/out" 2>"$T/err"; RC=$?
[ "$RC" = 4 ] && grep -q "parametros" "$T/out" && grep -q "Falta o parametro agente" "$T/err"
ok "recusa do controle: codigo 4, JSON no stdout e motivo no stderr" $?

echo pendente >"$T/estado"; "$BIN" pedido "$ID" >/dev/null 2>"$T/err"
grep -q "ainda espera uma pessoa do TI" "$T/err"
ok "pedido pendente: explica que nada foi executado" $?
echo recusada >"$T/estado"; "$BIN" pedido "$ID" >/dev/null 2>"$T/err"
grep -q "recusou" "$T/err"
ok "pedido recusado: manda nao tentar de novo" $?
echo executada >"$T/estado"; "$BIN" pedido "$ID" >/dev/null 2>"$T/err"
grep -q "foi executada" "$T/err"
ok "pedido executado: diz que foi feito" $?

"$BIN" pedido nao-e-id >/dev/null 2>"$T/err"; RC=$?
[ "$RC" = 1 ] && grep -q "24 caracteres" "$T/err"
ok "identificador de pedido invalido e recusado no cliente" $?

"$BIN" 'rm -rf' >/dev/null 2>"$T/err"; RC=$?
[ "$RC" = 1 ] && grep -q "nao e uma operacao" "$T/err"
ok "nome de operacao fora do formato e recusado" $?
"$BIN" agente.parar --agente >/dev/null 2>"$T/err"; RC=$?
[ "$RC" = 1 ] && grep -q "falta o valor" "$T/err"
ok "parametro sem valor e recusado" $?
"$BIN" agente.parar 'ana' >/dev/null 2>"$T/err"; RC=$?
[ "$RC" = 1 ]
ok "argumento solto e recusado" $?
"$BIN" agente.parar --agente ana --espera 9999 >/dev/null 2>"$T/err"; RC=$?
[ "$RC" = 1 ] && grep -q "0 a 600" "$T/err"
ok "--espera fora do limite e recusado" $?

SAIDA="$("$BIN" ops 2>&1)"
[ "$SAIDA" = "# Controle do servidor" ]
ok "ops mostra a lista de operacoes" $?
"$BIN" ajuda 2>&1 | grep -q "Operacoes perigosas nao executam"
ok "ajuda explica a aprovacao" $?

echo "dgclaw-controle.test.sh: $N verificacoes, $FALHAS falharam"
[ "$FALHAS" -eq 0 ]
