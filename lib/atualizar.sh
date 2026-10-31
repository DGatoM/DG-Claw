#!/usr/bin/env bash
# lib/atualizar.sh: `dgclaw atualizar`, a atualizacao do DG Claw sem perder nada do dono.
#
# Carregado com `source` pelo bin/dgclaw, nunca executado. Usa as funcoes dele e da lib/comum.sh
# (falha, ok, info, aviso, passo, executar, estado_container, saude_runner...), por isso as
# variaveis e funcoes "nao definidas aqui" abaixo sao do bin/dgclaw.
# shellcheck disable=SC2154
#
# A ordem importa e e sempre a mesma:
#   1. achar o clone e conferir que nao tem alteracao local;
#   2. backup datado (e conferido: o tar tem que abrir) ANTES de qualquer mudanca;
#   3. baixar a versao nova (git, so se for avanco simples);
#   4. rodar o install.sh do clone (ele preserva as configuracoes; ver install.sh);
#   5. reconstruir a imagem e recriar o container de cada agente, SEM tocar na casa deles;
#   6. conferir que tudo o que existia antes continua la;
#   7. reiniciar o Admin por ultimo, desacoplado (este comando pode estar rodando dentro dele).
# `--voltar <backup>` desfaz: volta o clone ao commit do backup e restaura configuracao e Admin.
#
# O que este arquivo NUNCA faz: `git reset --hard`, `git clean`, apagar pasta de agente, apagar
# volume, ou sobrescrever /var/lib/dgclaw. Detalhes e motivos em docs/ATUALIZAR.md.
#
# O backup em si (tar conferido, manifesto, pasta datada) mora em lib/backup.sh, que tambem serve
# ao `dgclaw backup` e ao `dgclaw restaurar`.

ATU_REPO=""
ATU_ETAPA=""
ATU_BACKUP=""
ATU_PROBLEMAS=0
ATU_AGENTES_FALHOS=""   # slugs que nao foram recriados ou nao responderam no fim (separados por espaco)
ATU_COMMIT_ANTIGO=""    # o commit que estava INSTALADO antes desta atualizacao (nao o HEAD do clone)
ATU_COMMIT_ORIGEM=""
ATU_VOLTAR_SOZINHO=0    # 1 = se o instalador novo ou a conferencia de configuracao falharem, desfaz sozinho
ATU_INSTALL_FALHOU=0
ATU_ROLLBACK_TEXTO=""   # o que o dono precisa saber quando a atualizacao foi desfeita sozinha

# _git <argumentos>: git no clone da atualizacao.
_git() { git_do_clone "$ATU_REPO" "$@"; }

_atu_problema() { ATU_PROBLEMAS=$((ATU_PROBLEMAS + 1)); printf '   FALHOU  %s\n' "$1" >&2; }

# Se a atualizacao parar no meio, a pessoa precisa saber onde parou, que os dados estao salvos
# e como seguir ou voltar.
_atualizar_ao_sair() {
    local rc=$?
    [ "$rc" -eq 0 ] && return 0
    {
        printf '\nA atualizacao parou em: %s.\n' "${ATU_ETAPA:-inicio}"
        if [ -n "$ATU_BACKUP" ] && [ -f "$ATU_BACKUP/MANIFESTO.txt" ]; then
            printf 'Seus dados estao salvos no backup %s (nada foi apagado).\n' "$ATU_BACKUP"
            printf 'Para tentar de novo (rodar de novo e seguro): sudo dgclaw atualizar --sem-baixar\n'
            printf 'Para voltar ao que era antes: sudo dgclaw atualizar --voltar %s\n' "$ATU_BACKUP"
        else
            printf 'Nada foi mudado ainda: o backup nem chegou a ser feito.\n'
        fi
    } >&2
}

# --- 1. o clone ---------------------------------------------------------------------------

# atualizar_achar_repo <--repo informado ou vazio>: define ATU_REPO ou falha explicando como informar.
atualizar_achar_repo() {
    local pedido="$1" candidato="" origem=""
    if [ -n "$pedido" ]; then candidato="$pedido"; origem="--repo"
    elif [ -n "${DGCLAW_REPO:-}" ]; then candidato="$DGCLAW_REPO"; origem="$DG_ETC/dgclaw.env (DGCLAW_REPO)"
    elif [ -f "$R/root/DG-Claw/install.sh" ]; then candidato="$R/root/DG-Claw"; origem="o lugar de sempre (/root/DG-Claw)"
    fi
    if [ -z "$candidato" ]; then
        falha "nao sei onde esta o clone do DG Claw (a pasta onde voce rodou o install.sh): o dgclaw.env nao guarda o caminho e --repo nao foi informado." \
              "diga onde ele esta: sudo dgclaw atualizar --repo /root/DG-Claw (troque pelo caminho certo; para procurar: find / -name install.sh -path '*DG-Claw*' 2>/dev/null). O proximo install.sh passa a anotar o caminho sozinho."
    fi
    [ -d "$candidato" ] || falha "o clone '$candidato' (vindo de $origem) nao e uma pasta." \
        "informe o caminho certo: sudo dgclaw atualizar --repo <pasta do clone>"
    candidato="$(cd "$candidato" && pwd)"
    if [ ! -f "$candidato/install.sh" ] || [ ! -f "$candidato/lib/comum.sh" ]; then
        falha "'$candidato' (vindo de $origem) nao parece o clone do DG Claw: falta o install.sh ou o lib/comum.sh." \
              "informe a pasta certa: sudo dgclaw atualizar --repo <pasta do clone>"
    fi
    ATU_REPO="$candidato"
    if ! git_do_clone "$ATU_REPO" rev-parse --git-dir >/dev/null 2>&1; then
        # Sem git so da para reinstalar o que ja esta na pasta (zip novo por cima): --sem-baixar, e nunca --voltar.
        if [ "$ATU_SEM_BAIXAR" != 1 ] || [ "$ATU_MODO" = voltar ]; then
            falha "'$ATU_REPO' nao e um repositorio git, entao nao tenho como baixar a versao nova nem voltar para a antiga." \
                  "se voce atualizou os arquivos a mao (zip novo por cima), rode com --sem-baixar. Se nao, clone de novo: git clone https://github.com/DGatoM/DG-Claw"
        fi
        aviso "'$ATU_REPO' nao e um repositorio git; vou so reinstalar o que esta na pasta. Nao havera como anotar a versao antiga no backup."
    fi
    info "clone do DG Claw: $ATU_REPO (vindo de $origem)"
}

# atualizar_checar_clone: alteracao local para ou vai para o stash (so com --forcar-local).
# Nunca reset --hard nem clean: o que a pessoa mexeu nunca e destruido.
atualizar_checar_clone() {
    git_do_clone "$ATU_REPO" rev-parse --git-dir >/dev/null 2>&1 || return 0
    local sujo stamp
    sujo="$(_git status --porcelain)" || falha "o 'git status' falhou no clone $ATU_REPO." \
        "entre na pasta e veja a mensagem do git: cd $ATU_REPO && git status"
    [ -n "$sujo" ] || { ok "o clone esta limpo (nenhuma alteracao local)"; return 0; }
    stamp="dgclaw-atualizar-$(date +%Y%m%d-%H%M%S)"
    if [ "$ATU_FORCAR_LOCAL" != 1 ]; then
        falha "o clone $ATU_REPO tem alteracao local que a atualizacao poderia atropelar:
$(printf '%s\n' "$sujo" | head -n 15 | sed 's/^/     /')" \
              "nada foi mudado. Guarde as alteracoes de lado (cd $ATU_REPO && git stash push -u -m $stamp) ou mova os arquivos para outra pasta, e rode de novo. Se quiser que eu guarde no stash por voce: sudo dgclaw atualizar --forcar-local"
    fi
    aviso "o clone tem alteracao local:"
    printf '%s\n' "$sujo" | head -n 15 | sed 's/^/        /' >&2
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] guardaria isso num stash chamado $stamp (git stash push -u -m $stamp)"
        return 0
    fi
    _git -c user.name=dgclaw -c user.email=dgclaw@localhost stash push -u -m "$stamp" >/dev/null \
        || falha "o 'git stash' do clone $ATU_REPO falhou." "guarde as alteracoes de lado na mao e rode de novo; nada foi mudado."
    ok "alteracoes locais guardadas no stash '$stamp' (para recuperar: cd $ATU_REPO && git stash list; git stash apply <stash>)"
}

# --- 2. backup ----------------------------------------------------------------------------

# --- 6. conferencia -----------------------------------------------------------------------

# Chaves do dgclaw.env que a atualizacao troca de proposito.
_chave_que_muda() { case "$1" in DGCLAW_VERSAO|DGCLAW_COMMIT) return 0 ;; esac; return 1; }

# _linhas_sobreviveram <arquivo antigo> <arquivo atual> <rotulo>: toda linha do antigo (menos as
# chaves que mudam de proposito) tem que estar no atual, igual.
_linhas_sobreviveram() {
    local antigo="$1" atual="$2" rotulo="$3" linha chave
    while IFS= read -r linha || [ -n "$linha" ]; do
        [ -n "$linha" ] || continue
        chave="${linha%%=*}"
        if _chave_que_muda "$chave"; then continue; fi
        if ! grep -qFx -- "$linha" "$atual"; then
            _atu_problema "$rotulo: a linha com a chave '${chave}' sumiu ou mudou de valor (o valor nao e mostrado aqui; a versao de antes esta no backup)"
        fi
    done <"$antigo"
}

# atualizar_conferir <pasta do backup>: define ATU_PROBLEMAS. Tudo o que so o instalador poderia
# mudar tem que estar igual; o que o proprio uso do sistema reescreve (casas, sessoes) so avisa.
atualizar_conferir() {
    local b="$1" tmp hash rel arq antigo sha_atual nome obj slug
    ATU_PROBLEMAS=0
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] compararia o que existia no backup com o que ficou (chaves, agentes, tokens, cofres, CLAUDE.md do Admin)"
        return 0
    fi
    tmp="$(mktemp -d)"
    chmod 700 "$tmp"
    tar -xzf "$b/config.tar.gz" -C "$tmp" \
        || { rm -rf "$tmp"; falha "nao consegui abrir $b/config.tar.gz para conferir." "o backup esta ali; confira com: tar -tzf $b/config.tar.gz"; }

    while read -r hash rel; do
        [ -n "$rel" ] || continue
        arq="${R:+$R/}$rel"
        [ -n "$R" ] || arq="/$rel"
        if [ ! -f "$arq" ]; then
            _atu_problema "$rel existia antes e sumiu"
            continue
        fi
        sha_atual="$(_sha "$arq")"
        antigo="$tmp/$rel"
        nome="$(basename "$rel")"
        case "$rel" in
            etc/dgclaw/web.env|etc/dgclaw/dgclaw.env|etc/dgclaw/registro.tsv|etc/dgclaw/portas.tsv)
                # Podem ganhar linhas; nenhuma linha de antes pode sumir nem mudar.
                if [ "$sha_atual" != "$hash" ]; then _linhas_sobreviveram "$antigo" "$arq" "$rel"; fi ;;
            etc/dgclaw/agentes.json)
                if [ "$sha_atual" != "$hash" ]; then
                    while read -r slug; do
                        obj="$(jq -cS --arg s "$slug" '.agentes[] | select(.slug == $s)' "$antigo")"
                        if [ "$obj" != "$(jq -cS --arg s "$slug" '.agentes[] | select(.slug == $s)' "$arq")" ]; then
                            _atu_problema "agentes.json: o registro do agente '$slug' mudou ou sumiu"
                        fi
                    done < <(jq -r '.agentes[] | select(.tipo == "agente") | .slug' "$antigo")
                    if [ -z "$(jq -r '.agentes[] | select(.slug == "admin") | .slug' "$arq")" ]; then
                        _atu_problema "agentes.json: o Admin nao esta mais registrado"
                    fi
                fi ;;
            etc/dgclaw/primeiro-acesso.json)
                if [ "$sha_atual" != "$hash" ]; then
                    aviso "$rel mudou: o instalador gerou um link de primeiro acesso novo (a senha ainda nao tinha sido cadastrada). Gere o link com: sudo dgclaw primeiro-acesso"
                fi ;;
            opt/dgclaw/admin/CLAUDE.md|opt/dgclaw/admin/AGENTS.md)
                # Igual ao de antes, ou era o modelo de fabrica e foi trocado pelo novo. Personalizado nao muda.
                if [ "$sha_atual" != "$hash" ] && ! modelo_admin_sha_de_fabrica "$hash" "$nome" "$ATU_REPO"; then
                    _atu_problema "$rel estava personalizado e foi alterado (o backup tem a sua versao: $b/admin.tar.gz)"
                fi ;;
            var/lib/dgclaw/web/sessoes.json|var/lib/dgclaw/agentes/*/home/*)
                # Quem escreve aqui e o uso normal (conversas, memoria do agente): mudar nao e erro.
                if [ "$sha_atual" != "$hash" ]; then
                    aviso "$rel mudou durante a atualizacao (normal se alguem estava conversando); a versao anterior esta no backup"
                fi ;;
            *)
                if [ "$sha_atual" != "$hash" ]; then _atu_problema "$rel mudou de conteudo (chaves, tokens e cofres nao podem mudar numa atualizacao)"; fi ;;
        esac
    done < <(sed -n '/^\[sha256\]$/,$p' "$b/MANIFESTO.txt" | tail -n +2)
    rm -rf "$tmp"

    if [ "$ATU_PROBLEMAS" -eq 0 ]; then ok "tudo o que existia antes continua igual (chaves, agentes, tokens, cofres, memoria e Admin)"; fi
}

# --- 4 e 5. instalar, imagem, agentes ------------------------------------------------------

# atualizar_rodar_install: o install.sh do clone, sem nada interativo e reaproveitando o que ja esta configurado.
atualizar_rodar_install() {
    local usuario dominio prov rc=0 args=()
    usuario="${DGCLAW_USUARIO:-$(_env_de "$DG_ETC/web.env" DGCLAW_PANEL_USER)}"
    [ -n "$usuario" ] || falha "nao descobri o usuario do painel (nem DGCLAW_USUARIO no dgclaw.env, nem DGCLAW_PANEL_USER no web.env)." \
        "diga qual e: sudo ./install.sh --usuario <nome> dentro do clone ($ATU_REPO) e depois rode de novo."
    dominio="${DGCLAW_DOMINIO:-}"
    prov="${DGCLAW_PROVEDOR_ADMIN:-}"
    args=(--usuario "$usuario")
    if [ -n "$dominio" ]; then args+=(--dominio "$dominio"); fi
    if [ -n "$prov" ]; then args+=(--provedor "$prov"); fi
    # A imagem e construida logo depois por este comando (com a certeza de que acabou); o
    # instalador so prepara a unidade.
    args+=(--sem-imagem)
    if [ "$ENSAIO" = 1 ]; then args+=(--ensaio); fi
    info "rodando: bash $ATU_REPO/install.sh ${args[*]}  (sem pergunta nenhuma; a senha atual do painel continua valendo)"
    # O link de primeiro acesso, se o instalador gerar um, e credencial: nao vai para o log.
    set +e
    bash "$ATU_REPO/install.sh" "${args[@]}" </dev/null 2>&1 | sed 's|primeiro-acesso#[A-Za-z0-9_-]*|primeiro-acesso#(oculto; gere outro com: sudo dgclaw primeiro-acesso)|'
    rc="${PIPESTATUS[0]}"
    set -e
    [ "$rc" -eq 0 ] || falha "o instalador ($ATU_REPO/install.sh) terminou com codigo $rc." \
        "leia as linhas acima, que mostram a causa. Seus dados estao no backup; rodar de novo e seguro: sudo dgclaw atualizar --sem-baixar"
}

# atualizar_aplicar: instalar + imagem + agentes. Compartilhado pela atualizacao e pelo --voltar.
# Chama de novo o proprio dgclaw (o ja instalado, com o codigo novo) para imagem e agentes.
atualizar_aplicar() {
    local slug falhou="" extra=()
    if [ "$ENSAIO" = 1 ]; then extra=(--ensaio); fi
    ATU_ETAPA="rodando o instalador"
    passo "Rodando o instalador do clone (configuracao e codigo)"
    if [ "$ATU_VOLTAR_SOZINHO" = 1 ]; then
        # Num subshell o `falha` do instalador so encerra o subshell: quem decide o que fazer e o chamador.
        ( atualizar_rodar_install ) || { ATU_INSTALL_FALHOU=1; return 0; }
    else
        atualizar_rodar_install
    fi
    carregar_env_dgclaw

    ATU_ETAPA="reconstruindo a imagem dos agentes"
    passo "Reconstruindo a imagem dos agentes (pode levar de 10 a 20 minutos)"
    "$DGCLAW_BIN_REAL" "${extra[@]}" imagem construir --agora

    ATU_ETAPA="recriando os containers dos agentes"
    passo "Recriando o container de cada agente (casa, cofre e rotinas ficam)"
    while IFS= read -r slug; do
        [ -n "$slug" ] || continue
        printf '\n   agente %s\n' "$slug"
        if ! "$DGCLAW_BIN_REAL" "${extra[@]}" agente recriar "$slug"; then falhou+=" $slug"; ATU_AGENTES_FALHOS+=" $slug"; fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    if [ -n "$falhou" ]; then
        ATU_PROBLEMAS=$((ATU_PROBLEMAS + 1))
        printf '   FALHOU  nao consegui recriar:%s (leia as mensagens acima; a casa deles esta intacta). Para refazer cada um: dgclaw agente recriar <slug> --forcar\n' "$falhou" >&2
    fi
}

# atualizar_checar_vida: o status geral e a saude de cada agente que estava ligado.
atualizar_checar_vida() {
    local slug runner estado saude
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] rodaria o dgclaw status e testaria a saude de cada agente"; return 0; fi
    set +e
    "$DGCLAW_BIN_REAL" status
    local rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then _atu_problema "o dgclaw status acusou servico essencial fora do ar (veja as linhas FALHOU acima)"; fi
    while IFS=$'\t' read -r slug runner; do
        [ -n "$slug" ] || continue
        estado="$(estado_container "$slug")"
        if [ "$estado" = stopping ]; then
            _atu_problema "agente $slug: o container esta preso em 'stopping'. Refaca com: dgclaw agente recriar $slug --forcar"
            ATU_AGENTES_FALHOS+=" $slug"
            continue
        fi
        if [ "$estado" != running ]; then
            aviso "agente $slug: container $estado (ele ja nao estava ligado ou nao subiu). Ligue com: dgclaw agente iniciar $slug"
            continue
        fi
        saude="$(saude_runner "${runner##*:}" "$estado")"
        if [ "$saude" = ok ]; then ok "agente $slug responde"
        else
            _atu_problema "agente $slug: o container esta de pe, mas o runner nao responde. Tente: dgclaw agente reparar $slug"
            ATU_AGENTES_FALHOS+=" $slug"
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | [.slug, .runner] | @tsv')
}

# atualizar_agendar_reinicio_do_admin <arquivo do resumo> <log>: o Admin pode ser quem esta rodando
# este comando; reiniciar na hora o mataria no meio da mensagem final. O systemd-run cria um
# temporizador separado que, daqui a DGCLAW_ESPERA_REINICIO segundos (padrao 20, o tempo do Admin
# contar ao dono que vai reiniciar), roda lib/reiniciar-admin.sh: reinicia o Admin, espera ele
# responder e manda a ELE uma mensagem pedindo que leia o resumo e conte o resultado ao dono.
# O token do Admin nao passa por aqui: o script le o arquivo, recebendo so o caminho dele.
atualizar_agendar_reinicio_do_admin() {
    local resumo="$1" log="$2" unidade espera="${DGCLAW_ESPERA_REINICIO:-20}" script
    unidade="dgclaw-admin-restart-$(date +%Y%m%d-%H%M%S)"
    script="$APP_DIR/lib/reiniciar-admin.sh"
    if [ ! -f "$DG_UNITS/dgclaw-admin.service" ] && [ "$ENSAIO" != 1 ]; then
        aviso "nao ha unidade dgclaw-admin.service em $DG_UNITS; nao ha Admin para reiniciar."
        return 0
    fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] agendaria: systemd-run --on-active=$espera --unit=$unidade bash $script (reinicia o Admin, espera ele responder e manda o resumo da atualizacao a ele)"
        return 0
    fi
    [ -f "$script" ] || falha "nao achei $script, o roteiro que reinicia o Admin e avisa o resultado." \
        "o resto ja foi feito. Reinicie o Admin voce mesmo, de fora do chat dele: systemctl restart dgclaw-admin"
    exigir_ferramentas systemd-run
    systemd-run --on-active="$espera" --unit="$unidade" --collect \
        --setenv="PATH=$PATH" ${R:+--setenv="DGCLAW_RAIZ=$R"} \
        bash "$script" "$resumo" "$log" "$DG_ETC/runner/admin.token" >/dev/null 2>&1 \
        || falha "o systemd-run nao conseguiu agendar o reinicio do Admin (unidade $unidade)." \
                 "o resto ja foi feito. Reinicie o Admin voce mesmo, de fora do chat dele: systemctl restart dgclaw-admin"
    ok "reinicio do Admin agendado para daqui a ${espera} segundos (unidade $unidade); ao voltar, ele recebe o resumo para contar a voce"
}

# atualizar_descobrir_commit_antigo: define ATU_COMMIT_ANTIGO com o commit que estava INSTALADO.
# O HEAD do clone nao serve sozinho: se alguem mudou o clone a mao (checkout/pull) antes do
# comando, o HEAD ja e o commit novo e o --voltar voltaria para a versao errada. Ordem:
#   1. DGCLAW_COMMIT do dgclaw.env (o instalador anota o commit que instalou);
#   2. o hash curto embutido em DGCLAW_VERSAO (formato v1-<12 hex>), resolvido no clone;
#   3. o HEAD do clone, com aviso (pode estar errado).
atualizar_descobrir_commit_antigo() {
    local env="$DG_ETC/dgclaw.env" c v h head
    c="$(_env_de "$env" DGCLAW_COMMIT)"
    if [[ "$c" =~ ^[0-9a-f]{40}$ ]] && _git cat-file -e "${c}^{commit}" 2>/dev/null; then
        ATU_COMMIT_ANTIGO="$c"; ATU_COMMIT_ORIGEM="DGCLAW_COMMIT do dgclaw.env"
    else
        v="$(_env_de "$env" DGCLAW_VERSAO)"; v="${v:-${DGCLAW_VERSAO:-}}"
        if [[ "$v" =~ ^v[0-9]+-([0-9a-f]{7,40})$ ]] && h="$(_git rev-parse --verify -q "${BASH_REMATCH[1]}^{commit}" 2>/dev/null)" && [ -n "$h" ]; then
            ATU_COMMIT_ANTIGO="$h"; ATU_COMMIT_ORIGEM="o hash da versao instalada ($v)"
        else
            ATU_COMMIT_ANTIGO="$(_git rev-parse HEAD 2>/dev/null || true)"; ATU_COMMIT_ORIGEM="HEAD do clone"
            aviso "nao achei o commit instalado (sem DGCLAW_COMMIT valido nem hash em DGCLAW_VERSAO='${v:-vazia}'); uso o HEAD do clone (${ATU_COMMIT_ANTIGO:0:10}) como 'antes'. Se o clone foi mudado a mao antes deste comando, o --voltar pode voltar para a versao errada."
        fi
    fi
    head="$(_git rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$head" ] && [ "$head" != "$ATU_COMMIT_ANTIGO" ]; then
        info "o clone ja estava em ${head:0:10}, mas o instalado e ${ATU_COMMIT_ANTIGO:0:10} ($ATU_COMMIT_ORIGEM); registro o instalado como a versao de antes."
    fi
}

# atualizar_montar_resumo <resultado> <versao antiga> <versao nova> <commit novo> <reinicia 1|0>
# Escreve o resumo final no STDOUT. O mesmo texto vai para o arquivo do resumo, que o Admin le
# depois do reinicio para contar o resultado ao dono.
atualizar_montar_resumo() {
    local resultado="$1" va="$2" vn="$3" cn="$4" reinicia="$5" slug oks=""
    while IFS= read -r slug; do
        [ -n "$slug" ] || continue
        case " $ATU_AGENTES_FALHOS " in *" $slug "*) ;; *) oks+="${oks:+, }$slug" ;; esac
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    printf '%s\n' "$resultado"
    printf '  Versao:  %s (%s) -> %s (%s)\n' "$va" "${ATU_COMMIT_ANTIGO:0:10}" "$vn" "${cn:0:10}"
    printf '  Backup:  %s\n' "$ATU_BACKUP"
    printf '  Para voltar atras: sudo dgclaw atualizar --voltar %s\n' "$ATU_BACKUP"
    printf '  Agentes que ficaram bem: %s\n' "${oks:-nenhum}"
    personalizacoes_linha_resumo
    if [ -n "${ATU_AGENTES_FALHOS// /}" ]; then
        printf '  Agentes COM PROBLEMA:%s\n' "$ATU_AGENTES_FALHOS"
        for slug in $ATU_AGENTES_FALHOS; do printf '    para refazer: dgclaw agente recriar %s --forcar\n' "$slug"; done
    fi
    if [ "$ATU_PROBLEMAS" -gt 0 ] && [ -z "${ATU_AGENTES_FALHOS// /}" ]; then
        printf '  A conferencia acusou %s problema(s) (linhas FALHOU no log).\n' "$ATU_PROBLEMAS"
    fi
    if [ "$reinicia" = 1 ]; then
        printf '  O Admin reinicia em alguns segundos e volta com o codigo novo. Se o chat parar, e isso; espere uns 20 segundos e recarregue a pagina.\n'
    else
        printf '  O Admin NAO foi reiniciado: ele precisa continuar de pe para consertar o que falhou, e segue com o codigo velho ate o reinicio.\n'
    fi
}

# --- o parecer obrigatorio ------------------------------------------------------------------
# Nunca se atualiza as cegas: antes do --ok-do-dono, quem analisou (o Admin) grava o veredito sobre AQUELE
# commit de destino. O --ok-do-dono confere esse arquivo (lib/personalizacoes.sh, _om_exigir_ok).

ATU_PARECER_LOG_NOME="atualizar-pareceres.log"

atualizar_parecer_arquivo() { printf '%s' "$DG_LIB/web/atualizacao/parecer.json"; }

# atualizar_registrar <evento> <detalhe>: uma linha no log dos pareceres (nunca texto de fora, so o que o comando sabe).
atualizar_registrar() {
    local log="$DG_LOG/$ATU_PARECER_LOG_NOME"
    [ "$ENSAIO" != 1 ] || [ "${ATU_MODO:-}" = parecer ] || return 0
    install -d -m 750 "$DG_LOG"
    printf '%s %s por=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${SUDO_USER:-root}" "$2" >>"$log" \
        || falha "nao consegui gravar o registro em $log." "confira o espaco e a permissao de $DG_LOG e rode de novo."
    chmod 600 "$log"
}

# atualizar_validar_parecer_pedido <simular> <segundo-plano> <voltar>: as combinacoes de opcoes que nao fazem sentido.
atualizar_validar_parecer_pedido() {
    local simular="$1" segundo="$2" voltar="$3"
    if [ "$ATU_MODO" = parecer ]; then
        case "$ATU_PARECER" in
            segura|arriscada) ;;
            *) falha "o parecer '${ATU_PARECER:0:30}' nao existe." "use --parecer segura ou --parecer arriscada, junto de --motivo \"<texto curto>\"." ;;
        esac
        [[ "$ATU_COMMIT_PARECER" =~ ^[0-9a-f]{40}$ ]] \
            || falha "falta o --commit do parecer, ou ele nao tem 40 caracteres hexadecimais (veio: ${ATU_COMMIT_PARECER:0:50})." \
                     "rode 'sudo dgclaw atualizar --simular', leia o relatorio e copie o commit da linha DESTINO= : sudo dgclaw atualizar --parecer $ATU_PARECER --commit <40 caracteres> --motivo \"<texto curto>\""
        [ -n "$ATU_MOTIVO" ] || falha "falta o --motivo do parecer." "diga em uma frase por que: sudo dgclaw atualizar --parecer $ATU_PARECER --motivo \"<texto curto>\""
        if [ "${#ATU_MOTIVO}" -gt 500 ] || [[ "$ATU_MOTIVO" == *$'\n'* ]]; then
            falha "o --motivo tem ${#ATU_MOTIVO} caracteres ou mais de uma linha." "resuma em uma linha de ate 500 caracteres."
        fi
        [ "$simular" != 1 ] || falha "--parecer nao combina com --simular." "o parecer ja le o que muda sem instalar nada; tire o --simular."
        [ "$segundo" != 1 ] || falha "--parecer nao combina com --segundo-plano." "ele e rapido e nao instala nada; rode direto."
        [ "$ATU_OK_DONO" != 1 ] || falha "--parecer nao combina com --ok-do-dono." "primeiro grave o parecer; depois, com o ok do dono, rode a atualizacao."
        [ -z "$voltar" ] || falha "--parecer nao combina com --voltar." "rode um de cada vez."
    elif [ -n "$ATU_MOTIVO" ] || [ -n "$ATU_COMMIT_PARECER" ]; then
        falha "--motivo e --commit so valem junto de --parecer." "use: sudo dgclaw atualizar --parecer segura|arriscada --motivo \"<texto curto>\""
    fi
    if [ "$ATU_APESAR" = 1 ] && [ "$ATU_OK_DONO" != 1 ]; then
        falha "--apesar-do-alerta so vale junto de --ok-do-dono." \
              "ele existe para o caso em que o dono ouviu o alerta de risco e pediu, explicitamente, para instalar mesmo assim: sudo dgclaw atualizar --ok-do-dono --apesar-do-alerta"
    fi
}

# atualizar_gravar_parecer: grava parecer.json (600) para o commit de destino que o relatorio acabou de mostrar.
atualizar_gravar_parecer() {
    local arq alvo instalado
    arq="$(atualizar_parecer_arquivo)"
    alvo="${ATU_DESTINO:-}"
    [[ "$alvo" =~ ^[0-9a-f]{40}$ ]] \
        || falha "nao consegui descobrir o commit de destino da atualizacao, entao nao ha a que dar parecer." \
                 "veja a mensagem acima (clone, internet) e rode de novo. Nada foi gravado."
    # O parecer vale para o commit que o ANALISTA viu: o do ultimo relatorio gravado antes deste comando. Se o
    # remoto andou desde entao, o que vai ser instalado nao e o que foi analisado.
    if [ -z "${OM_PREV_DEST:-}" ]; then
        falha "nao ha relatorio 'o que muda' gravado antes deste comando, entao nao ha o que o parecer confirme." \
              "rode 'sudo dgclaw atualizar --simular', leia o relatorio e repita o parecer com o commit da linha DESTINO=."
    fi
    if [ "$ATU_COMMIT_PARECER" != "$OM_PREV_DEST" ]; then
        falha "o --commit informado (${ATU_COMMIT_PARECER:0:10}) nao e o do ultimo relatorio gravado (${OM_PREV_DEST:0:10})." \
              "use o commit da linha DESTINO= do relatorio que voce leu. Se nao tem certeza de qual leu, rode 'sudo dgclaw atualizar --simular' de novo e analise esse."
    fi
    if [ "$ATU_COMMIT_PARECER" != "$alvo" ]; then
        falha "o repositorio andou: o relatorio que voce leu e de ${ATU_COMMIT_PARECER:0:10}, mas o destino agora e ${alvo:0:10}. Nada foi gravado." \
              "rode 'sudo dgclaw atualizar --simular' de novo, analise a versao nova e grave o parecer com o commit dela."
    fi
    if [ "${OM_PREV_PERS:-}" != "${ATU_PERS_HEAD:-}" ] || [ "${OM_PREV_MODO:-}" != "${ATU_MODO_INST:-}" ]; then
        falha "as personalizacoes ou o modo de instalacao mudaram depois do relatorio que voce leu (relatorio: ${OM_PREV_PERS:0:10} / ${OM_PREV_MODO:-sem registro}; agora: ${ATU_PERS_HEAD:0:10} / ${ATU_MODO_INST}). Nada foi gravado." \
              "rode 'sudo dgclaw atualizar --simular', leia o relatorio novo e de o parecer de novo."
    fi
    # A versao instalada tambem faz parte do que foi analisado: se ela mudou entre o --simular e o --parecer (uma
    # restauracao, uma atualizacao a mao), o parecer seria "B para C" sobre uma analise de "A para C".
    if [ "${OM_PREV_INST:-}" != "${ATU_COMMIT_ANTIGO:-}" ]; then
        falha "a versao instalada mudou depois do relatorio que voce leu (relatorio: ${OM_PREV_INST:0:10}${OM_PREV_INST:+, }agora: ${ATU_COMMIT_ANTIGO:0:10}). Nada foi gravado." \
              "rode 'sudo dgclaw atualizar --simular' de novo, leia o relatorio novo e grave o parecer dele."
    fi
    instalado="$OM_PREV_INST"
    # So vale quando a origem da versao instalada e verificavel: o "HEAD do clone" e um palpite, e com o clone ja puxado
    # a mao ele e igual ao destino, o que travaria o parecer (e, sem parecer, o --ok-do-dono) sem saida.
    if [ "$alvo" = "$instalado" ] && [ "${PERS_ATIVO:-0}" != 1 ] && [ "${ATU_COMMIT_ORIGEM:-}" != "HEAD do clone" ]; then
        falha "o destino (${alvo:0:10}) e o commit que ja esta instalado: nao ha atualizacao para dar parecer." "nada a fazer. Se acredita que saiu versao nova, confira: sudo dgclaw atualizar --checar"
    fi
    # O comando inteiro roda em modo ensaio (ler o que muda nao pode mudar nada); gravar o parecer e a unica excecao.
    local ensaio_antes="$ENSAIO"; ENSAIO=0
    install -d -m 700 "$(dirname "$arq")"
    jq -n --arg alvo "$alvo" --arg inst "$instalado" --arg v "$ATU_PARECER" --arg m "$ATU_MOTIVO" \
          --arg d "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg por "${SUDO_USER:-root}" \
          --arg ph "$ATU_PERS_HEAD" --arg mi "$ATU_MODO_INST" \
          '{commit_alvo: $alvo, commit_instalado: $inst, veredito: $v, motivo: $m, data: $d, por: $por, personalizacoes: $ph, modo: $mi}' \
        | escrever_arquivo "$arq" 600 \
        || falha "nao consegui gravar o parecer em $arq." "confira o espaco e a permissao de $(dirname "$arq") e rode de novo."
    atualizar_registrar parecer "alvo=${alvo:0:12} veredito=$ATU_PARECER motivo=$(printf '%s' "$ATU_MOTIVO" | tr -d '\000-\037\177')"
    ENSAIO="$ensaio_antes"
    ok "parecer '$ATU_PARECER' gravado para a versao ${alvo:0:10} em $arq"
    if [ "$ATU_PARECER" = segura ]; then
        info "Com o sim do dono: sudo dgclaw atualizar --ok-do-dono --segundo-plano"
    else
        info "Parecer ARRISCADA: a instalacao fica bloqueada. Conte o alerta ao dono. So se ele, depois de ouvir, pedir explicitamente para instalar mesmo assim: sudo dgclaw atualizar --ok-do-dono --apesar-do-alerta --segundo-plano"
    fi
}

# atualizar_conferir_parecer: chamado pelo --ok-do-dono, antes do backup. Exige parecer 'segura' para o destino
# (ou 'arriscada' com --apesar-do-alerta). Sem destino conhecido (sem git) nao ha a que comparar.
atualizar_conferir_parecer() {
    local arq alvo lido commit veredito motivo data pers modo inst_parecer
    alvo="${ATU_DESTINO:-}"
    if [ -z "$alvo" ]; then
        # Sem identidade verificavel do destino nao ha a que prender o parecer: bloqueia, em vez de deixar passar.
        atualizar_registrar bloqueio "motivo=destino-sem-identidade"
        falha "nao consigo identificar a versao de destino (o clone nao e um repositorio git ou nao tem de onde puxar), entao nao ha como conferir o parecer." \
              "faca da pasta um clone git do DG Claw oficial (git clone https://github.com/DGatoM/DG-Claw), aponte para ele com --repo e rode de novo: sudo dgclaw atualizar --simular, depois o parecer e o --ok-do-dono. Nada foi mudado (parei antes do backup)."
    fi
    arq="$(atualizar_parecer_arquivo)"
    if [ ! -f "$arq" ]; then
        atualizar_registrar bloqueio "alvo=${alvo:0:12} motivo=sem-parecer"
        falha "falta o parecer sobre a versao ${alvo:0:10} (nao existe $arq). Nunca se atualiza as cegas." \
              "rode o relatorio (sudo dgclaw atualizar --simular), leia o que muda e o que este DG Claw usa, diga ao dono se e segura e vale a pena, e grave o veredito: sudo dgclaw atualizar --parecer segura --commit <commit do DESTINO> --motivo \"<texto curto>\" (ou arriscada). Depois repita com --ok-do-dono. Nada foi mudado (parei antes do backup)."
    fi
    if ! lido="$(jq -r '[(.commit_alvo // ""), (.veredito // ""), (.motivo // ""), (.data // ""), (.personalizacoes // "-"), (.modo // "-"), (.commit_instalado // "-")] | @tsv' "$arq" 2>&1)"; then
        falha "nao consegui ler o parecer em $arq ($(printf '%s' "$lido" | head -n 1 | tr -d '\000-\037\177' | cut -c1-120))." \
              "grave o parecer de novo: sudo dgclaw atualizar --parecer segura --commit <commit do DESTINO> --motivo \"<texto curto>\". Nada foi mudado."
    fi
    IFS=$'\t' read -r commit veredito motivo data pers modo inst_parecer <<<"$lido"
    motivo="$(printf '%s' "$motivo" | tr -d '\000-\037\177' | cut -c1-300)"
    if [ "$commit" != "$alvo" ]; then
        atualizar_registrar bloqueio "alvo=${alvo:0:12} motivo=parecer-de-outro-commit(${commit:0:12})"
        falha "o parecer gravado e sobre outra versao (${commit:0:10}); a versao a instalar agora e ${alvo:0:10}." \
              "refaca a analise desta versao (sudo dgclaw atualizar --simular), diga ao dono e grave o parecer novo: sudo dgclaw atualizar --parecer segura|arriscada --motivo \"<texto curto>\". Nada foi mudado (parei antes do backup)."
    fi
    # O parecer foi dado para sair de uma versao instalada para o destino. Se a instalacao andou (voltou, foi atualizada
    # a mao), o que foi analisado nao e mais o que vai acontecer.
    if [ "$inst_parecer" != "${ATU_COMMIT_ANTIGO:-}" ]; then
        atualizar_registrar bloqueio "alvo=${alvo:0:12} motivo=instalado-mudou(${inst_parecer:0:12}->${ATU_COMMIT_ANTIGO:0:12})"
        falha "o parecer foi dado para quem estava na versao ${inst_parecer:0:10}, mas a versao instalada agora e ${ATU_COMMIT_ANTIGO:0:10} (destino ${alvo:0:10})." \
              "a instalacao mudou depois da analise. Rode 'sudo dgclaw atualizar --simular', leia o relatorio novo e grave o parecer de novo (--parecer segura|arriscada --commit <commit do DESTINO>). Nada foi mudado (parei antes do backup)."
    fi
    if [ "$pers" != "${ATU_PERS_HEAD:-nenhuma}" ] || [ "$modo" != "${ATU_MODO_INST:-oficial}" ]; then
        atualizar_registrar bloqueio "alvo=${alvo:0:12} motivo=personalizacoes-ou-modo-mudaram"
        falha "as personalizacoes mudaram depois do parecer (ou o modo de instalacao: parecer ${pers:0:10} / $modo, agora ${ATU_PERS_HEAD:0:10} / ${ATU_MODO_INST:-oficial})." \
              "rode --simular e de o parecer de novo: sudo dgclaw atualizar --simular, depois --parecer segura|arriscada --commit <commit do DESTINO> --motivo \"<texto curto>\". Nada foi mudado (parei antes do backup)."
    fi
    case "$veredito" in
        segura)
            ok "parecer 'segura' de ${data:-data desconhecida} para ${alvo:0:10}: $motivo"
            atualizar_registrar parecer-conferido "alvo=${alvo:0:12} veredito=segura" ;;
        arriscada)
            if [ "$ATU_APESAR" = 1 ]; then
                aviso "parecer ARRISCADA para ${alvo:0:10}: $motivo. Sigo porque o dono pediu para instalar apesar do alerta (--apesar-do-alerta)."
                atualizar_registrar apesar-do-alerta "alvo=${alvo:0:12} veredito=arriscada"
            else
                atualizar_registrar bloqueio "alvo=${alvo:0:12} motivo=parecer-arriscada"
                falha "o parecer sobre a versao ${alvo:0:10} e ARRISCADA, e a instalacao esta bloqueada. O alerta: $motivo" \
                      "conte o alerta ao dono em linguagem simples. So se ele, depois de ouvir, pedir explicitamente para instalar mesmo assim, rode: sudo dgclaw atualizar --ok-do-dono --apesar-do-alerta --segundo-plano. Nada foi mudado (parei antes do backup)."
            fi ;;
        *)
            falha "o parecer em $arq tem um veredito que eu nao conheco ('${veredito:0:20}')." "grave de novo: sudo dgclaw atualizar --parecer segura|arriscada --motivo \"<texto curto>\". Nada foi mudado." ;;
    esac
}

# --- o comando ------------------------------------------------------------------------------

atualizar_main() {
    local repo_arg="" voltar="" segundo_plano=0 sem_homes=0 mesmo_assim=0 a
    ATU_FORCAR_LOCAL=0; ATU_SEM_BAIXAR=0; ATU_MODO=atualizar; ATU_SEM_VOLTAR=0; ATU_OK_DONO=0; ATU_SEM_PERS=0
    ATU_PARECER=""; ATU_MOTIVO=""; ATU_COMMIT_PARECER=""; ATU_APESAR=0; local simular_pedido=0
    local repassar=("$@")
    while [ $# -gt 0 ]; do
        a="$1"
        case "$a" in
            --simular) ENSAIO=1; simular_pedido=1 ;;
            --parecer) [ $# -ge 2 ] || falha "a opcao --parecer precisa de segura ou arriscada." "exemplo: sudo dgclaw atualizar --parecer segura --commit <commit do DESTINO> --motivo \"so muda texto de ajuda\""
                       ATU_PARECER="$2"; ATU_MODO=parecer; shift ;;
            --parecer=*) ATU_PARECER="${a#*=}"; ATU_MODO=parecer ;;
            --motivo) [ $# -ge 2 ] || falha "a opcao --motivo precisa de um texto curto." "exemplo: sudo dgclaw atualizar --parecer segura --commit <commit do DESTINO> --motivo \"so muda texto de ajuda\""
                      ATU_MOTIVO="$2"; shift ;;
            --motivo=*) ATU_MOTIVO="${a#*=}" ;;
            --commit) [ $# -ge 2 ] || falha "a opcao --commit precisa do commit de destino (40 caracteres hexadecimais)." "ele esta na linha DESTINO= do relatorio de 'sudo dgclaw atualizar --simular'"
                      ATU_COMMIT_PARECER="$2"; shift ;;
            --commit=*) ATU_COMMIT_PARECER="${a#*=}" ;;
            --apesar-do-alerta) ATU_APESAR=1 ;;
            --repo) [ $# -ge 2 ] || falha "a opcao --repo precisa de um valor." "exemplo: sudo dgclaw atualizar --repo /root/DG-Claw"; repo_arg="$2"; shift ;;
            --repo=*) repo_arg="${a#*=}" ;;
            --forcar-local) ATU_FORCAR_LOCAL=1 ;;
            --sem-baixar) ATU_SEM_BAIXAR=1 ;;
            --sem-backup-agentes) sem_homes=1 ;;
            --segundo-plano) segundo_plano=1 ;;
            --ok-do-dono) export ATU_OK_DONO=1 ;;
            --sem-personalizacoes) export ATU_SEM_PERS=1 ;;
            --mesmo-assim) mesmo_assim=1 ;;
            --sem-voltar-sozinho) ATU_SEM_VOLTAR=1 ;;
            --voltar) [ $# -ge 2 ] || falha "a opcao --voltar precisa da pasta do backup." "exemplo: sudo dgclaw atualizar --voltar /var/backups/dgclaw/20261018-093000"; voltar="$2"; ATU_MODO=voltar; shift ;;
            --voltar=*) voltar="${a#*=}"; ATU_MODO=voltar ;;
            *) falha "a opcao '$a' nao existe em 'atualizar'." "veja as opcoes com: dgclaw --ajuda" ;;
        esac
        shift
    done

    atualizar_validar_parecer_pedido "$simular_pedido" "$segundo_plano" "$voltar"
    [ "$ATU_MODO" != parecer ] || ENSAIO=1   # ler o que muda nao pode mudar nada; so o parecer em si e gravado
    exigir_ferramentas git jq tar sha256sum podman curl rsync
    carregar_env_dgclaw
    if [ ! -f "$DG_ETC/dgclaw.env" ]; then
        falha "o DG Claw nao parece instalado aqui: falta $DG_ETC/dgclaw.env." "instale primeiro: sudo ./install.sh --usuario <nome>"
    fi

    if [ "$segundo_plano" = 1 ]; then
        [ "$ENSAIO" != 1 ] || falha "--segundo-plano nao combina com --simular." "rode a simulacao direto: sudo dgclaw atualizar --simular"
        atualizar_segundo_plano "${repassar[@]}"
        return 0
    fi

    trap _atualizar_ao_sair EXIT
    if [ "$ATU_MODO" = parecer ]; then printf 'PARECER: leio o que a versao nova muda e registro o seu veredito; nada sera instalado.\n'
    elif [ "$ENSAIO" = 1 ]; then printf 'SIMULACAO: nada sera mudado; so mostro o que seria feito.\n'; fi

    ATU_ETAPA="conferindo o clone"
    passo "Achando o clone do DG Claw e conferindo que esta limpo"
    atualizar_achar_repo "$repo_arg"
    atualizar_checar_clone

    if [ -n "$voltar" ]; then atualizar_voltar "$voltar" "$sem_homes" "$mesmo_assim"; return 0; fi
    personalizacoes_conferir

    local versao_antiga commit_novo versao_nova resumo_arq log_arq reinicia=0 resultado resumo_txt
    versao_antiga="${DGCLAW_VERSAO:-desconhecida}"
    atualizar_descobrir_commit_antigo
    atualizar_o_que_muda
    if [ "$ATU_MODO" = parecer ]; then atualizar_gravar_parecer; trap - EXIT; return 0; fi

    ATU_ETAPA="conferindo o espaco em disco"
    atualizar_checar_disco "$sem_homes"

    ATU_ETAPA="fazendo o backup"
    passo "Fazendo o backup antes de mexer em qualquer coisa"
    ATU_BACKUP="$(atualizar_pasta_backup)"
    atualizar_backup "$ATU_BACKUP" atualizar "$sem_homes"
    atualizar_preparar_volta_sozinha

    ATU_ETAPA="baixando a versao nova"
    passo "Baixando a versao nova"
    atualizar_baixar

    atualizar_aplicar
    if [ "$ATU_INSTALL_FALHOU" = 1 ]; then
        atualizar_voltar_sozinho "o instalador (install.sh) da versao nova terminou com erro; a causa esta nas linhas acima" "$sem_homes"
        return 1
    fi

    ATU_ETAPA="conferindo o resultado"
    passo "Conferindo que nada do que existia antes sumiu ou mudou"
    atualizar_conferir "$ATU_BACKUP"
    if [ "$ATU_PROBLEMAS" -gt 0 ] && [ "$ATU_VOLTAR_SOZINHO" = 1 ]; then
        atualizar_voltar_sozinho "a conferencia de configuracao achou $ATU_PROBLEMAS coisa(s) que existia(m) antes e sumiu/mudou (linhas FALHOU acima; os valores nunca sao mostrados)" "$sem_homes"
        return 1
    fi
    atualizar_checar_vida

    ATU_ETAPA="agendando o reinicio do Admin"
    carregar_env_dgclaw
    versao_nova="${DGCLAW_VERSAO:-desconhecida}"
    commit_novo="$(_git rev-parse HEAD 2>/dev/null || true)"
    log_arq="${DGCLAW_ATUALIZAR_LOG:-$DG_LOG/dgclaw-atualizar-$(date +%Y%m%d-%H%M%S).log}"
    resumo_arq="${log_arq%.log}.resumo.txt"
    if [ "$ATU_PROBLEMAS" -eq 0 ] && [ -z "${ATU_AGENTES_FALHOS// /}" ]; then reinicia=1; fi
    if [ "$reinicia" = 1 ]; then
        resultado="Atualizacao concluida."
    elif [ -n "${ATU_AGENTES_FALHOS// /}" ]; then
        resultado="Atualizacao INCOMPLETA: agente(s) com problema (veja as linhas FALHOU acima)."
    else
        resultado="Atualizacao INCOMPLETA: $ATU_PROBLEMAS problema(s) na conferencia (veja as linhas FALHOU acima)."
    fi
    resumo_txt="$(atualizar_montar_resumo "$resultado" "$versao_antiga" "$versao_nova" "$commit_novo" "$reinicia")"
    if [ "$ENSAIO" != 1 ]; then
        # O resumo vai para um arquivo ANTES de agendar o reinicio: e ele que o Admin le quando voltar.
        ( umask 027; mkdir -p "$DG_LOG"; { printf '%s\n' "$resumo_txt"; printf '  Log completo: %s\n' "$log_arq"; } >"$resumo_arq" ) \
            || falha "nao consegui gravar o resumo em $resumo_arq." "confira o espaco e a permissao de $DG_LOG; a atualizacao em si ja terminou."
    fi

    passo "Reiniciando o Admin (por ultimo)"
    if [ "$reinicia" = 1 ]; then
        atualizar_agendar_reinicio_do_admin "$resumo_arq" "$log_arq"
    elif [ -n "${ATU_AGENTES_FALHOS// /}" ]; then
        aviso "NAO vou reiniciar o Admin: o(s) agente(s)${ATU_AGENTES_FALHOS} nao ficou(aram) bem, e o Admin precisa continuar de pe, com o chat funcionando, para consertar. Tambem NAO desfiz a atualizacao: agente que nao sobe costuma ser problema do container dele, nao da versao, e voltar repetiria a falha. Refaca cada um com: dgclaw agente recriar <slug> --forcar"
    else
        aviso "houve $ATU_PROBLEMAS problema(s) na conferencia; deixo o Admin como esta, para voce nao perder o chat enquanto resolve."
    fi

    trap - EXIT
    printf '\n'
    if [ "$ENSAIO" = 1 ]; then
        printf 'Simulacao terminada: nada foi mudado. Para atualizar de verdade: sudo dgclaw atualizar\n'
        return 0
    fi
    if [ "$reinicia" != 1 ]; then
        depois_de_atualizar incompleta
        printf '%s\n  Resumo gravado em: %s\n' "$resumo_txt" "$resumo_arq" >&2
        return 1
    fi
    depois_de_atualizar concluida
    printf '%s\n  Resumo gravado em: %s\n' "$resumo_txt" "$resumo_arq"
}

# atualizar_preparar_volta_sozinha: decide se esta atualizacao pode se desfazer sozinha. Precisa do
# commit de antes no clone, que e para onde o --voltar leva. Sem ele, o comando para como sempre
# e diz como voltar a mao.
atualizar_preparar_volta_sozinha() {
    ATU_VOLTAR_SOZINHO=0
    if [ "$ATU_SEM_VOLTAR" = 1 ]; then
        info "--sem-voltar-sozinho: se o instalador ou a conferencia falharem, eu paro e deixo como esta (voce volta com --voltar)."
        return 0
    fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] se o instalador novo ou a conferencia de configuracao falharem, a atualizacao voltaria sozinha ao backup (agente que nao sobe NAO faz voltar)"
        return 0
    fi
    if ! [[ "$ATU_COMMIT_ANTIGO" =~ ^[0-9a-f]{40}$ ]] || ! _git cat-file -e "${ATU_COMMIT_ANTIGO}^{commit}" 2>/dev/null; then
        aviso "nao tenho o commit de antes neste clone, entao se algo falhar NAO consigo voltar sozinho; eu paro e digo como voltar a mao."
        return 0
    fi
    ATU_VOLTAR_SOZINHO=1
    ok "se o instalador novo ou a conferencia de configuracao falharem, volto sozinho ao backup (agente que nao sobe NAO faz voltar)"
}

# atualizar_voltar_sozinho <o que deu errado> <sem-homes>: o rollback automatico. Reaproveita o
# --voltar inteiro (backup do estado de agora, clone no commit de antes, configuracao e Admin
# restaurados, instalador, imagem, agentes, conferencia e reinicio desacoplado do Admin). Nunca
# reinicia o Admin no meio. Quem chama devolve 1: a atualizacao em si nao deu certo.
atualizar_voltar_sozinho() {
    local motivo="$1" sem_homes="$2" backup_orig="$ATU_BACKUP"
    ATU_ROLLBACK_TEXTO="A atualizacao NAO deu certo e foi desfeita sozinha. O que deu errado: $motivo. O que foi desfeito: a configuracao, o Admin e o codigo voltaram ao que eram antes (backup $backup_orig); os dados e as casas dos agentes nao foram tocados."
    printf '\n%s\n' "$ATU_ROLLBACK_TEXTO" >&2
    printf 'Vou voltar agora ao backup %s (isso leva alguns minutos).\n' "$backup_orig" >&2
    ATU_MODO=voltar
    ATU_VOLTAR_SOZINHO=0
    atualizar_voltar "$backup_orig" "$sem_homes" 0
    {
        printf '\nO que aconteceu: %s.\n' "$motivo"
        printf 'O DG Claw esta de volta na versao de antes. O backup que usei esta em %s.\n' "$backup_orig"
        printf 'O que fazer agora: leia as linhas FALHOU acima para saber a causa; quando ela estiver resolvida, rode de novo: sudo dgclaw atualizar.\n'
        printf 'Se quiser investigar com a versao nova instalada, rode: sudo dgclaw atualizar --sem-voltar-sozinho (ele para no erro e nao desfaz).\n'
        printf 'Se algum agente nao estiver bem depois disto, o conserto e: sudo dgclaw agente recriar <slug> --forcar.\n'
    } >&2
    depois_de_atualizar voltou-sozinho
}

# atualizar_checar_disco <sem-homes>: o backup mais a imagem nova precisam caber.
atualizar_checar_disco() {
    local sem_homes="$1" kb=0 p livre minimo reserva_mb="${DGCLAW_ATUALIZAR_LIVRE_MIN_MB:-6144}"
    for p in "$DG_ETC" "$DG_ADMIN" "$DG_LIB"; do
        [ -d "$p" ] || continue
        kb=$((kb + $(du -sk "$p" | cut -f1)))
    done
    if [ "$sem_homes" = 1 ] && [ -d "$DG_CASAS" ]; then
        for p in "$DG_CASAS"/*/home; do
            [ -d "$p" ] || continue
            kb=$((kb - $(du -sk "$p" | cut -f1)))
        done
    fi
    [ "$kb" -ge 0 ] || kb=0
    info "o backup vai ocupar ate $(_tamanho_humano "$kb") em $DG_BACKUPS (compactado costuma ser bem menos)"
    if [ "$sem_homes" = 1 ]; then aviso "--sem-backup-agentes: as casas dos agentes (memoria e conversas) NAO entram no backup."; fi
    # Mede o disco onde o backup vai ficar; se a pasta ainda nao existe, mede a mais proxima que existe.
    p="$DG_BACKUPS"
    while [ ! -d "$p" ] && [ "$p" != / ]; do p="$(dirname "$p")"; done
    livre="$(df -Pk "$p" 2>/dev/null | awk 'NR==2 {print $4}')" || livre=""
    [ -n "$livre" ] || { aviso "nao consegui medir o espaco livre em $DG_BACKUPS; sigo sem essa checagem."; return 0; }
    minimo=$((kb + reserva_mb * 1024))
    if [ "$livre" -lt "$minimo" ]; then
        falha "o disco tem $(_tamanho_humano "$livre") livres e eu preciso de uns $(_tamanho_humano "$minimo") (backup de $(_tamanho_humano "$kb") mais $reserva_mb MB para a imagem nova). Nada foi mudado." \
              "libere espaco (veja o que pesa: du -sh /var/lib/containers /var/lib/dgclaw /var/backups/dgclaw; imagens velhas: podman image prune) ou apague backups antigos de /var/backups/dgclaw que voce ja nao quer, e rode de novo."
    fi
    ok "espaco em disco suficiente ($(_tamanho_humano "$livre") livres)"
}

# atualizar_baixar: git fetch + pull --ff-only (ou nada, com --sem-baixar).
atualizar_baixar() {
    if [ "${PERS_ATIVO:-0}" = 1 ]; then personalizacoes_baixar; return 0; fi
    if [ "$ATU_SEM_BAIXAR" = 1 ]; then
        info "--sem-baixar: uso o clone como esta (commit $(_git rev-parse --short HEAD 2>/dev/null || printf 'desconhecido'))."
        return 0
    fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] rodaria: git fetch  e depois  git pull --ff-only  em $ATU_REPO"
        return 0
    fi
    local antes depois novos ramo alvo
    ramo="$(_git rev-parse --abbrev-ref HEAD)"
    [ "$ramo" != HEAD ] || falha "o clone $ATU_REPO esta com a cabeca solta (sem branch), e nao ha de onde puxar a versao nova." \
        "volte para a branch principal: cd $ATU_REPO && git switch main (ou rode com --sem-baixar se atualizou os arquivos a mao). O backup ja foi feito."
    _git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 \
        || falha "a branch '$ramo' do clone nao acompanha nenhuma branch remota." \
                 "diga qual: cd $ATU_REPO && git branch --set-upstream-to=origin/$ramo $ramo (ou use --sem-baixar). O backup ja foi feito; nada mais foi mudado."
    antes="$(_git rev-parse HEAD)"
    _git fetch >/dev/null 2>&1 \
        || falha "o 'git fetch' falhou em $ATU_REPO (sem internet, ou o GitHub nao respondeu)." \
                 "confira a internet (curl -I https://github.com) e rode de novo. O backup ja foi feito; nada mais foi mudado."
    # Instala EXATAMENTE a versao que o relatorio "o que muda" mostrou ao dono (ATU_DESTINO), nao o que o GitHub tem agora.
    alvo="${ATU_DESTINO:-}"; [ -n "$alvo" ] || alvo='@{u}'
    novos="$(_git rev-list --count "HEAD..$alvo")"
    if ! _git merge --ff-only "$alvo" >/dev/null 2>&1; then
        falha "o clone $ATU_REPO divergiu do GitHub (tem commits seus que nao estao la, ou o historico mudou), entao o 'git merge --ff-only' recusou. Nao fiz merge nem reset." \
              "veja a diferenca: cd $ATU_REPO && git log --oneline --graph --all -20. Guarde seus commits em outra branch (git branch minha-copia) e deixe o clone igual ao GitHub, ou peca ajuda. Depois rode de novo. O backup ja foi feito; nada mais foi mudado."
    fi
    depois="$(_git rev-parse HEAD)"
    if [ "$antes" = "$depois" ]; then ok "o clone ja estava na versao mais nova do GitHub (nenhum commit novo)"
    else ok "baixei $novos commit(s) novo(s): ${antes:0:10} -> ${depois:0:10}"; fi
}

# atualizar_segundo_plano <mesmos argumentos>: roda a atualizacao como unidade do systemd, solta
# do terminal (e do chat do Admin, que tem tempo limite). O log fica em /var/log/dgclaw/.
atualizar_segundo_plano() {
    local unidade log args=() a
    unidade="dgclaw-atualizar-$(date +%Y%m%d-%H%M%S)"
    log="$DG_LOG/$unidade.log"
    for a in "$@"; do
        if [ "$a" != --segundo-plano ]; then args+=("$a"); fi
    done
    ( umask 027; mkdir -p "$DG_LOG" )
    systemd-run --unit="$unidade" --collect \
        --property="StandardOutput=append:$log" --property="StandardError=append:$log" \
        --setenv="PATH=$PATH" --setenv="NO_COLOR=1" --setenv="DGCLAW_ATUALIZAR_LOG=$log" ${R:+--setenv="DGCLAW_RAIZ=$R"} \
        "$DGCLAW_BIN_REAL" atualizar "${args[@]}" >/dev/null \
        || falha "o systemd-run nao conseguiu iniciar a atualizacao em segundo plano (unidade $unidade)." \
                 "rode direto no terminal, sem --segundo-plano: sudo dgclaw atualizar"
    printf 'A atualizacao esta rodando em segundo plano (unidade %s).\n' "$unidade"
    printf '  Acompanhar:  tail -f %s\n' "$log"
    printf '  Terminou?    systemctl is-active %s   (inactive = acabou; o fim do log diz se deu certo)\n' "$unidade"
    printf '  Ela leva de 10 a 30 minutos por causa da imagem dos agentes. O Admin reinicia sozinho no fim.\n'
}

# atualizar_voltar <backup> <sem-homes> <mesmo-assim>
atualizar_voltar() {
    local b="$1" sem_homes="$2" mesmo_assim="$3" commit_alvo ramo_novo extras="" backup_agora log_arq resumo_arq
    ATU_ETAPA="conferindo o backup a restaurar"
    b="$(backup_conferir_pasta "$b")"
    commit_alvo="$(_env_de "$b/MANIFESTO.txt" commit)"
    [[ "$commit_alvo" =~ ^[0-9a-f]{40}$ ]] \
        || falha "o MANIFESTO.txt de $b nao tem um commit valido (commit='$commit_alvo'), entao nao sei para qual versao voltar." \
                 "se o backup foi feito sem git, volte o codigo na mao e rode so a parte de configuracao: tar -xzf $b/config.tar.gz -C /"
    _git cat-file -e "${commit_alvo}^{commit}" 2>/dev/null \
        || falha "o commit ${commit_alvo:0:10} do backup nao existe neste clone ($ATU_REPO)." \
                 "baixe o historico completo (cd $ATU_REPO && git fetch --all) e rode de novo."

    # Agentes criados depois do backup: voltar o agentes.json os tiraria do painel.
    extras="$(backup_agentes_novos "$b/MANIFESTO.txt")"
    if [ -n "$extras" ] && [ "$mesmo_assim" != 1 ]; then
        falha "estes agentes foram criados DEPOIS desse backup:$extras. Restaurar o agentes.json do backup os tiraria do painel (as pastas deles ficam, mas eles somem da lista)." \
              "se quer voltar mesmo assim: sudo dgclaw atualizar --voltar $b --mesmo-assim. Se nao, escolha um backup mais recente: ls $DG_BACKUPS"
    fi

    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] faria um backup do estado de agora; criaria a branch dgclaw-volta-<data> no commit ${commit_alvo:0:10} em $ATU_REPO"
        info "[ensaio] restauraria $b/config.tar.gz (etc/dgclaw) e $b/admin.tar.gz (opt/dgclaw/admin) por cima do que esta aqui, sem apagar arquivos novos"
    else
        ATU_ETAPA="fazendo o backup do estado de agora"
        passo "Fazendo um backup do estado de agora (para poder desfazer o desfazer)"
        backup_agora="$(atualizar_pasta_backup)"
        ATU_BACKUP="$backup_agora"
        atualizar_backup "$backup_agora" antes-de-voltar "$sem_homes"

        ATU_ETAPA="voltando o clone ao commit do backup"
        passo "Voltando o clone para o commit ${commit_alvo:0:10}"
        ramo_novo="dgclaw-volta-$(date +%Y%m%d-%H%M%S)"
        _git checkout -b "$ramo_novo" "$commit_alvo" >/dev/null 2>&1 \
            || falha "o 'git checkout -b $ramo_novo $commit_alvo' falhou em $ATU_REPO." \
                     "veja a mensagem do git: cd $ATU_REPO && git checkout -b $ramo_novo $commit_alvo. Nada foi restaurado ainda; o backup de agora esta em $backup_agora."
        ok "clone na branch $ramo_novo (a branch de antes continua la; para voltar a ela: git switch <nome>)"

        ATU_ETAPA="restaurando a configuracao e o Admin"
        passo "Restaurando /etc/dgclaw e a pasta do Admin do backup"
        # Por cima, sem apagar nada que seja mais novo; nao toca em /var/lib/dgclaw nem nas conversas do Admin.
        tar -xzf "$b/config.tar.gz" -C "${R:-/}" --numeric-owner \
            || falha "nao consegui restaurar $b/config.tar.gz." "o backup de agora esta em $backup_agora; veja a mensagem do tar acima."
        if [ -f "$b/admin.tar.gz" ]; then
            tar -xzf "$b/admin.tar.gz" -C "${R:-/}" --numeric-owner \
                || falha "nao consegui restaurar $b/admin.tar.gz." "o backup de agora esta em $backup_agora; veja a mensagem do tar acima."
        fi
        ok "configuracao e Admin restaurados do backup (as casas dos agentes nao foram tocadas)"
    fi

    carregar_env_dgclaw
    atualizar_aplicar

    ATU_ETAPA="conferindo o resultado"
    passo "Conferindo o resultado"
    if [ "$ENSAIO" != 1 ]; then atualizar_conferir "$b"; fi
    atualizar_checar_vida
    ATU_ETAPA="agendando o reinicio do Admin"
    passo "Reiniciando o Admin (por ultimo)"
    if [ "$ATU_PROBLEMAS" -gt 0 ]; then
        aviso "houve $ATU_PROBLEMAS problema(s) na conferencia; deixo o Admin como esta (ele precisa continuar de pe para consertar)."
    else
        log_arq="${DGCLAW_ATUALIZAR_LOG:-$DG_LOG/dgclaw-voltar-$(date +%Y%m%d-%H%M%S).log}"
        resumo_arq="${log_arq%.log}.resumo.txt"
        if [ "$ENSAIO" != 1 ]; then
            ( umask 027; mkdir -p "$DG_LOG"
              printf '%sVoltei para a versao de %s (commit %s).\n  Clone na branch: %s\n  Backup do estado de antes de voltar: %s\n  Todos os agentes ficaram bem.\n  Log completo: %s\n' \
                  "${ATU_ROLLBACK_TEXTO:+$ATU_ROLLBACK_TEXTO$'\n'}" "$(_env_de "$b/MANIFESTO.txt" criado_em)" "${commit_alvo:0:10}" "$ramo_novo" "$backup_agora" "$log_arq" >"$resumo_arq" ) \
                || falha "nao consegui gravar o resumo em $resumo_arq." "confira o espaco e a permissao de $DG_LOG; a volta em si ja terminou."
        fi
        atualizar_agendar_reinicio_do_admin "$resumo_arq" "$log_arq"
    fi
    printf '\n'
    trap - EXIT
    if [ "$ENSAIO" = 1 ]; then printf 'Simulacao terminada: nada foi mudado.\n'; return 0; fi
    if [ "$ATU_PROBLEMAS" -gt 0 ]; then
        printf 'Voltei, mas com %s problema(s) (linhas FALHOU acima). O backup do estado anterior ao --voltar esta em %s.\n' "$ATU_PROBLEMAS" "$backup_agora" >&2
        exit 1
    fi
    printf 'Voltei para a versao de %s (commit %s).\n' "$(_env_de "$b/MANIFESTO.txt" criado_em)" "${commit_alvo:0:10}"
    printf '  Clone na branch: %s\n  Backup do estado de antes de voltar: %s\n' "$ramo_novo" "$backup_agora"
    printf '  O Admin reinicia em alguns segundos.\n'
}
