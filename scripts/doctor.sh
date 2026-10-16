#!/bin/bash
# doctor.sh: diagnostico e conserto de um agente DG Claw (modo servidor).
#
# Uso:  bash doctor.sh <.dgclaw/config.sh> [--fix]
#
# Sem --fix: checa tudo e conserta so o que e determinístico e sem risco (trust do workspace,
# settings locais, cache needs-auth preso, watchdog do canal ausente).
# Com --fix: alem disso, re-materializa a identidade, reativa timer parado, reinstala os
# timers de vida e o fix do canal, e limpa pokefile orfao.
#
# Cobre as duas camadas: a base (binarios, bot, servico, pareamento) e a camada de operacao
# 24/7 (identidade materializada, timers de vida, injecao na sessao viva, auto-recovery,
# painel, poderes e extensoes instaladas).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONFIG="${1:-${DGCLAW_CONFIG:-}}"
[ -n "$CONFIG" ] || { echo "uso: doctor.sh <.dgclaw/config.sh> [--fix]" >&2; exit 1; }
[ -f "$CONFIG" ] || { echo "config nao encontrada: $CONFIG" >&2; exit 1; }
FIX=0
for a in "$@"; do [ "$a" = "--fix" ] && FIX=1; done

# Sourcing de config encadeada e fragil sob `set -u` (a config faz refs/unset); desliga so aqui.
set +u
# shellcheck disable=SC1090
source "$CONFIG"
set -u

: "${DGCLAW_WORKSPACE:?config sem DGCLAW_WORKSPACE (esta e a config certa do agente?)}"
WS="$DGCLAW_WORKSPACE"
SLUG="${DGCLAW_SLUG:-$(basename "$WS")}"
NOME="${DGCLAW_NAME:-$SLUG}"
PLUGIN="${DGCLAW_PLUGIN_ROOT:-$WS/.dgclaw/plugin}"
[ -d "$PLUGIN/scripts" ] || PLUGIN="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE="${TELEGRAM_STATE_DIR:-}"
BUN_BIN_DIR="${BUN_BIN_DIR:-$HOME/.bun/bin}"
LOGDIR="${DGCLAW_LOGS_DIR:-${DGCLAW_LOG_DIR:-$WS/.dgclaw/logs}}"
SVC="dgclaw-${SLUG}.service"
UNIT="/etc/systemd/system/$SVC"

if [ -n "${DGCLAW_CLAUDE_CONFIG_DIR:-}" ]; then
    CFGDIR="$DGCLAW_CLAUDE_CONFIG_DIR"; PLUGENV="CLAUDE_CONFIG_DIR=$DGCLAW_CLAUDE_CONFIG_DIR"
else
    CFGDIR="/root/.claude"; PLUGENV=""
fi
CFGJSON="$CFGDIR/.claude.json"
[ "$CFGDIR" = "/root/.claude" ] && CFGJSON="/root/.claude.json"

ok=0; warn=0; bad=0; fixed=0
P(){ echo "  [ ok ]  $1"; ok=$((ok+1)); }
W(){ echo "  [aviso] $1"; warn=$((warn+1)); }
B(){ echo "  [FALTA] $1"; bad=$((bad+1)); }
F(){ echo "  [consertado] $1"; fixed=$((fixed+1)); }
I(){ echo "  [info]  $1"; }
TITULO(){ echo; echo "-- $1"; }

echo "== DG Claw doctor: $NOME ($SLUG) em $WS =="
[ "$FIX" = "1" ] && I "modo --fix: vou consertar o que der, nao so reportar."

# ─────────────────────────────────────────────────────────────────────────────
TITULO "1. Programas de base"
command -v claude >/dev/null 2>&1 && P "claude no PATH" || B "claude NAO esta no PATH (o agente nao tem cerebro sem ele)"
command -v python3 >/dev/null 2>&1 && P "python3 presente" || B "python3 ausente (os crons de memoria e o heartbeat precisam dele)"
{ command -v bun >/dev/null 2>&1 || [ -x "$BUN_BIN_DIR/bun" ]; } \
    && P "bun presente" \
    || B "bun ausente (o canal do Telegram roda em bun) -> curl -fsSL https://bun.sh/install | bash"
if command -v node >/dev/null 2>&1; then P "node presente (painel)"; else W "node ausente: o painel nao sobe (o resto funciona)"; fi

if env $PLUGENV claude plugin list 2>/dev/null | grep -qi "telegram"; then
    P "plugin telegram instalado no config dir do servico ($CFGDIR)"
else
    B "plugin telegram NAO esta no config dir do servico ($CFGDIR) -> rode: $PLUGENV claude plugin install telegram@claude-plugins-official"
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "2. Permissoes que travam o Claude sob systemd"
if python3 -c "import json,sys; d=json.load(open('$CFGJSON')); p=d.get('projects',{}).get('$WS',{}); sys.exit(0 if p.get('hasTrustDialogAccepted') else 1)" 2>/dev/null; then
    P "workspace marcado como confiavel"
else
    if python3 - "$CFGJSON" "$WS" <<'PY' 2>/dev/null
import json,sys
path,ws=sys.argv[1],sys.argv[2]
try: d=json.load(open(path))
except Exception: d={}
d.setdefault("projects",{}); pr=d["projects"].get(ws,{})
pr["hasTrustDialogAccepted"]=True; pr["hasCompletedProjectOnboarding"]=True
d["projects"][ws]=pr; d["hasCompletedOnboarding"]=True
json.dump(d,open(path,"w"),indent=2)
PY
    then F "workspace marcado como confiavel (sem isso o servico para na pergunta de confianca)"
    else B "nao consegui marcar o workspace como confiavel em $CFGJSON (permissao? arquivo corrompido?)"
    fi
fi

LS="$WS/.claude/settings.local.json"
if python3 -c "import json,sys; sys.exit(0 if json.load(open('$LS')).get('skipDangerousModePermissionPrompt') else 1)" 2>/dev/null; then
    P "pergunta de modo perigoso ja dispensada nas settings locais"
else
    mkdir -p "$WS/.claude"
    if python3 - "$LS" <<'PY' 2>/dev/null
import json,sys
path=sys.argv[1]
try: d=json.load(open(path))
except Exception: d={}
d["skipDangerousModePermissionPrompt"]=True
json.dump(d,open(path,"w"),indent=2)
PY
    then F "pergunta de modo perigoso dispensada em $LS (sem isso o servico trava no start)"
    else B "nao consegui escrever $LS"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "3. Servico do agente"
if [ -f "$UNIT" ]; then
    grep -q "/usr/bin/script" "$UNIT" && P "o servico roda num terminal de verdade (PTY)" \
        || B "servico SEM PTY: o Claude precisa de terminal -> reinstale com install-service.sh"
    grep -q "IS_SANDBOX=1" "$UNIT" && P "IS_SANDBOX=1 presente" \
        || B "servico sem IS_SANDBOX=1 (rodando como root, o bypass de permissao falha sem isso)"
    grep -q "prestart-clear-tg-authcache" "$UNIT" && P "limpeza do cache needs-auth antes de cada start" \
        || W "sem a limpeza de cache antes do start: o bot pode ficar mudo do 2o start em diante"
else
    B "o servico $SVC nao existe -> rode install-service.sh"
fi

EN=$(systemctl is-enabled "$SVC" 2>/dev/null); EN="${EN:-?}"
AC=$(systemctl is-active  "$SVC" 2>/dev/null); AC="${AC:-?}"
I "$SVC -> liga no boot: $EN | rodando agora: $AC"
[ "$AC" = "active" ] && P "servico no ar" || B "servico parado -> systemctl start $SVC"
[ "$EN" = "disabled" ] && W "nao liga sozinho no boot (pode ser escolha de custo; se quiser 24/7: systemctl enable $SVC)"

# drop-in do fix do canal (o ExecStartPre pode vir do unit OU do drop-in)
DROPIN="/etc/systemd/system/dgclaw-${SLUG}.service.d/10-dgclaw-tg-authcache.conf"
PRESTART="$WS/.dgclaw/prestart-clear-tg-authcache.sh"
if [ -f "$DROPIN" ] && [ -x "$PRESTART" ]; then
    P "fix do canal instalado como drop-in"
elif [ -f "$UNIT" ] && grep -q "prestart-clear-tg-authcache" "$UNIT"; then
    I "fix do canal ja vem no proprio unit (drop-in dispensavel)"
else
    B "fix do canal AUSENTE: depois de um restart/reboot o bot fica mudo"
    [ "$FIX" = "1" ] && bash "$PLUGIN/scripts/install-channel-fix.sh" "$CONFIG" >/dev/null 2>&1 \
        && F "fix do canal instalado (reinicie: systemctl restart $SVC)"
fi

# chave presa AGORA no cache (o canal seria pulado no proximo start)
CACHE="$CFGDIR/mcp-needs-auth-cache.json"
if [ -f "$CACHE" ] && grep -q 'plugin:telegram:telegram' "$CACHE" 2>/dev/null; then
    if bash "$SCRIPT_DIR/prestart-clear-tg-authcache.sh" "$CFGDIR" >/dev/null 2>&1; then
        F "a marca de 'precisa autenticar' do telegram estava presa no cache, entao limpei (reinicie $SVC)"
    else
        B "marca de 'precisa autenticar' presa em $CACHE e nao consegui limpar (rode como root)"
    fi
else
    P "cache de autenticacao limpo"
fi

# watchdog do canal (cobre o poller morrer com o servico de pe).
# So instalamos se o servico do agente EXISTIR: sem ele, criar o vigia deixaria uma
# unidade orfa no systemd, vigiando um agente que nao existe.
WDTIMER="dgclaw-${SLUG}-channel-watchdog.timer"
# Sem Telegram nao ha bot para vigiar. Um vigia nessa situacao acha o canal morto e reinicia
# o agente a cada 2 min, para sempre (Lara 02/10, Luna 05/10/2026). Este doctor ja foi quem
# o reinstalou, entao aqui ele e retirado, nunca posto.
if [ -z "$STATE" ]; then
    if systemctl list-unit-files "$WDTIMER" --no-legend 2>/dev/null | grep -q .; then
        if [ "$FIX" = "1" ] && bash "$PLUGIN/scripts/install-channel-watchdog.sh" "$CONFIG" --off >/dev/null 2>&1; then
            F "vigia do canal retirado: este agente nao tem Telegram, e o vigia reiniciava a sessao a cada 2 min"
        else
            B "vigia do canal instalado num agente sem Telegram: ele reinicia a sessao a cada 2 min -> rode o doctor com --fix (ou: bash $PLUGIN/scripts/install-channel-watchdog.sh \"$CONFIG\" --off)"
        fi
    else
        I "sem Telegram: o vigia do canal nao se aplica (quem cuida da sessao e o dgclaw-${SLUG}-watchdog.timer)"
    fi
elif systemctl is-active --quiet "$WDTIMER" 2>/dev/null; then
    P "vigia do canal ativo (checa o bot a cada 2 min)"
elif [ ! -f "$UNIT" ]; then
    I "vigia do canal nao instalado, e o certo: o servico do agente ainda nao existe"
else
    if bash "$PLUGIN/scripts/install-channel-watchdog.sh" "$CONFIG" >/dev/null 2>&1; then
        F "vigia do canal instalado e ligado ($WDTIMER)"
    else
        B "vigia do canal ausente e nao consegui instalar -> bash $PLUGIN/scripts/install-channel-watchdog.sh \"$CONFIG\""
    fi
fi

# veredito REAL do canal: nao basta o servico estar ativo, o poller tem que estar vivo
if [ -z "$STATE" ]; then
    I "sem Telegram: a conversa e pelo app ou pelo painel, entao nao ha bot para conferir"
elif [ "$AC" = "active" ]; then
    if bash "$PLUGIN/scripts/channel-health.sh" "$CONFIG" >/dev/null 2>&1; then
        P "canal do Telegram conectado de verdade (o bot responde)"
    else
        B "servico no ar mas o canal do Telegram NAO conectou (bot mudo). O vigia deve reiniciar em ate 2 min; na pressa: systemctl restart $SVC"
    fi
else
    I "servico parado, entao nao da pra avaliar o canal"
fi
# Nota: o aviso "1 setup issue: MCP" no terminal costuma ser conector OAuth herdado falhando
# em modo headless. O que vale pro bot e o veredito do canal acima.

# pareamento
if [ -n "$STATE" ] && python3 -c "import json,sys; d=json.load(open('$STATE/access.json')); sys.exit(0 if d.get('allowFrom') else 1)" 2>/dev/null; then
    P "bot pareado: so o dono fala com ele"
elif [ -n "$STATE" ]; then
    B "bot ainda nao pareado (mande uma mensagem pra ele e aprove no wizard). Sem isso qualquer um poderia conversar"
else
    I "sem Telegram (config sem TELEGRAM_STATE_DIR): nao ha bot para parear"
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "4. Arquivos do agente"
[ -f "$WS/.dgclaw/agent.json" ] && P "agent.json presente" || B "agent.json ausente (a instalacao nao chegou ao fim) -> /dgclaw:setup"
[ -f "$WS/.dgclaw/config.sh" ]  && P "config.sh presente" || B "config.sh ausente"
[ -f "$WS/.dgclaw/powers.json" ] && P "powers.json presente" || W "powers.json ausente (o catalogo de poderes some do painel)"
[ -d "$WS/.dgclaw/plugin/scripts" ] && P "copia estavel do plugin presente" \
    || B "copia estavel ausente (.dgclaw/plugin): se a pasta do plugin for limpa, os crons param"

if head -1 "$WS/AGENT.md" 2>/dev/null | grep -q "GERADO PELO DG CLAW"; then
    P "identidade materializada no AGENT.md"
else
    B "AGENT.md NAO foi materializado: a identidade rica nao entra no system prompt"
    [ "$FIX" = "1" ] && bash "$PLUGIN/scripts/materialize-identity.sh" "$WS" >/dev/null 2>&1 \
        && F "identidade re-materializada (reinicie $SVC pra valer)"
fi
[ -f "$WS/AGENT.md.bak" ] && P "backup do AGENT.md anterior guardado" || W "sem backup do AGENT.md anterior"
grep -q "^## Agora" "$WS/working-memory.md" 2>/dev/null && P "working-memory com a secao Agora" \
    || W "working-memory sem a secao Agora (o batimento nao tem onde escrever o estado)"

# ownership (so importa quando o agente tem usuario dedicado)
WS_OWNER=$(stat -c '%U' "$WS" 2>/dev/null || echo root)
if [ "$WS_OWNER" != "root" ]; then
    WMO=$(stat -c '%U' "$WS/working-memory.md" 2>/dev/null || echo "?")
    [ "$WMO" = "$WS_OWNER" ] && P "dono dos arquivos coerente ($WS_OWNER)" \
        || W "working-memory.md e do usuario $WMO, mas o workspace e do $WS_OWNER (algum cron gravou como root)"
fi

# Memoria que entra sozinha (template de 05/10/2026): o CLAUDE.md importa o MEMORY.md e a
# working-memory com @. Agente instalado antes disso so recebia os fatos soltos pelo hook e
# comecava a sessao sem as regras que o dono ja tinha ensinado.
if [ -f "$WS/CLAUDE.md" ]; then
    if grep -q "^@MEMORY.md" "$WS/CLAUDE.md" && grep -q "^@working-memory.md" "$WS/CLAUDE.md"; then
        P "CLAUDE.md puxa o MEMORY.md e a working-memory em toda sessao"
    else
        W "CLAUDE.md sem as linhas @MEMORY.md e @working-memory.md: o agente comeca a sessao sem as regras que aprendeu (instalacao anterior a 05/10/2026) -> rode com --fix"
        if [ "$FIX" = "1" ] && [ -f "$PLUGIN/templates/CLAUDE.md.tmpl" ]; then
            cp -p "$WS/CLAUDE.md" "$WS/CLAUDE.md.bak-$(date +%Y%m%d)"
            { echo; sed -n '/^### O que voce ja aprendeu entra sozinho/,/^@working-memory.md/p' \
                "$PLUGIN/templates/CLAUDE.md.tmpl" | sed "s/{{DONO}}/${DGCLAW_OWNER:-dono}/g"; } >> "$WS/CLAUDE.md"
            if grep -q "^@MEMORY.md" "$WS/CLAUDE.md"; then
                F "secao da memoria acrescentada no fim do CLAUDE.md (backup ao lado; vale na proxima sessao)"
            else
                B "nao consegui acrescentar a secao: o template em $PLUGIN/templates nao tem o trecho (copia do plugin antiga? rode install-core.sh bootstrap)"
            fi
        fi
    fi
fi
if [ -f "$WS/MEMORY.md" ] && ! grep -q "^## Regras aprendidas" "$WS/MEMORY.md"; then
    W "MEMORY.md sem a secao Regras aprendidas: as correcoes do dono nao tem onde ficar (a reflexao da noite cria sozinha)"
    if [ "$FIX" = "1" ]; then
        printf '\n---\n\n## Regras aprendidas\n\n<!-- O que o dono ensinou ou corrigiu e vale pra sempre. UMA linha datada por regra: - (DD/MM/AAAA) <regra>. -->\n\n' \
            >> "$WS/MEMORY.md" && F "secao Regras aprendidas criada no MEMORY.md"
    fi
fi
if [ "$FIX" = "1" ] && [ "$WS_OWNER" != "root" ]; then
    chown "$WS_OWNER:" "$WS/CLAUDE.md" "$WS/MEMORY.md" 2>/dev/null
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "4b. Memoria e busca em conversas"
# A busca em conversas e o recall de fabrica (sem chave). Se ela esta desligada, o "lembra
# quando..." volta pra busca simples por palavra, e o dono nao tem como saber disso.
FTS_PY="$PLUGIN/scripts/memory_index/conversas_fts.py"
if [ ! -f "$FTS_PY" ]; then
    W "busca em conversas: a copia do plugin e anterior a 01/10/2026 e nao tem o conversas_fts.py (atualize a copia: install-core.sh bootstrap)"
else
    FTS_MSG=$(python3 "$FTS_PY" --workspace "$WS" status 2>&1); FTS_RC=$?
    case "$FTS_RC" in
        0) P "$FTS_MSG" ;;
        3) B "busca em conversas indisponivel neste servidor: $FTS_MSG" ;;
        *)
            if [ "$FIX" = "1" ] && bash "$PLUGIN/scripts/conversas-fts.sh" "$CONFIG" >/dev/null 2>&1; then
                F "$(python3 "$FTS_PY" --workspace "$WS" status 2>&1) (indice criado agora)"
            else
                W "$FTS_MSG -> o indice nasce sozinho no proximo build das 7h; na pressa: rode com --fix"
            fi ;;
    esac
fi
if systemctl list-unit-files "dgclaw-${SLUG}-conversas-fts.timer" --no-legend 2>/dev/null | grep -q .; then
    I "o indice da busca e atualizado a cada 15 min (rotina conversas-fts)"
else
    W "sem a rotina conversas-fts: o indice so anda uma vez por dia, no build das 7h -> bash $PLUGIN/scripts/install-timers.sh \"$CONFIG\""
fi
# Memoria semantica (05/10/2026): ligada de fabrica com o modelo local (EmbeddingGemma, sem
# chave). E o que acha "aquilo que ele falou em agosto" com outras palavras. Desligada, a busca
# em conversas continua achando pela palavra; por isso e aviso, e nao falta.
EMB_PY="$PLUGIN/scripts/memory_index/embedder.py"
IDX_DIR="${DGCLAW_MEMORY_INDEX_DIR:-$WS/.dgclaw/memory_index}"
memoria_semantica() { # imprime "estado|texto": ligada-ok, ligada-vazia, ligada-outro, desligada
    EMB_PY="$EMB_PY" DB="$IDX_DIR/chunks.db" python3 - <<'PY' 2>&1
import json, os, sqlite3, subprocess
r = subprocess.run(["python3", os.environ["EMB_PY"], "status", "--json"],
                   capture_output=True, text=True, timeout=30)
try:
    st = json.loads(r.stdout or "{}")
except ValueError:
    st = {"ligada": False, "motivo": (r.stderr or r.stdout or "embedder.py sem resposta").strip()[:200]}
n, fp = 0, None
if os.path.exists(os.environ["DB"]):
    try:
        c = sqlite3.connect(os.environ["DB"])
        n = c.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        row = c.execute("SELECT value FROM meta WHERE key='fingerprint'").fetchone()
        fp = row[0] if row else None
    except sqlite3.Error as e:
        print(f"ligada-vazia|o indice {os.environ['DB']} nao abre ({e})")
        raise SystemExit
if not st.get("ligada"):
    print(f"desligada|{st.get('motivo')}")
elif n == 0:
    print(f"ligada-vazia|{st.get('provedor')}, mas o indice esta vazio (o primeiro reindex ainda nao rodou)")
elif fp and not fp.startswith(f"{st.get('fingerprint')}|"):
    print(f"ligada-outro|o indice ({n} trechos) foi feito com outro modelo ({fp.split('|')[0]}) e a busca agora usa {st.get('provedor')}: ate refazer, ela so acha o termo escrito")
else:
    print(f"ligada-ok|memoria semantica ligada ({st.get('provedor')}), {n} trechos no indice")
PY
}
if [ ! -f "$EMB_PY" ]; then
    W "memoria semantica: a copia do plugin e anterior a 05/10/2026 e nao tem o embedder.py (atualize a copia: install-core.sh bootstrap)"
else
    MS="$(memoria_semantica)"; MS_ESTADO="${MS%%|*}"; MS_TEXTO="${MS#*|}"
    [ "$MS_ESTADO" = "desligada" ] && [ "${DGCLAW_EMBED_PROVIDER:-}" = "off" ] && MS_ESTADO="de-proposito"
    case "$MS_ESTADO" in
        ligada-ok) P "$MS_TEXTO" ;;
        de-proposito) I "$MS_TEXTO. Para religar, tire DGCLAW_EMBED_PROVIDER=off do config.sh" ;;
        ligada-vazia|ligada-outro)
            if [ "$FIX" = "1" ] && bash "$PLUGIN/scripts/memory-reindex.sh" "$CONFIG" >/dev/null 2>&1; then
                MS="$(memoria_semantica)"; F "${MS#*|} (reindex rodou agora)"
            else
                W "memoria semantica: $MS_TEXTO -> o reindex das 04:20 refaz sozinho; na pressa: rode com --fix"
            fi ;;
        *)
            if [ "$FIX" = "1" ] && bash "$PLUGIN/scripts/install-embedding-local.sh" "$CONFIG" >/dev/null 2>&1; then
                MS="$(memoria_semantica)"; F "${MS#*|} (modelo local instalado agora)"
            else
                W "memoria semantica DESLIGADA: $MS_TEXTO. Para ligar (uma vez, ~350 MB, sem chave): sudo bash $PLUGIN/scripts/install-embedding-local.sh \"$CONFIG\""
            fi ;;
    esac
fi
if ! systemctl list-unit-files "dgclaw-${SLUG}-memory-reindex.timer" --no-legend 2>/dev/null | grep -q .; then
    W "sem a rotina memory-reindex: o indice da memoria semantica nao anda sozinho -> bash $PLUGIN/scripts/install-timers.sh \"$CONFIG\""
fi

# A working-memory no formato de 01/10/2026: objetivos, tarefas, crencas e ultimas conversas.
if grep -q "^## Objetivos" "$WS/working-memory.md" 2>/dev/null && grep -qE "^## (Ú|U)ltimas conversas" "$WS/working-memory.md" 2>/dev/null; then
    P "working-memory com as secoes sobre o dono (objetivos, tarefas, o que sei, ultimas conversas)"
else
    W "working-memory no formato antigo (sem objetivos/tarefas/ultimas conversas do dono). O proximo batimento acrescenta sozinho"
    if [ "$FIX" = "1" ] && bash "$PLUGIN/scripts/build-wm.sh" "$CONFIG" --agora-only >/dev/null 2>&1; then
        F "secoes novas acrescentadas na working-memory (nada do que havia foi tirado)"
    fi
fi

# A reflexao "roda" mas nao escreve o diario: e a quebra que o pulso nao ve, porque o
# pulso mede a ENTREGA do recado na sessao, nao a execucao. O diario e a prova de execucao.
ULTIMO_DIARIO=""
for d in "$WS"/memory/20[0-9][0-9]-[0-9][0-9]-[0-9][0-9].md; do
    [ -f "$d" ] && ULTIMO_DIARIO="$(basename "$d" .md)"   # o glob ja vem em ordem de data
done
if [ -z "$ULTIMO_DIARIO" ]; then
    I "nenhum diario escrito ainda (normal no primeiro dia de vida)"
else
    DIAS_SEM=$(( ( $(date +%s) - $(date -d "$ULTIMO_DIARIO" +%s 2>/dev/null || date +%s) ) / 86400 ))
    if [ "$DIAS_SEM" -le 1 ]; then
        P "a reflexao da noite esta escrevendo o diario (ultimo: $ULTIMO_DIARIO)"
    else
        B "a reflexao da noite nao escreve o diario ha $DIAS_SEM dias (ultimo: $ULTIMO_DIARIO). O recado das 23:30 sai, mas a sessao nao executa: veja a secao 6 acima e o docs/EMERGENCIA.md, secoes 3.3 (login vencido ou outro erro no ultimo turno) e 3.7 (sessao travada)"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "5. Rotinas do dia a dia (timers)"
# Descobertos dinamicamente, pra rotina nova aparecer sozinha sem editar o doctor.
# Fora: os de dominio proprio (Instagram) e o vigia do canal, ja checados acima.
mapfile -t LIFE_TIMERS < <(
    systemctl list-unit-files "dgclaw-${SLUG}-*.timer" --no-legend 2>/dev/null \
        | awk '{print $1}' | grep -vE -- "-(post|comments|channel-watchdog)" | sort -u
)
if [ "${#LIFE_TIMERS[@]}" -eq 0 ]; then
    B "nenhuma rotina instalada (reflexao, auditoria, batimento...) -> bash $PLUGIN/scripts/install-timers.sh \"$CONFIG\""
    [ "$FIX" = "1" ] && bash "$PLUGIN/scripts/install-timers.sh" "$CONFIG" >/dev/null 2>&1 && F "rotinas instaladas"
else
    for U in "${LIFE_TIMERS[@]}"; do
        t="${U#dgclaw-${SLUG}-}"; t="${t%.timer}"
        if systemctl is-active --quiet "$U"; then
            P "rotina $t ativa"
        else
            W "rotina $t existe mas esta parada"
            [ "$FIX" = "1" ] && systemctl enable --now "$U" >/dev/null 2>&1 && F "rotina $t religada"
        fi
    done
fi

# consolidacao simples: se ficou ligada junto com a reflexao, as duas mexem na memoria a noite
if systemctl is-active --quiet "dgclaw-${SLUG}-consolidate.timer" 2>/dev/null \
   && systemctl is-active --quiet "dgclaw-${SLUG}-reflection.timer" 2>/dev/null; then
    W "consolidacao simples e reflexao noturna ligadas ao mesmo tempo (duas rotinas mexendo na mesma memoria)"
    [ "$FIX" = "1" ] && systemctl disable --now "dgclaw-${SLUG}-consolidate.timer" >/dev/null 2>&1 \
        && F "consolidacao simples desligada (quem consolida agora e a reflexao)"
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "6. Injecao na sessao viva (o que faz os crons falarem com o agente)"
INJ_MODE="${DGCLAW_INJECT_MODE:-tiocsti}"
CHAN_NAME="${DGCLAW_CHANNEL_NAME:-dgclaw-${SLUG}}"
I "modo de injecao: $INJ_MODE | sessao alvo: $CHAN_NAME"
[ -f "$PLUGIN/scripts/_lib/inject.py" ] && P "_lib/inject.py presente" \
    || B "_lib/inject.py AUSENTE: as rotinas nao conseguem falar com o agente"
[ -f "$PLUGIN/scripts/_lib/inject.sh" ] && P "_lib/inject.sh presente" || B "_lib/inject.sh AUSENTE"

LIVE_OK=0
if [ -f "$PLUGIN/scripts/_lib/inject.py" ] && python3 "$PLUGIN/scripts/_lib/inject.py" --slug "$SLUG" --check >/dev/null 2>&1; then
    P "sessao viva no ar: as rotinas rodam dentro da assinatura, sem gastar credito de API"
    LIVE_OK=1
else
    W "sessao viva fora do ar: as rotinas nao fazem nada (e o esperado se o servico esta parado de proposito)"
fi
if [ "$LIVE_OK" = "1" ]; then
    python3 "$PLUGIN/scripts/_lib/inject.py" --slug "$SLUG" --dry-run "dgclaw doctor" >/dev/null 2>&1 \
        && P "injecao testada em seco: achei o alvo" \
        || W "nao confirmei o alvo da injecao (cheque o modo e o nome da sessao)"
fi
if ( : > "/tmp/dgclaw-inject-${SLUG}.lock" ) 2>/dev/null; then
    P "trava de injecao gravavel"
else
    B "nao consigo escrever /tmp/dgclaw-inject-${SLUG}.lock (duas rotinas podem falar juntas e embaralhar o texto)"
fi
ORPHANS=$(find /tmp -maxdepth 1 -name "dgclaw-poke-${SLUG}-*.txt" -mtime +1 2>/dev/null | wc -l)
if [ "$ORPHANS" -gt 0 ]; then
    if [ "$FIX" = "1" ]; then
        find /tmp -maxdepth 1 -name "dgclaw-poke-${SLUG}-*.txt" -mtime +1 -delete 2>/dev/null
        F "limpei $ORPHANS recado(s) antigo(s) esquecido(s) em /tmp"
    else
        W "$ORPHANS recado(s) antigo(s) esquecido(s) em /tmp (rode com --fix pra limpar)"
    fi
fi
if [ "$INJ_MODE" = "tiocsti" ]; then
    LEGACY=$(sysctl -n dev.tty.legacy_tiocsti 2>/dev/null || echo "?")
    case "$LEGACY" in
        0) I "o sistema so deixa injetar como root, e as rotinas rodam como root: ok" ;;
        1) I "o sistema libera a injecao pra qualquer processo" ;;
        *) I "nao consegui ler a config do sistema; se a injecao falhar, use DGCLAW_INJECT_MODE=tmux" ;;
    esac
    [ "$(id -u)" = "0" ] || W "doctor rodando fora do root: neste modo a injecao precisa de root"
elif [ "$INJ_MODE" = "tmux" ]; then
    command -v tmux >/dev/null 2>&1 && P "modo tmux: tmux instalado" || B "modo tmux escolhido mas o tmux nao esta instalado"
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "7. Auto-recuperacao"
AUTO_RECOVERY="${DGCLAW_AUTO_RECOVERY:-on}"
I "auto-recuperacao: $AUTO_RECOVERY (vigia da sessao + compactacao automatica $([ "$AUTO_RECOVERY" = "off" ] && echo DESLIGADOS || echo ligados))"
for pair in "watchdog:5 min:levanta a sessao se ela cair" "auto-compact:30 min:compacta a conversa quando fica pesada"; do
    N="${pair%%:*}"; rest="${pair#*:}"; FREQ="${rest%%:*}"; DESC="${rest#*:}"
    U="dgclaw-${SLUG}-${N}.timer"
    [ -f "$PLUGIN/scripts/${N}.py" ] && P "script ${N}.py presente na copia estavel" \
        || B "script ${N}.py AUSENTE em $PLUGIN/scripts"
    if [ -n "$(systemctl list-unit-files "$U" --no-legend 2>/dev/null)" ]; then
        if systemctl is-active --quiet "$U"; then
            P "$N ativo (a cada $FREQ): $DESC"
        else
            W "$N instalado mas parado"
            [ "$FIX" = "1" ] && systemctl enable --now "$U" >/dev/null 2>&1 && F "$N religado"
        fi
    else
        if [ "$AUTO_RECOVERY" = "off" ]; then
            I "$N nao instalado, e o esperado: a auto-recuperacao esta desligada nesta instalacao"
        else
            B "$N AUSENTE com auto-recuperacao ligada -> bash $PLUGIN/scripts/install-timers.sh \"$CONFIG\""
            [ "$FIX" = "1" ] && bash "$PLUGIN/scripts/install-timers.sh" "$CONFIG" >/dev/null 2>&1 && F "rotinas reinstaladas"
        fi
    fi
done
# arquivos de estado: sem eles o backoff nao segura reinicio em loop e o cooldown nao segura recompactacao
for sf in ".watchdog-state.json:espera crescente do vigia" ".auto-compact-state.json:intervalo minimo entre compactacoes"; do
    SFNAME="${sf%%:*}"; SFDESC="${sf#*:}"; SFPATH="$LOGDIR/$SFNAME"
    if [ -e "$SFPATH" ]; then
        [ -w "$SFPATH" ] && P "estado gravavel: $SFDESC" || B "estado NAO gravavel ($SFPATH): $SFDESC"
    elif [ -d "$LOGDIR" ] && [ -w "$LOGDIR" ]; then
        P "estado sera criado no primeiro disparo (pasta de logs gravavel): $SFDESC"
    else
        B "pasta de logs nao gravavel ($LOGDIR), entao nunca sera salvo: $SFDESC"
    fi
done
if [ -n "${DGCLAW_OPENROUTER_KEY:-${OPENROUTER_API_KEY:-}}" ]; then
    P "OpenRouter configurado (apoio opcional do resumo; a chave nao e exibida)"
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "8. Painel"
if systemctl is-active --quiet "dgclaw-panel-${SLUG}.service" 2>/dev/null; then
    PPORT=$(systemctl show "dgclaw-panel-${SLUG}.service" -p Environment --value 2>/dev/null \
        | tr ' ' '\n' | grep '^DGCLAW_PANEL_PORT=' | cut -d= -f2)
    P "painel no ar (porta ${PPORT:-8300})"
else
    W "painel fora do ar -> /dgclaw:panel"
fi
if systemctl is-active --quiet "dgclaw-${SLUG}-panel.service" 2>/dev/null; then
    W "o painel simples antigo (8200) ainda esta ligado; ele e substituido pelo painel completo"
fi

# O canal do painel: a metade da ESCRITA. Sem o servidor MCP o agente recebe o
# que a pessoa escreve e nao tem como responder, e isso nao levanta erro nenhum:
# a tela so fica com a pergunta dela e silencio embaixo.
MCP_CANAL="$PLUGIN/scripts/dgchat-mcp/server.mjs"
if [ ! -f "$MCP_CANAL" ]; then
    B "sem o canal do painel ($MCP_CANAL): quem escrever na aba Conversa nao recebe resposta -> atualize a copia do plugin (install-core.sh bootstrap) e reinicie $SVC"
elif ! command -v node >/dev/null 2>&1; then
    B "o canal do painel existe mas nao ha node no PATH pra rodar ele -> instale o node e reinicie $SVC"
else
    P "canal do painel instalado (tools mcp__dgchat__reply e send_file)"
    # O mcp.json e reescrito a cada boot do launch.sh. Faltar aqui quer dizer que
    # a sessao subiu por um launch anterior a 11/08/2026, sem o canal fiado.
    if [ -f "$WS/.dgclaw/dgchat.mcp.json" ]; then
        P "canal fiado na sessao (.dgclaw/dgchat.mcp.json)"
    else
        W "a sessao viva subiu SEM o canal do painel (falta .dgclaw/dgchat.mcp.json) -> reinicie $SVC pra fiar"
    fi
fi
if [ -z "$STATE" ]; then
    I "sem Telegram plugado: o painel e o unico canal, e isso e uma escolha valida"
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "9. Poderes"
if [ -f "$WS/.dgclaw/powers.json" ]; then
    python3 - "$WS/.dgclaw/powers.json" <<'PY'
import json,subprocess,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception as e:
    print(f"  [FALTA] powers.json ilegivel ({e}); o painel nao vai listar os poderes"); sys.exit(0)
ligados=[p for p in d.get("powers",[]) if p.get("enabled")]
if not ligados:
    print("  [info]  nenhum poder ligado (o agente trabalha so com o que vem de fabrica)")
for p in ligados:
    for t in p.get("cron_timers",[]) or []:
        u=t if t.endswith(".timer") else t+".timer"
        r=subprocess.run(["systemctl","list-unit-files",u],capture_output=True,text=True)
        if u in r.stdout:
            print(f"  [ ok ]  poder {p['id']}: rotina {u} instalada")
        else:
            print(f"  [aviso] poder {p['id']} esta ligado mas a rotina {u} nao existe -> /dgclaw:powers install {p['id']}")
PY
else
    I "sem powers.json, entao nao ha poderes pra checar"
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "10. Extensoes instaladas"
EXTDIR="$WS/.dgclaw/ext"
NEXT=0
if [ -d "$EXTDIR" ]; then
    while IFS= read -r e; do
        NEXT=$((NEXT+1))
        EN_NAME=$(basename "$e")
        if [ -f "$e/ext.json" ] && python3 -c "import json;json.load(open('$e/ext.json'))" 2>/dev/null; then
            P "extensao $EN_NAME: ext.json valido"
        else
            B "extensao $EN_NAME: ext.json ausente ou invalido (o painel nao sabe o que ela acende)"
        fi
        for h in working-memory.py identity.sh heartbeat.sh reflection.md seed.sh event.sh panel.json; do
            [ -f "$e/hooks/$h" ] || continue
            case "$h" in
                *.md|*.json) I "  gancho $h presente (extensao $EN_NAME)" ;;
                *.py) python3 -c "import ast,sys;ast.parse(open('$e/hooks/$h').read())" 2>/dev/null \
                        && I "  gancho $h ok (extensao $EN_NAME)" \
                        || B "  gancho $h da extensao $EN_NAME tem erro de sintaxe: ele nao vai rodar" ;;
                *.sh) bash -n "$e/hooks/$h" 2>/dev/null \
                        && I "  gancho $h ok (extensao $EN_NAME)" \
                        || B "  gancho $h da extensao $EN_NAME tem erro de sintaxe: ele nao vai rodar" ;;
            esac
        done
    done < <(find "$EXTDIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
fi
[ "$NEXT" = "0" ] && I "nenhuma extensao instalada (o agente roda inteiro assim; o DG Alive acrescenta a vida emocional)"

# Mesa de tarefas do DG Telegram (opcional, 05/10/2026): so existe pra quem tem o app, entao
# ficar sem ela e escolha, nao falta. A chave nunca e impressa: entra no curl pela entrada
# padrao (nem a lista de processos mostra) e so o codigo HTTP volta pra tela.
MESA_URL="${DGCLAW_MESA_URL:-}"; MESA_KEY="${DGCLAW_MESA_KEY:-}"
if [ -z "$MESA_URL" ] && [ -z "$MESA_KEY" ]; then
    I "mesa de tarefas: desligada (sem DGCLAW_MESA_URL no config; e opcional, so pra quem tem o DG Telegram)"
elif [ -z "$MESA_URL" ] || [ -z "$MESA_KEY" ]; then
    if [ -z "$MESA_URL" ]; then MESA_FALTA="DGCLAW_MESA_URL"; else MESA_FALTA="DGCLAW_MESA_KEY"; fi
    B "mesa de tarefas pela metade: falta $MESA_FALTA no config.sh, e sem as duas o agente nao usa a mesa -> docs/MESA-DE-TAREFAS.md"
else
    MESA_HTTP=$(printf 'Authorization: Bearer %s\n' "$MESA_KEY" \
        | curl -s --noproxy '*' -m 8 -o /dev/null -w '%{http_code}' -H @- "${MESA_URL%/}?agente=${SLUG}" 2>/dev/null)
    case "$MESA_HTTP" in
        200) P "mesa de tarefas configurada e respondendo (GET $MESA_URL deu 200)" ;;
        401) B "mesa de tarefas: o DG Telegram recusou a chave (401, revogada ou errada) -> crie outra em /settings/api-keys com Agente dono = $SLUG e troque DGCLAW_MESA_KEY no config.sh" ;;
        404) B "mesa de tarefas: $MESA_URL deu 404 (endereco errado? o certo termina em /api/v1/tarefas)" ;;
        503) W "mesa de tarefas: o DG Telegram respondeu 503, o banco da mesa nao abriu la (o motivo esta no campo erro da resposta)" ;;
        000|"") W "mesa de tarefas: ninguem respondeu em $MESA_URL em 8 s (DG Telegram fora do ar, ou endereco errado)" ;;
        *) W "mesa de tarefas: GET $MESA_URL deu HTTP $MESA_HTTP (o esperado e 200)" ;;
    esac
    # Quadro de avisos da equipe: mesma chave e mesmo servidor da mesa (a base e a URL da mesa
    # sem o /api/v1/tarefas). So o codigo HTTP volta; o texto dos avisos nao e impresso aqui.
    AVISOS_URL="${MESA_URL%/}"; AVISOS_URL="${AVISOS_URL%/api/v1/tarefas}/api/v1/avisos"
    AV_HTTP=$(printf 'Authorization: Bearer %s\n' "$MESA_KEY" \
        | curl -s --noproxy '*' -m 8 -o /dev/null -w '%{http_code}' -H @- "$AVISOS_URL/injecao?formato=texto" 2>/dev/null)
    case "$AV_HTTP" in
        200) P "quadro de avisos da equipe respondendo (GET $AVISOS_URL/injecao deu 200)" ;;
        404) W "quadro de avisos: $AVISOS_URL/injecao deu 404 (o DG Telegram desta maquina ainda nao tem o quadro?)" ;;
        000|"") W "quadro de avisos: ninguem respondeu em $AVISOS_URL em 8 s" ;;
        *) W "quadro de avisos: GET $AVISOS_URL/injecao deu HTTP $AV_HTTP (o esperado e 200; o motivo fica em .dgclaw/logs/avisos.log)" ;;
    esac
    # O hook que traz os avisos: vem do hooks.json do plugin quando o plugin esta habilitado no
    # Claude, ou do .claude/settings.json do workspace (instalacao a mao). Sem nenhum dos dois, o
    # agente posta mas nao le o que os outros postam.
    if grep -qs '"dgclaw@[^"]*": *true' "$CFGDIR/settings.json" && grep -qs 'avisos' "$PLUGIN/hooks/hooks.json"; then
        P "o hook do quadro de avisos esta ligado (hooks.json do plugin)"
    elif grep -qs 'avisos.py' "$WS/.claude/settings.json"; then
        P "o hook do quadro de avisos esta ligado (.claude/settings.json do workspace)"
    else
        W "o hook do quadro de avisos nao esta ligado: o agente posta, mas nao recebe o que os outros postam -> docs/QUADRO-DE-AVISOS.md, secao Ligar o hook"
    fi
    if [ -s "$WS/.dgclaw/logs/avisos.log" ]; then
        I "  ultima linha do log do quadro: $(tail -1 "$WS/.dgclaw/logs/avisos.log" | cut -c1-160)"
    fi
    # Mesa ligada mas CLAUDE.md de antes da regra: o agente tem a chave e nao sabe quando usar.
    for SECAO in "Mesa de tarefas" "Quadro de avisos da equipe"; do
        [ -f "$WS/CLAUDE.md" ] || break
        grep -q "^## $SECAO" "$WS/CLAUDE.md" && continue
        W "a mesa esta configurada, mas o CLAUDE.md nao tem a secao $SECAO: o agente nao sabe quando usar -> rode com --fix"
        if [ "$FIX" = "1" ] && grep -q "^## $SECAO" "$PLUGIN/templates/CLAUDE.md.tmpl" 2>/dev/null; then
            [ -f "$WS/CLAUDE.md.bak-$(date +%Y%m%d)-mesa" ] || cp -p "$WS/CLAUDE.md" "$WS/CLAUDE.md.bak-$(date +%Y%m%d)-mesa"
            { echo; SECAO="$SECAO" awk '/^## /{f=(index($0, "## " ENVIRON["SECAO"]) == 1)} f' "$PLUGIN/templates/CLAUDE.md.tmpl" \
                | sed "s/{{DONO}}/${DGCLAW_OWNER:-dono}/g"; } >> "$WS/CLAUDE.md"
            [ "$WS_OWNER" != "root" ] && chown "$WS_OWNER:" "$WS/CLAUDE.md" 2>/dev/null
            F "secao $SECAO acrescentada no fim do CLAUDE.md (backup ao lado; vale na proxima leitura)"
        fi
    done
fi

# Instalacao da era anterior a fusao: enquanto as duas camadas existirem juntas, rotina
# velha e nova disputam os mesmos arquivos. Isto vem antes de qualquer outro conserto.
if [ -d "$WS/.dg-alive" ]; then
    B "existe uma camada DG Alive ANTIGA em $WS/.dg-alive (de antes da fusao)"
    I "  a migracao do DG Alive antigo nao faz parte desta versao: nao misture as duas camadas."
    I "  guarde uma copia de $WS/.dg-alive e use um workspace novo, ou remova essa pasta depois de copiar a memoria que quiser manter."
fi

# ─────────────────────────────────────────────────────────────────────────────
TITULO "11. Log recente"
if journalctl -u "$SVC" --no-pager -n 40 2>/dev/null \
   | grep -qiE "cannot be used with root|Input must be provided|plugin not installed|trust dialog"; then
    B "o log mostra um erro conhecido -> journalctl -u $SVC -n 40"
else
    P "sem erro conhecido no log recente"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "== resumo: $ok ok · $fixed consertado(s) · $warn aviso(s) · $bad faltando =="
if [ "$fixed" -gt 0 ] && [ "$AC" = "active" ]; then
    echo ">> consertei coisas que so valem depois de reiniciar. Reiniciando $SVC..."
    systemctl restart "$SVC" >/dev/null 2>&1 && echo "   servico reiniciado." || echo "   nao consegui reiniciar (rode como root)."
fi
if [ "$bad" -eq 0 ]; then
    echo ">> TUDO CERTO."
    exit 0
fi
echo ">> ainda faltam $bad item(ns) acima."
[ "$FIX" = "0" ] && echo "   muitos deles eu conserto sozinho: rode de novo com --fix."
echo "   se travar, /dgclaw:report manda um diagnostico sanitizado pro autor."
exit 1
