#!/usr/bin/env bash
# Bloco D, backup cifrado com restic: configurar, agora, listar, testar, restaurar, timers. restic, sqlite3 e systemctl de mentira.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
preparar; stubs_d
export STUB_RESTIC="$TMP/repo-restic"
app_copia

CHAVE_SEGREDO="chave-secreta-do-bucket-123456"
ENV_BK="$ETC/backup.env"
ESTADO="$LIB/backup"
AUD="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"

echo "backup: monta uma maquina com um agente"
nivel_na_raiz escritorio
printf 'DGCLAW_PANEL_USER=maria\n' >"$ETC/web.env"
"$CLI_COPIA" agente criar ana --nome "Ana" >/dev/null 2>&1
CASA="$LIB/agentes/ana"
mkdir -p "$CASA/home/.claude/projects/-home-agente" "$CASA/home/memory" "$CASA/home/app/node_modules/x"
echo '{"msg":"oi"}' >"$CASA/home/.claude/projects/-home-agente/sessao1.jsonl"
echo "lembrar do cafe" >"$CASA/home/memory/cafe.md"
echo "lixo" >"$CASA/home/app/node_modules/x/index.js"
mkdir -p "$LIB/web"; echo "banco" >"$LIB/web/dados.db"
mkdir -p "$DGCLAW_RAIZ/opt/dgclaw/admin" "$DGCLAW_RAIZ/opt/dgclaw/app"
echo "admin" >"$DGCLAW_RAIZ/opt/dgclaw/admin/CLAUDE.md"; echo 1.0.0 >"$DGCLAW_RAIZ/opt/dgclaw/app/VERSION"
mkdir -p "$DGCLAW_RAIZ/etc/systemd/system"; echo "[Unit]" >"$DGCLAW_RAIZ/etc/systemd/system/dgclaw-web.service"
mkdir -p "$LIB/agentes.antes-de-cifrar/ana"; echo "copia antiga" >"$LIB/agentes.antes-de-cifrar/ana/x"

echo "backup: sem configurar"
: >"$STUB_LOG"
"$CLI_COPIA" backup agora >"$TMP/o.txt" 2>&1
igual "agora sem configurar falha" 1 "$?"
afirma "diz o que fazer" grep -q "dgclaw backup configurar" "$TMP/o.txt"
afirma "ultimo-backup.json registra a falha" bash -c "jq -e '.ok == false and (.erro | test(\"nao configurado\"))' '$ESTADO/ultimo-backup.json'"
nega "restaurar sem configurar recusa" "$CLI_COPIA" restaurar latest
nega "listar sem configurar recusa" "$CLI_COPIA" backup listar

echo "backup: configurar"
nega "endereco que nao parece repositorio" "$CLI_COPIA" backup configurar --repositorio "http://exemplo"
printf 'AWS_ACCESS_KEY_ID=AKIAEXEMPLO\nAWS_SECRET_ACCESS_KEY=%s\n' "$CHAVE_SEGREDO" >"$TMP/cred.txt"
: >"$STUB_LOG"
"$CLI_COPIA" backup configurar --repositorio "s3:https://s3.exemplo.com/bucket" --credenciais "$TMP/cred.txt" >"$TMP/o.txt" 2>&1 </dev/null
igual "configura e cria o repositorio" 0 "$?"
afirma "backup.env existe com modo 600" bash -c "[ \"\$(stat -c %a '$ENV_BK')\" = 600 ]"
afirma "tem o repositorio, a chave gerada e as credenciais" bash -c "grep -q '^RESTIC_REPOSITORY=' '$ENV_BK' && grep -q '^RESTIC_PASSWORD=' '$ENV_BK' && grep -q '^AWS_ACCESS_KEY_ID=' '$ENV_BK' && grep -q '^AWS_SECRET_ACCESS_KEY=' '$ENV_BK'"
afirma "rodou snapshots e depois init (repositorio novo)" bash -c "grep -q '^restic snapshots' '$STUB_LOG' && grep -q '^restic init' '$STUB_LOG'"
afirma "avisa que a chave deve ser guardada fora da VPS" grep -q "FORA desta VPS" "$TMP/o.txt"
# shellcheck source=/dev/null
CHAVE_GERADA="$( . "$ENV_BK"; printf '%s' "$RESTIC_PASSWORD" )"
igual "a chave gerada tem 64 caracteres (48 bytes em base64)" 64 "${#CHAVE_GERADA}"
afirma "a chave foi mostrada uma vez" grep -qF -- "$CHAVE_GERADA" "$TMP/o.txt"
afirma "nenhum segredo em argv (restic, nem nada)" bash -c "! grep -qF -e '$CHAVE_GERADA' -e '$CHAVE_SEGREDO' '$STUB_LOG'"
afirma "nenhum segredo na auditoria" bash -c "! grep -qF -e '$CHAVE_GERADA' -e '$CHAVE_SEGREDO' -e AKIAEXEMPLO '$AUD'"
"$CLI_COPIA" backup configurar --repositorio "s3:https://s3.exemplo.com/bucket" >"$TMP/o.txt" 2>&1 </dev/null
# shellcheck source=/dev/null
chave_depois="$( . "$ENV_BK"; printf '%s' "$RESTIC_PASSWORD" )"
igual "configurar de novo mantem a chave e as credenciais" "$CHAVE_GERADA" "$chave_depois"
afirma "e nao mostra a chave de novo" bash -c "! grep -qF -- '$CHAVE_GERADA' '$TMP/o.txt'"
afirma "as credenciais antigas continuam" bash -c "grep -q '^AWS_SECRET_ACCESS_KEY=' '$ENV_BK'"
echo "linha ruim no arquivo de credenciais"
printf 'RESTIC_PASSWORD=x\n' >"$TMP/ruim.txt"
nega "credencial com nome nao aceito" "$CLI_COPIA" backup configurar --repositorio "s3:https://s3.exemplo.com/bucket" --credenciais "$TMP/ruim.txt"
echo "repositorio inacessivel nao troca a configuracao boa"
cp "$ENV_BK" "$TMP/env.bom"
STUB_RESTIC_FALHA=init STUB_RESTIC="$TMP/outro-repo" "$CLI_COPIA" backup configurar --repositorio "s3:https://outro.exemplo.com/b" >"$TMP/o.txt" 2>&1 </dev/null
igual "falha" 1 "$?"
afirma "a configuracao boa ficou como estava" cmp -s "$ENV_BK" "$TMP/env.bom"
afirma "a mensagem nao vaza a credencial da URL" bash -c "! grep -q 'usuario:segredo' '$TMP/o.txt'"

echo "backup: agora"
: >"$STUB_LOG"
"$CLI_COPIA" backup agora >"$TMP/o.txt" 2>&1
igual "backup termina bem" 0 "$?"
afirma "ultimo-backup.json: ok e com snapshot" bash -c "jq -e '.ok == true and (.snapshot | test(\"^snap\")) and .erro == null and has(\"quando\")' '$ESTADO/ultimo-backup.json'"
SNAP="$(jq -r .snapshot "$ESTADO/ultimo-backup.json")"
afirma "cobre /etc/dgclaw, /var/lib/dgclaw, o admin, a versao e as unidades" bash -c "grep '^restic backup' '$STUB_LOG' | grep -q -e ' $ETC ' -e ' $ETC\$' && grep '^restic backup' '$STUB_LOG' | grep -q \"$LIB\" && grep '^restic backup' '$STUB_LOG' | grep -q 'opt/dgclaw/admin' && grep '^restic backup' '$STUB_LOG' | grep -q 'opt/dgclaw/app/VERSION' && grep '^restic backup' '$STUB_LOG' | grep -q 'dgclaw-web.service'"
afirma "exclui node_modules, .cache e .npm" bash -c "grep '^restic backup' '$STUB_LOG' | grep -q -e '--exclude node_modules' && grep '^restic backup' '$STUB_LOG' | grep -q -e '--exclude .cache' && grep '^restic backup' '$STUB_LOG' | grep -q -e '--exclude .npm'"
afirma "retencao: forget --keep-daily 30 --prune" grep -q "^restic forget --tag dgclaw --keep-daily 30 --prune" "$STUB_LOG"
afirma "o banco passou pelo sqlite3 .backup" grep -q "^sqlite3 $LIB/web/dados.db .timeout 10000 .backup" "$STUB_LOG"
afirma "no snapshot: o banco original nao esta, a copia consistente esta" bash -c "[ ! -e '$STUB_RESTIC/snap/$SNAP$LIB/web/dados.db' ] && [ -f '$STUB_RESTIC/snap/$SNAP$ESTADO/staging/bancos/web/dados.db' ]"
afirma "no snapshot: node_modules fora, memoria dentro" bash -c "[ ! -e '$STUB_RESTIC/snap/$SNAP$CASA/home/app/node_modules' ] && [ -f '$STUB_RESTIC/snap/$SNAP$CASA/home/memory/cafe.md' ]"
afirma "no snapshot: a copia antiga do disco cifrado fica de fora" bash -c "[ ! -e '$STUB_RESTIC/snap/$SNAP$LIB/agentes.antes-de-cifrar' ]"
afirma "no snapshot: web.env, admin e unidade" bash -c "[ -f '$STUB_RESTIC/snap/$SNAP$ETC/web.env' ] && [ -f '$STUB_RESTIC/snap/$SNAP$DGCLAW_RAIZ/opt/dgclaw/admin/CLAUDE.md' ] && [ -f '$STUB_RESTIC/snap/$SNAP$DGCLAW_RAIZ/etc/systemd/system/dgclaw-web.service' ]"
afirma "o manifesto tem web.env, agentes.json, transcript e memoria do agente" bash -c "jq -e '.arquivos | length == 4' '$ESTADO/manifesto.json'"
afirma "a pasta de staging foi apagada no fim" test ! -e "$ESTADO/staging"
afirma "auditou backup.ok" bash -c "jq -e 'select(.evento == \"backup.ok\" and .dados.snapshot == \"$SNAP\")' '$AUD'"
afirma "nenhum segredo em argv" bash -c "! grep -qF -e '$CHAVE_GERADA' -e '$CHAVE_SEGREDO' '$STUB_LOG'"

echo "backup: falha do restic fica registrada, com codigo diferente de zero"
: >"$STUB_LOG"
STUB_RESTIC_FALHA=backup "$CLI_COPIA" backup agora >"$TMP/o.txt" 2>&1
igual "sai com 1" 1 "$?"
afirma "a mensagem diz o que fazer" grep -q "O que fazer" "$TMP/o.txt"
afirma "ultimo-backup.json: ok false com o erro" bash -c "jq -e '.ok == false and (.erro | test(\"restic backup falhou\"))' '$ESTADO/ultimo-backup.json'"
afirma "o erro nao vaza a credencial da URL" bash -c "! grep -q 'usuario:segredo' '$ESTADO/ultimo-backup.json' '$TMP/o.txt'"
afirma "auditou backup.falha" bash -c "jq -e 'select(.evento == \"backup.falha\")' '$AUD'"
STUB_SQLITE_FALHA=1 "$CLI_COPIA" backup agora >"$TMP/o.txt" 2>&1
igual "banco que nao copia derruba o backup (nao guarda copia inconsistente)" 1 "$?"
afirma "e diz qual banco" grep -q "dados.db" "$TMP/o.txt"
echo "retencao do nivel regulado (14 dias)"
nivel_na_raiz regulado
: >"$STUB_LOG"
"$CLI_COPIA" backup agora >"$TMP/o.txt" 2>&1
afirma "regulado: forget --keep-daily 14" grep -q "^restic forget --tag dgclaw --keep-daily 14 --prune" "$STUB_LOG"
nivel_na_raiz escritorio
"$CLI_COPIA" backup agora >/dev/null 2>&1

echo "backup: listar, testar"
"$CLI_COPIA" backup listar >"$TMP/o.txt" 2>&1
igual "listar passa pelo restic" 0 "$?"
: >"$STUB_LOG"
"$CLI_COPIA" backup testar >"$TMP/o.txt" 2>&1
igual "teste de restauracao passa" 0 "$?"
afirma "ultimo-teste.json: ok" bash -c "jq -e '.ok == true and has(\"quando\") and (.snapshot | test(\"^snap\"))' '$ESTADO/ultimo-teste.json'"
afirma "restaurou so o manifesto e a amostra, numa pasta temporaria" bash -c "grep -c '^restic restore' '$STUB_LOG' | grep -q 2 && grep '^restic restore' '$STUB_LOG' | head -1 | grep -q 'manifesto.json'"
afirma "a pasta temporaria foi limpa" bash -c "[ -z \"\$(ls -d '$ESTADO'/teste.* 2>/dev/null)\" ]"
afirma "auditou o teste" bash -c "jq -e 'select(.evento == \"backup.teste_restauracao\" and .dados.ok == true and .dados.verificados == 4)' '$AUD'"
echo "backup: arquivo corrompido no repositorio e pego pelo teste"
ULT="$(cat "$STUB_RESTIC/ultimo")"
ALVO="$(jq -r '.arquivos[0].arquivo' "$STUB_RESTIC/snap/$ULT$ESTADO/manifesto.json")"
echo "adulterado" >"$STUB_RESTIC/snap/$ULT$ALVO"
"$CLI_COPIA" backup testar >"$TMP/o.txt" 2>&1
igual "o teste falha" 1 "$?"
afirma "diz qual arquivo nao bate" grep -q "nao batem com o manifesto" "$TMP/o.txt"
afirma "ultimo-teste.json: ok false" bash -c "jq -e '.ok == false and (.erro | test(\"manifesto\"))' '$ESTADO/ultimo-teste.json'"
afirma "a pasta temporaria tambem foi limpa" bash -c "[ -z \"\$(ls -d '$ESTADO'/teste.* 2>/dev/null)\" ]"
"$CLI_COPIA" backup agora >/dev/null 2>&1   # um snapshot novo e bom

echo "backup: restaurar"
nega "snapshot com caractere estranho" "$CLI_COPIA" restaurar 'a;b'
"$CLI_COPIA" restaurar latest >"$TMP/o.txt" 2>&1
igual "sem --destino nem --confirmar: restaura numa pasta ao lado" 0 "$?"
PASTA="$(find "$LIB/restauracoes" -mindepth 1 -maxdepth 1 | head -n 1)"
afirma "a pasta nova tem a memoria do agente" test -f "$PASTA$CASA/home/memory/cafe.md"
afirma "e nada em uso foi tocado" grep -q "lembrar do cafe" "$CASA/home/memory/cafe.md"
echo "mudou no disco" >"$CASA/home/memory/cafe.md"
"$CLI_COPIA" restaurar latest --destino "$TMP/destino1" >"$TMP/o.txt" 2>&1
igual "com --destino" 0 "$?"
afirma "restaurou" grep -q "lembrar do cafe" "$TMP/destino1$CASA/home/memory/cafe.md"
afirma "o arquivo em uso continua como estava" grep -q "mudou no disco" "$CASA/home/memory/cafe.md"
nega "destino que ja tem coisa: recusa" "$CLI_COPIA" restaurar latest --destino "$TMP/destino1"
"$CLI_COPIA" restaurar latest --destino "$TMP/destino2" --agente ana >"$TMP/o.txt" 2>&1
igual "so um agente" 0 "$?"
afirma "trouxe a casa do agente e so ela" bash -c "[ -f '$TMP/destino2$CASA/home/memory/cafe.md' ] && [ ! -e '$TMP/destino2$ETC/web.env' ]"
echo "restaurar no lugar exige --confirmar e agente parado"
nega "no lugar com agente ligado recusa" "$CLI_COPIA" restaurar latest --agente ana --confirmar
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
"$CLI_COPIA" restaurar latest --agente ana --confirmar >"$TMP/o.txt" 2>&1
igual "no lugar com --confirmar e agente parado" 0 "$?"
afirma "o arquivo voltou ao que estava no backup" grep -q "lembrar do cafe" "$CASA/home/memory/cafe.md"
afirma "auditou as restauracoes" bash -c "jq -s '[.[] | select(.evento == \"backup.restauracao\")] | length >= 4' '$AUD' | grep -q true"
afirma "a ultima restauracao foi no lugar, do agente ana" bash -c "jq -e 'select(.evento == \"backup.restauracao\" and .dados.no_lugar == true and .dados.agente == \"ana\")' '$AUD'"

echo "backup: status"
"$CLI_COPIA" backup status >"$TMP/o.txt" 2>&1
afirma "status mostra configurado e os dois estados" bash -c "grep -q 'configurado = sim' '$TMP/o.txt' && grep -q 'ultimo-backup: ok' '$TMP/o.txt' && grep -q 'ultimo-teste:' '$TMP/o.txt'"

echo "backup: timers do instalador"
: >"$STUB_LOG"
lib_d ent_instalar_backup >"$TMP/o.txt" 2>&1
U="$DGCLAW_RAIZ/etc/systemd/system"
afirma "servico e timer diario as 03:30 com atraso aleatorio" bash -c "grep -q 'OnCalendar=\*-\*-\* 03:30:00' '$U/dgclaw-backup.timer' && grep -q 'RandomizedDelaySec' '$U/dgclaw-backup.timer' && grep -q 'ExecStart=/usr/local/bin/dgclaw backup agora' '$U/dgclaw-backup.service'"
afirma "teste semanal no escritorio" grep -q "OnCalendar=Sun" "$U/dgclaw-backup-teste.timer"
afirma "timers habilitados" grep -q "^systemctl enable --now dgclaw-backup.timer dgclaw-backup-teste.timer" "$STUB_LOG"
nivel_na_raiz regulado
lib_d ent_instalar_backup >"$TMP/o.txt" 2>&1
afirma "regulado: teste mensal" grep -q "OnCalendar=\*-\*-01" "$U/dgclaw-backup-teste.timer"
nivel_na_raiz pessoal
rm -f "$U"/dgclaw-backup*
lib_d ent_instalar_backup >"$TMP/o.txt" 2>&1
afirma "pessoal: nenhuma unidade" bash -c "[ -z \"\$(ls '$U'/dgclaw-backup* 2>/dev/null)\" ]"

fim
