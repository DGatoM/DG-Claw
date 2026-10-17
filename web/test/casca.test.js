'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../public/casca');
const M = require('../public/menu-lado');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const lista = [
  { id: 'admin', nome: 'Admin', tipo: 'admin' },
  { id: 'tina', nome: 'Tina', tipo: 'agente' },
  { id: 'ana', nome: 'Ana', tipo: 'agente' },
];

test('agente da casca: caminho /p/<slug> vence, depois ?a=, depois o guardado, depois o primeiro que não é Admin', () => {
  assert.equal(C.escolheAgente(lista, { caminho: '/p/ana/', busca: '?a=tina', guardado: 'tina' }).id, 'ana');
  assert.equal(C.escolheAgente(lista, { caminho: '/mesa', busca: '?a=ana', guardado: 'tina' }).id, 'ana');
  assert.equal(C.escolheAgente(lista, { caminho: '/mesa', busca: '', guardado: 'ana' }).id, 'ana');
  assert.equal(C.escolheAgente(lista, { caminho: '/mesa', busca: '', guardado: 'sumiu' }).id, 'tina');
  assert.equal(C.escolheAgente([lista[0]], { caminho: '/mesa', busca: '' }).id, 'admin');
  assert.equal(C.escolheAgente([], { caminho: '/mesa', busca: '' }), null);
});

test('a casca tem o cabeçalho e o menu com a mesma marcação do conversa.html', () => {
  const conversa = pub('conversa.html');
  for (const id of ['btnMenu', 'av', 'nomeAgente', 'estado', 'btnTutorial', 'overlayMenu', 'btnFechaMenu', 'mlMoldura', 'mlNome',
    'mlSub', 'gmTutorial', 'mlTroca', 'mlTrocaBtn', 'mlLista', 'mlTabs', 'gmIrConversa', 'mlPainel', 'mlConfig', 'mlInstalar',
    'mlInstalarSub', 'mlInstalarAjuda', 'formSair']) {
    assert.ok(conversa.includes(`id="${id}"`), 'conversa.html sem ' + id);
    assert.ok((C.MARCACAO_CABECALHO + C.MARCACAO_MENU).includes(`id="${id}"`), 'casca sem ' + id);
  }
  assert.match(C.MARCACAO_MENU, /href="\/mesa"/);
  assert.match(C.MARCACAO_MENU, /action="\/sair"/);
});

test('menu: ?a=<slug> nos links da Mesa e dos Lembretes', () => {
  assert.equal(M.comAgente('/mesa', 'tina'), '/mesa?a=tina');
  assert.equal(M.comAgente('/lembretes', 'a b'), '/lembretes?a=a%20b');
  assert.equal(M.comAgente('/mesa', ''), '/mesa');
  const conversaJs = pub('conversa.js');
  assert.match(conversaJs, /\['btnMesa', '\/mesa'\], \['btnLembretes', '\/lembretes'\]/);
  assert.match(conversaJs, /dgclaw:agente/);
});

test('menu: opção ativo marca o item certo (chave do href)', () => {
  assert.equal(M.chaveDoHref('/mesa?a=tina'), 'mesa');
  assert.equal(M.chaveDoHref('/mesa/'), 'mesa');
  assert.equal(M.chaveDoHref('/lembretes?a=tina'), 'lembretes');
  assert.equal(M.chaveDoHref('/p/tina/#aba=cofre'), 'cofre');
  assert.equal(M.chaveDoHref('/a/tina'), 'conversa');
  assert.equal(M.chaveDoHref('/avisos'), '');
  // toda aba do painel do menu tem chave própria
  for (const l of M.linksPainel({ id: 'tina', tem_painel: true })) assert.ok(M.chaveDoHref(l.href));
});

test('menu: itens extras do painel (Sessões e poderes) viram links #aba=', () => {
  const l = M.linksExtras({ id: 'tina', tem_painel: true }, [{ chave: 'sessoes', ico: '◫', nome: 'Sessões' }, { chave: '', nome: 'x' }]);
  assert.deepEqual(l, [{ nome: 'Sessões', ico: '◫', href: '/p/tina/#aba=sessoes' }]);
  assert.deepEqual(M.linksExtras({ id: 'admin', tem_painel: false }, [{ chave: 'posts', nome: 'Posts' }]), []);
  assert.equal(M.chaveDoHref(l[0].href), 'sessoes');
});

test('menu: passos do tutorial do menu respondem o que é, como e por quê', () => {
  const p = M.passosMenu({ nome: 'Tina', comTroca: true, naConversa: false });
  assert.equal(p.length, 2);
  for (const x of p) { assert.ok(x.alvo && x.titulo && x.oque && x.como && x.porque); assert.doesNotMatch(JSON.stringify(x), /[—–]/); }
  assert.equal(M.passosMenu({ nome: 'Tina', comTroca: false }).length, 1);
});

test('casca.css não depende do chat.css/conversa.css e vem antes do menu-lado.css nas telas', () => {
  const css = pub('casca.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /html,body\{[^}]*overflow:hidden/);
  assert.doesNotMatch(css, /^header\{/m);
  for (const t of ['mesa.html', 'lembretes.html', 'avisos.html']) {
    const h = pub(t);
    assert.doesNotMatch(h, /chat\.css|conversa\.css/, t);
    assert.ok(h.indexOf('/casca.css') > 0 && h.indexOf('/casca.css') < h.indexOf('/menu-lado.css'), t);
    assert.ok(h.indexOf('/menu-lado.js') < h.indexOf('/casca.js'), t);
  }
});

test('avisos.html: sem a barra antiga, com a casca e o tutorial ligado ao botão da página', () => {
  const h = pub('avisos.html');
  assert.doesNotMatch(h, /av-barra|← Conversa/);
  assert.match(h, /DGCasca\.monta\(\{ pagina: 'avisos', titulo: 'Quadro de avisos'/);
  assert.match(h, /data-av-tutorial="pagina"/);
});

test('sw.js guarda a casca', () => {
  const s = pub('sw.js');
  assert.match(s, /'\/casca\.js'/);
  assert.match(s, /'\/casca\.css'/);
});
