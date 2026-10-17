#!/usr/bin/env bash
# install.sh: instala o DG Claw v1 no servidor (o "host").
#
#   sudo ./install.sh --usuario <nome> [--dominio <dominio>] [--provedor claude|codex]
#                     [--senha-stdin] [--novo-primeiro-acesso]
#                     [--ensaio] [--com-imagem] [--sem-imagem] [--ajuda]
#
# O padrao e NAO pedir senha: o instalador gera um link de primeiro acesso (uso unico, vale
# 30 min) e a pessoa cadastra a senha no navegador. Assim a senha nunca aparece no terminal
# (que pode estar projetado numa aula). Quem quiser mesmo pode mandar a senha pelo STDIN
# (nunca por argumento, que aparece no `ps` e no historico do shell); a senha nunca e impressa.
#
# O que ele faz, nesta ordem (cada passo imprime o que esta fazendo):
#   1. confere a maquina (Ubuntu, root, memoria, disco, portas 80 e 443)
#   2. instala os pacotes (podman, Caddy, Node 22, git, jq, ufw...)
#   3. escolhe o endereco (dominio) do painel
#   4. copia o DG Claw para /opt/dgclaw/app
#   5. configura o Caddy (HTTPS automatico)
#   6. configura o firewall (ufw para fora, cerca de rede para os containers)
#   7. guarda o usuario e o HASH da senha do painel
#   8. liga o DG Claw Web
#   9. liga o Admin, o agente de sistema que cria os outros agentes
#  10. manda construir a imagem dos agentes, em segundo plano
#  11. testa de ponta a ponta e da o primeiro boot ao Admin
#
# Rodar de novo e seguro: o que ja esta feito e so conferido, nada duplica, e os
# segredos que ja existem nao sao trocados. `--ensaio` mostra o que seria feito
# sem mudar nada.
#
# Tudo fica dentro de funcoes e `main` e chamada na ultima linha: se o arquivo
# chegar cortado, o bash nao executa meio script.
#
# Variaveis de teste (so valem com DGCLAW_RAIZ definida, para rodar numa raiz falsa):
#   DGCLAW_RAIZ=<pasta>          prefixa /etc, /opt, /var, /usr/local
#   DGCLAW_PULAR_CHECAGENS=1     pula root, Ubuntu, memoria, disco e portas
#   DGCLAW_SENHA_HASH_CMD=<exe>  troca o gerador de hash (le a senha no STDIN)
# Vale sempre: DGCLAW_ESPERA_CERT=<segundos> (padrao 90) espera pelo certificado HTTPS.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

USUARIO=""
DOMINIO_ARG=""
PROVEDOR_ARG=""
ARG_ENSAIO=0
SEM_IMAGEM=1
SENHA=""
ARG_SENHA_STDIN=0
ARG_NOVO_PRIMEIRO_ACESSO=0
PRIMEIRO_ACESSO_TOKEN=""
SENHA_NOVA=0
DOMINIO=""
PROVEDOR=""
VERSAO=""
LOG_INSTALAR=""

uso() {
    cat <<'FIM'
Uso: sudo ./install.sh --usuario <nome> [opcoes]

Instala o DG Claw neste servidor: painel com HTTPS, Admin e a base para criar agentes.

  --usuario <nome>      usuario para entrar no painel (obrigatorio)
  --dominio <dominio>   endereco proprio (padrao: um endereco gratuito, escolhido sozinho)
  --provedor claude|codex
                        com qual assinatura o Admin trabalha (padrao: o que estiver logado aqui)
  --senha-stdin         le a senha do painel do STDIN (sem esperar; erro se vier vazia ou curta)
  --novo-primeiro-acesso
                        gera um link de primeiro acesso novo mesmo que o painel ja tenha senha
                        (a senha antiga vale ate o link ser usado)
  --ensaio              mostra o que faria, passo a passo, sem mudar nada
  --com-imagem          adianta a preparacao dos agentes em segundo plano (opcional)
  --sem-imagem          prepara so o painel e o Admin (padrao; agentes depois pelo painel)
  --ajuda               mostra esta ajuda

Senha do painel: o padrao e nao informar nenhuma. No fim, o instalador mostra um link de
primeiro acesso (uso unico, vale 30 minutos): voce abre, cadastra a senha no navegador e ja
entra no painel. Se o link expirar, gere outro com: sudo dgclaw primeiro-acesso
Se preferir definir a senha aqui (minimo 12 caracteres), ela entra pelo STDIN, nunca na linha
de comando, e nunca e mostrada de volta:
  - num terminal, o script pergunta (Enter pula e gera o link);
  - por um pipe: leia a senha sem eco e mande para o script, por exemplo
        read -rs SENHA; printf '%s\n' "$SENHA" | sudo ./install.sh --usuario voce
  - com --senha-stdin, a senha e obrigatoria no STDIN.
Ao rodar de novo, se nenhuma senha chegar, a atual continua valendo.
FIM
}

# --- argumentos -----------------------------------------------------------------
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --usuario)  [ $# -ge 2 ] || arg_sem_valor "$1"; USUARIO="$2"; shift 2 ;;
            --usuario=*) USUARIO="${1#*=}"; shift ;;
            --dominio)  [ $# -ge 2 ] || arg_sem_valor "$1"; DOMINIO_ARG="$2"; shift 2 ;;
            --dominio=*) DOMINIO_ARG="${1#*=}"; shift ;;
            --provedor) [ $# -ge 2 ] || arg_sem_valor "$1"; PROVEDOR_ARG="$2"; shift 2 ;;
            --provedor=*) PROVEDOR_ARG="${1#*=}"; shift ;;
            --ensaio)   ARG_ENSAIO=1; shift ;;
            --senha-stdin) ARG_SENHA_STDIN=1; shift ;;
            --novo-primeiro-acesso) ARG_NOVO_PRIMEIRO_ACESSO=1; shift ;;
            --com-imagem) SEM_IMAGEM=0; shift ;;
            --sem-imagem) SEM_IMAGEM=1; shift ;;
            --ajuda|-h|--help) uso; exit 0 ;;
            *) printf 'Nao deu certo: nao conheco a opcao "%s".\nO que fazer: rode ./install.sh --ajuda para ver as opcoes.\n' "$1" >&2; exit 1 ;;
        esac
    done
}

# Antes de carregar lib/comum.sh ainda nao existe a funcao `falha`.
arg_sem_valor() {
    printf 'Nao deu certo: a opcao %s precisa de um valor.\nO que fazer: rode ./install.sh --ajuda para ver o formato.\n' "$1" >&2
    exit 1
}

validar_args() {
    [ -n "$USUARIO" ] || falha "faltou dizer o usuario do painel (--usuario)." \
        "rode de novo com --usuario <nome>, por exemplo: sudo ./install.sh --usuario maria"
    [[ "$USUARIO" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || falha "o usuario '$USUARIO' tem caracteres que nao posso aceitar." \
        "use de 1 a 32 caracteres entre letras, numeros, ponto, hifen e sublinhado."
    if [ -n "$DOMINIO_ARG" ]; then
        [[ "$DOMINIO_ARG" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || falha "o dominio '$DOMINIO_ARG' nao parece um endereco valido." \
            "use so o nome, sem https:// e sem barra, por exemplo: painel.minhaempresa.com.br"
    fi
    case "$PROVEDOR_ARG" in
        ""|claude|codex) ;;
        *) falha "o provedor '$PROVEDOR_ARG' nao existe." "use --provedor claude ou --provedor codex." ;;
    esac
}

# --- utilidades -----------------------------------------------------------------

# env_valor <VARIAVEL>: le um valor do dgclaw.env sem dar `source` (o arquivo e so dado).
env_valor() {
    [ -f "$DG_ETC/dgclaw.env" ] || return 0
    sed -n "s/^$1=//p;T;q" "$DG_ETC/dgclaw.env"
}

# fonte_tem <caminho relativo>: o arquivo existe no repo que esta sendo instalado?
# Olha a pasta de origem (e nao /opt/dgclaw/app) porque no ensaio nada foi copiado.
fonte_tem() { [ -e "$SCRIPT_DIR/$1" ]; }

# executar_log <comando...>: como `executar`, mas a saida longa (apt, npm) vai para
# o instalar.log e, se falhar, mostra o fim dele. Nada de ruido de apt na tela.
executar_log() {
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] %s\n' "$*"
        return 0
    fi
    local rc=0
    printf '\n$ %s\n' "$*" >>"$LOG_INSTALAR"
    "$@" </dev/null >>"$LOG_INSTALAR" 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
        printf '\n--- ultimas linhas de %s ---\n' "$LOG_INSTALAR" >&2
        tail -n 15 "$LOG_INSTALAR" >&2
        falha "o comando '$*' terminou com codigo $rc." \
            "leia as linhas acima (o registro completo esta em ${LOG_INSTALAR#"$R"}); depois rode ./install.sh de novo, e seguro repetir."
    fi
}

# npm_em <pasta> <argumentos do npm...>: roda o npm DENTRO da pasta (mais confiavel
# que --prefix para `ci` e `run`), com a saida no registro.
npm_em() {
    local dir="$1"; shift
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] (cd %s && npm %s)\n' "$dir" "$*"
        return 0
    fi
    # shellcheck disable=SC2016 # $1 e $@ sao do bash -c, nao deste shell
    executar_log bash -c 'cd "$1" && shift && exec npm "$@"' _ "$dir" "$@"
}

criar_pasta() { executar install -d -m "$1" "$2"; }

# ligar_unidade <unidade>: recarrega o systemd e liga a unidade ao boot.
# Se ela ja estava rodando (reexecucao), o novo codigo so vale depois de reiniciar:
# reinicia quando e seguro, e avisa quando nao e (o Admin pode ser quem esta rodando isto).
ligar_unidade() {
    local unidade="$1" modo="${2:-reiniciar}"
    executar systemctl daemon-reload
    executar systemctl enable "$unidade"
    if systemctl is-active --quiet "$unidade"; then
        if [ "$modo" = reiniciar ]; then
            executar systemctl restart "$unidade"
        else
            aviso "$unidade ja estava rodando e continua com o codigo anterior. Para usar o novo: systemctl restart $unidade"
        fi
    else
        executar systemctl start "$unidade"
    fi
}

tem_jq() { command -v jq >/dev/null 2>&1; }

# --- senha ---------------------------------------------------------------------
tem_senha_guardada() {
    local hash=""
    [ -s "$DG_ETC/web.env" ] || return 1
    hash="$(sed -n "s/^DGCLAW_PANEL_PASSWORD_HASH='\(.*\)'$/\1/p;T;q" "$DG_ETC/web.env")"
    [[ "$hash" == scrypt\$* ]]
}

ler_senha() {
    local linha="" confirma=""
    if [ "$ARG_SENHA_STDIN" = 1 ]; then
        if [ "$ENSAIO" = 1 ]; then
            info "(ensaio) a senha do painel nao e lida."
            return 0
        fi
        if IFS= read -r linha; then :; fi
        [ -n "${linha%$'\r'}" ] || falha "a opcao --senha-stdin foi usada, mas a senha nao chegou pelo STDIN (veio vazia)." \
            "mande a senha pelo STDIN: read -rs SENHA; printf '%s\n' \"\$SENHA\" | sudo ./install.sh --usuario $USUARIO --senha-stdin"
    elif [ -t 0 ]; then
        if [ "$ENSAIO" = 1 ]; then
            info "(ensaio) a senha do painel nao e pedida."
            return 0
        fi
        local dica="digite a senha do painel (minimo 12 caracteres), ou Enter para receber um link de primeiro acesso"
        if tem_senha_guardada; then dica="digite a senha do painel (minimo 12 caracteres), ou Enter para manter a atual"; fi
        read -rsp "   $dica: " linha || true # EOF no terminal = Enter vazio
        printf '\n' >&2
        if [ -n "$linha" ]; then
            read -rsp "   repita a senha: " confirma || true
            printf '\n' >&2
            [ "$linha" = "$confirma" ] || falha "as duas senhas digitadas sao diferentes." "rode ./install.sh de novo e digite a mesma senha nas duas vezes."
        fi
    else
        # Pipe antigo (printf senha | ./install.sh): tenta uma linha, por 2 segundos. Nada chegou
        # (vazio, EOF, /dev/null, timeout) = segue sem senha, com link de primeiro acesso.
        if [ "$ENSAIO" = 1 ]; then
            info "(ensaio) a senha do painel nao e lida."
            return 0
        fi
        if IFS= read -r -t 2 linha; then :; fi
    fi
    SENHA="${linha%$'\r'}"
    if [ -n "$SENHA" ] && [ "${#SENHA}" -lt 12 ]; then
        falha "a senha tem ${#SENHA} caracteres e o minimo e 12." \
            "escolha uma senha maior (uma frase curta serve) e rode ./install.sh de novo, ou nao informe senha para receber o link de primeiro acesso."
    fi
}

# --- 1. checagens ---------------------------------------------------------------
pular_checagens() { [ -n "$R" ] && [ "${DGCLAW_PULAR_CHECAGENS:-}" = 1 ]; }

checar_portas() {
    # Imagens Ubuntu mínimas podem vir sem ss. A checagem precisa preparar a
    # ferramenta antes de usá-la, sem obrigar o dono a voltar ao terminal.
    if ! command -v ss >/dev/null 2>&1; then
        criar_pasta 750 "$DG_LOG"
        executar_log apt-get update
        executar_log apt-get install -y --no-install-recommends iproute2
    fi
    local linhas loc proc porta nome ocupadas=""
    linhas="$(ss -ltnpH 2>/dev/null)" || falha "nao consegui rodar 'ss -ltnp' para ver as portas em uso." \
        "instale o pacote iproute2 (apt-get install -y iproute2) e rode de novo."
    while read -r _ _ _ loc _ proc; do
        [ -n "$loc" ] || continue
        porta="${loc##*:}"
        if [ "$porta" != 80 ] && [ "$porta" != 443 ]; then continue; fi
        nome="$(printf '%s' "$proc" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p')"
        # Caddy na 80/443 e o nosso proprio servidor de uma instalacao anterior.
        if [ "$nome" = caddy ]; then continue; fi
        ocupadas="$ocupadas porta $porta (${nome:-processo que nao consegui identificar});"
    done <<<"$linhas"
    if [ -n "$ocupadas" ]; then
        falha "estas portas ja estao em uso:$ocupadas" \
            "o HTTPS do painel precisa das portas 80 e 443. Pare o programa que as usa (por exemplo: systemctl stop nginx apache2), ou use outro servidor para ele; depois rode de novo."
    fi
}

# Confere a versao do sistema lendo "$R/etc/os-release" (em producao R e vazio, entao e o
# /etc/os-release de sempre). Fica separada para os testes poderem exercitar so esta parte.
checar_versao_so() {
    local so
    [ -r "$R/etc/os-release" ] || falha "nao achei /etc/os-release, entao nao sei qual sistema e este." "o DG Claw v1 instala em Ubuntu 22.04, 24.04 ou 26.04."
    # shellcheck source=/dev/null
    so="$(. "$R/etc/os-release" && printf '%s %s' "${ID:-?}" "${VERSION_ID:-?}")"
    # 22.04 e 24.04 sao as versoes testadas. O 26.04 ja instalou do comeco ao fim (imersao de
    # 17/10/2026), entao entra com aviso e sem pergunta: a pessoa ja criou a VPS e vai instalar
    # de qualquer jeito. Outras versoes seguem recusadas ate alguem testar.
    case "$so" in
        "ubuntu 22.04"|"ubuntu 24.04") ok "sistema: $so" ;;
        "ubuntu 26.04")
            ok "sistema: $so"
            aviso "O DG Claw foi feito e testado no Ubuntu 24.04. O 26.04 tem funcionado, mas pode apresentar alguma instabilidade. Vou instalar mesmo assim." ;;
        *) falha "este sistema e '$so' e o DG Claw v1 so instala em Ubuntu 22.04, 24.04 ou 26.04." \
               "crie um servidor com Ubuntu 24.04 e rode o instalador nele." ;;
    esac
}

checar_maquina() {
    passo "Conferindo a maquina"
    if pular_checagens; then
        # Raiz falsa dos testes: o resto e pulado, mas a versao do sistema ainda vale conferir
        # quando o teste forneceu um os-release.
        if [ -r "$R/etc/os-release" ]; then checar_versao_so; fi
        info "checagens da maquina puladas (teste com raiz falsa)."
        return 0
    fi
    local mem_kb disco_kb
    checar_versao_so
    [ "$(id -u)" -eq 0 ] || falha "o instalador precisa rodar como root (voce e o usuario $(id -un))." \
        "rode com sudo: sudo ./install.sh --usuario $USUARIO"
    ok "rodando como root"
    mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
    # 2 GB de RAM aparecem como ~1,9 GB na conta, porque o kernel reserva uma parte.
    [ "${mem_kb:-0}" -ge 1887436 ] || falha "a memoria e de $(( ${mem_kb:-0} / 1024 )) MB e o minimo e 2 GB." \
        "use um servidor com pelo menos 2 GB de RAM (o ideal para varios agentes e 4 GB)."
    ok "memoria: $(( mem_kb / 1024 )) MB"
    disco_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
    [ "${disco_kb:-0}" -ge 15728640 ] || falha "o disco tem $(( ${disco_kb:-0} / 1048576 )) GB livres e o minimo e 15 GB." \
        "libere espaco em / ou use um servidor com disco maior (a imagem dos agentes ocupa varios GB)."
    ok "disco livre: $(( disco_kb / 1048576 )) GB"
    checar_portas
    ok "portas 80 e 443 livres (ou ja do Caddy)"
}

# --- 2. pacotes -----------------------------------------------------------------
pacote_instalado() {
    local st
    st="$(dpkg -s "$1" 2>/dev/null)" || return 1
    [[ "$st" == *"Status: install ok installed"* ]]
}

# baixar_chave <url> <destino.gpg>: baixa a chave do repositorio e converte para o formato do apt.
# Fica em /usr/share/keyrings e cada repositorio aponta so para a SUA chave (signed-by).
baixar_chave() {
    local url="$1" destino="$2" tmp
    if [ -s "$destino" ]; then
        ok "chave ja existe: ${destino#"$R"}"
        return 0
    fi
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] baixaria %s e gravaria %s\n' "$url" "${destino#"$R"}"
        return 0
    fi
    mkdir -p "$(dirname "$destino")"
    tmp="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp" "$url" \
        || { rm -f "$tmp"; falha "nao consegui baixar a chave do repositorio em $url." "confira se o servidor tem internet (curl -I https://deb.nodesource.com) e rode de novo."; }
    gpg --dearmor --yes -o "$destino" "$tmp" \
        || { rm -f "$tmp"; falha "o gpg nao conseguiu converter a chave baixada de $url." "rode de novo; se repetir, o repositorio pode estar fora do ar."; }
    rm -f "$tmp"
    chmod 644 "$destino"
}

instalar_pacotes() {
    passo "Instalando os pacotes"
    local base=(curl ca-certificates gnupg) faltam=() p
    local todos=(podman uidmap git jq ufw dnsutils rsync python3 build-essential)
    local precisa_caddy=0 precisa_node=0 repos_novos=0
    local chave_caddy="$R/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
    local lista_caddy="$R/etc/apt/sources.list.d/caddy-stable.list"
    local chave_node="$R/usr/share/keyrings/nodesource.gpg"
    local lista_node="$R/etc/apt/sources.list.d/nodesource.list"

    criar_pasta 750 "$DG_LOG"

    executar_log apt-get update
    for p in "${base[@]}"; do pacote_instalado "$p" || faltam+=("$p"); done
    if [ "${#faltam[@]}" -gt 0 ]; then
        executar_log env DEBIAN_FRONTEND=noninteractive apt-get install -y "${faltam[@]}"
    fi

    # Rede dos containers rootless: o podman 4 (22.04 e 24.04) usa o slirp4netns e o podman 5
    # (26.04) usa o passt. Cada um so entra se o apt conhece, porque versao nova do Ubuntu pode
    # tirar o slirp4netns do repositorio; sem nenhum dos dois o agente nao tem rede.
    if apt-cache show slirp4netns >/dev/null 2>&1; then todos+=(slirp4netns); fi
    if apt-cache show passt >/dev/null 2>&1; then todos+=(passt); fi
    case " ${todos[*]} " in
        *" slirp4netns "*|*" passt "*) ;;
        *) falha "o apt nao conhece nem o pacote slirp4netns nem o passt, e um dos dois e a rede dos agentes." \
               "rode apt-get update e confira com: apt-cache policy slirp4netns passt. Se nenhum aparecer, use um servidor com Ubuntu 24.04." ;;
    esac

    if ! pacote_instalado caddy; then precisa_caddy=1; fi
    local major
    major="$(node -v 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p')" || major=""
    if [ "${major:-0}" -lt 22 ]; then precisa_node=1; fi

    if [ "$precisa_caddy" = 1 ]; then
        baixar_chave "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" "$chave_caddy"
        if [ ! -s "$lista_caddy" ]; then
            printf 'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' \
                | escrever_arquivo "$lista_caddy" 644
            repos_novos=1
        fi
        todos+=(caddy)
    else
        ok "caddy ja instalado"
    fi
    if [ "$precisa_node" = 1 ]; then
        baixar_chave "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" "$chave_node"
        if [ ! -s "$lista_node" ]; then
            printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' \
                | escrever_arquivo "$lista_node" 644
            repos_novos=1
        fi
        todos+=(nodejs)
    else
        ok "Node ${major} ja instalado"
    fi
    if [ "$repos_novos" = 1 ]; then executar_log apt-get update; fi

    faltam=()
    for p in "${todos[@]}"; do
        # nodejs ja instalado em versao velha precisa ser atualizado, nao pulado.
        if [ "$p" = nodejs ] && [ "$precisa_node" = 1 ]; then faltam+=("$p"); continue; fi
        pacote_instalado "$p" || faltam+=("$p")
    done
    if [ "${#faltam[@]}" -gt 0 ]; then
        info "instalando: ${faltam[*]} (a saida completa vai para ${LOG_INSTALAR#"$R"})"
        executar_log env DEBIAN_FRONTEND=noninteractive apt-get install -y "${faltam[@]}"
    else
        ok "todos os pacotes ja estao instalados"
    fi
}

# --- 3. dominio -----------------------------------------------------------------
escolher_dominio() {
    passo "Escolhendo o endereco do painel"
    local atual ip nome
    atual="$(env_valor DGCLAW_DOMINIO)"
    if [ -n "$DOMINIO_ARG" ]; then
        DOMINIO="$DOMINIO_ARG"
        ok "dominio informado por voce: $DOMINIO"
        return 0
    fi
    if [ -n "$atual" ]; then
        DOMINIO="$atual"
        ok "mantendo o dominio da instalacao anterior: $DOMINIO"
        return 0
    fi
    ip="$(ip_publico)" || falha "nao consegui descobrir o IP publico deste servidor (api.ipify.org e ifconfig.me nao responderam)." \
        "confira se o servidor tem internet, ou informe o endereco com --dominio <dominio>."
    nome="$(hostname | tr '[:upper:]' '[:lower:]')"
    nome="${nome%.hstgr.cloud}"
    if [[ "$nome" =~ ^[a-z0-9-]+$ ]] && dns_publico_aponta "$nome.hstgr.cloud" "$ip"; then
        DOMINIO="$nome.hstgr.cloud"
        ok "endereco: $DOMINIO (o DNS publico aponta para $ip)"
    else
        DOMINIO="${ip//./-}.sslip.io"
        ok "endereco: $DOMINIO (gratuito, aponta sozinho para $ip)"
    fi
}

# Quem instala o Claude Code costuma nao rodar a linha que poe ~/.local/bin no PATH, e ai o
# terminal nao acha o `claude` mesmo ele existindo. Acha onde esta e acrescenta ao PATH deste
# instalador, sem mexer em nenhum arquivo da pessoa.
localizar_claude() {
    local pasta home_sudo="" achou=""
    if command -v claude >/dev/null 2>&1; then return 0; fi
    if [ -n "${SUDO_USER:-}" ]; then
        home_sudo="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)" || home_sudo=""
    fi
    for pasta in "$R/root/.local/bin" ${home_sudo:+"$home_sudo/.local/bin"} "$R/usr/local/bin"; do
        if [ -x "$pasta/claude" ] && [ ! -d "$pasta/claude" ]; then achou="$pasta"; break; fi
    done
    [ -n "$achou" ] || return 0
    PATH="$achou:$PATH"
    export PATH
    ok "Claude Code encontrado em $achou/claude"
    aviso "o seu terminal nao acha o comando claude (a pasta $achou nao esta no PATH). Usei o caminho certo so nesta instalacao. Para as proximas vezes, rode: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
}

# Com o provedor claude decidido, o comando precisa existir em algum lugar.
exigir_claude() {
    [ "$PROVEDOR" = claude ] || return 0
    if command -v claude >/dev/null 2>&1; then return 0; fi
    falha "o Claude Code nao foi encontrado (nem no PATH, nem em ~/.local/bin), e o Admin precisa dele." \
        "instale o Claude Code (https://code.claude.com/docs/en/setup), rode: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc, entre na sua assinatura rodando: claude, e rode o instalador de novo. Se voce usa o Codex, rode com --provedor codex."
}

detectar_provedor() {
    local atual
    atual="$(env_valor DGCLAW_PROVEDOR_ADMIN)"
    if [ -n "$PROVEDOR_ARG" ]; then PROVEDOR="$PROVEDOR_ARG"; return 0; fi
    if [ -n "$atual" ]; then PROVEDOR="$atual"; return 0; fi
    if [ -f "$R/root/.claude/.credentials.json" ] || command -v claude >/dev/null 2>&1; then
        PROVEDOR=claude
    elif [ -f "$R/root/.codex/auth.json" ]; then
        PROVEDOR=codex
    else
        PROVEDOR=claude
        aviso "nao achei o Claude nem o Codex logado neste servidor; vou configurar o Admin para o Claude. Se voce usa o Codex, rode de novo com --provedor codex."
    fi
}

# --- 4. codigo ------------------------------------------------------------------
instalar_codigo() {
    passo "Copiando o DG Claw para ${DG_APP#"$R"}"
    VERSAO="v1"
    if fonte_tem .claude-plugin/plugin.json; then
        if tem_jq; then
            VERSAO="$(jq -r '.version // "0"' "$SCRIPT_DIR/.claude-plugin/plugin.json")"
        else
            VERSAO="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p;T;q' "$SCRIPT_DIR/.claude-plugin/plugin.json")"
        fi
    else
        # A distribuição v1 não inclui o manifesto do plugin legado. O commit
        # identifica o build sem depender de tag ou release; ZIP usa somente v1.
        local revisao
        revisao="$(git -C "$SCRIPT_DIR" rev-parse --short=12 HEAD 2>/dev/null)" || revisao=""
        VERSAO="v1${revisao:+-$revisao}"
        info "distribuicao DG Claw $VERSAO"
    fi
    [[ "$VERSAO" =~ ^[0-9A-Za-z._+-]+$ ]] || falha "a versao '$VERSAO' do plugin.json tem caracteres estranhos." "corrija o campo version em .claude-plugin/plugin.json."

    criar_pasta 755 "$DG_ETC"
    criar_pasta 755 "$DG_OPT"
    criar_pasta 755 "$DG_APP"
    # node_modules fica de fora nos dois sentidos: o rsync nao copia e, por estar excluido, tambem nao apaga o
    # que o npm instalou la dentro numa rodada anterior.
    executar rsync -a --delete --exclude=.git --exclude=node_modules --exclude=tests --exclude=qa "$SCRIPT_DIR/" "$DG_APP/"

    if fonte_tem bin/dgclaw; then
        criar_pasta 755 "$DG_BIN"
        executar ln -sfn "$DG_APP/bin/dgclaw" "$DG_BIN/dgclaw"
        ok "comando dgclaw em ${DG_BIN#"$R"}/dgclaw"
    else
        aviso "bin/dgclaw ainda nao existe neste repositorio, entao o comando 'dgclaw' nao foi instalado. Rode ./install.sh de novo quando ele chegar."
    fi

    local imagem
    imagem="$(env_valor DGCLAW_IMAGEM)"
    imagem="${imagem:-$DG_IMAGEM_PADRAO}"
    detectar_provedor
    {
        printf 'DGCLAW_DOMINIO=%s\n' "$DOMINIO"
        printf 'DGCLAW_VERSAO=%s\n' "$VERSAO"
        printf 'DGCLAW_IMAGEM=%s\n' "$imagem"
        printf 'DGCLAW_PROVEDOR_ADMIN=%s\n' "$PROVEDOR"
        printf 'DGCLAW_USUARIO=%s\n' "$USUARIO"
    } | escrever_arquivo "$DG_ETC/dgclaw.env" 644
}

# --- 5. caddy -------------------------------------------------------------------
configurar_caddy() {
    passo "Configurando o Caddy (HTTPS automatico para $DOMINIO)"
    local cf="$R/etc/caddy/Caddyfile"
    escrever_site_caddy "$DOMINIO"
    executar_log caddy validate --config "$cf" --adapter caddyfile
    if systemctl is-active --quiet caddy; then
        executar systemctl reload caddy
    else
        executar systemctl enable --now caddy
    fi
}

# --- 6. firewall ----------------------------------------------------------------
configurar_firewall() {
    passo "Configurando o firewall"
    local st=""
    executar_log ufw allow 22/tcp
    executar_log ufw allow 80/tcp
    executar_log ufw allow 443/tcp
    st="$(ufw status 2>/dev/null)" || st="" # sem resposta = trata como desligado e liga abaixo
    if [[ "$st" == *"Status: active"* ]]; then
        ok "ufw ja estava ligado; as portas 22, 80 e 443 estao liberadas"
    else
        aviso "vou ligar o firewall com a porta 22 (SSH) aberta, para voce nao perder o acesso ao servidor. Se o seu SSH usa outra porta, libere-a antes com: ufw allow <porta>/tcp"
        executar_log ufw --force enable
    fi

    cat <<'FIM' | escrever_arquivo "$DG_UNITS/dgclaw-firewall.service" 644
[Unit]
Description=DG Claw: cerca de rede dos containers dos agentes
After=network-online.target podman.service ufw.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash /opt/dgclaw/app/lib/firewall.sh

[Install]
WantedBy=multi-user.target
FIM
    executar systemctl daemon-reload
    executar systemctl enable dgclaw-firewall.service
    # restart (e nao start): se a unidade ja estava ativa, reaplica as regras da versao nova.
    executar systemctl restart dgclaw-firewall.service
}

# --- 5b. folga de inotify ---------------------------------------------------------
# Sem isto o Ubuntu 24.04 (max_user_instances=128) nao aguenta mais de uns 20 agentes e o
# container sai com 255 sem log; ver lib/comum.sh. Nunca abaixa um valor que ja e maior.
maior_de() { # maior_de <minimo> <valor-atual-ou-vazio>
    local min="$1" atual="${2:-}"
    case "$atual" in ''|*[!0-9]*) atual=0 ;; esac
    if [ "$atual" -gt "$min" ]; then printf '%s' "$atual"; else printf '%s' "$min"; fi
}

configurar_inotify() {
    passo "Dando folga de inotify aos containers"
    local conf="$R/etc/sysctl.d/90-dgclaw-inotify.conf" inst watches novo
    inst="$(maior_de 1024 "$(cat "$R/proc/sys/fs/inotify/max_user_instances" 2>/dev/null || true)")"
    watches="$(maior_de 524288 "$(cat "$R/proc/sys/fs/inotify/max_user_watches" 2>/dev/null || true)")"
    novo="$(printf '%s\n' \
        '# DG Claw: cada agente gasta de 5 a 6 instancias de inotify do root do host.' \
        '# Com o padrao de 128 o container sai com codigo 255 e sem log.' \
        "fs.inotify.max_user_instances=$inst" \
        "fs.inotify.max_user_watches=$watches")"
    if [ "$ENSAIO" != 1 ] && [ -f "$conf" ] && [ "$(cat "$conf")" = "$novo" ]; then
        ok "$conf ja esta certo (instancias $inst, watches $watches)"
    else
        printf '%s\n' "$novo" | escrever_arquivo "$conf" 644
    fi
    # -p com o arquivo, nunca --system: o --system reaplicaria tudo o que outros deixaram.
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] sysctl -p %s\n' "$conf"
        return 0
    fi
    # A folga e desejavel, nao essencial: numa VPS em container (LXC, OpenVZ) o sysctl e do
    # provedor e falha sempre. Por isso aqui nao se usa o `executar`, que abortaria o install.
    local erro atual
    if erro="$(sysctl -p "$conf" 2>&1)"; then
        ok "inotify: $inst instancias e $watches watches por usuario"
    else
        atual="$(inotify_limite)"
        aviso "nao consegui aplicar o limite de inotify (sysctl -p $conf: $(printf '%s' "$erro" | tail -1)). O arquivo ficou gravado. O limite atual e ${atual:-desconhecido}; esta VPS provavelmente e um container e quem manda nesse limite e o provedor. Com 5 a 6 instancias por agente, cabem uns $(( ${atual:-0} / 6 )) agentes. Se precisar de mais, peca ao provedor fs.inotify.max_user_instances=1024."
    fi
}

# --- 7. usuario e senha ---------------------------------------------------------
gerar_hash() {
    local cmd hash
    if [ -n "$R" ] && [ -n "${DGCLAW_SENHA_HASH_CMD:-}" ]; then
        cmd="$DGCLAW_SENHA_HASH_CMD"
        hash="$(printf '%s' "$SENHA" | "$cmd")" || falha "o gerador de hash de teste ($cmd) recusou a senha." "confira o script de teste."
    else
        [ -f "$DG_APP/panel/bin/senha-hash.js" ] || falha "nao achei panel/bin/senha-hash.js em ${DG_APP#"$R"}, que gera o hash da senha." \
            "esta copia do DG Claw esta incompleta; atualize o repositorio (git pull) e rode ./install.sh de novo. A senha nao foi gravada."
        hash="$(printf '%s' "$SENHA" | node "$DG_APP/panel/bin/senha-hash.js")" || falha "o panel/bin/senha-hash.js recusou a senha (codigo $?)." \
            "use uma senha de pelo menos 12 caracteres."
    fi
    local re='^scrypt[$][A-Za-z0-9$+/=._:-]+$'
    [[ "$hash" =~ $re ]] || falha "o gerador de hash devolveu algo que nao parece um hash scrypt." \
        "isso e um erro do DG Claw; a senha nao foi gravada. Abra uma issue sem colar a senha."
    printf '%s' "$hash"
}

# gravar_web_env_senha <usuario> <hash>: grava usuario e hash no web.env SEM apagar o resto.
# O usuario pode ter posto ali as chaves de voz (GROQ_API_KEY, ELEVENLABS_API_KEY...) e outros
# ajustes; reescrever o arquivo inteiro a cada atualizacao as perdia. Filtra com grep -v (o hash
# tem $ e outros caracteres especiais, entao nada de sed com ele) e escreve com printf '%s'.
gravar_web_env_senha() {
    local usuario="$1" hash="$2" web_env="$DG_ETC/web.env" resto=""
    if [ -f "$web_env" ]; then
        resto="$(grep -v -e '^DGCLAW_PANEL_USER=' -e '^DGCLAW_PANEL_PASSWORD_HASH=' "$web_env" || true)"
    fi
    {
        [ -n "$resto" ] && printf '%s\n' "$resto"
        printf "DGCLAW_PANEL_USER=%s\nDGCLAW_PANEL_PASSWORD_HASH='%s'\n" "$usuario" "$hash"
    } | escrever_arquivo "$web_env" 600
}

configurar_senha() {
    passo "Guardando o usuario e a senha do painel"
    local web_env="$DG_ETC/web.env" hash="" tem=0
    if tem_senha_guardada; then tem=1; fi
    if [ -n "$SENHA" ]; then
        if [ "$ENSAIO" = 1 ]; then
            info "[ensaio] geraria o hash da senha e gravaria ${web_env#"$R"}"
            SENHA=""
            return 0
        fi
        hash="$(gerar_hash)"
        SENHA=""
        SENHA_NOVA=1
        # Senha definida agora: um link de primeiro acesso pendente nao faz mais sentido.
        rm -f "$DG_ETC/primeiro-acesso.json"
        ok "senha nova guardada como hash (a senha em si nao e gravada em lugar nenhum)"
    elif [ "$tem" = 1 ] && [ "$ARG_NOVO_PRIMEIRO_ACESSO" != 1 ]; then
        hash="$(sed -n "s/^DGCLAW_PANEL_PASSWORD_HASH='\(.*\)'$/\1/p;T;q" "$web_env")"
        aviso "nenhuma senha nova chegou; a senha atual do painel continua valendo."
    else
        if [ "$ENSAIO" = 1 ]; then
            info "[ensaio] gravaria ${web_env#"$R"} e geraria um link de primeiro acesso (uso unico, 30 min)"
            return 0
        fi
        if [ "$tem" = 1 ]; then
            hash="$(sed -n "s/^DGCLAW_PANEL_PASSWORD_HASH='\(.*\)'$/\1/p;T;q" "$web_env")"
        fi
        gravar_web_env_senha "$USUARIO" "$hash"
        PRIMEIRO_ACESSO_TOKEN="$(gerar_primeiro_acesso "$USUARIO")"
        ok "link de primeiro acesso gerado (vale 30 min, uso unico)"
        return 0
    fi
    gravar_web_env_senha "$USUARIO" "$hash"
}

# --- 8. web ---------------------------------------------------------------------
configurar_web() {
    passo "Ligando o DG Claw Web"
    if ! fonte_tem web/server.js; then
        aviso "web/server.js ainda nao existe neste repositorio; o DG Claw Web nao foi ligado. Rode ./install.sh de novo quando ele chegar."
        return 0
    fi
    criar_pasta 700 "$DG_LIB/web"
    # Par de chaves dos avisos no aparelho. Se falhar, o Web gera na primeira partida: nao derruba a instalacao.
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] geraria o par de chaves dos avisos no aparelho em ${DG_LIB#"$R"}/web/push"
    elif fonte_tem web/bin/push-chaves.js; then
        if node "$DG_APP/web/bin/push-chaves.js" "$DG_LIB/web" >/dev/null 2>>"$LOG_INSTALAR"; then
            ok "chaves dos avisos no aparelho prontas em ${DG_LIB#"$R"}/web/push"
        else
            aviso "nao consegui preparar as chaves dos avisos no aparelho (veja ${LOG_INSTALAR#"$R"}). O Web tenta de novo na primeira partida; se os avisos nao funcionarem, rode: node ${DG_APP#"$R"}/web/bin/push-chaves.js ${DG_LIB#"$R"}/web"
        fi
    fi
    if fonte_tem web/package.json; then
        npm_em "$DG_APP/web" ci --omit=dev
    fi
    cat <<'FIM' | escrever_arquivo "$DG_UNITS/dgclaw-web.service" 644
[Unit]
Description=DG Claw Web (painel e chat)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/dgclaw/app/web
Environment=DGCLAW_WEB_HOST=127.0.0.1
Environment=DGCLAW_WEB_PORT=8300
Environment=DGCLAW_AGENTES=/etc/dgclaw/agentes.json
Environment=DGCLAW_WEB_ENV=/etc/dgclaw/web.env
Environment=DGCLAW_WEB_DATA=/var/lib/dgclaw/web
EnvironmentFile=/etc/dgclaw/web.env
ExecStart=/usr/bin/node /opt/dgclaw/app/web/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
FIM
    ligar_unidade dgclaw-web.service reiniciar
}

# --- 9. admin -------------------------------------------------------------------
configurar_admin() {
    passo "Ligando o Admin (agente de sistema)"
    local p_admin="${DG_ADMIN#"$R"}" p_etc="${DG_ETC#"$R"}" p_app="${DG_APP#"$R"}"
    local provider_runner transcripts

    if ! fonte_tem runner/package.json; then
        falha "a pasta runner/ (o programa que roda cada agente) nao esta neste repositorio." \
            "atualize o repositorio (git pull, branch v1/integracao) e rode ./install.sh de novo."
    fi
    npm_em "$DG_APP/runner" ci
    npm_em "$DG_APP/runner" run build

    criar_pasta 700 "$DG_ADMIN"
    criar_pasta 700 "$DG_ADMIN/.plataforma"
    criar_pasta 700 "$DG_ADMIN/.plataforma/dgchat"
    criar_pasta 700 "$DG_ETC/runner"
    criar_pasta 750 "$DG_LOG"

    local arq
    for arq in CLAUDE.md AGENTS.md; do
        if fonte_tem "templates/admin/$arq"; then
            executar install -m 644 "$SCRIPT_DIR/templates/admin/$arq" "$DG_ADMIN/$arq"
        else
            aviso "templates/admin/$arq ainda nao existe neste repositorio; o Admin vai subir sem esse arquivo de identidade. Rode ./install.sh de novo quando ele chegar."
        fi
    done
    local skill
    for skill in criar-agente trocar-dominio; do
        if fonte_tem "skills/$skill"; then
            criar_pasta 755 "$DG_ADMIN/.claude"
            criar_pasta 755 "$DG_ADMIN/.claude/skills"
            executar rsync -a --delete "$SCRIPT_DIR/skills/$skill/" "$DG_ADMIN/.claude/skills/$skill/"
        else
            aviso "skills/$skill ainda nao existe neste repositorio; o Admin nao tera essa habilidade ate ela chegar."
        fi
    done

    if [ "$PROVEDOR" = codex ]; then
        provider_runner="codex-cli"
        transcripts="/root/.codex/sessions"
    else
        provider_runner="local-cli"
        transcripts="/root/.claude/projects/-opt-dgclaw-admin"
    fi

    if ! tem_jq; then
        if [ "$ENSAIO" = 1 ]; then
            info "[ensaio] o jq ainda nao esta instalado; escreveria runner.json, dgchat.mcp.json e o registro do Admin no agentes.json."
        else
            falha "o jq nao esta instalado, e ele e necessario para escrever os arquivos do Admin." "rode: apt-get install -y jq; depois ./install.sh de novo."
        fi
    else
        jq -n --arg prov "$provider_runner" --arg admin "$p_admin" '
            {id: "admin", slug: "admin",
             config: {name: "Admin", cwd: $admin, provider: $prov, model: "", auth: "assinatura",
                      permissionMode: "bypassPermissions", initialPrompt: "",
                      mcpConfig: ($admin + "/.plataforma/dgchat.mcp.json"),
                      identidadeArquivo: "",
                      allowTools: ["mcp__dgchat__reply", "mcp__dgchat__send_file"],
                      envExtra: {DGCHAT_AGENT: "admin",
                                 DGCHAT_OUTBOUND: ($admin + "/.plataforma/dgchat/outbound.jsonl"),
                                 DGCHAT_ENTREGA: "disco",
                                 CODEX_HOME: "/root/.codex",
                                 DGCLAW_WORKSPACE: $admin,
                                 DGCLAW_CONFIG: ($admin + "/.dgclaw/config.sh")},
                      tags: ["dgclaw", "admin"], cofre: []}}' \
            | escrever_arquivo "$DG_ADMIN/.plataforma/runner.json" 444
        # O Admin roda como root em bypassPermissions: sem esta chave o Claude Code abre o aviso
        # "Bypass Permissions mode" e o Enter do runner escolhe "No, exit" (loop, 16/10/2026).
        if [ "$PROVEDOR" != codex ]; then
            garantir_pular_aviso_bypass "$R/root/.claude/settings.json"
        fi
        jq -n --arg admin "$p_admin" --arg app "$p_app" '
            {mcpServers: {dgchat: {command: "node",
                                   args: [($app + "/scripts/dgchat-mcp/server.mjs")],
                                   env: {DGCHAT_AGENT: "admin",
                                         DGCHAT_OUTBOUND: ($admin + "/.plataforma/dgchat/outbound.jsonl")}}}}' \
            | escrever_arquivo "$DG_ADMIN/.plataforma/dgchat.mcp.json" 644
    fi

    gerar_segredo "$DG_ETC/runner/admin.token"

    cat <<'FIM' | escrever_arquivo "$DG_UNITS/dgclaw-admin.service" 644
[Unit]
Description=DG Claw Admin (agente de sistema, roda como root no servidor)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/dgclaw/app/runner
Environment=HOME=/root RUNNER_AGENT_FILE=/opt/dgclaw/admin/.plataforma/runner.json RUNNER_PORT=4300 RUNNER_BIND=127.0.0.1 RUNNER_LOG=/var/log/dgclaw/admin-runner.log RUNNER_TOKEN_FILE=/etc/dgclaw/runner/admin.token IS_SANDBOX=1
Environment=PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment="RUNNER_LOGIN_HINT=Abra o painel do agente e use o botão Entrar com a assinatura."
UnsetEnvironment=CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT ANTHROPIC_API_KEY
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
FIM
    # Sem reiniciar sozinho: quem roda este instalador pode ser o proprio Admin.
    ligar_unidade dgclaw-admin.service avisar

    if tem_jq; then
        agentes_garantir_arquivo
        jq -n --arg prov "$PROVEDOR" --arg transcripts "$transcripts" --arg admin "$p_admin" --arg etc "$p_etc" '
            {slug: "admin", nome: "Admin", tipo: "admin", runner: "http://127.0.0.1:4300",
             agente_id: "admin", chat_id: "c_admin", avatar: "🛠️", cor: "#64748b",
             provedor: $prov, modelo: "", transcripts_dir: $transcripts,
             porta_painel: null, proxy_segredo_arquivo: null,
             runner_token_arquivo: ($etc + "/runner/admin.token"),
             home_host: $admin, home_container: $admin}' \
            | agentes_registrar
    fi
}

# --- 10. imagem -----------------------------------------------------------------
imagem_pronta() { podman image exists "localhost/dgclaw-agente:$VERSAO" >/dev/null 2>&1; }

construir_imagem() {
    passo "Preparando a criacao dos agentes pelo painel"
    if ! fonte_tem container/Containerfile; then
        aviso "container/Containerfile ainda nao existe neste repositorio; a imagem nao foi construida. Rode ./install.sh de novo quando ele chegar."
        return 0
    fi
    # O comando fica numa linha so dentro do bash -c: o systemd nao faz redirecionamento sozinho.
    cat <<FIM | escrever_arquivo "$DG_UNITS/dgclaw-imagem.service" 644
[Unit]
Description=DG Claw: construir a imagem dos agentes
After=network-online.target podman.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/dgclaw/app
TimeoutStartSec=3600
ExecStart=/bin/bash -c 'exec podman build --http-proxy=false --ignorefile /opt/dgclaw/app/container/ignore --build-arg COM_NAVEGADOR=1 -t localhost/dgclaw-agente:$VERSAO -t localhost/dgclaw-agente:latest -f /opt/dgclaw/app/container/Containerfile /opt/dgclaw/app >>/var/log/dgclaw/imagem.log 2>&1'
FIM
    executar systemctl daemon-reload
    if [ "$SEM_IMAGEM" = 1 ]; then
        info "preparacao adiada para criar seu primeiro agente pelo Admin. Comando tecnico: dgclaw imagem construir"
        return 0
    fi
    if imagem_pronta; then
        ok "a imagem localhost/dgclaw-agente:$VERSAO ja existe"
    elif [ "$(systemctl is-active dgclaw-imagem.service 2>/dev/null || true)" = activating ]; then
        ok "a imagem ja esta sendo construida (acompanhe: tail -f /var/log/dgclaw/imagem.log)"
    else
        executar systemctl start --no-block dgclaw-imagem.service
        info "a construcao leva alguns minutos e roda sozinha. Acompanhe com: dgclaw imagem status"
    fi
}

# --- 11. testes finais ----------------------------------------------------------

# esperar_http <segundos> <curl args...>: tenta ate dar certo; qualquer resposta HTTP conta.
esperar_http() {
    local limite="$1"; shift
    local inicio=$SECONDS
    while true; do
        if curl -sS --max-time 8 -o /dev/null "$@" 2>/dev/null; then return 0; fi
        if [ $((SECONDS - inicio)) -ge "$limite" ]; then return 1; fi
        sleep 3
    done
}

primeiro_boot() {
    local marca="$DG_LIB/web/admin-saudado" cfg corpo
    if [ -e "$marca" ]; then
        ok "o Admin ja foi avisado do primeiro boot"
        return 0
    fi
    if ! tem_jq; then return 0; fi
    corpo="$(jq -n --arg t '<plataforma recado="primeiro-boot">A instalacao do servidor terminou e o dono vai abrir o chat em instantes. Este e um aviso da plataforma, nao uma mensagem escrita por ele. Cumprimente-o agora pelo chat c_admin, usando mcp__dgchat__reply, com esta mensagem: "Oi! Eu sou o Admin do seu DG Claw. Cuido da maquina e crio os seus agentes, cada um na sua propria caixa, separado dos outros. Vamos criar o primeiro? Toque em **Quero criar meu primeiro agente**, na janela aqui do chat. Se preferir, me diga aqui mesmo como ele vai se chamar." Depois espere a resposta dele e siga a skill criar-agente.</plataforma>' \
        '{text: $t, submit: true}')"
    # O token vai por arquivo de configuracao do curl (modo 600), nunca na linha de comando.
    cfg="$(mktemp)"
    chmod 600 "$cfg"
    printf 'header = "Authorization: Bearer %s"\n' "$(cat "$DG_ETC/runner/admin.token")" >"$cfg"
    if printf '%s' "$corpo" | curl -sS -f --max-time 20 --config "$cfg" -X POST \
            -H 'Content-Type: application/json' --data-binary @- \
            http://127.0.0.1:4300/api/agents/admin/input >/dev/null; then
        rm -f "$cfg"
        printf 'ok\n' | escrever_arquivo "$marca" 600
        ok "o Admin recebeu o recado de primeiro boot e vai cumprimentar voce no chat"
    else
        rm -f "$cfg"
        aviso "nao consegui mandar o recado de primeiro boot ao Admin (POST em http://127.0.0.1:4300/api/agents/admin/input). Isso costuma acontecer quando o Claude ou o Codex ainda nao esta logado em root neste servidor. O painel funciona do mesmo jeito; rode ./install.sh de novo depois do login para ele se apresentar."
    fi
}

testar_fim() {
    passo "Testando de ponta a ponta"
    local espera="${DGCLAW_ESPERA_CERT:-90}"

    if [ "$SEM_IMAGEM" != 1 ] && fonte_tem scripts/teste-isolamento.sh; then
        if [ "$ENSAIO" = 1 ]; then
            info "[ensaio] rodaria scripts/teste-isolamento.sh se a imagem ja estiver pronta"
        elif imagem_pronta; then
            info "rodando o teste de isolamento dos agentes..."
            executar bash "$DG_APP/scripts/teste-isolamento.sh"
            ok "teste de isolamento passou"
        else
            info "a imagem ainda esta sendo construida; o teste de isolamento roda sozinho no primeiro 'dgclaw agente criar'."
        fi
    elif [ "$SEM_IMAGEM" != 1 ]; then
        aviso "scripts/teste-isolamento.sh ainda nao existe neste repositorio; o teste de isolamento nao rodou."
    fi

    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] testaria https://$DOMINIO/, http://127.0.0.1:8300/ e http://127.0.0.1:4300/api/saude e daria o primeiro boot ao Admin"
        return 0
    fi

    info "esperando o certificado HTTPS de $DOMINIO (ate ${espera}s)..."
    esperar_http "$espera" --resolve "$DOMINIO:443:127.0.0.1" "https://$DOMINIO/" \
        || falha "https://$DOMINIO/ nao respondeu em ${espera}s." \
                 "confira se as portas 80 e 443 estao abertas no firewall do provedor e se $DOMINIO aponta para este servidor; veja o motivo com: journalctl -u caddy -n 30. Depois rode ./install.sh de novo."
    ok "HTTPS respondendo em $DOMINIO"

    if fonte_tem web/server.js; then
        esperar_http 30 http://127.0.0.1:8300/ \
            || falha "o DG Claw Web nao respondeu em http://127.0.0.1:8300/." \
                     "veja o motivo com: journalctl -u dgclaw-web -n 30"
        ok "DG Claw Web respondendo"
    fi

    esperar_http 60 -f http://127.0.0.1:4300/api/saude \
        || falha "o runner do Admin nao respondeu em http://127.0.0.1:4300/api/saude." \
                 "veja o motivo com: journalctl -u dgclaw-admin -n 30 (e ${DG_LOG#"$R"}/admin-runner.log)"
    ok "runner do Admin respondendo"

    primeiro_boot
}

mensagem_final() {
    printf '\n%sSeu DG Claw está instalado e configurado em https://%s.%s\n' "$_C_OK" "$DOMINIO" "$_C_0"
    printf '   Painel:   https://%s/\n' "$DOMINIO"
    printf '   Usuario:  %s\n' "$USUARIO"
    if [ -n "$PRIMEIRO_ACESSO_TOKEN" ]; then
        printf '\n   Primeiro acesso (uso único, vale 30 min): https://%s/primeiro-acesso#%s\n' "$DOMINIO" "$PRIMEIRO_ACESSO_TOKEN"
        printf '   Abra o link de primeiro acesso, cadastre sua senha e você já entra no chat do Admin.\n'
        printf '   Se o link expirar, gere outro com: sudo dgclaw primeiro-acesso\n\n'
        PRIMEIRO_ACESSO_TOKEN=""
    elif [ "$SENHA_NOVA" = 1 ]; then
        printf '   Senha:    a que você definiu agora\n\n'
    else
        printf '   Senha:    a que você escolheu antes (foi mantida)\n\n'
    fi
    printf '   Daqui pra frente é pelo painel. Pode fechar este terminal.\n'
    printf '   Peça: "Quero criar meu primeiro agente".\n'
    if [ "$ENSAIO" = 1 ]; then
        printf '\n   (isto foi um ensaio: nada foi mudado neste servidor)\n'
    fi
}

# --- main -----------------------------------------------------------------------
main() {
    parse_args "$@"
    # shellcheck source=lib/comum.sh
    . "$SCRIPT_DIR/lib/comum.sh"
    # shellcheck source=lib/agentes.sh
    . "$SCRIPT_DIR/lib/agentes.sh"
    ENSAIO="$ARG_ENSAIO"
    LOG_INSTALAR="$DG_LOG/instalar.log"
    validar_args
    if [ "$ENSAIO" = 1 ]; then printf 'ENSAIO: nada sera mudado neste servidor; so vou mostrar o que faria.\n'; fi

    ler_senha
    checar_maquina
    localizar_claude
    detectar_provedor
    exigir_claude
    instalar_pacotes
    escolher_dominio
    instalar_codigo
    configurar_caddy
    configurar_firewall
    configurar_inotify
    configurar_senha
    configurar_web
    configurar_admin
    construir_imagem
    testar_fim
    mensagem_final
}

main "$@"
