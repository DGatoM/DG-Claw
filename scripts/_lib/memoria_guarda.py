#!/usr/bin/env python3
"""memoria_guarda.py - copia de seguranca do MEMORY.md antes da consolidacao da noite.

POR QUE EXISTE. A consolidacao noturna e feita por um modelo que reescreve o MEMORY.md (o
livro da vida do agente: quem e o dono, regras aprendidas, pessoas, marcos). Se ela errar a
mao e apagar um pedaco grande, nao existe volta: o arquivo nao esta no Git. Este programa
tira uma foto antes (guardar) e, depois, compara a foto com o arquivo novo (conferir). Se
sumiu coisa demais, ele DEVOLVE a versao anterior, guarda a rejeitada para olhar depois e
avisa o dono.

COMO CONTA "ENTRADA". Entrada = linha com conteudo FORA de comentario HTML (<!-- ... -->,
inclusive de varias linhas), ignorando linhas em branco e separadores "---". Isso cobre
titulos de secao, itens de lista ("- ..."), linhas de campo ("**Campo:** valor") e
paragrafos. Por que assim: o template do MEMORY.md tem comentarios longos de instrucao que
o agente pode apagar ou reescrever sem perder memoria nenhuma, e os "---" sao so enfeite;
contar isso daria alarme falso. Contar linha de conteudo e simples, nao depende do formato
exato de cada secao e pega o que importa: texto que existia e sumiu.

Subcomandos (todos recebem --ws <workspace>; o MEMORY.md fica em <ws>/MEMORY.md):
  guardar  copia o MEMORY.md para <ws>/memory/.antes-da-consolidacao/MEMORY-AAAA-MM-DD-HHMM.md
           (permissao 600) e mantem so as 14 mais recentes. Sem MEMORY.md (agente novo) avisa
           no stderr e sai 0. Imprime o caminho da copia.
  conferir [--limite 0.25]  compara a copia mais recente ainda nao conferida com o MEMORY.md
           atual. Perdeu mais que o limite: restaura, guarda a versao rejeitada, avisa o dono
           e sai com 3. Idempotente (as conferidas ficam em conferidas.txt).

Codigos de saida: 0 ok | 1 erro de leitura/escrita (a mensagem diz o caminho e o motivo)
| 3 perda acima do limite (memoria restaurada).

Env: DGCLAW_MEMORIA_GUARDA_NOTIFY = script de aviso a chamar com bash (default:
../notify-owner.sh ao lado desta pasta). Uso por testes.
"""
import argparse
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

MANTER = 14
LIMITE_PADRAO = 0.25
PASTA = "memory/.antes-da-consolidacao"
CONFERIDAS = "conferidas.txt"
_COMENTARIO = re.compile(r"<!--.*?-->", re.DOTALL)
_SEPARADOR = re.compile(r"^-{3,}$")


def erro(msg):
    print(f"memoria_guarda: {msg}", file=sys.stderr)


def contar_entradas(texto):
    """Conta as linhas de conteudo fora de comentario HTML, sem brancas nem '---'."""
    sem_comentario = _COMENTARIO.sub("", texto)
    n = 0
    for linha in sem_comentario.splitlines():
        t = linha.strip()
        if not t or _SEPARADOR.match(t):
            continue
        n += 1
    return n


def _pasta(ws):
    return Path(ws) / PASTA


def _copias(pasta):
    """Pre-imagens normais (MEMORY-*.md sem '-rejeitada'), da mais antiga para a mais nova.
    O carimbo AAAA-MM-DD-HHMM no nome ordena igual ao tempo."""
    return sorted(p for p in pasta.glob("MEMORY-*.md") if not p.name.endswith("-rejeitada.md"))


def _rejeitadas(pasta):
    return sorted(pasta.glob("MEMORY-*-rejeitada.md"))


def _podar(lista):
    for velho in lista[:-MANTER]:
        try:
            velho.unlink()
        except OSError as e:
            erro(f"nao consegui apagar a copia antiga {velho}: {e}")


def _escrever_600(destino, conteudo):
    """Grava com permissao 600 desde o nascimento (a memoria do agente e privada)."""
    fd = os.open(destino, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(conteudo)
    os.chmod(destino, 0o600)


def cmd_guardar(a):
    memoria = Path(a.ws) / "MEMORY.md"
    if not memoria.is_file():
        erro(f"{memoria} nao existe (agente novo, ainda sem memoria de longo prazo); "
             "nada para guardar")
        return 0
    pasta = _pasta(a.ws)
    old = os.umask(0o077)
    try:
        pasta.mkdir(parents=True, exist_ok=True)
        destino = pasta / f"MEMORY-{datetime.now().strftime('%Y-%m-%d-%H%M')}.md"
        _escrever_600(destino, memoria.read_bytes())
    except OSError as e:
        erro(f"nao consegui guardar a copia de {memoria} em {pasta}: {e}")
        return 1
    finally:
        os.umask(old)
    _podar(_copias(pasta))
    _podar(_rejeitadas(pasta))
    print(destino)
    return 0


def _ler_conferidas(pasta):
    f = pasta / CONFERIDAS
    if not f.is_file():
        return set()
    return {x.strip() for x in f.read_text(encoding="utf-8").splitlines() if x.strip()}


def _marcar(pasta, nomes):
    f = pasta / CONFERIDAS
    with open(f, "a", encoding="utf-8") as fh:
        for n in nomes:
            fh.write(n + "\n")
    os.chmod(f, 0o600)


def _avisar_dono(ws, mensagem):
    padrao = Path(__file__).resolve().parent.parent / "notify-owner.sh"
    script = os.environ.get("DGCLAW_MEMORIA_GUARDA_NOTIFY") or str(padrao)
    env = {**os.environ}
    env.setdefault("DGCLAW_WORKSPACE", str(ws))
    try:
        r = subprocess.run(["bash", script, mensagem], env=env, capture_output=True,
                           text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        erro(f"NAO consegui avisar o dono (rodando {script}): {e}. A memoria foi restaurada "
             "mesmo assim; avise a pessoa por outro caminho.")
        return
    if r.returncode != 0:
        erro(f"o aviso ao dono FALHOU (rc={r.returncode}, script {script}): "
             f"{(r.stderr or r.stdout).strip()[:300]}. A memoria foi restaurada mesmo assim; "
             "avise a pessoa por outro caminho.")


def cmd_conferir(a):
    pasta = _pasta(a.ws)
    memoria = Path(a.ws) / "MEMORY.md"
    if not pasta.is_dir():
        erro(f"{pasta} nao existe: nao ha copia anterior para conferir (nada a fazer)")
        return 0
    try:
        conferidas = _ler_conferidas(pasta)
        copias = _copias(pasta)
        pendentes = [c for c in copias if c.name not in conferidas]
        if not pendentes:
            print("conferir: nenhuma copia nova para conferir (ja conferida ou inexistente)")
            return 0
        pre = pendentes[-1]
        # as mais velhas que a escolhida tambem ficam conferidas: sem isso, a segunda chamada
        # compararia uma foto de semanas atras com o arquivo de hoje e daria alarme falso.
        a_marcar = [c.name for c in pendentes]
        antes = contar_entradas(pre.read_text(encoding="utf-8"))
        depois = contar_entradas(memoria.read_text(encoding="utf-8")) if memoria.is_file() else 0
    except (OSError, UnicodeDecodeError) as e:
        erro(f"nao consegui ler os arquivos para conferir em {pasta}: {e}")
        return 1

    if antes == 0:
        _marcar(pasta, a_marcar)
        print(f"conferir: a copia {pre.name} nao tinha entradas, nada a comparar")
        return 0

    perda = (antes - depois) / antes
    pct = f"{perda * 100:.0f}%"
    if perda <= a.limite:
        _marcar(pasta, a_marcar)
        print(f"conferir: ok. Entradas antes={antes} depois={depois} (variacao {pct} de perda, "
              f"limite {a.limite * 100:.0f}%)")
        return 0

    # Perda grande demais: guarda a rejeitada, devolve a anterior, avisa.
    carimbo = pre.name[len("MEMORY-"):-len(".md")]
    rejeitada = pasta / f"MEMORY-{carimbo}-rejeitada.md"
    try:
        if memoria.is_file():
            _escrever_600(rejeitada, memoria.read_bytes())
        tmp = Path(a.ws) / ".MEMORY.md.restaurando"
        _escrever_600(tmp, pre.read_bytes())
        os.replace(tmp, memoria)
    except OSError as e:
        erro(f"a memoria perdeu {pct} ({antes} para {depois} entradas) mas NAO consegui "
             f"restaurar {pre} em {memoria}: {e}. Restaure a mao copiando {pre} sobre {memoria}.")
        return 1
    _podar(_rejeitadas(pasta))
    _marcar(pasta, a_marcar)
    onde = f"{PASTA}/{rejeitada.name}" if rejeitada.exists() else "(sem versao rejeitada)"
    print(f"conferir: PERDA de {pct} (antes={antes} depois={depois} entradas, limite "
          f"{a.limite * 100:.0f}%). Restaurei {pre.name}; a versao rejeitada ficou em {onde}")
    _avisar_dono(
        a.ws,
        f"Aviso: a consolidação da noite apagou {pct} da memória (MEMORY.md foi de {antes} "
        f"para {depois} entradas). Eu devolvi a versão anterior. A versão rejeitada ficou "
        f"guardada em {onde}.")
    return 3


def main():
    ap = argparse.ArgumentParser(description="Copia de seguranca do MEMORY.md")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("guardar")
    g.add_argument("--ws", required=True)
    c = sub.add_parser("conferir")
    c.add_argument("--ws", required=True)
    c.add_argument("--limite", type=float, default=LIMITE_PADRAO)
    a = ap.parse_args()
    return cmd_guardar(a) if a.cmd == "guardar" else cmd_conferir(a)


if __name__ == "__main__":
    sys.exit(main())
