#!/usr/bin/env bash
# dgclaw colaborador: a CLI fala com o Web pelo socket local. Aqui o curl e de mentira (stubs/curl): confere o que o
# comando MANDA (corpo, rota, socket) e o que ele MOSTRA a partir do que o Web responde.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

ENT="$STUB_LOG.curl-stdin"
resposta() { printf '%s' "$2" >"$STUB_ESTADO/colab-resposta${3:+.$3}"; printf '%s' "$1" >"$STUB_ESTADO/colab-status${3:+.$3}"; }
zera() { : >"$STUB_LOG"; rm -f "$ENT" "$STUB_ESTADO"/colab-* "$STUB_ESTADO/curl-sem-socket"; }

CONVITE='{"ok":true,"colaborador":{"id":"abcDEF123456","email":"maria@empresa.com","agente":"ana","estado":"aguardando_primeiro_acesso"},"convite":{"link":"https://teste.exemplo.org/login?usuario=maria%40empresa.com","usuario":"maria@empresa.com","senha_temporaria":"Zx9kQm2LpR7t","email_enviado":false,"email_motivo":"sem e-mail configurado","texto":"Ola, Maria!\n\nEndereco: https://teste.exemplo.org/login?usuario=maria%40empresa.com\nLogin: maria@empresa.com\nSenha temporaria: Zx9kQm2LpR7t"}}'

echo "criar"
# shellcheck disable=SC2016 # o \$(...) do nome e de proposito: tem de chegar como texto, sem executar
NOME_PERIGOSO='Maria "da Silva"; $(rm -rf /)'
zera; resposta 201 "$CONVITE"
dgclaw colaborador criar ana Maria@Empresa.com --nome "$NOME_PERIGOSO" >"$TMP/o.txt" 2>&1
igual "criar: sai com 0" "0" "$?"
afirma "criar: mostra o texto do convite" grep -q 'Senha temporaria: Zx9kQm2LpR7t' "$TMP/o.txt"
afirma "criar: avisa que o e-mail nao saiu e por que" grep -q 'sem e-mail configurado' "$TMP/o.txt"
afirma "criar: usa o socket do Web na pasta de dados" grep -q -- "--unix-socket $LIB/web/admin.sock" "$STUB_LOG"
afirma "criar: POST em /api/v1/colaboradores" grep -q 'http://dgclaw/api/v1/colaboradores' "$STUB_LOG"
nega "criar: nenhum valor do usuario vai na linha de comando" grep -q 'maria\|Maria\|rm -rf' "$STUB_LOG"
igual "criar: corpo montado pelo jq (agente)" "ana" "$(jq -r .agente "$ENT")"
igual "criar: corpo (email como veio, o Web normaliza)" "Maria@Empresa.com" "$(jq -r .email "$ENT")"
igual "criar: corpo (nome com aspas e \$() chega como texto)" "$NOME_PERIGOSO" "$(jq -r .nome "$ENT")"
igual "criar: corpo leva o endereco publico do dgclaw.env" "https://teste.exemplo.org" "$(jq -r .base "$ENT")"

zera; resposta 201 "$CONVITE"
dgclaw colaborador criar ana maria@empresa.com --json >"$TMP/o.txt" 2>&1
igual "criar --json: devolve o JSON do Web" "Zx9kQm2LpR7t" "$(jq -r .convite.senha_temporaria "$TMP/o.txt")"
nega "criar --json: sem nome nao manda o campo" jq -e 'has("nome")' "$ENT"

zera; resposta 201 "$CONVITE"
printf 'DGCLAW_VERSAO=1.0.0\n' >"$ETC/dgclaw.env"
dgclaw colaborador criar ana maria@empresa.com >"$TMP/o.txt" 2>&1
nega "criar sem dominio: nao manda base (o Web usa o padrao local e avisa)" jq -e 'has("base")' "$ENT"
printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$ETC/dgclaw.env"

echo "criar: erros"
zera; resposta 400 '{"ok":false,"erro":"O Admin nunca pode ser compartilhado: ele mexe no servidor inteiro."}'
dgclaw colaborador criar admin x@y.com >"$TMP/o.txt" 2>&1
igual "criar no Admin: sai com 1" "1" "$?"
afirma "criar no Admin: repete o motivo da API" grep -q 'O Admin nunca pode ser compartilhado' "$TMP/o.txt"
afirma "criar no Admin: diz o que fazer" grep -q 'O que fazer:' "$TMP/o.txt"
zera; resposta 409 '{"ok":false,"erro":"O agente ana já tem um colaborador ativo (maria@empresa.com)."}'
dgclaw colaborador criar ana joao@y.com >"$TMP/o.txt" 2>&1
afirma "criar duplicado: repete o erro e aponta a lista" bash -c "grep -q 'já tem um colaborador ativo' '$TMP/o.txt' && grep -q 'colaborador listar' '$TMP/o.txt'"
zera; touch "$STUB_ESTADO/curl-sem-socket"
dgclaw colaborador criar ana joao@y.com >"$TMP/o.txt" 2>&1
igual "Web fora do ar: sai com 1" "1" "$?"
afirma "Web fora do ar: explica e manda ver o servico" grep -q 'systemctl status dgclaw-web' "$TMP/o.txt"
zera
nega "criar sem e-mail" dgclaw colaborador criar ana
nega "criar com opcao desconhecida" dgclaw colaborador criar ana a@b.com --senha x
nega "subcomando desconhecido" dgclaw colaborador apagar x
afirma "ajuda do subcomando" bash -c "'$CLI' colaborador ajuda | grep -q 'colaborador criar'"
afirma "a ajuda geral cita o comando" bash -c "'$CLI' --ajuda | grep -q 'dgclaw colaborador criar'"

echo "ensaio"
zera
dgclaw --ensaio colaborador criar ana a@b.com >"$TMP/o.txt" 2>&1
igual "ensaio criar: sai com 0" "0" "$?"
nega "ensaio criar: nao chamou o Web" grep -q unix-socket "$STUB_LOG"
dgclaw --ensaio colaborador revogar a@b.com >/dev/null 2>&1
dgclaw --ensaio colaborador reenviar a@b.com >/dev/null 2>&1
nega "ensaio revogar/reenviar: nao chamou o Web" grep -q unix-socket "$STUB_LOG"

echo "listar"
zera; resposta 200 '{"ok":true,"colaboradores":[{"id":"abcDEF123456","email":"maria@empresa.com","agente":"ana","estado":"ativo","nome":"Maria"}]}'
dgclaw colaborador listar >"$TMP/o.txt" 2>&1
afirma "listar: mostra a pessoa" bash -c "grep -q 'maria@empresa.com' '$TMP/o.txt' && grep -q ativo '$TMP/o.txt'"
zera; resposta 200 '{"ok":true,"colaboradores":[]}'
dgclaw colaborador listar ana >"$TMP/o.txt" 2>&1
afirma "listar vazio: diz que nao ha ninguem" grep -q 'Nenhum colaborador no agente ana' "$TMP/o.txt"
afirma "listar agente: filtra na rota" grep -q 'colaboradores?agente=ana' "$STUB_LOG"
zera; resposta 200 '{"ok":true,"colaboradores":[]}'
afirma "listar --json" bash -c "'$CLI' colaborador listar --json | jq -e .ok"

echo "reenviar e revogar"
zera
resposta 200 '{"ok":true,"colaboradores":[{"id":"abcDEF123456","email":"maria@empresa.com","agente":"ana","estado":"ativo"},{"id":"zzzOLD999999","email":"maria@empresa.com","agente":"bob","estado":"revogado"}]}' 1
resposta 200 "$CONVITE" 2
dgclaw colaborador reenviar MARIA@empresa.com >"$TMP/o.txt" 2>&1
igual "reenviar por e-mail: sai com 0" "0" "$?"
afirma "reenviar: achou o id ativo e chamou /reenviar" grep -q 'colaboradores/abcDEF123456/reenviar' "$STUB_LOG"
afirma "reenviar: mostra o convite" grep -q 'Zx9kQm2LpR7t' "$TMP/o.txt"
zera; resposta 200 "$CONVITE"
dgclaw colaborador reenviar abcDEF123456 >/dev/null 2>&1
afirma "reenviar por id: nao precisa listar antes" bash -c "! grep -q 'GET.*api/v1/colaboradores\$' '$STUB_LOG' && grep -q 'abcDEF123456/reenviar' '$STUB_LOG'"
zera; resposta 200 '{"ok":true,"colaboradores":[]}'
dgclaw colaborador revogar ninguem@x.com >"$TMP/o.txt" 2>&1
igual "revogar e-mail sem acesso ativo: sai com 1" "1" "$?"
afirma "revogar e-mail sem acesso ativo: explica" grep -q 'nao achei colaborador ativo com o e-mail ninguem@x.com' "$TMP/o.txt"
zera
resposta 200 '{"ok":true,"colaboradores":[{"id":"abcDEF123456","email":"maria@empresa.com","agente":"ana","estado":"ativo"}]}' 1
resposta 200 '{"ok":true,"colaborador":{"id":"abcDEF123456","email":"maria@empresa.com","agente":"ana"},"contas_de_ia":["ana"]}' 2
dgclaw colaborador revogar maria@empresa.com >"$TMP/o.txt" 2>&1
igual "revogar: sai com 0" "0" "$?"
afirma "revogar: usou DELETE" grep -q -- '-X DELETE' "$STUB_LOG"
afirma "revogar: avisa que a conta de IA dela continua" grep -q 'a conta continua conectada' "$TMP/o.txt"
zera
resposta 200 '{"ok":true,"colaborador":{"id":"abcDEF123456","email":"maria@empresa.com","agente":"ana"},"contas_de_ia":[]}'
dgclaw colaborador revogar abcDEF123456 >"$TMP/o.txt" 2>&1
nega "revogar sem conta conectada por ela: nao avisa de conta" grep -q 'continua conectada' "$TMP/o.txt"
zera
resposta 200 '{"ok":true,"colaborador":{"id":"abcDEF123456","email":"maria@empresa.com","agente":"ana"},"contas_de_ia":[],"avisos":["Nao consegui cancelar o login que maria@empresa.com deixou em andamento no agente ana (HTTP 500)."]}'
dgclaw colaborador revogar abcDEF123456 >"$TMP/o.txt" 2>&1
afirma "revogar: repete o aviso de cancelamento que falhou" grep -q 'Nao consegui cancelar o login' "$TMP/o.txt"

fim
