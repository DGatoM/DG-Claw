#!/usr/bin/env bash
# `dgclaw agente criar`: faixa de uid, portas, agentes.json, segredos, podman create.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

echo "criar: faixa de uid"
criar_agente ana --nome "Ana" --dono "Marta"
igual "primeiro agente: faixa 1000000, numero 1" "ana	1000000	1" "$(cat "$ETC/registro.tsv")"
criar_agente beto --nome "Beto" --provedor codex
igual "segundo agente: proxima faixa (1065536), numero 2" "beto	1065536	2" "$(sed -n 2p "$ETC/registro.tsv")"
criar_agente ana --nome "Ana" --dono "Marta"
igual "repetir o mesmo slug reaproveita a propria linha" "2" "$(wc -l <"$ETC/registro.tsv" | tr -d ' ')"
rm -f "$ETC/runner/beto.token"   # a faixa nao depende dos arquivos
dgclaw agente remover beto --sim >/dev/null 2>&1
criar_agente dina --nome "Dina"
igual "faixa de agente aposentado nao e reaproveitada (pelo maior, nao pela contagem)" "dina	1131072	3" "$(sed -n 3p "$ETC/registro.tsv")"
igual "registro.tsv com modo 600" "600" "$(stat -c %a "$ETC/registro.tsv")"

echo "criar: portas"
igual "portas de ana: runner 4311, painel 8311" "4311 8311" "$(jq -r '.agentes[] | select(.slug=="ana") | "\(.runner|sub("^.*:";"")) \(.porta_painel)"' "$ETC/agentes.json")"
igual "portas de dina saltam as de ana (4313/8313, beto ja saiu e liberou as dele)" "4312 8312" "$(jq -r '.agentes[] | select(.slug=="dina") | "\(.runner|sub("^.*:";"")) \(.porta_painel)"' "$ETC/agentes.json")"

echo "criar: portas ocupadas"
preparar
printf '4311\n4312\n8311\n' >"$STUB_ESTADO/ss"
jq -n '{versao:1, agentes:[{slug:"outro", tipo:"agente", runner:"http://127.0.0.1:4313", porta_painel:8312}]}' >"$ETC/agentes.json"
criar_agente eva --nome "Eva"
igual "pula as portas que o ss mostra e as do agentes.json" "4314 8313" "$(jq -r '.agentes[] | select(.slug=="eva") | "\(.runner|sub("^.*:";"")) \(.porta_painel)"' "$ETC/agentes.json")"

echo "criar: porta ocupada no topo de uma lista grande (SIGPIPE do grep -q sob pipefail)"
# Com `printf | grep -q`, a lista maior que o buffer do pipe (64 KiB) garante o SIGPIPE: o
# grep acha a porta na 1a linha e sai, o printf morre com 141 e a porta ocupada passava por
# livre. Aqui o resultado e deterministico, sem depender da carga da maquina.
preparar
{ printf '4311\n8311\n'; seq 10000 29999; } >"$STUB_ESTADO/ss"
criar_agente fabi --nome "Fabi"
igual "porta ocupada no topo de lista grande continua ocupada" "4312 8312" "$(jq -r '.agentes[] | select(.slug=="fabi") | "\(.runner|sub("^.*:";"")) \(.porta_painel)"' "$ETC/agentes.json")"

echo "criar: agentes.json"
preparar
criar_agente ana --nome "Ana Silva" --papel "organiza a agenda" --jeito "calma e direta" --dono "Marta" --avatar "C" --cor "#10b981"
AJ="$ETC/agentes.json"
afirma "agentes.json e um JSON valido" jq -e . "$AJ"
igual "versao 1" "1" "$(jq -r .versao "$AJ")"
igual "campos exatamente os do contrato, na ordem" \
    "slug,nome,tipo,runner,agente_id,chat_id,avatar,cor,provedor,modelo,transcripts_dir,porta_painel,proxy_segredo_arquivo,runner_token_arquivo,home_host,home_container,cofre_arquivo,container" \
    "$(jq -r '.agentes[0] | keys_unsorted | join(",")' "$AJ")"
igual "tipo agente" "agente" "$(jq -r '.agentes[0].tipo' "$AJ")"
igual "chat_id c_<slug>" "c_ana" "$(jq -r '.agentes[0].chat_id' "$AJ")"
igual "transcripts_dir do Claude" "$LIB/agentes/ana/home/.claude/projects/-home-agente" "$(jq -r '.agentes[0].transcripts_dir' "$AJ")"
igual "token do runner so como caminho" "$ETC/runner/ana.token" "$(jq -r '.agentes[0].runner_token_arquivo' "$AJ")"
igual "porta_painel e numero" "number" "$(jq -r '.agentes[0].porta_painel | type' "$AJ")"
igual "nenhum arquivo temporario sobrando ao lado do agentes.json" "0" "$(find "$ETC" -maxdepth 1 -name '.agentes.json.*' | wc -l | tr -d ' ')"
criar_agente beto --nome "Beto" --provedor codex
igual "transcripts_dir do Codex" "$LIB/agentes/beto/home/.codex/sessions" "$(jq -r '.agentes[] | select(.slug=="beto") | .transcripts_dir' "$AJ")"
igual "dois agentes no registro" "2" "$(jq '.agentes | length' "$AJ")"

echo "criar: segredos"
for f in "$ETC/runner/ana.token" "$ETC/proxy/ana.segredo" "$LIB/agentes/ana/segredos/runner.token" "$LIB/agentes/ana/segredos/proxy.segredo"; do
    igual "modo 600 em ${f#"$DGCLAW_RAIZ"}" "600" "$(stat -c %a "$f")"
done
igual "token do runner tem 64 hex" "64" "$(tr -d '\n' <"$ETC/runner/ana.token" | wc -c | tr -d ' ')"
igual "a copia dentro da casa e igual ao do host" "$(cat "$ETC/runner/ana.token")" "$(cat "$LIB/agentes/ana/segredos/runner.token")"
vazou=0
for f in "$ETC/runner/ana.token" "$ETC/proxy/ana.segredo"; do
    grep -qF "$(cat "$f")" "$AJ" && vazou=1
    grep -qF "$(cat "$f")" "$STUB_LOG" && vazou=1
    grep -rqF "$(cat "$f")" "$LIB/agentes/ana/home" && vazou=1
done
igual "nenhum segredo no agentes.json, no argv do podman nem na casa" "0" "$vazou"
antes="$(cat "$ETC/runner/ana.token" "$ETC/proxy/ana.segredo" | md5sum)"
criar_agente ana --nome "Ana Silva"
igual "segredos nao mudam numa segunda execucao" "$antes" "$(cat "$ETC/runner/ana.token" "$ETC/proxy/ana.segredo" | md5sum)"
igual "so um registro de ana depois de repetir" "1" "$(jq '[.agentes[] | select(.slug=="ana")] | length' "$AJ")"
igual "so um podman create de ana depois de repetir" "1" "$(grep -c '^podman create .*--name dgclaw-ana ' "$STUB_LOG")"

echo "criar: a casa e a identidade"
H="$LIB/agentes/ana/home"
RJ="$LIB/agentes/ana/runner/runner.json"
igual "runner.json fora da home, em runner/, modo 444" "444" "$(stat -c %a "$RJ")"
igual "pasta runner/ 755" "755" "$(stat -c %a "$LIB/agentes/ana/runner")"
nega "nao sobra runner.json dentro de .plataforma" test -e "$H/.plataforma/runner.json"
igual "envExtra: id, url e arquivo do token (so o caminho)" "ana http://127.0.0.1:4300 /run/dgclaw/segredos/runner.token" \
    "$(jq -r '.config.envExtra | "\(.DGCLAW_AGENTE_ID) \(.DGCLAW_RUNNER_URL) \(.RUNNER_TOKEN_FILE)"' "$RJ")"
igual "settings.json 444" "444" "$(stat -c %a "$H/.claude/settings.json")"
igual "home 700" "700" "$(stat -c %a "$H")"
igual ".dgclaw 700 (o dgclaw-agente grava canais.json ali)" "700" "$(stat -c %a "$H/.dgclaw")"
SL="$H/.claude/settings.local.json"
igual "gmail: settings.local.json 644" "644" "$(stat -c %a "$SL")"
afirma "gmail: enviar bloqueado (deny send_message)" jq -e '.permissions.deny | index("mcp__claude_ai_Gmail__send_message")' "$SL"
afirma "gmail: ler continua liberado" jq -e '[.permissions.deny[] | select(test("get_message|search_threads"))] | length == 0' "$SL"
if [ "$(id -u)" -eq 0 ]; then
    igual "gmail: settings.local.json tem o mesmo dono da casa (o agente)" "$(stat -c %u:%g "$H")" "$(stat -c %u:%g "$SL")"
    nega "gmail: settings.local.json nao e do root" test "$(stat -c %u "$SL")" = 0
else
    afirma "gmail: chown do settings.local.json para o agente" grep -q "settings.local.json" "$DGCLAW_RAIZ/.chown-simulado"
fi
igual "gmail: settings.json segue 0:0 444" "0:0 444" "$(stat -c '%u:%g %a' "$H/.claude/settings.json")"
nega "gmail: nada escrito no /home/agente do host" test -e /home/agente/.dgclaw/logs/permissoes.log
jq '.permissions.deny = ["marca-do-dono"]' "$SL" >"$TMP/sl.json" && cat "$TMP/sl.json" >"$SL"
criar_agente ana --nome "Ana Silva"
igual "gmail: rodar o criar de novo nao desfaz a escolha do dono" "marca-do-dono" "$(jq -r '.permissions.deny[0]' "$SL")"

# Como root o chown acontece de verdade na pasta temporaria; sem root ele fica registrado.
dono_real() { if [ "$(id -u)" -eq 0 ]; then stat -c %u:%g "$1"; else awk -v p="$1" '$2 == p {print $1}' "$DGCLAW_RAIZ/.chown-simulado" | tail -1; fi; }
echo "criar: o aviso do modo Bypass do Claude Code (skipDangerousModePermissionPrompt)"
ST="$H/.claude/settings.json"
igual "settings.json nasce com a chave e com os hooks vazios" "true {}" "$(jq -r '"\(.skipDangerousModePermissionPrompt) \(.hooks)"' "$ST")"
chmod 644 "$ST"
printf '{"hooks": {"Stop": []}, "model": "x"}\n' >"$ST"
criar_agente ana --nome "Ana Silva"
igual "settings.json antigo: a chave entra e o resto fica" "true x" "$(jq -r '"\(.skipDangerousModePermissionPrompt) \(.model)"' "$ST")"
afirma "settings.json antigo: os hooks dele continuam" jq -e '.hooks.Stop == []' "$ST"
igual "settings.json mesclado segue 0:0 444" "0:0 444" "$(dono_real "$ST") $(stat -c %a "$ST")"
chmod 644 "$ST"
printf 'isto nao e json' >"$ST"
criar_agente ana --nome "Ana Silva"
igual "settings.json invalido: nao foi tocado" "isto nao e json" "$(cat "$ST")"
afirma "settings.json invalido: o criar avisa com o caminho" grep -q "$ST nao e um JSON valido" "$TMP/saida.txt"
igual "painel.env 644" "644" "$(stat -c %a "$LIB/agentes/ana/config/painel.env")"
igual "cofre.env 600 e vazio" "600 0" "$(stat -c '%a %s' "$LIB/agentes/ana/cofre/cofre.env")"
igual "settings.json de dono 0:0" "0:0" "$(dono_real "$H/.claude/settings.json")"
igual "runner.json de dono 0:0" "0:0" "$(dono_real "$RJ")"
igual "home do uid 1001001 (base + 1001)" "1001001:1001001" "$(dono_real "$H")"
igual ".dgclaw do uid do agente" "1001001:1001001" "$(dono_real "$H/.dgclaw")"
igual "cofre.env do uid_base (root do container)" "1000000:1000000" "$(dono_real "$LIB/agentes/ana/cofre/cofre.env")"
igual "runner.json: provider local-cli" "local-cli" "$(jq -r .config.provider "$RJ")"
igual "runner.json: nome" "Ana Silva" "$(jq -r .config.name "$RJ")"
igual "runner.json: sem DGCHAT_URL" "false" "$(jq '.config.envExtra | has("DGCHAT_URL")' "$RJ")"
igual "runner.json do Codex: provider codex-cli" "codex-cli" "$(jq -r .config.provider "$LIB/agentes/beto/runner/runner.json")"
afirma "AGENT.md traz o papel" grep -q "organiza a agenda" "$H/AGENT.md"
afirma "AGENT.md traz o jeito" grep -q "calma e direta" "$H/AGENT.md"
afirma "AGENT.md chama o dono pelo nome" grep -q "Marta" "$H/AGENT.md"
nega "nenhum campo {{...}} cru na identidade" grep -rq '{{' "$H/AGENT.md" "$H/CLAUDE.md" "$H/AGENTS.md" "$H/MEMORY.md" "$H/.plataforma/identidade.md"
afirma "identidade.md leva a regra do canal com o chat c_ana" grep -q 'chat="c_ana"' "$H/.plataforma/identidade.md"
nega "identidade.md nao diz que a conversa e pelo Telegram" grep -qiE "conversa (com .* )?pelo telegram|lista de permissao do telegram" "$H/.plataforma/identidade.md"
afirma "config.sh tem o slug" grep -q "DGCLAW_SLUG='ana'" "$H/.dgclaw/config.sh"
afirma "config.sh aponta o plugin para /opt/dgclaw/app" grep -q "DGCLAW_PLUGIN_ROOT='/opt/dgclaw/app'" "$H/.dgclaw/config.sh"
afirma "config.sh manda o inject.py para o runner do container" grep -q "DGCLAW_INJECT_MODE='bunker'" "$H/.dgclaw/config.sh"
afirma "config.sh aponta o card do runner pelo slug" grep -q "DGCLAW_BUNKER_CARD='ana'" "$H/.dgclaw/config.sh"
afirma "config.sh aponta o runner de dentro do container" grep -q "DGCLAW_BUNKER_URL='http://127.0.0.1:4300'" "$H/.dgclaw/config.sh"
igual "panel/config.json: slug" "ana" "$(jq -r .agentSlug "$H/.dgclaw/panel/config.json")"
igual "painel.env: base /p/ana" "1" "$(grep -c '^DGCLAW_PANEL_BASE=/p/ana$' "$LIB/agentes/ana/config/painel.env")"
igual "painel.env: cofre em modo host" "1" "$(grep -c '^DGCLAW_COFRE_NOMES=/run/dgclaw/config/cofre-nomes$' "$LIB/agentes/ana/config/painel.env")"
preparar
criar_agente sem-papel --nome "Sem Papel"
nega "papel e jeito vazios viram texto neutro (sem campo cru)" grep -q '{{' "$LIB/agentes/sem-papel/home/AGENT.md"
afirma "papel neutro presente" grep -q "Assistente de uso geral" "$LIB/agentes/sem-papel/home/AGENT.md"
preparar
criar_agente tel --nome "Tel" --canal telegram
igual "canal telegram so fica anotado" "telegram" "$(cat "$LIB/agentes/tel/home/.dgclaw/canal-desejado")"

echo "criar: podman"
preparar
criar_agente ana --nome "Ana"
linha="$(grep '^podman create ' "$STUB_LOG")"
igual "uidmap 0:1000000:65536" "1" "$(grep -c -- '--uidmap 0:1000000:65536' <<<"$linha")"
igual "gidmap igual" "1" "$(grep -c -- '--gidmap 0:1000000:65536' <<<"$linha")"
igual "duas publicacoes" "2" "$(grep -o -- '--publish [^ ]*' <<<"$linha" | wc -l | tr -d ' ')"
igual "todas as portas publicadas so em 127.0.0.1" "0" "$(grep -o -- '--publish [^ ]*' <<<"$linha" | grep -vc -- '--publish 127.0.0.1:')"
afirma "rede propria" grep -q -- '--network dgclaw-ana' <<<"$linha"
afirma "systemd always" grep -q -- '--systemd always' <<<"$linha"
afirma "runner/ montada so leitura em /etc/dgclaw-runner" grep -q -- 'ana/runner:/etc/dgclaw-runner:ro' <<<"$linha"
afirma "cofre montado so leitura" grep -q -- '/cofre:/run/dgclaw/cofre:ro' <<<"$linha"
afirma "rede criada com subnet 10.89.1.0/24 e sem DNS" grep -q 'network create --disable-dns --subnet 10.89.1.0/24 dgclaw-ana' "$STUB_LOG"
afirma "container iniciado" grep -q '^podman start dgclaw-ana' "$STUB_LOG"
afirma "a vida (install-timers) foi mandada por STDIN para dentro" grep -q 'install-timers.sh' "$STUB_LOG.stdin"
afirma "enable --now do runner e do painel" grep -q 'enable --now dgclaw-runner.service dgclaw-painel.service' "$STUB_LOG.stdin"
afirma "plugin do Telegram pre-instalado" grep -q 'plugin install telegram@claude-plugins-official' "$STUB_LOG.stdin"
afirma "marketplace oficial" grep -q 'marketplace add anthropics/claude-plugins-official' "$STUB_LOG.stdin"
afirma "a CLI espera /api/saude" grep -q 'curl .*127.0.0.1:4311/api/saude' "$STUB_LOG"
afirma "create sem o proxy do host (--http-proxy=false)" grep -q -- '--http-proxy=false' <<<"$linha"
afirma "confere o ambiente do agente por dentro" grep -q '^podman exec --user agente dgclaw-ana env' "$STUB_LOG"
afirma "confere a saida para api.anthropic.com por dentro" grep -q '^podman exec --user agente dgclaw-ana curl .*https://api.anthropic.com' "$STUB_LOG"
afirma "sem proxy e com internet: diz que esta ok" grep -q 'sem variavel de proxy dentro do agente' "$TMP/saida.txt"

echo "criar: proxy e internet de dentro do agente"
preparar
touch "$STUB_ESTADO/exec-proxy" "$STUB_ESTADO/sem-internet"
criar_agente ana --nome "Ana"
igual "proxy ou sem internet nao derrubam o criar" "0" "$?"
afirma "proxy dentro do agente: aviso com o nome da variavel" grep -q 'variavel de proxy no ambiente (HTTPS_PROXY' "$TMP/saida.txt"
afirma "sem internet: aviso com o erro do curl" grep -q 'api.anthropic.com falhou (codigo 6: curl: (6) Could not resolve host' "$TMP/saida.txt"
nega "sem internet: o arquivo temporario do erro nao sobra" test -e "$LIB/agentes/ana/.curl-erro"

echo "criar: --ensaio"
preparar
dgclaw --ensaio agente criar ana --nome "Ana" >"$TMP/ensaio.txt" 2>&1
igual "ensaio sai com 0" "0" "$?"
nega "ensaio nao cria a pasta dos agentes" test -e "$LIB/agentes"
nega "ensaio nao cria registro.tsv" test -e "$ETC/registro.tsv"
nega "ensaio nao cria agentes.json" test -e "$ETC/agentes.json"
nega "ensaio nao cria segredos" test -e "$ETC/runner"
nega "ensaio nao chama podman create/start/network create" grep -Eq '^podman (create|start|network create)' "$STUB_LOG"
afirma "ensaio anuncia o que faria" grep -q 'ensaio' "$TMP/ensaio.txt"
preparar
dgclaw agente criar ana --nome "Ana" --ensaio >/dev/null 2>&1
nega "--ensaio vale tambem depois do subcomando" test -e "$ETC/registro.tsv"

echo "criar de novo: link na casa do agente e recusado"
preparar
criar_agente bia --nome "Bia"
HB="$LIB/agentes/bia/home"
mkdir -p "$TMP/fora-bia"
mv "$HB/.dgclaw" "$TMP/dgclaw-bia-guardada"
ln -s "$TMP/fora-bia" "$HB/.dgclaw"
criar_agente bia --nome "Bia"
nega "criar de novo com .dgclaw em link nao sai com 0" test "$?" = 0
afirma "explica o link e o que fazer" grep -q "nao gravo como root fora da casa" "$TMP/saida.txt"
igual "nada foi gravado fora da casa" "" "$(ls -A "$TMP/fora-bia")"
rm "$HB/.dgclaw" && mv "$TMP/dgclaw-bia-guardada" "$HB/.dgclaw"
# Arquivo trocado por link: o chown dele daria ao agente a posse do alvo.
printf 'alvo do servidor\n' >"$TMP/alvo-bia"
rm -f "$HB/.dgclaw/logs/permissoes.log"
ln -s "$TMP/alvo-bia" "$HB/.dgclaw/logs/permissoes.log"
criar_agente bia --nome "Bia"
nega "criar de novo com permissoes.log em link nao sai com 0" test "$?" = 0
afirma "cita o arquivo que e link" grep -q "permissoes.log, na casa do agente bia, e um link" "$TMP/saida.txt"
nega "o alvo do link nao foi tocado pelo chown" grep -q "alvo-bia" "$DGCLAW_RAIZ/.chown-simulado"
rm "$HB/.dgclaw/logs/permissoes.log"
criar_agente bia --nome "Bia"
igual "sem o link, criar de novo volta a passar" "0" "$?"

fim
