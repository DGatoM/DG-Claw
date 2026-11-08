#!/usr/bin/env bash
# A Tela do agente, sem construir imagem nem criar container:
#   1. as travas de seguranca das unidades (localhost, rfbauth, bind em 127.0.0.1, ConditionPathExists);
#   2. o lancador do navegador (Google Chrome se existir, senao o Chromium do Playwright);
#   3. o Containerfile nao aborta em arquitetura que nao e amd64 (texto, estrutura e o trecho
#      de instalacao executado com apt-get, python e dpkg de mentira).
# shellcheck disable=SC2016  # os printf geram scripts falsos: o $ e do script gerado, nao deste
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
U="$REPO/container/units"
LANCADOR="$REPO/bin/dgclaw-tela-navegador"
CF="$REPO/container/Containerfile"
FALHAS=0
TESTES=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok() { TESTES=$((TESTES + 1)); printf '  ok     %s\n' "$1"; }
mal() { TESTES=$((TESTES + 1)); FALHAS=$((FALHAS + 1)); printf '  FALHOU %s\n' "$1"; }
afirma() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else mal "$d"; fi; }
nega() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then mal "$d"; else ok "$d"; fi; }
igual() { if [ "$2" = "$3" ]; then ok "$1"; else mal "$1 (esperado '$2', veio '$3')"; fi; }
exec_de() { grep -E '^ExecStart=' "$1"; }

echo "unidades: o VNC so em localhost, com senha"
VNC="$U/dgclaw-tela-vnc.service"
for f in -localhost "-rfbauth /home/agente/.dgclaw/tela/vnc.senha" -forever -shared -xkb "-rfbport 5901"; do
    afirma "x11vnc tem '$f'" bash -c "$(declare -f exec_de); exec_de '$VNC' | grep -qF -- '$f'"
done
nega "x11vnc nao tem -nopw nem -passwd em texto" bash -c "grep -E '^ExecStart=' '$VNC' | grep -qE -- '-nopw|-passwd|-localhost no'"
afirma "a unidade do VNC so sobe com o arquivo da senha (ConditionPathExists)" grep -qx 'ConditionPathExists=/home/agente/.dgclaw/tela/vnc.senha' "$VNC"

echo "unidades: o noVNC e o CDP so em 127.0.0.1"
WEB="$U/dgclaw-tela-web.service"
afirma "websockify escuta em 127.0.0.1:6080 e fala com 127.0.0.1:5901" bash -c "grep -E '^ExecStart=' '$WEB' | grep -qF 'websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901'"
afirma "o Xvfb nao escuta TCP (-nolisten tcp)" bash -c "grep -E '^ExecStart=' '$U/dgclaw-tela.service' | grep -qF -- '-nolisten tcp'"
afirma "o lancador abre o CDP so em 127.0.0.1:9222" bash -c "grep -qF -- '--remote-debugging-address=127.0.0.1' '$LANCADOR' && grep -qF -- '--remote-debugging-port=9222' '$LANCADOR'"
nega "nada escuta em 0.0.0.0 nas unidades nem no lancador (fora dos comentarios)" bash -c "cat '$U'/dgclaw-tela* '$LANCADOR' | grep -v '^[[:space:]]*#' | grep -E '0\\.0\\.0\\.0|remote-debugging-address=(0|::)'"
nega "o lancador nao usa headless" grep -qE -- '--headless' "$LANCADOR"
afirma "a unidade do navegador chama o lancador" bash -c "grep -qx 'ExecStart=/usr/local/bin/dgclaw-tela-navegador' '$U/dgclaw-tela-chrome.service'"

echo "unidades: a troca de senha religa o VNC"
afirma "o .path usa PathChanged no arquivo da senha" grep -qx 'PathChanged=/home/agente/.dgclaw/tela/vnc.senha' "$U/dgclaw-tela-senha.path"
nega "o .path nao usa PathExists (dispararia sem parar)" grep -q '^PathExists=' "$U/dgclaw-tela-senha.path"
afirma "o servico da senha reinicia o VNC" grep -q 'systemctl restart --no-block dgclaw-tela-vnc.service' "$U/dgclaw-tela-senha.service"

echo "lancador: escolhe o navegador certo"
mkdir -p "$TMP/vazio" "$TMP/com-chrome" "$TMP/pw/chromium-1200/chrome-linux" "$TMP/pw64/chromium-1300/chrome-linux64" "$TMP/pw/chromium_headless_shell-1200/chrome-linux"
faz_falso() { printf '#!/bin/sh\necho "NAVEGADOR=%s"\nfor a in "$@"; do echo "ARG=$a"; done\n' "$1" >"$2"; chmod 755 "$2"; }
faz_falso google-chrome "$TMP/com-chrome/google-chrome-stable"
faz_falso chromium-playwright "$TMP/pw/chromium-1200/chrome-linux/chrome"
faz_falso headless-shell "$TMP/pw/chromium_headless_shell-1200/chrome-linux/chrome"
faz_falso chromium-playwright64 "$TMP/pw64/chromium-1300/chrome-linux64/chrome"
# PATH so com a pasta do teste: o google-chrome-stable de verdade da maquina nao interfere.
BASH_BIN="$(command -v bash)"
roda() { env -i HOME="$TMP/casa" PATH="$1" "${@:2}" "$BASH_BIN" "$LANCADOR"; }

saida="$(roda "$TMP/com-chrome" PLAYWRIGHT_BROWSERS_PATH="$TMP/pw" 2>"$TMP/err")"
igual "com google-chrome-stable no PATH: usa o Google Chrome" "NAVEGADOR=google-chrome" "$(printf '%s\n' "$saida" | head -1)"
afirma "passa o perfil na casa do agente" bash -c "printf '%s\n' '$saida' | grep -qx 'ARG=--user-data-dir=$TMP/casa/.tela-chrome'"
afirma "passa o CDP em 127.0.0.1:9222" bash -c "printf '%s\n' '$saida' | grep -qx 'ARG=--remote-debugging-address=127.0.0.1' && printf '%s\n' '$saida' | grep -qx 'ARG=--remote-debugging-port=9222'"
afirma "mantem --no-sandbox e as flags economicas" bash -c "printf '%s\n' '$saida' | grep -qx 'ARG=--no-sandbox' && printf '%s\n' '$saida' | grep -qx 'ARG=--disable-dev-shm-usage' && printf '%s\n' '$saida' | grep -qx 'ARG=--no-zygote'"
nega "nao passa --headless" bash -c "printf '%s\n' '$saida' | grep -q headless"
afirma "diz no log qual navegador abriu" grep -q "Google Chrome" "$TMP/err"

saida="$(roda "$TMP/vazio" PLAYWRIGHT_BROWSERS_PATH="$TMP/pw" 2>"$TMP/err")"
igual "sem Google Chrome: usa o Chromium do Playwright (chrome-linux)" "NAVEGADOR=chromium-playwright" "$(printf '%s\n' "$saida" | head -1)"
afirma "mesmo perfil e mesmo CDP no Chromium" bash -c "printf '%s\n' '$saida' | grep -qx 'ARG=--user-data-dir=$TMP/casa/.tela-chrome' && printf '%s\n' '$saida' | grep -qx 'ARG=--remote-debugging-address=127.0.0.1'"
afirma "diz no log que e o Chromium do Playwright" grep -q "Chromium do Playwright" "$TMP/err"
saida="$(roda "$TMP/vazio" PLAYWRIGHT_BROWSERS_PATH="$TMP/pw64" 2>/dev/null)"
igual "aceita a pasta chrome-linux64" "NAVEGADOR=chromium-playwright64" "$(printf '%s\n' "$saida" | head -1)"

roda "$TMP/vazio" PLAYWRIGHT_BROWSERS_PATH="$TMP/nada" >"$TMP/out" 2>"$TMP/err"
igual "sem nenhum navegador: sai com 78 (a unidade nao reinicia em laco)" "78" "$?"
afirma "o erro diz o que procurou e o que fazer" bash -c "grep -q 'nao achei nenhum navegador' '$TMP/err' && grep -q 'dgclaw imagem construir' '$TMP/err'"
afirma "a unidade nao reinicia com 78" grep -qx 'RestartPreventExitStatus=78' "$U/dgclaw-tela-chrome.service"

echo "Containerfile: nao aborta fora do amd64"
nega "nao tem mais a mensagem que abortava a construcao" grep -q 'ERRO: o Google Chrome estavel so tem pacote para amd64' "$CF"
nega "nenhuma linha sai com erro logo depois de checar a arquitetura amd64 na instalacao" bash -c "grep -B1 -A2 '= \"amd64\" \\]' '$CF' | grep -q 'construa sem COM_NAVEGADOR'"
# O trecho de instalacao (o primeiro RUN com COM_NAVEGADOR): vira um script e roda com programas de mentira.
awk '/^RUN if \[ "\$COM_NAVEGADOR" = "1" \]; then \\$/ {n++} n == 1 {print} n == 1 && !/\\$/ {exit}' "$CF" | sed '1s/^RUN //' >"$TMP/instala.sh"
afirma "achei o trecho de instalacao da Tela no Containerfile" test -s "$TMP/instala.sh"
mkdir -p "$TMP/falsos"
for c in apt-get python rm chmod curl gpg; do
    printf '#!/bin/sh\necho "%s $*" >> "%s/chamadas"\nexit 0\n' "$c" "$TMP"  >"$TMP/falsos/$c"; chmod 755 "$TMP/falsos/$c"
done
printf '#!/bin/sh\necho "${ARQUITETURA:-amd64}"\n' >"$TMP/falsos/dpkg"; chmod 755 "$TMP/falsos/dpkg"
: >"$TMP/chamadas"
env -i PATH="$TMP/falsos:/usr/bin:/bin" COM_NAVEGADOR=1 ARQUITETURA=arm64 "$BASH_BIN" -euo pipefail "$TMP/instala.sh" >/dev/null 2>"$TMP/err"
igual "arm64 com COM_NAVEGADOR=1: o trecho termina com 0" "0" "$?"
afirma "arm64: instala a Tela (xvfb, x11vnc, fluxbox, novnc, websockify)" grep -q 'apt-get install .*xvfb x11vnc fluxbox novnc websockify' "$TMP/chamadas"
afirma "arm64: instala o Chromium do Playwright" grep -q 'python -m playwright install --with-deps chromium' "$TMP/chamadas"
nega "arm64: nao tenta instalar o Google Chrome" grep -q 'google-chrome' "$TMP/chamadas"
afirma "arm64: avisa que a Tela vai usar o Chromium" grep -q 'Chromium do Playwright' "$TMP/err"
afirma "amd64: o trecho instala o Google Chrome (texto)" grep -q 'apt-get install -y --no-install-recommends google-chrome-stable' "$TMP/instala.sh"
env -i PATH="$TMP/falsos:/usr/bin:/bin" COM_NAVEGADOR=0 ARQUITETURA=arm64 "$BASH_BIN" -euo pipefail "$TMP/instala.sh" >/dev/null 2>&1
igual "COM_NAVEGADOR=0: o trecho nao faz nada e termina com 0" "0" "$?"
afirma "a conferencia de build exige o Chromium do Playwright fora do amd64" grep -q 'ls /opt/playwright/chromium-\*/chrome-linux\*/chrome' "$CF"
afirma "a imagem tem o link do lancador" grep -q 'ln -s /opt/dgclaw/app/bin/dgclaw-tela-navegador /usr/local/bin/dgclaw-tela-navegador' "$CF"
afirma "as unidades da Tela continuam habilitadas no perfil com navegador" grep -q 'systemctl enable dgclaw-tela.service dgclaw-tela-vnc.service dgclaw-tela-web.service' "$CF"
afirma "o lancador e executavel" test -x "$LANCADOR"

printf 'tela: %s verificacoes, %s falharam\n' "$TESTES" "$FALHAS"
[ "$FALHAS" -eq 0 ]
