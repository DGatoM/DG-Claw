#!/usr/bin/env bash
# `dgclaw agente youtube <slug> conta-dedicada sim|nao`: o marcador que libera os cookies da Tela no yt-dlp.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

CFG="$DGCLAW_RAIZ/var/lib/dgclaw/agentes/ana/config"
M="$CFG/youtube-conta-dedicada"
criar_agente ana --nome "Ana"
igual "o criar termina com 0" "0" "$?"
nega "de saida o marcador nao existe (padrao desligado)" test -e "$M"

echo "youtube: sem valor so mostra o estado"
dgclaw agente youtube ana conta-dedicada >"$TMP/o.txt" 2>&1
igual "sem valor sai com 0" "0" "$?"
afirma "diz que esta DESLIGADA" grep -q "DESLIGADA" "$TMP/o.txt"
afirma "mostra o uso" grep -q "conta-dedicada sim|nao" "$TMP/o.txt"
nega "nao criou o marcador" test -e "$M"

echo "youtube: sim cria o marcador"
printf 'OUTRA=linha\n' >>"$CFG/painel.env"
painel_antes="$(sha256sum <"$CFG/painel.env")"
echo "alheio" >"$CFG/arquivo-alheio"
dgclaw agente youtube ana conta-dedicada sim >"$TMP/o.txt" 2>&1
igual "sim sai com 0" "0" "$?"
afirma "o marcador existe" test -f "$M"
igual "conteudo fixo de uma linha" "sim" "$(cat "$M")"
igual "uma linha so" "1" "$(wc -l <"$M" | tr -d ' ')"
igual "modo 644" "644" "$(stat -c %a "$M")"
afirma "dono igual ao da pasta config" bash -c "stat -c %u '$M' | grep -q \"\$(stat -c %u '$CFG')\" || grep -q \"$M\" '$DGCLAW_RAIZ/.chown-simulado'"
igual "painel.env continua igual" "$painel_antes" "$(sha256sum <"$CFG/painel.env")"
igual "arquivo alheio continua" "alheio" "$(cat "$CFG/arquivo-alheio")"
dgclaw agente youtube ana conta-dedicada >"$TMP/o.txt" 2>&1
afirma "sem valor agora diz LIGADA" grep -q "LIGADA" "$TMP/o.txt"
nega "e nao diz DESLIGADA" grep -q "DESLIGADA" "$TMP/o.txt"
dgclaw agente youtube ana conta-dedicada sim >/dev/null 2>&1
igual "sim de novo continua certo" "sim" "$(cat "$M")"

echo "youtube: valor invalido nao muda nada"
dgclaw agente youtube ana conta-dedicada talvez >"$TMP/o.txt" 2>&1
igual "valor invalido sai com 2" "2" "$?"
afirma "o marcador continua" test -f "$M"
dgclaw agente youtube ana conta-dedicada nao >"$TMP/o.txt" 2>&1
igual "nao sai com 0" "0" "$?"
nega "o marcador sumiu" test -e "$M"
dgclaw agente youtube ana conta-dedicada talvez >/dev/null 2>&1
igual "valor invalido com marcador ausente sai com 2" "2" "$?"
nega "e nao criou o marcador" test -e "$M"
igual "painel.env continua igual depois do nao" "$painel_antes" "$(sha256sum <"$CFG/painel.env")"
igual "arquivo alheio continua depois do nao" "alheio" "$(cat "$CFG/arquivo-alheio")"
dgclaw agente youtube ana conta-dedicada nao >/dev/null 2>&1
igual "nao de novo (sem marcador) sai com 0" "0" "$?"

echo "youtube: argumentos demais nao mudam nada"
dgclaw agente youtube ana conta-dedicada sim nao >"$TMP/o.txt" 2>&1
igual "sim nao sai com 2" "2" "$?"
nega "e nao criou o marcador" test -e "$M"
dgclaw agente youtube ana conta-dedicada sim >/dev/null 2>&1
dgclaw agente youtube ana conta-dedicada nao sim >/dev/null 2>&1
igual "nao sim sai com 2" "2" "$?"
afirma "e nao removeu o marcador" test -f "$M"
dgclaw agente youtube ana conta-dedicada nao >/dev/null 2>&1

echo "youtube: nome ou assunto invalido"
nega "nome inexistente recusado" dgclaw agente youtube fulano conta-dedicada sim
nega "nome invalido recusado" dgclaw agente youtube A conta-dedicada sim
nega "sem nome recusado" dgclaw agente youtube
nega "assunto desconhecido recusado" dgclaw agente youtube ana outra-coisa sim
nega "nome inexistente nao criou nada" test -e "$LIB/agentes/fulano"
nega "nada foi criado nas recusas" test -e "$M"

fim
