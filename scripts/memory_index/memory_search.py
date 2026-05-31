#!/usr/bin/env python3
"""memory_search.py — helpers de busca semantica (embeddings + cosine).

Fornece unpack_floats / cosine / embed_query / db_path pro memory_search_fast.py
e pode rodar standalone pra testar uma query:

  GEMINI_API_KEY=... DGCLAW_WORKSPACE=~/dgclaw/tina \\
      python3 memory_search.py "o que voce sabe sobre o projeto X"
"""

import json
import math
import os
import sqlite3
import struct
import sys
import urllib.request
from pathlib import Path

EMBED_DIM = 768
EMBED_MODEL = "gemini-embedding-001"
EMBED_URL_TPL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent?key={key}"


def workspace() -> Path:
    return Path(os.environ.get("DGCLAW_WORKSPACE", ".")).expanduser().resolve()


def db_path() -> Path:
    return workspace() / "memory_index" / "chunks.db"


def unpack_floats(blob: bytes):
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob))


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def embed_query(text: str):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return None
    body = json.dumps({
        "model": f"models/{EMBED_MODEL}",
        "content": {"parts": [{"text": text}]},
        "taskType": "RETRIEVAL_QUERY",
        "outputDimensionality": EMBED_DIM,
    }).encode("utf-8")
    url = EMBED_URL_TPL.format(model=EMBED_MODEL, key=key)
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())["embedding"]["values"]
    except Exception as e:
        sys.stderr.write(f"embed_query failed: {e}\n")
        return None


def top_k(query: str, k: int = 3, threshold: float = 0.55):
    qvec = embed_query(query)
    db = db_path()
    if not qvec or not db.exists():
        return []
    conn = sqlite3.connect(db)
    rows = conn.execute(
        "SELECT id, source_path, source_type, date, content, embedding FROM chunks").fetchall()
    conn.close()
    scored = []
    for cid, src, stype, date, content, blob in rows:
        sim = cosine(qvec, unpack_floats(blob))
        if sim >= threshold:
            scored.append({"id": cid, "source": Path(src).name, "date": date,
                           "score": round(sim, 3), "content": content})
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:k]


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or sys.stdin.read()
    for c in top_k(q):
        print(f"[{c['score']}] {c['source']} ({c['date']}): {c['content'][:160]}")
