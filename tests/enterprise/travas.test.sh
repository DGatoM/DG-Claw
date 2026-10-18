#!/usr/bin/env bash
# Bloco E, travas de acao externa (lado bash): liberar/fechar o envio de e-mail, timer, Instagram no cofre do host e lista
# do WhatsApp. Todo comando de sistema (podman, systemctl, systemd-run, systemd-creds) e stub; o teste confere que foi o stub.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
STUBS_C="$(cd "$(dirname "$0")" && pwd)/stubs-c"
novo_ambiente() { preparar; stubs_d; PATH="$STUBS_C:$PATH"; export PATH; app_copia; }
novo_ambiente

MS() { printf '%s/agentes/%s/politicas/managed-settings.json' "$LIB" "$1"; }
ESTADO() { printf '%s/travas/%s.json' "$ETC" "$1"; }
ENVIO='mcp__claude_ai_Gmail__send_message'
ALTERA='mcp__claude_ai_Gmail__trash_message'
tem_deny() { jq -e --arg x "$2" '.permissions.deny | index($x)' "$(MS "$1")" >/dev/null; }

echo "travas: nivel pessoal recusa e nao mexe em nada"
"$CLI_COPIA" agente criar ana --nome "Ana" >/dev/null 2>&1
nega "pessoal: travas liberar recusa" "$CLI_COPIA" travas liberar ana --minutos 30
"$CLI_COPIA" travas liberar ana --minutos 30 >"$TMP/o.txt" 2>&1
afirma "a mensagem diz que a protecao esta desligada" grep -q "travas_externas esta desligada" "$TMP/o.txt"
nega "pessoal: acoes whatsapp recusa" "$CLI_COPIA" acoes whatsapp permitir ana +5511987654321
nega "pessoal: acoes instagram recusa" "$CLI_COPIA" acoes instagram configurar ana
afirma "nenhum systemd-run" bash -c "! grep -q '^systemd-run' '$STUB_LOG'"

echo "travas: liberar o envio por um tempo"
novo_ambiente
nivel_na_raiz escritorio
"$CLI_COPIA" usuario criar fran --papel funcionario >/dev/null 2>&1
"$CLI_COPIA" agente criar ana --nome "Ana" --uso pessoa --usuario fran >/dev/null 2>&1
afirma "antes: o deny tem o envio" tem_deny ana "$ENVIO"
for ruim in 4 241 abc 30x -5 ''; do
    nega "minutos '$ruim' recusado" "$CLI_COPIA" travas liberar ana --minutos "$ruim"
done
nega "agente que nao existe" "$CLI_COPIA" travas liberar zzz --minutos 30
nega "opcao desconhecida" "$CLI_COPIA" travas liberar ana --horas 2
: >"$STUB_LOG"
DGCLAW_QUEM="controle:ti:dono" "$CLI_COPIA" travas liberar ana --minutos 30 >"$TMP/o.txt" 2>&1
igual "liberar termina bem" 0 "$?"
afirma "o estado da liberacao existe, 600" bash -c "[ -s '$(ESTADO ana)' ] && [ \"\$(stat -c %a '$(ESTADO ana)')\" = 600 ]"
afirma "o estado diz quem liberou e por quanto tempo" bash -c "jq -e '.minutos == 30 and .por == \"controle:ti:dono\"' '$(ESTADO ana)'"
nega "depois: o envio saiu do deny" tem_deny ana "$ENVIO"
afirma "mas apagar e alterar a caixa continuam bloqueados" tem_deny ana "$ALTERA"
afirma "o gmail-permissao.sh rodou como o agente, dentro do container, no modo envio" grep -q "^podman exec -u agente --env DGCLAW_GMAIL_SEM_AVISO=1 dgclaw-ana bash /opt/dgclaw/app/scripts/gmail-permissao.sh /home/agente/.dgclaw/config.sh envio" "$STUB_LOG"
afirma "reiniciou o runner" grep -q "^podman exec dgclaw-ana systemctl restart dgclaw-runner" "$STUB_LOG"
afirma "o systemd-run (stub) foi chamado com 30min e a unidade do agente" grep -q "^systemd-run --on-active=30min --unit=dgclaw-travas-fecha-ana " "$STUB_LOG"
afirma "o timer fecha com travas fechar ana --auto" grep -q "travas fechar ana --auto" "$STUB_LOG"
afirma "auditou travas.liberada" bash -c "jq -e 'select(.evento == \"travas.liberada\" and .dados.slug == \"ana\" and .dados.minutos == 30)' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl'"
"$CLI_COPIA" travas status >"$TMP/o.txt" 2>&1
afirma "status mostra liberado" grep -q "ana .*liberado por mais" "$TMP/o.txt"
"$CLI_COPIA" status >"$TMP/s.txt" 2>&1
afirma "o dgclaw status avisa que ha envio liberado" grep -q "LIBERADO agora para: ana" "$TMP/s.txt"

echo "travas: fechar"
: >"$STUB_LOG"
"$CLI_COPIA" travas fechar ana >"$TMP/o.txt" 2>&1
igual "fechar termina bem" 0 "$?"
afirma "o estado saiu" bash -c "[ ! -e '$(ESTADO ana)' ]"
afirma "o envio voltou ao deny" tem_deny ana "$ENVIO"
afirma "o gmail local voltou para leitura" grep -q "config.sh leitura" "$STUB_LOG"
afirma "auditou travas.fechada" bash -c "jq -e 'select(.evento == \"travas.fechada\")' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl'"
"$CLI_COPIA" travas fechar ana >"$TMP/o.txt" 2>&1
igual "fechar de novo e idempotente" 0 "$?"

echo "travas: conferir fecha o que venceu (rede de seguranca do timer)"
"$CLI_COPIA" travas liberar ana --minutos 5 >/dev/null 2>&1
"$CLI_COPIA" travas conferir >"$TMP/o.txt" 2>&1
afirma "ainda dentro do prazo: continua liberado" test -e "$(ESTADO ana)"
DGCLAW_AGORA_MS="$(( ($(date +%s) + 600) * 1000 ))" "$CLI_COPIA" travas conferir >"$TMP/o.txt" 2>&1
afirma "passou do prazo: fechou" bash -c "[ ! -e '$(ESTADO ana)' ]"
afirma "e o envio voltou ao deny" tem_deny ana "$ENVIO"

echo "travas: o agente nao consegue se liberar"
afirma "o managed-settings e do root, 644, numa pasta 755" bash -c "[ \"\$(stat -c '%a' '$(MS ana)')\" = 644 ] && [ \"\$(stat -c '%a' '$(dirname "$(MS ana)")')\" = 755 ]"
afirma "a pasta de politicas e montada no container" grep -q "/etc/claude-code" "$STUB_ESTADO/mounts-dgclaw-ana"
afirma "o estado da liberacao mora em /etc/dgclaw, fora da casa do agente" bash -c "case '$(ESTADO ana)' in '$LIB/agentes'/*) exit 1 ;; *) exit 0 ;; esac"

echo "travas: Instagram vai para o cofre do host"
CASA="$LIB/agentes/ana"
mkdir -p "$CASA/home/.dgclaw"
VALOR_IG="valor-ig-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s\n' "$VALOR_IG" >"$CASA/home/.instagram_token"
nega "sem igAccountId: recusa" "$CLI_COPIA" acoes instagram configurar ana
printf '{"igAccountId":"17841400000000000"}\n' >"$CASA/home/.dgclaw/instagram.json"
: >"$STUB_LOG"
"$CLI_COPIA" acoes instagram configurar ana >"$TMP/o.txt" 2>&1
igual "configurar termina bem" 0 "$?"
IG="$ETC/acoes-externas/ana"
afirma "cifrado (cofre_cifrado ligado no escritorio): so o .cred existe" bash -c "[ -s '$IG/instagram.env.cred' ] && [ ! -e '$IG/instagram.env' ]"
afirma "o .cred e 600 e a pasta 700" bash -c "[ \"\$(stat -c %a '$IG/instagram.env.cred')\" = 600 ] && [ \"\$(stat -c %a '$IG')\" = 700 ]"
afirma "o valor nao esta em claro no .cred" bash -c "! grep -q '$VALOR_IG' '$IG/instagram.env.cred'"
afirma "o nome da credencial identifica o agente" grep -q "^systemd-creds encrypt --name=dgclaw-acoes-instagram-ana " "$STUB_LOG"
afirma "o valor nao aparece em nenhum argv nem na saida" bash -c "! grep -q '$VALOR_IG' '$STUB_LOG' '$TMP/o.txt'"
afirma "o arquivo do token saiu da casa do agente" bash -c "[ ! -e '$CASA/home/.instagram_token' ]"
afirma "testar confere o cofre do host" "$CLI_COPIA" acoes instagram testar ana
"$CLI_COPIA" acoes instagram configurar ana >"$TMP/o.txt" 2>&1
afirma "rodar de novo nao quebra (ja esta no host)" grep -q "ja esta no cofre do host" "$TMP/o.txt"
afirma "auditou sem o valor" bash -c "jq -e 'select(.evento == \"acoes.instagram.configurar\")' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl' >/dev/null && ! grep -q '$VALOR_IG' '$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl'"

echo "travas: Instagram, atalho no lugar do arquivo e tokenPath fora da casa sao recusados"
rm -rf "$IG"
ln -s /etc/hostname "$CASA/home/.instagram_token"
nega "atalho no lugar do arquivo: recusa" "$CLI_COPIA" acoes instagram configurar ana
rm -f "$CASA/home/.instagram_token"
printf '{"igAccountId":"17841400000000000","tokenPath":"/etc/passwd"}\n' >"$CASA/home/.dgclaw/instagram.json"
nega "tokenPath fora da casa: recusa" "$CLI_COPIA" acoes instagram configurar ana

echo "travas: WhatsApp so conversa com a lista do TI"
mkdir -p "$CASA/home/.dgclaw/whatsapp"
printf '{"versao":1,"numeros":["+5511900000001"]}\n' >"$CASA/home/.dgclaw/whatsapp/permitidos.json"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
LISTA="$CASA/config/whatsapp-permitidos.json"
igual "aplicar semeou a lista do TI com a que o agente tinha" '["+5511900000001"]' "$(jq -c .numeros "$LISTA")"
igual "a lista e 644" 644 "$(stat -c %a "$LISTA")"
"$CLI_COPIA" acoes whatsapp permitir ana "(11) 98765-4321" >"$TMP/o.txt" 2>&1
igual "permitir aceita numero com mascara" 0 "$?"
afirma "virou +5511987654321" bash -c "jq -e '.numeros | index(\"+5511987654321\")' '$LISTA'"
"$CLI_COPIA" acoes whatsapp permitir ana +5511987654321 >/dev/null 2>&1
igual "permitir de novo nao duplica" 2 "$(jq '.numeros | length' "$LISTA")"
nega "numero curto demais" "$CLI_COPIA" acoes whatsapp permitir ana 12345
nega "numero com letras" "$CLI_COPIA" acoes whatsapp permitir ana '+55abc'
nega "sem numero" "$CLI_COPIA" acoes whatsapp permitir ana
"$CLI_COPIA" acoes whatsapp remover ana +5511900000001 >/dev/null 2>&1
igual "remover tira o numero" '["+5511987654321"]' "$(jq -c .numeros "$LISTA")"
afirma "listar mostra a lista do TI" bash -c "'$CLI_COPIA' acoes whatsapp listar ana | grep -q 5511987654321"
printf '{"versao":1,"numeros":["+5511900000001","+5599900000000"]}\n' >"$CASA/home/.dgclaw/whatsapp/permitidos.json"
"$CLI_COPIA" protecoes aplicar >/dev/null 2>&1
igual "o agente mexeu na lista dele: a do TI nao muda" '["+5511987654321"]' "$(jq -c .numeros "$LISTA")"

echo "travas: aplicar avisa de container sem DGCLAW_TRAVAS e instala o timer de conferencia"
: >"$STUB_LOG"
echo '[DGCLAW_SLUG=ana]' >"$STUB_ESTADO/env-dgclaw-ana"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "avisa do container antigo" grep -q "criado antes das travas" "$TMP/o.txt"
afirma "timer dgclaw-travas.timer escrito" test -s "$DGCLAW_RAIZ/etc/systemd/system/dgclaw-travas.timer"
afirma "systemctl enable --now do timer (stub)" grep -q "^systemctl enable --now dgclaw-travas.timer" "$STUB_LOG"

echo "travas: voltar para pessoal tira a lista do TI e o timer"
nivel_na_raiz pessoal
"$CLI_COPIA" protecoes aplicar >/dev/null 2>&1
afirma "lista do TI saiu" bash -c "[ ! -e '$LISTA' ]"
afirma "timer saiu" bash -c "[ ! -e '$DGCLAW_RAIZ/etc/systemd/system/dgclaw-travas.timer' ]"

fim
