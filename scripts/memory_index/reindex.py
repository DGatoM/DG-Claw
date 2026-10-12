#!/usr/bin/env python3
"""reindex.py (DG Claw) — Indexador semantico do corpus de memorias DA PROPRIA persona.

Indexador generico do plugin DG Claw. Tudo parametrizado por env
(DGCLAW_*), sem hardcode de persona/paths. As fontes indexadas sao APENAS a
memoria da propria persona dentro do workspace (NENHUM vault externo).

═══════════════════════════════════════════════════════════════════════════════
 SCHEMA do chunks.db (canonico — compativel com o lado-LEITURA / search)
───────────────────────────────────────────────────────────────────────────────
 TABLE chunks
   id            INTEGER PRIMARY KEY AUTOINCREMENT
   source_path   TEXT NOT NULL            -- caminho absoluto da fonte
   source_type   TEXT NOT NULL            -- rotulo de origem (ver detect_source_type)
   date          TEXT                     -- ISO date (YYYY-MM-DD) se aplicavel, senao NULL
   chunk_idx     INTEGER NOT NULL         -- indice do chunk dentro da fonte
   content       TEXT NOT NULL            -- texto do chunk
   content_hash  TEXT NOT NULL            -- sha256[:16] do content (incremental)
   embedding     BLOB NOT NULL            -- float32[EMBED_DIM] little-endian (struct '<Nf')
   embedded_at   TEXT NOT NULL            -- ISO timestamp do embedding
   UNIQUE(source_path, chunk_idx)
 INDEX idx_chunks_hash   ON chunks(content_hash)
 INDEX idx_chunks_source ON chunks(source_path)

 TABLE meta
   key   TEXT PRIMARY KEY
   value TEXT NOT NULL
   -- keys: fingerprint, last_indexed_at, last_embed_calls

 embedding = struct.pack('<%df' % EMBED_DIM, *vec); decode com unpack_floats().
═══════════════════════════════════════════════════════════════════════════════

Fontes indexadas (memoria da propria persona, todas opcionais):
  - <ws>/MEMORY.md
  - <ws>/working-memory.md
  - <ws>/memory/*.md            (dailies + notas)
  - <ws>/memory/*.json          (relationships/opinions/triggers/etc, serializados)
  - <ws>/data/diary.jsonl       (uma "pagina textual" por entrada)

Env (contrato DG Claw):
  DGCLAW_WORKSPACE        (obrigatorio na pratica) — raiz do workspace da persona
  DGCLAW_SLUG             (opcional)               — slug da persona (so p/ logs)
  DGCLAW_MEMORY_INDEX_DIR (opcional)               — default <ws>/.dgclaw/memory_index
  DGCLAW_EMBED_PROVIDER   (opcional)               — auto | local | gemini | off (ver embedder.py)
  GEMINI_API_KEY          (opcional)               — so para o provedor gemini

GATE: sem provedor (nem modelo local instalado, nem GEMINI_API_KEY), imprime
"memoria semantica desligada: <motivo e como ligar>" e sai 0, sem tocar no DB.

Chunking: ~200 palavras, overlap ~50. Embeddings 768d: EmbeddingGemma 300M local (padrao,
llama.cpp, sem chave) ou Gemini gemini-embedding-001. Trocar de provedor reindexa tudo.
Incremental por content_hash (reusa chunks inalterados).

Uso:
  python3 reindex.py [--full] [--dry-run]
    --full     apaga o DB e reindexa tudo
    --dry-run  lista o que (re)indexaria sem embedar nada (nao exige provedor)
"""

import argparse
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import struct
import sys
import time
from datetime import datetime
from pathlib import Path

# ─── Parametros de chunk/modelo ───────────────────────────────────────────────

sys.path.insert(0, str(Path(__file__).resolve().parent))
import embedder  # noqa: E402  (provedor local EmbeddingGemma ou Gemini; ver embedder.py)

EMBED_DIM = embedder.DIM
CHUNK_WORDS = 200
OVERLAP_WORDS = 50

# ─── Resolucao de env / paths ─────────────────────────────────────────────────

def env(name, default=""):
    return os.environ.get(name, default)


def resolve_workspace() -> Path:
    return Path(env("DGCLAW_WORKSPACE") or os.getcwd()).resolve()


def resolve_index_dir(workspace: Path) -> Path:
    override = env("DGCLAW_MEMORY_INDEX_DIR")
    if override:
        return Path(override).resolve()
    return workspace / ".dgclaw" / "memory_index"


# ─── Schema ───────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,
    source_type TEXT NOT NULL,            -- memory | working_memory | daily | note | relationships | opinions | triggers | diary | other
    date TEXT,                            -- ISO date se aplicavel
    chunk_idx INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding BLOB NOT NULL,              -- float32[EMBED_DIM]
    embedded_at TEXT NOT NULL,
    UNIQUE(source_path, chunk_idx)
);

CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# ─── Chunking ─────────────────────────────────────────────────────────────────

def split_into_chunks(text: str, n_words: int = CHUNK_WORDS, overlap: int = OVERLAP_WORDS):
    """Split em chunks de ~n_words palavras com overlap."""
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


def detect_date(path: Path) -> str | None:
    m = re.search(r"(\d{4}-\d{2}-\d{2})", path.name)
    return m.group(1) if m else None


def detect_source_type(path: Path) -> str:
    name = path.name
    if name == "MEMORY.md":
        return "memory"
    if name == "working-memory.md":
        return "working_memory"
    if re.match(r"\d{4}-\d{2}-\d{2}\.md", name):
        return "daily"
    if name == "diary.jsonl":
        return "diary"
    if name.endswith(".json"):
        return name.replace(".json", "")
    if name.endswith(".md"):
        return "note"
    return "other"


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


# ─── Serializadores de fontes estruturadas ────────────────────────────────────

def _serialize_json_source(path: Path) -> str | None:
    """Transforma um .json de memoria em texto "paginado" pra embeddings.

    Heuristica generica: se for dict de entidades/opinioes, emite um bloco por
    chave; se for lista, um bloco por item; senao, pretty-print. NAO assume
    nenhum schema especifico de persona.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"warn: {path.name}: {e}", file=sys.stderr)
        return None

    # Desembrulha um wrapper de nivel-1 comum (ex.: {"relationships": {...}})
    if isinstance(data, dict) and len(data) == 1:
        only_val = next(iter(data.values()))
        if isinstance(only_val, (dict, list)):
            data = only_val

    blobs = []
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, str):
                blobs.append(f"=== {k} ===\n{v}")
            else:
                blobs.append(f"=== {k} ===\n" + json.dumps(v, ensure_ascii=False, indent=2))
    elif isinstance(data, list):
        for v in data:
            blobs.append(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, indent=2))
    else:
        blobs.append(json.dumps(data, ensure_ascii=False, indent=2))

    return "\n\n".join(blobs) if blobs else None


def _serialize_jsonl_source(path: Path) -> str | None:
    """Transforma um .jsonl (ex.: diary) em texto: um bloco por linha valida."""
    blobs = []
    try:
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if isinstance(d, dict):
                    date = d.get("date") or d.get("ts") or d.get("timestamp") or ""
                    # concatena valores string mais o dump como fallback
                    text_parts = [str(v) for v in d.values() if isinstance(v, str)]
                    body = "\n".join(text_parts) if text_parts else json.dumps(d, ensure_ascii=False)
                    header = f"=== {date} ===\n" if date else ""
                    blobs.append(header + body)
                else:
                    blobs.append(json.dumps(d, ensure_ascii=False))
    except Exception as e:
        print(f"warn: {path.name}: {e}", file=sys.stderr)
        return None
    return "\n\n".join(blobs) if blobs else None


# ─── Coletor de fontes (memoria da propria persona) ───────────────────────────

def collect_sources(workspace: Path):
    """Retorna lista de (path, raw_text). Todas as fontes sao opcionais."""
    sources = []

    # 1. MEMORY.md (raiz do workspace)
    p = workspace / "MEMORY.md"
    if p.exists():
        sources.append((p, p.read_text(encoding="utf-8")))

    # 2. working-memory.md (raiz do workspace)
    wm = workspace / "working-memory.md"
    if wm.exists():
        sources.append((wm, wm.read_text(encoding="utf-8")))

    # 3. memory/*.md (dailies + notas)
    mem_dir = workspace / "memory"
    if mem_dir.exists():
        for p in sorted(mem_dir.glob("*.md")):
            sources.append((p, p.read_text(encoding="utf-8")))

        # 4. memory/*.json (relationships/opinions/triggers/etc — serializados)
        for p in sorted(mem_dir.glob("*.json")):
            text = _serialize_json_source(p)
            if text:
                sources.append((p, text))

    # 5. data/diary.jsonl
    diary = workspace / "data" / "diary.jsonl"
    if diary.exists():
        text = _serialize_jsonl_source(diary)
        if text:
            sources.append((diary, text))

    return sources


# ─── Storage helpers ──────────────────────────────────────────────────────────

def pack_floats(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def unpack_floats(blob: bytes) -> list[float]:
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob))


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def set_meta(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, str(value)))


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Indexador semantico da memoria da persona (DG Claw)")
    parser.add_argument("--full", action="store_true", help="Reindexar tudo (apaga db)")
    parser.add_argument("--dry-run", action="store_true", help="Listar chunks que seriam (re)indexados sem embeddar")
    args = parser.parse_args()

    slug = env("DGCLAW_SLUG") or "persona"
    workspace = resolve_workspace()
    index_dir = resolve_index_dir(workspace)
    db_path = index_dir / "chunks.db"

    # ─── GATE: sem provedor de embedding, degrada gracioso (e diz por que e como ligar) ───
    emb, motivo = embedder.escolher()
    if emb is None and not args.dry_run:
        print(motivo)
        sys.exit(0)
    print(f"[{slug}] {motivo}")

    index_dir.mkdir(parents=True, exist_ok=True)
    # Um reindex por vez: o timer da madrugada e o do instalador podem se cruzar, e dois
    # llama-server ao mesmo tempo numa KVM 1 e memoria demais.
    trava = open(index_dir / "reindex.lock", "w")
    try:
        fcntl.flock(trava, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("outro reindex desta memoria ainda esta rodando; este sai sem fazer nada")
        sys.exit(0)

    if args.full and db_path.exists():
        db_path.unlink()
        print("DB removido (--full)")

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()

    # A impressao digital junta o provedor (modelo e dimensao) e o jeito de cortar os trechos.
    # Vetor de um modelo nao se compara com vetor de outro: mudou, reindexa tudo.
    fingerprint = f"{emb.fingerprint if emb else 'dry-run'}|{CHUNK_WORDS}|{OVERLAP_WORDS}"
    stored_fp = get_meta(conn, "fingerprint")
    if emb and stored_fp and stored_fp != fingerprint:
        print(f"fingerprint mudou ({stored_fp} -> {fingerprint}); reindexando tudo")
        conn.execute("DELETE FROM chunks")
        set_meta(conn, "fingerprint", fingerprint)
        conn.commit()

    sources = collect_sources(workspace)
    print(f"[{slug}] {len(sources)} fontes detectadas em {workspace}")

    # Fonte que sumiu (diario apagado, arquivo renomeado) sai do indice: senao a busca
    # continuaria trazendo um trecho que nao existe mais.
    vivas = {str(p) for p, _ in sources}
    for (sp,) in conn.execute("SELECT DISTINCT source_path FROM chunks").fetchall():
        if sp not in vivas and not args.dry_run:
            conn.execute("DELETE FROM chunks WHERE source_path = ?", (sp,))
            print(f"  {Path(sp).name}: saiu do indice (o arquivo nao existe mais)")
    conn.commit()

    total_new = 0
    total_reused = 0
    total_chunks = 0
    total_erros = 0

    for path, text in sources:
        rel_path = str(path)
        src_type = detect_source_type(path)
        date = detect_date(path)
        chunks = split_into_chunks(text)
        total_chunks += len(chunks)

        existing = conn.execute(
            "SELECT chunk_idx, content_hash FROM chunks WHERE source_path = ?", (rel_path,)
        ).fetchall()
        existing_hashes = {idx: h for idx, h in existing}

        to_embed = []
        for idx, chunk in enumerate(chunks):
            h = content_hash(chunk)
            if existing_hashes.get(idx) == h:
                total_reused += 1
                continue
            to_embed.append((idx, chunk, h))

        # Remove orfaos (chunks que nao existem mais)
        if len(chunks) < len(existing):
            conn.execute("DELETE FROM chunks WHERE source_path = ? AND chunk_idx >= ?", (rel_path, len(chunks)))

        if not to_embed:
            continue

        print(f"  {path.name}: {len(to_embed)} chunks novos/mudados de {len(chunks)} totais")

        if args.dry_run:
            total_new += len(to_embed)
            continue

        try:
            vecs = emb.embed_documentos([c for _, c, _ in to_embed])
        except embedder.EmbedError as e:
            total_erros += len(to_embed)
            print(f"  erro: nao consegui embedar {path.name} ({len(to_embed)} trechos): {e}", file=sys.stderr)
            continue
        for (idx, chunk, h), vec in zip(to_embed, vecs):
            conn.execute(
                """INSERT OR REPLACE INTO chunks
                   (source_path, source_type, date, chunk_idx, content, content_hash, embedding, embedded_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (rel_path, src_type, date, idx, chunk, h, pack_floats(vec), datetime.now().isoformat()),
            )
            total_new += 1
        conn.commit()
        if total_new and total_new % 40 < len(to_embed):
            print(f"    progresso: +{total_new} trechos embedados | {total_reused} reaproveitados")

    if emb:
        emb.fechar()
        set_meta(conn, "fingerprint", fingerprint)
        set_meta(conn, "last_indexed_at", datetime.now().isoformat())
        set_meta(conn, "provider", emb.nome)
    conn.commit()
    conn.close()

    print("\nIndexacao concluida")
    print(f"   chunks totais: {total_chunks}")
    print(f"   embeddings novos: {total_new}")
    print(f"   reutilizados: {total_reused}")
    if total_erros:
        print(f"   FALHARAM: {total_erros} trechos (ver as linhas 'erro:' acima); ficam para a proxima rodada",
              file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
