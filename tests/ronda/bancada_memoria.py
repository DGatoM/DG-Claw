"""Bancada de memória da ronda de segurança (não entra no rodar.sh): mede o pico de memória de UMA rodada completa contra
um OSV falso com registros do tamanho dos reais, para comparar versões do ronda.py.

    python3 -I tests/ronda/bancada_memoria.py [--ronda CAMINHO/ronda.py] [--economica] [--ids 3000] [--pacotes 880]

Sobe um servidor HTTP local (KEV, Hacker News, NVD, GitHub, USN e OSV); o OSV devolve, para um inventário falso de ~880 pacotes
Ubuntu mais o kernel em execução, `--ids` vulnerabilidades no querybatch. Os detalhes são gerados na hora, por id, e nunca
guardados: 60% "tipo kernel" (~120 affected de vários releases, cada um com 150 versões, perto de 400 KB de JSON) e 40% pequenos
(~5 KB). A rodada roda como SUBPROCESSO (`python3 -I ronda.py executar --sem-avisar`) numa raiz falsa, e o pico é o
ru_maxrss do filho. Saída: uma linha `pico_mb=<n> tempo_s=<n> achados=<n> parcial=<sim/nao>`.
"""
import argparse
import json
import os
import resource
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

AQUI = os.path.dirname(os.path.abspath(__file__))
RONDA_NOVA = os.path.join(AQUI, "..", "..", "seguranca", "ronda", "ronda.py")
ECO = "Ubuntu:24.04:LTS"
KERNEL_VER = "6.8.0-147.153"
CRACHA = "cracha-da-bancada"
CFG = {"ids": 3000, "pacotes": 880, "kernel_ids": 1800}
RELEASES = ["14.04:LTS", "16.04:LTS", "18.04:LTS", "20.04:LTS", "22.04:LTS", "24.04:LTS", "24.10", "25.04"]
NOMES_KERNEL = ["linux", "linux-aws", "linux-azure", "linux-gcp", "linux-oracle", "linux-raspi", "linux-hwe-6.8", "linux-lowlatency"]


def nome_pacote(i):
    return f"pacote{i:04d}"


def dono_do_id(n):
    """Pacote (nome, versão) que o querybatch devolve com o id n."""
    if n < CFG["kernel_ids"]:
        return "linux", KERNEL_VER
    outros = max(1, min(CFG["pacotes"] - 2, 200))
    return nome_pacote((n - CFG["kernel_ids"]) % outros), "1.0-1ubuntu1"


def ids_de(nome):
    if nome == "linux":
        return list(range(min(CFG["kernel_ids"], CFG["ids"])))
    outros = max(1, min(CFG["pacotes"] - 2, 200))
    i = int(nome[6:])
    return [n for n in range(CFG["kernel_ids"], CFG["ids"]) if (n - CFG["kernel_ids"]) % outros == i]


def vid_de(n):
    return f"UBUNTU-CVE-2026-{n + 10000}"


def registro(n):
    """Registro OSV do id n, determinístico. Tipo kernel quando n % 10 < 6."""
    nome, _ = dono_do_id(n)
    vid = vid_de(n)
    afetados = [{"package": {"ecosystem": ECO, "name": nome},
                 "ranges": [{"type": "ECOSYSTEM", "events": [{"introduced": "0"}, {"fixed": "99.0-1"}]}],
                 "ecosystem_specific": {"priority": "medium"}}]
    if n % 10 < 6:
        for k in range(119):
            rel = RELEASES[k % len(RELEASES)]
            eco = f"Ubuntu:{rel}" if k % 2 == 0 else f"Ubuntu:Pro:{rel}"
            afetados.append({
                "package": {"ecosystem": eco, "name": NOMES_KERNEL[k % len(NOMES_KERNEL)], "purl": f"pkg:deb/ubuntu/x@{k}?arch=src"},
                "ranges": [{"type": "ECOSYSTEM", "events": [{"introduced": "0"}, {"fixed": f"5.15.0-{1000 + k}.{k}"}]}],
                "versions": [f"5.15.0-{j}.{j}~{rel[:5]}.1" for j in range(150)],
                "ecosystem_specific": {"priority": "medium"}})
        details = "Vários problemas foram encontrados no kernel Linux. " * 40
    else:
        details = "Uma falha foi encontrada em um pacote do sistema. " * 20
    return {"schema_version": "1.6.0", "id": vid, "summary": f"Falha {vid}", "details": details,
            "aliases": [f"CVE-2026-{n + 10000}"], "upstream": [f"CVE-2026-{n + 10000}"], "published": "2026-10-20T00:00:00Z",
            "modified": "2026-10-30T00:00:00Z",
            "severity": [{"type": "Ubuntu", "score": "medium"}], "affected": afetados,
            "references": [{"type": "REPORT", "url": f"https://ubuntu.com/security/CVE-2026-{n + 10000}"}] * 5}


USN_ARQUIVOS = [f"osv/usn/USN-8{i:03d}-1.json" for i in range(60)]
SHA = "a" * 40


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _out(self, obj, status=200, extra=None):
        corpo = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(corpo)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(corpo)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        corpo = json.loads(self.rfile.read(n) or b"{}")
        if self.path.startswith("/v1/querybatch"):
            res = []
            for q in corpo["queries"]:
                nome, ver = q["package"]["name"], q["version"]
                r = {}
                if q["package"]["ecosystem"] == ECO and (nome == "linux" and ver == KERNEL_VER or nome.startswith("pacote") and ver == "1.0-1ubuntu1"):
                    todos = ids_de(nome)
                    pag = int(q.get("page_token", "0"))
                    fatia = todos[pag * 500:(pag + 1) * 500]
                    if fatia:
                        r["vulns"] = [{"id": vid_de(i), "modified": "2026-10-30T00:00:00Z"} for i in fatia]
                    if (pag + 1) * 500 < len(todos):
                        r["next_page_token"] = str(pag + 1)
                res.append(r)
            return self._out({"results": res})
        self._out({"ok": True})

    def do_GET(self):
        p = urlparse(self.path).path
        if p.startswith("/v1/vulns/"):
            vid = p.split("/v1/vulns/")[1]
            try:
                n = int(vid.rsplit("-", 1)[1]) - 10000
            except ValueError:
                return self._out({"code": 5}, 404)
            if not 0 <= n < CFG["ids"]:
                return self._out({"code": 5}, 404)
            return self._out(registro(n))
        if p == "/kev.json":
            return self._out({"vulnerabilities": []})
        if p == "/hn":
            return self._out({"hits": []})
        if p == "/nvd":
            return self._out({"vulnerabilities": []})
        if p == "/api/saude":
            return self._out({"ok": True})
        if p.startswith("/gh/"):
            rl = {"X-RateLimit-Remaining": "50"}
            if p == "/gh/repos/canonical/ubuntu-security-notices/commits":
                return self._out([{"sha": SHA}], 200, rl)
            if p.startswith("/gh/repos/canonical/ubuntu-security-notices/commits/"):
                return self._out({"files": [{"filename": f, "status": "added"} for f in USN_ARQUIVOS]}, 200, rl)
            if p == "/gh/advisories":
                return self._out([], 200, rl)
        if p.startswith("/raw/canonical/ubuntu-security-notices/"):
            nome = p.split("/", 5)[5]
            if nome in USN_ARQUIVOS:
                i = USN_ARQUIVOS.index(nome)
                return self._out({"id": f"USN-8{i:03d}-1", "summary": "Atualização de segurança", "details": "x" * 800,
                                  "published": "2026-10-25T00:00:00Z", "upstream": [f"CVE-2026-{20000 + i}"],
                                  "affected": [{"package": {"ecosystem": ECO, "name": nome_pacote(i)},
                                                "ranges": [{"type": "ECOSYSTEM", "events": [{"introduced": "0"}, {"fixed": "99.0-1"}]}]}]})
        self._out({}, 404)


def escreve(caminho, conteudo):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    with open(caminho, "w", encoding="utf-8") as f:
        f.write(conteudo if isinstance(conteudo, str) else json.dumps(conteudo))


def monta_raiz(tmp, url):
    raiz, stub, proc = (os.path.join(tmp, x) for x in ("raiz", "estado", "proc"))
    shutil.copytree(os.path.join(AQUI, "stubs"), os.path.join(tmp, "bin"))
    os.makedirs(os.path.join(stub, "sysctl"))
    dpkg = [("linux-modules-6.8.0-147-generic", KERNEL_VER, "linux", KERNEL_VER),
            ("linux-image-6.8.0-147-generic", KERNEL_VER, "linux-signed", KERNEL_VER)]
    dpkg += [(nome_pacote(i), "1.0-1ubuntu1", nome_pacote(i), "1.0-1ubuntu1") for i in range(CFG["pacotes"] - 2)]
    escreve(os.path.join(stub, "dpkg.txt"), "".join("\t".join(x) + "\n" for x in dpkg))
    escreve(os.path.join(stub, "uname"), "6.8.0-147-generic\n")
    escreve(os.path.join(stub, "ss.txt"), "")
    escreve(os.path.join(stub, "dpkg-S.txt"), "")
    escreve(os.path.join(stub, "needrestart.txt"), "NEEDRESTART-VER: 3.6\nNEEDRESTART-KSTA: 1\n")
    escreve(os.path.join(stub, "sysctl", "net.mptcp.enabled"), "1\n")
    os.makedirs(proc)
    escreve(os.path.join(raiz, "etc/os-release"), 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n')
    escreve(os.path.join(raiz, "etc/dgclaw/dgclaw.env"), "DGCLAW_DOMINIO=x.exemplo.org\n")
    escreve(os.path.join(raiz, "etc/dgclaw/runner/admin.token"), CRACHA + "\n")
    escreve(os.path.join(raiz, "opt/dgclaw/app/VERSAO"), "1.0.0\n")
    pacotes_npm = {f"node_modules/pacote-npm-{i}": {"version": f"1.{i}.0"} for i in range(209)}
    escreve(os.path.join(raiz, "opt/dgclaw/app/web/package-lock.json"), {"packages": {"": {"name": "web"}, **pacotes_npm}})
    escreve(os.path.join(raiz, "opt/dgclaw/app/seguranca/acoes-permitidas.json"), {"versao": 1, "acoes": []})
    escreve(os.path.join(raiz, "etc/dgclaw/agentes.json"), {"versao": 1, "agentes": []})
    escreve(os.path.join(raiz, "opt/dgclaw/app/container/Containerfile"), "FROM docker.io/library/ubuntu:24.04 AS base\n")
    return raiz, stub, proc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ronda", default=RONDA_NOVA, help="ronda.py a medir (config.json e servicos.json ficam ao lado dele)")
    ap.add_argument("--economica", action="store_true", help="liga DGCLAW_RONDA_ECONOMICA=1 (simula servidor de 4 GB)")
    ap.add_argument("--ids", type=int, default=3000, help="vulnerabilidades devolvidas pelo querybatch")
    ap.add_argument("--pacotes", type=int, default=880, help="pacotes Ubuntu do inventário falso")
    ap.add_argument("--teto-mb", help="DGCLAW_RONDA_TETO_MB (só as versões novas conhecem)")
    a = ap.parse_args()
    if not os.path.isfile(a.ronda):
        print(f"bancada: não achei o ronda.py em '{a.ronda}'. Passe o caminho certo em --ronda.", file=sys.stderr)
        return 2
    CFG.update(ids=a.ids, pacotes=a.pacotes, kernel_ids=min(1800, a.ids * 6 // 10))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    tmp = tempfile.mkdtemp(prefix="bancada-ronda-")
    try:
        raiz, stub, proc = monta_raiz(tmp, url)
        env = {"PATH": f"{tmp}/bin:/usr/bin:/bin", "TZ": "UTC", "STUB_DIR": stub, "DGCLAW_RAIZ": raiz,
               "DGCLAW_RONDA_AGORA": "2026-10-31T10:00:00Z", "DGCLAW_RONDA_PROC": proc, "DGCLAW_RONDA_NVD_PAUSA": "0",
               "DGCLAW_RONDA_OSV_URL": url, "DGCLAW_RONDA_KEV_URL": url + "/kev.json", "DGCLAW_RONDA_HN_URL": url + "/hn",
               "DGCLAW_RONDA_NVD_URL": url + "/nvd", "DGCLAW_RONDA_GITHUB_API": url + "/gh", "DGCLAW_RONDA_GITHUB_RAW": url + "/raw",
               "DGCLAW_ADMIN_URL": url, "DGCLAW_RONDA_SAUDE_URL": url + "/api/saude", "HOME": tmp}
        if a.economica:
            env["DGCLAW_RONDA_ECONOMICA"] = "1"
        if a.teto_mb:
            env["DGCLAW_RONDA_TETO_MB"] = a.teto_mb
        t0 = time.time()
        r = subprocess.run([sys.executable, "-I", a.ronda, "executar", "--sem-avisar"], capture_output=True, text=True, env=env, timeout=1800)
        tempo = time.time() - t0
        pico = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
        achados, parcial = 0, "?"
        try:
            with open(os.path.join(raiz, "var/lib/dgclaw/web/seguranca/ronda.json"), encoding="utf-8") as f:
                doc = json.load(f)
            achados, parcial = len(doc.get("achados") or []), "sim" if doc.get("parcial") else "nao"
            for fonte in doc.get("fontes") or []:
                if not fonte.get("ok"):
                    print(f"bancada: fonte parcial: {fonte.get('nome')}: {fonte.get('motivo')}", file=sys.stderr)
        except (OSError, ValueError) as e:
            print(f"bancada: a rodada não deixou ronda.json legível ({e}). Saída da rodada:\n{r.stdout[-800:]}\n{r.stderr[-800:]}", file=sys.stderr)
        if r.returncode != 0:
            print(f"bancada: a rodada terminou com código {r.returncode}: {r.stderr[-400:]}", file=sys.stderr)
        print(f"pico_mb={pico:.0f} tempo_s={tempo:.1f} achados={achados} parcial={parcial}")
        return 0 if r.returncode == 0 else 1
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
