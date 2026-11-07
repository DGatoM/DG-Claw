#!/usr/bin/env python3
"""Entrega e leitura de arquivos na casa de um agente, sem seguir atalhos em nenhum componente do caminho.

Quem chama é o Web, que roda como root. O agente escreve na própria casa e pode trocar uma pasta por um atalho
no meio de uma operação; o Node não tem openat, então o caminho é descido aqui, pasta por pasta, com
os.open(nome, O_DIRECTORY | O_NOFOLLOW, dir_fd=pai). Só a biblioteca padrão. Rodar com: python3 -I entrega-segura.py ...

  entregar <casa> <dia> <pasta_origem> <nome> [<nome> ...]
      Grava <pasta_origem>/<nome> em <casa>/uploads/<dia>/<nome>. Cria uploads e <dia> se faltarem. Nome que já
      existe ganha -1, -2... (antes da extensão). Se qualquer arquivo falhar, apaga os que já gravou.
      Resposta: {"ok":true,"nomes":["<nome final>", ...]}
  ler <casa> <caminho_relativo> <destino> <max_bytes>
      Copia <casa>/<caminho_relativo> para <destino> (arquivo novo, 0600, numa pasta do root). Só arquivo comum:
      atalho, FIFO, dispositivo e pasta são recusados sem travar. Resposta: {"ok":true,"bytes":N}

Erro: {"ok":false,"erro":"<motivo em português>","codigo":"<curto>"} e saída 1. Nada de conteúdo de arquivo na resposta.
"""
import errno
import json
import os
import re
import stat
import sys

RX_NOME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$")
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


class Recusa(Exception):
    def __init__(self, codigo, erro):
        super().__init__(erro)
        self.codigo = codigo
        self.erro = erro


def abrir_pasta(pai_fd, nome, caminho_visivel, criar):
    try:
        return os.open(nome, O_DIR, dir_fd=pai_fd)
    except FileNotFoundError:
        if not criar:
            raise Recusa("ausente", f"{caminho_visivel} não existe.")
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Recusa("atalho", f"{caminho_visivel} é um atalho (link simbólico) ou não é uma pasta. Por segurança não grava nada ali. Peça ao Admin para apagar esse item na pasta do agente e envie de novo.")
        raise Recusa("abrir", f"Não consegui abrir {caminho_visivel} ({errno.errorcode.get(e.errno, e.errno)}).")
    try:
        os.mkdir(nome, 0o755, dir_fd=pai_fd)
    except FileExistsError:
        pass
    except OSError as e:
        raise Recusa("criar", f"Não consegui criar {caminho_visivel} ({errno.errorcode.get(e.errno, e.errno)}). Confira espaço em disco e permissão da pasta do agente.")
    return abrir_pasta(pai_fd, nome, caminho_visivel, False)


def descer(casa, partes, criar):
    """Abre a casa (já resolvida) e desce cada componente sem seguir atalho. Devolve a lista de fds abertos (o último é o destino)."""
    try:
        raiz = os.open(os.path.realpath(casa), O_DIR)
    except OSError as e:
        raise Recusa("casa", f"A casa do agente ({casa}) não existe ou não pôde ser lida ({errno.errorcode.get(e.errno, e.errno)}). Confira se o agente foi criado e a pasta montada.")
    fds = [raiz]
    visivel = casa
    try:
        for p in partes:
            visivel = os.path.join(visivel, p)
            fds.append(abrir_pasta(fds[-1], p, visivel, criar))
    except BaseException:
        for fd in fds:
            os.close(fd)
        raise
    return fds


def nome_livre(dir_fd, nome):
    raiz, ext = os.path.splitext(nome)
    for i in range(1000):
        alvo = nome if i == 0 else f"{raiz}-{i}{ext}"
        try:
            fd = os.open(alvo, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), 0o644, dir_fd=dir_fd)
            return alvo, fd
        except FileExistsError:
            continue
    raise Recusa("sem_nome", "Não achei um nome livre para o arquivo.")


def entregar(casa, dia, origem, nomes):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", dia):
        raise Recusa("dia", "O dia da pasta de uploads veio num formato inesperado.")
    for n in nomes:
        if not RX_NOME.match(n):
            raise Recusa("nome", "Um nome de arquivo veio com caracteres que não aceito.")
    fds = descer(casa, ["uploads", dia], True)
    criados = []
    try:
        destino = fds[-1]
        for n in nomes:
            try:
                src = os.open(os.path.join(origem, n), os.O_RDONLY | os.O_NOFOLLOW)
            except OSError as e:
                raise Recusa("origem", f"Não consegui abrir o arquivo de origem ({errno.errorcode.get(e.errno, e.errno)}).")
            try:
                final, out = nome_livre(destino, n)
                criados.append(final)
                try:
                    os.fchmod(out, 0o644)
                    while True:
                        bloco = os.read(src, 1 << 20)
                        if not bloco:
                            break
                        mv = memoryview(bloco)
                        while mv:
                            mv = mv[os.write(out, mv):]
                    os.fsync(out)
                finally:
                    os.close(out)
            finally:
                os.close(src)
        return criados
    except BaseException:
        for c in criados:
            try:
                os.unlink(c, dir_fd=fds[-1])
            except OSError:
                pass
        raise
    finally:
        for fd in fds:
            os.close(fd)


def ler(casa, relativo, destino, maximo):
    partes = [p for p in relativo.split("/") if p]
    if not partes or any(p in (".", "..") for p in partes):
        raise Recusa("caminho", "O caminho do arquivo sai da casa do agente.")
    fds = descer(casa, partes[:-1], False)
    try:
        try:
            fd = os.open(partes[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=fds[-1])
        except FileNotFoundError:
            raise Recusa("ausente", "O arquivo não está mais disponível na pasta do agente.")
        except OSError as e:
            if e.errno == errno.ELOOP:
                raise Recusa("atalho", "O arquivo é um atalho (link simbólico) e não será aberto.")
            raise Recusa("abrir", f"Não consegui abrir o arquivo ({errno.errorcode.get(e.errno, e.errno)}).")
    finally:
        for f in fds:
            os.close(f)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise Recusa("nao_comum", "O caminho do arquivo não é um arquivo comum (pode ser uma pasta, um atalho ou um arquivo especial) e não será aberto.")
        if st.st_size > maximo:
            raise Recusa("grande", f"O arquivo tem {st.st_size // 1048576} MB e o limite para gerar a versão final é {maximo // 1048576} MB.")
        total = 0
        out = os.open(destino, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            while True:
                bloco = os.read(fd, 1 << 20)
                if not bloco:
                    break
                total += len(bloco)
                if total > maximo:
                    raise Recusa("grande", f"O arquivo passou do limite de {maximo // 1048576} MB.")
                os.write(out, bloco)
        finally:
            os.close(out)
        return total
    finally:
        os.close(fd)


def main(argv):
    try:
        if len(argv) >= 6 and argv[1] == "entregar":
            nomes = entregar(argv[2], argv[3], argv[4], argv[5:])
            print(json.dumps({"ok": True, "nomes": nomes}))
        elif len(argv) == 6 and argv[1] == "ler":
            print(json.dumps({"ok": True, "bytes": ler(argv[2], argv[3], argv[4], int(argv[5]))}))
        else:
            raise Recusa("uso", "Uso: entregar <casa> <dia> <origem> <nome>... | ler <casa> <relativo> <destino> <max_bytes>")
        return 0
    except Recusa as r:
        print(json.dumps({"ok": False, "erro": r.erro, "codigo": r.codigo}, ensure_ascii=False))
        return 1
    except Exception as e:  # nunca deixar o chamador sem resposta
        print(json.dumps({"ok": False, "erro": f"Falha inesperada na entrega segura ({type(e).__name__}).", "codigo": "inesperado"}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
