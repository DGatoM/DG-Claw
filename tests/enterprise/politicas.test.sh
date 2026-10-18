#!/usr/bin/env bash
# Bloco E, politicas gerenciadas do Claude Code: managed-settings por agente, montagem so leitura, chaves por uso,
# aplicar com reinicio do runner e nivel pessoal intacto. Todo comando de sistema (podman, systemctl) e stub.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
preparar
stubs_d
app_copia

ORG="11111111-2222-3333-4444-555555555555"
MS() { printf '%s/agentes/%s/politicas/managed-settings.json' "$LIB" "$1"; }
CREATE() { grep '^podman create' "$STUB_LOG" | grep -- "--name dgclaw-$1 " | head -n 1; }

echo "politicas: nivel pessoal nao muda nada"
"$CLI_COPIA" agente criar ana --nome "Ana" >/dev/null 2>&1
igual "pessoal: criou" 0 "$?"
afirma "pessoal: nao existe pasta de politicas" bash -c "[ ! -e '$LIB/agentes/ana/politicas' ]"
afirma "pessoal: o podman create nao monta /etc/claude-code" bash -c "! grep -q 'claude-code' <<<\"\$(grep '^podman create' '$STUB_LOG')\""
afirma "pessoal: nem passa DGCLAW_TRAVAS" bash -c "! grep -q 'DGCLAW_TRAVAS' '$STUB_LOG'"

echo "politicas: escritorio, agente de pessoa"
preparar; stubs_d; app_copia
nivel_na_raiz escritorio
"$CLI_COPIA" nivel org "$ORG" >/dev/null 2>&1
"$CLI_COPIA" usuario criar fran --papel funcionario >/dev/null 2>&1
"$CLI_COPIA" agente criar ana --nome "Ana" --uso pessoa --usuario fran >"$TMP/o.txt" 2>&1
igual "criou o agente" 0 "$?"
afirma "managed-settings.json existe" test -s "$(MS ana)"
igual "arquivo 644" 644 "$(stat -c %a "$(MS ana)")"
igual "pasta 755" 755 "$(stat -c %a "$(dirname "$(MS ana)")")"
igual "forceLoginMethod claudeai" '"claudeai"' "$(jq -c .forceLoginMethod "$(MS ana)")"
igual "forceLoginOrgUUID e o org_uuid do nivel" "\"$ORG\"" "$(jq -c .forceLoginOrgUUID "$(MS ana)")"
igual "cleanupPeriodDays = retencao_dias do escritorio" 180 "$(jq -c .cleanupPeriodDays "$(MS ana)")"
for f in send_message reply forward 'send*' trash_message create_label update_message_labels; do
    afirma "deny tem mcp__claude_ai_Gmail__$f" bash -c "jq -e --arg x 'mcp__claude_ai_Gmail__$f' '.permissions.deny | index(\$x)' '$(MS ana)'"
done
afirma "o podman create monta a pasta so leitura em /etc/claude-code" bash -c "grep -q -- '--volume $LIB/agentes/ana/politicas:/etc/claude-code:ro' <<<\"\$(grep '^podman create' '$STUB_LOG')\""
afirma "o podman create passa DGCLAW_TRAVAS=1" bash -c "grep -q -- '--env DGCLAW_TRAVAS=1' <<<\"\$(grep '^podman create' '$STUB_LOG')\""
afirma "a imagem continua sendo o ultimo item" bash -c "[[ \"\$(grep '^podman create' '$STUB_LOG')\" == *' localhost/dgclaw-agente:latest' ]]"
afirma "nenhuma chave de segredo no arquivo" bash -c "! grep -qi -e 'token' -e 'senha' '$(MS ana)'"

echo "politicas: a lista de deny e a mesma do gmail-permissao.sh"
cfg="$TMP/gmail-config.sh"; printf "export DGCLAW_WORKSPACE='%s'\n" "$TMP/ws" >"$cfg"; mkdir -p "$TMP/ws"
DGCLAW_GMAIL_SEM_AVISO=1 bash "$REPO/scripts/gmail-permissao.sh" "$cfg" leitura >/dev/null 2>&1
igual "mesmas regras (ordenadas) que o script grava no settings.local.json" \
    "$(jq -c '.permissions.deny | sort' "$TMP/ws/.claude/settings.local.json")" "$(jq -c '.permissions.deny | sort' "$(MS ana)")"

echo "politicas: sem organizacao, o login pessoal nao e bloqueado e o status avisa"
printf '{"versao":1,"nivel":"escritorio","ajustes":{},"org_uuid":"","atualizado_em":"2026-01-01T00:00:00Z"}\n' >"$ETC/protecoes.json"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "sem org: nao tem forceLoginOrgUUID" bash -c "! jq -e 'has(\"forceLoginOrgUUID\")' '$(MS ana)'"
igual "mas continua com forceLoginMethod" '"claudeai"' "$(jq -c .forceLoginMethod "$(MS ana)")"
afirma "aplicar avisa da organizacao" grep -q "forceLoginOrgUUID" "$TMP/o.txt"
"$CLI_COPIA" status >"$TMP/s.txt" 2>&1
afirma "status avisa que o login pessoal nao esta bloqueado" grep -q "login pessoal do Claude NAO esta bloqueado" "$TMP/s.txt"
"$CLI_COPIA" nivel org "$ORG" >/dev/null 2>&1

echo "politicas: agente de setor (chave de API) nao leva forceLogin*"
"$CLI_COPIA" agente criar sac --nome "SAC" --uso setor --auth api >"$TMP/o.txt" 2>&1
igual "setor criado" 0 "$?"
afirma "sem forceLoginMethod" bash -c "! jq -e 'has(\"forceLoginMethod\")' '$(MS sac)'"
afirma "sem forceLoginOrgUUID" bash -c "! jq -e 'has(\"forceLoginOrgUUID\")' '$(MS sac)'"
afirma "mas com a trava do Gmail" bash -c "jq -e '.permissions.deny | index(\"mcp__claude_ai_Gmail__send_message\")' '$(MS sac)'"
afirma "e com a retencao" bash -c "jq -e '.cleanupPeriodDays == 180' '$(MS sac)'"

echo "politicas: aplicar regrava e reinicia o runner so de quem mudou"
"$CLI_COPIA" protecoes aplicar >/dev/null 2>&1
: >"$STUB_LOG"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
igual "aplicar sem mudanca: nenhum reinicio" 0 "$(grep -c 'systemctl restart dgclaw-runner' "$STUB_LOG")"
"$CLI_COPIA" nivel ajustar retencao_dias 400 >/dev/null 2>&1
: >"$STUB_LOG"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
igual "retencao nova no arquivo" 400 "$(jq -c .cleanupPeriodDays "$(MS ana)")"
afirma "reiniciou o runner da ana" grep -q "^podman exec dgclaw-ana systemctl restart dgclaw-runner" "$STUB_LOG"
afirma "reiniciou o runner do sac" grep -q "^podman exec dgclaw-sac systemctl restart dgclaw-runner" "$STUB_LOG"

echo "politicas: container criado antes da protecao nao tem a montagem"
: >"$STUB_ESTADO/mounts-dgclaw-ana"
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "avisa e diz o comando para recriar" grep -q "dgclaw agente recriar ana --sim" "$TMP/o.txt"
"$CLI_COPIA" status >"$TMP/s.txt" 2>&1
afirma "o status lista o agente sem a politica montada" grep -q "sem a politica montada: ana" "$TMP/s.txt"

echo "politicas: agente Codex recebe o requirements.toml, nao o managed-settings"
"$CLI_COPIA" agente criar cod --nome "Cod" --provedor codex --uso pessoa --usuario fran >"$TMP/o.txt" 2>&1
igual "codex criado" 0 "$?"
afirma "requirements.toml com chatgpt" grep -q '^allowed_login_methods = \["chatgpt"\]' "$LIB/agentes/cod/politicas-codex/requirements.toml"
afirma "monta em /etc/codex so leitura" bash -c "grep -q -- ':/etc/codex:ro' <<<\"\$(grep '^podman create' '$STUB_LOG' | grep 'dgclaw-cod ')\""
afirma "nao ha managed-settings do Claude" bash -c "[ ! -e '$(MS cod)' ]"

echo "politicas: baixar para pessoal tira o arquivo"
nivel_na_raiz pessoal
"$CLI_COPIA" protecoes aplicar >"$TMP/o.txt" 2>&1
afirma "managed-settings.json sai" bash -c "[ ! -e '$(MS ana)' ]"

fim
