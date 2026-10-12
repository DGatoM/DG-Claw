#!/usr/bin/env python3
"""
build-working-memory.py (DG Claw) — regenera a working-memory.md viva do agente.

Escreve em $DGCLAW_WORKSPACE/working-memory.md (a RAIZ do workspace), que e o arquivo que
entra no inicio de cada sessao e depois de cada compactacao. E por aqui que o "agora" do
agente chega na conversa, sem precisar de hook novo no caminho quente.

A ORDEM DO ARQUIVO (01/10/2026)
  O Danilo exigiu que a working memory mostre SEMPRE, logo no topo, quatro coisas sobre o
  DONO (e nao sobre o agente): o que ele quer alcancar, as frentes que ele toca em paralelo,
  o que o agente sabe dele e o que ele falou por ultimo. A ordem e esta:

    preambulo (titulo + linha ⚡ PENDENCIAS ATIVAS)
    ## Objetivos do <dono>          (curada pelo agente e pela reflexao)
    ## Tarefas em andamento         (curada: frente, proximo passo, de quem e a bola)
    ## O que eu sei sobre o <dono>  (curada: crencas e preferencias, cada uma com data)
    ## Ultimas conversas            (GERADA aqui, deterministica, do thread_log.py)
    ## Agora                        (gerada: data, hora, ha quanto tempo ele falou)
    ## Hoje / ## Ontem              (o diario curto; Hoje vira Ontem uma vez por dia)
    ## Pessoas proximas, Na minha cabeca, Metas de curto prazo
    ## Instrucoes do <dono>, ## Quero Falar com o <dono> Sobre   (protegidas)
    secoes que o agente criou e o build nao conhece (preservadas, nunca somem)
    secoes volateis genericas (Triagem de Email, Agenda, ...)
    bloco de carry-over da plataforma, se houver (intocado)

  Por que as curadas vem antes do "Agora": o hook de inicio de sessao injeta so as ~60
  primeiras linhas do arquivo. O que o dono quer e o que ele falou e o que nao pode cair
  fora dessa janela.

POR QUE "HOJE" E "ONTEM" FICAVAM VAZIOS (achado de 01/10/2026 num agente entregue)
  Tres causas somadas, todas aqui ou no prompt da reflexao:
    1. ninguem escrevia em "Hoje" (o agente escreve direto no diario);
    2. a reflexao das 23:30 mandava "limpar a working-memory", entao o pouco que havia em
       "Hoje" saia antes do build das 7h;
    3. o build copiava o PLACEHOLDER de "Hoje" ("- (vazio — ...)") para "Ontem", e o texto
       vazio parecia conteudo.
  Agora: a reflexao SUBSTITUI "Hoje" por um resumo do dia com a marca
  <!-- resumo do dia AAAA-MM-DD --> (em vez de esvaziar); o build vira esse resumo em
  "Ontem"; e, se a reflexao falhou, o build monta "Ontem" sozinho a partir do diario
  memory/<ontem>.md e da contagem de mensagens do canal. Placeholder nunca vira conteudo.
  E o build so vira o dia UMA vez por data (marca <!-- virada do dia: ... --> no topo):
  rodar o build duas vezes no mesmo dia nao apaga mais o "Ontem".

NADA SE PERDE
  - Secao desconhecida e preservada como esta (antes, o rebuild a descartava).
  - O bloco de carry-over da plataforma (<!-- CARRY-OVER DA PLATAFORMA ... -->) volta intacto.
  - Quando o arquivo passa do teto, o que precisa sair vai para memory/wm-transbordo.md
    (com data e de qual secao saiu), que a busca em conversas indexa. Antes, o corte jogava
    o texto fora.

TETO DE TAMANHO: 9000 bytes (antes 6500)
  As quatro secoes novas tem teto proprio (somam no maximo ~5,6 KB, tipicamente ~2,5 KB).
  O arquivo entra no contexto no inicio da sessao e depois de cada compactacao, nao a cada
  mensagem, e fica em cache; 9 KB sao ~2.300 tokens. Subir o teto foi o preco de as quatro
  coisas que o Danilo exigiu caberem sem expulsar o resto. As secoes volateis genericas
  continuam sendo as primeiras a encolher.

Roda pelo timer build-wm (07:00) e, com --agora-only, pelo batimento a cada 30 min (que
refresca "Agora" e "Ultimas conversas" sem virar o dia).

Envs:
  DGCLAW_WORKSPACE  (obrigatorio)  raiz do workspace do agente
  DGCLAW_OWNER      (opcional)     nome do dono (default: "o dono")
  DGCLAW_NAME       (opcional)     nome do agente (default: "a assistente")
  DGCLAW_TZ         (opcional)     fuso do dono (default: America/Sao_Paulo)
  DGCLAW_SESSION_DIR (opcional)    onde estao os transcripts (ver _lib/thread_log.py)
  DGCLAW_WM_SEM_CONVERSAS=1        nao le os transcripts (testes e diagnostico)
  DGCLAW_WM_AGORA=AAAA-MM-DDTHH:MM finge o relogio (teste da virada do dia)

Flags:
  --agora-only   refresca "Agora" e "Ultimas conversas" e garante que as secoes novas
                 existam (rapido, usado pelo batimento). Nao vira o dia.
"""

import os
import re
import subprocess
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Pulso: context manager pra registrar ok/erro no ledger. A lib vive em _lib/ ao lado
# deste script. Se ela nao existir (copia antiga do plugin), o build segue e AVISA no stderr:
# perder o registro do pulso e ruim, perder a memoria do dia e pior.
_LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_lib")
sys.path.insert(0, _LIB)
try:
    from pulso_lib import pulso_auto
except ImportError as _e:  # noqa: F841
    from contextlib import contextmanager

    sys.stderr.write(f"working-memory: sem _lib/pulso_lib.py em {_LIB}; o pulso deste build "
                     "nao vai ser registrado (o build roda igual).\n")

    @contextmanager
    def pulso_auto(pid=None):  # type: ignore
        yield

try:
    from zoneinfo import ZoneInfo
except ImportError:  # python < 3.9
    ZoneInfo = None  # type: ignore

BRT = timezone(timedelta(hours=-3))
MAX_BYTES = 9000
DIAS_PT = ["segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo"]

# Teto de cada secao curada. Passou, o que sobra vai pro transbordo (nao some).
TETO_OBJETIVOS = 1000
TETO_TAREFAS = 1600
TETO_SEI = 1800
# Ultimas conversas: quantas linhas e o tamanho de cada pedaco da linha.
N_CONVERSAS = 8
CORTE_FALA_DONO = 110
CORTE_FALA_AGENTE = 80


def env(name, default=""):
    return os.environ.get(name, default)


WORKSPACE = Path(env("DGCLAW_WORKSPACE") or os.getcwd())
OWNER = env("DGCLAW_OWNER", "o dono")
NAME = env("DGCLAW_NAME", "a assistente")
WM_FILE = WORKSPACE / "working-memory.md"
EXT_DIR = WORKSPACE / ".dgclaw" / "ext"
TRANSBORDO = WORKSPACE / "memory" / "wm-transbordo.md"
LOG_FILE = WORKSPACE / ".dgclaw" / "logs" / "build-wm.log"


def _tz():
    nome = env("DGCLAW_TZ") or env("TZ") or "America/Sao_Paulo"
    if ZoneInfo is not None:
        try:
            return ZoneInfo(nome)
        except Exception:  # noqa: BLE001  fuso invalido no config: avisa e usa BRT
            sys.stderr.write(f"working-memory: fuso '{nome}' invalido, usando -03:00.\n")
    return BRT


TZ = _tz()


def agora():
    # DGCLAW_WM_AGORA=AAAA-MM-DDTHH:MM finge o relogio (so para teste da virada do dia)
    fingido = env("DGCLAW_WM_AGORA")
    if fingido:
        return datetime.fromisoformat(fingido).replace(tzinfo=TZ)
    return datetime.now(TZ)


def log(msg):
    """Erro e aviso vao pro stderr E pro build-wm.log. O batimento chama este script com a
    saida jogada fora, entao so o stderr deixaria o problema invisivel."""
    sys.stderr.write(msg.rstrip() + "\n")
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"[{agora().strftime('%F %T')}] {msg.rstrip()}\n")
    except OSError as e:
        sys.stderr.write(f"working-memory: nao consegui escrever no log {LOG_FILE}: {e}\n")


def _do(nome):
    """'do Paulo', 'da Marta' nao da pra saber; mas 'o dono' vira 'do dono', nao 'do o dono'."""
    low = nome.lower()
    if low.startswith("o "):
        return "do " + nome[2:]
    if low.startswith("a "):
        return "da " + nome[2:]
    return "do " + nome


def _o(nome):
    low = nome.lower()
    if low.startswith(("o ", "a ")):
        return nome
    return "o " + nome


# ─── nomes das secoes ────────────────────────────────────────────────────────
H_OBJETIVOS = f"Objetivos {_do(OWNER)}"
H_TAREFAS = "Tarefas em andamento"
H_SEI = f"O que eu sei sobre {_o(OWNER)}"
H_CONVERSAS = "Últimas conversas"
H_INSTR = f"Instrucoes do {OWNER}"
H_QUERO = f"Quero Falar com o {OWNER} Sobre"

PH_OBJETIVOS = (f"- (ainda nao sei. O que {_o(OWNER)} quer alcancar, nas palavras dele, um por "
                "linha, com a data em que ele disse. Os MEUS objetivos de trabalho ficam em "
                "\"Metas de curto prazo\".)")
PH_TAREFAS = (f"- (nenhuma frente aberta. Formato: - **frente**: estado. Proximo passo: X. "
              f"Bola: comigo | com {_o(OWNER)} | com <terceiro>. (desde AAAA-MM-DD))")
PH_SEI = ("- (ainda aprendendo. Formato: - crenca, preferencia ou jeito de trabalhar "
          "(aprendi em AAAA-MM-DD). So o que ele mostrou ou disse, nunca palpite.)")
PH_HOJE = "- (vazio: cada conversa e cada rotina acrescentam uma linha aqui)"

MARCA_VIRADA = re.compile(r"<!--\s*virada do dia:\s*(\d{4}-\d{2}-\d{2})\s*-->")
MARCA_RESUMO = re.compile(r"<!--\s*resumo do dia\s*(\d{4}-\d{2}-\d{2})\s*-->")
MARCA_DIA = re.compile(r"<!--\s*dia\s*(\d{4}-\d{2}-\d{2})\s*-->")
CARRY_OVER = re.compile(
    r"\n*<!-- CARRY-OVER DA PLATAFORMA.*?<!-- FIM DO CARRY-OVER DA PLATAFORMA -->\n?",
    re.DOTALL)


def deaccent(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


def norm(h):
    return re.sub(r"\s+", " ", deaccent(h).strip().lower())


# ─── leitura e montagem do arquivo ───────────────────────────────────────────
def parse_sections(text):
    """Quebra o texto em (header, body) por '## '. Devolve (preambulo, [(header, body)])."""
    preamble, sections, cur_head, cur_body = [], [], None, []
    for ln in text.splitlines():
        if ln.startswith("## "):
            if cur_head is not None:
                sections.append((cur_head, "\n".join(cur_body).strip("\n")))
            cur_head = ln[3:].strip()
            cur_body = []
        elif cur_head is None:
            preamble.append(ln)
        else:
            cur_body.append(ln)
    if cur_head is not None:
        sections.append((cur_head, "\n".join(cur_body).strip("\n")))
    return "\n".join(preamble).strip("\n"), sections


def split_carry_over(text):
    """Separa o bloco de carry-over da plataforma (agents-server/contexto.ts) do resto.
    Ele e escrito pela maquina antes de um compact e precisa voltar intacto: se ficasse
    dentro da ultima secao, o filtro de placeholder comeria as linhas de marca."""
    m = CARRY_OVER.search(text)
    if not m:
        return text, ""
    return text[:m.start()] + text[m.end():], m.group(0).strip("\n")


def get(sections, *names):
    alvos = {norm(n) for n in names}
    for h, b in sections:
        if norm(h) in alvos:
            return b
    return None


def is_placeholder(line):
    s = line.strip()
    return (not s or s.startswith("- (") or (s.startswith("<!--") and not MARCA_RESUMO.search(s)
            and not MARCA_DIA.search(s)) or "(truncado" in s or "(omitido" in s)


def real_lines(body):
    return [l for l in (body or "").split("\n") if not is_placeholder(l)]


def reassemble(preamble, secs):
    parts = [preamble] if preamble else []
    for h, b in secs:
        parts.append(f"## {h}\n{b}".rstrip())
    return "\n\n".join(parts).rstrip() + "\n"


def write_atomic(path: Path, content: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


# ─── transbordo: o que sai do arquivo vai pra ca, nunca pro lixo ──────────────
_transbordo = []


def transbordar(secao, linhas, motivo):
    linhas = [l for l in linhas if l.strip()]
    if linhas:
        _transbordo.append((secao, motivo, linhas))


def gravar_transbordo():
    if not _transbordo:
        return
    try:
        TRANSBORDO.parent.mkdir(parents=True, exist_ok=True)
        with TRANSBORDO.open("a", encoding="utf-8") as f:
            if TRANSBORDO.stat().st_size == 0:
                f.write("# Transbordo da working-memory\n\n> O que saiu da working-memory por "
                        "falta de espaco. Nada aqui foi descartado: a reflexao decide o que "
                        "volta, o que sobe pro MEMORY.md e o que pode ir pro diario.\n")
            for secao, motivo, linhas in _transbordo:
                f.write(f"\n## {agora().strftime('%Y-%m-%d %H:%M')} · saiu de \"{secao}\" ({motivo})\n")
                f.write("\n".join(linhas).rstrip() + "\n")
        log(f"working-memory: {sum(len(x[2]) for x in _transbordo)} linha(s) foram para "
            f"{TRANSBORDO} por falta de espaco (nada foi apagado).")
    except OSError as e:
        # Nao conseguir gravar o transbordo quer dizer que o corte PERDERIA texto. Nesse caso
        # o build para antes de escrever a working-memory nova: melhor um arquivo velho que
        # um arquivo com buraco.
        raise RuntimeError(f"nao consegui gravar o transbordo em {TRANSBORDO} ({e}); a "
                           "working-memory NAO foi reescrita para nao perder texto") from e


def limitar(secao, body, teto):
    """Mantem a secao curada dentro do teto, de cima para baixo (o mais importante fica no
    topo, e isso e regra pro agente). O que nao couber vai pro transbordo."""
    if len(body.encode("utf-8")) <= teto:
        return body
    fica, sai, total = [], [], 0
    for l in body.split("\n"):
        n = len(l.encode("utf-8")) + 1
        if not sai and total + n <= teto:
            fica.append(l)
            total += n
        else:
            sai.append(l)
    transbordar(secao, sai, f"passou de {teto} bytes")
    fica.append(f"- (mais {len([s for s in sai if s.strip()])} linha(s) em memory/wm-transbordo.md)")
    return "\n".join(fica)


# ─── carry-forward ──────────────────────────────────────────────────────────
def pendencias_line(preamble):
    placeholder = (
        "⚡ PENDÊNCIAS ATIVAS: (nenhuma ativa. Resumo de 1 linha dos trabalhos EM ABERTO com o "
        + OWNER + ": projeto + proximo passo. Atualizo ao abrir/fechar pendencia.)"
    )
    for ln in (preamble or "").splitlines():
        s = ln.strip()
        if s.startswith("⚡ PEND") and "ATIVAS" in s.upper():
            return s
    return placeholder


def carry_quero(sections):
    placeholder = "- (atualizar durante sessoes quando surgir algo pra avisar o " + OWNER + ")"
    body = get(sections, H_QUERO)
    if not body:
        return placeholder
    real = [l for l in body.split("\n") if l.strip() and "atualizar durante" not in l
            and not l.strip().startswith("<!--") and "(truncado" not in l]
    return "\n".join(real) if real else placeholder


def carry_instrucoes(sections):
    placeholder = (
        f"- ({OWNER} escreve aqui via DM quando quer algo num cron futuro. Formato: "
        "`- [cron-alvo] instrucao (recebido YYYY-MM-DD HH:MM)`. Crons marcam [APLICADO] "
        "ao consumir; o build do dia seguinte limpa as marcadas.)"
    )
    body = get(sections, H_INSTR, f"Instruções do {OWNER}")
    if not body:
        return placeholder
    real = []
    for l in body.split("\n"):
        s = l.strip()
        if not s or "[aplicado" in s.lower() or s.startswith("<!--") \
                or s.startswith(f"- ({OWNER} escreve") or "(truncado" in s:
            continue
        real.append(l)
    return "\n".join(real) if real else placeholder


def carry_simple(sections, heading, placeholder):
    real = real_lines(get(sections, heading))
    return "\n".join(real) if real else placeholder


def carry_curada(sections, heading, placeholder, teto, *aliases):
    """Secao curada pelo agente: preserva tudo (inclusive comentario de formato), so troca
    pelo placeholder quando nao ha linha real, e aplica o teto com transbordo."""
    body = get(sections, heading, *aliases)
    if not body or not real_lines(body):
        return placeholder
    # a nota "(mais N linha(s) em memory/wm-transbordo.md)" da rodada anterior e recalculada,
    # e o placeholder de formato sai quando ja existe conteudo de verdade (so ocupava espaco)
    prefixo_ph = placeholder[:24]
    body = "\n".join(l for l in body.split("\n") if "em memory/wm-transbordo.md)" not in l
                     and not l.strip().startswith(prefixo_ph))
    return limitar(heading, body.strip("\n"), teto)


# ─── extensoes ──────────────────────────────────────────────────────────────
def ext_blocks(hook_name, timeout=5):
    """Roda o gancho <hook_name> de cada extensao em .dgclaw/ext/<nome>/hooks/ e devolve o
    markdown que cada uma imprimir. Extensao que falha nao derruba o build: o erro sai no
    stderr/log dizendo qual extensao, qual gancho e o que aconteceu."""
    out = []
    if not EXT_DIR.is_dir():
        return out
    for ext in sorted(p for p in EXT_DIR.iterdir() if p.is_dir()):
        hook = ext / "hooks" / hook_name
        if not hook.is_file():
            continue
        try:
            r = subprocess.run([sys.executable, str(hook)], capture_output=True, text=True,
                               timeout=timeout,
                               env={**os.environ, "DGCLAW_WORKSPACE": str(WORKSPACE)})
            if r.returncode != 0:
                log(f"working-memory: a extensao '{ext.name}' falhou no gancho {hook_name} "
                    f"(codigo {r.returncode}) e foi ignorada nesta rodada. Mensagem dela: "
                    f"{r.stderr.strip()[:300] or '(vazia)'}")
                continue
            if r.stdout.strip():
                out.append(r.stdout.strip())
        except subprocess.TimeoutExpired:
            log(f"working-memory: a extensao '{ext.name}' passou de {timeout}s no gancho "
                f"{hook_name} e foi ignorada nesta rodada (o gancho roda a cada remontagem e "
                "precisa ser rapido).")
        except OSError as e:
            log(f"working-memory: nao consegui rodar o gancho {hook_name} da extensao "
                f"'{ext.name}' ({hook}): {e}")
    return out


# ─── a conversa do canal (deterministico, sem LLM) ───────────────────────────
def carregar_conversa():
    """Eventos da thread do dono (painel + Telegram), em ordem, de todos os transcripts do
    agente. Devolve (eventos, erro). Lista vazia sem erro = ainda nao houve conversa."""
    if env("DGCLAW_WM_SEM_CONVERSAS") == "1":
        return [], None
    try:
        import thread_log  # noqa: WPS433  (mora em _lib, ja no sys.path)
    except ImportError as e:
        return [], f"sem _lib/thread_log.py ({e})"
    sd = thread_log.resolve_session_dir()
    if not sd.is_dir():
        return [], None
    try:
        arquivos = sorted(sd.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError as e:
        return [], f"nao consegui listar {sd} ({e})"
    try:
        import quarentena  # noqa: WPS433  (o que o modo de seguranca tirou do caminho)
        regras = quarentena.carregar(WORKSPACE)
    except Exception as e:  # noqa: BLE001  quarentena ilegivel nao pode zerar a conversa
        log(f"working-memory: nao consegui ler a quarentena do modo de seguranca ({e}); "
            "segui sem o filtro")
        regras = None
    eventos, vistos = [], set()
    falas_dono = 0
    fora = 0
    for p in arquivos[:30]:
        for e in thread_log.build_thread_log(str(p), last=0):
            if regras and regras.evento_bloqueado(p.stem, e.get("ts"), e.get("text")):
                fora += 1  # a conversa que travou o agente nao volta pela WM
                continue
            chave = (e.get("ts"), e.get("origin"), (e.get("text") or "")[:80])
            if chave in vistos:
                continue  # sessao retomada/bifurcada repete o historico
            vistos.add(chave)
            eventos.append(e)
            if e.get("origin") == "owner":
                falas_dono += 1
        if falas_dono >= N_CONVERSAS * 2:
            break
    if fora:
        log(f"working-memory: {fora} trecho(s) da conversa em quarentena (modo de seguranca) ficaram de fora")
    eventos.sort(key=lambda e: e.get("ts") or "")
    return eventos, None


def _local(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "")).replace(tzinfo=timezone.utc).astimezone(TZ)
    except (ValueError, AttributeError):
        return None


def _curto(t, n):
    t = re.sub(r"\s+", " ", t or "").strip()
    return t if len(t) <= n else t[:n].rstrip() + "…"


def _primeiro_nome(quem):
    q = (quem or OWNER).strip()
    if q.lower().startswith(("o ", "a ")):
        return q
    return q.split()[0] if q else OWNER


def montar_conversas(eventos, erro):
    """Ultimas ~8 trocas, uma linha cada: quando, por onde, o que ele disse e a primeira
    coisa que eu respondi. Mensagem que eu mandei por conta propria (rotina) entra como
    linha propria, porque e pergunta minha esperando resposta dele."""
    if erro:
        log(f"working-memory: nao consegui ler as conversas para 'Ultimas conversas': {erro}")
        return f"- (nao consegui ler as conversas: {erro}. Ver .dgclaw/logs/build-wm.log)"
    linhas, aberta = [], None
    for e in eventos:
        quando = _local(e.get("ts") or "")
        rotulo = quando.strftime("%d/%m %H:%M") if quando else (e.get("ts") or "")[:16]
        via = "Telegram" if e.get("via") == "telegram" else "painel"
        txt = e.get("text") or ""
        if e.get("origin") == "owner":
            aberta = {"base": f"- {rotulo} ({via}) {_primeiro_nome(e.get('who'))}: "
                              f"{_curto(txt, CORTE_FALA_DONO)}", "resposta": None}
            linhas.append(aberta)
        elif e.get("origin") == "persona-direct" and aberta is not None and aberta["resposta"] is None:
            aberta["resposta"] = _curto(txt, CORTE_FALA_AGENTE)
        elif e.get("origin") == "persona-cron":
            linhas.append({"base": f"- {rotulo} ({via}) eu, por conta propria: "
                                   f"{_curto(txt, CORTE_FALA_DONO)}", "resposta": None})
            aberta = None
    if not linhas:
        return "- (ainda nao houve conversa pelo canal)"
    out = []
    for l in linhas[-N_CONVERSAS:]:
        out.append(l["base"] + (f" → eu: {l['resposta']}" if l["resposta"] else ""))
    return "\n".join(out)


def ultima_fala_dono(eventos):
    for e in reversed(eventos):
        if e.get("origin") == "owner":
            return _local(e.get("ts") or "")
    return None


def _ha_quanto(dt):
    mins = int((agora() - dt).total_seconds() // 60)
    if mins < 2:
        return "agora mesmo"
    if mins < 60:
        return f"ha {mins} min"
    horas = mins // 60
    if horas < 24:
        return f"ha {horas}h"
    dias = horas // 24
    return f"ha {dias} dia" + ("s" if dias > 1 else "")


def build_agora(eventos):
    """'## Agora': o instante em que a sessao comeca. NEUTRO de proposito (o DG Alive
    acrescenta humor e energia pelo gancho hooks/working-memory.py)."""
    now = agora()
    body = [f"- **Agora:** {DIAS_PT[now.weekday()]}, {now.strftime('%d/%m/%Y %H:%M')}"]
    ultima = ultima_fala_dono(eventos)
    if ultima:
        body.append(f"- **Ultima fala {_do(OWNER)}:** {_ha_quanto(ultima)} "
                    f"({ultima.strftime('%d/%m %H:%M')})")
    else:
        # sem transcript legivel, cai no fio do Telegram do modo classico
        tail = WORKSPACE / ".dgclaw" / "chat-tail.md"
        try:
            if tail.is_file() and tail.stat().st_size > 0:
                body.append(f"- **Ultima conversa com {OWNER}:** "
                            f"{_ha_quanto(datetime.fromtimestamp(tail.stat().st_mtime, TZ))}")
        except OSError as e:
            log(f"working-memory: nao consegui ler {tail}: {e}")
    body.extend(ext_blocks("working-memory.py"))
    return "\n".join(body)


# ─── Ontem ──────────────────────────────────────────────────────────────────
def linhas_do_diario(dia):
    """Ate 4 linhas do diario memory/<dia>.md, pulando titulo e linha vazia. E o plano B
    quando a reflexao nao deixou resumo (ela falhou ou a sessao estava fora do ar)."""
    p = WORKSPACE / "memory" / f"{dia}.md"
    if not p.is_file():
        return []
    try:
        texto = p.read_text(encoding="utf-8")
    except OSError as e:
        log(f"working-memory: nao consegui ler o diario {p}: {e}")
        return []
    out = []
    for l in texto.splitlines():
        s = l.strip()
        if not s or s.startswith("#") or s.startswith(">"):
            continue
        out.append("- " + _curto(s.lstrip("-* "), 220))
        if len(out) >= 4:
            break
    if out:
        out.append(f"- (resumo tirado do diario memory/{dia}.md)")
    return out


def contagem_do_dia(eventos, dia):
    dono = eu = 0
    for e in eventos:
        q = _local(e.get("ts") or "")
        if not q or q.strftime("%Y-%m-%d") != dia:
            continue
        if e.get("origin") == "owner":
            dono += 1
        else:
            eu += 1
    return dono, eu


def montar_ontem(hoje_body, dia_ontem, eventos):
    linhas = real_lines(hoje_body)
    dia = dia_ontem
    do_resumo = False
    for l in list(linhas):
        m = MARCA_RESUMO.search(l)
        if m:
            dia, do_resumo = m.group(1), True
            linhas.remove(l)
    if not linhas:
        linhas = linhas_do_diario(dia)
    if not do_resumo:
        dono, eu = contagem_do_dia(eventos, dia)
        if dono or eu:
            linhas.append(f"- No canal: {dono} mensagem(ns) {_do(OWNER)} e {eu} minha(s).")
    if not linhas:
        linhas = [f"- (nada registrado em {dia[8:10]}/{dia[5:7]}: sem resumo da reflexao, sem "
                  "diario desse dia e sem conversa no canal)"]
    return "\n".join([f"<!-- dia {dia} -->"] + linhas)


# ─── corte quando estoura ───────────────────────────────────────────────────
# Ordem em que as secoes podem ENCOLHER quando o arquivo passa do teto. As primeiras sao
# sacrificadas antes. As curadas sobre o dono, as protegidas e "Agora" nao entram aqui:
# elas tem teto proprio (limitar) e nunca sao cortadas por este caminho.
ORDEM_DE_CORTE = [
    "Triagem de Email Hoje", "Agenda Hoje", "Pensamentos por Projeto",
    "Crons Sugeridos por Aprovar", "Campanhas/Frentes Ativas",
    "Ontem", H_CONVERSAS, "Na minha cabeca", "Pessoas proximas", "Metas de curto prazo", "Hoje",
]
NUNCA_CORTA = {norm(x) for x in (H_OBJETIVOS, H_TAREFAS, H_SEI, H_INSTR, H_QUERO,
                                 f"Instruções do {OWNER}", "Agora")}


def _encolher(h, b):
    """Versao curta da secao. 'Ultimas conversas' guarda as 3 MAIS NOVAS (o fim), e o que
    sai dela nao vai pro transbordo porque a fonte e o transcript (a busca em conversas ja
    indexa). As outras guardam a marca de dia (se houver) e a primeira linha; o resto vai
    pro transbordo."""
    linhas = [l for l in b.split("\n") if l.strip()]
    if norm(h) == norm(H_CONVERSAS):
        return "\n".join(linhas[-3:])
    marca = [l for l in linhas if MARCA_DIA.search(l)][:1]
    resto = [l for l in linhas if not MARCA_DIA.search(l)]
    if len(resto) <= 1:
        return b
    transbordar(h, resto[1:], "a working-memory passou do teto")
    return "\n".join(marca + resto[:1] + ["- (o resto foi para memory/wm-transbordo.md)"])


def encurtar(preamble, secs):
    def grande(s):
        return len(reassemble(preamble, s).encode("utf-8")) > MAX_BYTES

    secs = list(secs)
    if not grande(secs):
        return secs
    for etapa in ("encolher", "tirar"):
        for alvo in ORDEM_DE_CORTE:
            if not grande(secs):
                return secs
            for i, (h, b) in enumerate(secs):
                if norm(h) != norm(alvo) or norm(h) in NUNCA_CORTA:
                    continue
                if etapa == "encolher":
                    secs[i] = (h, _encolher(h, b))
                else:
                    if norm(h) != norm(H_CONVERSAS):
                        transbordar(h, [l for l in b.split("\n") if not is_placeholder(l)
                                        and "wm-transbordo" not in l],
                                    "a working-memory passou do teto")
                    secs[i] = (h, "- (omitido para caber; ver memory/wm-transbordo.md)")
                break
    if grande(secs):
        log(f"working-memory: mesmo depois de encolher tudo o que podia, o arquivo passou de "
            f"{MAX_BYTES} bytes. As secoes protegidas e as curadas sobre {OWNER} estao grandes "
            "demais; a reflexao precisa enxugar. Nada foi cortado delas.")
    return secs


# ─── as duas rodadas ────────────────────────────────────────────────────────
def ler_atual():
    if not WM_FILE.exists():
        return "", ""
    text = WM_FILE.read_text(encoding="utf-8")
    return split_carry_over(text)


def montar(preamble, secs, carry):
    content = reassemble(preamble, encurtar(preamble, secs))
    gravar_transbordo()  # antes de escrever: se falhar, levanta e a WM antiga fica
    if carry:
        content = content.rstrip() + "\n\n" + carry + "\n"
    return content


def novas_secoes(sections, eventos, erro):
    return [
        (H_OBJETIVOS, carry_curada(sections, H_OBJETIVOS, PH_OBJETIVOS, TETO_OBJETIVOS)),
        (H_TAREFAS, carry_curada(sections, H_TAREFAS, PH_TAREFAS, TETO_TAREFAS)),
        (H_SEI, carry_curada(sections, H_SEI, PH_SEI, TETO_SEI)),
        (H_CONVERSAS, montar_conversas(eventos, erro)),
    ]


def agora_only():
    """Rodada barata do batimento: refresca Agora e Ultimas conversas e garante que as
    secoes novas existam (e assim que uma working-memory antiga ganha as secoes novas sem
    esperar as 7h). Nao vira o dia e nao mexe em nada curado."""
    if not WM_FILE.exists():
        return full_build()
    texto, carry = ler_atual()
    preamble, sections = parse_sections(texto)
    eventos, erro = carregar_conversa()
    novas = dict((norm(h), (h, b)) for h, b in novas_secoes(sections, eventos, erro))
    out, inseridas = [], False
    existentes = {norm(h) for h, _ in sections}
    for h, b in sections:
        if not inseridas and norm(h) not in novas:
            # primeira secao "velha": antes dela entram as novas que ainda nao existem
            for k, (nh, nb) in novas.items():
                if k not in existentes:
                    out.append((nh, nb))
            inseridas = True
        if norm(h) in novas:
            # curadas passam pelo mesmo teto do build completo, e as conversas sao refeitas
            out.append(novas[norm(h)])
        elif norm(h) == "agora":
            out.append((h, build_agora(eventos)))
        else:
            out.append((h, b))
    if not inseridas:
        for k, (nh, nb) in novas.items():
            if k not in existentes:
                out.append((nh, nb))
    if "agora" not in existentes:
        out.append(("Agora", build_agora(eventos)))
    write_atomic(WM_FILE, montar(preamble, out, carry))
    print(f"working-memory: Agora e Ultimas conversas refrescadas ({WM_FILE})")


def full_build():
    texto, carry = ler_atual()
    preamble_old, sections = parse_sections(texto)
    eventos, erro = carregar_conversa()
    now = agora()
    hoje_iso = now.strftime("%Y-%m-%d")
    ontem_iso = (now - timedelta(days=1)).strftime("%Y-%m-%d")

    m = MARCA_VIRADA.search(preamble_old or "")
    ja_virou = bool(m and m.group(1) == hoje_iso)
    hoje_body = get(sections, "Hoje") or ""
    if ja_virou:
        # segunda rodada no mesmo dia: Hoje e Ontem ficam como estao
        hoje_sec = "\n".join(real_lines(hoje_body)) or PH_HOJE
        ontem_sec = get(sections, "Ontem") or "- (nada registrado)"
    else:
        ontem_sec = montar_ontem(hoje_body, ontem_iso, eventos)
        hoje_sec = PH_HOJE

    conhecidas = {norm(x) for x in (
        H_OBJETIVOS, H_TAREFAS, H_SEI, H_CONVERSAS, "Ultimas conversas", "Agora", "Hoje",
        "Ontem", "Pessoas proximas", "Na minha cabeca", "Metas de curto prazo", H_INSTR,
        f"Instruções do {OWNER}", H_QUERO, "Triagem de Email Hoje", "Agenda Hoje",
        "Pensamentos por Projeto", "Crons Sugeridos por Aprovar", "Campanhas/Frentes Ativas")}
    desconhecidas = [(h, b) for h, b in sections if norm(h) not in conhecidas]

    preamble = "\n".join([
        f"# Working Memory de {NAME}", "",
        f"> Memoria viva, curta. Remontada todo dia as 7h. As secoes sobre {_o(OWNER)}, as "
        "instrucoes e os recados sao preservados entre remontagens; \"Ultimas conversas\" e "
        "\"Agora\" sao gerados pela maquina.",
        f"<!-- virada do dia: {hoje_iso} -->", "",
        pendencias_line(preamble_old),
    ])

    secs = novas_secoes(sections, eventos, erro)
    secs += [
        ("Agora", build_agora(eventos)),
        ("Hoje", hoje_sec),
        ("Ontem", ontem_sec),
        ("Pessoas proximas", get(sections, "Pessoas proximas") or f"- {OWNER} (meu criador)"),
        ("Na minha cabeca", get(sections, "Na minha cabeca") or "- (sem pensamentos pendentes)"),
        ("Metas de curto prazo", get(sections, "Metas de curto prazo") or "- (definir)"),
        (H_INSTR, carry_instrucoes(sections)),
        (H_QUERO, carry_quero(sections)),
    ]
    secs += desconhecidas
    secs += [
        ("Triagem de Email Hoje", carry_simple(sections, "Triagem de Email Hoje",
            "- (cron de digest de email popula aqui, se houver; senao fica vazio)")),
        ("Agenda Hoje", carry_simple(sections, "Agenda Hoje",
            "- (cron de agenda/calendario popula aqui, se houver; senao fica vazio)")),
        ("Pensamentos por Projeto", carry_simple(sections, "Pensamentos por Projeto",
            "- (reflexao + heartbeat populam quando aparecerem cross-references entre projetos)")),
        ("Crons Sugeridos por Aprovar", carry_simple(sections, "Crons Sugeridos por Aprovar",
            f"- (eu escrevo aqui quando tiver ideia de cron novo, e o {OWNER} aprova no DM)")),
        ("Campanhas/Frentes Ativas", carry_simple(sections, "Campanhas/Frentes Ativas",
            f"- ({OWNER} me avisa quando uma frente inicia/finaliza, ou eu detecto e pergunto)")),
    ]
    content = montar(preamble, secs, carry)
    write_atomic(WM_FILE, content)
    print(f"working-memory: rebuild completo ({WM_FILE}); {len(content.encode('utf-8'))} bytes"
          + ("" if not ja_virou else " (o dia ja tinha virado hoje: Hoje/Ontem mantidos)"))


def main():
    if "--agora-only" in sys.argv:
        # sub-chamada do batimento (que registra o proprio pulso): nao loga 'build-wm' aqui
        # pra nao poluir o ledger a cada 30 min. Erro vai pro build-wm.log (ver log()).
        try:
            agora_only()
        except Exception as e:  # noqa: BLE001  o batimento joga a saida fora: registrar
            log(f"working-memory: a rodada --agora-only falhou e o arquivo ficou como estava: "
                f"{type(e).__name__}: {e}")
            raise
    else:
        with pulso_auto("build-wm"):
            full_build()


if __name__ == "__main__":
    main()
