#!/usr/bin/env bash
# lib/enterprise/monitor.sh: monitoramento e alerta (`dgclaw monitor verificar|configurar|testar`).
#
# A cada 5 minutos o timer dgclaw-monitor.timer roda `dgclaw monitor verificar`, que confere:
#   disco (/, /var/lib/dgclaw e o volume cifrado) acima de 85%; certificado HTTPS vencendo em menos
#   de 14 dias; a cerca de rede (se faltar, reaplica e alerta); os servicos dgclaw-web, dgclaw-admin e
#   caddy; os containers dos agentes; a idade do ultimo backup (mais de 26 h) e do ultimo teste de
#   restauracao; e a memoria livre. Cada problema vira um alerta com o que esta errado e o que fazer.
#
# Canais, em /etc/dgclaw/alertas.env (600), lidos como CHAVE=valor (o arquivo nunca e executado):
#   ALERTA_WEBHOOK_URL       POST em JSON ({"text","content"}: Slack, Teams, Discord, Mattermost)
#   ALERTA_TELEGRAM_*        o par do bot do Telegram: o segredo do bot e o id do chat de destino
#   ALERTA_PING_URL          healthchecks.io ou parecido: um GET a cada verificacao SEM problema. E o
#                            "dead man's switch": se a maquina inteira cair, o ping para de chegar e o
#                            servico externo avisa.
#   MONITOR_VOLUME_CIFRADO   (opcional) onde esta montado o volume cifrado; padrao: a pasta dos agentes
#   MONITOR_TESTE_MAX_DIAS   (opcional) idade maxima do teste de restauracao; padrao 35
# As credenciais vao para o curl por arquivo de configuracao no stdin: nunca aparecem em argv.
#
# O mesmo alerta nao se repete antes de 6 h; quando o problema some, sai um "resolvido".
# Estado em /var/lib/dgclaw/monitor/ (estado.json = alertas abertos, ultimo.json = ultimo resultado).
# Precisa de lib/comum.sh, lib/protecoes.sh e lib/agentes.sh carregados antes.

_MON_UNIDADE="dgclaw-monitor"
_MON_REPETIR_S=$((6 * 3600))
_MON_DISCO_MAX=85
_MON_CERT_DIAS=14
_MON_BACKUP_MAX_H=26
_MON_MEM_MIN_PCT=10

_mon_dir() { printf '%s/monitor' "$DG_LIB"; }
_mon_env_arq() { printf '%s/alertas.env' "$DG_ETC"; }

# _mon_env <CHAVE>: valor em alertas.env, sem executar o arquivo. Vazio se nao existe.
_mon_env() {
    local arq v
    arq="$(_mon_env_arq)"
    [ -r "$arq" ] || return 0
    v="$(sed -n "s/^$1=//p" "$arq" | tail -n 1)"
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    printf '%s' "$v"
}

# O arquivo guarda credenciais de alerta: avisa se ficou legivel por outras pessoas.
_mon_conferir_modo() {
    local arq modo
    arq="$(_mon_env_arq)"
    [ -e "$arq" ] || return 0
    modo="$(stat -c %a "$arq")"
    if [ "${modo: -2}" != "00" ]; then
        aviso "${arq#"$R"} esta com modo $modo e guarda credenciais de alerta. Rode: chmod 600 ${arq#"$R"}"
    fi
}

# --- problemas -------------------------------------------------------------------------------------
MON_PROBLEMAS=()
# _mon_problema <chave> <o que esta errado> <o que fazer>
_mon_problema() {
    local t="${2//[$'\t\n\r']/ }"
    local f="${3//[$'\t\n\r']/ }"
    MON_PROBLEMAS+=("$1"$'\t'"$t"$'\t'"$f")
}

_mon_agora_s() { printf '%s' "$(( $(agora_ms) / 1000 ))"; }

# _mon_epoch <data>: segundos; vazio se nao entendeu.
_mon_epoch() { date -d "$1" +%s 2>/dev/null || printf ''; }

_mon_checar_disco() {
    local caminhos=("${R:-/}" "$DG_LIB") p uso mont vistos="" volume
    if protecao_ligada disco_cifrado; then
        volume="$(_mon_env MONITOR_VOLUME_CIFRADO)"
        caminhos+=("${volume:-$DG_LIB/agentes}")
    fi
    for p in "${caminhos[@]}"; do
        [ -e "$p" ] || continue
        uso=""; mont=""
        read -r uso mont < <(df -P "$p" 2>/dev/null | awk 'NR==2 {gsub("%", "", $5); print $5, $6}') || uso=""
        if [ -z "$uso" ]; then
            _mon_problema "disco:$p" "Nao consegui medir o disco de ${p#"$R"} (o df nao respondeu)." "Rode 'df -h' e veja se o disco esta montado e saudavel."
            continue
        fi
        case " $vistos " in *" $mont "*) continue ;; esac
        vistos+=" $mont"
        if [ "$uso" -gt "$_MON_DISCO_MAX" ]; then
            _mon_problema "disco:$mont" "O disco em $mont esta $uso% cheio (o limite e $_MON_DISCO_MAX%)." \
                "Libere espaco: 'dgclaw retencao aplicar', 'podman image prune' e backups antigos; ou aumente o disco no painel do provedor. Disco cheio derruba os agentes e o backup."
        fi
    done
}

_mon_checar_certificado() {
    local dom="${DGCLAW_DOMINIO:-}" saida="" fim fim_s dias situacao
    [ -n "$dom" ] || return 0
    saida="$(timeout 20 openssl s_client -connect "$dom:443" -servername "$dom" </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null)" || saida=""
    if [ -z "$saida" ]; then
        _mon_problema "certificado:$dom" "Nao consegui ler o certificado HTTPS de $dom (a porta 443 nao respondeu ou o certificado nao veio)." \
            "Veja se o Caddy esta de pe (systemctl status caddy), se as portas 80 e 443 estao abertas no firewall do provedor e se $dom aponta para este servidor."
        return 0
    fi
    fim="${saida#notAfter=}"
    fim_s="$(_mon_epoch "$fim")"
    if [ -z "$fim_s" ]; then
        _mon_problema "certificado:$dom" "A data de validade do certificado de $dom veio num formato que nao entendi: $fim." "Rode: openssl s_client -connect $dom:443 -servername $dom </dev/null | openssl x509 -noout -dates"
        return 0
    fi
    dias=$(( (fim_s - $(_mon_agora_s)) / 86400 ))
    if [ "$dias" -lt "$_MON_CERT_DIAS" ]; then
        if [ "$dias" -lt 0 ]; then situacao="venceu ha $((-dias)) dia(s)"; else situacao="vence em $dias dia(s)"; fi
        _mon_problema "certificado:$dom" "O certificado HTTPS de $dom $situacao." \
            "O Caddy renova sozinho; se nao renovou, veja 'journalctl -u caddy -n 50' e confira as portas 80 e 443 e o DNS de $dom."
    fi
}

_mon_cerca_ok() {
    local c
    for c in DGCLAW_HOST DGCLAW_EGRESS; do iptables -n -L "$c" >/dev/null 2>&1 || return 1; done
    iptables -w -t mangle -n -L DGCLAW_EGRESS >/dev/null 2>&1
}

_mon_checar_cerca() {
    if ! command -v iptables >/dev/null 2>&1; then
        _mon_problema cerca "O comando iptables nao existe nesta maquina, entao nao da para conferir a cerca de rede dos agentes." "Instale com: apt-get install -y iptables"
        return 0
    fi
    if _mon_cerca_ok; then return 0; fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] a cerca de rede esta incompleta; reaplicaria com: bash $APP_DIR/lib/firewall.sh"
        _mon_problema cerca "A cerca de rede dos agentes esta incompleta (faltam cadeias DGCLAW_*)." "Reaplique: bash $APP_DIR/lib/firewall.sh"
        return 0
    fi
    if bash "$APP_DIR/lib/firewall.sh" >/dev/null 2>&1 && _mon_cerca_ok; then
        _mon_problema cerca "A cerca de rede dos agentes tinha sumido (faltavam cadeias DGCLAW_*). Eu reapliquei e ela voltou." \
            "Descubra o que a apagou (reinicio do firewall? alguem mexeu no iptables?). Enquanto ela faltou, os agentes alcancavam a rede interna. Veja a auditoria e 'journalctl -k'."
    else
        _mon_problema cerca "A cerca de rede dos agentes esta incompleta e nao consegui reaplicar." \
            "Rode na mao e leia o erro: bash $APP_DIR/lib/firewall.sh. Ate resolver, pare os agentes (dgclaw agente parar <nome>) se houver risco."
    fi
}

_mon_checar_servicos() {
    local u slug estado unid_admin
    read -ra unid_admin <<<"$(ent_admin_unidades)"   # Admin isolado: o que precisa estar de pe e o servico de controle
    for u in dgclaw-web "${unid_admin[@]}" caddy; do
        if [ "$(systemctl is-active "$u" 2>/dev/null)" != active ]; then
            _mon_problema "servico:$u" "O servico $u nao esta de pe." "Veja o motivo: journalctl -u $u -n 50. Para ligar: systemctl restart $u"
        fi
    done
    if ! command -v podman >/dev/null 2>&1; then
        _mon_problema containers "O podman nao foi encontrado, entao nao da para conferir os agentes." "Instale com: apt-get install -y podman"
        return 0
    fi
    while IFS= read -r slug; do
        [ -n "$slug" ] || continue
        estado="$(podman inspect -f '{{.State.Status}}' "dgclaw-$slug" 2>/dev/null)" || estado="ausente"
        if [ "${estado:-ausente}" != running ]; then
            _mon_problema "container:$slug" "O container do agente $slug esta ${estado:-ausente}." "Ligue com: dgclaw agente iniciar $slug. Se cair de novo: podman logs dgclaw-$slug | tail -50"
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
}

# _mon_checar_registro <arquivo> <rotulo> <idade maxima em horas> <chave> <como resolver>
_mon_checar_registro() {
    local arq="$1" rotulo="$2" max_h="$3" chave="$4" fazer="$5" ok quando motivo quando_s idade_h
    if [ ! -s "$arq" ]; then
        _mon_problema "$chave" "Nao ha registro de $rotulo (falta ${arq#"$R"})." "$fazer"
        return 0
    fi
    if ! jq -e 'type == "object"' "$arq" >/dev/null 2>&1; then
        _mon_problema "$chave" "O registro de $rotulo (${arq#"$R"}) nao e um JSON valido." "$fazer"
        return 0
    fi
    ok="$(jq -r '.ok' "$arq")"
    quando="$(jq -r '.quando // ""' "$arq")"
    motivo="$(jq -r '.erro // ""' "$arq")"
    if [ "$ok" != true ]; then
        _mon_problema "$chave" "O ultimo $rotulo falhou${quando:+ em $quando}${motivo:+: $motivo}." "$fazer"
        return 0
    fi
    quando_s="$(_mon_epoch "$quando")"
    if [ -z "$quando_s" ]; then
        _mon_problema "$chave" "O registro de $rotulo nao tem uma data valida (campo quando: '$quando')." "$fazer"
        return 0
    fi
    idade_h=$(( ($(_mon_agora_s) - quando_s) / 3600 ))
    if [ "$idade_h" -gt "$max_h" ]; then
        _mon_problema "$chave" "O ultimo $rotulo tem $idade_h hora(s) (o limite e $max_h)." "$fazer"
    fi
}

_mon_checar_backup() {
    local dir="$DG_LIB/backup" teste_dias
    protecao_ligada backup || return 0
    teste_dias="$(_mon_env MONITOR_TESTE_MAX_DIAS)"
    teste_dias="${teste_dias:-35}"
    _mon_checar_registro "$dir/ultimo-backup.json" "backup" "$_MON_BACKUP_MAX_H" backup \
        "Confira se o timer do backup roda (systemctl list-timers | grep -i backup) e leia o erro no registro. Sem backup recente, um disco perdido e dado perdido."
    _mon_checar_registro "$dir/ultimo-teste.json" "teste de restauracao" "$((teste_dias * 24))" backup-teste \
        "Rode o teste de restauracao do backup e confira que ele passa. Backup que nunca foi restaurado de teste pode nao servir."
}

_mon_checar_memoria() {
    local total="" livre="" pct
    read -r total livre < <(awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {print t, a}' "$R/proc/meminfo" 2>/dev/null) || total=""
    if [ -z "$total" ] || [ -z "$livre" ]; then
        _mon_problema memoria "Nao consegui ler a memoria livre em ${R}/proc/meminfo." "Rode 'free -m' e confira."
        return 0
    fi
    pct=$(( livre * 100 / total ))
    if [ "$pct" -lt "$_MON_MEM_MIN_PCT" ]; then
        _mon_problema memoria "Restam so $pct% de memoria livre ($((livre / 1024)) MB de $((total / 1024)) MB)." \
            "Veja quem gasta: 'ps aux --sort=-rss | head'. Pare um agente que nao esteja em uso (dgclaw agente parar <nome>) ou aumente a maquina."
    fi
}

# --- envio -------------------------------------------------------------------------------------------
# _mon_q <texto>: escapa para dentro de aspas de arquivo de configuracao do curl.
_mon_q() {
    local s="$1"
    s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"; s="${s//$'\r'/}"
    printf '%s' "$s"
}

# _mon_curl <valor-a-esconder>: le a configuracao do curl do stdin; se falhar, imprime o motivo sem o valor.
_mon_curl() {
    local escondido="$1" err rc=0
    err="$(curl -q --silent --show-error --fail --max-time 20 --output /dev/null --config - 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then
        [ -z "$escondido" ] || err="${err//$escondido/***}"
        printf '%s' "${err:-curl terminou com codigo $rc}" | head -c 200
        return 1
    fi
}

_mon_enviar_webhook() {
    local url texto="$1" corpo
    url="$(_mon_env ALERTA_WEBHOOK_URL)"
    [ -n "$url" ] || return 2
    corpo="$(jq -nc --arg t "$texto" '{text: $t, content: $t}')"
    printf 'url = "%s"\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' "$(_mon_q "$url")" "$(_mon_q "$corpo")" | _mon_curl "$url"
}

_mon_enviar_telegram() {
    local bot chat texto="${1:0:3500}"
    bot="$(_mon_env ALERTA_TELEGRAM_TOKEN)"
    chat="$(_mon_env ALERTA_TELEGRAM_CHAT)"
    if [ -z "$bot" ] && [ -z "$chat" ]; then return 2; fi
    if [ -z "$bot" ] || [ -z "$chat" ]; then
        printf 'falta um dos dois campos ALERTA_TELEGRAM_TOKEN e ALERTA_TELEGRAM_CHAT em %s' "$(_mon_env_arq)"
        return 1
    fi
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\n' \
        "$(_mon_q "$bot")" "$(_mon_q "$chat")" "$(_mon_q "$texto")" | _mon_curl "$bot"
}

_mon_ping() {
    local url
    url="$(_mon_env ALERTA_PING_URL)"
    [ -n "$url" ] || return 2
    printf 'url = "%s"\nretry = 2\n' "$(_mon_q "$url")" | _mon_curl "$url"
}

# _mon_enviar <texto>: manda por todos os canais configurados. 0 = pelo menos um entregou;
# 1 = nenhum entregou (motivo no aviso); 2 = nenhum canal configurado.
_mon_enviar() {
    local texto="$1" canal rc motivo entregou=0 configurados=0
    for canal in webhook telegram; do
        rc=0
        motivo="$("_mon_enviar_$canal" "$texto")" || rc=$?
        case "$rc" in
            0) entregou=1; configurados=1 ;;
            2) ;;
            *) configurados=1; aviso "alerta por $canal nao saiu: ${motivo:-sem detalhe}. Confira com: dgclaw monitor testar" ;;
        esac
    done
    if [ "$configurados" -eq 0 ]; then return 2; fi
    [ "$entregou" -eq 1 ]
}

# --- verificar ---------------------------------------------------------------------------------------
_mon_verificar() {
    local dir estado atual decisao novo msg agora_s enviou=0 rc=0 quantos n_env n_res ok_json
    dir="$(_mon_dir)"
    carregar_env_dgclaw
    _mon_conferir_modo
    MON_PROBLEMAS=()
    _mon_checar_disco
    _mon_checar_certificado
    _mon_checar_cerca
    _mon_checar_servicos
    _mon_checar_backup
    _mon_checar_memoria

    agora_s="$(_mon_agora_s)"
    quantos="${#MON_PROBLEMAS[@]}"
    atual="[]"
    if [ "$quantos" -gt 0 ]; then
        atual="$(printf '%s\n' "${MON_PROBLEMAS[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {chave: .[0], texto: .[1], fazer: .[2]})')"
    fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] encontraria $quantos problema(s); nao enviaria alerta nem gravaria estado."
        jq -r '.[] | "   - \(.texto) O que fazer: \(.fazer)"' <<<"$atual"
        return 0
    fi
    mkdir -p "$dir" && chmod 700 "$dir"
    estado="{}"
    if [ -s "$dir/estado.json" ]; then
        if ! estado="$(jq -c 'if type == "object" then . else error("nao e objeto") end' "$dir/estado.json" 2>/dev/null)"; then
            aviso "${dir#"$R"}/estado.json esta ilegivel; recomecei o controle de repeticao (alertas abertos podem ser reenviados uma vez)."
            estado="{}"
        fi
    fi

    decisao="$(jq -nc --argjson e "$estado" --argjson a "$atual" --argjson n "$agora_s" --argjson rep "$_MON_REPETIR_S" '
        {enviar: [$a[] | select((($e[.chave].ultimo_envio // 0) + $rep) <= $n)],
         resolvidos: [$e | to_entries[] | select(.key as $k | ($a | map(.chave) | index($k)) == null) | {chave: .key, texto: .value.texto}]}')"
    n_env="$(jq '.enviar | length' <<<"$decisao")"
    n_res="$(jq '.resolvidos | length' <<<"$decisao")"

    if [ "$n_env" -gt 0 ] || [ "$n_res" -gt 0 ]; then
        msg="$(jq -r --arg d "${DGCLAW_DOMINIO:-este servidor}" '
            "DG Claw (" + $d + ")\n"
            + (if (.enviar | length) > 0 then "\nALERTA (" + (.enviar | length | tostring) + "):\n" + ([.enviar[] | "- " + .texto + " O que fazer: " + .fazer] | join("\n")) + "\n" else "" end)
            + (if (.resolvidos | length) > 0 then "\nRESOLVIDO:\n" + ([.resolvidos[] | "- " + .texto] | join("\n")) + "\n" else "" end)' <<<"$decisao")"
        _mon_enviar "$msg" || rc=$?
        case "$rc" in
            0) enviou=1 ;;
            2) aviso "ha alerta para mandar, mas nenhum canal esta configurado em ${DG_ETC#"$R"}/alertas.env. Configure com: dgclaw monitor configurar" ;;
            *) aviso "nenhum canal entregou o alerta; tento de novo na proxima verificacao (em 5 minutos)." ;;
        esac
    fi

    novo="$(jq -nc --argjson e "$estado" --argjson a "$atual" --argjson d "$decisao" --argjson n "$agora_s" --argjson env "$enviou" '
        ($d.enviar | map(.chave)) as $enviados
        | (reduce $a[] as $p ({}; .[$p.chave] = {texto: $p.texto, fazer: $p.fazer, desde: ($e[$p.chave].desde // $n),
            ultimo_envio: (if $env == 1 and ($enviados | index($p.chave)) != null then $n else ($e[$p.chave].ultimo_envio // 0) end)})) as $novo
        | if $env == 1 then $novo
          else $novo + ($e | with_entries(select(.key as $k | ($a | map(.chave) | index($k)) == null))) end')"
    printf '%s\n' "$novo" | escrever_arquivo "$dir/estado.json" 600

    ok_json=true
    if [ "$quantos" -gt 0 ]; then ok_json=false; fi
    jq -nc --argjson n "$agora_s" --argjson ok "$ok_json" --argjson p "$atual" --arg q "$(date -u -d "@$agora_s" +%Y-%m-%dT%H:%M:%SZ)" \
        '{quando: $q, epoch: $n, ok: $ok, problemas: $p}' | escrever_arquivo "$dir/ultimo.json" 600

    if [ "$quantos" -eq 0 ]; then
        ok "monitor: tudo certo"
        _mon_ping_resultado
        return 0
    fi
    printf 'Monitor: %s problema(s):\n' "$quantos"
    jq -r '.[] | "   - \(.texto) O que fazer: \(.fazer)"' <<<"$atual"
    return 1
}

# Ping so quando esta tudo bem. Se ele falhar, avisa; o problema esta no canal, nao na maquina.
_mon_ping_resultado() {
    local rc=0 motivo
    motivo="$(_mon_ping)" || rc=$?
    case "$rc" in
        0|2) ;;
        *) aviso "o ping de monitoramento externo nao saiu: ${motivo:-sem detalhe}. Confira ALERTA_PING_URL com: dgclaw monitor testar" ;;
    esac
}

# --- configurar e testar ----------------------------------------------------------------------------
# _mon_perguntar <rotulo> <valor atual> <regex> <dica> [-s]: le uma linha do stdin.
# Linha vazia = manter; "-" = apagar. Imprime o valor final.
_mon_perguntar() {
    local rotulo="$1" atual="$2" rx="$3" dica="$4" sec="${5:-}" v="" ja=""
    [ -z "$atual" ] || ja=" (ja definido; Enter mantem, - apaga)"
    if [ -t 0 ]; then printf '%s%s: ' "$rotulo" "$ja" >&2; fi
    if [ -t 0 ] && [ -n "$sec" ]; then
        read -rs v || v=""
        printf '\n' >&2
    else
        read -r v || v=""
    fi
    case "$v" in
        "") printf '%s' "$atual" ;;
        -) printf '' ;;
        *) if [[ "$v" =~ $rx ]]; then printf '%s' "$v"
           else falha "o valor de '$rotulo' nao tem o formato esperado." "$dica"; fi ;;
    esac
}

# So diz se o canal esta definido; nunca repete o valor (URL e segredo do bot).
_mon_estado_canal() { if [ -n "$1" ]; then printf definido; else printf nenhum; fi; }

_mon_configurar() {
    local arq w b c p resto=""
    arq="$(_mon_env_arq)"
    w="$(_mon_perguntar "URL do webhook de alerta (vazio = nenhum)" "$(_mon_env ALERTA_WEBHOOK_URL)" '^https?://[^[:space:]"]+$' "cole a URL completa, comecando com https://")" || return 1
    b="$(_mon_perguntar "Segredo do bot do Telegram" "$(_mon_env ALERTA_TELEGRAM_TOKEN)" '^[0-9]+:[A-Za-z0-9_-]+$' "ele tem a forma 123456:ABC-def (criado no @BotFather)" -s)" || return 1
    c="$(_mon_perguntar "Chat do Telegram (id numerico ou @canal)" "$(_mon_env ALERTA_TELEGRAM_CHAT)" '^(-?[0-9]+|@[A-Za-z0-9_]+)$' "use o id numerico do chat (ex.: 123456789 ou -100123456789) ou @nomedocanal")" || return 1
    p="$(_mon_perguntar "URL de ping externo (healthchecks.io ou similar)" "$(_mon_env ALERTA_PING_URL)" '^https?://[^[:space:]"]+$' "cole a URL completa do ping, comecando com https://")" || return 1
    if [ -n "$b" ] && [ -z "$c" ]; then falha "o bot do Telegram foi informado mas falta o chat." "rode de novo e informe tambem o chat do Telegram."; fi
    # Mantem as outras linhas do arquivo (MONITOR_*), troca so as quatro do alerta.
    if [ -f "$arq" ]; then resto="$(grep -vE '^(ALERTA_WEBHOOK_URL|ALERTA_TELEGRAM_TOKEN|ALERTA_TELEGRAM_CHAT|ALERTA_PING_URL)=|^#|^$' "$arq" || printf '')"; fi
    {
        printf '# Canais de alerta do monitor do DG Claw. Arquivo secreto (600). Gerado por: dgclaw monitor configurar\n'
        if [ -n "$w" ]; then printf 'ALERTA_WEBHOOK_URL=%s\n' "$w"; fi
        if [ -n "$b" ]; then printf 'ALERTA_TELEGRAM_TOKEN=%s\n' "$b"; fi
        if [ -n "$c" ]; then printf 'ALERTA_TELEGRAM_CHAT=%s\n' "$c"; fi
        if [ -n "$p" ]; then printf 'ALERTA_PING_URL=%s\n' "$p"; fi
        if [ -n "$resto" ]; then printf '%s\n' "$resto"; fi
    } | escrever_arquivo "$arq" 600
    ok "canais gravados em ${arq#"$R"} (600): webhook $(_mon_estado_canal "$w"), telegram $(_mon_estado_canal "$b"), ping $(_mon_estado_canal "$p")"
    info "confira com: dgclaw monitor testar"
    auditar_aviso monitor_configurado "$(jq -nc --argjson w "$([ -n "$w" ] && echo true || echo false)" --argjson t "$([ -n "$b" ] && echo true || echo false)" --argjson p "$([ -n "$p" ] && echo true || echo false)" '{webhook: $w, telegram: $t, ping: $p}')"
}

_mon_testar() {
    local texto rc falhou=0 algum=0 canal motivo
    carregar_env_dgclaw
    _mon_conferir_modo
    texto="Teste de alerta do DG Claw (${DGCLAW_DOMINIO:-este servidor}) em $(date -u +%Y-%m-%dT%H:%M:%SZ). Se voce leu isto, o canal funciona."
    for canal in webhook telegram; do
        rc=0
        motivo="$("_mon_enviar_$canal" "$texto")" || rc=$?
        case "$rc" in
            0) ok "$canal: mensagem de teste enviada"; algum=1 ;;
            2) info "$canal: nao configurado" ;;
            *) aviso "$canal: FALHOU: ${motivo:-sem detalhe}"; falhou=1; algum=1 ;;
        esac
    done
    rc=0
    motivo="$(_mon_ping)" || rc=$?
    case "$rc" in
        0) ok "ping externo: ok"; algum=1 ;;
        2) info "ping externo: nao configurado" ;;
        *) aviso "ping externo: FALHOU: ${motivo:-sem detalhe}"; falhou=1; algum=1 ;;
    esac
    if [ "$algum" -eq 0 ]; then
        falha "nenhum canal de alerta esta configurado em ${DG_ETC#"$R"}/alertas.env." "rode: dgclaw monitor configurar"
    fi
    if [ "$falhou" -ne 0 ]; then
        falha "pelo menos um canal de alerta falhou no teste (veja as linhas acima)." "confira a URL e as credenciais com: dgclaw monitor configurar. Enquanto isso, o monitor nao consegue avisar por esse canal."
    fi
}

ent_cmd_monitor() {
    local sub="${1:-}"
    if [ "$#" -gt 0 ]; then shift; fi
    case "$sub" in
        verificar) _mon_verificar "$@" ;;
        configurar) _mon_configurar "$@" ;;
        testar) _mon_testar "$@" ;;
        *) falha "o subcomando 'monitor ${sub}' nao existe." "use: dgclaw monitor verificar | configurar | testar" ;;
    esac
}

# --- timer a cada 5 minutos ------------------------------------------------------------------------
_mon_escrever_unidades() {
    local bin="${DG_BIN#"$R"}/dgclaw"
    escrever_arquivo "$DG_UNITS/$_MON_UNIDADE.service" 644 <<FIM
[Unit]
Description=DG Claw: verifica disco, certificado, cerca, servicos, backup e memoria e manda alerta

[Service]
Type=oneshot
ExecStart=$bin monitor verificar
Nice=5
FIM
    escrever_arquivo "$DG_UNITS/$_MON_UNIDADE.timer" 644 <<FIM
[Unit]
Description=DG Claw: monitor a cada 5 minutos

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
FIM
}

_mon_sincronizar() {
    if protecao_ligada monitoramento; then
        if [ "$ENSAIO" != 1 ]; then mkdir -p "$(_mon_dir)" && chmod 700 "$(_mon_dir)"; fi
        _mon_escrever_unidades
        executar systemctl daemon-reload
        executar systemctl enable --now "$_MON_UNIDADE.timer"
        ok "monitoramento: $_MON_UNIDADE.timer ativo (a cada 5 minutos)"
        if [ ! -e "$(_mon_env_arq)" ]; then
            aviso "ainda nao ha canal de alerta (${DG_ETC#"$R"}/alertas.env). Sem ele o monitor so registra o resultado. Configure com: dgclaw monitor configurar"
        fi
    elif [ -e "$DG_UNITS/$_MON_UNIDADE.timer" ]; then
        executar systemctl disable --now "$_MON_UNIDADE.timer"
        executar rm -f "$DG_UNITS/$_MON_UNIDADE.timer" "$DG_UNITS/$_MON_UNIDADE.service"
        executar systemctl daemon-reload
        info "monitoramento desligado: timer removido."
    fi
}

ent_instalar_monitor() { _mon_sincronizar; }
ent_aplicar_monitor() { _mon_sincronizar; }

ent_status_monitor() {
    local arq epoch ok idade n
    protecao_ligada monitoramento || return 0
    arq="$(_mon_dir)/ultimo.json"
    if [ ! -s "$arq" ]; then
        s_aviso "monitor: ainda nao rodou. Rode: dgclaw monitor verificar"
        return 0
    fi
    epoch="$(jq -r '.epoch // 0' "$arq")"
    ok="$(jq -r '.ok' "$arq")"
    idade=$(( ($(_mon_agora_s) - epoch) / 60 ))
    if [ "$idade" -gt 15 ]; then
        s_aviso "monitor: o ultimo resultado tem $idade minutos (o timer deveria rodar a cada 5). Veja: systemctl status $_MON_UNIDADE.timer"
    elif [ "$ok" = true ]; then
        s_ok "monitor: tudo certo (verificado ha $idade min)"
    else
        n="$(jq '.problemas | length' "$arq")"
        s_aviso "monitor: $n alerta(s) aberto(s): $(jq -r '[.problemas[].texto] | join(" | ")' "$arq")"
    fi
}
