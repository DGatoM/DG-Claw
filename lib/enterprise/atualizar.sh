#!/usr/bin/env bash
# lib/enterprise/atualizar.sh: o enterprise por cima do `dgclaw atualizar` do main (lib/atualizar.sh).
#
# O comando, as opcoes (--simular, --voltar, --segundo-plano...), o backup datado, a conferencia e o
# reinicio do Admin sao do main. Aqui ficam so os ganchos que ele chama (atualizar_gancho):
#
#   ent_antes_de_atualizar_auditoria      <modo>                                   audita atualizar.inicio
#   ent_preparar_backup_atualizar_protecao                                         tira segredos e conversas do backup
#   ent_depois_de_atualizar_auditoria     <modo> <ok|incompleta|falha> <de> <para> <etapa>
#                                                                                  audita sucesso, falha ou rollback
#   ent_depois_de_atualizar_retencao      (mesmos argumentos)                      aplica backup_retencao_dias
#
# <modo> e `atualizar` ou `voltar`. No nivel pessoal nenhum gancho muda nada: o backup e o do main e a
# auditoria nem grava (a protecao `auditoria` e `nao`). A decisao sobre o backup esta em
# docs/enterprise/DESENHO.md (secao "Backup do dgclaw atualizar").
# shellcheck disable=SC2034 # os ATU_* sao lidos por lib/atualizar.sh

# Arquivos de /etc/dgclaw que so o enterprise cria e que nao podem sair da protecao do disco:
# chave do disco, segredo do restic, destino dos alertas, destino da auditoria externa e as credenciais
# das acoes externas. O instalador preserva todos, entao o --voltar nao precisa deles.
_ATU_SEGREDOS_ENT=(disco.chave backup.env alertas.env auditoria-externa.json acoes-externas)

_atu_ent_ativo() { [ "$(protecao_nivel)" != pessoal ]; }

ent_antes_de_atualizar_auditoria() {
    local modo="${1:-atualizar}"
    if [ "$ENSAIO" = 1 ]; then return 0; fi
    auditar_aviso atualizar.inicio "$(jq -nc --arg m "$modo" --arg de "${DGCLAW_VERSAO:-desconhecida}" '{modo: $m, de: $de}')"
}

# Backup do main = /etc/dgclaw e /var/lib/dgclaw inteiros em .tar.gz, fora da retencao, da exclusao por
# titular e do restic. Acima de `pessoal`: sem os segredos do enterprise, sem as casas dos agentes
# (conversas; elas ja vao no backup do restic, `dgclaw backup`), sem as conversas do painel e sem as
# pastas de estado do backup, da restauracao e dos titulares. A atualizacao nao toca nesses dados, entao
# nada disso e preciso para o --voltar.
ent_preparar_backup_atualizar_protecao() {
    local f lib
    if ! _atu_ent_ativo; then return 0; fi
    lib="$(_rel "$DG_LIB")"
    for f in "${_ATU_SEGREDOS_ENT[@]}"; do ATU_EXCLUIR_CONFIG+=("--exclude=$(_rel "$DG_ETC")/$f"); done
    for f in web/sessoes.json backup restauracoes titulares; do ATU_EXCLUIR_DADOS+=("--exclude=$lib/$f"); done
    ATU_EXCLUIR_DADOS+=("--exclude=$lib/agentes.antes-de-cifrar*")
    ATU_SEM_HOMES=1
    if [ "$ENSAIO" = 1 ]; then return 0; fi
    info "nivel $(protecao_nivel): o backup desta atualizacao fica sem os segredos do enterprise, sem as casas dos agentes e sem as conversas do painel (a atualizacao nao mexe neles)."
    if declare -F _bk_configurado >/dev/null && ! _bk_configurado; then
        aviso "o backup externo ainda nao esta configurado, entao as casas dos agentes (conversas e memoria) nao tem copia nenhuma. Configure com: dgclaw backup configurar --repositorio <destino>"
    fi
}

ent_depois_de_atualizar_auditoria() {
    local modo="${1:-atualizar}" resultado="${2:-}" de="${3:-}" para="${4:-}" etapa="${5:-}"
    if [ "$ENSAIO" = 1 ]; then return 0; fi
    case "$modo:$resultado" in
        atualizar:ok) auditar_aviso atualizar.sucesso "$(jq -nc --arg de "$de" --arg p "$para" '{de: $de, para: $p}')" ;;
        voltar:ok) auditar_aviso atualizar.rollback "$(jq -nc --arg c "$para" '{commit: $c}')" ;;
        *) auditar_aviso atualizar.falha "$(jq -nc --arg m "$modo" --arg r "$resultado" --arg e "$etapa" '{modo: $m, resultado: $r, etapa: $e}')" ;;
    esac
}

# backup_retencao_dias: apaga as pastas de /var/backups/dgclaw mais velhas que o prazo. Guarda sempre as
# duas mais novas (a desta atualizacao e a anterior), porque e delas que o --voltar precisa.
ent_depois_de_atualizar_retencao() {
    local modo="${1:-atualizar}" resultado="${2:-}" dias nome limite n=0 apagados=0
    if ! _atu_ent_ativo; then return 0; fi
    if [ "$ENSAIO" = 1 ] || [ "$modo" != atualizar ] || [ "$resultado" != ok ]; then return 0; fi
    [ -d "$DG_BACKUPS" ] || return 0
    dias="$(protecao_valor backup_retencao_dias)" || return 0
    limite="$(date -d "$dias days ago" +%Y%m%d)" || { aviso "nao consegui calcular o prazo de $dias dia(s) dos backups antigos."; return 0; }
    while IFS= read -r nome; do
        n=$((n + 1))
        [ "$n" -gt 2 ] || continue
        [ "${nome:0:8}" -lt "$limite" ] || continue
        rm -rf -- "${DG_BACKUPS:?}/$nome"
        apagados=$((apagados + 1))
    done < <(find "$DG_BACKUPS" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | { grep -E '^[0-9]{8}-[0-9]{6}(-[0-9]+)?$' || true; } | LC_ALL=C sort -r)
    if [ "$apagados" -gt 0 ]; then
        ok "retencao dos backups da atualizacao ($dias dias): apaguei $apagados pasta(s) mais velha(s) em ${DG_BACKUPS#"$R"}"
        auditar_aviso atualizar.retencao "$(jq -nc --argjson d "$dias" --argjson n "$apagados" '{dias: $d, apagados: $n}')"
    fi
}
