#!/usr/bin/env bash
# A Tela sempre presente: `agente tela` (a conferencia vista do servidor), o aviso de "senha da
# Tela nao definida" no reparar/recriar (que NAO inventa senha) e a lista no resumo do atualizar.
# O podman e o de mentira (tests/cli/stubs/podman): marcadores em $STUB_ESTADO simulam o que falta.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
export DGCLAW_TEMPO_PARADA=3

criar_agente ana --nome "Ana"
H="$LIB/agentes/ana/home"
V="$H/.dgclaw/tela/vnc.senha"
tela() { dgclaw agente tela "$@" >"$TMP/t.txt" 2>&1; }

echo "agente tela: tudo certo"
tela ana
igual "sai com 0" "0" "$?"
afirma "diz que a senha esta definida" grep -q "a senha da Tela esta definida" "$TMP/t.txt"
afirma "diz que o noVNC responde" grep -q "noVNC (websockify) responde" "$TMP/t.txt"
afirma "diz que o CDP responde" grep -q "CDP em 127.0.0.1:9222" "$TMP/t.txt"
afirma "diz que a Tela esta pronta" grep -q "esta pronta" "$TMP/t.txt"
afirma "diz que o navegador e o Google Chrome" grep -q "navegador da Tela: Google Chrome" "$TMP/t.txt"

echo "agente tela: navegador alternativo (arm64)"
touch "$STUB_ESTADO/sem-chrome"
tela ana
igual "ainda sai com 0 (o Chromium e um jeito valido)" "0" "$?"
afirma "avisa que e o Chromium do Playwright" grep -q "Chromium do Playwright" "$TMP/t.txt"
rm -f "$STUB_ESTADO/sem-chrome"

echo "agente tela: senha nao definida"
mv "$V" "$TMP/vnc.senha.guardada"
touch "$STUB_ESTADO/inativo-dgclaw-tela-vnc"
tela ana
igual "sai com 1" "1" "$?"
afirma "diz que a senha nao foi definida" grep -q "FALTA .*senha da Tela ainda nao foi definida" "$TMP/t.txt"
afirma "diz o comando tela-senha" grep -q "dgclaw agente tela-senha ana" "$TMP/t.txt"
nega "nao acusa o VNC parado quando a causa e a senha" grep -q "VNC (dgclaw-tela-vnc.service) esta parado" "$TMP/t.txt"
mv "$TMP/vnc.senha.guardada" "$V"

echo "agente tela: x11vnc parado com a senha presente"
tela ana
igual "sai com 1" "1" "$?"
afirma "acusa o VNC parado e diz como reiniciar" grep -q "systemctl restart dgclaw-tela-vnc" "$TMP/t.txt"
rm -f "$STUB_ESTADO/inativo-dgclaw-tela-vnc"

echo "agente tela: noVNC e CDP"
touch "$STUB_ESTADO/sem-novnc" "$STUB_ESTADO/sem-cdp"
tela ana
igual "sai com 1" "1" "$?"
afirma "acusa o noVNC sem resposta" grep -q "FALTA .*noVNC" "$TMP/t.txt"
afirma "acusa o CDP sem resposta" grep -q "FALTA .*127.0.0.1:9222" "$TMP/t.txt"
igual "duas faltas contadas" "2" "$(grep -c '^  FALTA' "$TMP/t.txt")"
rm -f "$STUB_ESTADO/sem-novnc" "$STUB_ESTADO/sem-cdp"

echo "agente tela: imagem sem a Tela"
touch "$STUB_ESTADO/sem-tela"
tela ana
igual "sai com 1" "1" "$?"
afirma "diz que a imagem nao tem a Tela e como recriar" grep -q "dgclaw agente recriar ana --forcar" "$TMP/t.txt"
rm -f "$STUB_ESTADO/sem-tela"

echo "agente tela: casos de erro"
echo exited >"$STUB_ESTADO/c-dgclaw-ana"
tela ana
igual "agente desligado: sai com 2" "2" "$?"
afirma "diz como ligar" grep -q "dgclaw agente iniciar ana" "$TMP/t.txt"
echo running >"$STUB_ESTADO/c-dgclaw-ana"
tela fantasma
igual "agente desconhecido: sai com 1" "1" "$?"
afirma "o erro diz o que fazer" grep -q "dgclaw agente listar" "$TMP/t.txt"
tela
igual "sem slug: sai com 1" "1" "$?"

echo "recriar e reparar: avisam da senha sem inventar uma"
rm -f "$V"
: >"$STUB_ESTADO/tela-senhas-recebidas"
echo imagem-v9 >"$STUB_ESTADO/imagem-id"
dgclaw agente recriar ana >"$TMP/rec.txt" 2>&1
igual "recriar sai com 0" "0" "$?"
afirma "avisa que a senha da Tela nao foi definida" grep -q "senha da Tela do agente ana ainda nao foi definida" "$TMP/rec.txt"
afirma "diz como definir (painel e comando)" bash -c "grep -q 'aba Tela do painel' '$TMP/rec.txt' && grep -q 'dgclaw agente tela-senha ana' '$TMP/rec.txt'"
nega "nao criou senha escondida" test -e "$V"
igual "o gravador de senha nao foi chamado" "0" "$(wc -c <"$STUB_ESTADO/tela-senhas-recebidas" | tr -d ' ')"
dgclaw agente reparar ana >"$TMP/rep.txt" 2>&1
igual "reparar sai com 0" "0" "$?"
afirma "reparar tambem avisa" grep -q "senha da Tela do agente ana ainda nao foi definida" "$TMP/rep.txt"
nega "reparar tambem nao cria a senha" test -e "$V"

echo "reparar: com a senha definida, nao fala dela"
printf '%s\n' "Nova1234" | dgclaw agente tela-senha ana >/dev/null 2>&1
dgclaw agente reparar ana >"$TMP/rep.txt" 2>&1
nega "nenhum aviso de senha" grep -q "senha da Tela" "$TMP/rep.txt"

echo "reparar: imagem sem a Tela nao pede senha"
rm -f "$V"
touch "$STUB_ESTADO/sem-tela"
dgclaw agente reparar ana >"$TMP/rep.txt" 2>&1
nega "nenhum aviso de senha" grep -q "senha da Tela" "$TMP/rep.txt"
rm -f "$STUB_ESTADO/sem-tela"

echo "atualizar: o resumo com os agentes sem senha da Tela esta em tests/cli/atualizar.sh"

fim
