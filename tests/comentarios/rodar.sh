#!/usr/bin/env bash
# Testes do cron de comentarios do Instagram: a sessao que le texto de terceiros roda com
# ferramentas restritas (nada de bypassPermissions), aborta se o Claude Code nao conhece as
# flags de restricao, e so responde pelo responder-comentario.sh (id numerico + texto).
# Tudo falso: claude, plugin, Graph API. Nada de rede nem de modelo.
# shellcheck disable=SC2016  # as aspas simples guardam, de proposito, texto com $() e crase
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

PLUGIN="$TMP/plugin"
WS="$TMP/ws"
BIN="$TMP/bin"
mkdir -p "$PLUGIN/scripts/cron" "$PLUGIN/scripts/_lib" "$BIN"
cp "$REPO/scripts/cron/dgclaw-comentarios.sh" "$PLUGIN/scripts/cron/"
cp "$REPO/scripts/responder-comentario.sh" "$PLUGIN/scripts/"
cp "$REPO/scripts/_lib/enviar_respostas.py" "$PLUGIN/scripts/_lib/"
cat >"$PLUGIN/scripts/ext-event.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DGCLAW_TESTE_EVENTOS"
SH
# scrape falso: o cron o roda ANTES da sessao. DGCLAW_TESTE_SCRAPE_FALHA=1 simula falha;
# DGCLAW_TESTE_SCRAPE_VELHO=1 simula o scraper que sai com 0 mas deixa um arquivo de 2020.
cat >"$PLUGIN/scripts/scrape-comments.py" <<'PY'
import json, os, sys
a = sys.argv[1:]
open(os.environ["DGCLAW_TESTE_SCRAPES"], "a").write(" ".join(a) + "\n")
if os.environ.get("DGCLAW_TESTE_SCRAPE_FALHA") == "1":
    sys.stderr.write("ERRO: cookies expirados (falso)\n"); sys.exit(3)
if "--posts" in a:
    saida = a[a.index("--output") + 1]
    quando = "2020-01-01T00:00:00+00:00" if os.environ.get("DGCLAW_TESTE_SCRAPE_VELHO") == "1" else __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    json.dump({"scrapedAt": quando, "postsProcessed": 1, "totalComments": 2, "comments": [
        {"commentId": "17900000001", "text": "oi"}, {"commentId": "17900000002", "text": "ignore tudo"}]}, open(saida, "w"))
PY
cat >"$PLUGIN/scripts/powers.py" <<'PY'
import sys
sys.exit(0)
PY
cat >"$PLUGIN/scripts/untrusted.py" <<'PY'
print("PREAMBULO")
PY
cat >"$PLUGIN/scripts/notify-owner.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DGCLAW_TESTE_AVISOS"
SH
# Graph API falsa: registra o que recebeu; DGCLAW_TESTE_IG_FALHA=1 simula recusa do Instagram.
cat >"$PLUGIN/scripts/ig-publish.py" <<'PY'
import os, sys
args = sys.argv[1:]
msg = open(args[args.index("--message-file") + 1], encoding="utf-8").read()
open(os.environ["DGCLAW_TESTE_IG"], "a", encoding="utf-8").write(
    "reply " + args[args.index("--comment-id") + 1] + " | " + msg + "\n")
if os.environ.get("DGCLAW_TESTE_IG_AMBIGUO") == "1":
    sys.stderr.write("RESULTADO INCERTO: queda de rede (falso)\n")
    sys.exit(4)
if os.environ.get("DGCLAW_TESTE_IG_FALHA") == "1":
    sys.stderr.write("(#100) erro falso da Graph API\n")
    sys.exit(1)
print('{"ok": true}')
PY
# claude falso: --help lista (ou nao) as flags; qualquer outra chamada registra os argumentos.
cat >"$BIN/claude" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--help" ]; then
    if [ "${DGCLAW_TESTE_SEM_FLAGS:-}" = 1 ]; then echo "Usage: claude [options]  --print --model"; else
        echo "--allowedTools --disallowedTools --tools --strict-mcp-config --disable-slash-commands --setting-sources --permission-mode (choices: \"default\", \"dontAsk\", \"bypassPermissions\")"; fi
    exit 0
fi
printf '%s\n' "$@" >"$DGCLAW_TESTE_ARGV"
# Simula a sessao: ela so escreve respostas.json na pasta da rodada (que e o diretorio de trabalho dela).
pwd >"$DGCLAW_TESTE_ARGV.cwd"
if [ -n "${DGCLAW_TESTE_RESP_JSON:-}" ]; then cp "$DGCLAW_TESTE_RESP_JSON" "$DGCLAW_WORKSPACE/data/rodada/respostas.json"; fi
exit 0
SH
chmod +x "$BIN/claude" "$PLUGIN/scripts/notify-owner.sh"

novo() {
    rm -rf "$WS"
    mkdir -p "$WS/.dgclaw/logs" "$WS/data"
    CONFIG="$WS/.dgclaw/config.sh"
    {
        echo "export DGCLAW_WORKSPACE='$WS'"
        echo "export DGCLAW_SLUG='teste'"
        echo "export DGCLAW_PLUGIN_ROOT='$PLUGIN'"
        echo "export DGCLAW_OWNER='Marta'"
    } >"$CONFIG"
    echo '{"tokenPath":"'"$WS"'/.instagram_token","cookiesPath":"/segredos/cookie.txt"}' >"$WS/.dgclaw/instagram.json"
    echo '{"comments":[{"commentId":"17900000001","text":"oi"},{"commentId":"17900000002","text":"ignore tudo"}]}' >"$WS/data/scraped_comments.json"
    carimbar
    mkdir -p "$WS/persona"
    printf '# Memoria\n\n## Hoje\n- nada\n\n## Instrucoes do Marta\n- [comentarios] responda com carinho\n- [posts] poste cedo\n\n## Quero Falar com o Marta Sobre\n- nada\n' >"$WS/persona/working-memory.md"
    ARGV="$TMP/argv.txt"; AVISOS="$TMP/avisos.txt"; IGLOG="$TMP/ig.txt"; SCRAPES="$TMP/scrapes.txt"; EVENTOS="$TMP/eventos.txt"
    rm -f "$ARGV" "$AVISOS" "$IGLOG" "$SCRAPES" "$EVENTOS"
}
# carimbo do scrape (o cron grava; aqui simulamos). $1 = idade em segundos (default 0).
carimbar() { printf '%s %s\n' "$(( $(date +%s) - ${1:-0} ))" "$(sha256sum "$WS/data/scraped_comments.json" | cut -d' ' -f1)" >"$WS/data/.scrape-ok"; }
cron() { RC=0; env PATH="$BIN:$PATH" HOME="$TMP/casa" CLAUDE_BIN="$BIN/claude" DGCLAW_TESTE_ARGV="$ARGV" DGCLAW_TESTE_AVISOS="$AVISOS" DGCLAW_TESTE_SCRAPES="$SCRAPES" DGCLAW_TESTE_EVENTOS="$EVENTOS" DGCLAW_TESTE_IG="$IGLOG" "$@" bash "$PLUGIN/scripts/cron/dgclaw-comentarios.sh" "$CONFIG" >"$TMP/saida.txt" 2>&1 || RC=$?; }
resp() { RC=0; env DGCLAW_CONFIG="$CONFIG" DGCLAW_TESTE_IG="$IGLOG" "$@" >"$TMP/saida.txt" 2>&1 || RC=$?; }

echo "cron: sessao com ferramentas restritas"
novo
cron env
afirma "sai com 0" test "$RC" -eq 0
nega "nao usa bypassPermissions" grep -qx 'bypassPermissions' "$ARGV"
afirma "usa dontAsk" grep -qx 'dontAsk' "$ARGV"
afirma "passa --allowedTools" grep -qx -- '--allowedTools' "$ARGV"
afirma "passa --disallowedTools" grep -qx -- '--disallowedTools' "$ARGV"
afirma "passa --tools" grep -qx -- '--tools' "$ARGV"
afirma "so as ferramentas Read, Write e Edit (sem Bash)" bash -c "grep -xA1 -- '--tools' '$ARGV' | tail -1 | grep -qx 'Read,Write,Edit'"
afirma "Bash esta na lista de bloqueadas" grep -qx 'Bash' "$ARGV"
nega "nenhuma regra Bash(...) liberada" grep -q '^Bash(' "$ARGV"
nega "nao libera o ig-publish.py direto" grep -q 'ig-publish.py' "$ARGV"
nega "o responder-comentario.sh nao e da sessao" grep -q '^Bash(.*responder-comentario' "$ARGV"
afirma "sem MCP e sem comandos de barra" bash -c "grep -qx -- '--strict-mcp-config' '$ARGV' && grep -qx -- '--disable-slash-commands' '$ARGV'"
afirma "bloqueia WebFetch" grep -qx 'WebFetch' "$ARGV"
afirma "bloqueia Grep e Glob" bash -c "grep -qx Grep '$ARGV' && grep -qx Glob '$ARGV'"
nega "nao libera Read sem restricao" grep -qx 'Read' "$ARGV"
afirma "Read so dos seguidores" grep -q 'Read(//.*/persona/followers/\*\*)' "$ARGV"
afirma "escrita so na pasta da rodada (regra Edit cobre o Write)" grep -q '^Edit(//.*/data/rodada/respostas.json)' "$ARGV"
nega "nao libera o working-memory vivo" grep -q 'Edit(/.*/persona/working-memory.md)' "$ARGV"
nega "nao libera data/** inteiro para escrita" grep -qE 'Edit\(/.*/data/\*\*' "$ARGV"
nega "nenhuma regra Write(...) (o Claude Code as ignora)" grep -q '^Write(' "$ARGV"
afirma "nega a leitura de .dgclaw" grep -q 'Read(//.*/.dgclaw/\*\*)' "$ARGV"
afirma "nega a leitura do token" grep -q 'Read(//.*/.instagram_token\*)' "$ARGV"
afirma "nega o tokenPath e o cookiesPath do instagram.json" grep -q 'Read(//segredos/cookie.txt)' "$ARGV"
nega "nao libera o scrape para a sessao" grep -q 'scrape-comments.py' "$ARGV"
nega "nao libera Edit/Write de .replied_comments" grep -qE '(Edit|Write)\(.*replied_comments' "$ARGV"
nega "nao libera Edit/Write de data/comments.jsonl" grep -qE '(Edit|Write)\(.*comments.jsonl' "$ARGV"
nega "o prompt nao manda ler o instagram.json" grep -q '^1. .dgclaw/instagram.json' "$ARGV"
afirma "o prompt manda gravar respostas.json" grep -q 'data/rodada/respostas.json' "$ARGV"

echo "cron: Claude Code sem as flags de restricao: aborta e avisa"
novo
cron env DGCLAW_TESTE_SEM_FLAGS=1
afirma "sai com 3" test "$RC" -eq 3
nega "nao chamou a sessao" test -s "$ARGV"
afirma "o log diz o que fazer" grep -q 'ABORTADO.*claude update' "$WS/.dgclaw/logs/comentarios.log"
afirma "o dono foi avisado" grep -q 'NAO rodou' "$AVISOS"

echo "responder-comentario: entradas recusadas"
novo
resp bash "$PLUGIN/scripts/responder-comentario.sh" "17900000001; touch $TMP/pwned" "oi"
afirma "id com ponto e virgula: recusa (2)" test "$RC" -eq 2
nega "nada foi executado" test -e "$TMP/pwned"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 'abc' "oi"
afirma "id nao numerico: recusa" test "$RC" -eq 2
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17999999999 "oi"
afirma "id fora do scrape: recusa" test "$RC" -eq 2
afirma "a mensagem explica" grep -q 'nao esta entre os comentarios' "$TMP/saida.txt"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 ""
afirma "texto vazio: recusa" test "$RC" -eq 2
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "$(printf 'a%.0s' $(seq 1 2300))"
afirma "texto acima de 2200: recusa" test "$RC" -eq 2
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "$(printf 'oi\001tchau')"
afirma "caractere de controle: recusa" test "$RC" -eq 2
nega "nenhuma chamada ao Instagram nas recusas" test -s "$IGLOG"
nega "nada gravado como respondido" test -s "$WS/.replied_comments"

echo "responder-comentario: resposta valida"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 'Oi! $(touch '"$TMP"'/pwned2) `touch '"$TMP"'/pwned3` obrigada'
afirma "responde (0)" test "$RC" -eq 0
afirma "o Instagram recebeu o id e o texto literal" grep -qF 'reply 17900000001 | Oi! $(touch' "$IGLOG"
nega "o texto nao executou" test -e "$TMP/pwned2"
afirma "gravou em .replied_comments" grep -qx 17900000001 "$WS/.replied_comments"
afirma "gravou em data/comments.jsonl" grep -q '"commentId": "17900000001"' "$WS/data/comments.jsonl"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "de novo"
afirma "segunda resposta ao mesmo comentario: recusa" test "$RC" -eq 2
afirma "texto pelo stdin tambem funciona" bash -c "echo 'pelo stdin' | env DGCLAW_CONFIG='$CONFIG' DGCLAW_TESTE_IG='$IGLOG' bash '$PLUGIN/scripts/responder-comentario.sh' 17900000002"

echo "responder-comentario: o Instagram recusa"
novo
resp env DGCLAW_TESTE_IG_FALHA=1 bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "oi"
afirma "sai com 1" test "$RC" -eq 1
afirma "explica o que houve" grep -q 'o Instagram recusou' "$TMP/saida.txt"
nega "nao grava como respondido" test -s "$WS/.replied_comments"


echo "cron: o scrape e do cron, nao da sessao"
novo
cron env
afirma "o cron rodou o scrape (--posts 15) para um arquivo da rodada" grep -q -- '^--posts 15 --output .*scraped_comments.rodada.json' "$SCRAPES"
afirma "o cron atualizou os seguidores a partir desse arquivo" grep -q -- '^--update-followers --file .*scraped_comments.rodada.json' "$SCRAPES"
afirma "gravou o carimbo com epoch e sha256" grep -qE '^[0-9]{10} [0-9a-f]{64}$' "$WS/data/.scrape-ok"
novo
cron env DGCLAW_TESTE_SCRAPE_FALHA=1
afirma "scrape falhou: sai com 4" test "$RC" -eq 4
nega "scrape falhou: a sessao nao rodou" test -s "$ARGV"
afirma "scrape falhou: o dono foi avisado" grep -q 'Scrape falhou, nao respondi' "$AVISOS"
nega "scrape falhou: sem carimbo" test -e "$WS/data/.scrape-ok"
novo
carimbar 100
cron env DGCLAW_TESTE_SCRAPE_FALHA=1
nega "carimbo velho some quando o scrape novo falha" test -e "$WS/data/.scrape-ok"

echo "cron: a sessao nao herda configuracao nem le fora do que foi liberado"
novo
cron env
afirma "ignora configuracao herdada (--setting-sources vazio)" bash -c "grep -qx -- '--setting-sources' '$ARGV' && grep -xA1 -- '--setting-sources' '$ARGV' | tail -1 | grep -qx ''"
nega "nao usa --add-dir (a leitura fora das regras fica negada)" grep -qx -- '--add-dir' "$ARGV"
afirma "o diretorio de trabalho da sessao e a pasta da rodada" test "$(cat "$ARGV.cwd")" = "$WS/data/rodada"
nega "nao libera a pasta data/ inteira para leitura" grep -qE 'Read\(/.*/data/\*\*\)' "$ARGV"
afirma "libera so o scrape e a pasta da rodada" bash -c "grep -q 'Read(/.*/data/scraped_comments.json)' '$ARGV' && grep -q 'Read(/.*/data/rodada/\*\*)' '$ARGV'"
nega "nao libera nenhuma escrita na memoria de trabalho" grep -q 'working-memory' <(grep -E '^(Edit|Write)\(' "$ARGV")
nega "o prompt nao manda marcar nem escrever na memoria" grep -qE 'APLICADO|Atualizar data/rodada/working-memory' "$ARGV"
nega "nao libera leitura da memoria privada" grep -qE 'Read\(/.*/(memory|persona)/\*\*\)' "$ARGV"
afirma "libera so os cadastros de seguidores" grep -q 'Read(/.*/persona/followers/\*\*)' "$ARGV"
nega "nao libera escrita em memoria nem em seguidores" grep -qE '^Edit\(/.*/(memory|persona)' "$ARGV"
afirma "o prompt usa caminhos absolutos para a saida" grep -q "$WS/data/rodada/respostas.json" "$ARGV"
afirma "as instrucoes do dono chegam so como linhas filtradas" bash -c "grep -q 'responda com carinho' '$WS/data/rodada/instrucoes.txt' && ! grep -q 'poste cedo' '$WS/data/rodada/instrucoes.txt'"
novo
sha_antes="$(sha256sum "$WS/persona/working-memory.md" | cut -d' ' -f1)"
cron env
igual_sha() { [ "$(sha256sum "$WS/persona/working-memory.md" | cut -d' ' -f1)" = "$sha_antes" ]; }
afirma "o cron nunca altera a memoria de trabalho viva" igual_sha

echo "cron: as respostas saem pelo cron, depois da sessao"
novo
cat >"$TMP/resp.json" <<'EOF'
{"respostas":[
 {"commentId":"17900000001","acao":"responder","texto":"Oi! $(touch /tmp/pwned-resp) obrigada","evento":"comment_positive"},
 {"commentId":"17900000002","acao":"pular"},
 {"commentId":"17999999999","acao":"responder","texto":"id fora do scrape"},
 {"commentId":"../../etc","acao":"responder","texto":"x"},
 {"commentId":"17900000001","acao":"responder","texto":"duplicada"}
]}
EOF
cron env DGCLAW_TESTE_RESP_JSON="$TMP/resp.json"
afirma "o Instagram recebeu a resposta valida, literal" grep -qF 'reply 17900000001 | Oi! $(touch' "$IGLOG"
nega "o texto nao executou" test -e /tmp/pwned-resp
afirma "UMA resposta so ao comentario repetido" test "$(grep -c '^reply 17900000001' "$IGLOG")" -eq 1
nega "id fora do scrape nao foi enviado" grep -q 17999999999 "$IGLOG"
afirma "o pulado consta em .replied_comments" grep -qx 17900000002 "$WS/.replied_comments"
afirma "o evento foi anunciado" grep -qx comment_positive "$EVENTOS"
afirma "o log tem o resumo" grep -q 'enviadas=1 puladas=1 recusadas=3' "$WS/.dgclaw/logs/comentarios.log"
afirma "o dono recebeu o resumo no fim" grep -q 'finalizado.*enviadas=1 puladas=1' "$AVISOS"
novo
cron env
afirma "sem respostas.json: nada enviado e rc 0" bash -c "test '$RC' -eq 0 && ! test -s '$IGLOG'"
novo
echo 'isso nao e json' >"$TMP/resp-ruim.json"
cron env DGCLAW_TESTE_RESP_JSON="$TMP/resp-ruim.json"
nega "respostas.json invalido: nada enviado" test -s "$IGLOG"
afirma "respostas.json invalido: o rc nao e 0" test "$RC" -ne 0

echo "cron: respostas com resultado INCERTO nao se repetem"
novo
cat >"$TMP/resp1.json" <<'EOF'
{"respostas":[{"commentId":"17900000001","acao":"responder","texto":"oi"}]}
EOF
cron env DGCLAW_TESTE_RESP_JSON="$TMP/resp1.json" DGCLAW_TESTE_IG_AMBIGUO=1
afirma "sai com 5" test "$RC" -eq 5
afirma "o dono foi avisado do incerto" grep -q 'nao deu para saber se o Instagram publicou' "$AVISOS"
afirma "a reserva ficou" grep -qx 17900000001 "$WS/.replied_comments"
afirma "o id foi anotado em respostas-incertas.txt" grep -q 17900000001 "$WS/data/respostas-incertas.txt"
cron env DGCLAW_TESTE_RESP_JSON="$TMP/resp1.json" DGCLAW_TESTE_IG_AMBIGUO=1
afirma "a rodada seguinte NAO responde de novo" test "$(grep -c '^reply 17900000001' "$IGLOG")" -eq 1

echo "cron: scrape velho nao ganha carimbo novo"
novo
cron env DGCLAW_TESTE_SCRAPE_VELHO=1
afirma "scrape de 2020: aborta com 4" test "$RC" -eq 4
nega "a sessao nao rodou" test -s "$ARGV"
nega "sem carimbo" test -e "$WS/data/.scrape-ok"
afirma "o dono foi avisado" grep -q 'Scrape falhou' "$AVISOS"

echo "cron: duas rodadas ao mesmo tempo"
novo
( exec 8>"$WS/data/.comentarios.lock"; flock -n 8; cron env; echo "$RC" >"$TMP/rc-concorrente.txt" )
afirma "com a trava ocupada a rodada e pulada (0)" test "$(cat "$TMP/rc-concorrente.txt")" = 0
nega "e a sessao nao rodou" test -s "$ARGV"

echo "responder-comentario: scrape velho ou adulterado"
novo
carimbar 7300
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "oi"
afirma "scrape com mais de 2h: recusa" test "$RC" -eq 2
afirma "a mensagem explica o limite" grep -q 'o limite e 120' "$TMP/saida.txt"
novo
echo '{"comments":[{"commentId":"17999999999","text":"x"}]}' >"$WS/data/scraped_comments.json"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17999999999 "oi"
afirma "arquivo mudou depois do carimbo: recusa" test "$RC" -eq 2
afirma "diz que o sha256 nao confere" grep -q 'sha256 diferente' "$TMP/saida.txt"
novo
rm -f "$WS/data/.scrape-ok"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "oi"
afirma "sem carimbo: recusa" test "$RC" -eq 2
nega "nada foi enviado" test -s "$IGLOG"

echo "responder-comentario: dedupe com trava e reserva"
novo
resp bash "$PLUGIN/scripts/responder-comentario.sh" --pular 17900000002
afirma "--pular grava o id (0)" test "$RC" -eq 0
afirma "o id pulado consta em .replied_comments" grep -qx 17900000002 "$WS/.replied_comments"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000002 "oi"
afirma "nao responde ao pulado" test "$RC" -eq 2
resp bash "$PLUGIN/scripts/responder-comentario.sh" --pular 17999999999
afirma "--pular de id fora do scrape: recusa" test "$RC" -eq 2
novo
# duas respostas AO MESMO tempo ao mesmo comentario: so uma sai
( env DGCLAW_CONFIG="$CONFIG" DGCLAW_TESTE_IG="$IGLOG" bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "a" >"$TMP/p1.txt" 2>&1 & \
  env DGCLAW_CONFIG="$CONFIG" DGCLAW_TESTE_IG="$IGLOG" bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "b" >"$TMP/p2.txt" 2>&1 & wait )
afirma "concorrencia: o Instagram recebeu UMA resposta" test "$(grep -c '^reply 17900000001' "$IGLOG")" -eq 1
afirma "concorrencia: .replied_comments com UMA linha" test "$(grep -cx 17900000001 "$WS/.replied_comments")" -eq 1
novo
printf '17900000009\n' >"$WS/.replied_comments"
resp env DGCLAW_TESTE_IG_FALHA=1 bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "oi"
afirma "falha do Instagram desfaz a reserva (so a linha antiga fica)" test "$(cat "$WS/.replied_comments")" = "17900000009"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "oi"
afirma "e a proxima tentativa funciona" test "$RC" -eq 0
novo
mkdir "$WS/.replied_comments"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "oi"
afirma "erro ao gravar a reserva: nao envia e sai com 1" test "$RC" -eq 1
nega "e nada foi enviado ao Instagram" test -s "$IGLOG"

echo "responder-comentario: falha ambigua mantem a reserva"
novo
resp env DGCLAW_TESTE_IG_AMBIGUO=1 bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "oi"
afirma "sai com 5" test "$RC" -eq 5
afirma "a reserva ficou" grep -qx 17900000001 "$WS/.replied_comments"
afirma "explica como conferir" grep -q 'Confira na conta do Instagram' "$TMP/saida.txt"
resp bash "$PLUGIN/scripts/responder-comentario.sh" 17900000001 "de novo"
afirma "a nova tentativa e recusada (nao responde duas vezes)" test "$RC" -eq 2
afirma "so uma chamada chegou ao Instagram" test "$(grep -c '^reply' "$IGLOG")" -eq 1

echo "search-follower: id e username viram nome de arquivo"
SF="$REPO/scripts/search-follower.py"
SFWS="$TMP/sfws"
rm -rf "$SFWS"; mkdir -p "$SFWS/persona" "$SFWS/.dgclaw"
echo '{"x":1}' >"$SFWS/.dgclaw/instagram.json"
sf() { RC=0; env DGCLAW_WORKSPACE="$SFWS" DGCLAW_SLUG=teste python3 "$SF" "$@" >"$TMP/saida.txt" 2>&1 || RC=$?; }
sf --id 12345678 --username ana.silva --create --increment
afirma "id valido cria o cadastro" test -f "$SFWS/persona/followers/12345678.json"
sf --id ../../.dgclaw/instagram --create
afirma "id com traversal: recusa (2)" test "$RC" -eq 2
afirma "o instagram.json ficou intacto" grep -q '"x":1' "$SFWS/.dgclaw/instagram.json"
sf --id /etc/cron.d/x --create
afirma "id absoluto: recusa" test "$RC" -eq 2
sf --id 123 --username 'a/../../b' --create
afirma "username com barra: recusa" test "$RC" -eq 2
sf --username '../../x' --create
afirma "username com traversal: recusa" test "$RC" -eq 2
sf --id 12345678 --workspace "$TMP/outro" --create
afirma "--workspace diferente do agente: recusa" test "$RC" -eq 2
nega "e nada foi criado fora" test -e "$TMP/outro"
# cadastro com instagramId malicioso dentro do JSON nao decide caminho
mkdir -p "$SFWS/persona/followers"
echo '{"instagramId":"../../.dgclaw/instagram","username":"vitima","usernameHistory":[],"interactionCount":1,"sentiment":"neutral"}' >"$SFWS/persona/followers/username_vitima.json"
sf --username vitima --increment
afirma "instagramId malicioso dentro do JSON: recusa" test "$RC" -eq 2
afirma "instagram.json continua intacto" grep -q '"x":1' "$SFWS/.dgclaw/instagram.json"
ln -s "$SFWS/.dgclaw/instagram.json" "$SFWS/persona/followers/55555.json"
sf --id 55555 --create --increment
afirma "cadastro que e link simbolico: recusa" test "$RC" -eq 2
afirma "o alvo do link ficou intacto" grep -q '"x":1' "$SFWS/.dgclaw/instagram.json"

echo "scrape-comments --update-followers: id fora do formato e ignorado"
SCW="$TMP/scws"
rm -rf "$SCW"; mkdir -p "$SCW/data" "$SCW/persona"
echo '{"comments":[{"instagramId":"../../.dgclaw/x","username":"a","text":"oi","createdAt":"2026-01-01T00:00:00+00:00"},{"instagramId":"777","username":"b","text":"oi","createdAt":"2026-01-01T00:00:00+00:00"}]}' >"$SCW/data/scraped_comments.json"
if python3 -c 'import requests' 2>/dev/null; then
    RC=0; env DGCLAW_WORKSPACE="$SCW" python3 "$REPO/scripts/scrape-comments.py" --update-followers >"$TMP/saida.txt" 2>&1 || RC=$?
    afirma "sai com 0" test "$RC" -eq 0
    afirma "criou so o id numerico" test -f "$SCW/persona/followers/777.json"
    nega "nada fora da pasta de seguidores" test -e "$SCW/.dgclaw"
    afirma "avisa do ignorado" grep -q 'fora do formato' "$TMP/saida.txt"
else
    ok "(sem a lib requests nesta maquina: o CI cobre o scrape)"
fi


printf '\n%s verificacoes, %s falharam.\n' "$((PASSOU + FALHOU))" "$FALHOU"
[ "$FALHOU" -eq 0 ]
