#!/usr/bin/env bash
# remover, listar, parar/iniciar/reiniciar, imagem, senha.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

criar_agente ana --nome "Ana"
criar_agente beto --nome "Beto"

echo "listar"
igual "listar --json devolve 2 agentes" "2" "$(dgclaw agente listar --json | jq length)"
igual "estado do container vem do podman inspect" "running" "$(dgclaw agente listar --json | jq -r '.[0].estado')"
igual "saude ok quando o runner responde" "ok" "$(dgclaw agente listar --json | jq -r '.[0].saude')"
touch "$STUB_ESTADO/curl-falha"
igual "saude 'sem resposta' quando o runner nao responde" "sem resposta" "$(dgclaw agente listar --json | jq -r '.[0].saude')"
rm -f "$STUB_ESTADO/curl-falha"
afirma "tabela legivel traz o nome" bash -c "'$CLI' agente listar | grep -q Ana"

echo "parar, iniciar, reiniciar"
dgclaw agente parar ana >/dev/null 2>&1
afirma "parar chama podman stop" grep -q '^podman stop dgclaw-ana' "$STUB_LOG"
nega "reiniciar com o agente parado explica e falha" dgclaw agente reiniciar ana
dgclaw agente iniciar ana >/dev/null 2>&1
afirma "iniciar chama podman start" grep -q '^podman start dgclaw-ana' "$STUB_LOG"
dgclaw agente reiniciar ana >/dev/null 2>&1
afirma "reiniciar reinicia so o runner por dentro" grep -q '^podman exec dgclaw-ana systemctl restart dgclaw-runner' "$STUB_LOG"
nega "agente desconhecido recusado" dgclaw agente parar fantasma

echo "remover"
cp "$ETC/runner/ana.token" "$TMP/token-ana"
dgclaw agente remover ana --sim >/dev/null 2>&1
igual "remover sai com 0" "0" "$?"
nega "a casa saiu do lugar" test -e "$LIB/agentes/ana"
apos="$(find "$LIB/aposentados" -maxdepth 1 -name 'ana-*' | head -1)"
afirma "a casa foi movida para aposentados/ana-<data>" test -f "$apos/home/AGENT.md"
afirma "o token do host foi para dentro da pasta aposentada" test -f "$apos/segredos-do-host/ana.token"
igual "o conteudo nao foi apagado (token intacto)" "$(cat "$TMP/token-ana")" "$(cat "$apos/segredos-do-host/ana.token")"
nega "token do host nao fica mais em /etc/dgclaw/runner" test -e "$ETC/runner/ana.token"
afirma "podman stop e rm do container" bash -c "grep -q '^podman stop dgclaw-ana' '$STUB_LOG' && grep -q '^podman rm dgclaw-ana' '$STUB_LOG'"
afirma "podman network rm" grep -q '^podman network rm dgclaw-ana' "$STUB_LOG"
igual "saiu do agentes.json" "0" "$(jq '[.agentes[] | select(.slug=="ana")] | length' "$ETC/agentes.json")"
igual "beto continua no agentes.json" "1" "$(jq '[.agentes[] | select(.slug=="beto")] | length' "$ETC/agentes.json")"
afirma "a linha do registro.tsv fica (faixa queimada)" grep -q '^ana	' "$ETC/registro.tsv"
nega "remover agente que nao existe falha com explicacao" dgclaw agente remover fantasma --sim

echo "imagem"
dgclaw imagem status >"$TMP/o.txt" 2>&1
igual "imagem pronta: sai com 0" "0" "$?"
afirma "imagem pronta: diz pronta" grep -q "pronta" "$TMP/o.txt"
touch "$STUB_ESTADO/sem-imagem"
dgclaw imagem status >"$TMP/o.txt" 2>&1
igual "sem imagem: sai com 1" "1" "$?"
afirma "sem imagem e sem construcao: diz que nao esta pronta" grep -q "NAO esta pronta" "$TMP/o.txt"
echo "ativo" >/dev/null; echo "activating" >"$STUB_ESTADO/svc-dgclaw-imagem.service"
dgclaw imagem status >"$TMP/o.txt" 2>&1
afirma "construindo: diz que esta sendo construida" grep -q "sendo construida" "$TMP/o.txt"
mkdir -p "$DGCLAW_RAIZ/var/log/dgclaw"; printf 'linha1\nERRO no passo 7\n' >"$DGCLAW_RAIZ/var/log/dgclaw/imagem.log"
echo failed >"$STUB_ESTADO/svc-dgclaw-imagem.service"
dgclaw imagem status >"$TMP/o.txt" 2>&1
afirma "falhou: mostra a cauda do log" grep -q "ERRO no passo 7" "$TMP/o.txt"
dgclaw imagem construir >/dev/null 2>&1
afirma "construir inicia a unidade em segundo plano" grep -q '^systemctl start --no-block dgclaw-imagem.service' "$STUB_LOG"
dgclaw imagem construir --agora >/dev/null 2>&1
afirma "construir --agora: podman build sem o proxy do host" grep -q '^podman build --http-proxy=false ' "$STUB_LOG"

echo "senha trocar"
printf "DGCLAW_PANEL_USER=dono\nDGCLAW_PANEL_PASSWORD_HASH='scrypt\$velho\$velho'\nOUTRA=1\n" >"$ETC/web.env"
chmod 600 "$ETC/web.env"
export DGCLAW_SENHA_HASH_CMD="cat >/dev/null; echo 'scrypt\$novo\$novo'"
printf '%s\n' "curta" | dgclaw senha trocar >/dev/null 2>&1
igual "senha curta recusada" "1" "$(grep -c velho "$ETC/web.env")"
printf '%s\n' "uma senha bem grande" | dgclaw senha trocar >"$TMP/o.txt" 2>&1
igual "senha trocada: linha do hash atualizada" "DGCLAW_PANEL_PASSWORD_HASH='scrypt\$novo\$novo'" "$(grep ^DGCLAW_PANEL_PASSWORD_HASH "$ETC/web.env")"
igual "as outras linhas do web.env ficam" "2" "$(grep -c -E '^(DGCLAW_PANEL_USER=dono|OUTRA=1)$' "$ETC/web.env")"
igual "web.env continua 600" "600" "$(stat -c %a "$ETC/web.env")"
afirma "dgclaw-web reiniciado" grep -q '^systemctl restart dgclaw-web' "$STUB_LOG"
nega "a senha nao aparece na saida nem no log" grep -rq "uma senha bem grande" "$TMP/o.txt" "$STUB_LOG"
unset DGCLAW_SENHA_HASH_CMD
# Uma copia da CLI numa pasta de app sem panel/: o repo traz o senha-hash.js, entao a
# ausencia dele so se testa fora do repo.
APP_SEM_HASH="$TMP/app-sem-hash"
mkdir -p "$APP_SEM_HASH/bin"
cp "$CLI" "$APP_SEM_HASH/bin/dgclaw"
cp -r "$(dirname "$CLI")/../lib" "$APP_SEM_HASH/lib"
printf '%s\n' 'uma senha bem grande' | "$APP_SEM_HASH/bin/dgclaw" senha trocar >"$TMP/o.txt" 2>&1
nega "sem hash de teste e sem senha-hash.js: sai com erro" test "$?" = 0
afirma "sem senha-hash.js: o erro diz qual arquivo falta" grep -q "panel/bin/senha-hash.js" "$TMP/o.txt"
igual "sem senha-hash.js: o hash antigo fica" "DGCLAW_PANEL_PASSWORD_HASH='scrypt\$novo\$novo'" "$(grep ^DGCLAW_PANEL_PASSWORD_HASH "$ETC/web.env")"
if command -v node >/dev/null; then
    printf '%s\n' 'uma senha bem grande' | dgclaw senha trocar >/dev/null 2>&1
    afirma "com o senha-hash.js do repo: grava um hash scrypt novo" \
        grep -qE "^DGCLAW_PANEL_PASSWORD_HASH='scrypt\\$" "$ETC/web.env"
    nega "com o senha-hash.js do repo: o hash de teste saiu" grep -qF "scrypt\$novo" "$ETC/web.env"
fi

echo "status"
dgclaw status >"$TMP/o.txt" 2>&1
igual "status sem servicos de pe sai com erro" "1" "$?"
afirma "status diz qual servico caiu" grep -q "FALHOU servico dgclaw-web" "$TMP/o.txt"
for u in caddy dgclaw-web dgclaw-admin; do echo active >"$STUB_ESTADO/svc-$u"; done
dgclaw status >"$TMP/o.txt" 2>&1
igual "status com tudo de pe sai com 0" "0" "$?"

fim
