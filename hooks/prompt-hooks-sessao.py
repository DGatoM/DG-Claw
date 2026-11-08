#!/usr/bin/env python3
"""
prompt-hooks-sessao.py: hook UserPromptSubmit FIXO do DG Claw no Codex, que roda os promptHooks da
sessao que o disparou.

POR QUE EXISTE
  No Codex, o hooks.json e a confianca (config.toml) sao do AGENTE e valem para todas as sessoes
  que usam o mesmo CODEX_HOME. Os promptHooks sao de cada sessao (a principal e as paralelas tem os
  seus). Em vez de gravar os promptHooks no hooks.json (e dar confianca a texto que veio de um
  arquivo), o hooks.json tem so este hook, igual para todas as sessoes, e o runner grava os
  promptHooks de cada sessao em <pasta de estado>/prompt-hooks/<id da sessao>.json no preparo.

COMO FUNCIONA
  - DGCLAW_SESSAO_ID (ambiente do Codex, posto pelo runner) escolhe o arquivo. O id so pode ter
    letras, numeros, _ e - (sem barra nem ponto): qualquer outra coisa sai calado.
  - DGCLAW_PROMPT_HOOKS_DIR (fixado no comando do hook pelo runner) e a pasta dos arquivos.
  - Cada comando roda por `sh -c`, em paralelo (como o Claude faz), cada um no seu grupo de processos,
    com o stdin deste hook. O prazo e UM SO para todos: 8,5 s a partir do inicio (o hook tem 10 s).
    Estourou, o grupo de cada comando que ainda roda leva SIGKILL (inclusive netos que seguram o
    pipe) e a saida dos que terminaram a tempo e com codigo 0 e emitida. Nada espera sem limite.
    cwd: o workspace do agente (DGCLAW_WORKSPACE).
  - Saida: o Claude acrescenta ao contexto o stdout de cada comando (JSON com
    hookSpecificOutput.additionalContext, ou texto simples). Aqui os contextos sao juntados, na ordem
    da lista, num UNICO JSON, porque o Codex le um unico JSON por hook.

FALHA: sempre exit 0. Sem variavel, id invalido ou arquivo ausente: sem saida. Comando que falha ou
  estoura o tempo: o motivo vai para o stderr e os demais seguem.
"""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

PRAZO_S = 8.5
MAX_SAIDA = 256 * 1024
ID_VALIDO = re.compile(r"^[A-Za-z0-9_-]+$")


def _comandos():
    sid = os.environ.get("DGCLAW_SESSAO_ID", "")
    pasta = os.environ.get("DGCLAW_PROMPT_HOOKS_DIR", "")
    if not sid or not pasta or not ID_VALIDO.match(sid):
        return []
    try:
        with open(os.path.join(pasta, sid + ".json"), encoding="utf-8") as f:
            dados = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        sys.stderr.write(f"prompt-hooks-sessao: nao consegui ler os promptHooks da sessao {sid} em {pasta} ({e}); nenhum rodou\n")
        return []
    lista = dados.get("comandos") if isinstance(dados, dict) else None
    if not isinstance(lista, list):
        return []
    return [c for c in lista if isinstance(c, str) and c.strip()]


def _contexto(saida):
    saida = saida.strip()
    if not saida:
        return ""
    try:
        j = json.loads(saida)
    except ValueError:
        return saida
    if isinstance(j, dict):
        ctx = (j.get("hookSpecificOutput") or {}).get("additionalContext")
        return ctx.strip() if isinstance(ctx, str) else ""
    return ""


class _Filho:
    """Um comando: o processo, as threads que escrevem o stdin e leem stdout/stderr, e o que chegou."""

    def __init__(self, comando, entrada, cwd):
        self.comando = comando
        self.saida = []
        self.erro = []
        self.proc = subprocess.Popen(["sh", "-c", comando], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, cwd=cwd, start_new_session=True)
        self.threads = [
            threading.Thread(target=self._escreve, args=(entrada,), daemon=True),
            threading.Thread(target=self._le, args=(self.proc.stdout, self.saida, MAX_SAIDA), daemon=True),
            threading.Thread(target=self._le, args=(self.proc.stderr, self.erro, 4096), daemon=True),
        ]
        for t in self.threads:
            t.start()

    def _escreve(self, entrada):
        try:
            self.proc.stdin.write(entrada)
        except (OSError, ValueError):
            pass  # o comando fechou o stdin sem ler: normal
        finally:
            try:
                self.proc.stdin.close()
            except OSError:
                pass

    @staticmethod
    def _le(fluxo, destino, limite):
        total = 0
        try:
            while True:
                bloco = fluxo.read1(65536) if hasattr(fluxo, "read1") else fluxo.read(65536)
                if not bloco:
                    return
                if total < limite:  # passado do limite, segue lendo e descartando, para o comando nao travar
                    destino.append(bloco[: limite - total])
                    total += len(bloco)
        except (OSError, ValueError):
            return

    def mata(self):
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass


def main():
    comandos = _comandos()
    if not comandos:
        return
    entrada = sys.stdin.buffer.read() if not sys.stdin.isatty() else b""
    ws = os.environ.get("DGCLAW_WORKSPACE", "")
    cwd = ws if ws and os.path.isdir(ws) else os.path.dirname(os.path.abspath(__file__))
    prazo = PRAZO_S
    try:  # so se pode ENCURTAR o prazo (teste); nunca passar dos 8,5 s
        prazo = min(PRAZO_S, float(os.environ.get("DGCLAW_PROMPT_HOOKS_PRAZO_S", PRAZO_S)))
    except ValueError:
        pass
    limite = time.monotonic() + prazo
    filhos = []
    for c in comandos:
        try:
            filhos.append(_Filho(c, entrada, cwd))
        except OSError as e:
            sys.stderr.write(f"prompt-hooks-sessao: nao consegui iniciar {c[:80]!r} ({e})\n")
    # Espera o fim de todos os processos, ate o prazo global.
    while time.monotonic() < limite and any(f.proc.poll() is None for f in filhos):
        time.sleep(0.02)
    estourou = [f for f in filhos if f.proc.poll() is None]
    for f in estourou:
        f.mata()
        sys.stderr.write(f"prompt-hooks-sessao: {f.comando[:80]!r} passou do prazo de {prazo:g} s e foi interrompido\n")
    # Quem saiu: as threads acabam sozinhas assim que os pipes fecham. Se alguma continua viva, um neto
    # (ex.: `sleep 30 &`) herdou o pipe; o grupo dele leva SIGKILL. Nenhuma espera aqui e sem limite.
    fim = time.monotonic() + 0.3
    for f in filhos:
        for t in f.threads:
            t.join(max(0.0, fim - time.monotonic()))
    for f in filhos:
        if f not in estourou and any(t.is_alive() for t in f.threads):
            f.mata()
    fim = time.monotonic() + 0.5
    for f in filhos:
        for t in f.threads:
            t.join(max(0.0, fim - time.monotonic()))
    contextos = []
    for f in filhos:
        if f in estourou:
            continue
        if f.proc.returncode != 0:
            sys.stderr.write(f"prompt-hooks-sessao: {f.comando[:80]!r} saiu com codigo {f.proc.returncode}: {b''.join(f.erro).decode('utf-8', 'replace')[:200]}\n")
            continue
        texto = _contexto(b"".join(f.saida).decode("utf-8", "replace"))
        if texto:
            contextos.append(texto)
    if contextos:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                                  "additionalContext": "\n\n".join(contextos)}}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # um hook nunca derruba o turno
        sys.stderr.write(f"prompt-hooks-sessao: erro inesperado ({type(e).__name__}: {e}); nada injetado\n")
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)  # threads de leitura podem estar presas num pipe de um neto que fugiu do grupo: nao esperar por elas
