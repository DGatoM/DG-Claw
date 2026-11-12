#!/usr/bin/env bash
# Testes do scripts/reflection.sh: a reflexao noturna pula o dia sem conversa com o dono e, na
# duvida, roda. Usa um workspace falso, um plugin falso (copia do _lib com um inject.sh que so
# registra a chamada) e transcripts .jsonl minimos no formato que o thread_log le. Nada de sessao,
# de rede ou de modelo.
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSOU=0
FALHOU=0
ok() { PASSOU=$((PASSOU + 1)); printf '  ok     %s\n' "$1"; }
nok() { FALHOU=$((FALHOU + 1)); printf '  FALHOU %s\n' "$1"; }
afirma() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else nok "$d"; fi; }
nega() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then nok "$d"; else ok "$d"; fi; }

DIA="2026-11-12"

# Plugin falso: o _lib de verdade, menos o inject.sh.
PLUGIN="$TMP/plugin"
mkdir -p "$PLUGIN/scripts"
cp -r "$REPO/scripts/_lib" "$PLUGIN/scripts/_lib"
cat >"$PLUGIN/scripts/_lib/inject.sh" <<'SH'
is_session_alive() { return 0; }
inject_session() { cat >/dev/null; printf 'inject_session %s %s\n' "$1" "$2" >>"$DGCLAW_TESTE_CHAMADAS"; return 0; }
SH

# novo_cenario [provedor]: workspace limpo, com config.sh. O provedor padrao e claude.
novo_cenario() {
    local provedor="${1-claude}"
    WS="$TMP/ws"
    SESSOES="$TMP/sessoes"
    CHAMADAS="$TMP/chamadas.log"
    rm -rf "$WS" "$SESSOES" "$CHAMADAS"
    mkdir -p "$WS/.dgclaw" "$SESSOES"
    : >"$CHAMADAS"
    {
        echo "export DGCLAW_WORKSPACE='$WS'"
        echo "export DGCLAW_SLUG='teste'"
        echo "export DGCLAW_PLUGIN_ROOT='$PLUGIN'"
        echo "export DGCLAW_TZ='America/Sao_Paulo'"
        echo "export DGCLAW_OWNER='Marta'"
        [ -n "$provedor" ] && echo "export DGCLAW_PROVEDOR='$provedor'"
    } >"$WS/.dgclaw/config.sh"
}

linha_dono() { # <hora UTC> <texto>
    printf '{"type":"user","timestamp":"%sT%s.000Z","message":{"content":"<dgchat from=\\"Marta\\" chat=\\"c_teste\\" msg=\\"m1\\" ts=\\"x\\">%s</dgchat>"}}\n' "$DIA" "$1" "$2"
}
linha_poke() { # <hora UTC>
    printf '{"type":"user","timestamp":"%sT%s.000Z","message":{"content":"leia /tmp/dgclaw-poke-teste-heartbeat-20261112-120000.txt e execute"}}\n' "$DIA" "$1"
}
linha_resposta() { # <hora UTC> <texto>
    printf '{"type":"assistant","timestamp":"%sT%s.000Z","message":{"content":[{"type":"tool_use","name":"mcp__dgchat__reply","input":{"text":"%s","chat":"c_teste"}}]}}\n' "$DIA" "$1" "$2"
}
# sessao <nome> <data do arquivo>: le as linhas do stdin e grava com a data de modificacao dada.
sessao() {
    cat >"$SESSOES/$1.jsonl"
    touch -d "$2" "$SESSOES/$1.jsonl"
}

# rodar [VAR=valor...]: roda a reflexao e deixa o codigo de saida em RC.
rodar() {
    RC=0
    env DGCLAW_SESSION_DIR="$SESSOES" DGCLAW_TESTE_CHAMADAS="$CHAMADAS" DGCLAW_REFLECT_DATE="$DIA" HOME="$TMP/casa" "$@" \
        bash "$REPO/scripts/reflection.sh" "$WS/.dgclaw/config.sh" >"$TMP/saida.txt" 2>&1 || RC=$?
}
log() { cat "$WS/.dgclaw/logs/reflection.log" 2>/dev/null; }
injetou() { grep -q '^inject_session teste reflection' "$CHAMADAS"; }
pulso_pulou() { cat "$WS"/.dgclaw/logs/pulso/*.jsonl 2>/dev/null | grep -q '"status":"ok".*reflexão pulada'; }

echo "dia sem nenhuma mensagem do dono: pula"
novo_cenario
{ linha_dono 12:00:00 "oi" | sed "s/$DIA/2026-11-10/"; } | sessao antiga "2026-11-10 12:00"
rodar env
afirma "sai com 0" test "$RC" -eq 0
nega "nao injeta" injetou
afirma "o log diz que pulou e como forcar" bash -c "grep -q 'PULADA, dia sem conversa com o dono' '$WS/.dgclaw/logs/reflection.log' && grep -q 'DGCLAW_REFLECT_SEMPRE=1' '$WS/.dgclaw/logs/reflection.log'"
afirma "o Pulso registra ok com o motivo" pulso_pulou
afirma "o dia fica anotado para o doctor" grep -qx "$DIA" "$WS/.dgclaw/logs/reflexoes-puladas.txt"

echo "so recado de cron e resposta do proprio agente: pula"
novo_cenario
{ linha_poke 12:00:00; linha_resposta 12:00:05 "rotina feita"; } | sessao hoje "$DIA 12:00"
rodar env
afirma "sai com 0" test "$RC" -eq 0
nega "nao injeta" injetou

echo "dia com mensagem do dono: reflete"
novo_cenario
{ linha_poke 11:00:00; linha_dono 12:00:00 "bom dia"; linha_resposta 12:00:05 "bom dia!"; } | sessao hoje "$DIA 12:01"
rodar env
afirma "sai com 0" test "$RC" -eq 0
afirma "injeta o prompt" injetou
afirma "o log conta a mensagem" bash -c "grep -q '1 mensagem(ns) do dono no dia' '$WS/.dgclaw/logs/reflection.log'"
nega "nao anota dia pulado" test -f "$WS/.dgclaw/logs/reflexoes-puladas.txt"

echo "mensagem do dono depois das 21h no fuso do agente (cai no dia seguinte em UTC): reflete"
novo_cenario
linha_dono 23:30:00 "boa noite" | sed "s/${DIA}T23/2026-11-13T01/" | sessao tarde "2026-11-13 01:31"
# 01:30 UTC do dia 13 = 22:30 do dia 12 em Sao Paulo
rodar env
afirma "injeta" injetou
afirma "contou a mensagem" bash -c "grep -q '1 mensagem(ns) do dono no dia' '$WS/.dgclaw/logs/reflection.log'"

echo "mensagem do dono em sessao antiga (nao esta entre as 5 mais recentes): reflete"
novo_cenario
linha_dono 12:00:00 "oi" | sessao a-dono "$DIA 12:00"
for i in 1 2 3 4 5 6; do linha_poke 13:0$i:00 | sessao "cron$i" "$DIA 13:0$i"; done
rodar env
afirma "injeta" injetou
afirma "contou a mensagem" bash -c "grep -q '1 mensagem(ns) do dono no dia' '$WS/.dgclaw/logs/reflection.log'"

echo "na duvida: reflete"
novo_cenario
rm -rf "$SESSOES"
rodar env
afirma "pasta de sessoes ausente: injeta" injetou
afirma "pasta ausente: o log explica" bash -c "grep -q 'nao existe' '$WS/.dgclaw/logs/reflection.log' || grep -q 'incerta' '$WS/.dgclaw/logs/reflection.log'"

# plugin com o thread_log quebrado: o Python falha e o script nao pode concluir que o dia foi parado
mkdir -p "$TMP/plugin-quebrado/scripts"
cp -r "$PLUGIN/scripts/_lib" "$TMP/plugin-quebrado/scripts/_lib"
echo 'raise RuntimeError("thread_log quebrado de proposito")' >"$TMP/plugin-quebrado/scripts/_lib/thread_log.py"
novo_cenario
sed -i "s|DGCLAW_PLUGIN_ROOT='$PLUGIN'|DGCLAW_PLUGIN_ROOT='$TMP/plugin-quebrado'|" "$WS/.dgclaw/config.sh"
cp "$PLUGIN/scripts/_lib/inject.sh" "$TMP/plugin-quebrado/scripts/_lib/inject.sh"
: >"$SESSOES/vazia.jsonl"
rodar env
afirma "Python quebrado: sai com 0" test "$RC" -eq 0
afirma "Python quebrado: injeta" injetou
afirma "Python quebrado: o log explica" bash -c "grep -q 'a leitura das conversas falhou' '$WS/.dgclaw/logs/reflection.log'"

novo_cenario codex
rodar env
afirma "provedor codex: injeta" injetou
afirma "provedor codex: o log explica" bash -c "grep -q \"provedor 'codex'\" '$WS/.dgclaw/logs/reflection.log'"

novo_cenario ""
rodar env
afirma "config sem DGCLAW_PROVEDOR: injeta" injetou

echo "leitura com falha conta como duvida: reflete"
novo_cenario
mkdir "$SESSOES/ilegivel.jsonl"   # abrir um diretorio falha igual a falta de permissao, mesmo como root
touch -d "$DIA 12:00" "$SESSOES/ilegivel.jsonl"
rodar env
afirma "arquivo ilegivel: injeta" injetou
afirma "arquivo ilegivel: o log diz o motivo" bash -c "grep -q 'nao consegui abrir ilegivel.jsonl' '$WS/.dgclaw/logs/reflection.log'"

novo_cenario
{ linha_poke 11:00:00; echo '{"type":"user","timest'; linha_resposta 12:00:05 "oi"; } | sessao quebrada "$DIA 12:00"
rodar env
afirma "linha JSON quebrada no meio: injeta" injetou
afirma "linha quebrada: o log diz o motivo" bash -c "grep -q 'nao e JSON valido' '$WS/.dgclaw/logs/reflection.log'"
nega "linha quebrada: nao anota dia pulado" test -f "$WS/.dgclaw/logs/reflexoes-puladas.txt"

novo_cenario
{ linha_poke 11:00:00; printf '{"type":"user","timest'; } | sessao em-escrita "$DIA 12:00"
rodar env
afirma "ultima linha sem quebra (escrita em andamento) nao impede o pulo" bash -c "! grep -q '^inject_session' '$CHAMADAS'"

novo_cenario
echo x >"$TMP/nao-e-pasta"
rodar env DGCLAW_SESSION_DIR="$TMP/nao-e-pasta"
afirma "pasta de sessoes que nao pode ser listada: injeta" injetou
afirma "pasta nao listavel: o log explica" bash -c "grep -q 'duvida\|nao existe\|incerta' '$WS/.dgclaw/logs/reflection.log'"

# scandir que falha com PermissionError (simulado por sitecustomize, so neste caso)
novo_cenario
: >"$SESSOES/a.jsonl"
mkdir -p "$TMP/sc"
cat >"$TMP/sc/sitecustomize.py" <<'PY'
import os
_orig = os.scandir
def _scandir(p="."):
    if "sessoes" in str(p):
        raise PermissionError(13, "Permission denied", str(p))
    return _orig(p)
os.scandir = _scandir
PY
rodar env PYTHONPATH="$TMP/sc"
afirma "listagem com PermissionError: injeta" injetou
afirma "listagem com PermissionError: o log explica" bash -c "grep -q 'nao consegui listar' '$WS/.dgclaw/logs/reflection.log'"
nega "listagem com PermissionError: nao anota dia pulado" test -f "$WS/.dgclaw/logs/reflexoes-puladas.txt"

echo "DGCLAW_REFLECT_SEMPRE=1 forca"
novo_cenario
: >"$SESSOES/vazia.jsonl"
rodar env DGCLAW_REFLECT_SEMPRE=1
afirma "injeta mesmo sem conversa" injetou
afirma "o log diz que foi forcado" bash -c "grep -q 'DGCLAW_REFLECT_SEMPRE=1, reflito' '$WS/.dgclaw/logs/reflection.log'"

printf '\n%s verificacoes, %s falharam.\n' "$((PASSOU + FALHOU))" "$FALHOU"
[ "$FALHOU" -eq 0 ]
