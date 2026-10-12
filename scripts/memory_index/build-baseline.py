#!/usr/bin/env python3
"""build-baseline.py (DG Claw) — baseline de vocabulario das DMs da persona.

Baseline generico do plugin DG Claw. Le os transcripts
.jsonl da sessao viva (channels) da persona, extrai mensagens de usuario (channel)
e respostas assistant, tokeniza, conta frequencia e salva as top-N palavras
"comuns" em baseline-vocab.json. O lado-leitura (memory_search rapido) usa isso pra
detectar "palavra estranha" (= termo FORA do baseline -> dispara busca semantica).

Sem hardcode de persona/paths. Tudo via env do contrato DG Claw.

Env:
  DGCLAW_WORKSPACE        (obrigatorio na pratica) — raiz do workspace da persona
  DGCLAW_SLUG             (opcional)               — slug (so p/ logs)
  DGCLAW_SESSION_DIR      (opcional)               — dir dos transcripts .jsonl.
                              Default: ~/.claude/projects/<encoded-workspace>, onde
                              <encoded-workspace> e o path absoluto do workspace com
                              cada '/' substituido por '-' (convencao do Claude Code).
  DGCLAW_MEMORY_INDEX_DIR (opcional)               — default <ws>/.dgclaw/memory_index
                              (baseline-vocab.json vai aqui, ao lado do chunks.db)

Sem gate de chave (05/10/2026): roda sempre, e local.

Uso:
  python3 build-baseline.py
"""

import json
import os
import re
import sys
import unicodedata
from collections import Counter
from datetime import datetime
from pathlib import Path

DAYS_LOOKBACK = 14
TOP_N = 1500
MIN_TOKEN_LEN = 3

STOPWORDS_PT = {
    "a", "o", "e", "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas", "um", "uma",
    "uns", "umas", "para", "pra", "por", "com", "sem", "que", "se", "ou", "mas", "como", "mais",
    "menos", "ja", "tá", "ta", "ai", "la", "aqui", "ali", "tem", "ter", "ser", "estar", "vai",
    "vou", "ver", "fui", "foi", "sao", "sim", "nao", "não", "só", "so", "ne", "né", "cara", "tipo",
    "muito", "muita", "muitos", "muitas", "pouco", "pouca", "todo", "toda", "todos", "todas",
    "esse", "essa", "esses", "essas", "isso", "isto", "aquilo", "aquele", "aquela", "meu",
    "minha", "seu", "sua", "dele", "dela", "quando", "onde", "quem", "qual", "quais", "cada",
    "porque", "entao", "então", "faz", "fazer", "fica", "ficar", "pode", "poder", "quer", "querer",
    "the", "of", "and", "to", "in", "is", "for", "with", "on", "at", "this", "that", "you", "i",
    "it", "be", "are", "was", "were", "an", "as", "by", "or", "not", "but", "if", "so", "do", "does",
    "did", "have", "has", "had", "will", "would", "can", "could", "should", "may", "might", "just",
    "from", "up", "out", "about", "into", "over", "under", "again", "then", "there", "here", "when",
    "what", "which", "who", "why", "how", "all", "each", "every", "any", "some", "no", "yes", "get",
    "got", "go", "going", "goes", "make", "made", "take", "took", "one", "two", "three", "new",
    "claro", "sobre", "entre", "disso", "disse", "falar", "fala", "falou", "vamos", "vem",
    "feito", "feita", "ainda", "cima", "baixo", "dia", "dias", "hoje", "ontem", "amanha",
    "agora", "sempre", "nunca", "talvez", "beleza", "blz", "ok", "okay", "oi", "ola", "olá", "tchau",
}


def env(name, default=""):
    return os.environ.get(name, default)


def resolve_workspace() -> Path:
    return Path(env("DGCLAW_WORKSPACE") or os.getcwd()).resolve()


def resolve_index_dir(workspace: Path) -> Path:
    override = env("DGCLAW_MEMORY_INDEX_DIR")
    if override:
        return Path(override).resolve()
    return workspace / ".dgclaw" / "memory_index"


def resolve_session_dir(workspace: Path) -> Path:
    """Dir dos transcripts .jsonl da sessao. Default = convencao do Claude Code:
    ~/.claude/projects/<abs-workspace-com-barras-viradas-em-tracos>.
    """
    override = env("DGCLAW_SESSION_DIR")
    if override:
        return Path(override).resolve()
    encoded = str(workspace).replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded


def normalize(s: str) -> str:
    s = s.lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s


def tokenize(text: str) -> list[str]:
    text = normalize(text)
    raw = re.findall(r"[a-z0-9_]+", text)
    return [t for t in raw if len(t) >= MIN_TOKEN_LEN and t not in STOPWORDS_PT and not t.isdigit()]


def extract_text(jsonl_path: Path) -> list[str]:
    """Extrai apenas conteudo conversacional (user channel + assistant text).

    Pula tool_use, tool_result, system — pra o baseline refletir LINGUAGEM da
    conversa, nao vocab tecnico (paths, comandos bash, etc).
    """
    texts = []
    try:
        with jsonl_path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                t = d.get("type")
                msg = d.get("message", {}) or {}
                content = msg.get("content")
                if t == "user":
                    if isinstance(content, str):
                        if "<channel" in content:
                            inner = re.sub(r"<channel[^>]*>", "", content)
                            inner = re.sub(r"</channel>", "", inner)
                            texts.append(inner.strip())
                    # tool_result ignorado
                elif t == "assistant" and isinstance(content, list):
                    for b in content:
                        if b.get("type") == "text":
                            texts.append(b.get("text", ""))
    except Exception as e:
        sys.stderr.write(f"skip {jsonl_path.name}: {e}\n")
    return texts


def main():
    # Sem gate de chave: o vocabulario e so contagem de palavras, local e de graca. Ate
    # 05/10/2026 ele exigia GEMINI_API_KEY e, sem ela, o caminho rapido da busca nunca
    # tinha baseline para achar a palavra estranha.

    slug = env("DGCLAW_SLUG") or "persona"
    workspace = resolve_workspace()
    sessions_dir = resolve_session_dir(workspace)
    index_dir = resolve_index_dir(workspace)
    out_path = index_dir / "baseline-vocab.json"

    index_dir.mkdir(parents=True, exist_ok=True)

    if not sessions_dir.exists():
        print(f"[{slug}] session dir nao existe ({sessions_dir}); baseline vazio")
        out_path.write_text(json.dumps({
            "generated_at": datetime.now().astimezone().isoformat(),
            "sessions_scanned": 0,
            "raw_chars": 0,
            "vocab_total_unique": 0,
            "top_n": TOP_N,
            "vocab": {},
        }, ensure_ascii=False, indent=2))
        sys.exit(0)

    cutoff = datetime.now().timestamp() - DAYS_LOOKBACK * 86400
    counter = Counter()
    files = 0
    raw_chars = 0
    for p in sessions_dir.glob("*.jsonl"):
        try:
            if p.stat().st_mtime < cutoff:
                continue
            if p.stat().st_size < 5_000:
                continue
        except OSError:
            continue
        files += 1
        for chunk in extract_text(p):
            raw_chars += len(chunk)
            for tok in tokenize(chunk):
                counter[tok] += 1

    common = dict(counter.most_common(TOP_N))
    out = {
        "generated_at": datetime.now().astimezone().isoformat(),
        "sessions_scanned": files,
        "raw_chars": raw_chars,
        "vocab_total_unique": len(counter),
        "top_n": TOP_N,
        "vocab": common,
    }
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"[{slug}] baseline: {files} sessions, {raw_chars} chars, {len(counter)} unique, top {TOP_N} -> {out_path}")


if __name__ == "__main__":
    main()
