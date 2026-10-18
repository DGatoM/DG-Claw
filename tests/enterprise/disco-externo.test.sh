#!/usr/bin/env bash
# Bloco J, chave do disco fora da VPS: Tang (Clevis) e frase manual, na ORDEM SEGURA (adiciona, testa, so entao remove),
# desbloqueio no boot, dados trancados. cryptsetup (varios slots), clevis, shred e mount de mentira.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-j.sh
. "$(dirname "$0")/_bloco-j.sh"

PATH_ORIG="$PATH"
URL="http://tang.exemplo.org:7500"
THP="thumbprintdotangdotangdotang1"
FRASE="uma frase bem longa que so o TI sabe"

novo() { # novo <nivel>: raiz nova, volume cifrado criado com a chave local transitoria
    PATH="$PATH_ORIG"
    preparar; stubs_j ""
    nivel_na_raiz "$1"
    app_copia
    AGENTES="$LIB/agentes"; LUKS="$DGCLAW_RAIZ/var/lib/dgclaw-cofre/dados.luks"; CHAVE="$ETC/disco.chave"
    LOGA="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"; RAM="$DGCLAW_RAIZ/run/dgclaw/disco"
    mkdir -p "$AGENTES/ana"; echo dado >"$AGENTES/ana/a.txt"
    "$CLI_COPIA" disco cifrar --tamanho 64M >"$TMP/cifrar.txt" 2>&1
}
linha_de() { grep -n "$1" "$STUB_LOG" | head -n 1 | cut -d: -f1; }
ultima_de() { grep -n "$1" "$STUB_LOG" | tail -n 1 | cut -d: -f1; }
reboot() { # simula o reinicio: o volume fecha e a pasta dos agentes volta a ser comum
    mv "$DGCLAW_DISCO_MAPPER" "$DGCLAW_DISCO_MAPPER.fechado"; rm -f "$AGENTES"; mkdir -p "$AGENTES"
}

echo "externo: cifrar no regulado usa a chave local so de passagem"
novo regulado
igual "cifrar termina bem" 0 "$(grep -c 'Nao deu certo' "$TMP/cifrar.txt")"
afirma "o volume existe e a pasta dos agentes esta montada" bash -c "[ -f '$LUKS' ] && [ -L '$AGENTES' ]"
afirma "a chave local existe" test -s "$CHAVE"
afirma "o aviso manda trocar por uma chave externa" grep -q "dgclaw disco chave externa tang" "$TMP/cifrar.txt"
"$CLI_COPIA" disco chave status >"$TMP/o.txt" 2>&1
afirma "status: nenhum metodo e a chave local ainda existe" bash -c "grep -q 'metodo: nenhum' '$TMP/o.txt' && grep -q 'AINDA EXISTE' '$TMP/o.txt'"
"$CLI_COPIA" status >"$TMP/o.txt" 2>&1
afirma "dgclaw status avisa que a chave ainda e local" grep -q "a chave ainda e a local" "$TMP/o.txt"

echo "externo: tang exige o thumbprint confirmado"
: >"$STUB_LOG"
"$CLI_COPIA" disco chave externa tang "$URL" >"$TMP/o.txt" 2>&1
igual "sem --thp recusa" 1 "$?"
afirma "mostra o thumbprint que o servidor anunciou" grep -q "$THP" "$TMP/o.txt"
afirma "manda comparar com o tang-show-keys" grep -q "tang-show-keys" "$TMP/o.txt"
afirma "nada foi ligado ao volume" bash -c "! grep -q 'clevis luks bind' '$STUB_LOG' && [ \$(wc -l <'$LUKS.slots') = 1 ]"
"$CLI_COPIA" disco chave externa tang "$URL" --thp errado123456789012345678901 >"$TMP/o.txt" 2>&1
igual "thumbprint que nao e o do servidor: recusa" 1 "$?"
afirma "o volume continua so com a chave local" bash -c "[ \$(wc -l <'$LUKS.slots') = 1 ] && [ -s '$CHAVE' ]"
nega "thumbprint com formato invalido" "$CLI_COPIA" disco chave externa tang "$URL" --thp 'a;b'
nega "url invalida" "$CLI_COPIA" disco chave externa tang 'ftp://x' --thp "$THP"
nega "url com lixo" "$CLI_COPIA" disco chave externa tang 'http://x;rm -rf' --thp "$THP"
nega "sem url" "$CLI_COPIA" disco chave externa tang
nega "metodo desconhecido" "$CLI_COPIA" disco chave externa nuvem
STUB_TANG_OFFLINE=1 "$CLI_COPIA" disco chave externa tang "$URL" >"$TMP/o.txt" 2>&1
afirma "Tang fora do ar sem --thp: diz que nao leu o anuncio" grep -q "nao consegui ler o anuncio do Tang" "$TMP/o.txt"

echo "externo: tang com o thumbprint certo adiciona e testa, sem remover"
: >"$STUB_LOG"
"$CLI_COPIA" disco chave externa tang "$URL" --thp "$THP" >"$TMP/o.txt" 2>&1
igual "termina bem" 0 "$?"
afirma "o bind autoriza com o ARQUIVO da chave local (nunca argv) e leva o thp na configuracao" grep -q "^clevis luks bind -f -d $LUKS -k $CHAVE tang {\"url\":\"$URL\",\"thp\":\"$THP\"}" "$STUB_LOG"
afirma "o volume agora tem 2 slots" bash -c "[ \$(wc -l <'$LUKS.slots') = 2 ]"
afirma "testou com o Tang (clevis luks pass) e o cryptsetup --test-passphrase" bash -c "grep -q '^clevis luks pass -d $LUKS -s 1' '$STUB_LOG' && grep -q '^cryptsetup open --test-passphrase --key-file - $LUKS' '$STUB_LOG'"
afirma "o teste veio DEPOIS do bind" bash -c "[ \$(grep -n 'cryptsetup open --test-passphrase' '$STUB_LOG' | head -1 | cut -d: -f1) -gt \$(grep -n 'clevis luks bind' '$STUB_LOG' | head -1 | cut -d: -f1) ]"
afirma "NAO removeu a chave local" bash -c "! grep -q 'luksRemoveKey' '$STUB_LOG' && ! grep -q '^shred' '$STUB_LOG' && [ -s '$CHAVE' ]"
afirma "explica o que o --confirmar faz" grep -q "o unico passo que nao se desfaz" "$TMP/o.txt"
afirma "estado gravado (tang, url, slot) com modo 600" bash -c "jq -e '.metodo == \"tang\" and .url == \"$URL\" and .slot == 1' '$ETC/disco-externo.json' && [ \$(stat -c %a '$ETC/disco-externo.json') = 600 ]"
igual "a protecao e externo (padrao do regulado, sem ajuste)" externo "$(lib protecao_valor disco_cifrado)"
afirma "a unidade de boot usa abrir --boot" grep -q "ExecStart=/usr/local/bin/dgclaw disco abrir --boot" "$DGCLAW_RAIZ/etc/systemd/system/dgclaw-disco.service"
afirma "drop-in impede os containers de subirem sem o volume" grep -q "ConditionPathIsMountPoint=$AGENTES" "$DGCLAW_RAIZ/etc/systemd/system/podman-restart.service.d/30-dgclaw-disco.conf"
afirma "auditado como chave_local_removida=false" jq -e 'select(.evento == "disco.chave_externa" and .dados.metodo == "tang" and .dados.chave_local_removida == false)' "$LOGA"
afirma "nada de chave nem de senha no log do stub" bash -c "! grep -q 'TANG-SECRET' '$STUB_LOG'"

echo "externo: --confirmar so remove depois de testar, e se o Tang falha nao remove nada"
: >"$STUB_LOG"
STUB_TANG_OFFLINE=1 "$CLI_COPIA" disco chave externa tang "$URL" --thp "$THP" --confirmar >"$TMP/o.txt" 2>&1
igual "Tang fora do ar: recusa remover" 1 "$?"
afirma "a chave local continua e nada foi removido" bash -c "[ -s '$CHAVE' ] && ! grep -q 'luksRemoveKey' '$STUB_LOG' && ! grep -q '^shred' '$STUB_LOG' && [ \$(wc -l <'$LUKS.slots') = 2 ]"
: >"$STUB_LOG"
"$CLI_COPIA" disco chave externa tang "$URL" --thp "$THP" --confirmar >"$TMP/o.txt" 2>&1
igual "com o Tang no ar, remove" 0 "$?"
afirma "nao fez um segundo bind (reaproveitou o slot)" bash -c "! grep -q 'clevis luks bind' '$STUB_LOG'"
afirma "removeu a chave local do slot (luksRemoveKey com o arquivo dela)" grep -q "^cryptsetup luksRemoveKey --batch-mode $LUKS $CHAVE" "$STUB_LOG"
afirma "o teste do Tang veio ANTES do luksRemoveKey" bash -c "[ \$(grep -n 'clevis luks pass' '$STUB_LOG' | head -1 | cut -d: -f1) -lt \$(grep -n 'luksRemoveKey' '$STUB_LOG' | cut -d: -f1) ]"
afirma "e o Tang ainda abre depois" bash -c "[ \$(grep -n 'clevis luks pass' '$STUB_LOG' | tail -1 | cut -d: -f1) -gt \$(grep -n 'luksRemoveKey' '$STUB_LOG' | cut -d: -f1) ]"
afirma "o arquivo foi apagado com shred" grep -q "^shred -u $CHAVE" "$STUB_LOG"
afirma "a chave local nao existe mais e sobrou o slot do Tang" bash -c "[ ! -e '$CHAVE' ] && [ \$(wc -l <'$LUKS.slots') = 1 ]"
afirma "auditado como chave_local_removida=true" jq -e 'select(.evento == "disco.chave_externa" and .dados.chave_local_removida == true)' "$LOGA"
"$CLI_COPIA" disco chave status >"$TMP/o.txt" 2>&1
afirma "status: metodo Tang e chave local removida" bash -c "grep -q 'metodo: Tang' '$TMP/o.txt' && grep -q 'removida' '$TMP/o.txt'"

echo "externo: depois de um reinicio o Clevis abre sozinho (unidade de boot)"
reboot
: >"$STUB_LOG"
"$CLI_COPIA" disco abrir --boot >"$TMP/o.txt" 2>&1
igual "abrir --boot termina bem" 0 "$?"
afirma "abriu com clevis luks unlock, nao com cryptsetup open" bash -c "grep -q '^clevis luks unlock -d $LUKS -n dgclaw-dados' '$STUB_LOG' && ! grep -q '^cryptsetup open' '$STUB_LOG'"
afirma "a pasta dos agentes esta montada" test -L "$AGENTES"
echo "externo: sem rede para o Tang a VPS sobe sem os dados e avisa"
reboot
STUB_TANG_OFFLINE=1 "$CLI_COPIA" disco abrir --boot >"$TMP/o.txt" 2>&1
igual "--boot nao derruba o boot (sai com 0)" 0 "$?"
afirma "avisa que os dados estao trancados" grep -q "DADOS TRANCADOS" "$TMP/o.txt"
afirma "a pasta dos agentes NAO foi montada" test ! -L "$AGENTES"
afirma "auditado como disco.trancado" jq -e 'select(.evento == "disco.trancado")' "$LOGA"
STUB_TANG_OFFLINE=1 nega "abrir sem --boot falha de verdade" "$CLI_COPIA" disco abrir
"$CLI_COPIA" status >"$TMP/o.txt" 2>&1
afirma "dgclaw status mostra DADOS TRANCADOS" grep -q "DADOS TRANCADOS" "$TMP/o.txt"
afirma "o monitor registra o problema disco-trancado" bash -c "cd '$REPO' && DGCLAW_RAIZ='$DGCLAW_RAIZ' PATH='$PATH' bash -c 'set -euo pipefail; REPO=\"$REPO\"; APP_DIR=\"\$REPO\"; . \"\$REPO/lib/comum.sh\"; . \"\$REPO/lib/agentes.sh\"; . \"\$REPO/lib/protecoes.sh\"; for f in \"\$REPO\"/lib/enterprise/*.sh; do . \"\$f\"; done; _mon_checar_disco_trancado; printf \"%s\n\" \"\${MON_PROBLEMAS[@]}\"' | grep -q '^disco-trancado'"
"$CLI_COPIA" disco desbloquear >"$TMP/o.txt" 2>&1
igual "desbloquear com o Tang de volta abre" 0 "$?"
afirma "montou" test -L "$AGENTES"
afirma "pediu para religar os containers" grep -q "systemctl start --no-block podman-restart.service" "$STUB_LOG"

echo "externo: frase manual"
novo regulado
: >"$STUB_LOG"
printf '%s\n%s\n' "$FRASE" "outra frase diferente aqui no fim" | "$CLI_COPIA" disco chave externa manual >"$TMP/o.txt" 2>&1
igual "duas frases diferentes: recusa" 1 "$?"
afirma "nada foi adicionado" bash -c "! grep -q 'luksAddKey' '$STUB_LOG' && [ \$(wc -l <'$LUKS.slots') = 1 ]"
printf '%s\n%s\n' "curta" "curta" | "$CLI_COPIA" disco chave externa manual >"$TMP/o.txt" 2>&1
igual "frase curta: recusa" 1 "$?"
afirma "diz o minimo de 20 caracteres" grep -q "menos de 20 caracteres" "$TMP/o.txt"
: >"$STUB_LOG"
printf '%s\n%s\n' "$FRASE" "$FRASE" | "$CLI_COPIA" disco chave externa manual >"$TMP/o.txt" 2>&1
igual "frase boa: adiciona e testa" 0 "$?"
afirma "luksAddKey autorizado pelo ARQUIVO da chave local" grep -q "^cryptsetup luksAddKey --key-file $CHAVE $LUKS $RAM/frase-nova" "$STUB_LOG"
afirma "o teste (--test-passphrase) veio depois da adicao" bash -c "[ \$(grep -n 'luksAddKey' '$STUB_LOG' | head -1 | cut -d: -f1) -lt \$(grep -n 'open --test-passphrase --key-file $RAM/frase-nova' '$STUB_LOG' | tail -1 | cut -d: -f1) ]"
afirma "a frase nunca aparece no log, na saida nem em argv" bash -c "! grep -q 'uma frase bem longa' '$STUB_LOG' '$TMP/o.txt'"
afirma "o arquivo temporario foi apagado com shred" bash -c "grep -q '^shred -u $RAM/frase-nova' '$STUB_LOG' && [ ! -e '$RAM/frase-nova' ]"
afirma "a chave local continua (sem --confirmar)" bash -c "[ -s '$CHAVE' ] && ! grep -q 'luksRemoveKey' '$STUB_LOG'"
printf '%s\n%s\n' "$FRASE" "$FRASE" | "$CLI_COPIA" disco chave externa manual --confirmar >"$TMP/o.txt" 2>&1
igual "--confirmar com a mesma frase remove a chave local" 0 "$?"
afirma "nao adicionou a frase de novo (so 2 slots no total foram criados)" bash -c "[ \$(grep -c 'luksAddKey' '$STUB_LOG') = 1 ]"
afirma "luksRemoveKey e shred da chave local" bash -c "grep -q '^cryptsetup luksRemoveKey --batch-mode $LUKS $CHAVE' '$STUB_LOG' && grep -q '^shred -u $CHAVE' '$STUB_LOG' && [ ! -e '$CHAVE' ]"
afirma "estado manual gravado" jq -e '.metodo == "manual"' "$ETC/disco-externo.json"

echo "externo: depois do reinicio o volume fica trancado ate o TI digitar a frase"
reboot
: >"$STUB_LOG"
"$CLI_COPIA" disco abrir --boot >"$TMP/o.txt" 2>&1
igual "--boot nao derruba o boot" 0 "$?"
afirma "diz que e preciso desbloquear" grep -q "dgclaw disco desbloquear" "$TMP/o.txt"
afirma "nao montou" test ! -L "$AGENTES"
nega "abrir comum recusa" "$CLI_COPIA" disco abrir
echo "uma frase errada de proposito" | "$CLI_COPIA" disco desbloquear >"$TMP/o.txt" 2>&1
igual "frase errada: falha" 1 "$?"
afirma "continua trancado e nao sobrou chave em RAM" bash -c "[ ! -L '$AGENTES' ] && [ ! -e '$RAM/disco.chave' ]"
echo "$FRASE" | "$CLI_COPIA" disco desbloquear >"$TMP/o.txt" 2>&1
igual "frase certa: desbloqueia" 0 "$?"
afirma "montou a pasta dos agentes e os dados estao la" bash -c "[ -L '$AGENTES' ] && [ -f '$AGENTES/ana/a.txt' ]"
afirma "a chave em RAM foi apagada com shred" bash -c "grep -q '^shred -u $RAM/disco.chave' '$STUB_LOG' && [ ! -e '$RAM/disco.chave' ]"
afirma "pediu para religar os containers" grep -q "systemctl start --no-block podman-restart.service" "$STUB_LOG"
afirma "auditado" jq -e 'select(.evento == "disco.desbloquear" and .dados.metodo == "manual")' "$LOGA"
afirma "a frase nunca apareceu no log nem na saida" bash -c "! grep -q 'uma frase bem longa' '$STUB_LOG' '$TMP/o.txt'"
echo "$FRASE" | "$CLI_COPIA" disco desbloquear >"$TMP/o.txt" 2>&1
afirma "desbloquear de novo e inofensivo" grep -q "nada a desbloquear" "$TMP/o.txt"

echo "externo: outros niveis"
novo escritorio
nega "desbloquear no modo auto recusa" "$CLI_COPIA" disco desbloquear
"$CLI_COPIA" disco desbloquear >"$TMP/o.txt" 2>&1
afirma "a mensagem diz que o auto abre sozinho" grep -q "abre sozinho no boot" "$TMP/o.txt"
afirma "no auto a unidade de boot continua sem --boot" bash -c "grep -q 'ExecStart=/usr/local/bin/dgclaw disco abrir$' '$DGCLAW_RAIZ/etc/systemd/system/dgclaw-disco.service'"
novo pessoal
nega "pessoal: chave externa recusa (disco_cifrado desligado)" "$CLI_COPIA" disco chave externa manual
"$CLI_COPIA" disco status >"$TMP/o.txt" 2>&1
afirma "pessoal: disco status continua o de antes" grep -q "protecao = nao" "$TMP/o.txt"

echo "externo: ensaio nao muda nada"
novo regulado
: >"$STUB_LOG"
"$CLI_COPIA" --ensaio disco chave externa tang "$URL" --thp "$THP" --confirmar >"$TMP/o.txt" 2>&1
igual "ensaio termina bem" 0 "$?"
afirma "e nao chamou clevis nem removeu nada" bash -c "! grep -q '^clevis' '$STUB_LOG' && ! grep -q 'luksRemoveKey' '$STUB_LOG' && [ -s '$CHAVE' ]"

fim
