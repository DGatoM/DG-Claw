#!/usr/bin/env bash
# Bloco D, container endurecido: opcoes do podman create, agente pacote, cerca IPv6, recriar e aplicar.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
preparar
stubs_d

cria_arr() { # imprime o array depois do gancho de endurecer
    # shellcheck disable=SC2016 # o script e do bash filho, nao deste
    lib eval 'args=(create --name x); ent_args_container_endurecer args ana; printf "%s\n" "${args[*]}"'
}

echo "container: nivel pessoal nao muda nada"
igual "pessoal: o gancho nao acrescenta nada" "create --name x" "$(cria_arr)"

echo "container: nivel escritorio endurece"
nivel_na_raiz escritorio
linha="$(cria_arr)"
afirma "cap-drop=ALL" bash -c "[[ '$linha' == *'--cap-drop=ALL'* ]]"
for cap in CHOWN DAC_OVERRIDE FOWNER FSETID KILL SETGID SETUID SETPCAP NET_BIND_SERVICE SYS_CHROOT AUDIT_WRITE; do
    afirma "cap-add=$cap" bash -c "[[ '$linha' == *'--cap-add=$cap'* ]]"
done
afirma "nao devolve capacidade que sobrou de fora (SYS_ADMIN, NET_RAW)" bash -c "[[ '$linha' != *SYS_ADMIN* && '$linha' != *NET_RAW* ]]"
afirma "no-new-privileges" bash -c "[[ '$linha' == *'--security-opt no-new-privileges'* ]]"
afirma "ulimit nofile" bash -c "[[ '$linha' == *'--ulimit nofile=4096:8192'* ]]"

echo "container: agente criado no escritorio (cofre cifrado + container endurecido)"
app_copia
"$CLI_COPIA" agente criar ana --nome "Ana" --dono "Marta" >"$TMP/saida.txt" 2>&1
igual "agente criou" 0 "$?"
grep '^podman create' "$STUB_LOG" | sed "s#$DGCLAW_RAIZ#@RAIZ@#g" >"$TMP/create.txt"
igual "escritorio: a linha do podman create e a esperada (golden)" "$(cat "$REPO/tests/enterprise/golden/podman-create-escritorio.txt")" "$(cat "$TMP/create.txt")"
afirma "a imagem continua sendo o ultimo item" bash -c "[[ \"\$(cat '$TMP/create.txt')\" == *' localhost/dgclaw-agente:latest' ]]"
afirma "o cofre em claro nao e mais montado" bash -c "! grep -q 'agentes/ana/cofre:/run/dgclaw/cofre' '$TMP/create.txt'"
afirma "o cofre em memoria e montado no lugar" grep -q "run/dgclaw/cofres/ana:/run/dgclaw/cofre:ro" "$TMP/create.txt"

echo "container: agente pacote"
nega "pacote com nome invalido (maiuscula)" "$CLI_COPIA" agente pacote ana Foo
nega "pacote que parece opcao" "$CLI_COPIA" agente pacote ana -y
nega "pacote com ponto e virgula" "$CLI_COPIA" agente pacote ana 'a;b'
nega "pacote com espaco" "$CLI_COPIA" agente pacote ana 'ab cd'
nega "sem pacote" "$CLI_COPIA" agente pacote ana
nega "agente que nao existe" "$CLI_COPIA" agente pacote zzz imagemagick
afirma "nenhum apt-get rodou com nome invalido" bash -c "! grep -q 'apt-get' '$STUB_LOG'"
"$CLI_COPIA" agente pacote ana imagemagick libreoffice-writer >"$TMP/o.txt" 2>&1
igual "pacote valido instala" 0 "$?"
afirma "o apt-get roda como root, em array, com -- antes dos nomes" grep -q "^podman exec -u 0 --env DEBIAN_FRONTEND=noninteractive dgclaw-ana apt-get install -y --no-install-recommends -- imagemagick libreoffice-writer$" "$STUB_LOG"
afirma "foi auditado" bash -c "jq -e 'select(.evento == \"agente.pacote\" and .dados.slug == \"ana\" and (.dados.pacotes | index(\"imagemagick\")))' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl'"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
nega "container parado: recusa" "$CLI_COPIA" agente pacote ana imagemagick
echo running >"$STUB_ESTADO/c-dgclaw-ana"

echo "container: pessoal recusa o agente pacote (o sudo continua la)"
preparar; stubs_d
app_copia
"$CLI_COPIA" agente criar ana --nome "Ana" >/dev/null 2>&1
nega "pessoal: agente pacote recusa" "$CLI_COPIA" agente pacote ana imagemagick
"$CLI_COPIA" agente pacote ana imagemagick >"$TMP/o.txt" 2>&1
afirma "a mensagem diz que o agente ainda tem sudo" grep -q "ainda tem sudo" "$TMP/o.txt"

echo "container: cerca IPv6"
preparar; stubs_d
FW6="$REPO/lib/enterprise/firewall6.sh"
printf 'dgclaw-ana podman1\ndgclaw-bia podman2\noutra-rede podman9\n' >"$STUB_ESTADO/pontes"
bash "$FW6" >"$TMP/o.txt" 2>&1
igual "pessoal: sai com 0" 0 "$?"
afirma "pessoal: nao chamou o ip6tables" bash -c "! grep -q '^ip6tables' '$STUB_LOG'"
nivel_na_raiz escritorio
bash "$FW6" >"$TMP/o.txt" 2>&1
igual "escritorio: aplicou" 0 "$?"
afirma "cria a cadeia" grep -q "^ip6tables -w -N DGCLAW_V6" "$STUB_LOG"
for p in podman1 podman2; do
    afirma "barra a entrada na ponte $p" grep -q "^ip6tables -w -A DGCLAW_V6 -i $p -j DROP" "$STUB_LOG"
    afirma "barra a saida na ponte $p" grep -q "^ip6tables -w -A DGCLAW_V6 -o $p -j DROP" "$STUB_LOG"
    afirma "desliga o IPv6 da ponte $p" grep -q "^sysctl -q -w net.ipv6.conf.$p.disable_ipv6=1" "$STUB_LOG"
done
afirma "rede que nao e dgclaw-* fica de fora" bash -c "! grep -q podman9 '$STUB_LOG'"
for c in INPUT OUTPUT FORWARD; do igual "salto unico em $c, no topo" "-j DGCLAW_V6" "$(head -n 1 "$STUB_ESTADO/v6-$c")"; done
bash "$FW6" >"$TMP/o.txt" 2>&1
for c in INPUT OUTPUT FORWARD; do igual "rodar de novo nao duplica o salto em $c" 1 "$(grep -c 'DGCLAW_V6' "$STUB_ESTADO/v6-$c")"; done
afirma "so mexeu no ip6tables (nunca no iptables, nem no mangle)" bash -c "! grep -qE '^iptables|mangle' '$STUB_LOG'"
DGCLAW_PONTES="bad;name" bash "$FW6" >"$TMP/o.txt" 2>&1
afirma "interface com nome estranho e ignorada com aviso" grep -q "fora do padrao" "$TMP/o.txt"

echo "container: recriar e aplicar"
preparar; stubs_d
app_copia
"$CLI_COPIA" agente criar ana --nome "Ana" >/dev/null 2>&1
nivel_na_raiz escritorio
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "aplicar avisa que o container esta defasado" grep -q "agente recriar ana --sim" "$TMP/o.txt"
nega "recriar sem --sim recusa" "$CLI_COPIA" agente recriar ana
: >"$STUB_LOG"
"$CLI_COPIA" agente recriar ana --sim >"$TMP/o.txt" 2>&1
igual "recriar com --sim" 0 "$?"
afirma "parou, removeu e criou de novo" bash -c "grep -q '^podman stop dgclaw-ana' '$STUB_LOG' && grep -q '^podman rm dgclaw-ana' '$STUB_LOG' && grep -q '^podman create.*--cap-drop=ALL' '$STUB_LOG'"
afirma "a casa do agente continua la" test -d "$LIB/agentes/ana/home"
afirma "foi auditado" bash -c "jq -e 'select(.evento == \"agente.recriar\")' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl'"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "depois de recriar, aplicar diz que esta tudo em dia" grep -q "ja estao com as protecoes" "$TMP/o.txt"

fim
