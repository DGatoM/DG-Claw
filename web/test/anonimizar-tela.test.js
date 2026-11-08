'use strict';
// Tela Anonimizar: textos puros, escape, ligação das telas (menu, conversa, service worker) e regras de estilo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../public/anonimizar');
const M = require('../public/menu-lado');

const PUB = path.join(__dirname, '..', 'public');
const le = (n) => fs.readFileSync(path.join(PUB, n), 'utf8');

test('destacaMarcadores escapa tudo e destaca só os marcadores', () => {
  assert.equal(T.destacaMarcadores('<img src=x onerror=alert(1)> [PESSOA_1] & [x_1] [CPF_12]'),
    '&lt;img src=x onerror=alert(1)&gt; <mark class="an-marca">[PESSOA_1]</mark> &amp; [x_1] <mark class="an-marca">[CPF_12]</mark>');
});

test('rótulos do nível dizem o que NÃO é procurado quando falta o detector', () => {
  assert.match(T.rotuloNivel('regex'), /Nomes e endereços NÃO/);
  assert.match(T.rotuloNivel('leitores'), /Nomes e endereços NÃO/);
  assert.doesNotMatch(T.rotuloNivel('completo'), /NÃO/);
  assert.match(T.rotuloNivel(null), /não respondeu/);
  assert.equal(T.textoContagem(1), '1 dado trocado');
  assert.equal(T.textoContagem(12), '12 dados trocados');
  assert.equal(T.mbParaTexto(2048), '2,0 GB');
  assert.equal(T.mbParaTexto(null), 'não medida');
});

test('cartão do detector: botões certos por nível, desligados durante a instalação, erro visível', () => {
  const base = { ram: { disponivel_mb: 3000, total_mb: 4000 } };
  const regex = T.detectorHtml(Object.assign({ detector: { nivel: 'regex' }, instalacao: { em_andamento: false } }, base));
  assert.match(regex, /data-nivel="leitores"/); assert.match(regex, /data-nivel="completo"/);
  const leitores = T.detectorHtml(Object.assign({ detector: { nivel: 'leitores' }, instalacao: { em_andamento: false } }, base));
  assert.doesNotMatch(leitores, /data-nivel="leitores"/); assert.match(leitores, /data-nivel="completo"/);
  const completo = T.detectorHtml(Object.assign({ detector: { nivel: 'completo' }, instalacao: { em_andamento: false } }, base));
  assert.doesNotMatch(completo, /data-an="instalar"/);
  const instalando = T.detectorHtml(Object.assign({ detector: { nivel: 'regex' }, instalacao: { em_andamento: true, nivel: 'completo', arquivo: { nivel: 'regex', nivel_pedido: 'completo', erro: null } } }, base));
  assert.match(instalando, /role="progressbar"/); assert.match(instalando, /disabled/); assert.match(instalando, /Instalando o detector completo/);
  const falhou = T.detectorHtml(Object.assign({ detector: { nivel: 'regex' }, instalacao: { em_andamento: false, arquivo: { nivel: 'regex', nivel_pedido: 'completo', erro: 'sem espaço <b>' } } }, base));
  assert.match(falhou, /sem espaço &lt;b&gt;/); assert.match(falhou, /completo\) falhou/);
  assert.match(T.detectorHtml({ detector: { nivel: null, erro: 'motor fora' }, instalacao: {}, ram: {} }), /motor fora/);
});

test('cartão do agente e lista de documentos escapam o que vem da API e nunca mostram valores', () => {
  const h = T.agenteHtml({ slug: 'ana', nome: '<Ana>', documentos: 2 }, { ligado: true, valores: true, sem_detector: 'so_numeros', nao_anonimizavel: 'bloquear' });
  assert.match(h, /&lt;Ana&gt;/); assert.doesNotMatch(h, /<Ana>/);
  assert.match(h, /data-an="ligado" checked/); assert.match(h, /data-campo="valores" checked/);
  assert.match(h, /<option value="so_numeros" selected>/);
  assert.match(h, /2 documentos anonimizados/);
  const d = T.documentosHtml([{ id: 'ab12cd34', nome_original: '<b>contrato</b>.pdf', criado_em: '2026-11-07T10:00:00Z', total: 3 }]);
  assert.match(d, /&lt;b&gt;contrato/); assert.match(d, /3 dados trocados/); assert.match(d, /data-an="apagar"/);
  assert.match(T.documentosHtml([]), /Nenhum documento/);
  const t = T.tabelaHtml([{ marcador: '[PESSOA_1]', valor: '<i>Maria</i>' }]);
  assert.match(t, /&lt;i&gt;Maria/);
});

test('tutorial: um passo por seção, com o que é, como funciona e por que está aqui', () => {
  const passos = T.passosDaPagina();
  assert.equal(passos.length, 5);
  for (const p of passos) {
    assert.ok(p.alvo && p.titulo && p.oque && p.como && p.porque, p.titulo);
    assert.ok(typeof p.alvo === 'string');
  }
});

test('a página real: scripts existem, tem Tutorial pela casca, um ? por seção, sem zoom e sem travessão', () => {
  const html = le('anonimizar.html');
  for (const s of ['/tour.js', '/menu-lado.js', '/casca.js', '/anonimizar.js', '/anonimizar.css', '/sem-zoom.js', '/sem-zoom.css']) {
    assert.ok(html.includes(s), 'falta ' + s);
    assert.ok(fs.existsSync(path.join(PUB, s)), 'não existe ' + s);
  }
  assert.match(html, /pagina: 'anonimizar'/); assert.match(html, /aoTutorial/);
  assert.match(html, /user-scalable=no/);
  assert.equal((html.match(/data-an="ajuda"/g) || []).length, 5);
  for (const alvo of T.passosDaPagina().map((p) => p.alvo)) assert.ok(html.includes('id="' + alvo.slice(1) + '"'), 'sem ' + alvo);
  for (const n of ['anonimizar.html', 'anonimizar.js', 'anonimizar.css']) assert.doesNotMatch(le(n), /[—–]/, n);
  const css = le('anonimizar.css');
  assert.match(css, /font-size:16px/);
  assert.match(css, /min-height:3[2-9]px/);
});

test('menu: item Anonimizar, reconhecimento da página e cache do service worker', () => {
  assert.deepEqual(M.LINK_ANONIMIZAR, { nome: 'Anonimizar', ico: '🕶', href: '/anonimizar' });
  assert.equal(M.chaveDoHref('/anonimizar?a=ana'), 'anonimizar');
  assert.match(le('sw.js'), /'\/anonimizar\.js', '\/anonimizar\.css'/);
  assert.match(le('sw.js'), /dgclaw-estaticos-v(3[5-9]|[4-9][0-9])'/);
});

test('conversa: selo, botões de dados reais e aviso no upload estão ligados, sem HTML cru do texto revertido', () => {
  const js = le('conversa.js'); const html = le('conversa.html');
  assert.match(html, /id="btnAnon"[^>]*hidden/);
  assert.match(js, /data-anon-ver=/); assert.match(js, /data-anon-final=/);
  assert.match(js, /Ver com dados reais/); assert.match(js, /Baixar versão final/);
  assert.match(js, /Anonimizado: /);
  // o texto revertido passa por paragrafos(), que escapa; nunca por innerHTML direto
  assert.match(js, /textoPuroEmParagrafos\(anonVistos/);
  assert.doesNotMatch(js, /innerHTML\s*=\s*d\.texto/);
  assert.match(js, /\/\\\[\[A-Z\]\+_\\d\+\\\]\/\.test\(leg\)/);
});

test('Correção na conversa: o texto revertido entra como texto puro, sem linkify nem markdown', () => {
  const js = le('conversa.js');
  assert.match(js, /function textoPuroEmParagrafos/);
  assert.match(js, /htmlLeg = textoPuroEmParagrafos\(anonVistos\.get\(String\(m\.id\)\)\)/);
  const f = /function textoPuroEmParagrafos[\s\S]*?\n}\n/.exec(js)[0];
  assert.doesNotMatch(f, /linkify|formata\(/);
});
