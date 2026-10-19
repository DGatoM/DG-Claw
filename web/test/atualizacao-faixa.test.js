'use strict';
// Faixa de nova versão: funções puras (fora do DOM), escape do texto vindo do GitHub e ligação nas telas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/atualizacao-faixa');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const estado = (extra) => Object.assign({
  mostrar_faixa: true, instalado: { commit: A, versao: 'v1-aaaaaaaaaaaa' },
  publicado: { commit: B, versao: '1.1.0' }, novidades: ['Lousa nova.', 'Aviso de versão.'],
}, extra || {});

test('esc cobre & < > " e aspa simples', () => {
  assert.equal(F.esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(F.esc(null), '');
  assert.equal(F.esc(7), '7');
});

test('rótulo das versões: usa o número, ou os 7 primeiros do commit', () => {
  assert.equal(F.rotuloVersoes(estado()), 'v1-aaaaaaaaaaaa → 1.1.0');
  assert.equal(F.rotuloVersoes(estado({ publicado: { commit: B, versao: null } })), 'v1-aaaaaaaaaaaa → bbbbbbb');
  assert.equal(F.rotuloVersoes(estado({ instalado: null })), '? → 1.1.0');
});

test('a faixa tem uma linha com os três botões, o ? do tutorial e a lista fechada', () => {
  const h = F.faixaHtml(estado());
  assert.match(h, /Nova versão do DG Claw disponível/);
  assert.match(h, /v1-aaaaaaaaaaaa → 1\.1\.0/);
  for (const a of ['ver', 'instalar', 'descansar', 'ajuda']) assert.ok(h.includes(`data-af="${a}"`), a);
  assert.match(h, />Ver o que mudou</);
  assert.match(h, />Instalar</);
  assert.match(h, />Agora não</);
  assert.match(h, /<ul class="af-lista" id="faixaAtualizacaoLista" hidden>/);
  assert.match(h, /<li>Lousa nova\.<\/li><li>Aviso de versão\.<\/li>/);
});

test('texto vindo do GitHub sai escapado: <img onerror> nunca vira tag', () => {
  const ruim = '<img src=x onerror=alert(1)>';
  const h = F.faixaHtml(estado({
    novidades: [ruim, '"><script>alert(2)</script>'],
    instalado: { commit: A, versao: ruim },
    publicado: { commit: B, versao: '</b><svg onload=alert(3)>' },
  }));
  assert.doesNotMatch(h, /<img/i);
  assert.doesNotMatch(h, /<script/i);
  assert.doesNotMatch(h, /<svg/i);
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(h.includes('&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;'));
  assert.ok(h.includes('&lt;/b&gt;&lt;svg onload=alert(3)&gt;'));
});

test('sem novidades detalhadas, a lista diz isso em vez de ficar vazia', () => {
  assert.match(F.novidadesHtml([]), /não trouxe o detalhe/);
  assert.match(F.novidadesHtml(undefined), /não trouxe o detalhe/);
  assert.equal(F.novidadesHtml([7, null, '']).includes('<li>7'), false);
});

test('o botão Instalar leva ao Admin com o pedido já escrito, sem enviar nada', () => {
  assert.equal(F.CAMINHO_ADMIN, '/a/admin');
  assert.equal(F.TEXTO_INSTALAR, 'Quero instalar a atualização do DG Claw');
  const src = pub('atualizacao-faixa.js');
  assert.match(src, /'\?texto=' \+ encodeURIComponent\(TEXTO_INSTALAR\)/, 'usa o ?texto= que a conversa já sabe preencher');
  assert.doesNotMatch(src.slice(src.indexOf('function instalar')), /\/messages|\/api\/v1\/agents/, 'o botão não manda mensagem sozinho');
  assert.match(pub('conversa.js'), /searchParams\.get\('texto'\)/, 'a conversa preenche o campo e não envia');
});

test('passo do tutorial responde o que é, como calculo e por que está aqui', () => {
  assert.equal(F.PASSO.alvo, '#faixaAtualizacao');
  for (const k of ['titulo', 'oque', 'como', 'porque']) assert.ok(F.PASSO[k] && F.PASSO[k].length > (k === 'titulo' ? 5 : 20), k);
  assert.match(F.PASSO.como, /6 horas/);
  assert.doesNotMatch(JSON.stringify(F.PASSO), /[—–]/);
});

test('conversa.html e a casca carregam a faixa; o service worker guarda os dois arquivos', () => {
  const h = pub('conversa.html');
  assert.equal(h.split('/atualizacao-faixa.js').length - 1, 1);
  assert.ok(h.indexOf('/tour.js') < h.indexOf('/atualizacao-faixa.js'));
  assert.match(pub('casca.js'), /s\.src = '\/atualizacao-faixa\.js'/);
  const sw = pub('sw.js');
  for (const u of ['/atualizacao-faixa.js', '/atualizacao-faixa.css']) assert.ok(sw.includes(`'${u}'`), u);
  assert.match(sw, /dgclaw-estaticos-v(2[1-9]|[3-9][0-9])\b/);
});

test('o css não gera rolagem horizontal e deixa os botões com 32 px', () => {
  const css = pub('atualizacao-faixa.css');
  assert.match(css, /flex-wrap:wrap/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /\.af-btn\{min-height:32px/);
  assert.match(css, /\.af-ajuda\{width:32px;height:32px/);
});
