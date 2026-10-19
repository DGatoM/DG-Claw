#!/usr/bin/env bash
# Bloco J, runtime reforcado (gVisor): instalacao, gancho do podman create, prova com queda para runc, testar-runtime e status.
# runsc, gpg, apt-get e podman de mentira: nada de sistema roda de verdade.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-j.sh
. "$(dirname "$0")/_bloco-j.sh"

PATH_ORIG="$PATH"
novo() { # novo <nivel> [sem-runsc]
    PATH="$PATH_ORIG"   # cada preparar empilha stubs de novo; sem isto o runsc de um teste vaza para o seguinte
    preparar; stubs_j "${2:-}"
    nivel_na_raiz "$1"
    app_copia
    LOGA="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"
}
create_do() { grep "^podman create .*--name dgclaw-$1 " "$STUB_LOG" | head -n 1; }

echo "gvisor: nivel pessoal nao muda nada"
novo pessoal
"$CLI_COPIA" agente criar ana --nome "Ana" >"$TMP/o.txt" 2>&1
igual "pessoal: agente criou" 0 "$?"
afirma "pessoal: sem --runtime no podman create" bash -c "! grep -q -- '--runtime' '$STUB_LOG'"
afirma "pessoal: nenhum container de prova" bash -c "! grep -q 'dgclaw-prova-runtime' '$STUB_LOG'"
afirma "pessoal: nenhum estado de prova gravado" test ! -e "$LIB/runtime-prova.json"
nega "pessoal: testar-runtime recusa" "$CLI_COPIA" agente testar-runtime ana
"$CLI_COPIA" agente testar-runtime ana >"$TMP/o.txt" 2>&1
afirma "pessoal: a mensagem diz que e do regulado" grep -q "nivel regulado" "$TMP/o.txt"

echo "gvisor: regulado com a prova passando"
novo regulado
"$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >"$TMP/o.txt" 2>&1
igual "regulado: agente criou" 0 "$?"
linha="$(create_do ana)"
afirma "o podman create leva --runtime runsc" bash -c "[[ '$linha' == *'--runtime runsc'* ]]"
afirma "e o cap-drop=ALL" bash -c "[[ '$linha' == *'--cap-drop=ALL'* ]]"
afirma "e o no-new-privileges" bash -c "[[ '$linha' == *'--security-opt no-new-privileges'* ]]"
afirma "e continua com --systemd always" bash -c "[[ '$linha' == *'--systemd always'* ]]"
afirma "a imagem continua sendo o ultimo item" bash -c "[[ '$linha' == *' localhost/dgclaw-agente:latest' ]]"
afirma "a prova subiu um container sob o runsc" grep -q "^podman run -d --name dgclaw-prova-runtime --runtime runsc " "$STUB_LOG"
afirma "a prova usa as mesmas capacidades do agente" bash -c "grep '^podman run -d --name dgclaw-prova-runtime' '$STUB_LOG' | grep -q -- '--cap-drop=ALL'"
afirma "a prova conferiu o systemd" grep -q "podman exec dgclaw-prova-runtime systemctl is-system-running" "$STUB_LOG"
afirma "a prova conferiu o cron" grep -q "podman exec dgclaw-prova-runtime systemctl is-active --quiet cron" "$STUB_LOG"
afirma "a prova conferiu as portas 4300 e 8300 com o node" bash -c "grep 'podman exec dgclaw-prova-runtime node -e' '$STUB_LOG' | grep -q '4300' "
afirma "o container de prova foi apagado" grep -q "^podman rm -f dgclaw-prova-runtime" "$STUB_LOG"
afirma "a prova ficou guardada como ok, com a imagem e a versao do runsc" jq -e '.ok == true and .imagem == "sha256:imagem-de-teste" and (.runsc | test("release"))' "$LIB/runtime-prova.json"
afirma "nenhuma marca de queda" test ! -e "$ETC/runtime-sem-reforco/ana"
"$CLI_COPIA" agente criar bia --nome "Bia" --uso setor --auth api >/dev/null 2>&1
igual "o segundo agente nao repete a prova (so uma subida de container)" 1 "$(grep -c '^podman run -d --name dgclaw-prova-runtime' "$STUB_LOG")"
afirma "o segundo agente tambem leva --runtime runsc" bash -c "[[ \"\$(grep '^podman create .*--name dgclaw-bia ' '$STUB_LOG')\" == *'--runtime runsc'* ]]"
"$CLI_COPIA" agente testar-runtime ana >"$TMP/o.txt" 2>&1
igual "testar-runtime do agente sai com 0" 0 "$?"
afirma "diz que o container roda sob o runsc" grep -q "roda sob o runsc" "$TMP/o.txt"
igual "testar-runtime refaz a prova de verdade (agora 2 subidas)" 2 "$(grep -c '^podman run -d --name dgclaw-prova-runtime' "$STUB_LOG")"
afirma "testar-runtime foi auditado" jq -e 'select(.evento == "runtime.prova" and .dados.ok == true)' "$LOGA"
nega "testar-runtime de agente que nao existe" "$CLI_COPIA" agente testar-runtime zzz
echo exited >"$STUB_ESTADO/c-dgclaw-ana"; rm "$STUB_ESTADO/runtime-dgclaw-ana"; echo runc >"$STUB_ESTADO/runtime-dgclaw-ana"; echo running >"$STUB_ESTADO/c-dgclaw-ana"
nega "agente que esta em runc faz o testar-runtime falhar" "$CLI_COPIA" agente testar-runtime ana
"$CLI_COPIA" agente testar-runtime ana >"$TMP/o.txt" 2>&1
afirma "e diz como recriar" grep -q "dgclaw agente recriar ana --forcar" "$TMP/o.txt"

echo "gvisor: a prova falha (systemd nao sobe) e o agente cai para runc"
novo regulado
STUB_RT_FALHA=systemd "$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >"$TMP/o.txt" 2>&1
igual "o agente criou mesmo assim" 0 "$?"
linha="$(create_do ana)"
afirma "sem --runtime no create" bash -c "[[ '$linha' != *'--runtime'* ]]"
afirma "mas com o endurecimento do bloco D" bash -c "[[ '$linha' == *'--cap-drop=ALL'* ]]"
afirma "aviso alto: nasce sem o runtime reforcado" grep -q "SEM o runtime reforcado" "$TMP/o.txt"
afirma "o aviso diz que o systemd nao subiu" grep -q "systemd nao subiu como PID 1" "$TMP/o.txt"
afirma "marca de queda gravada" jq -e '.motivo | test("prova do gVisor")' "$ETC/runtime-sem-reforco/ana"
afirma "a prova falha ficou guardada" jq -e '.ok == false' "$LIB/runtime-prova.json"
afirma "queda registrada na auditoria" jq -e 'select(.evento == "runtime.queda" and .dados.slug == "ana" and .dados.runtime == "runc")' "$LOGA"
afirma "o container de prova foi apagado mesmo com a falha" grep -q "^podman rm -f dgclaw-prova-runtime" "$STUB_LOG"
"$CLI_COPIA" agente criar bia --nome "Bia" --uso setor --auth api >/dev/null 2>&1
igual "a falha fica guardada: o segundo agente nao repete a prova" 1 "$(grep -c '^podman run -d --name dgclaw-prova-runtime' "$STUB_LOG")"
"$CLI_COPIA" status >"$TMP/o.txt" 2>&1
afirma "dgclaw status lista o agente sem o runtime reforcado" grep -q "agente ana SEM o runtime reforcado" "$TMP/o.txt"
afirma "e o outro tambem" grep -q "agente bia SEM o runtime reforcado" "$TMP/o.txt"
STUB_RT_FALHA=systemd nega "testar-runtime continua falhando enquanto a prova falha" "$CLI_COPIA" agente testar-runtime ana
echo "gvisor: corrigido o defeito, testar-runtime passa e recriar volta ao runsc"
"$CLI_COPIA" agente testar-runtime ana >"$TMP/o.txt" 2>&1
afirma "agora a prova passa, mas o agente avisa que ainda esta em runc" grep -q "esta marcado como SEM o runtime reforcado" "$TMP/o.txt"
: >"$STUB_LOG"
"$CLI_COPIA" agente recriar ana --forcar >"$TMP/o.txt" 2>&1
igual "recriar termina" 0 "$?"
afirma "o novo create leva --runtime runsc" bash -c "grep '^podman create .*--name dgclaw-ana ' '$STUB_LOG' | grep -q -- '--runtime runsc'"
afirma "a marca de queda sumiu" test ! -e "$ETC/runtime-sem-reforco/ana"

echo "gvisor: cada defeito da prova e pego"
for defeito in cron node; do
    novo regulado
    STUB_RT_FALHA=$defeito "$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >"$TMP/o.txt" 2>&1
    afirma "defeito $defeito: cai para runc" bash -c "[[ \"\$(grep '^podman create .*--name dgclaw-ana ' '$STUB_LOG')\" != *'--runtime'* ]]"
done
afirma "defeito node: o aviso fala das portas do runner e do painel" grep -q "portas 4300 e 8300" "$TMP/o.txt"
novo regulado
STUB_RT_RUN_FALHA=1 "$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >"$TMP/o.txt" 2>&1
afirma "o podman recusar o runsc: cai para runc" bash -c "[[ \"\$(grep '^podman create .*--name dgclaw-ana ' '$STUB_LOG')\" != *'--runtime'* ]]"
afirma "e conta o que o podman disse" grep -q "nao conseguiu criar o container sob o runsc" "$TMP/o.txt"
novo regulado sem-runsc
"$CLI_COPIA" agente criar ana --nome "Ana" --uso setor --auth api >"$TMP/o.txt" 2>&1
igual "sem runsc instalado o agente nasce" 0 "$?"
afirma "sem runsc: cai para runc" bash -c "[[ \"\$(grep '^podman create .*--name dgclaw-ana ' '$STUB_LOG')\" != *'--runtime'* ]]"
afirma "diz que o runsc nao esta instalado" grep -q "runsc nao esta instalado" "$TMP/o.txt"
afirma "nenhum container de prova foi criado" bash -c "! grep -q '^podman run' '$STUB_LOG'"

echo "gvisor: instalador"
novo regulado sem-runsc
lib ent_instalar_gvisor >"$TMP/o.txt" 2>&1
igual "instalar termina bem" 0 "$?"
afirma "instala os pre-requisitos do apt" grep -q "^apt-get install -y --no-install-recommends apt-transport-https ca-certificates curl gnupg" "$STUB_LOG"
afirma "baixa a chave do endereco oficial" grep -q "gvisor.dev/archive.key" "$STUB_LOG"
afirma "confere o fingerprint (gpg --show-keys)" grep -q "^gpg --show-keys --with-colons" "$STUB_LOG"
afirma "converte a chave (gpg --dearmor)" grep -q "^gpg --dearmor --yes -o $DGCLAW_RAIZ/usr/share/keyrings/gvisor-archive-keyring.gpg" "$STUB_LOG"
afirma "o repositorio e assinado pelo chaveiro" grep -q "signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg\] https://storage.googleapis.com/gvisor/releases release main" "$DGCLAW_RAIZ/etc/apt/sources.list.d/gvisor.list"
afirma "apt-get update e install runsc" bash -c "grep -q '^apt-get update' '$STUB_LOG' && grep -q '^apt-get install -y runsc' '$STUB_LOG'"
afirma "o runtime runsc foi registrado no podman" grep -q '^runsc = \["' "$DGCLAW_RAIZ/etc/containers/containers.conf.d/dgclaw-runsc.conf"
afirma "a secao e [engine.runtimes]" grep -q '^\[engine.runtimes\]' "$DGCLAW_RAIZ/etc/containers/containers.conf.d/dgclaw-runsc.conf"
novo regulado sem-runsc
STUB_GPG_FPR=AAAA1111 lib ent_instalar_gvisor >"$TMP/o.txt" 2>&1
igual "fingerprint errado: para" 1 "$?"
afirma "diz o que recebeu e o que esperava" grep -q "AAAA1111.*6F1DF85E3A71C24918E727D56FC6D554E32BD943" "$TMP/o.txt"
afirma "nao instalou nem registrou nada" bash -c "! grep -q '^apt-get install -y runsc' '$STUB_LOG' && [ ! -e '$DGCLAW_RAIZ/etc/apt/sources.list.d/gvisor.list' ] && [ ! -e '$DGCLAW_RAIZ/usr/share/keyrings/gvisor-archive-keyring.gpg' ]"
novo regulado
lib ent_instalar_gvisor >"$TMP/o.txt" 2>&1
afirma "runsc ja instalado: nao baixa chave nem mexe no apt" bash -c "! grep -q 'archive.key' '$STUB_LOG' && ! grep -q '^apt-get' '$STUB_LOG'"
afirma "mas registra o runtime" test -s "$DGCLAW_RAIZ/etc/containers/containers.conf.d/dgclaw-runsc.conf"
novo escritorio
lib ent_instalar_gvisor >"$TMP/o.txt" 2>&1
afirma "escritorio (runc): o instalador do gVisor nao faz nada" bash -c "[ ! -s '$STUB_LOG' ] && [ ! -e '$DGCLAW_RAIZ/etc/containers/containers.conf.d/dgclaw-runsc.conf' ]"
novo regulado sem-runsc
ENSAIO=1 lib ent_instalar_gvisor >"$TMP/o.txt" 2>&1
afirma "ensaio: so anuncia" bash -c "grep -q 'ensaio' '$TMP/o.txt' && [ ! -s '$STUB_LOG' ]"

fim
