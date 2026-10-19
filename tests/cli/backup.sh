#!/usr/bin/env bash
# `dgclaw backup`, `dgclaw backup listar` e `dgclaw restaurar`, numa raiz falsa com podman de mentira.
#
# Cobre: o backup cria pasta datada com MANIFESTO (versao e commit) e tars que abrem; listar mostra;
# nunca apaga; restaurar recusa backup de outra versao sem --mesmo-assim; restaurar faz o backup
# antes-de-restaurar, devolve a linha alterada do web.env, para e religa os agentes e agenda o
# reinicio do Admin; --simular nao muda nada. O rollback automatico do `atualizar` fica em atualizar.sh.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

RAIZ="$DGCLAW_RAIZ"
ADMIN="$RAIZ/opt/dgclaw/admin"
BACKUPS="$RAIZ/var/backups/dgclaw"
COMMIT="0123456789abcdef0123456789abcdef01234567"

printf 'DGCLAW_DOMINIO=teste.exemplo.org\nDGCLAW_VERSAO=1.0.0\nDGCLAW_COMMIT=%s\n' "$COMMIT" >"$ETC/dgclaw.env"
printf 'GROQ_API_KEY=gsk_original\nDGCLAW_PANEL_USER=maria\n' >"$ETC/web.env"
printf '%s\n' '{"versao":1,"agentes":[{"slug":"admin","tipo":"admin"},{"slug":"ana","tipo":"agente","runner":"x:4311"}]}' >"$ETC/agentes.json"
mkdir -p "$ADMIN" "$LIB/agentes/ana/home" "$LIB/agentes/ana/cofre" "$LIB/web" "$RAIZ/etc/systemd/system"
printf '# Admin da Marta\n' >"$ADMIN/CLAUDE.md"
printf '# Memoria\nA Marta gosta de cafe.\n' >"$LIB/agentes/ana/home/MEMORY.md"
printf 'OPENAI_API_KEY=sk-ana\n' >"$LIB/agentes/ana/cofre/cofre.env"
: >"$RAIZ/etc/systemd/system/dgclaw-admin.service"
echo running >"$STUB_ESTADO/c-dgclaw-ana"

echo "backup --simular"
dgclaw backup --simular >"$TMP/o1.txt" 2>&1; rc=$?
igual "--simular sai com 0" "0" "$rc"
afirma "avisa que e simulacao" grep -q 'SIMULACAO' "$TMP/o1.txt"
nega "simular nao cria a pasta de backups" test -e "$BACKUPS"

echo "backup"
dgclaw backup >"$TMP/o2.txt" 2>&1; rc=$?
igual "backup sai com 0" "0" "$rc"
[ "$rc" -eq 0 ] || sed 's/^/      | /' "$TMP/o2.txt" | tail -n 20
B1="$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -name '*-manual' | head -n 1)"
afirma "criou uma pasta datada com sufixo -manual" test -d "$B1"
igual "a pasta e so do root (700)" "700" "$(stat -c %a "$B1")"
for a in config admin dados; do afirma "$a.tar.gz abre" tar -tzf "$B1/$a.tar.gz"; done
afirma "o manifesto traz a versao instalada" grep -qx 'versao=1.0.0' "$B1/MANIFESTO.txt"
afirma "o manifesto traz o commit instalado" grep -qx "commit_instalado=$COMMIT" "$B1/MANIFESTO.txt"
afirma "o manifesto traz o motivo manual" grep -qx 'motivo=manual' "$B1/MANIFESTO.txt"
afirma "o manifesto diz que as casas entraram" grep -qx 'casas_dos_agentes_no_backup=sim' "$B1/MANIFESTO.txt"
afirma "o backup guarda a memoria da Ana" bash -c "tar -xzOf '$B1/dados.tar.gz' var/lib/dgclaw/agentes/ana/home/MEMORY.md | grep -q cafe"
afirma "imprime a pasta" grep -qF "$B1" "$TMP/o2.txt"
afirma "imprime o tamanho" grep -q 'Tamanho:' "$TMP/o2.txt"
afirma "imprime o comando para restaurar" grep -qF "sudo dgclaw restaurar $B1" "$TMP/o2.txt"

echo "backup --sem-casas"
sleep 1
dgclaw backup --sem-casas >"$TMP/o3.txt" 2>&1; rc=$?
igual "sai com 0" "0" "$rc"
B2="$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -name '*-manual' | sort | tail -n 1)"
afirma "sao duas pastas distintas" test "$B1" != "$B2"
afirma "o manifesto diz que as casas ficaram de fora" grep -qx 'casas_dos_agentes_no_backup=nao' "$B2/MANIFESTO.txt"
nega "a memoria da Ana nao entrou" bash -c "tar -xzOf '$B2/dados.tar.gz' var/lib/dgclaw/agentes/ana/home/MEMORY.md"
afirma "o cofre entrou" bash -c "tar -xzOf '$B2/dados.tar.gz' var/lib/dgclaw/agentes/ana/cofre/cofre.env | grep -q sk-ana"

echo "backup listar"
dgclaw backup listar >"$TMP/o4.txt" 2>&1; rc=$?
igual "listar sai com 0" "0" "$rc"
afirma "mostra as duas pastas" bash -c "grep -q '$(basename "$B1")' '$TMP/o4.txt' && grep -q '$(basename "$B2")' '$TMP/o4.txt'"
afirma "mostra motivo, versao e se tem as casas" bash -c "grep '$(basename "$B1")' '$TMP/o4.txt' | grep -q 'manual.*1.0.0.*sim' && grep '$(basename "$B2")' '$TMP/o4.txt' | grep -q 'manual.*1.0.0.*nao'"
nega "backup com opcao desconhecida e recusado" dgclaw backup --nada
igual "nenhum backup foi apagado" "2" "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | wc -l)"

echo "restaurar: backup de outra versao"
sed -i 's/^DGCLAW_VERSAO=.*/DGCLAW_VERSAO=1.1.0/' "$ETC/dgclaw.env"
printf 'GROQ_API_KEY=gsk_mudou\nLINHA_NOVA=1\n' >"$ETC/web.env"
: >"$STUB_LOG"
dgclaw restaurar "$B1" >"$TMP/o5.txt" 2>&1; rc=$?
igual "recusa (codigo 1)" "1" "$rc"
afirma "explica a diferenca de versao" grep -q "versao '1.0.0'.*'1.1.0'" "$TMP/o5.txt"
afirma "aponta o atualizar --voltar" grep -qF "sudo dgclaw atualizar --voltar $B1" "$TMP/o5.txt"
afirma "oferece o --mesmo-assim" grep -q -- '--mesmo-assim' "$TMP/o5.txt"
afirma "o web.env nao foi tocado" grep -qx 'LINHA_NOVA=1' "$ETC/web.env"
nega "nao parou agente nenhum" grep -q '^podman stop' "$STUB_LOG"
igual "nao fez backup nenhum a mais" "2" "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | wc -l)"

echo "restaurar: backup que nao abre"
mkdir -p "$TMP/ruim"; cp "$B1/MANIFESTO.txt" "$TMP/ruim/"; echo lixo >"$TMP/ruim/config.tar.gz"
dgclaw restaurar "$TMP/ruim" --mesmo-assim >"$TMP/o5b.txt" 2>&1; rc=$?
igual "recusa (codigo 1)" "1" "$rc"
afirma "diz qual arquivo nao abre" grep -q 'config.tar.gz do backup nao abre' "$TMP/o5b.txt"
nega "pasta que nao e backup e recusada" dgclaw restaurar "$TMP"

echo "restaurar --simular"
sed -i 's/^DGCLAW_VERSAO=.*/DGCLAW_VERSAO=1.0.0/' "$ETC/dgclaw.env"
cp "$ETC/web.env" "$TMP/web-antes.env"
: >"$STUB_LOG"
dgclaw restaurar "$B1" --simular >"$TMP/o6.txt" 2>&1; rc=$?
igual "--simular sai com 0" "0" "$rc"
afirma "avisa que e simulacao" grep -q 'SIMULACAO' "$TMP/o6.txt"
afirma "o web.env nao mudou" cmp -s "$ETC/web.env" "$TMP/web-antes.env"
nega "nao parou agente" grep -q '^podman stop' "$STUB_LOG"
nega "nao agendou reinicio" grep -q '^systemd-run' "$STUB_LOG"
igual "nenhum backup novo" "2" "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | wc -l)"

echo "restaurar"
printf 'novo conteudo da memoria\n' >"$LIB/agentes/ana/home/MEMORY.md"
sleep 1
: >"$STUB_LOG"
dgclaw restaurar "$B1" >"$TMP/o7.txt" 2>&1; rc=$?
igual "restaurar sai com 0" "0" "$rc"
[ "$rc" -eq 0 ] || sed 's/^/      | /' "$TMP/o7.txt" | tail -n 25
afirma "a linha alterada do web.env voltou ao valor do backup" grep -qx 'GROQ_API_KEY=gsk_original' "$ETC/web.env"
nega "a linha criada depois do backup saiu do web.env" grep -qx 'LINHA_NOVA=1' "$ETC/web.env"
afirma "a memoria da Ana voltou" grep -q 'A Marta gosta de cafe' "$LIB/agentes/ana/home/MEMORY.md"
afirma "fez o backup antes-de-restaurar" grep -rqx 'motivo=antes-de-restaurar' "$BACKUPS"
ANTES="$(grep -rlx 'motivo=antes-de-restaurar' "$BACKUPS" | head -n 1)"
afirma "esse backup guardou o web.env de antes de restaurar (com a linha nova)" bash -c "tar -xzOf '$(dirname "$ANTES")/config.tar.gz' etc/dgclaw/web.env | grep -qx 'LINHA_NOVA=1'"
afirma "esse backup guardou as casas dos agentes" bash -c "tar -xzOf '$(dirname "$ANTES")/dados.tar.gz' var/lib/dgclaw/agentes/ana/home/MEMORY.md | grep -q 'novo conteudo'"
igual "tres backups agora (nenhum foi apagado)" "3" "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | wc -l)"
afirma "parou a Ana antes de restaurar" grep -q '^podman stop .*dgclaw-ana' "$STUB_LOG"
afirma "religou a Ana depois" grep -q '^podman start dgclaw-ana' "$STUB_LOG"
afirma "agendou o reinicio do Admin desacoplado" grep -q '^systemd-run --on-active=20 --unit=dgclaw-admin-restart-' "$STUB_LOG"
nega "nunca reiniciou o Admin direto" grep -q '^systemctl restart dgclaw-admin' "$STUB_LOG"
afirma "diz como desfazer" grep -q 'Para desfazer: sudo dgclaw restaurar ' "$TMP/o7.txt"

echo "restaurar --mesmo-assim com outra versao"
sed -i 's/^DGCLAW_VERSAO=.*/DGCLAW_VERSAO=1.1.0/' "$ETC/dgclaw.env"
sleep 1
dgclaw restaurar "$B1" --mesmo-assim >"$TMP/o8.txt" 2>&1; rc=$?
igual "com --mesmo-assim restaura" "0" "$rc"
afirma "avisa da diferenca de versao" grep -q 'diferente da instalada' "$TMP/o8.txt"

echo "agente criado depois do backup"
jq '.agentes += [{"slug":"beto","tipo":"agente","runner":"x:4312"}]' "$ETC/agentes.json" >"$TMP/ag.json" && cp "$TMP/ag.json" "$ETC/agentes.json"
sed -i 's/^DGCLAW_VERSAO=.*/DGCLAW_VERSAO=1.0.0/' "$ETC/dgclaw.env"
dgclaw restaurar "$B1" >"$TMP/o9.txt" 2>&1; rc=$?
igual "recusa (codigo 1)" "1" "$rc"
afirma "lista o agente novo" grep -q 'DEPOIS desse backup: beto' "$TMP/o9.txt"

echo "pontos de extensao"
for f in backup_caminhos_extras backup_aplicar_retencao depois_de_restaurar depois_de_atualizar; do
    afirma "$f existe no lib/backup.sh com o padrao que nao faz nada" grep -q "^$f() { return 0; }" "$REPO/lib/backup.sh"
done

fim
