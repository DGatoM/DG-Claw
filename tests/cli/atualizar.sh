#!/usr/bin/env bash
# `dgclaw atualizar`: a atualizacao nao pode perder nem mudar nada que e do dono.
#
# Monta, numa raiz falsa, uma instalacao de verdade (o install.sh real, rodando de um clone git
# real com um "GitHub" local), cria dois agentes e enche tudo de dados de aluno: chaves no
# web.env, memoria, conversas, cofre, uploads, identidade personalizada, rotina, CLAUDE.md do
# Admin personalizado. Depois atualiza e REPROVA se qualquer um desses arquivos sumir ou mudar.
# Cobre tambem: pre-checagem de alteracao local, --simular, backup, repeticao sem novidade,
# --voltar e a conferencia que pega um instalador que apaga uma chave.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

# Os stubs do instalador completam o que a CLI nao usa (apt-get, dpkg, ufw...). Os da CLI vem
# primeiro no PATH (podman, systemctl, curl com estado proprio).
PATH="$AQUI/stubs:$REPO/tests/instalador/stubs:$PATH"
export PATH
export DGCLAW_STUB_LOG="$TMP/instalador.log" DGCLAW_STUB_ESTADO="$TMP/estado-instalador"
export DGCLAW_PULAR_CHECAGENS=1 DGCLAW_ESPERA_CERT=5 DGCLAW_ATUALIZAR_LIVRE_MIN_MB=1
export DGCLAW_SENHA_HASH_CMD="$REPO/tests/instalador/senha-hash-falso.sh"
export GIT_AUTHOR_NAME=teste GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=teste GIT_COMMITTER_EMAIL=t@t
: >"$DGCLAW_STUB_LOG"
RAIZ="$DGCLAW_RAIZ"
ADMIN="$RAIZ/opt/dgclaw/admin"
BACKUPS="$RAIZ/var/backups/dgclaw"

# --- o "GitHub" e o clone ---------------------------------------------------------------------
TRAB="$TMP/trabalho"; ORIGEM="$TMP/origem.git"; CLONE="$TMP/clone"
mkdir -p "$TRAB/bin" "$TRAB/web" "$TRAB/runner" "$TRAB/container" "$TRAB/templates/admin" \
    "$TRAB/skills/criar-agente" "$TRAB/skills/trocar-dominio" "$TRAB/scripts/dgchat-mcp"
cp "$REPO/install.sh" "$TRAB/install.sh"
cp -r "$REPO/lib" "$TRAB/lib"
printf '#!/bin/sh\necho dgclaw falso\n' >"$TRAB/bin/dgclaw"; chmod +x "$TRAB/bin/dgclaw"
echo 'console.log("web")' >"$TRAB/web/server.js"
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
git -C "$TRAB" add -A
git -C "$TRAB" commit -q -m v1
git clone -q --bare "$TRAB" "$ORIGEM"
git -C "$TRAB" remote add origin "$ORIGEM"
git -C "$TRAB" fetch -q origin
git -C "$TRAB" branch -q --set-upstream-to=origin/main main
git clone -q "$ORIGEM" "$CLONE"
COMMIT_V1="$(git -C "$CLONE" rev-parse HEAD)"

# --- instalacao v1 (o install.sh de verdade) -------------------------------------------------
mkdir -p "$RAIZ/var/lib/dgclaw/web"
echo ok >"$RAIZ/var/lib/dgclaw/web/admin-saudado"   # sem o recado de primeiro boot, que nao e o assunto
echo active >"$STUB_ESTADO/svc-caddy"; echo active >"$STUB_ESTADO/svc-dgclaw-web"; echo active >"$STUB_ESTADO/svc-dgclaw-admin"
if printf '%s\n' 'uma-frase-comprida-123' | bash "$CLONE/install.sh" --usuario maria --provedor claude --dominio teste.exemplo.org >"$TMP/instalar.txt" 2>&1; then
    ok "install.sh v1 instalou o Admin no clone"
else
    mal "install.sh v1 falhou: $(tail -n 5 "$TMP/instalar.txt" | tr '\n' ' ')"
fi
afirma "o dgclaw.env anota onde esta o clone" grep -qx "DGCLAW_REPO=$CLONE" "$ETC/dgclaw.env"
afirma "o dgclaw.env anota o commit instalado" grep -qx "DGCLAW_COMMIT=$COMMIT_V1" "$ETC/dgclaw.env"
criar_agente ana --nome "Ana" --dono "Marta"
criar_agente beto --nome "Beto" --dono "Marta"
igual "dois agentes criados" "2" "$(jq '[.agentes[] | select(.tipo=="agente")] | length' "$ETC/agentes.json")"

# --- dados do aluno -----------------------------------------------------------------------------
printf 'GROQ_API_KEY=gsk_chave_da_marta\nELEVENLABS_API_KEY=el_chave\nQUALQUER_COISA=1\n' >>"$ETC/web.env"
printf 'LINHA_DA_MARTA=oi\n' >>"$ETC/dgclaw.env"
for s in ana beto; do
    casa="$LIB/agentes/$s"; h="$casa/home"
    printf '# Memoria de %s\nA Marta prefere cafe sem acucar.\n' "$s" >"$h/MEMORY.md"
    mkdir -p "$h/.claude/projects/-home-agente" "$h/uploads" "$h/.dgclaw"
    printf '{"msg":"conversa de %s com a Marta"}\n' "$s" >"$h/.claude/projects/-home-agente/sessao1.jsonl"
    printf 'OPENAI_API_KEY=sk-%s-da-marta\n' "$s" >"$casa/cofre/cofre.env"
    printf 'conteudo do contrato de %s\n' "$s" >"$h/uploads/contrato com espaco.txt"
    printf '# Identidade personalizada\nVoce e %s, a assistente da Marta.\n' "$s" >"$h/IDENTITY.md"
    printf '# Personalidade\nAlegre e direta.\n' >"$h/PERSONALITY.md"
    printf '{"crons":[{"name":"lembrete-agua","calendar":"*-*-* 09:00:00"}]}\n' >"$h/.dgclaw/self-crons.json"
done
printf '# Meu Admin personalizado\nSempre me chame de Dona Marta.\n' >"$ADMIN/CLAUDE.md"
mkdir -p "$ADMIN/uploads" "$RAIZ/root/.claude/projects/-opt-dgclaw-admin"
printf 'pdf da marta\n' >"$ADMIN/uploads/proposta.pdf"
printf '{"msg":"conversa do admin"}\n' >"$RAIZ/root/.claude/projects/-opt-dgclaw-admin/a.jsonl"
printf '{"c_ana":{"sessao":"abc"}}\n' >"$LIB/web/sessoes.json"

# Os arquivos que NAO PODEM mudar numa atualizacao (o web.env e o dgclaw.env ganham linhas, mas
# as de antes ficam: conferidos linha a linha mais abaixo).
fotografar() {
    local f
    for f in "$ETC"/runner/*.token "$ETC"/proxy/*.segredo "$ETC/registro.tsv" "$ETC/portas.tsv" \
             "$LIB"/agentes/*/cofre/cofre.env "$LIB"/agentes/*/home/MEMORY.md "$LIB"/agentes/*/home/IDENTITY.md \
             "$LIB"/agentes/*/home/PERSONALITY.md "$LIB"/agentes/*/home/.dgclaw/self-crons.json \
             "$LIB"/agentes/*/home/.claude/projects/-home-agente/sessao1.jsonl "$LIB"/agentes/*/home/uploads/* \
             "$ADMIN/CLAUDE.md" "$ADMIN"/uploads/* "$RAIZ"/root/.claude/projects/-opt-dgclaw-admin/a.jsonl \
             "$LIB/web/sessoes.json"; do
        if [ -f "$f" ]; then printf '%s  %s\n' "$(sha256sum <"$f" | cut -d' ' -f1)" "${f#"$RAIZ"}"; else printf 'AUSENTE  %s\n' "${f#"$RAIZ"}"; fi
    done
}
linhas_do_aluno_ok() {
    grep -qx 'GROQ_API_KEY=gsk_chave_da_marta' "$ETC/web.env" && grep -qx 'ELEVENLABS_API_KEY=el_chave' "$ETC/web.env" \
        && grep -qx 'QUALQUER_COISA=1' "$ETC/web.env" && grep -q "^DGCLAW_PANEL_PASSWORD_HASH='scrypt" "$ETC/web.env" \
        && grep -qx 'DGCLAW_PANEL_USER=maria' "$ETC/web.env" && grep -qx 'LINHA_DA_MARTA=oi' "$ETC/dgclaw.env" \
        && grep -qx 'DGCLAW_DOMINIO=teste.exemplo.org' "$ETC/dgclaw.env"
}
fotografar >"$TMP/antes.txt"
afirma "a fotografia pegou os arquivos do aluno" test "$(grep -vc AUSENTE "$TMP/antes.txt")" -ge 20
igual "nenhum arquivo do aluno falta antes de comecar" "0" "$(grep -c AUSENTE "$TMP/antes.txt")"
cp "$ETC/agentes.json" "$TMP/agentes-antes.json"

# --- o GitHub ganha a versao 2 ---------------------------------------------------------------------
echo '# Admin (Claude) v2: leia docs/ATUALIZAR.md' >"$TRAB/templates/admin/CLAUDE.md"
echo '# Admin (Codex) v2: leia docs/ATUALIZAR.md' >"$TRAB/templates/admin/AGENTS.md"
echo 'novidade' >"$TRAB/NOVIDADE.md"
git -C "$TRAB" add -A; git -C "$TRAB" commit -q -m v2; git -C "$TRAB" push -q origin main
COMMIT_V2="$(git -C "$TRAB" rev-parse HEAD)"

echo "pre-checagem: alteracao local no clone"
echo 'mexi aqui' >>"$CLONE/README.md"
: >"$STUB_LOG"
dgclaw atualizar >"$TMP/o1.txt" 2>&1; rc=$?
igual "com alteracao local o comando para (codigo 1)" "1" "$rc"
afirma "diz o arquivo alterado" grep -q 'README.md' "$TMP/o1.txt"
afirma "explica como guardar de lado" grep -q 'git stash push -u -m dgclaw-atualizar-' "$TMP/o1.txt"
afirma "oferece o --forcar-local" grep -q -- '--forcar-local' "$TMP/o1.txt"
nega "nao fez backup" test -e "$BACKUPS"
nega "nao mexeu em container" grep -q '^podman \(stop\|rm\|build\|create\)' "$STUB_LOG"
igual "o clone continua no commit antigo" "$COMMIT_V1" "$(git -C "$CLONE" rev-parse HEAD)"
afirma "a alteracao do aluno continua no clone" grep -q 'mexi aqui' "$CLONE/README.md"
fotografar >"$TMP/depois.txt"
igual "arquivos do aluno intactos" "" "$(diff "$TMP/antes.txt" "$TMP/depois.txt")"

echo "simular"
dgclaw atualizar --simular --forcar-local >"$TMP/o2.txt" 2>&1; rc=$?
igual "--simular termina com 0" "0" "$rc"
afirma "avisa que e simulacao" grep -q 'SIMULACAO' "$TMP/o2.txt"
afirma "mostra o stash que faria" grep -q '\[ensaio\] guardaria isso num stash' "$TMP/o2.txt"
nega "simular nao faz backup" test -e "$BACKUPS"
nega "simular nao mexe em container" grep -q '^podman \(stop\|rm\|build\|create\)' "$STUB_LOG"
igual "simular nao puxa nada" "$COMMIT_V1" "$(git -C "$CLONE" rev-parse HEAD)"
afirma "a alteracao do aluno continua no clone" grep -q 'mexi aqui' "$CLONE/README.md"
nega "simular nao agenda reinicio" grep -q '^systemd-run' "$STUB_LOG"
fotografar >"$TMP/depois.txt"
igual "arquivos do aluno intactos" "" "$(diff "$TMP/antes.txt" "$TMP/depois.txt")"
git -C "$CLONE" checkout -q README.md

echo "atualizar de verdade"
echo imagem-v2 >"$STUB_ESTADO/imagem-id"   # a imagem "mudou": os containers velhos precisam ser recriados
: >"$STUB_LOG"
dgclaw atualizar >"$TMP/o3.txt" 2>&1; rc=$?
igual "atualizar sai com 0" "0" "$rc"
[ "$rc" -eq 0 ] || sed 's/^/      | /' "$TMP/o3.txt" | tail -n 30
afirma "diz que concluiu" grep -q 'Atualizacao concluida' "$TMP/o3.txt"
afirma "diz como voltar atras" grep -q 'sudo dgclaw atualizar --voltar ' "$TMP/o3.txt"
igual "o clone foi para o commit novo" "$COMMIT_V2" "$(git -C "$CLONE" rev-parse HEAD)"
fotografar >"$TMP/depois.txt"
igual "TODOS os arquivos do aluno intactos (memoria, conversas, cofre, uploads, identidade, rotina, Admin)" "" "$(diff "$TMP/antes.txt" "$TMP/depois.txt")"
afirma "linhas do aluno no web.env e no dgclaw.env sobreviveram" linhas_do_aluno_ok
afirma "o dgclaw.env passou a anotar o commit novo" grep -qx "DGCLAW_COMMIT=$COMMIT_V2" "$ETC/dgclaw.env"
afirma "agentes.json: os dois agentes iguais aos de antes" bash -c "[ \"\$(jq -cS '[.agentes[] | select(.tipo==\"agente\")] | sort_by(.slug)' '$ETC/agentes.json')\" = \"\$(jq -cS '[.agentes[] | select(.tipo==\"agente\")] | sort_by(.slug)' '$TMP/agentes-antes.json')\" ]"
afirma "agentes.json: o Admin continua registrado" jq -e '[.agentes[] | select(.slug=="admin")] | length == 1' "$ETC/agentes.json"
igual "CLAUDE.md personalizado do Admin nao foi trocado" "personalizado" "$(grep -q 'Dona Marta' "$ADMIN/CLAUDE.md" && echo personalizado)"
afirma "a versao nova do CLAUDE.md ficou ao lado (.novo)" grep -q 'v2: leia docs/ATUALIZAR.md' "$ADMIN/CLAUDE.md.novo"
afirma "o AGENTS.md que veio de fabrica foi atualizado" grep -q 'v2: leia docs/ATUALIZAR.md' "$ADMIN/AGENTS.md"
afirma "o aviso do CLAUDE.md personalizado aparece" grep -q 'foi personalizado' "$TMP/o3.txt"

B1="$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
igual "um backup datado foi criado" "1" "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | wc -l)"
igual "a pasta do backup e so do root (700)" "700" "$(stat -c %a "$B1")"
for a in config admin dados transcricoes-admin; do
    afirma "o backup tem $a.tar.gz que abre" tar -tzf "$B1/$a.tar.gz"
done
afirma "o backup tem o MANIFESTO.txt" test -s "$B1/MANIFESTO.txt"
afirma "o manifesto guarda o commit de antes" grep -qx "commit=$COMMIT_V1" "$B1/MANIFESTO.txt"
afirma "o manifesto lista os agentes" grep -qx 'agentes=ana,beto' "$B1/MANIFESTO.txt"
afirma "o manifesto traz os sha256" grep -q 'etc/dgclaw/web.env' "$B1/MANIFESTO.txt"
afirma "o backup guarda o web.env com a chave" bash -c "tar -xzOf '$B1/config.tar.gz' etc/dgclaw/web.env | grep -qx 'GROQ_API_KEY=gsk_chave_da_marta'"
afirma "o backup guarda a memoria da Ana" bash -c "tar -xzOf '$B1/dados.tar.gz' var/lib/dgclaw/agentes/ana/home/MEMORY.md | grep -q 'cafe sem acucar'"
afirma "o backup guarda o cofre do Beto" bash -c "tar -xzOf '$B1/dados.tar.gz' var/lib/dgclaw/agentes/beto/cofre/cofre.env | grep -qx 'OPENAI_API_KEY=sk-beto-da-marta'"
afirma "o backup guarda o CLAUDE.md personalizado do Admin" bash -c "tar -xzOf '$B1/admin.tar.gz' opt/dgclaw/admin/CLAUDE.md | grep -q 'Dona Marta'"
afirma "o backup guarda a conversa do Admin" bash -c "tar -xzOf '$B1/transcricoes-admin.tar.gz' root/.claude/projects/-opt-dgclaw-admin/a.jsonl | grep -q 'conversa do admin'"

afirma "reconstruiu a imagem" grep -q '^podman build ' "$STUB_LOG"
for s in ana beto; do
    afirma "$s: container parado e removido" bash -c "grep -q '^podman stop -t 60 dgclaw-$s' '$STUB_LOG' && grep -q '^podman rm dgclaw-$s' '$STUB_LOG'"
    afirma "$s: container criado de novo com a mesma casa" grep -q "^podman create .*--name dgclaw-$s .*--volume $LIB/agentes/$s/home:/home/agente:rw" "$STUB_LOG"
    afirma "$s: o cofre continua montado" grep -q "^podman create .*--name dgclaw-$s .*--volume $LIB/agentes/$s/cofre:/run/dgclaw/cofre:ro" "$STUB_LOG"
    afirma "$s: guardou as rotinas antes de trocar" grep -q "^podman exec dgclaw-$s sh -c cd /etc/systemd/system" "$STUB_LOG"
done
igual "so dois containers removidos" "2" "$(grep -c '^podman rm ' "$STUB_LOG")"
nega "nunca apagou volume nem rede" grep -q '^podman \(volume rm\|network rm\|system prune\|image rm\|rmi\)' "$STUB_LOG"
afirma "agendou o reinicio do Admin desacoplado (20 s) com o roteiro que avisa o resultado" grep -q '^systemd-run --on-active=20 --unit=dgclaw-admin-restart-.* bash .*lib/reiniciar-admin.sh .*\.resumo\.txt .*\.log .*runner/admin.token' "$STUB_LOG"
nega "o token do Admin nao aparece na linha de comando do agendamento" grep -q "$(cat "$ETC/runner/admin.token")" "$STUB_LOG"
RESUMO="$(find "$RAIZ/var/log/dgclaw" -name '*.resumo.txt' | head -n 1)"
afirma "o resumo foi gravado em arquivo antes do reinicio" test -s "$RESUMO"
afirma "o resumo traz versao antiga -> nova, backup e como voltar" bash -c "grep -q 'Atualizacao concluida' '$RESUMO' && grep -q -- '-> ' '$RESUMO' && grep -q 'Backup:' '$RESUMO' && grep -q -- '--voltar' '$RESUMO' && grep -q 'ana, beto' '$RESUMO'"
afirma "o resumo mostra o commit de antes certo (${COMMIT_V1:0:10})" grep -q "(${COMMIT_V1:0:10}) ->" "$RESUMO"
nega "nao reiniciou o Admin direto (ele pode ser quem roda o comando)" grep -q '^systemctl restart dgclaw-admin' "$STUB_LOG"
ult="$(grep -n '^systemd-run' "$STUB_LOG" | tail -n 1 | cut -d: -f1)"; bld="$(grep -n '^podman build' "$STUB_LOG" | tail -n 1 | cut -d: -f1)"
afirma "o reinicio do Admin e o ultimo passo (depois do build)" test "${ult:-0}" -gt "${bld:-1}"

echo "o roteiro que reinicia o Admin e avisa o resultado"
: >"$STUB_LOG"; rm -f "$STUB_LOG.curl-stdin" "$STUB_LOG.curl-config"
bash "$REPO/lib/reiniciar-admin.sh" "$RESUMO" "$TMP/reinicio.log" "$ETC/runner/admin.token" >/dev/null 2>&1; rc=$?
igual "reiniciar-admin.sh sai com 0" "0" "$rc"
afirma "reinicia o servico do Admin" grep -q '^systemctl restart dgclaw-admin' "$STUB_LOG"
afirma "espera o /api/saude do Admin" grep -q 'curl .*127.0.0.1:4300/api/saude' "$STUB_LOG"
afirma "avisa o Admin por POST em /api/agents/admin/input" grep -q 'curl .*-X POST .*http://127.0.0.1:4300/api/agents/admin/input' "$STUB_LOG"
afirma "o aviso cita o resumo e pede que conte ao dono" bash -c "grep -q 'resumo.txt' '$STUB_LOG.curl-stdin' && grep -q 'conte ao dono' '$STUB_LOG.curl-stdin' && grep -qF 'submit' '$STUB_LOG.curl-stdin'"
afirma "o token vai no arquivo de configuracao do curl" grep -q "Authorization: Bearer $(cat "$ETC/runner/admin.token")" "$STUB_LOG.curl-config"
nega "o token nunca aparece na linha de comando (STUB_LOG)" grep -q "$(cat "$ETC/runner/admin.token")" "$STUB_LOG"
nega "o token nunca aparece no log do roteiro" grep -q "$(cat "$ETC/runner/admin.token")" "$TMP/reinicio.log"
touch "$STUB_ESTADO/curl-falha"
: >"$STUB_LOG"
DGCLAW_ESPERA_ADMIN=2 bash "$REPO/lib/reiniciar-admin.sh" "$RESUMO" "$TMP/reinicio2.log" "$ETC/runner/admin.token" >/dev/null 2>&1; rc=$?
rm -f "$STUB_ESTADO/curl-falha"
igual "se o Admin nao volta, sai com erro" "1" "$rc"
afirma "o log diz que ele nao respondeu e onde esta o resumo" grep -q 'nao respondeu em 2s.*resumo' "$TMP/reinicio2.log"
nega "sem o Admin de pe, nao tenta o POST" grep -q 'X POST' "$STUB_LOG"

echo "repetir sem novidade"
: >"$STUB_LOG"
dgclaw atualizar >"$TMP/o4.txt" 2>&1; rc=$?
igual "repetir sai com 0" "0" "$rc"
afirma "diz que ja estava na versao mais nova" grep -q 'ja estava na versao mais nova' "$TMP/o4.txt"
igual "nenhum container recriado de novo (a imagem e a mesma)" "0" "$(grep -c '^podman rm ' "$STUB_LOG")"
fotografar >"$TMP/depois.txt"
igual "arquivos do aluno intactos" "" "$(diff "$TMP/antes.txt" "$TMP/depois.txt")"
igual "dois backups agora" "2" "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | wc -l)"

echo "voltar"
printf 'LINHA_NOVA_DEPOIS_DO_BACKUP=1\n' >>"$ETC/web.env"
: >"$STUB_LOG"
dgclaw atualizar --voltar "$B1" --simular >"$TMP/o5.txt" 2>&1; rc=$?
igual "--voltar --simular sai com 0" "0" "$rc"
afirma "a linha nova continua (simular nao restaurou nada)" grep -qx 'LINHA_NOVA_DEPOIS_DO_BACKUP=1' "$ETC/web.env"
igual "o clone continua na branch de antes" "main" "$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)"
dgclaw atualizar --voltar "$B1" >"$TMP/o6.txt" 2>&1; rc=$?
igual "--voltar sai com 0" "0" "$rc"
[ "$rc" -eq 0 ] || sed 's/^/      | /' "$TMP/o6.txt" | tail -n 30
afirma "o clone esta numa branch dgclaw-volta-*" bash -c "git -C '$CLONE' rev-parse --abbrev-ref HEAD | grep -q '^dgclaw-volta-'"
igual "o clone voltou ao commit do backup" "$COMMIT_V1" "$(git -C "$CLONE" rev-parse HEAD)"
afirma "a branch main continua no commit novo (nada apagado)" bash -c "[ \"\$(git -C '$CLONE' rev-parse main)\" = '$COMMIT_V2' ]"
afirma "o web.env voltou ao do backup (sem a linha nova)" bash -c "! grep -qx 'LINHA_NOVA_DEPOIS_DO_BACKUP=1' '$ETC/web.env'"
afirma "as linhas do aluno continuam" linhas_do_aluno_ok
fotografar >"$TMP/depois.txt"
igual "arquivos do aluno intactos depois de voltar" "" "$(diff "$TMP/antes.txt" "$TMP/depois.txt")"
igual "o --voltar fez um backup do estado de antes (3 backups)" "3" "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | wc -l)"
afirma "um dos backups tem o motivo antes-de-voltar" grep -rqx 'motivo=antes-de-voltar' "$BACKUPS"
afirma "reconstruiu a imagem ao voltar" grep -q '^podman build ' "$STUB_LOG"
nega "backup inexistente e recusado" dgclaw atualizar --voltar "$TMP/nao-existe"

echo "a conferencia pega um instalador que apaga uma chave"
git -C "$CLONE" switch -q main
# shellcheck disable=SC2016 # o $@ e o $DG_ETC vao literais para dentro do install.sh sabotado
sed -i 's|^main "\$@"$|main "$@"\nsed -i "/^GROQ_API_KEY=/d" "$DG_ETC/web.env"|' "$TRAB/install.sh"
git -C "$TRAB" add -A; git -C "$TRAB" commit -q -m v3-sabotado; git -C "$TRAB" push -q origin main
echo 'sujeira do aluno' >"$CLONE/anotacao.txt"
: >"$STUB_LOG"
dgclaw atualizar --forcar-local >"$TMP/o7.txt" 2>&1; rc=$?
igual "a atualizacao que apaga uma chave termina com erro" "1" "$rc"
afirma "aponta a chave que sumiu" grep -q "FALHOU.*'GROQ_API_KEY'" "$TMP/o7.txt"
afirma "mostra como voltar" grep -q -- '--voltar' "$TMP/o7.txt"
nega "com problema, nao reinicia o Admin" grep -q '^systemd-run' "$STUB_LOG"
nega "o valor da chave nunca aparece na saida" grep -q 'gsk_chave_da_marta' "$TMP/o7.txt"
afirma "--forcar-local guardou a sujeira do aluno no stash" bash -c "git -C '$CLONE' stash list | grep -q 'dgclaw-atualizar-'"
nega "a anotacao saiu do clone para o stash, mas nao foi perdida" test -e "$CLONE/anotacao.txt"
afirma "a anotacao esta no stash" bash -c "git -C '$CLONE' stash show -u -p stash@{0} | grep -q 'sujeira do aluno'"


echo "um agente que nao recria: a atualizacao diz INCOMPLETA e nao reinicia o Admin"
# Volta ao instalador bom (reverte a sabotagem) e devolve a chave que ela apagou.
git -C "$TRAB" revert --no-edit HEAD >/dev/null 2>&1; git -C "$TRAB" push -q origin main
printf 'GROQ_API_KEY=gsk_chave_da_marta\n' >>"$ETC/web.env"
echo imagem-v4 >"$STUB_ESTADO/imagem-id"
echo sempre >"$STUB_ESTADO/stop-trava-dgclaw-ana"   # o stop da Ana devolve e o container fica em 'stopping'
touch "$STUB_ESTADO/mounts-volume"                     # com volume do podman o 'rm -f' e proibido: a Ana nao recria
: >"$STUB_LOG"
DGCLAW_TEMPO_PARADA=2 dgclaw atualizar --forcar-local >"$TMP/o8.txt" 2>&1; rc=$?
[ "$rc" -ne 0 ] || sed 's/^/      | /' "$TMP/o8.txt" | tail -n 30
nega "sai com codigo diferente de 0" test "$rc" -eq 0
afirma "diz INCOMPLETA" grep -q 'Atualizacao INCOMPLETA' "$TMP/o8.txt"
nega "nao diz concluida" grep -q 'Atualizacao concluida' "$TMP/o8.txt"
afirma "lista o agente com problema" grep -q 'Agentes COM PROBLEMA: ana' "$TMP/o8.txt"
afirma "traz o comando para refazer o agente" grep -q 'dgclaw agente recriar ana --forcar' "$TMP/o8.txt"
afirma "o Beto, que recriou, aparece como bem" grep -q 'Agentes que ficaram bem: beto' "$TMP/o8.txt"
afirma "explica por que o Admin nao reinicia" grep -q 'NAO vou reiniciar o Admin' "$TMP/o8.txt"
nega "nao agenda o reinicio do Admin" grep -q '^systemd-run' "$STUB_LOG"
afirma "o resumo INCOMPLETA tambem foi gravado" grep -rq 'Atualizacao INCOMPLETA' "$RAIZ/var/log/dgclaw"
afirma "o container do Beto foi trocado" grep -q '^podman create .*--name dgclaw-beto ' "$STUB_LOG"
fotografar >"$TMP/depois.txt"
igual "os arquivos do aluno continuam intactos" "" "$(diff "$TMP/antes.txt" "$TMP/depois.txt")"

echo "refazer o agente travado com 'agente recriar --forcar'"
rm -f "$STUB_ESTADO/mounts-volume"
DGCLAW_TEMPO_PARADA=2 dgclaw agente recriar ana --forcar >"$TMP/o9.txt" 2>&1; rc=$?
igual "recriar --forcar sai com 0" "0" "$rc"
afirma "a Ana voltou a rodar" grep -qx running "$STUB_ESTADO/c-dgclaw-ana"
rm -f "$STUB_ESTADO/stop-trava-dgclaw-ana"

echo "o commit de antes vem do instalado, nao do HEAD do clone (clone mudado a mao)"
COMMIT_ANTES="$(git -C "$CLONE" rev-parse HEAD)"
git -C "$TRAB" commit -q --allow-empty -m v5; git -C "$TRAB" push -q origin main
git -C "$CLONE" pull -q --ff-only                   # o aluno (ou o Admin) puxou a mao, antes do comando
COMMIT_NOVO="$(git -C "$CLONE" rev-parse HEAD)"
afirma "o clone ja esta no commit novo" test "$COMMIT_NOVO" != "$COMMIT_ANTES"
sed -i '/^DGCLAW_COMMIT=/d; s/^DGCLAW_VERSAO=.*/DGCLAW_VERSAO=v1-'"${COMMIT_ANTES:0:12}"'/' "$ETC/dgclaw.env"
: >"$STUB_LOG"
dgclaw atualizar --sem-baixar >"$TMP/o10.txt" 2>&1; rc=$?
igual "atualizar --sem-baixar sai com 0" "0" "$rc"
[ "$rc" -eq 0 ] || sed 's/^/      | /' "$TMP/o10.txt" | tail -n 30
afirma "algum manifesto grava o commit antigo certo" grep -rqx "commit=$COMMIT_ANTES" "$BACKUPS"
nega "nenhum manifesto grava o commit novo como o antigo" grep -rqx "commit=$COMMIT_NOVO" "$BACKUPS"
afirma "o resumo mostra o commit antigo certo" grep -q "(${COMMIT_ANTES:0:10}) ->" "$TMP/o10.txt"
afirma "avisa que o clone ja estava em outro commit" grep -q 'o clone ja estava em' "$TMP/o10.txt"

echo "sem DGCLAW_COMMIT nem hash na versao: usa o HEAD e avisa"
sed -i '/^DGCLAW_COMMIT=/d; s/^DGCLAW_VERSAO=.*/DGCLAW_VERSAO=desconhecida/' "$ETC/dgclaw.env"
dgclaw atualizar --sem-baixar >"$TMP/o11.txt" 2>&1; rc=$?
igual "sai com 0" "0" "$rc"
afirma "avisa que usou o HEAD do clone" grep -q 'uso o HEAD do clone' "$TMP/o11.txt"

fim
