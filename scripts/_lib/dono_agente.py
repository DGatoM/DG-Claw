#!/usr/bin/env python3
"""Quem e o dono da pasta do agente: usuario e HOME das units e devolucao de arquivos.

Por que existe: na v1 o agente vive num container como o usuario `agente`, e tudo o que ele
instala depois da criacao (rotinas, timers de poder) nasceria como root, com HOME errado e
mais privilegio que o necessario. No plugin classico o workspace e do root, e o resultado
continua root. O HOME vem do passwd (pw_dir) e nunca de $HOME: sob sudo o $HOME vira /root.

Uso como biblioteca:  dono_do_workspace(ws), usuario_da_rotina(ws), chown_dono(ws, caminho)
Uso pela linha de comando (scripts bash):
    python3 dono_agente.py unidade --ws <ws>              # imprime User=... e Environment=HOME=...
    python3 dono_agente.py chown --ws <ws> [-R] <caminho>...
"""
import argparse
import os
import pwd
import sys


class ErroDono(Exception):
    """Nao deu para decidir o dono; a mensagem ja diz o que fazer."""


def dono_do_workspace(ws):
    """(uid, gid) do dono da pasta do agente. Falha dizendo o caminho se nao der para ler."""
    try:
        st = os.stat(ws)
    except OSError as e:
        raise ErroDono(f"nao consegui ler o dono da pasta do agente ({ws}): {e}. "
                       f"Confira DGCLAW_WORKSPACE no config.sh do agente.")
    return st.st_uid, st.st_gid


def usuario_da_rotina(ws):
    """(usuario, home) com que a unit vai rodar. DGCLAW_ROTINA_USUARIO manda; senao o dono da pasta."""
    forcado = os.environ.get("DGCLAW_ROTINA_USUARIO")
    if forcado:
        try:
            pw = pwd.getpwnam(forcado)
        except KeyError:
            raise ErroDono(f"DGCLAW_ROTINA_USUARIO={forcado!r} nao existe neste sistema "
                           f"(getpwnam nao achou). Corrija o nome no config.sh do agente "
                           f"ou remova a variavel.")
        return pw.pw_name, pw.pw_dir
    uid, _gid = dono_do_workspace(ws)
    try:
        pw = pwd.getpwuid(uid)
    except KeyError:
        raise ErroDono(f"a pasta do agente ({ws}) pertence ao uid {uid}, que nao tem entrada no "
                       f"passwd, entao nao sei com que usuario rodar. Defina "
                       f"DGCLAW_ROTINA_USUARIO=<usuario> no config.sh do agente.")
    return pw.pw_name, pw.pw_dir


def chown_dono(ws, path):
    """Quando o processo e root e a pasta do agente e de outro usuario, devolve o arquivo ao
    dono da pasta. Sem isso, a proxima execucao sem sudo nao consegue escrever ali. Falha nao
    aborta: vai para o stderr com o caminho, o motivo e o chown sugerido."""
    if os.geteuid() != 0:
        return
    uid, gid = dono_do_workspace(ws)
    if uid == 0:
        return
    try:
        os.chown(path, uid, gid)
    except OSError as e:
        print(f"[dono_agente] AVISO: nao consegui devolver {path} ao uid {uid} (dono da pasta "
              f"do agente): {e}. A proxima execucao sem sudo pode nao conseguir escrever ali; "
              f"rode: chown {uid}:{gid} {path}", file=sys.stderr)


def _chown_recursivo(ws, raiz):
    chown_dono(ws, raiz)
    if os.path.isdir(raiz) and not os.path.islink(raiz):
        for base, pastas, arquivos in os.walk(raiz):
            for nome in pastas + arquivos:
                chown_dono(ws, os.path.join(base, nome))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("unidade", help="imprime as linhas User= e Environment=HOME= da unit")
    u.add_argument("--ws", required=True)
    c = sub.add_parser("chown", help="devolve caminhos ao dono da pasta do agente")
    c.add_argument("--ws", required=True)
    c.add_argument("-R", dest="recursivo", action="store_true")
    c.add_argument("caminhos", nargs="+")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "unidade":
            usuario, home = usuario_da_rotina(a.ws)
            print(f"User={usuario}")
            print(f"Environment=HOME={home}")
        else:
            dono_do_workspace(a.ws)
            for p in a.caminhos:
                (_chown_recursivo if a.recursivo else chown_dono)(a.ws, p)
    except ErroDono as e:
        print(f"[dono_agente] ERRO: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
