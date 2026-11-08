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
  - Cada comando roda por `sh -c`, em paralelo (como o Claude faz), com o stdin deste hook e teto de
    9 s cada, dentro do teto de 10 s deste hook. cwd: o workspace do agente (DGCLAW_WORKSPACE).
  - Saida: o Claude acrescenta ao contexto o stdout de cada comando (JSON com
    hookSpecificOutput.additionalContext, ou texto simples). Aqui os contextos sao juntados, na ordem
    da lista, num UNICO JSON, porque o Codex le um unico JSON por hook.

FALHA: sempre exit 0. Sem variavel, id invalido ou arquivo ausente: sem saida. Comando que falha ou
  estoura o tempo: o motivo vai para o stderr e os demais seguem.
"""
import json
import os
import re
import subprocess
import sys

TETO_S = 9
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


def main():
    comandos = _comandos()
    if not comandos:
        return
    entrada = sys.stdin.buffer.read() if not sys.stdin.isatty() else b""
    ws = os.environ.get("DGCLAW_WORKSPACE", "")
    cwd = ws if ws and os.path.isdir(ws) else os.path.dirname(os.path.abspath(__file__))
    procs = []
    for c in comandos:
        try:
            procs.append((c, subprocess.Popen(["sh", "-c", c], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                              stderr=subprocess.PIPE, cwd=cwd)))
        except OSError as e:
            sys.stderr.write(f"prompt-hooks-sessao: nao consegui iniciar {c[:80]!r} ({e})\n")
            procs.append((c, None))
    contextos = []
    for c, p in procs:
        if p is None:
            continue
        try:
            out, err = p.communicate(entrada, timeout=TETO_S)
        except subprocess.TimeoutExpired:
            p.kill()
            p.communicate()
            sys.stderr.write(f"prompt-hooks-sessao: {c[:80]!r} passou de {TETO_S} s e foi interrompido\n")
            continue
        if p.returncode != 0:
            sys.stderr.write(f"prompt-hooks-sessao: {c[:80]!r} saiu com codigo {p.returncode}: {err.decode('utf-8', 'replace')[:200]}\n")
            continue
        texto = _contexto(out.decode("utf-8", "replace"))
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
    sys.exit(0)
