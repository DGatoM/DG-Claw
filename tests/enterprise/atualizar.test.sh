#!/usr/bin/env bash
# dgclaw atualizar do main + ganchos enterprise (lib/enterprise/atualizar.sh): no nivel pessoal o backup
# e o do main; acima dele sai sem segredos e sem conversas, a auditoria registra o comando e a
# retencao apaga os backups velhos. O fluxo inteiro do comando (instalar, imagem, agentes, --voltar) e
# testado em tests/cli/atualizar.sh. Raiz falsa, sem git e sem rede.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
BACKUPS="$DGCLAW_RAIZ/var/backups/dgclaw"
AUD="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"

# at <funcao> [args]: carrega a CLI como o bin/dgclaw faz (comum, agentes, atualizar, protecoes e enterprise).
at() {
    bash -c 'set -euo pipefail
        REPO="$1"; shift; APP_DIR="$REPO"; ATU_REPO=""; ATU_MODO=atualizar; exigir_ferramentas() { :; }
        . "$REPO/lib/comum.sh"; DG_CASAS="$DG_LIB/agentes"; . "$REPO/lib/agentes.sh"; . "$REPO/lib/atualizar.sh"; . "$REPO/lib/protecoes.sh"
        shopt -s nullglob
        for f in "$REPO"/lib/enterprise/*.sh; do . "$f"; done
        "$@"' _ "$REPO" "$@"
}

# Uma instalacao falsa com os arquivos que o backup precisa decidir se leva.
mkdir -p "$ETC/runner" "$LIB/web" "$LIB/backup" "$LIB/agentes/ana/home/memory" "$LIB/agentes/ana/cofre" "$DGCLAW_RAIZ/opt/dgclaw/admin"
printf 'DGCLAW_USUARIO=maria\n' >>"$ETC/dgclaw.env"
echo '{"versao":1,"agentes":[{"slug":"ana","nome":"Ana","tipo":"agente"}]}' >"$ETC/agentes.json"
echo "USUARIO=maria" >"$ETC/web.env"
echo "token" >"$ETC/runner/ana.token"
echo "chave-do-disco" >"$ETC/disco.chave"
echo "RESTIC_PASSWORD=segredo" >"$ETC/backup.env"
echo "conversa do painel" >"$LIB/web/sessoes.json"
echo "memoria da ana" >"$LIB/agentes/ana/home/memory/nota.md"
echo "estado" >"$LIB/backup/ultimo-backup.json"
echo "# Admin" >"$DGCLAW_RAIZ/opt/dgclaw/admin/CLAUDE.md"
chmod 600 "$ETC"/*

lista() { tar -tzf "$1" | LC_ALL=C sort; }

echo "atualizar: nivel pessoal, o backup e o do main"
at atualizar_backup "$BACKUPS/pessoal" atualizar 0 >"$TMP/o.txt" 2>&1
igual "pessoal: o backup sai com 0" 0 "$?"
afirma "pessoal: leva a chave do disco" bash -c "tar -tzf '$BACKUPS/pessoal/config.tar.gz' | grep -q 'etc/dgclaw/disco.chave'"
afirma "pessoal: leva as conversas do painel" bash -c "tar -tzf '$BACKUPS/pessoal/dados.tar.gz' | grep -q 'web/sessoes.json'"
afirma "pessoal: leva a casa do agente" bash -c "tar -tzf '$BACKUPS/pessoal/dados.tar.gz' | grep -q 'home/memory/nota.md'"
afirma "pessoal: o manifesto diz que as casas entraram" grep -qx 'casas_dos_agentes_no_backup=sim' "$BACKUPS/pessoal/MANIFESTO.txt"
nega "pessoal: nao cria arquivo de auditoria" test -e "$AUD"
at ent_antes_de_atualizar_auditoria atualizar >/dev/null 2>&1
at ent_depois_de_atualizar_auditoria atualizar ok v1 v2 "" >/dev/null 2>&1
nega "pessoal: os ganchos de auditoria nao gravam nada" test -e "$AUD"

echo "atualizar: nivel escritorio, o backup sai sem segredos e sem conversas"
nivel_na_raiz escritorio
at atualizar_backup "$BACKUPS/escritorio" atualizar 0 >"$TMP/o.txt" 2>&1
igual "escritorio: o backup sai com 0" 0 "$?"
afirma "escritorio: diz o que ficou de fora" grep -q "sem os segredos do enterprise" "$TMP/o.txt"
nega "escritorio: com o backup externo configurado nao avisa" grep -q "backup externo ainda nao esta configurado" "$TMP/o.txt"
nega "escritorio: a chave do disco nao vai" bash -c "tar -tzf '$BACKUPS/escritorio/config.tar.gz' | grep -q 'disco.chave'"
nega "escritorio: o segredo do restic nao vai" bash -c "tar -tzf '$BACKUPS/escritorio/config.tar.gz' | grep -q 'backup.env'"
afirma "escritorio: o resto da configuracao vai (web.env, token, agentes.json)" bash -c "tar -tzf '$BACKUPS/escritorio/config.tar.gz' | grep -q 'etc/dgclaw/web.env' && tar -tzf '$BACKUPS/escritorio/config.tar.gz' | grep -q 'runner/ana.token' && tar -tzf '$BACKUPS/escritorio/config.tar.gz' | grep -q 'agentes.json'"
nega "escritorio: as conversas do painel nao vao" bash -c "tar -tzf '$BACKUPS/escritorio/dados.tar.gz' | grep -q 'web/sessoes.json'"
nega "escritorio: a casa do agente nao vai" bash -c "tar -tzf '$BACKUPS/escritorio/dados.tar.gz' | grep -q 'home/memory'"
nega "escritorio: o estado do backup externo nao vai" bash -c "tar -tzf '$BACKUPS/escritorio/dados.tar.gz' | grep -q 'ultimo-backup.json'"
afirma "escritorio: o manifesto diz que as casas ficaram de fora" grep -qx 'casas_dos_agentes_no_backup=nao' "$BACKUPS/escritorio/MANIFESTO.txt"
afirma "escritorio: o manifesto ainda confere a chave do disco (a conferencia final compara com o arquivo vivo)" grep -q 'etc/dgclaw/disco.chave' "$BACKUPS/escritorio/MANIFESTO.txt"
mv "$ETC/backup.env" "$TMP/backup.env.guardado"
at ent_preparar_backup_atualizar_protecao >"$TMP/o2.txt" 2>&1
afirma "escritorio: sem backup externo configurado, avisa que as casas ficam sem copia" grep -q "backup externo ainda nao esta configurado" "$TMP/o2.txt"
mv "$TMP/backup.env.guardado" "$ETC/backup.env"
igual "escritorio: a pasta do backup e 700" 700 "$(stat -c %a "$BACKUPS/escritorio")"

echo "atualizar: a auditoria registra inicio, sucesso, rollback e falha"
at ent_antes_de_atualizar_auditoria atualizar >/dev/null 2>&1
at ent_depois_de_atualizar_auditoria atualizar ok v1 v2 "" >/dev/null 2>&1
at ent_antes_de_atualizar_auditoria voltar >/dev/null 2>&1
at ent_depois_de_atualizar_auditoria voltar ok "" abc1234567 "" >/dev/null 2>&1
at ent_depois_de_atualizar_auditoria atualizar falha "" "" "rodando o instalador" >/dev/null 2>&1
igual "eventos na ordem" "atualizar.inicio atualizar.sucesso atualizar.inicio atualizar.rollback atualizar.falha" "$(jq -r .evento "$AUD" | paste -sd' ')"
igual "o sucesso leva de e para" "v1>v2" "$(jq -r 'select(.evento=="atualizar.sucesso") | .dados.de + ">" + .dados.para' "$AUD" 2>/dev/null || jq -r 'select(.evento=="atualizar.sucesso") | .de + ">" + .para' "$AUD")"
igual "a falha leva a etapa" "rodando o instalador" "$(jq -r 'select(.evento=="atualizar.falha") | (.dados.etapa // .etapa)' "$AUD")"
before="$(wc -l <"$AUD")"
ENSAIO=1 at ent_antes_de_atualizar_auditoria atualizar >/dev/null 2>&1
igual "simulacao nao audita" "$before" "$(wc -l <"$AUD")"

echo "atualizar: retencao dos backups (backup_retencao_dias = 30 no escritorio)"
rm -rf "$BACKUPS"; mkdir -p "$BACKUPS"
velho1="$(date -d '90 days ago' +%Y%m%d)-100000"; velho2="$(date -d '60 days ago' +%Y%m%d)-100000"
velho3="$(date -d '45 days ago' +%Y%m%d)-100000"; recente="$(date -d '2 days ago' +%Y%m%d)-100000"
hoje="$(date +%Y%m%d)-100000"
for d in "$velho1" "$velho2" "$velho3" "$recente" "$hoje" "nao-e-backup"; do mkdir -p "$BACKUPS/$d"; echo x >"$BACKUPS/$d/MANIFESTO.txt"; done
at ent_depois_de_atualizar_retencao voltar ok >/dev/null 2>&1
igual "voltar nao apaga nada" 6 "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
at ent_depois_de_atualizar_retencao atualizar incompleta >/dev/null 2>&1
igual "atualizacao incompleta nao apaga nada" 6 "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
at ent_depois_de_atualizar_retencao atualizar ok >"$TMP/o.txt" 2>&1
igual "apaga so os 3 mais velhos que o prazo" "nao-e-backup $hoje $recente" "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort -r | paste -sd' ')"
afirma "diz quantos apagou" grep -q "apaguei 3 pasta" "$TMP/o.txt"
afirma "audita a retencao" bash -c "jq -r .evento '$AUD' | tail -n 1 | grep -qx atualizar.retencao"
# Mesmo com prazo curto, as duas mais novas ficam (e delas que o --voltar precisa).
nivel_na_raiz escritorio '{"backup_retencao_dias":1}'
rm -rf "$BACKUPS"; mkdir -p "$BACKUPS/$velho1" "$BACKUPS/$velho2"
at ent_depois_de_atualizar_retencao atualizar ok >/dev/null 2>&1
igual "as duas mais novas ficam sempre" 2 "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
nivel_na_raiz pessoal
rm -rf "$BACKUPS"; mkdir -p "$BACKUPS/$velho1" "$BACKUPS/$velho2" "$BACKUPS/$velho3"
at ent_depois_de_atualizar_retencao atualizar ok >/dev/null 2>&1
igual "pessoal: a retencao nao apaga nada" 3 "$(find "$BACKUPS" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"

echo "atualizar: o reinicio do Admin usa as unidades certas"
mkdir -p "$DGCLAW_RAIZ/etc/systemd/system"
: >"$DGCLAW_RAIZ/etc/systemd/system/dgclaw-admin.service"; : >"$DGCLAW_RAIZ/etc/systemd/system/dgclaw-controle.service"
echo resumo >"$TMP/resumo.txt"
: >"$STUB_LOG"
at atualizar_agendar_reinicio_do_admin "$TMP/resumo.txt" "$TMP/log.txt" >/dev/null 2>&1
afirma "pessoal: reinicia o dgclaw-admin, como o main" grep -q "DGCLAW_UNIDADES_ADMIN=dgclaw-admin " "$STUB_LOG"
nivel_na_raiz empresa '{"admin_llm":false}'
: >"$STUB_LOG"
at atualizar_agendar_reinicio_do_admin "$TMP/resumo.txt" "$TMP/log.txt" >/dev/null 2>&1
afirma "Admin desligado com controle: reinicia so o dgclaw-controle" grep -q "DGCLAW_UNIDADES_ADMIN=dgclaw-controle " "$STUB_LOG"
afirma "Admin desligado: o roteiro nao tenta mandar o resumo ao Admin" grep -q "DGCLAW_SEM_AVISO_ADMIN=1" "$STUB_LOG"
nivel_na_raiz pessoal

echo "atualizar: o comando e o do main, sem comando duplicado no enterprise"
nega "nao existe mais ent_cmd_atualizar" bash -c "grep -rq 'ent_cmd_atualizar' '$REPO/lib'"
afirma "a CLI chama atualizar_main antes do despacho enterprise" bash -c "grep -n 'atualizar) atualizar_main' '$REPO/bin/dgclaw'"

fim
