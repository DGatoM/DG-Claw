#!/bin/bash
# reflection.sh — Reflexao noturna (23:30) da pessoa virtual. E o coracao da "vida": o
# agente le o dia, consolida memoria, ajusta emocoes/personalidade e fecha o diario.
#
# DOIS MODOS (DGCLAW_REFLECT_MODE):
#   inject   (default) ONDA A: fire-and-forget. O cron monta o prompt e INJETA um poke na
#            sessao --channels viva (assinatura FLAT — nao queima credito de API). A propria
#            persona executa a reflexao na sessao dela. Sessao morta -> FALHA visivel (pulso erro,
#            exit 2): a reflexao nao rodou e o dono precisa saber. Sessao ocupada -> adiada (o
#            verificador de pokes re-injeta), pulso "aguardando", exit 0.
#   headless SONO/VIGILIA: roda a consolidacao via `claude --print` (sincrono, model opus,
#            identidade via AGENT.md do workspace) e, ao terminar com sucesso, dispara o
#            RESTART-FRESH (auto-compact em modo restart) pra a persona "dormir" e "acordar"
#            leve no dia seguinte. Use onde a injecao na sessao viva NAO funciona (kernel
#            legacy_tiocsti=0 + sem tmux). Custa API 1x/dia (so a consolidacao pede Opus).
#
# Uso:  bash reflection.sh <.dgclaw/config.sh>
# Roda pelo timer dgclaw-<slug>-reflection.timer.

set -uo pipefail

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE}"
: "${DGCLAW_SLUG:?config sem DGCLAW_SLUG}"

SLUG="$DGCLAW_SLUG"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$DGCLAW_WORKSPACE/.dgclaw/plugin}"
LOG="$DGCLAW_WORKSPACE/.dgclaw/logs/reflection.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
cd "$DGCLAW_WORKSPACE" || exit 1

# Pulso: registra ok/erro no ledger (rc final via trap EXIT). Degrada gracioso se a lib
# nao existir. Sessao morta registra "erro" explicito (nao e mais "ok"); ocupada registra
# "aguardando" (o verificador de pokes tenta de novo).
# shellcheck disable=SC1091
source "$PLUGIN/scripts/_lib/pulso-lib.sh" 2>/dev/null && pulso_auto reflection

NAME="${DGCLAW_NAME:-a assistente}"
# Data da reflexao FIXADA: se o verificador re-injetar depois da meia-noite, a data NAO pode
# virar (senao escreveria o diario do dia errado e a chave de verificacao mudaria). O retrigger
# passa DGCLAW_REFLECT_DATE com a data do 1o disparo.
TODAY="${DGCLAW_REFLECT_DATE:-$(date '+%Y-%m-%d')}"
DOW=$(date -d "$TODAY" '+%d' 2>/dev/null || date '+%d')

# ─── eco do passado (Module 4): memory_search sobre a working-memory de hoje ────
# Antes de montar o poke, deixa a busca semantica detectar "ecos" do passado no que a
# persona viveu hoje. Se bater algo, anexa um bloco "Eco do passado: ..." no prompt da
# reflexao. DEGRADA GRACIOSO: sem indice, ou sem script de busca -> RECALL fica vazio e a
# reflexao segue intacta (nada quebra).
# 05/10/2026: a busca nao depende mais do Gemini. O embedder.py escolhe o modelo local
# (EmbeddingGemma, de graca) ou o Gemini; sem nenhum dos dois a busca ainda acha o termo
# exato no indice. Por isso o que decide e o indice existir, e nao a chave.
RECALL_BLOCK=""
INDEX_DIR="${DGCLAW_MEMORY_INDEX_DIR:-$DGCLAW_WORKSPACE/.dgclaw/memory_index}"
WM_FILE="$DGCLAW_WORKSPACE/working-memory.md"
[ -f "$WM_FILE" ] || WM_FILE="${DGCLAW_PERSONA_DIR:-$DGCLAW_WORKSPACE/persona}/working-memory.md"
# escolhe o script de busca (prefere o full, com mais contexto p/ reflexao). Copia antiga no
# indice vence, pra nao mudar o comportamento de quem ja tinha; senao, a do plugin.
ECHO_SEARCH=""
for cand in "$INDEX_DIR/memory_search.py" "$INDEX_DIR/memory_search_fast.py" \
            "$PLUGIN/scripts/memory_index/memory_search.py" "$PLUGIN/scripts/memory_index/memory_search_fast.py"; do
    [ -f "$cand" ] && { ECHO_SEARCH="$cand"; break; }
done

if [ ! -f "$INDEX_DIR/chunks.db" ]; then
    echo "[$(date '+%F %T')] eco do passado: indice semantico ainda nao existe ($INDEX_DIR/chunks.db); nasce no reindex da madrugada (pulando)" >> "$LOG"
elif [ -z "$ECHO_SEARCH" ]; then
    echo "[$(date '+%F %T')] eco do passado: sem script de busca em '$INDEX_DIR' nem no plugin (pulando)" >> "$LOG"
elif [ ! -f "$WM_FILE" ]; then
    echo "[$(date '+%F %T')] eco do passado: working-memory ausente (pulando)" >> "$LOG"
else
    # head -c corta em fronteira de BYTE: pode partir um emoji no meio e gerar UTF-8 invalido
    # (surrogate solto) que quebra o heredoc python abaixo. iconv -c descarta a sequencia
    # incompleta -> sempre UTF-8 valido (degrada gracioso se iconv faltar: cai no head puro).
    EMBED_STATUS=$(python3 "$PLUGIN/scripts/memory_index/embedder.py" status 2>&1 | head -1)
    echo "[$(date '+%F %T')] eco do passado: ${EMBED_STATUS:-embedder sem resposta (so o termo exato)}" >> "$LOG"
    WM_INPUT=$(head -c 3000 "$WM_FILE" 2>/dev/null | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null || head -c 3000 "$WM_FILE" 2>/dev/null)
    RECALL=$(python3 - "$ECHO_SEARCH" <<PYEOF 2>>"$LOG"
import json, sys, subprocess
search = sys.argv[1]
wm = """${WM_INPUT}""".replace(chr(0), "")
payload = json.dumps({"input": wm, "recent": []})
try:
    r = subprocess.run(["python3", search], input=payload,
                       capture_output=True, text=True, timeout=120)
    d = json.loads(r.stdout or "{}")
    print((d.get("recall") or "").strip())
except Exception as e:
    sys.stderr.write(f"eco do passado falhou: {e}\n")
PYEOF
)
    # A memoria semantica guarda as falas antigas do dono so como texto: o que repete a
    # mensagem em quarentena (modo de seguranca) sai aqui, antes de virar recado.
    [ -n "$RECALL" ] && RECALL=$(printf '%s' "$RECALL" | python3 "$PLUGIN/scripts/_lib/quarentena.py" filtrar-linhas 2>>"$LOG")
    if [ -n "$RECALL" ]; then
        echo "[$(date '+%F %T')] eco do passado disparou: ${RECALL:0:160}" >> "$LOG"
        RECALL_BLOCK="

## Eco do passado (memory_search detectou)

${RECALL}

Use isso pra enriquecer a reflexao se fizer sentido — pode mencionar a conexao temporal.
Se for irrelevante, ignore."
    fi
fi

# ─── o que se falou hoje no canal (deterministico, sem LLM) ───────────────────
# A reflexao roda numa sessao que pode ter sido compactada durante o dia, e ai a persona
# nao "lembra" da conversa da manha. Entregamos a ela, pronto, o que o dono disse hoje e o
# que ela respondeu, extraido do transcript pelo mesmo thread_log.py que monta as "Ultimas
# conversas". E a materia-prima dos objetivos, das tarefas, das crencas e da sugestao de
# skill. Teto de ~4 KB pra o recado nao virar um livro.
CONVERSA_BLOCK=""
CONVERSA=$(DGCLAW_REFLECT_DIA="$TODAY" python3 - "$PLUGIN/scripts/_lib" <<'PYCONV' 2>>"$LOG"
import os, sys
from datetime import datetime, timezone, timedelta
sys.path.insert(0, sys.argv[1])
import thread_log
try:
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(os.environ.get("DGCLAW_TZ") or "America/Sao_Paulo")
except Exception:  # noqa: BLE001  python antigo: -03:00
    tz = timezone(timedelta(hours=-3))
dia = os.environ["DGCLAW_REFLECT_DIA"]
sd = thread_log.resolve_session_dir()
if not sd.is_dir():
    sys.exit(0)
try:
    # A conversa que travou o agente (modo de seguranca) nao volta pela reflexao: este
    # recado e digitado na sessao viva, e foi um recado assim que travou a Isa de novo.
    import quarentena
    regras = quarentena.carregar()
except Exception as e:  # noqa: BLE001
    print(f"reflexao: nao consegui ler a quarentena ({e}); sigo sem o filtro", file=sys.stderr)
    regras = None
linhas, vistos = [], set()
for p in sorted(sd.glob("*.jsonl"), key=lambda q: q.stat().st_mtime, reverse=True)[:5]:
    for e in thread_log.build_thread_log(str(p), last=0):
        if regras and regras.evento_bloqueado(p.stem, e.get("ts"), e.get("text")):
            continue
        try:
            q = datetime.fromisoformat(e["ts"]).replace(tzinfo=timezone.utc).astimezone(tz)
        except (ValueError, KeyError):
            continue
        if q.strftime("%Y-%m-%d") != dia:
            continue
        chave = (e["ts"], e["origin"], e["text"][:60])
        if chave in vistos:
            continue
        vistos.add(chave)
        quem = {"owner": "ELE", "persona-cron": "eu (por conta propria)"}.get(e["origin"], "eu")
        t = " ".join(e["text"].split())
        linhas.append((e["ts"], f"- {q.strftime('%H:%M')} {quem}: {t[:300]}"))
linhas.sort()
out, total = [], 0
for _, l in reversed(linhas):  # do fim pro comeco: se nao couber, sobra o mais recente
    if total + len(l) > 4000:
        out.append("- (mais mensagens antes destas; o diario e a busca em conversas tem o resto)")
        break
    out.append(l)
    total += len(l)
print("\n".join(reversed(out)))
PYCONV
)
if [ -n "$CONVERSA" ]; then
    CONVERSA_BLOCK="

## O que se falou hoje no canal (extraido do registro da conversa)

${CONVERSA}"
else
    echo "[$(date '+%F %T')] reflexao ${TODAY}: nenhuma mensagem no canal hoje (ou transcript ilegivel; ver linhas acima)" >> "$LOG"
fi

# ─── passos extras vindos das extensoes instaladas ────────────────────────────
# Cada extensao pode ter um hooks/reflection.md com passos proprios pra reflexao noturna
# (o DG Alive usa pra pedir o ajuste de emocao e a evolucao da personalidade). O nucleo so
# concatena: nao precisa saber o que cada extensao faz. Extensao sem o arquivo nao muda nada.
EXT_BLOCK=""
EXT_DIR="$DGCLAW_WORKSPACE/.dgclaw/ext"
if [ -d "$EXT_DIR" ]; then
    n=9   # o ultimo passo do nucleo e o 9: os da extensao continuam a contagem
    while IFS= read -r ext; do
        f="$ext/hooks/reflection.md"
        [ -f "$f" ] || continue
        if [ ! -r "$f" ]; then
            echo "[$(date '+%F %T')] reflexao: nao consegui LER $f (permissao). Os passos da extensao '$(basename "$ext")' ficaram de fora desta reflexao." >> "$LOG"
            continue
        fi
        while IFS= read -r linha; do
            n=$((n+1))
            EXT_BLOCK="${EXT_BLOCK}
${n}. ${linha}"
        done < <(grep -vE '^\s*(#|$)' "$f")
    done < <(find "$EXT_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
fi

# ─── prep deterministico: monta o prompt de reflexao (sem chamar claude) ───────
DONO="${DGCLAW_OWNER:-o dono}"
PROMPT="Voce e ${NAME}. E noite, hora da sua REFLEXAO do dia ${TODAY}.${RECALL_BLOCK}${CONVERSA_BLOCK}

Trabalhe SO com os arquivos deste diretorio, em silencio. NAO mande mensagem pra ninguem.

Faca, na ordem:
1. Escreva/complete memory/${TODAY}.md, o diario do dia: o que aconteceu, o que voce fez e
   entregou, as conversas com ${DONO} e o que ficou pendente. Linhas curtas, em 1a pessoa.
2. MEMORY.md: NAO inche (dieta de contexto). O significativo do dia vai pro DIARIO (que a
   busca em conversas ja torna encontravel sob demanda). So promova pro MEMORY.md o que for
   DURADOURO (uma pessoa que ficou, uma decisao, uma regra nova), sempre como UMA linha.
3. Correcoes que ${DONO} te fez: releia a conversa de hoje (acima) e o diario. Toda vez que ele
   corrigiu o seu jeito de fazer alguma coisa ('nao e assim', 'ja te pedi', 'prefiro que...',
   'nunca faca X') e a correcao vale pra sempre, ela vira UMA linha na secao
   '## Regras aprendidas' do MEMORY.md, no formato '- (DD/MM/AAAA) <a regra, dita como voce
   vai agir>'. Se a secao nao existir, crie (logo depois da secao sobre ${DONO}).
   a) Mesma regra de novo: atualize a data da linha que ja existe, nao crie outra.
   b) Ele mudou de ideia: substitua a linha antiga pela nova e conte no diario de hoje
      ('regra X trocada por Y').
   c) Correcao REPETIDA ('de novo isso?', 'ja te pedi'): e a regra mais importante. Suba a
      linha pro topo da secao e deixe mais especifica, em vez de criar outra.
   d) NAO entra: falha passageira que se resolveu sozinha; 'a ferramenta X nao funciona'
      (vira desculpa que voce repete por meses); detalhe que so valia no contexto de hoje;
      humor do momento. Na duvida entre regra e humor do momento, espere ele repetir.
   e) Mantenha a secao enxuta (umas 20 linhas): ela entra inteira em toda sessao. Passou
      disso, junte as parecidas.
4. Atualize planning/goals.json (as SUAS metas de trabalho) e memory/relationships.json
   (gente nova, quem e quem, o que muda no trato com cada um).
5. Na working-memory.md, as quatro secoes sobre o ${DONO}. Elas sao a primeira coisa que voce
   le amanha; mantenha cada uma curta, com o mais importante no topo:
   a) '## Objetivos do ${DONO}': o que ELE quer alcancar (nao os seus objetivos, que ficam
      em 'Metas de curto prazo'), nas palavras dele, uma linha cada, com a data em que ele
      disse. Tire o que ele alcancou ou abandonou (e conte no diario).
   b) '## Tarefas em andamento': as frentes que ele toca em paralelo, uma linha cada, no
      formato '- **frente**: estado. Proximo passo: X. Bola: comigo | com ${DONO} | com
      <terceiro>. (desde AAAA-MM-DD)'. Feche o que terminou. Confira que a linha
      '⚡ PENDENCIAS ATIVAS' do topo diz a mesma coisa em uma linha.
   c) '## O que eu sei sobre o ${DONO}': crencas, preferencias e jeito de trabalhar que voce
      aprendeu, cada uma com '(aprendi em AAAA-MM-DD)'. So o que ele disse ou mostrou, nunca
      palpite. Se algo de hoje contradiz uma crenca antiga, corrija a linha e diga no diario
      que corrigiu. O que ja e certeza antiga pode subir pro MEMORY.md e sair daqui.
   d) NAO mexa em '## Últimas conversas' nem em '## Agora': a maquina gera as duas.
6. Ainda na working-memory, a secao '## Hoje': NAO esvazie. Substitua o conteudo dela por um
   resumo do dia em 3 a 5 linhas, sendo a PRIMEIRA linha exatamente
   '<!-- resumo do dia ${TODAY} -->'. As 7h a maquina move esse resumo para '## Ontem', e e
   ele que voce vai ler amanha cedo. Limpe o resto do arquivo (o que ja virou diario ou fato
   duradouro). NAO mexa em 'Instrucoes do ${DONO}' nem em 'Quero Falar com o ${DONO} Sobre'
   (exceto os passos 8 e 9). Se existir memory/wm-transbordo.md, e o que saiu da working-memory
   por falta de espaco: decida o que volta, o que sobe pro MEMORY.md e o que fica so la.
7. Reveja a linha '⚡ PENDENCIAS ATIVAS' no topo: ela tem que refletir o que de fato esta em
   aberto com ${DONO} agora, com o proximo passo de cada frente.
8. Tarefa repetida que ainda nao e skill (veja a skill aprender, se estiver disponivel):
   a) Releia o dia e procure trabalho que voce fez A MAO seguindo um roteiro de varios
      passos: o mesmo tipo de pedido, o mesmo procedimento montado de novo do zero.
   b) Confira se ja existe skill pra isso (.claude/skills/ e memory/skills-aprendidas.md).
      Se existe e voce nao usou, anote no diario: foi falha sua de lembrar, nao candidata.
   c) Registre em memory/skills-candidatas.md (crie se nao existir), uma linha por tarefa:
      '- <tarefa em 1 linha> | vezes: N | datas: DD/MM, DD/MM | o que a skill faria'. Se a
      tarefa ja esta la, so some a vez e a data.
   d) Quando uma candidata chegar a 2 vezes (ou 1, se o roteiro tem mais de 5 passos e
      ${DONO} disse que vai repetir), ponha em 'Quero Falar com o ${DONO} Sobre':
      '- Hoje fiz de novo <tarefa> a mao; quer que eu transforme numa skill?'. No maximo
      UMA por noite, e nao repita a que ja esta la esperando resposta.
   e) NAO crie a skill sozinho: skill so nasce com o sim dele, na conversa. Nao e
      candidata: tarefa de um passo, coisa que uma rotina ja faz, pedido que nao vai voltar.
9. Se hoje voce usou uma skill sua e ele corrigiu alguma coisa no resultado, confira se a
   skill ja foi melhorada; se nao foi, deixe em 'Quero Falar...' a linha
   '- Melhorar a skill <nome>: <o que ele corrigiu>'.${EXT_BLOCK}

O combinado: na duvida, preserve. Nunca invente fato que nao esta escrito.
No fim, escreva UMA linha de resumo do que mudou (apenas texto; nao mande pro canal)."

# ─── MODO HEADLESS (claude -p) + restart-fresh — sono/vigilia ──────────────────
# Opt-in via DGCLAW_REFLECT_MODE=headless. Use em hosts onde a injecao na sessao viva
# NAO funciona (kernel legacy_tiocsti=0 + sem tmux; sessao sob expect/script): a reflexao
# injetada nunca executa e a consolidacao fica congelada. Aqui ela roda HEADLESS (claude
# --print, mesma identidade via AGENT.md materializado no workspace), de forma SINCRONA —
# entao sabemos quando terminou (exit 0) e ai disparamos o RESTART-FRESH: a persona "dorme"
# (consolida o dia no working-memory) e "acorda" numa sessao leve (~base) no dia seguinte.
# Custa credito de API 1x/dia (a consolidacao e a unica tarefa que justifica Opus); o
# resto da vida segue na assinatura flat. Default continua 'inject' (nao quebra instalacoes).
REFLECT_MODE="$(printf '%s' "${DGCLAW_REFLECT_MODE:-inject}" | tr 'A-Z' 'a-z')"

# ─── copia de seguranca do MEMORY.md (vale para os DOIS modos) ──────────────────
# A consolidacao reescreve o MEMORY.md e ele nao esta no Git: se o modelo apagar demais, so
# esta foto traz de volta. A conferencia (e a restauracao, se sumir mais de 25%) acontece
# depois: aqui mesmo no modo headless, e no modo inject em poke-ack.sh e no build-wm.sh das 7h.
# Na re-injecao do verificador (DGCLAW_REFLECT_DATE vem preenchida) NAO tira foto nova: a
# persona pode ter reescrito metade do MEMORY.md na primeira tentativa, e a foto nova viraria
# a referencia da conferencia, escondendo o estrago. Vale a foto do primeiro disparo.
if [ -n "${DGCLAW_REFLECT_DATE:-}" ]; then
    echo "[$(date '+%F %T')] reflexao ${TODAY}: re-injecao, mantenho a copia do MEMORY.md tirada no primeiro disparo" >> "$LOG"
elif ! python3 "$PLUGIN/scripts/_lib/memoria_guarda.py" guardar --ws "$DGCLAW_WORKSPACE" >> "$LOG" 2>&1; then
    echo "[$(date '+%F %T')] reflexao ${TODAY}: NAO consegui guardar a copia do MEMORY.md (motivo na linha acima). A reflexao vai rodar SEM copia de seguranca; se a memoria encolher, nao havera de onde restaurar." >> "$LOG"
fi

if [ "$REFLECT_MODE" = "headless" ]; then
    export PATH="${BUN_BIN_DIR:-$HOME/.bun/bin}:$HOME/.local/bin:$PATH"
    CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
    REFLECT_MODEL="${DGCLAW_REFLECT_MODEL:-opus}"
    RESTART_THRESHOLD="${DGCLAW_REFLECT_RESTART_THRESHOLD:-100000}"

    echo "[$(date '+%F %T')] reflexao ${TODAY}: consolidacao HEADLESS (claude --print, model=$REFLECT_MODEL)" >> "$LOG"
    "$CLAUDE_BIN" --print \
        --no-session-persistence \
        --permission-mode bypassPermissions \
        --add-dir "$DGCLAW_WORKSPACE" \
        --model "$REFLECT_MODEL" \
        -p "$PROMPT" >> "$LOG" 2>&1
    RC=$?
    echo "[$(date '+%F %T')] reflexao ${TODAY}: consolidacao concluida (exit $RC)" >> "$LOG"

    # Confere se o MEMORY.md nao encolheu demais. rc 3 = restaurou a versao anterior (o aviso
    # ao dono ja saiu de dentro do script); outro rc != 0 = nao conseguiu conferir.
    python3 "$PLUGIN/scripts/_lib/memoria_guarda.py" conferir --ws "$DGCLAW_WORKSPACE" >> "$LOG" 2>&1
    GRC=$?
    case "$GRC" in
        0) ;;
        3) echo "[$(date '+%F %T')] reflexao ${TODAY}: o MEMORY.md encolheu demais; a versao anterior foi RESTAURADA e o dono avisado (detalhes acima)" >> "$LOG" ;;
        *) echo "[$(date '+%F %T')] reflexao ${TODAY}: NAO consegui conferir o MEMORY.md (rc=$GRC, motivo acima)" >> "$LOG" ;;
    esac

    # DORMIR -> ACORDAR FRESCA: so reinicia se a consolidacao deu certo (exit 0). Senao
    # PRESERVA a sessao (nao perde estado) e alerta o dono. O restart-fresh reusa o
    # auto-compact em MODO RESTART (carry-over com log da thread + verificacao por saude
    # do systemd); so reinicia o que estiver acima de RESTART_THRESHOLD.
    if [ "$RC" -eq 0 ]; then
        echo "[$(date '+%F %T')] reflexao ${TODAY}: restart-fresh pos-consolidacao (teto ${RESTART_THRESHOLD})" >> "$LOG"
        # --ignore-cooldown: o auto-compact do timer pode ter rodado minutos antes e o
        # cooldown bloqueava o restart noturno (bug visto na Isa em 30/06). A checagem
        # de ociosidade continua valendo (nao corta conversa tarde da noite).
        DGCLAW_COMPACT_MODE=restart python3 "$PLUGIN/scripts/auto-compact.py" \
            --threshold "$RESTART_THRESHOLD" --ignore-cooldown >> "$LOG" 2>&1
    else
        echo "[$(date '+%F %T')] reflexao ${TODAY}: consolidacao FALHOU (exit $RC) — NAO reinicio (preservo a sessao)" >> "$LOG"
        bash "$PLUGIN/scripts/notify-owner.sh" \
            "⚠️ Reflexao noturna ${TODAY}: consolidacao falhou (exit $RC). Sessao NAO reiniciada. Ver reflection.log." >/dev/null 2>&1 || true
    fi
    echo "[$(date '+%F %T')] reflexao ${TODAY}: fim (headless)" >> "$LOG"
    exit "$RC"
fi

# ─── injeta na sessao viva (com VERIFICACAO de recibo); no-op gracioso se morta ──
# (modo default 'inject': a propria persona executa a reflexao na sessao flat dela)
# shellcheck disable=SC1091
source "$PLUGIN/scripts/_lib/inject.sh"

# Liga o recibo deterministico deste poke. Sucesso = a persona roda poke-ack.sh OU o
# diario memory/<data>.md aparece escrito apos o envio (rede de seguranca). Se nenhum dos
# dois em ~25min, o poke-verify.py re-injeta (ate 2x, de 20 em 20min) e, esgotado, alerta o dono.
export DGCLAW_POKE_VERIFY=1
export DGCLAW_POKE_KEY="reflection-${TODAY}"
export DGCLAW_POKE_ARTIFACT="memory/${TODAY}.md"
export DGCLAW_POKE_DEADLINE_SEC=1500
export DGCLAW_POKE_MAX_RETRIES=2
export DGCLAW_POKE_RETRY_INTERVAL_SEC=1200
export DGCLAW_POKE_RETRIGGER="DGCLAW_REFLECT_DATE=${TODAY} bash ${PLUGIN}/scripts/reflection.sh ${CONFIG}"

echo "[$(date '+%F %T')] reflexao: injetando poke (verificavel) na sessao viva de ${SLUG}" >> "$LOG"
inject_session "$SLUG" reflection <<< "$PROMPT" >> "$LOG" 2>&1
RC=$?

HORA="$(date '+%H:%M')"
case "$RC" in
    0)
        echo "[$(date '+%F %T')] reflexao ${TODAY}: poke injetado na sessao viva (rc=0)" >> "$LOG"
        exit 0
        ;;
    75)
        # O poke ja ficou como pendente no verificador (DGCLAW_POKE_VERIFY=1), que re-injeta.
        echo "[$(date '+%F %T')] reflexao ${TODAY}: sessao ocupada (turno em voo); o verificador re-injeta em 20 min" >> "$LOG"
        declare -F pulso >/dev/null && pulso aguardando "sessão ocupada às ${HORA}, o verificador tenta de novo em 20 min"
        exit 0
        ;;
    2)
        MSG="a sessão do agente não estava no ar às ${HORA} e a reflexão de ${TODAY} não rodou. O que fazer: ligar o agente e rodar de novo com 'bash ${PLUGIN}/scripts/reflection.sh ${CONFIG}'"
        echo "[$(date '+%F %T')] reflexao ${TODAY}: FALHA, ${MSG}" >> "$LOG"
        declare -F pulso >/dev/null && pulso erro "$MSG"
        exit 2
        ;;
    *)
        MSG="falha ao injetar a reflexão de ${TODAY} na sessão (rc=${RC}). O que fazer: ver o log em ${LOG} e rodar de novo com 'bash ${PLUGIN}/scripts/reflection.sh ${CONFIG}'"
        echo "[$(date '+%F %T')] reflexao ${TODAY}: FALHA, ${MSG}" >> "$LOG"
        declare -F pulso >/dev/null && pulso erro "$MSG"
        exit "$RC"
        ;;
esac
