#!/bin/bash
# install-core.sh — Mecanica da instalacao do DG Claw servidor (a parte nao-conversacional).
#
# O wizard /dgclaw:setup conduz a entrevista com o dono e escreve o conteudo rico
# (IDENTITY.md, PERSONALITY.md, MEMORY.md). Este script faz o trabalho mecanico em volta:
#   bootstrap        cria .dgclaw/, copia o plugin (copia estavel), gera config.sh e agent.json
#   seed-persona     instancia os templates de estado/memoria (powers.json, working-memory, JSONs)
#   list-archetypes  lista os perfis prontos disponiveis (templates/archetypes/*/manifest.json)
#   status           imprime o estado da instalacao (pra idempotencia/doctor)
#
# Uso:
#   bash install-core.sh bootstrap --dgclaw-config <path> --name <Nome> --owner <Dono> --owner-id <tg_id>
#   bash install-core.sh list-archetypes
#   bash install-core.sh seed-persona --workspace <ws> [--archetype <nome>] \
#                  [--owner Dono] [--owner-id id] [--name Nome] [--future "..."] [--longterm "..."]
#   bash install-core.sh status --workspace <ws>
#
# --archetype <nome>: instancia o ETHICS.md.tmpl do perfil no workspace e usa os numeros
#   sugeridos (suggestedBigFive/suggestedBehavior) como DEFAULT; as flags numericas explicitas
#   (--extroversao, --proatividade, etc) continuam sobrescrevendo. Perfis prontos vem de
#   extensoes instaladas (o nucleo nao traz nenhum); sem perfil, o wizard usa os defaults.

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"          # .../scripts
PLUGIN_SRC="$(cd "$SELF_DIR/.." && pwd)"                          # raiz do plugin (instalado)

arg() { # arg <flag> <default> — busca <flag> no array global ARGS e ecoa o valor seguinte
    local flag="$1" def="${2:-}"
    local i; for ((i=0; i<${#ARGS[@]}; i++)); do
        if [ "${ARGS[$i]}" = "$flag" ]; then echo "${ARGS[$((i+1))]:-$def}"; return; fi
    done
    echo "$def"
}

CMD="${1:-}"; shift 2>/dev/null || true
ARGS=("$@")

iso_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
date_now() { date '+%Y-%m-%d'; }

# archetype_dirs [workspace]: lista os diretorios onde pode haver perfil pronto (arquetipo),
# um por linha. O nucleo do DG Claw nao traz arquetipo de fabrica: quem traz e uma extensao
# (o DG Alive traz influencer e infra). Entao procuramos, nesta ordem: os templates da copia
# estavel, os do plugin, e o diretorio archetypes/ de cada extensao instalada.
archetype_dirs() {
    local ws="${1:-}" d
    for d in "$ws/.dgclaw/plugin/templates/archetypes" "$PLUGIN_SRC/templates/archetypes"; do
        [ -n "$ws" ] || [ "$d" = "$PLUGIN_SRC/templates/archetypes" ] || continue
        [ -d "$d" ] && echo "$d"
    done
    if [ -n "$ws" ] && [ -d "$ws/.dgclaw/ext" ]; then
        while IFS= read -r e; do
            [ -d "$e/archetypes" ] && echo "$e/archetypes"
        done < <(find "$ws/.dgclaw/ext" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    fi
}

# archetype_path <nome> [workspace]: ecoa o diretorio do arquetipo <nome>, olhando em todas
# as fontes acima. Sai vazio se nao achar.
archetype_path() {
    local name="$1" ws="${2:-}" d
    while IFS= read -r d; do
        [ -f "$d/$name/manifest.json" ] && { echo "$d/$name"; return; }
    done < <(archetype_dirs "$ws")
}

# manifest_get <manifest.json> <dotted.path> [default] — le um valor escalar do manifest via python3
manifest_get() {
    local f="$1" path="$2" def="${3:-}"
    [ -f "$f" ] || { echo "$def"; return; }
    python3 - "$f" "$path" "$def" <<'PY' 2>/dev/null || echo "$def"
import json, sys
f, path, default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(f))
except Exception:
    print(default); sys.exit(0)
cur = d
for part in path.split('.'):
    if isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        print(default); sys.exit(0)
print(cur if cur is not None else default)
PY
}

ws_chown() { # alinha ownership se o workspace e de usuario dedicado
    local ws="$1"; local owner
    owner=$(stat -c '%U' "$ws" 2>/dev/null || echo root)
    [ "$owner" != "root" ] && chown -R "$owner":"$(stat -c '%G' "$ws")" "$ws/.dgclaw" 2>/dev/null || true
}

cmd_bootstrap() {
    local dgcfg name owner ownerid tz
    dgcfg=$(arg --dgclaw-config "")
    name=$(arg --name "")
    owner=$(arg --owner "Dono")
    ownerid=$(arg --owner-id "")
    # Fuso do DONO. O wizard pergunta e passa em --tz; sem isso, herdamos o relogio da
    # maquina. Isso precisa ficar EXPLICITO na config: VPS costuma nascer em UTC, e um
    # assistente que nao sabe o fuso do dono marca compromisso na hora errada.
    tz=$(arg --tz "")
    [ -n "$tz" ] || tz=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo "UTC")
    [ -f "$dgcfg" ] || { echo "bootstrap: --dgclaw-config invalido: $dgcfg" >&2; exit 1; }

    # Le slug/workspace CARREGANDO o config num subshell, em vez de garimpar com grep.
    # Garimpar quebrava na segunda instalacao: no config completo o workspace vem escrito
    # como ${DGCLAW_WORKSPACE:-/caminho}, e o grep trazia o texto cru em vez do caminho.
    local slug ws pair
    pair=$( set +u; source "$dgcfg" >/dev/null 2>&1; printf '%s\n%s\n' "${DGCLAW_SLUG:-}" "${DGCLAW_WORKSPACE:-}" )
    slug=$(printf '%s' "$pair" | sed -n '1p')
    ws=$(printf '%s' "$pair" | sed -n '2p')
    if [ -z "$slug" ] || [ ! -d "$ws" ]; then
        echo "bootstrap: nao consegui ler o slug e o workspace de $dgcfg." >&2
        echo "  li slug='$slug' e workspace='$ws'. Esse arquivo e mesmo a config do agente?" >&2
        echo "  ela precisa exportar DGCLAW_SLUG e DGCLAW_WORKSPACE, e o workspace tem que existir." >&2
        exit 1
    fi
    [ -n "$name" ] || name="$slug"

    # versao do plugin (carimba no agent.json) — lida do plugin.json pra nao drift-ar.
    local plugin_ver
    plugin_ver=$(grep '"version"' "$PLUGIN_SRC/.claude-plugin/plugin.json" 2>/dev/null | head -1 | sed -E 's/.*"version"[: ]+"([^"]+)".*/\1/')
    [ -n "$plugin_ver" ] || plugin_ver="0.3.0"

    local AL="$ws/.dgclaw"
    mkdir -p "$AL/logs" "$AL/creds" "$ws/persona" "$ws/memory" "$ws/planning" "$ws/data" "$ws/assets/reference"
    chmod 700 "$AL/creds"

    # Copia estavel do plugin (a pasta do plugin instalado pode ser limpa pelo sistema).
    # Nada e apagado aqui: cada instalacao gera uma pasta com data e o "plugin" vira um
    # atalho pra ela. Assim reinstalar nao puxa o tapete de um cron que esteja rodando
    # naquele instante, e da pra voltar pra versao anterior so mudando o atalho.
    local stamp newdir
    stamp=$(date '+%Y%m%d-%H%M%S')
    newdir="$AL/plugin-$stamp"
    mkdir -p "$newdir"
    # docs/ vai junto desde 01/10/2026: o manual de emergencia (docs/EMERGENCIA.md), que a skill
    # socorro e a sessao de socorro do painel leem, e a radiografia (docs/RADIOGRAFIA.md), que o
    # painel mostra numa aba, precisam existir na copia estavel mesmo sem o plugin carregado.
    # hooks/ vai junto desde 05/10/2026: agente instalado a mao (sem o plugin habilitado no
    # Claude) pendura o hook do quadro de avisos pelo .claude/settings.json do workspace,
    # apontando pra esta copia (docs/QUADRO-DE-AVISOS.md).
    cp -r "$PLUGIN_SRC/scripts" "$PLUGIN_SRC/skills" "$PLUGIN_SRC/templates" "$PLUGIN_SRC/powers" "$PLUGIN_SRC/docs" "$PLUGIN_SRC/hooks" "$newdir/" 2>/dev/null
    # painel: leva o fonte sem node_modules (o install-panel-service.sh instala as deps depois).
    if [ -d "$PLUGIN_SRC/panel" ]; then
        mkdir -p "$newdir/panel"
        ( cd "$PLUGIN_SRC/panel" && tar -cf - --exclude=node_modules . ) | ( cd "$newdir/panel" && tar -xf - ) 2>/dev/null
    fi
    # Se ja havia uma copia como pasta de verdade (instalacao antiga), tira ela do caminho
    # antes de criar o atalho, senao o atalho iria parar dentro dela.
    if [ -d "$AL/plugin" ] && [ ! -L "$AL/plugin" ]; then
        mv -f "$AL/plugin" "$AL/plugin-anterior-$stamp"
        echo "  copia anterior guardada em $AL/plugin-anterior-$stamp"
    fi
    ln -sfn "$newdir" "$AL/plugin"

    # O config de base (o que o wizard escreveu no Passo do bot: slug, workspace, telegram,
    # plugin root) vira config.base.sh, e o config.sh completo passa a dar source nele. Sem
    # essa separacao, quando o config de base JA e o proprio $AL/config.sh, o arquivo daria
    # source em si mesmo e todo cron que carregasse a config entraria em recursao infinita.
    local base="$AL/config.base.sh"
    if [ "$(readlink -f "$dgcfg")" = "$(readlink -f "$AL/config.sh")" ]; then
        # Reinstalando por cima: o config de base ja foi separado numa instalacao anterior,
        # entao reaproveitamos. Copiar de novo aninharia o config completo dentro do base.
        if [ -f "$base" ] && grep -q '^export DGCLAW_WORKSPACE=' "$base"; then
            echo "  config de base ja existia em $base, reaproveitando"
        else
            cp "$dgcfg" "$base"
            chmod 600 "$base"
            echo "  config de base preservado em $base (o config.sh agora e o completo, e da source nele)"
        fi
    else
        base="$dgcfg"
    fi

    # Mesa de tarefas (opcional): o config.sh e reescrito inteiro a cada bootstrap, entao as duas
    # linhas da mesa, se ja existiam, sao levadas pro arquivo novo. Sem isso, reinstalar o plugin
    # desligaria a mesa em silencio. A chave nunca aparece na tela: vai direto de um arquivo pro outro.
    local mesa_keep=""
    if [ -f "$AL/config.sh" ]; then
        mesa_keep=$(grep -E '^export DGCLAW_MESA_(URL|KEY)=' "$AL/config.sh" 2>/dev/null || true)
    fi

    # config.sh do agente: tudo que os crons e o painel precisam saber.
    cat > "$AL/config.sh" <<EOF
# Config da camada DG Claw de ${name} (${slug}). Gerado por /dgclaw:setup.
# Herda tudo do config de base (DGCLAW_*, TELEGRAM_STATE_DIR, BUN_BIN_DIR, IS_SANDBOX).
source "${base}"

export DGCLAW_SLUG="${slug}"
export DGCLAW_NAME="${name}"
export DGCLAW_OWNER="${owner}"
export DGCLAW_OWNER_TELEGRAM_ID="${ownerid}"
export DGCLAW_WORKSPACE="\${DGCLAW_WORKSPACE:-${ws}}"
export DGCLAW_PLUGIN_ROOT="\${DGCLAW_WORKSPACE}/.dgclaw/plugin"
export DGCLAW_PERSONA_DIR="\${DGCLAW_WORKSPACE}/persona"
# Auto-recovery (Modulo 4): watchdog (ressuscita a sessao viva) + auto-compact (compacta o
# contexto da sessao viva). Default ON pra assinatura flat 24/7. O wizard pergunta na instalacao
# e troca pra "off" aqui se o dono recusar. off = os crons viram no-op puro (so observam/logam).
export DGCLAW_AUTO_RECOVERY="\${DGCLAW_AUTO_RECOVERY:-on}"
# Modelo do agente. Ele nasce no Opus, o mais inteligente, porque quem conversa com o dono e
# decide as coisas e ele. O gasto fica sob controle pela regra de orquestrador que esta no
# AGENT.md: trabalho pesado (codigo, texto longo, varredura de arquivos) vai pra subagente
# Sonnet, e o Opus so le, decide e responde.
# Pra trocar: mude aqui e reinicie o servico. Vazio ("") = usa o modelo padrao da conta.
export DGCLAW_MODEL="\${DGCLAW_MODEL:-opus}"
# Fuso do dono. Toda hora que ele disser ("as 17h") e nesta referencia, e e ela que vai
# carimbada em cada rotina que o assistente marcar. Se o dono mudar de pais, mude aqui.
export DGCLAW_TZ="\${DGCLAW_TZ:-${tz}}"
# Mesa de tarefas do DG Telegram (OPCIONAL, so pra quem tem o app DG Telegram). Com as duas
# linhas abaixo, o agente cria e atualiza as proprias tarefas na mesa (regra no CLAUDE.md) e o
# doctor confere se ela responde. Sem elas, a regra fica desligada e nada muda.
# DGCLAW_MESA_KEY e a chave do agente no DG Telegram, criada com "Agente dono" = este agente;
# o quadro de avisos da equipe vai usar a mesma chave. Detalhes: docs/MESA-DE-TAREFAS.md.
# Reinstalar o plugin preserva estas duas linhas.
#   export DGCLAW_MESA_URL="http://127.0.0.1:4045/api/v1/tarefas"
#   export DGCLAW_MESA_KEY="<chave do agente>"
${mesa_keep}
EOF
    chmod 600 "$AL/config.sh"

    # agent.json (controle de versao/idempotencia)
    cat > "$AL/agent.json" <<EOF
{
  "dgclaw_version": "${plugin_ver}",
  "instalado_em": "$(iso_now)",
  "slug": "${slug}",
  "name": "${name}",
  "owner": "${owner}",
  "identity": { "agent_md_backup": "AGENT.md.bak", "materialized": false },
  "timers": [],
  "panel": { "installed": false, "port": 8300 },
  "avatar": { "path": null }
}
EOF
    ws_chown "$ws"
    echo "bootstrap ok: agente criado em $AL (slug=$slug, name=$name, ws=$ws)"
    echo "  copia dos scripts: $newdir (o atalho .dgclaw/plugin aponta pra ela)"
    echo "  versoes antigas ficam guardadas em $AL/plugin-*; apague as que nao quiser."
    echo "WORKSPACE=$ws"
    echo "DGCLAW_CONFIG=$AL/config.sh"
}

cmd_seed_persona() {
    local ws name owner ownerid future longterm slug archetype crisis
    ws=$(arg --workspace "")
    [ -d "$ws" ] || { echo "seed-persona: --workspace invalido: $ws" >&2; exit 1; }
    name=$(arg --name ""); owner=$(arg --owner "Dono"); ownerid=$(arg --owner-id "")
    future=$(arg --future "Descobrir quem eu sou e o que quero criar.")
    longterm=$(arg --longterm "Crescer e deixar uma marca positiva.")
    archetype=$(arg --archetype "")
    # Linha de apoio emocional p/ a LAWS.md (Lei 1). Default generico; o wizard/dono pode
    # passar a local. Sem isso o {{CRISIS_HOTLINE}} vazava cru pro system prompt.
    crisis=$(arg --crisis-hotline "uma linha local de apoio emocional/emergencia (no Brasil: CVV 188)")
    slug=$(basename "$ws")
    [ -n "$name" ] || name="$slug"

    local T="$ws/.dgclaw/plugin/templates"
    [ -d "$T" ] || T="$PLUGIN_SRC/templates"
    local DATA DISO; DATA=$(date_now); DISO=$(iso_now)

    # --- Arquetipo (opcional): define os DEFAULTS dos numeros de personalidade. ---
    # Defaults "genericos" (sem arquetipo) — preservam o comportamento antigo do script.
    local d_ext=6 d_abe=7 d_con=7 d_ama=7 d_neu=4 d_pro=7 d_hum=6 d_cur=8 d_tei=5
    local ADIR MAN
    if [ -n "$archetype" ]; then
        ADIR=$(archetype_path "$archetype" "$ws")
        MAN="$ADIR/manifest.json"
        if [ -z "$ADIR" ] || [ ! -f "$MAN" ]; then
            echo "seed-persona: nao achei o perfil pronto '$archetype'." >&2
            echo "  procurei em: $(archetype_dirs "$ws" | tr '\n' ' ')" >&2
            echo "  perfis disponiveis: $(cmd_list_archetypes_names "$ws" | tr '\n' ' ')" >&2
            echo "  (o nucleo do DG Claw nao traz perfil de fabrica; quem traz e uma extensao, como o DG Alive)" >&2
            exit 1
        fi
        # numeros sugeridos viram os defaults (sobrescreviveis pelas flags explicitas).
        d_ext=$(manifest_get "$MAN" "suggestedBigFive.extroversao"      "$d_ext")
        d_abe=$(manifest_get "$MAN" "suggestedBigFive.abertura"         "$d_abe")
        d_con=$(manifest_get "$MAN" "suggestedBigFive.conscienciosidade" "$d_con")
        d_ama=$(manifest_get "$MAN" "suggestedBigFive.amabilidade"      "$d_ama")
        d_neu=$(manifest_get "$MAN" "suggestedBigFive.neuroticismo"     "$d_neu")
        d_pro=$(manifest_get "$MAN" "suggestedBehavior.proatividade"    "$d_pro")
        d_hum=$(manifest_get "$MAN" "suggestedBehavior.humor"           "$d_hum")
        d_cur=$(manifest_get "$MAN" "suggestedBehavior.curiosidade"     "$d_cur")
        d_tei=$(manifest_get "$MAN" "suggestedBehavior.teimosia"        "$d_tei")
        # suggestedEnergy (faixa emocional) existe no manifest mas nao e do nucleo: quem le
        # isso e a extensao de emocoes, no seed.sh dela.
        echo "  perfil: $archetype ($(manifest_get "$MAN" "label" "$archetype"))"
    fi

    # Big Five (0-10) + tracos de comportamento — alimentam PERSONALITY.md (tabela) e proactivity.json.
    # As flags explicitas sobrescrevem; senao caem nos defaults do arquetipo (ou nos genericos).
    local ext abe con ama neu pro hum cur tei
    ext=$(arg --extroversao "$d_ext"); abe=$(arg --abertura "$d_abe"); con=$(arg --conscienciosidade "$d_con")
    ama=$(arg --amabilidade "$d_ama"); neu=$(arg --neuroticismo "$d_neu")
    pro=$(arg --proatividade "$d_pro"); hum=$(arg --humor "$d_hum"); cur=$(arg --curiosidade "$d_cur"); tei=$(arg --teimosia "$d_tei")

    subst() { # subst <template> <dest> — so cria se nao existir (nao sobrescreve persona viva)
        local src="$1" dst="$2"
        [ -f "$dst" ] && { echo "  (mantido, ja existe: $dst)"; return; }
        mkdir -p "$(dirname "$dst")"
        sed -e "s#{{NOME}}#${name}#g" \
            -e "s#{{DONO}}#${owner}#g" \
            -e "s#{{DONO_TELEGRAM_ID}}#${ownerid}#g" \
            -e "s#{{SESSION_ID}}##g" \
            -e "s#{{SLUG}}#${slug}#g" \
            -e "s#{{WORKSPACE}}#${ws}#g" \
            -e "s#{{DATA}}#${DATA}#g" \
            -e "s#{{DATA_ISO}}#${DISO}#g" \
            -e "s#{{META_FUTURO}}#${future}#g" \
            -e "s#{{META_LONGO}}#${longterm}#g" \
            -e "s#{{CRISIS_HOTLINE}}#${crisis}#g" \
            -e "s#{{EXTROVERSAO}}#${ext}#g" \
            -e "s#{{ABERTURA}}#${abe}#g" \
            -e "s#{{CONSCIENCIOSIDADE}}#${con}#g" \
            -e "s#{{AMABILIDADE}}#${ama}#g" \
            -e "s#{{NEUROTICISMO}}#${neu}#g" \
            -e "s#{{PROATIVIDADE}}#${pro}#g" \
            -e "s#{{HUMOR}}#${hum}#g" \
            -e "s#{{CURIOSIDADE}}#${cur}#g" \
            -e "s#{{TEIMOSIA}}#${tei}#g" \
            "$src" > "$dst"
        echo "  criado: $dst"
    }

    subst "$T/proactivity.json.tmpl"    "$ws/.dgclaw/proactivity.json"
    subst "$T/powers.json.tmpl"         "$ws/.dgclaw/powers.json"
    subst "$T/relationships.json.tmpl"  "$ws/memory/relationships.json"
    subst "$T/goals.json.tmpl"          "$ws/planning/goals.json"
    subst "$T/working-memory.md.tmpl"   "$ws/working-memory.md"
    # PERSONALITY.md em formato tabela (o painel le os tracos daqui). Gerado pelo seed pra
    # garantir o formato; o IDENTITY.md/MEMORY.md ricos sao escritos pelo wizard.
    local personality_existia=0
    [ -f "$ws/PERSONALITY.md" ] && personality_existia=1
    subst "$T/PERSONALITY.md.tmpl"      "$ws/PERSONALITY.md"
    # As FALAS do perfil pronto, quando ele traz (arquivo FALAS.md.tmpl ao lado do
    # ETHICS.md.tmpl). Um gestor nao fala como um assistente pessoal, e a diferenca
    # nao cabe em numero: cabe em frase escrita.
    #
    # Por que isto importa mais no perfil que no wizard: quem instala pela conversa
    # tem o wizard reescrevendo as falas com a voz que o dono descreveu. Quem nasce
    # pela PLATAFORMA (entrega.ts / provision.ts chamam este seed sem entrevista
    # nenhuma) ficaria com as falas de fabrica pra sempre.
    if [ "$personality_existia" = "0" ] && [ -n "$archetype" ] && [ -f "$ADIR/FALAS.md.tmpl" ]; then
        DGCLAW_FALAS_SRC="$ADIR/FALAS.md.tmpl" DGCLAW_FALAS_DST="$ws/PERSONALITY.md" \
        DGCLAW_FALAS_NOME="$name" DGCLAW_FALAS_DONO="$owner" python3 - <<'PY'
import os, re, sys

src, dst = os.environ["DGCLAW_FALAS_SRC"], os.environ["DGCLAW_FALAS_DST"]
falas = open(src, encoding="utf-8").read()
falas = falas.replace("{{NOME}}", os.environ["DGCLAW_FALAS_NOME"])
falas = falas.replace("{{DONO}}", os.environ["DGCLAW_FALAS_DONO"])
texto = open(dst, encoding="utf-8").read()

# Os marcadores sao o contrato. Sem eles nao ha onde encaixar, e trocar o arquivo
# inteiro perderia a tabela dos Big Five, que e de onde o painel le os tracos.
padrao = re.compile(r"(<!-- FALAS:INICIO.*?-->)(.*?)(<!-- FALAS:FIM -->)", re.S)
if not padrao.search(texto):
    print(f"  [aviso] o PERSONALITY.md nao tem os marcadores FALAS:INICIO/FIM, "
          f"entao as falas do perfil ficaram de fora. Conferir {dst}.", file=sys.stderr)
    sys.exit(0)
open(dst, "w", encoding="utf-8").write(padrao.sub(lambda m: m.group(1) + "\n\n" + falas.strip() + "\n\n" + m.group(3), texto, count=1))
print(f"  falas do perfil '{os.path.basename(os.path.dirname(src))}' aplicadas em {dst}")
PY
    fi
    # LAWS (leis imutaveis) e CREATOR (dados do dono) instanciados aqui com os placeholders
    # preenchidos, pra o materialize-identity compor o AGENT.md. O wizard enriquece depois.
    subst "$T/LAWS.md.tmpl"             "$ws/LAWS.md"
    # LAWS.md sao leis imutaveis -> read-only (o proprio template pede chmod 444).
    [ -f "$ws/LAWS.md" ] && chmod 444 "$ws/LAWS.md" 2>/dev/null || true
    subst "$T/CREATOR.md.tmpl"          "$ws/CREATOR.md"

    # Do perfil pronto, o nucleo instancia so o que e neutro: a etica de trabalho (ETHICS.md),
    # que o materialize-identity anexa ao AGENT.md. A parte de alma (SOUL-addendum) e da
    # extensao que trouxe o perfil, e ela cuida disso no seed.sh dela.
    if [ -n "$archetype" ] && [ -d "$ADIR" ] && [ -f "$ADIR/ETHICS.md.tmpl" ]; then
        subst "$ADIR/ETHICS.md.tmpl" "$ws/ETHICS.md"
    fi

    # Extensoes instaladas semeiam os proprios arquivos (o DG Alive semeia o estado emocional,
    # os gatilhos, as opinioes e o SOUL.md). Sem extensao, nada disso existe e o agente roda
    # igual. O perfil escolhido vai junto, pra extensao aplicar a parte dela do perfil.
    local extdir="$ws/.dgclaw/ext" e seed
    if [ -d "$extdir" ]; then
        while IFS= read -r e; do
            seed="$e/hooks/seed.sh"
            [ -f "$seed" ] || continue
            if ! DGCLAW_WORKSPACE="$ws" DGCLAW_ARCHETYPE="$archetype" DGCLAW_ARCHETYPE_DIR="${ADIR:-}" \
                 DGCLAW_NAME="$name" DGCLAW_OWNER="$owner" bash "$seed"; then
                echo "  aviso: a extensao '$(basename "$e")' falhou ao semear os arquivos dela. O agente foi criado sem essa parte; rode 'bash $seed' pra ver o erro." >&2
            fi
        done < <(find "$extdir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    fi
    ws_chown "$ws"
    echo "seed-persona ok."
}

# cmd_list_archetypes_names [ws]: so os nomes, um por linha (usado nas mensagens de erro).
cmd_list_archetypes_names() {
    local ws="${1:-}" d p
    while IFS= read -r d; do
        for p in "$d"/*/; do
            [ -f "$p/manifest.json" ] && basename "$p"
        done
    done < <(archetype_dirs "$ws") | sort -u
}

cmd_list_archetypes() {
    local ws d p m name label desc saida
    ws=$(arg --workspace "")
    # A montagem vai pra uma variavel (e nao direto pro pipe) porque num pipe o loop roda
    # em subshell e o "achei algum perfil" se perderia: a funcao dizia que nao havia
    # nenhum logo depois de listar os que existem.
    saida=$(
        while IFS= read -r d; do
            for p in "$d"/*/; do
                m="$p/manifest.json"
                [ -f "$m" ] || continue
                name=$(basename "$p")
                label=$(manifest_get "$m" "label" "$name")
                desc=$(manifest_get "$m" "description" "")
                echo "${name}|${label}|${desc}"
            done
        done < <(archetype_dirs "$ws") | sort -u
    )
    [ -n "$saida" ] && printf '%s\n' "$saida"
    if [ -z "$saida" ]; then
        echo "nenhum perfil pronto instalado. O nucleo do DG Claw nao traz nenhum de fabrica:" >&2
        echo "quem traz perfil e uma extensao (o DG Alive traz 'influencer' e 'infra'). Sem perfil," >&2
        echo "o wizard segue normalmente e a personalidade sai toda da entrevista." >&2
        exit 1
    fi
}

cmd_status() {
    local ws; ws=$(arg --workspace "")
    [ -d "$ws" ] || { echo "status: --workspace invalido" >&2; exit 1; }
    local AL="$ws/.dgclaw"
    echo "agent.json:  $([ -f "$AL/agent.json" ] && echo presente || echo AUSENTE)"
    echo "config.sh:   $([ -f "$AL/config.sh" ] && echo presente || echo AUSENTE)"
    echo "powers.json: $([ -f "$AL/powers.json" ] && echo presente || echo AUSENTE)"
    echo "AGENT.md materializado: $(head -1 "$ws/AGENT.md" 2>/dev/null | grep -q 'GERADO PELO DG CLAW' && echo sim || echo nao)"
    echo "backup AGENT: $([ -f "$ws/AGENT.md.bak" ] && echo presente || echo ausente)"
    local e n=0
    if [ -d "$AL/ext" ]; then
        while IFS= read -r e; do
            n=$((n+1)); echo "extensao: $(basename "$e")"
        done < <(find "$AL/ext" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    fi
    # sem `|| true` o status sairia com codigo 1 quando HA extensao, e quem chama pensaria que falhou
    [ "$n" = "0" ] && echo "extensoes: nenhuma (o agente roda igual; o DG Alive acrescenta a vida emocional)" || true
}

case "$CMD" in
    bootstrap)        cmd_bootstrap ;;
    seed-persona)     cmd_seed_persona ;;
    list-archetypes)  cmd_list_archetypes ;;
    status)           cmd_status ;;
    *) echo "uso: install-core.sh {bootstrap|seed-persona|list-archetypes|status} [flags]" >&2; exit 1 ;;
esac
