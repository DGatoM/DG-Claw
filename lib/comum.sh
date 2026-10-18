#!/usr/bin/env bash
# lib/comum.sh: o vocabulario comum do instalador (install.sh) e da CLI (bin/dgclaw).
#
# Carregado com `source`, nunca executado. Concentra tres coisas que precisam ser
# iguais nos dois lados, senao um escreve de um jeito e o outro le de outro:
#   1. os caminhos do sistema, todos atras de $R (DGCLAW_RAIZ), para os testes
#      rodarem numa raiz falsa sem encostar no /etc de verdade;
#   2. o modo ensaio (--ensaio), em que nada muda e tudo e anunciado;
#   3. as mensagens para gente: o que esta acontecendo e, na falha, o que falhou,
#      com que entrada e o que fazer.

# Guarda contra carregar duas vezes (o install.sh e a CLI podem se chamar).
if [ -n "${_DGCLAW_COMUM_CARREGADO:-}" ]; then return 0; fi
_DGCLAW_COMUM_CARREGADO=1

# --- caminhos ----------------------------------------------------------------
# Vazio em producao. Nos testes aponta para uma pasta temporaria, e todo caminho
# de sistema passa a morar dentro dela.
R="${DGCLAW_RAIZ:-}"
DG_ETC="$R/etc/dgclaw"
DG_OPT="$R/opt/dgclaw"
DG_APP="$DG_OPT/app"
DG_ADMIN="$DG_OPT/admin"
DG_LIB="$R/var/lib/dgclaw"
DG_LOG="$R/var/log/dgclaw"
DG_UNITS="$R/etc/systemd/system"
DG_BIN="$R/usr/local/bin"
DG_AGENTES_JSON="$DG_ETC/agentes.json"
DG_REGISTRO="$DG_ETC/registro.tsv"
DG_TRAVA="$DG_ETC/.agentes.lock"
DG_IMAGEM_PADRAO="localhost/dgclaw-agente:latest"
export R DG_ETC DG_OPT DG_APP DG_ADMIN DG_LIB DG_LOG DG_UNITS DG_BIN DG_AGENTES_JSON DG_REGISTRO DG_TRAVA

ENSAIO="${ENSAIO:-0}"

# --- saida para gente ----------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    _C_OK=$'\033[32m'; _C_AV=$'\033[33m'; _C_ER=$'\033[31m'; _C_TI=$'\033[1m'; _C_0=$'\033[0m'
else
    _C_OK=""; _C_AV=""; _C_ER=""; _C_TI=""; _C_0=""
fi
_PASSO_N=0

passo() { _PASSO_N=$((_PASSO_N + 1)); printf '\n%s[%s] %s%s\n' "$_C_TI" "$_PASSO_N" "$1" "$_C_0"; }
ok()    { printf '   %sok%s  %s\n' "$_C_OK" "$_C_0" "$1"; }
info()  { printf '   %s\n' "$1"; }
aviso() { printf '   %saviso%s  %s\n' "$_C_AV" "$_C_0" "$1" >&2; }

# falha "<o que falhou, com que entrada>" "<o que fazer>"
# Sai com 1. As duas metades sao obrigatorias: um erro sem o "o que fazer" deixa
# a pessoa (ou o Claude dela) sem saida, e a saida vira adivinhar.
falha() {
    printf '\n%sNao deu certo:%s %s\n' "$_C_ER" "$_C_0" "$1" >&2
    printf 'O que fazer: %s\n' "${2:-veja a mensagem acima.}" >&2
    exit 1
}

# executar <comando...>
# No ensaio, so anuncia. Fora dele, roda; se falhar, diz qual comando e com que
# codigo, em vez de deixar o `set -e` derrubar o script em silencio.
executar() {
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] %s\n' "$*"
        return 0
    fi
    local rc=0
    "$@" || rc=$?
    if [ "$rc" -ne 0 ]; then
        falha "o comando '$*' terminou com codigo $rc." "leia as linhas acima, que mostram a causa; depois rode de novo (rodar de novo e seguro)."
    fi
}

# escrever_arquivo <caminho> <modo> [uid:gid]
# Conteudo pelo STDIN. Escreve num temporario NA MESMA PASTA e troca com mv: quem
# esta lendo o arquivo (o Web, o runner) nunca ve metade dele.
escrever_arquivo() {
    local alvo="$1" modo="$2" quem="${3:-}" tmp
    if [ "$ENSAIO" = 1 ]; then
        cat >/dev/null
        printf '   [ensaio] escreveria %s (modo %s%s)\n' "$alvo" "$modo" "${quem:+, dono $quem}"
        return 0
    fi
    mkdir -p "$(dirname "$alvo")"
    tmp="$(mktemp "$(dirname "$alvo")/.$(basename "$alvo").XXXXXX")"
    cat >"$tmp"
    chmod "$modo" "$tmp"
    [ -n "$quem" ] && dono "$quem" "$tmp"
    mv -f "$tmp" "$alvo"
}

# agora_ms: epoch em milissegundos. Nos testes (DGCLAW_RAIZ definida), DGCLAW_AGORA_MS fixa o relogio.
agora_ms() {
    if [ -n "$R" ] && [ -n "${DGCLAW_AGORA_MS:-}" ]; then
        printf '%s' "$DGCLAW_AGORA_MS"
    else
        printf '%s' "$(( $(date +%s) * 1000 ))"
    fi
}

# gerar_primeiro_acesso <usuario>
# Gera a credencial do link de primeiro acesso (32 bytes em base64url, 43 caracteres) e grava
# $DG_ETC/primeiro-acesso.json (modo 600), trocando o anterior: o link velho deixa de valer.
# Imprime SO a credencial no stdout. Ela nunca vai para disco nem para log; o arquivo guarda
# apenas o sha256 dela. Contrato com o web: web/lib/primeiro-acesso.js.
gerar_primeiro_acesso() {
    local usuario="$1" tk hash criado
    tk="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
    hash="$(printf '%s' "$tk" | sha256sum | cut -d' ' -f1)"
    criado="$(agora_ms)"
    printf '{"versao":1,"usuario":"%s","token_sha256":"%s","criado":%s,"expira":%s,"usado_em":null}\n' \
        "$usuario" "$hash" "$criado" "$((criado + 30 * 60 * 1000))" \
        | escrever_arquivo "$DG_ETC/primeiro-acesso.json" 600 >&2
    printf '%s' "$tk"
}

# garantir_pular_aviso_bypass <caminho do settings.json> [modo] [uid:gid]
# Poe `"skipDangerousModePermissionPrompt": true` no settings do Claude Code, sem perder nada
# do que ja existe. Por que: desde o Claude Code 2.x, no modo bypassPermissions ele abre o aviso
# "Bypass Permissions mode ... 1. No, exit / 2. Yes, I accept" a cada boot; o Enter do runner
# escolhe o padrao ("No, exit") e o agente cai em loop (16/10/2026). So esta chave resolve:
# `bypassPermissionsModeAccepted` no ~/.claude.json nao.
# - arquivo ausente ou vazio: cria so com a chave;
# - JSON valido (objeto): mescla com jq, preservando o resto;
# - JSON invalido: NAO mexe, avisa com o caminho e o que fazer (devolve 0: o resto da
#   instalacao segue, mas a pessoa fica sabendo).
# Modo e dono: os pedidos; sem pedido, os que o arquivo ja tem (ou 644 e o dono de quem roda).
garantir_pular_aviso_bypass() {
    local alvo="$1" modo="${2:-}" quem="${3:-}" novo
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] poria skipDangerousModePermissionPrompt=true em %s (sem apagar o que ja existe)\n' "$alvo"
        return 0
    fi
    if [ -s "$alvo" ]; then
        if ! jq -e 'type == "object"' "$alvo" >/dev/null 2>&1; then
            aviso "$alvo nao e um JSON valido (objeto); nao mexi nele. O Claude Code vai abrir o aviso do modo Bypass e o agente nao sobe sozinho. Corrija o arquivo (ou apague-o, se nao tiver nada seu) e rode de novo, ou acrescente a mao: \"skipDangerousModePermissionPrompt\": true"
            return 0
        fi
        if jq -e '.skipDangerousModePermissionPrompt == true' "$alvo" >/dev/null 2>&1; then
            return 0
        fi
        [ -n "$modo" ] || modo="$(stat -c '%a' "$alvo")"
        [ -n "$quem" ] || quem="$(stat -c '%u:%g' "$alvo")"
        novo="$(jq '. + {skipDangerousModePermissionPrompt: true}' "$alvo")" \
            || falha "o jq nao conseguiu mesclar a chave em $alvo." "confira se o arquivo e um JSON valido (jq . $alvo) e rode de novo."
    else
        novo='{"skipDangerousModePermissionPrompt": true}'
    fi
    printf '%s\n' "$novo" | escrever_arquivo "$alvo" "${modo:-644}" "$quem"
}

# garantir_gancho_runner <runner.json> <slug> <comando> <rotulo>
# Poe <comando> em .config.promptHooks do runner.json, sem perder os outros itens nem o resto do
# arquivo. Por que: agentes criados antes de um gancho existir nao o tem, e o `agente reparar` e o
# caminho para eles ganharem sem recriar.
# - arquivo ausente: nao faz nada (o criar escreve ja com os ganchos);
# - ja tem o gancho: nao toca no arquivo;
# - JSON ilegivel (ou promptHooks que nao e lista): falha dizendo onde e o que fazer, sem sobrescrever;
# - o runner so le o arquivo ao iniciar: avisa qual comando reinicia.
garantir_gancho_runner() {
    local alvo="$1" slug="${2:-<slug>}" gancho="$3" rotulo="$4" novo
    [ -f "$alvo" ] || return 0
    if ! jq -e '(.config | type) == "object" and ((.config.promptHooks // []) | type) == "array"' "$alvo" >/dev/null 2>&1; then
        falha "o runner.json $alvo nao e um JSON valido com \"config\" e, se houver, \"promptHooks\" como lista; nao mexi nele." \
            "confira com: jq . $alvo (corrija o JSON ou, se nao tiver nada seu, apague o arquivo e rode: dgclaw agente reparar $slug)."
    fi
    if jq -e --arg g "$gancho" '(.config.promptHooks // []) | index($g) != null' "$alvo" >/dev/null; then
        return 0
    fi
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] poria o gancho %s em promptHooks de %s (sem apagar o que ja existe)\n' "$rotulo" "$alvo"
        return 0
    fi
    novo="$(jq --arg g "$gancho" '.config.promptHooks = ((.config.promptHooks // []) + [$g])' "$alvo")" \
        || falha "o jq nao conseguiu acrescentar o gancho em $alvo." "confira se o arquivo e um JSON valido (jq . $alvo) e rode de novo."
    printf '%s\n' "$novo" | escrever_arquivo "$alvo" 444 0:0
    ok "gancho $rotulo acrescentado ao runner.json"
    info "ele entra quando o runner reiniciar: dgclaw agente reiniciar $slug"
}

# garantir_gancho_foco <runner.json> [slug]
garantir_gancho_foco() {
    garantir_gancho_runner "$1" "${2:-<slug>}" "node /opt/dgclaw/app/scripts/foco-hook.mjs" "do Modo foco"
}

# garantir_gancho_novidades <runner.json> [slug]
# O aviso de novidades depois de atualizar (docs/NOVIDADES.md). Agente antigo, sem arquivo de visto,
# recebe o aviso uma vez na primeira conversa depois que o runner reiniciar com o gancho.
garantir_gancho_novidades() {
    garantir_gancho_runner "$1" "${2:-<slug>}" "node /opt/dgclaw/app/scripts/novidades-hook.mjs" "de novidades"
}

# gerar_segredo <caminho> [uid:gid]
# 32 bytes aleatorios em hexadecimal. So cria se nao existir: rodar de novo nao
# troca o segredo de ninguem (trocar derrubaria a conversa entre Web e runner).
gerar_segredo() {
    local alvo="$1" quem="${2:-}"
    if [ -s "$alvo" ]; then return 0; fi
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] geraria um segredo novo em %s (modo 600)\n' "$alvo"
        return 0
    fi
    mkdir -p "$(dirname "$alvo")"
    ( umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$alvo" )
    chmod 600 "$alvo"
    [ -n "$quem" ] && dono "$quem" "$alvo"
    return 0
}

# dono <uid:gid> <caminho...>
# Em producao e um chown comum. Nos testes (raiz falsa, sem root) o chown para o
# uid de um agente nao e possivel; ai so registra, porque o que o teste confere
# e o resto (modo, conteudo, lugar), e falhar aqui esconderia isso.
dono() {
    local quem="$1"; shift
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] chown %s %s\n' "$quem" "$*"
        return 0
    fi
    if [ -n "$R" ] && [ "$(id -u)" -ne 0 ]; then
        printf '%s %s\n' "$quem" "$*" >>"$R/.chown-simulado"
        return 0
    fi
    # -h: se o caminho for um link, muda o link e nunca o alvo (um link plantado na casa
    # de um agente nao pode dar a ele a posse de um arquivo do servidor).
    chown -h "$quem" "$@"
}

# com_trava <comando...>
# Serializa quem mexe no agentes.json e no registro.tsv: dois `agente criar` ao
# mesmo tempo nao podem pegar a mesma faixa de uid nem a mesma porta.
com_trava() {
    if [ "$ENSAIO" = 1 ]; then "$@"; return; fi
    mkdir -p "$(dirname "$DG_TRAVA")"
    (
        flock -w 30 9 || falha "outro comando do DG Claw esta segurando $DG_TRAVA ha mais de 30 segundos." \
            "espere ele terminar e rode de novo. Se nada estiver rodando, confira com: fuser $DG_TRAVA"
        "$@"
    ) 9>"$DG_TRAVA"
}

# definir_linha_env <arquivo> <CHAVE> <valor> [modo]
# Poe CHAVE=valor num arquivo de configuracao (dgclaw.env, web.env...) sem reescrever o resto:
# troca a linha no lugar se ela ja existe, acrescenta no fim se nao existe, e deixa TODAS as
# outras linhas (inclusive as que a pessoa poe la, como chaves de API) na ordem em que estavam.
# Regra do projeto: arquivo de configuracao que ja existe se edita linha a linha.
definir_linha_env() {
    local arq="$1" chave="$2" valor="$3" modo="${4:-644}"
    if [ ! -f "$arq" ]; then
        printf '%s=%s\n' "$chave" "$valor" | escrever_arquivo "$arq" "$modo"
        return 0
    fi
    # O modo do arquivo que ja existe vence: web.env e 600 e nao pode virar 644 por aqui.
    modo="$(stat -c '%a' "$arq")"
    NOVO_K="$chave" NOVO_V="$valor" awk '
        BEGIN {k = ENVIRON["NOVO_K"]; linha = k "=" ENVIRON["NOVO_V"]}
        index($0, k "=") == 1 {if (!feito) print linha; feito = 1; next}
        {print}
        END {if (!feito) print linha}' "$arq" | escrever_arquivo "$arq" "$modo"
}

# git_do_clone <pasta> <argumentos do git...>: git em outro clone, sem pergunta de senha e sem
# o bloqueio "dubious ownership" (o clone pode ser de outro usuario, e quem roda aqui e o root).
git_do_clone() {
    local repo="$1"; shift
    GIT_TERMINAL_PROMPT=0 git -c safe.directory="$repo" -C "$repo" "$@"
}

# modelo_admin_sha_de_fabrica <sha256> <CLAUDE.md|AGENTS.md> <clone>
# Sai com 0 se esse conteudo e exatamente o de alguma versao ja publicada do modelo do Admin
# (a do clone agora ou qualquer uma do historico dele). E assim que se distingue o arquivo que
# veio de fabrica (pode ser trocado pelo novo) do que a pessoa personalizou (nao pode).
# Sem historico git (zip), so a versao do clone conta: o resto cai em "personalizado", o lado
# seguro, porque nesse caso o instalador grava o novo ao lado, como <arquivo>.novo.
modelo_admin_sha_de_fabrica() {
    local sha="$1" nome="$2" repo="$3" atual rev
    if [ -f "$repo/templates/admin/$nome" ]; then
        atual="$(sha256sum <"$repo/templates/admin/$nome" | cut -d' ' -f1)"
        if [ "$atual" = "$sha" ]; then return 0; fi
    fi
    git_do_clone "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 1
    while read -r rev; do
        [ -n "$rev" ] || continue
        atual="$(git_do_clone "$repo" show "$rev:templates/admin/$nome" 2>/dev/null | sha256sum | cut -d' ' -f1)"
        if [ "$atual" = "$sha" ]; then return 0; fi
    done < <(git_do_clone "$repo" log --all --format=%H -- "templates/admin/$nome" 2>/dev/null)
    return 1
}

# carregar_env_dgclaw: le o /etc/dgclaw/dgclaw.env se existir (dominio, imagem...).
carregar_env_dgclaw() {
    if [ -f "$DG_ETC/dgclaw.env" ]; then
        # shellcheck disable=SC1091
        . "$DG_ETC/dgclaw.env"
    fi
    DGCLAW_IMAGEM="${DGCLAW_IMAGEM:-$DG_IMAGEM_PADRAO}"
}

# --- dominio e Caddy (usados pelo install.sh e por `dgclaw dominio`) ------------------
# ip_publico: o IP publico desta maquina (imprime so ele); falha se nenhum servico responder.
ip_publico() {
    local url ip
    for url in https://api.ipify.org https://ifconfig.me; do
        # Se o primeiro servico falhar, o segundo e a reserva: por isso o erro aqui nao para nada.
        ip="$(curl --proto '=https' --tlsv1.2 -fsS --max-time 10 "$url" 2>/dev/null)" || continue
        if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
            printf '%s' "$ip"
            return 0
        fi
    done
    return 1
}

# dns_publico_aponta <host> <ip>: 1.1.1.1 E 8.8.8.8 precisam devolver o IP.
# Nunca a resolucao local: na Hostinger o /etc/hosts aponta o nome da maquina para 127.0.1.1.
dns_publico_aponta() {
    local host="$1" ip="$2" servidor resp
    for servidor in 1.1.1.1 8.8.8.8; do
        # Sem resposta (timeout, sem internet para o DNS) significa "nao aponta".
        resp="$(dig +short +time=3 +tries=1 "@$servidor" "$host" A 2>/dev/null)" || resp=""
        # Here-string, sem pipe: com pipefail, `printf | grep -q` pode devolver 141 (SIGPIPE)
        # mesmo achando o IP, e isso viraria um falso "o dominio nao aponta para ca".
        if ! grep -qFx -- "$ip" <<<"$resp"; then return 1; fi
    done
    return 0
}

caddyfile_e_padrao() {
    local cf="$1" sites
    grep -q 'root \* /usr/share/caddy' "$cf" || return 1
    sites="$(grep -E '^[^[:space:]#}].*\{[[:space:]]*$' "$cf" || true)" # sem blocos = nenhum site proprio
    [ "$sites" = ":80 {" ]
}

bloco_caddy() {
    printf '# DG Claw: gerado pelo install.sh. Rodar o instalador de novo reescreve este arquivo.\n'
    printf '%s {\n\treverse_proxy 127.0.0.1:8300\n}\n' "$1"
}

# escrever_site_caddy <dominio>: grava o site do DG Claw no Caddyfile proprio (quando e dele ou
# padrao) ou em conf.d/dgclaw.caddy (quando o Caddyfile tem sites de outros). Nao valida nem recarrega.
escrever_site_caddy() {
    local dominio="$1" cf="$R/etc/caddy/Caddyfile" confd="$R/etc/caddy/conf.d/dgclaw.caddy"
    if [ ! -f "$cf" ] || grep -q '^# DG Claw' "$cf" || caddyfile_e_padrao "$cf"; then
        bloco_caddy "$dominio" | escrever_arquivo "$cf" 644
    else
        # Ja existe um Caddyfile com sites de verdade: nao se sobrescreve o que e dos outros.
        if ! grep -Eq '^[[:space:]]*import[[:space:]]+.*conf\.d/\*' "$cf"; then
            falha "o Caddyfile em ${cf#"$R"} ja tem outros sites e nao importa a pasta conf.d, entao nao tenho onde colocar o do DG Claw sem mexer no seu." \
                "acrescente a linha 'import conf.d/*' no topo do arquivo (fora de qualquer bloco) e rode ./install.sh de novo. Ele vai criar ${confd#"$R"} com o site do DG Claw."
        fi
        bloco_caddy "$dominio" | escrever_arquivo "$confd" 644
        info "o Caddyfile existente foi preservado; o site do DG Claw ficou em ${confd#"$R"}"
    fi
}

# --- inotify ---------------------------------------------------------------------
# Os containers dos agentes sao criados pelo root (podman rootful, --uidmap
# 0:<uid_base>:65536) e os ucounts do kernel sao hierarquicos por user namespace: as
# instancias de inotify de dentro de cada container contam para o root do host. Cada
# agente gasta de 5 a 6. O padrao do Ubuntu 24.04 e 128; sem folga o container sai
# com codigo 255 e sem log ("Failed to create control group inotify object").

# inotify_limite: imprime o max_user_instances atual; vazio se nao der para ler.
inotify_limite() {
    local arq="$R/proc/sys/fs/inotify/max_user_instances" v=""
    if [ -r "$arq" ]; then
        v="$(tr -d '[:space:]' <"$arq" 2>/dev/null)" || v="" # arquivo que sumiu no meio: trata como ilegivel
    fi
    case "$v" in ''|0|*[!0-9]*) v="" ;; esac
    printf '%s' "$v"
}

# inotify_uso_root: imprime quantas instancias de inotify pesam no root, ou seja, as
# abertas por processos de uid 0 ou de uid >= 1000000 (a faixa dos agentes).
# E uma aproximacao POR CIMA: um fd herdado por fork conta duas vezes.
# O 2>/dev/null do find e dos awk e proposital: processo que morre durante a varredura
# faz o /proc/<pid> sumir e o find reclamar, e isso nao e erro de quem le.
inotify_uso_root() {
    local total=0 n dir pid uid
    while read -r n dir; do
        pid="${dir%/fd}"; pid="${pid##*/}"
        uid="$(awk '/^Uid:/ { print $2; exit }' "$R/proc/$pid/status" 2>/dev/null)" || uid=""
        case "$uid" in ''|*[!0-9]*) continue ;; esac
        if [ "$uid" -eq 0 ] || [ "$uid" -ge 1000000 ]; then total=$((total + n)); fi
    done < <(find "$R/proc" -mindepth 3 -maxdepth 3 -path "$R/proc/[0-9]*/fd/*" -lname 'anon_inode:inotify' -printf '%h\n' 2>/dev/null | sort | uniq -c)
    printf '%s' "$total"
}
