#!/usr/bin/env python3
"""memory_recall_local.py — recall de memoria LOCAL, sem nenhuma API externa.

Em vez de embeddings (que exigiriam um servico externo tipo Gemini), faz uma
busca por palavra-chave nos arquivos de memoria do workspace. Instantaneo,
gratis e sem dependencia nenhuma — so o Python padrao.

Heuristica:
  1. Extrai da mensagem as palavras "fora do comum" (>=5 letras, nao stopword).
  2. Procura essas palavras (sem acento, case-insensitive) nas linhas de
     MEMORY.md, working-memory.md e memory/*.md.
  3. Devolve ate N linhas que casaram, como "lembrete" pro assistente.

Entrada (stdin):  {"input": "texto da msg"}
Saida (stdout):   {"fired": bool, "trigger": "...", "recall": "...|null"}
Workspace via env DGCLAW_WORKSPACE (default: cwd).
"""
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

MIN_LEN = 5
MAX_LINES = 8
MAX_INPUT = 1200

STOPWORDS = {
    "voce","vc","tudo","sobre","entre","essa","esse","isso","aquele","aquela",
    "tipo","cara","claro","beleza","preciso","posso","fala","falar","entao",
    "agora","depois","antes","sempre","nunca","mesmo","outro","outra","todos",
    "todas","cada","tambem","talvez","pouco","muito","muita","como","hoje",
    "ontem","amanha","tarde","noite","manha","fazer","fazendo","feito","lembra",
    "lembro","lembrar","conversamos","conversar","semana","quando","onde","qual",
    "quais","queria","poder","podia","quero","queremos","olha","veja","estao",
    "estou","estamos","ser","estar","aquilo","coisa","coisas","sabe","saber",
}


def deaccent(s: str) -> str:
    s = s.lower()
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


def tokens(text: str):
    seen, out = set(), []
    for t in re.findall(r"[a-z0-9_]+", deaccent(text)):
        if len(t) >= MIN_LEN and not t.isdigit() and t not in STOPWORDS and t not in seen:
            seen.add(t); out.append(t)
    return out


def sources(ws: Path):
    for name in ("MEMORY.md", "working-memory.md"):
        p = ws / name
        if p.exists():
            yield p
    md = ws / "memory"
    if md.exists():
        yield from sorted(md.glob("*.md"))


def run(text: str) -> dict:
    out = {"fired": False, "trigger": None, "recall": None}
    if not text or len(text.strip()) < 5:
        return out
    toks = tokens(text[:MAX_INPUT])
    if not toks:
        return out
    ws = Path(os.environ.get("DGCLAW_WORKSPACE", ".")).expanduser()
    hits = []
    seen_lines = set()
    for p in sources(ws):
        try:
            for raw in p.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if len(line) < 8 or line.startswith("#") or line.startswith(">"):
                    continue
                dl = deaccent(line)
                matched = [t for t in toks if t in dl]
                if matched:
                    key = line[:120]
                    if key in seen_lines:
                        continue
                    seen_lines.add(key)
                    hits.append((len(matched), f"- ({p.name}) {line}"))
        except Exception:
            continue
    if not hits:
        return out
    hits.sort(key=lambda x: x[0], reverse=True)
    chosen = [h[1] for h in hits[:MAX_LINES]]
    trig = ", ".join(toks[:3])
    out["fired"] = True
    out["trigger"] = trig
    out["recall"] = (
        "MEMORIA RELACIONADA (use so se fizer sentido — pode ser irrelevante).\n"
        f"Disparou por: {trig}\n" + "\n".join(chosen)
    )
    return out


def main():
    try:
        raw = sys.stdin.read()
        text = (json.loads(raw).get("input") if raw.strip() else "") or ""
    except Exception:
        text = ""
    print(json.dumps(run(text), ensure_ascii=False))


if __name__ == "__main__":
    main()
