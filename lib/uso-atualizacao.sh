#!/usr/bin/env bash
# lib/uso-atualizacao.sh: a seção "O que este DG Claw usa e o que a versão nova toca" do relatório
# `dgclaw atualizar --simular` (docs/ATUALIZAR.md, capítulo "Ler o que muda antes de instalar").
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Usa as funcoes do bin/dgclaw, da lib/comum.sh e da
# lib/personalizacoes.sh (_git, agentes_ler, personalizacoes_ler...).
# shellcheck disable=SC2154
#
# Levanta o USO REAL desta instalacao (por agente: rotinas, scripts proprios, skills, canais) e cruza,
# mecanicamente, com os arquivos alterados ou removidos entre a versao instalada e a de destino, e com os
# subcomandos do `dgclaw` que sairam ou mudaram de nome. Cada cruzamento vira um ponto de atencao.
#
# As casas dos agentes sao gravaveis pelo proprio agente e este codigo roda como root, e o Admin (root) le o
# relatorio. Por isso a leitura das casas e feita pelo lib/uso-coletor.sh, num processo a parte, sob timeout, sem
# seguir atalho e com limites, e SO volta: contagens, ids gerados (rotina-1, script-2), nomes que casam com uma
# regex estrita e referencias que este arquivo reconhece contra a lista confiavel (o diff da versao e a ajuda do
# bin/dgclaw). Texto livre de container nunca chega ao relatorio. Dos canais so se confere se existem.
#
# Alcance honesto do cruzamento: pega o que esta ESCRITO (caminho /opt/dgclaw/app/..., $DGCLAW_PLUGIN_ROOT/...,
# .dgclaw/plugin/... e `dgclaw <comando> [subcomando]`). Uma rotina que so diz "faca o resumo do dia" e
# chama o programa por dentro nao aparece: para isso vale o julgamento do Admin sobre o relatorio.

USO_TXT=""          # o texto da secao (inventario + cruzamentos)
USO_CRUZ=()         # uma linha por cruzamento (vira ponto de atencao)
USO_LIM=()          # limites atingidos (viram pontos de atencao, sem derrubar a atualizacao)

USO_MAX_SECAO="${DGCLAW_USO_MAX_SECAO:-40000}"     # bytes da secao no relatorio
USO_MAX_CRUZ=100
USO_TEMPO_COLETA="${DGCLAW_USO_TEMPO_COLETA:-60}"
USO_NOME_RE='^[a-z0-9][a-z0-9._-]{0,40}$'

# _uso_nome_seguro <texto>: o nome so aparece se for de uma skill que o proprio DG Claw distribui (a lista vem do
# repositorio, fora da casa gravavel, em $USO_SKILLS_OFICIAIS). Regex nao basta: "ignore-instrucoes-anteriores"
# passa em qualquer regex. Nome de agente vem do agentes.json do root e so passa pela regex.
_uso_nome_seguro() {
    if [[ "$1" =~ $USO_NOME_RE ]]; then printf '%s' "$1"; else printf '(nome fora do padrao)'; fi
}
USO_SKILLS_OFICIAIS=" "

# _uso_comandos <revisao>: os comandos e subcomandos do `dgclaw` que a ajuda daquela revisao documenta,
# um por linha ("agente criar", "senha"...). Vazio se a revisao nao tem bin/dgclaw.
_uso_comandos() {
    _git show "$1:bin/dgclaw" 2>/dev/null \
        | sed -n '/^ajuda() {/,/^FIM$/p' | grep -E '^  dgclaw [a-z]' \
        | sed -E 's/^  dgclaw //' \
        | awk '{
            n = split($1, a1, "|")
            for (i = 1; i <= n; i++) {
                print a1[i]
                if (NF >= 2 && $2 ~ /^[a-z|-]+$/ && $2 !~ /^-/) {
                    m = split($2, a2, "|")
                    for (j = 1; j <= m; j++) print a1[i] " " a2[j]
                }
            }
        }' | sort -u
}

# _uso_ref_toca <referencia> <caminho alterado>: 0 se a referencia (arquivo ou pasta) e esse caminho.
_uso_ref_toca() {
    local r="${1%/}" c="$2"
    [ -n "$r" ] || return 1
    [ "$r" = "$c" ] && return 0
    [[ "$c" == "$r/"* ]]
}


# uso_calcular <de> <para>: preenche USO_TXT, USO_CRUZ e USO_LIM. <de> vazio = nao ha base para cruzar.
uso_calcular() {
    local de="$1" para="$2" tmp agente slug casa c acao pn pf reg_n=0 rc kind a b d nrot nscr skills canais nskp grandes ident n_ag=0 naocomuns oficial nsk
    USO_TXT=""; USO_CRUZ=(); USO_LIM=()
    tmp="$(mktemp -d)"

    # O que muda: caminho<TAB>o verbo da frase ("muda", "sai", "passa a se chamar X").
    : >"$tmp/alterados"; : >"$tmp/removidos"
    if [ -n "$de" ]; then
        _git diff --name-status -M "$de" "$para" 2>/dev/null | while IFS=$'\t' read -r st a b; do
            case "$st" in
                M*|T*) printf '%s\tmuda\n' "$a" ;;
                D*) printf '%s\tsai\n' "$a" ;;
                R*) printf '%s\tpassa a se chamar %s\n' "$a" "$b" ;;
            esac
        done >"$tmp/alterados" || true
        _uso_comandos "$de" >"$tmp/cmd-antes"; _uso_comandos "$para" >"$tmp/cmd-depois"
        if [ -s "$tmp/cmd-antes" ]; then comm -23 "$tmp/cmd-antes" "$tmp/cmd-depois" >"$tmp/removidos"; fi
    fi

    # Skills distribuidas pelo DG Claw: as do repositorio na versao de destino (ou, sem ela, as do programa instalado).
    USO_SKILLS_OFICIAIS=" "
    if [ -n "$para" ]; then
        while IFS= read -r oficial; do USO_SKILLS_OFICIAIS+="${oficial#skills/} "; done < <(_git ls-tree -d --name-only "$para" skills/ 2>/dev/null)
    fi
    if [ "$USO_SKILLS_OFICIAIS" = " " ] && [ -d "$APP_DIR/skills" ]; then
        for oficial in "$APP_DIR/skills"/*/; do oficial="${oficial%/}"; USO_SKILLS_OFICIAIS+="${oficial##*/} "; done
    fi

    USO_TXT+="So entram aqui contagens, ids gerados, nomes no padrao e referencias reconhecidas; texto livre das casas dos agentes nao e mostrado."$'\n'
    while IFS=$'\t' read -r slug casa; do
        [ -n "$slug" ] || continue
        n_ag=$((n_ag + 1))
        if [ "${#USO_TXT}" -gt "$USO_MAX_SECAO" ]; then
            [[ " ${USO_LIM[*]-} " == *"passou de 40 KB"* ]] \
                || USO_LIM+=("o levantamento do uso passou de 40 KB; os agentes seguintes nao foram detalhados")
            continue
        fi
        agente="$(_uso_nome_seguro "$slug")"
        USO_TXT+=$'\n'"Agente $agente:"$'\n'
        if [ -z "$casa" ] || [ ! -d "$casa" ] || [ -L "$casa" ]; then
            USO_TXT+="  (nao li a casa dele: nao e uma pasta de verdade)"$'\n'
            continue
        fi
        : >"$tmp/col"; rc=0
        timeout "$USO_TEMPO_COLETA" bash "$APP_DIR/lib/uso-coletor.sh" "$casa" "$tmp/col" 2>/dev/null || rc=$?
        if [ "$rc" -eq 124 ]; then
            USO_LIM+=("a leitura da casa do agente $agente passou de ${USO_TEMPO_COLETA}s e foi interrompida; o que foi lido ate ali esta abaixo")
        elif [ "$rc" -ne 0 ]; then
            USO_LIM+=("a leitura da casa do agente $agente falhou (codigo $rc); confira a pasta dele antes de atualizar")
        fi
        nrot=0; nscr=0; skills=""; nskp=0; canais="chat"; grandes=0; ident=0; naocomuns=0; nsk=0
        while IFS=$'\t' read -r kind a b d; do
            case "$kind" in
                rotinas) [[ "$a" =~ ^[0-9]{1,6}$ ]] && nrot="$a" ;;
                scripts) [[ "$a" =~ ^[0-9]{1,6}$ ]] && nscr="$a" ;;
                puladosgrandes) [[ "$a" =~ ^[0-9]{1,6}$ ]] && grandes="$a" ;;
                puladosnaocomuns) [[ "$a" =~ ^[0-9]{1,6}$ ]] && naocomuns="$a" ;;
                skill) nsk=$((nsk + 1))
                       if [[ "$a" =~ ^[a-z0-9][a-z0-9._-]{0,40}$ && "$USO_SKILLS_OFICIAIS" == *" $a "* ]]; then skills+="${skills:+, }$a"
                       else nskp=$((nskp + 1)); skills+="${skills:+, }skill-$nsk"; fi ;;
                canal) case "$a" in WhatsApp|Telegram) canais+=", $a" ;; esac ;;
                identidade) ident=1 ;;
                rotina) USO_TXT+="  $(_uso_id "$a")"$'\n' ;;
                lim) USO_LIM+=("agente $agente: $(_uso_lim_conhecido "$a")") ;;
                ref) uso_cruzar "agente $agente, $(_uso_id "$a")" "$b" "$d" "$tmp" ;;
            esac
        done <"$tmp/col"
        USO_TXT+="  rotinas: $nrot"$'\n'
        USO_TXT+="  scripts proprios lidos: $nscr"
        if [ "$grandes" -gt 0 ]; then USO_TXT+=" ($grandes pulado(s) por passar de 256 KB)"; fi
        if [ "$naocomuns" -gt 0 ]; then USO_TXT+=" ($naocomuns pulado(s): nao e arquivo comum)"; fi
        USO_TXT+=$'\n'
        USO_TXT+="  skills: ${skills:-nenhuma}"
        if [ "$nskp" -gt 0 ]; then USO_TXT+=" ($nskp propria(s) do agente; o nome nao e mostrado)"; fi
        USO_TXT+=$'\n'
        USO_TXT+="  canais ligados: $canais"$'\n'
        if [ "$ident" = 1 ]; then USO_TXT+="  identidade e personalidade proprias: sim (a atualizacao nao as toca)"$'\n'; fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | [.slug, (.home_host // "")] | @tsv')
    [ "$n_ag" -gt 0 ] || USO_TXT+=$'\n'"Nenhum agente de trabalho criado ainda."$'\n'

    # --- personalizacoes do programa (o caderno do Admin): so a contagem e os arquivos que a versao toca ---
    while IFS=$'\t' read -r pn pf; do
        [ -n "$pn" ] || continue
        reg_n=$((reg_n + 1))
        [ -n "$pf" ] || continue
        while IFS=$'\t' read -r c acao; do
            if [ "$c" = "$pf" ]; then
                USO_CRUZ+=("a personalizacao $reg_n mexeu em $c, que $acao nesta versao")
            fi
        done <"$tmp/alterados"
    done < <(personalizacoes_ler)
    USO_TXT+=$'\n'"Personalizacoes do programa registradas e ativas: $reg_n"$'\n'

    USO_TXT+=$'\n'"Cruzamento com o que esta versao muda:"$'\n'
    if [ -z "$de" ]; then
        USO_TXT+="  Nao sei qual versao esta instalada, entao nao cruzei nada."$'\n'
    elif [ "${#USO_CRUZ[@]}" -eq 0 ]; then
        USO_TXT+="  Nenhum cruzamento: nada do que foi levantado acima cita arquivo ou comando que esta versao muda ou remove."$'\n'
    else
        for c in "${USO_CRUZ[@]}"; do USO_TXT+="  - $c"$'\n'; done
    fi
    for c in ${USO_LIM[@]+"${USO_LIM[@]}"}; do USO_TXT+="  limite atingido: $c"$'\n'; done
    rm -rf "$tmp"
}

# _uso_id <texto>: id gerado pelo coletor (rotina-3, script-12); qualquer outra coisa vira "(id invalido)".
_uso_id() { if [[ "$1" =~ ^(rotina|script)-[0-9]{1,6}$ ]]; then printf '%s' "$1"; else printf '(id invalido)'; fi; }

# _uso_lim_conhecido <texto>: as mensagens de limite sao fixas do coletor; qualquer outra e descartada.
_uso_lim_conhecido() {
    case "$1" in
        "o manifesto de rotinas nao e arquivo comum (atalho, FIFO ou pasta); pulado"|"o manifesto de rotinas passa de 256 KB; nao li"|\
        "o manifesto de rotinas nao e um JSON valido; nao li"|"o manifesto de rotinas nao pode ser lido com seguranca; pulado"|\
        "mais de 200 rotinas; li so as primeiras 200"|"mais de 500 scripts; li so os primeiros 500"|\
        "a pasta .claude ou skills e um atalho; nao listei as skills"|"casa ilegivel") printf '%s' "$1" ;;
        *) printf 'limite do coletor (mensagem nao reconhecida)' ;;
    esac
}

# uso_cruzar <quem> <arq|cli> <referencia> <pasta temporaria>: se a referencia cai num arquivo alterado ou
# num comando removido, acrescenta uma linha a USO_CRUZ (sem repetir). A linha usa o caminho do DIFF e o
# comando da AJUDA (lista confiavel), nunca o texto que veio da casa do agente.
uso_cruzar() {
    local quem="$1" tipo="$2" ref="$3" tmp="$4" c acao r linha
    if [ "${#USO_CRUZ[@]}" -ge "$USO_MAX_CRUZ" ]; then
        [[ " ${USO_LIM[*]-} " == *"cruzamentos"* ]] || USO_LIM+=("mais de $USO_MAX_CRUZ cruzamentos; mostrei so os primeiros")
        return 0
    fi
    if [ "$tipo" = arq ]; then
        while IFS=$'\t' read -r c acao; do
            if _uso_ref_toca "$ref" "$c"; then
                linha="$quem: chama $c, que $acao nesta versao"
                [[ " ${USO_CRUZ[*]-} " == *"$linha"* ]] || USO_CRUZ+=("$linha")
            fi
        done <"$tmp/alterados"
    elif [ "$tipo" = cli ]; then
        while IFS= read -r r; do
            [ -n "$r" ] || continue
            if [ "$ref" = "$r" ] || [[ "$ref" == "$r "* ]]; then
                linha="$quem: usa o comando \"dgclaw $r\", que saiu ou mudou de nome nesta versao"
                [[ " ${USO_CRUZ[*]-} " == *"$linha"* ]] || USO_CRUZ+=("$linha")
            fi
        done <"$tmp/removidos"
    fi
}
