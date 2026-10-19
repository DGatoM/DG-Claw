#!/usr/bin/env bash
# `dgclaw atualizar` com personalizacoes do programa (branch `personalizacoes` + registro).
#
# Mesmo molde do atualizar.sh: raiz falsa, install.sh de verdade, "GitHub" local (repo bare),
# stubs. Cenarios: sem personalizacao; personalizacao que nao cruza (reaplica por cima);
# personalizacao que cruza (para ANTES do backup, nada muda); entrada desfeita (nao conta).
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

PATH="$AQUI/stubs:$REPO/tests/instalador/stubs:$PATH"
export PATH
export DGCLAW_STUB_LOG="$TMP/instalador.log" DGCLAW_STUB_ESTADO="$TMP/estado-instalador"
export DGCLAW_PULAR_CHECAGENS=1 DGCLAW_ESPERA_CERT=5 DGCLAW_ATUALIZAR_LIVRE_MIN_MB=1
export DGCLAW_SENHA_HASH_CMD="$REPO/tests/instalador/senha-hash-falso.sh"
export GIT_AUTHOR_NAME=teste GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=teste GIT_COMMITTER_EMAIL=t@t
RAIZ="$DGCLAW_RAIZ"
ADMIN="$RAIZ/opt/dgclaw/admin"
APP="$RAIZ/opt/dgclaw/app"
BACKUPS="$RAIZ/var/backups/dgclaw"
REGISTRO="$ADMIN/PERSONALIZACOES.md"
TRAB="$TMP/trabalho"; ORIGEM="$TMP/origem.git"; CLONE="$TMP/clone"

# montar: zera tudo e instala a v1 de um clone novo (o "GitHub" so tem a v1).
montar() {
    rm -rf "$RAIZ" "$TRAB" "$ORIGEM" "$CLONE" "$STUB_ESTADO"
    mkdir -p "$RAIZ/etc/dgclaw" "$STUB_ESTADO" "$TRAB/bin" "$TRAB/web" "$TRAB/runner" "$TRAB/container" \
        "$TRAB/templates/admin" "$TRAB/skills/criar-agente" "$TRAB/skills/trocar-dominio" "$TRAB/scripts/dgchat-mcp"
    printf 'DGCLAW_DOMINIO=teste.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    : >"$DGCLAW_STUB_LOG"; : >"$STUB_LOG"
    cp "$REPO/install.sh" "$TRAB/install.sh"
    cp -r "$REPO/lib" "$TRAB/lib"
    printf '#!/bin/sh\necho dgclaw falso\n' >"$TRAB/bin/dgclaw"; chmod +x "$TRAB/bin/dgclaw"
    echo 'console.log("web v1")' >"$TRAB/web/server.js"
    echo '{"name":"web"}' >"$TRAB/web/package.json"
    echo '{"name":"runner"}' >"$TRAB/runner/package.json"
    echo 'FROM scratch' >"$TRAB/container/Containerfile"
    echo '# Admin (Claude) v1' >"$TRAB/templates/admin/CLAUDE.md"
    echo '# Admin (Codex) v1' >"$TRAB/templates/admin/AGENTS.md"
    echo '# criar-agente' >"$TRAB/skills/criar-agente/SKILL.md"
    echo '# trocar-dominio' >"$TRAB/skills/trocar-dominio/SKILL.md"
    echo '//' >"$TRAB/scripts/dgchat-mcp/server.mjs"
    echo 'DG Claw de mentira' >"$TRAB/README.md"
    git -C "$TRAB" init -q -b main
    git -C "$TRAB" add -A; git -C "$TRAB" commit -q -m v1
    git clone -q --bare "$TRAB" "$ORIGEM"
    git -C "$TRAB" remote add origin "$ORIGEM"
    git -C "$TRAB" fetch -q origin
    git -C "$TRAB" branch -q --set-upstream-to=origin/main main
    git clone -q "$ORIGEM" "$CLONE"
    mkdir -p "$RAIZ/var/lib/dgclaw/web"
    echo ok >"$RAIZ/var/lib/dgclaw/web/admin-saudado"
    echo active >"$STUB_ESTADO/svc-caddy"; echo active >"$STUB_ESTADO/svc-dgclaw-web"; echo active >"$STUB_ESTADO/svc-dgclaw-admin"
    if ! printf '%s\n' 'uma-frase-comprida-123' | bash "$CLONE/install.sh" --usuario maria --provedor claude --dominio teste.exemplo.org >"$TMP/instalar.txt" 2>&1; then
        mal "install.sh v1 falhou: $(tail -n 5 "$TMP/instalar.txt" | tr '\n' ' ')"
    fi
    : >"$STUB_LOG"
}

# personalizar <arquivo> <texto>: branch personalizacoes no clone com um commit mexendo no arquivo.
personalizar() {
    git -C "$CLONE" switch -q -c personalizacoes
    mkdir -p "$(dirname "$CLONE/$1")"
    printf '%s\n' "$2" >>"$CLONE/$1"
    git -C "$CLONE" add -A; git -C "$CLONE" commit -q -m "personalizacao: $1"
}

# registrar <arquivo> <situacao>: entrada no registro (mais um modelo cercado, que deve ser ignorado).
registrar() {
    mkdir -p "$ADMIN"
    cat >"$REGISTRO" <<REG
# Personalizacoes do programa

Modelo:

\`\`\`
## 2026-01-01 - Titulo de exemplo
- Arquivos: \`web/server.js\`
- Situacao: ativa
\`\`\`

## 2026-10-19 - Botao "Resumo do dia" na conversa
- Pedido: um botao
- Arquivos: \`$1\`
- Commit: abc1234
- Por que: o dono pediu
- Como testar: abra a conversa
- Situação: $2
REG
}

# publicar_v2 <arquivo>: o "GitHub" ganha a v2, que mexe no arquivo.
publicar_v2() {
    printf '%s\n' "// v2" >>"$TRAB/$1"
    echo 'novidade' >"$TRAB/NOVIDADE.md"
    git -C "$TRAB" add -A; git -C "$TRAB" commit -q -m v2; git -C "$TRAB" push -q origin main
}

pastas_de_backup() { find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l; }

echo "a. sem personalizacao"
montar
publicar_v2 web/server.js
dgclaw atualizar --simular >"$TMP/a1.txt" 2>&1; rc=$?
igual "simular sai com 0" "0" "$rc"
afirma "diz que nao ha personalizacao registrada" grep -q 'nenhuma personalizacao do programa registrada' "$TMP/a1.txt"
dgclaw atualizar --ok-do-dono >"$TMP/a2.txt" 2>&1; rc=$?
igual "atualizar sai com 0 como antes" "0" "$rc"
[ "$rc" -eq 0 ] || sed 's/^/      | /' "$TMP/a2.txt" | tail -n 20
afirma "o clone foi para a versao nova" grep -q '^// v2' "$CLONE/web/server.js"
nega "sem personalizacao nao fala em reaplicar" grep -q 'Personalizacoes reaplicadas' "$TMP/a2.txt"

echo "b. personalizacao sem conflito"
montar
personalizar web/public/extra.js '// minha personalizacao'
registrar web/public/extra.js ativa
publicar_v2 web/server.js
HEAD_ANTES="$(git -C "$CLONE" rev-parse HEAD)"
dgclaw atualizar --simular >"$TMP/b1.txt" 2>&1; rc=$?
igual "simular sai com 0" "0" "$rc"
afirma "simular mostra o cruzamento vazio" grep -q 'nenhum arquivo personalizado e mexido pela versao nova' "$TMP/b1.txt"
afirma "simular diz o que faria" grep -q '\[ensaio\] guardaria a branch em personalizacoes-antes-' "$TMP/b1.txt"
igual "simular nao mexe no HEAD do clone" "$HEAD_ANTES" "$(git -C "$CLONE" rev-parse HEAD)"
nega "simular nao cria branch de copia" bash -c "git -C '$CLONE' branch --list 'personalizacoes-antes-*' | grep -q ."
dgclaw atualizar --ok-do-dono >"$TMP/b2.txt" 2>&1; rc=$?
igual "atualizar sai com 0" "0" "$rc"
[ "$rc" -eq 0 ] || sed 's/^/      | /' "$TMP/b2.txt" | tail -n 25
igual "o clone continua na branch personalizacoes" "personalizacoes" "$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)"
git -C "$CLONE" fetch -q origin
igual "o HEAD tem a versao nova (merge-base == origin/main)" "$(git -C "$CLONE" rev-parse origin/main)" "$(git -C "$CLONE" merge-base HEAD origin/main)"
afirma "o HEAD tem a personalizacao" grep -q 'minha personalizacao' "$CLONE/web/public/extra.js"
afirma "o app instalado tem a mudanca da v2" grep -q '^// v2' "$APP/web/server.js"
afirma "o app instalado tem a personalizacao" grep -q 'minha personalizacao' "$APP/web/public/extra.js"
afirma "existe a branch personalizacoes-antes-*" bash -c "git -C '$CLONE' branch --list 'personalizacoes-antes-*' | grep -q ."
afirma "a saida cita as personalizacoes reaplicadas" grep -q 'Personalizacoes reaplicadas: 1' "$TMP/b2.txt"
igual "um backup foi feito" "1" "$(pastas_de_backup)"

echo "c. personalizacao com conflito"
montar
personalizar web/server.js '// minha personalizacao no server'
registrar web/server.js ativa
publicar_v2 web/server.js
HEAD_ANTES="$(git -C "$CLONE" rev-parse HEAD)"
SERVER_ANTES="$(sha256sum <"$APP/web/server.js")"
dgclaw atualizar --simular >"$TMP/c1.txt" 2>&1; rc=$?
nega "simular sai com erro" test "$rc" -eq 0
afirma "simular cita o arquivo" grep -q 'web/server.js' "$TMP/c1.txt"
afirma "simular cita o titulo do registro" grep -q 'Botao "Resumo do dia" na conversa' "$TMP/c1.txt"
afirma "simular traz a frase pronta" grep -q 'Posso ajustar a personalizacao' "$TMP/c1.txt"
afirma "simular diz que nada foi mudado" grep -q 'nada foi mudado' "$TMP/c1.txt"
dgclaw atualizar >"$TMP/c2.txt" 2>&1; rc=$?
nega "atualizar sai com erro" test "$rc" -eq 0
afirma "a frase pronta aparece" grep -q 'Posso ajustar a personalizacao' "$TMP/c2.txt"
afirma "aponta o capitulo do ATUALIZAR.md" grep -q 'Personalizacao que cruza com a versao nova' "$TMP/c2.txt"
igual "o HEAD do clone nao mudou" "$HEAD_ANTES" "$(git -C "$CLONE" rev-parse HEAD)"
igual "a branch personalizacoes nao mudou" "$HEAD_ANTES" "$(git -C "$CLONE" rev-parse personalizacoes)"
igual "nenhuma pasta de backup foi criada" "0" "$(pastas_de_backup)"
igual "o server.js instalado nao mudou" "$SERVER_ANTES" "$(sha256sum <"$APP/web/server.js")"
nega "nao mexeu em container" grep -q '^podman \(stop\|rm\|build\|create\)' "$STUB_LOG"
dgclaw personalizacoes conferir >"$TMP/c3.txt" 2>&1; rc=$?
igual "personalizacoes conferir sai com 0 mesmo com cruzamento" "0" "$rc"
afirma "e mostra a frase pronta" grep -q 'Posso ajustar a personalizacao' "$TMP/c3.txt"

echo "d. entrada desfeita nao conta"
montar
personalizar web/public/extra.js '// outra coisa'
registrar web/server.js desfeita
publicar_v2 web/server.js
dgclaw atualizar --simular >"$TMP/d1.txt" 2>&1; rc=$?
igual "simular sai com 0" "0" "$rc"
afirma "nao ha cruzamento" grep -q 'nenhum arquivo personalizado e mexido pela versao nova' "$TMP/d1.txt"
dgclaw atualizar --ok-do-dono >"$TMP/d2.txt" 2>&1; rc=$?
igual "atualizar sai com 0" "0" "$rc"
afirma "reaplicou por cima" grep -q '^// v2' "$APP/web/server.js"

echo "e. levantar, conferir e concluir"
montar
personalizar web/public/extra.js '// minha personalizacao'
registrar web/public/extra.js ativa
publicar_v2 web/server.js
SESSOES="$RAIZ/root/.claude/projects/-opt-dgclaw-admin"
mkdir -p "$SESSOES" "$ADMIN/personalizacoes-migracao/20261019-100000"
printf 'M\tweb/server.js\n' >"$ADMIN/personalizacoes-migracao/20261019-100000/LISTA.txt"
printf '2026-10-19 10:00:00\tapp diferente do oficial\t/opt/dgclaw/admin/personalizacoes-migracao/20261019-100000\n' >"$ADMIN/personalizacoes-migracao/PENDENTE"
cat >"$SESSOES/sessao-abc.jsonl" <<'JSONL'
{"type":"assistant","timestamp":"2026-10-18T12:30:00Z","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/opt/dgclaw/app/web/public/x.js","old_string":"a","new_string":"SEGREDO123"}}]}}
{"type":"assistant","timestamp":"2026-10-18T12:31:00Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"sed -i s/a/b/ /opt/dgclaw/app/web/public/y.js\nSEGREDO456"}}]}}
{"type":"assistant","timestamp":"2026-10-18T12:32:00Z","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/fora-do-app.txt","old_string":"a","new_string":"b"}}]}}
{"type":"assistant","timestamp":"2026-10-18T12:33:00Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"sed -i 's@/opt/dgclaw/app/antigo@SEGREDO_FICTICIO@' x && export K=/opt/dgclaw/app/chave.js:SEGREDO_DOIS"}}]}}
JSONL
# Commit local e stash cuja mensagem carrega segredo: so hash, data e nomes de arquivo podem sair.
echo a >"$CLONE/seg-commit.txt"; git -C "$CLONE" add -A; git -C "$CLONE" commit -q -m "SEGREDO_X no commit"
echo b >"$CLONE/seg-stash.txt"; git -C "$CLONE" stash push -q -u -m "SEGREDO_X no stash"
echo c >"$CLONE/seg-antigo.txt"; git -C "$CLONE" stash push -q -u -m "dgclaw-atualizar-20261019-100000"
dgclaw atualizar --simular >"$TMP/e0.txt" 2>&1
afirma "atualizar avisa do levantamento pendente" grep -q 'levantamento de personalizacoes pendente desde 2026-10-19' "$TMP/e0.txt"
dgclaw personalizacoes levantar >"$TMP/e1.txt" 2>&1; rc=$?
igual "levantar sai com 0" "0" "$rc"
afirma "lista o arquivo editado" grep -q '/opt/dgclaw/app/web/public/x.js' "$TMP/e1.txt"
afirma "lista o arquivo citado no Bash" grep -q '/opt/dgclaw/app/web/public/y.js' "$TMP/e1.txt"
afirma "traz a data e a sessao" grep -q '2026-10-18T12:30:00Z.*sessao-abc' "$TMP/e1.txt"
nega "nao lista arquivo fora do app" grep -q 'fora-do-app' "$TMP/e1.txt"
nega "nao imprime o conteudo do Edit (SEGREDO123)" grep -q 'SEGREDO123' "$TMP/e1.txt"
nega "nem o resto do comando Bash (SEGREDO456)" grep -q 'SEGREDO456' "$TMP/e1.txt"
afirma "o Bash cita o caminho do app que o sed mexeu" grep -q '(comando no terminal) /opt/dgclaw/app/antigo' "$TMP/e1.txt"
nega "mas nao o que veio depois do @ (SEGREDO_FICTICIO)" grep -q 'SEGREDO_FICTICIO' "$TMP/e1.txt"
afirma "o caminho antes do : sai sem o resto" grep -q '/opt/dgclaw/app/chave.js$' <(grep 'chave.js' "$TMP/e1.txt" | sed 's/  (sessao.*//')
nega "nem o que veio depois do : (SEGREDO_DOIS)" grep -q 'SEGREDO_DOIS' "$TMP/e1.txt"
nega "a mensagem do commit local nao sai (SEGREDO_X)" grep -q 'SEGREDO_X' "$TMP/e1.txt"
afirma "o commit local sai com os nomes dos arquivos" grep -q 'seg-commit.txt' "$TMP/e1.txt"
afirma "o stash sai com a mensagem omitida" grep -q '(mensagem omitida)' "$TMP/e1.txt"
afirma "o stash sai com os nomes dos arquivos" grep -q 'seg-stash.txt' "$TMP/e1.txt"
afirma "a mensagem dgclaw-atualizar-* aparece" grep -q 'dgclaw-atualizar-20261019-100000' "$TMP/e1.txt"
afirma "traz a LISTA da pasta de migracao" grep -q 'web/server.js' "$TMP/e1.txt"
afirma "traz o registro (1 entrada ativa)" grep -q '1 entrada(s) ativa(s)' "$TMP/e1.txt"
afirma "traz a branch do clone" grep -q 'branch: personalizacoes' "$TMP/e1.txt"
afirma "gravou o LEVANTAMENTO.md na pasta mais recente" test -s "$ADMIN/personalizacoes-migracao/20261019-100000/LEVANTAMENTO.md"
nega "o arquivo tambem nao tem o conteudo" grep -q 'SEGREDO' "$ADMIN/personalizacoes-migracao/20261019-100000/LEVANTAMENTO.md"
HEAD_ANTES="$(git -C "$CLONE" rev-parse HEAD)"
dgclaw personalizacoes conferir >"$TMP/e2.txt" 2>&1; rc=$?
igual "conferir sai com 0" "0" "$rc"
afirma "conferir mostra o cruzamento vazio" grep -q 'nenhum arquivo personalizado e mexido pela versao nova' "$TMP/e2.txt"
igual "conferir nao mexe no HEAD" "$HEAD_ANTES" "$(git -C "$CLONE" rev-parse HEAD)"
dgclaw personalizacoes concluir >"$TMP/e3.txt" 2>&1; rc=$?
igual "concluir sai com 0" "0" "$rc"
nega "o PENDENTE sumiu" test -e "$ADMIN/personalizacoes-migracao/PENDENTE"
afirma "virou CONCLUIDO-*" bash -c "ls '$ADMIN/personalizacoes-migracao'/CONCLUIDO-* >/dev/null"
rm -f "$REGISTRO"; printf 'x\t\t\n' >"$ADMIN/personalizacoes-migracao/PENDENTE"
dgclaw personalizacoes concluir >"$TMP/e4.txt" 2>&1; rc=$?
nega "sem registro, concluir recusa" test "$rc" -eq 0
afirma "e o PENDENTE continua" test -e "$ADMIN/personalizacoes-migracao/PENDENTE"

tem_app_tar() { [ "$(tar -tzf "$1/app.tar.gz" 2>/dev/null | grep -c 'web/server.js')" -ge 1 ]; }

echo "f. o backup guarda o app inteiro (atualizar e voltar)"
montar
publicar_v2 web/server.js
dgclaw atualizar --simular >/dev/null 2>&1
dgclaw atualizar --ok-do-dono >"$TMP/f1.txt" 2>&1; rc=$?
igual "atualizar sai com 0" "0" "$rc"
B1="$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
afirma "o backup tem app.tar.gz que abre e tem o programa" tem_app_tar "$B1"
afirma "o programa guardado e o de antes (v1)" bash -c "tar -xzOf '$B1/app.tar.gz' ./web/server.js | grep -q 'web v1'"
nega "sem node_modules no app.tar.gz" bash -c "tar -tzf '$B1/app.tar.gz' | grep -q node_modules"
afirma "o MANIFESTO traz o hash do app.tar.gz" grep -q '^app_tar_gz_sha256=' "$B1/MANIFESTO.txt"
dgclaw atualizar --voltar "$B1" >"$TMP/f2.txt" 2>&1; rc=$?
igual "voltar sai com 0" "0" "$rc"
afirma "o backup feito ao voltar tambem tem app.tar.gz (com a v2)" bash -c "for d in '$BACKUPS'/*/; do if grep -q 'antes-de-voltar' \"\$d/MANIFESTO.txt\"; then tar -xzOf \"\$d/app.tar.gz\" ./web/server.js | grep -q '^// v2'; fi; done; grep -l antes-de-voltar '$BACKUPS'/*/MANIFESTO.txt | grep -q ."

echo "g. o ok do dono vale para tudo que difere do instalado, inclusive commit so do clone"
montar
personalizar web/public/extra.js '// minha personalizacao'
registrar web/public/extra.js ativa
# o GitHub nao mudou (origin/main == instalado), mas a branch tem um commit que nao esta instalado
dgclaw atualizar --sem-baixar >"$TMP/g2.txt" 2>&1; rc=$?
nega "--sem-baixar com HEAD diferente do instalado tambem exige o ok" test "$rc" -eq 0
dgclaw atualizar >"$TMP/g1.txt" 2>&1; rc=$?
nega "sem --ok-do-dono, para" test "$rc" -eq 0
afirma "diz que falta o ok do dono" grep -q 'ainda nao tenho o ok do dono' "$TMP/g1.txt"
afirma "o relatorio lista o lado do clone" grep -q 'No seu clone' "$TMP/g1.txt"
igual "nenhum backup" "0" "$(pastas_de_backup)"
dgclaw atualizar --ok-do-dono >"$TMP/g3.txt" 2>&1; rc=$?
igual "com o ok, instala" "0" "$rc"
afirma "a personalizacao foi instalada" grep -q 'minha personalizacao' "$APP/web/public/extra.js"
dgclaw atualizar >"$TMP/g4.txt" 2>&1; rc=$?
igual "instalado == HEAD == origin: nada novo e sem ok sai com 0" "0" "$rc"

echo "h. a versao instalada e a que o dono viu"
montar
publicar_v2 web/server.js
dgclaw atualizar --simular >/dev/null 2>&1
printf '%s\n' "$(git -C "$TRAB" rev-parse HEAD)" >"$TMP/v2.hash"
git -C "$TRAB" commit -q --allow-empty -m v3; git -C "$TRAB" push -q origin main
dgclaw atualizar --ok-do-dono >"$TMP/h1.txt" 2>&1; rc=$?
nega "o dono viu a v2 e agora ha a v3: para" test "$rc" -eq 0
afirma "diz que a versao mudou desde o relatorio" grep -q 'mudou desde o relatorio' "$TMP/h1.txt"
igual "nenhum backup" "0" "$(pastas_de_backup)"
dgclaw atualizar --ok-do-dono >"$TMP/h2.txt" 2>&1; rc=$?
igual "depois de ver o relatorio novo, segue" "0" "$rc"
afirma "o relatorio traz a linha DESTINO= com o hash completo" grep -rqE '^DESTINO=[0-9a-f]{40}$' "$RAIZ/var/log/dgclaw"

echo "h2. entre o relatorio e o download, so entra o que foi mostrado"
montar
publicar_v2 web/server.js
V2="$(git -C "$TRAB" rev-parse HEAD)"
dgclaw atualizar --simular >/dev/null 2>&1
REAL_GIT="$(command -v git)"
mkdir -p "$TMP/gitwrap"
cat >"$TMP/gitwrap/git" <<WRAP
#!/bin/bash
case " \$* " in
    *" fetch "*)
        n=\$(cat "$TMP/fetch.n" 2>/dev/null || echo 0); n=\$((n + 1)); echo \$n >"$TMP/fetch.n"
        if [ "\$n" -eq 2 ]; then
            "$REAL_GIT" -C "$TRAB" commit -q --allow-empty -m v3-chegou-no-meio && "$REAL_GIT" -C "$TRAB" push -q origin main
        fi ;;
esac
exec "$REAL_GIT" "\$@"
WRAP
chmod +x "$TMP/gitwrap/git"
PATH="$TMP/gitwrap:$PATH" dgclaw atualizar --ok-do-dono >"$TMP/h3.txt" 2>&1; rc=$?
igual "atualizar sai com 0" "0" "$rc"
[ "$rc" -eq 0 ] || sed 's/^/      | /' "$TMP/h3.txt" | tail -n 20
igual "o clone ficou EXATAMENTE na versao mostrada (v2)" "$V2" "$(git -C "$CLONE" rev-parse HEAD)"
afirma "a v3 existe no GitHub" bash -c "[ \"\$(git -C '$ORIGEM' rev-parse main)\" != '$V2' ]"

echo "i. clone fora da branch das personalizacoes"
montar
personalizar web/public/extra.js '// minha personalizacao'
registrar web/public/extra.js ativa
git -C "$CLONE" switch -q main
publicar_v2 web/server.js
SERVER_ANTES="$(sha256sum <"$APP/web/server.js")"
dgclaw atualizar >"$TMP/i1.txt" 2>&1; rc=$?
nega "fora da branch, atualizar para" test "$rc" -eq 0
afirma "explica que instalaria SEM as personalizacoes" grep -q 'SEM as personalizacoes' "$TMP/i1.txt"
afirma "diz o comando git switch personalizacoes" grep -q 'git -C .* switch personalizacoes' "$TMP/i1.txt"
afirma "cita --sem-personalizacoes" grep -q -- '--sem-personalizacoes' "$TMP/i1.txt"
igual "nenhum backup" "0" "$(pastas_de_backup)"
dgclaw atualizar --sem-baixar >"$TMP/i2.txt" 2>&1; rc=$?
nega "--sem-baixar tambem para" test "$rc" -eq 0
afirma "--sem-baixar tambem explica" grep -q 'SEM as personalizacoes' "$TMP/i2.txt"
igual "o app nao mudou" "$SERVER_ANTES" "$(sha256sum <"$APP/web/server.js")"
dgclaw atualizar --sem-personalizacoes --ok-do-dono >"$TMP/i3.txt" 2>&1; rc=$?
igual "com --sem-personalizacoes o dono decidiu: segue" "0" "$rc"
[ "$rc" -eq 0 ] || sed 's/^/      | /' "$TMP/i3.txt" | tail -n 20
afirma "o app tem a v2 e nao tem a personalizacao" bash -c "grep -q '^// v2' '$APP/web/server.js' && [ ! -e '$APP/web/public/extra.js' ]"

echo "j. personalizacao que cruza, sem entrada no registro"
montar
personalizar web/server.js '// minha personalizacao no server'
publicar_v2 web/server.js
dgclaw atualizar --simular >"$TMP/j1.txt" 2>&1; rc=$?
nega "sai com erro" test "$rc" -eq 0
afirma "traz a frase de inconsistencia sem titulo" grep -q 'Uma personalizacao do programa tem uma inconsistencia' "$TMP/j1.txt"
afirma "cita o arquivo" grep -q 'web/server.js' "$TMP/j1.txt"

echo "k. commit seguido de revert e a versao nova mexe no mesmo arquivo"
montar
personalizar web/server.js '// minha personalizacao no server'
git -C "$CLONE" revert --no-edit HEAD >/dev/null 2>&1
publicar_v2 web/server.js
HEAD_ANTES="$(git -C "$CLONE" rev-parse HEAD)"
dgclaw atualizar --ok-do-dono >"$TMP/k1.txt" 2>&1; rc=$?
nega "o ensaio do rebase para antes do backup" test "$rc" -eq 0
afirma "traz a frase de inconsistencia" grep -q 'Uma personalizacao do programa tem uma inconsistencia' "$TMP/k1.txt"
afirma "cita o arquivo em conflito" grep -q 'web/server.js' "$TMP/k1.txt"
igual "nenhum backup" "0" "$(pastas_de_backup)"
igual "o HEAD nao mudou" "$HEAD_ANTES" "$(git -C "$CLONE" rev-parse HEAD)"
igual "nao sobrou worktree de ensaio" "1" "$(git -C "$CLONE" worktree list | wc -l)"
nega "nem pasta de worktree no .git" test -n "$(ls "$CLONE/.git/worktrees" 2>/dev/null)"
dgclaw atualizar --simular >"$TMP/k2.txt" 2>&1
igual "na simulacao tambem nao sobra worktree" "1" "$(git -C "$CLONE" worktree list | wc -l)"

fim
