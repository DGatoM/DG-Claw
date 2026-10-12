#!/usr/bin/env python3
"""memory_search_fast.py (DG Claw) — versao sub-2s do memory_search pro hook DM Channels.

Versao GENERALIZADA: sem acoplamento a vault externo (eco-ambiente fora da persona):
busca SO no chunks.db da PROPRIA persona. Sem hardcode de paths de workspace.

Diferencas vs memory_search.py:
  - PULA detect_triggers (Haiku) → usa lista de "palavras estranhas" do baseline-vocab
  - PULA decide_recall (Haiku) → injeta direto se cosine acima do threshold
  - Trade: menos preciso, mas latencia ~1s vs 38s. Aceitavel pra DM Channels.

BUSCA HIBRIDA (05/10/2026): a palavra estranha e procurada ESCRITA nos trechos antes de
qualquer vetor (lexical_hits do memory_search.py). Nome raro nao tem significado pro
embedding; pelo texto, acha o trecho certo e ainda sai mais rapido (nao sobe o modelo).

GATE DO PROVEDOR (embedder.py): sem modelo local e sem GEMINI_API_KEY, so a busca pelo
termo exato funciona; sem indice nenhum, run() retorna {fired: False,
skip_reason: "memoria_semantica_desligada", recall: None}. Degradacao graciosa total.

Detector "palavra estranha":
  - Tokeniza msg (mesma normalizacao do build-baseline.py)
  - Se houver >=1 token NAO em baseline-vocab.json E length>=MIN_STRANGE_LEN → dispara
  - Senao: skip silencioso
  Se o baseline-vocab.json nao existir ainda, skip silencioso (skip_reason=no_baseline).

Schema do chunks.db: IDENTICO ao reindex.py canonico (embedding = float32[768] LE).

Output: JSON em stdout {fired, trigger, recall, score, source, duration_ms, skip_reason}.
Stderr: erros silenciosos (DM precisa continuar mesmo se hook falhar).

Uso CLI (chamado pelo hook UserPromptSubmit, com timeout duro ~3s):
  echo '{"input":"texto da msg"}' | memory_search_fast.py

Envs (contrato DG Claw):
  DGCLAW_EMBED_PROVIDER   auto | local | gemini | off (ver embedder.py)
  DGCLAW_WORKSPACE        raiz do workspace da persona (<ws>)
  DGCLAW_MEMORY_INDEX_DIR dir do indice (default "<ws>/.dgclaw/memory_index")
  DGCLAW_SLUG             slug da persona (default "agent"); usado so no path do log
  DGCLAW_LOG_DIR          dir de logs (default "<ws>/.dgclaw/logs")

Log de cada disparo: <DGCLAW_LOG_DIR>/memory-recall-fast.jsonl
"""
import json, os, re, sqlite3, sys, time, unicodedata
from pathlib import Path

# ─── Contrato de env / paths ──────────────────────────────────────────────────

def env(name, default=""):
    return os.environ.get(name, default)


WORKSPACE = Path(env("DGCLAW_WORKSPACE") or os.getcwd())
INDEX_DIR = Path(env("DGCLAW_MEMORY_INDEX_DIR") or (WORKSPACE / ".dgclaw" / "memory_index"))
DB_PATH = INDEX_DIR / "chunks.db"
VOCAB_PATH = INDEX_DIR / "baseline-vocab.json"

SLUG = env("DGCLAW_SLUG", "agent")
LOG_DIR = Path(env("DGCLAW_LOG_DIR") or (WORKSPACE / ".dgclaw" / "logs"))
LOG_PATH = LOG_DIR / "memory-recall-fast.jsonl"

# Reaproveita do search original o embed (com o gate do provedor), a busca pelo termo
# exato e o provedor. Importa pelo dir deste script, sem hardcode de path de workspace.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from memory_search import embed_query, EMBED_DIM, lexical_hits, provedor, motivo_desligada  # noqa

# numpy acelera a busca (vetorizado). Se faltar, cai no fallback puro-Python.
try:
    import numpy as np
    _HAS_NUMPY = True
except Exception:  # pragma: no cover
    np = None
    _HAS_NUMPY = False

SIMILARITY_THRESHOLD = None  # None = embedder.limiar_rapido do provedor. Conservador.
MIN_STRANGE_LEN = 5          # exige tokens longos (filtra "como", "hoje")
MAX_INPUT_CHARS = 1200

STOPWORDS_PT = {
    # comuns curtos
    "voce", "vc", "tudo", "bom", "boa", "mais", "menos", "ainda", "sobre", "entre", "essa",
    "esse", "isso", "aquele", "aquela", "tipo", "cara", "claro", "beleza", "blz", "oi", "ola",
    "olá", "ai", "la", "pode", "quer", "preciso", "posso", "fala", "falar", "entao", "então",
    "agora", "depois", "antes", "sempre", "nunca", "aqui", "ali", "mesmo", "mesma", "outro",
    "outra", "outros", "outras", "todo", "toda", "todos", "todas", "cada", "alo",
    "tambem", "também", "talvez", "pouco", "muito", "muita", "muitas",
    # comuns conversacionais (mesmo com 5+ chars) — nao devem ser "strange"
    "como", "hoje", "ontem", "amanha", "amanhã", "tarde", "noite", "manha", "manhã",
    "fazer", "fazendo", "fizemos", "feito", "feita", "feitos", "feitas",
    "lembra", "lembro", "lembrar", "lembrei", "lembrou", "conversamos", "conversar",
    "fevereiro", "janeiro", "marco", "março", "abril", "maio", "junho", "julho", "agosto",
    "setembro", "outubro", "novembro", "dezembro", "semana", "mes", "mês", "ano",
    "queria", "poder", "podia", "podemos", "quero", "queremos",
    "olha", "veja", "vejo", "viu", "vendo", "escuta", "ouve", "ouvi",
    "daquele", "daquela", "aquilo", "aqueles", "aquelas",
    "the", "of", "and", "to", "in", "is", "for", "with", "on", "at", "that", "you", "this", "be",
    "are", "an", "as", "by", "or", "not", "but", "if", "so", "do", "does", "did", "have", "has",
}


def normalize(s: str) -> str:
    s = s.lower()
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


def tokenize(text: str) -> list:
    text = normalize(text)
    raw = re.findall(r"[a-z0-9_]+", text)
    return [
        t for t in raw
        if len(t) >= MIN_STRANGE_LEN and t not in STOPWORDS_PT and not t.isdigit()
    ]


def load_baseline() -> set:
    try:
        d = json.loads(VOCAB_PATH.read_text())
        return set(d.get("vocab", {}).keys())
    except Exception as e:
        sys.stderr.write(f"baseline load failed: {e}\n")
        return set()


def find_strange_tokens(text: str, baseline: set) -> list:
    seen = set()
    out = []
    for t in tokenize(text):
        if t in baseline or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def nomes_proprios(text: str, baseline: set) -> list:
    """Palavras com cara de nome ou codigo (maiuscula, ou com digito: "Jev", "BL-271",
    "Prosperus"), de 3 letras ou mais, que nao sao vocabulario comum deste agente. Sao as
    unicas que vao para a busca pelo termo exato: palavra comum achada escrita num diario
    nao quer dizer nada. Nome curto ("Jev") passa aqui mesmo abaixo de MIN_STRANGE_LEN."""
    vistos, out = set(), []
    for w in re.findall(r"[\w-]+", text):
        w = w.strip("-")
        n = normalize(w)
        if len(w) < 3 or n in vistos or n in baseline or n in STOPWORDS_PT or n.isdigit():
            continue
        if w[0].isupper() or any(c.isdigit() for c in w):
            vistos.add(n)
            out.append(w)
    return out


def _cosine_topk_py(qvec_unit, rows):
    """Fallback puro-Python (sem numpy): top-1 por cosseno."""
    import struct as _struct
    best = None
    best_sim = -1.0
    for r in rows:
        blob = r[5]
        n = len(blob) // 4
        vec = _struct.unpack(f"<{n}f", blob)
        dot = sum(x * y for x, y in zip(qvec_unit, vec))
        nb = sum(y * y for y in vec) ** 0.5
        sim = dot / nb if nb else 0.0
        if sim > best_sim:
            best_sim = sim
            best = r
    return best, best_sim


def search(query: str, threshold: float = SIMILARITY_THRESHOLD, termos=()) -> list:
    """Busca SO no chunks.db da propria persona. Primeiro os `termos` (palavras estranhas)
    escritos no texto; depois o vetor da mensagem. Devolve o melhor hit (no max 1), ou []."""
    for t in termos:
        lex = lexical_hits(t)
        if lex:
            return lex[:1]
    qvec = embed_query(query)
    if not qvec:
        return []
    if threshold is None:
        threshold = provedor().limiar_rapido
    if not DB_PATH.exists():
        sys.stderr.write(f"chunks.db ausente em {DB_PATH} — rode reindex.py\n")
        return []

    conn = sqlite3.connect(DB_PATH)
    try:
        rows = conn.execute(
            "SELECT id, source_path, source_type, date, content, embedding FROM chunks"
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return []

    if _HAS_NUMPY:
        q = np.asarray(qvec, dtype=np.float32)
        qn = np.linalg.norm(q)
        if qn == 0:
            return []
        q = q / qn
        blobs = b"".join(r[5] for r in rows)
        mat = np.frombuffer(blobs, dtype=np.float32).reshape(len(rows), EMBED_DIM)
        norms = np.linalg.norm(mat, axis=1)
        norms[norms == 0] = 1.0
        sims = (mat @ q) / norms
        i = int(np.argmax(sims))
        top_row = rows[i]
        top_sim = float(sims[i])
    else:
        qn = sum(x * x for x in qvec) ** 0.5
        if qn == 0:
            return []
        qvec_unit = [x / qn for x in qvec]
        top_row, top_sim = _cosine_topk_py(qvec_unit, rows)
        if top_row is None:
            return []

    if top_sim < threshold:
        return []
    cid, src, stype, date, content, _ = top_row
    return [{
        "id": cid,
        "source": Path(src).name,
        "source_type": stype,
        "date": date,
        "score": round(top_sim, 3),
        "content": content,
    }]


def log_event(event: dict) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        pass


def run(input_text: str) -> dict:
    t0 = time.time()
    out = {
        "fired": False,
        "strange_tokens": [],
        "trigger": None,
        "recall": None,
        "score": None,
        "source": None,
        "duration_ms": 0,
        "skip_reason": None,
    }

    # GATE: sem provedor e sem indice, nao ha o que buscar. Com indice, o termo exato vale.
    if not provedor() and not DB_PATH.exists():
        sys.stderr.write(motivo_desligada() + "\n")
        out["skip_reason"] = "memoria_semantica_desligada"
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    if not input_text or len(input_text.strip()) < 5:
        out["skip_reason"] = "input_too_short"
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    baseline = load_baseline()
    if not baseline:
        out["skip_reason"] = "no_baseline"
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    strange = find_strange_tokens(input_text[:MAX_INPUT_CHARS], baseline)
    proprios = nomes_proprios(input_text[:MAX_INPUT_CHARS], baseline)
    out["strange_tokens"] = (proprios + [t for t in strange if t not in {normalize(x) for x in proprios}])[:10]
    if not strange and not proprios:
        out["skip_reason"] = "no_strange_tokens"
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    # Embed da msg inteira (nao dos tokens) — captura intencao, nao palavra.
    # Busca SO na memoria da propria persona (sem Cerebro/vault externo).
    # So nome e codigo vao para o termo exato, escritos como ele escreveu (com acento).
    hits = search(input_text[:MAX_INPUT_CHARS], termos=proprios[:5])
    if not hits:
        out["skip_reason"] = "below_threshold"
        out["trigger"] = (proprios or strange)[0]
        out["duration_ms"] = int((time.time() - t0) * 1000)
        log_event({**out, "ts": time.time()})
        return out

    trigger_str = ", ".join((proprios or strange)[:3])
    top = hits[0]
    out["fired"] = True
    out["trigger"] = trigger_str
    out["score"] = top["score"]
    out["source"] = f"{top['source']} ({top['date'] or '?'})"

    como = "o termo aparece escrito" if top.get("lexical") else f"sim {top['score']}"
    head = (f"📒 Da minha memoria — {top['source']} "
            f"({top['date'] or '?'}, {como}):")
    corpo = top.get("preview") if top.get("lexical") else top["content"]
    block = f"{head}\n{corpo[:550]}"

    out["recall"] = (
        "💡 MEMORIA ERRANTE (use so se fizer sentido — pode ser irrelevante).\n"
        f"Disparou porque ele mencionou: {trigger_str}\n\n"
        + block
    )
    out["duration_ms"] = int((time.time() - t0) * 1000)
    log_event({**out, "ts": time.time()})
    return out


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        text = payload.get("input", "") or ""
    except Exception as e:
        sys.stderr.write(f"input parse failed: {e}\n")
        text = ""
    result = run(text)
    print(json.dumps(result, ensure_ascii=False))
    emb = provedor()
    if emb:
        emb.fechar()


if __name__ == "__main__":
    main()
