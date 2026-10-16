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
nega "status sem cofre antigo nao avisa dele" grep -q 'cofre antigo' "$TMP/o.txt"
igual "o criar grava o nome do container no agentes.json" "dgclaw-beto" \
    "$(jq -r '.agentes[] | select(.slug == "beto") | .container' "$ETC/agentes.json")"

echo "status: cofre antigo do painel que sobrou na casa"
VELHO="$LIB/agentes/beto/home/.dgclaw"
mkdir -p "$VELHO/cofre/segredos"
printf 'sk-teste-chave-de-cifra' >"$VELHO/cofre.chave"
printf 'sk-teste-conteudo-cifrado' >"$VELHO/cofre/segredos/OPENAI_API_KEY.enc"
printf 'sk-teste-conteudo-cifrado' >"$VELHO/cofre/segredos/GEMINI_API_KEY.enc"
dgclaw status >"$TMP/o.txt" 2>&1
igual "cofre antigo e aviso, nao falha: status sai 0" "0" "$?"
afirma "avisa o cofre antigo com o nome do agente" grep -q 'aviso  agente beto: sobrou o cofre antigo' "$TMP/o.txt"
afirma "lista os nomes das chaves" grep -q 'chaves: GEMINI_API_KEY, OPENAI_API_KEY' "$TMP/o.txt"
afirma "diz como guardar de novo" grep -q 'dgclaw agente cofre beto guardar NOME' "$TMP/o.txt"
afirma "diz o que apagar" grep -q "apague $VELHO/cofre.chave" "$TMP/o.txt"
nega "nao imprime o conteudo dos arquivos" grep -q 'sk-teste' "$TMP/o.txt"
afirma "nao apaga nada sozinho" test -f "$VELHO/cofre/segredos/OPENAI_API_KEY.enc"
nega "nao avisa de agente sem cofre antigo" grep -q 'agente cida: sobrou' "$TMP/o.txt"
rm -rf "$VELHO/cofre" "$VELHO/cofre.chave"

echo "status: cofre antigo trocado por atalho nao e seguido"
mkdir -p "$TMP/fora-da-casa/segredos"
printf 'x' >"$TMP/fora-da-casa/segredos/SEGREDO_DE_FORA.enc"
ln -s "$TMP/fora-da-casa" "$VELHO/cofre"
dgclaw status >"$TMP/o.txt" 2>&1
igual "atalho no cofre: status sai 0" "0" "$?"
afirma "avisa que e um atalho e nao seguiu" grep -q "agente beto: $VELHO/cofre e um atalho" "$TMP/o.txt"
nega "nao lista nomes de fora da casa" grep -q 'SEGREDO_DE_FORA' "$TMP/o.txt"
rm -f "$VELHO/cofre"
mkdir -p "$VELHO/cofre"
ln -s "$TMP/fora-da-casa/segredos" "$VELHO/cofre/segredos"
dgclaw status >"$TMP/o.txt" 2>&1
afirma "atalho em cofre/segredos tambem nao e seguido" grep -q "$VELHO/cofre/segredos e um atalho" "$TMP/o.txt"
nega "nem lista os nomes de la" grep -q 'SEGREDO_DE_FORA' "$TMP/o.txt"
rm -rf "$VELHO/cofre"

echo "reparar: regrava o config.sh"
rm -f "$STUB_ESTADO/sem-imagem"
criar_agente cida --nome "Cida" --dono "Marta"
CFG="$LIB/agentes/cida/home/.dgclaw/config.sh"
cp "$CFG" "$TMP/config-original.sh"
sed -i '/^export DGCLAW_INJECT_MODE=/d;/^export DGCLAW_BUNKER_URL=/d;/^export DGCLAW_BUNKER_CARD=/d' "$CFG"
nega "config.sh antigo nao tem DGCLAW_INJECT_MODE" grep -q DGCLAW_INJECT_MODE "$CFG"
dgclaw agente reparar cida >"$TMP/o.txt" 2>&1
igual "reparar sai com 0" "0" "$?"
afirma "reparar diz que regravou" grep -q "config.sh do agente regravado" "$TMP/o.txt"
afirma "DGCLAW_INJECT_MODE voltou" grep -q "^export DGCLAW_INJECT_MODE='bunker'" "$CFG"
afirma "DGCLAW_BUNKER_URL voltou" grep -q "^export DGCLAW_BUNKER_URL=" "$CFG"
afirma "DGCLAW_BUNKER_CARD voltou" grep -q "^export DGCLAW_BUNKER_CARD='cida'" "$CFG"
afirma "DGCLAW_NAME continua o do criar" grep -q "^export DGCLAW_NAME='Cida'" "$CFG"
afirma "DGCLAW_OWNER continua o do criar" grep -q "^export DGCLAW_OWNER='Marta'" "$CFG"
igual "o arquivo ficou igual ao do criar" "$(cat "$TMP/config-original.sh")" "$(cat "$CFG")"
igual "modo 644" "644" "$(stat -c '%a' "$CFG")"
touch -d '2020-01-01' "$CFG"
dgclaw agente reparar cida >"$TMP/o.txt" 2>&1
afirma "segundo reparar diz que ja estava atualizado" grep -q "config.sh do agente ja estava atualizado" "$TMP/o.txt"
igual "segundo reparar nao mexe no arquivo (mtime)" "2020-01-01" "$(date -r "$CFG" +%F)"

echo "reparar: nome com aspas e cifrao"
criar_agente duda --nome "D'Avila \$HOME \`x\`" --dono "O'Neil \$USER"
CFG2="$LIB/agentes/duda/home/.dgclaw/config.sh"
cp "$CFG2" "$TMP/config-duda.sh"
dgclaw agente reparar duda >"$TMP/o.txt" 2>&1
igual "reparar de nome estranho sai com 0" "0" "$?"
afirma "nome com aspas e cifrao ja estava atualizado (ida e volta exata)" grep -q "ja estava atualizado" "$TMP/o.txt"
igual "config.sh identico" "$(cat "$TMP/config-duda.sh")" "$(cat "$CFG2")"
igual "o nome lido do arquivo e o original" "D'Avila \$HOME \`x\`" "$(bash -c ". '$CFG2'; printf '%s' \"\$DGCLAW_NAME\"")"

echo "reparar: o runner.json manda"
RJ="$LIB/agentes/cida/runner/runner.json"
jq '.config.provider = "codex-cli"' "$RJ" >"$TMP/rj.json" && cat "$TMP/rj.json" >"$RJ"
dgclaw agente reparar cida >"$TMP/o.txt" 2>&1
igual "reparar com runner.json trocado sai com 0" "0" "$?"
afirma "config.sh reflete o provedor do runner.json" grep -q "^export DGCLAW_PROVEDOR='codex'" "$CFG"

echo "reparar: sem panel/config.json o dono vem do config.sh antigo"
rm -f "$LIB/agentes/duda/home/.dgclaw/panel/config.json"
dgclaw agente reparar duda >"$TMP/o.txt" 2>&1
igual "dono com aspas e cifrao sobrevive pelo config.sh antigo" "O'Neil \$USER" "$(bash -c ". '$CFG2'; printf '%s' \"\$DGCLAW_OWNER\"")"

echo "reparar: .dgclaw trocada por link e recusada"
H3="$LIB/agentes/cida/home"
mkdir -p "$TMP/fora"
mv "$H3/.dgclaw" "$TMP/dgclaw-cida-guardada"
ln -s "$TMP/fora" "$H3/.dgclaw"
dgclaw agente reparar cida >"$TMP/o.txt" 2>&1
nega "reparar com .dgclaw em link nao sai com 0" test "$?" = 0
afirma "explica que a pasta e um link" grep -q "nao gravo como root fora da casa" "$TMP/o.txt"
nega "nada foi gravado fora da casa" test -e "$TMP/fora/config.sh"
rm "$H3/.dgclaw" && mv "$TMP/dgclaw-cida-guardada" "$H3/.dgclaw"

fim
