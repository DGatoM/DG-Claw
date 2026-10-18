#!/usr/bin/env bash
# `dgclaw agente recriar`: a troca do container nao pode travar num container preso em "stopping".
# Cobre: parada com espera, "stopping" que passa sozinho, "stopping" para sempre (rm -f so do
# container), volume do podman (nao usa -f), estados exited/ausente com --forcar, e a mensagem de
# erro que diz a verdade sobre o que foi ou nao removido.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
export DGCLAW_TEMPO_PARADA=3   # espera de 3 s em vez de 90 s, para o teste ser rapido

criar_agente ana --nome "Ana"
criar_agente beto --nome "Beto"
echo imagem-v2 >"$STUB_ESTADO/imagem-id"   # a imagem mudou: o container precisa ser recriado

recriar() { : >"$STUB_LOG"; dgclaw agente recriar "$@" >"$TMP/rec.txt" 2>&1; }

echo "parada normal"
recriar ana
igual "recriar sai com 0" "0" "$?"
afirma "para com -t 60" grep -q '^podman stop -t 60 dgclaw-ana' "$STUB_LOG"
afirma "remove com rm normal (sem -f)" grep -q '^podman rm dgclaw-ana' "$STUB_LOG"
nega "nao usou rm -f" grep -q '^podman rm -f' "$STUB_LOG"
afirma "criou o container de novo" grep -q '^podman create .*--name dgclaw-ana ' "$STUB_LOG"

echo "stop devolve mas o estado fica 'stopping' por algumas consultas"
echo imagem-v3 >"$STUB_ESTADO/imagem-id"
echo 2 >"$STUB_ESTADO/stop-trava-dgclaw-ana"
recriar ana
igual "espera o estado sair de stopping e termina com 0" "0" "$?"
afirma "esperou e usou rm normal" grep -q '^podman rm dgclaw-ana' "$STUB_LOG"
nega "nao precisou de rm -f" grep -q '^podman rm -f' "$STUB_LOG"
rm -f "$STUB_ESTADO/stop-trava-dgclaw-ana"

echo "stopping para sempre: rm -f so do container"
echo imagem-v4 >"$STUB_ESTADO/imagem-id"
echo sempre >"$STUB_ESTADO/stop-trava-dgclaw-ana"
casa_antes="$(find "$LIB/agentes/ana" -type f | sort | xargs sha256sum | sha256sum)"
recriar ana
igual "termina com 0 usando rm -f" "0" "$?"
afirma "usou podman rm -f no container do agente" grep -q '^podman rm -f dgclaw-ana' "$STUB_LOG"
afirma "avisou por que usa -f" grep -q "continua em 'stopping'" "$TMP/rec.txt"
nega "nenhum volume foi removido" grep -q '^podman volume' "$STUB_LOG"
igual "a casa do agente ficou intacta" "$casa_antes" "$(find "$LIB/agentes/ana" -type f | sort | xargs sha256sum | sha256sum)"
afirma "container novo no ar" grep -qx running "$STUB_ESTADO/c-dgclaw-ana"

echo "stopping para sempre + volume do podman: nao usa -f e explica"
echo imagem-v5 >"$STUB_ESTADO/imagem-id"
touch "$STUB_ESTADO/mounts-volume"
recriar ana
nega "falha" test "$?" -eq 0
nega "nao usou rm -f" grep -q '^podman rm -f' "$STUB_LOG"
afirma "explica o volume" grep -q 'volume do podman' "$TMP/rec.txt"
afirma "diz que o container antigo continua la, em stopping" grep -q 'ANTIGO do agente ana continua la, no estado stopping' "$TMP/rec.txt"
nega "nao diz 'foi removido'" grep -q 'foi removido e o novo NAO' "$TMP/rec.txt"
afirma "diz o comando para tentar de novo" grep -q 'dgclaw agente recriar ana --forcar' "$TMP/rec.txt"
rm -f "$STUB_ESTADO/mounts-volume"

echo "sem --forcar, 'stopping' e a troca que travou: recria"
recriar ana
igual "recria e termina com 0" "0" "$?"
afirma "avisa que estava preso em stopping" grep -q "preso em 'stopping'" "$TMP/rec.txt"
rm -f "$STUB_ESTADO/stop-trava-dgclaw-ana"
afirma "container novo no ar" grep -qx running "$STUB_ESTADO/c-dgclaw-ana"

echo "agente desligado (exited)"
echo exited >"$STUB_ESTADO/c-dgclaw-beto"
recriar beto
igual "sem --forcar deixa como esta (0)" "0" "$?"
afirma "diz que deixou como esta e oferece --forcar" grep -q 'deixei como esta.*--forcar' "$TMP/rec.txt"
nega "nao mexeu no container" grep -q '^podman \(stop\|rm\|create\)' "$STUB_LOG"
recriar beto --forcar
igual "com --forcar recria (0)" "0" "$?"
afirma "removeu o container parado sem stop" bash -c "grep -q '^podman rm dgclaw-beto' '$STUB_LOG' && ! grep -q '^podman stop' '$STUB_LOG'"
afirma "criou de novo" grep -q '^podman create .*--name dgclaw-beto ' "$STUB_LOG"

echo "container ausente com --forcar: cria do zero com os mesmos volumes e portas"
rm -f "$STUB_ESTADO/c-dgclaw-beto"
porta="$(awk -F'\t' '$1 == "beto" {print $0}' "$ETC/portas.tsv" | head -n1)"
recriar beto --forcar
igual "recria (0)" "0" "$?"
afirma "criou com a casa do Beto" grep -q "^podman create .*--name dgclaw-beto .*--volume $LIB/agentes/beto/home:/home/agente:rw" "$STUB_LOG"
afirma "criou com as portas do registro" grep -q -- '--publish 127.0.0.1:[0-9]*:4300' "$STUB_LOG"
nega "nao tentou parar nem remover o que nao existe" grep -q '^podman \(stop\|rm\) ' "$STUB_LOG"
: "$porta"

fim
