#!/usr/bin/env bash
# lib/sentinela.sh: a parte da sentinela do servidor que fica na CLI (docs/SENTINELA.md).
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. O motor e seguranca/sentinela/sentinela.py (Python da
# biblioteca padrao); aqui so se chama, sempre sob root. A entrada do `configurar` (token, senha) passa direto
# para o Python pela entrada padrao: nada de segredo em argumento de comando.
# shellcheck disable=SC2154
#
#   dgclaw sentinela estado [--json]            o que a sentinela ve agora
#   dgclaw sentinela rodar                      uma rodada agora
#   dgclaw sentinela levantar [--json]          as 20 maiores pastas (nao apaga nada)
#   dgclaw sentinela faxinar [--executar] [--json]
#   dgclaw sentinela reserva estado|liberar|recriar
#   dgclaw sentinela testar-avisos [--json]
#   dgclaw sentinela configurar                 CHAVE=valor pela entrada padrao

SENTINELA_PY="$APP_DIR/seguranca/sentinela/sentinela.py"

sentinela_py() {
    command -v python3 >/dev/null 2>&1 \
        || falha "o python3 nao foi encontrado nesta maquina; a sentinela precisa dele." "instale com: apt-get install -y python3"
    [ -f "$SENTINELA_PY" ] \
        || falha "nao achei o motor da sentinela em $SENTINELA_PY." "a copia do DG Claw esta incompleta; rode sudo dgclaw atualizar ou o instalador de novo."
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] python3 -I %s %s\n' "$SENTINELA_PY" "$*"
        return 0
    fi
    python3 -I "$SENTINELA_PY" "$@"
}

sentinela_main() {
    local sub="${1:-}"
    [ "$#" -eq 0 ] || shift
    case "$sub" in
        ""|ajuda|--ajuda) sentinela_py ajuda ;;
        estado|rodar|levantar|faxinar|reserva|testar-avisos|configurar) sentinela_py "$sub" "$@" ;;
        *) falha "o subcomando '$sub' de 'dgclaw sentinela' nao existe." "veja os subcomandos com: dgclaw sentinela ajuda" ;;
    esac
}
