#!/usr/bin/env bash
# Bloco H, saida controlada: cerca (ordem das regras), gancho do container, comandos, unidade do servico, teste de dentro.
# Nada toca o iptables de verdade: o stub de tests/enterprise/stubs-h guarda as cadeias em arquivos.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
ENT_STUBS_H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stubs-h"
FWSH="$REPO/lib/firewall.sh"
FWS="$REPO/lib/enterprise/firewall-saida.sh"

# ambiente <nivel|"">: raiz nova, stubs (d + h), dois agentes no registro e na pasta de casas. A cerca roda de verdade
# (lib/firewall.sh e firewall-saida.sh) contra o iptables de mentira.
ambiente() {
    preparar; stubs_d
    PATH="$ENT_STUBS_H:$PATH"; export PATH
    export DGCLAW_PONTES="podman1 podman2"
    [ -z "${1:-}" ] || nivel_na_raiz "$1" "${2:-{\}}"
    printf 'ana\t1000000\t11\nbia\t1065536\t12\n' >"$ETC/registro.tsv"
    mkdir -p "$LIB/agentes/ana" "$LIB/agentes/bia"
}

# app_copia_h: como app_copia, mais a pasta saida/ (o proxy e a CLI de listas, em Node).
app_copia_h() { app_copia; cp -r "$REPO/saida" "$TMP/app/"; }

ipt() { cat "$STUB_ESTADO/ipt/$1__$2" 2>/dev/null; }
# estado_ipt: todas as cadeias (nome e regras), em ordem estavel.
estado_ipt() { (cd "$STUB_ESTADO/ipt" 2>/dev/null && for f in *; do echo "[$f]"; cat "$f"; done); }
sem_saida() { grep -v 'DGCLAW-SAIDA'; }
rodar_fw() { bash "$FWSH" >"$TMP/fw.txt" 2>&1; }

echo "saida/cerca: nivel pessoal (sem protecoes.json) nao cria regra nenhuma e nem chama o iptables no script novo"
ambiente ""
rodar_fw
igual "lib/firewall.sh aplicou a cerca de hoje" 0 "$?"
BASE="$(estado_ipt)"
afirma "a cerca base existe (DGCLAW_HOST, DGCLAW_EGRESS)" bash -c "[[ '$BASE' == *DGCLAW_HOST* && '$BASE' == *DGCLAW_EGRESS* ]]"
afirma "nenhuma cadeia ou regra DGCLAW-SAIDA" bash -c "! grep -rq 'DGCLAW-SAIDA' '$STUB_ESTADO/ipt'"
afirma "nenhum comando mencionou DGCLAW-SAIDA" bash -c "! grep -q 'DGCLAW-SAIDA' '$STUB_LOG'"
: >"$STUB_LOG"
bash "$FWS" >/dev/null 2>&1
igual "o script da saida, sozinho, sai com 0" 0 "$?"
igual "e nao chamou o iptables nenhuma vez" 0 "$(grep -c '^iptables' "$STUB_LOG")"

echo "saida/cerca: nivel pessoal COM protecoes.json: so leitura, estado identico"
nivel_na_raiz pessoal
: >"$STUB_LOG"
rodar_fw
igual "estado das cadeias identico ao de hoje" "$BASE" "$(estado_ipt)"
afirma "nenhum -N/-I/-A/-D/-F/-X mencionou a cadeia nova (so leitura)" bash -c "! grep -E '^iptables .* (-N|-I|-A|-D|-F|-X) ' '$STUB_LOG' | grep -q 'DGCLAW-SAIDA'"
afirma "e houve leitura (o script rodou de verdade)" grep -q "^iptables -w -t filter -L DGCLAW-SAIDA" "$STUB_LOG"
igual "nenhuma regra nova (so as de sempre: contagem de linhas igual)" "$(printf '%s\n' "$BASE" | wc -l)" "$(estado_ipt | wc -l)"

echo "saida/cerca: regulado (bloqueio) acrescenta so a cadeia nova e preserva a ordem de hoje"
nivel_na_raiz regulado
rodar_fw
igual "firewall.sh com o bloco H sai com 0" 0 "$?"
igual "mangle FORWARD: DGCLAW_EGRESS segue na posicao 1" "-s 10.89.0.0/16 -j DGCLAW_EGRESS" "$(ipt mangle FORWARD | sed -n 1p)"
igual "mangle FORWARD: o salto novo vem na posicao 2" "-s 10.89.0.0/16 -j DGCLAW-SAIDA" "$(ipt mangle FORWARD | sed -n 2p)"
igual "mangle FORWARD: so esses dois" 2 "$(ipt mangle FORWARD | grep -c '')"
igual "filter INPUT: o salto da saida fica ANTES do DGCLAW_HOST (libera o proxy antes do DROP)" "-s 10.89.0.0/16 -j DGCLAW-SAIDA" "$(ipt filter INPUT | sed -n 1p)"
igual "filter INPUT: DGCLAW_HOST na posicao 2" "-s 10.89.0.0/16 -j DGCLAW_HOST" "$(ipt filter INPUT | sed -n 2p)"
# Sem as linhas da cadeia nova, tudo o que existia continua IGUAL, na mesma ordem.
igual "removendo a cadeia nova, o resto e identico ao de hoje (mangle, filter, DGCLAW_HOST, DGCLAW_EGRESS)" \
    "$(printf '%s\n' "$BASE" | grep -v '^\[.*DGCLAW-SAIDA')" \
    "$(estado_ipt | awk '/^\[.*DGCLAW-SAIDA\]$/ {pular=1; next} /^\[/ {pular=0} !pular && !/-j DGCLAW-SAIDA$/ {print}')"
igual "filter DGCLAW-SAIDA: so o proxy de cada agente, na porta 3128, e RETURN" \
    "-s 10.89.11.0/24 -d 10.89.11.1/32 -p tcp --dport 3128 -j ACCEPT
-s 10.89.12.0/24 -d 10.89.12.1/32 -p tcp --dport 3128 -j ACCEPT
-j RETURN" "$(ipt filter DGCLAW-SAIDA)"
igual "mangle DGCLAW-SAIDA: barra toda saida de cada agente e RETURN" \
    "-s 10.89.11.0/24 -j DROP
-s 10.89.12.0/24 -j DROP
-j RETURN" "$(ipt mangle DGCLAW-SAIDA)"
igual "a cadeia DGCLAW_EGRESS da mangle nao ganhou regra" "$(printf '%s\n' "$BASE" | awk '/^\[mangle__DGCLAW_EGRESS\]$/ {p=1; next} /^\[/ {p=0} p')" "$(ipt mangle DGCLAW_EGRESS)"
afirma "o IPv6 (bloco D) continua aplicado" grep -q "^ip6tables -w -N DGCLAW_V6" "$STUB_LOG"
ANTES="$(estado_ipt)"
rodar_fw
igual "rodar de novo e idempotente (mesmo estado, um salto so em cada lugar)" "$ANTES" "$(estado_ipt)"

echo "saida/cerca: empurrar o nosso salto para baixo, ou o do DGCLAW_HOST, e rodar de novo recoloca a ordem"
{ echo "-j ufw-before-input"; ipt filter INPUT; } >"$STUB_ESTADO/ipt/filter__INPUT.n"; mv "$STUB_ESTADO/ipt/filter__INPUT.n" "$STUB_ESTADO/ipt/filter__INPUT"
rodar_fw
igual "INPUT: saida, host, depois a regra de fora" "-s 10.89.0.0/16 -j DGCLAW-SAIDA|-s 10.89.0.0/16 -j DGCLAW_HOST|-j ufw-before-input" "$(ipt filter INPUT | paste -sd'|')"
igual "mangle FORWARD segue com os dois saltos na ordem" "-s 10.89.0.0/16 -j DGCLAW_EGRESS|-s 10.89.0.0/16 -j DGCLAW-SAIDA" "$(ipt mangle FORWARD | paste -sd'|')"

echo "saida/cerca: escritorio (registro) libera o proxy mas nao fecha a saida direta"
ambiente escritorio
rodar_fw
igual "filter: ACCEPT do proxy dos dois agentes" 3 "$(ipt filter DGCLAW-SAIDA | grep -c '')"
igual "mangle: sem DROP de saida (so RETURN)" "-j RETURN" "$(ipt mangle DGCLAW-SAIDA)"
echo "saida/cerca: modo do agente mais firme que o da instalacao"
mkdir -p "$ETC/saida"; echo '{"modo":"bloqueio","permitidos":[]}' >"$ETC/saida/ana.json"
rodar_fw
igual "so o ana ganha DROP" "-s 10.89.11.0/24 -j DROP
-j RETURN" "$(ipt mangle DGCLAW-SAIDA)"
echo '{"modo":"livre","permitidos":[]}' >"$ETC/saida/bia.json"
rodar_fw
igual "modo livre no arquivo do agente nao afrouxa a instalacao: bia continua com o proxy" 1 "$(ipt filter DGCLAW-SAIDA | grep -c '10.89.12.0/24')"
rm -rf "$LIB/agentes/bia"
rodar_fw
igual "agente sem casa (removido) perde as regras" 0 "$(ipt filter DGCLAW-SAIDA | grep -c '10.89.12.0/24')"

echo "saida/cerca: voltar ao pessoal desfaz tudo o que a saida montou"
ambiente regulado
rodar_fw
afirma "montou" test -f "$STUB_ESTADO/ipt/mangle__DGCLAW-SAIDA"
nivel_na_raiz pessoal
rodar_fw
afirma "a cadeia da mangle saiu" test ! -f "$STUB_ESTADO/ipt/mangle__DGCLAW-SAIDA"
afirma "a cadeia do filter saiu" test ! -f "$STUB_ESTADO/ipt/filter__DGCLAW-SAIDA"
igual "INPUT voltou a ter so o DGCLAW_HOST" "-s 10.89.0.0/16 -j DGCLAW_HOST" "$(ipt filter INPUT)"
igual "mangle FORWARD voltou a ter so o DGCLAW_EGRESS" "-s 10.89.0.0/16 -j DGCLAW_EGRESS" "$(ipt mangle FORWARD)"

echo "saida/cerca: sem a cerca base a saida recusa em vez de inserir na posicao errada"
ambiente regulado
bash "$FWS" >"$TMP/o.txt" 2>&1
igual "falha" 1 "$?"
afirma "diz o que fazer" grep -q "systemctl restart dgclaw-firewall" "$TMP/o.txt"
afirma "nao criou nada" bash -c "! grep -rq 'DGCLAW-SAIDA' '$STUB_ESTADO/ipt' 2>/dev/null"

echo "saida/gancho: o container recebe o proxy no ambiente (e so fora do nivel pessoal)"
# shellcheck disable=SC2016 # o script e do bash filho, nao deste
cria_arr() { lib_d eval 'C_N=11; args=(create --name x); ent_args_container_saida args ana; printf "%s\n" "${args[*]}"'; }
ambiente ""
igual "pessoal: o gancho nao acrescenta nada" "create --name x" "$(cria_arr)"
ambiente escritorio
linha="$(cria_arr)"
for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do
    afirma "escritorio: --env $v aponta para o gateway do agente" bash -c "[[ '$linha' == *'--env $v=http://10.89.11.1:3128'* ]]"
done
afirma "NO_PROXY mantem o local fora do proxy" bash -c "[[ '$linha' == *'--env NO_PROXY=localhost,127.0.0.1,::1'* ]]"

echo "saida/sincronizacao e comandos: pessoal"
ambiente ""
app_copia_h
"$CLI_COPIA" agente criar ana --nome "Ana" >/dev/null 2>&1
igual "pessoal: agente criou" 0 "$?"
afirma "pessoal: nenhum arquivo em /etc/dgclaw/saida" test ! -e "$ETC/saida"
afirma "pessoal: nenhuma pasta de registro" test ! -e "$DGCLAW_RAIZ/var/log/dgclaw/saida"
afirma "pessoal: o podman create nao tem variavel de proxy" bash -c "! grep '^podman create' '$STUB_LOG' | grep -q 'HTTPS_PROXY'"
afirma "pessoal: nenhum useradd, nenhuma unidade" bash -c "! grep -q '^useradd' '$STUB_LOG' && [ ! -e '$DGCLAW_RAIZ/etc/systemd/system/dgclaw-saida.service' ]"
"$CLI_COPIA" saida >"$TMP/o.txt" 2>&1
igual "saida (resumo) responde" 0 "$?"
afirma "diz que esta livre" grep -q "livre" "$TMP/o.txt"
nega "permitir recusa" "$CLI_COPIA" saida permitir ana api.exemplo.com
"$CLI_COPIA" saida permitir ana api.exemplo.com >"$TMP/o.txt" 2>&1
afirma "e explica como ligar" grep -q "dgclaw nivel ajustar saida registro" "$TMP/o.txt"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
igual "protecoes aplicar no pessoal" 0 "$?"
afirma "pessoal: aplicar nao mexeu no systemctl por causa da saida" bash -c "! grep -q 'dgclaw-saida' '$STUB_LOG'"

echo "saida/escritorio: agente nasce com proxy, geral.json e a unidade sobe"
ambiente escritorio
app_copia_h
export DGCLAW_FIREWALL_SAIDA_CMD="echo cerca-saida >>'$TMP/cerca.log'"
export DGCLAW_SAIDA_TESTE_CMD="printf '%s\n' \"\$*\" >>'$TMP/teste-saida.log'; true"
export DGCLAW_ISOLAMENTO_CMD="true"
"$CLI_COPIA" agente criar ana --nome "Ana" >"$TMP/o.txt" 2>&1
igual "agente criou" 0 "$?"
grep '^podman create' "$STUB_LOG" | sed "s#$DGCLAW_RAIZ#@RAIZ@#g" >"$TMP/create.txt"
afirma "podman create com HTTPS_PROXY no gateway" grep -q -- "--env HTTPS_PROXY=http://10.89.11.1:3128" "$TMP/create.txt"
afirma "a imagem continua sendo o ultimo item" bash -c "[[ \"\$(cat '$TMP/create.txt')\" == *' localhost/dgclaw-agente:latest' ]]"
igual "geral.json: modo, retencao e os agentes (provedor claude quando o agente ainda nao esta no agentes.json)" '{"versao":1,"modo":"registro","retencao_dias":180,"agentes":{"ana":{"n":11,"provedor":"claude"},"bia":{"n":12,"provedor":"claude"}}}' "$(jq -c . "$ETC/saida/geral.json")"
igual "geral.json e 640" 640 "$(stat -c %a "$ETC/saida/geral.json")"
igual "a pasta de config e 2750" 2750 "$(stat -c %a "$ETC/saida")"
igual "o teste de dentro recebeu agente, modo e provedor" "ana registro claude" "$(cat "$TMP/teste-saida.log")"
afirma "o aviso de variavel de proxy do conferir_saida_internet nao aparece" bash -c "! grep -q 'nasceu com variavel de proxy' '$TMP/o.txt'"

echo "saida/escritorio: teste de dentro que falha para o agente"
ambiente escritorio
app_copia_h
export DGCLAW_SAIDA_TESTE_CMD="exit 1"
"$CLI_COPIA" agente criar ana --nome "Ana" >"$TMP/o.txt" 2>&1
igual "agente criar falha" 1 "$?"
afirma "e o container foi parado" grep -q "^podman stop dgclaw-ana" "$STUB_LOG"
export DGCLAW_SAIDA_TESTE_CMD="true"
unset DGCLAW_SAIDA_TESTE_CMD

echo "saida/escritorio: comandos de lista, modo e relatorio"
ambiente escritorio
app_copia_h
export DGCLAW_FIREWALL_SAIDA_CMD="echo cerca-saida >>'$TMP/cerca.log'"
export DGCLAW_ISOLAMENTO_CMD="true"
"$CLI_COPIA" agente criar ana --nome "Ana" >/dev/null 2>&1
: >"$TMP/cerca.log"
"$CLI_COPIA" saida permitir ana '*.Empresa.com.br' >"$TMP/o.txt" 2>&1
igual "permitir" 0 "$?"
igual "lista gravada normalizada" '{"permitidos":["*.empresa.com.br"]}' "$(jq -c . "$ETC/saida/ana.json")"
afirma "permitir foi auditado" bash -c "jq -e 'select(.evento == \"saida.permitir\" and .dados.slug == \"ana\" and .dados.dominio == \"*.Empresa.com.br\")' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl'"
nega "permitir com URL e recusado" "$CLI_COPIA" saida permitir ana 'https://x.com/a'
nega "permitir em agente que nao existe" "$CLI_COPIA" saida permitir zzz a.com
"$CLI_COPIA" saida mostrar ana >"$TMP/o.txt" 2>&1
afirma "mostrar traz a base e a lista do agente" bash -c "grep -q 'api.anthropic.com' '$TMP/o.txt' && grep -q '\\*.empresa.com.br' '$TMP/o.txt'"
nega "modo mais solto que a instalacao e recusado" "$CLI_COPIA" saida modo ana livre
: >"$TMP/cerca.log"
"$CLI_COPIA" saida modo ana bloqueio >"$TMP/o.txt" 2>&1
igual "modo bloqueio" 0 "$?"
afirma "mudar o modo reaplicou a cerca" test -s "$TMP/cerca.log"
afirma "avisa para conferir o relatorio antes" grep -q "dgclaw saida relatorio ana" "$TMP/o.txt"
afirma "modo foi auditado" bash -c "jq -e 'select(.evento == \"saida.modo\" and .dados.modo == \"bloqueio\")' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl'"
afirma "o resumo mostra o modo que vale" bash -c "'$CLI_COPIA' saida | grep -q 'ana: bloqueio'"
: >"$TMP/cerca.log"
"$CLI_COPIA" saida remover ana '*.empresa.com.br' >/dev/null 2>&1
igual "remover" 0 "$?"
mkdir -p "$DGCLAW_RAIZ/var/log/dgclaw/saida"
printf '{"ts":"%s","host":"estranho.test","porta":443,"decisao":"recusado","bytes_up":0,"bytes_down":0,"duracao":3}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >"$DGCLAW_RAIZ/var/log/dgclaw/saida/ana.jsonl"
"$CLI_COPIA" saida relatorio ana >"$TMP/o.txt" 2>&1
igual "relatorio" 0 "$?"
afirma "relatorio lista o destino fora da lista" grep -q "estranho.test" "$TMP/o.txt"

echo "saida/escritorio: protecoes aplicar escreve a unidade com hardening e liga o servico"
ambiente escritorio
app_copia_h
: >"$STUB_LOG"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
igual "aplicar sai com 0" 0 "$?"
U="$DGCLAW_RAIZ/etc/systemd/system/dgclaw-saida.service"
afirma "unidade escrita" test -f "$U"
for linha in "User=dgclaw-saida" "NoNewPrivileges=yes" "CapabilityBoundingSet=" "ProtectSystem=strict" "PrivateDevices=yes" "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX" "BindPaths=/var/log/dgclaw/saida:/opt/dgclaw/saida-log" "ExecStart=/usr/bin/node /opt/dgclaw/app/saida/servidor.js" "Restart=always"; do
    afirma "unidade tem: $linha" grep -qxF "$linha" "$U"
done
afirma "usuario do sistema criado, sem login nem home" grep -q "^useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dgclaw-saida" "$STUB_LOG"
afirma "enable e restart do servico" bash -c "grep -q '^systemctl enable dgclaw-saida.service' '$STUB_LOG' && grep -q '^systemctl restart dgclaw-saida.service' '$STUB_LOG'"
afirma "ponto de montagem do registro criado" test -d "$DGCLAW_RAIZ/opt/dgclaw/saida-log"
afirma "a pasta de registro existe" test -d "$DGCLAW_RAIZ/var/log/dgclaw/saida"
echo "saida/escritorio: voltar ao pessoal desliga o servico e remove a unidade"
nivel_na_raiz pessoal
: >"$STUB_LOG"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "disable --now" grep -q "^systemctl disable --now dgclaw-saida.service" "$STUB_LOG"
afirma "unidade removida" test ! -e "$U"

echo "saida/status: avisa de proxy parado"
ambiente escritorio
app_copia_h
"$CLI_COPIA" status >"$TMP/o.txt" 2>&1
afirma "status diz que o proxy nao esta ativo" grep -q "proxy dgclaw-saida nao esta ativo" "$TMP/o.txt"
echo active >"$STUB_ESTADO/svc-dgclaw-saida.service"
"$CLI_COPIA" status >"$TMP/o.txt" 2>&1
afirma "com o servico ativo, status confirma" grep -q "proxy dgclaw-saida ativo" "$TMP/o.txt"

echo "saida/teste de dentro (scripts/enterprise/teste-saida.sh), com podman, curl e timeout de mentira"
ambiente escritorio
TS="$REPO/scripts/enterprise/teste-saida.sh"
FALSOS="$TMP/falsos"; mkdir -p "$FALSOS"
cat >"$FALSOS/podman" <<'FIM'
#!/usr/bin/env bash
case "$1" in
    ps) echo dgclaw-ana ;;
    exec) shift; while [ "$1" != bash ]; do shift; done; shift; exec bash "$@" ;;
esac
FIM
cat >"$FALSOS/curl" <<'FIM'
#!/usr/bin/env bash
fmt=""; while [ "$#" -gt 0 ]; do [ "$1" = -w ] && fmt="$2"; shift; done
case "$fmt" in *http_connect*) echo "${FAKE_CONNECT:-403}" ;; *) echo "${FAKE_CODIGO:-200}" ;; esac
FIM
cat >"$FALSOS/timeout" <<'FIM'
#!/usr/bin/env bash
exit "${FAKE_TIMEOUT_RC:-124}"
FIM
chmod +x "$FALSOS"/*
export DGCLAW_ETC="$ETC" DGCLAW_TESTE_SEM_ROOT=1 DGCLAW_SAIDA_TENTATIVAS=1
rodar_ts() { PATH="$FALSOS:$PATH" bash "$TS" "$@" >"$TMP/ts.txt" 2>&1; }
rodar_ts ana bloqueio claude
igual "bloqueio em dia: sai com 0" 0 "$?"
afirma "diz que passou" grep -q "SAIDA CONTROLADA OK" "$TMP/ts.txt"
FAKE_TIMEOUT_RC=0 rodar_ts ana bloqueio claude
igual "saida direta que conecta e FURO (1)" 1 "$?"
afirma "o furo diz o que conferir" grep -q "iptables -t mangle -S DGCLAW-SAIDA" "$TMP/ts.txt"
FAKE_CONNECT=200 rodar_ts ana bloqueio claude
igual "destino fora da lista que o proxy deixa passar e FURO (1)" 1 "$?"
FAKE_CODIGO=000 rodar_ts ana bloqueio claude
igual "proxy que nao responde e INCONCLUSIVO (2), nunca 'ok'" 2 "$?"
rodar_ts ana registro codex
igual "registro: so confere o proxy" 0 "$?"
afirma "e avisa que a saida direta fica aberta de proposito" grep -q "continua aberta de proposito" "$TMP/ts.txt"
rodar_ts ana
igual "sem o modo: erro de uso (2)" 2 "$?"
rodar_ts 'a;b' bloqueio
igual "slug invalido: recusa (2)" 2 "$?"
unset DGCLAW_ETC DGCLAW_TESTE_SEM_ROOT DGCLAW_SAIDA_TENTATIVAS

fim
