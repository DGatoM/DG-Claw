#!/usr/bin/env bash
# Bloco D, disco cifrado: cifrar (copia, conferencia, troca), abrir no boot, falhas, instalador. cryptsetup, mount e rsync de mentira.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"

novo() { # novo <nivel>: raiz nova, stubs, mapper e arquivo do volume dentro da raiz falsa
    preparar; stubs_d
    export DGCLAW_DISCO_MAPPER="$TMP/mapper/dgclaw-dados"
    app_copia
    nivel_na_raiz "$1"
    AGENTES="$LIB/agentes"; LUKS="$DGCLAW_RAIZ/var/lib/dgclaw-cofre/dados.luks"; CHAVE="$ETC/disco.chave"
    VELHO="$AGENTES.antes-de-cifrar"
}

echo "disco: nivel pessoal recusa"
novo pessoal
mkdir -p "$AGENTES/ana"; echo dado >"$AGENTES/ana/arquivo.txt"
nega "cifrar recusa quando a protecao esta desligada" "$CLI_COPIA" disco cifrar
"$CLI_COPIA" disco cifrar >"$TMP/o.txt" 2>&1
afirma "a mensagem diz como ligar" grep -q "dgclaw nivel" "$TMP/o.txt"
afirma "nada foi criado" bash -c "[ ! -e '$LUKS' ] && [ ! -e '$CHAVE' ] && [ ! -L '$AGENTES' ]"
"$CLI_COPIA" disco status >"$TMP/o.txt" 2>&1
afirma "status funciona e fala a verdade" grep -q "protecao = nao" "$TMP/o.txt"

echo "disco: cifrar no escritorio, com um agente ligado"
novo escritorio
"$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >/dev/null 2>&1
echo "conteudo da memoria" >"$AGENTES/ana/home/memory/nota.txt"
: >"$STUB_LOG"
"$CLI_COPIA" disco cifrar --tamanho 64M >"$TMP/o.txt" 2>&1
igual "cifrar termina bem" 0 "$?"
afirma "o volume existe e e esparso" test -f "$LUKS"
afirma "a chave tem 64 bytes e modo 400" bash -c "[ \"\$(stat -c %s '$CHAVE')\" = 64 ] && [ \"\$(stat -c %a '$CHAVE')\" = 400 ]"
afirma "luksFormat luks2, com chave por arquivo" grep -q "^cryptsetup luksFormat --type luks2 --batch-mode --key-file $CHAVE " "$STUB_LOG"
afirma "a chave nunca aparece em argv (so o caminho)" bash -c "! grep -q \"\$(head -c 64 '$CHAVE' | base64 -w0 | head -c 20)\" '$STUB_LOG'"
afirma "o rsync preservou donos (-aHAX --numeric-ids)" grep -q "^rsync -aHAX --numeric-ids $AGENTES/ " "$STUB_LOG"
afirma "montou em cima do mesmo caminho" test -L "$AGENTES"
afirma "os dados estao no volume" test -f "$AGENTES/ana/home/memory/nota.txt"
afirma "a copia antiga foi guardada, nao apagada" test -f "$VELHO/ana/home/memory/nota.txt"
afirma "parou o agente antes da copia e religou depois" bash -c "grep -n '^podman stop dgclaw-ana' '$STUB_LOG' | head -1 | cut -d: -f1 > '$TMP/n1'; grep -n '^podman start dgclaw-ana' '$STUB_LOG' | tail -1 | cut -d: -f1 > '$TMP/n2'; [ -s '$TMP/n1' ] && [ \"\$(cat '$TMP/n2')\" -gt \"\$(cat '$TMP/n1')\" ]"
afirma "unidade de boot instalada" test -f "$DGCLAW_RAIZ/etc/systemd/system/dgclaw-disco.service"
afirma "a unidade vem antes de web, admin, firewall, cofre e containers" bash -c "grep -q 'Before=dgclaw-web.service dgclaw-admin.service dgclaw-firewall.service dgclaw-cofre.service podman.service' '$DGCLAW_RAIZ/etc/systemd/system/dgclaw-disco.service'"
afirma "unidade habilitada" grep -q "^systemctl enable dgclaw-disco.service" "$STUB_LOG"
afirma "avisa com honestidade que nao protege contra root" grep -q "NAO protege contra quem tem root" "$TMP/o.txt"
afirma "pede para apagar a copia antiga depois de conferir" grep -q "apague a copia antiga" "$TMP/o.txt"
afirma "auditado" bash -c "jq -e 'select(.evento == \"disco.cifrar\" and .dados.tamanho == \"64M\")' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl'"
nega "cifrar de novo recusa (ja montado)" "$CLI_COPIA" disco cifrar --tamanho 64M
"$CLI_COPIA" disco status >"$TMP/o.txt" 2>&1
afirma "status: aberto e montado" bash -c "grep -q 'aberto: sim' '$TMP/o.txt' && grep -q 'montado em' '$TMP/o.txt' && grep -q 'montado em.*: sim' '$TMP/o.txt'"
afirma "status repete a honestidade" grep -q "Ele protege contra snapshot" "$TMP/o.txt"

echo "disco: abrir depois de um reboot"
rm "$AGENTES" && mkdir "$AGENTES"; rm -rf "$DGCLAW_DISCO_MAPPER.bak"
mv "$DGCLAW_DISCO_MAPPER" "$DGCLAW_DISCO_MAPPER.bak"   # a "pasta do dispositivo" some quando a maquina desliga
"$CLI_COPIA" disco abrir >"$TMP/o.txt" 2>&1
igual "abrir termina bem" 0 "$?"
afirma "reabriu com a chave do arquivo" grep -q "^cryptsetup open --type luks2 --key-file $CHAVE $LUKS dgclaw-dados" "$STUB_LOG"
afirma "montou de novo" test -L "$AGENTES"
"$CLI_COPIA" disco abrir >"$TMP/o.txt" 2>&1
igual "abrir de novo e inofensivo" 0 "$?"
afirma "diz que ja estava montado" grep -q "ja esta montado" "$TMP/o.txt"
echo "disco: chave perdida"
mv "$CHAVE" "$TMP/chave.guardada"
rm "$AGENTES" && mkdir "$AGENTES"
mv "$DGCLAW_DISCO_MAPPER" "$DGCLAW_DISCO_MAPPER.bak2"
"$CLI_COPIA" disco abrir >"$TMP/o.txt" 2>&1
igual "sem a chave, abrir falha" 1 "$?"
afirma "diz onde esta a chave que falta e como restaurar" grep -q "restaure o arquivo do backup" "$TMP/o.txt"

echo "disco: copia que nao bate nao troca nada"
novo escritorio
mkdir -p "$AGENTES/ana"; echo um >"$AGENTES/ana/a.txt"; echo dois >"$AGENTES/ana/b.txt"
STUB_RSYNC_CORROMPE=1 "$CLI_COPIA" disco cifrar --tamanho 64M >"$TMP/o.txt" 2>&1
igual "falha" 1 "$?"
afirma "a conferencia por checksum pegou" grep -q "conferencia por checksum" "$TMP/o.txt"
afirma "a pasta original ficou onde estava, inteira" bash -c "[ ! -L '$AGENTES' ] && [ \"\$(cat '$AGENTES/ana/a.txt')\" = um ] && [ ! -e '$VELHO' ]"
afirma "o volume e a chave recem-criados foram desfeitos" bash -c "[ ! -e '$LUKS' ] && [ ! -e '$CHAVE' ]"
afirma "a mensagem diz que nada foi mudado" grep -q "Nada foi mudado nos dados" "$TMP/o.txt"
echo "disco: chave solta sem volume nao e sobrescrita"
mkdir -p "$ETC"; head -c 64 /dev/urandom >"$CHAVE"
nega "cifrar recusa" "$CLI_COPIA" disco cifrar --tamanho 64M
afirma "a chave antiga continua" test -s "$CHAVE"
rm -f "$CHAVE"
echo "disco: tamanho invalido e modo externo"
nega "tamanho sem unidade" "$CLI_COPIA" disco cifrar --tamanho 40
nega "tamanho com lixo" "$CLI_COPIA" disco cifrar --tamanho '40G;rm'
nivel_na_raiz regulado
"$CLI_COPIA" disco cifrar --tamanho 64M >"$TMP/o.txt" 2>&1
afirma "regulado (externo): cifra com a chave local transitoria e manda trocar por uma externa" grep -q "dgclaw disco chave externa" "$TMP/o.txt"

echo "disco: instalador"
novo escritorio
mkdir -p "$AGENTES/ana"
lib_d ent_instalar_disco >"$TMP/o.txt" 2>&1
afirma "maquina com agentes: so avisa" grep -q "nunca faco isso sozinho" "$TMP/o.txt"
afirma "e nao cifrou" test ! -e "$LUKS"
novo escritorio
DGCLAW_DISCO_LIVRE_M=20480 lib_d ent_instalar_disco >"$TMP/o.txt" 2>&1
afirma "maquina nova: cifra direto, com 70% de 20G (14G)" grep -q "criando o disco cifrado de 14G" "$TMP/o.txt"
afirma "maquina nova: o volume existe" test -f "$LUKS"
afirma "e monta" test -L "$AGENTES"
novo pessoal
lib_d ent_instalar_disco >"$TMP/o.txt" 2>&1
afirma "pessoal: nada" test ! -e "$LUKS"

fim
