#!/usr/bin/env python3
"""memory_search_fast.py — busca de memoria sub-2s pro hook do Telegram.

Recebe a mensagem do dono, decide rapido se vale procurar na memoria semantica,
e se achar algo relevante devolve um "lembrete" pro assistente.

Heuristica (sem chamar nenhum modelo extra, so pra ser rapido):
  1. Tem alguma palavra "fora do comum" na mensagem? (token >= 5 letras, nao e
     stopword nem numero). Se nao, nem procura — provavelmente e conversa banal.
  2. Se tem, gera o embedding da mensagem e pega o chunk mais parecido no
     chunks.db. Dispara se a similaridade passar do threshold.

Zero-config: NAO precisa de baseline de vocabulario. Degrada sozinho —
sem GEMINI_API_KEY ou sem chunks.db, retorna fired=false sem quebrar.

Uso (chamado pelo hook UserPromptSubmit):
  echo '{"input":"texto da msg"}' | python3 memory_search_fast.py
Saida: JSON {fired, trigger, recall, score, source, duration_ms, skip_reason}.
"""
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from memory_search import unpack_floats, cosine, embed_query, db_path  # noqa

SIMILARITY_THRESHOLD = 0.70
MIN_STRANGE_LEN = 5
MAX_INPUT_CHARS = 1200

STOPWORDS = {
    "voce","vc","tudo","bom","boa","mais","menos","ainda","sobre","entre","essa",
    "esse","isso","aquele","aquela","tipo","cara","claro","beleza","blz","oi","ola",
    "ola","ai","la","pode","quer","preciso","posso","fala","falar","entao","entao",
    "agora","depois","antes","sempre","nunca","aqui","ali","mesmo","mesma","outro",
    "outra","outros","outras","todo","toda","todos","todas","cada","alo","tambem",
    "talvez","pouco","muito","muita","muitas","como","hoje","ontem","amanha","tarde",
    "noite","manha","fazer","fazendo","feito","feita","lembra","lembro","lembrar",
    "conversamos","conversar","fevereiro","janeiro","marco","abril","maio","junho",
    "julho","agosto","setembro","outubro","novembro","dezembro","semana","mes","ano",
    "queria","poder","podia","podemos","quero","queremos","olha","veja","vejo","viu",
    "the","of","and","to","in","is","for","with","on","at","that","you","this","be",
    "are","an","as","by","or","not","but","if","so","do","does","did","have","has",
    "voce","esta","estao","estou","estamos","ser","estar","isso","aquilo",
}


def normalize(s: str) -> str:
    s = s.lower()
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


def strange_tokens(text: str):
    raw = re.findall(r"[a-z0-9_]+", normalize(text))
    seen, out = set(), []
    for t in raw:
        if len(t) < MIN_STRANGE_LEN or t.isdigit() or t in STOPWORDS or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def search_top1(query: str, threshold=SIMILARITY_THRESHOLD):
    qvec = embed_query(query)
    db = db_path()
    if not qvec or not db.exists():
        return None
    conn = sqlite3.connect(db)
    rows = conn.execute(
        "SELECT id, source_path, source_type, date, content, embedding FROM chunks").fetchall()
    conn.close()
    best = None
    for cid, src, stype, date, content, blob in rows:
        sim = cosine(qvec, unpack_floats(blob))
        if best is None or sim > best["score"]:
            best = {"id": cid, "source": Path(src).name, "date": date,
                    "score": round(sim, 3), "content": content}
    return best if best and best["score"] >= threshold else None


def run(input_text: str) -> dict:
    t0 = time.time()
    out = {"fired": False, "trigger": None, "recall": None, "score": None,
           "source": None, "duration_ms": 0, "skip_reason": None}

    def done(reason=None):
        out["skip_reason"] = reason
        out["duration_ms"] = int((time.time() - t0) * 1000)
        return out

    if not input_text or len(input_text.strip()) < 5:
        return done("input_too_short")
    strange = strange_tokens(input_text[:MAX_INPUT_CHARS])
    if not strange:
        return done("no_strange_tokens")
    if not os.environ.get("GEMINI_API_KEY"):
        return done("no_gemini_key")
    if not db_path().exists():
        return done("no_index")

    chunk = search_top1(input_text[:MAX_INPUT_CHARS])
    if not chunk:
        out["trigger"] = strange[0]
        return done("below_threshold")

    trigger = ", ".join(strange[:3])
    out.update({
        "fired": True,
        "trigger": trigger,
        "score": chunk["score"],
        "source": f"{chunk['source']} ({chunk['date'] or '?'})",
        "recall": (
            "MEMORIA ERRANTE (use so se fizer sentido — pode ser irrelevante).\n"
            f"Disparou porque ele mencionou: {trigger}\n"
            f"Achei isso em {chunk['source']} ({chunk['date'] or '?'}, "
            f"similaridade {chunk['score']}):\n\n{chunk['content'][:600]}"
        ),
    })
    out["duration_ms"] = int((time.time() - t0) * 1000)
    return out


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        text = payload.get("input", "") or ""
    except Exception:
        text = ""
    print(json.dumps(run(text), ensure_ascii=False))


if __name__ == "__main__":
    main()
