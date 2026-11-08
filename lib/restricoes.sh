#!/usr/bin/env bash
# Restricoes de cada agente (docs/RESTRICOES-DO-AGENTE.md). Carregado por bin/dgclaw com `source`.
#
# A fonte unica e $DG_CASAS/<slug>/runner/restricoes.json: pasta do dono do servidor (root), montada
# so leitura dentro da caixa. Nada que o agente ou a imagem faca apaga esse arquivo, e por isso a
# restricao sobrevive ao `dgclaw atualizar`, ao `agente recriar` e ao `agente reparar`.
# `aplicar_restricoes` traduz o arquivo em duas coisas, sempre de forma idempotente:
#   - denyTools (e a saida de allowTools) no runner.json;
#   - o gancho PreToolUse de escrita no .claude/settings.json da casa do agente.

# `env -i`: o agente grava `env` no settings.local.json dele; sem limpar o ambiente, um NODE_OPTIONS
# poria codigo dele dentro do gancho. O gancho tambem nao le variavel de ambiente (escrita-restrita-hook.mjs).
GANCHO_ESCRITA_CMD="/usr/bin/env -i /usr/bin/node /opt/dgclaw/app/scripts/escrita-restrita-hook.mjs"
# Marca que acha tambem o comando das versoes anteriores (sem env -i) na migracao.
GANCHO_ESCRITA_MARCA="escrita-restrita-hook"
GANCHO_ESCRITA_MATCHER="Write|Edit|MultiEdit|NotebookEdit"

# Tira o gancho antigo do settings.json DENTRO da caixa, como o usuario agente (podman exec --user agente
# <caixa> node -e <este texto> <arquivo> <marca>). Texto fixo, sem shell e sem interpolacao: o arquivo e a marca
# chegam como argumentos. Grava por temporario na mesma pasta + rename. O root do servidor nunca le nem grava
# nada na casa do agente nesta migracao: o agente troca qualquer pedaco do caminho por um atalho a qualquer hora.
# Imprime removido, sem-gancho ou sem-arquivo; sai com 3 se o arquivo nao e um JSON.
GANCHO_MIGRACAO_JS='const fs = require("fs"), path = require("path");
const arq = process.argv[1], marca = process.argv[2];
let txt;
try { txt = fs.readFileSync(arq, "utf8"); } catch (e) { if (e.code === "ENOENT") { console.log("sem-arquivo"); process.exit(0); } throw e; }
if (txt.trim() === "") { console.log("sem-gancho"); process.exit(0); }
let j;
try { j = JSON.parse(txt); } catch (e) { console.error("o settings.json nao e um JSON valido: " + e.message); process.exit(3); }
const pre = j && j.hooks && j.hooks.PreToolUse;
if (!Array.isArray(pre)) { console.log("sem-gancho"); process.exit(0); }
const tem = (c) => typeof c === "string" && c.includes(marca);
const lista = (e) => e && Array.isArray(e.hooks);
const novo = pre.map((e) => lista(e) ? Object.assign({}, e, { hooks: e.hooks.filter((h) => !tem(h && h.command)) }) : e)
    .filter((e) => !lista(e) || e.hooks.length > 0);
if (JSON.stringify(novo) === JSON.stringify(pre)) { console.log("sem-gancho"); process.exit(0); }
if (novo.length === 0) delete j.hooks.PreToolUse; else j.hooks.PreToolUse = novo;
const modo = fs.statSync(arq).mode & 0o777;
const tmp = path.join(path.dirname(arq), "." + path.basename(arq) + "." + process.pid + ".tmp");
try { fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", { flag: "wx", mode: modo }); fs.renameSync(tmp, arq); }
catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
console.log("removido");'

# _restricoes_recusar_combinacao <slug>: com o terminal liberado, travar so os nomes das ferramentas de envio nao
# adianta: o agente fala direto com a ponte do WhatsApp (~/.dgclaw/whatsapp/ponte.sock) ou manda o arquivo por
# qualquer outro meio. Por isso a combinacao e recusada em vez de prometer uma trava que nao existe.
_restricoes_recusar_combinacao() {
    falha "o agente $1 ficaria com o envio de arquivos travado e o terminal (Bash) liberado: com o terminal liberado o agente consegue mandar o arquivo por fora das ferramentas, por exemplo falando direto com a ponte do WhatsApp. Nao gravei nada e deixei as travas atuais como estao." \
        "trave os dois juntos: dgclaw agente restricoes $1 --sem-bash sim --sem-enviar-arquivo sim . Se prefere o terminal liberado, deixe o envio liberado: --sem-enviar-arquivo nao"
}

# restricoes_validar <restricoes.json> <slug> [permitir-combinacao]: para com erro (e nao muda nada) se o arquivo nao serve.
# Nunca devolve "sem restricao" para um arquivo estragado: isso tiraria, sem aviso, uma trava do dono.
# O comando `restricoes` passa permitir-combinacao ao ler o arquivo atual, para conseguir consertar um arquivo
# editado a mao; a combinacao do resultado final ele confere sozinho.
restricoes_validar() {
    local arq="$1" slug="$2" erro
    if [ -L "$arq" ] || [ ! -f "$arq" ]; then
        falha "$arq (restricoes do agente $slug) existe mas nao e um arquivo comum; nao apliquei nada e deixei as travas atuais como estao." \
            "veja com: ls -la $arq . Se foi voce que o criou por engano, apague-o e rode: dgclaw agente restricoes $slug --sem-bash sim|nao ..."
    fi
    if ! jq -e . "$arq" >/dev/null 2>&1; then
        falha "$arq (restricoes do agente $slug) nao e um JSON valido; nao apliquei nada e deixei as travas atuais como estao." \
            "confira com: jq . $arq . Corrija o arquivo, ou refaca as restricoes pelo comando: dgclaw agente restricoes $slug --sem-bash sim|nao --sem-enviar-arquivo sim|nao --escrita-so-em pasta1,pasta2"
    fi
    # shellcheck disable=SC2016 # nao ha variavel de shell aqui
    erro="$(jq -r '
        def pasta_ruim: type != "string" or length == 0 or startswith("/") or test("(^|/)\\.{1,2}(/|$)") or startswith(".") or test("[[:cntrl:]]");
        if type != "object" then "o conteudo nao e um objeto JSON"
        elif .versao != 1 then "\"versao\" precisa ser 1"
        elif ((.sem_bash // false) | type) != "boolean" then "\"sem_bash\" precisa ser true ou false"
        elif ((.sem_enviar_arquivo // false) | type) != "boolean" then "\"sem_enviar_arquivo\" precisa ser true ou false"
        elif ((.escrita_so_em // null) | . != null and type != "array") then "\"escrita_so_em\" precisa ser uma lista de pastas ou null"
        elif (.escrita_so_em != null) and ((.escrita_so_em | length) == 0) then "\"escrita_so_em\" esta vazia; use null para gravar em qualquer lugar"
        elif ((.escrita_so_em // []) | any(.[]; pasta_ruim)) then "\"escrita_so_em\" so aceita pastas relativas a casa do agente, sem \"..\", sem comecar por \"/\" e sem comecar por ponto (.dgclaw, .claude e afins sao do servidor)"
        else empty end' "$arq")"
    if [ -n "$erro" ]; then
        falha "$arq (restricoes do agente $slug) esta invalido: $erro. Nao apliquei nada e deixei as travas atuais como estao." \
            "corrija o arquivo ou refaca as restricoes pelo comando: dgclaw agente restricoes $slug --sem-bash sim|nao --sem-enviar-arquivo sim|nao --escrita-so-em pasta1,pasta2"
    fi
    if [ "${3:-}" != permitir-combinacao ] && jq -e '(.sem_enviar_arquivo // false) == true and (.sem_bash // false) != true' "$arq" >/dev/null; then
        _restricoes_recusar_combinacao "$slug"
    fi
}

# restricoes_conferir <slug>: so confere. Usado antes de mexer no container, para um arquivo ruim
# parar o `recriar` antes de qualquer coisa ser removida.
restricoes_conferir() {
    local arq="$DG_CASAS/$1/runner/restricoes.json"
    if [ -e "$arq" ] || [ -L "$arq" ]; then restricoes_validar "$arq" "$1"; fi
    return 0
}

_restricoes_log() {
    [ "$ENSAIO" = 1 ] && return 0
    printf '%s %s\n' "$(date -u +%FT%TZ)" "$2" >>"$DG_CASAS/$1/restricoes.log" 2>/dev/null || true
}

# aplicar_restricoes <slug> [--sem-reiniciar] [--runner-novo]
# Le o restricoes.json (ausente = sem restricao) e deixa tres coisas de acordo:
#   - runner/managed-settings.json: a CONFIGURACAO ADMINISTRADA do Claude Code (o Containerfile liga
#     /etc/claude-code/managed-settings.json a ele). Leva o gancho de escrita e o permissions.deny. Fica fora
#     da casa, e o Claude Code nao deixa disableAllHooks de usuario, projeto ou local desligar gancho
#     administrado (docs/RESTRICOES-DO-AGENTE.md). Sem restricao o conteudo e `{}`, igual a nao ter nada;
#   - runner.json: denyTools e a saida do envio de arquivo de allowTools, registrando em `restricoesAplicadas`
#     so o que o mecanismo mexeu, para desligar devolver SO isso e nunca o que o dono ja tinha posto;
#   - settings.json da casa: so para tirar o gancho antigo (versoes anteriores o gravavam la). Isso roda DENTRO da
#     caixa, como o usuario agente; agente parado deixa uma pendencia (runner/restricoes-migracao.pendente).
# Ordem: valida e MONTA tudo na memoria; so depois grava (primeiro a configuracao administrada, depois o
# runner.json). Com --runner-novo o runner.json de base vem pelo STDIN (agente criar), ja entra restrito e o
# permissivo nunca chega ao disco. Arquivo invalido: para antes de gravar qualquer coisa.
# Sem --sem-reiniciar, reinicia o runner se algo mudou e o agente esta ligado.
aplicar_restricoes() {
    restricoes_com_trava "$1" _aplicar_restricoes_sem_trava "$@"
}

# restricoes_com_trava <slug> <funcao> [args...]: roda a funcao segurando uma trava por agente
# (arquivo na pasta do agente, fora da casa). Duas alteracoes simultaneas (restricoes, criar, reparar,
# recriar, atualizar) esperam uma pela outra em vez de apagar uma a outra. Quem ja segura a trava (a
# transacao do comando `restricoes` chama o aplicar) passa direto: RESTRICOES_TRAVA_COM guarda o slug.
# Roda num subshell: um `falha` la dentro sai com 1 e quem chamou (set -e) para.
restricoes_com_trava() {
    local slug="$1"; shift
    if [ "$ENSAIO" = 1 ] || [ "${RESTRICOES_TRAVA_COM:-}" = "$slug" ]; then "$@"; return; fi
    mkdir -p "$DG_CASAS/$slug" || falha "nao consegui criar $DG_CASAS/$slug para a trava das restricoes." "confira a permissao de $DG_LIB e rode de novo."
    (
        flock -w 120 9 || falha "outra alteracao das restricoes do agente $slug esta segurando $DG_CASAS/$slug/.restricoes.lock ha mais de 120 segundos." \
            "espere ela terminar e rode de novo. Se nada estiver rodando, confira com: fuser $DG_CASAS/$slug/.restricoes.lock"
        RESTRICOES_TRAVA_COM="$slug"
        "$@"
    ) 9>"$DG_CASAS/$slug/.restricoes.lock"
}

# _restricoes_gravar <alvo> <conteudo>: grava o arquivo (root, 444) por temporario + mv e falha dizendo qual.
_restricoes_gravar() {
    local alvo="$1" conteudo="$2" dir base
    dir="$(dirname "$alvo")"; base="$(basename "$alvo")"
    if ! printf '%s\n' "$conteudo" | escrever_arquivo "$alvo" 444 0:0; then
        rm -f -- "$dir"/."$base".?????? 2>/dev/null || true
        falha "nao consegui gravar $alvo (a troca do arquivo temporario falhou); o agente ficou como estava." \
            "confira o espaco em disco e a permissao de $dir (ls -ld $dir; df -h $dir) e rode de novo."
    fi
}

_aplicar_restricoes_sem_trava() {
    local slug="$1" reiniciar=1 runner_novo=0 a
    shift
    for a in "$@"; do
        case "$a" in
            --sem-reiniciar) reiniciar=0 ;;
            --runner-novo) runner_novo=1 ;;
        esac
    done
    local casa="$DG_CASAS/$slug" c="dgclaw-$slug"
    local rj="$casa/runner/runner.json" rs="$casa/runner/restricoes.json" ms="$casa/runner/managed-settings.json"
    local pend="$casa/runner/restricoes.pendente" pend_mig="$casa/runner/restricoes-migracao.pendente"
    local sem_bash=false sem_env=false pastas=null mudou=0 novo_rj="" novo_ms ms_existia=0 grav_ms=0 grav_rj=0 base="" provider deny_json='[]' rodando=0 saida rc ativo i

    if [ "$runner_novo" = 1 ]; then base="$(cat)"; fi
    if [ -e "$rs" ] || [ -L "$rs" ]; then
        restricoes_validar "$rs" "$slug"
        IFS=$'\t' read -r sem_bash sem_env pastas < <(jq -r '[(.sem_bash // false), (.sem_enviar_arquivo // false), ((.escrita_so_em // null) | tojson)] | @tsv' "$rs")
    fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] aplicaria as restricoes de $rs no managed-settings.json e no runner.json do agente $slug"
        return 0
    fi
    deny_json="$(jq -nc --argjson bash "$sem_bash" --argjson env "$sem_env" '
        [if $bash then "Bash", "BashOutput", "KillShell" else empty end]
        + [if $env then "mcp__dgchat__send_file", "mcp__dgchat__whatsapp_send_file" else empty end]')"

    # --- monta o runner.json novo (na memoria) ---
    if [ "$runner_novo" = 0 ] && [ -f "$rj" ]; then base="$(cat "$rj")"; fi
    if [ -z "$base" ]; then
        if [ "$deny_json" != '[]' ]; then
            falha "nao achei $rj, entao nao consigo aplicar as restricoes do agente $slug." \
                "rode: dgclaw agente criar $slug --nome \"...\" (continua de onde parou e regrava o runner.json) e depois: dgclaw agente reparar $slug"
        fi
    else
        if ! printf '%s' "$base" | jq -e '(.config | type) == "object"' >/dev/null 2>&1; then
            falha "o runner.json $rj do agente $slug nao e um JSON valido com \"config\"; nao apliquei as restricoes." \
                "confira com: jq . $rj (corrija o JSON ou, se nao tiver nada seu, apague o arquivo e rode: dgclaw agente criar $slug --nome \"...\")."
        fi
        # shellcheck disable=SC2016 # os $ sao variaveis do jq
        novo_rj="$(printf '%s' "$base" | jq --argjson querem "$deny_json" '
            def envio: ["mcp__dgchat__send_file", "mcp__dgchat__whatsapp_send_file"];
            (.restricoesAplicadas // {}) as $prev
            | ((.config.denyTools // []) - ($prev.deny // [])) as $dono_deny
            | ($querem - $dono_deny) as $add
            | ((.config.allowTools // []) + (($prev.allow_removidas // []) - (.config.allowTools // []))) as $allow0
            | (if (.config | has("allowTools")) and ($querem | index("mcp__dgchat__send_file")) != null then (envio - (envio - $allow0)) else [] end) as $tirar
            | (if (.config | has("allowTools")) then .config.allowTools = ($allow0 - $tirar) else . end)
            | (if ($dono_deny + $add | length) > 0 then .config.denyTools = ($dono_deny + $add)
               elif (.config | has("denyTools")) and (($prev.deny // []) | length) > 0 then del(.config.denyTools)
               else . end)
            | if ($add | length) + ($tirar | length) > 0 then .restricoesAplicadas = {deny: $add, allow_removidas: $tirar}
              else del(.restricoesAplicadas) end')" \
            || falha "o jq nao conseguiu aplicar as restricoes em $rj." "confira se o arquivo e um JSON valido (jq . $rj) e rode de novo."
    fi

    # --- monta a configuracao administrada (na memoria) ---
    # shellcheck disable=SC2016 # os $ sao variaveis do jq
    novo_ms="$(jq -nc --argjson pastas "$pastas" --argjson deny "$deny_json" --arg cmd "$GANCHO_ESCRITA_CMD" --arg m "$GANCHO_ESCRITA_MATCHER" '
        {}
        | (if $pastas != null then .hooks = {PreToolUse: [{matcher: $m, hooks: [{type: "command", command: $cmd, timeout: 10}]}]} else . end)
        | (if ($deny | length) > 0 then .permissions = {deny: $deny} else . end)')" \
        || falha "o jq nao conseguiu montar o managed-settings.json do agente $slug." "isto e um erro do DG Claw; abra uma issue com a saida acima."

    [ "$(podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null || true)" = running ] && rodando=1
    # --- grava: configuracao administrada primeiro, para o runner nunca subir sem a trava ---
    if [ -L "$ms" ]; then
        falha "$ms e um link; nao gravo nele." "apague o link e rode de novo: dgclaw agente reparar $slug"
    fi
    [ -f "$ms" ] && ms_existia=1
    if [ ! -f "$ms" ] || [ "$(jq -c . "$ms" 2>/dev/null || true)" != "$novo_ms" ]; then
        _restricoes_gravar "$ms" "$novo_ms"
        # `{}` num arquivo que nao existia nao muda nada para o agente: nao conta como mudanca.
        if [ "$novo_ms" != '{}' ] || [ "$ms_existia" = 1 ]; then mudou=1; fi
        grav_ms=1
    fi
    if [ -n "$novo_rj" ] && { [ "$runner_novo" = 1 ] || [ "$(printf '%s' "$novo_rj" | jq -c .)" != "$(jq -c . "$rj")" ]; }; then
        _restricoes_gravar "$rj" "$novo_rj"
        mudou=1
        grav_rj=1
    fi

    # --- migracao: versoes antigas gravavam o gancho no settings.json da casa, onde o agente o desligava ---
    # Quem mexe nesse arquivo e o usuario agente, DENTRO da caixa. O root nao le nem grava nada na casa: entre
    # uma checagem de atalho e a gravacao o agente troca .claude por um link para /root/.claude. So agentes que ja
    # tiveram restricoes (restricoes.json) podem ter o gancho antigo.
    if [ "$mudou" = 1 ] && [ "$reiniciar" = 1 ] && [ "$rodando" = 1 ] && [ ! -e "$pend" ]; then
        _restricoes_gravar "$pend" "reinicio do runner pendente desde $(date -u +%FT%TZ)"
    fi
    if [ -e "$rs" ] || [ -e "$pend_mig" ]; then
        if [ "$rodando" = 1 ]; then
            rc=0
            saida="$(timeout 30 podman exec --user agente "$c" node -e "$GANCHO_MIGRACAO_JS" /home/agente/.claude/settings.json "$GANCHO_ESCRITA_MARCA" 2>&1)" || rc=$?
            if [ "$rc" -ne 0 ]; then
                # O agente controla esse arquivo e pode estragar a migracao de proposito. Nao e fatal: o gancho
                # antigo que ficar la nao afrouxa nada, porque a configuracao administrada vale por cima, e o
                # reinicio do runner precisa acontecer de qualquer jeito.
                [ -e "$pend_mig" ] || _restricoes_gravar "$pend_mig" "migracao do gancho antigo pendente desde $(date -u +%FT%TZ)"
                aviso "nao consegui tirar o gancho antigo do settings.json de dentro da caixa do agente $slug ($([ "$rc" = 124 ] && echo 'passou de 30 segundos' || echo "codigo $rc: ${saida:-sem mensagem}")). Isso nao afrouxa nada: a configuracao administrada vale por cima. Continuei com o reinicio; para tentar de novo, corrija o settings.json do agente e rode: dgclaw agente reparar $slug"
            else
                rm -f -- "$pend_mig"
                if [ "$saida" = removido ]; then
                    mudou=1
                    ok "gancho de escrita antigo tirado do settings.json do agente $slug (agora ele vive na configuracao administrada)"
                fi
            fi
        else
            if [ ! -e "$pend_mig" ]; then
                _restricoes_gravar "$pend_mig" "migracao do gancho antigo pendente desde $(date -u +%FT%TZ)"
            fi
            aviso "o agente $slug esta parado, entao nao mexi no settings.json dele: se ainda houver um gancho antigo de escrita la, ele sai quando o agente ligar e este comando (ou dgclaw agente reparar $slug) rodar de novo."
        fi
    fi

    # --- confere o que ficou no disco antes de dizer que aplicou ---
    if [ "$(jq -c . "$ms" 2>/dev/null || true)" != "$novo_ms" ] || [ "$(stat -c %a "$ms")" != 444 ]; then
        falha "reli $ms depois de gravar e o conteudo ou o modo nao e o esperado; nao vou dizer que as restricoes do agente $slug foram aplicadas." \
            "veja o arquivo (cat $ms; ls -l $ms) e rode de novo: dgclaw agente reparar $slug"
    fi
    if [ -n "$novo_rj" ] && [ "$(jq -c . "$rj" 2>/dev/null || true)" != "$(printf '%s' "$novo_rj" | jq -c .)" ]; then
        falha "reli $rj depois de gravar e o conteudo nao e o esperado; nao vou dizer que as restricoes do agente $slug foram aplicadas." \
            "veja o arquivo (jq . $rj) e rode de novo: dgclaw agente reparar $slug"
    fi
    [ "$grav_ms" = 0 ] || [ "$novo_ms" = '{}' ] || ok "configuracao administrada do agente $slug gravada (gancho de escrita: $([ "$pastas" != null ] && echo ligado || echo desligado); ferramentas negadas: $(printf '%s' "$deny_json" | jq -r 'if length == 0 then "nenhuma" else join(", ") end'))"
    [ "$grav_rj" = 0 ] || ok "runner.json do agente $slug ajustado (Bash: $([ "$sem_bash" = true ] && echo travado || echo liberado), envio de arquivo: $([ "$sem_env" = true ] && echo travado || echo liberado))"

    # --- Codex: o runner ignora allow/deny e os ganchos do Claude Code ---
    provider=""
    [ -f "$rj" ] && provider="$(jq -r '.config.provider // empty' "$rj" 2>/dev/null || true)"
    if [ "$provider" = codex-cli ] && { [ "$sem_bash" = true ] || [ "$sem_env" = true ] || [ "$pastas" != null ]; }; then
        aviso "o agente $slug roda no Codex, e no Codex estas travas ainda NAO valem (o runner ignora as regras de ferramentas e os ganchos do Claude Code). O arquivo $rs fica guardado e passa a valer se o agente trocar para o Claude."
        _restricoes_log "$slug" "aviso: provedor codex-cli, restricoes gravadas mas nao aplicadas pelo runner (sem_bash=$sem_bash sem_enviar_arquivo=$sem_env escrita_so_em=$pastas)"
    fi
    # Agente sem restricoes.json nao ganha arquivo novo na casa dele: o log so existe para quem tem trava.
    if [ -e "$rs" ]; then
        _restricoes_log "$slug" "aplicadas: sem_bash=$sem_bash sem_enviar_arquivo=$sem_env escrita_so_em=$pastas mudou=$mudou"
    fi

    # Pendencia de um reinicio que falhou: os arquivos ja estao gravados, entao a proxima execucao os acharia iguais
    # e diria "nada mudou" com o runner ainda no denyTools antigo. O marcador (pasta do root) so sai depois que o
    # reinicio deu certo e o runner voltou a responder active.
    if [ "$reiniciar" = 1 ]; then
        [ -e "$pend" ] && mudou=1
        if [ "$mudou" = 1 ]; then
            if [ "$rodando" = 1 ]; then
                [ -e "$pend" ] || _restricoes_gravar "$pend" "reinicio do runner pendente desde $(date -u +%FT%TZ)"
                executar podman exec "$c" systemctl restart dgclaw-runner >/dev/null
                ativo=""
                for ((i = 0; i < ${TEMPO_ESPERA:-60}; i++)); do
                    ativo="$(podman exec "$c" systemctl is-active dgclaw-runner 2>/dev/null || true)"
                    [ "$ativo" = active ] && break
                    sleep 1
                done
                if [ "$ativo" != active ]; then
                    falha "reiniciei o runner do agente $slug, mas ele nao voltou a responder active (systemctl is-active devolveu '${ativo:-nada}'); as restricoes novas ainda nao valem para ele." \
                        "veja o log: podman exec $c journalctl -u dgclaw-runner -n 50 . A pendencia ficou guardada em $pend: depois de consertar, rode de novo o mesmo comando (ou: dgclaw agente reparar $slug) que ele reinicia o runner."
                fi
                rm -f -- "$pend"
                ok "runner do agente $slug reiniciado para valer a mudanca"
            else
                rm -f -- "$pend"
                info "o agente $slug esta parado; as restricoes valem quando ele ligar."
            fi
        fi
    fi
    return 0
}

# restricoes_conferir_pasta <home> <pasta relativa>: so le (lstat). Recusa atalho e arquivo no caminho.
# O root NAO cria pasta nem da dono dentro da casa do agente: entre o mkdir e o chown alguem poderia
# trocar um pedaco do caminho por um atalho para /etc, e o chown do root atingiria o servidor.
restricoes_conferir_pasta() {
    local h="$1" rel="$2" cur="$1" seg partes
    IFS=/ read -ra partes <<<"$rel"
    for seg in "${partes[@]}"; do
        [ -n "$seg" ] || continue
        cur="$cur/$seg"
        if [ -L "$cur" ]; then
            falha "$cur e um atalho (aponta para $(realpath -m "$cur")); nao uso atalho como pasta liberada." \
                "escolha outra pasta ou troque o atalho por uma pasta de verdade, e rode de novo."
        fi
        if [ -e "$cur" ] && [ ! -d "$cur" ]; then
            falha "$cur ja existe e e um arquivo, nao uma pasta." "escolha outro nome de pasta em --escrita-so-em."
        fi
    done
}

# restricoes_criar_pastas <slug> <pasta...>: cria as pastas DENTRO da caixa, como o usuario agente, e sem
# shell (argumentos ja validados, depois de `--`). Com o agente desligado nao cria nada: o agente cria a
# pasta quando gravar nela (a ferramenta de gravar cria as pastas que faltam) e o gancho aceita pasta
# que ainda nao existe.
restricoes_criar_pastas() {
    local slug="$1" c="dgclaw-$1" p; shift
    [ "$ENSAIO" = 1 ] && { for p in "$@"; do info "[ensaio] criaria /home/agente/$p dentro da caixa, como o usuario agente"; done; return 0; }
    if [ "$(podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null || true)" != running ]; then
        aviso "o agente $slug esta desligado, entao nao criei as pastas ($*). O agente cria cada uma quando gravar nela; se preferir cria-las agora, ligue o agente e rode o mesmo comando de novo."
        return 0
    fi
    for p in "$@"; do
        executar podman exec -u agente "$c" mkdir -p -- "/home/agente/$p"
    done
}

# agente_restricoes <slug> [--sem-bash sim|nao] [--sem-enviar-arquivo sim|nao]
#                          [--escrita-so-em pasta1,pasta2 | --escrita-livre]
agente_restricoes() {
    local slug="" sem_bash="" sem_env="" pastas_arg="" livre=0 a
    while [ $# -gt 0 ]; do
        a="$1"
        case "$a" in
            --sem-bash|--sem-enviar-arquivo|--escrita-so-em)
                [ $# -ge 2 ] || falha "a opcao $a precisa de um valor." "exemplo: dgclaw agente restricoes ana $a $([ "$a" = --escrita-so-em ] && echo relatorios,rascunhos || echo sim)"
                case "$a" in
                    --sem-bash|--sem-enviar-arquivo)
                        case "$2" in
                            sim|nao) ;;
                            *) falha "o valor '$2' de $a nao serve." "use sim ou nao: dgclaw agente restricoes ${slug:-<slug>} $a sim" ;;
                        esac ;;
                esac
                case "$a" in
                    --sem-bash) sem_bash="$2" ;;
                    --sem-enviar-arquivo) sem_env="$2" ;;
                    --escrita-so-em) pastas_arg="$2" ;;
                esac
                shift 2 ;;
            --escrita-livre) livre=1; shift ;;
            -*) falha "opcao desconhecida: $a" "use: dgclaw agente restricoes <slug> [--sem-bash sim|nao] [--sem-enviar-arquivo sim|nao] [--escrita-so-em pasta1,pasta2 | --escrita-livre]" ;;
            *) [ -z "$slug" ] || falha "so cabe um agente por vez, e recebi '$slug' e '$a'." "use: dgclaw agente restricoes <slug> ..."
               slug="$a"; shift ;;
        esac
    done
    [ "$slug" != admin ] || falha "o Admin nao usa este mecanismo: ele roda como root para cuidar do servidor e quem limita o que ele faz e o proprio instalador." \
        "as restricoes valem para os agentes de trabalho: dgclaw agente restricoes <slug-do-agente> ."
    exigir_slug "$slug" restricoes
    [ -z "$pastas_arg" ] || [ "$livre" = 0 ] || falha "--escrita-so-em e --escrita-livre juntos se contradizem." \
        "use um so: --escrita-so-em pasta1,pasta2 para limitar, ou --escrita-livre para soltar."
    exigir_ferramentas jq podman
    local obj
    obj="$(agentes_obter "$slug")"
    [ -n "$obj" ] || falha "o agente '$slug' nao esta no agentes.json." "veja os que existem com: dgclaw agente listar"

    local casa="$DG_CASAS/$slug" h="$DG_CASAS/$slug/home" rs="$DG_CASAS/$slug/runner/restricoes.json" atual='{"versao":1}'
    exigir_casa_sem_link "$casa" "$h" "$slug" "dgclaw agente restricoes $slug ..."

    if [ -z "$sem_bash$sem_env$pastas_arg" ] && [ "$livre" = 0 ]; then
        if [ -e "$rs" ] || [ -L "$rs" ]; then
            restricoes_validar "$rs" "$slug"
            atual="$(cat "$rs")"
        fi
        restricoes_mostrar "$slug" "$atual" "$rs"
        return 0
    fi

    local lista='null' p limpas=()
    if [ -n "$pastas_arg" ]; then
        local itens=()
        IFS=, read -ra itens <<<"$pastas_arg"
        for p in "${itens[@]}"; do
            p="${p#"${p%%[![:space:]]*}"}"; p="${p%"${p##*[![:space:]]}"}"
            while [ "${p%/}" != "$p" ]; do p="${p%/}"; done
            [ -n "$p" ] || continue
            case "$p" in
                /*) falha "a pasta '$p' comeca por '/'. As pastas sao sempre dentro da casa do agente." "escreva so o nome, por exemplo: --escrita-so-em relatorios,rascunhos/2026" ;;
            esac
            if [[ "$p" =~ (^|/)\.{1,2}(/|$) ]]; then
                falha "a pasta '$p' tem '.' ou '..' no caminho; so aceito pastas dentro da casa do agente." "escreva o caminho direto, por exemplo: --escrita-so-em relatorios"
            fi
            case "$p" in
                .*) falha "a pasta '$p' comeca por ponto. Pastas como .dgclaw, .claude, .codex e .plataforma guardam o que o agente executa e so o dono altera." "escolha uma pasta comum, por exemplo: --escrita-so-em relatorios" ;;
            esac
            if [[ "$p" =~ [[:cntrl:]] ]]; then
                falha "a pasta tem caractere de controle no nome." "use um nome de pasta normal."
            fi
            restricoes_conferir_pasta "$h" "$p"
            limpas+=("$p")
        done
        [ "${#limpas[@]}" -gt 0 ] || falha "nao recebi nenhuma pasta em --escrita-so-em '$pastas_arg'." "exemplo: --escrita-so-em relatorios,rascunhos (ou --escrita-livre para soltar)."
        lista="$(printf '%s\n' "${limpas[@]}" | jq -R . | jq -sc 'unique')"
    fi

    # Ler, gravar, derivar e reiniciar acontecem numa transacao so, com a trava do agente.
    restricoes_com_trava "$slug" _restricoes_transacao
}

# _restricoes_transacao: usa as variaveis locais de agente_restricoes (slug, sem_bash, sem_env, lista, limpas, ...).
_restricoes_transacao() {
    local atual='{"versao":1}' novo quem="${SUDO_USER:-$(id -un)}"
    if [ -e "$rs" ] || [ -L "$rs" ]; then
        restricoes_validar "$rs" "$slug" permitir-combinacao
        atual="$(cat "$rs")"
    fi
    # shellcheck disable=SC2016 # os $ sao variaveis do jq
    novo="$(printf '%s' "$atual" | jq \
        --arg sb "$sem_bash" --arg se "$sem_env" --argjson lista "$lista" --argjson livre "$livre" \
        --argjson tocouPastas "$([ -n "$pastas_arg" ] && echo true || echo false)" \
        --arg em "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg por "$quem" '
        . + {versao: 1}
        | .sem_bash = (if $sb == "" then (.sem_bash // false) else $sb == "sim" end)
        | .sem_enviar_arquivo = (if $se == "" then (.sem_enviar_arquivo // false) else $se == "sim" end)
        | .escrita_so_em = (if $tocouPastas then $lista elif $livre == 1 then null else (.escrita_so_em // null) end)
        | .atualizado_em = $em | .atualizado_por = $por')" \
        || falha "o jq nao conseguiu montar o novo restricoes.json a partir de $rs." "confira se o arquivo e um JSON valido (jq . $rs)."

    if printf '%s' "$novo" | jq -e '(.sem_enviar_arquivo // false) == true and (.sem_bash // false) != true' >/dev/null; then
        _restricoes_recusar_combinacao "$slug"
    fi
    _restricoes_gravar "$rs" "$novo"
    if [ "$ENSAIO" != 1 ] && ! printf '%s' "$novo" | jq -e '.escrita_so_em == null or .sem_bash == true' >/dev/null; then
        aviso "este agente continua com o Bash ligado, e pelo Bash ele grava em qualquer lugar: a trava de pastas so barra as ferramentas de arquivo (Write, Edit). Para valer de verdade, combine com: dgclaw agente restricoes $slug --sem-bash sim"
    fi
    # Sem `|| falha`: um `||` desligaria o set -e la dentro e um erro de gravacao viraria "aplicado".
    aplicar_restricoes "$slug"
    [ "${#limpas[@]}" -eq 0 ] || restricoes_criar_pastas "$slug" "${limpas[@]}"
    ok "restricoes do agente $slug gravadas em $rs e aplicadas"
    if [ "$ENSAIO" != 1 ]; then restricoes_mostrar "$slug" "$novo" "$rs"; fi
}

# restricoes_mostrar <slug> <json> <arquivo>
restricoes_mostrar() {
    local slug="$1" json="$2" rs="$3" pastas
    printf '\nRestricoes do agente %s\n' "$slug"
    if [ ! -e "$rs" ]; then
        printf '  Nenhuma restricao definida (o agente faz tudo o que o DG Claw permite).\n'
        printf '  Para travar: dgclaw agente restricoes %s --sem-bash sim --sem-enviar-arquivo sim --escrita-so-em pasta1,pasta2\n' "$slug"
        return 0
    fi
    printf '  Bash (terminal):       %s\n' "$(printf '%s' "$json" | jq -r 'if (.sem_bash // false) then "TRAVADO" else "liberado" end')"
    printf '  Enviar arquivos:       %s\n' "$(printf '%s' "$json" | jq -r 'if (.sem_enviar_arquivo // false) then "TRAVADO" else "liberado" end')"
    pastas="$(printf '%s' "$json" | jq -r 'if (.escrita_so_em // null) == null then "qualquer lugar" else "so em " + (.escrita_so_em | join(", ")) end')"
    printf '  Gravar arquivos em:    %s\n' "$pastas"
    printf '  Atualizado em:         %s por %s\n' "$(printf '%s' "$json" | jq -r '.atualizado_em // "?"')" "$(printf '%s' "$json" | jq -r '.atualizado_por // "?"')"
    printf '  Arquivo:               %s\n' "$rs"
}
