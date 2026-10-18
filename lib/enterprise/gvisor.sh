#!/usr/bin/env bash
# lib/enterprise/gvisor.sh: runtime reforcado dos containers (protecao `runtime` = gvisor, nivel regulado).
#
# O gVisor (runsc) coloca um kernel de usuario entre o agente e o kernel do servidor: uma falha de kernel
# alcancada de dentro do container nao chega no host. O custo e compatibilidade: a imagem dos agentes roda o
# systemd como PID 1 (`--systemd always`), e a documentacao do gVisor NAO afirma que isso funciona
# (pesquisa de 2026-10-18 em gvisor.dev/docs/user_guide/compatibility, /systemd e /install; resumo em
# docs/enterprise/REGULADO.md). Por isso nada aqui presume que funciona:
#
#   - `ent_args_container_runtime` so poe `--runtime runsc` quando uma PROVA recente passou: sobe um container
#     descartavel da mesma imagem, com as mesmas capacidades, e confere systemd, cron e dois servidores HTTP nas
#     portas do runner (4300) e do painel (8300). A prova fica guardada por imagem + versao do runsc.
#   - Se a prova falha (ou o runsc nao esta instalado), o agente nasce em runc, com aviso alto, evento na auditoria
#     (runtime.queda) e uma marca em /etc/dgclaw/runtime-sem-reforco/<agente>. O `dgclaw status` lista esses agentes.
#   - `dgclaw agente testar-runtime [<agente>]` refaz a prova a pedido e confere o agente.
#
# Ganchos: ent_args_container_runtime, ent_instalar_gvisor, ent_aplicar_runtime, ent_status_runtime.

# A chave do repositorio apt do gVisor. O fingerprint e o da chave publicada em https://gvisor.dev/archive.key em
# 2026-10-18 (chave primaria 6FC6D554E32BD943, "The gVisor Authors"). Se o gVisor trocar a chave, a instalacao para
# aqui de proposito: confira a nova em gvisor.dev/docs/user_guide/install e atualize esta linha.
GVISOR_FINGERPRINT="6F1DF85E3A71C24918E727D56FC6D554E32BD943"
GVISOR_URL_CHAVE="https://gvisor.dev/archive.key"
GVISOR_REPO="https://storage.googleapis.com/gvisor/releases release main"

_rt_chaveiro() { printf '%s/usr/share/keyrings/gvisor-archive-keyring.gpg' "$R"; }
_rt_lista_apt() { printf '%s/etc/apt/sources.list.d/gvisor.list' "$R"; }
_rt_conf_podman() { printf '%s/etc/containers/containers.conf.d/dgclaw-runsc.conf' "$R"; }
_rt_marcas() { printf '%s/runtime-sem-reforco' "$DG_ETC"; }
_rt_estado_prova() { printf '%s/runtime-prova.json' "$DG_LIB"; }
_rt_container_prova() { printf 'dgclaw-prova-runtime'; }

_rt_gvisor() { [ "$(protecao_valor runtime)" = gvisor ]; }

# --- instalacao ------------------------------------------------------------------------------------------

_rt_fingerprint_do_arquivo() {
    gpg --show-keys --with-colons "$1" 2>/dev/null | awk -F: '$1 == "fpr" {print $10; exit}'
}

ent_instalar_gvisor() {
    local tmp fpr runsc
    _rt_gvisor || return 0
    passo "gVisor (runtime reforcado dos agentes)"
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] baixaria $GVISOR_URL_CHAVE, conferiria o fingerprint $GVISOR_FINGERPRINT, instalaria o pacote runsc pelo repositorio apt do gVisor e registraria o runtime em $(_rt_conf_podman | sed "s|^$R||")"
        return 0
    fi
    if ! command -v runsc >/dev/null 2>&1; then
        executar apt-get install -y --no-install-recommends apt-transport-https ca-certificates curl gnupg
        tmp="$(mktemp)"
        curl -fsSL --max-time 60 -o "$tmp" "$GVISOR_URL_CHAVE" \
            || { rm -f "$tmp"; falha "nao consegui baixar a chave do repositorio do gVisor em $GVISOR_URL_CHAVE." "confira a saida de internet deste servidor e repita: dgclaw protecoes aplicar"; }
        fpr="$(_rt_fingerprint_do_arquivo "$tmp")"
        if [ "$fpr" != "$GVISOR_FINGERPRINT" ]; then
            rm -f "$tmp"
            falha "a chave baixada de $GVISOR_URL_CHAVE tem o fingerprint '${fpr:-ilegivel}', e eu esperava $GVISOR_FINGERPRINT. Nao instalei nada." \
                "se o gVisor trocou a chave de verdade, confira a nova na pagina oficial (gvisor.dev/docs/user_guide/install) e atualize GVISOR_FINGERPRINT em lib/enterprise/gvisor.sh; se nao trocou, alguem esta interceptando a conexao."
        fi
        mkdir -p "$(dirname "$(_rt_chaveiro)")"
        gpg --dearmor --yes -o "$(_rt_chaveiro)" <"$tmp" \
            || { rm -f "$tmp"; falha "o gpg nao converteu a chave do gVisor para $(_rt_chaveiro | sed "s|^$R||")." "veja o erro acima e repita."; }
        rm -f "$tmp"
        printf 'deb [arch=%s signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] %s\n' "$(dpkg --print-architecture)" "$GVISOR_REPO" \
            | escrever_arquivo "$(_rt_lista_apt)" 644
        executar apt-get update
        executar apt-get install -y runsc
        ok "runsc instalado pelo repositorio oficial (chave com o fingerprint conferido)"
    else
        info "o runsc ja esta instalado: $(command -v runsc)"
    fi
    runsc="$(command -v runsc || printf '/usr/bin/runsc')"
    # Formato do containers.conf do podman: https://github.com/containers/common/blob/main/docs/containers.conf.5.md
    printf '[engine.runtimes]\nrunsc = ["%s"]\n' "$runsc" | escrever_arquivo "$(_rt_conf_podman)" 644
    ok "runtime runsc registrado no podman ($(_rt_conf_podman | sed "s|^$R||"))"
    info "Sobe agora um container de prova para saber se a imagem dos agentes funciona sob o gVisor."
    if podman image exists "${DGCLAW_IMAGEM:-$DG_IMAGEM_PADRAO}" >/dev/null 2>&1; then
        _rt_prova_forcada || aviso "a prova do gVisor falhou (motivo acima). Os agentes novos vao nascer em runc ate ela passar; o dgclaw status mostra quais. Refaca com: dgclaw agente testar-runtime"
    else
        info "a imagem dos agentes ainda nao esta pronta: a prova roda no primeiro agente criado (ou: dgclaw agente testar-runtime)."
    fi
}

# --- a prova ---------------------------------------------------------------------------------------------

# Servidor de mentira nas portas do runner e do painel, falando consigo mesmo por dentro: prova que o node roda,
# que o loopback funciona e que se pode escutar nessas portas sob o runtime.
_RT_NODE_PROVA="const http=require('http');let n=0;[4300,8300].forEach(p=>{http.createServer((q,r)=>r.end('ok')).listen(p,'127.0.0.1',()=>{http.get({host:'127.0.0.1',port:p},x=>{x.resume();if(++n===2)process.exit(0)}).on('error',e=>{console.error(e.message);process.exit(1)})})});setTimeout(()=>process.exit(2),15000)"

_rt_imagem_id() {
    podman image inspect -f '{{.Id}}' "${DGCLAW_IMAGEM:-$DG_IMAGEM_PADRAO}" 2>/dev/null || true
}

_rt_versao_runsc() {
    runsc --version 2>/dev/null | head -n 1 | tr -d '\r' || true
}

# _rt_prova_executar: sobe o container descartavel e confere. Imprime o motivo da falha no stderr e devolve 1.
_rt_prova_executar() {
    local nome pargs=() rc=0 espera="${DGCLAW_TEMPO_ESPERA:-60}" i estado="" saida
    nome="$(_rt_container_prova)"
    command -v runsc >/dev/null 2>&1 \
        || { aviso "prova do gVisor: o programa runsc nao esta instalado neste servidor. Instale com: dgclaw protecoes aplicar"; return 1; }
    podman rm -f "$nome" >/dev/null 2>&1 || true
    pargs=(run -d --name "$nome" --runtime runsc --network none --http-proxy=false
        --tmpfs /run --tmpfs /run/lock --systemd always --memory 512m --pids-limit 256)
    # As mesmas capacidades do agente de verdade: a prova tem que falhar se elas atrapalham o gVisor.
    if protecao_ligada container_endurecido; then
        ent_args_container_endurecer pargs "$nome"
    fi
    pargs+=("${DGCLAW_IMAGEM:-$DG_IMAGEM_PADRAO}")
    if ! saida="$(podman "${pargs[@]}" 2>&1)"; then
        aviso "prova do gVisor: o podman nao conseguiu criar o container sob o runsc. O que ele disse: ${saida:0:400}"
        podman rm -f "$nome" >/dev/null 2>&1 || true
        return 1
    fi
    for ((i = 0; i < espera; i++)); do
        estado="$(podman exec "$nome" systemctl is-system-running 2>/dev/null || true)"
        case "$estado" in running|degraded) break ;; esac
        sleep 1
    done
    case "$estado" in
        running|degraded) ;;
        *) aviso "prova do gVisor: o systemd nao subiu como PID 1 sob o runsc (estado '${estado:-sem resposta}' depois de ${espera}s). E o ponto de incompatibilidade que a documentacao do gVisor nao garante."
           rc=1 ;;
    esac
    if [ "$rc" -eq 0 ]; then
        podman exec "$nome" systemctl is-active --quiet cron \
            || { aviso "prova do gVisor: o cron nao ficou ativo dentro do container (as rotinas dos agentes dependem dele)."; rc=1; }
        saida="$(podman exec "$nome" node -e "$_RT_NODE_PROVA" 2>&1)" \
            || { aviso "prova do gVisor: o node nao conseguiu escutar e responder nas portas 4300 e 8300 (runner e painel). O que ele disse: ${saida:0:300}"; rc=1; }
    fi
    podman rm -f "$nome" >/dev/null 2>&1 || aviso "nao consegui apagar o container de prova $nome; apague a mao: podman rm -f $nome"
    return "$rc"
}

# _rt_prova_forcada: roda a prova de verdade e guarda o resultado.
_rt_prova_forcada() {
    local ok=false rc=0 img ver
    _rt_prova_executar || rc=$?
    [ "$rc" -ne 0 ] || ok=true
    img="$(_rt_imagem_id)"; ver="$(_rt_versao_runsc)"
    jq -nc --argjson ok "$ok" --arg i "$img" --arg v "$ver" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{ok: $ok, imagem: $i, runsc: $v, em: $t}' | escrever_arquivo "$(_rt_estado_prova)" 600
    if [ "$ok" = true ]; then ok "prova do gVisor passou: systemd, cron e portas do runner e do painel funcionam sob o runsc"; fi
    return "$rc"
}

# _rt_prova_ok: a prova vale para esta imagem e esta versao do runsc? Roda se nao ha prova guardada.
_rt_prova_ok() {
    local est img ver
    est="$(_rt_estado_prova)"; img="$(_rt_imagem_id)"; ver="$(_rt_versao_runsc)"
    if [ -s "$est" ] && jq -e --arg i "$img" --arg v "$ver" '.imagem == $i and .runsc == $v' "$est" >/dev/null 2>&1; then
        jq -e '.ok == true' "$est" >/dev/null 2>&1
        return
    fi
    info "rodando a prova do gVisor (primeira vez com esta imagem ou esta versao do runsc)..."
    _rt_prova_forcada
}

# --- gancho do podman create + queda para runc -----------------------------------------------------------

_rt_marcar_queda() {
    local slug="$1" motivo="$2"
    mkdir -p "$(_rt_marcas)"; chmod 700 "$(_rt_marcas)"
    jq -nc --arg m "$motivo" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{motivo: $m, em: $t}' | escrever_arquivo "$(_rt_marcas)/$slug" 600
    aviso "ATENCAO: o agente $slug vai nascer SEM o runtime reforcado (runc em vez de gVisor). Motivo: $motivo. O nivel regulado pede gVisor; este agente NAO tem a protecao extra de kernel. Isso fica na auditoria e no dgclaw status. Para tentar de novo depois de corrigir: dgclaw agente testar-runtime $slug && dgclaw agente recriar $slug --sim"
    auditar_aviso runtime.queda "$(jq -nc --arg s "$slug" --arg m "$motivo" '{slug: $s, motivo: $m, runtime: "runc"}')"
}

# ent_args_container_runtime <nome-do-array> <slug>
ent_args_container_runtime() {
    local -n _rt_args="$1"
    local slug="$2"
    _rt_gvisor || return 0
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] rodaria a prova do gVisor e, passando, criaria o container com --runtime runsc"
        _rt_args+=(--runtime runsc)
        return 0
    fi
    if _rt_prova_ok; then
        rm -f "$(_rt_marcas)/$slug"
        _rt_args+=(--runtime runsc)
    else
        _rt_marcar_queda "$slug" "a prova do gVisor falhou ou o runsc nao esta instalado (veja as linhas de aviso acima desta)"
    fi
}

# --- dgclaw agente testar-runtime ------------------------------------------------------------------------

ent_cmd_agente_testar_runtime() {
    local slug="${1:-}" cont runtime obj runner painel prova_rc=0 problemas=0
    exigir_ferramentas jq podman
    if ! _rt_gvisor; then
        falha "o runtime reforcado nao esta ligado neste nivel ($(protecao_nivel))." "ele e do nivel regulado: dgclaw nivel definir regulado (ou: dgclaw nivel ajustar runtime gvisor)."
    fi
    if [ -n "$slug" ]; then
        exigir_slug "$slug" testar-runtime
        existe_agente "$slug" || falha "nao conheco o agente '$slug'." "veja os que existem com: dgclaw agente listar"
    fi
    carregar_env_dgclaw
    podman image exists "$DGCLAW_IMAGEM" >/dev/null 2>&1 || falha "a imagem dos agentes ($DGCLAW_IMAGEM) nao existe nesta maquina." "veja: dgclaw imagem status"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] subiria um container de prova sob o runsc e conferiria systemd, cron, runner e painel"; return 0; fi
    passo "Prova do gVisor com a imagem dos agentes"
    _rt_prova_forcada || prova_rc=$?
    if [ "$prova_rc" -ne 0 ]; then problemas=1; fi
    auditar_aviso runtime.prova "$(jq -nc --argjson ok "$([ "$prova_rc" -eq 0 ] && echo true || echo false)" --arg s "$slug" '{ok: $ok, agente: $s}')"
    if [ -n "$slug" ]; then
        passo "Conferindo o agente $slug"
        cont="dgclaw-$slug"
        runtime="$(podman inspect -f '{{.OCIRuntime}}' "$cont" 2>/dev/null || true)"
        if [ "$runtime" = runsc ]; then ok "o container $cont roda sob o runsc"
        else
            problemas=1
            aviso "o container $cont roda em '${runtime:-desconhecido}', nao em runsc. $([ "$prova_rc" -eq 0 ] && echo "A prova passou, entao recriar resolve: dgclaw agente recriar $slug --sim" || echo "Enquanto a prova falhar, ele continua em runc.")"
        fi
        obj="$(agentes_obter "$slug")"
        runner="$(jq -r '.runner // empty' <<<"$obj")"; painel="$(jq -r '.porta_painel // empty' <<<"$obj")"
        if [ -n "$runner" ] && curl -fsS -o /dev/null --max-time 5 "${runner%/}/api/saude"; then ok "o runner do agente responde"
        else problemas=1; aviso "o runner do agente $slug nao respondeu em ${runner:-?}/api/saude. Veja: dgclaw agente reparar $slug"; fi
        if [ -n "$painel" ] && curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$painel/"; then ok "o painel do agente responde"
        else problemas=1; aviso "o painel do agente $slug nao respondeu em 127.0.0.1:${painel:-?}."; fi
        if podman exec "$cont" systemctl is-active --quiet cron; then ok "o cron do agente esta ativo"
        else problemas=1; aviso "o cron do agente $slug nao esta ativo."; fi
        if [ -e "$(_rt_marcas)/$slug" ]; then problemas=1; aviso "o agente $slug esta marcado como SEM o runtime reforcado (motivo: $(jq -r '.motivo' "$(_rt_marcas)/$slug" 2>/dev/null))."; fi
    fi
    [ "$problemas" -eq 0 ] || return 1
    ok "tudo certo com o runtime reforcado"
}

# --- aplicar e status ------------------------------------------------------------------------------------

# Lista os agentes que nao estao sob o runsc, um por linha: "slug<TAB>motivo".
_rt_fora_do_runsc() {
    local slug runtime marca
    while IFS= read -r slug; do
        [ -n "$slug" ] || continue
        marca="$(_rt_marcas)/$slug"
        if [ -e "$marca" ]; then
            printf '%s\tcaiu para runc (%s)\n' "$slug" "$(jq -r '.motivo // "sem motivo registrado"' "$marca" 2>/dev/null)"
            continue
        fi
        runtime="$(podman inspect -f '{{.OCIRuntime}}' "dgclaw-$slug" 2>/dev/null || true)"
        if [ -n "$runtime" ] && [ "$runtime" != runsc ]; then
            printf '%s\tcriado antes do nivel regulado (runtime %s)\n' "$slug" "$runtime"
        fi
    done < <(agentes_ler | jq -r '.agentes[] | select(.tipo == "agente") | .slug')
}

ent_aplicar_runtime() {
    local slug motivo alguma=0
    _rt_gvisor || return 0
    command -v runsc >/dev/null 2>&1 || aviso "o runsc nao esta instalado; rode o instalador (./install.sh --nivel regulado) ou veja docs/enterprise/REGULADO.md."
    while IFS=$'\t' read -r slug motivo; do
        [ -n "$slug" ] || continue
        alguma=1
        aviso "agente $slug sem o runtime reforcado: $motivo. Para recriar sob o gVisor (a casa fica): dgclaw agente recriar $slug --sim"
    done < <(_rt_fora_do_runsc)
    [ "$alguma" = 1 ] || ok "todos os agentes rodam sob o gVisor"
}

ent_status_runtime() {
    local slug motivo
    _rt_gvisor || return 0
    if command -v runsc >/dev/null 2>&1; then s_ok "gVisor instalado ($(_rt_versao_runsc))"
    else s_mal "o nivel pede gVisor mas o runsc nao esta instalado. Rode: ./install.sh --nivel regulado (veja docs/enterprise/REGULADO.md)"; fi
    while IFS=$'\t' read -r slug motivo; do
        [ -n "$slug" ] || continue
        s_aviso "agente $slug SEM o runtime reforcado: $motivo (dgclaw agente testar-runtime $slug; dgclaw agente recriar $slug --sim)"
    done < <(_rt_fora_do_runsc)
}

# Monitor (bloco F): agente que caiu para runc continua sendo um problema ate alguem resolver.
_mon_checar_runtime() {
    local slug motivo
    _rt_gvisor || return 0
    while IFS=$'\t' read -r slug motivo; do
        [ -n "$slug" ] || continue
        _mon_problema "runtime:$slug" "O agente $slug esta SEM o runtime reforcado: $motivo." \
            "Rode: dgclaw agente testar-runtime $slug. Se a prova passar: dgclaw agente recriar $slug --sim. Se nao passar, a falta de gVisor e uma decisao do responsavel (veja docs/enterprise/REGULADO.md)."
    done < <(_rt_fora_do_runsc)
}
