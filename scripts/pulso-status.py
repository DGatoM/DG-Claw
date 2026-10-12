#!/usr/bin/env python3
"""pulso-status.py — Saude operacional do agente DG Claw (fonte unica do PULSO).

Descobre DINAMICAMENTE os componentes a monitorar (NADA hardcoded com nome de
persona):

  1. powers.json (DGCLAW_WORKSPACE/.dgclaw/powers.json): para cada poder
     `enabled`, pega os `cron_timers` e/ou `service` que ele declara.
  2. Timers de vida: unidades systemd `dgclaw-<slug>-*.timer`.
  3. Servicos do runtime: `dgclaw-<slug>.service` (canal), `dgclaw-panel-<slug>.service`
     (painel) e `dgclaw-<slug>-channel-watchdog.timer` (watchdog), se existirem.

O estado de cada componente vem de DUAS fontes, na ordem:
  a) ledger de pulso (DGCLAW_PULSO_DIR/*.jsonl) — linhas
     {timestamp, component, status, detail?} gravadas pelos crons de vida.
  b) introspeccao systemd (`systemctl show`) — fallback quando nao ha ledger.

O QUE "OK" QUER DIZER (mudou em 26/08/2026): rodou e a ultima execucao terminou
bem. Antes o estado nascia "ok" e so saia de la por defeito explicito, entao um
timer que nunca rodou aparecia verde e o painel abria com 100% sem ter medido
nada. Ver o cabecalho de timer_state(). Um componente ainda nao medido fica em
"aguardando" e sai da conta do percentual, em vez de contar como sucesso.

Cada processo sai com o que a TELA precisa pra explicar sozinha: `oQueE` e
`praQueServe` (do CATALOGO, escrito para leigo), `cadencia`, `lastRun`,
`proxima` e um `detail` em portugues que diz o motivo do estado.

Tudo degrada gracioso: sem systemd, sem ledger, sem powers.json → ainda
retorna JSON valido (lista possivelmente vazia). NUNCA estoura.

Uso:
  pulso-status.py --json [--date=YYYY-MM-DD]
  pulso-status.py            # saida humana (terminal)

Parametros por ambiente (todos opcionais, com defaults):
  DGCLAW_WORKSPACE   raiz do workspace do agente (default: cwd)
  DGCLAW_SLUG        slug do agente (default: basename do workspace)
  DGCLAW_PULSO_DIR   dir do ledger (default: <ws>/.dgclaw/logs/pulso)
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

# ─── Config por env (zero dado pessoal) ──────────────────────────────────────
WS = os.environ.get("DGCLAW_WORKSPACE") or os.getcwd()
SLUG = os.environ.get("DGCLAW_SLUG") or os.path.basename(os.path.abspath(WS)) or "agente"
PULSO_DIR = os.environ.get("DGCLAW_PULSO_DIR") or os.path.join(WS, ".dgclaw", "logs", "pulso")
POWERS_FILE = os.path.join(WS, ".dgclaw", "powers.json")

try:
    TZ_OFFSET = int(os.environ.get("DGCLAW_TZ_OFFSET_HOURS", "-3"))
except ValueError:
    TZ_OFFSET = -3
TZ = timezone(timedelta(hours=TZ_OFFSET))

# Estados possiveis (mesmo vocabulario do painel/CSS)
OK = "ok"
ERRO = "erro"
AGUARDANDO = "aguardando"
PENDENTE = "pendente"
SEM_SINAL = "sem-sinal"


def now_local():
    return datetime.now(TZ)


def today_str():
    return now_local().strftime("%Y-%m-%d")


# ─── systemd introspection (gracioso) ────────────────────────────────────────
def systemctl_show(unit, props):
    """Retorna dict prop->valor via `systemctl show`. {} se indisponivel."""
    try:
        out = subprocess.run(
            ["systemctl", "show", unit, "--no-pager", "-p", ",".join(props)],
            capture_output=True, text=True, timeout=8,
        )
        if out.returncode != 0:
            return {}
        res = {}
        for line in out.stdout.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                res[k] = v
        return res
    except Exception:
        return {}


def systemctl_show_multi(unit, props):
    """Como systemctl_show, mas guarda TODAS as linhas de cada propriedade.

    Existe porque `TimersMonotonic` sai uma vez por gatilho, e um timer de
    intervalo tem dois: o OnBootUSec (a primeira vez, depois do boot) e o
    OnUnitActiveUSec (a cadencia de verdade). Achatar isso num dicionario
    guarda so a ultima linha, e qual das duas e a ultima nao e promessa de
    ninguem: um dia a ordem muda e a tela passa a dizer que o heartbeat roda
    "a cada 5 min depois do boot", que nao e a cadencia dele.
    """
    try:
        out = subprocess.run(
            ["systemctl", "show", unit, "--no-pager", "-p", ",".join(props)],
            capture_output=True, text=True, timeout=8,
        )
        if out.returncode != 0:
            return {}
        res = {}
        for line in out.stdout.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                res.setdefault(k, []).append(v)
        return res
    except Exception:
        return {}


def unit_exists(unit):
    try:
        out = subprocess.run(
            ["systemctl", "list-unit-files", unit, "--no-legend"],
            capture_output=True, text=True, timeout=8,
        )
        return out.returncode == 0 and bool(out.stdout.strip())
    except Exception:
        return False


def list_unit_files(pattern):
    """Lista unidades cujo nome casa o glob `pattern`. [] se indisponivel."""
    try:
        out = subprocess.run(
            ["systemctl", "list-unit-files", pattern, "--no-legend"],
            capture_output=True, text=True, timeout=8,
        )
        if out.returncode != 0:
            return []
        return [ln.split()[0] for ln in out.stdout.splitlines() if ln.strip()]
    except Exception:
        return []


def parse_systemd_ts(val):
    """Parseia timestamp do systemd (ex.: 'Mon 2026-06-24 13:00:01 -03'). None se vazio."""
    if not val or val in ("n/a", "0", "-"):
        return None
    parts = val.split()
    # remove o nome do dia da semana se vier
    if parts and len(parts[0]) == 3 and not parts[0][0].isdigit():
        parts = parts[1:]
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S"):
        try:
            cand = " ".join(parts[:3]) if "%z" in fmt else " ".join(parts[:2])
            return datetime.strptime(cand, fmt)
        except Exception:
            continue
    return None


def service_state(unit):
    """Estado resumido de um .service como componente continuo.

    Servico e diferente de timer: aqui "ativo agora" E o resultado que interessa,
    porque o trabalho dele e justamente estar de pe. O que faltava era dizer
    DESDE QUANDO, que e o que separa "esta no ar" de "esta no ar ha 4 minutos
    porque acabou de reiniciar sozinho pela quinta vez".
    """
    if not unit_exists(unit):
        return None
    info = systemctl_show(
        unit,
        ["ActiveState", "SubState", "ExecMainStatus", "Result",
         "ActiveEnterTimestamp", "NRestarts"],
    )
    active = info.get("ActiveState", "")
    result = info.get("Result", "")
    desde = parse_systemd_ts(info.get("ActiveEnterTimestamp", ""))
    if active == "active":
        estado = OK
        detalhe = "esta no ar"
        if desde:
            detalhe += f" desde {humano_ate(desde)}"
    elif active in ("activating", "reloading"):
        estado, detalhe = AGUARDANDO, "esta subindo agora"
    elif result and result not in ("success", ""):
        estado, detalhe = ERRO, f"parou e terminou mal (systemd diz \"{result}\")"
    elif active in ("", "inactive"):
        estado, detalhe = SEM_SINAL, "esta parado"
    else:
        estado, detalhe = ERRO, f"systemd diz \"{active}\", que nao e um estado saudavel"
    try:
        n = int(info.get("NRestarts", "0") or 0)
    except ValueError:
        n = 0
    if n:
        detalhe += f". Ja reiniciou {n}x desde que a unidade foi carregada"
    return {
        "estado": estado,
        "active": active,
        "sub": info.get("SubState", ""),
        "detalhe": detalhe,
        "ultima": desde.isoformat() if desde else "",
        "proxima": "",
        "cadencia": "fica de pe o tempo todo",
    }


def humano_ate(quando, agora=None):
    """"ha 27 min", "ontem as 23:30", "as 13:00" — o jeito que a pessoa fala."""
    if not quando:
        return ""
    agora = agora or now_local()
    try:
        if quando.tzinfo is None:
            quando = quando.replace(tzinfo=TZ)
        delta = (agora - quando).total_seconds()
    except Exception:
        return ""
    # HOJE/AMANHA/ONTEM SAO DECIDIDOS PELA DATA, NUNCA PELA DURACAO.
    # A primeira versao disto comparava "faltam menos de 24 h?" para dizer "hoje",
    # e as 20:59 uma rotina das 07:00 da manha seguinte virava "hoje as 07:00",
    # que ja passou. Duracao nao sabe onde fica a meia-noite; data sabe.
    dias = (quando.date() - agora.date()).days
    hora = quando.strftime("%H:%M")
    if delta < 0:
        falta = -delta
        if falta < 90:
            return "daqui a menos de um minuto"
        if falta < 3600:
            return f"daqui a {int(falta // 60)} min"
        if dias == 0:
            return f"hoje as {hora}"
        if dias == 1:
            return f"amanha as {hora}"
        return f"{quando.strftime('%d/%m as %H:%M')}"
    if delta < 90:
        return "agora ha pouco"
    if delta < 3600:
        return f"ha {int(delta // 60)} min"
    if dias == 0:
        return f"hoje as {hora}"
    if dias == -1:
        return f"ontem as {hora}"
    return f"{quando.strftime('%d/%m as %H:%M')}"


def cadencia_do_timer(multi):
    """De quanto em quanto tempo o timer roda, em portugues.

    Le do systemd e nao de tabela nossa, de proposito: quem muda o horario mexe
    na unidade, e uma tabela paralela viraria mentira no primeiro ajuste.
    """
    for linha in multi.get("TimersCalendar", []):
        # { OnCalendar=*-*-* 13:00:00 ; next_elapse=... }
        if "OnCalendar=" not in linha:
            continue
        cal = linha.split("OnCalendar=", 1)[1].split(";")[0].strip()
        if cal.startswith("*-*-* "):
            hora = cal[len("*-*-* "):].strip()
            if hora.endswith(":00"):
                hora = hora[:-3]
            return f"todo dia as {hora}"
        return f"no calendario {cal}"
    for linha in multi.get("TimersMonotonic", []):
        # A cadencia de verdade e o OnUnitActiveUSec. O OnBootUSec so diz quando
        # foi a PRIMEIRA vez depois do boot, e anunciar isso como cadencia faria
        # o heartbeat (30 min) aparecer como "a cada 5 min".
        if "OnUnitActiveUSec=" in linha:
            v = linha.split("OnUnitActiveUSec=", 1)[1].split(";")[0].strip()
            return intervalo_humano(v)
    return ""


def intervalo_humano(v):
    """"30min" → "a cada 30 minutos"; "1h" → "de hora em hora"."""
    v = v.strip()
    especiais = {
        "1h": "de hora em hora",
        "1min": "a cada minuto",
        "24h": "uma vez por dia",
        "1d": "uma vez por dia",
    }
    if v in especiais:
        return especiais[v]
    if v.endswith("min") and v[:-3].isdigit():
        return f"a cada {v[:-3]} minutos"
    if v.endswith("h") and v[:-1].isdigit():
        return f"a cada {v[:-1]} horas"
    return f"a cada {v}"


def timer_state(unit):
    """Estado de um .timer (kind=cron/frequente). None se nao existe.

    ╔══════════════════════════════════════════════════════════════════════╗
    ║  "OK" QUER DIZER QUE RODOU E DEU CERTO. NAO QUE ESTA ARMADO.         ║
    ╚══════════════════════════════════════════════════════════════════════╝

    Ate 26/08/2026 o estado NASCIA "ok" e so saia de la se o timer estivesse
    desarmado ou se o servico-irmao tivesse falhado. Ou seja: um timer recem
    instalado, que nunca rodou uma vez na vida, aparecia verde no painel do
    cliente, e o painel abria com 100% de saude sem ter perguntado nada a
    ninguem. O alarme media EXECUCAO, e o que a pessoa le como "ok" e
    RESULTADO. Foi assim que a Isa ficou 5 h muda com o pulso todo verde.

    Agora sao quatro desfechos, e cada um diz por que:
      SEM_SINAL   o timer existe mas nao esta armado. Nao vai rodar.
      ERRO        rodou e o servico-irmao terminou mal.
      AGUARDANDO  esta armado e ainda NAO rodou nenhuma vez. Nao e defeito e
                  nao e sucesso: e uma pergunta que ainda nao tem resposta, e
                  por isso fica FORA da conta do percentual.
      OK          rodou, e a ultima vez terminou bem. Com a hora junto, porque
                  "ok" sem quando permite que uma coisa parada em maio continue
                  verde em agosto.
    """
    if not unit_exists(unit):
        return None
    multi = systemctl_show_multi(
        unit,
        ["ActiveState", "LastTriggerUSec", "NextElapseUSecRealtime",
         "TimersCalendar", "TimersMonotonic"],
    )
    def um(prop):
        vals = multi.get(prop, [])
        return vals[-1] if vals else ""

    active = um("ActiveState")
    # checa o servico-irmao (.service) pra saber COMO terminou a ultima execucao
    svc = unit[:-6] + ".service" if unit.endswith(".timer") else unit
    svc_info = systemctl_show(svc, ["Result", "ExecMainStatus", "ExecMainStartTimestamp"])
    result = svc_info.get("Result", "")

    ultima = parse_systemd_ts(um("LastTriggerUSec")) or parse_systemd_ts(
        svc_info.get("ExecMainStartTimestamp", "")
    )
    proxima = parse_systemd_ts(um("NextElapseUSecRealtime"))
    cadencia = cadencia_do_timer(multi)

    armado = active in ("active", "waiting", "")
    if not armado:
        estado, detalhe = SEM_SINAL, f"o timer nao esta armado (systemd diz \"{active}\"), entao nao vai rodar"
    elif result and result not in ("success", ""):
        quando = humano_ate(ultima)
        estado = ERRO
        detalhe = f"rodou {quando} e terminou mal (systemd diz \"{result}\")" if quando \
            else f"a ultima execucao terminou mal (systemd diz \"{result}\")"
    elif ultima is None:
        estado = AGUARDANDO
        quando = humano_ate(proxima)
        detalhe = "armado, mas ainda nao rodou nenhuma vez"
        if quando:
            detalhe += f". A primeira vez e {quando}"
    else:
        estado = OK
        detalhe = f"rodou {humano_ate(ultima)} e deu certo"
        if proxima:
            detalhe += f". A proxima e {humano_ate(proxima)}"

    return {
        "estado": estado,
        "active": active,
        "detalhe": detalhe,
        "ultima": ultima.isoformat() if ultima else "",
        "proxima": proxima.isoformat() if proxima else "",
        "cadencia": cadencia,
    }


# ─── Ledger de pulso ─────────────────────────────────────────────────────────
def read_ledger(date):
    """Le todas as linhas dos *.jsonl no PULSO_DIR e indexa o ultimo registro
    por component. Cada linha: {timestamp, component, status, detail?}.
    Retorna {component: {status, timestamp, detail}}."""
    latest = {}
    try:
        files = [f for f in os.listdir(PULSO_DIR) if f.endswith(".jsonl")]
    except Exception:
        return latest
    for fn in files:
        path = os.path.join(PULSO_DIR, fn)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    comp = obj.get("component") or obj.get("name")
                    if not comp:
                        continue
                    ts = obj.get("timestamp") or ""
                    prev = latest.get(comp)
                    if not prev or ts >= prev.get("timestamp", ""):
                        latest[comp] = {
                            "status": obj.get("status") or obj.get("estado"),
                            "timestamp": ts,
                            "detail": obj.get("detail") or obj.get("resumo") or "",
                        }
        except Exception:
            continue
    return latest


def normalize_status(s):
    if not s:
        return None
    s = str(s).lower()
    if s in (OK, "success", "completed", "done", "rodou"):
        return OK
    if s in (ERRO, "error", "fail", "failed", "faltou", "missing"):
        return ERRO
    if s in (AGUARDANDO, "running", "in_progress", "activating"):
        return AGUARDANDO
    if s in (PENDENTE, "pending", "scheduled"):
        return PENDENTE
    return SEM_SINAL


# ─── Descoberta dinamica de componentes ──────────────────────────────────────
def load_powers():
    try:
        with open(POWERS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("powers"), list):
            return data["powers"]
    except Exception:
        pass
    return []


def discover_components():
    """Monta a lista de componentes a monitorar, DINAMICAMENTE.

    Cada componente: {nome, grupo, kind, unit?, crit}.
      kind: 'servico' (continuo) | 'timer' (agendado/frequente)
      grupo: 'runtime' | 'vida' | power-id
    """
    comps = []
    seen_units = set()

    def add(nome, grupo, kind, unit=None, crit="media"):
        key = unit or nome
        if key in seen_units:
            return
        seen_units.add(key)
        comps.append({"nome": nome, "grupo": grupo, "kind": kind, "unit": unit, "crit": crit})

    # 1. Runtime do DG Claw (por convencao de nome + slug, com uma excecao declarada)
    #
    # Quem hospeda a sessao viva nem sempre e o dgclaw-<slug>.service: num agente de
    # runner proprio e o dgclaw-agent-<slug>.service, e e ele que o config.sh declara
    # em DGCLAW_SERVICE. Sem ler essa env, o pulso do cliente abria com "unidade
    # ausente" no componente mais importante da tela, enquanto o agente ia bem.
    add("canal (runtime)", "runtime", "servico",
        os.environ.get("DGCLAW_SERVICE") or f"dgclaw-{SLUG}.service", crit="alta")
    # O watchdog de canal so existe em agente com bot de Telegram. Onde ele nunca foi
    # instalado, anuncia-lo seria inventar um defeito: "sem sinal" quer dizer que
    # alguma coisa parou de responder, e nao que ela nunca existiu.
    unit_cw = f"dgclaw-{SLUG}-channel-watchdog.timer"
    if list_unit_files(unit_cw):
        add("watchdog do canal", "runtime", "timer", unit_cw, crit="alta")
    add("painel", "runtime", "servico", f"dgclaw-panel-{SLUG}.service", crit="baixa")

    # 2. Poderes habilitados → seus timers/servicos declarados
    for p in load_powers():
        if not p.get("enabled"):
            continue
        pid = p.get("id", "?")
        pname = p.get("name") or pid
        for t in (p.get("cron_timers") or []):
            unit = t if str(t).endswith(".timer") else f"{t}.timer"
            add(f"{pid}: {t}", pid, "timer", unit, crit="media")
        svc = p.get("service")
        if svc:
            unit = svc if str(svc).endswith(".service") else f"{svc}.service"
            add(f"{pname}", pid, "servico", unit, crit="media")

    # 3. Timers de vida (dgclaw-<slug>-*.timer), descobertos via systemd
    for unit in list_unit_files(f"dgclaw-{SLUG}-*.timer"):
        suffix = unit[len(f"dgclaw-{SLUG}-"):-len(".timer")]
        add(suffix, "vida", "timer", unit, crit="media")

    return comps


# ─── O que e cada processo, em portugues ─────────────────────────────────────
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  ESTE CATALOGO E A FONTE UNICA. A TELA NAO TEM COPIA DELE.               ║
# ╚══════════════════════════════════════════════════════════════════════════╝
#
# Quem abre o painel do agente e a Marta e o Paulo, e nenhum dos dois sabe
# (nem tem por que saber) o que e um "build-wm" ou um "poke-verify". Ate hoje a
# tela mostrava esses nomes crus, uma bolinha colorida e mais nada, e a unica
# forma de descobrir o que aquilo era, era perguntar pro Danilo.
#
# Cada entrada responde DUAS perguntas: o que e, e por que esta ali. A TERCEIRA
# pergunta ("de quanto em quanto tempo roda") NAO mora aqui de proposito: ela e
# lida do systemd ao vivo, em cadencia_do_timer(). Escrever o horario aqui
# criaria duas verdades, e a errada seria justamente a que aparece na tela.
#
# A chave e o sufixo da unidade (dgclaw-<slug>-<sufixo>.timer). O que nao estiver
# aqui aparece sem explicacao, e isso e melhor do que inventar uma: um texto
# generico do tipo "rotina do agente" ocuparia o lugar e ninguem nunca mais
# escreveria a explicacao de verdade.
# OS TEXTOS TÊM ACENTO DESDE 01/10/2026. Eles aparecem na aba Operações do painel
# como o NOME de cada operação ("A reflexão da noite") e no balão dela, e "A
# reflexao da noite" escrito sem til, na tela do cliente, parece erro de
# digitação de quem fez o sistema. O arquivo é UTF-8 e o Python 3 lê sem
# cerimônia; quem consome o JSON (o painel e o pulso-report) também.
CATALOGO = {
    "reflection": (
        "A reflexão da noite.",
        "Antes de dormir, o agente relê o próprio dia e escreve o que aprendeu na "
        "memória dele. É o que faz ele lembrar amanhã do que vocês combinaram hoje.",
    ),
    "audit": (
        "O conferente da reflexão.",
        "Vinte minutos depois da reflexão, confere se ela realmente aconteceu e "
        "ficou gravada. Sem ele, uma reflexão que falhou passaria em branco.",
    ),
    "build-wm": (
        "A remontagem da memória de trabalho.",
        "De manhã, junta o que ficou espalhado em várias anotações num resumo único "
        "que o agente carrega no começo de cada conversa.",
    ),
    "heartbeat": (
        "O batimento.",
        "De tempos em tempos cutuca o agente só pra ver se ele responde. É o sinal "
        "mais barato de que ele está vivo, e não só ligado.",
    ),
    "watchdog": (
        "O vigia da sessão.",
        "Olha se a sessão do agente travou com a luz acesa (o processo de pé, mas "
        "sem responder) e, se travou, reinicia ele sozinho e avisa.",
    ),
    "auto-compact": (
        "A arrumação da conversa.",
        "Quando a conversa fica longa demais pra caber na cabeça dele, pede pro "
        "próprio agente salvar o que importa e recomeçar limpo, sem perder o fio.",
    ),
    "poke-verify": (
        "O recibo dos recados.",
        "Confere se os recados automáticos (a reflexão, por exemplo) chegaram mesmo "
        "ao agente. Se algum se perdeu no caminho, manda de novo.",
    ),
    "cost-alerts": (
        "O aviso de orçamento.",
        "De hora em hora compara o gasto do mês com o teto configurado e avisa "
        "quando passa dos degraus, pra conta não chegar de surpresa no fim do mês.",
    ),
    "channels-tokens-logger": (
        "O medidor de consumo.",
        "Lê a conversa viva e anota quanto cada turno custou. É daqui que sai tudo "
        "o que você vê na aba Custos.",
    ),
    "cron-audit": (
        "O conferente das rotinas.",
        "Uma vez por noite, confere se as rotinas todas continuam instaladas e "
        "armadas. Pega o caso da rotina que sumiu sem ninguém perceber.",
    ),
    "pulso-report-1": (
        "O pulso do meio-dia.",
        "Às 13h manda pra você, no seu canal, o resumo do que rodou e do que falhou. "
        "É esta mesma tela, entregue sem você precisar vir buscar.",
    ),
    "pulso-report-2": (
        "O pulso do fim da tarde.",
        "Às 19h, o mesmo resumo, com o dia quase fechado.",
    ),
    "pulso-report-3": (
        "O pulso do fim do dia.",
        "Às 23h58, o fechamento do dia, já com a reflexão da noite contabilizada.",
    ),
    "channel-watchdog": (
        "O vigia do canal.",
        "Olha se o canal de mensagens (o bot do Telegram) continua respondendo. "
        "Só existe em agente que tem canal próprio.",
    ),
    "canal (runtime)": (
        "O agente em si.",
        "É o processo onde o agente pensa e responde. Se esta linha cai, o agente "
        "está fora do ar, e nenhuma das outras importa muito.",
    ),
    "conversas-fts": (
        "O fichário das conversas.",
        "Guarda num índice tudo o que vocês conversaram e o que está na memória dele, "
        "pra quando você perguntar 'lembra quando eu falei de...' ele achar o trecho "
        "certo. Funciona sem chave e sem internet.",
    ),
    "painel": (
        "Esta tela.",
        "O servidor que serve o painel que você está olhando agora. Se ele cair, "
        "você não estaria lendo isto.",
    ),
}


def explicar(nome):
    """(o que e, pra que serve) do processo, ou ("", "") quando nao sabemos.

    Devolver vazio e deliberado: ver o cabecalho do CATALOGO.
    """
    if nome in CATALOGO:
        return CATALOGO[nome]
    # "instagram: publicar" → tenta pelo sufixo depois dos dois pontos
    if ":" in nome:
        cauda = nome.split(":", 1)[1].strip()
        if cauda in CATALOGO:
            return CATALOGO[cauda]
    return ("", "")


def resolve_state(comp, ledger):
    """Decide o estado final do componente: ledger tem prioridade; senao systemd."""
    nome = comp["nome"]
    unit = comp.get("unit")

    vazio = {"detalhe": "", "ultima": "", "proxima": "", "cadencia": ""}

    # a) ledger (por nome ou por unidade)
    led = ledger.get(nome) or (ledger.get(unit) if unit else None)
    if led:
        st = normalize_status(led.get("status"))
        if st:
            extra = dict(vazio)
            extra["detalhe"] = led.get("detail") or ""
            extra["ultima"] = led.get("timestamp") or ""
            return st, extra

    # b) systemd
    if unit:
        s = service_state(unit) if comp["kind"] == "servico" else timer_state(unit)
        if s:
            return s["estado"], s
        # Unidade que nao existe NAO e a mesma coisa que unidade parada, e a frase
        # precisa dizer qual das duas, senao quem le vai procurar defeito no lugar
        # errado. Aqui o systemd nunca ouviu falar deste nome.
        return SEM_SINAL, dict(
            vazio,
            detalhe=f"o systemd nao conhece a unidade \"{unit}\". "
                    "Ou ela nunca foi instalada, ou foi instalada com outro nome.",
        )

    return SEM_SINAL, dict(vazio, detalhe="nao ha unidade systemd para consultar")


# ─── Montagem do relatorio ───────────────────────────────────────────────────
def build_report(date):
    ledger = read_ledger(date)
    comps = discover_components()

    counts = {OK: 0, ERRO: 0, AGUARDANDO: 0, PENDENTE: 0, SEM_SINAL: 0}
    processos = []
    for c in comps:
        estado, extra = resolve_state(c, ledger)
        counts[estado] = counts.get(estado, 0) + 1
        oque, praque = explicar(c["nome"])
        processos.append({
            "nome": c["nome"],
            "dono": c["grupo"],
            "grupo": c["grupo"],
            "kind": c["kind"],
            "unit": c.get("unit"),
            "crit": c["crit"],
            "resumo": estado,
            "detail": extra.get("detalhe", ""),
            "lastRun": extra.get("ultima", ""),
            "proxima": extra.get("proxima", ""),
            "cadencia": extra.get("cadencia", ""),
            "oQueE": oque,
            "praQueServe": praque,
        })

    # O PERCENTUAL CONTA SO QUEM JA RODOU.
    #
    # "aguardando" (armado e ainda nao rodou nenhuma vez) fica fora das DUAS
    # pontas da fracao, e nao no numerador como um sucesso. Um agente instalado
    # ha dez minutos nao esta 100% saudavel nem 0%: ele nao foi medido ainda, e
    # dizer 100% ali e a mentira que esta tela existe pra nao contar. Conforme os
    # timers vao rodando pela primeira vez, eles entram na conta sozinhos.
    #
    # E COM NADA MEDIDO O PERCENTUAL E None, NAO 100. Um agente onde nenhuma peca
    # rodou ainda nao esta com saude perfeita: ele esta sem diagnostico. O painel
    # ja sabe desenhar "--" nesse caso, e "--" e a resposta honesta.
    decididos = counts[OK] + counts[ERRO]
    pct = round(100 * counts[OK] / decididos) if decididos else None

    return {
        "slug": SLUG,
        "date": date,
        "now": now_local().strftime("%H:%M"),
        "counts": counts,
        "pct": pct,
        "total": len(processos),
        "processos": processos,
    }


# ─── CLI ─────────────────────────────────────────────────────────────────────
def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    date = today_str()
    for a in args:
        if a.startswith("--date="):
            d = a.split("=", 1)[1]
            if len(d) == 10 and d[4] == "-" and d[7] == "-":
                date = d

    report = build_report(date)

    if as_json:
        print(json.dumps(report, ensure_ascii=False))
        return 0

    c = report["counts"]
    print(f"== PULSO {report['slug']} — {report['date']} {report['now']} ==")
    saude = f"{report['pct']}%" if report["pct"] is not None else "sem medida ainda"
    print(f"  saude: {saude} ({c[OK]} ok / {c[ERRO]} erro / "
          f"{c[AGUARDANDO]} aguardando / {c[PENDENTE]} pendente / {c[SEM_SINAL]} sem-sinal)")
    grupos = {}
    for p in report["processos"]:
        grupos.setdefault(p["grupo"], []).append(p)
    for g, procs in grupos.items():
        print(f"  [{g}]")
        for p in procs:
            cad = f" [{p['cadencia']}]" if p.get("cadencia") else ""
            print(f"    {p['resumo']:<11} {p['nome']}{cad}")
            if p.get("detail"):
                print(f"                {p['detail']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # Nunca estoura: emite JSON de erro se pediram --json, senao mensagem.
        if "--json" in sys.argv:
            print(json.dumps({
                "error": str(e), "counts": {OK: 0, ERRO: 0, AGUARDANDO: 0,
                "pendente": 0, "sem-sinal": 0}, "pct": None,
                "processos": [], "total": 0, "now": "", "date": today_str(),
            }, ensure_ascii=False))
            sys.exit(0)
        print(f"pulso-status falhou: {e}", file=sys.stderr)
        sys.exit(1)
