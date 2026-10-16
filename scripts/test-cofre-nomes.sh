#!/usr/bin/env bash
# Teste do cofre-nomes.sh: so nomes saem, nunca valores.
set -u
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
falhas=0
ok() { if [ "$2" = "$3" ]; then echo "  ok     $1"; else echo "  FALHOU $1: esperado [$2], veio [$3]"; falhas=$((falhas+1)); fi; }

printf '# comentario\n\nOPENAI_API_KEY=valor-secreto-1234567890\nexport GEMINI_API_KEY="outro valor secreto"\n  FOO_BAR=x=y\n1INVALIDO=z\n' >"$T/cofre.env"
bash "$AQUI/cofre-nomes.sh" "$T/cofre.env" "$T/nomes"; rc=$?
ok "sai 0 com cofre normal" 0 "$rc"
ok "so os nomes, uma linha NOME= por chave" "OPENAI_API_KEY=,GEMINI_API_KEY=,FOO_BAR=" "$(paste -sd, "$T/nomes")"
ok "nenhum valor vaza" 0 "$(grep -c -e secreto -e 'x=y' "$T/nomes")"
ok "saida com modo 644" 644 "$(stat -c %a "$T/nomes")"

bash "$AQUI/cofre-nomes.sh" "$T/nao-existe.env" "$T/vazio"; rc=$?
ok "cofre ausente: sai 0" 0 "$rc"
ok "cofre ausente: saida vazia" 0 "$(wc -c <"$T/vazio" | tr -d ' ')"

bash "$AQUI/cofre-nomes.sh" "$T/cofre.env" "$T/pasta-que-nao-existe/nomes" 2>"$T/err"; rc=$?
ok "pasta de saida ausente: sai 1" 1 "$rc"
ok "pasta de saida ausente: explica" 1 "$(grep -c 'nao consegui criar um temporario' "$T/err")"

mkdir "$T/cofre-pasta"
bash "$AQUI/cofre-nomes.sh" "$T/cofre-pasta" "$T/semler" 2>"$T/err2"; rc=$?
ok "cofre ilegivel: sai 1" 1 "$rc"
ok "cofre ilegivel: explica" 1 "$(grep -c 'nao consegui ler' "$T/err2")"
ok "cofre ilegivel: saida vazia mesmo assim" 0 "$(wc -c <"$T/semler" | tr -d ' ')"

if [ "$falhas" = 0 ]; then echo "tudo certo"; else echo "$falhas falha(s)"; exit 1; fi
