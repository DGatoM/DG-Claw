#!/usr/bin/env bash
# lib/enterprise/container.sh: container endurecido (protecao `container_endurecido`).
#
# Gancho ent_args_container_endurecer: acrescenta ao `podman create` as opcoes que tiram do agente o
# que ele nao precisa. No nivel pessoal nao acrescenta nada (o array fica igual ao de hoje).
# Tambem define `dgclaw agente pacote`, o jeito de instalar pacote num agente que perdeu o sudo.
# Detalhes, o que deixa de funcionar e como contornar: docs/enterprise/CONTAINER-ENDURECIDO.md.

# Capacidades que sobram depois de `--cap-drop=ALL`, e por que cada uma ficou:
#   CHOWN, DAC_OVERRIDE, FOWNER, FSETID  o systemd (PID 1) e as unidades ajustam dono e modo de /run, /var e dos
#                                        arquivos que criam; o apt (dgclaw agente pacote) tambem.
#   SETUID, SETGID                       `User=agente` das unidades, `runuser` do reparar e o apt largando
#                                        para o usuario `_apt` dependem de trocar de uid/gid.
#   SETPCAP                              o systemd reduz o conjunto de capacidades de cada servico que sobe.
#   KILL                                 parar e reiniciar unidades (systemctl, cron) manda sinal a processos
#                                        de outros uids (o agente e o root de dentro).
#   NET_BIND_SERVICE                     bind em porta baixa de dentro (o runner e o painel usam 4300 e 8300,
#                                        mas ferramentas do agente podem subir servidor na 80).
#   SYS_CHROOT                           o apt e o dpkg usam chroot em scripts de pacote; o systemd tambem
#                                        em alguns sandboxes de unidade.
#   AUDIT_WRITE                          o `runuser`/PAM grava no audit do kernel; sem a capacidade a sessao
#                                        falha com "Cannot make/remove an entry for the specified session".
# Ficam de fora (padrao do podman, mas o agente nao usa): MKNOD, SETFCAP, NET_RAW. Sem NET_RAW o `ping`
# de raw socket falha; o `ping` do iputils usa socket ICMP de datagrama e continua funcionando.
ENT_CONT_CAPS=(CHOWN DAC_OVERRIDE FOWNER FSETID KILL SETGID SETUID SETPCAP NET_BIND_SERVICE SYS_CHROOT AUDIT_WRITE)

# ent_args_container_endurecer <nome-do-array> <slug>
ent_args_container_endurecer() {
    local -n _ent_cont_args="$1"
    local cap
    protecao_ligada container_endurecido || return 0
    _ent_cont_args+=(--cap-drop=ALL)
    for cap in "${ENT_CONT_CAPS[@]}"; do _ent_cont_args+=("--cap-add=$cap"); done
    # Sem isto o setuid do `sudo` ainda funcionaria. Com isto o agente deixa de subir para root de dentro.
    _ent_cont_args+=(--security-opt no-new-privileges)
    _ent_cont_args+=(--ulimit nofile=4096:8192)
}

# Nome de pacote Debian: letras minusculas, digitos, + - . ; comeca com letra ou digito; 2 a 100 caracteres.
_ENT_PACOTE_RX='^[a-z0-9][a-z0-9+.-]+$'

# dgclaw agente pacote <slug> <pacote...>
ent_cmd_agente_pacote() {
    local slug="${1:-}" p c
    if [ "$#" -gt 0 ]; then shift; fi
    if [ -z "$slug" ] || [ "$#" -eq 0 ]; then
        falha "faltou o agente ou o pacote." "use: dgclaw agente pacote <slug> <pacote...>   (exemplo: dgclaw agente pacote ana imagemagick)"
    fi
    exigir_slug "$slug" pacote
    if ! protecao_ligada container_endurecido; then
        falha "neste nivel de protecao o agente $slug ainda tem sudo, e este comando e so para o container endurecido." \
            "peca ao proprio agente para rodar 'sudo apt-get install -y <pacote>', ou suba o nivel com: dgclaw nivel definir escritorio"
    fi
    for p in "$@"; do
        if [ "${#p}" -gt 100 ] || ! [[ "$p" =~ $_ENT_PACOTE_RX ]]; then
            falha "'${p:0:60}' nao parece nome de pacote Debian." \
                "use so letras minusculas, numeros e os sinais + - . (exemplo: imagemagick, libreoffice-writer). Versao e opcoes nao sao aceitas aqui."
        fi
    done
    exigir_ferramentas jq podman
    existe_agente "$slug" || falha "nao conheco o agente '$slug'." "veja os que existem com: dgclaw agente listar"
    c="dgclaw-$slug"
    if [ "$ENSAIO" != 1 ] && [ "$(podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" != running ]; then
        falha "o container $c nao esta ligado." "ligue com: dgclaw agente iniciar $slug   e repita o comando."
    fi
    # argv em array, sem shell no meio: o nome ja foi validado, e mesmo assim nada passa por interpolacao.
    executar podman exec -u 0 --env DEBIAN_FRONTEND=noninteractive "$c" apt-get install -y --no-install-recommends -- "$@"
    ok "pacote(s) instalado(s) no agente $slug: $*"
    auditar_aviso agente.pacote "$(jq -nc --arg s "$slug" '{slug: $s, pacotes: $ARGS.positional}' --args "$@")"
}

# _cont_defasado <slug>: imprime o que falta no container (vazio = em dia). So olha o que as protecoes
# ligadas pedem: no-new-privileges (container_endurecido) e a pasta do cofre em memoria (cofre_cifrado).
_cont_defasado() {
    local c="dgclaw-$1" falta=""
    podman container exists "$c" >/dev/null 2>&1 || return 0
    if protecao_ligada container_endurecido \
        && ! podman inspect -f '{{.HostConfig.SecurityOpt}}' "$c" 2>/dev/null | grep -q 'no-new-privileges'; then
        falta="cap-drop e no-new-privileges"
    fi
    if protecao_ligada cofre_cifrado \
        && ! podman inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$c" 2>/dev/null | grep -q '/cofres/'; then
        falta="${falta:+$falta, }cofre em memoria"
    fi
    printf '%s' "$falta"
}

# `dgclaw agente recriar <slug> --forcar` e do main (agente_recriar, bin/dgclaw): refaz o container com as
# protecoes do nivel atual. A casa (/home/agente, memoria, conversas) fica, porque e uma pasta do host; o que
# o agente instalou so na camada do container (apt, /opt) se perde. As rotinas voltam sozinhas. Sem --forcar o
# main responde "nada a recriar" quando a imagem e a atual, e e exatamente o caso de quem acabou de subir o
# nivel de protecao: por isso as mensagens deste arquivo mandam usar --forcar. O gancho abaixo so audita.
ent_depois_de_recriar_auditoria() {
    auditar_aviso agente.recriar "$(jq -nc --arg s "${1:-}" '{slug: $s}')"
}

# `dgclaw protecoes aplicar`: nao recria sozinho (derrubaria os agentes e levaria o que eles instalaram);
# diz quais agentes estao defasados e o comando para cada um.
ent_aplicar_container() {
    local slug falta alguma=0
    protecao_ligada container_endurecido || protecao_ligada cofre_cifrado || return 0
    while IFS= read -r slug; do
        falta="$(_cont_defasado "$slug")"
        if [ -n "$falta" ]; then
            alguma=1
            aviso "o container do agente $slug foi criado antes e esta sem: $falta. Para recriar (a casa fica): dgclaw agente recriar $slug --forcar"
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    [ "$alguma" = 1 ] || ok "todos os containers ja estao com as protecoes do nivel"
}

ent_status_container() {
    local slug falta
    protecao_ligada container_endurecido || return 0
    while IFS= read -r slug; do
        falta="$(_cont_defasado "$slug")"
        if [ -n "$falta" ]; then s_aviso "agente $slug: container criado antes das protecoes, sem: $falta (dgclaw agente recriar $slug --forcar)"; fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
}
