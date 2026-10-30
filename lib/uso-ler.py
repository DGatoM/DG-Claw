"""Copia, com seguranca, UM arquivo de dentro da casa de um agente para um arquivo temporario do host.

Usado por lib/uso-coletor.sh. A casa e gravavel pelo proprio agente e quem le e o root, entao o arquivo pode ter
sido trocado por atalho, FIFO, device ou diretorio entre o `find` e a leitura. Por isso tudo e decidido pelo
MESMO descritor, aberto sem seguir atalho e sem bloquear:
  os.open(O_NOFOLLOW | O_NONBLOCK) -> os.fstat (precisa ser arquivo comum) -> o caminho do descritor precisa estar
  dentro da casa -> le no maximo MAX + 1 bytes (passou disso = pulado) -> grava a copia.
Uso: python3 -I uso-ler.py <casa> <arquivo> <copia>
Saida: 0 copiou | 10 nao e arquivo comum (atalho, FIFO, device, diretorio) | 11 passa de 256 KiB |
       12 fora da casa | 13 nao existe ou sem permissao
"""
import os
import stat
import sys

MAX = 256 * 1024


def main():
    casa, arquivo, copia = sys.argv[1:4]
    casa = os.path.realpath(casa)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        fd = os.open(arquivo, flags)
    except FileNotFoundError:
        return 13
    except PermissionError:
        return 13
    except OSError:
        # ELOOP (atalho), ENXIO e afins: o que nao da para abrir sem seguir atalho nao e arquivo comum.
        return 10
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return 10
        real = os.readlink("/proc/self/fd/%d" % fd)
        if not (real == casa or real.startswith(casa + os.sep)):
            return 12
        dados = b""
        while len(dados) <= MAX:
            bloco = os.read(fd, MAX + 1 - len(dados))
            if not bloco:
                break
            dados += bloco
        if len(dados) > MAX:
            return 11
    finally:
        os.close(fd)
    saida = os.open(copia, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        os.write(saida, dados)
    finally:
        os.close(saida)
    return 0


if __name__ == "__main__":
    sys.exit(main())
