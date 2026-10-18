#!/usr/bin/env bash
# lib/protecoes.sh: o nivel de protecao da instalacao e o valor de cada protecao enterprise.
#
# Carregado com `source` (bin/dgclaw e install.sh), depois de lib/comum.sh. Le dois arquivos:
#   - a matriz  $APP_DIR/config/protecoes-matriz.json   (fonte unica, a mesma que o Web le);
#   - a escolha $DG_ETC/protecoes.json                  (600, root): {versao, nivel, ajustes, org_uuid, atualizado_em}.
# Sem o segundo arquivo o nivel e `pessoal`, que e o DG Claw de antes: nenhum recurso
# enterprise age. Valor efetivo = ajuste (se o tipo estiver certo e nao descer abaixo da
# trava do nivel) senao o padrao do nivel. A mesma regra esta em web/lib/protecoes.js.
#
# Valores de fora (CLI) chegam como texto: bool = true|false, numero = inteiro, enum = uma das palavras.

if [ -n "${_DGCLAW_PROTECOES_CARREGADO:-}" ]; then return 0; fi
_DGCLAW_PROTECOES_CARREGADO=1

_PROT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROT_NIVEIS="pessoal escritorio empresa regulado"
PROT_ARQ="$DG_ETC/protecoes.json"

# A matriz mora no app instalado (APP_DIR, definido pela CLI); no instalador, ao lado da lib.
_prot_matriz() { printf '%s/config/protecoes-matriz.json' "${APP_DIR:-$_PROT_LIB_DIR/..}"; }

# Regras de tipo e de trava em jq, usadas igual na leitura e no ajuste.
# forca: quanto maior, mais protegido. bool usa `forte` (o valor que protege; padrao true),
# enum usa a posicao em `valores` (do mais fraco ao mais forte). Numero nao tem trava.
# shellcheck disable=SC2016 # e codigo jq, nao expansao do shell
_PROT_JQ='
def forca($c; $v): if $c.tipo == "bool" then (if $v == (if $c | has("forte") then $c.forte else true end) then 1 else 0 end)
  elif $c.tipo == "enum" then ($c.valores | index($v)) else 0 end;
def tipo_ok($c; $v): if $c.tipo == "bool" then ($v | type) == "boolean"
  elif $c.tipo == "enum" then (($c.valores | index($v)) != null)
  else (($v | type) == "number" and $v == ($v | floor) and $v >= ($c.min // 0)) end;
def motivo($c; $n; $v):
  if (tipo_ok($c; $v) | not) then "o valor nao e do tipo certo para esta chave"
  elif (($c.travado // {})[$n] == true) and (forca($c; $v) < forca($c; $c.nivel[$n]))
    then "fica abaixo da trava do nivel \($n) (o minimo e \($c.nivel[$n]|tojson))"
  else null end;
'

_prot_erro() {
    printf '\nNao deu certo: %s\nO que fazer: %s\n' "$1" "$2" >&2
    return 1
}

# _prot_arquivo: imprime o JSON da escolha, ou `{}` se nao existe. Ilegivel: avisa e imprime `{}`
# (o nivel cai para pessoal, e a pessoa fica sabendo por que).
_prot_arquivo() {
    if [ ! -s "$PROT_ARQ" ]; then printf '{}'; return 0; fi
    if ! jq -ce 'if type == "object" then . else error("nao e um objeto") end' "$PROT_ARQ" 2>/dev/null; then
        aviso "$PROT_ARQ nao e um JSON valido (objeto); estou tratando a instalacao como nivel pessoal. Corrija o arquivo ou regrave com: dgclaw nivel definir <nivel>"
        printf '{}'
    fi
}

_prot_matriz_ok() {
    local m
    m="$(_prot_matriz)"
    [ -s "$m" ] && return 0
    _prot_erro "nao achei a matriz de protecoes em $m." "reinstale o DG Claw (o instalador copia a pasta config/) ou confira se o APP_DIR aponta para o app certo."
}

protecao_nivel() {
    local n
    n="$(_prot_arquivo | jq -r '.nivel // "pessoal"')"
    case " $PROT_NIVEIS " in
        *" $n "*) printf '%s' "$n" ;;
        *) aviso "o nivel '$n' em $PROT_ARQ nao existe (use: $PROT_NIVEIS); estou tratando como pessoal."
           printf 'pessoal' ;;
    esac
}

# protecao_valor <chave>: valor efetivo (true/false, numero ou palavra). Chave que nao existe: erro.
protecao_valor() {
    local chave="${1:?protecao_valor precisa da chave}" nivel arq saida
    _prot_matriz_ok || return 1
    nivel="$(protecao_nivel)"
    arq="$(_prot_arquivo)"
    saida="$(jq -rn --arg c "$chave" --arg n "$nivel" --slurpfile m "$(_prot_matriz)" --argjson a "$arq" "$_PROT_JQ"'
        ($m[0].chaves[$c]) as $ch
        | if $ch == null then "ERRO\tnao existe"
          else ($ch.nivel[$n]) as $pad
            | if ($a.ajustes // {}) | has($c) then
                (($a.ajustes[$c]) as $v | motivo($ch; $n; $v)) as $mot
                | if $mot == null then "OK\t\($a.ajustes[$c] | tostring)"
                  else "IGNORADO\t\($pad | tostring)\t\($a.ajustes[$c] | tojson)\t\($mot)" end
              else "OK\t\($pad | tostring)" end
          end')" || return 1
    case "$saida" in
        "ERRO"*) _prot_erro "a protecao '$chave' nao existe na matriz." "veja as chaves com: dgclaw nivel"; return 1 ;;
        "IGNORADO"*)
            IFS=$'\t' read -r _ pad bruto mot <<<"$saida"
            aviso "ajuste ignorado: $chave = $bruto em $PROT_ARQ ($mot). Vale o padrao do nivel $nivel: $pad."
            printf '%s' "$pad" ;;
        *) printf '%s' "${saida#OK$'\t'}" ;;
    esac
}

# protecao_ligada <chave>: sai com 0 se a protecao esta ligada. bool: true. enum: qualquer coisa
# diferente de nao/livre/runc. numero: maior que zero.
protecao_ligada() {
    local v
    v="$(protecao_valor "$1")" || return 1
    case "$v" in
        true) return 0 ;;
        false|nao|livre|runc|0|"") return 1 ;;
        *) return 0 ;;
    esac
}

# _prot_gravar <json>: troca o protecoes.json de forma atomica, modo 600.
_prot_gravar() {
    printf '%s\n' "$1" | escrever_arquivo "$PROT_ARQ" 600
}

_prot_agora() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# protecao_gravar_nivel <nivel>: grava o nivel. Ajustes que ficariam abaixo da trava do nivel novo
# sao tirados (e listados), para o arquivo nunca guardar uma escolha que seria ignorada.
protecao_gravar_nivel() {
    local nivel="${1:-}" arq novo tirados
    case " $PROT_NIVEIS " in
        *" $nivel "*) ;;
        *) _prot_erro "o nivel '$nivel' nao existe." "use um destes: $PROT_NIVEIS."; return 1 ;;
    esac
    _prot_matriz_ok || return 1
    arq="$(_prot_arquivo)"
    novo="$(jq -n --arg n "$nivel" --arg t "$(_prot_agora)" --slurpfile m "$(_prot_matriz)" --argjson a "$arq" "$_PROT_JQ"'
        ($a.ajustes // {}) as $aj
        | ($aj | with_entries(select(.key as $k | $m[0].chaves[$k] != null and motivo($m[0].chaves[$k]; $n; .value) == null))) as $ok
        | {versao: 1, nivel: $n, ajustes: $ok, org_uuid: ($a.org_uuid // ""), atualizado_em: $t,
           _tirados: (($aj | keys) - ($ok | keys))}')" || return 1
    tirados="$(jq -r '._tirados | join(", ")' <<<"$novo")"
    _prot_gravar "$(jq -c 'del(._tirados)' <<<"$novo")" || return 1
    if [ -n "$tirados" ]; then
        aviso "estes ajustes ficariam abaixo da trava do nivel $nivel e foram tirados: $tirados."
    fi
}

# protecao_ajustar <chave> <valor>: grava o ajuste. Recusa valor de tipo errado ou abaixo da trava.
protecao_ajustar() {
    local chave="${1:-}" bruto="${2-}" nivel arq tipo json mot novo
    if [ -z "$chave" ] || [ "$#" -lt 2 ]; then
        _prot_erro "faltou a chave ou o valor." "use: dgclaw nivel ajustar <chave> <valor>"; return 1
    fi
    _prot_matriz_ok || return 1
    tipo="$(jq -r --arg c "$chave" '.chaves[$c].tipo // empty' "$(_prot_matriz)")"
    [ -n "$tipo" ] || { _prot_erro "a protecao '$chave' nao existe na matriz." "veja as chaves com: dgclaw nivel"; return 1; }
    case "$tipo" in
        bool) case "$bruto" in true|false) json="$bruto" ;; *) _prot_erro "'$chave' aceita true ou false, e voce mandou '$bruto'." "use: dgclaw nivel ajustar $chave true (ou false)"; return 1 ;; esac ;;
        numero) [[ "$bruto" =~ ^[0-9]+$ ]] || { _prot_erro "'$chave' aceita um numero inteiro, e voce mandou '$bruto'." "use: dgclaw nivel ajustar $chave <numero>"; return 1; }
                json="$((10#$bruto))" ;;
        *) json="$(jq -n --arg v "$bruto" '$v')" ;;
    esac
    nivel="$(protecao_nivel)"
    mot="$(jq -rn --arg c "$chave" --arg n "$nivel" --argjson v "$json" --slurpfile m "$(_prot_matriz)" "$_PROT_JQ"'
        ($m[0].chaves[$c]) as $ch | motivo($ch; $n; $v) // ""
        | if . != "" and ($ch.tipo == "enum") and (($ch.valores | index($v)) == null)
            then "so aceita: \($ch.valores | join(", "))" else . end')" || return 1
    if [ -n "$mot" ]; then
        _prot_erro "nao posso gravar $chave = $bruto no nivel $nivel: $mot." \
            "escolha um valor igual ou mais protegido que o padrao do nivel, ou troque de nivel com: dgclaw nivel definir <nivel>"
        return 1
    fi
    arq="$(_prot_arquivo)"
    novo="$(jq -c --arg c "$chave" --argjson v "$json" --arg n "$nivel" --arg t "$(_prot_agora)" \
        '{versao: 1, nivel: ($n), ajustes: ((.ajustes // {}) + {($c): $v}), org_uuid: (.org_uuid // ""), atualizado_em: $t}' <<<"$arq")"
    _prot_gravar "$novo"
}

# protecao_org [<uuid>]: sem argumento imprime o UUID da organizacao (vazio se nao ha); com argumento grava.
protecao_org() {
    local arq novo
    arq="$(_prot_arquivo)"
    if [ "$#" -eq 0 ]; then jq -r '.org_uuid // ""' <<<"$arq"; return 0; fi
    local uuid="$1"
    if [ -n "$uuid" ] && ! [[ "$uuid" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
        _prot_erro "'$uuid' nao parece um UUID de organizacao (formato 8-4-4-4-12 em hexadecimal)." \
            "copie o identificador da organizacao no console da Anthropic, por exemplo 123e4567-e89b-12d3-a456-426614174000."
        return 1
    fi
    novo="$(jq -c --arg u "$uuid" --arg n "$(protecao_nivel)" --arg t "$(_prot_agora)" \
        '{versao: 1, nivel: $n, ajustes: (.ajustes // {}), org_uuid: $u, atualizado_em: $t}' <<<"$arq")"
    _prot_gravar "$novo"
}
