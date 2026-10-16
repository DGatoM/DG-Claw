#!/bin/bash
# install-panel-service.sh - Instala/atualiza o Painel Robusto do DG Claw como systemd service.
#
# IDEMPOTENTE (desde 10/08/2026). Antes disso, rodar este script DE NOVO num agente que
# ja tinha o painel (pra atualizar ou reinstalar) sorteava o salto de hash e a senha do
# zero e reescrevia o config.json inteiro, trocava a senha do dono em silencio e apagava
# qualquer ajuste que ele tivesse feito (blockedFiles, schedule, budgetUsd, chat,
# bunkerCard...). Grave porque as alunas ja tinham baixado o script antigo. Agora: so
# nasce valor novo (salto, senha, porta) o que NAO foi encontrado no que ja existe; o
# config.json e MESCLADO, nunca reescrito do zero.
#
# Uso:  sudo bash install-panel-service.sh <.dgclaw/config.sh> [--loopback] [--base <prefixo>]
#
#   --loopback         painel passa a escutar SO em 127.0.0.1 (Environment=DGCLAW_PANEL_HOST
#                       no unit). E o modo de quando o painel fica atras de uma fachada e
#                       nao deve ser alcancavel direto pelo IP da VPS. Sem a flag, escuta em
#                       0.0.0.0, igual a sempre.
#   --base <prefixo>   grava Environment=DGCLAW_PANEL_BASE=<prefixo> no unit: o painel passa
#                       a servir sob esse prefixo (ex.: /agente/ana/painel) em vez da raiz.
#
# As duas flags valem so pra ESTA execucao; se voce rodar o script de novo sem passa-las, o
# valor que ja estava no unit e preservado (mesma regra do salto/senha/porta).
#
# O config.sh do DG Claw expõe (entre outros):
#   DGCLAW_SLUG, DGCLAW_WORKSPACE, DGCLAW_NAME, DGCLAW_OWNER,
#   DGCLAW_OWNER_TELEGRAM_ID, DGCLAW_WORKSPACE, TELEGRAM_STATE_DIR
#
# Passos:
#   1. Sourcia a config.
#   2. Descobre o que ja existe (salto de hash, senha, porta, host, base) ANTES de mexer
#      em qualquer arquivo: so sorteia/escolhe o que nao achou.
#   3. Copia panel/ → $WS/.dgclaw/panel/ (copia estavel: SEM node_modules, SEM config.json;
#      o config.json do plugin em si e so um EXEMPLO, nunca o do agente).
#   4. Mescla $WS/.dgclaw/panel/config.json com o que o instalador manda (nao reescreve).
#   5. npm ci/install --omit=dev (versões pinadas; commit do lockfile).
#   6. Desativa o painel Flask antigo (dgclaw-<slug>-panel) se ativo (rollback-safe).
#   7. Cria/atualiza e sobe dgclaw-panel-<slug>.service.
#   8. Ecoa URL; a senha SO aparece impressa quando foi criada AGORA.
#
# Teste de idempotencia (nunca toca em agente real, nunca cria unit systemd de verdade):
# scripts/test-install-panel-idempotente.sh. Ele roda este proprio script duas vezes contra
# um workspace descartavel, com DGCLAW_INSTALL_TEST_MODE=1: a variavel pula os passos 5, 6
# e 7 (npm, desativar o painel antigo, criar/subir o unit) e mantem so a descoberta (passo 2)
# e a mescla do config.json (passo 4), que sao as duas partes que este teste prova.

set -euo pipefail

CONFIG="${1:?Uso: install-panel-service.sh <.dgclaw/config.sh> [--loopback] [--base <prefixo>]}"
shift
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }

LOOPBACK=0
BASE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --loopback) LOOPBACK=1; shift ;;
    --base) BASE_ARG="${2:?--base precisa de um prefixo, ex.: --base /agente/ana/painel}"; shift 2 ;;
    *) echo "opcao desconhecida: $1" >&2; exit 1 ;;
  esac
done

# Diretório deste script (pra achar o panel/ do plugin)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_PANEL_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/panel"
[ -d "$PLUGIN_PANEL_SRC" ] || { echo "panel/ nao encontrado em $PLUGIN_PANEL_SRC" >&2; exit 1; }

# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"

SLUG="$DGCLAW_SLUG"
WS="$DGCLAW_WORKSPACE"
NAME="${DGCLAW_NAME:-$SLUG}"
OWNER="${DGCLAW_OWNER:-Dono}"
OWNER_TG="${DGCLAW_OWNER_TELEGRAM_ID:-}"

PANEL_DST="$WS/.dgclaw/panel"
CONFIG_JSON="$PANEL_DST/config.json"
LOG_DIR="$WS/.dgclaw/logs"
SVC="dgclaw-panel-${SLUG}.service"
# Injetavel so pra teste: sem isto, provar que a senha SOBREVIVE a uma reinstalacao
# exigiria escrever em /etc/systemd/system, e um teste que precisa mexer no systemd de
# verdade e um teste que ninguem roda. Em uso normal fica no lugar de sempre.
UNIT_DIR="${DGCLAW_UNIT_DIR:-/etc/systemd/system}"
UNIT_FILE="$UNIT_DIR/$SVC"

echo "==> DG Claw Painel: instalando para '$SLUG' ($NAME)"
echo "    workspace: $WS"

gen_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | xxd -p | tr -d '\n'; fi
}

# Le uma variavel do Environment de um unit systemd ja instalado. Primeiro pelo proprio
# systemd (systemctl show), que reflete o unit carregado de verdade; se o unit foi escrito
# em disco mas nunca passou por daemon-reload (instalacao anterior interrompida no meio),
# systemctl nao acha nada, ai cai pro grep direto no arquivo do unit.
unit_env() {
  local key="$1" val=""
  if [ -f "$UNIT_FILE" ]; then
    val="$(systemctl show -p Environment --value "$SVC" 2>/dev/null \
      | tr ' ' '\n' | grep "^${key}=" | cut -d= -f2- || true)"
    if [ -z "$val" ]; then
      val="$(grep -oP "^Environment=${key}=\K.*" "$UNIT_FILE" 2>/dev/null | tail -1 || true)"
    fi
  fi
  printf '%s' "$val"
}

# ── 2. Descobre o que ja existe (idempotencia) ────────────────────────────
# Le TUDO antes de tocar em qualquer arquivo: o salto de hash (do config.json atual),
# a senha e a porta (do unit systemd atual). So sorteia/escolhe o que nao foi encontrado.

EXISTING_HASH_SALT=""
if [ -f "$CONFIG_JSON" ]; then
  EXISTING_HASH_SALT="$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
      if (c && typeof c.authSalt === "string" && c.authSalt) process.stdout.write(c.authSalt);
    } catch { /* config.json ausente ou invalido: trata como se nao existisse */ }
  ' "$CONFIG_JSON" 2>/dev/null || true)"
fi

EXISTING_PANEL_SECRET="$(unit_env DGCLAW_PANEL_PASSWORD)"
EXISTING_PORT="$(unit_env DGCLAW_PANEL_PORT)"
EXISTING_HOST="$(unit_env DGCLAW_PANEL_HOST)"
EXISTING_BASE="$(unit_env DGCLAW_PANEL_BASE)"

if [ -n "$EXISTING_HASH_SALT" ]; then
  SALT_FINAL="$EXISTING_HASH_SALT"
  echo "==> authSalt preservado (o de sempre)"
else
  SALT_FINAL="$(gen_hex 16)"
  echo "==> authSalt novo (nao havia config.json valido ainda)"
fi

SENHA_NOVA=0
if [ -n "$EXISTING_PANEL_SECRET" ]; then
  PANEL_PASSWORD="$EXISTING_PANEL_SECRET"
  echo "==> senha preservada (a mesma de antes, nao mudou)"
else
  PANEL_PASSWORD="$(gen_hex 12)"
  SENHA_NOVA=1
  echo "==> senha nova (nao havia service instalado ainda)"
fi

# Porta: pode vir preservada do unit, ou (numa instalacao NOVA) escolhida agora. Nunca
# sobe em silencio por cima de outro processo que ja esteja ouvindo nela.
porta_ocupada() {
  [ -n "$(ss -ltn "sport = :$1" 2>/dev/null | tail -n +2)" ]
}

if [ -n "$EXISTING_PORT" ]; then
  PORT="$EXISTING_PORT"
  echo "==> porta preservada: $PORT"
else
  PORT_DESEJADA="${DGCLAW_PANEL_PORT:-8300}"
  if porta_ocupada "$PORT_DESEJADA"; then
    PORT_LIVRE=""
    for off in $(seq 1 20); do
      cand=$((PORT_DESEJADA + off))
      if ! porta_ocupada "$cand"; then PORT_LIVRE="$cand"; break; fi
    done
    if [ -z "$PORT_LIVRE" ]; then
      echo "ERRO: a porta $PORT_DESEJADA ja esta em uso por outro processo, e nenhuma das" >&2
      echo "20 seguintes ($((PORT_DESEJADA + 1))-$((PORT_DESEJADA + 20))) esta livre." >&2
      echo "Libere uma porta ou rode de novo com DGCLAW_PANEL_PORT=<outra> definido." >&2
      exit 1
    fi
    echo "==> a porta $PORT_DESEJADA ja estava ocupada por outro processo; escolhi $PORT_LIVRE em vez dela"
    PORT="$PORT_LIVRE"
  else
    PORT="$PORT_DESEJADA"
    echo "==> porta nova: $PORT"
  fi
fi

# --loopback / --base valem pra ESTA execucao (intencao explicita de quem roda o script
# agora) e vencem o que ja estava no unit; sem a flag, o que ja existia e preservado.
if [ "$LOOPBACK" = "1" ]; then
  HOST_FINAL="127.0.0.1"
  echo "==> --loopback: painel vai escutar so em 127.0.0.1"
elif [ -n "$EXISTING_HOST" ]; then
  HOST_FINAL="$EXISTING_HOST"
  echo "==> DGCLAW_PANEL_HOST preservado: $HOST_FINAL"
else
  HOST_FINAL=""
fi

if [ -n "$BASE_ARG" ]; then
  BASE_FINAL="$BASE_ARG"
  echo "==> --base: painel vai servir sob $BASE_FINAL"
elif [ -n "$EXISTING_BASE" ]; then
  BASE_FINAL="$EXISTING_BASE"
  echo "==> DGCLAW_PANEL_BASE preservado: $BASE_FINAL"
else
  BASE_FINAL=""
fi

# ── 3. Copia panel/ (estável, sem node_modules, sem config.json) ─────────────
# config.json fica de fora da copia: o panel/config.json do PLUGIN é só um EXEMPLO
# (schedule de amostra, salto de hash "troque-na-instalacao"), nunca o config real do
# agente. Copia-lo por cima apagaria a mescla feita no passo seguinte.
mkdir -p "$PANEL_DST" "$LOG_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'node_modules' --exclude '.env' --exclude '.git' --exclude 'config.json' \
    "$PLUGIN_PANEL_SRC"/ "$PANEL_DST"/
else
  # cp nao tem --exclude: preserva o config.json do agente (se ja existir) antes de
  # copiar tudo, e restaura por cima; numa instalacao nova, remove o exemplo copiado.
  CONFIG_BACKUP=""
  if [ -f "$CONFIG_JSON" ]; then
    CONFIG_BACKUP="$(mktemp)"
    cp "$CONFIG_JSON" "$CONFIG_BACKUP"
  fi
  cp -a "$PLUGIN_PANEL_SRC"/. "$PANEL_DST"/
  rm -rf "$PANEL_DST/node_modules" "$PANEL_DST/.env" "$PANEL_DST/.git"
  if [ -n "$CONFIG_BACKUP" ]; then
    mv "$CONFIG_BACKUP" "$CONFIG_JSON"
  else
    rm -f "$CONFIG_JSON"
  fi
fi
echo "==> panel/ copiado para $PANEL_DST"

# ── 3b. O painel e os scripts que ele chama precisam ser da MESMA versao ─────
# A aba Conversa nao le nem escreve sozinha: ela chama o `inject.py` e o
# `thread_log.py`, que NAO moram no painel, e sim na copia estavel do plugin
# ($WS/.dgclaw/plugin/, feita pelo install-core.sh). Este script atualiza o
# painel e nao encosta naquela copia, entao rodar so ele deixa os dois em
# versoes diferentes.
#
# Isso nao e hipotese: aconteceu com a Ana em 10/08/2026. O painel novo pedia
# `inject.py --transcript`, a copia dela era de tres horas antes e nao conhecia a
# opcao, e o resultado na tela foi "Ainda nao achei o diario desta sessao" -
# uma frase plausivel e errada, sobre um transcript de 111 KB que estava no disco.
# Um script que falta e um script que nao achou nada falham igual, entao o alerta
# tem que vir daqui, onde da pra comparar os dois lados.
LIB_AGENTE="$WS/.dgclaw/plugin/scripts/_lib"
LIB_PLUGIN="$(cd "$SCRIPT_DIR" && pwd)/_lib"
if [ -d "$LIB_PLUGIN" ]; then
  if [ ! -d "$LIB_AGENTE" ]; then
    echo "!!  ATENCAO: nao achei $LIB_AGENTE."
    echo "    A aba Conversa nao vai conseguir ler nem escrever ate isso existir."
    echo "    O que fazer: rodar o bootstrap do plugin neste agente"
    echo "      bash $SCRIPT_DIR/install-core.sh bootstrap --dgclaw-config $CONFIG"
  elif ! diff -rq "$LIB_PLUGIN" "$LIB_AGENTE" >/dev/null 2>&1; then
    echo "!!  ATENCAO: a copia do plugin deste agente esta DIFERENTE do plugin que acabei"
    echo "    de instalar o painel. O painel chama inject.py/thread_log.py de la, entao os"
    echo "    dois em versoes diferentes dao erro que se disfarca de 'nao achei a conversa'."
    echo "    O que fazer: atualizar a copia estavel do plugin deste agente"
    echo "      bash $SCRIPT_DIR/install-core.sh bootstrap --dgclaw-config $CONFIG"
  fi
fi

# ── 3c. E o agente precisa ter COMO RESPONDER pelo painel ───────────────────
# O item 3b cobre a metade da LEITURA. Esta cobre a da ESCRITA, e ela falha de um
# jeito ainda mais silencioso: a mensagem da pessoa chega no agente, ele responde
# em texto puro, e o `thread_log.py` (que so conta como fala dele o que sai por
# uma tool de envio) nao tem o que mostrar. A tela fica com a pergunta dela e
# silencio embaixo, sem erro em lugar nenhum.
#
# O servidor do canal mora na copia do plugin, nao no painel, entao um painel novo
# sobre uma copia anterior a 11/08/2026 cai exatamente nisso.
MCP_AGENTE="$WS/.dgclaw/plugin/scripts/dgchat-mcp/server.mjs"
if [ -f "$(cd "$SCRIPT_DIR" && pwd)/dgchat-mcp/server.mjs" ] && [ ! -f "$MCP_AGENTE" ]; then
  echo "!!  ATENCAO: a copia do plugin deste agente nao tem o canal do painel"
  echo "    ($MCP_AGENTE)."
  echo "    Sem ele o agente RECEBE o que for escrito na aba Conversa e nao tem como"
  echo "    responder: a resposta dele nao chega em ninguem e a tela fica muda."
  echo "    O que fazer: atualizar a copia estavel do plugin e reiniciar a sessao dele"
  echo "      bash $SCRIPT_DIR/install-core.sh bootstrap --dgclaw-config $CONFIG"
  echo "      systemctl restart dgclaw-<slug>.service"
fi

# ── 4. Mescla o config.json (nunca reescreve do zero) ────────────────────────
# Chaves que o instalador manda (agentName, agentSlug, agentDir, creatorId, creatorName,
# logDir, logPrefix, authSalt) sempre vencem. TODAS as outras (blockedFiles, schedule,
# budgetUsd, chat, bunkerCard, bunkerUrl, o que for) sobrevivem intactas se ja existirem;
# se a chave nao existir ainda (instalacao nova), leva o default de sempre.
MERGE_JS="$(mktemp --suffix=.cjs)"
cat > "$MERGE_JS" <<'JS'
const fs = require('fs');

const configPath = process.env.DGCLAW_MERGE_CONFIG_JSON;
const tmpPath = configPath + '.tmp';

const defaults = {
  creatorKey: 'agent_owner',
  meetingsDir: null,
  budgetUsd: 200,
  avatar: '/assets/sprites/avatar.jpg',
  level: null,
  timezoneOffsetHours: -3,
  schedule: [],
  moodSprites: null,
  logs: null,
  costAnalyzer: null,
  blockedFiles: ['.instagram_token', '.heygen_token', 'cookies.txt', '.env', 'config.sh'],
};

const managed = {
  agentName: process.env.DGCLAW_MERGE_NAME,
  agentSlug: process.env.DGCLAW_MERGE_SLUG,
  agentDir: process.env.DGCLAW_MERGE_WS,
  creatorId: process.env.DGCLAW_MERGE_OWNER_TG,
  creatorName: process.env.DGCLAW_MERGE_OWNER,
  logDir: process.env.DGCLAW_MERGE_LOG_DIR,
  logPrefix: process.env.DGCLAW_MERGE_SLUG,
  authSalt: process.env.DGCLAW_MERGE_SALT,
};

let existing = {};
try {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
} catch {
  // Ausente ou JSON invalido: comeca do zero (defaults + managed), igual a uma
  // instalacao nova. Nunca trava a instalacao por causa de um config.json corrompido.
}

const merged = Object.assign({}, defaults, existing, managed);

// Escreve num arquivo temporario e move por cima: uma falha no meio (disco cheio,
// processo morto) nunca deixa o config.json truncado ou pela metade.
fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n');
fs.renameSync(tmpPath, configPath);
JS

DGCLAW_MERGE_CONFIG_JSON="$CONFIG_JSON" \
DGCLAW_MERGE_NAME="$NAME" \
DGCLAW_MERGE_SLUG="$SLUG" \
DGCLAW_MERGE_WS="$WS" \
DGCLAW_MERGE_OWNER_TG="$OWNER_TG" \
DGCLAW_MERGE_OWNER="$OWNER" \
DGCLAW_MERGE_LOG_DIR="$LOG_DIR" \
DGCLAW_MERGE_SALT="$SALT_FINAL" \
node "$MERGE_JS"
rm -f "$MERGE_JS"
echo "==> config.json mesclado ($CONFIG_JSON)"

if [ "${DGCLAW_INSTALL_TEST_MODE:-0}" = "1" ]; then
  echo "==> DGCLAW_INSTALL_TEST_MODE=1: pulando npm install, systemd e o eco final."
  echo "==> (so a descoberta do passo 2 e a mescla do passo 4 rodaram, que e o que este modo prova)"
  exit 0
fi

# ── 5. Instala dependências (omit dev, versões pinadas) ──────
(
  cd "$PANEL_DST"
  if [ -f package-lock.json ]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
)
echo "==> dependências instaladas"

# ── 6. Desativa painel Flask antigo (8200), sem apagar ───────
OLD_SVC="dgclaw-${SLUG}-panel.service"
if systemctl list-unit-files "$OLD_SVC" >/dev/null 2>&1 && systemctl is-active --quiet "$OLD_SVC"; then
  echo "==> desativando painel antigo $OLD_SVC (rollback: systemctl enable --now $OLD_SVC)"
  systemctl disable --now "$OLD_SVC" || true
fi

# ── 7. Cria e sobe o service novo ────────────────────────────
EXTRA_ENV=""
[ -n "$HOST_FINAL" ] && EXTRA_ENV="${EXTRA_ENV}Environment=DGCLAW_PANEL_HOST=${HOST_FINAL}
"
[ -n "$BASE_FINAL" ] && EXTRA_ENV="${EXTRA_ENV}Environment=DGCLAW_PANEL_BASE=${BASE_FINAL}
"

cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=DG Claw Painel Robusto: ${SLUG}
After=network.target

[Service]
Type=simple
# Plugin classico, onde o agente roda como root. Na v1 o painel nao sobe por este script (chamado so por skills/setup e skills/panel).
User=root
Environment=HOME=/root
Environment=DGCLAW_PANEL_PORT=${PORT}
Environment=DGCLAW_PANEL_CONFIG=${CONFIG_JSON}
Environment=DGCLAW_PANEL_PASSWORD=${PANEL_PASSWORD}
${EXTRA_ENV}WorkingDirectory=${PANEL_DST}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
# A unidade guarda a senha do painel, e cat > cria o arquivo em 644 (legível por qualquer
# usuário da máquina). 600 no mesmo passo, e vale também para unidade que já existia.
chmod 600 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1 || true
# restart, nao "enable --now": com o service JA ativo, o --now nao faz nada, e o passo 3
# acabou de trocar o codigo do painel embaixo de um processo que continua rodando o codigo
# velho. Reinstalar pra ATUALIZAR e o caminho normal de quem ja tem o painel, e ate
# 10/08/2026 ele nao atualizava nada: o script dizia "ativo", a pessoa recarregava a
# pagina e via o painel de antes, sem um erro em lugar nenhum. Custou uma correcao de
# vazamento que "nao pegou" mesmo depois de instalada.
systemctl restart "$SVC"
echo "==> service $SVC ativo (reiniciado com o codigo recem-copiado)"

# ── 8. Ecoa URL + senha (senha SO impressa quando foi criada agora) ──────────
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<IP-DA-VPS>"
if [ "$HOST_FINAL" = "127.0.0.1" ]; then
  URL="http://127.0.0.1:${PORT}${BASE_FINAL}/"
  ALCANCE="(loopback: so alcancavel NESTA maquina, atras da fachada)"
else
  URL="http://${IP}:${PORT}${BASE_FINAL}/"
  ALCANCE=""
fi
echo ""
echo "════════════════════════════════════════════════════════"
echo " DG Claw Painel '$NAME' instalado!"
echo "   URL:   ${URL} ${ALCANCE}"
if [ "$SENHA_NOVA" = "1" ]; then
  echo "   Senha: ${PANEL_PASSWORD}"
  echo "   (senha também no Environment do $SVC)"
else
  # A saida deste script acaba em log e em rolagem de terminal: nunca reimprime uma
  # senha que ja existia so porque o script rodou de novo.
  echo "   Senha: continua a mesma de antes (nao mudou)."
  echo "   Pra ver: systemctl show -p Environment --value $SVC | tr ' ' '\\n' | grep DGCLAW_PANEL_PASSWORD"
fi
echo "════════════════════════════════════════════════════════"
