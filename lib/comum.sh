#!/usr/bin/env bash
# lib/comum.sh: o vocabulario comum do instalador (install.sh) e da CLI (bin/dgclaw).
#
# Carregado com `source`, nunca executado. Concentra tres coisas que precisam ser
# iguais nos dois lados, senao um escreve de um jeito e o outro le de outro:
#   1. os caminhos do sistema, todos atras de $R (DGCLAW_RAIZ), para os testes
#      rodarem numa raiz falsa sem encostar no /etc de verdade;
#   2. o modo ensaio (--ensaio), em que nada muda e tudo e anunciado;
#   3. as mensagens para gente: o que esta acontecendo e, na falha, o que falhou,
#      com que entrada e o que fazer.

# Guarda contra carregar duas vezes (o install.sh e a CLI podem se chamar).
if [ -n "${_DGCLAW_COMUM_CARREGADO:-}" ]; then return 0; fi
_DGCLAW_COMUM_CARREGADO=1

# --- caminhos ----------------------------------------------------------------
# Vazio em producao. Nos testes aponta para uma pasta temporaria, e todo caminho
# de sistema passa a morar dentro dela.
R="${DGCLAW_RAIZ:-}"
DG_ETC="$R/etc/dgclaw"
DG_OPT="$R/opt/dgclaw"
DG_APP="$DG_OPT/app"
DG_ADMIN="$DG_OPT/admin"
DG_LIB="$R/var/lib/dgclaw"
DG_LOG="$R/var/log/dgclaw"
DG_UNITS="$R/etc/systemd/system"
DG_BIN="$R/usr/local/bin"
DG_AGENTES_JSON="$DG_ETC/agentes.json"
DG_REGISTRO="$DG_ETC/registro.tsv"
DG_TRAVA="$DG_ETC/.agentes.lock"
DG_IMAGEM_PADRAO="localhost/dgclaw-agente:latest"
export R DG_ETC DG_OPT DG_APP DG_ADMIN DG_LIB DG_LOG DG_UNITS DG_BIN DG_AGENTES_JSON DG_REGISTRO DG_TRAVA

ENSAIO="${ENSAIO:-0}"

# --- saida para gente ----------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    _C_OK=$'\033[32m'; _C_AV=$'\033[33m'; _C_ER=$'\033[31m'; _C_TI=$'\033[1m'; _C_0=$'\033[0m'
else
    _C_OK=""; _C_AV=""; _C_ER=""; _C_TI=""; _C_0=""
fi
_PASSO_N=0

passo() { _PASSO_N=$((_PASSO_N + 1)); printf '\n%s[%s] %s%s\n' "$_C_TI" "$_PASSO_N" "$1" "$_C_0"; }
ok()    { printf '   %sok%s  %s\n' "$_C_OK" "$_C_0" "$1"; }
info()  { printf '   %s\n' "$1"; }
aviso() { printf '   %saviso%s  %s\n' "$_C_AV" "$_C_0" "$1" >&2; }

# falha "<o que falhou, com que entrada>" "<o que fazer>"
# Sai com 1. As duas metades sao obrigatorias: um erro sem o "o que fazer" deixa
# a pessoa (ou o Claude dela) sem saida, e a saida vira adivinhar.
falha() {
    printf '\n%sNao deu certo:%s %s\n' "$_C_ER" "$_C_0" "$1" >&2
    printf 'O que fazer: %s\n' "${2:-veja a mensagem acima.}" >&2
    exit 1
}

# executar <comando...>
# No ensaio, so anuncia. Fora dele, roda; se falhar, diz qual comando e com que
# codigo, em vez de deixar o `set -e` derrubar o script em silencio.
executar() {
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] %s\n' "$*"
        return 0
    fi
    local rc=0
    "$@" || rc=$?
    if [ "$rc" -ne 0 ]; then
        falha "o comando '$*' terminou com codigo $rc." "leia as linhas acima, que mostram a causa; depois rode de novo (rodar de novo e seguro)."
    fi
}

# escrever_arquivo <caminho> <modo> [uid:gid]
# Conteudo pelo STDIN. Escreve num temporario NA MESMA PASTA e troca com mv: quem
# esta lendo o arquivo (o Web, o runner) nunca ve metade dele.
escrever_arquivo() {
    local alvo="$1" modo="$2" quem="${3:-}" tmp
    if [ "$ENSAIO" = 1 ]; then
        cat >/dev/null
        printf '   [ensaio] escreveria %s (modo %s%s)\n' "$alvo" "$modo" "${quem:+, dono $quem}"
        return 0
    fi
    mkdir -p "$(dirname "$alvo")"
    tmp="$(mktemp "$(dirname "$alvo")/.$(basename "$alvo").XXXXXX")"
    cat >"$tmp"
    chmod "$modo" "$tmp"
    [ -n "$quem" ] && dono "$quem" "$tmp"
    mv -f "$tmp" "$alvo"
}

# gerar_segredo <caminho> [uid:gid]
# 32 bytes aleatorios em hexadecimal. So cria se nao existir: rodar de novo nao
# troca o segredo de ninguem (trocar derrubaria a conversa entre Web e runner).
gerar_segredo() {
    local alvo="$1" quem="${2:-}"
    if [ -s "$alvo" ]; then return 0; fi
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] geraria um segredo novo em %s (modo 600)\n' "$alvo"
        return 0
    fi
    mkdir -p "$(dirname "$alvo")"
    ( umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$alvo" )
    chmod 600 "$alvo"
    [ -n "$quem" ] && dono "$quem" "$alvo"
    return 0
}

# dono <uid:gid> <caminho...>
# Em producao e um chown comum. Nos testes (raiz falsa, sem root) o chown para o
# uid de um agente nao e possivel; ai so registra, porque o que o teste confere
# e o resto (modo, conteudo, lugar), e falhar aqui esconderia isso.
dono() {
    local quem="$1"; shift
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] chown %s %s\n' "$quem" "$*"
        return 0
    fi
    if [ -n "$R" ] && [ "$(id -u)" -ne 0 ]; then
        printf '%s %s\n' "$quem" "$*" >>"$R/.chown-simulado"
        return 0
    fi
    chown "$quem" "$@"
}

# com_trava <comando...>
# Serializa quem mexe no agentes.json e no registro.tsv: dois `agente criar` ao
# mesmo tempo nao podem pegar a mesma faixa de uid nem a mesma porta.
com_trava() {
    if [ "$ENSAIO" = 1 ]; then "$@"; return; fi
    mkdir -p "$(dirname "$DG_TRAVA")"
    (
        flock -w 30 9 || falha "outro comando do DG Claw esta segurando $DG_TRAVA ha mais de 30 segundos." \
            "espere ele terminar e rode de novo. Se nada estiver rodando, confira com: fuser $DG_TRAVA"
        "$@"
    ) 9>"$DG_TRAVA"
}

# carregar_env_dgclaw: le o /etc/dgclaw/dgclaw.env se existir (dominio, imagem...).
carregar_env_dgclaw() {
    if [ -f "$DG_ETC/dgclaw.env" ]; then
        # shellcheck disable=SC1091
        . "$DG_ETC/dgclaw.env"
    fi
    DGCLAW_IMAGEM="${DGCLAW_IMAGEM:-$DG_IMAGEM_PADRAO}"
}
