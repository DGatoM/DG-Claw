#!/usr/bin/env python3
"""watchdog.py (DG Claw) — Vigia da SESSAO VIVA do agente (a sessao --channels que serve
o bot Telegram e onde os crons de vida injetam seus pokes).

A sessao alvo e a do DG Claw: o processo `claude --channels --name dgclaw-<slug>` (User=root),
subido pelo servico `dgclaw-<slug>.service` e reiniciavel por `systemctl restart dgclaw-<slug>.service`.

Duas coberturas, ambas com o MESMO cap anti-storm:

  1) LIVENESS — a sessao do canal esta MORTA? (reusa _lib/inject.is_session_alive, que checa
     o /dev/pts do processo claude --channels real; NAO reimplementamos a deteccao aqui).
       - service ENABLED (autostart, dono quer o bot 24/7) -> `systemctl restart` + notifica dono.
       - service DISABLED (dono desligou de proposito pra poupar) -> NAO reinicia: loga e sai 0.

  2) TURNO TRAVADO — aqui NAO existe `tmux capture-pane` (a sessao roda sob `script -qfec`, nao
     tmux), entao a heuristica e por mtime/ultima atividade do transcript .jsonl em
     DGCLAW_SESSION_DIR. Se a sessao esta VIVA mas o transcript nao recebe atividade ha mais de
     DGCLAW_STUCK_MIN (default 25) min E houve um POKE recente (a sessao deveria estar
     processando algo) -> consideramos o turno travado/deadlock -> restart (mesmo cap) + notifica.
     Sem o gate de "poke recente", uma sessao legitimamente ociosa (ninguem falou com ela ha
     horas) seria reiniciada a toa — por isso so reiniciamos travamento quando havia trabalho
     pendente em voo.

  3) A RESPOSTA (01/10/2026): o processo de pe nao prova que ele responde. A Isa ficou
     muda 56 min por um corte do filtro de seguranca da Anthropic, e dois agentes entregues
     ficaram uma semana mudos por login vencido, com este vigia dizendo "VIVA e saudavel"
     ~1.500 vezes. Agora cada rodada pergunta ao _lib/saude_sessao.py como foi o ULTIMO
     TURNO e age conforme o tipo:
       recusa / contexto -> MODO DE SEGURANCA automatico (_lib/reinicio.py): sessao nova sem
                            a conversa que travou. Uma vez por incidente, cooldown proprio de
                            DGCLAW_WATCHDOG_SEGURO_COOLDOWN_MIN (60), e dentro do mesmo cap
                            anti-storm dos restarts. NUNCA restart de systemd aqui: no runner
                            ele sobe `claude --resume` e o veneno volta junto.
       login             -> so avisa o dono, 1 vez por incidente. Reiniciar nao resolve.
       limite/sobrecarga/erro_api -> nao reinicia (reiniciar zera o cache e piora); avisa 1
                            vez se passar de 30 min.
       sem_resposta      -> restart normal (o de sempre, com o mesmo cap).
     O diagnostico vai para <ws>/.dgclaw/logs/saude.json (o painel e o doctor leem) e para o
     ledger do Pulso com id `saude`.

  ONDE O RESTART ACONTECE: no mundo bunker (card do Bunker ou runner proprio, que e o caso
  da jaula) o restart e por HTTP (_lib/reinicio.py: parar + /resume), e nao systemctl. O
  watchdog da jaula roda como usuario comum e cada `systemctl restart` falhava (119 vezes
  num agente ate 01/10), com o aviso caindo no vazio. Fora do bunker, `systemctl` com
  `sudo -n` quando nao e root. Restart que falha agora sai com rc 1 e grava `erro` no Pulso.

SEGURANCA ANTI-STORM (inegociavel): NUNCA um loop de restart. Backoff + cap de N restarts por
janela deslizante (default 3 / 60 min), persistido em <ws>/.dgclaw/logs/.watchdog-state.json
(mesmo nome que o doctor.sh checa).
Estourou o cap -> NAO reinicia: notifica o dono 1x (dedup) pedindo olho manual e sai 0.

Tudo parametrizado por env do contrato DG Claw. ZERO hardcode de persona/paths/dados pessoais.
Notificacao SEMPRE via scripts/notify-owner.sh (bot do dono, sem markdown).

Env:
  DGCLAW_WORKSPACE      (obrigatorio na pratica) raiz do workspace da persona.
  DGCLAW_SLUG           (opcional)  slug da persona. Default: basename(workspace) ou "agente".
                            Compoe o service alvo: dgclaw-<slug>.service.
  DGCLAW_CHANNEL_NAME   (opcional)  override do --name alvo (default: dgclaw-<slug>).
  DGCLAW_SERVICE        (opcional)  override do nome do service (default: dgclaw-<slug>.service).
  DGCLAW_SESSION_DIR    (opcional)  dir dos transcripts .jsonl (heuristica de travamento).
                            Default: ~/.claude/projects/<workspace com '/' -> '-'>.
  DGCLAW_LOGS_DIR       (opcional)  dir de logs/state. Default: <ws>/.dgclaw/logs.
  DGCLAW_STUCK_MIN      (opcional)  min sem atividade no transcript p/ considerar travado. Default 25.
  DGCLAW_AUTO_RECOVERY  (opcional)  on|off — opt-in do auto-recovery (default on). Com off,
                            o watchdog vira NO-OP de acao: so observa/loga e NUNCA reinicia o
                            servico sozinho (o dono desligou a auto-recuperacao de proposito).
  DGCLAW_WATCHDOG_MAX_RESTARTS (opcional) cap de restarts na janela. Default 3.
  DGCLAW_WATCHDOG_WINDOW_MIN   (opcional) janela do cap, em min. Default 60.
  DGCLAW_WATCHDOG_POKE_GRACE_MIN (opcional) "poke recente" = poke ha <= isso min. Default 30.
  DGCLAW_OWNER_TELEGRAM_ID / TELEGRAM_STATE_DIR  consumidos por notify-owner.sh.

Cron sugerido: */5 * * * *  (timer systemd a cada ~5min).
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Reusa a deteccao de vida da sessao do _lib (NAO reimplementar).
sys.path.insert(0, str(Path(__file__).resolve().parent / "_lib"))
import inject  # noqa: E402  (is_session_alive, channel_name)
import saude_sessao  # noqa: E402  (como foi o ultimo turno)
import reinicio  # noqa: E402  (restart normal e modo de seguranca, nos tres mundos)
from pulso_lib import pulso_write  # noqa: E402

# Falhas desta rodada. Qualquer uma faz o watchdog sair com rc 1: restart que falhou ou
# aviso que nao chegou NAO e "rodou bem" (antes saia 0 em tudo, e o Pulso ficava verde).
FALHAS = []


# ─── resolucao de env (contrato DG Claw) ─────────────────────────────────────

def env(name, default=""):
    return os.environ.get(name, default)


def resolve_workspace() -> Path:
    return Path(env("DGCLAW_WORKSPACE") or os.getcwd()).resolve()


def resolve_slug(workspace: Path) -> str:
    return env("DGCLAW_SLUG") or workspace.name or "agente"


def resolve_service(slug: str) -> str:
    return env("DGCLAW_SERVICE") or f"dgclaw-{slug}.service"


def resolve_session_dir(workspace: Path) -> Path:
    override = env("DGCLAW_SESSION_DIR")
    if override:
        return Path(override).resolve()
    encoded = str(workspace).replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded


def resolve_logs_dir(workspace: Path) -> Path:
    override = env("DGCLAW_LOGS_DIR") or env("DGCLAW_LOG_DIR")
    if override:
        return Path(override).resolve()
    return workspace / ".dgclaw" / "logs"


def env_int(name, default: int) -> int:
    try:
        return int(env(name) or default)
    except (TypeError, ValueError):
        return default


# ─── notificacao (SEMPRE via notify-owner.sh) ─────────────────────────────────

def notify_owner(msg: str) -> bool:
    """Avisa o dono. Devolve True SO se o notify-owner disse que entregou (rc 0). Aviso
    que nao chegou entra em FALHAS: o dono nao saber de nada e o defeito, nao um detalhe."""
    no = Path(__file__).resolve().parent / "notify-owner.sh"
    if not no.exists():
        FALHAS.append(f"aviso ao dono NAO saiu: notify-owner.sh ausente em {no}")
        sys.stderr.write(f"[watchdog] {FALHAS[-1]}\n")
        return False
    try:
        r = subprocess.run(["bash", str(no), msg], timeout=60, capture_output=True, text=True)
    except Exception as e:
        FALHAS.append(f"aviso ao dono NAO saiu: {e}")
        sys.stderr.write(f"[watchdog] {FALHAS[-1]}\n")
        return False
    if r.returncode != 0:
        motivo = (r.stderr or r.stdout or "").strip().replace("\n", " | ")[:300]
        FALHAS.append(f"aviso ao dono NAO saiu (notify-owner rc {r.returncode}): {motivo}")
        sys.stderr.write(f"[watchdog] {FALHAS[-1]}\n")
        return False
    return True


# ─── estado anti-storm ────────────────────────────────────────────────────────

def load_state(state_path: Path) -> dict:
    try:
        return json.loads(state_path.read_text())
    except Exception:
        return {}


def save_state(state_path: Path, state: dict) -> None:
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        # escrita atomica: tmp+replace. Um state corrompido zeraria o historico de restarts
        # (load_state -> {}) e derrubaria o cap anti-storm — entao nunca deixamos meio-escrito.
        tmp = state_path.with_suffix(state_path.suffix + ".tmp")
        tmp.write_text(json.dumps(state, indent=2))
        tmp.replace(state_path)
    except Exception as e:
        sys.stderr.write(f"[watchdog] falha ao salvar state: {e}\n")


def recent_restarts(state: dict, now: datetime, window_min: int) -> list:
    """Timestamps (ISO) de restarts dentro da janela deslizante. Poda os antigos.

    `now`/`cutoff` sao tz-aware (UTC). Um timestamp NAIVE no state (gravado por uma versao
    antiga ou outro caminho) faria `fromisoformat(ts) >= cutoff` levantar TypeError, que era
    engolido pelo except -> o restart SUMIA da contagem e o cap anti-storm afrouxava. Por isso
    normalizamos pra aware-UTC (assume UTC quando naive) antes de comparar."""
    cutoff = now - timedelta(minutes=window_min)
    kept = []
    for ts in state.get("restarts", []):
        try:
            dt = datetime.fromisoformat(ts)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt >= cutoff:
                kept.append(ts)
        except Exception:
            continue
    return kept


# ─── service state ────────────────────────────────────────────────────────────

def service_is_enabled(service: str) -> bool:
    """True se o service esta habilitado p/ autostart (dono quer o bot 24/7).
    `systemctl is-enabled` retorna rc 0 quando enabled; qualquer outra coisa (disabled,
    static, masked, not-found) tratamos como NAO-autostart -> watchdog nao reinicia."""
    r = subprocess.run(["systemctl", "is-enabled", service],
                       capture_output=True, text=True)
    return r.returncode == 0 and r.stdout.strip() == "enabled"


def do_restart(service: str):
    """Restart NORMAL (a mesma conversa onde isso existe). Devolve (ok, motivo).
    Mundo bunker: por HTTP, pelo _lib/reinicio.py (parar + /resume); nada de systemctl,
    que na jaula nem tem permissao. Fora dele: systemctl, com sudo -n se nao for root."""
    if inject.resolve_mode() == "bunker":
        r = reinicio.reiniciar_normal("watchdog: sessao caida ou travada", origem="watchdog")
        return bool(r.get("ok")), r.get("motivo") or ""
    return reinicio._systemctl("restart", service)


# ─── heuristica de turno travado (sem tmux capture-pane) ──────────────────────

def latest_transcript_mtime(session_dir: Path):
    """mtime (epoch float) do .jsonl mais recente do dir de transcripts da sessao, ou None.
    Substitui o `capture-pane` (que nao existe aqui) como sinal de 'a sessao esta viva e
    processando': enquanto ha turno em andamento, o transcript recebe writes."""
    try:
        jsonls = list(session_dir.glob("*.jsonl"))
    except Exception:
        return None
    if not jsonls:
        return None
    try:
        return max(p.stat().st_mtime for p in jsonls)
    except Exception:
        return None


def latest_poke_mtime(slug: str) -> float | None:
    """mtime do poke file mais recente DESTE agente em /tmp (dgclaw-poke-<slug>-*). Os crons
    (heartbeat/reflection/auditoria) escrevem esses arquivos antes de injetar. Um poke recente =
    havia trabalho em voo, entao silencio prolongado do transcript = turno travado (e nao
    ociosidade legitima). Usamos mtime do arquivo, nao o conteudo (zero dado pessoal lido).

    ESCOPADO POR SLUG: num host multi-agente, o poke de OUTRO agente nao pode contar como
    "trabalho em voo" deste — senao o watchdog de A enxerga o poke de B e reinicia A por engano.
    O contrato de nome dos pokes (inject.sh) e dgclaw-poke-<slug>-<tag>-<stamp>.txt."""
    if not slug:
        return None
    try:
        pokes = list(Path("/tmp").glob(f"dgclaw-poke-{slug}-*"))
    except Exception:
        return None
    if not pokes:
        return None
    try:
        return max(p.stat().st_mtime for p in pokes)
    except Exception:
        return None


# ─── auto-recovery OFF: so observa, nunca reinicia (dedup por episodio) ────────

def observe_only(service, reason, state, state_path) -> str:
    """DGCLAW_AUTO_RECOVERY=off: o dono desligou a auto-recuperacao de proposito. NAO
    reiniciamos — so logamos e avisamos o dono UMA vez por episodio (dedup via flag
    'warned_off'), igual ao watchdog.sh aposentado. A flag e rearmada quando a sessao volta."""
    if not state.get("warned_off"):
        notify_owner(
            f"⚠️ Watchdog DG Claw: a sessao viva {reason}, mas o auto-recovery esta DESLIGADO "
            f"(DGCLAW_AUTO_RECOVERY=off), entao NAO vou reiniciar sozinho. Reinicie pelo botao "
            f"Reiniciar do painel (ou rode /dgclaw:doctor --fix)."
        )
        state["warned_off"] = True
        save_state(state_path, state)
    return f"auto-recovery=off — so observei ({reason}), sem restart"


# ─── acao de restart com cap ──────────────────────────────────────────────────

def attempt_restart(service, reason, state, state_path, now, max_restarts, window_min) -> str:
    """Aplica o cap anti-storm e, se houver folga, reinicia. Retorna o veredito (string p/ log).
    NUNCA loopa: estourou o cap -> notifica 1x (dedup) e sai sem reiniciar."""
    recents = recent_restarts(state, now, window_min)
    state["restarts"] = recents  # state ja podado

    if len(recents) >= max_restarts:
        # Cap estourado: NAO reinicia. Notifica o dono 1x por estouro (dedup por flag).
        if not state.get("storm_notified"):
            notify_owner(
                f"🚨 Watchdog DG Claw: a sessao viva caiu/travou de novo, mas ja reiniciei "
                f"{len(recents)}x na ultima ~{window_min}min (cap atingido). NAO vou ficar "
                f"reiniciando em loop. Precisa de olho manual (servico: {service})."
            )
            state["storm_notified"] = True
            save_state(state_path, state)
        return f"cap atingido ({len(recents)}/{max_restarts} em {window_min}min) — NAO reiniciei"

    ok, erro = do_restart(service)
    state.setdefault("restarts", []).append(now.isoformat())
    state["storm_notified"] = False  # tem folga de novo -> rearma o aviso de storm
    save_state(state_path, state)

    if ok:
        notify_owner(
            f"🔧 Watchdog DG Claw: a sessao viva {reason} — reiniciei {service} "
            f"automaticamente ({len(state['restarts'])}/{max_restarts} na janela de {window_min}min). "
            f"Se voce mandou msg e nao respondeu, reenvia."
        )
        return f"reiniciei ({reason}) — {len(state['restarts'])}/{max_restarts}"
    FALHAS.append(f"restart FALHOU ({reason}): {erro}")
    notify_owner(
        f"🚨 Watchdog DG Claw: a sessao viva {reason} e o reinicio automatico FALHOU "
        f"({erro[:160]}). Precisa de olho manual."
    )
    return f"restart FALHOU ({reason}): {erro}"


# ─── a RESPOSTA: como foi o ultimo turno (saude_sessao) ──────────────────────

def ultimo_turno_epoch(slug: str):
    """Epoch do ultimo turno REAL (user/assistant) da sessao viva, ou None.

    Substitui o mtime do diretorio como sinal de atividade (vistoria P1-1): o Claude
    anexa ao .jsonl linhas que nao sao turno (bridge-session, frame-link, fila), e um
    agente mudo havia uma semana aparecia "idle=3min"."""
    caminho = inject.live_transcript(slug)
    if not caminho:
        return None
    try:
        regs, _ = saude_sessao.ler_cauda(caminho, 200 * 1024)
    except OSError as e:
        sys.stderr.write(f"[watchdog] nao consegui ler {caminho}: {e}\n")
        return None
    for o in reversed(regs):
        if o.get("type") in ("user", "assistant"):
            dt = saude_sessao._ts(o)
            if dt:
                return dt.timestamp()
    return None


def gravar_saude(logs_dir: Path, diag: dict, acao: str, now) -> None:
    """<ws>/.dgclaw/logs/saude.json: o ultimo diagnostico, com o que o watchdog fez.
    O painel e o doctor leem daqui tambem. Escrita atomica (tmp + replace)."""
    try:
        logs_dir.mkdir(parents=True, exist_ok=True)
        tmp = logs_dir / "saude.json.tmp"
        tmp.write_text(json.dumps(dict(diag, watchdogEm=now.isoformat(), acaoDoWatchdog=acao),
                                  ensure_ascii=False, indent=2))
        tmp.replace(logs_dir / "saude.json")
    except OSError as e:
        FALHAS.append(f"nao consegui gravar saude.json em {logs_dir}: {e}")


def _avisar_uma_vez(state, state_path, chave, msg) -> str:
    """Avisa o dono so uma vez por incidente. A chave so e gravada se o aviso CHEGOU:
    aviso que falhou e tentado de novo na proxima rodada, em vez de dar por avisado.
    Devolve "avisei", "ja avisado" ou "aviso NAO saiu", para o veredito do log dizer
    o que de fato aconteceu."""
    if state.get("saude_avisado") == chave:
        return "ja avisado"
    if notify_owner(msg):
        state["saude_avisado"] = chave
        save_state(state_path, state)
        return "avisei"
    return "aviso NAO saiu"


def cuidar_da_saude(diag, ctx):
    """Age conforme o tipo do diagnostico. Devolve (tratado, veredito). tratado=True quer
    dizer "ja decidi, nao siga para as heuristicas de restart": para login, limite e
    sobrecarga, reiniciar e o ERRADO, e as heuristicas antigas reiniciariam."""
    state, state_path, now = ctx["state"], ctx["state_path"], ctx["now"]
    tipo, estado = diag.get("tipo"), diag.get("estado")
    nome = env("DGCLAW_NAME") or ctx["slug"]
    incidente = f"{tipo}:{diag.get('sessionId')}:{diag.get('desde')}"
    trecho = (diag.get("trecho") or "")[:160]

    veneno = (tipo in ("recusa", "contexto") and estado == "inativo") or \
             (tipo == "sessao_caida" and diag.get("recomendacao") == "modo_seguro")
    if veneno:
        if ctx["auto_recovery"] == "off":
            _avisar_uma_vez(state, state_path, incidente,
                            f"🛟 {nome} parou de responder: {diag.get('frase')} O auto-recovery esta "
                            f"desligado, entao NAO reiniciei. No painel, use Reiniciar em modo de seguranca.")
            return True, f"{tipo}: auto-recovery=off, so avisei"
        if state.get("seguro_incidente") == incidente:
            _avisar_uma_vez(state, state_path, "nao-resolveu:" + incidente,
                            f"🚨 {nome} continua travado depois do reinicio automatico em modo de "
                            f"seguranca ({diag.get('frase')}). Nao vou tentar de novo sozinho: "
                            f"precisa de olho humano. Trecho: {trecho}")
            return True, f"{tipo}: modo de seguranca ja rodou neste incidente, nao repito"
        cooldown = env_int("DGCLAW_WATCHDOG_SEGURO_COOLDOWN_MIN", 60)
        ultimo = state.get("seguro_em")
        if ultimo:
            try:
                idade = (now - datetime.fromisoformat(ultimo)).total_seconds() / 60
            except ValueError:
                idade = cooldown + 1
            if idade < cooldown:
                return True, f"{tipo}: modo de seguranca em cooldown ({int(cooldown - idade)} min restantes)"
        recents = recent_restarts(state, now, ctx["window_min"])
        if len(recents) >= ctx["max_restarts"]:
            return True, attempt_restart(ctx["service"], f"travou ({tipo})", state, state_path, now,
                                         ctx["max_restarts"], ctx["window_min"])
        r = reinicio.reiniciar_seguro(f"{diag.get('frase')}", origem="watchdog")
        state["seguro_incidente"] = incidente
        state["seguro_em"] = now.isoformat()
        state.setdefault("restarts", []).append(now.isoformat())
        save_state(state_path, state)
        if not r.get("ok"):
            FALHAS.append(f"modo de seguranca automatico FALHOU: {r.get('motivo')}")
            notify_owner(f"🚨 {nome} travou ({diag.get('frase')}) e o reinicio automatico em modo de "
                         f"seguranca FALHOU: {r.get('motivo')}. Precisa de olho humano.")
            return True, f"{tipo}: modo de seguranca FALHOU: {r.get('motivo')}"
        notify_owner(f"🛟 {nome} travou ({diag.get('frase')}) e eu o reiniciei em modo de seguranca: "
                     f"ele volta sem carregar a conversa que travou. "
                     + ("Ele mesmo deve te mandar uma mensagem em instantes." if r.get("recadoEntregue")
                        else "Mande uma mensagem simples para ele, tipo \"oi, o que houve?\"."))
        return True, f"{tipo}: reiniciei em MODO DE SEGURANCA (recado entregue={r.get('recadoEntregue')})"

    if tipo == "login":
        aviso = _avisar_uma_vez(state, state_path, incidente,
                        f"🔑 {nome} esta sem login na Anthropic e nao consegue responder ({trecho}). "
                        f"Reiniciar nao resolve: quem cuida do sistema precisa refazer o login da conta "
                        f"deste agente.")
        return True, f"login: {aviso} (1 aviso por incidente), sem reiniciar"

    if tipo in ("limite", "sobrecarga", "erro_api") and estado in ("atencao", "inativo"):
        persiste = env_int("DGCLAW_SAUDE_PERSISTE_MIN", 30)
        desde = saude_sessao._ts({"timestamp": diag.get("desde")}) if diag.get("desde") else None
        dur = (now - desde).total_seconds() / 60 if desde else 0
        if dur > persiste:
            aviso = _avisar_uma_vez(state, state_path, incidente,
                            f"⏳ {nome} nao consegue responder ha {int(dur)} min: {diag.get('frase')} "
                            f"{diag.get('comoResolver')}")
            return True, f"{tipo}: ha {int(dur)} min, {aviso} (sem reiniciar)"
        return True, f"{tipo}: ha {int(dur)} min, esperando (reiniciar pioraria)"

    if tipo == "sem_resposta" and ctx["alive"]:
        if ctx["auto_recovery"] == "off":
            return True, observe_only(ctx["service"], "deixou mensagem do dono sem resposta", state, state_path)
        return True, attempt_restart(ctx["service"], "deixou mensagem do dono sem resposta ha mais de "
                                     f"{env_int('DGCLAW_SAUDE_SEM_RESPOSTA_MIN', 10)} min",
                                     state, state_path, now, ctx["max_restarts"], ctx["window_min"])
    return False, ""


# ─── main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    """Uma rodada. rc 1 quando alguma acao FALHOU (restart, aviso ao dono, gravar a saude),
    e o motivo vai para o Pulso: um watchdog que falha calado e o mesmo que nenhum."""
    try:
        detalhe = rodada()
    except Exception as e:  # noqa: BLE001
        FALHAS.append(f"{type(e).__name__}: {e}")
        detalhe = ""
    if FALHAS:
        pulso_write("watchdog", "erro", "; ".join(FALHAS)[:480])
        for f in FALHAS:
            sys.stderr.write(f"[watchdog] FALHA: {f}\n")
        return 1
    pulso_write("watchdog", "ok", detalhe[:480])
    return 0


def rodada() -> str:
    ws = resolve_workspace()
    slug = resolve_slug(ws)
    service = resolve_service(slug)
    name = inject.channel_name(slug)
    session_dir = resolve_session_dir(ws)
    logs_dir = resolve_logs_dir(ws)
    # Nome do state file ALINHADO com watchdog.sh e doctor.sh (.watchdog-state.json, com ponto).
    # Se divergir, o doctor checa um arquivo e o watchdog grava outro -> o backoff "some" do
    # diagnostico e ninguem percebe um restart-storm sendo (mal) contido.
    state_path = logs_dir / ".watchdog-state.json"
    log_path = logs_dir / "watchdog.log"

    # OPT-IN do auto-recovery (mesmo flag do .sh aposentado): off = so observa, nunca reinicia.
    auto_recovery = (env("DGCLAW_AUTO_RECOVERY", "on") or "on").lower()
    stuck_min = env_int("DGCLAW_STUCK_MIN", 25)
    max_restarts = env_int("DGCLAW_WATCHDOG_MAX_RESTARTS", 3)
    window_min = env_int("DGCLAW_WATCHDOG_WINDOW_MIN", 60)
    poke_grace_min = env_int("DGCLAW_WATCHDOG_POKE_GRACE_MIN", 30)

    now = datetime.now(timezone.utc)
    state = load_state(state_path)

    def log(line: str) -> None:
        msg = f"[{now.astimezone().strftime('%Y-%m-%dT%H:%M:%S%z')}] {line}"
        try:
            logs_dir.mkdir(parents=True, exist_ok=True)
            with log_path.open("a") as f:
                f.write(msg + "\n")
        except Exception:
            pass
        print(msg, flush=True)

    enabled = service_is_enabled(service)
    alive = inject.is_session_alive(slug, name)

    # ── 0) A RESPOSTA: o ultimo turno foi normal? ──
    try:
        diag, _interno = saude_sessao.diagnosticar(slug)
    except Exception as e:  # noqa: BLE001
        FALHAS.append(f"o diagnostico de saude quebrou: {type(e).__name__}: {e}")
        diag = {"estado": "indeterminado", "tipo": "desconhecido",
                "frase": f"o watchdog nao conseguiu medir ({e})"}
    estado_pulso = {"ativo": "ok", "inativo": "erro"}.get(diag.get("estado"), "aviso")
    pulso_write("saude", estado_pulso, f"{diag.get('estado')}/{diag.get('tipo')}: {diag.get('frase')}"
                + (f" | {diag.get('trecho')}" if diag.get("trecho") else ""))

    # Modo de seguranca que ja cumpriu o papel: 24 h com ele respondendo normal, encerra.
    marca = reinicio.ler_marca()
    if marca and marca.get("ativo") and diag.get("estado") == "ativo":
        try:
            ativado = datetime.fromisoformat(str(marca.get("ativadoEm")).replace("Z", "+00:00"))
            if (now - ativado).total_seconds() > env_int("DGCLAW_MODO_SEGURO_EXPIRA_H", 24) * 3600:
                reinicio.encerrar_modo_seguro("24 h respondendo normalmente depois do modo de seguranca")
                log("modo de seguranca encerrado: 24 h com ele respondendo normalmente")
        except ValueError as e:
            log(f"modo-seguro.json com ativadoEm ilegivel ({e}); deixei como esta")

    ctx = {"state": state, "state_path": state_path, "now": now, "slug": slug, "service": service,
           "auto_recovery": auto_recovery, "max_restarts": max_restarts, "window_min": window_min,
           "alive": alive}
    if diag.get("estado") == "ativo" and state.get("saude_avisado"):
        state.pop("saude_avisado", None)  # voltou ao normal: o proximo incidente avisa de novo
        save_state(state_path, state)
    tratado, verdict = cuidar_da_saude(diag, ctx)
    gravar_saude(logs_dir, diag, verdict or "nenhuma (seguiu para as checagens de vida)", now)
    if tratado:
        log(f"saude: {diag.get('estado')}/{diag.get('tipo')} -> {verdict}")
        return verdict

    # ── 1) LIVENESS ──
    if not alive:
        if not enabled:
            # Dono desligou o bot de proposito (service disabled) -> respeitamos: no-op gracioso.
            log(f"sessao '{name}' MORTA mas {service} DISABLED (stop intencional do dono) — sem acao")
            return "sem acao"
        if auto_recovery == "off":
            verdict = observe_only(service, "estava MORTA (canal fora do ar)", state, state_path)
            log(f"sessao '{name}' MORTA, {service} ENABLED, mas auto-recovery=off -> {verdict}")
            return verdict
        verdict = attempt_restart(service, "estava MORTA (canal fora do ar)",
                                  state, state_path, now, max_restarts, window_min)
        log(f"sessao '{name}' MORTA, {service} ENABLED -> {verdict}")
        return verdict

    # ── 2) TURNO TRAVADO (sessao viva, mas transcript parado apos um poke recente) ──
    # Sessao viva e saudavel -> rearma o aviso de storm E o de auto-recovery=off (normalizou).
    if state.get("storm_notified") or state.get("warned_off"):
        state["storm_notified"] = False
        state["warned_off"] = False
        save_state(state_path, state)

    # O ultimo TURNO real, e nao o mtime do arquivo (linhas que nao sao turno renovam o
    # mtime). Sem turno legivel, cai no mtime de antes, que e melhor que nada.
    t_mtime = ultimo_turno_epoch(slug) or latest_transcript_mtime(session_dir)
    p_mtime = latest_poke_mtime(slug)
    now_epoch = time.time()

    if t_mtime is None:
        log(f"sessao '{name}' VIVA; sem transcript em {session_dir} — sem heuristica de travamento")
        return "ok"

    idle_min = (now_epoch - t_mtime) / 60.0
    poke_age_min = (now_epoch - p_mtime) / 60.0 if p_mtime is not None else None

    # Poke anterior ao ULTIMO RESTART nao conta como "trabalho em voo": o restart matou o
    # processo que ia processa-lo (keystroke perdido), mas o poke file segue em /tmp — sem
    # este gate o watchdog reinicia DE NOVO por causa do MESMO poke morto, em loop, ate
    # estourar o cap (storm de 01-03/07/2026: dezenas de episodios de 3 restarts + 🚨).
    last_restart_epoch = 0.0
    for ts in state.get("restarts", []):
        try:
            last_restart_epoch = max(last_restart_epoch, datetime.fromisoformat(ts).timestamp())
        except Exception:
            continue
    poke_valido = p_mtime is not None and p_mtime > last_restart_epoch

    # Sinal de travamento correto = transcript MUDO DESDE o poke, apos uma carencia de
    # processamento. (Antes: `idle > stuck_min` com o idle vindo de HORAS de ociosidade
    # legitima pre-poke declarava TRAVADA 2min depois do poke, sem dar tempo do turno rodar.)
    poke_min_age_min = env_int("DGCLAW_WATCHDOG_POKE_MIN_AGE_MIN", 10)
    poke_recent = poke_valido and poke_age_min <= poke_grace_min
    poke_maduro = poke_recent and poke_age_min >= poke_min_age_min
    transcript_mudo_desde_poke = poke_valido and t_mtime < p_mtime

    if poke_maduro and transcript_mudo_desde_poke:
        reason = (f"parecia TRAVADA (transcript sem atividade desde o poke de ha "
                  f"~{int(poke_age_min)}min; idle total ~{int(idle_min)}min)")
        if auto_recovery == "off":
            verdict = observe_only(service, reason, state, state_path)
        else:
            verdict = attempt_restart(service, reason, state, state_path, now,
                                      max_restarts, window_min)
        log(f"sessao '{name}' VIVA mas TRAVADA (transcript mudo desde poke ha "
            f"{int(poke_age_min)}min, carencia {poke_min_age_min}min) -> {verdict}")
        return verdict

    log(f"sessao '{name}' VIVA e saudavel (idle={int(idle_min)}min, "
        f"poke_valido={poke_valido}, poke_recente={poke_recent}) — sem acao")
    return f"viva e saudavel ({diag.get('estado')}/{diag.get('tipo')})"


if __name__ == "__main__":
    sys.exit(main())
