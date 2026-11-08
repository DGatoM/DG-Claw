#!/usr/bin/env bash
# anexo-seguro.sh: acrescenta uma secao no fim de um arquivo de instrucoes do agente (CLAUDE.md,
# AGENTS.md) SEM seguir link simbolico. Usado pelo doctor.sh --fix, que roda como root no host,
# enquanto o arquivo fica na casa do agente, onde o proprio agente pode trocar o arquivo por um link
# para um arquivo de sistema (por exemplo /etc/ssh/sshd_config). Seguir o link faria o root escrever
# Markdown nesse arquivo e passar o dono dele para o usuario do agente.
#
# anexo_arquivo_seguro <arquivo> <workspace>
#   Devolve 0 se o arquivo e um arquivo regular, que nao e link, e seu caminho real e filho direto do
#   workspace real. Senao devolve 1 e deixa o motivo (em portugues) em ANEXO_MOTIVO.
#
# anexar_secao_segura <arquivo> <workspace> <texto-da-secao> <backup> <usuario-dono>
#   Faz, nesta ordem: confere o arquivo e o backup (recusa link); guarda uma copia no <backup> se ele
#   ainda nao existe; monta o arquivo novo num temporario criado no MESMO diretorio (mktemp, 0600),
#   com o conteudo atual mais a secao, mesmo modo e dono (chown no temporario, que e nosso); confere
#   de novo que o arquivo e o mesmo (mesmo dispositivo e inode) e continua sem ser link; e troca com
#   `mv -T`, que e um rename: ele substitui o NOME e nunca segue o destino, mesmo que seja link.
#   Devolve 0 se acrescentou, 1 se recusou (motivo em ANEXO_MOTIVO), 2 se falhou ao gravar.
#
# CORRIDA que sobra: entre a segunda conferencia e o rename o agente ainda pode trocar o arquivo.
# Isso nao abre nada: o rename troca o nome (um link plantado ali e simplesmente substituido), e o
# conteudo lido foi conferido antes e depois da leitura. O que o agente consegue e fazer a secao
# nova ser perdida. O ideal e rodar a migracao como o usuario do agente; o doctor nao tem esse
# caminho hoje.

# shellcheck disable=SC2034
ANEXO_MOTIVO=""

anexo_arquivo_seguro() {
    local arq="$1" ws="$2" real wsreal
    ANEXO_MOTIVO=""
    if [ -L "$arq" ]; then
        ANEXO_MOTIVO="$arq e um link simbolico (aponta para $(readlink -- "$arq" 2>/dev/null || echo '?')); nao leio nem escrevo por ele. Apague o link e recoloque o arquivo de verdade (ou restaure o ultimo backup .bak-*), depois rode o doctor de novo"
        return 1
    fi
    if [ ! -f "$arq" ]; then
        ANEXO_MOTIVO="$arq nao e um arquivo comum. Troque por um arquivo regular e rode o doctor de novo"
        return 1
    fi
    real="$(readlink -f -- "$arq" 2>/dev/null)" || real=""
    wsreal="$(readlink -f -- "$ws" 2>/dev/null)" || wsreal=""
    if [ -z "$real" ] || [ -z "$wsreal" ] || [ "$(dirname -- "$real")" != "$wsreal" ]; then
        ANEXO_MOTIVO="o caminho real de $arq (${real:-?}) nao fica direto dentro do workspace do agente (${wsreal:-?}); uma pasta no caminho e um link. Conferir com ls -ld e corrigir"
        return 1
    fi
    return 0
}

anexar_secao_segura() {
    local arq="$1" ws="$2" texto="$3" bak="$4" dono="$5" dir id1 id2 tmp tmpbak
    anexo_arquivo_seguro "$arq" "$ws" || return 1
    if [ -L "$bak" ] || { [ -e "$bak" ] && [ ! -f "$bak" ]; }; then
        ANEXO_MOTIVO="o backup $bak ja existe e e um link ou nao e arquivo comum; nao escrevo por ele. Apague $bak e rode o doctor de novo"
        return 1
    fi
    dir="$(dirname -- "$arq")"
    id1="$(stat -c '%d:%i' -- "$arq")" || { ANEXO_MOTIVO="nao consegui ler os dados de $arq"; return 2; }
    if [ ! -e "$bak" ]; then
        tmpbak="$(mktemp "$dir/.bak.XXXXXX")" || { ANEXO_MOTIVO="nao consegui criar um temporario em $dir (permissao ou disco cheio?)"; return 2; }
        if cp -p -- "$arq" "$tmpbak" && mv -T -- "$tmpbak" "$bak"; then :; else
            rm -f -- "$tmpbak"
            ANEXO_MOTIVO="nao consegui guardar o backup em $bak"
            return 2
        fi
    fi
    tmp="$(mktemp "$dir/.anexo.XXXXXX")" || { ANEXO_MOTIVO="nao consegui criar um temporario em $dir (permissao ou disco cheio?)"; return 2; }
    if ! { cat -- "$arq"; printf '\n%s\n' "$texto"; } > "$tmp"; then
        rm -f -- "$tmp"; ANEXO_MOTIVO="nao consegui montar o arquivo novo em $tmp"; return 2
    fi
    chmod --reference="$arq" -- "$tmp" 2>/dev/null || chmod 644 -- "$tmp"
    if [ "$dono" != "root" ]; then
        chown -h -- "$dono:" "$tmp" || { rm -f -- "$tmp"; ANEXO_MOTIVO="nao consegui passar o arquivo para o usuario $dono; rode como root"; return 2; }
    fi
    # Conferencia final: o arquivo lido e o mesmo de antes e continua sem ser link.
    id2="$(stat -c '%d:%i' -- "$arq" 2>/dev/null)" || id2=""
    if [ -L "$arq" ] || [ "$id1" != "$id2" ]; then
        rm -f -- "$tmp"
        ANEXO_MOTIVO="$arq mudou (ou virou link) enquanto eu o lia; nao gravei nada. Rode o doctor de novo"
        return 1
    fi
    # shellcheck disable=SC2034
    mv -T -- "$tmp" "$arq" || { rm -f -- "$tmp"; ANEXO_MOTIVO="nao consegui trocar $arq"; return 2; }
    return 0
}
