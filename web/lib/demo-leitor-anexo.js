'use strict';
// Leitor de anexo que roda DENTRO do container, como o usuário do agente (docs/MODO-DEMONSTRACAO.md):
//   podman exec -u agente <container> python3 -I -c <SCRIPT> <base> <componentes...>
// Abre a base com O_DIRECTORY|O_NOFOLLOW e desce componente a componente com dir_fd e O_NOFOLLOW (O_DIRECTORY nos
// intermediários), então um atalho em QUALQUER componente é recusado e não há corrida entre conferir e abrir. No fim
// confere arquivo comum e um nome só (st_nlink == 1) e escreve os bytes no stdout (até 20 MB).
// Saída: 0 = ok; 3 caminho inválido; 4 atalho; 5 não existe; 6 não é arquivo comum; 7 hardlink; 8 grande; 9 outro erro.
const LIMITE_BYTES = 20 * 1024 * 1024;

const SCRIPT = `
import os, sys, stat, errno
LIM = ${LIMITE_BYTES}
def nao(cod, msg):
    sys.stderr.write("ANEXO_RECUSADO: " + msg + "\\n")
    sys.exit(cod)
if len(sys.argv) < 4:
    nao(3, "faltam a base e os componentes do caminho")
base = sys.argv[1]
partes = sys.argv[2:]
if partes[0] not in ("arquivos", "saida"):
    nao(3, "o anexo precisa estar em arquivos ou saida")
for p in partes:
    if p in ("", ".", "..") or "/" in p or "\\\\" in p or p.startswith(".") or "\\0" in p:
        nao(3, "componente de caminho invalido: " + repr(p))
fd = -1
try:
    fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    for i, p in enumerate(partes):
        ultimo = i == len(partes) - 1
        flags = os.O_RDONLY | os.O_NOFOLLOW | (os.O_NONBLOCK if ultimo else os.O_DIRECTORY)
        novo = os.open(p, flags, dir_fd=fd)
        os.close(fd)
        fd = novo
except OSError as e:
    if e.errno in (errno.ELOOP, errno.ENOTDIR):
        nao(4, "atalho (link simbolico) ou algo que nao e pasta no caminho")
    if e.errno == errno.ENOENT:
        nao(5, "o anexo nao existe")
    nao(9, "nao consegui abrir o anexo: " + os.strerror(e.errno))
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode):
    nao(6, "o anexo nao e um arquivo comum")
if st.st_nlink != 1:
    nao(7, "o anexo tem mais de um nome no disco (hardlink)")
if st.st_size > LIM:
    nao(8, "o anexo passa de 20 MB")
out = sys.stdout.buffer
total = 0
while True:
    pedaco = os.read(fd, 1048576)
    if not pedaco:
        break
    total += len(pedaco)
    if total > LIM:
        nao(8, "o anexo passa de 20 MB")
    out.write(pedaco)
out.flush()
`;

module.exports = { SCRIPT, LIMITE_BYTES };
