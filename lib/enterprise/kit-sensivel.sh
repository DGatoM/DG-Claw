#!/usr/bin/env bash
# lib/enterprise/kit-sensivel.sh: bloco I, o kit "skill com dado sensivel" (protecao `kit_sensivel`).
#
# O agente nunca toca no dado bruto nem na credencial do sistema da empresa: ele aciona uma ferramenta fechada
# (/etc/dgclaw/ferramentas/<nome>/) pelo servico dgclaw-ferramentas, que roda no host sem privilegio, e recebe um resultado
# agregado, pseudonimizado e conferido. Detalhes e limites: docs/enterprise/KIT-SENSIVEL.md e SKILL-SENSIVEL.md.
#
# Comandos:
#   dgclaw ferramenta criar <nome> --agente <slug> [--agente <slug>...] --responsavel "<nome>"   cria a pasta a partir do exemplo
#   dgclaw ferramenta listar                                  as ferramentas, os agentes, o estado da credencial
#   dgclaw ferramenta testar <nome|pasta>                     roda o teste sintetico (base falsa, nomes e CPFs conhecidos)
#   dgclaw ferramenta credencial <nome>                       grava credenciais.env lendo do stdin (CHAVE=valor por linha)
#   dgclaw ferramenta abrir [nome]                            abre em memoria as credenciais cifradas (roda no boot do servico)
#   dgclaw ferramenta chave                                   cria a chave de pseudonimo da empresa (so se ainda nao existe)
#   dgclaw ferramenta ficha <nome>                            a ficha da ferramenta (insumo do RIPD), em markdown, no stdout
#   dgclaw ferramenta skill <nome> --agente <slug>            instala no agente a skill que ensina a usar so a ferramenta
#
# Ganchos: ent_instalar_kit_sensivel (instalador), ent_aplicar_kit_sensivel (`protecoes aplicar`), ent_status_kit_sensivel.
# Precisa de lib/comum.sh, lib/agentes.sh, lib/protecoes.sh e lib/enterprise/auditoria.sh carregados antes.

_KS_USUARIO="dgclaw-ferramentas"
_KS_UNIDADE="dgclaw-ferramentas.service"
_KS_RX_NOME='^[a-z][a-z0-9_-]{0,38}(\.[a-z][a-z0-9_-]{0,38})?$'
_KS_RX_SLUG='^[a-z0-9][a-z0-9-]{1,30}$'

_ks_dir() { printf '%s/ferramentas' "$DG_ETC"; }
_ks_ug() { printf '%s:%s' "$_KS_USUARIO" "$_KS_USUARIO"; }
_ks_cred_ram() { printf '%s' "${DGCLAW_FERRAMENTAS_CRED_RAM:-$R/run/dgclaw/ferramentas-cred}"; }
_ks_creds() { printf '%s' "${DGCLAW_SYSTEMD_CREDS:-systemd-creds}"; }
_ks_app() { printf '%s' "${APP_DIR:?}"; }

# _ks_exigir_ligado: os comandos que escrevem em /etc/dgclaw/ferramentas so existem com a protecao ligada.
_ks_exigir_ligado() {
    protecao_ligada kit_sensivel \
        || falha "a protecao kit_sensivel esta desligada neste nivel, entao nao ha servico de ferramentas." \
                 "ligue com: dgclaw nivel ajustar kit_sensivel true  (ela liga sozinha nos niveis empresa e regulado)."
}

_ks_exigir_nome() {
    [[ "${1:-}" =~ $_KS_RX_NOME ]] \
        || falha "'${1:-}' nao e um nome de ferramenta." \
                 "use minusculas, numeros, - e _, no formato carteira ou carteira.resumo."
}

# _ks_exigir_existe <nome>: a pasta da ferramenta existe.
_ks_exigir_existe() {
    [ -d "$(_ks_dir)/$1" ] \
        || falha "nao existe a ferramenta '$1' em ${DG_ETC#"$R"}/ferramentas." \
                 "veja as que existem com: dgclaw ferramenta listar  (ou crie com: dgclaw ferramenta criar $1 --agente <slug> --responsavel \"<nome>\")."
}

# ---------------------------------------------------------------------------------------------------------------
# Unidade do systemd
# ---------------------------------------------------------------------------------------------------------------

# O servico roda como usuario proprio, sem capacidade nenhuma e sem root. Cada linha abaixo e uma porta fechada:
#   ExecStartPre=+...abrir     (com o `+`, roda como root) decifra as credenciais para a memoria (/run), pasta 700 do servico.
#   ProtectSystem=strict       o sistema inteiro somente leitura; o servico so grava no tmp proprio (PrivateTmp) e no socket.
#   ProtectHome=yes            /home, /root e /run/user fora de vista.
#   RestrictAddressFamilies    o executor precisa falar com o banco da empresa (rede), entao AF_INET e AF_INET6 ficam.
#                              Para limitar a rede a um endereco, use um drop-in com IPAddressDeny=any e IPAddressAllow=<banco>.
#   MemoryDenyWriteExecute     fica de fora: o JIT do Node (o proprio servico) precisa de memoria gravavel e executavel.
_ks_unidade() {
    cat <<'FIM'
[Unit]
Description=DG Claw Ferramentas (servico sem IA e sem privilegio que roda as ferramentas fechadas de dado sensivel)
After=network-online.target dgclaw-cofre.service
Wants=network-online.target

[Service]
Type=simple
User=dgclaw-ferramentas
Group=dgclaw-ferramentas
RuntimeDirectory=dgclaw-ferramentas
RuntimeDirectoryMode=0750
Environment=DGCLAW_FERRAMENTAS_SOCK=/run/dgclaw-ferramentas/ferramentas.sock
Environment=DGCLAW_FERRAMENTAS_DIR=/etc/dgclaw/ferramentas
Environment=DGCLAW_FERRAMENTAS_CRED_RAM=/run/dgclaw/ferramentas-cred
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStartPre=+-/opt/dgclaw/app/bin/dgclaw ferramenta abrir
ExecStart=/usr/bin/node /opt/dgclaw/app/ferramentas/servidor.js
Restart=always
RestartSec=3
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectProc=invisible
ProcSubset=pid
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
LimitNPROC=256
TasksMax=256
MemoryMax=2G
UMask=0077

[Install]
WantedBy=multi-user.target
FIM
}

# _ks_escrever <arquivo> <modo>: grava o STDIN se mudou. Devolve 0 se gravou, 1 se ja estava igual.
_ks_escrever() {
    local alvo="$1" modo="$2" novo
    novo="$(cat)"
    if [ -f "$alvo" ] && [ "$(cat "$alvo")" = "$novo" ]; then return 1; fi
    printf '%s\n' "$novo" | escrever_arquivo "$alvo" "$modo"
    return 0
}

# _ks_chave: cria a chave de pseudonimo se ainda nao existe. Trocar a chave muda TODOS os pseudonimos, entao nunca sobrescreve.
_ks_chave() {
    local arq
    arq="$(_ks_dir)/chave-pseudonimo"
    if [ -s "$arq" ]; then
        info "a chave de pseudonimo ja existe (${arq#"$R"}); nao troco, porque trocar muda todos os pseudonimos."
        return 0
    fi
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | escrever_arquivo "$arq" 600 "$(_ks_ug)"
    ok "chave de pseudonimo criada em ${arq#"$R"} (600). Guarde uma copia no cofre da empresa: sem ela os pseudonimos antigos nao se repetem."
}

_ks_instalar() {
    local mudou=0
    ent_exigir jq
    command -v node >/dev/null 2>&1 || [ "$ENSAIO" = 1 ] \
        || falha "o node nao foi encontrado nesta maquina e o servico de ferramentas precisa dele." "o instalador do DG Claw instala o Node 22; rode ./install.sh de novo."
    command -v python3 >/dev/null 2>&1 || [ "$ENSAIO" = 1 ] \
        || falha "o python3 nao foi encontrado nesta maquina e os executores de ferramenta usam a biblioteca em Python." "instale com: apt-get install -y python3"
    if ! getent passwd "$_KS_USUARIO" >/dev/null 2>&1; then
        executar useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$_KS_USUARIO"
        ok "usuario $_KS_USUARIO criado (sem login, sem privilegio)"
    fi
    executar install -d -m 750 "$(_ks_dir)"
    dono "$(_ks_ug)" "$(_ks_dir)"
    _ks_chave
    if _ks_unidade | _ks_escrever "$DG_UNITS/$_KS_UNIDADE" 644; then mudou=1; info "unidade $_KS_UNIDADE escrita"; fi
    executar systemctl daemon-reload
    executar systemctl enable "$_KS_UNIDADE"
    if [ "$mudou" = 1 ] || [ "$ENSAIO" = 1 ] || [ "$(systemctl is-active "${_KS_UNIDADE%.service}" 2>/dev/null || true)" != active ]; then
        executar systemctl restart "$_KS_UNIDADE"
    fi
    ok "servico de ferramentas ligado (socket /run/dgclaw-ferramentas/ferramentas.sock)"
}

# ---------------------------------------------------------------------------------------------------------------
# Comandos
# ---------------------------------------------------------------------------------------------------------------

_ks_criar() {
    local nome="" resp="" agentes=() a modelo destino json
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --agente) [ "$#" -ge 2 ] || falha "faltou o slug depois de --agente." "use: dgclaw ferramenta criar <nome> --agente <slug> --responsavel \"<nome>\""
                      agentes+=("$2"); shift 2 ;;
            --responsavel) [ "$#" -ge 2 ] || falha "faltou o nome depois de --responsavel." "use: dgclaw ferramenta criar <nome> --agente <slug> --responsavel \"<nome>\""
                           resp="$2"; shift 2 ;;
            -*) falha "a opcao '$1' nao existe em 'ferramenta criar'." "use: dgclaw ferramenta criar <nome> --agente <slug> --responsavel \"<nome>\"" ;;
            *) [ -z "$nome" ] || falha "sobrou '$1' na linha (o nome ja e '$nome')." "use: dgclaw ferramenta criar <nome> --agente <slug> --responsavel \"<nome>\""
               nome="$1"; shift ;;
        esac
    done
    _ks_exigir_nome "$nome"
    [ "${#agentes[@]}" -gt 0 ] || falha "falta dizer qual agente pode usar a ferramenta." "acrescente --agente <slug> (pode repetir). Sem agente listado ninguem usa a ferramenta."
    for a in "${agentes[@]}"; do
        [[ "$a" =~ $_KS_RX_SLUG ]] || falha "'$a' nao e um slug de agente." "veja os slugs com: dgclaw agente listar"
    done
    if [ -z "$resp" ] || [ "${#resp}" -gt 200 ]; then falha "falta o responsavel pela ferramenta (ate 200 caracteres)." "acrescente --responsavel \"Maria Souza, maria@empresa.com\" (ele entra na ficha do RIPD)."; fi
    _ks_exigir_ligado
    ent_exigir jq
    destino="$(_ks_dir)/$nome"
    [ ! -e "$destino" ] || falha "a ferramenta '$nome' ja existe em ${destino#"$R"}." "escolha outro nome, ou edite a pasta que ja existe."
    modelo="$(_ks_app)/templates/ferramenta-sensivel/exemplo-carteira"
    [ -d "$modelo" ] || falha "nao achei o modelo $modelo." "reinstale o DG Claw para recolocar a pasta templates/ferramenta-sensivel."
    json="$(jq --arg n "$nome" --arg r "$resp" --argjson a "$(printf '%s\n' "${agentes[@]}" | jq -R . | jq -sc .)" \
        '.nome = $n | .agentes = $a | .responsavel = $r | .finalidade = "PREENCHER: por que esta ferramenta existe" | .base_legal = "PREENCHER: base legal da LGPD (art. 7 ou 11)" | .descricao = "PREENCHER: o que a ferramenta devolve, em uma frase"' \
        "$modelo/ferramenta.json")" \
        || falha "o jq nao leu o modelo $modelo/ferramenta.json." "reinstale o DG Claw."
    executar install -d -m 750 "$destino"
    executar cp -a "$modelo/." "$destino/"
    printf '%s\n' "$json" | escrever_arquivo "$destino/ferramenta.json" 640 "$(_ks_ug)"
    executar chown -R "$(_ks_ug)" "$destino"
    auditar_aviso ferramenta_criada "$(jq -nc --arg n "$nome" --arg r "$resp" --argjson a "$(printf '%s\n' "${agentes[@]}" | jq -R . | jq -sc .)" '{ferramenta: $n, agentes: $a, responsavel: $r}')"
    ok "ferramenta $nome criada em ${destino#"$R"}, a partir do exemplo carteira.resumo"
    info "Proximos passos:"
    info "  1. edite ${destino#"$R"}/ferramenta.json (troque os PREENCHER, os parametros e os campos usados) e o executor.py para a sua base;"
    info "  2. grave a credencial:  printf 'BASE_SQLITE=...' | dgclaw ferramenta credencial $nome   (a credencial nunca vai para o agente);"
    info "  3. rode o teste:        dgclaw ferramenta testar $nome;"
    info "  4. instale a skill:     dgclaw ferramenta skill $nome --agente ${agentes[0]};"
    info "  5. gere a ficha do RIPD: dgclaw ferramenta ficha $nome"
}

_ks_listar() {
    command -v node >/dev/null 2>&1 || falha "o node nao foi encontrado nesta maquina." "instale o Node 22 (o instalador do DG Claw faz isso)."
    [ -d "$(_ks_dir)" ] || { info "Nenhuma ferramenta: a pasta ${DG_ETC#"$R"}/ferramentas ainda nao existe."; return 0; }
    node "$(_ks_app)/ferramentas/listar.js" "$(_ks_dir)"
}

_ks_testar() {
    local alvo="${1:-}" py
    [ -n "$alvo" ] || falha "falta dizer qual ferramenta testar." "use: dgclaw ferramenta testar <nome>  (ou o caminho de uma pasta, como templates/ferramenta-sensivel/exemplo-carteira)"
    [ "$#" -le 1 ] || falha "sobrou '$2' na linha." "use: dgclaw ferramenta testar <nome>"
    command -v node >/dev/null 2>&1 || falha "o node nao foi encontrado nesta maquina." "instale o Node 22 (o instalador do DG Claw faz isso)."
    py="$(command -v python3 2>/dev/null || true)"
    [ -n "$py" ] || falha "o python3 nao foi encontrado nesta maquina." "instale com: apt-get install -y python3"
    if [[ "$alvo" != */* ]]; then
        _ks_exigir_nome "$alvo"
        _ks_exigir_existe "$alvo"
        alvo="$(_ks_dir)/$alvo"
    fi
    [ -d "$alvo" ] || falha "a pasta '$alvo' nao existe." "confira o caminho."
    node "$(_ks_app)/ferramentas/testar.js" "$alvo" --python "$py"
}

# _ks_credencial <nome>: o stdin vira credenciais.env (600, dono do servico). Cifrado quando a protecao cofre_cifrado esta ligada.
_ks_credencial() {
    local nome="${1:-}" texto linha n pasta chaves=0
    _ks_exigir_nome "$nome"
    _ks_exigir_ligado
    _ks_exigir_existe "$nome"
    if [ -t 0 ]; then
        falha "este comando le a credencial do stdin e nao do teclado (o valor nao pode ir na linha de comando, que fica no historico)." \
              "use:  printf 'BASE_URL=...\\nBASE_SENHA=...\\n' | dgclaw ferramenta credencial $nome   ou   dgclaw ferramenta credencial $nome < arquivo.env"
    fi
    texto="$(cat)"
    [ -n "$texto" ] || falha "o stdin veio vazio: nao ha credencial para gravar." "mande linhas CHAVE=valor."
    n=0
    while IFS= read -r linha || [ -n "$linha" ]; do
        n=$((n + 1))
        [ -z "${linha//[[:space:]]/}" ] && continue
        [[ "$linha" == \#* ]] && continue
        [[ "$linha" =~ ^[A-Z][A-Z0-9_]{0,63}=.+$ ]] \
            || falha "a linha $n da credencial nao tem o formato CHAVE=valor (nome em maiusculas, valor nao vazio). O conteudo da linha nao e mostrado." \
                     "corrija e mande de novo; nada foi gravado."
        [[ "${linha%%=*}" =~ ^(PATH|HOME|TMPDIR|LANG|LC_.*|PYTHON.*|NODE.*|LD_.*|DGCLAW_.*)$ ]] \
            && falha "o nome ${linha%%=*} (linha $n) e reservado do servico de ferramentas." "use outro nome (os reservados sao PATH, HOME, DGCLAW_*, PYTHON*, NODE* e LD_*)."
        chaves=$((chaves + 1))
    done <<<"$texto"
    pasta="$(_ks_dir)/$nome"
    if protecao_ligada cofre_cifrado; then
        ent_exigir "$(_ks_creds)"
        local tmp
        tmp="$(mktemp "$pasta/.cred.XXXXXX")"
        if ! printf '%s\n' "$texto" | "$(_ks_creds)" encrypt "--name=dgclaw-ferramenta-$nome" --with-key=auto - "$tmp" 2>"$tmp.erro"; then
            local motivo
            motivo="$(tr '\n' ' ' <"$tmp.erro" | head -c 200)"
            rm -f "$tmp" "$tmp.erro"
            falha "o systemd-creds nao cifrou a credencial de $nome (${motivo:-sem mensagem})." "confira com: systemd-creds --version. Nada foi gravado."
        fi
        rm -f "$tmp.erro"
        chmod 600 "$tmp"
        mv -f "$tmp" "$pasta/credenciais.env.cred"
        dono "$(_ks_ug)" "$pasta/credenciais.env.cred"
        rm -f "$pasta/credenciais.env"
        _ks_abrir_uma "$nome"
        ok "credencial de $nome gravada cifrada (credenciais.env.cred) e aberta em memoria"
    else
        printf '%s\n' "$texto" | escrever_arquivo "$pasta/credenciais.env" 600 "$(_ks_ug)"
        ok "credencial de $nome gravada em ${pasta#"$R"}/credenciais.env (600, so o servico le)"
        info "Em disco ela fica em texto claro neste nivel. Com a protecao cofre_cifrado ligada ela passa a ser cifrada."
    fi
    auditar_aviso ferramenta_credencial "$(jq -nc --arg n "$nome" --argjson c "$chaves" '{ferramenta: $n, chaves: $c}')"
}

# _ks_abrir_uma <nome>: decifra credenciais.env.cred para a copia em memoria (so existe em /run).
_ks_abrir_uma() {
    local nome="$1" pasta cred ram erro
    pasta="$(_ks_dir)/$nome"
    cred="$pasta/credenciais.env.cred"
    [ -f "$cred" ] || return 0
    ram="$(_ks_cred_ram)"
    executar install -d -m 755 "$ram"
    executar install -d -m 700 "$ram/$nome"
    dono "$(_ks_ug)" "$ram/$nome"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] decifraria $cred para $ram/$nome/credenciais.env"; return 0; fi
    erro="$(mktemp)"
    if ! "$(_ks_creds)" decrypt "--name=dgclaw-ferramenta-$nome" "$cred" - 2>"$erro" | escrever_arquivo "$ram/$nome/credenciais.env" 600 "$(_ks_ug)"; then
        aviso "nao consegui decifrar a credencial de $nome ($(tr '\n' ' ' <"$erro" | head -c 200)). A ferramenta fica sem credencial ate voce regravar: dgclaw ferramenta credencial $nome"
        rm -f "$erro"
        return 1
    fi
    if [ ! -s "$ram/$nome/credenciais.env" ]; then
        rm -f "$erro" "$ram/$nome/credenciais.env"
        aviso "a credencial de $nome decifrou vazia. Regrave: dgclaw ferramenta credencial $nome"
        return 1
    fi
    rm -f "$erro"
}

_ks_abrir() {
    local alvo="${1:-}" d n rc=0
    protecao_ligada kit_sensivel || return 0
    [ -d "$(_ks_dir)" ] || return 0
    if [ -n "$alvo" ]; then
        _ks_exigir_nome "$alvo"
        _ks_exigir_existe "$alvo"
        _ks_abrir_uma "$alvo"
        return $?
    fi
    for d in "$(_ks_dir)"/*/; do
        [ -d "$d" ] || continue
        n="$(basename "$d")"
        [[ "$n" =~ $_KS_RX_NOME ]] || continue
        _ks_abrir_uma "$n" || rc=1
    done
    return "$rc"
}

# _ks_ler_json <nome>: o ferramenta.json da ferramenta no stdout (confere que abre).
_ks_ler_json() {
    local arq
    arq="$(_ks_dir)/$1/ferramenta.json"
    [ -f "$arq" ] || falha "a ferramenta '$1' nao tem ferramenta.json (${arq#"$R"})." "recrie com: dgclaw ferramenta criar."
    jq -c . "$arq" || falha "o ferramenta.json de '$1' nao e um JSON valido." "corrija o arquivo ${arq#"$R"}."
}

# _ks_renderizar <modelo> <json>: troca {{campo}} do modelo pelos valores do ferramenta.json. Imprime no stdout.
_ks_renderizar() {
    local modelo="$1" json="$2" txt
    [ -f "$modelo" ] || falha "nao achei o modelo $modelo." "reinstale o DG Claw para recolocar a pasta templates/skill-sensivel."
    txt="$(cat "$modelo")"
    local nome descricao finalidade base campos agentes resp ret minimo params exemplo
    nome="$(jq -r .nome <<<"$json")"
    descricao="$(jq -r .descricao <<<"$json")"
    finalidade="$(jq -r .finalidade <<<"$json")"
    base="$(jq -r .base_legal <<<"$json")"
    campos="$(jq -r '.campos_usados | join(", ")' <<<"$json")"
    agentes="$(jq -r '.agentes | join(", ")' <<<"$json")"
    resp="$(jq -r .responsavel <<<"$json")"
    ret="$(jq -r .retencao_dias <<<"$json")"
    minimo="$(jq -r '.minimo_grupo // 10' <<<"$json")"
    params="$(jq -r '.parametros | to_entries | map("- `--\(.key)`: \(.value.descricao // "") (tipo \(.value.tipo)\(if .value.valores then ", um de: " + (.value.valores | join(", ")) else "" end)\(if .value.obrigatorio then ", obrigatorio" else "" end))") | join("\n")' <<<"$json")"
    exemplo="$(jq -r '"dgclaw-ferramenta \(.nome)" + ([.parametros | to_entries[] | select(.value.obrigatorio or (.value.padrao != null)) | " --\(.key) <\(.key)>"] | join(""))' <<<"$json")"
    txt="${txt//\{\{nome\}\}/$nome}"
    txt="${txt//\{\{descricao\}\}/$descricao}"
    txt="${txt//\{\{finalidade\}\}/$finalidade}"
    txt="${txt//\{\{base_legal\}\}/$base}"
    txt="${txt//\{\{campos\}\}/$campos}"
    txt="${txt//\{\{agentes\}\}/$agentes}"
    txt="${txt//\{\{responsavel\}\}/$resp}"
    txt="${txt//\{\{retencao\}\}/$ret}"
    txt="${txt//\{\{minimo\}\}/$minimo}"
    txt="${txt//\{\{parametros\}\}/$params}"
    txt="${txt//\{\{exemplo\}\}/$exemplo}"
    txt="${txt//\{\{skill\}\}/${nome//./-}}"
    printf '%s\n' "$txt"
}

_ks_ficha() {
    local nome="${1:-}"
    _ks_exigir_nome "$nome"
    _ks_exigir_existe "$nome"
    ent_exigir jq
    _ks_renderizar "$(_ks_app)/templates/skill-sensivel/FICHA.md" "$(_ks_ler_json "$nome")"
}

_ks_skill() {
    local nome="" slug="" json home pasta dono_h
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --agente) [ "$#" -ge 2 ] || falha "faltou o slug depois de --agente." "use: dgclaw ferramenta skill <nome> --agente <slug>"
                      slug="$2"; shift 2 ;;
            -*) falha "a opcao '$1' nao existe em 'ferramenta skill'." "use: dgclaw ferramenta skill <nome> --agente <slug>" ;;
            *) [ -z "$nome" ] || falha "sobrou '$1' na linha." "use: dgclaw ferramenta skill <nome> --agente <slug>"
               nome="$1"; shift ;;
        esac
    done
    _ks_exigir_nome "$nome"
    [[ "$slug" =~ $_KS_RX_SLUG ]] || falha "falta o agente (ou '$slug' nao e um slug)." "use: dgclaw ferramenta skill $nome --agente <slug>"
    _ks_exigir_existe "$nome"
    ent_exigir jq
    json="$(_ks_ler_json "$nome")"
    jq -e --arg s "$slug" '.agentes | index($s)' <<<"$json" >/dev/null \
        || falha "o agente '$slug' nao esta na lista de agentes da ferramenta '$nome'." "inclua o slug em \"agentes\" no ferramenta.json; a skill so deve existir em quem pode usar a ferramenta."
    home="$(agentes_obter "$slug" | jq -r '.home_host // empty')"
    [ -n "$home" ] || falha "nao achei o agente '$slug' no registro de agentes." "veja os slugs com: dgclaw agente listar"
    pasta="$home/.claude/skills/${nome//./-}"
    dono_h="$(stat -c '%u:%g' "$home" 2>/dev/null || echo 0:0)"
    executar install -d -m 755 "$pasta"
    _ks_renderizar "$(_ks_app)/templates/skill-sensivel/SKILL.md" "$json" | escrever_arquivo "$pasta/SKILL.md" 644 "$dono_h"
    dono "$dono_h" "$pasta"
    ok "skill ${nome//./-} instalada em ${pasta#"$R"}"
}

ent_cmd_ferramenta() {
    local sub="${1:-}"
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        criar) _ks_criar "$@" ;;
        listar) _ks_listar ;;
        testar) _ks_testar "$@" ;;
        credencial) _ks_credencial "$@" ;;
        abrir) _ks_abrir "$@" ;;
        chave) _ks_exigir_ligado; _ks_chave ;;
        ficha) _ks_ficha "$@" ;;
        skill) _ks_skill "$@" ;;
        *) falha "'ferramenta ${sub:-}' nao existe." "use: dgclaw ferramenta criar|listar|testar|credencial|abrir|chave|ficha|skill  (veja docs/enterprise/KIT-SENSIVEL.md)" ;;
    esac
}

# ---------------------------------------------------------------------------------------------------------------
# Ganchos
# ---------------------------------------------------------------------------------------------------------------

ent_instalar_kit_sensivel() {
    protecao_ligada kit_sensivel || return 0
    passo "Servico de ferramentas (kit de dado sensivel)"
    _ks_instalar
}

ent_aplicar_kit_sensivel() {
    protecao_ligada kit_sensivel || return 0
    _ks_instalar
}

ent_status_kit_sensivel() {
    protecao_ligada kit_sensivel || return 0
    if [ "$(systemctl is-active "${_KS_UNIDADE%.service}" 2>/dev/null)" = active ]; then s_ok "servico de ferramentas de pe"
    else s_mal "o servico de ferramentas esta parado. Veja: journalctl -u dgclaw-ferramentas -n 50  (ligar: systemctl restart dgclaw-ferramentas)"; fi
}
