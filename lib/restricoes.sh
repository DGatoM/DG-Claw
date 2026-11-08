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
#     /etc/claude-code/managed-settings.json a ele). Leva o gancho de escrita (com qualquer restricao ligada), e o
#     permissions.deny. Fica fora
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

# _restricoes_gravar <alvo> <conteudo>: grava o arquivo (root, 444) por temporario na mesma pasta + mv.
# Cada passo e conferido na mao (sem `if !` em volta de funcao, que desligaria o set -e la dentro): uma falha de
# escrita (disco cheio) nunca chega ao mv, o destino bom fica como estava e so o temporario e apagado.
# Arquivo .json so troca o destino depois de o temporario passar no `jq -e .`.
_restricoes_gravar() {
    local alvo="$1" conteudo="$2" dir base tmp
    dir="$(dirname "$alvo")"; base="$(basename "$alvo")"
    if [ "$ENSAIO" = 1 ]; then
        printf '   [ensaio] escreveria %s (modo 444, dono root)\n' "$alvo"
        return 0
    fi
    _restricoes_gravar_falhou() {
        [ -z "$tmp" ] || rm -f -- "$tmp"
        falha "nao consegui gravar $alvo (passo: $1); o arquivo anterior ficou como estava." \
            "confira o espaco em disco e a permissao de $dir (ls -ld $dir; df -h $dir) e rode de novo."
    }
    tmp=""
    mkdir -p -- "$dir" || _restricoes_gravar_falhou "criar a pasta $dir"
    tmp="$(mktemp "$dir/.$base.XXXXXX")" || { tmp=""; _restricoes_gravar_falhou "criar o arquivo temporario"; }
    printf '%s\n' "$conteudo" >"$tmp" || _restricoes_gravar_falhou "escrever o conteudo no temporario"
    case "$base" in
        *.json) jq -e . "$tmp" >/dev/null 2>&1 || _restricoes_gravar_falhou "conferir que o temporario e um JSON valido" ;;
    esac
    chmod 444 "$tmp" || _restricoes_gravar_falhou "ajustar o modo do temporario"
    dono 0:0 "$tmp" || _restricoes_gravar_falhou "dar o dono root ao temporario"
    mv -f -- "$tmp" "$alvo" || _restricoes_gravar_falhou "trocar o temporario pelo arquivo"
}

# Le os provedor.json da casa do agente DENTRO da caixa, como o usuario agente (podman exec --user agente
# <caixa> node -e <este texto> /home/agente/.plataforma [id...]). Os arquivos sao do agente: o root nao os abre
# (um FIFO ali travaria o jq para sempre). Abre com O_NOFOLLOW|O_NONBLOCK, exige arquivo regular de ate 64 KiB e
# lista as sessoes paralelas por aqui. Imprime uma linha "id|resultado" por sessao (id vazio = principal);
# resultado: claude, codex, vazio (sem arquivo ou sem provedor valido) ou ? (em duvida). A linha "!|?" avisa que a
# pasta das sessoes nao pode ser listada.
PROVEDOR_JS='const fs = require("fs"), path = require("path");
const base = process.argv[1], extras = process.argv.slice(2);
const norm = (v) => {
  const s = (v == null || v === false ? "" : String(v)).trim().toLowerCase();
  return (s === "claude" || s === "local-cli" || s === "claude-code") ? "claude" : (s === "codex" || s === "codex-cli") ? "codex" : "";
};
const ler = (arq) => {
  let fd;
  try { fd = fs.openSync(arq, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (e) { return (e.code === "ENOENT" || e.code === "ENOTDIR") ? "" : "?"; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 65536) return "?";
    const buf = Buffer.alloc(st.size); let n = 0;
    while (n < st.size) { const r = fs.readSync(fd, buf, n, st.size - n, n); if (r <= 0) break; n += r; }
    const j = JSON.parse(buf.toString("utf8", 0, n));
    return (j && typeof j === "object" && !Array.isArray(j)) ? norm(j.provedor) : "?";
  } catch (e) { return "?"; } finally { try { fs.closeSync(fd); } catch (_) {} }
};
const ids = new Set(extras); let listagem = true;
const dir = path.join(base, "sessoes");
try { if (fs.lstatSync(dir).isDirectory()) for (const d of fs.readdirSync(dir)) ids.add(d); } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") listagem = false; }
const saida = ["|" + ler(path.join(base, "provedor.json"))];
if (!listagem) saida.push("!|?");
for (const id of ids) {
  if (/^[A-Za-z0-9._-]+$/.test(id)) saida.push(id + "|" + ler(path.join(dir, id, "provedor.json")));
}
console.log(saida.join("\n"));'

# Le DENTRO da caixa, como o usuario agente, a politica remota do Claude Code (conta de uma organizacao claude.ai
# com "server-managed settings"): o cache fica em /home/agente/.claude/remote-settings.json e vence a configuracao
# administrada local. Mesmo padrao seguro do PROVEDOR_JS (O_NOFOLLOW|O_NONBLOCK, fstat, so arquivo regular, ate
# 1 MiB). Imprime uma palavra: sem (arquivo ausente ou objeto vazio), com (objeto com pelo menos uma chave, qualquer
# que seja: nao da para validar chave por chave o que a organizacao pode desligar, nem com "managedSourcesBehavior":
# "merge", porque "disableAllHooks" na mesma politica desliga ate os ganchos administrados) ou duvida (qualquer outra coisa).
REMOTA_JS='const fs = require("fs");
let fd;
try { fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
catch (e) { console.log((e.code === "ENOENT" || e.code === "ENOTDIR") ? "sem" : "duvida"); process.exit(0); }
try {
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.size > 1048576) { console.log("duvida"); process.exit(0); }
  const buf = Buffer.alloc(st.size); let n = 0;
  while (n < st.size) { const r = fs.readSync(fd, buf, n, st.size - n, n); if (r <= 0) break; n += r; }
  const j = JSON.parse(buf.toString("utf8", 0, n));
  if (!j || typeof j !== "object" || Array.isArray(j)) console.log("duvida");
  else if (Object.keys(j).length === 0) console.log("sem");
  else console.log("com");
} catch (e) { console.log("duvida"); } finally { try { fs.closeSync(fd); } catch (_) {} }'


# _restricoes_provedor_parado <arquivo>: com o agente parado nenhum processo dele roda, entao o root le, mas
# recusa link e o que nao e arquivo regular (um FIFO travaria a leitura), com prazo e limite de tamanho.
# Imprime claude, codex, vazio ou ? (em duvida). O jq recebe o texto pelo STDIN.
_restricoes_provedor_parado() {
    local arq="$1" txt
    if [ ! -e "$arq" ] && [ ! -L "$arq" ]; then return 0; fi
    if [ -L "$arq" ] || [ ! -f "$arq" ]; then printf '?'; return 0; fi
    [ "$(stat -c %s -- "$arq" 2>/dev/null || echo 99999999)" -le 65536 ] || { printf '?'; return 0; }
    txt="$(timeout 5 head -c 65536 -- "$arq" 2>/dev/null)" || { printf '?'; return 0; }
    printf '%s' "$txt" | timeout 5 jq -r "$_RESTRICOES_NORM"' if type == "object" then (.provedor // "" | norm) else "?" end' 2>/dev/null || printf '?'
}
# shellcheck disable=SC2016 # os $ sao variaveis do jq
_RESTRICOES_NORM='def norm: tostring | ascii_downcase | gsub("^\\s+|\\s+$"; "") | if . == "claude" or . == "local-cli" or . == "claude-code" then "claude" elif . == "codex" or . == "codex-cli" then "codex" else "" end;'

# _restricoes_sessoes_em_codex <casa> <container> <rodando 0|1>: lista (separada por "; ") as sessoes do agente que
# rodam no Codex, ou cujo provedor nao deu para ler. Segue a ordem do runner (runner/src/provedores/escolha.ts): o
# provedor.json da sessao vence (principal em home/.plataforma/provedor.json, paralela em
# home/.plataforma/sessoes/<id>/provedor.json), depois o descritor (sessoes[].provider da paralela,
# config.provider), depois Claude. A escolha do painel nunca passa pelo runner.json, por isso so olhar o runner.json
# deixava o aviso de fora. Os arquivos da casa sao do agente: com o agente ligado sao lidos DENTRO da caixa, pelo
# usuario agente, com prazo (PROVEDOR_JS); parado, o root le com as protecoes de _restricoes_provedor_parado.
# Qualquer falha, prazo estourado ou arquivo estranho vira "em duvida" e nunca impede o comando de seguir.
# So le (nada e gravado na casa do agente). Imprime vazio quando todas as sessoes estao no Claude.
_restricoes_sessoes_em_codex() {
    local casa="$1" c="$2" rodando="$3" id nome res achados=() ids=() d lido="" l k v
    local rj="$casa/runner/runner.json" est="$casa/home/.plataforma"
    local -A visto=()
    if [ -f "$rj" ]; then
        while IFS= read -r id; do [ -z "$id" ] || ids+=("$id"); done < <(timeout 5 jq -r '(.sessoes // [])[]? | .id? // empty' "$rj" 2>/dev/null || true)
    fi
    if [ "$rodando" = 1 ]; then
        lido="$(timeout 10 podman exec --user agente "$c" node -e "$PROVEDOR_JS" /home/agente/.plataforma "${ids[@]}" 2>/dev/null)" || lido=""
        while IFS= read -r l; do
            [ -n "$l" ] || continue
            k="${l%%|*}"; v="${l#*|}"
            visto["s:$k"]="$v"
            [[ "$k" =~ ^[A-Za-z0-9._-]*$ ]] && { [ -z "$k" ] || [[ " ${ids[*]} " == *" $k "* ]] || ids+=("$k"); }
        done <<<"$lido"
        [ -z "${visto["s:!"]+x}" ] || achados+=("paralelas: nao consegui listar as sessoes")
    elif [ -d "$est/sessoes" ] && [ ! -L "$est" ] && [ ! -L "$est/sessoes" ]; then
        for d in "$est"/sessoes/*/; do
            id="$(basename "$d")"
            [[ "$id" =~ ^[A-Za-z0-9._-]+$ ]] || continue
            [[ " ${ids[*]} " == *" $id "* ]] || ids+=("$id")
        done
    fi
    for id in "" "${ids[@]}"; do
        if [ -z "$id" ]; then nome="principal"; else nome="paralela $id"; fi
        if [ "$rodando" = 1 ]; then
            res="${visto["s:$id"]-?}"
        elif [ -L "$est" ] || { [ -n "$id" ] && [ -L "$est/sessoes" ]; }; then
            res="?"
        elif [ -z "$id" ]; then res="$(_restricoes_provedor_parado "$est/provedor.json")"
        else res="$(_restricoes_provedor_parado "$est/sessoes/$id/provedor.json")"
        fi
        if [ "$res" = "?" ]; then
            achados+=("$nome: nao consegui ler o provedor.json"); continue
        fi
        # shellcheck disable=SC2016 # os $ sao variaveis do jq
        if [ -z "$res" ]; then
            if [ ! -f "$rj" ]; then res=claude
            elif ! res="$(timeout 5 jq -r --arg id "$id" "$_RESTRICOES_NORM"' ((if $id == "" then "" else ((.sessoes // [])[]? | select(.id == $id) | .provider // "") end) | norm) as $s | if $s != "" then $s else ((.config.provider // "") | norm) end' "$rj" 2>/dev/null)"; then
                achados+=("$nome: nao consegui ler $rj"); continue
            fi
            [ -n "$res" ] || res=claude
        fi
        [ "$res" != codex ] || achados+=("$nome: Codex")
    done
    local IFS=';'
    [ "${#achados[@]}" -eq 0 ] || printf '%s' "${achados[*]}" | sed 's/;/; /g'
}

# _restricoes_conferir_suporte <slug> <esperado>: com o container RODANDO, confere DENTRO dele (como root, so
# lendo /etc e a imagem, que o agente nao controla) que a imagem carrega a configuracao administrada: o link
# /etc/claude-code/managed-settings.json aponta para a pasta do runner, o conteudo visto la e o <esperado> e o
# script do gancho de escrita existe, e que a conta de IA do agente nao traz politica administrada remota (que
# substituiria a local; ver REMOTA_JS). Agente parado numa imagem antiga (ex.: durante `dgclaw atualizar`) sobe sem
# nada disso, e o gancho que protege o .dgclaw/config.sh nao vale. Devolve 0 se tudo certo; senao 1, com o motivo
# em RESTRICOES_SUPORTE_MOTIVO. Nao grava nada.
_restricoes_conferir_suporte() {
    local c="dgclaw-$1" esperado="$2" alvo=/etc/claude-code/managed-settings.json destino=/etc/dgclaw-runner/managed-settings.json lnk visto script
    script="${GANCHO_ESCRITA_CMD##* }"
    RESTRICOES_SUPORTE_MOTIVO=""; RESTRICOES_SUPORTE_CAUSA=imagem; RESTRICOES_REMOTA=""
    lnk="$(timeout 15 podman exec "$c" readlink "$alvo" 2>/dev/null)" || lnk=""
    if [ "$lnk" != "$destino" ]; then
        RESTRICOES_SUPORTE_MOTIVO="dentro do container $alvo ${lnk:+aponta para $lnk e nao para $destino}${lnk:-nao existe ou nao e um link}"
        return 1
    fi
    visto="$(timeout 15 podman exec "$c" cat "$alvo" 2>/dev/null | timeout 5 jq -c . 2>/dev/null || true)"
    if [ "$visto" != "$esperado" ]; then
        RESTRICOES_SUPORTE_MOTIVO="o conteudo de $alvo visto dentro do container ($(printf '%s' "${visto:-vazio ou ilegivel}" | head -c 120)) nao e o que acabou de ser gravado"
        return 1
    fi
    if ! timeout 15 podman exec "$c" test -f "$script" -a -x /usr/bin/node -a -x /usr/bin/env >/dev/null 2>&1; then
        RESTRICOES_SUPORTE_MOTIVO="a imagem nao traz o script do gancho de escrita ($script) ou o node"
        return 1
    fi
    # A politica remota de uma organizacao claude.ai substitui a local inteira (inclusive o gancho): so se le com o
    # container ligado e como agente, porque o arquivo e dele.
    RESTRICOES_REMOTA="$(timeout 10 podman exec --user agente "$c" node -e "$REMOTA_JS" /home/agente/.claude/remote-settings.json 2>/dev/null | head -n 1)" || RESTRICOES_REMOTA=""
    case "$RESTRICOES_REMOTA" in sem|com|duvida) ;; *) RESTRICOES_REMOTA=duvida ;; esac
    case "$RESTRICOES_REMOTA" in
        com) RESTRICOES_SUPORTE_MOTIVO="a conta de IA conectada tem politica administrada remota (/home/agente/.claude/remote-settings.json), que substitui a configuracao do DG Claw" ;;
        duvida) RESTRICOES_SUPORTE_MOTIVO="nao consegui ler com seguranca /home/agente/.claude/remote-settings.json (link, arquivo estranho, grande demais, JSON invalido ou prazo estourado), entao nao sei se a conta de IA conectada tem politica administrada remota, que substituiria a configuracao do DG Claw" ;;
    esac
    case "$RESTRICOES_REMOTA" in com|duvida) RESTRICOES_SUPORTE_CAUSA=remota; return 1 ;; esac
    return 0
}

# _restricoes_suporte_falhou <slug>: a falha comum da conferencia de suporte. Sempre vem depois de
# _restricoes_parar_por_falha: o container ja esta parado, e por isso o recriar precisa do --forcar (sem ele o recriar
# deixa parado como esta).
_restricoes_suporte_falhou() {
    local slug="$1"
    if [ "${RESTRICOES_SUPORTE_CAUSA:-}" = remota ]; then
        falha "as restricoes do agente $slug NAO valem: $RESTRICOES_SUPORTE_MOTIVO. A politica remota de uma organizacao do claude.ai vence a configuracao local, e o agente poderia gravar arquivos que as rotinas dele executam. Parei o container, porque agente com restricao ligada nao roda sem a trava. Os arquivos das restricoes ficaram gravados." \
            "conecte no agente uma conta pessoal (Pro ou Max) ou uma chave de API, ou desligue as restricoes dele. Depois rode: dgclaw agente reiniciar $slug"
    fi
    falha "o agente $slug roda numa imagem antiga que nao carrega a configuracao administrada do Claude Code ($RESTRICOES_SUPORTE_MOTIVO). Por isso as restricoes NAO valem: o agente ainda poderia mudar arquivos que as rotinas dele executam. Parei o container, porque agente com restricao ligada nao roda sem a trava. Os arquivos das restricoes ficaram gravados." \
        "recrie o agente com a imagem atual: dgclaw agente recriar $slug --forcar (--forcar porque o agente ficou parado; se a imagem do servidor tambem estiver velha, antes: dgclaw imagem construir --agora). O recriar liga o agente de novo ja conferindo as restricoes."
}

# _restricoes_parar_por_falha <slug> <motivo> [etapa]: o container esta ligado e nao da para garantir a trava. A
# contencao vem primeiro e e conferida (stop; se ainda estiver ligado, kill; se mesmo assim estiver, falha dizendo que
# o agente esta LIGADO SEM A TRAVA). O marcador de pendencia e o log vem depois, cada um num subshell: disco cheio
# ou erro de escrita nunca impedem a parada. Etapa: iniciar (padrao) ou aplicar. Quem chama termina com `falha`.
_restricoes_parar_por_falha() {
    local slug="$1" casa="$DG_CASAS/$1" c="dgclaw-$1" etapa="${3:-iniciar}" estado=""
    ( executar timeout 60 podman stop "$c" >/dev/null ) || true
    if [ "$ENSAIO" != 1 ]; then
        estado="$(timeout 15 podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null || true)"
        case "$estado" in
            running|stopping)
                ( timeout 30 podman kill "$c" >/dev/null 2>&1 ) || true
                estado="$(timeout 15 podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null || true)"
                case "$estado" in
                    running|stopping)
                        ( _restricoes_log "$slug" "$etapa: $2; NAO consegui parar o container (estado: $estado)" ) || true
                        falha "o agente $slug esta LIGADO SEM A TRAVA: $2. Tentei parar o container (podman stop e podman kill) e ele continua $estado." \
                            "pare o agente na mao agora: dgclaw agente parar $slug (ou: podman stop dgclaw-$slug / podman kill dgclaw-$slug). Depois resolva o motivo acima e rode: dgclaw agente iniciar $slug"
                        ;;
                esac
                ;;
        esac
    fi
    if [ ! -e "$casa/runner/restricoes-suporte.pendente" ]; then
        ( _restricoes_gravar "$casa/runner/restricoes-suporte.pendente" "conferencia de suporte pendente desde $(date -u +%FT%TZ)" ) \
            || aviso "o container do agente $slug FOI parado, mas nao consegui gravar o marcador $casa/runner/restricoes-suporte.pendente (provavel: disco cheio ou pasta sem permissao). Confira com: df -h /var/lib/dgclaw ; ls -l $casa/runner"
    fi
    ( _restricoes_log "$slug" "$etapa: $2; container parado" ) || true
}

# restricoes_conferir_ao_iniciar <slug>: segunda camada, com o container ja ligado (a primeira, antes de ligar, esta em
# restricoes_antes_de_ligar). Agente com restricao ligada nao roda sem a trava: se a imagem nao carrega a configuracao
# administrada, ou se a configuracao gravada nao serve (ausente, vazia, invalida) ou o restricoes.json nao da para
# ler, o container e PARADO e o comando falha. Sem restricoes.json, ou com tudo desligado, nao ha o que conferir.
restricoes_conferir_ao_iniciar() {
    local slug="$1" casa="$DG_CASAS/$1" rs ms esperado ligada
    rs="$casa/runner/restricoes.json"; ms="$casa/runner/managed-settings.json"
    [ "$ENSAIO" = 1 ] && return 0
    # O container acabou de ligar (ou o runner acabou de reiniciar) com os arquivos ja regenerados: um reinicio
    # pendente deixou de fazer sentido. Se algo abaixo falhar, o container e parado e o marcador de suporte fica.
    rm -f -- "$casa/runner/restricoes.pendente"
    if [ ! -e "$rs" ] && [ ! -L "$rs" ]; then
        rm -f -- "$casa/runner/restricoes-suporte.pendente"
        return 0
    fi
    if [ -L "$rs" ] || ! ligada="$(jq -r '.sem_bash == true or .sem_enviar_arquivo == true or ((.escrita_so_em // null) != null)' "$rs" 2>/dev/null)"; then
        _restricoes_parar_por_falha "$slug" "restricoes.json ilegivel ou invalido"
        falha "nao consegui ler $rs (restricoes do agente $slug), entao nao sei quais travas valem. Parei o container." \
            "confira com: jq . $rs . Corrija o arquivo, ou refaca as restricoes pelo comando: dgclaw agente restricoes $slug --sem-bash sim|nao --sem-enviar-arquivo sim|nao --escrita-so-em pasta1,pasta2"
    fi
    if [ "$ligada" != true ]; then
        rm -f -- "$casa/runner/restricoes-suporte.pendente"
        return 0
    fi
    esperado="$(jq -c . "$ms" 2>/dev/null || true)"
    if [ -z "$esperado" ] || [ "$esperado" = '{}' ]; then
        _restricoes_parar_por_falha "$slug" "managed-settings.json ausente, vazio ou invalido com restricao ligada"
        falha "o agente $slug tem restricao ligada, mas $ms esta ausente, vazio ou invalido, entao as travas nao valem. Parei o container." \
            "ligue de novo com: dgclaw agente iniciar $slug (ele refaz os arquivos a partir do restricoes.json e confere antes de ligar)"
    fi
    if ! _restricoes_conferir_suporte "$slug" "$esperado"; then
        _restricoes_parar_por_falha "$slug" "configuracao administrada nao vale ($RESTRICOES_SUPORTE_MOTIVO)"
        _restricoes_suporte_falhou "$slug"
    fi
    rm -f -- "$casa/runner/restricoes-suporte.pendente"
}

# _restricoes_imagem_com_suporte <slug>: confere, SEM ligar o container, que a imagem com que ele foi criado carrega
# a configuracao administrada (LABEL dgclaw.configuracao-administrada=1 no container/Containerfile, junto do link
# /etc/claude-code/managed-settings.json). Devolve 0 ou 1, com o motivo em RESTRICOES_SUPORTE_MOTIVO.
_restricoes_imagem_com_suporte() {
    local c="dgclaw-$1" id marca
    RESTRICOES_SUPORTE_MOTIVO=""
    id="$(timeout 15 podman container inspect --format '{{.Image}}' "$c" 2>/dev/null)" || id=""
    if [ -z "$id" ]; then
        RESTRICOES_SUPORTE_MOTIVO="nao consegui ler qual imagem o container $c usa"
        return 1
    fi
    marca="$(timeout 15 podman image inspect --format '{{index .Labels "dgclaw.configuracao-administrada"}}' "$id" 2>/dev/null)" || marca=""
    if [ "$marca" != 1 ]; then
        RESTRICOES_SUPORTE_MOTIVO="a imagem do container $c nao traz o marcador dgclaw.configuracao-administrada"
        return 1
    fi
    return 0
}

# restricoes_antes_de_ligar <slug>: PRIMEIRA camada, antes de ligar (ou reiniciar) um container que ja existe, sempre
# dentro da trava do agente (restricoes_com_trava). Sem restricoes.json nao faz nada. Com ele:
#   a) regenera managed-settings.json e runner.json a partir do restricoes.json (o aplicar completo, sem reiniciar) e
#      relê o que gravou. Arquivo ilegivel, invalido ou link, ou falha de gravacao (disco cheio): o agente NAO liga.
#      Sem isto, um arquivo permissivo antigo ficaria valendo se a gravacao anterior parou no meio;
#   b) com restricao ligada, confere que a imagem do container carrega a configuracao administrada. O runner sobe
#      sozinho pelo systemd, e conferir so depois de ligar deixaria uma janela sem o gancho.
restricoes_antes_de_ligar() {
    local slug="$1" rs="$DG_CASAS/$1/runner/restricoes.json" ligada
    [ "$ENSAIO" = 1 ] && return 0
    if [ ! -e "$rs" ] && [ ! -L "$rs" ]; then return 0; fi
    _aplicar_restricoes_sem_trava "$slug" --sem-reiniciar
    ligada="$(jq -r '.sem_bash == true or .sem_enviar_arquivo == true or ((.escrita_so_em // null) != null)' "$rs")" \
        || falha "nao consegui ler $rs (restricoes do agente $slug) depois de aplicar; nao liguei o agente." "confira com: jq . $rs"
    [ "$ligada" = true ] || return 0
    if ! _restricoes_imagem_com_suporte "$slug"; then
        _restricoes_log "$slug" "ligar: nao liguei, $RESTRICOES_SUPORTE_MOTIVO"
        falha "o agente $slug tem restricao ligada, mas nao liguei o container: $RESTRICOES_SUPORTE_MOTIVO. Uma imagem antiga nao carrega a configuracao administrada do Claude Code, e sem ela as restricoes nao valem (o agente ainda poderia mudar arquivos que as rotinas dele executam). Os arquivos das restricoes ficaram gravados." \
            "recrie o agente com a imagem atual: dgclaw agente recriar $slug --forcar (--forcar porque o agente esta parado; se a imagem do servidor tambem estiver velha, antes: dgclaw imagem construir --agora). O recriar liga o agente de novo ja conferindo as restricoes."
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
    local pend="$casa/runner/restricoes.pendente" pend_mig="$casa/runner/restricoes-migracao.pendente" pend_sup="$casa/runner/restricoes-suporte.pendente"
    local sem_bash=false sem_env=false pastas=null mudou=0 novo_rj="" novo_ms ms_existia=0 grav_ms=0 grav_rj=0 base="" deny_json='[]' codex_em rodando=0 vai_ms=0 vai_rj=0 saida rc ativo=false pronto i

    if [ "$runner_novo" = 1 ]; then base="$(cat)"; fi
    if [ -e "$rs" ] || [ -L "$rs" ]; then
        restricoes_validar "$rs" "$slug"
        # Cada campo sai direto como JSON (jq -c): o @tsv escapava de novo as aspas e barras invertidas do nome
        # das pastas, e o --argjson la embaixo recusava a lista.
        if ! sem_bash="$(jq -c '.sem_bash // false' "$rs")" || ! sem_env="$(jq -c '.sem_enviar_arquivo // false' "$rs")" \
            || ! pastas="$(jq -c '.escrita_so_em // null' "$rs")"; then
            falha "nao consegui ler $rs (restricoes do agente $slug)." "confira com: jq . $rs"
        fi
    fi
    if [ "$ENSAIO" = 1 ]; then
        info "[ensaio] aplicaria as restricoes de $rs no managed-settings.json e no runner.json do agente $slug"
        return 0
    fi
    # Monitor (Claude Code 2.1.296) executa shell por conta propria e a checagem dele ignora a regra `Bash` sem padrao:
    # sem negar o nome dele, as tres travas do terminal seriam contornadas.
    deny_json="$(jq -nc --argjson bash "$sem_bash" --argjson env "$sem_env" '
        [if $bash then "Bash", "BashOutput", "KillShell", "Monitor" else empty end]
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
    ativo=false
    if [ "$sem_bash" = true ] || [ "$sem_env" = true ] || [ "$pastas" != null ]; then ativo=true; fi
    # shellcheck disable=SC2016 # os $ sao variaveis do jq
    # Qualquer restricao ligada instala o gancho (sem escrita_so_em ele roda no modo "so protegidos": fecha
    # .dgclaw, .claude, SKILL.md... que o agente poderia usar para executar comando sem o Bash). onFailure=block:
    # gancho que nao inicia, morre ou passa do tempo bloqueia em vez de liberar.
    # NAO usar allowManagedHooksOnly: o runner passa os ganchos de status do agente (Stop, PreToolUse...) por
    # --settings a cada sessao, e essa chave poderia desliga-los e o painel perderia o estado do agente.
    novo_ms="$(jq -nc --argjson pastas "$pastas" --argjson deny "$deny_json" --argjson ativo "$ativo" --arg cmd "$GANCHO_ESCRITA_CMD" --arg m "$GANCHO_ESCRITA_MATCHER" '
        {}
        | (if $ativo then .hooks = {PreToolUse: [{matcher: $m, hooks: [{type: "command", command: $cmd, timeout: 10, onFailure: "block"}]}]} else . end)
        | (if ($deny | length) > 0 then .permissions = {deny: $deny} else . end)')" \
        || falha "o jq nao conseguiu montar o managed-settings.json do agente $slug." "isto e um erro do DG Claw; abra uma issue com a saida acima."

    [ "$(podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null || true)" = running ] && rodando=1
    # --- grava: configuracao administrada primeiro, para o runner nunca subir sem a trava ---
    if [ -L "$ms" ]; then
        falha "$ms e um link; nao gravo nele." "apague o link e rode de novo: dgclaw agente reparar $slug"
    fi
    [ -f "$ms" ] && ms_existia=1
    # Primeiro DECIDE o que vai mudar; com reinicio a fazer, o marcador de pendencia entra ANTES de qualquer
    # arquivo ser trocado. Gravar o marcador depois deixaria uma janela (disco cheio) em que os arquivos novos
    # estao no lugar, nao ha marcador, e a proxima execucao os acha iguais e nao reinicia o runner.
    vai_ms=0; vai_rj=0
    if [ ! -f "$ms" ] || [ "$(jq -c . "$ms" 2>/dev/null || true)" != "$novo_ms" ]; then vai_ms=1; fi
    if [ -n "$novo_rj" ] && { [ "$runner_novo" = 1 ] || [ "$(printf '%s' "$novo_rj" | jq -c .)" != "$(jq -c . "$rj")" ]; }; then vai_rj=1; fi
    if [ "$reiniciar" = 1 ] && [ "$rodando" = 1 ] && [ ! -e "$pend" ] \
        && { [ "$vai_rj" = 1 ] || { [ "$vai_ms" = 1 ] && { [ "$novo_ms" != '{}' ] || [ "$ms_existia" = 1 ]; }; }; }; then
        _restricoes_gravar "$pend" "reinicio do runner pendente desde $(date -u +%FT%TZ)"
    fi
    if [ "$vai_ms" = 1 ]; then
        _restricoes_gravar "$ms" "$novo_ms"
        # `{}` num arquivo que nao existia nao muda nada para o agente: nao conta como mudanca.
        if [ "$novo_ms" != '{}' ] || [ "$ms_existia" = 1 ]; then mudou=1; fi
        grav_ms=1
    fi
    if [ "$vai_rj" = 1 ]; then
        _restricoes_gravar "$rj" "$novo_rj"
        mudou=1
        grav_rj=1
    fi

    # --- migracao: versoes antigas gravavam o gancho no settings.json da casa, onde o agente o desligava ---
    # Quem mexe nesse arquivo e o usuario agente, DENTRO da caixa. O root nao le nem grava nada na casa: entre
    # uma checagem de atalho e a gravacao o agente troca .claude por um link para /root/.claude. So agentes que ja
    # tiveram restricoes (restricoes.json) podem ter o gancho antigo.
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
    # --- o container precisa carregar a politica: so o arquivo gravado nao basta (imagem antiga nao a le) ---
    if [ "$novo_ms" = '{}' ]; then
        rm -f -- "$pend_sup"
    elif [ "$rodando" = 1 ]; then
        if _restricoes_conferir_suporte "$slug" "$novo_ms"; then
            rm -f -- "$pend_sup"
        else
            # O marcador de reinicio fica: depois de recriar, a proxima execucao reinicia o runner e confere de novo.
            _restricoes_parar_por_falha "$slug" "configuracao administrada nao vale ($RESTRICOES_SUPORTE_MOTIVO): restricoes gravadas mas NAO valem" aplicar
            if [ ! -e "$pend" ]; then
                ( _restricoes_gravar "$pend" "reinicio do runner pendente desde $(date -u +%FT%TZ)" ) \
                    || aviso "o container do agente $slug FOI parado, mas nao consegui gravar o marcador $pend (provavel: disco cheio). Confira com: df -h /var/lib/dgclaw"
            fi
            _restricoes_suporte_falhou "$slug"
        fi
    else
        [ -e "$pend_sup" ] || _restricoes_gravar "$pend_sup" "conferencia de suporte pendente desde $(date -u +%FT%TZ)"
        aviso "o agente $slug esta parado, entao nao deu para conferir se a imagem dele carrega a configuracao administrada. A conferencia sera feita quando o agente ligar (dgclaw agente iniciar $slug); se a imagem for antiga, o agente nao liga e a mensagem diz como recriar."
    fi
    [ "$grav_ms" = 0 ] || [ "$novo_ms" = '{}' ] || ok "configuracao administrada do agente $slug gravada (gancho de escrita: $([ "$ativo" = true ] && { [ "$pastas" != null ] && echo "ligado, grava so nas pastas" || echo "ligado, protege so a configuracao"; } || echo desligado); ferramentas negadas: $(printf '%s' "$deny_json" | jq -r 'if length == 0 then "nenhuma" else join(", ") end'))"
    [ "$grav_rj" = 0 ] || ok "runner.json do agente $slug ajustado (Bash: $([ "$sem_bash" = true ] && echo travado || echo liberado), envio de arquivo: $([ "$sem_env" = true ] && echo travado || echo liberado))"

    # --- Codex: o runner ignora allow/deny e os ganchos do Claude Code ---
    if [ "$sem_bash" = true ] || [ "$sem_env" = true ] || [ "$pastas" != null ]; then
        codex_em="$(_restricoes_sessoes_em_codex "$casa" "$c" "$rodando")"
        if [ -n "$codex_em" ]; then
            aviso "o agente $slug tem sessoes em Codex ou com o provedor em duvida ($codex_em), e no Codex estas travas ainda NAO valem (o runner ignora as regras de ferramentas e os ganchos do Claude Code). O arquivo $rs fica guardado e passa a valer na sessao que voltar para o Claude."
            _restricoes_log "$slug" "aviso: sessoes em Codex ou em duvida ($codex_em), restricoes gravadas mas nao aplicadas pelo runner (sem_bash=$sem_bash sem_enviar_arquivo=$sem_env escrita_so_em=$pastas)"
        fi
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
                pronto=""
                for ((i = 0; i < ${TEMPO_ESPERA:-60}; i++)); do
                    pronto="$(podman exec "$c" systemctl is-active dgclaw-runner 2>/dev/null || true)"
                    [ "$pronto" = active ] && break
                    sleep 1
                done
                if [ "$pronto" != active ]; then
                    falha "reiniciei o runner do agente $slug, mas ele nao voltou a responder active (systemctl is-active devolveu '${pronto:-nada}'); as restricoes novas ainda nao valem para ele." \
                        "veja o log: podman exec $c journalctl -u dgclaw-runner -n 50 . A pendencia ficou guardada em $pend: depois de consertar, rode de novo o mesmo comando ou: dgclaw agente reiniciar $slug (os dois reiniciam o runner; o reparar nao)."
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
    exigir_casa_sem_link "$casa" "$h" "$slug" "dgclaw agente restricoes $slug --sem-bash sim|nao ..."

    if [ -z "$sem_bash$sem_env$pastas_arg" ] && [ "$livre" = 0 ]; then
        if [ -e "$rs" ] || [ -L "$rs" ]; then
            restricoes_validar "$rs" "$slug"
            atual="$(cat "$rs")"
        fi
        restricoes_mostrar "$slug" "$atual" "$rs" consulta
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

# _restricoes_pendencias <slug>: imprime uma linha por marcador de pendencia (conteudo do marcador), so lendo a pasta
# runner/ do dono. Nada e gravado nem lido da casa do agente.
_restricoes_pendencias() {
    local casa="$DG_CASAS/$1" f txt
    for f in restricoes.pendente restricoes-suporte.pendente restricoes-migracao.pendente; do
        if [ -e "$casa/runner/$f" ] || [ -L "$casa/runner/$f" ]; then
            txt=""
            if [ -f "$casa/runner/$f" ] && [ ! -L "$casa/runner/$f" ]; then txt="$(head -c 200 -- "$casa/runner/$f" 2>/dev/null | head -n 1 || true)"; fi
            printf '%s|%s\n' "$f" "${txt:-marcador sem texto}"
        fi
    done
}

# restricoes_mostrar <slug> <json> <arquivo> [consulta]
# Mostra o configurado. Com o 4o argumento "consulta" (o comando sem opcoes), mostra tambem o que esta VALENDO: so
# le (marcadores de pendencia da pasta do dono, /etc e a imagem dentro do container, e o provedor das sessoes por
# dentro da caixa) e sai sempre com 0, porque consulta e informacao e o chat do Admin pinta de vermelho todo
# comando que sai com codigo diferente de 0.
restricoes_mostrar() {
    local slug="$1" json="$2" rs="$3" consulta="${4:-}" pastas ligada casa="$DG_CASAS/$1" c="dgclaw-$1"
    local marcador txt estado=parado esperado="" codex_em="" motivo="" pend_linhas=() nome cmd rotulo quem_liga
    printf '\nRestricoes do agente %s\n' "$slug"
    if [ ! -e "$rs" ]; then
        printf '  Nenhuma restricao definida (o agente faz tudo o que o DG Claw permite).\n'
        printf '  Para travar: dgclaw agente restricoes %s --sem-bash sim --sem-enviar-arquivo sim --escrita-so-em pasta1,pasta2\n' "$slug"
        return 0
    fi
    ligada="$(printf '%s' "$json" | jq -r '(.sem_bash // false) or (.sem_enviar_arquivo // false) or ((.escrita_so_em // null) != null)')"
    if [ "$ENSAIO" != 1 ] && [ "$(podman inspect -f '{{.State.Status}}' "$c" 2>/dev/null || true)" = running ]; then estado=ligado; fi
    if [ "$estado" = ligado ]; then quem_liga="dgclaw agente reiniciar $slug"; else quem_liga="dgclaw agente iniciar $slug"; fi
    if [ "$ENSAIO" != 1 ]; then
        while IFS='|' read -r marcador txt; do
            [ -n "$marcador" ] || continue
            case "$marcador" in
                restricoes.pendente) cmd="$quem_liga (reinicia o runner com as travas novas)" ;;
                restricoes-suporte.pendente) cmd="$quem_liga (confere se a imagem carrega a configuracao administrada)" ;;
                *) cmd="dgclaw agente reparar $slug (tira o gancho antigo do settings.json; o agente precisa estar ligado)" ;;
            esac
            pend_linhas+=("$txt. Resolve: $cmd")
        done < <(_restricoes_pendencias "$slug")
    fi
    if [ "$consulta" = consulta ] && [ "$ENSAIO" != 1 ] && [ "$ligada" = true ]; then
        if [ "$estado" = ligado ]; then
            esperado="$(jq -c . "$casa/runner/managed-settings.json" 2>/dev/null || true)"
            if [ -z "$esperado" ] || [ "$esperado" = '{}' ]; then
                motivo="managed-settings.json ausente, vazio ou invalido com restricao ligada. Resolve: $quem_liga (refaz os arquivos a partir do restricoes.json)"
            elif ! _restricoes_conferir_suporte "$slug" "$esperado"; then
                if [ "${RESTRICOES_SUPORTE_CAUSA:-}" = remota ]; then
                    motivo="$RESTRICOES_SUPORTE_MOTIVO. O agente esta ligado SEM a trava (pare com: dgclaw agente parar $slug). Resolve: conectar no agente uma conta pessoal (Pro ou Max) ou chave de API, ou desligar as restricoes dele; depois: dgclaw agente reiniciar $slug"
                else
                    motivo="$RESTRICOES_SUPORTE_MOTIVO. O agente esta ligado SEM a trava (pare com: dgclaw agente parar $slug). Resolve: dgclaw agente recriar $slug (se a imagem do servidor tambem estiver velha, antes: dgclaw imagem construir --agora)"
                fi
            fi
        fi
        codex_em="$(_restricoes_sessoes_em_codex "$casa" "$c" "$([ "$estado" = ligado ] && echo 1 || echo 0)")"
    fi
    if [ "${#pend_linhas[@]}" -gt 0 ] || [ -n "$motivo" ]; then rotulo="configurado, AINDA NAO VALE"; else rotulo=TRAVADO; fi
    printf '  Bash (terminal):       %s\n' "$(printf '%s' "$json" | jq -r --arg t "$rotulo" 'if (.sem_bash // false) then $t else "liberado" end')"
    printf '  Enviar arquivos:       %s\n' "$(printf '%s' "$json" | jq -r --arg t "$rotulo" 'if (.sem_enviar_arquivo // false) then $t else "liberado" end')"
    pastas="$(printf '%s' "$json" | jq -r --arg t "$rotulo" 'if (.escrita_so_em // null) == null then "qualquer lugar" else "so em " + (.escrita_so_em | join(", ")) + (if $t == "TRAVADO" then "" else " (" + $t + ")" end) end')"
    printf '  Gravar arquivos em:    %s\n' "$pastas"
    printf '  Atualizado em:         %s por %s\n' "$(printf '%s' "$json" | jq -r '.atualizado_em // "?"')" "$(printf '%s' "$json" | jq -r '.atualizado_por // "?"')"
    printf '  Arquivo:               %s\n' "$rs"
    for txt in "${pend_linhas[@]}"; do printf '  Pendente:              %s\n' "$txt"; done
    [ -z "$motivo" ] || printf '  NAO VALE:              %s\n' "$motivo"
    if [ "$consulta" = consulta ] && [ "$ENSAIO" != 1 ] && [ "$ligada" = true ]; then
        if [ "$estado" != ligado ]; then
            printf '  Conferencia:           o agente esta parado; a imagem sera conferida quando ele ligar (dgclaw agente iniciar %s).\n' "$slug"
        fi
        if [ -n "$codex_em" ]; then
            printf '  Codex:                 %s. No Codex estas travas nao valem (o runner ignora as regras de ferramentas e os ganchos do Claude Code); passam a valer na sessao que voltar para o Claude.\n' "$codex_em"
        fi
    fi
    return 0
}
