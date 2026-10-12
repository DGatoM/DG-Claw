#!/usr/bin/env python3
"""memory_search.py (DG Claw) — Pre-turn semantic memory hook (HippoRAG-inspired).

Versao GENERALIZADA: sem hardcode de nome/paths de workspace e SEM acoplamento a
vault externo (fora da persona). Tudo sai do contrato de env do DG Claw (DGCLAW_*).

Pipeline (lado LEITURA do indice semantico):
  1. detect_triggers(context) — Haiku extrai palavras/conceitos incomuns (~$0.001-0.002)
  2. search(trigger)         — TERMO EXATO primeiro (lexical_hits); se nao achar, embed
                               (EmbeddingGemma local ou Gemini) + cosine top-K no chunks.db
  3. decide_recall(...)      — Haiku decide se vale interromper a persona (~$0.002)
  4. Retorna texto "💡 Recall: ..." ou None (skip)

GATE DO PROVEDOR (embedder.py): sem modelo local e sem GEMINI_API_KEY, a parte por vetor
DEGRADA gracioso: embed_query() retorna None e o motivo (com o jeito de ligar) vai pro
stderr e pro campo reason. A busca pelo termo exato continua valendo se o indice existir.
Indice feito com outro provedor tambem nao entra na conta (vetores nao se comparam): o
motivo pede o reindex. Nada quebra; a sessao segue.

BUSCA HIBRIDA (05/10/2026): nome proprio raro nao tem significado para o embedding. Na Isa,
o vetor de "Jev" trouxe trechos de HeyGen e o Haiku inventou que o Jev era uma pessoa, com
"JEV (TypeSafe AI)" escrito com todas as letras num diario. Por isso o termo exato vem
antes do vetor, e o prompt de decisao proibe deduzir o que nao esta escrito.

Schema do chunks.db: IDENTICO ao reindex.py canonico (tabela chunks com
source_path/source_type/date/chunk_idx/content/content_hash/embedding/embedded_at;
embedding = float32[768] little-endian via struct).

Uso CLI (chamado pelo hook UserPromptSubmit / crons):
  echo '{"input": "...", "recent": ["msg1","msg2"]}' | memory_search.py
  → imprime JSON {recall, triggers, chunks_found, skipped, reason, duration_ms}

Envs (contrato DG Claw):
  DGCLAW_EMBED_PROVIDER   auto | local | gemini | off (ver embedder.py)
  GEMINI_API_KEY          so para o provedor gemini
  DGCLAW_WORKSPACE        raiz do workspace da persona (<ws>)
  DGCLAW_MEMORY_INDEX_DIR dir do indice (default "<ws>/.dgclaw/memory_index")
  DGCLAW_NAME             nome da persona (default "a assistente")
  DGCLAW_OWNER            nome do dono (default "o dono")
  DGCLAW_CLAUDE_BIN/CLAUDE_BIN  binario claude (default: PATH 'claude', senao ~/.local/bin/claude)
"""

import json
import math
import os
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import time
from pathlib import Path

# ─── Contrato de env / paths ──────────────────────────────────────────────────

def env(name, default=""):
    return os.environ.get(name, default)


WORKSPACE = Path(env("DGCLAW_WORKSPACE") or os.getcwd())
INDEX_DIR = Path(env("DGCLAW_MEMORY_INDEX_DIR") or (WORKSPACE / ".dgclaw" / "memory_index"))
DB_PATH = INDEX_DIR / "chunks.db"

NAME = env("DGCLAW_NAME", "a assistente")
OWNER = env("DGCLAW_OWNER", "o dono")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import embedder  # noqa: E402

EMBED_DIM = embedder.DIM


def _claude_bin() -> str:
    """Binario claude: env override, senao 'claude' no PATH, senao ~/.local/bin/claude.
    Generalizado: nada de path absoluto fixo."""
    cb = env("DGCLAW_CLAUDE_BIN") or env("CLAUDE_BIN")
    if cb:
        return cb
    found = shutil.which("claude")
    if found:
        return found
    return str(Path.home() / ".local" / "bin" / "claude")


CLAUDE_BIN = _claude_bin()

SIMILARITY_THRESHOLD = None  # None = o limiar do provedor (embedder.limiar_busca)
TOP_K = 3                    # quantos chunks por trigger
MAX_TRIGGERS = 5             # cap pra nao explodir custo
LEXICAL_MAX_HITS = 12        # termo que aparece em mais trechos que isso e comum demais pra ancora
NO_KEY_REASON = "memoria semantica desligada"   # prefixo; o motivo completo vem de motivo_desligada()

_EMB = None
_EMB_MOTIVO = None


def provedor():
    """O embedder escolhido (uma vez por processo: o llama-server local sobe uma vez so,
    na primeira busca, e serve todos os gatilhos). None = desligado."""
    global _EMB, _EMB_MOTIVO
    if _EMB is None and _EMB_MOTIVO is None:
        _EMB, _EMB_MOTIVO = embedder.escolher()
    return _EMB


def motivo_desligada() -> str:
    provedor()
    return _EMB_MOTIVO or NO_KEY_REASON


def indice_compativel(emb):
    """(ok, motivo). Vetor de um modelo nao se compara com vetor de outro."""
    if not DB_PATH.exists():
        return False, f"indice da memoria ainda nao existe em {DB_PATH}: rode scripts/memory-reindex.sh"
    try:
        conn = sqlite3.connect(DB_PATH)
        row = conn.execute("SELECT value FROM meta WHERE key = 'fingerprint'").fetchone()
        conn.close()
    except sqlite3.Error as e:
        return False, f"nao consegui ler {DB_PATH}: {e}"
    fp = row[0] if row else ""
    if not fp.startswith(emb.fingerprint + "|"):
        return False, (f"o indice foi feito com outro modelo ({fp.split('|')[0] or '?'}) e a busca agora "
                       f"usa {emb.nome}: rode scripts/memory-reindex.sh para refazer")
    return True, ""


def unpack_floats(blob: bytes) -> list:
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob))


def cosine(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


# ─── embed da busca (provedor do embedder.py) ─────────────────────────────────

def embed_query(text: str):
    """Vetor da busca. None se a memoria semantica esta desligada, se o indice e de outro
    modelo ou se o provedor falhou (o motivo vai pro stderr)."""
    emb = provedor()
    if not emb:
        sys.stderr.write(motivo_desligada() + "\n")
        return None
    ok, motivo = indice_compativel(emb)
    if not ok:
        sys.stderr.write(motivo + "\n")
        return None
    try:
        return emb.embed_query(text)
    except embedder.EmbedError as e:
        sys.stderr.write(f"busca semantica falhou: {e}\n")
        return None


def lexical_hits(trigger: str, limit: int = LEXICAL_MAX_HITS) -> list:
    """Trechos que contem o termo EXATO (palavra inteira, sem caixa), antes de qualquer vetor.

    Nome proprio raro ("Jev", "Prosperus") nao tem significado pro embedding, e o vetor traz
    o trecho errado com cara de certo. Termo que aparece em mais de `limit` trechos e comum
    demais pra servir de ancora e fica para a busca semantica. O preview sai centrado no
    termo, porque o comeco do trecho quase nunca e onde ele aparece."""
    t = (trigger or "").strip()
    if len(t) < 3 or not DB_PATH.exists():
        return []
    padrao = re.compile(r"(?<!\w)" + re.escape(t) + r"(?!\w)", re.IGNORECASE)
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT id, source_path, source_type, date, content FROM chunks WHERE content LIKE ?",
            (f"%{t}%",),
        ).fetchall()
        conn.close()
    except sqlite3.Error as e:
        sys.stderr.write(f"busca pelo termo exato falhou em {DB_PATH}: {e}\n")
        return []
    hits = []
    for cid, src, stype, date, content in rows:
        m = padrao.search(content)
        if not m:
            continue
        ini = max(0, m.start() - 150)
        hits.append({
            "id": cid,
            "source": Path(src).name,
            "source_type": stype,
            "date": date,
            "score": 1.0,
            "preview": content[ini:ini + 400],
            "content": content,
            "lexical": True,
        })
    if len(hits) > limit:
        return []
    hits.sort(key=lambda x: x["date"] or "", reverse=True)
    return hits


# ─── Haiku via claude CLI ──────────────────────────────────────────────────────

def call_haiku(prompt: str, timeout: int = 60):
    """Invoca Haiku via claude CLI, retorna .result texto ou None."""
    cmd = [
        CLAUDE_BIN, "--print",
        "--model", "haiku",
        "--no-session-persistence",
        "--output-format", "json",
        "-p", prompt,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception as e:
        sys.stderr.write(f"haiku exec failed: {e}\n")
        return None
    if proc.returncode != 0:
        sys.stderr.write(f"haiku exit {proc.returncode}: {proc.stderr[:200]}\n")
        return None
    try:
        return json.loads(proc.stdout).get("result", "").strip()
    except Exception as e:
        sys.stderr.write(f"haiku parse failed: {e}\n")
        return None


def parse_json_from_haiku(text: str):
    """Haiku as vezes envolve em ```json — limpa antes de parse."""
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"):
        lines = [l for l in text.split("\n") if not l.startswith("```")]
        text = "\n".join(lines).strip()
    try:
        return json.loads(text)
    except Exception:
        import re
        m = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except Exception:
                return None
    return None


# ─── Pipeline ──────────────────────────────────────────────────────────────────

DETECT_PROMPT_TPL = """Voce e detector de saliencia pra um sistema de memoria. {name} (assistente de {owner}) vai responder a mensagem abaixo, mas antes preciso saber se vale buscar coisas no historico antigo dela.

Contexto recente (ultimas mensagens):
{recent}

Mensagem atual:
"{input}"

Identifique ate {max_triggers} "gatilhos" (palavras, nomes, conceitos, datas) que parecem ter raiz em algo anterior — coisas que NAO aparecem resumidas no contexto recente mas que podem ter ligacao com memoria antiga.

Criterio: prefira termos especificos (nomes proprios, projetos, datas, jargao) ao inves de palavras genericas ("trabalho", "ontem"). Se nada salta aos olhos, retorne [].

Retorne JSON apenas (nada antes/depois):
["gatilho1", "gatilho2", ...]
"""


def detect_triggers(input_text: str, recent: list, max_triggers: int = MAX_TRIGGERS) -> list:
    recent_block = "\n".join(f"- {m}" for m in (recent or [])[-5:]) or "(nenhum)"
    prompt = DETECT_PROMPT_TPL.format(
        name=NAME,
        owner=OWNER,
        recent=recent_block,
        input=input_text[:1000],
        max_triggers=max_triggers,
    )
    raw = call_haiku(prompt, timeout=30)
    parsed = parse_json_from_haiku(raw) if raw else None
    if isinstance(parsed, list):
        return [str(t).strip() for t in parsed if t][:max_triggers]
    return []


def search_chunks(trigger: str, top_k: int = TOP_K, threshold: float = SIMILARITY_THRESHOLD) -> list:
    """Termo exato primeiro (lexical_hits); se nao achar, top-K por vetor com score >= limiar.
    Sem provedor ou com indice de outro modelo -> so o termo exato. Sem chunks.db -> []."""
    lex = lexical_hits(trigger)
    if lex:
        return lex[:top_k]
    qvec = embed_query(trigger)
    if not qvec:
        return []
    if threshold is None:
        threshold = provedor().limiar_busca
    conn = sqlite3.connect(DB_PATH)
    try:
        rows = conn.execute(
            "SELECT id, source_path, source_type, date, content, embedding FROM chunks"
        ).fetchall()
    finally:
        conn.close()

    scored = []
    for row in rows:
        cid, src, stype, date, content, blob = row
        vec = unpack_floats(blob)
        sim = cosine(qvec, vec)
        if sim >= threshold:
            scored.append({
                "id": cid,
                "source": Path(src).name,
                "source_type": stype,
                "date": date,
                "score": round(sim, 3),
                "preview": content[:300],
                "content": content,
            })
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]


DECIDE_PROMPT_TPL = """{name} (assistente de {owner}) esta prestes a responder. Antes, encontrei essas memorias antigas que PODEM ter ligacao com a mensagem atual.

Mensagem atual de {owner}:
"{input}"

Memorias encontradas:
{chunks}

Decida: vale interromper {name} e injetar um "💡 Recall: ..." pra ela lembrar disso? Criterios:
- SIM se a memoria traz fato/contexto que {name} quase certamente nao tem no working-memory atual
- SIM se a conexao e nao-obvia mas valiosa (insight cross-temporal)
- NAO se e trivial, obvio, ou so repete o que ela ja sabe
- NAO se a similaridade e alta mas o assunto na verdade e outro
- O recall_text so pode dizer o que esta ESCRITO nas memorias acima. Nunca deduza quem ou o que
  e um nome a partir de memorias que nao o mencionam. Se nenhuma memoria menciona o termo da
  mensagem, inject=false.

Retorne JSON apenas:
{{
  "inject": true | false,
  "recall_text": "1-2 frases concisas pra {name}, mencionando data/fonte quando relevante. Vazio se inject=false",
  "reason": "1 frase curta justificando"
}}
"""


def decide_recall(input_text: str, chunks: list):
    if not chunks:
        return None
    block = "\n".join(
        f"- [{c['source']} • {c['date'] or '?'} • score={c['score']}]\n  {c['preview']}"
        for c in chunks[:5]
    )
    prompt = DECIDE_PROMPT_TPL.format(name=NAME, owner=OWNER, input=input_text[:1000], chunks=block)
    raw = call_haiku(prompt, timeout=45)
    return parse_json_from_haiku(raw) if raw else None


def run(input_text: str, recent=None, verbose: bool = False) -> dict:
    t0 = time.time()
    out = {
        "recall": None,
        "triggers": [],
        "chunks_found": 0,
        "skipped": False,
        "reason": None,
        "duration_ms": 0,
    }

    # GATE: sem provedor E sem indice, nao ha o que buscar. Com indice e sem provedor,
    # a busca pelo termo exato ainda funciona.
    if not provedor() and not DB_PATH.exists():
        sys.stderr.write(motivo_desligada() + "\n")
        out["skipped"] = True
        out["reason"] = motivo_desligada()
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    if not input_text or len(input_text.strip()) < 5:
        out["skipped"] = True
        out["reason"] = "input too short"
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    # 1. detect
    triggers = detect_triggers(input_text, recent or [])
    out["triggers"] = triggers

    if not triggers:
        out["skipped"] = True
        out["reason"] = "no triggers"
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    # 2. search (top-K por trigger, dedupe por id)
    seen = set()
    chunks = []
    for t in triggers:
        for c in search_chunks(t):
            if c["id"] in seen:
                continue
            seen.add(c["id"])
            c["matched_trigger"] = t
            chunks.append(c)
    chunks.sort(key=lambda x: x["score"], reverse=True)
    chunks = chunks[:5]
    out["chunks_found"] = len(chunks)

    if not chunks:
        out["skipped"] = True
        out["reason"] = "no chunks above threshold"
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    # 3. decide
    decision = decide_recall(input_text, chunks)
    if not decision or not decision.get("inject"):
        out["skipped"] = True
        out["reason"] = (decision or {}).get("reason") or "decided skip"
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    recall = decision.get("recall_text", "").strip()
    if recall:
        out["recall"] = f"💡 Recall: {recall}"
    else:
        out["skipped"] = True
        out["reason"] = "empty recall_text"

    out["duration_ms"] = int((time.time() - t0) * 1000)
    return out


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps({"error": f"invalid stdin JSON: {e}"}))
        sys.exit(1)

    result = run(
        input_text=req.get("input", ""),
        recent=req.get("recent", []),
    )
    print(json.dumps(result, ensure_ascii=False))
    if _EMB:
        _EMB.fechar()


if __name__ == "__main__":
    main()
