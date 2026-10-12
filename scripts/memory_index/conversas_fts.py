#!/usr/bin/env python3
"""conversas_fts.py (DG Claw) — busca em conversas antigas e na memoria, sem chave nenhuma.

POR QUE EXISTE (01/10/2026)
  A memoria "semantica" do DG Claw depende de GEMINI_API_KEY, que o wizard nunca pede.
  Resultado: ela vem desligada de fabrica e o dono nem sabe. O Danilo: "essa experiencia
  ja esta ruim". Esta busca e o piso que funciona sempre: um indice SQLite FTS5 (do Python
  padrao, sem instalar nada, sem rede, sem custo) sobre

    1. as CONVERSAS do agente com o dono: so as falas do dono e as respostas do agente
       pelos canais (painel e Telegram), extraidas pelo _lib/thread_log.py. Recado interno
       de rotina (poke), tool_result gigante e pensamento ficam de fora;
    2. os arquivos de MEMORIA: MEMORY.md e tudo em memory/ (diario, pastas por assunto,
       skills aprendidas, transbordo da working-memory).

  E a mesma ideia da busca de sessoes do Hermes e do transcripts_fts.py da Isa: o
  embedding borra nome proprio, data e jargao; a busca literal acha exato. Com a chave do
  Gemini, a busca semantica continua existindo como complemento, nao como requisito.

O QUE O INDICE GUARDA E O QUE ELE NUNCA APAGA
  O Claude Code limpa transcripts antigos sozinho (depois de ~30 dias). O indice NAO apaga
  conversa quando o transcript some: e justamente ai que ele vale mais ("lembra do que eu
  falei em agosto?"). Arquivo de memoria apagado sai do indice (apagar foi decisao do dono).
  Transcript que encolheu (reescrito) e relido do zero; trecho repetido e ignorado pela
  impressao digital.

INCREMENTAL
  Transcripts sao append-only: guardamos a posicao (byte) da ultima linha COMPLETA lida de
  cada arquivo e o reindex le so o que entrou depois. Linha pela metade (o agente esta
  escrevendo agora) fica pra proxima rodada. Arquivo de memoria e reindexado quando muda
  tamanho ou data. Reindex sem novidade leva milissegundos.

USO
  conversas_fts.py reindex [--do-zero] [--quieto]
  conversas_fts.py buscar "termo" [--limite N] [--desde AAAA-MM-DD] [--so conversas|memoria] [--json]
  conversas_fts.py status [--json]
  conversas_fts.py recall          (stdin {"input": "<prompt cru>"}; usado pelo hook)

  --workspace <dir> antes do subcomando, ou DGCLAW_WORKSPACE (default: pasta atual).
  DB: <workspace>/.dgclaw/memory_index/conversas.db (ou DGCLAW_CONVERSAS_DB). E conversa
  crua do dono: arquivo 600, nunca versionar, nunca mandar pra fora.

CODIGOS DE SAIDA
  0 ok | 1 erro de uso ou de leitura | 2 indice ainda nao existe | 3 este Python nao tem FTS5
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI.parent / "_lib"))
sys.path.insert(0, str(AQUI))

MAX_TEXTO = 4000          # corte de cada fala guardada
MAX_TRECHO_MEMORIA = 1200  # corte de cada paragrafo/item de memoria
BLOCO_BYTES = 32 * 1024 * 1024  # quanto do transcript vai pro thread_log de cada vez
MAX_ARQ_MEMORIA = 2 * 1024 * 1024

# recall automatico (hook): o orcamento de contexto por mensagem
RECALL_MAX_TRECHOS = 3
RECALL_MAX_CHARS = 220
RECALL_IGNORA_HORAS = 6   # conversa mais nova que isso provavelmente ainda esta no contexto


def deaccent(s):
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


try:
    from memory_recall_local import STOPWORDS as _STOP  # mesma lista do recall antigo
except ImportError:
    _STOP = set()
STOPWORDS = set(_STOP) | {
    "para", "pelo", "pela", "pelos", "pelas", "com", "sem", "uma", "umas", "uns", "dos",
    "das", "nos", "nas", "que", "nao", "sim", "mas", "ele", "ela", "eles", "elas", "meu",
    "minha", "seu", "sua", "isso", "esta", "este", "aqui", "ali", "vai", "vou", "foi",
    "era", "tem", "ter", "tinha", "falei", "falou", "disse", "dizer", "lembra", "lembrar",
    "lembro", "quando", "sobre", "aquela", "aquele", "daquele", "daquela", "pode", "consegue",
    "favor", "obrigado", "valeu", "oi", "ola", "bom", "dia", "boa", "noite", "tarde",
}


# ─── onde as coisas estao ────────────────────────────────────────────────────
def workspace(args=None):
    w = (getattr(args, "workspace", None) or os.environ.get("DGCLAW_WORKSPACE") or os.getcwd())
    return Path(w).resolve()


def db_path(ws):
    o = os.environ.get("DGCLAW_CONVERSAS_DB")
    return Path(o) if o else ws / ".dgclaw" / "memory_index" / "conversas.db"


def _tz():
    nome = os.environ.get("DGCLAW_TZ") or os.environ.get("TZ") or "America/Sao_Paulo"
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(nome)
    except Exception as e:  # noqa: BLE001  python antigo ou fuso invalido: -03:00 e o do dono tipico
        sys.stderr.write(f"conversas_fts: nao consegui usar o fuso '{nome}' ({e}); usando -03:00\n")
        return timezone(timedelta(hours=-3))


TZ = _tz()


def local(ts_utc):
    """'2026-09-02T20:42:55' (UTC, como o transcript guarda) -> datetime no fuso do dono."""
    try:
        return datetime.fromisoformat(ts_utc.replace("Z", "")[:19]).replace(
            tzinfo=timezone.utc).astimezone(TZ)
    except (ValueError, AttributeError):
        return None


# ─── banco ──────────────────────────────────────────────────────────────────
class SemFTS5(Exception):
    pass


ESQUEMA = """
CREATE TABLE IF NOT EXISTS meta(chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS fontes(
    caminho TEXT PRIMARY KEY, tipo TEXT, tamanho INTEGER, posicao INTEGER,
    mtime REAL, inode INTEGER);
CREATE TABLE IF NOT EXISTS trechos(
    id INTEGER PRIMARY KEY, fonte TEXT, tipo TEXT, ts TEXT, dia TEXT, canal TEXT,
    papel TEXT, nome TEXT, texto TEXT, ref TEXT, impressao TEXT UNIQUE);
CREATE INDEX IF NOT EXISTS ix_trechos_fonte ON trechos(fonte);
CREATE INDEX IF NOT EXISTS ix_trechos_dia ON trechos(dia);
CREATE TRIGGER IF NOT EXISTS trechos_ai AFTER INSERT ON trechos BEGIN
    INSERT INTO trechos_fts(rowid, texto) VALUES (new.id, new.texto); END;
CREATE TRIGGER IF NOT EXISTS trechos_ad AFTER DELETE ON trechos BEGIN
    INSERT INTO trechos_fts(trechos_fts, rowid, texto) VALUES ('delete', old.id, old.texto); END;
"""


def conectar(ws, criar=True):
    p = db_path(ws)
    if not p.exists() and not criar:
        return None
    p.parent.mkdir(parents=True, exist_ok=True)
    novo = not p.exists()
    con = sqlite3.connect(str(p), timeout=5)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=3000")
    if novo:
        try:
            os.chmod(p, 0o600)  # e conversa crua do dono
        except OSError as e:
            sys.stderr.write(f"conversas_fts: nao consegui fechar a permissao de {p} ({e})\n")
    tem_fts = con.execute(
        "SELECT 1 FROM sqlite_master WHERE name='trechos_fts'").fetchone()
    if not tem_fts:
        ultimo = None
        # remove_diacritics 2 existe desde o SQLite 3.27; o 1 e o fallback mais antigo.
        for tok in ("unicode61 remove_diacritics 2", "unicode61 remove_diacritics 1"):
            try:
                con.execute("CREATE VIRTUAL TABLE trechos_fts USING fts5("
                            f"texto, content='trechos', content_rowid='id', tokenize='{tok}')")
                ultimo = None
                break
            except sqlite3.OperationalError as e:
                ultimo = e
        if ultimo is not None:
            con.close()
            if novo:
                p.unlink(missing_ok=True)
            raise SemFTS5(
                f"o SQLite deste Python ({sqlite3.sqlite_version}) nao tem FTS5 ({ultimo}). "
                "A busca em conversas fica desligada ate trocar o python3 por um com o sqlite "
                "completo (no Ubuntu e no Debian ele ja vem assim).")
    con.executescript(ESQUEMA)
    return con


def meta_get(con, k, default=None):
    r = con.execute("SELECT valor FROM meta WHERE chave=?", (k,)).fetchone()
    return r[0] if r else default


def meta_set(con, k, v):
    con.execute("INSERT OR REPLACE INTO meta(chave, valor) VALUES (?, ?)", (k, str(v)))


def impressao(*partes):
    return hashlib.sha1("\x1f".join(str(p) for p in partes).encode("utf-8")).hexdigest()


# ─── fonte 1: transcripts ───────────────────────────────────────────────────
def pasta_transcripts():
    import thread_log
    return thread_log.resolve_session_dir()


def indexar_transcript(con, caminho: Path, do_zero=False):
    """Le do ultimo byte completo em diante, passa pelo thread_log em blocos e insere as
    falas. Devolve quantos trechos novos entraram."""
    import thread_log

    st = caminho.stat()
    row = con.execute("SELECT tamanho, posicao, inode FROM fontes WHERE caminho=?",
                      (str(caminho),)).fetchone()
    pos = 0
    if row and not do_zero:
        tamanho_ant, pos_ant, inode_ant = row
        if st.st_ino == inode_ant and st.st_size >= (pos_ant or 0):
            pos = pos_ant or 0
        # encolheu ou trocou de arquivo: relemos do zero; a impressao digital evita duplicar
    if pos >= st.st_size:
        con.execute("UPDATE fontes SET tamanho=?, mtime=? WHERE caminho=?",
                    (st.st_size, st.st_mtime, str(caminho)))
        return 0
    novos = 0
    nome_agente = os.environ.get("DGCLAW_NAME") or "agente"
    with open(caminho, "rb") as f, tempfile.TemporaryDirectory(prefix="dgclaw-fts-") as tmpd:
        f.seek(pos)
        while True:
            pedaco = Path(tmpd) / "bloco.jsonl"
            escritos = 0
            fim_bom = pos
            with open(pedaco, "wb") as out:
                while escritos < BLOCO_BYTES:
                    linha = f.readline()
                    if not linha:
                        break
                    if not linha.endswith(b"\n"):
                        break  # linha pela metade: o agente esta escrevendo agora
                    out.write(linha)
                    escritos += len(linha)
                    fim_bom = f.tell()
            if escritos == 0:
                break
            for e in thread_log.build_thread_log(str(pedaco), last=0):
                texto = (e.get("text") or "").strip()
                if not texto:
                    continue
                ts = e.get("ts") or ""
                q = local(ts)
                origem = e.get("origin")
                papel = {"owner": "dono", "persona-cron": "agente-rotina"}.get(origem, "agente")
                nome = e.get("who") if origem == "owner" else nome_agente
                canal = "telegram" if e.get("via") == "telegram" else "painel"
                cur = con.execute(
                    "INSERT OR IGNORE INTO trechos(fonte, tipo, ts, dia, canal, papel, nome, "
                    "texto, ref, impressao) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (str(caminho), "conversa", ts, q.strftime("%Y-%m-%d") if q else ts[:10],
                     canal, papel, nome, texto[:MAX_TEXTO], e.get("arquivo") or "",
                     impressao("conversa", ts, papel, texto)))
                novos += cur.rowcount
            pos = fim_bom
            con.execute("INSERT OR REPLACE INTO fontes(caminho, tipo, tamanho, posicao, mtime, "
                        "inode) VALUES (?,?,?,?,?,?)",
                        (str(caminho), "transcript", st.st_size, pos, st.st_mtime, st.st_ino))
            con.commit()
            if escritos < BLOCO_BYTES:
                break
    return novos


# ─── fonte 2: arquivos de memoria ───────────────────────────────────────────
_DATA_ISO = re.compile(r"\b(20\d\d-\d\d-\d\d)\b")
_DATA_BR = re.compile(r"\b(\d\d)/(\d\d)/(20\d\d)\b")
_ITEM = re.compile(r"^\s*([-*+]|\d+[.)])\s+")


def fontes_memoria(ws: Path):
    out = []
    m = ws / "MEMORY.md"
    if m.is_file():
        out.append(m)
    pasta = ws / "memory"
    if pasta.is_dir():
        out.extend(sorted(p for p in pasta.rglob("*.md") if p.is_file()))
    return out


def trechos_de_memoria(ws: Path, p: Path):
    """Quebra o arquivo em pedacos citaveis: cada item de lista e um trecho, cada paragrafo
    tambem. O titulo de secao vai junto na referencia, pra saber de onde veio."""
    rel = str(p.relative_to(ws))
    m = re.match(r"(20\d\d-\d\d-\d\d)", p.stem)
    dia_arquivo = m.group(1) if m else None
    mtime_dia = datetime.fromtimestamp(p.stat().st_mtime, TZ).strftime("%Y-%m-%d")
    texto = p.read_text(encoding="utf-8", errors="replace")
    titulo, buf, inicio, saida = "", [], 0, []

    def fecha():
        t = re.sub(r"\s+", " ", " ".join(buf)).strip()
        if len(t) >= 12:
            dia = dia_arquivo
            if not dia:
                a = _DATA_ISO.search(t)
                b = _DATA_BR.search(t)
                dia = a.group(1) if a else (f"{b.group(3)}-{b.group(2)}-{b.group(1)}" if b else mtime_dia)
            ref = f"{rel}:{inicio}" + (f" · {titulo}" if titulo else "")
            saida.append((dia, t[:MAX_TRECHO_MEMORIA], ref))
        buf.clear()

    for n, linha in enumerate(texto.splitlines(), 1):
        s = linha.strip()
        if s.startswith("#"):
            fecha()
            titulo = s.lstrip("#").strip()[:60]
        elif not s or s.startswith("<!--"):
            fecha()
        elif _ITEM.match(linha) and not linha.startswith((" ", "\t")):
            fecha()
            buf.append(s)
            inicio = n
        else:
            if not buf:
                inicio = n
            buf.append(s)
    fecha()
    return saida


def indexar_memoria(con, ws: Path, p: Path, do_zero=False):
    st = p.stat()
    row = con.execute("SELECT tamanho, mtime FROM fontes WHERE caminho=?", (str(p),)).fetchone()
    if row and not do_zero and row[0] == st.st_size and abs((row[1] or 0) - st.st_mtime) < 0.001:
        return 0
    con.execute("DELETE FROM trechos WHERE fonte=?", (str(p),))
    novos = 0
    if st.st_size <= MAX_ARQ_MEMORIA:
        for i, (dia, texto, ref) in enumerate(trechos_de_memoria(ws, p)):
            cur = con.execute(
                "INSERT OR IGNORE INTO trechos(fonte, tipo, ts, dia, canal, papel, nome, texto, "
                "ref, impressao) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (str(p), "memoria", dia, dia, "memoria", "arquivo", p.name, texto, ref,
                 impressao("memoria", str(p), i, texto)))
            novos += cur.rowcount
    else:
        sys.stderr.write(f"conversas_fts: {p} tem {st.st_size} bytes, mais que o limite de "
                         f"{MAX_ARQ_MEMORIA}; ficou fora do indice (quebre em arquivos menores).\n")
    con.execute("INSERT OR REPLACE INTO fontes(caminho, tipo, tamanho, posicao, mtime, inode) "
                "VALUES (?,?,?,?,?,?)", (str(p), "memoria", st.st_size, 0, st.st_mtime, st.st_ino))
    return novos


# ─── comandos ───────────────────────────────────────────────────────────────
def cmd_reindex(args):
    ws = workspace(args)
    t0 = time.time()
    # Uma rodada por vez: o timer de 15 min e o build das 7h podem se encontrar, e duas
    # escritas ao mesmo tempo dariam "database is locked" numa delas. Quem chega depois sai
    # sem erro, porque a rodada que esta andando ja vai pegar a mesma novidade.
    trava_path = db_path(ws).with_suffix(".reindex.lock")
    trava_path.parent.mkdir(parents=True, exist_ok=True)
    trava = open(trava_path, "w")
    try:
        fcntl.flock(trava, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        if not args.quieto:
            print("outro reindex esta rodando agora; este saiu sem mexer em nada")
        return 0
    con = conectar(ws)
    novos_conv = novos_mem = 0
    erros = []

    # conversas
    try:
        pasta = pasta_transcripts()
    except ImportError as e:
        pasta = None
        erros.append(f"sem _lib/thread_log.py ({e}): as conversas nao foram indexadas")
    if pasta is not None and pasta.is_dir():
        for p in sorted(pasta.glob("*.jsonl")):
            try:
                novos_conv += indexar_transcript(con, p, args.do_zero)
            except OSError as e:
                erros.append(f"nao consegui ler {p}: {e}")
    elif pasta is not None and not args.quieto:
        print(f"(ainda nao ha transcripts em {pasta}; so a memoria foi indexada)")

    # memoria: indexa o que existe e tira do indice o que foi apagado
    vistos = set()
    for p in fontes_memoria(ws):
        vistos.add(str(p))
        try:
            novos_mem += indexar_memoria(con, ws, p, args.do_zero)
        except (OSError, ValueError) as e:
            erros.append(f"nao consegui ler {p}: {e}")
    for (cam,) in con.execute("SELECT caminho FROM fontes WHERE tipo='memoria'").fetchall():
        if cam not in vistos:
            con.execute("DELETE FROM trechos WHERE fonte=?", (cam,))
            con.execute("DELETE FROM fontes WHERE caminho=?", (cam,))
    meta_set(con, "ultimo_reindex", datetime.now(TZ).isoformat(timespec="seconds"))
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM trechos").fetchone()[0]
    con.close()
    for e in erros:
        sys.stderr.write(f"conversas_fts: {e}\n")
    if not args.quieto or novos_conv or novos_mem or erros:
        print(f"reindex ok: +{novos_conv} fala(s) de conversa, +{novos_mem} trecho(s) de "
              f"memoria, {total} no total, em {time.time() - t0:.1f}s")
    return 1 if erros else 0


def termos(texto):
    return [t for t in re.findall(r"\w+", texto, flags=re.UNICODE) if len(t) >= 2]


def consulta_fts(ts, modo="and"):
    partes = [f'"{t.replace(chr(34), "")}"' for t in ts]
    return (" OR " if modo == "or" else " ").join(partes)


def _buscar(con, q, limite, desde=None, so=None, mais_novo_que=None):
    where, params = ["trechos_fts MATCH ?"], [q]
    if desde:
        where.append("t.dia >= ?")
        params.append(desde)
    if so == "conversas":
        where.append("t.tipo = 'conversa'")
    elif so == "memoria":
        where.append("t.tipo = 'memoria'")
    if mais_novo_que:
        where.append("NOT (t.tipo = 'conversa' AND t.ts > ?)")
        params.append(mais_novo_que)
    params.append(limite)
    return con.execute(
        "SELECT t.id, t.tipo, t.ts, t.dia, t.canal, t.papel, t.nome, t.ref, t.texto, "
        "snippet(trechos_fts, 0, '«', '»', ' … ', 24), bm25(trechos_fts), t.fonte "
        "FROM trechos_fts JOIN trechos t ON t.id = trechos_fts.rowid "
        f"WHERE {' AND '.join(where)} ORDER BY bm25(trechos_fts), t.ts DESC LIMIT ?",
        params).fetchall()


def _sem_quarentena(rows, ws):
    """Tira o que o modo de seguranca pos em quarentena (ver _lib/quarentena.py): a
    conversa que fez o agente travar continua no indice, mas nao volta para ele, nem
    pelo recall nem pelo `buscar` que ele mesmo roda. Conversa: sessao + horario + texto.
    Memoria: so o texto."""
    try:
        import quarentena
        regras = quarentena.carregar(ws)
    except Exception as e:  # noqa: BLE001
        print(f"conversas_fts: nao consegui ler a quarentena ({e}); resultados sem o filtro",
              file=sys.stderr)
        return rows
    if not regras:
        return rows
    fica = []
    for r in rows:
        if r[1] == "conversa":
            if regras.evento_bloqueado(Path(r[11] or "").stem, r[2], r[8]):
                continue
        elif regras.texto_bloqueado(r[8]):
            continue
        fica.append(r)
    return fica


def rotulo(tipo, ts, dia, canal, papel, nome, ref):
    if tipo == "conversa":
        q = local(ts)
        quando = q.strftime("%d/%m/%Y %H:%M") if q else ts[:16]
        quem = (nome or "dono").split()[0] if papel == "dono" else (
            "eu, por conta propria" if papel == "agente-rotina" else "eu")
        return f"{quando} · {canal} · {quem}"
    d = f"{dia[8:10]}/{dia[5:7]}/{dia[:4]}" if dia and len(dia) >= 10 else (dia or "")
    return f"{d} · memoria · {ref}"


def cmd_buscar(args):
    ws = workspace(args)
    con = conectar(ws, criar=False)
    if con is None:
        print("a busca em conversas ainda nao tem indice. Rode antes: "
              f"python3 {Path(__file__)} reindex", file=sys.stderr)
        return 2
    if args.desde and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.desde):
        print(f"--desde precisa ser AAAA-MM-DD (recebi '{args.desde}')", file=sys.stderr)
        return 1
    ts = termos(args.termo)
    if not ts:
        print("busca vazia: passe pelo menos uma palavra com 2 letras ou mais", file=sys.stderr)
        return 1
    aviso = ""
    rows = _buscar(con, consulta_fts(ts), args.limite, args.desde, args.so)
    if not rows and len(ts) > 1:
        rows = _buscar(con, consulta_fts(ts, "or"), args.limite, args.desde, args.so)
        if rows:
            aviso = "(nenhum trecho tem todas as palavras; estes tem alguma delas)"
    con.close()
    rows = _sem_quarentena(rows, ws)
    out = [{"quando": rotulo(r[1], r[2], r[3], r[4], r[5], r[6], r[7]), "tipo": r[1],
            "ts": r[2], "dia": r[3], "canal": r[4], "papel": r[5], "ref": r[7],
            "trecho": re.sub(r"\s+", " ", r[9])} for r in rows]
    if args.json:
        print(json.dumps({"aviso": aviso, "resultados": out}, ensure_ascii=False, indent=1))
        return 0
    if not out:
        print(f"nada encontrado para: {args.termo}"
              + (f" (desde {args.desde})" if args.desde else ""))
        return 0
    if aviso:
        print(aviso)
    for r in out:
        print(f"[{r['quando']}] {r['trecho']}")
    return 0


def resumo_status(ws):
    p = db_path(ws)
    if not p.exists():
        return {"ligada": False, "motivo": "indice ainda nao criado", "trechos": 0}
    con = conectar(ws, criar=False)
    conv = con.execute("SELECT COUNT(*), MIN(dia), MAX(dia) FROM trechos WHERE tipo='conversa'").fetchone()
    mem = con.execute("SELECT COUNT(*) FROM trechos WHERE tipo='memoria'").fetchone()[0]
    ultimo = meta_get(con, "ultimo_reindex")
    con.close()
    return {"ligada": True, "trechos": conv[0] + mem, "conversa": conv[0], "memoria": mem,
            "primeira_conversa": conv[1], "ultima_conversa": conv[2], "ultimo_reindex": ultimo,
            "db": str(p), "bytes": p.stat().st_size}


def cmd_status(args):
    ws = workspace(args)
    try:
        s = resumo_status(ws)
    except SemFTS5 as e:
        s = {"ligada": False, "motivo": str(e), "trechos": 0}
    if args.json:
        print(json.dumps(s, ensure_ascii=False))
        return 0 if s["ligada"] else 2
    if not s["ligada"]:
        print(f"busca em conversas: desligada ({s['motivo']})")
        return 2
    idade = ""
    if s.get("ultimo_reindex"):
        try:
            mins = int((datetime.now(TZ) - datetime.fromisoformat(s["ultimo_reindex"])).total_seconds() // 60)
            idade = f", indice atualizado ha {mins} min" if mins < 120 else f", indice atualizado ha {mins // 60}h"
        except ValueError:
            idade = ""
    periodo = (f", conversas de {s['primeira_conversa']} a {s['ultima_conversa']}"
               if s.get("primeira_conversa") else ", nenhuma conversa ainda")
    print(f"busca em conversas: ligada ({s['trechos']} trechos indexados: {s['conversa']} de "
          f"conversa e {s['memoria']} de memoria{periodo}{idade})")
    return 0


# ─── recall automatico (o hook UserPromptSubmit chama isto) ──────────────────
_POKE = re.compile(r"/tmp/dgclaw-poke-|<plataforma\b")


def fala_do_dono(prompt):
    """So busca quando quem fala e o dono, por um canal. Recado de rotina, poke e texto
    cru no terminal ficam de fora: alem de gastar contexto a toa, uma rotina publica
    (responder comentario, por exemplo) nunca pode receber trecho de conversa privada."""
    if _POKE.search(prompt):
        return None
    m = re.search(r"<dgchat\b[^>]*>(.*?)(</dgchat>|$)", prompt, re.S)
    if m:
        return m.group(1).strip()
    m = re.search(r"<channel\b[^>]*source=\"[^\"]*telegram[^\"]*\"[^>]*>(.*?)(</channel>|$)", prompt, re.S)
    if m:
        return m.group(1).strip()
    return None


def palavras_raras(texto):
    vistos, out = set(), []
    for t in re.findall(r"\w+", deaccent(texto), flags=re.UNICODE):
        if len(t) < 4 or t.isdigit() or t in STOPWORDS or t in vistos:
            continue
        vistos.add(t)
        out.append(t)
    return out[:12]


def recall(prompt, ws):
    vazio = {"fired": False, "trigger": None, "recall": None}
    fala = fala_do_dono(prompt or "")
    if not fala or len(fala) < 8:
        return vazio
    ts = palavras_raras(fala[:1500])
    if not ts:
        return vazio
    con = conectar(ws, criar=False)
    if con is None:
        return vazio
    total = con.execute("SELECT COUNT(*) FROM trechos").fetchone()[0] or 1
    # palavra rara = aparece em poucos trechos; uma so ja basta pra valer a pena lembrar
    raras = set()
    for t in ts:
        df = con.execute("SELECT COUNT(*) FROM trechos_fts WHERE trechos_fts MATCH ?",
                         (f'"{t}"',)).fetchone()[0]
        if 0 < df <= max(3, total * 0.01):
            raras.add(t)
    limite_ts = (datetime.now(timezone.utc) - timedelta(hours=RECALL_IGNORA_HORAS)).strftime("%Y-%m-%dT%H:%M:%S")
    rows = _sem_quarentena(_buscar(con, consulta_fts(ts, "or"), 15, mais_novo_que=limite_ts), ws)
    con.close()
    escolhidos, vistos = [], set()
    for r in rows:
        alvo = deaccent(r[8])
        casou = {t for t in ts if re.search(rf"\b{re.escape(t)}\b", alvo)}
        if len(casou) < 2 and not (casou & raras):
            continue  # casamento fraco: uma palavra comum so, nao vale o contexto
        chave = (r[1], r[3], r[8][:60])
        if chave in vistos:
            continue
        vistos.add(chave)
        trecho = re.sub(r"\s+", " ", r[9])
        if len(trecho) > RECALL_MAX_CHARS:
            trecho = trecho[:RECALL_MAX_CHARS].rstrip() + "…"
        escolhidos.append(f"- [{rotulo(r[1], r[2], r[3], r[4], r[5], r[6], r[7])}] {trecho}")
        if len(escolhidos) >= RECALL_MAX_TRECHOS:
            break
    if not escolhidos:
        return vazio
    gatilho = ", ".join(ts[:3])
    return {"fired": True, "trigger": gatilho, "recall": (
        "CONVERSAS E MEMORIA RELACIONADAS (busca local; use so se fizer sentido, pode ser "
        f"irrelevante). Disparou por: {gatilho}\n" + "\n".join(escolhidos) +
        f"\n(para ver mais: python3 {Path(__file__)} buscar \"<palavras>\")")}


def cmd_recall(args):
    ws = workspace(args)
    try:
        raw = sys.stdin.read()
        prompt = (json.loads(raw).get("input") if raw.strip() else "") or ""
    except (json.JSONDecodeError, AttributeError) as e:
        sys.stderr.write(f"conversas_fts recall: entrada nao e o JSON esperado ({e})\n")
        prompt = ""
    try:
        out = recall(prompt, ws)
    except SemFTS5 as e:
        sys.stderr.write(f"conversas_fts recall: {e}\n")
        out = {"fired": False, "trigger": None, "recall": None, "erro": str(e)}
    print(json.dumps(out, ensure_ascii=False))
    return 0


def main():
    # Tudo o que este script cria (o banco e os arquivos -wal/-shm do SQLite) e conversa crua
    # do dono: nasce legivel so pelo usuario do agente.
    os.umask(0o077)
    ap = argparse.ArgumentParser(description="Busca em conversas antigas e na memoria (FTS5, sem chave).")
    ap.add_argument("--workspace", help="pasta do agente (default: DGCLAW_WORKSPACE ou a atual)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("reindex", help="atualiza o indice (incremental)")
    r.add_argument("--do-zero", action="store_true", help="rele tudo desde o comeco")
    r.add_argument("--quieto", action="store_true", help="so fala se houver novidade ou erro")
    b = sub.add_parser("buscar", help="procura um termo")
    b.add_argument("termo")
    b.add_argument("--limite", type=int, default=5)
    b.add_argument("--desde", help="AAAA-MM-DD")
    b.add_argument("--so", choices=["conversas", "memoria"])
    b.add_argument("--json", action="store_true")
    s = sub.add_parser("status", help="diz se a busca esta ligada e quanto tem indexado")
    s.add_argument("--json", action="store_true")
    sub.add_parser("recall", help="uso interno do hook (stdin JSON)")
    args = ap.parse_args()
    try:
        return {"reindex": cmd_reindex, "buscar": cmd_buscar, "status": cmd_status,
                "recall": cmd_recall}[args.cmd](args)
    except SemFTS5 as e:
        print(f"busca em conversas indisponivel: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
