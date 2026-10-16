#!/usr/bin/env python3
"""inject.py — Injeta uma linha no stdin da sessao --channels VIVA de um agente DG Claw.

A sessao viva e a MESMA que serve o bot Telegram (claude --channels ... --name dgclaw-<slug>,
subida pelo dgclaw-<slug>.service do DG Claw, dentro de `script -qfec`). Injetar nela faz a
reflexao/auditoria/proatividade rodarem na ASSINATURA FLAT do dono — nunca queima credito de API.

GENERALIZADO (tecnica TIOCSTI): nada de hardcode de nome de persona. O alvo e
identificado pelo --name (default "dgclaw-<slug>", ou DGCLAW_CHANNEL_NAME). Namespacing por-slug
em tudo (lock /tmp/dgclaw-inject-<slug>.lock) pra varios agentes coexistirem no mesmo host.

TRES modos (env DGCLAW_INJECT_MODE; default "bunker" se DGCLAW_BUNKER_CARD estiver
definido, senao "tiocsti"):
  tiocsti  acha o /dev/pts da sessao pelo --name em /proc/*/cmdline e injeta char a char via
           ioctl TIOCSTI. Nesta VPS sysctl dev.tty.legacy_tiocsti=0 -> so funciona como ROOT
           (CAP_SYS_ADMIN); os crons de vida rodam root, entao OK.
  tmux     fallback portavel (opt-in): tmux -L /tmp/dgclaw-<slug>.sock send-keys. NAO exige
           tmux instalado se voce ficar no modo default.
  bunker   a sessao nao e um `claude --channels` deste host: e um CARD do painel do Bunker,
           que e como nascem o gestor e o agente entregue. Aqui nao ha pts pra achar nem
           processo com --channels no argv, entao os dois modos acima dao "sessao morta" e o
           cron vira no-op em silencio. Este modo fala com o painel por HTTP.

           Por que isso existe (10/08/2026): o painel do agente, os self-crons da persona e
           as rotinas de vida travavam todos no mesmo ponto, que era o injetor so saber achar
           sessao `--channels`. Um card do Bunker e uma sessao viva legitima, e passa a ser
           tratada como tal.

           Env: DGCLAW_BUNKER_CARD (id do card, obrigatorio) e DGCLAW_BUNKER_URL
           (default http://127.0.0.1:4001).
           ⚠️ NUNCA leia SERVER_PORT aqui. Uma sessao que roda DENTRO de um card da
           instancia de ADMINISTRACAO exporta SERVER_PORT=4201, e herdar isso em silencio
           faz o poke ir para o painel errado, onde o card nem existe.

API publica (importavel por outros scripts):
  is_session_alive(slug, name=None) -> bool   sessao viva no ar?
  channel_name(slug) -> str                   o --name esperado pra um slug
  live_transcript(slug, name=None) -> str|None  o .jsonl da sessao viva

CLI:
  inject.py --slug <slug> "texto a injetar"          injeta (Enter no fim)
  inject.py --slug <slug> --dry-run "texto"          monta tudo mas NAO envia
  inject.py --slug <slug> --check                    so testa se a sessao esta viva (exit 0/2)
  inject.py --slug <slug> --transcript               imprime o .jsonl da sessao viva (exit 0/2)
  inject.py --slug <slug> --stop                     manda ESC (interrompe o turno em voo)
  inject.py --name <nome> ...                         override explicito do --name alvo
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys
import termios
import time
from pathlib import Path


# ─── identificacao do alvo ────────────────────────────────────────────────────

def channel_name(slug: str) -> str:
    """O --name da sessao --channels do agente. Override por env DGCLAW_CHANNEL_NAME.
    Default segue o contrato do DG Claw launch.sh: --name "dgclaw-<slug>"."""
    return os.environ.get("DGCLAW_CHANNEL_NAME") or f"dgclaw-{slug}"


def _claude_marker() -> str:
    """Trecho do path do binario claude que distingue o processo claude REAL do injetor
    (que tambem tem '--name <nome>' no argv). Generalizado: aceita override por env
    DGCLAW_CLAUDE_BIN; senao casa por basename '/claude' (cobre ~/.local/bin/claude,
    /usr/bin/claude, etc), em vez de fixar um path absoluto."""
    cb = os.environ.get("DGCLAW_CLAUDE_BIN") or os.environ.get("CLAUDE_BIN")
    return cb if cb else "/claude"


def find_pts(name: str):
    """Acha (pid, /dev/pts/N) do processo claude --channels cujo argv tem 'name <name>'.
    pgrep -f casa qualquer cmdline com a string — inclusive o PROPRIO injetor (tem --name
    no argv). Por isso filtramos pro binario claude real."""
    try:
        pids = subprocess.check_output(["pgrep", "-f", f"name {name}"], text=True).split()
    except subprocess.CalledProcessError:
        return None, None
    marker = _claude_marker()
    my_pid = str(os.getpid())
    for pid in pids:
        if pid == my_pid:
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\x00", b" ").decode(errors="replace")
        except OSError:
            continue
        # so o processo claude de verdade (exclui o injetor python, shells, `script`, etc).
        # --channels e a marca forte e portavel (so a sessao viva tem). O marker do binario
        # (DGCLAW_CLAUDE_BIN ou basename '/claude') e uma confirmacao ADICIONAL, mas como
        # paths variam entre hosts, '--channels' sozinho ja basta pra identificar a sessao.
        # Mas sessao sem Telegram (so painel, desde 11/08/2026) sobe SEM --channels, e ate
        # 05/10/2026 ela ficava invisivel aqui: crons, painel e watchdog achavam o agente
        # morto e o watchdog o reiniciava (Lara, 02/10). Sem --channels, vale o argv[0] ser o
        # binario claude (ou o node rodando o claude-code, instalacao via npm). O injetor e
        # python, entao continua de fora.
        _argv0 = os.path.basename(cmd.split(" ", 1)[0])
        _e_claude = _argv0 == "claude" or (_argv0 == "node" and "claude-code" in cmd)
        if "--channels" not in cmd and not _e_claude:
            continue
        if marker not in cmd and "claude" not in cmd:
            continue
        try:
            tty = subprocess.check_output(["ps", "-o", "tty=", "-p", pid], text=True).strip()
        except subprocess.CalledProcessError:
            tty = ""
        if tty and tty != "?":
            return pid, f"/dev/{tty}"
        return pid, None
    return None, None


# ─── envelope de PLATAFORMA (quem esta falando com o agente) ──────────────────
# Um agente que atende cliente tem uma trava de fim de turno (o hook stop-force-reply):
# se ele escrever texto e nao entregar nada pelo canal, o hook bloqueia o Stop e cobra a
# entrega. Isso e certo quando quem falou foi a PESSOA. Um poke de cron nao e a pessoa: sem
# marcar quem falou, a reflexao das 23h30 vira uma mensagem que o CLIENTE recebe, sobre uma
# rotina interna que ele nao pediu e nao entende.
#
# O envelope `<plataforma ...>` e o combinado com o hook (PLATFORM_MARKER = "<plataforma ").
# Ele so carimba quem falou; nao pede recibo e nao muda o conteudo do poke.

def _tem_canal_dgchat(slug: str) -> bool:
    """O agente atende alguem por um canal (e por isso tem trava de fim de turno)?
    Duas evidencias baratas e que nao dependem de ler transcript: a env do canal no
    ambiente, e a pasta do canal no workspace do agente."""
    if os.environ.get("DGCHAT_OUTBOUND") or os.environ.get("DGCHAT_AGENT"):
        return True
    ws = os.environ.get("DGCLAW_WORKSPACE") or ("/home/agente" if slug else "")
    return bool(ws) and Path(ws, ".plataforma", "dgchat").exists()


def envelope_plataforma(texto: str) -> str:
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).isoformat()
    rid = f"poke-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    limpo = texto.replace("</plataforma>", "<\\/plataforma>")
    return f'<plataforma recado="{rid}" tipo="aviso" ts="{ts}">{limpo}</plataforma>'


def aplicar_envelope(texto: str, modo: str, slug: str) -> str:
    """modo: none (default, retrocompativel) | plataforma (forca) | auto (envelopa se o
    agente tiver canal). O default e `none` de proposito: a aba Conversa do painel tambem
    chama este script, e ali quem esta digitando E a pessoa."""
    modo = (modo or "none").strip().lower()
    if modo in ("plataforma", "1", "on", "true", "yes"):
        return envelope_plataforma(texto)
    if modo == "auto" and _tem_canal_dgchat(slug):
        return envelope_plataforma(texto)
    return texto


# ─── modo bunker: a sessao viva e um CARD do painel ───────────────────────────

def _bunker_card() -> str:
    return os.environ.get("DGCLAW_BUNKER_CARD", "").strip()


def _bunker_url() -> str:
    """Base do painel. NUNCA derivada de SERVER_PORT (ver o aviso no cabecalho)."""
    return (os.environ.get("DGCLAW_BUNKER_URL") or "http://127.0.0.1:4001").rstrip("/")


def resolve_mode() -> str:
    """O modo efetivo. DGCLAW_INJECT_MODE manda; na ausencia dele, ter um card
    configurado ja diz qual e o mundo (card do Bunker), e o default historico
    (tiocsti) fica para quem roda o DG Claw sozinho."""
    explicito = os.environ.get("DGCLAW_INJECT_MODE", "").strip().lower()
    if explicito:
        return explicito
    return "bunker" if _bunker_card() else "tiocsti"


def _cabecalho_runner() -> dict:
    """Authorization do runner, se RUNNER_TOKEN_FILE existir no ambiente. Sem a variavel
    nada muda (o alvo pode ser o Bunker antigo). Arquivo ilegivel: avisa o caminho e o
    erro (nunca o conteudo) e segue sem o cabecalho; o runner vai responder 401."""
    caminho = os.environ.get("RUNNER_TOKEN_FILE")
    if not caminho:
        return {}
    try:
        token = Path(caminho).read_text().strip()
    except OSError as e:
        print(f"[dgclaw-inject] nao consegui ler o token do runner em {caminho}: {e}. "
              "Confira se o arquivo existe e se este usuario consegue le-lo.", file=sys.stderr)
        return {}
    if not token:
        print(f"[dgclaw-inject] o arquivo do token do runner esta vazio: {caminho}", file=sys.stderr)
        return {}
    return {"Authorization": f"Bearer {token}"}


def _bunker_pedir(rota: str, corpo=None, timeout: int = 30):
    """Chamada ao painel. Devolve (status, dict|None). Nunca levanta: quem chama
    precisa distinguir "painel recusou" de "painel fora do ar", e nos dois casos o
    cron tem que virar no-op gracioso em vez de estourar.

    O opener sai SEM proxy de proposito: esta VPS tem http_proxy no ambiente, e o
    urllib obedeceria, mandando uma chamada de loopback para o proxy."""
    import urllib.error
    import urllib.request

    url = f"{_bunker_url()}{rota}"
    dados = None
    cab = _cabecalho_runner()
    if corpo is not None:
        dados = json.dumps(corpo).encode()
        cab["content-type"] = "application/json"
    req = urllib.request.Request(url, data=dados, headers=cab,
                                 method="POST" if corpo is not None else "GET")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            bruto = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        bruto = e.read().decode("utf-8", "replace")
        status = e.code
    except Exception as e:
        print(f"[dgclaw-inject] nao alcancei o painel em {url}: {e}", file=sys.stderr)
        return 0, None
    if status == 401:
        print(f"[dgclaw-inject] o runner em {url} recusou o token (401). Confira se "
              "RUNNER_TOKEN_FILE aponta para o arquivo certo e se o token nao foi trocado.",
              file=sys.stderr)
    try:
        return status, json.loads(bruto)
    except Exception:
        return status, None


def _bunker_estado():
    """O card, ou None. 423 = cofre trancado, que e o estado NORMAL depois de todo
    restart do painel e nao e defeito: quem chama trata como 'sessao indisponivel'."""
    card = _bunker_card()
    if not card:
        return None
    status, corpo = _bunker_pedir(f"/api/agents/{card}")
    if status == 423:
        print("[dgclaw-inject] cofre do painel TRANCADO — trate como sessao indisponivel",
              file=sys.stderr)
        return None
    if status != 200 or not corpo or not corpo.get("success"):
        return None
    return corpo.get("data")


# Estados em que o card NAO tem terminal vivo: escrever neles seria descartado em
# silencio, que e o pior desfecho possivel para um recado.
_BUNKER_MORTO = {"errored", "stopped", "resumable"}


def _bunker_vivo(card=None) -> bool:
    card = card if card is not None else _bunker_estado()
    return bool(card) and card.get("status") not in _BUNKER_MORTO


def is_session_alive(slug: str, name: str = None) -> bool:
    """True se a sessao viva do agente esta no ar (modo tiocsti: tem pts; modo tmux: a
    sessao tmux existe; modo bunker: o card tem terminal). Usado pelos crons pro NO-OP
    gracioso quando o dono desligou o bot 24/7 pra poupar."""
    name = name or channel_name(slug)
    mode = resolve_mode()
    if mode == "bunker":
        return _bunker_vivo()
    if mode == "tmux":
        sock = _tmux_sock(slug)
        sess = _tmux_session(slug)
        return subprocess.run(
            ["tmux", "-L", sock, "has-session", "-t", sess],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ).returncode == 0
    pid, pts = find_pts(name)
    return bool(pts)


# ─── lock por-slug (anti-colisao de keystrokes) ───────────────────────────────

def lock_key(slug: str, name: str = None) -> str:
    """Chave de namespacing do lock. Usa o slug quando ha; senao deriva do --name
    (contrato 'dgclaw-<slug>' -> '<slug>', ou o proprio name sanitizado). Garante que
    chamar so com --name AINDA serialize injecoes na mesma sessao (senao dois crons
    colidem keystrokes silenciosamente)."""
    if slug:
        return slug
    n = name or ""
    if n.startswith("dgclaw-"):
        n = n[len("dgclaw-"):]
    # sanitiza pra um nome de arquivo seguro
    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in n)
    return safe or "default"


def acquire_lock(key: str, wait_s: int = 150):
    """Lock por-CHAVE (slug ou derivado do --name) pra SERIALIZAR injecoes concorrentes na
    mesma sessao. Sem isto, dois crons que disparam no mesmo minuto (ex: heartbeat +
    reflection) digitam ao mesmo tempo -> as teclas se intercalam e um poke se PERDE.
    Namespacing por-chave deixa agentes diferentes injetarem em paralelo sem se atrapalhar.
    Retorna o fd do lock (mante-lo aberto = segurar o lock) ou None se estourar o tempo.
    O lock file e criado com perms 0600 (so o dono le/escreve)."""
    lock_path = f"/tmp/dgclaw-inject-{key}.lock"
    # O(pen com umask restritivo: o lock file nao precisa ser world-readable.
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o600)
    fh = os.fdopen(fd, "w")
    deadline = time.monotonic() + wait_s
    while True:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fh
        except BlockingIOError:
            if time.monotonic() > deadline:
                fh.close()
                return None
            time.sleep(1.5)


# ─── guarda de ociosidade (anti-atropelamento de turno) ───────────────────────
# Mesmo com o lock serializando injetores ENTRE SI, um poke de cron pode chegar enquanto
# o DONO esta no meio de um turno (ele falou com o agente agora). Injetar nesse instante
# intercala texto na caixa de input ou interrompe o raciocinio. Esta guarda detecta "turno
# em voo" pelo transcript da sessao viva e adia o poke (sem dado pessoal: so mtime + tipo do
# ultimo evento). Conservadora: em duvida, considera OCUPADA e NAO injeta.

def _resolve_session_dir() -> Path:
    override = os.environ.get("DGCLAW_SESSION_DIR")
    if override:
        return Path(override).resolve()
    ws = Path(os.environ.get("DGCLAW_WORKSPACE") or os.getcwd()).resolve()
    encoded = str(ws).replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded


def _find_live_transcript(session_dir: Path, channel: str):
    """O .jsonl da sessao --channels viva, casado por customTitle == channel (igual ao
    auto-compact.py). NAO usa so mtime: outro arquivo pode mascarar a sessao real."""
    if not session_dir.exists():
        return None
    try:
        files = list(session_dir.glob("*.jsonl"))
    except OSError:
        return None
    if not files:
        return None
    for p in sorted(files, key=lambda f: f.stat().st_mtime, reverse=True)[:80]:
        try:
            with p.open() as f:
                for i, line in enumerate(f):
                    if i > 8:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        if json.loads(line).get("customTitle") == channel:
                            return p
                    except Exception:
                        continue
        except Exception:
            continue
    return None


def _codex_homes(codex_home=None) -> list:
    """Onde o rollout pode estar, visto de DENTRO do container (o painel roda la):
    o CODEX_HOME que o runner informou, o do ambiente, a pasta por sessao do modo api
    e o ~/.codex da assinatura. O que o runner informa so vale dentro da casa do agente."""
    casa = Path.home().resolve()
    homes = []
    if codex_home:
        p = Path(str(codex_home)).resolve()
        if p == casa or casa in p.parents:
            homes.append(p)
        else:
            print(f"[dgclaw-inject] o CODEX_HOME informado pelo runner ({codex_home}) cai fora "
                  f"de {casa}; ignorei", file=sys.stderr)
    env = os.environ.get("CODEX_HOME")
    if env:
        homes.append(Path(env))
    api = casa / ".plataforma" / "codex-api"
    if api.is_dir():
        homes.extend(sorted(d for d in api.iterdir() if d.is_dir()))
    homes.append(casa / ".codex")
    return homes


def _dentro_da_casa(alvo: Path, raiz_real: Path) -> bool:
    try:
        real = alvo.resolve(strict=True)
    except (OSError, RuntimeError):
        return False
    return real == raiz_real or raiz_real in real.parents


def find_codex_rollout(session_id: str, codex_home=None):
    """<CODEX_HOME>/sessions/AAAA/MM/DD/rollout-*-<sessionId>.jsonl, ou None.
    A pasta de sessoes e o arquivo final precisam ter o realpath dentro de realpath($HOME):
    atalho plantado para fora e recusado (aviso no stderr, nada e lido)."""
    import re
    if not session_id or not re.fullmatch(r"[0-9a-fA-F-]{8,64}", str(session_id)):
        return None
    sufixo = f"-{str(session_id).lower()}.jsonl"
    vistos = set()
    casa = Path.home().resolve()
    for h in _codex_homes(codex_home):
        if h in vistos:
            continue
        vistos.add(h)
        raiz = h / "sessions"
        if not raiz.exists():
            continue
        if not _dentro_da_casa(raiz, casa):
            print(f"[dgclaw-inject] recusei a pasta de sessoes do Codex {raiz}: o realpath "
                  f"cai fora de {casa}; nada foi lido", file=sys.stderr)
            continue
        try:
            achados = [f for f in raiz.glob("*/*/*/rollout-*.jsonl") if f.name.lower().endswith(sufixo)]
        except OSError:
            continue
        for f in sorted(achados, reverse=True):
            if _dentro_da_casa(f, casa):
                return str(f.resolve())
            print(f"[dgclaw-inject] recusei o registro Codex {f}: o atalho aponta para "
                  f"{f.resolve()}, fora de {casa}; nada foi lido", file=sys.stderr)
    return None


def live_transcript(slug: str, name: str = None):
    """O caminho do .jsonl da sessao viva, ou None. Existe para que UM lugar so saiba
    achar a sessao: o painel e o extrator de thread perguntam aqui em vez de cada um
    reimplementar a convencao de diretorio.

    No modo bunker o id da sessao vem do proprio painel, que e a fonte da verdade
    (o `/resume` dentro do TUI faz o Claude gravar sob um uuid diferente do que foi
    pedido no spawn, entao adivinhar por mtime erra em cwd compartilhado)."""
    name = name or channel_name(slug)
    if resolve_mode() == "bunker":
        card = _bunker_estado()
        if not card:
            return None
        sid = card.get("sessionId")
        if not sid:
            return None
        cwd = (card.get("config") or {}).get("cwd") or os.environ.get("DGCLAW_WORKSPACE") or ""
        if not cwd:
            return None
        encoded = str(Path(cwd).resolve()).replace("/", "-")
        p = Path.home() / ".claude" / "projects" / encoded / f"{sid}.jsonl"
        if p.exists():
            return str(p)
        # Agente com o motor Codex: a conversa fica no rollout dele, nao no transcript do
        # Claude. O id da sessao decide (um id de Codex nunca existe como .jsonl do Claude),
        # entao nao precisa perguntar o provedor ao runner.
        return find_codex_rollout(sid, card.get("codexHome"))
    p = _find_live_transcript(_resolve_session_dir(), name)
    return str(p) if p else None


def session_is_idle(slug: str, name: str = None, idle_sec: int = None) -> bool:
    """True quando a sessao NAO esta no meio de um turno. Espelha looks_idle do auto-compact.py:
      - transcript parado ha >= idle_sec (turno em voo escreve chunks continuamente), E
      - ultimo evento e 'assistant' (turno terminou); se 'user' sem resposta -> ocupada.
    Em duvida (sem transcript, erro de leitura) -> False (conservador: NAO injeta).

    No modo bunker nao se adivinha nada: o painel sabe o estado do card pelos hooks
    nativos do Claude Code, que e um sinal muito melhor que mtime de arquivo."""
    if resolve_mode() == "bunker":
        card = _bunker_estado()
        return bool(card) and card.get("status") in ("idle", "completed")
    if idle_sec is None:
        try:
            idle_sec = int(os.environ.get("DGCLAW_INJECT_IDLE_SEC", "45"))
        except (TypeError, ValueError):
            idle_sec = 45
    name = name or channel_name(slug)
    tr = _find_live_transcript(_resolve_session_dir(), name)
    if tr is None:
        return False
    try:
        mtime = tr.stat().st_mtime
    except OSError:
        return False
    if (time.time() - mtime) < idle_sec:
        return False
    last_type = None
    try:
        with tr.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                t = o.get("type")
                if t in ("user", "assistant"):
                    last_type = _tipo_de_turno(o, t, last_type)
    except Exception:
        return False
    return last_type == "assistant"


def _tipo_de_turno(o: dict, t: str, atual):
    """Mesma regra do tipo_de_turno do auto-compact.py (BL-426, 05/10/2026). Depois de um
    /compact o transcript termina em linhas 'user' que nao sao turno (resumo, meta e o eco
    do comando local), e a sessao parecia ocupada ate a proxima resposta: a ponte segurava
    a mensagem do dono 180 s antes de forcar. <local-command-stdout> prova que o comando
    local terminou e o prompt voltou; resumo, meta e caveat nao mudam o estado."""
    if t != "user":
        return t
    if o.get("isCompactSummary") or o.get("isMeta"):
        return atual
    c = (o.get("message") or {}).get("content")
    if isinstance(c, str):
        c = c.lstrip()
        if c.startswith(("<local-command-stdout>", "<local-command-stderr>")):
            return "assistant"
        if c.startswith("<local-command-caveat>"):
            return atual
    return "user"


# ─── modo TIOCSTI (default) ───────────────────────────────────────────────────

def _inject_tiocsti(pts: str, text: str):
    fd = os.open(pts, os.O_WRONLY)
    try:
        # TIOCSTI empurra UM byte (conserto de 02/10/2026). Iterar por caractere mandava so o
        # primeiro byte de cada letra acentuada (UTF-8 tem 2+), e o texto chegava estragado.
        for byte in text.encode("utf-8"):
            fcntl.ioctl(fd, termios.TIOCSTI, bytes([byte]))
    finally:
        os.close(fd)


# ─── modo tmux send-keys (opt-in, portavel) ───────────────────────────────────

def _tmux_sock(slug: str) -> str:
    return os.environ.get("DGCLAW_TMUX_SOCK") or f"/tmp/dgclaw-{slug}.sock"


def _tmux_session(slug: str) -> str:
    return os.environ.get("DGCLAW_TMUX_SESSION") or f"dgclaw-{slug}"


def _inject_bunker(text: str, quando_ocioso: bool):
    """Datilografa no card pelo painel. Devolve (ok, motivo).

    `quando_ocioso` NAO descarta nada: o painel ENFILEIRA e entrega quando o card
    ficar ocioso. E por isso que o modo bunker nao tem o exit 75 ("adiei, tenta no
    proximo disparo") dos outros dois: aqui adiar e o proprio painel esperar, e o
    recado chega em vez de se perder."""
    card = _bunker_card()
    corpo = {"text": text, "injectWhenIdle": True} if quando_ocioso else {"text": text}
    status, resposta = _bunker_pedir(f"/api/agents/{card}/input", corpo)
    if status in (200, 202) and resposta and resposta.get("success"):
        return True, "enfileirado" if quando_ocioso else "digitado"
    if status == 0:
        return False, "o painel nao respondeu"
    motivo = (resposta or {}).get("error") or f"painel respondeu {status}"
    remedio = (resposta or {}).get("howToFix")
    return False, f"{motivo}{' | ' + remedio if remedio else ''}"


def _stop_bunker():
    """ESC no card, SEM o \\r. O Enter depois do ESC viraria envio de linha vazia, que
    no TUI e um turno a toa em vez de uma interrupcao."""
    card = _bunker_card()
    status, resposta = _bunker_pedir(f"/api/agents/{card}/input",
                                     {"text": "\x1b", "submit": False})
    if status == 200 and resposta and resposta.get("success"):
        return True, "ESC enviado"
    motivo = (resposta or {}).get("error") or f"painel respondeu {status}"
    return False, motivo


def _inject_tmux(slug: str, text: str):
    sock = _tmux_sock(slug)
    sess = _tmux_session(slug)
    # C-u limpa lixo na caixa de input antes de digitar (senao concatena e submete garbled)
    subprocess.run(["tmux", "-L", sock, "send-keys", "-t", sess, "C-u"], check=True)
    time.sleep(0.3)
    subprocess.run(["tmux", "-L", sock, "send-keys", "-t", sess, text], check=True)
    time.sleep(1)
    subprocess.run(["tmux", "-L", sock, "send-keys", "-t", sess, "Enter"], check=True)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Injeta um poke na sessao --channels viva do agente.")
    ap.add_argument("--slug", help="DGCLAW_SLUG (= DGCLAW_SLUG). Usado p/ lock e --name default.")
    ap.add_argument("--name", help="override do --name alvo (default: dgclaw-<slug> ou DGCLAW_CHANNEL_NAME)")
    ap.add_argument("--dry-run", action="store_true", help="monta tudo mas NAO injeta")
    ap.add_argument("--check", action="store_true", help="so testa se a sessao esta viva (exit 0 viva / 2 morta)")
    ap.add_argument("--transcript", action="store_true",
                    help="imprime no stdout o .jsonl da sessao viva (exit 0 achou / 2 nao achou)")
    ap.add_argument("--stop", action="store_true",
                    help="manda ESC na sessao (interrompe o turno em voo), sem submeter linha")
    ap.add_argument("--require-idle", action="store_true",
                    help="so injeta se a sessao estiver ociosa (nao no meio de um turno); senao exit 75 (adiar)")
    ap.add_argument("--envelope", default=os.environ.get("DGCLAW_POKE_ENVELOPE", "none"),
                    choices=["none", "auto", "plataforma"],
                    help="carimba quem esta falando: 'plataforma' embrulha o texto em "
                         "<plataforma ...> pro hook de fim de turno saber que foi a maquina, "
                         "e nao a pessoa; 'auto' faz isso so quando o agente tem canal. "
                         "O default AQUI e 'none' de proposito, e nao e esquecimento: quem "
                         "chama este script direto e a aba Conversa do painel, onde quem "
                         "digita E a pessoa e o hook TEM que cobrar a resposta. Quem faz poke "
                         "passa --envelope explicito (_lib/inject.sh e persona-cron-mgr.py "
                         "mandam 'auto'). Nao troque este default sem trocar aqueles dois.")
    ap.add_argument("text", nargs="?", default="", help="linha a injetar (um \\r e acrescentado pra submeter)")
    a = ap.parse_args()

    if not a.slug and not a.name:
        print("[dgclaw-inject] --slug ou --name obrigatorio", file=sys.stderr)
        sys.exit(64)

    slug = a.slug or ""
    name = a.name or channel_name(slug)
    mode = resolve_mode()

    # --check: so o veredito de vida (pros crons decidirem no-op)
    if a.check:
        if is_session_alive(slug, name):
            print(f"[dgclaw-inject] sessao '{name}' VIVA (modo {mode})", file=sys.stderr)
            sys.exit(0)
        print(f"[dgclaw-inject] sessao '{name}' MORTA (modo {mode})", file=sys.stderr)
        sys.exit(2)

    # --transcript: onde a conversa esta gravada. O caminho vai no STDOUT (e o valor
    # util); todo o resto deste script fala por stderr, entao da pra capturar direto.
    if a.transcript:
        caminho = live_transcript(slug, name)
        if caminho:
            print(caminho)
            sys.exit(0)
        print(f"[dgclaw-inject] nao achei o transcript da sessao '{name}' (modo {mode})",
              file=sys.stderr)
        sys.exit(2)

    # --stop: o freio. ESC sem \r, porque o Enter depois do ESC vira envio de linha
    # vazia (um turno a toa) em vez de interrupcao.
    if a.stop:
        if mode == "bunker":
            ok, motivo = _stop_bunker()
            print(f"[dgclaw-inject] {motivo}", file=sys.stderr)
            sys.exit(0 if ok else 1)
        if mode == "tmux":
            if not is_session_alive(slug, name):
                print(f"[dgclaw-inject] sessao tmux de '{slug}' nao existe", file=sys.stderr)
                sys.exit(2)
            subprocess.run(["tmux", "-L", _tmux_sock(slug), "send-keys",
                            "-t", _tmux_session(slug), "Escape"], check=True)
            print(f"[dgclaw-inject] ESC enviado (tmux) em {_tmux_session(slug)}", file=sys.stderr)
            sys.exit(0)
        pid, pts = find_pts(name)
        if not pts:
            print(f"[dgclaw-inject] sessao '{name}' sem pts — nao tem o que parar", file=sys.stderr)
            sys.exit(2)
        try:
            _inject_tiocsti(pts, "\x1b")
        except PermissionError:
            print("[dgclaw-inject] PermissionError no TIOCSTI — precisa ser root "
                  "(dev.tty.legacy_tiocsti=0) ou use DGCLAW_INJECT_MODE=tmux", file=sys.stderr)
            sys.exit(3)
        print(f"[dgclaw-inject] ESC enviado em {pts} (pid {pid})", file=sys.stderr)
        sys.exit(0)

    if not a.text:
        print("[dgclaw-inject] texto obrigatorio (a menos que --check/--transcript/--stop)",
              file=sys.stderr)
        sys.exit(64)

    # Carimbo de quem falou. Vem antes de qualquer transporte: o envelope e do RECADO,
    # nao do meio pelo qual ele chega.
    a.text = aplicar_envelope(a.text, a.envelope, slug)

    # Guarda de ociosidade (opt-in via --require-idle ou env): nao atropela um turno do dono.
    # Aplica-se ANTES de pegar o lock/injetar, nos dois modos. Exit 75 = "adiar" (turno em voo).
    want_idle = a.require_idle or (os.environ.get("DGCLAW_INJECT_REQUIRE_IDLE", "").lower()
                                   in ("1", "on", "true", "yes"))

    # ── modo bunker ──
    # Vem ANTES da guarda de ociosidade de proposito: aqui quem espera o card ficar
    # livre e o proprio painel (injectWhenIdle), que enfileira em vez de descartar.
    # Reimplementar a guarda aqui so produziria o exit 75 e faria o cron jogar fora um
    # poke que teria sido entregue dois minutos depois.
    if mode == "bunker":
        if not _bunker_card():
            print("[dgclaw-inject] modo bunker sem DGCLAW_BUNKER_CARD — nao sei em qual card "
                  "digitar. O que fazer: exportar DGCLAW_BUNKER_CARD no .dgclaw/config.sh do "
                  "agente (o id aparece em GET /api/agents do painel).", file=sys.stderr)
            sys.exit(64)
        card = _bunker_estado()
        if not _bunker_vivo(card):
            estado = (card or {}).get("status", "sem resposta do painel")
            print(f"[dgclaw-inject] card '{_bunker_card()}' sem terminal vivo ({estado}) — "
                  f"NAO injetei", file=sys.stderr)
            sys.exit(2)
        if a.dry_run:
            print(f"[dgclaw-inject] DRYRUN (bunker) — injetaria em {_bunker_card()} "
                  f"(ocioso={want_idle}): {a.text!r}", file=sys.stderr)
            return
        ok, motivo = _inject_bunker(a.text, want_idle)
        if not ok:
            print(f"[dgclaw-inject] FALHA ao injetar no card {_bunker_card()}: {motivo}",
                  file=sys.stderr)
            sys.exit(1)
        print(f"[dgclaw-inject] injetado ({motivo}) no card {_bunker_card()}", file=sys.stderr)
        return

    if want_idle and not session_is_idle(slug, name):
        print(f"[dgclaw-inject] sessao '{name}' OCUPADA (turno em voo) — NAO injetei (adiar)", file=sys.stderr)
        sys.exit(75)

    # ── modo tmux ──
    if mode == "tmux":
        if not is_session_alive(slug, name):
            print(f"[dgclaw-inject] sessao tmux de '{slug}' nao existe — NAO injetei", file=sys.stderr)
            sys.exit(2)
        if a.dry_run:
            print(f"[dgclaw-inject] DRYRUN (tmux) — injetaria em {_tmux_session(slug)}: {a.text!r}", file=sys.stderr)
            return
        # serializa SEMPRE (deriva a chave do slug ou do --name) — evita colisao de keystrokes
        key = lock_key(slug, name)
        lock = acquire_lock(key)
        if lock is None:
            print(f"[dgclaw-inject] nao consegui o lock de '{key}' em 150s — NAO injetei (evita colisao)", file=sys.stderr)
            sys.exit(4)
        try:
            time.sleep(2)
            _inject_tmux(slug, a.text)
            time.sleep(2)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()
        print(f"[dgclaw-inject] injetado (tmux) em {_tmux_session(slug)}", file=sys.stderr)
        return

    # ── modo tiocsti (default) ──
    pid, pts = find_pts(name)
    if not pts:
        print(f"[dgclaw-inject] sessao '{name}' sem pts (pid={pid}) — NAO injetei", file=sys.stderr)
        sys.exit(2)
    if a.dry_run:
        print(f"[dgclaw-inject] DRYRUN (tiocsti) — injetaria em {pts} (pid {pid}): {a.text!r}", file=sys.stderr)
        return

    # serializa com outros injetores na MESMA sessao (anti-colisao de keystrokes).
    # Lock SEMPRE: deriva a chave do slug ou, na falta dele, do --name. Sem isto, chamar
    # so com --name pularia o lock e dois crons poderiam intercalar keystrokes.
    key = lock_key(slug, name)
    lock = acquire_lock(key)
    if lock is None:
        print(f"[dgclaw-inject] nao consegui o lock de '{key}' em 150s — NAO injetei (evita colisao)", file=sys.stderr)
        sys.exit(4)
    try:
        time.sleep(2)            # respira: deixa um turno em voo comecar/terminar
        try:
            # Enter separado (02/10/2026). Texto longo chega como rajada, o TUI trata
            # como colagem e o \r grudado no fim vira parte dela: o poke ficava parado na caixa.
            _inject_tiocsti(pts, a.text)
            time.sleep(1.0)
            _inject_tiocsti(pts, "\r")
        except PermissionError:
            print("[dgclaw-inject] PermissionError no TIOCSTI — precisa ser root "
                  "(dev.tty.legacy_tiocsti=0) ou use DGCLAW_INJECT_MODE=tmux", file=sys.stderr)
            sys.exit(3)
        time.sleep(4)            # segura o lock: o proximo injetor espera o prompt ser submetido
    finally:
        if lock is not None:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()
    print(f"[dgclaw-inject] injetado em {pts} (pid {pid})", file=sys.stderr)


if __name__ == "__main__":
    main()
