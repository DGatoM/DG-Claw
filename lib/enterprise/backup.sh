#!/usr/bin/env bash
# lib/enterprise/backup.sh: backup cifrado FORA da VPS, com restic (protecao `backup`).
#
# Configuracao: /etc/dgclaw/backup.env (600): RESTIC_REPOSITORY, RESTIC_PASSWORD e as credenciais do
# bucket. O restic le tudo do AMBIENTE (o arquivo e carregado dentro de um subshell com `set -a`); nada
# disso passa por argv nem por log. Sem a RESTIC_PASSWORD nao existe restauracao: a empresa precisa
# guardar uma copia dela FORA da VPS.
#
# Estado em /var/lib/dgclaw/backup/:
#   ultimo-backup.json, ultimo-teste.json   {ok, quando, snapshot, erro}  (o monitoramento le estes dois)
#   manifesto.json                          sha256 da amostra de arquivos, gravado no momento do backup
#   staging/                                bancos .db consistentes e a amostra do manifesto (apagado no fim)
# Comandos: dgclaw backup configurar | agora | listar | testar | status   e   dgclaw restaurar.

_bk_env() { printf '%s' "${DGCLAW_BACKUP_ENV:-$DG_ETC/backup.env}"; }
_bk_dir() { printf '%s/backup' "$DG_LIB"; }

# _bk_restic <args...>: roda o restic com o ambiente do backup.env.
_bk_restic() {
    ( set -a
      # shellcheck source=/dev/null
      . "$(_bk_env)"
      set +a
      exec restic "$@" )
}

# _bk_limpa: texto de erro do restic sem credencial embutida em URLs (rest:https://usuario:segredo@host).
_bk_limpa() { tr '\n' ' ' | sed -E 's#://[^/@ ]*@#://***@#g' | head -c 400; }

_bk_agora_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# _bk_gravar_estado <arquivo> <ok:true|false> <snapshot> <erro>
_bk_gravar_estado() {
    local arq="$1" okv="$2" snap="$3" erro="$4"
    jq -nc --argjson ok "$okv" --arg q "$(_bk_agora_iso)" --arg s "$snap" --arg e "$erro" \
        '{ok: $ok, quando: $q, snapshot: (if $s == "" then null else $s end), erro: (if $e == "" then null else $e end)}' \
        | escrever_arquivo "$(_bk_dir)/$arq" 640
}

_bk_configurado() { [ -s "$(_bk_env)" ]; }

_bk_exigir_config() {
    _bk_configurado || falha "o backup ainda nao foi configurado (falta $(_bk_env | sed "s|^$R||"))." \
        "configure com: dgclaw backup configurar --repositorio <s3:https://... | b2:bucket:pasta | sftp:usuario@host:/pasta>"
}

# --- configurar ------------------------------------------------------------------------------------

_BK_REPO_RX='^(s3:|b2:|sftp:|rest:|azure:|gs:|rclone:|/)'
_BK_CRED_RX='^(AWS_[A-Z0-9_]+|B2_[A-Z0-9_]+|AZURE_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|OS_[A-Z0-9_]+|RCLONE_[A-Z0-9_]+|ST_[A-Z0-9_]+)$'

# _bk_ler_credenciais <arquivo>: imprime NOME=valor (validados) das linhas do arquivo.
_bk_ler_credenciais() {
    local arq="$1" linha n=0 nome
    [ -f "$arq" ] || falha "nao achei o arquivo de credenciais $arq." "crie um arquivo com linhas NOME=valor (por exemplo AWS_ACCESS_KEY_ID=...) e passe o caminho em --credenciais."
    while IFS= read -r linha || [ -n "$linha" ]; do
        n=$((n + 1))
        if [[ -z "${linha//[[:space:]]/}" || "$linha" =~ ^[[:space:]]*# ]]; then continue; fi
        nome="${linha%%=*}"
        if [[ "$linha" != *=* ]] || ! [[ "$nome" =~ $_BK_CRED_RX ]]; then
            falha "a linha $n de $arq nao e uma credencial aceita (o nome precisa ser AWS_*, B2_*, AZURE_*, GOOGLE_*, OS_*, RCLONE_* ou ST_*)." \
                "corrija a linha $n. RESTIC_REPOSITORY e a chave do repositorio nao entram aqui: o endereco vai em --repositorio e a chave o comando gera."
        fi
        printf '%s\n' "$linha"
    done <"$arq"
}

# _bk_credenciais_atuais: as credenciais do bucket que ja estao no backup.env, como NOME=valor.
_bk_credenciais_atuais() {
    local nome
    [ -s "$(_bk_env)" ] || return 0
    while IFS= read -r nome; do
        [[ "$nome" =~ $_BK_CRED_RX ]] || continue
        # shellcheck source=/dev/null
        ( . "$(_bk_env)"; printf '%s=%s\n' "$nome" "${!nome}" )
    done < <(sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$(_bk_env)")
}

_bk_configurar() {
    local repo="" cred="" chave_arq="" chave="" gerou=0 atual="" a linhas="" l novo_arq tmp err
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --repositorio|--credenciais|--senha-arquivo)
                [ "$#" -ge 2 ] || falha "faltou o valor depois de $1." "use: dgclaw backup configurar --repositorio <url> [--credenciais <arquivo>] [--senha-arquivo <arquivo>]"
                case "$1" in --repositorio) repo="$2" ;; --credenciais) cred="$2" ;; --senha-arquivo) chave_arq="$2" ;; esac
                shift 2 ;;
            *) falha "opcao desconhecida: $1" "use: dgclaw backup configurar --repositorio <url> [--credenciais <arquivo>] [--senha-arquivo <arquivo>]" ;;
        esac
    done
    ent_exigir restic jq
    atual="$(_bk_env)"

    if [ -z "$repo" ]; then
        if [ -t 0 ] && [ "$ENSAIO" != 1 ]; then
            printf 'Endereco do repositorio (s3:https://s3.exemplo.com/bucket, b2:bucket:pasta, sftp:usuario@host:/pasta): ' >&2
            read -r repo
        else
            falha "faltou o endereco do repositorio." "use: dgclaw backup configurar --repositorio <url>"
        fi
    fi
    if ! [[ "$repo" =~ $_BK_REPO_RX ]] || [[ "$repo" == *$'\n'* ]]; then
        falha "o endereco '${repo:0:60}' nao parece um repositorio do restic." "comece por s3:, b2:, sftp:, rest:, azure:, gs:, rclone: ou por um caminho absoluto (/...)."
    fi

    if [ -n "$cred" ]; then
        linhas="$(_bk_ler_credenciais "$cred")" || return 1
    elif [ -t 0 ] && [ "$ENSAIO" != 1 ]; then
        case "$repo" in
            s3:*) printf 'AWS_ACCESS_KEY_ID: ' >&2; read -r a; linhas="AWS_ACCESS_KEY_ID=$a"
                  printf 'AWS_SECRET_ACCESS_KEY (nao aparece enquanto digita): ' >&2; read -rs a; printf '\n' >&2
                  linhas="$linhas"$'\n'"AWS_SECRET_ACCESS_KEY=$a" ;;
            b2:*) printf 'B2_ACCOUNT_ID: ' >&2; read -r a; linhas="B2_ACCOUNT_ID=$a"
                  printf 'B2_ACCOUNT_KEY (nao aparece enquanto digita): ' >&2; read -rs a; printf '\n' >&2
                  linhas="$linhas"$'\n'"B2_ACCOUNT_KEY=$a" ;;
            *) ;;
        esac
    fi
    # Credenciais que ja estavam gravadas e nao foram repetidas continuam valendo.
    if [ -z "$linhas" ]; then linhas="$(_bk_credenciais_atuais)"; fi

    if [ -n "$chave_arq" ]; then
        [ -s "$chave_arq" ] || falha "o arquivo $chave_arq nao existe ou esta vazio." "grave nele a chave do repositorio existente (so ela, numa linha)."
        chave="$(head -n 1 "$chave_arq")"
    elif [ -s "$atual" ]; then
        # shellcheck source=/dev/null
        chave="$( ( . "$atual"; printf '%s' "${RESTIC_PASSWORD:-}" ) )"
    fi
    if [ -z "$chave" ]; then
        chave="$(head -c 48 /dev/urandom | base64 -w0)"
        gerou=1
    fi

    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] gravaria $atual (600) com o repositorio e as credenciais, testaria com 'restic snapshots' e, se o repositorio nao existir, 'restic init'"
        return 0
    fi

    novo_arq="$(mktemp)"
    {
        printf 'RESTIC_REPOSITORY=%q\n' "$repo"
        printf 'RESTIC_PASSWORD=%q\n' "$chave"
        while IFS= read -r l; do
            [ -n "$l" ] || continue
            printf '%s=%q\n' "${l%%=*}" "${l#*=}"
        done <<<"$linhas"
    } >"$novo_arq"
    chmod 600 "$novo_arq"

    # Testa com o arquivo novo ANTES de trocar o que vale: configuracao ruim nao pode derrubar a boa.
    err="$(mktemp)"
    if ! DGCLAW_BACKUP_ENV="$novo_arq" _bk_restic snapshots --quiet >/dev/null 2>"$err"; then
        info "o repositorio ainda nao responde como repositorio do restic; tentando criar (restic init)..."
        if ! DGCLAW_BACKUP_ENV="$novo_arq" _bk_restic init >/dev/null 2>"$err"; then
            tmp="$(_bk_limpa <"$err")"
            rm -f "$err" "$novo_arq"
            falha "o restic nao conseguiu usar o repositorio (${tmp:-sem mensagem})." \
                "confira o endereco, as credenciais do bucket e a rede. Se o repositorio ja existe, a chave precisa ser a dele (--senha-arquivo). Nada foi gravado."
        fi
        ok "repositorio criado (restic init)"
    else
        ok "repositorio respondeu (restic snapshots)"
    fi
    rm -f "$err"
    mkdir -p "$DG_ETC"
    escrever_arquivo "$atual" 600 <"$novo_arq"
    rm -f "$novo_arq"
    ok "configuracao gravada em ${atual#"$R"} (600)"
    if [ "$gerou" = 1 ]; then
        printf '\n'
        printf '   ATENCAO: esta e a chave do backup. Sem ela NAO ha restauracao, nem para voce.\n'
        printf '   Guarde-a agora, FORA desta VPS (gerenciador de senhas da empresa). Ela nao sera mostrada de novo.\n\n'
        printf '   %s\n\n' "$chave"
    fi
    auditar_aviso backup.configurar "$(jq -nc --arg r "$(printf '%s' "$repo" | sed -E 's#://[^/@ ]*@#://***@#')" '{repositorio: $r}')"
}

# --- agora ----------------------------------------------------------------------------------------

# _bk_falhou <mensagem> <o que fazer> [snapshot]: registra o fracasso (arquivo de estado + auditoria) e sai.
_bk_falhou() {
    local msg="$1" fix="$2" snap="${3:-}"
    _bk_gravar_estado ultimo-backup.json false "$snap" "$msg" \
        || aviso "nao consegui gravar $(_bk_dir)/ultimo-backup.json; o monitoramento nao vai ver esta falha."
    auditar_aviso backup.falha "$(jq -nc --arg e "$msg" '{erro: $e}')"
    rm -rf "$(_bk_dir)/staging"
    falha "backup nao concluido: $msg" "$fix"
}

# _bk_listar_caminhos: os caminhos que entram no snapshot (so os que existem), um por linha.
_bk_listar_caminhos() {
    local p
    for p in "$DG_ETC" "$DG_LIB" "$DG_ADMIN" "$DG_APP/VERSION" "$DG_UNITS"/dgclaw*.service "$DG_UNITS"/dgclaw*.timer; do
        if [ -e "$p" ]; then printf '%s\n' "$p"; fi
    done
}

# _bk_bancos: os bancos SQLite sob /var/lib/dgclaw (fora da pasta do proprio backup e da copia antiga).
_bk_bancos() {
    find "$DG_LIB" \( -path "$(_bk_dir)" -o -path "$DG_LIB/agentes.antes-de-cifrar*" -o -path "$DG_LIB/restauracoes" \) -prune -o \
        -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0 2>/dev/null
}

# _bk_preparar_bancos <excluir-arquivo>: copia consistente de cada banco para staging/bancos e lista os originais
# (e seus -wal/-shm) em <excluir-arquivo>, para o restic guardar so a copia.
_bk_preparar_bancos() {
    local excluir="$1" db rel dest n=0 erro
    if ! command -v sqlite3 >/dev/null 2>&1; then
        aviso "o sqlite3 nao esta instalado: os bancos .db vao no backup como estao, e um banco em uso pode ficar inconsistente na copia. Instale com: apt-get install -y sqlite3"
        return 0
    fi
    erro="$(_bk_dir)/staging/erro-sqlite"
    while IFS= read -r -d '' db; do
        rel="${db#"$DG_LIB"/}"
        dest="$(_bk_dir)/staging/bancos/$rel"
        mkdir -p "$(dirname "$dest")"
        sqlite3 "$db" ".timeout 10000" ".backup '${dest//\'/\'\'}'" 2>"$erro" \
            || _bk_falhou "o sqlite3 nao copiou o banco $db ($(_bk_limpa <"$erro"))." "confira se o banco nao esta corrompido: sqlite3 '$db' 'PRAGMA integrity_check;'"
        printf '%s\n%s\n%s\n' "$db" "$db-wal" "$db-shm" >>"$excluir"
        n=$((n + 1))
    done < <(_bk_bancos)
    rm -f "$erro"
    if [ "$n" -gt 0 ]; then info "$n banco(s) SQLite copiados de forma consistente (.backup)"; fi
}

# _bk_manifesto: copia uma amostra fixa para staging/amostra e grava manifesto.json com o sha256 de cada copia.
# Amostra: web.env, agentes.json e, por agente, um transcript e um arquivo de memoria. A copia (e nao o
# original) entra no manifesto porque o transcript muda a cada mensagem e daria falso alarme no teste.
_bk_manifesto() {
    local dir amostra itens n=0 slug td home f
    dir="$(_bk_dir)"; amostra="$dir/staging/amostra"
    mkdir -p "$amostra"
    itens="$(mktemp)"
    # _bk_amostrar <nome-na-amostra> <arquivo-original>
    _bk_amostrar() {
        [ -f "$2" ] || return 0
        n=$((n + 1))
        cp -p -- "$2" "$amostra/$n-$1"
        printf '%s\t%s\t%s\n' "$amostra/$n-$1" "$2" "$(sha256sum <"$amostra/$n-$1" | cut -d' ' -f1)" >>"$itens"
    }
    _bk_amostrar web.env "$DG_ETC/web.env"
    _bk_amostrar agentes.json "$DG_AGENTES_JSON"
    while IFS=$'\t' read -r slug td home; do
        [ -n "$slug" ] || continue
        f=""
        if [ -d "$td" ]; then f="$(find "$td" -maxdepth 2 -type f -name '*.jsonl' 2>/dev/null | LC_ALL=C sort | head -n 1)"; fi
        if [ -n "$f" ]; then _bk_amostrar "$slug-transcript" "$f"; fi
        f=""
        if [ -d "$home/memory" ]; then f="$(find "$home/memory" -type f 2>/dev/null | LC_ALL=C sort | head -n 1)"; fi
        if [ -n "$f" ]; then _bk_amostrar "$slug-memoria" "$f"; fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | [.slug, (.transcripts_dir // ""), (.home_host // "")] | @tsv')
    jq -Rn --arg q "$(_bk_agora_iso)" '{versao: 1, quando: $q, arquivos: [inputs | split("\t") | {arquivo: .[0], origem: .[1], sha256: .[2]}]}' <"$itens" \
        | escrever_arquivo "$dir/manifesto.json" 640
    rm -f "$itens"
    unset -f _bk_amostrar
    info "manifesto com $n arquivo(s) de amostra"
}

_bk_agora() {
    local dir excluir saida err snap ret msg caminhos=() p
    ent_exigir restic jq
    dir="$(_bk_dir)"
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] copiaria os bancos .db com sqlite3 .backup, gravaria o manifesto, rodaria restic backup de $DG_ETC, $DG_LIB, $DG_ADMIN e das unidades, e restic forget --keep-daily $(protecao_valor backup_retencao_dias) --prune"
        return 0
    fi
    mkdir -p "$dir"; chmod 700 "$dir"
    exec 9>"$dir/.trava"
    flock -n 9 || falha "ja existe um backup rodando (a trava $dir/.trava esta em uso)." "espere ele terminar e confira com: dgclaw backup status"
    if ! _bk_configurado; then
        msg="backup nao configurado (falta $(_bk_env | sed "s|^$R||"))"
        _bk_gravar_estado ultimo-backup.json false "" "$msg" \
            || aviso "nao consegui gravar $dir/ultimo-backup.json."
        auditar_aviso backup.falha "$(jq -nc --arg e "$msg" '{erro: $e}')"
        falha "o backup ainda nao foi configurado (falta $(_bk_env | sed "s|^$R||"))." "configure com: dgclaw backup configurar --repositorio <url>"
    fi
    passo "Backup cifrado fora da VPS"
    rm -rf "$dir/staging"
    mkdir -p "$dir/staging"
    excluir="$dir/staging/excluir.txt"
    : >"$excluir"
    _bk_preparar_bancos "$excluir"
    _bk_manifesto
    while IFS= read -r p; do caminhos+=("$p"); done < <(_bk_listar_caminhos)
    saida="$(mktemp)"; err="$(mktemp)"
    if ! _bk_restic backup --json --tag dgclaw \
        --exclude node_modules --exclude .cache --exclude .npm \
        --exclude "$DG_LIB/agentes.antes-de-cifrar*" --exclude "$DG_LIB/restauracoes" \
        --exclude-file "$excluir" "${caminhos[@]}" >"$saida" 2>"$err"; then
        msg="$(_bk_limpa <"$err")"
        rm -f "$saida" "$err"
        _bk_falhou "o restic backup falhou (${msg:-sem mensagem})." "confira a rede, as credenciais do bucket e o espaco no destino; teste com: dgclaw backup listar"
    fi
    snap="$(jq -rs '[.[] | select(.message_type? == "summary")] | last | .snapshot_id // empty' <"$saida" 2>/dev/null)" || snap=""
    rm -f "$saida" "$err"
    [ -n "$snap" ] || _bk_falhou "o restic terminou sem dizer o numero do snapshot." "confira com: dgclaw backup listar"
    ok "snapshot $snap gravado"

    ret="$(protecao_valor backup_retencao_dias)"
    err="$(mktemp)"
    if ! _bk_restic forget --tag dgclaw --keep-daily "$ret" --prune >/dev/null 2>"$err"; then
        msg="$(_bk_limpa <"$err")"; rm -f "$err"
        _bk_falhou "o backup foi gravado (snapshot $snap), mas a limpeza dos antigos falhou (${msg:-sem mensagem})." \
            "os backups antigos estao se acumulando; confira com: dgclaw backup listar. Repita: dgclaw backup agora" "$snap"
    fi
    rm -f "$err"
    ok "retencao aplicada: $ret dia(s)"
    rm -rf "$dir/staging"
    _bk_gravar_estado ultimo-backup.json true "$snap" ""
    auditar_aviso backup.ok "$(jq -nc --arg s "$snap" --argjson r "$ret" '{snapshot: $s, retencao_dias: $r}')"
    ok "backup concluido"
}

# --- testar ---------------------------------------------------------------------------------------

# _bk_falhou_teste <mensagem> <o que fazer>: usa $snap e $tmp de _bk_testar (variaveis dinamicas do bash).
_bk_falhou_teste() {
    _bk_gravar_estado ultimo-teste.json false "${snap:-}" "$1" \
        || aviso "nao consegui gravar $(_bk_dir)/ultimo-teste.json; o monitoramento nao vai ver esta falha."
    auditar_aviso backup.teste_restauracao "$(jq -nc --arg e "$1" '{ok: false, erro: $e}')"
    if [ -n "${tmp:-}" ]; then rm -rf "$tmp" "$tmp.erro"; fi
    falha "teste de restauracao falhou: $1" "$2"
}

_bk_testar() {
    local dir snap="" tmp="" man n=0 ruins=0 f esperado obtido erro="" lista=() args=() e
    ent_exigir restic jq sha256sum
    dir="$(_bk_dir)"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] restauraria o snapshot mais novo numa pasta temporaria e conferiria o manifesto"; return 0; fi
    _bk_exigir_config
    mkdir -p "$dir"; chmod 700 "$dir"
    passo "Teste de restauracao do backup mais novo"
    snap="$(_bk_restic snapshots --latest 1 --json 2>/dev/null | jq -r 'last | .short_id // empty' 2>/dev/null)" || snap=""
    [ -n "$snap" ] || _bk_falhou_teste "nao ha nenhum backup no repositorio." "rode primeiro: dgclaw backup agora"
    tmp="$(mktemp -d "$dir/teste.XXXXXX")"
    man="$tmp$dir/manifesto.json"
    _bk_restic restore "$snap" --target "$tmp" --include "$dir/manifesto.json" >/dev/null 2>"$tmp.erro" \
        || _bk_falhou_teste "o restic nao restaurou o manifesto do snapshot $snap ($(_bk_limpa <"$tmp.erro"))." "confira a rede e as credenciais: dgclaw backup listar"
    [ -s "$man" ] || _bk_falhou_teste "o snapshot $snap nao traz o manifesto (e anterior a este recurso ou esta incompleto)." "rode um backup novo: dgclaw backup agora"
    while IFS= read -r f; do lista+=("$f"); done < <(jq -r '.arquivos[].arquivo' "$man")
    if [ "${#lista[@]}" -gt 0 ]; then
        for f in "${lista[@]}"; do args+=(--include "$f"); done
        _bk_restic restore "$snap" --target "$tmp" "${args[@]}" >/dev/null 2>"$tmp.erro" \
            || _bk_falhou_teste "o restic nao restaurou os arquivos de amostra do snapshot $snap ($(_bk_limpa <"$tmp.erro"))." "tente de novo: dgclaw backup testar"
    fi
    while IFS=$'\t' read -r f esperado; do
        n=$((n + 1))
        if [ -f "$tmp$f" ]; then obtido="$(sha256sum <"$tmp$f" | cut -d' ' -f1)"; else obtido=""; fi
        if [ "$obtido" != "$esperado" ]; then
            ruins=$((ruins + 1)); e="${f#"$dir"/staging/amostra/}"
            erro="${erro:+$erro; }$e ($([ -z "$obtido" ] && echo ausente || echo diferente))"
        fi
    done < <(jq -r '.arquivos[] | [.arquivo, .sha256] | @tsv' "$man")
    if [ "$ruins" -gt 0 ]; then
        _bk_falhou_teste "$ruins de $n arquivo(s) restaurado(s) nao batem com o manifesto: $erro." "o backup esta ruim; rode um novo e repita: dgclaw backup agora && dgclaw backup testar"
    fi
    rm -rf "$tmp" "$tmp.erro"
    _bk_gravar_estado ultimo-teste.json true "$snap" ""
    auditar_aviso backup.teste_restauracao "$(jq -nc --arg s "$snap" --argjson n "$n" '{ok: true, snapshot: $s, verificados: $n}')"
    ok "snapshot $snap restaurado e conferido: $n arquivo(s) com o sha256 do manifesto"
}

# --- restaurar ------------------------------------------------------------------------------------

ent_cmd_restaurar() {
    local snap="latest" destino="" agente="" confirmar=0 no_lugar=0 alvo c incluir=() quando n erro
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --destino|--agente)
                [ "$#" -ge 2 ] || falha "faltou o valor depois de $1." "use: dgclaw restaurar <snapshot|latest> [--destino <pasta>] [--agente <slug>] [--confirmar]"
                case "$1" in --destino) destino="$2" ;; --agente) agente="$2" ;; esac
                shift 2 ;;
            --confirmar) confirmar=1; shift ;;
            -*) falha "opcao desconhecida: $1" "use: dgclaw restaurar <snapshot|latest> [--destino <pasta>] [--agente <slug>] [--confirmar]" ;;
            *) snap="$1"; shift ;;
        esac
    done
    [[ "$snap" =~ ^[A-Za-z0-9]+$ ]] || falha "o snapshot '${snap:0:40}' nao e valido." "use o numero que aparece em: dgclaw backup listar   ou a palavra latest."
    ent_exigir restic jq
    _bk_exigir_config
    if [ -n "$agente" ]; then
        [[ "$agente" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || falha "o agente '${agente:0:40}' nao e um nome curto valido." "veja: dgclaw agente listar"
        incluir+=(--include "${DG_CASAS:-$DG_LIB/agentes}/$agente")
    fi
    if [ -z "$destino" ] && [ "$confirmar" = 0 ]; then
        quando="$(date +%Y%m%d-%H%M%S)"
        destino="$DG_LIB/restauracoes/$snap-$quando"
        info "sem --destino e sem --confirmar: restauro numa pasta ao lado, sem tocar no que esta em uso."
    fi
    if [ -z "$destino" ]; then
        # Os caminhos do snapshot sao os absolutos de verdade (com a raiz falsa dos testes dentro deles).
        no_lugar=1; alvo="/"
        if [ -n "$agente" ]; then
            c="dgclaw-$agente"
            if [ "$(podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" = running ]; then
                falha "o agente $agente esta ligado, e restaurar por cima de uma casa em uso a corromperia." "pare com: dgclaw agente parar $agente   restaure, e ligue de novo: dgclaw agente iniciar $agente"
            fi
        else
            n="$(podman ps --format '{{.Names}}' 2>/dev/null | grep -c '^dgclaw-' || true)"
            if [ "${n:-0}" -gt 0 ]; then
                falha "ha $n agente(s) ligado(s); restaurar tudo por cima de um DG Claw em uso o corromperia." "pare os agentes (dgclaw agente parar <slug>) e repita, ou restaure numa pasta com --destino <pasta> e copie o que precisar."
            fi
        fi
    else
        if [ -e "$destino" ] && [ -n "$(find "$destino" -mindepth 1 -print -quit 2>/dev/null)" ]; then
            falha "o destino $destino ja existe e nao esta vazio; nao restauro por cima." "escolha uma pasta nova (--destino) ou esvazie esta."
        fi
        alvo="$destino"
    fi
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] restic restore $snap --target $alvo ${incluir[*]}"; return 0; fi
    if [ "$no_lugar" = 0 ]; then mkdir -p "$alvo"; chmod 700 "$alvo"; fi
    passo "Restaurando $snap${agente:+ (so o agente $agente)} em $alvo"
    erro="$(mktemp)"
    if ! _bk_restic restore "$snap" --target "$alvo" "${incluir[@]}" >/dev/null 2>"$erro"; then
        n="$(_bk_limpa <"$erro")"; rm -f "$erro"
        falha "o restic nao restaurou o snapshot $snap (${n:-sem mensagem})." "confira o numero em dgclaw backup listar e a rede/credenciais."
    fi
    rm -f "$erro"
    ok "restaurado em $alvo"
    if [ "$no_lugar" = 0 ]; then
        info "os arquivos estao em $alvo, com o caminho completo de origem. Copie o que precisar para o lugar certo."
        info "bancos .db: a copia consistente do backup fica em $alvo$(_bk_dir)/staging/bancos/ (so existe nos backups feitos com sqlite3 instalado)."
    fi
    auditar_aviso backup.restauracao "$(jq -nc --arg s "$snap" --arg d "$alvo" --arg a "$agente" --argjson l "$no_lugar" '{snapshot: $s, destino: $d, agente: (if $a == "" then null else $a end), no_lugar: ($l == 1)}')"
}

# --- status ---------------------------------------------------------------------------------------

_bk_status() {
    local f
    printf 'Backup: configurado = %s, retencao = %s dia(s)\n' "$(_bk_configurado && echo sim || echo NAO)" "$(protecao_valor backup_retencao_dias)"
    for f in ultimo-backup ultimo-teste; do
        if [ -s "$(_bk_dir)/$f.json" ]; then
            printf '  %s: %s\n' "$f" "$(jq -r '"\(if .ok then "ok" else "FALHOU" end) em \(.quando)\(if .snapshot then ", snapshot \(.snapshot)" else "" end)\(if .erro then " - \(.erro)" else "" end)"' "$(_bk_dir)/$f.json")"
        else
            printf '  %s: ainda nao rodou\n' "$f"
        fi
    done
}

ent_cmd_backup() {
    local sub="${1:-status}"
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        configurar) _bk_configurar "$@" ;;
        agora) _bk_agora "$@" ;;
        listar) ent_exigir restic; _bk_exigir_config; _bk_restic snapshots "$@" ;;
        testar) _bk_testar "$@" ;;
        status) _bk_status ;;
        *) falha "o subcomando 'backup $sub' nao existe." "use: dgclaw backup configurar | agora | listar | testar | status   (e dgclaw restaurar)" ;;
    esac
}

# --- ganchos --------------------------------------------------------------------------------------

ent_status_backup() {
    local arq idade
    protecao_ligada backup || return 0
    if ! _bk_configurado; then s_aviso "backup ligado, mas nao configurado. Rode: dgclaw backup configurar --repositorio <url>"; return 0; fi
    arq="$(_bk_dir)/ultimo-backup.json"
    if [ ! -s "$arq" ]; then s_aviso "backup configurado, mas ainda nao rodou. Rode: dgclaw backup agora"; return 0; fi
    if [ "$(jq -r '.ok' "$arq")" != true ]; then
        s_aviso "o ultimo backup FALHOU: $(jq -r '.erro // "sem mensagem"' "$arq"). Rode: dgclaw backup agora"
        return 0
    fi
    idade=$(( ($(date +%s) - $(date -d "$(jq -r '.quando' "$arq")" +%s)) / 3600 ))
    if [ "$idade" -gt 36 ]; then s_aviso "o ultimo backup bem-sucedido foi ha ${idade}h (o esperado e diario). Veja: systemctl status dgclaw-backup.timer"
    else s_ok "backup: ultimo ok ha ${idade}h"; fi
}

# Instalador: restic, sqlite3 e os dois timers.
ent_instalar_backup() {
    local cal_teste="Sun *-*-* 05:00:00" nome_teste=semanal
    protecao_ligada backup || return 0
    if [ "$(protecao_nivel)" = regulado ]; then cal_teste="*-*-01 05:00:00"; nome_teste=mensal; fi
    if [ "$ENSAIO" = 1 ] || ! command -v restic >/dev/null 2>&1 || ! command -v sqlite3 >/dev/null 2>&1; then
        executar apt-get install -y --no-install-recommends restic sqlite3
    fi
    cat <<'FIM' | escrever_arquivo "$DG_UNITS/dgclaw-backup.service" 644
[Unit]
Description=DG Claw: backup cifrado fora da VPS
After=network-online.target dgclaw-disco.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/dgclaw backup agora
Nice=10
IOSchedulingClass=idle
FIM
    cat <<'FIM' | escrever_arquivo "$DG_UNITS/dgclaw-backup.timer" 644
[Unit]
Description=DG Claw: backup diario

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
FIM
    cat <<'FIM' | escrever_arquivo "$DG_UNITS/dgclaw-backup-teste.service" 644
[Unit]
Description=DG Claw: teste de restauracao do backup
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/dgclaw backup testar
Nice=10
IOSchedulingClass=idle
FIM
    printf '[Unit]\nDescription=DG Claw: teste de restauracao (%s)\n\n[Timer]\nOnCalendar=%s\nRandomizedDelaySec=30min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' \
        "$nome_teste" "$cal_teste" | escrever_arquivo "$DG_UNITS/dgclaw-backup-teste.timer" 644
    executar systemctl daemon-reload
    executar systemctl enable --now dgclaw-backup.timer dgclaw-backup-teste.timer
    ok "backup diario as 03:30 e teste de restauracao $nome_teste instalados (timers)"
    if ! _bk_configurado; then
        info "falta configurar o destino: dgclaw backup configurar --repositorio <s3:https://...|b2:bucket:pasta|sftp:usuario@host:/pasta>"
    fi
}
