#!/usr/bin/env python3
"""Mede a acurácia do motor de anonimização contra o gabarito (dados 100% fictícios).

  python3 avaliar.py --python /caminho/do/venv/bin/python --base /caminho/da/base --rodadas 3 --saida resultado.md
  python3 avaliar.py --nivel regex ...       base vazia: sem o detector de nomes, só regex

Para cada documento roda a op `anonimizar` do motor real (opções valores, datas e empresas ligadas), com tabela vazia
e processo novo a cada rodada. Alinha o texto original e o anonimizado por tokens (difflib) e mede, por tipo:
recall (o trecho sumiu e virou marcador; "qualquer tipo" e "tipo certo"), falso positivo (marcador onde o
gabarito não manda marcar; as armadilhas separadas), estabilidade entre rodadas, tempo e RSS de pico.
Roda com o Python do venv que tem pypdf, python-docx e openpyxl (usa os leitores só para o texto de referência).
"""
import argparse
import csv
import difflib
import io
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
sys.path.insert(0, RAIZ)
sys.path.insert(0, AQUI)

import gerar_corpus  # noqa: E402

RX_TOKEN = re.compile(r"\[[A-Z]+_\d+\]|\w+|[^\w\s\"]")
RX_MARCADOR = re.compile(r"\[([A-Z]+)_\d+\]")
MOTOR_DIR = RAIZ
CONJUNTOS = {
    "principal": ("fontes", "gabarito.json"),
    "validacao": ("fontes-validacao", "gabarito-validacao.json"),
}


def tokens(texto):
    return RX_TOKEN.findall(texto)


def texto_referencia(caminho, formato):
    """O texto que o motor lê do original, sem anonimizar (base do alinhamento)."""
    import documentos as docs
    nome = os.path.basename(caminho)
    if formato == "txt":
        return docs.ler_texto(caminho)
    if formato == "pdf":
        return docs.pdf_texto(caminho, nome)
    if formato == "docx":
        return docs.docx_para_md(caminho)
    if formato == "xlsx":
        wb = docs.xlsx_abrir(caminho, nome, data_only=True)
        buf = io.StringIO()
        for ws in wb.worksheets:
            w = csv.writer(buf, lineterminator="\n")
            for linha in ws.iter_rows():
                w.writerow(["" if c.value is None else c.value for c in linha])
        return buf.getvalue()
    raise SystemExit("formato desconhecido " + formato)


def ler_saida(saida_dir, base):
    for ext in (".md", ".csv", ".json"):
        for nome in sorted(os.listdir(saida_dir)):
            if nome.startswith(base + ".anon") and nome.endswith(ext):
                with open(os.path.join(saida_dir, nome), encoding="utf-8") as f:
                    return f.read()
    return None


class Motor:
    def __init__(self, python, base):
        env = dict(os.environ, DGCLAW_ANON_BASE=base)
        env.pop("DGCLAW_ANON_NER", None)
        self.p = subprocess.Popen([python, "-I", os.path.join(MOTOR_DIR, "motor.py"), "servir"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)

    def pedir(self, req):
        self.p.stdin.write(json.dumps(req) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def pico_rss_mb(self):
        try:
            with open("/proc/%d/status" % self.p.pid) as f:
                for l in f:
                    if l.startswith("VmHWM:"):
                        return int(l.split()[1]) // 1024
        except OSError:
            pass
        return 0

    def fechar(self):
        self.p.stdin.close()
        self.p.wait(timeout=30)


def localizar(ref_tokens, trecho, a_partir):
    """Posição (inicio, fim) em tokens da primeira ocorrência do trecho depois de `a_partir`, ou None."""
    alvo = tokens(trecho)
    n = len(alvo)
    for i in range(a_partir, len(ref_tokens) - n + 1):
        if ref_tokens[i:i + n] == alvo:
            return i, i + n
    return None


def analisar_doc(doc, ref_texto, out_texto):
    ref, out = tokens(ref_texto), tokens(out_texto)
    ops = difflib.SequenceMatcher(None, ref, out, autojunk=False).get_opcodes()
    mudados = [(i1, i2, [m for m in out[j1:j2] if RX_MARCADOR.fullmatch(m)]) for tag, i1, i2, j1, j2 in ops
               if tag != "equal" and (i2 > i1 or any(RX_MARCADOR.fullmatch(m) for m in out[j1:j2]))]
    coberto = {}
    for i1, i2, ms in mudados:
        for i in range(i1, i2):
            coberto[i] = ms
    itens, naoloc, arm_pos, cursor = [], [], [], 0
    for it in doc["itens"]:
        pos = localizar(ref, it["texto"], cursor)
        if pos is None:
            naoloc.append(it)
            continue
        cursor = pos[1]
        if it["tipo"] == "!":
            arm_pos.append((pos, it["texto"]))
            continue
        palavras = [i for i in range(*pos) if re.match(r"\w", ref[i])]
        cob = [i for i in palavras if i in coberto]
        marcas = {RX_MARCADOR.fullmatch(m).group(1) for i in range(*pos) if i in coberto for m in coberto[i]}
        itens.append({"tipo": it["tipo"], "texto": it["texto"], "pos": pos, "pego": bool(palavras) and len(cob) == len(palavras),
                      "parcial": 0 < len(cob) < len(palavras), "tipo_certo": it["tipo"] in marcas, "marcas": sorted(marcas)})
    esperado_idx = {i for it in itens for i in range(*it["pos"])}
    fps, extensoes = [], []
    for i1, i2, ms in mudados:
        if not ms:
            continue
        rng = set(range(i1, i2))
        trecho = " ".join(ref[i1:i2])
        tipos = sorted({RX_MARCADOR.fullmatch(m).group(1) for m in ms})
        if rng & esperado_idx:
            extra = [ref[i] for i in sorted(rng - esperado_idx) if re.match(r"\w", ref[i])]
            if extra:
                extensoes.append({"trecho": trecho, "tipos": tipos})
            continue
        arm = [t for (p, t) in arm_pos if rng & set(range(*p))]
        fps.append({"trecho": trecho, "tipos": tipos, "armadilha": bool(arm)})
    arm_marcadas = [t for (p, t) in arm_pos if any(i in coberto for i in range(*p))]
    return {"itens": itens, "naoloc": naoloc, "fps": fps, "extensoes": extensoes, "arm_total": len(arm_pos), "arm_marcadas": arm_marcadas}


def rodar(args, docs, corpus):
    base = args.base
    if args.nivel == "regex":
        base = tempfile.mkdtemp(prefix="anon-base-vazia-")
    rodadas = []
    try:
        for r in range(args.rodadas):
            motor = Motor(args.python, base)
            res = {}
            for doc in docs:
                saida = tempfile.mkdtemp(prefix="anon-aval-saida-")
                t0 = time.time()
                resp = motor.pedir({"op": "anonimizar", "entrada": os.path.join(corpus, doc["arquivo"]), "saida_dir": saida, "nome_base": "doc",
                                    "tabela": [], "opcoes": {"valores": True, "datas": True, "empresas": True}})
                dt = time.time() - t0
                out = ler_saida(saida, "doc") if resp.get("ok") else None
                shutil.rmtree(saida, ignore_errors=True)
                res[doc["id"]] = {"resp": resp, "saida": out, "seg": dt}
            rodadas.append({"docs": res, "rss": motor.pico_rss_mb()})
            motor.fechar()
    finally:
        if args.nivel == "regex":
            shutil.rmtree(base, ignore_errors=True)
    return rodadas


def pct(a, b):
    return "%.1f%%" % (100.0 * a / b) if b else "n/a"


def relatorio(args, docs, corpus, rodadas):
    refs = {d["id"]: texto_referencia(os.path.join(corpus, d["arquivo"]), d["formato"]) for d in docs}
    analises = []   # por rodada: {id: analise}
    falhas = []
    for rod in rodadas:
        a = {}
        for d in docs:
            r = rod["docs"][d["id"]]
            if r["saida"] is None:
                falhas.append((d["id"], r["resp"].get("erro", "?")))
                continue
            a[d["id"]] = analisar_doc(d, refs[d["id"]], r["saida"])
        analises.append(a)
    prim = analises[0]
    tipos = sorted({it["tipo"] for d in docs for it in d["esperados"]})
    linhas = ["| Tipo | Esperado | Pego (qualquer tipo) | Recall | Pego com o tipo certo | Recall (tipo certo) | Parcial | Escapou |", "|---|---|---|---|---|---|---|---|"]
    tot = dict(e=0, p=0, t=0, par=0)
    escapes = []
    for tp in tipos:
        e = p = t = par = 0
        for did, an in prim.items():
            for it in an["itens"]:
                if it["tipo"] != tp:
                    continue
                e += 1
                p += it["pego"]
                t += it["pego"] and it["tipo_certo"]
                par += it["parcial"]
                if not it["pego"]:
                    escapes.append((did, it))
        linhas.append("| %s | %d | %d | %s | %d | %s | %d | %d |" % (tp, e, p, pct(p, e), t, pct(t, e), par, e - p))
        tot["e"] += e; tot["p"] += p; tot["t"] += t; tot["par"] += par
    linhas.append("| **Total** | **%d** | **%d** | **%s** | **%d** | **%s** | **%d** | **%d** |" % (
        tot["e"], tot["p"], pct(tot["p"], tot["e"]), tot["t"], pct(tot["t"], tot["e"]), tot["par"], tot["e"] - tot["p"]))
    nao_loc = sum(len(an["naoloc"]) for an in prim.values())
    fp_geral = [(did, f) for did, an in prim.items() for f in an["fps"] if not f["armadilha"]]
    fp_arm = [(did, f) for did, an in prim.items() for f in an["fps"] if f["armadilha"]]
    arm_total = sum(an["arm_total"] for an in prim.values())
    arm_marc = sum(len(an["arm_marcadas"]) for an in prim.values())
    marcadores_total = tot["p"] + len(fp_geral) + len(fp_arm)
    # estabilidade
    est_docs_dif, est_itens_dif = 0, 0
    for d in docs:
        saidas = [rod["docs"][d["id"]]["saida"] for rod in rodadas]
        if len(set(saidas)) > 1:
            est_docs_dif += 1
        if d["id"] in prim:
            base_status = [(i["pego"], i["tipo_certo"]) for i in prim[d["id"]]["itens"]]
            for an in analises[1:]:
                if d["id"] in an:
                    est_itens_dif += sum(1 for x, y in zip(base_status, [(i["pego"], i["tipo_certo"]) for i in an[d["id"]]["itens"]]) if x != y)
    recalls = [sum(i["pego"] for an in a.values() for i in an["itens"]) / max(1, sum(len(an["itens"]) for an in a.values())) for a in analises]
    tempos = {d["id"]: statistics.mean(rod["docs"][d["id"]]["seg"] for rod in rodadas) for d in docs}
    o = []
    o.append("# Acurácia do motor de anonimização (%s)\n" % args.rotulo)
    o.append("Conjunto: **%s**, %d documentos, %d trechos esperados, %d armadilhas. Rodadas: %d (tabela vazia e processo novo em cada uma). "
             "Opções: valores, datas e empresas ligadas. Nível: **%s**.\n" % (args.conjunto, len(docs), sum(len(d["esperados"]) for d in docs),
                                                                              sum(len(d["armadilhas"]) for d in docs), len(rodadas), args.nivel))
    if falhas:
        o.append("**Documentos que o motor recusou:** " + "; ".join("%s (%s)" % f for f in falhas) + "\n")
    o.append("## Recall por tipo (primeira rodada)\n")
    o += linhas
    o.append("\nTrechos do gabarito que não deu para localizar no texto de referência (ignorados): %d%s.\n" % (
        nao_loc, "".join(" [%s: %s]" % (did, i["texto"]) for did, an in prim.items() for i in an["naoloc"])))
    o.append("## Falso positivo\n")
    o.append("- Marcadores onde o gabarito não manda marcar: **%d** fora das armadilhas e **%d** em cima de armadilhas." % (len(fp_geral), len(fp_arm)))
    o.append("- Armadilhas marcadas: **%d de %d** (%s). Precisão aproximada (acertos / acertos + falsos): **%s**." % (
        arm_marc, arm_total, pct(arm_marc, arm_total), pct(tot["p"], marcadores_total)))
    o.append("- Marcador que passou do trecho esperado (pegou palavra a mais): %d casos.\n" % sum(len(an["extensoes"]) for an in prim.values()))
    o.append("## Estabilidade\n")
    o.append("- Recall (qualquer tipo) por rodada: %s." % ", ".join("%.1f%%" % (100 * r) for r in recalls))
    o.append("- Documentos com saída diferente entre rodadas: **%d de %d**; itens do gabarito com resultado diferente: **%d**.\n" % (est_docs_dif, len(docs), est_itens_dif))
    o.append("## Tempo e memória\n")
    o.append("- Pico de RSS do processo (por rodada): %s MB." % ", ".join(str(r["rss"]) for r in rodadas))
    o.append("- Tempo médio por documento: %.2f s (mínimo %.2f s, máximo %.2f s). Total do corpus: %.1f s.\n" % (
        statistics.mean(tempos.values()), min(tempos.values()), max(tempos.values()), sum(tempos.values())))
    o.append("| Documento | Tempo médio (s) |\n|---|---|")
    o += ["| %s | %.2f |" % (k, v) for k, v in tempos.items()]
    o.append("\n## O que escapou (primeira rodada)\n")
    if escapes:
        o.append("| Documento | Tipo | Trecho | Resultado |\n|---|---|---|---|")
        for did, it in escapes:
            o.append("| %s | %s | %s | %s |" % (did, it["tipo"], it["texto"].replace("|", "/"), "parcial" if it["parcial"] else "intacto"))
    else:
        o.append("Nada escapou.")
    o.append("\n## Marcadores com tipo diferente do esperado\n")
    errados = [(did, it) for did, an in prim.items() for it in an["itens"] if it["pego"] and not it["tipo_certo"]]
    if errados:
        o.append("| Documento | Esperado | Trecho | Virou |\n|---|---|---|---|")
        for did, it in errados:
            o.append("| %s | %s | %s | %s |" % (did, it["tipo"], it["texto"].replace("|", "/"), ", ".join(it["marcas"])))
    else:
        o.append("Nenhum.")
    marcadas = [(did, t) for did, an in prim.items() for t in an["arm_marcadas"]]
    o.append("\n## Armadilhas que foram marcadas (primeira rodada)\n")
    o.append("\n".join("- %s: %s" % m for m in marcadas) if marcadas else "Nenhuma.")
    o.append("\n## Falsos positivos (primeira rodada)\n")
    if fp_geral or fp_arm:
        o.append("| Documento | Trecho marcado | Virou | Armadilha? |\n|---|---|---|---|")
        for did, f in fp_geral + fp_arm:
            o.append("| %s | %s | %s | %s |" % (did, f["trecho"].replace("|", "/"), ", ".join(f["tipos"]), "sim" if f["armadilha"] else "não"))
    else:
        o.append("Nenhum.")
    return "\n".join(o) + "\n", {"tot": tot, "fp": len(fp_geral), "fp_arm": len(fp_arm), "est": est_docs_dif}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--base", default=os.environ.get("DGCLAW_ANON_BASE", "/opt/dgclaw/anonimizar"))
    ap.add_argument("--nivel", choices=["completo", "regex"], default="completo")
    ap.add_argument("--rodadas", type=int, default=3)
    ap.add_argument("--conjunto", choices=sorted(CONJUNTOS), default="principal")
    ap.add_argument("--rotulo", default="")
    ap.add_argument("--saida")
    ap.add_argument("--motor-dir", help="pasta com o motor.py a medir (padrão: o do repositório); serve para comparar versões")
    ap.add_argument("--so", help="ids de documentos separados por vírgula")
    args = ap.parse_args()
    global MOTOR_DIR
    if args.motor_dir:
        MOTOR_DIR = os.path.abspath(args.motor_dir)
    fontes, gabarito = CONJUNTOS[args.conjunto]
    corpus = tempfile.mkdtemp(prefix="anon-corpus-")
    try:
        docs = gerar_corpus.gerar(os.path.join(AQUI, fontes), os.path.join(AQUI, gabarito), corpus)
        if args.so:
            docs = [d for d in docs if d["id"] in args.so.split(",")]
        rodadas = rodar(args, docs, corpus)
        texto, _ = relatorio(args, docs, corpus, rodadas)
    finally:
        shutil.rmtree(corpus, ignore_errors=True)
    if args.saida:
        with open(args.saida, "w", encoding="utf-8") as f:
            f.write(texto)
    print(texto)


if __name__ == "__main__":
    main()
