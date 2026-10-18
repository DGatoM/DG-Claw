#!/usr/bin/env bash
# Teste do dgclaw-ferramenta com um dgclaw-api de mentira: parametros viram JSON sem passar pelo shell, a lista sai
# crua, o resultado sai sem o envelope, e a recusa do servidor vira codigo de saida 4 com o motivo.
# Uso: bash bin/test/dgclaw-ferramenta.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$AQUI/../dgclaw-ferramenta"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FALHAS=0; N=0
ok() { N=$((N+1)); if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FALHOU $1"; FALHAS=$((FALHAS+1)); fi; }

cat >"$T/api" <<FIM
#!/usr/bin/env bash
# dgclaw-api de mentira: anota o que recebeu e responde conforme a rota.
printf '%s\t%s\t%s\n' "\$1" "\$2" "\${3:-}" >>"$T/chamadas.tsv"
case "\$1 \$2" in
  "GET /api/v1/ferramentas") echo '{"ok":true,"ferramentas":[{"nome":"carteira.resumo"}]}'; exit 0 ;;
  "POST /api/v1/ferramentas/carteira.resumo")
      echo '{"ok":true,"ferramenta":"carteira.resumo","resultado":{"grupos":[{"pessoas":22}]},"verificador":"aprovado"}'; exit 0 ;;
  "POST /api/v1/ferramentas/relatorio")
      echo '{"ok":true,"resultado":{"gerado":true},"arquivo":{"caminho":"/home/ana/.dgclaw/entregas/x-resumo.csv","expira_em":"2026-11-17T12:00:00Z"}}'; exit 0 ;;
  "POST /api/v1/ferramentas/cpf")
      echo '{"ok":false,"motivo":"bloqueado_pelo_verificador","erro":"O resultado foi bloqueado porque continha dado pessoal (tipo CPF)."}'
      echo "O resultado foi bloqueado porque continha dado pessoal (tipo CPF)." >&2; exit 4 ;;
  *) echo '{"ok":false,"erro":"rota desconhecida"}'; exit 4 ;;
esac
FIM
chmod +x "$T/api"
export DGCLAW_API="$T/api"
corpo_enviado() { tail -n 1 "$T/chamadas.tsv" | cut -f3; }

SAIDA="$("$BIN" listar 2>"$T/err")"; RC=$?
[ "$RC" = 0 ] && [ "$(printf '%s' "$SAIDA" | jq -r '.ferramentas[0].nome')" = carteira.resumo ]; ok "listar imprime a lista que o servidor mandou" $?

SAIDA="$("$BIN" carteira.resumo --periodo 2026-09 --agrupar_por faixa_etaria 2>"$T/err")"; RC=$?
[ "$RC" = 0 ] && [ "$(printf '%s' "$SAIDA" | jq -c .)" = '{"grupos":[{"pessoas":22}]}' ]; ok "executar imprime so o resultado, sem o envelope" $?
[ "$(corpo_enviado | jq -cS .)" = '{"params":{"agrupar_por":"faixa_etaria","periodo":"2026-09"}}' ]; ok "os parametros viram JSON" $?

# shellcheck disable=SC2016 # o cifrao e as aspas sao o proprio teste: precisam chegar como texto
PERIGOSO='2026-09"; $(id)'
"$BIN" carteira.resumo --periodo "$PERIGOSO" >/dev/null 2>&1
[ "$(corpo_enviado | jq -r '.params.periodo')" = "$PERIGOSO" ]; ok "aspas e cifrao no valor chegam como texto, sem ser interpretados" $?

SAIDA="$("$BIN" relatorio 2>"$T/err")"; RC=$?
[ "$RC" = 0 ] && grep -q "relatorio gravado em /home/ana/.dgclaw/entregas/x-resumo.csv" "$T/err"; ok "relatorio gerado: o caminho e o prazo saem no stderr" $?

"$BIN" cpf >"$T/out" 2>"$T/err"; RC=$?
[ "$RC" = 4 ] && grep -q "bloqueado" "$T/err" && grep -q "bloqueado_pelo_verificador" "$T/out"; ok "resultado bloqueado: codigo 4, motivo no stderr e no corpo" $?

"$BIN" 'Carteira' >/dev/null 2>"$T/err"; RC=$?
[ "$RC" = 1 ] && grep -q "nao e o nome de uma ferramenta" "$T/err"; ok "nome fora do formato e recusado antes de chamar o servidor" $?
"$BIN" carteira.resumo periodo >/dev/null 2>"$T/err"; RC=$?
[ "$RC" = 1 ] && grep -q "nao entendi" "$T/err"; ok "argumento sem -- e recusado" $?
"$BIN" carteira.resumo --periodo >/dev/null 2>"$T/err"; RC=$?
[ "$RC" = 1 ] && grep -q "falta o valor de --periodo" "$T/err"; ok "parametro sem valor e recusado" $?
"$BIN" ajuda 2>&1 | grep -q "Se o verificador de saida achar dado pessoal"; ok "a ajuda explica o bloqueio" $?

echo "dgclaw-ferramenta: $N verificacoes, $FALHAS falharam"
[ "$FALHAS" -eq 0 ]
