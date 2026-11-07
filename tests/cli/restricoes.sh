#!/usr/bin/env bash
# `dgclaw agente restricoes` e a aplicacao das restricoes (lib/restricoes.sh).
# O ponto: a restricao do dono sobrevive a criar de novo, reparar, recriar e atualizar, sem apagar
# nada que e do aluno, e um arquivo estragado PARA em vez de soltar a trava. O gancho de escrita
# (scripts/escrita-restrita-hook.mjs) tem a bateria dele no fim.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

R_DIR() { printf '%s/agentes/%s/runner' "$LIB" "$1"; }

criar_agente ana --nome "Ana"
criar_agente beto --nome "Beto" --provedor codex
RJ="$(R_DIR ana)/runner.json"; RS="$(R_DIR ana)/restricoes.json"; ST="$LIB/agentes/ana/home/.claude/settings.json"

echo "sem restricoes: tudo como antes"
cp "$RJ" "$TMP/runner-padrao.json"
cp "$ST" "$TMP/settings-padrao.json"
dgclaw agente restricoes ana >"$TMP/o1.txt" 2>&1
igual "mostrar sai com 0" "0" "$?"
afirma "diz que nao ha restricao" grep -q 'Nenhuma restricao definida' "$TMP/o1.txt"
nega "nao criou o restricoes.json" test -e "$RS"
dgclaw agente reparar ana >/dev/null 2>&1
igual "reparar sem restricao nao muda o runner.json" "" "$(diff "$TMP/runner-padrao.json" "$RJ")"
igual "reparar sem restricao nao muda o settings.json" "" "$(diff "$TMP/settings-padrao.json" "$ST")"

echo "recusas"
dgclaw agente restricoes admin >"$TMP/o2.txt" 2>&1; igual "recusa o Admin (1)" "1" "$?"
afirma "explica por que o Admin nao entra" grep -q 'Admin nao usa este mecanismo' "$TMP/o2.txt"
dgclaw agente restricoes fantasma --sem-bash sim >"$TMP/o2.txt" 2>&1; igual "agente que nao existe (1)" "1" "$?"
dgclaw agente restricoes ana --sem-bash talvez >"$TMP/o2.txt" 2>&1; igual "valor errado (1)" "1" "$?"
afirma "diz o valor errado e o que usar" grep -q "o valor 'talvez' de --sem-bash nao serve" "$TMP/o2.txt"
dgclaw agente restricoes ana --escrita-so-em /etc >"$TMP/o2.txt" 2>&1; igual "pasta absoluta (1)" "1" "$?"
afirma "explica a pasta absoluta" grep -q "comeca por '/'" "$TMP/o2.txt"
dgclaw agente restricoes ana --escrita-so-em a/../../b >"$TMP/o2.txt" 2>&1; igual "pasta com .. (1)" "1" "$?"
afirma "explica o .." grep -q "tem '.' ou '..'" "$TMP/o2.txt"
dgclaw agente restricoes ana --escrita-so-em x --escrita-livre >"$TMP/o2.txt" 2>&1; igual "so-em com livre (1)" "1" "$?"
dgclaw agente restricoes ana --foo >"$TMP/o2.txt" 2>&1; igual "opcao desconhecida (1)" "1" "$?"
nega "nada foi gravado pelas recusas" test -e "$RS"
mkdir -p "$LIB/agentes/ana/home/arquivo-solto"; ln -s /etc "$LIB/agentes/ana/home/atalho"
dgclaw agente restricoes ana --escrita-so-em atalho >"$TMP/o2.txt" 2>&1; igual "pasta que e atalho (1)" "1" "$?"
afirma "explica o atalho" grep -q 'e um atalho' "$TMP/o2.txt"
rm -f "$LIB/agentes/ana/home/atalho"

echo "definir as tres restricoes"
marcar_settings_alheio ana
dgclaw agente restricoes ana --sem-bash sim --sem-enviar-arquivo sim --escrita-so-em relatorios,rascunhos/2026/ >"$TMP/o3.txt" 2>&1
igual "definir sai com 0" "0" "$?"
afirma "o restricoes.json esta no formato combinado" jq -e '.versao == 1 and .sem_bash == true and .sem_enviar_arquivo == true and .escrita_so_em == ["rascunhos/2026","relatorios"] and (.atualizado_em | test("^[0-9]{4}-")) and (.atualizado_por | length > 0)' "$RS"
igual "restricoes.json com modo 444" "444" "$(stat -c %a "$RS")"
afirma "as pastas nasceram dentro da casa, dono do agente" test -d "$LIB/agentes/ana/home/rascunhos/2026" -a -d "$LIB/agentes/ana/home/relatorios"
afirma "o mostrar traz o estado" grep -q 'so em rascunhos/2026, relatorios' "$TMP/o3.txt"
nega "com o Bash travado nao avisa do Bash" grep -q 'continua com o Bash ligado' "$TMP/o3.txt"
guardar_restricoes ana
confere_travas ana "depois de definir"

echo "campos que nao vieram ficam como estao"
jq '. + {"campo_do_dono": "fica"}' "$RS" >"$RS.novo" && mv -f "$RS.novo" "$RS" && chmod 444 "$RS"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1
afirma "mudar so o Bash preserva o resto e o campo desconhecido" jq -e '.sem_enviar_arquivo == true and .escrita_so_em == ["rascunhos/2026","relatorios"] and .campo_do_dono == "fica"' "$RS"
guardar_restricoes ana

echo "sobrevive: reparar"
dgclaw agente reparar ana >"$TMP/o4.txt" 2>&1; igual "reparar sai com 0" "0" "$?"
confere_travas ana "depois de reparar"

echo "sobrevive: recriar"
echo imagem-v2 >"$STUB_ESTADO/imagem-id"
dgclaw agente recriar ana >"$TMP/o5.txt" 2>&1; igual "recriar sai com 0" "0" "$?"
afirma "o container foi mesmo recriado" grep -q '^podman create .*--name dgclaw-ana ' "$STUB_LOG"
confere_travas ana "depois de recriar"

echo "sobrevive: criar de novo (regrava o runner.json com os padroes)"
cp "$TMP/runner-padrao.json" "$TMP/ref.json"
criar_agente ana --nome "Ana"
igual "criar de novo sai com 0" "0" "$?"
confere_travas ana "depois de criar de novo"
afirma "fora das travas, o runner.json e o padrao de sempre" bash -c "[ \"\$(jq -cS '.config |= (del(.denyTools) | .allowTools = [\"mcp__dgchat__reply\",\"mcp__dgchat__send_file\",\"mcp__dgchat__whatsapp_reply\",\"mcp__dgchat__whatsapp_send_file\"])' '$RJ')\" = \"\$(jq -cS . '$TMP/ref.json')\" ]"

echo "o que o dono ja tinha em denyTools e o que o aluno poe no runner.json fica"
jq '.config.denyTools += ["WebFetch"]' "$RJ" >"$RJ.novo" && mv -f "$RJ.novo" "$RJ" && chmod 444 "$RJ"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1
afirma "WebFetch continua em denyTools" jq -e '.config.denyTools | index("WebFetch") != null' "$RJ"
afirma "e sem duplicar" jq -e '[.config.denyTools[] | select(. == "Bash")] | length == 1' "$RJ"

echo "arquivo invalido: para com erro e nao tira as travas"
cp "$RS" "$TMP/restr-bom.json"
printf '{"versao": 1, "sem_bash": ' >"$RS"
for cmd in "agente reparar ana" "agente recriar ana --forcar" "agente restricoes ana" "agente restricoes ana --sem-bash nao"; do
    : >"$STUB_LOG"
    # shellcheck disable=SC2086 # $cmd sao varias palavras de proposito
    dgclaw $cmd >"$TMP/o6.txt" 2>&1; rc=$?
    nega "'$cmd' falha com arquivo ilegivel" test "$rc" -eq 0
    afirma "'$cmd': diz qual arquivo e o motivo" grep -q "restricoes.json (restricoes do agente ana) nao e um JSON valido" "$TMP/o6.txt"
    afirma "'$cmd': diz o que fazer" grep -q 'O que fazer:' "$TMP/o6.txt"
done
afirma "as travas do runner.json continuam" jq -e '(.config.denyTools | index("Bash")) != null' "$RJ"
afirma "o gancho continua no settings.json" jq -e '[.hooks.PreToolUse[]?.hooks[]?] | length == 1' "$ST"
: >"$STUB_LOG"
dgclaw agente recriar ana --forcar >/dev/null 2>&1
nega "recriar nem chegou a mexer no container" grep -q '^podman \(stop\|rm\|create\)' "$STUB_LOG"
nega "o arquivo ruim nao foi reescrito" bash -c "jq -e . '$RS'"
printf '{"versao": 2}' >"$RS"
dgclaw agente reparar ana >"$TMP/o6.txt" 2>&1; nega "versao desconhecida falha" test "$?" -eq 0
afirma "explica a versao" grep -q '"versao" precisa ser 1' "$TMP/o6.txt"
printf '{"versao": 1, "escrita_so_em": ["../fora"]}' >"$RS"
dgclaw agente reparar ana >"$TMP/o6.txt" 2>&1; nega "pasta com .. no arquivo falha" test "$?" -eq 0
printf '{"versao": 1, "escrita_so_em": []}' >"$RS"
dgclaw agente reparar ana >"$TMP/o6.txt" 2>&1; nega "lista vazia falha" test "$?" -eq 0
afirma "explica a lista vazia" grep -q 'esta vazia' "$TMP/o6.txt"
cp "$TMP/restr-bom.json" "$RS"; chmod 444 "$RS"
dgclaw agente reparar ana >/dev/null 2>&1; igual "com o arquivo de volta, reparar funciona" "0" "$?"

echo "aviso: pasta sem travar o Bash"
dgclaw agente restricoes ana --sem-bash nao >"$TMP/o7.txt" 2>&1
afirma "avisa que o Bash ligado fura a trava de pastas" grep -q 'continua com o Bash ligado' "$TMP/o7.txt"
afirma "e manda combinar com --sem-bash sim" grep -q -- '--sem-bash sim' "$TMP/o7.txt"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1

echo "reinicia o runner so quando algo mudou e o agente esta ligado"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1
nega "nada mudou: nao reiniciou" grep -q 'systemctl restart dgclaw-runner' "$STUB_LOG"
dgclaw agente restricoes ana --sem-enviar-arquivo nao >/dev/null 2>&1
afirma "mudou e esta ligado: reiniciou" grep -q 'exec dgclaw-ana systemctl restart dgclaw-runner' "$STUB_LOG"
dgclaw agente restricoes ana --sem-enviar-arquivo sim >/dev/null 2>&1
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-enviar-arquivo nao >"$TMP/o7.txt" 2>&1
nega "parado: nao tenta reiniciar" grep -q 'systemctl restart' "$STUB_LOG"
afirma "parado: diz que vale quando ligar" grep -q 'vale quando ele ligar\|valem quando ele ligar' "$TMP/o7.txt"
echo running >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana --sem-enviar-arquivo sim >/dev/null 2>&1

echo "desligar: gancho e denyTools somem, o resto fica"
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao --escrita-livre >"$TMP/o8.txt" 2>&1
igual "desligar sai com 0" "0" "$?"
afirma "denyTools so tem o que o dono pos por fora (WebFetch)" jq -e '.config.denyTools == ["WebFetch"]' "$RJ"
afirma "os envios de arquivo voltaram aos allowTools" jq -e '(.config.allowTools | index("mcp__dgchat__send_file")) != null and (.config.allowTools | index("mcp__dgchat__whatsapp_send_file")) != null' "$RJ"
afirma "o gancho de escrita saiu do settings.json" jq -e '(.hooks.PreToolUse // []) | length == 0' "$ST"
afirma "a linha alheia continua" jq -e '.minhaLinha == "do-aluno" and .hooks.PostToolUse[0].hooks[0].command == "echo alheio"' "$ST"
afirma "o arquivo guarda o estado desligado" jq -e '.sem_bash == false and .sem_enviar_arquivo == false and .escrita_so_em == null' "$RS"
afirma "o mostrar diz liberado" bash -c "'$CLI' agente restricoes ana | grep -q 'qualquer lugar'"
cp "$RJ" "$TMP/rj-1.json"; cp "$ST" "$TMP/st-1.json"
dgclaw agente restricoes ana --escrita-livre >/dev/null 2>&1
igual "desligar de novo e idempotente (runner.json)" "" "$(diff "$TMP/rj-1.json" "$RJ")"
igual "desligar de novo e idempotente (settings.json)" "" "$(diff "$TMP/st-1.json" "$ST")"

echo "Codex: avisa e registra que a trava ainda nao vale"
dgclaw agente restricoes beto --sem-bash sim >"$TMP/o9.txt" 2>&1
igual "no Codex o comando grava e sai com 0" "0" "$?"
afirma "avisa que no Codex as travas ainda nao valem" grep -q 'no Codex estas travas ainda NAO valem' "$TMP/o9.txt"
afirma "registra em log" grep -q 'provedor codex-cli' "$LIB/agentes/beto/restricoes.log"
afirma "o arquivo ficou guardado" jq -e '.sem_bash == true' "$(R_DIR beto)/restricoes.json"

echo "ensaio: nao grava nada"
rm -f "$(R_DIR beto)/restricoes.json"
dgclaw --ensaio agente restricoes beto --sem-bash sim >/dev/null 2>&1
nega "o ensaio nao criou o arquivo" test -e "$(R_DIR beto)/restricoes.json"

fim
