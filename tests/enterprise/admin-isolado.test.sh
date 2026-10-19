#!/usr/bin/env bash
# Bloco C: dgclaw admin isolar|host|status|manutencao, as unidades do systemd e os ganchos. Raiz falsa, podman e systemctl de mentira.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
ENT_STUBS_C="$(cd "$(dirname "$0")" && pwd)/stubs-c"
preparar
stubs_d
PATH="$ENT_STUBS_C:$PATH"; export PATH
app_copia

ADMIN_HOST='{"slug":"admin","nome":"Admin","tipo":"admin","runner":"http://127.0.0.1:4300","agente_id":"admin","chat_id":"c_admin","avatar":"T","cor":"#64748b","provedor":"claude","modelo":"","transcripts_dir":"/root/.claude/projects/-opt-dgclaw-admin","porta_painel":null,"proxy_segredo_arquivo":null,"runner_token_arquivo":"/etc/dgclaw/runner/admin.token","home_host":"/opt/dgclaw/admin","home_container":"/opt/dgclaw/admin"}'
ADMIN_DIR="$DGCLAW_RAIZ/opt/dgclaw/admin"
AGENTES="$ETC/agentes.json"
UNITS="$DGCLAW_RAIZ/etc/systemd/system"
AUD="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"
export DGCLAW_BIN_CLI="$CLI_COPIA"

# o Admin do host como o instalador o deixa
mkdir -p "$ADMIN_DIR/.plataforma" "$ADMIN_DIR/.claude/skills/criar-agente" "$ADMIN_DIR/memory"
echo '{}' >"$ADMIN_DIR/.plataforma/runner.json"
echo "instrucoes do admin antigo" >"$ADMIN_DIR/CLAUDE.md"
echo "o dono prefere resumos curtos" >"$ADMIN_DIR/memory/preferencias.md"
echo "segredo-do-runner-antigo" >"$ADMIN_DIR/.plataforma/dgchat.mcp.json"
printf '{"versao": 1, "agentes": [%s]}\n' "$ADMIN_HOST" >"$AGENTES"
agente() { jq -c --arg s "$1" '.agentes[] | select(.slug == $s)' "$AGENTES"; }
chamou() { grep -q -- "$1" "$STUB_LOG"; }

echo "admin: nivel pessoal nao muda nada"
igual "unidades esperadas: so o Admin do host" "dgclaw-admin" "$(lib_d ent_admin_unidades)"
igual "porta do Admin: 4300" "4300" "$(lib_d ent_admin_porta)"
afirma "ganchos de instalar nao fazem nada" bash -c "$(declare -f lib_d); REPO='$REPO'; lib_d ent_instalar_admin_isolado && lib_d ent_instalar_controle"
afirma "gancho de status nao diz nada" bash -c "[ -z \"\$(DGCLAW_RAIZ='$DGCLAW_RAIZ' bash -c '. \"$REPO/lib/comum.sh\"; . \"$REPO/lib/agentes.sh\"; . \"$REPO/lib/protecoes.sh\"; for f in \"$REPO\"/lib/enterprise/*.sh; do . \"\$f\"; done; ent_status_admin')\" ]"
nega "o gancho do agente criar recusa o nome admin sem o aviso" "$CLI_COPIA" agente criar admin --nome Admin
afirma "o nome admin continua reservado (a mensagem)" bash -c "'$CLI_COPIA' agente criar admin --nome Admin 2>&1 | grep -q 'reservado ao agente de sistema'"
afirma "nenhuma unidade do controle foi escrita" test ! -e "$UNITS/dgclaw-controle.service"
afirma "o agentes.json nao mudou" bash -c "[ \"\$(jq -c '.agentes[0].tipo' '$AGENTES')\" = '\"admin\"' ] && [ \"\$(jq '.agentes | length' '$AGENTES')\" = 1 ]"

echo "admin isolar: nivel pessoal liga a protecao e cria o container"
printf '{"versao": 1, "agentes": []}\n' >"$AGENTES"
nega "isolar sem o Admin do host no registro falha" "$CLI_COPIA" admin isolar
afirma "a falha diz o que fazer" bash -c "'$CLI_COPIA' admin isolar 2>&1 | grep -q 'rode o instalador'"
printf '{"versao": 1, "agentes": [%s]}\n' "$ADMIN_HOST" >"$AGENTES"
"$CLI_COPIA" admin isolar >"$TMP/isolar.txt" 2>&1
igual "isolar terminou bem" 0 "$?"
igual "a protecao admin_isolado foi ligada" "true" "$(jq -r '.ajustes.admin_isolado' "$ETC/protecoes.json")"
igual "o nivel continua pessoal" "pessoal" "$(jq -r '.nivel' "$ETC/protecoes.json")"
igual "registro: tipo admin" "admin" "$(agente admin | jq -r .tipo)"
igual "registro: papel admin" "admin" "$(agente admin | jq -r .papel)"
igual "registro: container dgclaw-admin" "dgclaw-admin" "$(agente admin | jq -r .container)"
afirma "registro: runner em porta de agente, nao a 4300" bash -c "[ \"\$(jq -r '.agentes[] | select(.slug==\"admin\") | .runner' '$AGENTES')\" != 'http://127.0.0.1:4300' ]"
igual "so um registro admin (substituiu o do host)" 1 "$(jq '[.agentes[] | select(.slug == "admin")] | length' "$AGENTES")"
igual "backup do registro do host: sem container, porta 4300" "http://127.0.0.1:4300" "$(jq -r '.runner' "$ETC/admin-host.json")"
afirma "backup 600" test "$(stat -c %a "$ETC/admin-host.json")" = 600
HOME_ADMIN="$LIB/agentes/admin/home"
afirma "CLAUDE.md do Admin isolado usa o dgclaw-controle" grep -q "dgclaw-controle" "$HOME_ADMIN/CLAUDE.md"
afirma "AGENTS.md tambem" grep -q "dgclaw-controle" "$HOME_ADMIN/AGENTS.md"
afirma "o CLAUDE.md novo nao ensina comandos do dgclaw para rodar no servidor" bash -c "! grep -q '^| .dgclaw agente' '$HOME_ADMIN/CLAUDE.md'"
afirma "a skill criar-agente isolada foi instalada" test -f "$HOME_ADMIN/.claude/skills/criar-agente/SKILL.md"
afirma "a skill nova fala do dgclaw-controle" grep -q "dgclaw-controle agente.criar" "$HOME_ADMIN/.claude/skills/criar-agente/SKILL.md"
afirma "memoria do admin antigo copiada" grep -q "resumos curtos" "$HOME_ADMIN/admin-anterior/memory/preferencias.md"
afirma "instrucoes antigas copiadas" grep -q "instrucoes do admin antigo" "$HOME_ADMIN/admin-anterior/CLAUDE.md"
afirma "o segredo do runner antigo NAO foi copiado (.plataforma fica de fora)" test ! -e "$HOME_ADMIN/admin-anterior/.plataforma"
afirma "a pasta original do Admin continua intacta" grep -q "instrucoes do admin antigo" "$ADMIN_DIR/CLAUDE.md"
afirma "o Admin do host foi desligado e desabilitado" chamou "systemctl disable --now dgclaw-admin.service"
afirma "o servico de controle foi habilitado e reiniciado" bash -c "grep -q 'systemctl enable dgclaw-controle.service' '$STUB_LOG' && grep -q 'systemctl restart dgclaw-controle.service' '$STUB_LOG'"
afirma "o container dgclaw-admin foi criado" chamou "podman create .*dgclaw-admin"
afirma "no nivel pessoal a auditoria fica desligada: nada gravado" test ! -s "$AUD"
afirma "a saida diz como entrar na conta" grep -q "Entrar com a assinatura" "$TMP/isolar.txt"
igual "unidades esperadas depois de isolar: so o controle" "dgclaw-controle" "$(lib_d ent_admin_unidades)"

echo "admin isolar: unidades do systemd"
CTL="$UNITS/dgclaw-controle.service"
afirma "unidade do controle existe" test -f "$CTL"
afirma "roda como root" grep -q '^User=root' "$CTL"
afirma "sem LLM: o ExecStart e o servidor do controle" grep -q 'ExecStart=/usr/bin/node /opt/dgclaw/app/controle/servidor.js' "$CTL"
for linha in PrivateTmp=yes ProtectHome=read-only ProtectKernelTunables=yes ProtectControlGroups=no UMask=0077; do
    afirma "endurecimento: $linha" grep -q "^$linha\$" "$CTL"
done
afirma "NoNewPrivileges fica de fora (herdaria para os containers e quebraria o sudo)" bash -c "! grep -q '^NoNewPrivileges' '$CTL' && ! grep -q '^SystemCallFilter' '$CTL' && ! grep -q '^CapabilityBoundingSet' '$CTL'"
afirma "o socket e o agentes.json vem do ambiente da unidade" grep -q 'DGCLAW_CONTROLE_SOCK=/run/dgclaw/controle.sock' "$CTL"
MAN="$UNITS/dgclaw-admin-manutencao.service"
afirma "unidade de manutencao existe e e o Admin antigo" grep -q 'RUNNER_AGENT_FILE=/opt/dgclaw/admin/.plataforma/runner.json' "$MAN"
afirma "a unidade de manutencao nao tem [Install] (nunca sobe no boot)" bash -c "! grep -q '^\[Install\]' '$MAN'"
DROP="$UNITS/dgclaw-web.service.d/20-enterprise-controle.conf"
afirma "drop-in do Web com sandbox" bash -c "grep -q '^ProtectSystem=full' '$DROP' && grep -q '^ReadWritePaths=/etc/dgclaw' '$DROP' && grep -q '^PrivateTmp=yes' '$DROP'"
afirma "o Web foi reiniciado para valer o sandbox" chamou "systemctl restart dgclaw-web.service"
: >"$STUB_LOG"
"$CLI_COPIA" admin isolar >"$TMP/isolar2.txt" 2>&1
igual "isolar de novo e seguro" 0 "$?"
afirma "segunda vez o Web nao reinicia (drop-in igual)" bash -c "! grep -q 'systemctl restart dgclaw-web.service' '$STUB_LOG'"
afirma "o backup do host nao foi sobrescrito pelo registro do container" test "$(jq -r '.runner' "$ETC/admin-host.json")" = "http://127.0.0.1:4300"

echo "admin status e dgclaw status"
afirma "status diz que esta em container" bash -c "'$CLI_COPIA' admin status | grep -q 'em container'"
echo running >"$STUB_ESTADO/c-dgclaw-admin"; echo active >"$STUB_ESTADO/svc-dgclaw-controle"
"$CLI_COPIA" status >"$TMP/status.txt" 2>&1
afirma "dgclaw status: Admin em container" grep -q "Admin em container (isolado)" "$TMP/status.txt"
afirma "dgclaw status: servico de controle de pe" grep -q "servico de controle de pe" "$TMP/status.txt"
afirma "dgclaw status nao cobra mais o servico dgclaw-admin parado" bash -c "! grep -q 'servico dgclaw-admin parado' '$TMP/status.txt'"
echo exited >"$STUB_ESTADO/c-dgclaw-admin"
"$CLI_COPIA" status >"$TMP/status2.txt" 2>&1
afirma "container do Admin parado vira FALHOU com o que fazer" grep -q "FALHOU.*container do Admin esta exited.*podman logs dgclaw-admin" "$TMP/status2.txt"

echo "admin manutencao (nivel escritorio: auditoria ligada)"
nivel_na_raiz escritorio
"$CLI_COPIA" admin isolar >"$TMP/isolar3.txt" 2>&1
igual "isolar no escritorio" 0 "$?"
afirma "no escritorio o isolar e auditado" bash -c "jq -e 'select(.evento == \"admin.isolar\")' '$AUD'"
for ruim in 4 61 abc '5;ls' '' 1000 -5; do
    nega "abrir com minutos '$ruim' e recusado" "$CLI_COPIA" admin manutencao abrir "$ruim"
done
nega "abrir com --por estranho e recusado" "$CLI_COPIA" admin manutencao abrir 10 --por 'a b;c'
nega "abrir com opcao desconhecida e recusado" "$CLI_COPIA" admin manutencao abrir 10 --root
afirma "nada foi ligado ate aqui" bash -c "! grep -q 'start dgclaw-admin-manutencao' '$STUB_LOG'"
: >"$STUB_LOG"
export DGCLAW_AGORA_MS=1800000000000
"$CLI_COPIA" admin manutencao abrir 15 --por agente:admin >"$TMP/m1.txt" 2>&1
igual "abrir 15 minutos" 0 "$?"
MST="$LIB/web/controle/manutencao.json"
igual "estado: fecha 15 minutos depois" "$((1800000000000 + 900000))" "$(jq -r .fecha_em "$MST")"
igual "estado: quem abriu" "agente:admin" "$(jq -r .por "$MST")"
afirma "estado 600" test "$(stat -c %a "$MST")" = 600
igual "registro da manutencao: tipo admin (funcionario nunca ve)" "admin" "$(agente admin-manutencao | jq -r .tipo)"
igual "registro da manutencao: aponta para o runner antigo" "http://127.0.0.1:4300" "$(agente admin-manutencao | jq -r .runner)"
igual "registro da manutencao: sem papel (nao usa a caixa nem o controle)" "null" "$(agente admin-manutencao | jq -r '.papel')"
afirma "ligou a unidade de manutencao" chamou "systemctl start dgclaw-admin-manutencao.service"
afirma "agendou o fechamento com systemd-run" chamou "systemd-run --on-active=15min --unit=dgclaw-admin-manutencao-fecha"
afirma "o fechamento chama dgclaw admin manutencao fechar --auto" chamou "admin manutencao fechar --auto"
afirma "auditou a abertura" bash -c "jq -e 'select(.evento == \"manutencao_aberta\" and .dados.minutos == 15 and .dados.por == \"agente:admin\")' '$AUD'"
nega "abrir outra com a primeira aberta e recusado" "$CLI_COPIA" admin manutencao abrir 10
afirma "status mostra a manutencao" bash -c "'$CLI_COPIA' admin manutencao status | grep -q 'aberta por agente:admin'"
echo active >"$STUB_ESTADO/svc-dgclaw-admin-manutencao"
: >"$STUB_LOG"
"$CLI_COPIA" admin manutencao fechar >"$TMP/m2.txt" 2>&1
igual "fechar" 0 "$?"
afirma "parou a unidade" chamou "systemctl stop dgclaw-admin-manutencao.service"
afirma "estado apagado" test ! -e "$MST"
igual "registro da manutencao removido" "" "$(agente admin-manutencao)"
igual "o Admin isolado continua registrado" "dgclaw-admin" "$(agente admin | jq -r .container)"
afirma "auditou o fechamento" bash -c "jq -e 'select(.evento == \"manutencao_fechada\" and .dados.motivo == \"manual\")' '$AUD'"
afirma "fechar de novo e seguro" "$CLI_COPIA" admin manutencao fechar --auto
unset DGCLAW_AGORA_MS

echo "admin host: nivel pessoal volta; nivel travado recusa"
nivel_na_raiz pessoal '{"admin_isolado":true}'
: >"$STUB_LOG"
"$CLI_COPIA" admin host >"$TMP/host.txt" 2>&1
igual "host no nivel pessoal" 0 "$?"
igual "protecao desligada" "false" "$(jq -r '.ajustes.admin_isolado' "$ETC/protecoes.json")"
igual "registro do Admin voltou ao do host" "http://127.0.0.1:4300" "$(agente admin | jq -r .runner)"
igual "sem container no registro" "" "$(agente admin | jq -r '.container // empty')"
afirma "parou o container" chamou "podman stop dgclaw-admin"
afirma "religou o Admin do host" chamou "systemctl enable --now dgclaw-admin.service"
afirma "desligou o controle" chamou "systemctl disable --now dgclaw-controle.service"
afirma "a casa do container continua la (reversivel)" test -d "$LIB/agentes/admin/home"
igual "unidades esperadas: so o Admin do host" "dgclaw-admin" "$(lib_d ent_admin_unidades)"
"$CLI_COPIA" admin isolar >/dev/null 2>&1
igual "isolar outra vez depois de voltar ao host" 0 "$?"
igual "de novo em container" "dgclaw-admin" "$(agente admin | jq -r .container)"

nivel_na_raiz escritorio
agentes_antes="$(cat "$AGENTES")"; : >"$STUB_LOG"
nega "no escritorio o host e recusado (admin_isolado e travado)" "$CLI_COPIA" admin host
afirma "a recusa explica a trava" bash -c "'$CLI_COPIA' admin host 2>&1 | grep -qi 'nao posso gravar admin_isolado'"
igual "o registro nao mudou" "$agentes_antes" "$(cat "$AGENTES")"
afirma "nada foi parado nem religado" bash -c "! grep -q 'podman stop dgclaw-admin' '$STUB_LOG' && ! grep -q 'enable --now dgclaw-admin' '$STUB_LOG'"
afirma "o status avisa que a manutencao e o caminho de emergencia" bash -c "'$CLI_COPIA' admin manutencao abrir 5 >/dev/null 2>&1 && '$CLI_COPIA' admin manutencao fechar >/dev/null 2>&1"

echo "admin: ganchos do instalador e do protecoes aplicar"
preparar
stubs_d
PATH="$ENT_STUBS_C:$PATH"; export PATH
app_copia
export DGCLAW_BIN_CLI="$CLI_COPIA"
ADMIN_DIR="$DGCLAW_RAIZ/opt/dgclaw/admin"; AGENTES="$ETC/agentes.json"; UNITS="$DGCLAW_RAIZ/etc/systemd/system"
mkdir -p "$ADMIN_DIR/.plataforma"; echo '{}' >"$ADMIN_DIR/.plataforma/runner.json"
printf '{"versao": 1, "agentes": [%s]}\n' "$ADMIN_HOST" >"$AGENTES"
nivel_na_raiz escritorio
touch "$STUB_ESTADO/sem-imagem"
lib_d ent_instalar_admin_isolado >"$TMP/inst1.txt" 2>&1
igual "instalar o Admin sem imagem pronta nao falha" 0 "$?"
lib_d ent_instalar_controle >>"$TMP/inst1.txt" 2>&1
igual "instalar o controle nao falha" 0 "$?"
afirma "escreveu as unidades" test -f "$UNITS/dgclaw-controle.service"
afirma "avisou que o Admin continua no host e como terminar" grep -q "dgclaw admin isolar" "$TMP/inst1.txt"
igual "o Admin continua o do host" "" "$(jq -r '.agentes[] | select(.slug=="admin") | .container // empty' "$AGENTES")"
igual "unidades esperadas no meio do caminho (protecao ligada, Admin ainda no host): o dgclaw-admin" "dgclaw-admin" "$(lib_d ent_admin_unidades)"
afirma "status avisa que falta isolar" bash -c "'$CLI_COPIA' status 2>&1 | grep -q 'Admin ainda roda no host'"
rm -f "$STUB_ESTADO/sem-imagem"
lib_d ent_instalar_admin_isolado >"$TMP/inst2.txt" 2>&1
igual "instalar com imagem pronta isola" 0 "$?"
igual "agora em container" "dgclaw-admin" "$(jq -r '.agentes[] | select(.slug=="admin") | .container' "$AGENTES")"
lib_d ent_instalar_admin_isolado >/dev/null 2>&1 && lib_d ent_instalar_controle >/dev/null 2>&1
igual "instalar de novo e seguro" 0 "$?"
afirma "ensaio nao muda nada" bash -c "rm -rf '$UNITS'; cd '$TMP' && DGCLAW_RAIZ='$DGCLAW_RAIZ' ENSAIO=1 bash -c '. \"$REPO/lib/comum.sh\"; . \"$REPO/lib/agentes.sh\"; . \"$REPO/lib/protecoes.sh\"; for f in \"$REPO\"/lib/enterprise/*.sh; do . \"\$f\"; done; ent_instalar_admin_isolado; ent_instalar_controle' >/dev/null 2>&1; test ! -e '$UNITS/dgclaw-controle.service'"

echo "admin: protecoes aplicar"
printf '{"versao": 1, "agentes": []}\n' >"$AGENTES"
rm -rf "$UNITS"
lib_d ent_aplicar_admin_isolado >"$TMP/ap1.txt" 2>&1
igual "aplicar sem Admin no registro nao falha" 0 "$?"
afirma "e nao escreve unidade nenhuma" test ! -e "$UNITS/dgclaw-controle.service"
printf '{"versao": 1, "agentes": [%s]}\n' "$ADMIN_HOST" >"$AGENTES"
"$CLI_COPIA" protecoes aplicar >"$TMP/ap2.txt" 2>&1
igual "protecoes aplicar com o Admin do host isola" 0 "$?"
igual "agora em container" "dgclaw-admin" "$(jq -r '.agentes[] | select(.slug=="admin") | .container' "$AGENTES")"

fim
