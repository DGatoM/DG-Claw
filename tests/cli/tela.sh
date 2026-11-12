#!/usr/bin/env bash
# A senha da Tela do agente: nasce no `agente criar`, aparece uma vez, nao e sobrescrita
# e pode ser trocada com `agente tela-senha`. O gravador do rfbauth e o de mentira.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

H="$DGCLAW_RAIZ/var/lib/dgclaw/agentes/ana/home"
V="$H/.dgclaw/tela/vnc.senha"
RECEBIDAS="$STUB_ESTADO/tela-senhas-recebidas"
FORMATO='^[A-HJ-NP-Za-km-z2-9]{8}$'

echo "tela: criar grava a senha"
criar_agente ana --nome "Ana"
igual "o criar termina com 0" "0" "$?"
afirma "o arquivo da senha existe" test -s "$V"
igual "arquivo da senha com modo 600" "600" "$(stat -c %a "$V")"
igual "pasta da tela com modo 700" "700" "$(stat -c %a "$H/.dgclaw/tela")"
afirma "dono da senha e o do agente (uid 1001001)" bash -c "stat -c %u '$V' | grep -q 1001001 || grep -q '^1001001:1001001 $V' '$DGCLAW_RAIZ/.chown-simulado'"
igual "o gravador recebeu uma unica senha" "1" "$(wc -l <"$RECEBIDAS" | tr -d ' ')"
SENHA="$(head -1 "$RECEBIDAS")"
if [[ "$SENHA" =~ $FORMATO ]]; then ok "a senha tem 8 caracteres do alfabeto sem ambiguos"; else mal "a senha tem 8 caracteres do alfabeto sem ambiguos (veio '$SENHA')"; fi
igual "a senha aparece uma vez na saida do criar" "1" "$(grep -oF "$SENHA" "$TMP/saida.txt" | wc -l | tr -d ' ')"
afirma "o bloco diz para anotar e onde trocar" grep -q "aba Tela" "$TMP/saida.txt"

echo "tela: a senha nao vaza"
vazou=0
grep -qF "$SENHA" "$STUB_LOG" && vazou=1
[ ! -f "$STUB_LOG.stdin" ] || { grep -qF "$SENHA" "$STUB_LOG.stdin" && vazou=1; }
grep -rqF "$SENHA" "$DGCLAW_RAIZ" && vazou=1
igual "nem no argv do podman, nem no agentes.json, nem em arquivo da raiz" "0" "$vazou"

echo "tela: criar de novo nao sobrescreve"
antes="$(md5sum <"$V")"
criar_agente ana --nome "Ana"
igual "o arquivo da senha nao mudou" "$antes" "$(md5sum <"$V")"
igual "o gravador nao foi chamado de novo" "1" "$(wc -l <"$RECEBIDAS" | tr -d ' ')"
nega "a segunda execucao nao mostra senha nenhuma" grep -q "SENHA DA TELA" "$TMP/saida.txt"

echo "tela: --ensaio so descreve"
preparar
dgclaw --ensaio agente criar bia --nome "Bia" >"$TMP/ensaio.txt" 2>&1
igual "o ensaio sai com 0" "0" "$?"
nega "o ensaio nao grava senha" test -e "$DGCLAW_RAIZ/var/lib/dgclaw/agentes/bia"
nega "o ensaio nao chama o gravador" test -e "$STUB_ESTADO/tela-senhas-recebidas"
afirma "o ensaio descreve a senha da Tela" grep -q "rfbauth" "$TMP/ensaio.txt"

echo "tela: agente tela-senha"
preparar
RECEBIDAS="$STUB_ESTADO/tela-senhas-recebidas"
H="$DGCLAW_RAIZ/var/lib/dgclaw/agentes/ana/home"
V="$H/.dgclaw/tela/vnc.senha"
criar_agente ana --nome "Ana"
printf '%s\n' "Nova1234" | dgclaw agente tela-senha ana >"$TMP/o.txt" 2>&1
igual "senha nova aceita" "0" "$?"
igual "o gravador recebeu a senha nova" "Nova1234" "$(tail -1 "$RECEBIDAS")"
igual "arquivo continua com modo 600" "600" "$(stat -c %a "$V")"
nega "a senha nova nao aparece na saida" grep -q "Nova1234" "$TMP/o.txt"
nega "a senha nova nao aparece no log do podman" grep -q "Nova1234" "$STUB_LOG"
printf '%s\n' "curta" | dgclaw agente tela-senha ana >"$TMP/o.txt" 2>&1
igual "senha curta recusada com codigo 1" "1" "$?"
afirma "a recusa diz que o tamanho e de 6 a 8" grep -q "6 a 8" "$TMP/o.txt"
dgclaw agente tela-senha fantasma </dev/null >"$TMP/o.txt" 2>&1
igual "agente desconhecido recusado" "1" "$?"
afirma "o erro diz o que fazer" grep -q "dgclaw agente listar" "$TMP/o.txt"

echo "tela: sem o gravador de verdade o erro diz o arquivo"
APP_SEM_TELA="$TMP/app-sem-tela"
mkdir -p "$APP_SEM_TELA/bin"
cp "$CLI" "$APP_SEM_TELA/bin/dgclaw"
cp -r "$(dirname "$CLI")/../lib" "$APP_SEM_TELA/lib"
printf '%s\n' "Nova1234" | env -u DGCLAW_TELA_SENHA_CMD "$APP_SEM_TELA/bin/dgclaw" agente tela-senha ana >"$TMP/o.txt" 2>&1
igual "sem o gravador: sai com 1" "1" "$?"
afirma "sem o gravador: cita panel/bin/tela-senha.js" grep -q "panel/bin/tela-senha.js" "$TMP/o.txt"

if command -v node >/dev/null && [ -f "$REPO/panel/bin/tela-senha.js" ]; then
echo "tela: com o gravador de verdade (panel/bin/tela-senha.js)"
printf '%s\n' "Real1234" | env -u DGCLAW_TELA_SENHA_CMD "$CLI" agente tela-senha ana >"$TMP/o.txt" 2>&1
igual "gravador real: sai com 0" "0" "$?"
igual "gravador real: rfbauth de 8 bytes com modo 600" "8 600" "$(stat -c '%s %a' "$V")"
nega "gravador real: a senha nao fica em texto puro no arquivo" grep -q "Real1234" "$V"
nega "gravador real: a senha nao aparece na saida" grep -q "Real1234" "$TMP/o.txt"
fi

fim
