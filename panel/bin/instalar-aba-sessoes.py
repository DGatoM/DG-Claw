#!/usr/bin/env python3
"""Enxerta a aba Sessões num painel DG Claw já instalado, sem trocar o painel inteiro.

Uso:  instalar-aba-sessoes.py <pasta-do-painel-instalado> [--aplicar]

Por que enxerto: os painéis instalados (Lara, Luna, Marina...) estão numa base mais antiga e
têm remendos à mão. Copiar o painel da worktree por cima apagaria esses remendos. Aqui só se
mexe nos pontos da aba Sessões.

Sem --aplicar é ensaio: nada é escrito no painel; o script calcula tudo na memória, confere a
sintaxe numa pasta temporária e mostra o diff. Com --aplicar escreve, depois de salvar
<arquivo>.bak-20261012-sessoes de cada arquivo existente que vai mudar.

Regras:
  - cada âncora precisa casar EXATAMENTE uma vez, senão aborta sem escrever nada;
  - idempotente: um pedaço que já está enxertado é pulado;
  - se o .bak já existe e o arquivo ainda precisa mudar, aborta (não sobrescreve cópia antiga);
  - node --check em server.js, app.js e sessoes.js antes de escrever e depois.
"""
import difflib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ORIGEM = Path(__file__).resolve().parent.parent  # panel/ da worktree
SUFIXO = '.bak-20261012-sessoes'
NOVOS = ['lib/sessoes-proxy.js', 'public/js/sessoes.js', 'public/css/sessoes.css', 'docs/SESSOES.md']


class Aborta(Exception):
    pass


def unica(texto, padrao, arquivo, nome, flags=re.M):
    achados = list(re.finditer(padrao, texto, flags))
    if len(achados) != 1:
        raise Aborta(f'Âncora "{nome}" em {arquivo}: casou {len(achados)} vez(es), precisava casar exatamente 1. '
                     'Nada foi escrito.')
    return achados[0]


def insere_depois(texto, m):
    return texto[:m.end()]


# ─── server.js ───────────────────────────────────────────────────────────────
LINHA_URLENC = "app.use(express.urlencoded({ extended: false }));\n"
LINHA_JSON = "app.use(express.json({ limit: '3mb' }));\n"
BLOCO_PARSER = """// A aba Sessões (lib/sessoes-proxy.js) repassa o corpo em STREAM para o DG Telegram (anexo de
// até 100 MB). Um parser global que lesse o corpo antes deixaria o proxy sem nada para
// repassar, então /api/sessoes passa direto. O caminho aqui ainda leva o prefixo BASE.
const PREFIXO_SESSOES = `${BASE}/api/sessoes`.toLowerCase(); // o Express casa rota sem olhar maiúscula
const semParser = (parser) => (req, res, next) => {
  const p = req.path.toLowerCase();
  return p === PREFIXO_SESSOES || p.startsWith(`${PREFIXO_SESSOES}/`) ? next() : parser(req, res, next);
};
"""
REQUIRE_PROXY = """// A aba Sessões (12/10/2026): proxy fino para os cards do Bunker, via DG Telegram. Ver docs/SESSOES.md.
require('./lib/sessoes-proxy').registrar(router, { CONFIG });
"""


def server_js(t):
    a = 'server.js'
    if 'PREFIXO_SESSOES' not in t:
        mb = unica(t, r"^let BASE = ", a, 'definição de BASE (let BASE = ...)')
        mu = unica(t, re.escape(LINHA_URLENC), a, LINHA_URLENC.strip(), 0)
        mj = unica(t, re.escape(LINHA_JSON), a, LINHA_JSON.strip(), 0)
        if mb.start() > mu.start():
            raise Aborta(f'Em {a}, BASE só é definido depois do ponto onde o semParser precisa dele '
                         '(app.use(express.urlencoded...)). O enxerto não é seguro nesta base. Nada foi escrito.')
        t = t.replace(LINHA_URLENC, BLOCO_PARSER + 'app.use(semParser(express.urlencoded({ extended: false })));\n', 1)
        t = t.replace(LINHA_JSON, "app.use(semParser(express.json({ limit: '3mb' })));\n", 1)
    if "require('./lib/sessoes-proxy')" not in t:
        m = unica(t, r"^require\('\./lib/wm-status'\)\.registrar\(router, \{ CONFIG \}\);\n", a, "require('./lib/wm-status').registrar(...)")
        t = t[:m.end()] + REQUIRE_PROXY + t[m.end():]
    return t


# ─── index.html ──────────────────────────────────────────────────────────────
LINK_CSS = '  <link rel="stylesheet" href="{{BASE}}/css/sessoes.css">\n'
BOTAO = ('        <!-- Sessões (12/10/2026): nasce escondida; js/sessoes.js mostra quando /api/sessoes-config diz ligado:true. -->\n'
         '        <button class="tab" data-tab="sessoes" hidden><span class="ico">◫</span>Sessões</button>\n')
PAINEL = ('        <!-- SESSÕES: desenhada inteira por js/sessoes.js (ver o cabeçalho dele). -->\n'
          '        <div class="panel" id="panel-sessoes"><div id="sessoes-root"></div></div>\n\n')
SCRIPT = '  <script src="{{BASE}}/js/sessoes.js"></script>\n'


def index_html(t):
    a = 'public/index.html'
    if 'css/sessoes.css' not in t:
        m = None
        achados = list(re.finditer(r'^.*css/operacoes\.css.*\n', t, re.M))
        if len(achados) > 1:
            raise Aborta(f'Âncora "link do operacoes.css" em {a}: casou {len(achados)} vezes. Nada foi escrito.')
        if achados:
            m = achados[0]
        else:
            ls = list(re.finditer(r'^.*<link rel="stylesheet".*\n', t, re.M))
            if not ls:
                raise Aborta(f'Âncora "último <link rel=\\"stylesheet\\">" em {a}: não achei nenhum. Nada foi escrito.')
            m = ls[-1]
        t = t[:m.end()] + LINK_CSS + t[m.end():]
    if 'data-tab="sessoes"' not in t:
        m = unica(t, r'^.*data-tab="operations".*\n', a, 'botão data-tab="operations"')
        t = t[:m.end()] + BOTAO + t[m.end():]
    if 'id="panel-sessoes"' not in t:
        m = unica(t, r'^[ \t]*<!-- COFRE -->', a, '<!-- COFRE -->')
        t = t[:m.start()] + PAINEL + t[m.start():]
    if '/js/sessoes.js"' not in t:
        ss = list(re.finditer(r'^[ \t]*<script src=.*\n', t, re.M))
        if not ss:
            raise Aborta(f'Âncora "último <script src>" em {a}: não achei nenhum. Nada foi escrito.')
        unica(t, r'</body>', a, '</body>')
        m = ss[-1]
        t = t[:m.end()] + SCRIPT + t[m.end():]
    return t


# ─── app.js ──────────────────────────────────────────────────────────────────
SUBTITULO = "  sessoes: 'os cards do Bunker: o que cada um faz agora',\n"
EXPLICACAO = ("  sessoes: 'Os cards do Bunker, que são as conversas de Claude trabalhando em pastas. Veja o que cada um '\n"
              "    + 'está fazendo, leia a conversa, mande recado e crie sessões novas. Pedido de permissão só se decide no DG Telegram.',\n")
CASE = "    case 'sessoes': await window.DGSessoes.carregar(); break;\n"


def app_js(t):
    a = 'public/js/app.js'
    # No começo de cada objeto, e não depois da entrada operations: lá a entrada tem uma ou mais
    # linhas e muda de base para base. A ordem das chaves de um objeto não importa.
    if "sessoes: 'os cards do Bunker" not in t:
        m = unica(t, r'^const SUBTITULO_ABA = \{\n', a, 'const SUBTITULO_ABA = {')
        t = t[:m.end()] + SUBTITULO + t[m.end():]
    if "sessoes: 'Os cards do Bunker" not in t:
        m = unica(t, r'^const EXPLICACAO_ABA = \{\n', a, 'const EXPLICACAO_ABA = {')
        t = t[:m.end()] + EXPLICACAO + t[m.end():]
    if "case 'sessoes'" not in t:
        m = unica(t, r"^[ \t]*case 'operations': await loadOperations\(\); break;\n", a, "case 'operations' do loadPanel")
        t = t[:m.end()] + CASE + t[m.end():]
    return t


def node_check(caminho):
    r = subprocess.run(['node', '--check', str(caminho)], capture_output=True, text=True)
    if r.returncode != 0:
        raise Aborta(f'node --check falhou em {caminho.name}: {r.stderr.strip()}')


def main():
    args = [x for x in sys.argv[1:] if x != '--aplicar']
    aplicar = '--aplicar' in sys.argv[1:]
    if len(args) != 1:
        print(__doc__)
        return 2
    alvo = Path(args[0]).resolve()
    try:
        if not (alvo / 'server.js').is_file() or not (alvo / 'public/index.html').is_file():
            raise Aborta(f'{alvo} não parece uma pasta de painel (falta server.js ou public/index.html).')
        novos = {}  # caminho relativo -> texto novo (arquivos que mudam)
        for rel, fn in (('server.js', server_js), ('public/index.html', index_html), ('public/js/app.js', app_js)):
            antigo = (alvo / rel).read_text(encoding='utf-8')
            novo = fn(antigo)
            if novo != antigo:
                novos[rel] = (antigo, novo)
        copias = []
        for rel in NOVOS:
            fonte = (ORIGEM / rel).read_bytes()
            destino = alvo / rel
            if destino.exists() and destino.read_bytes() == fonte:
                continue
            copias.append((rel, fonte, destino.exists()))

        # .bak existente em arquivo que vai mudar: aborta antes de escrever qualquer coisa.
        for rel in list(novos) + [r for r, _, existe in copias if existe]:
            if (alvo / (rel + SUFIXO)).exists():
                raise Aborta(f'{rel + SUFIXO} já existe e {rel} ainda precisa mudar. Não sobrescrevo cópia antiga: '
                             'confira o arquivo e mova ou apague o .bak. Nada foi escrito.')

        # Sintaxe conferida numa pasta temporária ANTES de tocar no painel.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for rel in ('server.js', 'public/js/app.js'):
                if rel in novos:
                    (tmp / Path(rel).name).write_text(novos[rel][1], encoding='utf-8')
                    node_check(tmp / Path(rel).name)
            shutil.copy(ORIGEM / 'public/js/sessoes.js', tmp / 'sessoes.js')
            node_check(tmp / 'sessoes.js')

        print(f'Painel: {alvo}')
        print('Modo: ' + ('APLICAR' if aplicar else 'ENSAIO (nada é escrito)'))
        if not novos and not copias:
            print('Já está com a aba Sessões enxertada. Nada a fazer.')
            return 0
        for rel, (antigo, novo) in novos.items():
            d = list(difflib.unified_diff(antigo.splitlines(True), novo.splitlines(True), f'a/{rel}', f'b/{rel}', n=1))
            mais = sum(1 for l in d if l.startswith('+') and not l.startswith('+++'))
            menos = sum(1 for l in d if l.startswith('-') and not l.startswith('---'))
            print(f'\n=== {rel}: +{mais} -{menos}')
            sys.stdout.writelines(d)
        for rel, fonte, existe in copias:
            print(f'\n=== {rel}: {"sobrescreve (com .bak)" if existe else "novo arquivo"} ({len(fonte)} bytes)')

        if not aplicar:
            print('\nEnsaio concluído: sintaxe conferida em pasta temporária. Rode com --aplicar para escrever.')
            return 0

        for rel, (antigo, novo) in novos.items():
            shutil.copy2(alvo / rel, alvo / (rel + SUFIXO))
            (alvo / rel).write_text(novo, encoding='utf-8')
        for rel, fonte, existe in copias:
            destino = alvo / rel
            destino.parent.mkdir(parents=True, exist_ok=True)
            if existe:
                shutil.copy2(destino, alvo / (rel + SUFIXO))
            destino.write_bytes(fonte)
        for rel in ('server.js', 'public/js/app.js', 'public/js/sessoes.js'):
            node_check(alvo / rel)
        print('\nAplicado. node --check passou em server.js, app.js e sessoes.js. '
              'Reinicie o serviço do painel para valer (este script não reinicia nada).')
        return 0
    except Aborta as e:
        print(f'ABORTADO: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
