#!/usr/bin/env python3
"""reindex.py — Indexador semantico da memoria do assistente DG Claw.

Le os arquivos de memoria do workspace e gera embeddings (Gemini
gemini-embedding-001, 768 dims) gravados num SQLite. E o que alimenta a
"memoria que se acende sozinha" (busca semantica no hook de recall).

Fontes (em $DGCLAW_WORKSPACE):
  - MEMORY.md
  - working-memory.md
  - memory/*.md   (diarios e notas, se existirem)

Workspace vem de:  --workspace <dir>  ou  env DGCLAW_WORKSPACE  (default: cwd)
Precisa de:        env GEMINI_API_KEY  (free tier do Google AI Studio serve)

Uso:
  GEMINI_API_KEY=... python3 reindex.py --workspace ~/dgclaw/tina
  python3 reindex.py --full      # apaga e reindexa tudo
  python3 reindex.py --dry-run   # so lista o que indexaria
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import struct
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path

EMBED_DIM = 768
EMBED_MODEL = "gemini-embedding-001"
EMBED_URL_TPL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent?key={key}"
CHUNK_WORDS = 200
OVERLAP_WORDS = 50

SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,
    source_type TEXT NOT NULL,
    date TEXT,
    chunk_idx INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding BLOB NOT NULL,
    embedded_at TEXT NOT NULL,
    UNIQUE(source_path, chunk_idx)
);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def resolve_workspace(arg: str | None) -> Path:
    ws = arg or os.environ.get("DGCLAW_WORKSPACE") or "."
    return Path(ws).expanduser().resolve()


def split_into_chunks(text, n_words=CHUNK_WORDS, overlap=OVERLAP_WORDS):
    words = text.split()
    if not words:
        return []
    if len(words) <= n_words:
        return [text]
    chunks = []
    stride = max(1, n_words - overlap)
    for i in range(0, len(words), stride):
        chunk = " ".join(words[i:i + n_words])
        if chunk:
            chunks.append(chunk)
        if i + n_words >= len(words):
            break
    return chunks


def detect_date(path: Path):
    m = re.search(r"(\d{4}-\d{2}-\d{2})", path.name)
    return m.group(1) if m else None


def detect_source_type(path: Path) -> str:
    name = path.name
    if name == "MEMORY.md":
        return "memory"
    if name == "working-memory.md":
        return "working"
    if re.match(r"\d{4}-\d{2}-\d{2}\.md", name):
        return "daily"
    return "other"


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def collect_sources(ws: Path):
    sources = []
    for fname in ("MEMORY.md", "working-memory.md"):
        p = ws / fname
        if p.exists():
            sources.append((p, p.read_text(encoding="utf-8")))
    mem_dir = ws / "memory"
    if mem_dir.exists():
        for p in sorted(mem_dir.glob("*.md")):
            sources.append((p, p.read_text(encoding="utf-8")))
    return sources


class EmbedClient:
    def __init__(self, api_key, dim=EMBED_DIM, model=EMBED_MODEL):
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY nao setada")
        self.key, self.dim, self.model = api_key, dim, model
        self.url = EMBED_URL_TPL.format(model=model, key=api_key)
        self.calls = self.errors = 0

    def embed(self, text, task_type="RETRIEVAL_DOCUMENT", retries=3):
        body = json.dumps({
            "model": f"models/{self.model}",
            "content": {"parts": [{"text": text}]},
            "taskType": task_type,
            "outputDimensionality": self.dim,
        }).encode("utf-8")
        req = urllib.request.Request(self.url, data=body,
                                     headers={"Content-Type": "application/json"})
        last_err = None
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    self.calls += 1
                    return json.loads(r.read())["embedding"]["values"]
            except urllib.error.HTTPError as e:
                last_err = f"HTTP {e.code}"
                if e.code == 429:
                    time.sleep(2 ** attempt); continue
                if e.code >= 500:
                    time.sleep(1); continue
                break
            except Exception as e:
                last_err = str(e); time.sleep(1)
        self.errors += 1
        raise RuntimeError(f"embed failed: {last_err}")


def pack_floats(vec):
    return struct.pack(f"<{len(vec)}f", *vec)


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def set_meta(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", (key, str(value)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace")
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ws = resolve_workspace(args.workspace)
    index_dir = ws / "memory_index"
    db_path = index_dir / "chunks.db"

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key and not args.dry_run:
        print("ERRO: GEMINI_API_KEY nao setada. A memoria semantica fica desligada "
              "(a memoria em arquivos continua funcionando).", file=sys.stderr)
        sys.exit(1)

    index_dir.mkdir(parents=True, exist_ok=True)
    if args.full and db_path.exists():
        db_path.unlink()
        print("DB removido (--full)")

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()

    fingerprint = f"{EMBED_MODEL}|{EMBED_DIM}|{CHUNK_WORDS}|{OVERLAP_WORDS}"
    if get_meta(conn, "fingerprint") not in (None, fingerprint):
        conn.execute("DELETE FROM chunks"); conn.commit()

    sources = collect_sources(ws)
    print(f"{len(sources)} fontes de memoria em {ws}")
    client = None if args.dry_run else EmbedClient(api_key)
    total_new = total_reused = 0

    for path, text in sources:
        rel = str(path)
        chunks = split_into_chunks(text)
        existing = dict(conn.execute(
            "SELECT chunk_idx, content_hash FROM chunks WHERE source_path=?", (rel,)).fetchall())
        to_embed = []
        for idx, chunk in enumerate(chunks):
            h = content_hash(chunk)
            if existing.get(idx) == h:
                total_reused += 1
            else:
                to_embed.append((idx, chunk, h))
        if len(chunks) < len(existing):
            conn.execute("DELETE FROM chunks WHERE source_path=? AND chunk_idx>=?",
                         (rel, len(chunks)))
        if not to_embed:
            continue
        print(f"  {path.name}: {len(to_embed)} chunks novos/mudados")
        if args.dry_run:
            total_new += len(to_embed); continue
        for idx, chunk, h in to_embed:
            try:
                vec = client.embed(chunk)
                conn.execute(
                    """INSERT OR REPLACE INTO chunks
                       (source_path,source_type,date,chunk_idx,content,content_hash,embedding,embedded_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (rel, detect_source_type(path), detect_date(path), idx, chunk, h,
                     pack_floats(vec), datetime.now().isoformat()))
                total_new += 1
                if total_new % 20 == 0:
                    conn.commit()
            except Exception as e:
                print(f"  embed falhou {path.name}#{idx}: {e}", file=sys.stderr)
        conn.commit()

    set_meta(conn, "fingerprint", fingerprint)
    set_meta(conn, "last_indexed_at", datetime.now().isoformat())
    conn.commit()
    conn.close()
    print(f"OK. novos={total_new} reaproveitados={total_reused}"
          + (f" | API calls={client.calls} erros={client.errors}" if client else ""))


if __name__ == "__main__":
    main()
