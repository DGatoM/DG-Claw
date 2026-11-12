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
#   Entrega o trabalho a scripts/_lib/anexar_secao.py (python3 -I), que so usa descritores: abre a
#   pasta do workspace e cada pasta do caminho com O_NOFOLLOW, abre o original sem seguir link com
#   O_APPEND, cria o backup com O_EXCL|O_NOFOLLOW por dir_fd e escreve a secao no fim do proprio
#   arquivo, num unico write, depois de conferir de novo, por nome, que o original e o mesmo inode que
#   foi aberto. O arquivo nao e copiado nem substituido: o que o agente escrever durante a migracao
#   nao se perde. Nenhuma operacao reabre um caminho textual dentro da pasta que o agente escreve.
#   Devolve 0 se acrescentou, 1 se recusou (motivo em ANEXO_MOTIVO), 2 se falhou ao gravar.
#
# CORRIDA que sobra: se o agente trocar o nome do arquivo entre a conferencia e o write, a secao cai
# no arquivo antigo (ja desligado do nome) e se perde; nada e escrito atraves de link.

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

_ANEXO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

anexar_secao_segura() {
    local arq="$1" ws="$2" texto="$3" bak="$4" dono="$5" rel erro rc
    ANEXO_MOTIVO=""
    case "$arq" in
        "$ws"/*) rel="${arq#"$ws"/}" ;;
        *) ANEXO_MOTIVO="$arq nao fica dentro do workspace $ws"; return 1 ;;
    esac
    if [ "$(dirname -- "$bak")" != "$(dirname -- "$arq")" ]; then
        ANEXO_MOTIVO="o backup $bak precisa ficar na mesma pasta de $arq"; return 1
    fi
    # Todo o trabalho com arquivo e feito por descritor no helper Python (ver o cabecalho dele).
    # O texto vai pelo stdin; o shell nao interpola nada em codigo.
    erro="$(printf '%s' "$texto" | python3 -I "$_ANEXO_DIR/anexar_secao.py" "$ws" "$rel" "$(basename -- "$bak")" "${dono:--}" 2>&1 >/dev/null)"
    rc=$?
    ANEXO_MOTIVO="$erro"
    case "$rc" in
        0) return 0 ;;
        1) return 1 ;;
        *) return 2 ;;
    esac
}
