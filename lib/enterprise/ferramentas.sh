#!/usr/bin/env bash
# lib/enterprise/ferramentas.sh: conferencia de programas para os blocos enterprise.
# O bin/dgclaw tem o proprio exigir_ferramentas, mas o instalador (que tambem roda os ganchos
# ent_instalar_*) nao tem; este funciona nos dois.

# ent_exigir <programa...>: falha dizendo qual programa falta e como instalar.
ent_exigir() {
    local f
    for f in "$@"; do
        command -v "$f" >/dev/null 2>&1 \
            || falha "o programa '$f' nao foi encontrado nesta maquina." \
                     "instale o pacote que o traz (no Ubuntu: apt-get install -y cryptsetup rsync e2fsprogs restic sqlite3 jq util-linux) e rode o comando de novo."
    done
}
