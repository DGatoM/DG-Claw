#!/usr/bin/env bash
# lib/agentes.sh: leitura e escrita do /etc/dgclaw/agentes.json.
#
# O agentes.json e o que o DG Claw Web le para montar o seletor de agentes (ele
# rele sozinho quando o arquivo muda). Quem escreve sao o instalador (o Admin) e
# o `dgclaw agente criar|remover`. Por isso a escrita mora aqui, num lugar so:
#   - sempre com a trava (com_trava), para dois comandos ao mesmo tempo nao
#     perderem a escrita um do outro;
#   - sempre atomica (temporario + mv), para o Web nunca ler meio arquivo;
#   - sem segredo nenhum dentro: so caminhos para os arquivos de segredo.
#
# Precisa de lib/comum.sh carregado antes, e do jq.

# agentes_garantir_arquivo: cria o agentes.json vazio se ainda nao existe.
agentes_garantir_arquivo() {
    if [ -s "$DG_AGENTES_JSON" ]; then return 0; fi
    printf '{"versao": 1, "agentes": []}\n' | escrever_arquivo "$DG_AGENTES_JSON" 640
}

# agentes_ler: imprime o agentes.json (ou um vazio, se ainda nao existe).
agentes_ler() {
    if [ -s "$DG_AGENTES_JSON" ]; then cat "$DG_AGENTES_JSON"; else printf '{"versao": 1, "agentes": []}\n'; fi
}

# agentes_obter <slug>: imprime o objeto do agente, ou nada se nao existir.
agentes_obter() {
    agentes_ler | jq -c --arg s "$1" '.agentes[] | select(.slug == $s)'
}

# _agentes_aplicar <filtro jq> [args do jq...]: aplica o filtro e grava. Uso interno,
# sempre chamado de dentro da trava.
_agentes_aplicar() {
    local filtro="$1"; shift
    local novo
    novo="$(agentes_ler | jq "$@" "$filtro")" \
        || falha "nao consegui atualizar $DG_AGENTES_JSON (o jq recusou o conteudo atual)." \
                 "confira se o arquivo e um JSON valido com: jq . $DG_AGENTES_JSON"
    printf '%s\n' "$novo" | escrever_arquivo "$DG_AGENTES_JSON" 640
}

# agentes_registrar: le um objeto JSON do STDIN e grava no agentes.json. Se ja
# existe um agente com o mesmo slug, substitui (rodar de novo nao duplica).
agentes_registrar() {
    local obj
    obj="$(jq -c . )" || falha "o registro do agente nao e um JSON valido." "isso e um erro do DG Claw; abra uma issue com a saida acima."
    local slug
    slug="$(printf '%s' "$obj" | jq -r '.slug // empty')"
    [ -n "$slug" ] || falha "o registro do agente veio sem slug." "isso e um erro do DG Claw; abra uma issue."
    # Olha so os NOMES dos campos (em qualquer nivel), nunca os valores: um agente
    # chamado "Senha Bot" nao pode ser barrado. Campo que termina em _arquivo e caminho.
    if printf '%s' "$obj" | jq -e '[paths | .[-1] | strings | select(test("(?i)(password|senha|token|segredo|secret|chave)") and (test("_arquivo$") | not))] | length > 0' >/dev/null; then
        falha "o registro do agente $slug parece conter um segredo." "o agentes.json so guarda CAMINHOS de arquivos de segredo; isso e um erro do DG Claw."
    fi
    # shellcheck disable=SC2016 # o $o e variavel do jq, nao do shell
    com_trava _agentes_aplicar \
        '.agentes = ([.agentes[] | select(.slug != $o.slug)] + [$o])' --argjson o "$obj"
}

# agentes_remover <slug>: tira o agente do agentes.json (os arquivos dele ficam).
agentes_remover() {
    # shellcheck disable=SC2016 # o $s e variavel do jq, nao do shell
    com_trava _agentes_aplicar '.agentes = [.agentes[] | select(.slug != $s)]' --arg s "$1"
}
