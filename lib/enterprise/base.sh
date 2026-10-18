#!/usr/bin/env bash
# lib/enterprise/base.sh: os pontos de extensao da versao enterprise na CLI e no instalador.
#
# Cada recurso enterprise mora no proprio arquivo em lib/enterprise/ e se pendura no
# bin/dgclaw (ou no install.sh) por convencao de nome, sem que dois blocos precisem editar o
# mesmo lugar:
#
#   comando novo        ent_cmd_<comando>            (traco do comando vira sublinhado)
#   argumentos podman   ent_args_container_<bloco>   (recebe o NOME do array e o slug)
#   apos criar agente   ent_depois_de_criar_<bloco>  (recebe o slug)
#   linhas do status    ent_status_<bloco>
#   etapa do instalador ent_instalar_<bloco>
#   `protecoes aplicar` ent_aplicar_<bloco>
#
# Os ganchos de um prefixo rodam em ordem alfabetica do nome. Cada gancho consulta o nivel
# (protecao_ligada) e nao faz nada quando a protecao dele esta desligada: no nivel pessoal a
# CLI se comporta como antes.

# ent_despachar <comando> [argumentos...]
# Chama ent_cmd_<comando>. Devolve 127 se nao existe, para quem chamou mostrar o erro de sempre.
ent_despachar() {
    local cmd="${1:-}" fn
    if [ "$#" -gt 0 ]; then shift; fi
    [[ "$cmd" =~ ^[a-z][a-z0-9-]*$ ]] || return 127
    fn="ent_cmd_${cmd//-/_}"
    declare -F "$fn" >/dev/null || return 127
    "$fn" "$@"
}

# ent_rodar_ganchos <prefixo> [argumentos...]
# Chama, em ordem alfabetica, toda funcao cujo nome comeca com o prefixo, passando os
# argumentos. Para no primeiro gancho que falha e devolve o codigo dele depois de dizer qual
# foi: uma protecao que nao conseguiu se aplicar nao pode passar por aplicada.
# Sem nenhum gancho, nao faz nada e devolve 0.
ent_rodar_ganchos() {
    local prefixo="${1:?ent_rodar_ganchos precisa do prefixo}" f rc
    shift
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        rc=0
        "$f" "$@" || rc=$?
        if [ "$rc" -ne 0 ]; then
            aviso "o gancho $f terminou com codigo $rc e parei os demais ganchos $prefixo*. Leia a mensagem acima dele; depois rode o comando de novo."
            return "$rc"
        fi
    done < <(compgen -A function "$prefixo" | LC_ALL=C sort)
}
