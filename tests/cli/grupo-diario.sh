#!/usr/bin/env bash
# O grupo systemd-journal do usuario agente (aba Operacoes le o diario com ele):
#  - grupo_diario_script, extraido do bin/dgclaw e executado com getent, id, usermod, systemctl e
#    ps de mentira: so mexe no que precisa (usermod se falta o grupo, restart se o painel nao o tem);
#  - o Containerfile cria o usuario ja com o grupo;
#  - instalar_vida envia o script para dentro do agente (reparar, recriar e criar passam por ela).
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

# A funcao, do "grupo_diario_script() {" ate o "}" da coluna 0 seguinte.
awk '/^grupo_diario_script\(\) \{/ {d=1} d {print} d && /^\}/ {exit}' "$CLI" >"$TMP/funcao.sh"
afirma "achei grupo_diario_script no bin/dgclaw" test -s "$TMP/funcao.sh"
# shellcheck source=/dev/null
. "$TMP/funcao.sh"

BIN="$TMP/bin"
mkdir -p "$BIN"
chamadas="$TMP/chamadas.log"
cat >"$BIN/getent" <<'STUB'
#!/usr/bin/env bash
[ "$1" = group ] && [ "$2" = systemd-journal ] || exit 2
[ "${SEM_GRUPO:-0}" = 1 ] && exit 2
echo "systemd-journal:x:999:"
STUB
cat >"$BIN/id" <<'STUB'
#!/usr/bin/env bash
if [ "${NO_GRUPO:-0}" = 1 ]; then echo "agente crontab systemd-journal"; else echo "agente crontab"; fi
STUB
cat >"$BIN/usermod" <<'STUB'
#!/usr/bin/env bash
echo "usermod $*" >>"$CHAMADAS"
STUB
cat >"$BIN/systemctl" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = show ]; then echo "${MAINPID:-4242}"; exit 0; fi
echo "systemctl $*" >>"$CHAMADAS"
STUB
cat >"$BIN/ps" <<'STUB'
#!/usr/bin/env bash
echo "${SUPGID:-1001,4}"
STUB
chmod +x "$BIN"/*

# rodar_caso: roda o script com os stubs na frente do PATH; deixa o codigo em $RC e o que
# foi chamado em $chamadas.
rodar_caso() {
    : >"$chamadas"
    RC=0
    env CHAMADAS="$chamadas" PATH="$BIN:$PATH" "$@" bash -s < <(grupo_diario_script) >"$TMP/saida.txt" 2>&1 || RC=$?
}

echo "ja no grupo e painel com o grupo certo: nao mexe em nada"
rodar_caso NO_GRUPO=1 SUPGID="1001,999,4"
igual "sai com 0" 0 "$RC"
nega "nao chamou usermod nem restart" test -s "$chamadas"

echo "reparar de novo com o grupo no meio da lista: sem restart"
rodar_caso NO_GRUPO=1 SUPGID="101,999,1001"
igual "sai com 0" 0 "$RC"
nega "nao reiniciou" grep -q '^systemctl' "$chamadas"

echo "fora do grupo: usermod e restart"
rodar_caso NO_GRUPO=0 SUPGID="1001,4"
igual "sai com 0" 0 "$RC"
afirma "rodou usermod -aG systemd-journal agente" grep -qx 'usermod -aG systemd-journal agente' "$chamadas"
afirma "reiniciou o painel" grep -qx 'systemctl restart dgclaw-painel.service' "$chamadas"

echo "no grupo, mas o painel antigo nao o tem: so o restart"
rodar_caso NO_GRUPO=1 SUPGID="1001,4"
igual "sai com 0" 0 "$RC"
nega "nao rodou usermod" grep -q '^usermod' "$chamadas"
afirma "reiniciou o painel" grep -qx 'systemctl restart dgclaw-painel.service' "$chamadas"

echo "o gid do grupo so conta como palavra inteira (9990 nao e 999)"
rodar_caso NO_GRUPO=1 SUPGID="9990,1001"
afirma "reiniciou o painel" grep -qx 'systemctl restart dgclaw-painel.service' "$chamadas"

echo "painel parado (MainPID 0): usermod, sem restart"
rodar_caso NO_GRUPO=0 MAINPID=0
igual "sai com 0" 0 "$RC"
afirma "rodou usermod" grep -qx 'usermod -aG systemd-journal agente' "$chamadas"
nega "nao reiniciou" grep -q '^systemctl' "$chamadas"

echo "grupo inexistente na imagem"
rodar_caso SEM_GRUPO=1
igual "sai com 1" 1 "$RC"
nega "nao chamou usermod nem restart" test -s "$chamadas"
afirma "a mensagem diz o que fazer" grep -q 'recrie o agente' "$TMP/saida.txt"

echo "a imagem e o instalador"
afirma "o Containerfile cria o agente no grupo systemd-journal" grep -q 'usermod -aG crontab,systemd-journal agente' "$REPO/container/Containerfile"
corpo="$(awk '/^instalar_vida\(\) \{/ {d=1} d {print} d && /^\}/ {exit}' "$CLI")"
# shellcheck disable=SC2016 # o $c e literal: e o texto que o bin/dgclaw tem
afirma "instalar_vida envia o grupo_diario_script ao agente" grep -q 'grupo_diario_script | podman exec -i "\$c" bash -s' <<<"$corpo"

fim
