#!/usr/bin/env bash
# lib/enterprise/ambiente.sh: o que o agente precisa saber das protecoes, na secao "Onde voce esta e o que voce
# consegue fazer" do identidade.md (templates/ambiente/agente.md, regravada por regravar_identidade_md em bin/dgclaw).
#
# O main exige que o que o agente usa entre no modelo de ambiente. Aqui cada trecho entra so quando a protecao que
# o cria esta ligada, para o agente nunca ouvir falar de comando que nao existe no nivel dele:
#   container_endurecido  container.md       sem sudo, pacote pelo TI
#   travas_externas       travas.md          Gmail, Instagram (ig-publish.py travado) e WhatsApp
#   kit_sensivel          ferramentas.md     dgclaw-ferramenta (nao vale para o Admin)
#   admin_isolado         admin-isolado.md   dgclaw-controle (so para o Admin)
# No nivel pessoal nada e impresso e o identidade.md sai byte a byte como antes.
# `dgclaw protecoes aplicar` regrava a identidade de cada agente (ent_aplicar_ambiente), porque o nivel pode ter mudado.

_amb_trecho() { printf '\n'; renderizar_template "$APP_DIR/templates/ambiente/enterprise/$1.md"; }

ent_ambiente_extra_admin_isolado() {
    [ "${1:-}" = admin ] || return 0
    protecao_ligada admin_isolado || return 0
    _amb_trecho admin-isolado
}

ent_ambiente_extra_container() {
    protecao_ligada container_endurecido || return 0
    _amb_trecho container
}

ent_ambiente_extra_ferramentas() {
    [ "${1:-}" != admin ] || return 0
    protecao_ligada kit_sensivel || return 0
    _amb_trecho ferramentas
}

ent_ambiente_extra_travas() {
    [ "${1:-}" != admin ] || return 0
    protecao_ligada travas_externas || return 0
    _amb_trecho travas
}

# `dgclaw protecoes aplicar`: regrava so o identidade.md de cada agente (nada reinicia; vale na proxima sessao).
ent_aplicar_ambiente() {
    local slug falhou=0 erro
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] regravaria o identidade.md de cada agente, com o que o nivel $(protecao_nivel) pede"; return 0; fi
    erro="$(mktemp)"
    while IFS= read -r slug; do
        [ -n "$slug" ] || continue
        if ! "$DGCLAW_BIN_REAL" agente identidade "$slug" >/dev/null 2>"$erro"; then
            aviso "nao consegui regravar a identidade do agente $slug: $(head -c 300 "$erro" | tr '\n' ' '). Para refazer: dgclaw agente identidade $slug"
            falhou=1
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente" or (.slug == "admin" and (.container // "") != "")) | .slug')
    rm -f "$erro"
    [ "$falhou" = 1 ] || ok "a identidade dos agentes diz o que o nivel $(protecao_nivel) pede"
}
