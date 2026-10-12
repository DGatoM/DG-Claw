#!/bin/bash
# uninstall.sh: tira um agente DG Claw do ar (modo servidor).
#
# Uso:
#   bash uninstall.sh <.dgclaw/config.sh | workspace> [--purge] [--yes]
#
# Este script NAO apaga nada: ele desliga e GUARDA. Tudo o que sai do lugar vai pra uma
# pasta de backup datada dentro do workspace (.dgclaw-desinstalado-<data>), pra que qualquer
# desinstalacao tenha volta.
#
# Por padrao (SEM --purge): para o servico, as rotinas e o painel, guarda os arquivos das
#   unidades e tira do caminho so a copia dos scripts. Identidade, memoria, diarios,
#   working-memory, credenciais e arquivos das extensoes ficam no lugar, e reinstalar por
#   cima recupera o agente inteiro.
#
# Com --purge: alem disso, tira do workspace os DADOS do agente (identidade, memoria,
#   persona, planning e o .dgclaw inteiro), guardando tudo no backup. Como o agente some da
#   vista do dono, pede confirmacao digitada com o slug, mesmo com --yes.
#
# O usuario dedicado do sistema (dgclaw-<slug>) NAO e removido em nenhum caso: se o
# dono quiser, ele apaga a mao depois de conferir que nao ha nada dele ali.

set -uo pipefail

ARG1="${1:-}"
[ -n "$ARG1" ] || { echo "uso: uninstall.sh <.dgclaw/config.sh | workspace> [--purge] [--yes]" >&2; exit 1; }

PURGE=0; YES=0
for a in "$@"; do
    [ "$a" = "--purge" ] && PURGE=1
    [ "$a" = "--yes" ] && YES=1
done

# Resolve a config a partir do argumento, que pode ser o proprio config.sh ou o workspace.
CFG=""
if [ -f "$ARG1" ] && grep -q '^export DGCLAW_WORKSPACE=' "$ARG1" 2>/dev/null; then
    CFG="$ARG1"
elif [ -d "$ARG1" ] && [ -f "$ARG1/.dgclaw/config.sh" ]; then
    CFG="$ARG1/.dgclaw/config.sh"
fi
[ -n "$CFG" ] || {
    echo "uninstall: nao achei a config do agente a partir de '$ARG1'." >&2
    echo "  passe o workspace do agente ou o caminho do .dgclaw/config.sh." >&2
    exit 1
}

set +u; # shellcheck disable=SC1090
source "$CFG"; set -u
WS="${DGCLAW_WORKSPACE:-}"
SLUG="${DGCLAW_SLUG:-}"
[ -n "$WS" ] && [ -d "$WS" ] || { echo "uninstall: workspace invalido depois de ler a config ($WS)" >&2; exit 1; }
[ -n "$SLUG" ] || SLUG="$(basename "$WS")"
NOME="${DGCLAW_NAME:-$SLUG}"

echo "== DG Claw uninstall: agente '$NOME' ($SLUG) em $WS =="
if [ "$PURGE" = "1" ]; then
    echo "   modo: PURGE. Tira do ar e move identidade, memoria e dados pra uma pasta de backup."
else
    echo "   modo: conservador. Tira do ar e deixa identidade, memoria e credenciais no lugar."
fi

# Lista o que sera desligado, ANTES de desligar (o dono ve o tamanho do estrago).
mapfile -t UNITS < <(systemctl list-unit-files "dgclaw-${SLUG}.service" "dgclaw-${SLUG}-*" "dgclaw-panel-${SLUG}*" 2>/dev/null \
    | awk '/^dgclaw-/{print $1}' | sort -u)
echo "   vai desligar ${#UNITS[@]} unidade(s) do systemd:"
for u in "${UNITS[@]}"; do echo "     - $u"; done
[ "${#UNITS[@]}" -eq 0 ] && echo "     (nenhuma; o agente ja parece fora do ar)"

if [ "$YES" != "1" ]; then
    read -r -p "Confirmar? [s/N] " ans
    case "$ans" in s|S|sim|y|Y) ;; *) echo "abortado, nada foi tocado."; exit 0 ;; esac
fi
# Purge sempre pede confirmacao digitada, mesmo com --yes: apagar memoria nao tem volta.
if [ "$PURGE" = "1" ]; then
    echo "PURGE apaga a memoria e a identidade de '$NOME' e nao tem como desfazer."
    read -r -p "Digite o slug do agente ($SLUG) pra confirmar: " conf
    [ "$conf" = "$SLUG" ] || { echo "o que voce digitou nao bate com '$SLUG'. Abortado, nada foi apagado."; exit 1; }
fi

# 1. Desligar o servico, as rotinas e o painel.
# Nada e apagado aqui: o `systemctl disable` ja tira do boot e remove os atalhos, e os
# arquivos das unidades sao GUARDADOS numa pasta de backup. Assim, se o dono se arrepender
# (ou se a desinstalacao for so pra mudar de maquina), da pra devolver tudo copiando de volta.
BACKUP="$WS/.dgclaw-desinstalado-$(date '+%Y-%m-%d-%H%M%S')"
mkdir -p "$BACKUP/units" 2>/dev/null
echo "-> desligando servico, rotinas e painel..."
for u in "${UNITS[@]}"; do
    systemctl disable --now "$u" >/dev/null 2>&1 || true
    [ -f "/etc/systemd/system/$u" ] && mv -f "/etc/systemd/system/$u" "$BACKUP/units" 2>/dev/null
done
DROPDIR="/etc/systemd/system/dgclaw-${SLUG}.service.d"
if [ -d "$DROPDIR" ]; then
    mv -f "$DROPDIR" "$BACKUP/units" 2>/dev/null
    echo "   ajustes extras do servico (drop-ins) guardados no backup."
fi
systemctl daemon-reload 2>/dev/null || true
echo "   ${#UNITS[@]} unidade(s) desligada(s). Copia guardada em $BACKUP/units"

# 2. Purge dos dados, se pedido.
# Ninguem apaga nada aqui: o purge MOVE tudo pra uma pasta datada, dentro do proprio
# workspace. Assim o dono confere com calma e apaga a mao quando tiver certeza. Um leigo
# nao deveria conseguir perder a memoria do assistente dele por causa de uma flag.
if [ "$PURGE" = "1" ]; then
    cd "$WS" || { echo "uninstall: nao consegui entrar em $WS, entao nada foi movido." >&2; exit 1; }
    mkdir -p "$BACKUP/dados" || { echo "uninstall: nao consegui criar $BACKUP/dados, entao nada foi movido." >&2; exit 1; }
    echo "-> tirando os dados do caminho..."
    chmod 644 ./LAWS.md 2>/dev/null || true
    for item in AGENT.md AGENT.md.bak SOUL.md SOUL-addendum.md PERSONALITY.md IDENTITY.md \
                ETHICS.md CREATOR.md LAWS.md MEMORY.md working-memory.md \
                persona planning memory data .dgclaw; do
        [ -e "./$item" ] || continue
        mv -f "./$item" "$BACKUP/dados" 2>/dev/null && echo "     movido: $item"
    done
    echo "   tudo o que era do agente esta guardado em $BACKUP/dados"
    echo "   Confira com calma e, quando tiver certeza, apague essa pasta voce mesmo."
else
    # So a maquinaria: a copia estavel dos scripts e recriada na reinstalacao.
    [ -d "$WS/.dgclaw/plugin" ] && mv -f "$WS/.dgclaw/plugin" "$BACKUP" 2>/dev/null
    echo "-> preservados: identidade, memoria, diarios, credenciais e arquivos das extensoes."
    echo "   a copia dos scripts saiu do caminho (ela e recriada quando voce reinstalar)."
fi

echo
echo "== pronto. O agente '$NOME' esta fora do ar. =="
if [ "$PURGE" = "0" ]; then
    echo "   Pra trazer de volta: rode /dgclaw:setup apontando pro mesmo workspace ($WS)."
    echo "   Os dados continuam la, entao ele volta com a memoria e a personalidade que tinha."
fi
echo "   O usuario do sistema (se houver um dedicado) NAO foi removido, de proposito."
echo "   Confira o que sobrou antes de apagar: ls -la $WS"
