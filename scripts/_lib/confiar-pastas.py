#!/usr/bin/env python3
"""Marca pastas como confiaveis no .claude.json do Claude Code, antes de subir o `claude`.

Por que existe: o Claude Code 2.1.326 abre, no boot, o dialogo "Is this a directory you created or
one you trust?" (cursor em "No, exit") para o cwd e para CADA pasta passada com --add-dir que ainda
nao tem projects[<pasta>].hasTrustDialogAccepted = true. Sessao que sobe sem ninguem no teclado
(systemd, cron, PTY do runner) fica parada nele.

Uso (sempre com `python3 -I`; os caminhos vao como argumento, nunca dentro do codigo):

    python3 -I confiar-pastas.py [--onboarding] <.claude.json> <pasta> [<pasta> ...]

  --onboarding  tambem marca hasCompletedProjectOnboarding em cada pasta e hasCompletedOnboarding
                no arquivo (o que o instalador e o doctor sempre fizeram para o workspace).

Regras: preserva TODAS as outras chaves, o modo e o dono do arquivo; grava por tempfile na mesma
pasta + os.replace; nao reescreve se nada mudou; cria o arquivo se ele nao existe; se o conteudo nao
e um JSON de objeto, explica o que houve e sai com codigo 2 SEM tocar no arquivo.
Saidas: 0 ok (mudou ou nao), 2 arquivo ilegivel/invalido, 3 nao consegui gravar, 64 uso errado.
"""
import json
import os
import sys
import tempfile


def main(argv):
    onboarding = False
    args = list(argv)
    if args and args[0] == "--onboarding":
        onboarding = True
        args.pop(0)
    if len(args) < 2:
        sys.stderr.write("uso: confiar-pastas.py [--onboarding] <.claude.json> <pasta> [<pasta> ...]\n")
        return 64
    arquivo, pastas = args[0], [p for p in args[1:] if p]
    if not pastas:
        sys.stderr.write("confiar-pastas: nenhuma pasta informada, nada a marcar\n")
        return 64

    dados = {}
    existe = os.path.exists(arquivo)
    if existe:
        try:
            with open(arquivo, "r", encoding="utf-8") as f:
                texto = f.read()
            dados = json.loads(texto) if texto.strip() else {}
        except (OSError, ValueError) as e:
            sys.stderr.write(
                "confiar-pastas: nao consegui ler %s (%s). O arquivo NAO foi alterado. "
                "Se ele esta corrompido, mova-o para outro nome e rode de novo; "
                "o Claude Code recria o arquivo, mas voce precisara entrar de novo na conta.\n" % (arquivo, e)
            )
            return 2
        if not isinstance(dados, dict):
            sys.stderr.write(
                "confiar-pastas: %s nao e um objeto JSON (veio %s). O arquivo NAO foi alterado.\n"
                % (arquivo, type(dados).__name__)
            )
            return 2

    mudou = False
    projetos = dados.get("projects")
    if not isinstance(projetos, dict):
        projetos = {}
        dados["projects"] = projetos
        mudou = True
    marcadas = []
    for pasta in pastas:
        proj = projetos.get(pasta)
        if not isinstance(proj, dict):
            proj = {}
            projetos[pasta] = proj
            mudou = True
        if proj.get("hasTrustDialogAccepted") is not True:
            proj["hasTrustDialogAccepted"] = True
            marcadas.append(pasta)
            mudou = True
        if onboarding and proj.get("hasCompletedProjectOnboarding") is not True:
            proj["hasCompletedProjectOnboarding"] = True
            mudou = True
    if onboarding and dados.get("hasCompletedOnboarding") is not True:
        dados["hasCompletedOnboarding"] = True
        mudou = True

    if not mudou and existe:
        return 0

    pasta_do_arquivo = os.path.dirname(os.path.abspath(arquivo))
    try:
        os.makedirs(pasta_do_arquivo, exist_ok=True)
        modo, dono = 0o600, None
        if existe:
            st = os.stat(arquivo)
            modo, dono = st.st_mode & 0o777, (st.st_uid, st.st_gid)
        fd, tmp = tempfile.mkstemp(dir=pasta_do_arquivo, prefix="." + os.path.basename(arquivo) + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(dados, f, indent=2, ensure_ascii=False)
                f.write("\n")
            os.chmod(tmp, modo)
            if dono is not None and hasattr(os, "chown"):
                try:
                    os.chown(tmp, dono[0], dono[1])
                except OSError:
                    pass  # sem privilegio para trocar o dono: o dono ja e quem esta rodando
            os.replace(tmp, arquivo)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as e:
        sys.stderr.write(
            "confiar-pastas: nao consegui gravar %s (%s). Confira a permissao de escrita na pasta %s.\n"
            % (arquivo, e, pasta_do_arquivo)
        )
        return 3

    if marcadas:
        sys.stdout.write("confianca marcada em %s: %s\n" % (arquivo, ", ".join(marcadas)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
