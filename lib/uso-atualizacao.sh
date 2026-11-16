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
USO_PRAZO="${DGCLAW_USO_PRAZO:-120}"     # segundos para o inventario inteiro, cruzamento incluido
USO_MAX_REFS_TOTAL=10000
USO_NOME_RE='^[a-z0-9][a-z0-9._-]{0,40}$'

# _uso_nome_seguro <texto>: o nome so aparece se for de uma skill que o proprio DG Claw distribui (a lista vem do
# repositorio, fora da casa gravavel, em $USO_SKILLS_OFICIAIS). Regex nao basta: "ignore-instrucoes-anteriores"
# passa em qualquer regex. Nome de agente vem do agentes.json do root e so passa pela regex.
_uso_nome_seguro() {
    if [[ "$1" =~ $USO_NOME_RE ]]; then printf '%s' "$1"; else printf '(nome fora do padrao)'; fi
}
USO_SKILLS_OFICIAIS=" "
USO_CHEIO=0

# _uso_lim_add <texto>: registra um limite atingido; no maximo 50 (o resto e contado numa linha so).
USO_LIM_PERDIDOS=0
_uso_lim_add() {
    if [ "${#USO_LIM[@]}" -ge 50 ]; then USO_LIM_PERDIDOS=$((USO_LIM_PERDIDOS + 1)); return 0; fi
    USO_LIM+=("$1")
}

# _uso_linha_valida <linha>: 0 se a linha do coletor casa EXATAMENTE com um dos formatos do protocolo.
_uso_linha_valida() {
    local t=$'\t' n='[0-9]{1,6}'
    [[ "$1" =~ ^(rotinas|scripts|puladosgrandes|puladosnaocomuns)${t}${n}$ ]] && return 0
    [[ "$1" =~ ^canal${t}(WhatsApp|Telegram)$ ]] && return 0
    [[ "$1" == "identidade${t}1" ]] && return 0
    [[ "$1" =~ ^rotina${t}rotina-${n}$ ]] && return 0
    [[ "$1" == "skill${t}propria" ]] && return 0
    [[ "$1" =~ ^skill${t}oficial${t}[a-z0-9][a-z0-9._-]{0,40}$ ]] && return 0
    [[ "$1" =~ ^lim${t}[A-Za-z0-9\ .,\;\(\)/-]{1,120}$ ]] && return 0
    [[ "$1" =~ ^ref${t}(rotina|script)-${n}${t}(arq|cli)${t}[A-Za-z0-9_./@\ -]{1,200}$ ]] && return 0
    return 1
}

# _uso_add <texto>: acrescenta a secao, conferindo o teto de bytes A CADA acrescimo (nao so entre agentes). Passou do
# teto: corta, avisa uma vez e ignora o resto. O aviso entra direto, fora do teto.
_uso_add() {
    [ "$USO_CHEIO" = 0 ] || return 0
    USO_TXT+="$1"
    if [ "${#USO_TXT}" -gt "$((USO_MAX_SECAO - USO_MAX_SECAO / 10))" ]; then
        USO_TXT="${USO_TXT:0:$((USO_MAX_SECAO - USO_MAX_SECAO / 10))}"$'\n'
        USO_CHEIO=1
        _uso_lim_add "relatorio grande demais, o resto foi omitido"
    fi
}

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

# uso_calcular <de> <para>: preenche USO_TXT, USO_CRUZ e USO_LIM. <de> vazio = nao ha base para cruzar.
uso_calcular() {
    local linha malformados de="$1" para="$2" tmp agente slug casa c acao pn pf reg_n=0 rc kind a b d nrot nscr skills canais nskp grandes ident n_ag=0 naocomuns oficial nsk
    USO_TXT=""; USO_CRUZ=(); USO_LIM=(); USO_CHEIO=0; USO_LIM_PERDIDOS=0
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

    # shellcheck disable=SC2086 # uma skill por linha: a divisao em palavras e proposital
    printf '%s\n' $USO_SKILLS_OFICIAIS >"$tmp/skills-oficiais"
    local inicio="$SECONDS" restante total_refs=0
    _uso_add "So entram aqui contagens, ids gerados, nomes no padrao e referencias reconhecidas; texto livre das casas dos agentes nao e mostrado."$'\n'
    while IFS=$'\t' read -r slug casa; do
        [ -n "$slug" ] || continue
        n_ag=$((n_ag + 1))
        [ "$USO_CHEIO" = 0 ] || continue
        restante=$((USO_PRAZO - (SECONDS - inicio)))
        if [ "$restante" -le 0 ]; then
            [[ " ${USO_LIM[*]-} " == *"analise do uso incompleta"* ]] || _uso_lim_add "analise do uso incompleta (prazo de ${USO_PRAZO} s esgotado; agentes seguintes nao foram lidos)"
            continue
        fi
        [ "$restante" -le "$USO_TEMPO_COLETA" ] || restante="$USO_TEMPO_COLETA"
        agente="$(_uso_nome_seguro "$slug")"
        _uso_add $'\n'"Agente $agente:"$'\n'
        if [ -z "$casa" ] || [ ! -d "$casa" ] || [ -L "$casa" ]; then
            _uso_add "  (nao li a casa dele: nao e uma pasta de verdade)"$'\n'
            continue
        fi
        : >"$tmp/col"; rc=0
        timeout "$restante" bash "${DGCLAW_USO_COLETOR:-$APP_DIR/lib/uso-coletor.sh}" "$casa" "$tmp/col" "$tmp/skills-oficiais" 2>/dev/null || rc=$?
        if [ "$rc" -eq 124 ]; then
            _uso_lim_add "a leitura da casa do agente $agente passou de ${restante}s e foi interrompida; o que foi lido ate ali esta abaixo"
        elif [ "$rc" -ne 0 ]; then
            _uso_lim_add "a leitura da casa do agente $agente falhou (codigo $rc); confira a pasta dele antes de atualizar"
        fi
        nrot=0; nscr=0; skills=""; nskp=0; canais="chat"; grandes=0; ident=0; naocomuns=0; nsk=0
        malformados=0; : >"$tmp/refs"
        while IFS= read -r linha || [ -n "$linha" ]; do
            # Protocolo estrito: a linha inteira tem de casar com um dos formatos exatos. O que nao casar nao vira
            # registro (uma quebra de linha num nome nao fabrica linha nova) e e contado.
            if ! _uso_linha_valida "$linha"; then malformados=$((malformados + 1)); continue; fi
            IFS=$'\t' read -r kind a b d <<<"$linha"
            case "$kind" in
                rotinas) nrot="$a" ;;
                scripts) nscr="$a" ;;
                puladosgrandes) grandes="$a" ;;
                puladosnaocomuns) naocomuns="$a" ;;
                skill) nsk=$((nsk + 1))
                       if [ "$a" = oficial ] && [[ "$USO_SKILLS_OFICIAIS" == *" $b "* ]]; then skills+="${skills:+, }$b"
                       else nskp=$((nskp + 1)); skills+="${skills:+, }skill-$nsk"; fi ;;
                canal) canais+=", $a" ;;
                identidade) ident=1 ;;
                rotina) _uso_add "  $a"$'\n' ;;
                lim) _uso_lim_add "agente $agente: $(_uso_lim_conhecido "$a")" ;;
                ref) if [ "$total_refs" -lt "$USO_MAX_REFS_TOTAL" ]; then
                         printf '%s\t%s\t%s\n' "$a" "$b" "$d" >>"$tmp/refs"; total_refs=$((total_refs + 1))
                     fi ;;
            esac
        done <"$tmp/col"
        uso_cruzar_agente "agente $agente" "$tmp"
        if [ "$total_refs" -ge "$USO_MAX_REFS_TOTAL" ]; then
            [[ " ${USO_LIM[*]-} " == *"referencias no total"* ]] || _uso_lim_add "mais de $USO_MAX_REFS_TOTAL referencias no total; o resto nao foi cruzado"
        fi
        if [ "$malformados" -gt 0 ]; then _uso_lim_add "agente $agente: $malformados registros malformados na leitura da casa; ignorados"; fi
        _uso_add "  rotinas: $nrot"$'\n'
        _uso_add "  scripts proprios lidos: $nscr"
        if [ "$grandes" -gt 0 ]; then _uso_add " ($grandes pulado(s) por passar de 256 KB)"; fi
        if [ "$naocomuns" -gt 0 ]; then _uso_add " ($naocomuns pulado(s): nao e arquivo comum)"; fi
        _uso_add $'\n'
        _uso_add "  skills: ${skills:-nenhuma}"
        if [ "$nskp" -gt 0 ]; then _uso_add " ($nskp propria(s) do agente; o nome nao e mostrado)"; fi
        _uso_add $'\n'
        _uso_add "  canais ligados: $canais"$'\n'
        if [ "$ident" = 1 ]; then _uso_add "  identidade e personalidade proprias: sim (a atualizacao nao as toca)"$'\n'; fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | [.slug, (.home_host // "")] | @tsv')
    [ "$n_ag" -gt 0 ] || _uso_add $'\n'"Nenhum agente de trabalho criado ainda."$'\n'

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
    _uso_add $'\n'"Personalizacoes do programa registradas e ativas: $reg_n"$'\n'

    _uso_add $'\n'"Cruzamento com o que esta versao muda:"$'\n'
    if [ -z "$de" ]; then
        _uso_add "  Nao sei qual versao esta instalada, entao nao cruzei nada."$'\n'
    elif [ "${#USO_CRUZ[@]}" -eq 0 ]; then
        _uso_add "  Nenhum cruzamento: nada do que foi levantado acima cita arquivo ou comando que esta versao muda ou remove."$'\n'
    else
        for c in "${USO_CRUZ[@]}"; do _uso_add "  - $c"$'\n'; done
    fi
    # Alertas e limites tambem contam no teto: cabem na folga reservada (10%) e o resto vira uma linha de contagem.
    for c in ${USO_LIM[@]+"${USO_LIM[@]}"}; do
        if [ $((${#USO_TXT} + ${#c} + 20)) -gt "$USO_MAX_SECAO" ]; then USO_LIM_PERDIDOS=$((USO_LIM_PERDIDOS + 1)); continue; fi
        USO_TXT+="  limite atingido: $c"$'\n'
    done
    if [ "$USO_LIM_PERDIDOS" -gt 0 ]; then USO_TXT+="  limite atingido: mais $USO_LIM_PERDIDOS aviso(s) omitido(s)"$'\n'; fi
    rm -rf "$tmp"
}

# _uso_id <texto>: id gerado pelo coletor (rotina-3, script-12); qualquer outra coisa vira "(id invalido)".
_uso_id() { if [[ "$1" =~ ^(rotina|script)-[0-9]{1,6}$ ]]; then printf '%s' "$1"; else printf '(id invalido)'; fi; }

# _uso_lim_conhecido <texto>: as mensagens de limite sao fixas do coletor; qualquer outra e descartada.
_uso_lim_conhecido() {
    case "$1" in
        "o manifesto de rotinas nao e arquivo comum (atalho, FIFO ou pasta); pulado"|"o manifesto de rotinas passa de 256 KB; nao li"|\
        "o manifesto de rotinas nao e um JSON valido; nao li"|"o manifesto de rotinas nao pode ser lido com seguranca; pulado"|\
        "mais de 200 rotinas; li so as primeiras 200"|"mais de 500 scripts; li so os primeiros 500"|"mais de 300 skills; listei so as primeiras 300"|"mais de 2000 referencias unicas; cruzei so as primeiras 2000"|\
        "a pasta .claude ou skills e um atalho; nao listei as skills"|"casa ilegivel") printf '%s' "$1" ;;
        *) printf 'limite do coletor (mensagem nao reconhecida)' ;;
    esac
}

# uso_cruzar_agente <quem> <pasta temporaria>: cruza as referencias do agente ($tmp/refs: origem, tipo, referencia)
# com os arquivos alterados ($tmp/alterados) e os comandos removidos ($tmp/removidos) numa passada so, em conjunto
# (awk com tabelas), nunca referencia x arquivo. A linha usa o caminho do DIFF e o comando da AJUDA (lista confiavel),
# nunca o texto que veio da casa do agente.
uso_cruzar_agente() {
    local quem="$1" tmp="$2" origem tipo alvo extra linha
    [ -s "$tmp/refs" ] || return 0
    while IFS=$'\t' read -r origem tipo alvo extra; do
        if [ "${#USO_CRUZ[@]}" -ge "$USO_MAX_CRUZ" ]; then
            [[ " ${USO_LIM[*]-} " == *"cruzamentos"* ]] || _uso_lim_add "mais de $USO_MAX_CRUZ cruzamentos; mostrei so os primeiros"
            return 0
        fi
        case "$tipo" in
            arq) linha="$quem, $origem: chama $alvo, que $extra nesta versao" ;;
            dir) linha="$quem, $origem: chama a pasta $alvo, onde $extra arquivo(s) mudam nesta versao" ;;
            cli) linha="$quem, $origem: usa o comando \"dgclaw $alvo\", que saiu ou mudou de nome nesta versao" ;;
            *) continue ;;
        esac
        [[ " ${USO_CRUZ[*]-} " == *"$linha"* ]] || USO_CRUZ+=("$linha")
    done < <(awk -F'\t' -v OFS='\t' '
        FILENAME == ARGV[1] { alt[$1] = $2; p = $1; while (match(p, "/[^/]*$") > 0) { p = substr(p, 1, RSTART - 1); dirs[p]++ } next }
        FILENAME == ARGV[2] { rem[$0] = 1; next }
        { r = $3; sub(/\/+$/, "", r)
          if ($2 == "arq") { if (r in alt) print $1, "arq", r, alt[r]; else if (r in dirs) print $1, "dir", r, dirs[r] }
          else if ($2 == "cli") { n = split(r, w, " ")
              if (r in rem) print $1, "cli", r; else if (n >= 2 && (w[1] in rem)) print $1, "cli", w[1] } }' \
        "$tmp/alterados" "$tmp/removidos" "$tmp/refs")
}
