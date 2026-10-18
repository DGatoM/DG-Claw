#!/usr/bin/env bash
# lib/enterprise/travas.sh: travas de acao externa (protecao `travas_externas`). Texto completo: docs/enterprise/TRAVAS.md.
#
# O agente trabalha dentro do container; o que ele faz "em nome da empresa" (mandar e-mail, publicar no Instagram, mandar
# mensagem para um terceiro) passa por uma trava que ele NAO consegue abrir:
#   Gmail      as regras `deny` das ferramentas de envio vao para o managed-settings do Claude Code (lib/enterprise/politicas.sh),
#              que o container monta so leitura. O agente so cria rascunho. Liberar o envio por um tempo e a operacao perigosa
#              `travas.liberar` do controle: aprovada pelo TI, vira `dgclaw travas liberar <agente> --minutos N`, que tira o
#              deny por N minutos e volta sozinho (timer).
#   Instagram  o token sai do agente e fica num cofre do host que o container nao monta; a publicacao passa pela fila de
#              aprovacoes (web/lib/ent/acoes-instagram.js). `dgclaw acoes instagram configurar <slug>` faz a mudanca.
#   WhatsApp   o canal so conversa com os numeros da lista do TI (`dgclaw acoes whatsapp ...`), gravada num arquivo que o
#              container ve so leitura.
#
# Comandos: dgclaw travas liberar|fechar|conferir|status ; dgclaw acoes instagram configurar|testar <slug> ;
#           dgclaw acoes whatsapp permitir|remover|listar <slug> [numero]
# Ganchos: ent_args_container_travas (DGCLAW_TRAVAS=1 no ambiente do agente), ent_instalar_travas (timer),
#          ent_aplicar_travas, ent_status_travas.

_TRV_UNID="dgclaw-travas"
_TRV_MIN=5
_TRV_MAX=240
_trv_acoes_dir() { printf '%s' "${DGCLAW_ACOES_EXTERNAS_DIR:-$DG_ETC/acoes-externas}"; }
_trv_cli() { printf '%s' "${DGCLAW_BIN_CLI:-$DG_BIN/dgclaw}"; }
_trv_estado_dir() { printf '%s/travas' "$DG_ETC"; }

_trv_exigir_ligada() {
    protecao_ligada travas_externas && return 0
    falha "a protecao travas_externas esta desligada no nivel '$(protecao_nivel)', entao nao ha trava para liberar ou configurar." \
        "use um nivel com travas (dgclaw nivel definir escritorio) e rode o comando de novo."
}

_trv_exigir_agente() {
    local slug="${1:-}" quem="${2:-travas}"
    exigir_slug "$slug" "$quem"
    [ -n "$(agentes_obter "$slug")" ] || falha "nao conheco o agente '$slug'." "veja os que existem com: dgclaw agente listar"
}

# O Gmail de dentro do container (settings.local.json do agente) volta a bater com o managed-settings. Roda COMO O AGENTE,
# dentro do container: o root do host nunca escreve em pasta que o agente controla (armadilha 7).
_trv_gmail_local() {
    local slug="$1" modo="$2" c="dgclaw-$1"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] poria o Gmail local do agente $slug em '$modo'"; return 0; fi
    if [ "$(podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" != running ]; then
        aviso "o container $c nao esta ligado, entao nao acertei o settings.local.json do agente (modo $modo). A trava de verdade e o managed-settings, que ja esta certo; ao ligar o agente rode: dgclaw travas conferir"
        return 0
    fi
    podman exec -u agente --env DGCLAW_GMAIL_SEM_AVISO=1 "$c" \
        bash /opt/dgclaw/app/scripts/gmail-permissao.sh /home/agente/.dgclaw/config.sh "$modo" >/dev/null \
        || falha "o gmail-permissao.sh terminou com erro dentro do container $c (modo $modo)." \
            "veja o log do agente: podman exec $c cat /home/agente/.dgclaw/logs/permissoes.log"
}

# liberar <slug> --minutos N [--por quem]
_trv_liberar() {
    local slug="${1:-}" minutos=30 por="${DGCLAW_QUEM:-cli}" ate agora arq unid
    if [ "$#" -gt 0 ]; then shift; fi
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --minutos) [ "$#" -ge 2 ] || falha "a opcao --minutos precisa de um valor." "use: dgclaw travas liberar <slug> --minutos 30"; minutos="$2"; shift 2 ;;
            --por) [ "$#" -ge 2 ] || falha "a opcao --por precisa de um valor." "use: dgclaw travas liberar <slug> --minutos 30 --por <quem>"; por="$2"; shift 2 ;;
            *) falha "a opcao '$1' nao existe." "use: dgclaw travas liberar <slug> --minutos <$_TRV_MIN a $_TRV_MAX>" ;;
        esac
    done
    _trv_exigir_ligada
    _trv_exigir_agente "$slug" "travas liberar"
    if ! [[ "$minutos" =~ ^[0-9]{1,4}$ ]] || [ "$minutos" -lt "$_TRV_MIN" ] || [ "$minutos" -gt "$_TRV_MAX" ]; then
        falha "os minutos '$minutos' nao valem." "use um numero inteiro de $_TRV_MIN a $_TRV_MAX. A liberacao e curta de proposito: o envio volta a fechar sozinho."
    fi
    [ "$(_pol_provedor "$slug")" = claude ] || falha "o agente $slug usa o Codex, que nao tem o conector do Gmail do claude.ai." "nao ha trava de e-mail para liberar nele."
    agora="$(( $(agora_ms) / 1000 ))"
    ate=$(( agora + minutos * 60 ))
    arq="$(_pol_travas_arq "$slug")"
    criar_pasta 700 0:0 "$(_trv_estado_dir)"
    jq -nc --argjson ate "$ate" --argjson min "$minutos" --arg por "$por" --argjson em "$agora" \
        '{liberado_ate: $ate, minutos: $min, por: $por, liberado_em: $em}' | escrever_arquivo "$arq" 600 0:0
    # Managed settings sem o deny do envio, local do agente em "envio", runner reiniciado para recarregar.
    if ! _trv_aplicar_agente "$slug" envio; then
        # Nao conseguiu abrir: desfaz o estado para a trava nao ficar meio aberta sem o TI saber.
        [ "$ENSAIO" = 1 ] || rm -f -- "$arq"
        pol_gerar "$slug" || true
        falha "nao consegui liberar o envio do agente $slug (veja a mensagem acima). Voltei a trava ao que era." "resolva o que a mensagem diz e peca a aprovacao de novo."
    fi
    unid="$_TRV_UNID-fecha-$slug"
    if [ "$ENSAIO" != 1 ] && systemctl is-active --quiet "$unid.timer"; then executar systemctl stop "$unid.timer"; fi
    executar systemd-run --on-active="${minutos}min" --unit="$unid" \
        --description="Fecha o envio de e-mail do agente $slug" "$(_trv_cli)" travas fechar "$slug" --auto
    ok "envio de e-mail do agente $slug liberado por $minutos minuto(s); fecha sozinho"
    info "para fechar antes: dgclaw travas fechar $slug"
    auditar_aviso travas.liberada "$(jq -nc --arg s "$slug" --argjson m "$minutos" --arg p "$por" --argjson a "$ate" '{slug: $s, minutos: $m, por: $p, ate: $a}')"
}

# _trv_aplicar_agente <slug> <envio|leitura>: regrava o managed-settings, acerta o local e reinicia o runner.
_trv_aplicar_agente() {
    local slug="$1" modo="$2" rc=0
    pol_gerar "$slug" || rc=$?
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 10 ]; then return "$rc"; fi
    _trv_gmail_local "$slug" "$modo" || return 1
    _pol_reiniciar_runner "$slug"
}

# fechar <slug> [--auto]: idempotente.
_trv_fechar() {
    local slug="${1:-}" auto=0 arq unid
    if [ "$#" -gt 0 ]; then shift; fi
    for a in "$@"; do
        case "$a" in --auto) auto=1 ;; *) falha "a opcao '$a' nao existe." "use: dgclaw travas fechar <slug>" ;; esac
    done
    _trv_exigir_ligada
    _trv_exigir_agente "$slug" "travas fechar"
    arq="$(_pol_travas_arq "$slug")"
    if [ ! -e "$arq" ]; then info "o envio do agente $slug ja esta fechado."; return 0; fi
    [ "$ENSAIO" = 1 ] || rm -f -- "$arq"
    _trv_aplicar_agente "$slug" leitura || aviso "o envio do agente $slug esta fechado no managed-settings (isso ja bloqueia), mas nao consegui terminar o resto; rode: dgclaw travas conferir"
    unid="$_TRV_UNID-fecha-$slug"
    if [ "$auto" = 0 ] && [ "$ENSAIO" != 1 ] && systemctl is-active --quiet "$unid.timer"; then executar systemctl stop "$unid.timer"; fi
    ok "envio de e-mail do agente $slug fechado"
    auditar_aviso travas.fechada "$(jq -nc --arg s "$slug" --arg como "$([ "$auto" = 1 ] && echo timer || echo manual)" '{slug: $s, como: $como}')"
}

# conferir: fecha toda liberacao vencida (o timer de 5 minutos e a rede de seguranca do timer exato, que some num reboot).
_trv_conferir() {
    local f slug ate agora
    _trv_exigir_ligada
    agora="$(( $(agora_ms) / 1000 ))"
    for f in "$(_trv_estado_dir)"/*.json; do
        [ -e "$f" ] || continue
        slug="$(basename "$f" .json)"
        [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || { aviso "ignorei $f: o nome do arquivo nao e um nome curto de agente."; continue; }
        ate="$(jq -r '.liberado_ate // 0' "$f" 2>/dev/null)" || ate=0
        if ! [[ "$ate" =~ ^[0-9]+$ ]] || [ "$ate" -le "$agora" ]; then _trv_fechar "$slug" --auto; fi
    done
}

_trv_status() {
    local slug f ate agora algum=0
    agora="$(( $(agora_ms) / 1000 ))"
    printf '%-20s %s\n' AGENTE ENVIO-DE-EMAIL
    while IFS= read -r slug; do
        algum=1
        f="$(_pol_travas_arq "$slug")"
        if [ -s "$f" ]; then
            ate="$(jq -r '.liberado_ate // 0' "$f")"
            if [[ "$ate" =~ ^[0-9]+$ ]] && [ "$ate" -gt "$agora" ]; then
                printf '%-20s liberado por mais %s minuto(s) (por %s)\n' "$slug" "$(( (ate - agora + 59) / 60 ))" "$(jq -r '.por // "?"' "$f")"
                continue
            fi
        fi
        printf '%-20s travado (so rascunho)\n' "$slug"
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    [ "$algum" = 1 ] || echo "nenhum agente."
}

ent_cmd_travas() {
    local sub="${1:-status}"
    if [ "$#" -gt 0 ]; then shift; fi
    exigir_ferramentas jq
    case "$sub" in
        liberar) _trv_liberar "$@" ;;
        fechar) _trv_fechar "$@" ;;
        conferir) _trv_conferir ;;
        status) _trv_status ;;
        *) falha "o subcomando 'travas $sub' nao existe." "use: dgclaw travas liberar <agente> --minutos N | fechar <agente> | conferir | status" ;;
    esac
}

# --- Instagram ------------------------------------------------------------------------------

_trv_ig_dir() { printf '%s/%s' "$(_trv_acoes_dir)" "$1"; }

# Caminho (visto do host) do arquivo de token do agente. instagram.json pode apontar para /home/agente/...; nada fora da casa vale.
_trv_ig_token_arquivo() {
    local slug="$1" home cfg caminho
    home="$(_pol_casa "$slug")/home"
    cfg="$home/.dgclaw/instagram.json"
    caminho=""
    if [ -f "$cfg" ] && [ ! -L "$cfg" ]; then caminho="$(jq -r '.tokenPath // empty' "$cfg" 2>/dev/null)" || caminho=""; fi
    case "$caminho" in
        "") caminho="$home/.instagram_token" ;;
        /home/agente/*) caminho="$home/${caminho#/home/agente/}" ;;
        *) falha "o tokenPath do instagram.json do agente $slug ($caminho) esta fora da casa dele." "ajuste o instagram.json para um arquivo dentro de /home/agente (o padrao e /home/agente/.instagram_token) e rode de novo." ;;
    esac
    case "$caminho" in *..*) falha "o tokenPath do agente $slug tem '..'." "use um caminho direto, sem '..'." ;; esac
    printf '%s' "$caminho"
}

_trv_ig_configurar() {
    local slug="${1:-}" arq token conta dir destino claro tmp
    _trv_exigir_ligada
    _trv_exigir_agente "$slug" "acoes instagram configurar"
    ent_exigir jq
    arq="$(_trv_ig_token_arquivo "$slug")"
    dir="$(_trv_ig_dir "$slug")"
    if [ ! -e "$arq" ] && { [ -e "$dir/instagram.env" ] || [ -e "$dir/instagram.env.cred" ]; }; then
        info "o token do Instagram do agente $slug ja esta no cofre do host (${dir#"$R"}); nada a mover."
        return 0
    fi
    [ -e "$arq" ] || falha "nao achei o token do Instagram do agente $slug em ${arq#"$R"}." \
        "o agente precisa ter o token no arquivo que o instagram.json indica (padrao: .instagram_token na casa dele). Peca ao agente para guardar o token ali, ou crie o arquivo, e rode de novo."
    if [ -L "$arq" ] || [ ! -f "$arq" ]; then
        falha "${arq#"$R"} nao e um arquivo comum (e atalho ou pasta)." "troque por um arquivo comum com o token numa linha so e rode de novo. Nao sigo atalhos dentro da casa do agente."
    fi
    token="$(head -c 4096 "$arq" | tr -d '[:space:]')"
    [ -n "$token" ] || falha "o arquivo ${arq#"$R"} esta vazio." "coloque o token do Instagram nele e rode de novo."
    conta=""
    if [ -f "$(_pol_casa "$slug")/home/.dgclaw/instagram.json" ] && [ ! -L "$(_pol_casa "$slug")/home/.dgclaw/instagram.json" ]; then
        conta="$(jq -r '.igAccountId // empty' "$(_pol_casa "$slug")/home/.dgclaw/instagram.json" 2>/dev/null)" || conta=""
    fi
    [[ "$conta" =~ ^[0-9]{5,25}$ ]] || falha "o instagram.json do agente $slug nao tem um igAccountId valido (so numeros, de 5 a 25 digitos)." \
        "corrija o igAccountId em /home/agente/.dgclaw/instagram.json do agente e rode de novo."
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] moveria o token de ${arq#"$R"} para ${dir#"$R"}/instagram.env"; return 0; fi
    criar_pasta 700 0:0 "$(_trv_acoes_dir)" "$dir"
    claro="$dir/instagram.env"
    destino="$claro"
    tmp="$(mktemp "$dir/.ig.XXXXXX")"
    chmod 600 "$tmp"
    printf 'IG_TOKEN=%s\nIG_CONTA=%s\n' "$token" "$conta" >"$tmp"
    if protecao_ligada cofre_cifrado; then
        destino="$claro.cred"
        _trv_ig_cifrar "$slug" "$tmp" "$destino" || { rm -f "$tmp"; return 1; }
        rm -f "$tmp" "$claro"
    else
        mv -f "$tmp" "$claro"
    fi
    chmod 600 "$destino"
    # Confere que o cofre do host devolve o mesmo token ANTES de apagar o original do agente.
    if [ "$(_trv_ig_ler_token "$slug")" != "$token" ]; then
        rm -f "$destino"
        falha "a copia do token no cofre do host nao bate com o original; desfiz a copia e nao mexi no arquivo do agente." "confira o systemd-creds (systemd-creds --version) e rode de novo."
    fi
    rm -f -- "$arq"
    ok "token do Instagram do agente $slug movido para o cofre do host (${destino#"$R"}); o arquivo ${arq#"$R"} do agente foi apagado"
    info "o agente passa a pedir a publicacao pela caixa (DGCLAW_TRAVAS=1) e o TI aprova em /aprovacoes. Container antigo: dgclaw agente recriar $slug --sim"
    auditar_aviso acoes.instagram.configurar "$(jq -nc --arg s "$slug" --arg c "$conta" --argjson cif "$(protecao_ligada cofre_cifrado && echo true || echo false)" '{slug: $s, conta: $c, cifrado: $cif}')"
}

_trv_ig_cifrar() {
    local slug="$1" claro="$2" cred="$3" tmp motivo creds="${DGCLAW_SYSTEMD_CREDS:-systemd-creds}"
    tmp="$(mktemp "$(dirname "$cred")/.ig.cred.XXXXXX")"
    if ! "$creds" encrypt "--name=dgclaw-acoes-instagram-$slug" --with-key=auto - "$tmp" <"$claro" 2>"$tmp.erro"; then
        motivo="$(tr '\n' ' ' <"$tmp.erro" | head -c 200)"
        rm -f "$tmp" "$tmp.erro"
        falha "o systemd-creds nao cifrou o token do Instagram do agente $slug (${motivo:-sem mensagem})." \
            "confira se funciona com: systemd-creds --version. O arquivo do agente nao foi tocado."
    fi
    rm -f "$tmp.erro"
    chmod 600 "$tmp"
    mv -f "$tmp" "$cred"
}

# Imprime o token do Instagram do cofre do host (so o valor). Usado na conferencia e no teste.
_trv_ig_ler_token() {
    local slug="$1" dir creds="${DGCLAW_SYSTEMD_CREDS:-systemd-creds}" texto
    dir="$(_trv_ig_dir "$slug")"
    if [ -s "$dir/instagram.env.cred" ]; then
        texto="$("$creds" decrypt "--name=dgclaw-acoes-instagram-$slug" "$dir/instagram.env.cred" - 2>/dev/null)" || return 1
    elif [ -s "$dir/instagram.env" ]; then
        texto="$(cat "$dir/instagram.env")"
    else
        return 1
    fi
    sed -n 's/^IG_TOKEN=//p' <<<"$texto" | head -n 1
}

_trv_ig_testar() {
    local slug="${1:-}" dir modo
    _trv_exigir_agente "$slug" "acoes instagram testar"
    dir="$(_trv_ig_dir "$slug")"
    if [ -s "$dir/instagram.env.cred" ]; then modo="cifrado"; elif [ -s "$dir/instagram.env" ]; then modo="em claro, so do root"; else
        falha "o agente $slug nao tem token do Instagram no cofre do host (${dir#"$R"})." "rode: dgclaw acoes instagram configurar $slug"
    fi
    [ -n "$(_trv_ig_ler_token "$slug")" ] || falha "nao consegui ler o token do cofre do host do agente $slug." "confira o systemd-creds e rode: dgclaw acoes instagram configurar $slug"
    ok "token do Instagram do agente $slug no cofre do host ($modo). A conferencia com a Graph API so acontece na hora de publicar."
}

# --- WhatsApp ------------------------------------------------------------------------------

_trv_wa_lista() { printf '%s/config/whatsapp-permitidos.json' "$(_pol_casa "$1")"; }

# Numero em E.164: aceita espaco, traco, parenteses e ponto; sem + na frente, 10 ou 11 digitos viram Brasil (55).
_trv_wa_numero() {
    local n d
    n="$(tr -d ' ().-' <<<"$1")"
    if [[ "$n" == +* ]]; then d="${n#+}"; else
        d="$n"
        [[ "$d" =~ ^[0-9]{10,11}$ ]] && d="55$d"
    fi
    [[ "$d" =~ ^[0-9]{10,15}$ ]] || return 1
    printf '+%s' "$d"
}

_trv_wa_gravar() {
    local slug="$1" json="$2" arq dono_pasta
    arq="$(_trv_wa_lista "$slug")"
    [ -d "$(dirname "$arq")" ] || falha "o agente $slug nao tem a pasta de configuracao ($(dirname "$arq"))." "rode: dgclaw agente reparar $slug"
    dono_pasta="$(stat -c '%u:%g' "$(dirname "$arq")" 2>/dev/null || echo 0:0)"
    printf '%s\n' "$json" | escrever_arquivo "$arq" 644 "$dono_pasta"
}

_trv_wa_ler() {
    local arq
    arq="$(_trv_wa_lista "$1")"
    if [ -s "$arq" ]; then cat "$arq"; else printf '{"versao":1,"numeros":[]}\n'; fi
}

_trv_wa() {
    local acao="${1:-}" slug="${2:-}" numero="${3:-}" n lista novo
    if [ "$#" -gt 0 ]; then shift; fi
    _trv_exigir_ligada
    _trv_exigir_agente "$slug" "acoes whatsapp"
    case "$acao" in
        listar)
            if [ -s "$(_trv_wa_lista "$slug")" ]; then
                printf 'Lista do TI do agente %s (so estes numeros conversam com o canal):\n' "$slug"
                _trv_wa_ler "$slug" | jq -r '.numeros[]' | sed 's/^/  /'
            else
                echo "O agente $slug ainda nao tem lista do TI: o canal usa a lista dele (que o proprio agente pode mudar). Rode: dgclaw protecoes aplicar"
            fi ;;
        permitir)
            [ -n "$numero" ] || falha "faltou o numero." "use: dgclaw acoes whatsapp permitir $slug <numero>   (exemplo: +55 11 98765-4321)"
            n="$(_trv_wa_numero "$numero")" || falha "o numero '${numero:0:30}' nao vale." "use o formato internacional, como +5511987654321 (de 10 a 15 digitos depois do +; sem +, 10 ou 11 digitos sao do Brasil)."
            novo="$(_trv_wa_ler "$slug" | jq -c --arg n "$n" '.numeros = ((.numeros + [$n]) | unique)')"
            _trv_wa_gravar "$slug" "$novo"
            ok "numero $n permitido no WhatsApp do agente $slug"
            auditar_aviso acoes.whatsapp.permitir "$(jq -nc --arg s "$slug" --arg n "$n" '{slug: $s, numero: $n}')" ;;
        remover)
            [ -n "$numero" ] || falha "faltou o numero." "use: dgclaw acoes whatsapp remover $slug <numero>"
            n="$(_trv_wa_numero "$numero")" || falha "o numero '${numero:0:30}' nao vale." "use o formato internacional, como +5511987654321."
            lista="$(_trv_wa_ler "$slug")"
            novo="$(jq -c --arg n "$n" '.numeros = (.numeros - [$n])' <<<"$lista")"
            _trv_wa_gravar "$slug" "$novo"
            ok "numero $n removido do WhatsApp do agente $slug"
            auditar_aviso acoes.whatsapp.remover "$(jq -nc --arg s "$slug" --arg n "$n" '{slug: $s, numero: $n}')" ;;
        *) falha "o subcomando 'acoes whatsapp ${acao}' nao existe." "use: dgclaw acoes whatsapp permitir|remover|listar <agente> [numero]" ;;
    esac
}

ent_cmd_acoes() {
    local canal="${1:-}" acao="${2:-}"
    if [ "$#" -gt 0 ]; then shift; fi
    exigir_ferramentas jq
    case "$canal" in
        instagram)
            if [ "$#" -gt 0 ]; then shift; fi
            case "$acao" in
                configurar) _trv_ig_configurar "$@" ;;
                testar) _trv_ig_testar "$@" ;;
                *) falha "o subcomando 'acoes instagram ${acao}' nao existe." "use: dgclaw acoes instagram configurar|testar <agente>" ;;
            esac ;;
        whatsapp) _trv_wa "$@" ;;
        *) falha "a acao externa '${canal}' nao existe." "use: dgclaw acoes instagram ... | dgclaw acoes whatsapp ..." ;;
    esac
}

# --- ganchos -------------------------------------------------------------------------------

# O agente precisa saber que as acoes externas passam pela caixa (ig-publish.py olha esta variavel).
ent_args_container_travas() {
    local -n _ent_trv_args="$1"
    protecao_ligada travas_externas || return 0
    _ent_trv_args+=(--env DGCLAW_TRAVAS=1)
}

ent_instalar_travas() {
    protecao_ligada travas_externas || return 0
    cat <<FIM | escrever_arquivo "$DG_UNITS/$_TRV_UNID.service" 644
[Unit]
Description=DG Claw: fecha as liberacoes de envio de e-mail que venceram

[Service]
Type=oneshot
ExecStart=$(_trv_cli) travas conferir
FIM
    cat <<'FIM' | escrever_arquivo "$DG_UNITS/$_TRV_UNID.timer" 644
[Unit]
Description=DG Claw: confere de 5 em 5 minutos se alguma liberacao de envio venceu

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
FIM
    executar systemctl daemon-reload
    executar systemctl enable --now "$_TRV_UNID.timer"
    ok "timer $_TRV_UNID.timer instalado (rede de seguranca para fechar o envio liberado)"
}

# Semeia a lista do WhatsApp do TI com a que o agente ja tinha, e confere as liberacoes vencidas.
ent_aplicar_travas() {
    local slug propria arq
    if ! protecao_ligada travas_externas; then
        # Trava desligada: a lista do TI sai (o canal volta a ler a do agente) e o timer de conferencia tambem.
        while IFS= read -r slug; do
            arq="$(_trv_wa_lista "$slug")"
            if [ -e "$arq" ] && [ "$ENSAIO" != 1 ]; then rm -f -- "$arq"; info "lista de WhatsApp do TI do agente $slug removida (travas_externas desligada)"; fi
        done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
        if [ -e "$DG_UNITS/$_TRV_UNID.timer" ]; then
            executar systemctl disable --now "$_TRV_UNID.timer"
            executar rm -f "$DG_UNITS/$_TRV_UNID.timer" "$DG_UNITS/$_TRV_UNID.service"
            executar systemctl daemon-reload
        fi
        return 0
    fi
    while IFS= read -r slug; do
        arq="$(_trv_wa_lista "$slug")"
        propria="$(_pol_casa "$slug")/home/.dgclaw/whatsapp/permitidos.json"
        if [ ! -e "$arq" ] && [ -f "$propria" ] && [ ! -L "$propria" ] && jq -e '.numeros | type == "array"' "$propria" >/dev/null 2>&1; then
            _trv_wa_gravar "$slug" "$(jq -c '{versao: 1, numeros: .numeros}' "$propria")" \
                && ok "WhatsApp do agente $slug: a lista dele virou a lista do TI (confira: dgclaw acoes whatsapp listar $slug)"
        fi
        if ! podman inspect -f '{{.Config.Env}}' "dgclaw-$slug" 2>/dev/null | grep -q 'DGCLAW_TRAVAS=1'; then
            if podman container exists "dgclaw-$slug" >/dev/null 2>&1; then
                aviso "o container do agente $slug foi criado antes das travas e nao sabe que as acoes externas passam pela caixa. Para recriar (a casa fica): dgclaw agente recriar $slug --sim"
            fi
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
    ent_instalar_travas
    _trv_conferir
}

ent_status_travas() {
    local f agora algum=""
    protecao_ligada travas_externas || return 0
    agora="$(( $(agora_ms) / 1000 ))"
    for f in "$(_trv_estado_dir)"/*.json; do
        [ -e "$f" ] || continue
        if [ "$(jq -r '.liberado_ate // 0' "$f" 2>/dev/null)" -gt "$agora" ]; then algum="${algum:+$algum, }$(basename "$f" .json)"; fi
    done
    if [ -n "$algum" ]; then s_aviso "travas externas: envio de e-mail LIBERADO agora para: $algum (fecha sozinho; antes: dgclaw travas fechar <agente>)"
    else s_ok "travas externas: nenhum agente com envio de e-mail liberado"; fi
}
