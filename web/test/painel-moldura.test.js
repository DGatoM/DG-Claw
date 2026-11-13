'use strict';
// A moldura do painel (web/public/painel.html e painel-moldura.js): o que vem do iframe é dado não confiável.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/painel-moldura');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const JANELA = { nome: 'janela do iframe' };
const OUTRA = { nome: 'outra janela' };
const msg = (dados, fonte) => ({ source: fonte === undefined ? JANELA : fonte, data: Object.assign({ dgclaw: 1 }, dados) });

/** Roda `fn` com console.warn capturado (a triagem avisa por que ignorou). */
function comAvisos(fn) {
  const avisos = []; const orig = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  try { return { r: fn(), avisos }; } finally { console.warn = orig; }
}

test('mensagem de outra janela (ou sem janela) é ignorada em silêncio', () => {
  const { r, avisos } = comAvisos(() => [M.triagem(msg({ tipo: 'pronto' }, OUTRA), JANELA), M.triagem(msg({ tipo: 'pronto' }, null), JANELA), M.triagem(msg({ tipo: 'pronto' }), null), M.triagem(msg({ tipo: 'pronto' }, undefined), undefined)]);
  assert.deepEqual(r, [null, null, null, null]);
  assert.equal(avisos.length, 0);
  assert.deepEqual(M.triagem(msg({ tipo: 'pronto' }), JANELA), { tipo: 'pronto' });
});

test('formato, tipo fora da lista branca e tamanho: ignorados com aviso', () => {
  const { r, avisos } = comAvisos(() => [
    M.triagem({ source: JANELA, data: 'texto' }, JANELA),
    M.triagem({ source: JANELA, data: { tipo: 'pronto' } }, JANELA),            // sem dgclaw:1
    M.triagem({ source: JANELA, data: { dgclaw: 2, tipo: 'pronto' } }, JANELA),
    M.triagem(msg({ tipo: 'apagar-tudo' }), JANELA),
    M.triagem(msg({ tipo: 'tema', valor: 'claro' }), JANELA),                    // tipo que só vai da moldura para o iframe
    M.triagem(msg({ tipo: 'ativa', pagina: 'status', titulo: 'x'.repeat(5000) }), JANELA),
    M.triagem(msg({ tipo: 'extras', lista: new Array(21).fill({ chave: 'a', ico: '', nome: 'n' }) }), JANELA),
  ]);
  assert.deepEqual(r, [null, null, null, null, null, null, null]);
  assert.equal(avisos.length, 7);
  assert.ok(avisos.every((a) => /ignorada/.test(a)));
});

test('ir: só páginas do próprio Web; //evil, /\\evil, URL completa, javascript: e desvios são ignorados', () => {
  for (const ok of ['/a/ana', '/a/ana/', '/mesa', '/lembretes', '/avisos', '/seguranca', '/p/ana/#aba=status', '/p/ana/?x=1', '/mesa?a=ana', '/manual/inicio.md']) {
    assert.deepEqual(comAvisos(() => M.triagem(msg({ tipo: 'ir', para: ok }), JANELA)).r, { tipo: 'ir', para: ok }, ok);
  }
  for (const ruim of ['//evil.example', '//evil.example/a/ana', '/\\evil.example', '/\\/evil', 'https://evil.example/a/ana', 'javascript:alert(1)', 'a/ana', '', '/', '/outra', '/a/../x', '/a/%2e%2e/x', '/a/ana/%2fx',
    '/a/ana\\x', '/api/v1/agents', '/login', '/sair', '/pv/x', '/a/ana\n', `/a/${'x'.repeat(300)}`, null, undefined, 5, {}, ['/a/ana']]) {
    const { r, avisos } = comAvisos(() => M.triagem(msg({ tipo: 'ir', para: ruim }), JANELA));
    assert.equal(r, null, String(ruim));
    assert.equal(avisos.length, 1, 'cada recusa deixa um aviso no console');
  }
});

test('ativa e extras: chave validada por regex curta; texto com HTML segue como texto puro', () => {
  const r = comAvisos(() => M.triagem(msg({ tipo: 'ativa', pagina: 'memory', titulo: '<img src=x onerror=alert(1)>' }), JANELA)).r;
  assert.deepEqual(r, { tipo: 'ativa', pagina: 'memory', titulo: '<img src=x onerror=alert(1)>' }, 'a moldura não altera o texto: quem o põe na tela usa textContent');
  assert.deepEqual(comAvisos(() => M.triagem(msg({ tipo: 'ativa', pagina: '', titulo: null }), JANELA)).r, { tipo: 'ativa', pagina: '', titulo: null });
  for (const pagina of ['a b', '<x>', 'a'.repeat(41), '../x', 5, null]) assert.equal(comAvisos(() => M.triagem(msg({ tipo: 'ativa', pagina, titulo: 't' }), JANELA)).r, null, String(pagina));
  const bom = { tipo: 'extras', lista: [{ chave: 'posts', ico: '📷', nome: 'Posts' }] };
  assert.deepEqual(comAvisos(() => M.triagem(msg(bom), JANELA)).r, bom);
  for (const x of [{ chave: 'a"b', ico: '', nome: 'n' }, { chave: 'ok', ico: 'x'.repeat(9), nome: 'n' }, { chave: 'ok', ico: '', nome: 'n'.repeat(61) }, { chave: 'ok', ico: 1, nome: 'n' }, null, 'texto']) {
    assert.equal(comAvisos(() => M.triagem(msg({ tipo: 'extras', lista: [x] }), JANELA)).r, null, JSON.stringify(x));
  }
});

test('o código da moldura nunca põe texto do iframe como HTML', () => {
  const src = pub('painel-moldura.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/.test(src));
  assert.match(src, /erro\.textContent = motivo/);
  // a casca (cabeçalho e menu) é quem recebe o título e os extras: o título entra por textContent e o menu escapa
  assert.match(pub('casca.js'), /e\.textContent = est\.titulo/);
  const menu = pub('menu-lado.js');
  for (const campo of ['l.href', 'l.ico', 'l.nome']) assert.ok(menu.includes(`\${esc(${campo})}`), `o menu não escapa ${campo}`);
});

test('painel.html: iframe com sandbox sem allow-same-origin nem navegação do topo, clipboard e referrer', () => {
  const html = pub('painel.html');
  const tag = /<iframe\b[^>]*>/.exec(html)[0];
  const sandbox = /sandbox="([^"]*)"/.exec(tag)[1];
  assert.equal(sandbox, 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads');
  assert.ok(!/allow-same-origin|allow-top-navigation/.test(tag));
  assert.match(tag, /allow="clipboard-write; fullscreen"/);
  assert.match(tag, /referrerpolicy="no-referrer"/);
  assert.ok(!/\ssrc=/.test(tag), 'o endereço (com o token) é posto pelo script, nunca escrito no HTML');
  assert.ok(M.sandboxSeguro(sandbox));
  assert.equal(M.sandboxSeguro(`${sandbox} allow-same-origin`), false);
  assert.equal(M.sandboxSeguro(`${sandbox} allow-top-navigation-by-user-activation`), false);
  assert.equal(M.sandboxSeguro(''), false);
  assert.equal(M.sandboxSeguro(null), false);
  // a casca, o menu e a moldura vêm na ordem certa
  assert.ok(html.indexOf('/menu-lado.js') < html.indexOf('/casca.js') && html.indexOf('/casca.js') < html.indexOf('/painel-moldura.js'));
});

test('sem travessão nos arquivos novos da moldura', () => {
  for (const f of ['painel.html', 'painel-moldura.js', 'painel-moldura.css']) assert.ok(!/[—–]/.test(pub(f)), f);
});

test('ir: a navegação usa o endereço remontado (new URL do próprio origin), nunca o texto cru do iframe', () => {
  const src = pub('painel-moldura.js');
  assert.match(src, /const u = new URL\(msg\.para, location\.origin\)/);
  assert.match(src, /u\.origin !== location\.origin \|\| !destinoValido\(u\.pathname \+ u\.search \+ u\.hash\)/);
  assert.match(src, /location\.assign\(u\.pathname \+ u\.search \+ u\.hash\)/);
  assert.ok(!/location\.assign\(msg\./.test(src));
});
