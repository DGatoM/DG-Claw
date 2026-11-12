#!/usr/bin/env python3
"""
anexar_secao.py: acrescenta uma secao no fim de um arquivo de instrucoes do agente (AGENTS.md,
CLAUDE.md, MEMORY.md) SEM seguir link simbolico e sem reabrir nada por caminho textual.

Quem chama: scripts/_lib/anexo-seguro.sh, a partir do doctor.sh --fix, que roda como ROOT no host
enquanto a pasta do workspace pode ser escrita pelo agente (que poderia plantar links).

  python3 -I anexar_secao.py <workspace> <alvo relativo ao workspace> <nome do backup> <usuario|->
  (o texto da secao entra pelo stdin, nunca por argumento)

COMO FICA SEGURO
  - A pasta do workspace e cada pasta do caminho ate o arquivo sao abertas com
    O_DIRECTORY|O_NOFOLLOW, uma a partir da outra (dir_fd). Depois disso, TODA operacao usa
    descritor: open/stat/unlink/rename com dir_fd, e escrita, fchmod e fchown pelo fd.
  - O original abre com O_RDWR|O_APPEND|O_NOFOLLOW e fstat confere que e arquivo regular.
  - A operacao so ACRESCENTA: a secao e escrita no fim do proprio arquivo, pelo mesmo descritor, num
    unico write. O arquivo nunca e copiado nem renomeado por cima, entao uma linha que o agente
    escreva no meio da migracao nao e apagada (no pior caso a secao entra depois dela).
  - O backup e criado com nome aleatorio, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600, e entra no nome
    final por rename com dir_fd. Ele guarda o que foi lido antes de acrescentar.
  - Antes de escrever o original e olhado de novo POR NOME (sem seguir link): tem de ser o mesmo
    dispositivo e inode que foi aberto; se o agente trocou o nome, nada e escrito.
  - Qualquer falha apaga o temporario do backup (unlink com dir_fd) e sai com mensagem em portugues.

SAIDA: 0 acrescentou; 1 recusou (link, nao e arquivo comum...); 2 falhou ao gravar. O motivo vai no
stderr, uma linha.

GANCHO DE TESTE: com DGCLAW_ANEXO_MODO_TESTE=1 e DGCLAW_ANEXO_GANCHO=<executavel>, o executavel roda
entre as etapas ("depois-do-backup-temporario", "antes-da-escrita") com os argumentos
<etapa> <pasta do workspace> <nome do temporario do backup, ou - nas outras>, para o teste simular o
agente trocando o temporario por um link, ou escrevendo no arquivo no meio da operacao. Sem o modo de teste a variavel e ignorada.
"""
import os
import pwd
import secrets
import stat
import subprocess
import sys

ABRE_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
CRIA = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW


class Recusa(Exception):
    pass


class Falha(Exception):
    pass


def _gancho(etapa, ws, nome):
    exe = os.environ.get("DGCLAW_ANEXO_GANCHO")
    if exe and os.environ.get("DGCLAW_ANEXO_MODO_TESTE") == "1":
        subprocess.run([exe, etapa, ws, nome], check=False)


def _escreve(fd, dados):
    visto = memoryview(dados)
    while visto:
        n = os.write(fd, visto)
        visto = visto[n:]


def _cria(dfd, uid, gid, modo, dados):
    """Cria um arquivo novo (nome aleatorio) so por descritor; devolve (nome, fd)."""
    for _ in range(20):
        nome = ".anexo." + secrets.token_hex(8)
        try:
            fd = os.open(nome, CRIA, 0o600, dir_fd=dfd)
        except FileExistsError:
            continue
        return nome, fd
    raise Falha("nao consegui um nome livre para o arquivo temporario")


def _preenche(fd, uid, gid, modo, dados):
    _escreve(fd, dados)
    os.fchmod(fd, modo)
    os.fchown(fd, uid, gid)
    os.fsync(fd)


def _mesmo_arquivo(dfd, nome, esperado, o_que):
    """O nome (sem seguir link) tem de ser o mesmo arquivo comum que eu escrevi pelo descritor."""
    try:
        agora = os.stat(nome, dir_fd=dfd, follow_symlinks=False)
    except OSError as e:
        raise Recusa(f"{o_que} sumiu antes da troca ({e.strerror}); nao gravei nada. Rode o doctor de novo") from e
    if not stat.S_ISREG(agora.st_mode) or (agora.st_dev, agora.st_ino) != (esperado.st_dev, esperado.st_ino):
        raise Recusa(f"{o_que} foi trocado por outro arquivo (ou por um link) antes da troca; nao gravei nada. Rode o doctor de novo")


def main(ws, rel, nome_bak, usuario, secao):
    partes = [p for p in rel.split("/") if p != ""]
    if not partes or any(p in (".", "..") for p in partes):
        raise Recusa(f"o caminho {rel!r} nao e um caminho simples dentro do workspace")
    if "/" in nome_bak or nome_bak in ("", ".", ".."):
        raise Recusa(f"o nome do backup {nome_bak!r} nao e um nome simples")
    abertos = []
    try:
        try:
            dfd = os.open(ws, ABRE_DIR)
        except OSError as e:
            raise Recusa(f"nao abri o workspace {ws} sem seguir link ({e.strerror}); se ele for um link, aponte o config para a pasta real") from e
        abertos.append(dfd)
        for p in partes[:-1]:
            try:
                dfd = os.open(p, ABRE_DIR, dir_fd=dfd)
            except OSError as e:
                raise Recusa(f"a pasta {p} do caminho nao abre sem seguir link ({e.strerror}); uma pasta no caminho de {rel} e um link ou nao existe") from e
            abertos.append(dfd)
        alvo = partes[-1]
        try:
            ofd = os.open(alvo, os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW, dir_fd=dfd)
        except OSError as e:
            if os.path.lexists(os.path.join(ws, rel)) and os.path.islink(os.path.join(ws, rel)):
                raise Recusa(f"{rel} e um link simbolico; nao leio nem escrevo por ele. Apague o link e recoloque o arquivo de verdade (ou restaure o ultimo backup .bak-*), depois rode o doctor de novo") from e
            raise Recusa(f"nao abri {rel} sem seguir link ({e.strerror}). Troque por um arquivo comum e rode o doctor de novo") from e
        abertos.append(ofd)
        est = os.fstat(ofd)
        if not stat.S_ISREG(est.st_mode):
            raise Recusa(f"{rel} nao e um arquivo comum. Troque por um arquivo regular e rode o doctor de novo")
        original = b""
        while True:
            bloco = os.read(ofd, 1 << 20)
            if not bloco:
                break
            original += bloco

        if usuario and usuario != "-" and usuario != "root":
            try:
                pw = pwd.getpwnam(usuario)
            except KeyError as e:
                raise Falha(f"o usuario {usuario} nao existe neste servidor; confira o dono da pasta do agente") from e
            uid, gid = pw.pw_uid, pw.pw_gid
        else:
            uid, gid = est.st_uid, est.st_gid
        modo = stat.S_IMODE(est.st_mode)

        criados = []
        try:
            # backup: so se ainda nao existe; se existe tem de ser arquivo comum (link e recusado)
            try:
                eb = os.stat(nome_bak, dir_fd=dfd, follow_symlinks=False)
            except FileNotFoundError:
                eb = None
            if eb is not None and not stat.S_ISREG(eb.st_mode):
                raise Recusa(f"o backup {nome_bak} ja existe e e um link ou nao e arquivo comum; nao escrevo por ele. Apague {nome_bak} e rode o doctor de novo")
            if eb is None:
                nb, fb = _cria(dfd, uid, gid, modo, original)
                criados.append(nb)
                try:
                    _gancho("depois-do-backup-temporario", ws, nb)
                    _preenche(fb, est.st_uid, est.st_gid, modo, original)
                    est_b = os.fstat(fb)
                finally:
                    os.close(fb)
                _mesmo_arquivo(dfd, nb, est_b, "o backup temporario")
                os.rename(nb, nome_bak, src_dir_fd=dfd, dst_dir_fd=dfd)
                criados.remove(nb)

            _gancho("antes-da-escrita", ws, "-")
            # o original, por nome e sem seguir link, tem de ser o mesmo que foi aberto
            try:
                agora = os.stat(alvo, dir_fd=dfd, follow_symlinks=False)
            except OSError as e:
                raise Recusa(f"{rel} sumiu ou mudou enquanto eu o lia ({e.strerror}); nao gravei nada. Rode o doctor de novo") from e
            if not stat.S_ISREG(agora.st_mode) or (agora.st_dev, agora.st_ino) != (est.st_dev, est.st_ino):
                raise Recusa(f"{rel} mudou (ou virou link) enquanto eu o lia; nao gravei nada. Rode o doctor de novo")
            # O_APPEND: o write cai no fim atual do arquivo, depois de qualquer linha que o agente tenha escrito
            _escreve(ofd, b"\n" + secao + b"\n")
            os.fchown(ofd, uid, gid)
            os.fsync(ofd)
        finally:
            for nome in criados:
                try:
                    os.unlink(nome, dir_fd=dfd)
                except OSError:
                    pass
    finally:
        for fd in reversed(abertos):
            try:
                os.close(fd)
            except OSError:
                pass


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.stderr.write("uso: anexar_secao.py <workspace> <alvo relativo> <nome do backup> <usuario|->  (secao no stdin)\n")
        sys.exit(2)
    try:
        main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.stdin.buffer.read())
    except Recusa as e:
        sys.stderr.write(f"{e}\n")
        sys.exit(1)
    except (Falha, OSError) as e:
        sys.stderr.write(f"nao consegui gravar: {e}\n")
        sys.exit(2)
