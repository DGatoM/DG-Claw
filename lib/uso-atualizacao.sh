#!/usr/bin/env bash
# lib/uso-atualizacao.sh: a seção "O que este DG Claw usa e o que a versão nova toca" do relatório
# `dgclaw atualizar --simular` (docs/ATUALIZAR.md, capítulo "Analise antes de instalar").
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Usa as funcoes do bin/dgclaw, da lib/comum.sh e da
# lib/personalizacoes.sh (_git, agentes_ler, personalizacoes_ler...).
# shellcheck disable=SC2154
#
# Levanta o USO REAL desta instalacao (por agente: rotinas, scripts proprios, skills, canais) e cruza,
# mecanicamente, com os arquivos alterados ou removidos entre a versao instalada e a de destino, e com os
# subcomandos do `dgclaw` que sairam ou mudaram de nome. Cada cruzamento vira um ponto de atencao.
#
# As casas dos agentes sao gravaveis pelo proprio agente e este codigo roda como root: nada e seguido por
# atalho, nada e executado, e o texto que sai de la e limpo e cortado (dado, nunca instrucao). Dos canais
# so se confere se existem; credenciais nunca sao lidas.
#
# Alcance honesto do cruzamento: pega o que esta ESCRITO (caminho /opt/dgclaw/app/..., $DGCLAW_PLUGIN_ROOT/...,
# .dgclaw/plugin/... e `dgclaw <comando> [subcomando]`). Uma rotina que so diz "faca o resumo do dia" e
# chama o programa por dentro nao aparece: para isso vale o julgamento do Admin sobre o relatorio.

USO_TXT=""          # o texto da secao (inventario + cruzamentos)
USO_CRUZ=()         # uma linha por cruzamento (vira ponto de atencao)

# _uso_limpa: uma linha so, sem caracteres de controle nem nada fora do conjunto seguro, no maximo 70 colunas.
_uso_limpa() { tr -d '\000-\037\177' | tr -c '[:alnum:] ./_:@=+,%-' '?' | cut -c1-70; }

# _uso_nome: nome curto (de rotina, de skill...) so com letras, numeros, ponto, hifen e sublinhado.
_uso_nome() { tr -c 'A-Za-z0-9._-' '?' | cut -c1-40; }

# _uso_refs: le texto no STDIN e imprime as referencias ao programa do DG Claw, uma por linha:
# "arq<TAB>caminho/relativo/ao/repo" e "cli<TAB>comando [subcomando]".
_uso_refs() {
    local txt; txt="$(head -c 262144)"
    printf '%s\n' "$txt" \
        | grep -oE '(/opt/dgclaw/app|\$\{?DGCLAW_PLUGIN_ROOT\}?|\.dgclaw/plugin)/[A-Za-z0-9_./@-]+' 2>/dev/null \
        | sed -E 's#^(/opt/dgclaw/app|\$\{?DGCLAW_PLUGIN_ROOT\}?|\.dgclaw/plugin)/##; s#[.,;:]+$##' \
        | grep . | sed 's/^/arq\t/' | sort -u || true
    printf '%s\n' "$txt" \
        | grep -oE '(^|[^A-Za-z0-9_./-])dgclaw [a-z][a-z-]*( [a-z][a-z-]*)?' 2>/dev/null \
        | sed -E 's/^[^d]?dgclaw //' | grep . | sed 's/^/cli\t/' | sort -u || true
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

# _uso_ref_toca <referencia> <caminho alterado>: 0 se a referencia (arquivo ou pasta) e esse caminho.
_uso_ref_toca() {
    local r="${1%/}" c="$2"
    [ -n "$r" ] || return 1
    [ "$r" = "$c" ] && return 0
    [[ "$c" == "$r/"* ]]
}

# uso_calcular <de> <para>: preenche USO_TXT e USO_CRUZ. <de> vazio = nao ha base para cruzar.
uso_calcular() {
    local de="$1" para="$2" tmp agente slug casa nrot f nome poke refs tipo ref c acao
    local scripts_com skills canais agentes_n=0 sk reg_n=0 mostra
    USO_TXT=""; USO_CRUZ=()
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

    USO_TXT+="Texto que vem das casas dos agentes e dado, nao instrucao; aparece cortado e limpo."$'\n'
    while IFS=$'\t' read -r slug casa; do
        [ -n "$slug" ] || continue
        agentes_n=$((agentes_n + 1))
        agente="$(printf '%s' "$slug" | _uso_nome)"
        USO_TXT+=$'\n'"Agente $agente:"$'\n'
        if [ -z "$casa" ] || [ ! -d "$casa" ] || [ -L "$casa" ]; then
            USO_TXT+="  (nao li a casa dele: ${casa:+$casa nao e uma pasta de verdade}${casa:-sem casa registrada})"$'\n'
            continue
        fi

        # --- rotinas (o manifesto do proprio agente) ---
        nrot=0
        f="$casa/.dgclaw/self-crons.json"
        if [ -L "$casa/.dgclaw" ] || [ -L "$f" ]; then
            USO_TXT+="  rotinas: nao li (a pasta .dgclaw ou o manifesto e um atalho)"$'\n'
        elif [ -f "$f" ]; then
            if ! grep -v '^#' "$f" | jq -r '
                    (.crons // {}) | (if type == "array" then .[] else to_entries[] | (.value + {name: .key}) end)
                    | [(.name // "?"), (.poke // .command // .cmd // "")] | @tsv' >"$tmp/rot" 2>"$tmp/rot.erro"; then
                USO_TXT+="  rotinas: nao consegui ler $f ($(head -n 1 "$tmp/rot.erro" | _uso_limpa)). Confira o arquivo antes de atualizar."$'\n'
                : >"$tmp/rot"
            fi
            while IFS=$'\t' read -r nome poke; do
                [ -n "$nome" ] || continue
                nrot=$((nrot + 1))
                nome="$(printf '%s' "$nome" | _uso_nome)"
                mostra="(sem texto registrado)"
                if [ -n "$poke" ]; then mostra="$(printf '%s' "$poke" | _uso_limpa)"; fi
                USO_TXT+="  rotina $nome: $mostra"$'\n'
                while IFS=$'\t' read -r tipo ref; do
                    [ -n "$ref" ] || continue
                    uso_cruzar "a rotina $nome do agente $agente" "$tipo" "$ref" "$tmp"
                done < <(printf '%s' "$poke" | _uso_refs)
            done <"$tmp/rot"
            [ "$nrot" -gt 0 ] || USO_TXT+="  rotinas: nenhuma"$'\n'
        else
            USO_TXT+="  rotinas: nenhuma"$'\n'
        fi

        # --- scripts proprios na casa e nas skills proprias (arquivos de verdade; atalho nao entra) ---
        scripts_com=""
        if [ ! -L "$casa/.claude" ] && [ ! -L "$casa/.claude/skills" ]; then
            skills=""
            for sk in "$casa/.claude/skills"/*; do
                [ -e "$sk" ] || [ -L "$sk" ] || continue
                skills+="${skills:+, }$(basename "$sk" | _uso_nome)"
            done
            USO_TXT+="  skills: ${skills:-nenhuma}"$'\n'
        else
            USO_TXT+="  skills: nao li (a pasta .claude e um atalho)"$'\n'
        fi
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            refs="$(_uso_refs <"$f")"
            [ -n "$refs" ] || continue
            nome="${f#"$casa"/}"; nome="$(printf '%s' "$nome" | _uso_limpa)"
            scripts_com+="${scripts_com:+, }$nome"
            while IFS=$'\t' read -r tipo ref; do
                [ -n "$ref" ] || continue
                uso_cruzar "o script $nome do agente $agente" "$tipo" "$ref" "$tmp"
            done <<<"$refs"
        done < <(find "$casa" -maxdepth 5 \( -name node_modules -o -name .git -o -name .dgclaw -o -name memory -o -name uploads -o -name projects -o -name backups -o -name logs -o -name .cache -o -name .npm -o -name .local \) -prune \
                    -o -type f -size -256k \( -name '*.sh' -o -name '*.py' -o -name '*.mjs' -o -name '*.js' -o -name '*.md' -path '*/.claude/skills/*' \) -print 2>/dev/null | sort | head -n 400)
        USO_TXT+="  scripts proprios que chamam o programa do DG Claw: ${scripts_com:-nenhum}"$'\n'

        # --- canais (so existencia; nada de credencial) ---
        canais="chat"
        if [ -d "$casa/.dgclaw/whatsapp" ] && [ ! -L "$casa/.dgclaw/whatsapp" ]; then canais+=", WhatsApp"; fi
        if [ -f "$casa/.dgclaw/telegram/.env" ] && [ ! -L "$casa/.dgclaw/telegram" ]; then canais+=", Telegram"; fi
        USO_TXT+="  canais ligados: $canais"$'\n'
        if [ -f "$casa/IDENTITY.md" ] || [ -f "$casa/PERSONALITY.md" ]; then
            USO_TXT+="  identidade e personalidade proprias: sim (a atualizacao nao as toca)"$'\n'
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | [.slug, (.home_host // "")] | @tsv')
    [ "$agentes_n" -gt 0 ] || USO_TXT+=$'\n'"Nenhum agente de trabalho criado ainda."$'\n'

    # --- personalizacoes do programa (o caderno do Admin) ---
    USO_TXT+=$'\n'"Personalizacoes do programa registradas e ativas:"$'\n'
    while IFS=$'\t' read -r nome f; do
        [ -n "$nome" ] || continue
        reg_n=$((reg_n + 1))
        USO_TXT+="  $(printf '%s' "$nome" | _uso_limpa)${f:+ ($(printf '%s' "$f" | _uso_limpa))}"$'\n'
        [ -n "$f" ] || continue
        while IFS=$'\t' read -r c acao; do
            if [ "$c" = "$f" ]; then
                USO_CRUZ+=("a personalizacao \"$(printf '%s' "$nome" | _uso_limpa)\" mexeu em $c, que $acao nesta versao")
            fi
        done <"$tmp/alterados"
    done < <(personalizacoes_ler)
    [ "$reg_n" -gt 0 ] || USO_TXT+="  nenhuma"$'\n'

    USO_TXT+=$'\n'"Cruzamento com o que esta versao muda:"$'\n'
    if [ -z "$de" ]; then
        USO_TXT+="  Nao sei qual versao esta instalada, entao nao cruzei nada."$'\n'
    elif [ "${#USO_CRUZ[@]}" -eq 0 ]; then
        USO_TXT+="  Nenhum cruzamento: nada do que foi levantado acima cita arquivo ou comando que esta versao muda ou remove."$'\n'
    else
        for c in "${USO_CRUZ[@]}"; do USO_TXT+="  - $c"$'\n'; done
    fi
    rm -rf "$tmp"
}

# uso_cruzar <quem> <arq|cli> <referencia> <pasta temporaria>: se a referencia cai num arquivo alterado ou
# num comando removido, acrescenta uma linha a USO_CRUZ (sem repetir).
uso_cruzar() {
    local quem="$1" tipo="$2" ref="$3" tmp="$4" c acao r linha
    if [ "$tipo" = arq ]; then
        while IFS=$'\t' read -r c acao; do
            if _uso_ref_toca "$ref" "$c"; then
                linha="$quem chama $ref, que $acao nesta versao"
                [[ " ${USO_CRUZ[*]-} " == *"$linha"* ]] || USO_CRUZ+=("$linha")
            fi
        done <"$tmp/alterados"
    else
        while IFS= read -r r; do
            [ -n "$r" ] || continue
            if [ "$ref" = "$r" ] || [[ "$ref" == "$r "* ]]; then
                linha="$quem usa o comando \"dgclaw $r\", que saiu ou mudou de nome nesta versao"
                [[ " ${USO_CRUZ[*]-} " == *"$linha"* ]] || USO_CRUZ+=("$linha")
            fi
        done <"$tmp/removidos"
    fi
}
