#!/usr/bin/env python3
"""embedder.py (DG Claw) — quem transforma texto em vetor para a memoria semantica.

POR QUE EXISTE (05/10/2026). Ate aqui a memoria semantica so funcionava com GEMINI_API_KEY,
e sem ela ficava desligada sem aviso nenhum. O DG Claw da Imersao tem que vir com todos os
poderes sem o aluno abrir conta nem pagar servico novo. Entao o padrao virou um modelo
LOCAL e gratuito, o EmbeddingGemma 300M (Google, GGUF Q8_0, 333 MB) rodando no llama.cpp
da propria VPS. Nada sai da maquina. O Gemini continua como opcao.

COMO O LOCAL RODA. O llama-server sobe so na hora da busca (2 s com 1 nucleo), numa porta
livre de 127.0.0.1, responde, e morre quando o processo que pediu termina. Usa ~600 MB de
RAM enquanto esta de pe e zero no resto do tempo: cabe numa KVM 1 (1 vCPU, 4 GB). O
reindex roda de madrugada. Medido em 05/10/2026 com 1 nucleo: 0,24 s por busca, ~1 s por
trecho de 200 palavras no reindex.

QUAL PROVEDOR VALE (DGCLAW_EMBED_PROVIDER):
  auto   (padrao) local se estiver instalado; senao Gemini se houver GEMINI_API_KEY; senao
         desligada, com o motivo e o comando que liga.
  local  so o local (instalar: bash scripts/install-embedding-local.sh)
  gemini so o Gemini (GEMINI_API_KEY; a chave gratuita do AI Studio deixa o Google usar o
         texto enviado, entao memoria do dono so com projeto que tem billing)
  off    desligada de proposito

Vetores de provedores diferentes NAO se misturam: cada um tem uma impressao digital
(fingerprint) gravada no chunks.db, e trocar de provedor obriga a reindexar.

Onde o local mora (DGCLAW_EMBED_DIR, senao o primeiro que existir):
  /opt/dgclaw/embed            instalacao como root, compartilhada por todos os agentes
  ~/.local/share/dgclaw/embed  instalacao de um usuario so
Dentro: llama/llama-server (com as .so ao lado) e embeddinggemma-300M-Q8_0.gguf.

Uso pela linha de comando (doctor e wizard):
  python3 embedder.py status          -> uma linha em portugues; rc 0 ligada, 1 desligada
  python3 embedder.py status --json   -> o mesmo em JSON
  python3 embedder.py teste           -> sobe o provedor e embeda uma frase (rc 0 = funciona)
"""

import atexit
import ctypes
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

DIM = 768

LOCAL_MODELO = "embeddinggemma-300M-Q8_0.gguf"
LOCAL_DIRS = (Path("/opt/dgclaw/embed"), Path.home() / ".local" / "share" / "dgclaw" / "embed")
# Os prefixos que o EmbeddingGemma espera (model card): a busca e o documento sao
# embedados com instrucoes diferentes, e sem eles a qualidade cai.
LOCAL_PREFIXO_BUSCA = "task: search result | query: "
LOCAL_PREFIXO_DOC = "title: none | text: "
LOCAL_CTX = 1024             # tokens por texto; o trecho de 200 palavras fica bem abaixo
LOCAL_MAX_CHARS = 2800       # corte de seguranca para nunca passar do contexto
LOCAL_LOTE = 8               # textos por requisicao no reindex

GEMINI_MODELO = "gemini-embedding-001"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent?key={key}"

COMO_LIGAR = ("para ligar sem conta e sem custo: bash <plugin>/scripts/install-embedding-local.sh "
              "(baixa ~350 MB uma vez)")


class EmbedError(RuntimeError):
    """Falha de embedding com a explicacao pronta para log."""


def _env(nome, padrao=""):
    return (os.environ.get(nome) or padrao).strip()


# ─── provedor local: EmbeddingGemma no llama-server ───────────────────────────

def local_dir():
    """A pasta da instalacao local, ou None se nao ha nenhuma completa."""
    candidatos = [Path(_env("DGCLAW_EMBED_DIR"))] if _env("DGCLAW_EMBED_DIR") else list(LOCAL_DIRS)
    for d in candidatos:
        if (d / "llama" / "llama-server").is_file() and (d / LOCAL_MODELO).is_file():
            return d
    return None


def _porta_livre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _morre_junto():
    """preexec: o llama-server recebe SIGTERM se o processo pai morrer (Linux). Sem isto,
    um hook morto por timeout deixaria 600 MB de servidor orfao na KVM 1."""
    try:
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:  # noqa: BLE001  fora do Linux so perde a garantia extra
        pass


class EmbedderLocal:
    nome = "local"
    descricao = "EmbeddingGemma 300M local (llama.cpp, sem chave, nada sai da maquina)"
    fingerprint = f"local:{LOCAL_MODELO}|{DIM}"
    # Escala de similaridade deste modelo, medida em 05/10/2026 em diarios reais (pt-BR,
    # trechos de 200 palavras com varios assuntos): o trecho certo veio em 1o nas 5 buscas
    # relevantes, com 0,36 a 0,57; busca sem relacao nenhuma ficou em 0,26. Frase curta e
    # limpa contra frase curta da ~0,59 (certo) e 0,08-0,18 (errado). Escala mais baixa que
    # a do Gemini, entao os limiares sao outros. A busca completa ainda passa pelo Haiku.
    limiar_busca = 0.35
    limiar_rapido = 0.45

    def __init__(self, pasta: Path):
        self.pasta = pasta
        self.proc = None
        self.url = None
        self._log = None

    def _subir(self):
        if self.proc and self.proc.poll() is None:
            return
        binario = self.pasta / "llama" / "llama-server"
        porta = _porta_livre()
        try:
            threads = int(_env("DGCLAW_EMBED_THREADS") or os.cpu_count() or 1)
        except ValueError:
            threads = os.cpu_count() or 1
        cmd = [str(binario), "-m", str(self.pasta / LOCAL_MODELO), "--embedding",
               "--host", "127.0.0.1", "--port", str(porta), "-t", str(threads),
               "-c", str(LOCAL_CTX), "-b", str(LOCAL_CTX), "-ub", str(LOCAL_CTX), "-np", "1",
               "--no-webui"]
        env = dict(os.environ)
        env["LD_LIBRARY_PATH"] = f"{binario.parent}:{env.get('LD_LIBRARY_PATH', '')}".rstrip(":")
        # O log do servidor vai para um arquivo temporario (um PIPE que ninguem le enche e
        # trava o servidor). So e lido se ele morrer, para explicar o porque.
        self._log = tempfile.TemporaryFile()
        try:
            self.proc = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL,
                                         stdout=self._log, stderr=self._log,
                                         preexec_fn=_morre_junto)
        except OSError as e:
            raise EmbedError(f"nao consegui rodar {binario} ({e}). Reinstale: "
                             "bash <plugin>/scripts/install-embedding-local.sh --reinstalar")
        atexit.register(self.fechar)
        self.url = f"http://127.0.0.1:{porta}"
        limite = time.time() + float(_env("DGCLAW_EMBED_SUBIDA_S") or 60)
        while time.time() < limite:
            if self.proc.poll() is not None:
                self._log.seek(0)
                err = self._log.read().decode(errors="replace")[-600:]
                raise EmbedError(f"o llama-server morreu ao subir (codigo {self.proc.returncode}). "
                                 f"Ultimas linhas: {err.strip() or '(nada)'}. Se for falta de "
                                 "memoria, feche algo ou use DGCLAW_EMBED_PROVIDER=gemini.")
            try:
                with urllib.request.urlopen(self.url + "/health", timeout=1) as r:
                    if r.status == 200:
                        return
            except Exception:  # noqa: BLE001  ainda carregando o modelo
                pass
            time.sleep(0.1)
        self.fechar()
        raise EmbedError("o llama-server nao ficou pronto em 60 s (maquina muito ocupada?). "
                         "A busca segue sem a memoria semantica desta vez.")

    def _pedir(self, textos):
        self._subir()
        corpo = json.dumps({"input": textos}).encode()
        req = urllib.request.Request(self.url + "/v1/embeddings", data=corpo,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                dados = json.loads(r.read())["data"]
        except urllib.error.HTTPError as e:
            raise EmbedError(f"o llama-server recusou o pedido (HTTP {e.code}: "
                             f"{e.read()[:300].decode(errors='replace')})")
        except Exception as e:  # noqa: BLE001
            raise EmbedError(f"falha ao falar com o llama-server em {self.url}: {e}")
        dados.sort(key=lambda d: d.get("index", 0))
        vetores = [d["embedding"] for d in dados]
        if len(vetores) != len(textos) or any(len(v) != DIM for v in vetores):
            raise EmbedError(f"resposta inesperada do llama-server: {len(vetores)} vetores para "
                             f"{len(textos)} textos (esperava {DIM} dimensoes)")
        return vetores

    def embed_query(self, texto: str):
        return self._pedir([LOCAL_PREFIXO_BUSCA + texto[:LOCAL_MAX_CHARS]])[0]

    def embed_documentos(self, textos):
        saida = []
        for i in range(0, len(textos), LOCAL_LOTE):
            lote = [LOCAL_PREFIXO_DOC + t[:LOCAL_MAX_CHARS] for t in textos[i:i + LOCAL_LOTE]]
            saida.extend(self._pedir(lote))
        return saida

    def fechar(self):
        p, self.proc = self.proc, None
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        if self._log:
            self._log.close()
            self._log = None


# ─── provedor Gemini (opcional) ───────────────────────────────────────────────

class EmbedderGemini:
    nome = "gemini"
    descricao = f"Gemini {GEMINI_MODELO} (GEMINI_API_KEY, manda o texto ao Google)"
    fingerprint = f"{GEMINI_MODELO}|{DIM}"   # o mesmo de antes de 05/10: indice antigo continua valendo
    limiar_busca = 0.55
    limiar_rapido = 0.70

    def __init__(self, chave: str):
        self.chave = chave
        self.chamadas = 0

    def _um(self, texto, tarefa, tentativas=3):
        corpo = json.dumps({"model": f"models/{GEMINI_MODELO}", "content": {"parts": [{"text": texto}]},
                            "taskType": tarefa, "outputDimensionality": DIM}).encode()
        url = GEMINI_URL.format(model=GEMINI_MODELO, key=self.chave)
        ultimo = None
        for n in range(tentativas):
            req = urllib.request.Request(url, data=corpo, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    self.chamadas += 1
                    return json.loads(r.read())["embedding"]["values"]
            except urllib.error.HTTPError as e:
                ultimo = f"HTTP {e.code}"
                if e.code in (429, 500, 502, 503, 504):
                    time.sleep(2 ** n)
                    continue
                break
            except Exception as e:  # noqa: BLE001
                ultimo = str(e)
                time.sleep(2 ** n)
        raise EmbedError(f"o Gemini nao devolveu o vetor ({ultimo}). Confira a GEMINI_API_KEY e a cota.")

    def embed_query(self, texto):
        return self._um(texto, "RETRIEVAL_QUERY")

    def embed_documentos(self, textos):
        return [self._um(t, "RETRIEVAL_DOCUMENT") for t in textos]

    def fechar(self):
        pass


# ─── escolha ──────────────────────────────────────────────────────────────────

def escolher():
    """(embedder, motivo). embedder None = memoria semantica desligada, e o motivo diz
    por que e como ligar."""
    pedido = (_env("DGCLAW_EMBED_PROVIDER") or "auto").lower()
    if pedido == "off":
        return None, "memoria semantica desligada de proposito (DGCLAW_EMBED_PROVIDER=off)"
    if pedido in ("auto", "local"):
        d = local_dir()
        if d:
            return EmbedderLocal(d), f"ligada: {EmbedderLocal.descricao}, em {d}"
        if pedido == "local":
            return None, f"memoria semantica desligada: o modelo local nao esta instalado; {COMO_LIGAR}"
    if pedido in ("auto", "gemini"):
        chave = _env("GEMINI_API_KEY")
        if chave:
            return EmbedderGemini(chave), f"ligada: {EmbedderGemini.descricao}"
        if pedido == "gemini":
            return None, "memoria semantica desligada: DGCLAW_EMBED_PROVIDER=gemini mas sem GEMINI_API_KEY"
    if pedido not in ("auto", "local", "gemini"):
        return None, (f"memoria semantica desligada: DGCLAW_EMBED_PROVIDER={pedido} nao existe "
                      "(use auto, local, gemini ou off)")
    return None, f"memoria semantica desligada: sem modelo local e sem GEMINI_API_KEY; {COMO_LIGAR}"


def _main(argv):
    cmd = argv[1] if len(argv) > 1 else "status"
    emb, motivo = escolher()
    if cmd == "status":
        if "--json" in argv:
            print(json.dumps({"ligada": emb is not None, "provedor": emb.nome if emb else None,
                              "fingerprint": emb.fingerprint if emb else None, "motivo": motivo},
                             ensure_ascii=False))
        else:
            print(motivo)
        return 0 if emb else 1
    if cmd == "teste":
        if not emb:
            print(motivo)
            return 1
        t0 = time.time()
        try:
            v = emb.embed_query("teste da memoria semantica do DG Claw")
        except EmbedError as e:
            print(f"memoria semantica NAO funcionou: {e}")
            return 1
        finally:
            emb.fechar()
        print(f"memoria semantica funcionando ({emb.nome}): vetor de {len(v)} dimensoes "
              f"em {time.time() - t0:.1f} s")
        return 0
    print(f"uso: {argv[0]} status [--json] | teste", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
