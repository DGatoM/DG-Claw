'use strict';
// Tela do Manual: renderização de markdown (escapa tudo, links seguros), busca e marcação da página.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/manual');
const menu = require('../public/menu-lado');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

test('HTML cru do markdown aparece como texto, nunca como marcação', () => {
  const { html } = M.renderiza('# <img src=x onerror=1>\n\n<script>alert(1)</script> **ok**\n\n```\n<b>x</b>\n```\n\n- <u>a</u>\n\n| <i>h</i> |\n|---|\n| <b>c</b> |');
  assert.doesNotMatch(html, /<script|<img|<u>|<i>|<b>/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; <strong>ok<\/strong>/);
  assert.match(html, /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/);
});

test('links: http/https abrem fora, páginas do manual viram /manual, o resto vira texto', () => {
  assert.deepEqual(M.destinoLink('https://exemplo.com/a?b=1'), { tipo: 'externo', href: 'https://exemplo.com/a?b=1' });
  assert.equal(M.destinoLink('cofre.md').href, '/manual/cofre');
  assert.equal(M.destinoLink('./cofre.md#Como Usar').tipo, 'texto', 'espaço não é âncora válida');
  assert.equal(M.destinoLink('cofre.md#como-usar').href, '/manual/cofre#como-usar');
  assert.equal(M.destinoLink('README.md').href, '/manual');
  assert.equal(M.destinoLink('#Seção Um').href, '#secao-um');
  for (const ruim of ['javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', '//evil.com', 'vbscript:x', '../../../X.md', '../a/../../X.md', 'Cofre.md']) {
    assert.equal(M.destinoLink(ruim).tipo, 'texto', ruim);
  }
  const { html } = M.renderiza('[a](javascript:alert(1)) [b](../ATUALIZAR.md) [c](x.md#y) [d](https://e.com)');
  assert.doesNotMatch(html, /href="javascript/i);
  assert.match(html, /<a href="https:\/\/github\.com\/DGatoM\/DG-Claw\/blob\/main\/docs\/ATUALIZAR\.md" target="_blank" rel="noopener noreferrer">b<\/a>/);
  assert.equal(M.destinoLink('../../web/docs/MESA.md#rotas').href, 'https://github.com/DGatoM/DG-Claw/blob/main/web/docs/MESA.md#rotas');
  assert.match(html, /<a href="\/manual\/x#y">c<\/a>/);
  assert.match(html, /<a href="https:\/\/e\.com" target="_blank" rel="noopener noreferrer">d<\/a>/);
});

test('títulos ganham âncora única e sem acento; o primeiro H1 é o título', () => {
  const r = M.renderiza('# Olá, Mundão\n\n## Seção\n\n## Seção\n');
  assert.equal(r.titulo, 'Olá, Mundão');
  assert.match(r.html, /<h1 id="ola-mundao">/);
  assert.match(r.html, /<h2 id="secao">/);
  assert.match(r.html, /<h2 id="secao-1">/);
});

test('tabela fica dentro de um bloco que rola; lista aninha; código em linha preserva colchetes', () => {
  const r = M.renderiza('| A | B |\n|---|---|\n| 1 | `[x](y)` |\n\n- a\n  - b\n- c\n\n1. um\n2. dois\n');
  assert.match(r.html, /<div class="mn-tabela"><table>/);
  assert.match(r.html, /<code>\[x\]\(y\)<\/code>/);
  assert.match(r.html, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li>c<\/li><\/ul>/);
  assert.match(r.html, /<ol><li>um<\/li><li>dois<\/li><\/ol>/);
});

test('busca ignora acento e maiúscula; endereço vira nome de página', () => {
  const ps = [{ nome: 'cofre', titulo: 'O Cofre de Chaves' }, { nome: 'mesa', titulo: 'Mesa de tarefas' }];
  assert.deepEqual(M.filtraPaginas(ps, 'COFRE').map(p => p.nome), ['cofre']);
  assert.deepEqual(M.filtraPaginas(ps, 'tarefás').map(p => p.nome), ['mesa']);
  assert.equal(M.filtraPaginas(ps, '').length, 2);
  assert.equal(M.paginaDoCaminho('/manual'), '');
  assert.equal(M.paginaDoCaminho('/manual/cofre/'), 'cofre');
});

test('a página segue as regras das telas: sem zoom, tour, Tutorial e menu', () => {
  const html = pub('manual.html');
  assert.match(html, /sem-zoom\.css/);
  assert.match(html, /sem-zoom\.js/);
  assert.match(html, /user-scalable=no/);
  assert.match(html, /DGCasca\.monta\(\{ pagina: 'manual'/);
  assert.match(html, /\/tour\.js/);
  assert.match(pub('manual.js'), /DGManualTutorial/);
  assert.match(pub('manual.css'), /\.mn-tabela\{overflow-x:auto/);
  assert.equal(menu.LINK_MANUAL.href, '/manual');
  assert.equal(menu.chaveDoHref('/manual/cofre'), 'manual');
});

test('título indentado ou vazio não trava o renderizador', () => {
  assert.match(M.renderiza(' # Titulo').html, /<h1 id="titulo">Titulo<\/h1>/);
  assert.match(M.renderiza('   ## Sub').html, /<h2 id="sub">Sub<\/h2>/);
  for (const md of ['# ', '    # recuado', '  >', ' ```', '#\ntexto']) {
    assert.equal(typeof M.renderiza(md).html, 'string', JSON.stringify(md));
  }
});
