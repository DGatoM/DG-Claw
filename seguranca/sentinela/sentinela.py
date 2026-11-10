#!/usr/bin/env python3
"""Sentinela do servidor do DG Claw (docs/SENTINELA.md, especificação em docs/interno/SENTINELA-ESPEC.md).

Só biblioteca padrão, roda como root com `python3 -I`. Uma rodada por minuto (timer do systemd) mede disco, memória,
agentes e serviços, avisa o dono por Telegram, e-mail, painel e Admin, e faz as limpezas do catálogo fechado
(faxina.json). Nunca reinicia agente nem serviço: ela avisa e diz o comando.

Todos os caminhos aceitam o prefixo DGCLAW_RAIZ (testes em raiz falsa). As variáveis DGCLAW_SENTINELA_FALSO,
DGCLAW_SENTINELA_AGORA e DGCLAW_SENTINELA_FALHA_ESCRITA só valem com DGCLAW_SENTINELA_TESTE=1.
"""
import datetime as dt
import errno
import fcntl
import fnmatch
import json
import os
import re
import secrets
import shutil
import signal
import smtplib
import socket
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage

AQUI = os.path.dirname(os.path.abspath(__file__))
NIVEIS = ["ok", "aviso", "serio", "critico"]
ROTULO = {"aviso": "AVISO", "serio": "SÉRIO", "critico": "CRÍTICO", "ok": "RESOLVIDO"}
EMOJI = {"aviso": "🟡", "serio": "🟠", "critico": "🔴", "ok": "✅"}
PRAZO_RODADA = 45
GB = 1024 ** 3
MB = 1024 ** 2
SERVICOS_SERVIDOR = ["dgclaw-web", "dgclaw-admin", "caddy"]
PONTOS_DISCO = ["/", "/var/lib/dgclaw", "/var/lib/containers", "/var/log", "/tmp", "/home"]
PASTAS_MEDIDAS = ["/var/lib/containers", "/var/log", "/tmp", "/var/tmp", "/root", "/home", "/opt"]
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
TOKEN_TG_RE = re.compile(r"\d{5,20}:[A-Za-z0-9_-]{30,60}")
EMAIL_RE = re.compile(r"^[^@\s,;<>]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$")

PADROES = {
    "NOME_SERVIDOR": "", "DISCO_AVISO": 75, "DISCO_SERIO": 85, "DISCO_CRITICO": 92, "DISCO_EXTREMO": 97,
    "RAM_AVISO": 85, "RAM_SERIO": 92, "RAM_CRITICO": 96, "RESERVA_GB": 2.0, "FAXINA_AUTOMATICA": 1,
    "ALIVIO_RAM_AUTOMATICO": 1, "REPETIR_AVISO_MIN": 360, "REPETIR_SERIO_MIN": 60, "REPETIR_CRITICO_MIN": 10,
    "AGENTE_CAIDO_RODADAS": 2, "TELEGRAM_TOKEN": "", "TELEGRAM_CHATS": "", "EMAIL_SMTP_HOST": "",
    "EMAIL_SMTP_PORTA": 587, "EMAIL_USUARIO": "", "EMAIL_SENHA": "", "EMAIL_DE": "", "EMAIL_PARA": "", "PULSO_URL": "",
}
SEGREDOS = ("TELEGRAM_TOKEN", "EMAIL_SENHA", "PULSO_URL")
LIMIARES = ("DISCO_AVISO", "DISCO_SERIO", "DISCO_CRITICO", "DISCO_EXTREMO", "RAM_AVISO", "RAM_SERIO", "RAM_CRITICO")
_SEGREDOS_ATIVOS = []
_PRAZO = {"fim": None}
_EVENTOS = []
_FAKE = {"dados": None, "lido": False}


class PrazoEsgotado(Exception):
    """Não herda de OSError de propósito: as escritas protegidas não podem engolir o estouro do tempo da rodada."""


class ErroSentinela(Exception):
    """Falha que a pessoa precisa entender: o que falhou, com que entrada, o que fazer."""

    def __init__(self, msg, fazer="veja a mensagem acima."):
        super().__init__(msg)
        self.fazer = fazer


# --- ambiente, caminhos, relógio ---------------------------------------------------------------

def teste():
    return os.environ.get("DGCLAW_SENTINELA_TESTE") == "1"


def raiz():
    r = os.environ.get("DGCLAW_RAIZ", "")
    if r and not os.path.isabs(r):
        raise ErroSentinela(f"DGCLAW_RAIZ ({r[:80]!r}) não é um caminho absoluto.", "use um caminho começando com / ou apague a variável.")
    return r


def P(*partes):
    return raiz() + "/" + "/".join(p.strip("/") for p in partes)


def caminhos():
    return {
        "conf": P("etc/dgclaw/sentinela.conf"), "env": P("etc/dgclaw/dgclaw.env"), "agentes": P("etc/dgclaw/agentes.json"),
        "token_admin": P("etc/dgclaw/runner/admin.token"),
        "estado": P("var/lib/dgclaw/sentinela/estado.json"), "historico": P("var/lib/dgclaw/sentinela/historico.jsonl"),
        "trava": P("var/lib/dgclaw/sentinela/.trava"), "dir_estado": P("var/lib/dgclaw/sentinela"),
        "painel": P("var/lib/dgclaw/web/sentinela/estado.json"), "dir_painel": P("var/lib/dgclaw/web/sentinela"),
        "reserva": P("var/lib/dgclaw/reserva/balao.bin"), "dir_reserva": P("var/lib/dgclaw/reserva"),
        "log": P("var/log/dgclaw/sentinela.log"), "faxina": os.path.join(AQUI, "faxina.json"),
        "comandos_teste": P("var/lib/dgclaw/sentinela/comandos-teste.log"),
    }


def agora():
    if teste() and os.environ.get("DGCLAW_SENTINELA_AGORA"):
        try:
            return float(os.environ["DGCLAW_SENTINELA_AGORA"])
        except ValueError:
            raise ErroSentinela(f"DGCLAW_SENTINELA_AGORA ({os.environ['DGCLAW_SENTINELA_AGORA'][:30]!r}) não é um número.", "use os segundos desde 1970.")
    return time.time()


def iso(ts):
    return dt.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def hora_curta(ts):
    return dt.datetime.fromtimestamp(ts).strftime("%d/%m %H:%M")


def fake():
    if not teste() or not os.environ.get("DGCLAW_SENTINELA_FALSO"):
        return None
    if not _FAKE["lido"]:
        caminho = os.environ["DGCLAW_SENTINELA_FALSO"]
        try:
            with open(caminho, encoding="utf-8") as f:
                _FAKE["dados"] = json.load(f)
        except (OSError, ValueError) as e:
            raise ErroSentinela(f"não consegui ler as medições falsas em {caminho} ({e}).", "corrija o JSON ou apague DGCLAW_SENTINELA_FALSO.")
        _FAKE["lido"] = True
    return _FAKE["dados"]


def restante():
    fim = _PRAZO["fim"]
    return 9999 if fim is None else fim - time.time()


# --- segredos, texto limpo, log ----------------------------------------------------------------

def registra_segredos(cfg):
    _SEGREDOS_ATIVOS.clear()
    for k in SEGREDOS:
        v = str(cfg.get(k) or "")
        if len(v) >= 4:
            _SEGREDOS_ATIVOS.append((k, v))


def limpa(texto, limite=300):
    """Última defesa: nenhum segredo sai em log, estado, JSON ou erro, mesmo que alguém esqueça de tirá-lo."""
    t = str(texto)
    for chave, valor in _SEGREDOS_ATIVOS:
        if chave == "PULSO_URL":
            host = urllib.parse.urlparse(valor).hostname or "?"
            t = t.replace(valor, f"<pulso {host}>")
            sem_esquema = valor.split("://", 1)[-1]
            t = t.replace(sem_esquema, f"<pulso {host}>")
        else:
            t = t.replace(valor, "<senha do e-mail>" if chave == "EMAIL_SENHA" else "<token do Telegram>")
    t = TOKEN_TG_RE.sub("<token do Telegram>", t)
    t = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", t).replace("\n", " ").replace("\r", " ")
    return t[:limite]


def ev(texto):
    """Evento para o log (gravado no fim da rodada, protegido)."""
    _EVENTOS.append(f"{iso(agora())} {limpa(texto, 500)}")


def stderr(texto):
    print(f"[sentinela] {limpa(texto, 600)}", file=sys.stderr)


def falha_escrita_simulada():
    return teste() and os.environ.get("DGCLAW_SENTINELA_FALHA_ESCRITA") == "1"


# --- escrita atômica ---------------------------------------------------------------------------

def garante_pasta(caminho, modo):
    """Cria a pasta com o modo pedido; uma pasta que já existe fica como está (nunca afrouxa permissão alheia)."""
    if not os.path.isdir(caminho):
        os.makedirs(caminho, mode=modo, exist_ok=True)
        os.chmod(caminho, modo)


def grava_atomico(caminho, texto, modo, modo_pasta=0o700):
    if falha_escrita_simulada():
        raise OSError(errno.ENOSPC, "No space left on device (simulado)")
    pasta = os.path.dirname(caminho)
    garante_pasta(pasta, modo_pasta)
    tmp = f"{caminho}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, modo)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(texto)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, modo)
        os.rename(tmp, caminho)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def anexa_linhas(caminho, linhas, modo=0o600, modo_pasta=0o700, teto=1_000_000, manter=500):
    if falha_escrita_simulada():
        raise OSError(errno.ENOSPC, "No space left on device (simulado)")
    garante_pasta(os.path.dirname(caminho), modo_pasta)
    try:
        if os.path.getsize(caminho) > teto:
            with open(caminho, encoding="utf-8", errors="replace") as f:
                resto = f.readlines()[-manter:]
            grava_atomico(caminho, "".join(resto), modo, modo_pasta)
    except FileNotFoundError:
        pass
    fd = os.open(caminho, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, modo)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write("".join(l + "\n" for l in linhas))
    os.chmod(caminho, modo)


def protegido(descricao, fn):
    """Roda uma escrita. Se falhar (disco cheio ou outra), registra em stderr e devolve a causa; nunca derruba a rodada."""
    try:
        fn()
        return None
    except OSError as e:
        causa = "disco cheio" if e.errno == errno.ENOSPC else (e.strerror or str(e))
        stderr(f"não consegui gravar {descricao}: {causa}. Libere espaço em disco ou confira as permissões de {raiz() or '/'}var/lib/dgclaw.")
        return causa


# --- configuração ------------------------------------------------------------------------------

def _inteiro(minimo, maximo):
    def v(t):
        if not re.fullmatch(r"\d{1,9}", t):
            raise ValueError(f"precisa ser um número inteiro entre {minimo} e {maximo}")
        n = int(t)
        if not minimo <= n <= maximo:
            raise ValueError(f"precisa ficar entre {minimo} e {maximo}")
        return n
    return v


def _zero_um(t):
    if t not in ("0", "1"):
        raise ValueError("use 0 (desligado) ou 1 (ligado)")
    return int(t)


def _gb(t):
    if not re.fullmatch(r"\d{1,3}(\.\d{1,3})?", t):
        raise ValueError("use um número como 2 ou 0.5 (0 desliga a reserva)")
    n = float(t)
    if n > 100:
        raise ValueError("no máximo 100")
    return n


def _texto(maximo):
    def v(t):
        if len(t) > maximo or re.search(r"[\x00-\x1f\x7f]", t):
            raise ValueError(f"texto simples de até {maximo} caracteres, sem quebra de linha")
        return t
    return v


def _token(t):
    if not re.fullmatch(r"\d{5,20}:[A-Za-z0-9_-]{30,60}", t):
        raise ValueError("não tem o formato de um token do BotFather (números, dois-pontos e letras)")
    return t


def _chats(t):
    itens = [x.strip() for x in t.split(",") if x.strip()]
    if not itens or len(itens) > 20:
        raise ValueError("informe de 1 a 20 ids separados por vírgula")
    for i in itens:
        if not re.fullmatch(r"-?\d{1,20}", i):
            raise ValueError("cada id de chat é um número (pode começar com -)")
    return ",".join(itens)


def _host(t):
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", t):
        raise ValueError("endereço do servidor de e-mail inválido (ex.: smtp.gmail.com)")
    return t


def _email(t):
    if not EMAIL_RE.match(t):
        raise ValueError("e-mail inválido")
    return t


def _emails(t):
    itens = [x.strip() for x in t.split(",") if x.strip()]
    if not itens or len(itens) > 10:
        raise ValueError("informe de 1 a 10 e-mails separados por vírgula")
    for i in itens:
        _email(i)
    return ",".join(itens)


def _url(t):
    try:
        u = urllib.parse.urlparse(t)
    except ValueError:
        raise ValueError("endereço inválido")
    if len(t) > 500 or re.search(r"\s", t):
        raise ValueError("endereço longo demais ou com espaço")
    local = teste() and u.scheme == "http" and u.hostname == "127.0.0.1"
    if u.scheme != "https" and not local:
        raise ValueError("precisa começar com https://")
    if not u.hostname:
        raise ValueError("faltou o nome do servidor")
    if u.username or u.password:
        raise ValueError("não pode ter usuário nem senha dentro do endereço")
    return t


VALIDADORES = {
    "NOME_SERVIDOR": _texto(80), "DISCO_AVISO": _inteiro(1, 99), "DISCO_SERIO": _inteiro(1, 99),
    "DISCO_CRITICO": _inteiro(1, 99), "DISCO_EXTREMO": _inteiro(1, 99), "RAM_AVISO": _inteiro(1, 99),
    "RAM_SERIO": _inteiro(1, 99), "RAM_CRITICO": _inteiro(1, 99), "RESERVA_GB": _gb, "FAXINA_AUTOMATICA": _zero_um,
    "ALIVIO_RAM_AUTOMATICO": _zero_um, "REPETIR_AVISO_MIN": _inteiro(1, 100000), "REPETIR_SERIO_MIN": _inteiro(1, 100000),
    "REPETIR_CRITICO_MIN": _inteiro(1, 100000), "AGENTE_CAIDO_RODADAS": _inteiro(1, 60), "TELEGRAM_TOKEN": _token,
    "TELEGRAM_CHATS": _chats, "EMAIL_SMTP_HOST": _host, "EMAIL_SMTP_PORTA": _inteiro(1, 65535), "EMAIL_USUARIO": _texto(200),
    "EMAIL_SENHA": _texto(200), "EMAIL_DE": _email, "EMAIL_PARA": _emails, "PULSO_URL": _url,
}


def _tira_aspas(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    return v


def ordem_limiares_ok(cfg):
    d = [cfg[k] for k in ("DISCO_AVISO", "DISCO_SERIO", "DISCO_CRITICO", "DISCO_EXTREMO")]
    r = [cfg[k] for k in ("RAM_AVISO", "RAM_SERIO", "RAM_CRITICO")]
    return all(a < b for a, b in zip(d, d[1:])) and all(a < b for a, b in zip(r, r[1:]))


def ler_pares(caminho):
    """Lê o sentinela.conf como texto (nunca executa). Devolve ({chave: valor_texto}, [problemas])."""
    pares, problemas = {}, []
    try:
        with open(caminho, encoding="utf-8", errors="replace") as f:
            linhas = f.read().splitlines()
    except FileNotFoundError:
        return pares, problemas
    except OSError as e:
        raise ErroSentinela(f"não consegui ler {caminho} ({e.strerror or e}).", "confira a permissão do arquivo (deve ser 600, dono root).")
    for n, linha in enumerate(linhas, 1):
        s = linha.strip()
        if not s or s.startswith("#"):
            continue
        m = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", s)
        if not m:
            problemas.append(f"linha {n} de {caminho} não é CHAVE=valor; ignorei.")
            continue
        pares[m.group(1)] = _tira_aspas(m.group(2))
    return pares, problemas


def ler_config(caminho=None):
    """Devolve (cfg completa com padrões, problemas). Valor inválido: padrão e o motivo, nunca o valor de um segredo."""
    caminho = caminho or caminhos()["conf"]
    pares, problemas = ler_pares(caminho)
    cfg = dict(PADROES)
    for chave, texto in pares.items():
        if chave not in PADROES:
            problemas.append(f"chave desconhecida {chave} em {caminho}; ignorei.")
            continue
        if texto == "":
            continue
        try:
            cfg[chave] = VALIDADORES[chave](texto)
        except ValueError as e:
            problemas.append(f"valor de {chave} em {caminho} recusado ({e}); usei o padrão." if chave in SEGREDOS
                             else f"valor {texto[:40]!r} de {chave} em {caminho} recusado ({e}); usei o padrão.")
    if not ordem_limiares_ok(cfg):
        problemas.append("os limiares de disco e memória precisam ficar em ordem crescente (aviso < sério < crítico < extremo); voltei todos ao padrão.")
        for k in LIMIARES:
            cfg[k] = PADROES[k]
    registra_segredos(cfg)
    return cfg, problemas


def nome_servidor(cfg):
    if cfg["NOME_SERVIDOR"]:
        return cfg["NOME_SERVIDOR"]
    try:
        with open(caminhos()["env"], encoding="utf-8", errors="replace") as f:
            for linha in f:
                m = re.fullmatch(r"\s*DGCLAW_DOMINIO=(.*)", linha.rstrip("\n"))
                if m and _tira_aspas(m.group(1)):
                    return _tira_aspas(m.group(1))[:80]
    except OSError:
        pass
    return socket.gethostname()


def configurar():
    """CHAVE=valor pela entrada padrão (nunca por argumento: apareceria no ps e no histórico do shell)."""
    novos = {}
    for n, linha in enumerate(sys.stdin.read().splitlines(), 1):
        s = linha.strip()
        if not s or s.startswith("#"):
            continue
        m = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", s)
        if not m:
            raise ErroSentinela(f"a linha {n} da entrada não é CHAVE=valor.", "mande uma linha por chave, assim: printf 'TELEGRAM_CHATS=123456\\n' | sudo dgclaw sentinela configurar")
        chave, texto = m.group(1), _tira_aspas(m.group(2))
        if chave not in PADROES:
            raise ErroSentinela(f"a chave {chave} (linha {n}) não existe na sentinela.", "as chaves válidas: " + ", ".join(PADROES))
        if texto != "":
            try:
                VALIDADORES[chave](texto)
            except ValueError as e:
                shown = "" if chave in SEGREDOS else f" ({texto[:40]!r})"
                raise ErroSentinela(f"valor de {chave}{shown} recusado: {e}. Nada foi gravado.", f"corrija o valor de {chave} e mande de novo.")
        novos[chave] = texto
    if not novos:
        raise ErroSentinela("a entrada veio vazia: não recebi nenhum CHAVE=valor.", "exemplo: printf 'TELEGRAM_CHATS=123456\\n' | sudo dgclaw sentinela configurar")
    caminho = caminhos()["conf"]
    pares, _ = ler_pares(caminho)
    teste_cfg = dict(PADROES)
    for k, v in {**pares, **novos}.items():
        if k in PADROES and v != "":
            try:
                teste_cfg[k] = VALIDADORES[k](v)
            except ValueError:
                pass
    if not ordem_limiares_ok(teste_cfg):
        raise ErroSentinela("com esses valores os limiares ficariam fora de ordem (aviso < sério < crítico < extremo). Nada foi gravado.",
                            "ajuste os números de DISCO_* e RAM_* para ficarem crescentes e mande de novo.")
    try:
        with open(caminho, encoding="utf-8", errors="replace") as f:
            linhas = f.read().splitlines()
    except FileNotFoundError:
        linhas = []
    except OSError as e:
        raise ErroSentinela(f"não consegui ler {caminho} ({e.strerror or e}).", "confira a permissão do arquivo (deve ser 600, dono root).")
    ja = set()
    for i, l in enumerate(linhas):
        m = re.fullmatch(r"\s*([A-Z][A-Z0-9_]*)=.*", l)
        if m and m.group(1) in novos:
            linhas[i] = f"{m.group(1)}={novos[m.group(1)]}"
            ja.add(m.group(1))
    for k, v in novos.items():
        if k not in ja:
            linhas.append(f"{k}={v}")
    try:
        grava_atomico(caminho, "\n".join(linhas) + "\n", 0o600, 0o755)
    except OSError as e:
        raise ErroSentinela(f"não consegui gravar {caminho} ({e.strerror or e}).", "libere espaço no disco ou confira as permissões e tente de novo.")
    print("Gravei: " + ", ".join(novos) + f" em {caminho}.")
    return 0


# --- comandos externos -------------------------------------------------------------------------

def cmd(args, timeout=10):
    """Roda um comando sem shell. Devolve (código, saída). Em teste, só registra e responde com o JSON falso."""
    if fake() is not None:
        return cmd_falso(args)
    t = max(1, min(timeout, restante() - 1)) if _PRAZO["fim"] else timeout
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=t, stdin=subprocess.DEVNULL,
                           env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        return r.returncode, r.stdout
    except FileNotFoundError:
        return 127, ""
    except subprocess.TimeoutExpired as e:
        saida = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return 124, saida
    except OSError as e:
        return 126, f"{e}"


def cmd_falso(args):
    f = fake()
    try:
        garante_pasta(caminhos()["dir_estado"], 0o700)
        with open(caminhos()["comandos_teste"], "a", encoding="utf-8") as lg:
            lg.write(" ".join(args) + "\n")
    except OSError:
        pass
    pod = f.get("podman", {})
    a = list(args)
    if a[:2] == ["podman", "inspect"]:
        slug = a[-1].replace("dgclaw-", "", 1)
        st = pod.get("inspect", {}).get(slug, "running")
        return (125, "") if st == "ausente" else (0, st + "\n")
    if a[:2] == ["podman", "stats"]:
        return 0, json.dumps(pod.get("stats", []))
    if a[:2] == ["podman", "exec"] and len(a) >= 6 and a[3] == "systemctl":
        slug = a[2].replace("dgclaw-", "", 1)
        info = pod.get("exec", {}).get(slug, {})
        if a[4] == "is-enabled":
            v = info.get("enabled", "disabled")
            return (0 if v == "enabled" else 1), v + "\n"
        if a[4] == "is-active":
            v = info.get("active", "active")
            return (0 if v == "active" else 3), v + "\n"
        return 0, ""
    if a[:2] == ["systemctl", "is-active"]:
        v = f.get("servicos", {}).get(a[-1], False if a[-1] == "dgclaw-ronda.service" else True)
        return (0, "active\n") if v else (3, "inactive\n")
    if a[:2] == ["systemctl", "cat"]:
        padrao = a[-1] in SERVICOS_SERVIDOR if "servicos" not in f else a[-1] in f["servicos"]
        return (0, "") if padrao else (1, "")
    if "du" in a:
        pastas = f.get("pastas", {})
        linhas = [f"{b}\t{p}" for p, b in pastas.items()]
        return 0, "\n".join(linhas) + ("\n" if linhas else "")
    return 0, ""


def existe_servico(nome):
    rc, _ = cmd(["systemctl", "cat", nome], 5)
    return rc == 0


def servico_ativo(nome):
    rc, saida = cmd(["systemctl", "is-active", nome], 5)
    return saida.strip() == "active"


# --- HTTP, Telegram, e-mail, pulso -------------------------------------------------------------

class _SemRedirecionar(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def http(url, metodo="GET", dados=None, cabecalhos=None, timeout=10):
    """Devolve (status, corpo). Não segue redirecionamento. Levanta OSError com motivo legível se não houver resposta."""
    req = urllib.request.Request(url, data=dados, method=metodo, headers=cabecalhos or {})
    opener = urllib.request.build_opener(_SemRedirecionar)
    t = max(1, min(timeout, restante() - 1)) if _PRAZO["fim"] else timeout
    try:
        with opener.open(req, timeout=t) as r:
            return r.status, r.read(65536).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            corpo = e.read(2000).decode("utf-8", "replace")
        except OSError:
            corpo = ""
        return e.code, corpo
    except urllib.error.URLError as e:
        raise OSError(f"sem resposta ({e.reason})")
    except (socket.timeout, TimeoutError):
        raise OSError("tempo esgotado")


def base_telegram():
    v = os.environ.get("DGCLAW_SENTINELA_TELEGRAM_API", "")
    if v and (v.startswith("https://") or re.fullmatch(r"http://127\.0\.0\.1:\d{1,5}", v)):
        return v.rstrip("/")
    if v:
        stderr("DGCLAW_SENTINELA_TELEGRAM_API ignorada: só vale https:// ou http://127.0.0.1:<porta>.")
    return "https://api.telegram.org"


def envia_telegram(cfg, texto):
    """(ok, motivo). Todos os chats; ok se ao menos um recebeu."""
    chats = [c for c in cfg["TELEGRAM_CHATS"].split(",") if c]
    ok, motivos = 0, []
    for c in chats:
        corpo = urllib.parse.urlencode({"chat_id": c, "text": texto[:4000]}).encode()
        try:
            st, resp = http(f"{base_telegram()}/bot{cfg['TELEGRAM_TOKEN']}/sendMessage", "POST", corpo,
                            {"Content-Type": "application/x-www-form-urlencoded"}, 10)
        except OSError as e:
            motivos.append(f"chat {c}: {limpa(e, 120)}")
            continue
        if 200 <= st < 300:
            ok += 1
        else:
            desc = ""
            try:
                desc = json.loads(resp).get("description", "")
            except (ValueError, AttributeError):
                pass
            motivos.append(f"chat {c}: o Telegram respondeu {st} {limpa(desc, 100)}".strip())
    return ok > 0, "; ".join(motivos)


def envia_email(cfg, texto):
    para = [x for x in cfg["EMAIL_PARA"].split(",") if x]
    msg = EmailMessage()
    msg["Subject"] = texto.splitlines()[0][:200] if texto else "Aviso da sentinela"
    msg["From"] = cfg["EMAIL_DE"]
    msg["To"] = ", ".join(para)
    msg.set_content(texto)
    host, porta = cfg["EMAIL_SMTP_HOST"], int(cfg["EMAIL_SMTP_PORTA"])
    try:
        if teste() and host in ("127.0.0.1", "localhost"):
            s = smtplib.SMTP(host, porta, timeout=15)
        elif porta == 465:
            s = smtplib.SMTP_SSL(host, porta, timeout=15, context=ssl.create_default_context())
        else:
            s = smtplib.SMTP(host, porta, timeout=15)
            s.ehlo()
            s.starttls(context=ssl.create_default_context())
            s.ehlo()
        with s:
            if cfg["EMAIL_USUARIO"] and cfg["EMAIL_SENHA"]:
                s.login(cfg["EMAIL_USUARIO"], cfg["EMAIL_SENHA"])
            s.send_message(msg)
        return True, ""
    except (smtplib.SMTPException, OSError) as e:
        return False, limpa(f"{type(e).__name__}: {e}", 200)


def envia_pulso(cfg, falha_texto=None):
    url = cfg["PULSO_URL"]
    try:
        if falha_texto is None:
            st, _ = http(url, "GET", None, None, 10)
        else:
            st, _ = http(url.rstrip("/") + "/fail", "POST", falha_texto.encode("utf-8")[:4000], {"Content-Type": "text/plain; charset=utf-8"}, 10)
    except OSError as e:
        return False, limpa(e, 150)
    return (200 <= st < 300), ("" if 200 <= st < 300 else f"o serviço de pulso respondeu {st}")


def avisa_admin(cfg, texto):
    try:
        with open(caminhos()["token_admin"], encoding="utf-8") as f:
            token = f.read().strip()
    except OSError as e:
        return False, f"não li o token do Admin em {caminhos()['token_admin']} ({e.strerror or e})"
    if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{8,512}", token):
        return False, f"o token do Admin em {caminhos()['token_admin']} não tem o formato esperado"
    base = os.environ.get("DGCLAW_ADMIN_URL", "http://127.0.0.1:4300")
    u = urllib.parse.urlparse(base)
    if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost"):
        return False, "recusei mandar o token do Admin para fora da máquina"
    try:
        st, _ = http(base.rstrip("/") + "/api/agents/admin/input", "POST",
                     json.dumps({"text": texto, "injectWhenIdle": True}).encode(),
                     {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}, 10)
    except OSError as e:
        return False, limpa(e, 150)
    return (200 <= st < 300), ("" if 200 <= st < 300 else f"o Admin respondeu {st}")


def canais_configurados(cfg):
    return {
        "telegram": bool(cfg["TELEGRAM_TOKEN"] and cfg["TELEGRAM_CHATS"]),
        "email": bool(cfg["EMAIL_SMTP_HOST"] and cfg["EMAIL_DE"] and cfg["EMAIL_PARA"]),
        "pulso": bool(cfg["PULSO_URL"]),
        "admin": os.path.exists(caminhos()["token_admin"]),
    }


# --- medições ----------------------------------------------------------------------------------

def nivel_de(pct, lim):
    n = 0
    for i, l in enumerate(lim, 1):
        if pct >= l:
            n = i
    return n


def com_histerese(pct, lim, anterior):
    """Sobe na hora; desce só quando fica 3 pontos abaixo do limiar do nível atual."""
    bruto = nivel_de(pct, lim)
    if bruto >= anterior:
        return bruto
    n = anterior
    while n > 0 and pct < lim[n - 1] - 3:
        n -= 1
    return max(n, bruto)


def medir_disco():
    f = fake()
    if f is not None and "disco" in f:
        dev_reserva = None
        try:
            dev_reserva = os.stat(caminhos()["dir_reserva"]).st_dev
        except OSError:
            pass
        out = []
        for d in f["disco"]:
            tot = float(d.get("total_gb", 40.0))
            pct = float(d["usado_pct"])
            out.append({"ponto": d["ponto"], "usado_pct": pct, "livre_gb": float(d.get("livre_gb", round(tot * (100 - pct) / 100, 1))),
                        "total_gb": tot, "inodes_pct": float(d.get("inodes_pct", 0.0)),
                        "dev": dev_reserva if d["ponto"] in ("/", "/var/lib/dgclaw") else -1})
        return out
    vistos, out = set(), []
    for p in PONTOS_DISCO:
        caminho = (raiz() or "/") if p == "/" else P(p)
        try:
            sv, st = os.statvfs(caminho), os.stat(caminho)
        except OSError:
            continue
        if st.st_dev in vistos:
            continue
        vistos.add(st.st_dev)
        usado = sv.f_blocks - sv.f_bfree
        total = usado + sv.f_bavail
        pct = usado / total * 100 if total else 0.0
        ino = (sv.f_files - sv.f_ffree) / sv.f_files * 100 if sv.f_files else 0.0
        out.append({"ponto": p, "usado_pct": round(pct, 1), "livre_gb": round(sv.f_bavail * sv.f_frsize / GB, 1),
                    "total_gb": round(total * sv.f_frsize / GB, 1), "inodes_pct": round(ino, 1), "dev": st.st_dev})
    return out


def pior_pct(discos):
    return max([max(d["usado_pct"], d["inodes_pct"]) for d in discos] or [0.0])


def medir_ram():
    f = fake()
    if f is not None and "ram" in f:
        r = f["ram"]
        return {"usado_pct": float(r["usado_pct"]), "disponivel_mb": int(r.get("disponivel_mb", 1000)),
                "total_mb": int(r.get("total_mb", 8000)), "swap_pct": float(r.get("swap_pct", 0)), "processos": r.get("processos", [])}
    info = {}
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for l in fh:
                m = re.match(r"(\w+):\s+(\d+)", l)
                if m:
                    info[m.group(1)] = int(m.group(2))
        total, disp = info["MemTotal"], info["MemAvailable"]
    except (OSError, KeyError) as e:
        raise ErroSentinela(f"não consegui ler /proc/meminfo ({e}).", "confira se o /proc está montado.")
    sw_t, sw_l = info.get("SwapTotal", 0), info.get("SwapFree", 0)
    return {"usado_pct": round((total - disp) / total * 100, 1), "disponivel_mb": disp // 1024, "total_mb": total // 1024,
            "swap_pct": round((sw_t - sw_l) / sw_t * 100, 1) if sw_t else 0.0, "processos": None}


def processos_ram():
    """Os 5 que mais usam memória: soma de RSS por nome (como o vigia da ronda)."""
    soma = {}
    try:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open(f"/proc/{pid}/status", encoding="utf-8", errors="replace") as f:
                    txt = f.read()
            except OSError:
                continue
            nome = re.search(r"^Name:\s+(.+)$", txt, re.M)
            rss = re.search(r"^VmRSS:\s+(\d+)", txt, re.M)
            if nome and rss:
                soma[nome.group(1)] = soma.get(nome.group(1), 0) + int(rss.group(1)) // 1024
    except OSError:
        return []
    return sorted(([n, mb] for n, mb in soma.items()), key=lambda x: -x[1])[:5]


def ler_agentes():
    try:
        with open(caminhos()["agentes"], encoding="utf-8") as f:
            dados = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        ev(f"não consegui ler o registro de agentes {caminhos()['agentes']} ({e}); sem ele não sei quais agentes vigiar.")
        return []
    out = []
    for a in dados.get("agentes", []):
        if a.get("tipo") != "agente" or not SLUG_RE.match(str(a.get("slug", ""))):
            continue
        out.append({"slug": a["slug"], "nome": a.get("nome") or a["slug"], "runner": str(a.get("runner", "")),
                    "container": a.get("container") or f"dgclaw-{a['slug']}"})
    return out


def consulta_runner(ag):
    """(ok, motivo_registro). Só fala com a própria máquina."""
    f = fake()
    if f is not None and "runners" in f:
        return f["runners"].get(ag["slug"], "ok") == "ok", ""
    r = ag["runner"]
    u = urllib.parse.urlparse(r if "://" in r else "//" + r)
    if u.hostname not in ("127.0.0.1", "localhost") or not u.port:
        return None, "registro com endereço fora da máquina"
    try:
        st, _ = http(f"http://127.0.0.1:{u.port}/api/saude", "GET", None, None, 3)
    except OSError:
        return False, ""
    return 200 <= st < 300, ""


def motivo_container(ag):
    rc, saida = cmd(["podman", "inspect", "-f", "{{.State.Status}}", ag["container"]], 10)
    estado = saida.strip()
    if rc != 0 or not estado:
        return "container não existe"
    if estado == "running":
        return "container ligado mas o programa do agente não responde"
    return "container parado"


def comando_para(ag, motivo):
    if motivo == "container não existe":
        return "peça ao Admin para recriar o agente"
    return f"sudo dgclaw agente reiniciar {ag['slug']}"


# --- limpeza de arquivos (à prova de link simbólico) -------------------------------------------

def _dev(st):
    return st.st_dev


def espaco_livre():
    try:
        sv = os.statvfs(raiz() or "/")
        return sv.f_bavail * sv.f_frsize
    except OSError:
        return 0


def apagar_velhos(raizes, padroes, dias, pular, simular=False, agora_ts=None):
    """Apaga (ou só soma) arquivos regulares mais velhos que `dias`. Usa os.fwalk (dir_fd, sem seguir link) e unlink pelo
    dir_fd: se alguém trocar uma pasta por um link no meio do caminho, nada fora dela é tocado. Devolve (bytes, quantos)."""
    limite = (agora_ts or time.time()) - dias * 86400
    total, qtd = 0, 0
    for r in raizes:
        topo = P(r)
        try:
            dev_raiz = _dev(os.lstat(topo))
        except OSError:
            continue
        try:
            for _, dirnomes, arquivos, fd in os.fwalk(topo, topdown=True, follow_symlinks=False):
                manter = []
                for d in dirnomes:
                    if any(fnmatch.fnmatch(d, p) for p in pular):
                        continue
                    try:
                        if _dev(os.stat(d, dir_fd=fd, follow_symlinks=False)) != dev_raiz:
                            continue
                    except OSError:
                        continue
                    manter.append(d)
                dirnomes[:] = manter
                for nome in arquivos:
                    if not any(fnmatch.fnmatch(nome, p) for p in padroes) or any(fnmatch.fnmatch(nome, p) for p in pular):
                        continue
                    try:
                        st = os.stat(nome, dir_fd=fd, follow_symlinks=False)
                    except OSError:
                        continue
                    if not stat.S_ISREG(st.st_mode) or _dev(st) != dev_raiz or st.st_mtime >= limite:
                        continue
                    if not simular:
                        try:
                            os.unlink(nome, dir_fd=fd)
                        except OSError as e:
                            ev(f"não apaguei {topo}/{nome}: {e.strerror or e}")
                            continue
                    total += st.st_size
                    qtd += 1
        except OSError as e:
            ev(f"não consegui percorrer {topo} para a faxina ({e.strerror or e}).")
    return total, qtd


def _abre_filho(fd, nome, rotulo):
    try:
        return os.open(nome, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    except FileNotFoundError:
        return None
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.ENOTDIR):
            try:
                eh_link = stat.S_ISLNK(os.stat(nome, dir_fd=fd, follow_symlinks=False).st_mode)
            except OSError:
                eh_link = False
            ev(f"pulei {rotulo}: é um link simbólico" if eh_link else f"pulei {rotulo}: não é uma pasta")
        else:
            ev(f"pulei {rotulo}: {e.strerror or e}")
        return None


def _tamanho_dir(fd_pai, nome):
    soma = 0
    try:
        for _, _, arqs, fd in os.fwalk(nome, dir_fd=fd_pai, follow_symlinks=False):
            for a in arqs:
                try:
                    soma += os.stat(a, dir_fd=fd, follow_symlinks=False).st_size
                except OSError:
                    pass
    except OSError:
        pass
    return soma


def _casa(fd, parte):
    if not any(c in parte for c in "*?["):
        return [parte]
    try:
        return [n for n in sorted(os.listdir(fd)) if fnmatch.fnmatch(n, parte)]
    except OSError:
        return []


def _percorre(fd, partes, rotulo, simular):
    total = 0
    for nome in _casa(fd, partes[0]):
        rot = f"{rotulo}/{nome}" if rotulo else nome
        if len(partes) == 1:
            try:
                st = os.stat(nome, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            except OSError as e:
                ev(f"pulei {rot}: {e.strerror or e}")
                continue
            if stat.S_ISLNK(st.st_mode):
                ev(f"pulei {rot}: é um link simbólico")
            elif not stat.S_ISDIR(st.st_mode):
                ev(f"pulei {rot}: não é uma pasta")
            elif simular:
                total += _tamanho_dir(fd, nome)
            else:
                antes = _tamanho_dir(fd, nome)
                try:
                    shutil.rmtree(nome, dir_fd=fd)
                    total += antes
                except OSError as e:
                    ev(f"não consegui apagar {rot} por inteiro: {e.strerror or e}")
        else:
            fdc = _abre_filho(fd, nome, rot)
            if fdc is None:
                continue
            try:
                total += _percorre(fdc, partes[1:], rot, simular)
            finally:
                os.close(fdc)
    return total


def limpar_cache_agentes(item, simular=False):
    """Casas dos agentes: descer com O_NOFOLLOW e dir_fd, componente por componente, e apagar com rmtree(dir_fd)."""
    if not shutil.rmtree.avoids_symlink_attacks:
        ev("o item cache-agente não rodou: este Python não tem o rmtree à prova de link simbólico (shutil.rmtree.avoids_symlink_attacks é falso).")
        return 0
    base = P(item["base"])
    try:
        fd_base = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return 0
    except OSError as e:
        ev(f"não consegui abrir {base} para a faxina dos agentes ({e.strerror or e}).")
        return 0
    total = 0
    try:
        for slug in sorted(os.listdir(fd_base)):
            fd_slug = _abre_filho(fd_base, slug, slug)
            if fd_slug is None:
                continue
            try:
                fd_casa = _abre_filho(fd_slug, item["casa"], f"{slug}/{item['casa']}")
                if fd_casa is None:
                    continue
                try:
                    for caminho in item["caminhos"]:
                        total += _percorre(fd_casa, caminho.split("/"), slug, simular)
                finally:
                    os.close(fd_casa)
            finally:
                os.close(fd_slug)
    finally:
        os.close(fd_base)
    return total


def ler_catalogo():
    caminho = caminhos()["faxina"]
    try:
        with open(caminho, encoding="utf-8") as f:
            dados = json.load(f)
        itens = dados["itens"]
        assert isinstance(itens, list)
        return itens
    except (OSError, ValueError, KeyError, AssertionError) as e:
        raise ErroSentinela(f"não consegui ler o catálogo da faxina em {caminho} ({e}).", "a cópia do DG Claw está incompleta: rode sudo dgclaw atualizar ou o instalador de novo.")


REMOTOS = ("fuse", "nfs", "cifs", "smb", "sshfs", "9p", "overlay")
LOCAIS = ("ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "zfs")


def ler_montagens():
    """[(ponto_de_montagem_do_sistema, tipo)] de /proc/mounts (em raiz falsa, de <raiz>/proc/mounts)."""
    caminho = P("proc/mounts") if raiz() else "/proc/mounts"
    out = []
    try:
        with open(caminho, encoding="utf-8", errors="replace") as f:
            for l in f:
                p = l.split()
                if len(p) >= 3:
                    mp = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), p[1])
                    out.append((mp, p[2]))
    except OSError as e:
        if raiz() == "":
            ev(f"não consegui ler {caminho} ({e.strerror or e}); não sei quais pastas são montagens remotas.")
    return out


def montagens_remotas():
    """Pontos de montagem fuse/nfs/cifs/sshfs/9p/overlay. Um rclone montado parece ocupar disco, não ocupa, e o du nele trava."""
    return [mp for mp, t in ler_montagens() if mp != "/" and t.startswith(REMOTOS)]


def no_sistema(caminho):
    """Caminho como o sistema o vê (sem o prefixo da raiz falsa dos testes)."""
    return caminho[len(raiz()):] or "/" if raiz() and caminho.startswith(raiz()) else caminho


def dentro_de(caminho, base):
    base = base.rstrip("/")
    return caminho == base or caminho.startswith(base + "/")


def filtra_alvos(alvos, remotos):
    """(alvos que valem a pena medir, [motivos das puladas]). Pula montagem remota, o que não existe e o que já está dentro
    de outro alvo do mesmo sistema de arquivos (não soma a mesma pasta duas vezes)."""
    puladas, validos = [], []
    for a in alvos:
        sis = no_sistema(a)
        mont = next((mp for mp in remotos if dentro_de(sis, mp)), None)
        if mont:
            puladas.append(f"{sis}: é montagem remota ({mont}), o du nela trava e não ocupa disco desta máquina")
            continue
        try:
            if os.path.islink(a) and not os.path.isdir(a):
                continue
            validos.append((os.path.realpath(a), os.stat(a).st_dev, a))
        except OSError:
            continue
    validos.sort(key=lambda x: len(x[0]))
    mantidos = []
    for real, dev, a in validos:
        if any(dev == d2 and dentro_de(real, r2) for r2, d2, _ in mantidos):
            puladas.append(f"{no_sistema(a)}: já está dentro de outra pasta medida")
            continue
        mantidos.append((real, dev, a))
    return [a for _, _, a in mantidos], puladas


def du_bytes(caminhos_, timeout=20, extra=None, excluir=()):
    """Um du (com nice/ionice) numa lista de caminhos. Devolve ({caminho: bytes}, completou)."""
    base = ["nice", "-n", "19", "ionice", "-c3", "du", "-x"] + (extra if extra else ["-s"]) + ["-B1"]
    base += [f"--exclude={x}" for x in excluir]
    rc, saida = cmd(base + ["--"] + list(caminhos_), timeout)
    res = {}
    for l in saida.splitlines():
        m = re.match(r"(\d+)\s+(.+)$", l)
        if m:
            res[m.group(2)] = int(m.group(1))
    return res, rc != 124


def du_por_pasta(alvos, total_s, por_pasta_s, extra=None):
    """Um du por pasta, cada um com o seu tempo, dentro de um orçamento total. Devolve (resultado, completo, puladas)."""
    remotos = montagens_remotas()
    alvos, puladas = filtra_alvos(alvos, remotos)
    fim = time.time() + total_s
    res, completo = {}, True
    for a in alvos:
        sobra = fim - time.time()
        if sobra < 2:
            puladas.append(f"{no_sistema(a)}: acabou o tempo da medição")
            completo = False
            continue
        r, ok = du_bytes([a], min(por_pasta_s, sobra), extra, [mp for mp in remotos if dentro_de(mp, no_sistema(a))])
        res.update(r)
        if not ok:
            completo = False
            puladas.append(f"{no_sistema(a)}: a medição passou do tempo e ficou parcial")
    return res, completo, puladas


def estima_item(item):
    """Quanto o item liberaria, em bytes (None se não dá para estimar)."""
    t = item["tipo"]
    if t == "apagar-velhos":
        return apagar_velhos(item["raizes"], item["padroes"], item["dias"], item.get("pular", []), simular=True)[0]
    if t == "cache-agente":
        return limpar_cache_agentes(item, simular=True)
    if t == "journal-vacuum":
        r, _ = du_bytes([P("var/log/journal")], 20)
        return max(0, sum(r.values()) - 500 * MB) if r else None
    if t == "apt-clean":
        r, _ = du_bytes([P("var/cache/apt/archives")], 20)
        return sum(r.values()) if r else None
    if t == "podman-prune-dangling":
        rc, s = cmd(["podman", "images", "--filter", "dangling=true", "--format", "json"], 20)
        try:
            return sum(int(i.get("Size", 0)) for i in json.loads(s)) if rc == 0 else None
        except (ValueError, AttributeError, TypeError):
            return None
    return None


def executa_item(item, timeout):
    """Roda um item do catálogo. Devolve a descrição do que fez; só tipos conhecidos, nunca comando livre."""
    t = item["tipo"]
    if t == "journal-vacuum":
        rc, _ = cmd(["journalctl", "--vacuum-size=500M"], timeout)
    elif t == "apt-clean":
        rc, _ = cmd(["apt-get", "clean"], timeout)
    elif t == "podman-prune-dangling":
        rc, _ = cmd(["podman", "image", "prune", "-f"], timeout)
    elif t == "apagar-velhos":
        apagar_velhos(item["raizes"], item["padroes"], item["dias"], item.get("pular", []))
        rc = 0
    elif t == "cache-agente":
        limpar_cache_agentes(item)
        rc = 0
    else:
        raise ErroSentinela(f"o item {item.get('id')} do catálogo tem tipo desconhecido ({t!r}).", "o catálogo só muda por versão nova do DG Claw.")
    return rc


def faxinar_agora(ids=None, executar=True):
    """Roda (ou simula) o catálogo. Devolve lista de {id, descricao, liberou_mb, ok, pulado}; respeita o prazo da rodada."""
    itens = ler_catalogo()
    resultado = []
    for item in itens:
        if ids is not None and item["id"] not in ids:
            continue
        if not executar:
            est = estima_item(item)
            resultado.append({"id": item["id"], "descricao": item["descricao"], "estimativa_mb": None if est is None else round(est / MB, 1)})
            continue
        if _PRAZO["fim"] and restante() < 8:
            resultado.append({"id": item["id"], "descricao": item["descricao"], "liberou_mb": 0, "ok": False, "pulado": True})
            continue
        antes = espaco_livre()
        try:
            rc = executa_item(item, 30)
        except ErroSentinela as e:
            ev(str(e))
            resultado.append({"id": item["id"], "descricao": item["descricao"], "liberou_mb": 0, "ok": False, "pulado": False})
            continue
        lib = max(0, espaco_livre() - antes)
        if rc != 0:
            ev(f"faxina {item['id']}: o comando terminou com código {rc}.")
        resultado.append({"id": item["id"], "descricao": item["descricao"], "liberou_mb": round(lib / MB, 1), "ok": rc == 0, "pulado": False})
    return resultado


# --- reserva de disco --------------------------------------------------------------------------

def tamanho_reserva(cfg, discos):
    ponto = next((d for d in discos if d["ponto"] == "/var/lib/dgclaw"), None) or next((d for d in discos if d["ponto"] == "/"), None)
    gb = cfg["RESERVA_GB"]
    if ponto:
        gb = min(gb, ponto["total_gb"] * 0.05)
    return gb, ponto


def reserva_existe():
    try:
        return os.path.getsize(caminhos()["reserva"]) > 0
    except OSError:
        return False


def apaga_reserva():
    """Devolve os bytes liberados (0 se não havia reserva). Não escreve nada: é a primeira coisa quando o disco está lotado."""
    try:
        tam = os.path.getsize(caminhos()["reserva"])
        os.unlink(caminhos()["reserva"])
        return tam
    except FileNotFoundError:
        return 0
    except OSError as e:
        stderr(f"não consegui apagar a reserva {caminhos()['reserva']} ({e.strerror or e}).")
        return 0


def cria_reserva(cfg, discos):
    """(ok, motivo). Cria com posix_fallocate (blocos de verdade) só se o uso depois dela ficar abaixo de DISCO_AVISO."""
    if cfg["RESERVA_GB"] <= 0:
        return False, "a reserva está desligada (RESERVA_GB=0)"
    gb, ponto = tamanho_reserva(cfg, discos)
    if ponto is None:
        return False, "não consegui medir o disco de /var/lib/dgclaw"
    if gb <= 0:
        return False, "o disco é pequeno demais para uma reserva"
    depois = ponto["usado_pct"] + gb / ponto["total_gb"] * 100 if ponto["total_gb"] else 100
    if depois >= cfg["DISCO_AVISO"]:
        return False, f"com a reserva o disco ficaria em {depois:.0f}% (o aviso começa em {cfg['DISCO_AVISO']}%)"
    caminho = caminhos()["reserva"]
    if falha_escrita_simulada():
        return False, "disco cheio (simulado)"
    try:
        garante_pasta(os.path.dirname(caminho), 0o700)
        fd = os.open(caminho, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        try:
            os.posix_fallocate(fd, 0, int(gb * GB))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(caminho, 0o600)
    except OSError as e:
        try:
            os.unlink(caminho)
        except OSError:
            pass
        return False, f"não consegui reservar {gb:.1f} GB ({e.strerror or e})"
    return True, f"{gb:.1f}".replace(".", ",") + " GB"


# --- estado interno ----------------------------------------------------------------------------

def estado_inicial():
    return {"versao": 1, "rodadas": 0, "disco": {"nivel": 0}, "ram": {"nivel": 0, "subindo": 0, "criticas": 0},
            "agentes": {}, "servicos": {}, "notificado": {}, "ultimo_aviso_em": None, "problema_desde": None, "seq": 0,
            "aviso": None, "pendente": None, "faxina": {"ultima": None, "restantes": []},
            "alivio": {"ronda": False, "chrome": {}}, "reserva": {"criada_em": None, "liberada_em": None, "abaixo_desde": None},
            "pastas": None, "acoes": [], "canais": {"ultimo_envio_ok": None, "ultima_falha": None}, "config_hash": None}


def carrega_estado():
    caminho = caminhos()["estado"]
    base = estado_inicial()
    try:
        with open(caminho, encoding="utf-8") as f:
            dados = json.load(f)
        for k, v in base.items():
            dados.setdefault(k, v)
        return dados
    except FileNotFoundError:
        return base
    except (OSError, ValueError) as e:
        ev(f"o estado interno {caminho} estava ilegível ({e}); recomecei do zero.")
        return base


def fmt_gb(x):
    return f"{x:.1f}".replace(".", ",")


def fmt_bytes(b):
    if b >= GB:
        return f"{b / GB:.1f}".replace(".", ",") + " GB"
    return f"{b / MB:.0f} MB"


def duracao(seg):
    m = int(seg // 60)
    if m < 60:
        return f"{max(m, 1)} min"
    h, m = divmod(m, 60)
    return f"{h} h" + (f" {m} min" if m else "")


# --- rodada ------------------------------------------------------------------------------------

def maiores_pastas(est, agora_ts):
    cache = est.get("pastas")
    if cache and agora_ts - cache["em"] < 1800 and cache.get("lista") is not None:
        return cache["lista"], cache.get("completo", True)
    alvos = [P("var/lib/dgclaw/agentes")] + [P(x) for x in PASTAS_MEDIDAS]
    res, completo, puladas = du_por_pasta(alvos, 20, 8)
    for p in puladas:
        ev(f"maiores pastas: pulei {p}")
    lista = [{"caminho": no_sistema(c), "gb": round(b / GB, 1)} for c, b in sorted(res.items(), key=lambda x: -x[1])[:5]]
    est["pastas"] = {"em": agora_ts, "lista": lista, "completo": completo and bool(res)}
    return lista, completo and bool(res)


def etiqueta_nivel(n):
    return NIVEIS[n]


def rodar():
    cfg, problemas = ler_config()
    t0 = time.time()
    _PRAZO["fim"] = t0 + PRAZO_RODADA
    c = caminhos()
    # Disco lotado: a reserva sai ANTES de qualquer escrita (até criar a trava é escrever). É o que devolve fôlego ao resto.
    discos = medir_disco()
    reserva_liberada = 0
    if any(max(d["usado_pct"], d["inodes_pct"]) >= cfg["DISCO_EXTREMO"] for d in discos) and reserva_existe():
        reserva_liberada = apaga_reserva()
    # trava: outra rodada viva = sai sem fazer nada
    trava = None
    try:
        garante_pasta(c["dir_estado"], 0o700)
        trava = os.open(c["trava"], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(trava, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0
    except OSError as e:
        stderr(f"não consegui criar a trava {c['trava']} ({e.strerror or e}); sigo sem ela.")
        trava = None

    def _alarme(*_):
        raise PrazoEsgotado("a rodada passou do limite de tempo")

    signal.signal(signal.SIGALRM, _alarme)
    signal.alarm(PRAZO_RODADA + 8)
    try:
        return _rodada(cfg, problemas, discos, reserva_liberada)
    except PrazoEsgotado as e:
        stderr(f"{e}: parei a rodada; a próxima começa do zero.")
        return 0
    finally:
        signal.alarm(0)
        if trava is not None:
            os.close(trava)


def _rodada(cfg, problemas, discos, reserva_liberada):
    c = caminhos()
    agora_ts = agora()
    pior = pior_pct(discos)
    est = carrega_estado()
    est["rodadas"] += 1
    if problemas:
        h = "|".join(problemas)
        if h != est.get("config_hash"):
            for p in problemas:
                ev(f"configuração: {p}")
        est["config_hash"] = h
    else:
        est["config_hash"] = None
    mudancas, acoes = [], []
    if reserva_liberada > 0:
        est["reserva"]["liberada_em"] = agora_ts
        acoes.append({"em": agora_ts, "tipo": "reserva", "descricao": f"liberei a reserva de emergência de {fmt_bytes(reserva_liberada)}",
                      "texto": f"liberei a reserva de emergência de {fmt_bytes(reserva_liberada)}. Isso compra tempo, não resolve: libere espaço agora"})
        ev(f"reserva liberada ({fmt_bytes(reserva_liberada)}): o disco passou de {cfg['DISCO_EXTREMO']}%.")

    ram = medir_ram()
    # --- níveis de disco e RAM
    lim_d = [cfg["DISCO_AVISO"], cfg["DISCO_SERIO"], cfg["DISCO_CRITICO"]]
    lim_r = [cfg["RAM_AVISO"], cfg["RAM_SERIO"], cfg["RAM_CRITICO"]]
    nd_ant = est["disco"]["nivel"]
    nd = com_histerese(pior, lim_d, nd_ant)
    est["disco"]["nivel"] = nd
    if nd != nd_ant:
        ev(f"disco: {NIVEIS[nd_ant]} -> {NIVEIS[nd]} ({pior:.0f}%).")
    nr_ant = est["ram"]["nivel"]
    bruto_r = nivel_de(ram["usado_pct"], lim_r)
    if bruto_r > nr_ant:
        est["ram"]["subindo"] += 1
        nr = bruto_r if est["ram"]["subindo"] >= 2 else nr_ant
    else:
        est["ram"]["subindo"] = 0
        nr = com_histerese(ram["usado_pct"], lim_r, nr_ant)
    est["ram"]["nivel"] = nr
    if nr != nr_ant:
        ev(f"memória: {NIVEIS[nr_ant]} -> {NIVEIS[nr]} ({ram['usado_pct']:.0f}%).")
    est["ram"]["criticas"] = est["ram"]["criticas"] + 1 if nr == 3 else 0
    for k, (ant, atual) in {"disco": (nd_ant, nd), "ram": (nr_ant, nr)}.items():
        if atual > est["notificado"].get(k, 0):
            mudancas.append(("subida", k))

    # --- agentes
    agentes = ler_agentes()
    vistos = set()
    painel_agentes = []
    rodada_canal = est["rodadas"] % 5 == 0
    for ag in agentes:
        slug = ag["slug"]
        vistos.add(slug)
        s = est["agentes"].setdefault(slug, {"falhas": 0, "estado": "ok", "desde": None, "motivo": "", "canal": "ok", "canal_desde": None})
        ok, motivo_reg = consulta_runner(ag)
        if ok is None:
            s["estado"], s["motivo"] = "desconhecido", motivo_reg
        elif ok:
            s["falhas"] = 0
            if s["estado"] == "caido":
                mudancas.append(("voltou", slug))
                ev(f"agente {slug} voltou a responder.")
            if s["estado"] in ("caido", "desconhecido"):
                s["estado"], s["desde"], s["motivo"] = "ok", None, ""
        else:
            s["falhas"] += 1
            if s["falhas"] >= cfg["AGENTE_CAIDO_RODADAS"] and s["estado"] != "caido":
                s["estado"], s["desde"] = "caido", agora_ts
                s["motivo"] = motivo_container(ag)
                mudancas.append(("caiu", slug))
                ev(f"agente {slug} fora do ar: {s['motivo']}.")
        if rodada_canal and s["estado"] != "caido":
            rc, st = cmd(["podman", "inspect", "-f", "{{.State.Status}}", ag["container"]], 10)
            if rc == 0 and st.strip() == "running":
                rc1, o1 = cmd(["podman", "exec", ag["container"], "systemctl", "is-enabled", "dgclaw-whatsapp.service"], 10)
                if o1.strip() == "enabled":
                    rc2, o2 = cmd(["podman", "exec", ag["container"], "systemctl", "is-active", "dgclaw-whatsapp.service"], 10)
                    parado = o2.strip() != "active"
                else:
                    parado = False
                if parado and s["canal"] == "ok":
                    s["canal"], s["canal_desde"] = "caido", agora_ts
                    mudancas.append(("canal", slug))
                    ev(f"agente {slug}: o canal do WhatsApp parou.")
                elif not parado and s["canal"] == "caido":
                    s["canal"], s["canal_desde"] = "ok", None
                    mudancas.append(("canal_voltou", slug))
                    ev(f"agente {slug}: o canal do WhatsApp voltou.")
    for slug in list(est["agentes"]):
        if slug not in vistos:
            del est["agentes"][slug]
    for ag in agentes:
        s = est["agentes"][ag["slug"]]
        if s["estado"] == "caido":
            estado, motivo, desde = "caido", s["motivo"], s["desde"]
        elif s["canal"] == "caido":
            estado, motivo, desde = "canal_caido", "o WhatsApp do agente parou: os clientes não recebem resposta", s["canal_desde"]
        else:
            estado, motivo, desde = s["estado"], s["motivo"], None
        painel_agentes.append({"slug": ag["slug"], "nome": ag["nome"], "estado": estado, "desde": iso(desde) if desde else None, "motivo": motivo})
    agentes_mal = [a for a in painel_agentes if a["estado"] in ("caido", "canal_caido")]

    # --- serviços
    painel_servicos = []
    servicos_mal = []
    for nome in SERVICOS_SERVIDOR:
        if not existe_servico(nome):
            continue
        ativo = servico_ativo(nome)
        s = est["servicos"].setdefault(nome, {"inativo": 0, "caido": False})
        if ativo:
            if s["caido"]:
                mudancas.append(("servico_voltou", nome))
                ev(f"serviço {nome} voltou.")
            s["inativo"], s["caido"] = 0, False
        else:
            s["inativo"] += 1
            if s["inativo"] >= 2 and not s["caido"]:
                s["caido"] = True
                mudancas.append(("servico_caiu", nome))
                ev(f"serviço {nome} parado.")
        painel_servicos.append({"nome": nome, "ativo": ativo})
        if s["caido"]:
            servicos_mal.append(nome)

    geral = max(nd, nr, 3 if (agentes_mal or servicos_mal) else 0)
    dim_ag = 3 if (agentes_mal or servicos_mal) else 0
    if dim_ag > est["notificado"].get("agentes", 0):
        mudancas.append(("subida", "agentes"))

    # --- 6. ações automáticas
    ultima_faxina = est["faxina"]["ultima"]
    precisa_faxina = False
    if cfg["FAXINA_AUTOMATICA"] and nd >= 2:
        if est["faxina"]["restantes"] or nd_ant < 2 or ultima_faxina is None or agora_ts - ultima_faxina >= 6 * 3600:
            precisa_faxina = True
    if precisa_faxina:
        ids = est["faxina"]["restantes"] or None
        res = faxinar_agora(ids, True)
        est["faxina"]["restantes"] = [r["id"] for r in res if r.get("pulado")]
        est["faxina"]["ultima"] = agora_ts
        total_mb = sum(r.get("liberou_mb", 0) for r in res)
        for r in res:
            acoes.append({"em": agora_ts, "tipo": "faxina", "descricao": f"{r['id']}: liberou {r.get('liberou_mb', 0):.0f} MB" + (" (faltou tempo, fica para a próxima rodada)" if r.get("pulado") else ""),
                          "liberou_mb": r.get("liberou_mb", 0)})
        acoes.append({"em": agora_ts, "tipo": "faxina-resumo", "descricao": "", "texto": f"limpei caches e logs antigos (liberou {fmt_bytes(int(total_mb * MB))})"})
        ev(f"faxina automática: liberou {total_mb:.0f} MB.")
    # reserva
    if cfg["RESERVA_GB"] > 0 and not reserva_existe() and reserva_liberada == 0:
        if pior < cfg["DISCO_AVISO"] - 5:
            est["reserva"]["abaixo_desde"] = est["reserva"]["abaixo_desde"] or agora_ts
        else:
            est["reserva"]["abaixo_desde"] = None
        liberada = est["reserva"]["liberada_em"]
        pode = (liberada is None and pior < cfg["DISCO_AVISO"]) or (liberada is not None and est["reserva"]["abaixo_desde"] and agora_ts - est["reserva"]["abaixo_desde"] >= 1800)
        if pode and nd == 0:
            ok_r, mot = cria_reserva(cfg, discos)
            if ok_r:
                recriada = liberada is not None
                est["reserva"]["criada_em"], est["reserva"]["liberada_em"], est["reserva"]["abaixo_desde"] = agora_ts, None, None
                ev(f"reserva {'recriada' if recriada else 'criada'}: {mot}.")
                acoes.append({"em": agora_ts, "tipo": "reserva", "descricao": f"reserva {'recriada' if recriada else 'criada'} ({mot})",
                              "texto": f"recriei a reserva de emergência ({mot})" if recriada else None})
            elif est["reserva"].get("nao_criada") != mot:
                est["reserva"]["nao_criada"] = mot
                ev(f"não criei a reserva: {mot}.")
    elif reserva_existe():
        est["reserva"]["abaixo_desde"] = None
    # alívio de RAM
    if cfg["ALIVIO_RAM_AUTOMATICO"] and est["ram"]["criticas"] >= 3:
        alivio_ram(est, agentes, agora_ts, acoes)
    elif nr < 3:
        est["alivio"]["ronda"] = False

    # --- 5/7. decidir o aviso
    aviso = decide_aviso(cfg, est, mudancas, acoes, geral, nd, nr, pior, discos, ram, painel_agentes, agentes_mal, servicos_mal, agora_ts)
    for k, v in (("disco", nd), ("ram", nr), ("agentes", dim_ag)):
        est["notificado"][k] = v if aviso is not None or v < est["notificado"].get(k, 0) else est["notificado"].get(k, 0)
    est["acoes"] = (est["acoes"] + [{k: v for k, v in a.items() if k != "texto"} for a in acoes if a["tipo"] != "faxina-resumo"])[-20:]

    # Teste de escrita antes de avisar: o aviso precisa dizer "não consegui gravar" quando for o caso.
    falha_grav = protegido("o estado interno", lambda: grava_atomico(c["estado"], json.dumps(est, ensure_ascii=False), 0o600))
    if falha_grav and aviso is not None:
        aviso["corpo"] += "\n⚠️ Não consegui gravar o estado: " + ("disco cheio" if "cheio" in falha_grav else falha_grav) + "."
    elif falha_grav and aviso is None and geral > 0:
        pass

    # --- canais
    canais = canais_configurados(cfg)
    texto = None
    if aviso is not None:
        aviso["texto"] = monta_texto(cfg, aviso, agora_ts)
        est["seq"] += 1
        aviso["seq"] = est["seq"]
        est["ultimo_aviso_em"] = agora_ts
        est["aviso"] = {"seq": aviso["seq"], "nivel": aviso["nivel"], "titulo": aviso["titulo"], "corpo": aviso["corpo"], "em": iso(agora_ts)}
        texto = aviso["texto"]
        ev(f"aviso {aviso['nivel']} ({aviso['tipo']}): {aviso['titulo']}.")
    elif est.get("pendente"):
        texto = "(reenvio, a mensagem anterior não chegou)\n" + est["pendente"]["texto"]
    if texto:
        externo_ok = envia_canais(cfg, est, canais, texto, aviso, agora_ts, mudancas)
        tem_externo = canais["telegram"] or canais["email"]
        if aviso is not None:
            est["pendente"] = {"texto": texto} if (tem_externo and not externo_ok) else None
        elif externo_ok:
            est["pendente"] = None
    # pulso
    pulso_ok = None
    if canais["pulso"]:
        if geral == 3 or agentes_mal or servicos_mal:
            pulso_ok, mot = envia_pulso(cfg, resumo(cfg, nd, nr, pior, ram, agentes_mal, servicos_mal))
        else:
            pulso_ok, mot = envia_pulso(cfg)
        if not pulso_ok:
            falha_canal(est, "pulso", mot, agora_ts)

    # --- 9. gravar
    est["nivel_geral_nome"] = NIVEIS[geral]
    painel = monta_painel(cfg, est, discos, ram, painel_agentes, painel_servicos, canais, geral, nd, nr, agora_ts)
    falha_grav2 = protegido("o estado interno", lambda: grava_atomico(c["estado"], json.dumps(est, ensure_ascii=False), 0o600))
    protegido("o estado do painel", lambda: grava_atomico(c["painel"], json.dumps(painel, ensure_ascii=False, indent=2), 0o640, 0o750))
    linhas_hist = []
    for a in acoes:
        if a["tipo"] != "faxina-resumo":
            linhas_hist.append(json.dumps({"em": iso(a["em"]), "tipo": a["tipo"], "descricao": a["descricao"], **({"liberou_mb": a["liberou_mb"]} if "liberou_mb" in a else {})}, ensure_ascii=False))
    if aviso is not None:
        linhas_hist.append(json.dumps({"em": iso(agora_ts), "tipo": "aviso", "descricao": aviso["titulo"], "nivel": aviso["nivel"], "seq": aviso["seq"]}, ensure_ascii=False))
    if linhas_hist:
        protegido("o histórico", lambda: anexa_linhas(c["historico"], [limpa(l, 800) for l in linhas_hist]))
    if falha_grav2 and not falha_grav:
        ev(f"não consegui gravar o estado: {falha_grav2}.")
    if _EVENTOS:
        protegido("o log", lambda: anexa_linhas(c["log"], list(_EVENTOS), 0o640, 0o750, 2_000_000, 1000))
    return 0


def resumo(cfg, nd, nr, pior, ram, agentes_mal, servicos_mal):
    partes = []
    if nd:
        partes.append(f"disco em {pior:.0f}%")
    if nr:
        partes.append(f"memória em {ram['usado_pct']:.0f}%")
    partes += [f"agente {a['nome']} fora do ar" for a in agentes_mal]
    partes += [f"serviço {s} parado" for s in servicos_mal]
    return (", ".join(partes) or "tudo normal") + f" em {cfg['NOME_SERVIDOR'] or nome_servidor(cfg)}"


def alivio_ram(est, agentes, agora_ts, acoes):
    """Só fecha o navegador do agente que mais usa memória; nunca runner, WhatsApp, painel, Web, Admin ou Caddy."""
    if not est["alivio"]["ronda"]:
        est["alivio"]["ronda"] = True
        if servico_ativo("dgclaw-ronda.service"):
            rc, _ = cmd(["systemctl", "stop", "dgclaw-ronda.service"], 20)
            if rc == 0:
                acoes.append({"em": agora_ts, "tipo": "alivio-ram", "descricao": "parei a ronda de segurança para liberar memória",
                              "texto": "parei a ronda de segurança para liberar memória (ela roda de novo depois, no modo econômico)"})
                ev("alívio de memória: parei dgclaw-ronda.service.")
            return
    rc, saida = cmd(["podman", "stats", "--no-stream", "--format", "json"], 20)
    if rc != 0:
        ev(f"alívio de memória: o podman stats falhou (código {rc}); não fechei navegador nenhum.")
        return
    try:
        stats = json.loads(saida)
    except ValueError:
        ev("alívio de memória: não entendi a saída do podman stats.")
        return
    por_container = {a["container"]: a for a in agentes}
    melhor, uso = None, -1.0
    for s in stats if isinstance(stats, list) else []:
        nome = s.get("name") or s.get("Name") or ""
        if nome not in por_container:
            continue
        raw = str(s.get("mem_percent") or s.get("MemPerc") or s.get("mem_perc") or "0").replace("%", "").replace(",", ".")
        try:
            v = float(raw)
        except ValueError:
            continue
        if v > uso:
            melhor, uso = por_container[nome], v
    if melhor is None:
        return
    ult = est["alivio"]["chrome"].get(melhor["slug"])
    if ult is not None and agora_ts - ult < 1800:
        return
    rc, _ = cmd(["podman", "exec", melhor["container"], "systemctl", "stop", "dgclaw-tela-chrome.service"], 20)
    est["alivio"]["chrome"][melhor["slug"]] = agora_ts
    if rc == 0:
        acoes.append({"em": agora_ts, "tipo": "alivio-ram", "descricao": f"fechei o navegador do agente {melhor['nome']}",
                      "texto": f"fechei o navegador do agente {melhor['nome']} para liberar memória. A conversa dele continua de pé; o navegador volta quando ele precisar"})
        ev(f"alívio de memória: fechei o navegador de {melhor['slug']}.")
    else:
        ev(f"alívio de memória: não consegui fechar o navegador de {melhor['slug']} (código {rc}).")


# --- avisos ------------------------------------------------------------------------------------

def decide_aviso(cfg, est, mudancas, acoes, geral, nd, nr, pior, discos, ram, painel_agentes, agentes_mal, servicos_mal, agora_ts):
    anterior_em = est["ultimo_aviso_em"]
    if geral > 0 and est["problema_desde"] is None:
        est["problema_desde"] = agora_ts
    tipos = {m[0] for m in mudancas}
    subida = "subida" in tipos or "caiu" in tipos or "canal" in tipos or "servico_caiu" in tipos
    voltou = tipos & {"voltou", "canal_voltou", "servico_voltou"}
    tipo = None
    if geral == 0 and est["problema_desde"] is not None:
        tipo = "resolvido"
    elif subida:
        tipo = "subida"
    elif voltou:
        tipo = "voltou"
    elif geral > 0 and anterior_em is not None:
        rep = {1: cfg["REPETIR_AVISO_MIN"], 2: cfg["REPETIR_SERIO_MIN"], 3: cfg["REPETIR_CRITICO_MIN"]}[geral]
        if agora_ts - anterior_em >= rep * 60:
            tipo = "repeticao"
    elif geral > 0 and anterior_em is None:
        tipo = "subida"
    avisa_acao = [a for a in acoes if a.get("texto")]
    if tipo is None and avisa_acao:
        tipo = "acao"
    if tipo is None:
        return None
    duracao_txt = duracao(agora_ts - est["problema_desde"]) if est["problema_desde"] else ""
    aviso = {"tipo": tipo, "nivel": NIVEIS[geral], "geral": geral, "mudancas": mudancas, "acoes": avisa_acao, "duracao": duracao_txt,
             "nd": nd, "nr": nr, "pior": pior, "discos": discos, "ram": ram, "agentes": painel_agentes, "servicos_mal": servicos_mal}
    if tipo == "acao" and geral == 0:
        aviso["titulo"] = "ℹ️ " + avisa_acao[0]["texto"][:1].upper() + avisa_acao[0]["texto"][1:]
    elif tipo == "resolvido":
        aviso["titulo"] = "✅ RESOLVIDO · tudo voltou ao normal"
        est["problema_desde"] = None
        est["alivio"]["ronda"] = False
    else:
        partes = []
        if nd:
            partes.append(f"disco em {pior:.0f}%")
        if nr:
            partes.append(f"memória em {ram['usado_pct']:.0f}%")
        partes += [f"{a['nome']} fora do ar" for a in agentes_mal]
        partes += [f"{s} parado" for s in servicos_mal]
        if tipo == "voltou" and not partes:
            partes = ["agente voltou"]
        aviso["titulo"] = f"{EMOJI[NIVEIS[geral]]} {ROTULO[NIVEIS[geral]]} · {', '.join(partes) or 'situação mudou'}"
    aviso["corpo"] = corpo_aviso(cfg, aviso, est, agentes_mal, agora_ts)
    return aviso


def corpo_aviso(cfg, a, est, agentes_mal, agora_ts):
    L = []
    if a["tipo"] == "resolvido":
        L.append(f"Tudo voltou ao normal. O problema durou {a['duracao']}.")
        for m in a["mudancas"]:
            if m[0] == "voltou":
                L.append(f"✅ O agente {m[1]} voltou a responder.")
        L += [f"O que eu fiz: {x['texto']}." for x in a["acoes"] if x.get("texto")]
        return "\n".join(L)
    if a["tipo"] == "acao" and not a["geral"]:
        return "\n".join(f"O que eu fiz: {x['texto']}." for x in a["acoes"] if x.get("texto"))
    if a["tipo"] == "repeticao":
        L.append(f"Continua há {a['duracao']}.")
    for m in a["mudancas"]:
        if m[0] == "voltou":
            L.append(f"✅ O agente {m[1]} voltou a responder.")
        elif m[0] == "canal_voltou":
            L.append(f"✅ O WhatsApp do agente {m[1]} voltou.")
        elif m[0] == "servico_voltou":
            L.append(f"✅ O serviço {m[1]} voltou.")
    for ag in agentes_mal:
        L.append(f"🔴 AGENTE FORA DO AR · {ag['nome']}" + (f" (há {duracao(agora_ts - est['agentes'][ag['slug']]['desde'])})" if ag["estado"] == "caido" and est["agentes"][ag["slug"]].get("desde") else ""))
        L.append(ag["motivo"] + ".")
        cmdo = comando_para({"slug": ag["slug"]}, ag["motivo"])
        L.append(f"O que fazer: {cmdo}" if cmdo.startswith("sudo") else f"O que fazer: {cmdo}.")
    for s in a["servicos_mal"]:
        L.append(f"🔴 SERVIÇO PARADO · {s}")
        L.append(f"O que fazer: sudo systemctl restart {s}")
    if a["nd"]:
        pior = max(a["discos"], key=lambda d: max(d["usado_pct"], d["inodes_pct"]))
        onde = "" if pior["ponto"] == "/" else f" em {pior['ponto']}"
        if pior["inodes_pct"] > pior["usado_pct"]:
            L.append(f"💾 Arquivos demais no disco{onde}: {pior['inodes_pct']:.0f}% dos números de arquivo usados")
        else:
            L.append(f"💾 Disco em {pior['usado_pct']:.0f}% ({fmt_gb(pior['livre_gb'])} GB livres de {pior['total_gb']:.0f} GB){onde}")
        L.append({3: "O servidor para de funcionar quando o disco enche. Os agentes param de responder.",
                  2: "Se o disco continuar subindo, os agentes vão parar de responder.",
                  1: "Ainda dá tempo, mas vale liberar espaço nos próximos dias."}[a["nd"]])
        if a["nd"] >= 2:
            pastas, completo = maiores_pastas(est, agora_ts)
            L.append("")
            L.append("Maiores pastas:")
            if pastas:
                L += [f"• {p['caminho']}: {fmt_gb(p['gb'])} GB" for p in pastas]
            else:
                L.append("não deu tempo de medir as pastas")
            L.append("")
    if a["nr"]:
        r = a["ram"]
        L.append(f"🧠 Memória em {r['usado_pct']:.0f}% ({r['disponivel_mb']} MB livres de {fmt_gb(r['total_mb'] / 1024)} GB)")
        L.append({3: "Com a memória no limite o servidor trava ou o sistema fecha programas sozinho.",
                  2: "Se a memória continuar subindo, o sistema pode começar a fechar programas.",
                  1: "A memória está alta, mas ainda há folga."}[a["nr"]])
        procs = r.get("processos")
        if procs is None:
            procs = processos_ram()
        if procs:
            L.append("Quem mais usa:")
            L += [f"• {p[0]}: {p[1]} MB" for p in procs[:5]]
    feitos = [x["texto"] for x in a["acoes"] if x.get("texto")]
    if feitos:
        L.append("")
        L.append("O que eu já fiz: " + "; ".join(feitos) + ".")
    if a["nd"] and a["tipo"] != "resolvido":
        L.append('O que fazer agora: peça ao Admin no painel "faz a faxina do disco", ou no servidor rode')
        L.append("sudo dgclaw sentinela levantar")
    elif a["nr"] and not agentes_mal:
        L.append("O que fazer agora: peça ao Admin para ver o que está usando memória, ou no servidor rode")
        L.append("sudo dgclaw sentinela estado")
    return "\n".join(L).strip()


def monta_texto(cfg, a, agora_ts):
    nome = cfg["NOME_SERVIDOR"] or nome_servidor(cfg)
    if a["tipo"] == "resolvido":
        cab = f"✅ RESOLVIDO · {nome} · {hora_curta(agora_ts)}"
    else:
        ag = [x for x in a["agentes"] if x["estado"] in ("caido", "canal_caido")]
        so_agente = ag and not a["nd"] and not a["nr"]
        rot = f"AGENTE FORA DO AR · {ag[0]['nome']}" if so_agente else ROTULO[a["nivel"]]
        cab = f"{EMOJI[a['nivel']]} {rot} · {nome} · {hora_curta(agora_ts)}" if a["geral"] else f"ℹ️ INFORMAÇÃO · {nome} · {hora_curta(agora_ts)}"
    return cab + "\n" + a["corpo"]


def falha_canal(est, canal, motivo, agora_ts):
    est["canais"]["ultima_falha"] = {"canal": canal, "em": iso(agora_ts), "motivo": limpa(motivo, 200)}
    ev(f"falha ao avisar pelo canal {canal}: {limpa(motivo, 200)}")


def envia_canais(cfg, est, canais, texto, aviso, agora_ts, mudancas):
    """Todos os canais são independentes. Devolve True se ao menos um canal externo (Telegram/e-mail) entregou."""
    ok_externo = False
    if canais["telegram"]:
        ok, mot = envia_telegram(cfg, texto)
        if ok:
            ok_externo = True
        if mot:
            falha_canal(est, "telegram", mot, agora_ts)
    if canais["email"]:
        ok, mot = envia_email(cfg, texto)
        if ok:
            ok_externo = True
        else:
            falha_canal(est, "email", mot, agora_ts)
    if ok_externo:
        est["canais"]["ultimo_envio_ok"] = iso(agora_ts)
    transicao = aviso is not None and aviso["tipo"] == "subida" and (aviso["geral"] >= 2 or any(m[0] in ("caiu", "canal") for m in mudancas))
    if transicao and canais["admin"]:
        partes = []
        if aviso["nd"]:
            partes.append(f"disco em {aviso['pior']:.0f}%")
        if aviso["nr"]:
            partes.append(f"memória em {aviso['ram']['usado_pct']:.0f}%")
        partes += [f"agente {a['slug']} fora do ar" for a in aviso["agentes"] if a["estado"] in ("caido", "canal_caido")]
        partes += [f"serviço {x} parado" for x in aviso["servicos_mal"]]
        ok, mot = avisa_admin(cfg, f"[sentinela] {', '.join(partes) or 'situação mudou'}. Rode `dgclaw sentinela estado` para ver o detalhe e ofereça ao dono a faxina guiada (`dgclaw sentinela levantar`).")
        if not ok:
            falha_canal(est, "admin", mot, agora_ts)
    return ok_externo


# --- estado do painel --------------------------------------------------------------------------

def monta_painel(cfg, est, discos, ram, agentes, servicos, canais, geral, nd, nr, agora_ts):
    reserva_gb, _ = tamanho_reserva(cfg, discos)
    nivel_ponto = lambda p: NIVEIS[nivel_de(max(p["usado_pct"], p["inodes_pct"]), [cfg["DISCO_AVISO"], cfg["DISCO_SERIO"], cfg["DISCO_CRITICO"]])]
    cache = est.get("pastas") or {}
    return {
        "versao": 1, "atualizado_em": iso(agora_ts), "servidor": nome_servidor(cfg), "nivel_geral": NIVEIS[geral],
        "disco": [{"ponto": d["ponto"], "usado_pct": d["usado_pct"], "livre_gb": d["livre_gb"], "total_gb": d["total_gb"],
                   "inodes_pct": d["inodes_pct"], "nivel": nivel_ponto(d)} for d in discos],
        "ram": {"usado_pct": ram["usado_pct"], "disponivel_mb": ram["disponivel_mb"], "total_mb": ram["total_mb"], "swap_pct": ram["swap_pct"], "nivel": NIVEIS[nr]},
        "reserva": {"ligada": cfg["RESERVA_GB"] > 0, "existe": reserva_existe(), "tamanho_gb": round(reserva_gb, 2),
                    "liberada_em": iso(est["reserva"]["liberada_em"]) if est["reserva"]["liberada_em"] else None},
        "agentes": agentes, "servicos": servicos, "maiores_pastas": cache.get("lista") or [],
        "ultimas_acoes": [{"em": iso(a["em"]), "tipo": a["tipo"], "descricao": limpa(a["descricao"], 200), **({"liberou_mb": a["liberou_mb"]} if "liberou_mb" in a else {})} for a in est["acoes"][-10:]],
        "canais": {**canais, "ultimo_envio_ok": est["canais"]["ultimo_envio_ok"], "ultima_falha": est["canais"]["ultima_falha"]},
        "aviso": est["aviso"],
    }


# --- CLI ---------------------------------------------------------------------------------------

def le_painel():
    caminho = caminhos()["painel"]
    try:
        with open(caminho, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise ErroSentinela(f"a sentinela ainda não rodou nesta máquina (falta {caminho}).", "rode uma rodada agora: sudo dgclaw sentinela rodar. Se nunca rodou sozinha, confira: systemctl status dgclaw-sentinela.timer")
    except (OSError, ValueError) as e:
        raise ErroSentinela(f"não consegui ler {caminho} ({e}).", "rode sudo dgclaw sentinela rodar para regravar o estado.")


def cmd_estado(args):
    p = le_painel()
    if "--json" in args:
        print(json.dumps(p, ensure_ascii=False, indent=2))
        return 0
    L = [f"Servidor: {p['servidor']}  |  nível geral: {p['nivel_geral'].upper()}  |  atualizado em {p['atualizado_em']}"]
    try:
        idade = time.time() - dt.datetime.fromisoformat(p["atualizado_em"]).timestamp()
        if idade > 300:
            L.append(f"⚠️ A última rodada foi há {duracao(idade)}. Confira: systemctl status dgclaw-sentinela.timer")
    except (ValueError, KeyError):
        pass
    for d in p["disco"]:
        L.append(f"Disco {d['ponto']}: {d['usado_pct']:.0f}% usado ({fmt_gb(d['livre_gb'])} GB livres de {d['total_gb']:.0f} GB, arquivos {d['inodes_pct']:.0f}%) [{d['nivel']}]")
    r = p["ram"]
    L.append(f"Memória: {r['usado_pct']:.0f}% usada ({r['disponivel_mb']} MB livres de {r['total_mb']} MB, troca {r['swap_pct']:.0f}%) [{r['nivel']}]")
    rs = p["reserva"]
    L.append("Reserva de disco: " + ("desligada" if not rs["ligada"] else (f"guardada ({fmt_gb(rs['tamanho_gb'])} GB)" if rs["existe"] else "liberada" + (f" em {rs['liberada_em']}" if rs["liberada_em"] else " (ainda não criada)"))))
    for a in p["agentes"]:
        L.append(f"Agente {a['nome']}: {a['estado']}" + (f" ({a['motivo']})" if a["motivo"] else ""))
    for s in p["servicos"]:
        L.append(f"Serviço {s['nome']}: {'ativo' if s['ativo'] else 'PARADO'}")
    if p["maiores_pastas"]:
        L.append("Maiores pastas: " + "; ".join(f"{x['caminho']} {fmt_gb(x['gb'])} GB" for x in p["maiores_pastas"]))
    for a in p["ultimas_acoes"][-5:]:
        L.append(f"Ação {a['em']}: {a['descricao']}")
    ca = p["canais"]
    L.append("Avisos: " + ", ".join(f"{n} {'ligado' if ca[k] else 'não configurado'}" for k, n in (("telegram", "Telegram"), ("email", "e-mail"), ("pulso", "pulso externo"), ("admin", "Admin"))))
    if ca.get("ultima_falha"):
        f = ca["ultima_falha"]
        L.append(f"Última falha de envio: {f['canal']} em {f['em']}: {f['motivo']}")
    if not (ca["telegram"] or ca["email"]):
        L.append("Sem Telegram nem e-mail, os alarmes só aparecem no painel. Peça ao Admin para configurar.")
    print("\n".join(L))
    return 0


def raizes_do_levantamento():
    """Pastas de primeiro nível de / (sem links nem sistemas virtuais) mais os discos locais montados à parte."""
    base = raiz() or "/"
    alvos = []
    try:
        for n in sorted(os.listdir(base)):
            caminho = base.rstrip("/") + "/" + n
            if n in ("proc", "sys", "dev", "run") or os.path.islink(caminho) or not os.path.isdir(caminho):
                continue
            alvos.append(caminho)
    except OSError as e:
        raise ErroSentinela(f"não consegui listar {base} ({e.strerror or e}).", "confira as permissões e rode de novo como root.")
    for mp, t in ler_montagens():
        if mp != "/" and t in LOCAIS and os.path.isdir(P(mp)):
            alvos.append(P(mp))
    return alvos


def cmd_levantar(args):
    res, completo, puladas = du_por_pasta(raizes_do_levantamento(), 120, 40, extra=["--max-depth=2"])
    itens = [(no_sistema(c), b) for c, b in res.items() if no_sistema(c) != "/"]
    folhas = []
    for c, b in itens:
        filhos = [bb for cc, bb in itens if cc.startswith(c.rstrip("/") + "/") and cc.count("/") == c.count("/") + 1]
        if filhos and max(filhos) >= 0.8 * b:
            continue
        folhas.append((c, b))
    folhas.sort(key=lambda x: -x[1])
    out = [{"caminho": c, "gb": round(b / GB, 2), "item_faxina": item_do_caminho(c)} for c, b in folhas[:20]]
    if "--json" in args:
        print(json.dumps({"completo": completo, "pastas": out, "puladas": [limpa(p, 200) for p in puladas]}, ensure_ascii=False, indent=2))
    else:
        print("As 20 maiores pastas (nada foi apagado):" + ("" if completo else " (alguma medição parou no tempo limite, a lista pode estar incompleta)"))
        for o in out:
            print(f"  {fmt_gb(o['gb']):>7} GB  {o['caminho']}  " + (f"[a faxina limpa isto: {o['item_faxina']}]" if o["item_faxina"] else "[fora da faxina automática: só apague com o ok do dono]"))
        for p in puladas:
            print(f"  pulei {p}")
        print("Para limpar o que o catálogo cobre: sudo dgclaw sentinela faxinar --executar")
    return 0


def item_do_caminho(c):
    if c.startswith(("/tmp", "/var/tmp")):
        return "tmp-velhos"
    if c.startswith("/var/log/journal"):
        return "journal"
    if c.startswith("/var/log"):
        return "logs-girados"
    if c.startswith("/var/cache/apt"):
        return "apt"
    if c.startswith("/var/lib/containers"):
        return "imagens-soltas"
    m = re.match(r"/var/lib/dgclaw/agentes/[^/]+/home/(\.cache|\.npm)(/|$)", c)
    return "cache-agente" if m else None


def cmd_faxinar(args):
    executar = "--executar" in args
    res = faxinar_agora(None, executar)
    if "--json" in args:
        print(json.dumps({"executado": executar, "itens": res}, ensure_ascii=False, indent=2))
    else:
        print("Faxina feita:" if executar else "Simulação (nada foi apagado). Para executar: sudo dgclaw sentinela faxinar --executar")
        for r in res:
            if executar:
                print(f"  {r['id']}: liberou {r['liberou_mb']:.0f} MB" + ("" if r["ok"] else "  (não deu certo, veja o log)"))
            else:
                e = r["estimativa_mb"]
                print(f"  {r['id']}: " + ("liberaria cerca de %.0f MB" % e if e is not None else "não consegui estimar"))
    if executar:
        c = caminhos()
        protegido("o log", lambda: anexa_linhas(c["log"], [f"{iso(agora())} faxina manual: " + "; ".join(f"{r['id']} {r['liberou_mb']:.0f} MB" for r in res)] + list(_EVENTOS), 0o640, 0o750, 2_000_000, 1000))
    return 0


def cmd_reserva(args):
    cfg, _ = ler_config()
    sub = args[0] if args else "estado"
    c = caminhos()
    est = carrega_estado()
    if sub == "estado":
        gb, _p = tamanho_reserva(cfg, medir_disco())
        print(f"Reserva: {'ligada' if cfg['RESERVA_GB'] > 0 else 'desligada (RESERVA_GB=0)'}; " + (f"existe ({fmt_gb(os.path.getsize(c['reserva']) / GB)} GB)" if reserva_existe() else "não existe agora") + f"; tamanho planejado {fmt_gb(gb)} GB; arquivo {c['reserva']}")
        return 0
    if sub == "liberar":
        gb = apaga_reserva() / GB
        if gb <= 0:
            raise ErroSentinela(f"não há reserva para liberar em {c['reserva']}.", "veja o estado com: sudo dgclaw sentinela reserva estado")
        est["reserva"]["liberada_em"] = agora()
        protegido("o estado interno", lambda: grava_atomico(c["estado"], json.dumps(est, ensure_ascii=False), 0o600))
        protegido("o histórico", lambda: anexa_linhas(c["historico"], [json.dumps({"em": iso(agora()), "tipo": "reserva", "descricao": f"reserva liberada à mão ({fmt_gb(gb)} GB)"}, ensure_ascii=False)]))
        print(f"Liberei a reserva de emergência de {fmt_gb(gb)} GB. Isso compra tempo, não resolve: libere espaço agora.")
        return 0
    if sub == "recriar":
        if reserva_existe():
            print("A reserva já existe; nada a fazer.")
            return 0
        ok, mot = cria_reserva(cfg, medir_disco())
        if not ok:
            raise ErroSentinela(f"não recriei a reserva: {mot}.", "libere espaço no disco e tente de novo, ou ajuste RESERVA_GB.")
        est["reserva"]["criada_em"], est["reserva"]["liberada_em"], est["reserva"]["abaixo_desde"] = agora(), None, None
        protegido("o estado interno", lambda: grava_atomico(c["estado"], json.dumps(est, ensure_ascii=False), 0o600))
        print(f"Reserva recriada ({mot}).")
        return 0
    raise ErroSentinela(f"'reserva {sub}' não existe.", "use: estado, liberar ou recriar.")


def cmd_testar(args):
    """Contrato com o painel: {"ok", "canais": {canal: {configurado, ok (null se não configurado), motivo}}}.
    Saída 0 se ao menos um canal entregou, 1 se nenhum entregou, 2 se nenhum canal está configurado."""
    cfg, _ = ler_config()
    canais = canais_configurados(cfg)
    texto = f"🧪 Teste da sentinela · {nome_servidor(cfg)} · {hora_curta(agora())}\nSe você recebeu esta mensagem, este canal está funcionando."
    res = {}
    for nome, fn in (("telegram", lambda: envia_telegram(cfg, texto)), ("email", lambda: envia_email(cfg, texto)), ("pulso", lambda: envia_pulso(cfg))):
        if not canais[nome]:
            res[nome] = {"configurado": False, "ok": None, "motivo": "não configurado: peça ao Admin para configurar"}
            continue
        ok, mot = fn()
        res[nome] = {"configurado": True, "ok": bool(ok), "motivo": "" if ok else limpa(mot or "falhou sem dar o motivo", 250)}
    res["admin"] = {"configurado": canais["admin"], "ok": None,
                    "motivo": "o Admin não recebe teste, para não interromper a conversa dele" if canais["admin"] else "não configurado: o token do Admin não foi encontrado"}
    usados = [r for n, r in res.items() if n != "admin" and r["configurado"]]
    entregou = any(r["ok"] for r in usados)
    if "--json" in args:
        print(json.dumps({"ok": entregou, "canais": res}, ensure_ascii=False, indent=2))
    else:
        nomes = {"telegram": "Telegram", "email": "E-mail", "pulso": "Pulso externo"}
        for n, rot in nomes.items():
            r = res[n]
            print(f"{rot}: " + ("não configurado" if not r["configurado"] else ("chegou" if r["ok"] else f"FALHOU ({r['motivo']})")))
        if not usados:
            print("Nenhum canal externo configurado: os alarmes só aparecem no painel. Peça ao Admin para configurar o Telegram.")
    if not usados:
        return 2
    return 0 if entregou else 1


AJUDA = """dgclaw sentinela: a vigia do disco, da memória, dos agentes e dos serviços desta máquina.

  dgclaw sentinela estado [--json]            o que a sentinela vê agora
  dgclaw sentinela rodar                      uma rodada agora (o timer faz isto a cada minuto)
  dgclaw sentinela levantar [--json]          as 20 maiores pastas e quais a faxina cobre (não apaga nada)
  dgclaw sentinela faxinar [--executar] [--json]   sem --executar só simula e mostra quanto cada item liberaria
  dgclaw sentinela reserva estado|liberar|recriar  a reserva de disco (o balão de ar)
  dgclaw sentinela testar-avisos [--json]     manda um aviso de teste em cada canal configurado
  dgclaw sentinela configurar                 lê CHAVE=valor da entrada padrão, sem aparecer no histórico:
      printf 'TELEGRAM_TOKEN=...\\nTELEGRAM_CHATS=...\\n' | sudo dgclaw sentinela configurar

Chaves: """ + ", ".join(PADROES) + "\n"


def main(argv):
    if not argv or argv[0] in ("ajuda", "--ajuda", "-h", "--help"):
        print(AJUDA, end="")
        return 0
    sub, resto = argv[0], argv[1:]
    if not raiz() and os.geteuid() != 0:
        raise ErroSentinela("a sentinela precisa rodar como root.", f"rode com sudo: sudo dgclaw sentinela {sub}")
    if sub == "rodar":
        return rodar()
    if sub == "configurar":
        return configurar()
    cfg, _ = ler_config()
    if sub == "estado":
        return cmd_estado(resto)
    if sub == "levantar":
        return cmd_levantar(resto)
    if sub == "faxinar":
        return cmd_faxinar(resto)
    if sub == "reserva":
        return cmd_reserva(resto)
    if sub == "testar-avisos":
        return cmd_testar(resto)
    raise ErroSentinela(f"o subcomando '{sub}' não existe.", "veja os subcomandos com: dgclaw sentinela ajuda")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except ErroSentinela as e:
        print(f"\nNão deu certo: {limpa(e, 600)}\nO que fazer: {limpa(e.fazer, 400)}", file=sys.stderr)
        sys.exit(1)
    except BrokenPipeError:
        sys.exit(0)
    except Exception as e:  # noqa: BLE001 - qualquer falha inesperada precisa dizer o que foi, nunca sumir
        print(f"\nNão deu certo: erro inesperado na sentinela ({type(e).__name__}: {limpa(e, 300)}).\n"
              "O que fazer: rode de novo com sudo dgclaw sentinela rodar e, se repetir, mande esta mensagem ao Admin.", file=sys.stderr)
        sys.exit(1)
