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
dgclaw agente restricoes ana --escrita-so-em .dgclaw >"$TMP/o2.txt" 2>&1; igual "pasta que comeca por ponto (1)" "1" "$?"
afirma "explica a pasta com ponto" grep -q 'comeca por ponto' "$TMP/o2.txt"
dgclaw agente restricoes ana --escrita-so-em ok,.claude/skills >"$TMP/o2.txt" 2>&1; igual "subpasta de .claude no meio da lista (1)" "1" "$?"
nega "e nada foi gravado" test -e "$RS"
dgclaw agente restricoes ana --escrita-so-em x --escrita-livre >"$TMP/o2.txt" 2>&1; igual "so-em com livre (1)" "1" "$?"
dgclaw agente restricoes ana --foo >"$TMP/o2.txt" 2>&1; igual "opcao desconhecida (1)" "1" "$?"
nega "nada foi gravado pelas recusas" test -e "$RS"
mkdir -p "$LIB/agentes/ana/home/arquivo-solto"; ln -s /etc "$LIB/agentes/ana/home/atalho"
dgclaw agente restricoes ana --escrita-so-em atalho >"$TMP/o2.txt" 2>&1; igual "pasta que e atalho (1)" "1" "$?"
afirma "explica o atalho" grep -q 'e um atalho' "$TMP/o2.txt"
rm -f "$LIB/agentes/ana/home/atalho"

echo "definir as tres restricoes"
marcar_settings_alheio ana
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim --sem-enviar-arquivo sim --escrita-so-em relatorios,rascunhos/2026/ >"$TMP/o3.txt" 2>&1
igual "definir sai com 0" "0" "$?"
afirma "o restricoes.json esta no formato combinado" jq -e '.versao == 1 and .sem_bash == true and .sem_enviar_arquivo == true and .escrita_so_em == ["rascunhos/2026","relatorios"] and (.atualizado_em | test("^[0-9]{4}-")) and (.atualizado_por | length > 0)' "$RS"
igual "restricoes.json com modo 444" "444" "$(stat -c %a "$RS")"
afirma "as pastas foram criadas DENTRO da caixa, pelo usuario agente, sem shell" grep -qx 'podman exec -u agente dgclaw-ana mkdir -p -- /home/agente/relatorios' "$STUB_LOG"
afirma "a subpasta tambem" grep -qx 'podman exec -u agente dgclaw-ana mkdir -p -- /home/agente/rascunhos/2026' "$STUB_LOG"
nega "o root nao criou pasta na casa do agente" test -e "$LIB/agentes/ana/home/relatorios"
nega "e nao deu dono como root a nada da casa" grep -q 'relatorios\|rascunhos' "$DGCLAW_RAIZ/.chown-simulado"
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
afirma "fora das travas, o runner.json e o padrao de sempre" bash -c "[ \"\$(jq -cS 'del(.restricoesAplicadas) | .config |= (del(.denyTools) | .allowTools = [\"mcp__dgchat__reply\",\"mcp__dgchat__send_file\",\"mcp__dgchat__whatsapp_reply\",\"mcp__dgchat__whatsapp_send_file\"])' '$RJ')\" = \"\$(jq -cS . '$TMP/ref.json')\" ]"

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
afirma "o gancho continua na configuracao administrada" jq -e '[.hooks.PreToolUse[]?.hooks[]?] | length == 1' "$(R_DIR ana)/managed-settings.json"
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
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao >"$TMP/o7.txt" 2>&1
afirma "avisa que o Bash ligado fura a trava de pastas" grep -q 'continua com o Bash ligado' "$TMP/o7.txt"
afirma "e manda combinar com --sem-bash sim" grep -q -- '--sem-bash sim' "$TMP/o7.txt"
dgclaw agente restricoes ana --sem-bash sim --sem-enviar-arquivo sim >/dev/null 2>&1

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
afirma "o gancho de escrita saiu da configuracao administrada" jq -e '((.hooks.PreToolUse // []) | length == 0) and ((.permissions.deny // []) | length == 0)' "$(R_DIR ana)/managed-settings.json"
afirma "a linha alheia continua" jq -e '.minhaLinha == "do-aluno" and .hooks.PostToolUse[0].hooks[0].command == "echo alheio"' "$ST"
afirma "o arquivo guarda o estado desligado" jq -e '.sem_bash == false and .sem_enviar_arquivo == false and .escrita_so_em == null' "$RS"
afirma "o mostrar diz liberado" bash -c "'$CLI' agente restricoes ana | grep -q 'qualquer lugar'"
cp "$RJ" "$TMP/rj-1.json"; cp "$ST" "$TMP/st-1.json"
dgclaw agente restricoes ana --escrita-livre >/dev/null 2>&1
igual "desligar de novo e idempotente (runner.json)" "" "$(diff "$TMP/rj-1.json" "$RJ")"
igual "desligar de novo e idempotente (settings.json)" "" "$(diff "$TMP/st-1.json" "$ST")"

echo "migracao: o gancho antigo no settings.json da casa sai"
jq '.hooks.PreToolUse = [{matcher: "Write", hooks: [{type: "command", command: "node /opt/dgclaw/app/scripts/escrita-restrita-hook.mjs"}]}]' "$ST" >"$ST.novo" && mv -f "$ST.novo" "$ST" && chmod 444 "$ST"
dgclaw agente restricoes ana --escrita-so-em relatorios >/dev/null 2>&1
nega "o gancho antigo foi tirado do settings.json" grep -q 'escrita-restrita-hook' "$ST"
afirma "a linha alheia continua" jq -e '.minhaLinha == "do-aluno"' "$ST"
dgclaw agente restricoes ana --escrita-livre >/dev/null 2>&1

echo "o agente nao desliga o gancho: ele fica na configuracao administrada, fora da casa"
dgclaw agente restricoes ana --sem-bash sim --escrita-so-em relatorios >/dev/null 2>&1
echo '{"disableAllHooks": true}' >"$LIB/agentes/ana/home/.claude/settings.local.json"
dgclaw agente reparar ana >/dev/null 2>&1
afirma "o gancho segue na configuracao administrada" jq -e '[.hooks.PreToolUse[]?.hooks[]?] | length == 1' "$(R_DIR ana)/managed-settings.json"
igual "o settings.local.json do agente nao foi tocado" '{"disableAllHooks": true}' "$(cat "$LIB/agentes/ana/home/.claude/settings.local.json")"
afirma "a imagem liga /etc/claude-code/managed-settings.json ao arquivo do runner" grep -q 'ln -s /etc/dgclaw-runner/managed-settings.json /etc/claude-code/managed-settings.json' "$REPO/container/Containerfile"
dgclaw agente restricoes ana --sem-bash nao --escrita-livre >/dev/null 2>&1
rm -f "$LIB/agentes/ana/home/.claude/settings.local.json"

echo "sem restricao: managed-settings.json vazio (nada muda para quem nao usa)"
criar_agente duda --nome "Duda"
igual "managed-settings.json de agente sem restricao e {}" "{}" "$(jq -c . "$(R_DIR duda)/managed-settings.json")"
igual "e nao e escrito de novo (mesmo conteudo) ao reparar" "$(sha256sum <"$(R_DIR duda)/managed-settings.json")" "$(dgclaw agente reparar duda >/dev/null 2>&1; sha256sum <"$(R_DIR duda)/managed-settings.json")"

echo "denyTools do dono sem restricoes.json: o aplicar nao toca"
criar_agente carla --nome "Carla"
RJC="$(R_DIR carla)/runner.json"
jq '.config.denyTools = ["Bash", "WebFetch"] | .config.allowTools -= ["mcp__dgchat__send_file"]' "$RJC" >"$RJC.novo" && mv -f "$RJC.novo" "$RJC" && chmod 444 "$RJC"
cp "$RJC" "$TMP/rjc-dono.json"
dgclaw agente reparar carla >/dev/null 2>&1; igual "reparar sem restricoes.json deixa allow e deny do dono" "" "$(diff "$TMP/rjc-dono.json" "$RJC")"
dgclaw agente restricoes carla --sem-bash sim --sem-enviar-arquivo sim >/dev/null 2>&1
afirma "o runner.json registra o que o mecanismo acrescentou e tirou" jq -e '.restricoesAplicadas.deny | index("BashOutput") != null and index("Bash") == null' "$RJC"
dgclaw agente restricoes carla --sem-bash nao --sem-enviar-arquivo nao >/dev/null 2>&1
afirma "desligar tira so o que o mecanismo pos: o Bash do dono fica" jq -e '.config.denyTools == ["Bash", "WebFetch"] and (.config.allowTools | index("mcp__dgchat__whatsapp_send_file") != null) and (has("restricoesAplicadas") | not)' "$RJC"
afirma "o send_file que o dono ja tinha tirado nao volta" jq -e '.config.allowTools | index("mcp__dgchat__send_file") == null' "$RJC"

echo "criar de novo com restricoes.json invalido: nada muda (nem um runner.json permissivo)"
cp "$RJ" "$TMP/rj-antes-criar.json"; cp "$(R_DIR ana)/managed-settings.json" "$TMP/ms-antes-criar.json"
dgclaw agente restricoes ana --sem-bash sim --sem-enviar-arquivo sim --escrita-so-em relatorios >/dev/null 2>&1
cp "$RJ" "$TMP/rj-antes-criar.json"; cp "$(R_DIR ana)/managed-settings.json" "$TMP/ms-antes-criar.json"
cp "$RS" "$TMP/rs-bom.json"; printf '{"versao": 1,' >"$RS"
criar_agente ana --nome "Ana"; nega "criar de novo falha" test "$?" -eq 0
igual "o runner.json continua restrito, byte a byte" "" "$(diff "$TMP/rj-antes-criar.json" "$RJ")"
igual "a configuracao administrada continua, byte a byte" "" "$(diff "$TMP/ms-antes-criar.json" "$(R_DIR ana)/managed-settings.json")"
cp "$TMP/rs-bom.json" "$RS"; chmod 444 "$RS"
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao --escrita-livre >/dev/null 2>&1

echo "atalho no caminho: nao grava como root fora da casa"
FORA="$TMP/fora-da-casa"; mkdir -p "$FORA"
mv "$LIB/agentes/ana/home/.claude" "$LIB/agentes/ana/home/.claude.real"; ln -s "$FORA" "$LIB/agentes/ana/home/.claude"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o10.txt" 2>&1; nega "restricoes com .claude virado atalho falha" test "$?" -eq 0
afirma "diz que e um link" grep -q 'e um link' "$TMP/o10.txt"
dgclaw agente reparar ana >"$TMP/o10.txt" 2>&1; nega "reparar com .claude virado atalho falha" test "$?" -eq 0
igual "nada foi gravado fora da casa" "" "$(ls -A "$FORA")"
rm "$LIB/agentes/ana/home/.claude"; mv "$LIB/agentes/ana/home/.claude.real" "$LIB/agentes/ana/home/.claude"
mkdir -p "$FORA/x"; ln -s "$FORA" "$LIB/agentes/ana/home/pai-atalho"
dgclaw agente restricoes ana --sem-bash nao --escrita-so-em pai-atalho/x >"$TMP/o10.txt" 2>&1; nega "pasta liberada por tras de atalho falha" test "$?" -eq 0
afirma "explica o atalho" grep -q 'e um atalho' "$TMP/o10.txt"
rm "$LIB/agentes/ana/home/pai-atalho"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1

echo "agente parado: nao cria pasta, avisa, e o gancho aceita pasta que ainda nao existe"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim --escrita-so-em relatorios,pasta-nova >"$TMP/o11.txt" 2>&1
igual "com o agente parado o comando funciona (0)" "0" "$?"
nega "nao tentou criar pasta" grep -q 'mkdir' "$STUB_LOG"
afirma "avisa que o agente cria ao gravar" grep -q 'pasta-nova.*cria\|cria.*pasta-nova' "$TMP/o11.txt"
nega "e nao criou nada na casa" test -e "$LIB/agentes/ana/home/pasta-nova"
echo running >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana --sem-bash nao --escrita-livre >/dev/null 2>&1

echo "gravacao que falha: o comando falha, nao anuncia sucesso e nao deixa meia mudanca"
FALSO="$TMP/falso-bin"; mkdir -p "$FALSO"
printf '#!/bin/sh\ncase "$*" in *managed-settings.json*) echo "mv: falha simulada" >&2; exit 1;; esac\nexec /bin/mv "$@"\n' >"$FALSO/mv"; chmod +x "$FALSO/mv"
cp "$RJ" "$TMP/rj-antes-falha.json"
PATH="$FALSO:$PATH" dgclaw agente restricoes ana --sem-bash sim >"$TMP/o12.txt" 2>&1; rc=$?
nega "sai com codigo diferente de 0" test "$rc" -eq 0
nega "nao diz que aplicou" grep -qi 'aplicad\|restricoes do agente ana gravadas\|runner do agente ana reiniciado' "$TMP/o12.txt"
afirma "diz o que falhou" grep -q 'Nao deu certo' "$TMP/o12.txt"
igual "o runner.json nao foi mexido (a politica administrada vem primeiro)" "" "$(diff "$TMP/rj-antes-falha.json" "$RJ")"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1

echo "duas alteracoes ao mesmo tempo nao se apagam (trava por agente)"
for i in 1 2 3 4 5 6; do
    dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao --escrita-livre >/dev/null 2>&1
    dgclaw agente restricoes ana --sem-bash sim >"$TMP/p1.txt" 2>&1 &
    pa=$!
    dgclaw agente restricoes ana --escrita-so-em relatorios >"$TMP/p2.txt" 2>&1 &
    pb=$!
    wait "$pa" "$pb"
    if jq -e '.sem_bash == true and .escrita_so_em == ["relatorios"]' "$RS" >/dev/null 2>&1 \
        && jq -e '(.config.denyTools | index("Bash")) != null' "$(R_DIR ana)/runner.json" >/dev/null 2>&1 \
        && jq -e '(.hooks.PreToolUse | length) == 1' "$(R_DIR ana)/managed-settings.json" >/dev/null 2>&1; then
        ok "rodada $i: as duas mudancas ficaram no arquivo e no runner.json"
    else
        mal "rodada $i: uma mudanca apagou a outra"
    fi
done
afirma "a trava fica na pasta do agente, fora da casa" test -e "$LIB/agentes/ana/.restricoes.lock"
nega "e nao dentro da casa" test -e "$LIB/agentes/ana/home/.restricoes.lock"
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao --escrita-livre >/dev/null 2>&1

echo "Codex: avisa e registra que a trava ainda nao vale"
dgclaw agente restricoes beto --sem-bash sim >"$TMP/o9.txt" 2>&1
igual "no Codex o comando grava e sai com 0" "0" "$?"
afirma "avisa que no Codex as travas ainda nao valem" grep -q 'no Codex estas travas ainda NAO valem' "$TMP/o9.txt"
afirma "registra em log" grep -q 'provedor codex-cli' "$LIB/agentes/beto/restricoes.log"
afirma "o arquivo ficou guardado" jq -e '.sem_bash == true' "$(R_DIR beto)/restricoes.json"

echo "enviar arquivo travado exige o terminal travado (com o Bash ele fala direto com a ponte do WhatsApp)"
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao --escrita-livre >/dev/null 2>&1
cp "$RS" "$TMP/rs-antes-combo.json"
dgclaw agente restricoes ana --sem-enviar-arquivo sim >"$TMP/o13.txt" 2>&1; rc=$?
nega "travar o envio com o Bash liberado e recusado" test "$rc" -eq 0
afirma "diz o porque (o terminal manda o arquivo por fora das ferramentas)" grep -q 'por fora das ferramentas' "$TMP/o13.txt"
afirma "e o que fazer (--sem-bash sim)" grep -q -- '--sem-bash sim' "$TMP/o13.txt"
igual "nada foi gravado pela recusa" "" "$(diff "$TMP/rs-antes-combo.json" "$RS")"
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo sim >/dev/null 2>&1; nega "as duas opcoes na mesma chamada, Bash liberado, tambem recusa" test "$?" -eq 0
dgclaw agente restricoes ana --sem-bash sim --sem-enviar-arquivo sim >/dev/null 2>&1; igual "travar os dois de uma vez funciona" "0" "$?"
dgclaw agente restricoes ana --sem-bash nao >"$TMP/o13.txt" 2>&1; nega "devolver o Bash com o envio ainda travado e recusado" test "$?" -eq 0
afirma "o arquivo continua com os dois travados" jq -e '.sem_bash == true and .sem_enviar_arquivo == true' "$RS"
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao >/dev/null 2>&1; igual "devolver os dois de uma vez funciona" "0" "$?"
printf '{"versao": 1, "sem_bash": false, "sem_enviar_arquivo": true}' >"$RS"; chmod 444 "$RS"
dgclaw agente reparar ana >"$TMP/o13.txt" 2>&1; nega "restricoes.json editado a mao com a combinacao proibida falha" test "$?" -eq 0
afirma "explica o motivo no arquivo" grep -q 'por fora das ferramentas' "$TMP/o13.txt"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1; igual "o proprio comando consegue consertar o arquivo" "0" "$?"
afirma "e o arquivo ficou valido" jq -e '.sem_bash == true and .sem_enviar_arquivo == true' "$RS"
dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao --escrita-livre >/dev/null 2>&1

echo "migracao: o root nao le nem grava nada na casa do agente (corrida de atalho em .claude)"
# O jq de mentira troca .claude por um atalho para uma pasta de fora logo depois de o root ler o settings.json:
# com o codigo antigo o root grava la; com o novo ele nunca encosta no arquivo.
HOMEANA="$LIB/agentes/ana/home"
jq '.hooks.PreToolUse = [{matcher: "Write", hooks: [{type: "command", command: "node /opt/dgclaw/app/scripts/escrita-restrita-hook.mjs"}]}]' "$ST" >"$ST.novo" && mv -f "$ST.novo" "$ST" && chmod 444 "$ST"
FORA2="$TMP/fora-corrida"; mkdir -p "$FORA2"
JQFALSO="$TMP/jq-corrida"; mkdir -p "$JQFALSO"
cat >"$JQFALSO/jq" <<EOS
#!/bin/sh
/usr/bin/jq "\$@"; rc=\$?
case "\$*" in *limpa*"$HOMEANA/.claude/settings.json") if [ ! -L "$HOMEANA/.claude" ]; then mv "$HOMEANA/.claude" "$TMP/claude-real" && ln -s "$FORA2" "$HOMEANA/.claude"; fi ;; esac
exit \$rc
EOS
chmod +x "$JQFALSO/jq"
touch "$STUB_ESTADO/exec-node-nao"
: >"$STUB_LOG"
PATH="$JQFALSO:$PATH" dgclaw agente restricoes ana --sem-bash sim >"$TMP/o14.txt" 2>&1
[ -L "$HOMEANA/.claude" ] && { rm "$HOMEANA/.claude"; mv "$TMP/claude-real" "$HOMEANA/.claude"; }
igual "nada foi gravado fora da casa" "" "$(ls -A "$FORA2")"
afirma "a migracao foi pedida ao usuario agente, dentro da caixa, sem shell" grep -q '^podman exec --user agente dgclaw-ana node -e ' "$STUB_LOG"
rm -f "$STUB_ESTADO/exec-node-nao"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1
dgclaw agente reparar ana >/dev/null 2>&1
nega "rodando de verdade dentro da caixa, o gancho antigo sai" grep -q 'escrita-restrita-hook' "$ST"
afirma "e a linha alheia continua" jq -e '.minhaLinha == "do-aluno"' "$ST"

echo "migracao com o agente parado: guarda a pendencia, avisa, e conclui quando ele ligar"
PEND_MIG="$(R_DIR ana)/restricoes-migracao.pendente"
jq '.hooks.PreToolUse = [{matcher: "Write", hooks: [{type: "command", command: "node /opt/dgclaw/app/scripts/escrita-restrita-hook.mjs"}]}]' "$ST" >"$ST.novo" && mv -f "$ST.novo" "$ST" && chmod 444 "$ST"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o15.txt" 2>&1; igual "parado: o comando funciona (0)" "0" "$?"
afirma "o gancho antigo ainda esta la (o root nao mexe)" grep -q 'escrita-restrita-hook' "$ST"
afirma "a pendencia da migracao ficou guardada" test -e "$PEND_MIG"
afirma "avisa que sai quando o agente ligar e o comando rodar de novo" grep -q 'gancho antigo' "$TMP/o15.txt"
echo running >"$STUB_ESTADO/c-dgclaw-ana"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1
nega "ligado, o comando de novo tira o gancho antigo" grep -q 'escrita-restrita-hook' "$ST"
nega "e a pendencia some" test -e "$PEND_MIG"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1

echo "reinicio que falha nao e esquecido (marcador de pendencia, so do root)"
PEND="$(R_DIR ana)/restricoes.pendente"
touch "$STUB_ESTADO/restart-falha"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o16.txt" 2>&1; nega "restart falhou: o comando falha" test "$?" -eq 0
afirma "o marcador de pendencia ficou" test -e "$PEND"
igual "marcador do root, so ele grava" "0:0" "$(stat -c %u:%g "$PEND" 2>/dev/null || echo 0:0)"
rm -f "$STUB_ESTADO/restart-falha"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim >"$TMP/o16.txt" 2>&1; igual "mesmo comando de novo (arquivos iguais) sai com 0" "0" "$?"
afirma "e reiniciou o runner por causa da pendencia" grep -q 'exec dgclaw-ana systemctl restart dgclaw-runner' "$STUB_LOG"
nega "o marcador saiu depois do restart e do is-active" test -e "$PEND"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash sim >/dev/null 2>&1
nega "sem pendencia e sem mudanca, nao reinicia" grep -q 'systemctl restart' "$STUB_LOG"
touch "$STUB_ESTADO/inativo"
dgclaw agente restricoes ana --sem-bash nao >"$TMP/o16.txt" 2>&1; nega "restart ok mas o runner nao fica active: falha" test "$?" -eq 0
afirma "diz que o runner nao esta active" grep -q 'active' "$TMP/o16.txt"
afirma "e o marcador continua" test -e "$PEND"
rm -f "$STUB_ESTADO/inativo"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
: >"$STUB_LOG"
dgclaw agente restricoes ana --sem-bash nao >/dev/null 2>&1; igual "com o agente parado o comando funciona" "0" "$?"
nega "parado: o marcador sai (o runner le tudo ao subir)" test -e "$PEND"
echo running >"$STUB_ESTADO/c-dgclaw-ana"

echo "ensaio: nao grava nada"
rm -f "$(R_DIR beto)/restricoes.json"
dgclaw --ensaio agente restricoes beto --sem-bash sim >/dev/null 2>&1
nega "o ensaio nao criou o arquivo" test -e "$(R_DIR beto)/restricoes.json"

fim
