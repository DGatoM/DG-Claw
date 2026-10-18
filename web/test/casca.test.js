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

test('o menu tem uma fonte só: a conversa.html não repete a marcação, usa o ponto de montagem da casca', () => {
  const conversa = pub('conversa.html');
  // nenhum id do menu escrito à mão na conversa.html (só o ponto de montagem)
  for (const id of ['overlayMenu', 'btnFechaMenu', 'mlMoldura', 'mlNome', 'mlSub', 'gmTutorial', 'mlTroca', 'mlTrocaBtn', 'mlLista',
    'mlTabs', 'gmIrConversa', 'mlPainel', 'mlConfig', 'mlInstalar', 'mlInstalarSub', 'mlInstalarAjuda', 'formSair']) {
    assert.ok(!conversa.includes(`id="${id}"`), 'conversa.html repete o menu da casca: ' + id);
    assert.ok(C.MARCACAO_MENU.includes(`id="${id}"`), 'a casca não tem ' + id);
  }
  assert.doesNotMatch(conversa, /<aside id="menu"/);
  assert.match(conversa, /<div id="menuPonto"><\/div>/);
  assert.match(conversa, /DGCasca\.injetaMenu\("menuPonto"\)/);
  // a casca vem antes do conversa.js (que usa os ids do menu logo ao carregar) e depois do menu-lado.js
  assert.ok(conversa.indexOf('/casca.js') > conversa.indexOf('/menu-lado.js') && conversa.indexOf('/casca.js') < conversa.indexOf('/conversa.js'));
  // o que a Conversa e o menu-lado.js usam continua existindo (ids da casca)
  for (const id of ['btnMenu', 'av', 'nomeAgente', 'estado', 'btnTutorial', 'btnSessoes']) {
    assert.ok(conversa.includes(`id="${id}"`), 'conversa.html sem ' + id);
    assert.ok(C.MARCACAO_CABECALHO.includes(`id="${id}"`), 'casca sem ' + id);
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
  assert.match(conversaJs, /DGCasca\.guardaAgente\(AGENTE\.id\)/);
  // o último agente vai para o localStorage (a casca) e para o cookie que o servidor lê na rota "/"
  assert.match(pub('casca.js'), /dgclaw:agente/);
  assert.match(pub('casca.js'), /dgclaw_agente=.*SameSite=Lax/);
});

test('menu: opção ativo marca o item certo (chave do href)', () => {
  assert.equal(M.chaveDoHref('/mesa?a=tina'), 'mesa');
  assert.equal(M.chaveDoHref('/mesa/'), 'mesa');
  assert.equal(M.chaveDoHref('/lembretes?a=tina'), 'lembretes');
  assert.equal(M.chaveDoHref('/p/tina/#aba=cofre'), 'cofre');
  assert.equal(M.chaveDoHref('/a/tina'), 'conversa');
  assert.equal(M.chaveDoHref('/avisos?a=tina'), 'avisos');
  assert.equal(M.chaveDoHref('/outra'), '');
  // toda aba do painel do menu tem chave própria
  for (const l of M.linksPainel({ id: 'tina', tem_painel: true })) assert.ok(M.chaveDoHref(l.href));
});

test('menu: itens extras do painel (Sessões e poderes) viram links #aba=', () => {
  const l = M.linksExtras({ id: 'tina', tem_painel: true }, [{ chave: 'posts', ico: '◫', nome: 'Posts' }, { chave: '', nome: 'x' }]);
  assert.deepEqual(l, [{ nome: 'Posts', ico: '◫', href: '/p/tina/#aba=posts' }]);
  assert.deepEqual(M.linksExtras({ id: 'admin', tem_painel: false }, [{ chave: 'posts', nome: 'Posts' }]), []);
  assert.equal(M.chaveDoHref(l[0].href), 'posts');
  // Sessões é item fixo: um painel antigo que ainda a mande como extra não a duplica no menu
  assert.deepEqual(M.linksExtras({ id: 'tina', tem_painel: true }, [{ chave: 'sessoes', nome: 'Sessões' }]), []);
});

test('menu: Sessões é item fixo de todo agente com painel, e Avisos é item fixo de todos', () => {
  const s = M.linkSessoes({ id: 'tina', tem_painel: true });
  assert.equal(s.nome, 'Sessões');
  assert.equal(s.ico, '🖥');
  assert.equal(s.href, '/p/tina/#aba=sessoes');
  assert.equal(s.config, '/p/tina/api/sessoes-config');
  assert.equal(M.chaveDoHref(s.href), 'sessoes');
  assert.equal(M.linkSessoes({ id: 'tina', tem_painel: true, painel_url: '/p/tina' }).href, '/p/tina/#aba=sessoes', 'painel_url sem a barra final');
  assert.equal(M.linkSessoes({ id: 'admin', tem_painel: false }), null, 'o Admin não tem painel, então não tem Sessões');
  assert.equal(M.LINK_AVISOS.href, '/avisos');
  assert.equal(M.chaveDoHref(M.comAgente(M.LINK_AVISOS.href, 'tina')), 'avisos');
  // a marcação do menu-lado.js põe Sessões logo depois da Mesa e esconde só com ligado:false
  const js = pub('menu-lado.js');
  assert.match(js, /mesa\.parentElement\.insertAdjacentHTML\('afterend'/);
  assert.match(js, /c\.ligado === false/);
  assert.match(js, /Deixei o item no menu/);
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
