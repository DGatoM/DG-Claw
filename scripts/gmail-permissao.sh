#!/bin/bash
# gmail-permissao.sh: controla o que o agente pode fazer no Gmail (conector do claude.ai).
#
# O conector nasce SO LEITURA (+ rascunho). O bloqueio e feito com regras
# permissions.deny no .claude/settings.local.json do workspace do agente, porque deny
# vale ate em bypassPermissions (allow nao vale) e vale de qualquer escopo. O Claude Code
# recarrega o arquivo na sessao viva, entao a mudanca vale na hora, sem reiniciar.
#
# Por que settings.local.json e nao settings.json: no container da v1 o settings.json e
# do root, so leitura, e o agente nao mexe nele. O .local fica com o usuario do agente,
# para ele mesmo conduzir a liberacao quando o dono pedir. Quem roda isto como root
# (instalador) deve deixar o arquivo com o dono do agente (chown agente).
#
# Niveis:
#   leitura  (padrao) bloqueia enviar, responder, encaminhar e tudo que altera ou apaga
#            na caixa. Ler e fazer rascunho continuam liberados.
#   envio    libera enviar, responder e encaminhar. Apagar e alterar a caixa
#            continuam bloqueados.
#
# So mexe nas regras listadas aqui. Qualquer outra regra e qualquer outra chave do
# settings.json ficam como estao.
#
# Uso:  bash gmail-permissao.sh <.dgclaw/config.sh> {estado|leitura|envio}
# Env:  DGCLAW_GMAIL_SEM_AVISO=1  nao avisa o dono ao liberar o envio (uso em teste)

set -uo pipefail

USO="Uso: gmail-permissao.sh <.dgclaw/config.sh> {estado|leitura|envio}"
CONFIG="${1:-}"
ACAO="${2:-}"
if [ -z "$CONFIG" ] || [ -z "$ACAO" ]; then echo "$USO" >&2; exit 2; fi
case "$ACAO" in estado|leitura|envio) ;; *)
    echo "acao desconhecida: '$ACAO'. $USO" >&2; exit 2 ;;
esac
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG. Passe o caminho do .dgclaw/config.sh do agente." >&2; exit 1; }

set +u
# shellcheck disable=SC1090
source "$CONFIG"
set -u
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE (confira $CONFIG)}"
WS="$DGCLAW_WORKSPACE"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="${DGCLAW_GMAIL_SETTINGS:-$WS/.claude/settings.local.json}"
LOGDIR="$WS/.dgclaw/logs"
LOG="$LOGDIR/permissoes.log"

[ "$ACAO" = "estado" ] || mkdir -p "$(dirname "$SETTINGS")" || {
    echo "nao consegui criar a pasta de $SETTINGS" >&2; exit 1; }

SAIDA="$(ACAO="$ACAO" SETTINGS="$SETTINGS" python3 - <<'PY'
import json, os, sys

settings = os.environ["SETTINGS"]
acao = os.environ["ACAO"]
P = "mcp__claude_ai_Gmail__"

ENVIO = [P + n for n in ("send_message", "reply", "forward")] + \
        [P + "send*", P + "reply*", P + "forward*"]
ALTERA = [P + n for n in (
    "apply_sensitive_message_label", "apply_sensitive_thread_label", "create_label",
    "delete_draft", "delete_label", "label_message", "label_thread",
    "mark_message_spam", "mark_thread_spam", "trash_message", "trash_thread",
    "unlabel_message", "unlabel_thread", "unmark_message_spam", "unmark_thread_spam",
    "untrash_message", "untrash_thread", "update_label", "update_message_labels")]
MINHAS = set(ENVIO) | set(ALTERA)

try:
    with open(settings, encoding="utf-8") as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
except Exception as e:
    print(f"{settings} esta ilegivel ({e}). Nao mexi no arquivo. Corrija o JSON (ou renomeie o arquivo) e rode de novo.", file=sys.stderr)
    sys.exit(1)
if not isinstance(data, dict):
    print(f"{settings} nao e um objeto JSON. Nao mexi no arquivo. Corrija e rode de novo.", file=sys.stderr)
    sys.exit(1)

perms = data.get("permissions")
if perms is None:
    perms = {}
if not isinstance(perms, dict) or not isinstance(perms.get("deny", []), list):
    print(f"{settings}: 'permissions' ou 'permissions.deny' com formato inesperado. Nao mexi no arquivo.", file=sys.stderr)
    sys.exit(1)
deny = perms.get("deny", [])

def estado(lista):
    tem = set(lista) & MINHAS
    if not tem:
        return "sem-bloqueio"
    if set(ENVIO) <= tem and set(ALTERA) <= tem:
        return "leitura"
    if not (set(ENVIO) & tem) and set(ALTERA) <= tem:
        return "envio"
    return "parcial"

antes = estado(deny)
if acao != "estado":
    alvo = ENVIO + ALTERA if acao == "leitura" else list(ALTERA)
    novo = [r for r in deny if r not in MINHAS] + alvo
    if novo != deny:
        perms["deny"] = novo
        data["permissions"] = perms
        texto = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        tmp = settings + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(texto)
            if os.path.exists(settings):
                st = os.stat(settings)
                os.chmod(tmp, st.st_mode & 0o7777)
                try:
                    os.chown(tmp, st.st_uid, st.st_gid)
                except PermissionError:
                    pass  # usuario comum nao troca dono; o tmp ja nasce dele, que e o certo
            os.replace(tmp, settings)
        except PermissionError:
            # Pasta sem escrita para este usuario (ex.: .claude/ do root no container),
            # mas o arquivo e dele: grava no lugar. Perde a atomicidade, nao o conteudo.
            try:
                os.unlink(tmp)
            except OSError:
                pass
            try:
                with open(settings, "r+" if os.path.exists(settings) else "w", encoding="utf-8") as f:
                    f.seek(0); f.write(texto); f.truncate()
            except PermissionError as e:
                print(f"sem permissao para gravar {settings} ({e}). Rode como o usuario do agente, ou peca a quem administra: chown <usuario do agente> {settings}", file=sys.stderr)
                sys.exit(1)
        deny = novo
depois = estado(deny)
print(f"{antes} {depois}")
PY
)" || exit $?

ANTES="${SAIDA%% *}"
DEPOIS="${SAIDA##* }"

frase() {
    case "$1" in
        leitura) echo "Gmail agora: so leitura e rascunho. Enviar, responder e encaminhar estao bloqueados." ;;
        envio) echo "Gmail agora: leitura, rascunho e envio (enviar, responder e encaminhar). Apagar e alterar a caixa continuam bloqueados." ;;
        sem-bloqueio) echo "Gmail sem nenhum bloqueio deste script: o agente pode ler, enviar e alterar a caixa. Rode 'leitura' para bloquear." ;;
        *) echo "Gmail com bloqueio parcial (regras incompletas): rode 'leitura' ou 'envio' para acertar." ;;
    esac
}

if [ "$ACAO" = "estado" ]; then
    echo "$DEPOIS"
    frase "$DEPOIS"
    exit 0
fi

AGORA="$(date '+%F %H:%M')"
if [ "$ANTES" = "$DEPOIS" ] && [ "$ANTES" = "$ACAO" ]; then
    echo "Nada mudou. $(frase "$DEPOIS")"
    exit 0
fi

mkdir -p "$LOGDIR" 2>/dev/null || true
echo "[$(date '+%F %T')] gmail: $ANTES -> $DEPOIS (pedido: $ACAO)" >> "$LOG" 2>/dev/null \
    || echo "aviso: nao consegui gravar o registro em $LOG" >&2
echo "$(frase "$DEPOIS")"

if [ "$DEPOIS" = "envio" ]; then
    if [ "${DGCLAW_GMAIL_SEM_AVISO:-}" = "1" ]; then
        echo "(aviso ao dono pulado por DGCLAW_GMAIL_SEM_AVISO=1)"
    else
        MSG="Aviso de seguranca: o envio de e-mail pelo Gmail foi liberado para o agente agora ($AGORA). Se nao foi voce que pediu, diga ao agente 'bloqueia o envio de e-mail' ou rode gmail-permissao.sh leitura."
        if bash "$AQUI/notify-owner.sh" "$MSG" >/dev/null 2>&1; then
            echo "O dono recebeu um aviso de que o envio foi liberado."
            echo "[$(date '+%F %T')] gmail: aviso ao dono enviado" >> "$LOG" 2>/dev/null || true
        else
            echo "[$(date '+%F %T')] gmail: FALHA ao avisar o dono (notify-owner.sh)" >> "$LOG" 2>/dev/null || true
            echo "ATENCAO: o aviso ao dono NAO saiu (notify-owner.sh falhou). Avise o dono voce mesmo. Detalhe no registro $LOG." >&2
        fi
    fi
fi
exit 0
