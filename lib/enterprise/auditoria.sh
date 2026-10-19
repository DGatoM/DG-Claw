#!/usr/bin/env bash
# lib/enterprise/auditoria.sh: a trilha de auditoria (lado bash). O lado Node e web/lib/auditoria.js.
#
# Arquivo: $DG_LOG/auditoria.jsonl (600), uma linha JSON por evento:
#   {"ts","evento","quem","origem","dados","ant","hash"}
# `ant` e o `hash` da linha anterior (64 zeros na primeira). `hash` = sha256 de (ant + a linha
# sem o campo hash, exatamente como foi escrita). Quem confere recorta o texto da linha, nunca
# re-serializa, por isso bash e Node podem escrever na mesma corrente.
#
# Trava: `mkdir <arquivo>.trava` (atomico), a mesma do Node. Trava com mais de 30 s e de
# processo que morreu: sai com aviso. Limite: dois processos que acham a mesma trava velha ao
# mesmo tempo podem se atropelar; e uma janela de milissegundos a cada 30 s de trava abandonada.
#
# Nivel completo em diante: no primeiro evento de um mes novo, o auditoria.jsonl vira auditoria-AAAA-MM.jsonl
# (o mes da ultima linha dele) e comeca outro auditoria.jsonl, cuja primeira linha guarda em `ant` o hash da
# ultima do mes anterior. As regras completas estao em web/lib/auditoria-corrente.js (mesma logica, em Node).
# Origem: "cli" por padrao; o servico de controle (bloco C) grava com DGCLAW_AUDITORIA_ORIGEM=controle.
#
# Nivel com auditoria = nao: nao grava nada. Precisa de lib/comum.sh e lib/protecoes.sh.

AUD_ZERO="0000000000000000000000000000000000000000000000000000000000000000"
AUD_ESPERA_MAX_DS="${DGCLAW_AUDITORIA_ESPERA_DS:-100}"   # em decimos de segundo (padrao 10 s)
AUD_TRAVA_VELHA_S=30

_aud_arquivo() { printf '%s/auditoria.jsonl' "$DG_LOG"; }

# _aud_pegar_trava <arquivo>: 0 com a trava na mao; 1 se estourou a espera.
_aud_pegar_trava() {
    local trava="$1.trava" tentativas=0 idade
    while ! mkdir "$trava" 2>/dev/null; do
        idade=$(( $(date +%s) - $(stat -c %Y "$trava" 2>/dev/null || date +%s) ))
        if [ "$idade" -gt "$AUD_TRAVA_VELHA_S" ]; then
            aviso "a trava ${trava#"$R"} tinha $idade s (mais de $AUD_TRAVA_VELHA_S); o processo que a criou provavelmente morreu. Estou removendo e seguindo."
            rmdir "$trava" 2>/dev/null || true
            continue
        fi
        tentativas=$((tentativas + 1))
        if [ "$tentativas" -gt "$AUD_ESPERA_MAX_DS" ]; then return 1; fi
        sleep 0.1
    done
}

# _aud_rotacionar <arquivo>: com a trava na mao. Se o arquivo vivo tem a ultima linha de um mes anterior ao de agora,
# fecha o mes (renomeia para auditoria-AAAA-MM.jsonl). So no nivel completo em diante.
_aud_rotacionar() {
    local arq="$1" nivel mes_ult mes_agora destino
    nivel="$(protecao_valor auditoria)" || return 1
    if [ "$nivel" != completa ] && [ "$nivel" != externa ]; then return 0; fi
    [ -s "$arq" ] || return 0
    mes_ult="$(tail -n 1 "$arq" | jq -r '.ts // empty' 2>/dev/null | cut -c1-7)" || mes_ult=""
    if ! [[ "$mes_ult" =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
        mes_ult="$(date -u -r "$arq" +%Y-%m)"
        aviso "a ultima linha de ${arq#"$R"} nao tem data legivel; usei a data de modificacao do arquivo para decidir a rotacao do mes."
    fi
    mes_agora="$(date -u +%Y-%m)"
    if [[ ! "$mes_ult" < "$mes_agora" ]]; then return 0; fi
    destino="$(dirname "$arq")/auditoria-$mes_ult.jsonl"
    if [ -e "$destino" ]; then
        printf 'Nao deu certo: nao consegui fechar o mes %s da auditoria porque ja existe %s.\nO que fazer: confira com "dgclaw auditoria verificar" e mova um dos dois arquivos para fora da pasta antes de continuar.\n' "$mes_ult" "${destino#"$R"}" >&2
        return 1
    fi
    mv "$arq" "$destino" || return 1
}

# _aud_hash_anterior <arquivo-vivo>: o hash da ultima linha dos arquivos mensais fechados, ou o da poda, ou zeros.
_aud_hash_anterior() {
    local pasta f ultima
    pasta="$(dirname "$1")"
    f="$(find "$pasta" -maxdepth 1 -name 'auditoria-[0-9][0-9][0-9][0-9]-[0-9][0-9].jsonl' 2>/dev/null | LC_ALL=C sort | tail -n 1)"
    if [ -n "$f" ] && [ -s "$f" ]; then
        ultima="$(tail -n 1 "$f")"
        if [[ "$ultima" =~ ,\"hash\":\"([0-9a-f]{64})\"\}$ ]]; then printf '%s' "${BASH_REMATCH[1]}"; return 0; fi
    fi
    if [ -r "$pasta/auditoria-poda.json" ]; then
        jq -r '.ate_hash // empty' "$pasta/auditoria-poda.json" 2>/dev/null | grep -E '^[0-9a-f]{64}$' && return 0
    fi
    printf '%s' "$AUD_ZERO"
}

# _aud_gravar <arquivo> <evento> <json-dados>: com a trava na mao, encadeia e acrescenta a linha.
_aud_gravar() {
    local arq="$1" evento="$2" dados="$3" ant="" ultima quem corpo hash ts origem
    origem="${DGCLAW_AUDITORIA_ORIGEM:-cli}"
    if ! [[ "$origem" =~ ^[a-z][a-z0-9_-]{0,30}$ ]]; then
        printf 'Nao deu certo: a origem "%.40s" nao serve (DGCLAW_AUDITORIA_ORIGEM).\nO que fazer: use letras minusculas, numeros, traco e sublinhado, como "cli" ou "controle".\n' "$origem" >&2
        return 1
    fi
    _aud_rotacionar "$arq" || return 1
    if [ -s "$arq" ]; then
        ultima="$(tail -n 1 "$arq")"
        if [[ "$ultima" =~ ,\"hash\":\"([0-9a-f]{64})\"\}$ ]]; then
            ant="${BASH_REMATCH[1]}"
        else
            ant="$AUD_ZERO"
            aviso "a ultima linha de ${arq#"$R"} nao tem hash valido (arquivo cortado ou editado); recomecei a corrente aqui. A conferencia vai apontar essa linha."
        fi
    fi
    if [ -z "$ant" ]; then ant="$(_aud_hash_anterior "$arq")"; fi
    quem="${DGCLAW_QUEM:-${SUDO_USER:-${USER:-desconhecido}}}"
    ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
    corpo="$(jq -c --arg ts "$ts" --arg e "$evento" --arg q "$quem" --arg a "$ant" --arg o "$origem" \
        '{ts: $ts, evento: $e, quem: $q, origem: $o, dados: ., ant: $a}' <<<"$dados")" || {
        printf 'Nao deu certo: o jq nao montou a linha do evento "%s".\nO que fazer: confira se o jq esta instalado e os dados sao JSON.\n' "$evento" >&2; return 1; }
    hash="$(printf '%s%s' "$ant" "$corpo" | sha256sum | cut -d' ' -f1)"
    if [ -s "$arq" ] && [ "$(tail -c 1 "$arq" | od -An -c | tr -d ' ')" != '\n' ]; then printf '\n' >>"$arq"; fi
    if [ ! -e "$arq" ]; then ( umask 077; : >"$arq" ); fi
    chmod 600 "$arq"
    printf '%s,"hash":"%s"}\n' "${corpo%\}}" "$hash" >>"$arq" || {
        printf 'Nao deu certo: nao consegui escrever em %s.\nO que fazer: confira o espaco em disco e a permissao da pasta %s.\n' "${arq#"$R"}" "${DG_LOG#"$R"}" >&2; return 1; }
}

# auditar <evento> [<json-dados>]
# Acrescenta um evento a trilha. Devolve 1 (dizendo por que) se nao conseguiu gravar; quem chama
# decide o que fazer, mas nunca deve fingir que gravou.
auditar() {
    local evento="${1:-}" dados="${2:-}" arq nivel rc=0
    [ -n "$dados" ] || dados='{}'
    if [ -z "$evento" ]; then
        printf 'Nao deu certo: auditar foi chamado sem o nome do evento.\nO que fazer: avise quem mantem o DG Claw; isto e um erro de programacao.\n' >&2
        return 1
    fi
    nivel="$(protecao_valor auditoria)" || return 1
    if [ "$nivel" = nao ]; then return 0; fi
    if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$dados"; then
        printf 'Nao deu certo: os dados do evento "%s" nao sao um objeto JSON: %.80s\nO que fazer: avise quem mantem o DG Claw; isto e um erro de programacao.\n' "$evento" "$dados" >&2
        return 1
    fi
    if [ "$ENSAIO" = 1 ]; then printf '   [ensaio] auditaria o evento %s\n' "$evento"; return 0; fi

    arq="$(_aud_arquivo)"
    mkdir -p "$(dirname "$arq")"
    if ! _aud_pegar_trava "$arq"; then
        printf 'Nao deu certo: nao consegui a trava da auditoria (%s.trava) em %s decimos de segundo; outro processo a segura.\nO que fazer: espere e repita. Se nada estiver rodando, apague a pasta %s.trava.\n' "${arq#"$R"}" "$AUD_ESPERA_MAX_DS" "${arq#"$R"}" >&2
        return 1
    fi
    _aud_gravar "$arq" "$evento" "$dados" || rc=$?
    rmdir "$arq.trava" 2>/dev/null || aviso "nao consegui soltar a trava ${arq#"$R"}.trava (ja tinha sumido?)."
    return "$rc"
}

# auditar_aviso <evento> [<json-dados>]
# Como `auditar`, para quem ja fez a acao: se a trilha nao aceitou, a acao continua valendo e a
# pessoa fica sabendo que ela nao ficou registrada (a mensagem de motivo vem de `auditar`).
auditar_aviso() {
    auditar "$@" || aviso "a acao foi feita, mas nao ficou registrada na auditoria (veja o motivo acima)."
    return 0
}
