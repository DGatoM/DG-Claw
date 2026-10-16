#!/usr/bin/env python3
"""persona-cron-mgr.py — Deixa a PESSOA VIRTUAL criar/editar/listar/remover os SEUS PROPRIOS
crons (timers systemd), de forma segura, dentro de um BLOCO DELIMITADO que so ela governa.

PORQUE: uma pessoa viva quer poder dizer "todo dia as 9h me lembra de X" e ter isso virar um
agendamento real, sem precisar do dono mexer em systemd na mao. Mas dar `crontab`/`systemctl`
cru pra um LLM e perigoso. Este wrapper e a fronteira segura:

  - BLOCO DELIMITADO: a persona so cria timers no namespace dela, com prefixo fixo
        dgclaw-<slug>-self-<name>
    Tudo que ela cria/edita/remove fica DENTRO desse prefixo. Os timers de VIDA do plugin
    (reflection/audit/heartbeat/pulso/etc — sem o infixo `-self-`) e quaisquer outras units
    do sistema sao INTOCAVEIS por este script. Ele recusa operar fora do bloco.
  - MANIFESTO com marcadores: um JSON em <ws>/.dgclaw/self-crons.json guarda a lista
    declarativa dos crons da persona, cercada por marcadores textuais
        # >>> DG-ALIVE SELF-CRONS (slug=<slug>) — NAO EDITAR FORA DESTE BLOCO <<<
        ... json ...
        # <<< DG-ALIVE SELF-CRONS END >>>
    pra ficar obvio (pra humano e pra ferramenta) que so este programa mexe ali.
  - CAP: no maximo DGCLAW_SELF_CRON_CAP timers self (default 10). Atingiu, recusa criar.
  - BACKUP antes de editar: toda escrita no manifesto faz um snapshot timestampado em
        <ws>/.dgclaw/backups/self-crons/<utc>.json
    (rotacao: mantem os ultimos DGCLAW_SELF_CRON_BACKUPS, default 20).
  - VALIDACAO dura: slug-name kebab-case 3-40 chars; OnCalendar OU intervalo (um dos dois);
    a ACAO e so um TEXTO de poke que vai ser INJETADO na sessao viva via _lib/inject.py
    (NUNCA um comando shell arbitrario da persona). Assim a pior coisa que um cron self pode
    fazer e injetar uma frase na propria sessao da pessoa — zero superficie de RCE.

MODELO DE EXECUCAO (igual ao resto da Onda A): o cron self NAO chama `claude -p`. Quando dispara,
ele so INJETA um poke (o texto que a persona definiu) na sessao --channels VIVA do agente, via
inject.py. A persona "acorda", le o poke e age na assinatura flat do dono. Se a sessao estiver
morta (dono desligou o 24/7), inject.py faz no-op gracioso (exit 2) e o cron nao faz nada.

Tudo parametrizado por env DGCLAW_* (lidos do config.sh do agente). ZERO dado pessoal.
Notificacao (quando habilitada) SEMPRE via scripts/notify-owner.sh.

────────────────────────────────────────────────────────────────────────────────────────────
COMO A PERSONA INVOCA (a sessao viva tem Bash; o config.sh ja exporta os DGCLAW_*):

  # criar um lembrete diario as 9h
  python3 "$DGCLAW_PLUGIN_ROOT/scripts/persona-cron-mgr.py" create \\
      --name lembrete-agua --calendar '*-*-* 09:00:00' \\
      --poke '[self-cron] hora de lembrar o dono de beber agua'

  # criar um cron por intervalo (a cada 6h)
  python3 .../persona-cron-mgr.py create --name ronda-leve --every 6h \\
      --poke '[self-cron] faz uma ronda leve e me avisa se achar algo'

  # listar os SEUS crons
  python3 .../persona-cron-mgr.py list

  # editar (muda horario e/ou texto)
  python3 .../persona-cron-mgr.py edit --name lembrete-agua --calendar '*-*-* 08:30:00'

  # remover
  python3 .../persona-cron-mgr.py remove --name lembrete-agua

Sem --slug/--config explicito, o script le DGCLAW_CONFIG (ou os DGCLAW_* ja no ambiente).
`--dry-run` em create/edit/remove mostra o que faria sem tocar systemd nem o manifesto.

ENV:
  DGCLAW_SLUG              (obrig.) slug do agente — namespace dos timers
  DGCLAW_WORKSPACE         (obrig.) raiz do workspace (.dgclaw/ fica dentro)
  DGCLAW_CONFIG            (opcional) caminho do config.sh; se setado e os DGCLAW_* nao
                             estiverem no ambiente, o script o sourcia pra carregar tudo
  DGCLAW_PLUGIN_ROOT       (opcional) raiz do plugin instalado (default <ws>/.dgclaw/plugin)
  DGCLAW_SELF_CRON_CAP     (opcional) maximo de crons self (default 10)
  DGCLAW_SELF_CRON_BACKUPS (opcional) quantos backups do manifesto guardar (default 20)
  DGCLAW_TZ                (opcional) timezone dos timers (default America/Sao_Paulo)
  DGCLAW_SELF_CRON_NOTIFY  (opcional) 1 = avisa o dono via notify-owner ao criar/remover
  DGCLAW_INJECT_DRYRUN     (opcional) repassado pro inject.py no exec do timer (1 = nao injeta)
  DGCLAW_SYSTEMD_DIR       (opcional) onde gravar as unit-files (default /etc/systemd/system;
                             sobrescrevivel so pra teste)
"""

import argparse
import fcntl
import json
import os
import re
import shlex
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "_lib"))
import dono_agente  # noqa: E402  (ajudante comum com o install-ig-timers.sh)

# ─── constantes / marcadores ──────────────────────────────────────────────────

SELF_INFIX = "self"  # dgclaw-<slug>-self-<name> — a fronteira do bloco da persona
MARKER_BEGIN = "# >>> DG-ALIVE SELF-CRONS (slug={slug}) — NAO EDITAR FORA DESTE BLOCO <<<"
MARKER_END = "# <<< DG-ALIVE SELF-CRONS END >>>"

NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$")
EVERY_RE = re.compile(r"^\d+(s|min|h|d|m)$")  # 30min, 6h, 90s, 2d, 1m(onth nao; usa OnCalendar)
# OnCalendar: aceitamos as formas comuns e seguras. systemd valida de verdade no daemon-reload;
# aqui so barramos lixo obvio / chars perigosos. Permitido: digitos, espacos, : - * , / e letras
# (pra Mon..Fri, daily, weekly, etc).
CALENDAR_SAFE_RE = re.compile(r"^[A-Za-z0-9 :\-\*,/\.]+$")


def log_err(msg: str):
    print(f"[persona-cron-mgr] {msg}", file=sys.stderr)


def die(msg: str, code: int = 1):
    log_err(f"ERRO: {msg}")
    sys.exit(code)


# ─── quem roda a rotina, elevacao e dono dos arquivos ───────────────────────

def dono_do_workspace(c):
    """(uid, gid) do dono da pasta do agente (logica em _lib/dono_agente.py)."""
    try:
        return dono_agente.dono_do_workspace(c["ws"])
    except dono_agente.ErroDono as e:
        die(str(e))


def usuario_da_rotina(c):
    """(usuario, home) da unit da rotina (regra e motivo em _lib/dono_agente.py)."""
    try:
        return dono_agente.usuario_da_rotina(c["ws"])
    except dono_agente.ErroDono as e:
        die(str(e))


def chown_dono(c, path):
    """Devolve o arquivo ao dono da pasta do agente quando rodamos como root (via sudo)."""
    try:
        dono_agente.chown_dono(c["ws"], path)
    except dono_agente.ErroDono as e:
        die(str(e))


VARS_ELEVADO = "DGCLAW_CRON_MGR_ELEVADO"


def _gravavel(pasta: str) -> bool:
    """A pasta (ou o ancestral mais proximo que existe, se ela ainda nao existe) aceita escrita?"""
    p = Path(pasta)
    while not p.exists() and p != p.parent:
        p = p.parent
    return os.access(p, os.W_OK)


def elevar_se_preciso(c):
    """Gravar unit e rodar systemctl exige root. O agente da v1 nao e root, mas tem sudo sem
    senha: re-executa este mesmo comando com sudo. Roda antes de tocar no manifesto, para nao
    deixar meio caminho feito."""
    if os.geteuid() == 0 or _gravavel(c["unit_dir"]):
        return
    pasta = c["unit_dir"]
    if os.environ.get(VARS_ELEVADO) == "1":
        die(f"tentei gravar a rotina em {pasta} com sudo e mesmo assim a pasta nao aceita escrita. "
            f"Confira as permissoes dessa pasta (ou DGCLAW_SYSTEMD_DIR) com quem administra o servidor.")
    r = subprocess.run(["sudo", "-n", "true"], capture_output=True, text=True)
    if r.returncode != 0:
        die(f"tentei gravar a unit da rotina em {pasta}, mas este usuario nao e root e nao tem sudo "
            f"sem senha ({(r.stderr or r.stdout).strip() or 'sudo -n true falhou'}). "
            f"Rode o comando com sudo, ou peca ao dono do servidor para liberar.")
    log_err(f"este usuario nao e root e {pasta} nao aceita escrita; vou repetir o comando com sudo")
    os.environ[VARS_ELEVADO] = "1"
    nomes = sorted(k for k in os.environ if k.startswith("DGCLAW_") or k == "RUNNER_TOKEN_FILE")
    cmd = ["sudo", "-n", f"--preserve-env={','.join(nomes)}",
           sys.executable, os.path.abspath(sys.argv[0]), *sys.argv[1:]]
    os.execvp("sudo", cmd)


# ─── carga de config (env DGCLAW_*) ─────────────────────────────────────────

def load_config(config_path: str | None):
    """Garante que os DGCLAW_* estejam no os.environ. Se ja estao (timer/sessao viva os
    exportou), nao faz nada. Senao, e se houver um config.sh, sourcia-o num subshell e importa
    so as DGCLAW_* de volta (nunca exec do conteudo aqui dentro)."""
    if os.environ.get("DGCLAW_SLUG") and os.environ.get("DGCLAW_WORKSPACE"):
        return
    cfg = config_path or os.environ.get("DGCLAW_CONFIG")
    if not cfg:
        return
    cfg = os.path.abspath(cfg)
    if not os.path.isfile(cfg):
        die(f"config nao encontrada: {cfg}")
    # registra o caminho resolvido pra que o ExecStart dos timers sourceie o config (e exporte
    # os DGCLAW_* que o inject.py precisa quando o timer disparar fora da sessao).
    os.environ["DGCLAW_CONFIG"] = cfg
    # sourceia e dumpa SO as DGCLAW_* (env -0 pra valores com newline/espaco)
    out = subprocess.run(
        ["bash", "-c", f'set -a; source {shlex.quote(cfg)}; set +a; '
                       f'env -0 | grep -z "^DGCLAW_" || true'],
        capture_output=True, text=False,
    )
    for chunk in out.stdout.split(b"\x00"):
        if not chunk:
            continue
        try:
            k, _, v = chunk.decode().partition("=")
        except Exception:
            continue
        if k.startswith("DGCLAW_"):
            os.environ.setdefault(k, v)


def fuso_sem_config() -> str:
    """
    Fuso quando a config nao diz qual e (instalacao anterior a esta pergunta no wizard).

    Prefere o relogio da maquina. Se a maquina esta em UTC, que e como quase toda VPS nasce,
    quase certamente ninguem acertou nada: assumimos o fuso do publico deste produto e
    AVISAMOS, porque adivinhar fuso em silencio e o comeco do compromisso na hora errada.
    """
    try:
        out = subprocess.run(["timedatectl", "show", "-p", "Timezone", "--value"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        out = ""
    if out and out != "UTC":
        return out
    log_err("DGCLAW_TZ nao esta na config e o relogio da maquina esta em UTC. "
            "Assumindo America/Sao_Paulo. Se o dono nao vive nesse fuso, acerte agora: "
            "escreva DGCLAW_TZ no .dgclaw/config.sh (ou rode 'timedatectl set-timezone <fuso>').")
    return "America/Sao_Paulo"


def ctx():
    """Resolve o contexto (slug, ws, plugin, paths) do ambiente. Falha se faltar o essencial."""
    slug = os.environ.get("DGCLAW_SLUG")
    ws = os.environ.get("DGCLAW_WORKSPACE")
    if not slug:
        die("DGCLAW_SLUG nao setado (passe --config ou rode com o ambiente do agente)")
    if not ws:
        die("DGCLAW_WORKSPACE nao setado")
    if not NAME_RE.match(slug):
        die(f"DGCLAW_SLUG invalido: {slug!r}")
    plugin = os.environ.get("DGCLAW_PLUGIN_ROOT") or f"{ws}/.dgclaw/plugin"
    dgdir = Path(ws) / ".dgclaw"
    return {
        "slug": slug,
        "ws": ws,
        "plugin": plugin,
        "config": os.path.abspath(os.environ["DGCLAW_CONFIG"]) if os.environ.get("DGCLAW_CONFIG") else "",
        "dgdir": dgdir,
        "manifest": dgdir / "self-crons.json",
        "backup_dir": dgdir / "backups" / "self-crons",
        "tz": os.environ.get("DGCLAW_TZ") or fuso_sem_config(),
        "cap": int(os.environ.get("DGCLAW_SELF_CRON_CAP", "10")),
        "n_backups": int(os.environ.get("DGCLAW_SELF_CRON_BACKUPS", "20")),
        "notify": os.environ.get("DGCLAW_SELF_CRON_NOTIFY", "0") == "1",
        # diretorio das unit-files. /etc/systemd/system em prod; sobrescrevivel em teste.
        "unit_dir": os.environ.get("DGCLAW_SYSTEMD_DIR", "/etc/systemd/system"),
    }


# ─── nomes / fronteira do bloco ───────────────────────────────────────────────

def unit_base(slug: str, name: str) -> str:
    """O nome-base (sem .timer/.service) de um cron self. ESTE prefixo e a fronteira:
    nada fora de `dgclaw-<slug>-self-` e tocado por este programa."""
    return f"dgclaw-{slug}-{SELF_INFIX}-{name}"


def is_self_unit(slug: str, unit: str) -> bool:
    """Guard-rail: a unit pertence ao bloco self da persona deste slug?"""
    return unit.startswith(f"dgclaw-{slug}-{SELF_INFIX}-")


def assert_in_block(slug: str, name: str):
    """Recusa qualquer name que escaparia do bloco. Defesa em profundidade (alem do NAME_RE)."""
    base = unit_base(slug, name)
    if not is_self_unit(slug, base):
        die(f"name {name!r} escaparia do bloco self do slug {slug!r} — recusado")


# ─── lock do manifesto (serializa read-modify-write) ──────────────────────────

@contextmanager
def manifest_lock(c):
    """Lock exclusivo por-slug em volta do ciclo read->validate->write do manifesto.
    Sem ele, dois `create` concorrentes (ex.: a persona dispara duas tools) leem a mesma
    versao e o segundo write sobrescreve o primeiro -> um cron some. flock e liberado no
    finally. Em duvida (lock indisponivel), nao roda a mutacao."""
    c["dgdir"].mkdir(parents=True, exist_ok=True)
    lock_path = c["dgdir"] / ".self-crons.lock"
    fh = open(lock_path, "w")
    chown_dono(c, c["dgdir"])
    chown_dono(c, lock_path)
    deadline = time.monotonic() + 30
    while True:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() > deadline:
                fh.close()
                die("nao consegui o lock do manifesto a tempo (outra operacao em andamento) — tente de novo")
            time.sleep(0.5)
    try:
        yield
    finally:
        try:
            fcntl.flock(fh, fcntl.LOCK_UN)
        finally:
            fh.close()


# ─── manifesto (com marcadores + backup) ──────────────────────────────────────

def read_manifest(c) -> dict:
    """Le o manifesto declarativo. Tolera ausente (primeiro uso) e arquivo cercado por
    marcadores (extrai so o miolo JSON entre BEGIN/END)."""
    mf: Path = c["manifest"]
    if not mf.exists():
        return {"slug": c["slug"], "crons": {}}
    raw = mf.read_text(encoding="utf-8")
    begin = MARKER_BEGIN.format(slug=c["slug"])
    if begin in raw and MARKER_END in raw:
        inner = raw.split(begin, 1)[1].split(MARKER_END, 1)[0]
    else:
        inner = raw  # arquivo legado sem marcadores: trata o todo como JSON
    inner = inner.strip()
    if not inner:
        return {"slug": c["slug"], "crons": {}}
    try:
        data = json.loads(inner)
    except json.JSONDecodeError as e:
        die(f"manifesto corrompido ({mf}): {e}. Restaure de {c['backup_dir']} ou apague.")
    data.setdefault("slug", c["slug"])
    data.setdefault("crons", {})
    return data


def backup_manifest(c):
    """Snapshot timestampado ANTES de qualquer escrita. Rotaciona pra n_backups."""
    mf: Path = c["manifest"]
    if not mf.exists():
        return None
    bdir: Path = c["backup_dir"]
    bdir.mkdir(parents=True, exist_ok=True)
    chown_dono(c, bdir.parent)
    chown_dono(c, bdir)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    dst = bdir / f"{stamp}.json"
    dst.write_text(mf.read_text(encoding="utf-8"), encoding="utf-8")
    chown_dono(c, dst)
    # rotacao
    backups = sorted(bdir.glob("*.json"))
    excess = len(backups) - c["n_backups"]
    for old in backups[:max(0, excess)]:
        try:
            old.unlink()
        except OSError:
            pass
    return dst


def write_manifest(c, data: dict):
    """Escreve o manifesto cercado por marcadores. Sempre faz backup antes (se ja existia).
    Escrita atomica (tmp + rename)."""
    backup_manifest(c)
    mf: Path = c["manifest"]
    mf.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(data, indent=2, ensure_ascii=False)
    content = (
        MARKER_BEGIN.format(slug=c["slug"]) + "\n"
        + body + "\n"
        + MARKER_END + "\n"
    )
    tmp = mf.with_suffix(".json.tmp")
    tmp.write_text(content, encoding="utf-8")
    chown_dono(c, tmp)
    os.replace(tmp, mf)


# ─── validacao ────────────────────────────────────────────────────────────────

def validate_name(name: str):
    if not name or not NAME_RE.match(name):
        die(f"name invalido: {name!r} (kebab-case [a-z0-9-], 3-40 chars)")


def validate_schedule(calendar: str | None, every: str | None):
    if bool(calendar) == bool(every):
        die("escolha UM: --calendar '<OnCalendar>' OU --every '<30min|6h|2d>'")
    if calendar is not None:
        if not CALENDAR_SAFE_RE.match(calendar):
            die(f"OnCalendar com chars suspeitos: {calendar!r}")
        if len(calendar) > 100:
            die("OnCalendar longo demais")
    if every is not None and not EVERY_RE.match(every):
        die(f"--every invalido: {every!r} (ex: 30min, 6h, 90s, 2d)")


def systemd_versao() -> int:
    """Versao do systemd (so o numero). 0 se nao der pra saber."""
    try:
        out = subprocess.run(["systemctl", "--version"], capture_output=True, text=True, timeout=10).stdout
        m = re.search(r"systemd (\d+)", out)
        return int(m.group(1)) if m else 0
    except Exception:
        return 0


def carimbar_fuso(calendar: str, tz: str) -> str:
    """
    Gruda o fuso do DONO no proprio OnCalendar ('*-*-* 17:00:00 America/Sao_Paulo').

    PORQUE: sem o carimbo, o systemd interpreta o horario no fuso da MAQUINA, e VPS costuma
    nascer em UTC. Ai o dono pede 17h e a rotina dispara 14h (ou o assistente "converte" na
    mao e marca 20h). Com o fuso escrito na unit, a hora que o dono falou e a hora que
    acontece, mesmo que alguem mexa no relogio do servidor depois.

    Suportado a partir do systemd 252. Em systemd mais velho o carimbo faria a unit ser
    recusada, entao devolvemos o horario como veio (e nesse caso o fuso da maquina e que
    manda, motivo pelo qual o wizard confere o relogio na instalacao).
    """
    if not tz or " " + tz in calendar or calendar.endswith(tz):
        return calendar
    if systemd_versao() < 252:
        log_err(f"systemd antigo (<252): nao da pra carimbar o fuso {tz} na rotina. "
                f"O horario vale no fuso da maquina; confira com: timedatectl")
        return calendar
    return f"{calendar} {tz}"


def conferir_no_systemd(calendar: str) -> str | None:
    """
    Pergunta ao systemd se ele entendeu o horario, ANTES de escrever a unit, e devolve a
    proxima vez que a rotina vai rodar (texto pronto pra mostrar ao dono).

    Horario que o systemd nao entende vira timer que nunca dispara e ninguem percebe. Melhor
    recusar aqui, com a mensagem dele, do que criar um compromisso morto.
    """
    try:
        r = subprocess.run(["systemd-analyze", "calendar", calendar],
                           capture_output=True, text=True, timeout=10)
    except FileNotFoundError:
        return None  # sem systemd-analyze: seguimos sem a conferencia
    except Exception:
        return None
    if r.returncode != 0:
        die(f"o systemd nao entendeu o horario {calendar!r}: "
            f"{(r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else 'formato invalido'}")
    for linha in r.stdout.splitlines():
        if "Next elapse:" in linha:
            return linha.split("Next elapse:", 1)[1].strip()
    return None


def validate_poke(poke: str):
    if not poke or not poke.strip():
        die("--poke vazio (e o TEXTO que a persona vai receber na sessao viva quando o cron dispara)")
    if len(poke) > 1000:
        die("--poke longo demais (max 1000 chars)")
    if "\x00" in poke:
        die("--poke com NUL")


# ─── geracao das units systemd ────────────────────────────────────────────────

def exec_line(c, poke: str) -> str:
    """A linha ExecStart de um cron self. NUNCA roda comando arbitrario: so chama o inject.py
    do plugin com o texto-poke. O config.sh e sourciado pra exportar os DGCLAW_* que o
    inject.py le (slug, modo, etc).

    Passa --require-idle: a rotina agendada nao pode digitar por cima de um turno em voo. Nos
    modos tiocsti/tmux o inject.py sai com 75 quando a sessao esta ocupada e NAO injeta; o
    .service gerado por install_units manda o systemd tentar de novo (RestartForceExitStatus=75).
    No modo bunker o proprio painel enfileira a mensagem ate a sessao ficar livre."""
    inject = f"{c['plugin']}/scripts/_lib/inject.py"
    cfg = c["config"]
    src = f"set -a; source {shlex.quote(cfg)}; set +a; " if cfg else ""
    # --slug e passado explicito (alem do env) pra robustez; o texto vai como argumento unico.
    # --envelope: cron self da persona tambem e poke, e nao a pessoa falando. Sem o carimbo,
    # o hook de fim de turno le a rotina como se fosse o cliente e cobra resposta pelo canal.
    # "auto" so embrulha se o agente tiver canal, entao e inofensivo em agente sem canal.
    env_envelope = os.environ.get("DGCLAW_POKE_ENVELOPE", "auto")
    return (
        "/bin/bash -c " + shlex.quote(
            f"{src}exec python3 {shlex.quote(inject)} "
            f"--slug {shlex.quote(c['slug'])} --envelope {shlex.quote(env_envelope)} --require-idle {shlex.quote(poke)}"
        )
    )


def install_units(c, name: str, calendar: str | None, every: str | None, poke: str, desc: str):
    base = unit_base(c["slug"], name)
    Path(c["unit_dir"]).mkdir(parents=True, exist_ok=True)
    svc = Path(c["unit_dir"]) / f"{base}.service"
    tmr = Path(c["unit_dir"]) / f"{base}.timer"

    usuario, home = usuario_da_rotina(c)
    svc.write_text(
        "[Unit]\n"
        f"Description=DG Claw self-cron '{name}': {c['slug']}\n\n"
        "[Service]\n"
        "Type=simple\n"
        f"User={usuario}\n"
        f"Environment=HOME={home}\n"
        "Environment=IS_SANDBOX=1\n"
        f"Environment=TZ={c['tz']}\n"
        f"WorkingDirectory={c['ws']}\n"
        f"ExecStart={exec_line(c, poke)}\n"
        # Type=simple e nao oneshot: o systemd 255 RECUSA RestartForceExitStatus= em oneshot
        # ("which isn't allowed for Type=oneshot services. Refusing"); o programa sai logo, entao
        # na pratica se comporta igual. Testado com unit transiente (exit 75 duas vezes, depois 0).
        # Sessao ocupada (inject.py sai 75): sem isto o lembrete se perderia ate o proximo
        # disparo do timer. O 75 forca nova tentativa a cada 2 min ate a sessao ficar livre
        # (cada adiamento fica no journal com a frase "OCUPADA ... NAO injetei"). Sessao morta
        # (exit 2) e qualquer outra falha NAO entram aqui: falham de verdade, sem retry infinito.
        "RestartForceExitStatus=75\n"
        "RestartSec=120\n",
        encoding="utf-8",
    )

    timer = ["[Unit]", f"Description=DG Claw self-cron '{name}' (timer): {c['slug']}", "", "[Timer]"]
    if calendar:
        timer.append(f"OnCalendar={calendar}")
    if every:
        timer.append(f"OnUnitActiveSec={every}")
        timer.append("OnBootSec=5min")
    timer += ["Persistent=true", "", "[Install]", "WantedBy=timers.target", ""]
    tmr.write_text("\n".join(timer), encoding="utf-8")

    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", f"{base}.timer"])


def remove_units(c, name: str):
    base = unit_base(c["slug"], name)
    run(["systemctl", "disable", "--now", f"{base}.timer"], check=False)
    for ext in (".timer", ".service"):
        p = Path(c["unit_dir"]) / f"{base}{ext}"
        if p.exists():
            try:
                p.unlink()
            except OSError as e:
                log_err(f"nao removi {p}: {e}")
    run(["systemctl", "daemon-reload"], check=False)


def run(cmd, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        die(f"comando falhou ({' '.join(cmd)}): {r.stderr.strip() or r.stdout.strip()}")
    return r


# ─── notificacao (sempre via notify-owner.sh) ─────────────────────────────────

def notify(c, msg: str):
    if not c["notify"]:
        return
    script = f"{c['plugin']}/scripts/notify-owner.sh"
    if not os.path.isfile(script):
        log_err(f"notify pedido mas {script} ausente — pulei")
        return
    subprocess.run(["bash", script, msg], check=False, timeout=30)


# ─── comandos ─────────────────────────────────────────────────────────────────

def cmd_create(c, a, edit=False):
    validate_name(a.name)
    assert_in_block(c["slug"], a.name)
    validate_schedule(a.calendar, a.every)
    validate_poke(a.poke)

    # O horario do dono vira horario carimbado com o fuso dele, e o systemd confirma que
    # entendeu antes de a gente escrever qualquer coisa.
    proxima = None
    if a.calendar:
        a.calendar = carimbar_fuso(a.calendar, c["tz"])
        proxima = conferir_no_systemd(a.calendar)

    desc = a.desc or (f"self-cron {a.name}")
    entry = {
        "name": a.name,
        "calendar": a.calendar,
        "every": a.every,
        "poke": a.poke,
        "desc": desc,
        "unit": unit_base(c["slug"], a.name),
        "updated_utc": datetime.now(timezone.utc).isoformat(),
    }

    if a.dry_run:
        # dry-run nao muta: le sem lock so pra validar existencia/cap e reportar.
        data = read_manifest(c)
        exists = a.name in data["crons"]
        if not edit and exists:
            die(f"cron self '{a.name}' ja existe. Use 'edit' pra mudar, ou outro --name.")
        if edit and not exists:
            die(f"cron self '{a.name}' nao existe pra editar. Use 'create'.")
        if not edit and len(data["crons"]) >= c["cap"]:
            die(f"cap atingido: {len(data['crons'])}/{c['cap']} crons self. Remova um antes (persona-cron-mgr remove).")
        print(f"DRYRUN {'edit' if edit else 'create'} — unit={entry['unit']}")
        print(f"  schedule: {'OnCalendar='+a.calendar if a.calendar else 'OnUnitActiveSec='+a.every}")
        if proxima:
            print(f"  rodaria: {proxima}   (fuso do dono: {c['tz']})")
        print(f"  ExecStart: {exec_line(c, a.poke)}")
        return

    # read-validate-write sob lock exclusivo (anti-race: dois create concorrentes nao se sobrescrevem)
    with manifest_lock(c):
        data = read_manifest(c)
        exists = a.name in data["crons"]
        if not edit and exists:
            die(f"cron self '{a.name}' ja existe. Use 'edit' pra mudar, ou outro --name.")
        if edit and not exists:
            die(f"cron self '{a.name}' nao existe pra editar. Use 'create'.")
        if not edit:
            # CAP so vale pra novos
            n = sum(1 for _ in data["crons"])
            if n >= c["cap"]:
                die(f"cap atingido: {n}/{c['cap']} crons self. Remova um antes (persona-cron-mgr remove).")

        install_units(c, a.name, a.calendar, a.every, a.poke, desc)
        data["crons"][a.name] = entry
        write_manifest(c, data)

    verb = "editado" if edit else "criado"
    print(f"OK: cron self '{a.name}' {verb}")
    print(f"  unit:     {entry['unit']}.timer")
    print(f"  schedule: {'OnCalendar='+a.calendar if a.calendar else 'every '+a.every}")
    if proxima:
        print(f"  proxima:  {proxima}   (fuso do dono: {c['tz']})")
    print(f"  poke:     {a.poke}")
    print(f"  ativos:   {len(data['crons'])}/{c['cap']}")
    notify(c, f"🟢 self-cron '{a.name}' {verb} ({'OnCalendar='+a.calendar if a.calendar else 'a cada '+a.every}). "
              f"Ele vai cutucar a sessao viva com: {a.poke}")


def cmd_remove(c, a):
    validate_name(a.name)
    assert_in_block(c["slug"], a.name)
    if a.dry_run:
        data = read_manifest(c)
        if a.name not in data["crons"]:
            die(f"cron self '{a.name}' nao existe no manifesto.")
        print(f"DRYRUN remove — removeria unit {unit_base(c['slug'], a.name)} e a entrada do manifesto")
        return
    with manifest_lock(c):
        data = read_manifest(c)
        if a.name not in data["crons"]:
            die(f"cron self '{a.name}' nao existe no manifesto.")
        remove_units(c, a.name)
        del data["crons"][a.name]
        write_manifest(c, data)
    print(f"OK: cron self '{a.name}' removido ({len(data['crons'])}/{c['cap']} restantes)")
    notify(c, f"🗑️ self-cron '{a.name}' removido pela persona.")


def cmd_list(c, a):
    data = read_manifest(c)
    crons = data.get("crons", {})
    if a.json:
        print(json.dumps({"slug": c["slug"], "cap": c["cap"], "crons": crons}, indent=2, ensure_ascii=False))
        return
    if not crons:
        print(f"nenhum cron self (0/{c['cap']}). Crie com: persona-cron-mgr create --name <n> --calendar/--every ... --poke ...")
        return
    print(f"crons self da persona (slug={c['slug']}) — {len(crons)}/{c['cap']}:")
    for name, e in sorted(crons.items()):
        sched = f"OnCalendar={e['calendar']}" if e.get("calendar") else f"every {e.get('every')}"
        unit = e.get("unit", unit_base(c["slug"], name))
        active = run(["systemctl", "is-active", f"{unit}.timer"], check=False).stdout.strip()
        print(f"  • {name}  [{sched}]  ({active})")
        print(f"      poke: {e.get('poke','')}")


def main():
    ap = argparse.ArgumentParser(
        description="Gerencia os crons (timers systemd) PROPRIOS da pessoa virtual — bloco delimitado, cap, backup, validacao.")
    ap.add_argument("--config", help="caminho do config.sh do agente (carrega os DGCLAW_*)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_common(p):
        p.add_argument("--name", required=True, help="slug-name kebab-case do cron self")

    pc = sub.add_parser("create", help="cria um cron self novo")
    add_common(pc)
    pc.add_argument("--calendar", help="OnCalendar systemd (ex: '*-*-* 09:00:00', 'Mon..Fri 18:00')")
    pc.add_argument("--every", help="intervalo (ex: 30min, 6h, 2d) — alternativa a --calendar")
    pc.add_argument("--poke", required=True, help="TEXTO injetado na sessao viva quando disparar")
    pc.add_argument("--desc", help="descricao curta (opcional)")
    pc.add_argument("--dry-run", action="store_true")

    pe = sub.add_parser("edit", help="edita um cron self existente (mesma assinatura do create)")
    add_common(pe)
    pe.add_argument("--calendar")
    pe.add_argument("--every")
    pe.add_argument("--poke")
    pe.add_argument("--desc")
    pe.add_argument("--dry-run", action="store_true")

    pr = sub.add_parser("remove", help="remove um cron self")
    add_common(pr)
    pr.add_argument("--dry-run", action="store_true")

    pl = sub.add_parser("list", help="lista os crons self")
    pl.add_argument("--json", action="store_true")

    a = ap.parse_args()
    load_config(a.config)
    c = ctx()

    # create/edit/remove de verdade precisam de root; list e --dry-run nao.
    if a.cmd in ("create", "edit", "remove") and not a.dry_run:
        elevar_se_preciso(c)

    if a.cmd == "create":
        cmd_create(c, a, edit=False)
    elif a.cmd == "edit":
        # edit: pra campos nao passados, reaproveita os atuais do manifesto
        data = read_manifest(c)
        cur = data.get("crons", {}).get(a.name)
        if cur:
            if a.calendar is None and a.every is None:
                a.calendar, a.every = cur.get("calendar"), cur.get("every")
            if a.poke is None:
                a.poke = cur.get("poke")
            if a.desc is None:
                a.desc = cur.get("desc")
        cmd_create(c, a, edit=True)
    elif a.cmd == "remove":
        cmd_remove(c, a)
    elif a.cmd == "list":
        cmd_list(c, a)


if __name__ == "__main__":
    main()
