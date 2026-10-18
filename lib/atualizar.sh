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

DG_BACKUPS="$R/var/backups/dgclaw"

ATU_REPO=""
ATU_ETAPA=""
ATU_BACKUP=""
ATU_PROBLEMAS=0
ATU_AGENTES_FALHOS=""   # slugs que nao foram recriados ou nao responderam no fim (separados por espaco)
ATU_COMMIT_ANTIGO=""    # o commit que estava INSTALADO antes desta atualizacao (nao o HEAD do clone)
ATU_COMMIT_ORIGEM=""

# _git <argumentos>: git no clone da atualizacao.
_git() { git_do_clone "$ATU_REPO" "$@"; }

# _env_de <arquivo> <CHAVE>: valor de uma linha CHAVE=valor, sem executar o arquivo.
_env_de() {
    [ -f "$1" ] || return 0
    sed -n "s/^$2=//p;T;q" "$1"
}

# _rel <caminho absoluto>: o caminho sem o prefixo da raiz falsa e sem a barra inicial.
_rel() { local p="${1#"$R"}"; printf '%s' "${p#/}"; }

# _sha <arquivo>: so o hash.
_sha() { sha256sum <"$1" | cut -d' ' -f1; }

# _tamanho_humano <kb>
_tamanho_humano() {
    awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GB", k / 1048576; else if (k >= 1024) printf "%.0f MB", k / 1024; else printf "%d KB", k }'
}

_atu_problema() { ATU_PROBLEMAS=$((ATU_PROBLEMAS + 1)); printf '   FALHOU  %s\n' "$1" >&2; }

# Se a atualizacao parar no meio, a pessoa precisa saber onde parou, que os dados estao salvos
# e como seguir ou voltar.
_atualizar_ao_sair() {
    local rc=$?
    [ "$rc" -eq 0 ] && return 0
    {
        printf '\nA atualizacao parou em: %s.\n' "${ATU_ETAPA:-inicio}"
        if [ -n "$ATU_BACKUP" ] && [ -d "$ATU_BACKUP" ]; then
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

# _tar_backup <arquivo.tar.gz> <opcoes e caminhos do tar, relativos a raiz...>
# Cria o tar.gz relativo a raiz, aceita "arquivo mudou enquanto eu lia" (codigo 1: normal com
# agente ligado), recusa qualquer outro erro e confere que o resultado abre.
_tar_backup() {
    local alvo="$1"; shift
    local rc=0
    ( umask 077; tar --numeric-owner -C "${R:-/}" -czf "$alvo" "$@" ) || rc=$?
    case "$rc" in
        0) ;;
        1) aviso "alguns arquivos mudaram enquanto eu copiava para $(basename "$alvo") (normal com agentes ligados); a copia segue valida." ;;
        *) falha "o tar nao conseguiu criar $alvo (codigo $rc)." "veja se ha espaco em disco (df -h $DG_BACKUPS) e rode de novo; nada foi mudado." ;;
    esac
    tar -tzf "$alvo" >/dev/null 2>&1 \
        || falha "o backup $alvo foi criado, mas o tar nao consegue abri-lo (esta corrompido)." \
                 "nao sigo sem um backup que abre. Veja o espaco em disco (df -h) e rode de novo; nada foi mudado."
    chmod 600 "$alvo"
}

# atualizar_backup <pasta destino> <motivo> <sem-homes 0|1>
atualizar_backup() {
    local dest="$1" motivo="$2" sem_homes="$3" casa agentes="" f
    local caminhos=() transc=()
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] criaria o backup em $dest com: etc/dgclaw, var/lib/dgclaw$([ "$sem_homes" = 1 ] && printf ' (sem as casas dos agentes)'), opt/dgclaw/admin, transcricoes do Admin e o MANIFESTO.txt"
        return 0
    fi
    ( umask 077; mkdir -p "$dest" )
    chmod 700 "$DG_BACKUPS" "$dest"

    # config.tar.gz: /etc/dgclaw inteiro (chaves, hash da senha, agentes.json, tokens).
    [ -d "$DG_ETC" ] || falha "nao existe $DG_ETC; o DG Claw nao parece instalado." "instale primeiro: sudo ./install.sh --usuario <nome>"
    _tar_backup "$dest/config.tar.gz" "$(_rel "$DG_ETC")"

    # admin.tar.gz: a pasta do Admin (CLAUDE.md, AGENTS.md, uploads, skills).
    if [ -d "$DG_ADMIN" ]; then _tar_backup "$dest/admin.tar.gz" "$(_rel "$DG_ADMIN")"; fi

    # transcricoes-admin.tar.gz: a conversa do Admin (Claude ou Codex).
    for f in "$R/root/.claude/projects/-opt-dgclaw-admin" "$R/root/.codex/sessions"; do
        if [ -d "$f" ]; then transc+=("$(_rel "$f")"); fi
    done
    if [ "${#transc[@]}" -gt 0 ]; then _tar_backup "$dest/transcricoes-admin.tar.gz" "${transc[@]}"; fi

    # dados.tar.gz: /var/lib/dgclaw (casas dos agentes, cofres, web). O pesado.
    if [ -d "$DG_LIB" ]; then
        caminhos=("$(_rel "$DG_LIB")")
        if [ "$sem_homes" = 1 ]; then
            _tar_backup "$dest/dados.tar.gz" "--exclude=$(_rel "$DG_LIB")/agentes/*/home" "${caminhos[@]}"
        else
            _tar_backup "$dest/dados.tar.gz" "${caminhos[@]}"
        fi
    fi

    while IFS= read -r casa; do agentes+="${agentes:+,}$casa"; done \
        < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')

    {
        printf 'MANIFESTO do backup do DG Claw\n'
        printf 'criado_em=%s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"
        printf 'motivo=%s\n' "$motivo"
        printf 'repo=%s\n' "$ATU_REPO"
        printf 'commit=%s\n' "${ATU_COMMIT_ANTIGO:-$(_git rev-parse HEAD 2>/dev/null || true)}"
        printf 'ramo=%s\n' "$(_git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
        printf 'versao=%s\n' "${DGCLAW_VERSAO:-desconhecida}"
        printf 'commit_instalado=%s\n' "$(_env_de "$DG_ETC/dgclaw.env" DGCLAW_COMMIT)"
        printf 'imagem=%s\n' "${DGCLAW_IMAGEM:-}"
        printf 'agentes=%s\n' "$agentes"
        printf 'casas_dos_agentes_no_backup=%s\n' "$([ "$sem_homes" = 1 ] && printf nao || printf sim)"
        printf '\n[sha256]\n'
        atualizar_hashes_do_manifesto
    } >"$dest/MANIFESTO.txt"
    chmod 600 "$dest/MANIFESTO.txt"
    ok "backup conferido em $dest ($(du -sh "$dest" | cut -f1))"
    info "ele guarda as chaves e o hash da senha: so o root le (pasta 700). Para voltar: sudo dgclaw atualizar --voltar $dest"
}

# atualizar_hashes_do_manifesto: "<sha256>  <caminho relativo>" de tudo o que a conferencia
# final compara. Arquivos de configuracao, do Admin, cofres e os .md de identidade e memoria.
atualizar_hashes_do_manifesto() {
    local f casa
    {
        if [ -d "$DG_ETC" ]; then find "$DG_ETC" -type f ! -name '.agentes.lock'; fi
        for f in "$DG_ADMIN/CLAUDE.md" "$DG_ADMIN/AGENTS.md" "$DG_LIB/web/sessoes.json"; do
            if [ -f "$f" ]; then printf '%s\n' "$f"; fi
        done
        for casa in "$DG_CASAS"/*/; do
            [ -d "$casa" ] || continue
            casa="${casa%/}"
            for f in "$casa/cofre/cofre.env" "$casa/home/.plataforma/identidade.md" "$casa/home/.dgclaw/self-crons.json"; do
                if [ -f "$f" ]; then printf '%s\n' "$f"; fi
            done
            if [ -d "$casa/home" ]; then find "$casa/home" -maxdepth 1 -type f -name '*.md'; fi
            if [ -d "$casa/home/memory" ]; then find "$casa/home/memory" -maxdepth 1 -type f -name '*.md'; fi
        done
    } | sort -u | while IFS= read -r f; do
        printf '%s  %s\n' "$(_sha "$f")" "$(_rel "$f")"
    done
}

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
    atualizar_rodar_install
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

# --- o comando ------------------------------------------------------------------------------

atualizar_main() {
    local repo_arg="" voltar="" segundo_plano=0 sem_homes=0 mesmo_assim=0 a
    ATU_FORCAR_LOCAL=0; ATU_SEM_BAIXAR=0; ATU_MODO=atualizar
    local repassar=("$@")
    while [ $# -gt 0 ]; do
        a="$1"
        case "$a" in
            --simular) ENSAIO=1 ;;
            --repo) [ $# -ge 2 ] || falha "a opcao --repo precisa de um valor." "exemplo: sudo dgclaw atualizar --repo /root/DG-Claw"; repo_arg="$2"; shift ;;
            --repo=*) repo_arg="${a#*=}" ;;
            --forcar-local) ATU_FORCAR_LOCAL=1 ;;
            --sem-baixar) ATU_SEM_BAIXAR=1 ;;
            --sem-backup-agentes) sem_homes=1 ;;
            --segundo-plano) segundo_plano=1 ;;
            --mesmo-assim) mesmo_assim=1 ;;
            --voltar) [ $# -ge 2 ] || falha "a opcao --voltar precisa da pasta do backup." "exemplo: sudo dgclaw atualizar --voltar /var/backups/dgclaw/20261018-093000"; voltar="$2"; ATU_MODO=voltar; shift ;;
            --voltar=*) voltar="${a#*=}"; ATU_MODO=voltar ;;
            *) falha "a opcao '$a' nao existe em 'atualizar'." "veja as opcoes com: dgclaw --ajuda" ;;
        esac
        shift
    done

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
    if [ "$ENSAIO" = 1 ]; then printf 'SIMULACAO: nada sera mudado; so mostro o que seria feito.\n'; fi

    ATU_ETAPA="conferindo o clone"
    passo "Achando o clone do DG Claw e conferindo que esta limpo"
    atualizar_achar_repo "$repo_arg"
    atualizar_checar_clone

    if [ -n "$voltar" ]; then atualizar_voltar "$voltar" "$sem_homes" "$mesmo_assim"; return 0; fi

    local versao_antiga commit_novo versao_nova resumo_arq log_arq reinicia=0 resultado resumo_txt
    versao_antiga="${DGCLAW_VERSAO:-desconhecida}"
    atualizar_descobrir_commit_antigo

    ATU_ETAPA="conferindo o espaco em disco"
    atualizar_checar_disco "$sem_homes"

    ATU_ETAPA="fazendo o backup"
    passo "Fazendo o backup antes de mexer em qualquer coisa"
    ATU_BACKUP="$(atualizar_pasta_backup)"
    atualizar_backup "$ATU_BACKUP" atualizar "$sem_homes"

    ATU_ETAPA="baixando a versao nova"
    passo "Baixando a versao nova"
    atualizar_baixar

    atualizar_aplicar

    ATU_ETAPA="conferindo o resultado"
    passo "Conferindo que nada do que existia antes sumiu ou mudou"
    atualizar_conferir "$ATU_BACKUP"
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
        aviso "NAO vou reiniciar o Admin: o(s) agente(s)${ATU_AGENTES_FALHOS} nao ficou(aram) bem, e o Admin precisa continuar de pe, com o chat funcionando, para consertar."
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
        printf '%s\n  Resumo gravado em: %s\n' "$resumo_txt" "$resumo_arq" >&2
        return 1
    fi
    printf '%s\n  Resumo gravado em: %s\n' "$resumo_txt" "$resumo_arq"
}

# atualizar_pasta_backup: imprime a pasta nova (data e hora; ganha sufixo se ja existir).
atualizar_pasta_backup() {
    local base n=1 pasta
    base="$DG_BACKUPS/$(date +%Y%m%d-%H%M%S)"
    pasta="$base"
    while [ -e "$pasta" ]; do n=$((n + 1)); pasta="$base-$n"; done
    printf '%s' "$pasta"
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
    if [ "$ATU_SEM_BAIXAR" = 1 ]; then
        info "--sem-baixar: uso o clone como esta (commit $(_git rev-parse --short HEAD 2>/dev/null || printf 'desconhecido'))."
        return 0
    fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] rodaria: git fetch  e depois  git pull --ff-only  em $ATU_REPO"
        return 0
    fi
    local antes depois novos ramo
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
    novos="$(_git rev-list --count 'HEAD..@{u}')"
    if ! _git pull --ff-only >/dev/null 2>&1; then
        falha "o clone $ATU_REPO divergiu do GitHub (tem commits seus que nao estao la, ou o historico mudou), entao o 'git pull --ff-only' recusou. Nao fiz merge nem reset." \
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
    local b="$1" sem_homes="$2" mesmo_assim="$3" commit_alvo ramo_novo extras="" slug backup_agora log_arq resumo_arq
    ATU_ETAPA="conferindo o backup a restaurar"
    if [ ! -f "$b/MANIFESTO.txt" ] || [ ! -f "$b/config.tar.gz" ]; then
        falha "'$b' nao parece um backup do DG Claw (falta a pasta, o MANIFESTO.txt ou o config.tar.gz)." \
              "veja os backups que existem: ls $DG_BACKUPS"
    fi
    b="$(cd "$b" && pwd)"
    commit_alvo="$(_env_de "$b/MANIFESTO.txt" commit)"
    [[ "$commit_alvo" =~ ^[0-9a-f]{40}$ ]] \
        || falha "o MANIFESTO.txt de $b nao tem um commit valido (commit='$commit_alvo'), entao nao sei para qual versao voltar." \
                 "se o backup foi feito sem git, volte o codigo na mao e rode so a parte de configuracao: tar -xzf $b/config.tar.gz -C /"
    tar -tzf "$b/config.tar.gz" >/dev/null 2>&1 || falha "o $b/config.tar.gz nao abre." "esse backup esta corrompido; use outro de: ls $DG_BACKUPS"
    if [ -f "$b/admin.tar.gz" ]; then tar -tzf "$b/admin.tar.gz" >/dev/null 2>&1 || falha "o $b/admin.tar.gz nao abre." "esse backup esta corrompido; use outro de: ls $DG_BACKUPS"; fi
    _git cat-file -e "${commit_alvo}^{commit}" 2>/dev/null \
        || falha "o commit ${commit_alvo:0:10} do backup nao existe neste clone ($ATU_REPO)." \
                 "baixe o historico completo (cd $ATU_REPO && git fetch --all) e rode de novo."

    # Agentes criados depois do backup: voltar o agentes.json os tiraria do painel.
    while read -r slug; do
        [ -n "$slug" ] || continue
        if ! printf ',%s,' "$(_env_de "$b/MANIFESTO.txt" agentes)" | grep -qF ",$slug,"; then extras+=" $slug"; fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
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
              printf 'Voltei para a versao de %s (commit %s).\n  Clone na branch: %s\n  Backup do estado de antes de voltar: %s\n  Todos os agentes ficaram bem.\n  Log completo: %s\n' \
                  "$(_env_de "$b/MANIFESTO.txt" criado_em)" "${commit_alvo:0:10}" "$ramo_novo" "$backup_agora" "$log_arq" >"$resumo_arq" ) \
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
