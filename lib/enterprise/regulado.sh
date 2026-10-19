#!/usr/bin/env bash
# lib/enterprise/regulado.sh: ajustes do nivel regulado que nao cabem em outro bloco.
#
# regulado_relatorio_teste <snapshot> <arquivos-verificados>: no nivel regulado, o teste de restauracao do backup
# (lib/enterprise/backup.sh, timer MENSAL neste nivel) grava um relatorio e imprime o sha256 dele. O backup poe esse
# hash no evento backup.teste_restauracao da auditoria. Como a auditoria e encadeada por hash (e, no regulado, enviada
# a um coletor externo), o relatorio fica assinado pela corrente: mudar o arquivo depois muda o sha256 e nao bate com o evento.
# Conferir:  sha256sum <relatorio>  contra  dgclaw auditoria exportar | grep backup.teste_restauracao
# Fora do regulado nao faz nada e nao imprime nada.

regulado_relatorio_teste() {
    local snap="$1" n="$2" dir arq
    [ "$(protecao_nivel)" = regulado ] || return 0
    dir="$DG_LIB/backup/relatorios"
    mkdir -p "$dir"; chmod 700 "$dir"
    arq="$dir/teste-restauracao-$(date -u +%Y%m%dT%H%M%SZ).json"
    jq -n --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg s "$snap" --argjson n "$n" --arg h "$(hostname)" --arg v "$(cat "$APP_DIR/VERSION" 2>/dev/null || echo desconhecida)" \
        '{tipo: "teste_restauracao", resultado: "ok", em: $t, snapshot: $s, arquivos_conferidos: $n, servidor: $h, versao_dgclaw: $v}' \
        | escrever_arquivo "$arq" 600
    sha256sum <"$arq" | cut -d' ' -f1
}
