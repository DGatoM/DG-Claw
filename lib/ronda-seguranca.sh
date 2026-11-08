#!/usr/bin/env bash
# lib/ronda-seguranca.sh: a parte da ronda de seguranca que mora na CLI (docs/RONDA-DE-SEGURANCA.md).
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Usa as funcoes dele e da lib/comum.sh (falha, info).
# O motor e seguranca/ronda/ronda.py (Python da biblioteca padrao); aqui so se chama, sempre sob root.
# shellcheck disable=SC2154
#
#   dgclaw seguranca rodar [--sem-avisar]   faz uma rodada agora
#   dgclaw seguranca resumo [--json] [--todos]   os achados novos, ja limpos (e o que o Admin le)
#   dgclaw seguranca estado [--json]        ultima rodada, proxima, parcial?, quantos por nivel
#   dgclaw seguranca aplicar <id>           aplica a acao do catalogo para o achado (com o sim do dono)
#   dgclaw seguranca desfazer <registro>    volta atras numa acao aplicada
#   dgclaw seguranca inventario [--json] [--refazer]
#   dgclaw seguranca pedido <arquivo>   executa um pedido do painel
#   dgclaw seguranca pedido-todos       executa a fila de pedidos do painel (a unidade .path chama isto)

RONDA_PY="$APP_DIR/seguranca/ronda/ronda.py"

ronda_py() {
    command -v python3 >/dev/null 2>&1 \
        || falha "o python3 nao foi encontrado nesta maquina; a ronda de seguranca precisa dele." "instale com: apt-get install -y python3"
    [ -f "$RONDA_PY" ] \
        || falha "nao achei o motor da ronda em $RONDA_PY." "a copia do DG Claw esta incompleta; rode sudo dgclaw atualizar ou o instalador de novo."
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] python3 -I %s %s\n' "$RONDA_PY" "$*"
        return 0
    fi
    python3 -I "$RONDA_PY" "$@"
}

seguranca_ajuda() {
    cat <<'FIM'
dgclaw seguranca: a ronda de seguranca desta instalacao.

  dgclaw seguranca estado [--json]          ultima rodada, proxima, se ficou parcial e quantos achados por nivel
  dgclaw seguranca resumo [--json] [--todos] os achados novos (ou todos), ja limpos para ler
  dgclaw seguranca rodar [--sem-avisar]     faz uma rodada agora (--sem-avisar nao manda recado ao Admin)
  dgclaw seguranca aplicar <id>             aplica a correcao do catalogo para o achado <id>; so com o sim do dono
  dgclaw seguranca desfazer <registro>      desfaz uma acao aplicada (o registro vem na saida do aplicar e do resumo)
  dgclaw seguranca inventario [--json] [--refazer]   o que a ronda sabe desta instalacao
  dgclaw seguranca pedido <arquivo>         executa um pedido do painel
  dgclaw seguranca pedido-todos             executa a fila de pedidos do painel (a unidade do systemd chama isto)

Desligar: DGCLAW_RONDA_SEGURANCA=0 no /etc/dgclaw/dgclaw.env. Horarios: DGCLAW_RONDA_HORARIOS="07:00 13:00 19:00".
Nao aplicar nada sozinha: DGCLAW_RONDA_APLICAR_SOZINHA=0. Depois de mudar o dgclaw.env, rode sudo ./install.sh de novo.
FIM
}

seguranca_main() {
    local sub="${1:-}"
    [ "$#" -eq 0 ] || shift
    case "$sub" in
        ""|ajuda|--ajuda) seguranca_ajuda ;;
        rodar) ronda_py executar "$@" ;;
        resumo|estado|aplicar|desfazer|inventario|pedido) ronda_py "$sub" "$@" ;;
        pedido-todos) ronda_py pedido --todos ;;
        *) falha "o subcomando '$sub' de 'dgclaw seguranca' nao existe." "veja os subcomandos com: dgclaw seguranca ajuda" ;;
    esac
}
