'use strict';
// Boletins de segurança na tela Segurança: textos puros (ronda-comum), cards, escape do texto vindo do GitHub e ligação nas telas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/ronda-comum');
const T = require('../public/seguranca');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const AGORA = Date.parse('2026-10-31T12:00:00Z');
const bol = (extra) => Object.assign({
  id: 'GHSA-332P-7HRC-92WF', severidade: 'CRITICAL', componente: 'Pillow', acao: 'atualizar-dgclaw', titulo: 'Vulnerabilidade no Pillow',
  detalhe: 'linha 1\nlinha 2', o_que_muda: 'A imagem usa o Pillow 13.', publicado_em: '2026-10-30T20:00:00Z', boletim_em: '2026-10-31T10:00:00Z',
  fonte_url: 'https://github.com/advisories/GHSA-332p-7hrc-92wf', noticia_url: null, pendente: true, dispensado: false, adiado_ate: null,
}, extra || {});

test('abertura: "Nas últimas horas" com menos de 48 h, senão a data em dd/mm/aaaa', () => {
  assert.equal(R.abertura('2026-10-30T20:00:00Z', AGORA), 'Nas últimas horas');
  assert.equal(R.abertura('2026-10-29T13:00:00Z', AGORA), 'Nas últimas horas');
  assert.equal(R.abertura('2026-10-29T11:00:00Z', AGORA), 'Em 29/10/2026');
  assert.equal(R.abertura('2026-10-21T21:28:09Z', AGORA), 'Em 21/10/2026');
});

test('texto principal para atualizar-dgclaw, com a abertura certa', () => {
  assert.equal(R.textoBoletim(bol(), AGORA),
    'Nas últimas horas foi identificada uma vulnerabilidade em uma das ferramentas que o sistema usa: Pillow. A correção já foi publicada pela equipe oficial dela. Para aplicar, basta clicar em Atualizar abaixo, e o seu sistema vai para a versão com essa correção. É muito importante que você atualize.');
  assert.match(R.textoBoletim(bol({ publicado_em: '2026-10-21T21:28:09Z' }), AGORA), /^Em 21\/10\/2026 foi identificada/);
});

test('texto principal para atualizar-sistema troca as duas frases finais', () => {
  const t = R.textoBoletim(bol({ acao: 'atualizar-sistema' }), AGORA);
  assert.match(t, /Para aplicar, clique em Atualizar abaixo e o Admin atualiza os pacotes do servidor com você\. Depois de aplicar, o Admin confirma e o aviso some\.$/);
  assert.doesNotMatch(t, /É muito importante/);
});

test('parar-servico e aguardar: dizem que a correção ainda não saiu', () => {
  for (const acao of ['parar-servico', 'aguardar']) {
    assert.match(R.textoBoletim(bol({ acao }), AGORA), /A correção ainda não saiu\./);
    assert.doesNotMatch(R.textoBoletim(bol({ acao }), AGORA), /clicar em Atualizar/);
  }
});

test('texto do pedido ao Admin, por ação', () => {
  assert.equal(R.textoDoPedidoBoletim(bol()), 'Quero instalar a atualização de segurança do DG Claw (boletim GHSA-332P-7HRC-92WF).');
  assert.equal(R.textoDoPedidoBoletim(bol({ acao: 'atualizar-sistema' })), 'Quero aplicar a atualização de segurança do servidor (boletim GHSA-332P-7HRC-92WF). Depois de aplicar, confirme que o aviso pode sumir.');
});

test('card com correção: fatos, link seguro, detalhe recolhido, Atualizar e Lembrar depois', () => {
  const h = T.cardBoletimHtml(bol({ noticia_url: 'https://blog.exemplo.org/post' }), AGORA);
  assert.match(h, /<h3>Vulnerabilidade no Pillow <span class="rp-tag rp-grav-critical">Crítica<\/span><\/h3>/);
  assert.match(h, /<dt>Publicada em<\/dt><dd>30\/10\/2026<\/dd>/);
  assert.match(h, /<dt>Fonte oficial<\/dt><dd><a href="https:\/\/github\.com\/advisories\/GHSA-332p-7hrc-92wf" target="_blank" rel="noopener noreferrer">/);
  assert.match(h, /<dt>Notícia<\/dt><dd><a href="https:\/\/blog\.exemplo\.org\/post"/);
  assert.match(h, /<dt>O que muda<\/dt><dd>A imagem usa o Pillow 13\.<\/dd>/);
  assert.match(h, /<details class="rp-detalhe"><summary>Ver detalhes<\/summary>/);
  assert.match(h, /data-rp="b-atualizar">Atualizar</);
  assert.match(h, /data-rp="b-lembrar">Lembrar depois</);
  assert.match(h, /data-boletim="1"/);
});

test('sem notícia e sem o_que_muda, essas linhas não aparecem', () => {
  const h = T.cardBoletimHtml(bol({ o_que_muda: '' }), AGORA);
  assert.doesNotMatch(h, /Notícia/);
  assert.doesNotMatch(h, /O que muda/);
});

test('aguardar e parar-servico: só Entendi, e o detalhe fica à vista', () => {
  for (const acao of ['aguardar', 'parar-servico']) {
    const h = T.cardBoletimHtml(bol({ acao }), AGORA);
    assert.doesNotMatch(h, /b-atualizar/);
    assert.match(h, /data-rp="b-entendi">Entendi</);
    assert.match(h, /rp-boletim-detalhe/);
    assert.doesNotMatch(h, /<details/);
  }
});

test('boletim com "lembrar depois" ativo mostra até quando; vencido não mostra', () => {
  assert.match(T.cardBoletimHtml(bol({ adiado_ate: '2026-11-01T10:00:00Z' }), AGORA), /Você pediu para lembrar depois/);
  assert.doesNotMatch(T.cardBoletimHtml(bol({ adiado_ate: '2026-10-30T10:00:00Z' }), AGORA), /lembrar depois \(/);
});

test('lista: pendentes viram cards, mais graves primeiro; dispensados ficam numa linha recolhida; vazio diz que não há aviso', () => {
  const h = T.listaBoletinsHtml([
    bol({ id: 'B-LOW', severidade: 'LOW', titulo: 'Baixo' }), bol({ id: 'B-CRIT', titulo: 'Crítico' }),
    bol({ id: 'B-DISP', titulo: 'Já visto', dispensado: true, acao: 'aguardar' }),
  ], AGORA);
  assert.ok(h.indexOf('Crítico') < h.indexOf('Baixo'));
  assert.equal((h.match(/class="rp-card/g) || []).length, 2);
  assert.match(h, /<summary>Já dispensados \(1\)<\/summary>/);
  assert.match(h, /Já visto/);
  assert.match(T.listaBoletinsHtml([], AGORA), /Nenhum aviso de segurança pendente\./);
  assert.match(T.listaBoletinsHtml(null, AGORA), /Nenhum aviso de segurança pendente\./);
});

test('texto vindo do GitHub sai escapado: <img onerror> nunca vira tag', () => {
  const ruim = '<img src=x onerror=alert(1)>';
  const h = T.cardBoletimHtml(bol({ componente: ruim, titulo: ruim, detalhe: '"><script>alert(2)</script>', o_que_muda: '</dd><svg onload=alert(3)>', id: ruim }), AGORA);
  assert.doesNotMatch(h, /<img/i);
  assert.doesNotMatch(h, /<script/i);
  assert.doesNotMatch(h, /<svg/i);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('link que não é https:// nunca vira <a>, mesmo que a API deixasse passar', () => {
  const h = T.cardBoletimHtml(bol({ fonte_url: 'javascript:alert(1)', noticia_url: 'https://x.org/"onmouseover="alert(1)' }), AGORA);
  assert.doesNotMatch(h, /<a /);
});

test('a seção está na página, tem o ? e o passo do tutorial com o que/como/por quê', () => {
  const html = pub('seguranca.html');
  assert.match(html, /id="secBoletins"/);
  assert.match(html, /id="listaBoletins"/);
  assert.match(html, /data-secao="boletins"/);
  const passos = T.PASSOS.boletins;
  assert.equal(passos[0].alvo, '#secBoletins');
  for (const k of ['titulo', 'oque', 'como', 'porque']) assert.ok(passos[0][k].length > 20, k);
  assert.ok(T.passosPagina(null).some((p) => p.alvo === '#secBoletins'));
});

test('o botão Atualizar da tela reaproveita o atalho do Admin da faixa, e nenhum texto novo tem travessão', () => {
  assert.match(pub('seguranca.js'), /faixa\.instalar\(R\.textoDoPedidoBoletim\(b\)\)/);
  assert.match(pub('atualizacao-faixa.js'), /function instalar\(textoPedido\)/);
  assert.doesNotMatch(T.listaBoletinsHtml([bol(), bol({ id: 'X', acao: 'aguardar' })], AGORA) + JSON.stringify(T.PASSOS.boletins), /[—–]/);
});

test('as janelas antigas não existem mais', () => {
  for (const n of ['seguranca-aviso.js', 'seguranca-aviso.css', 'ronda-aviso.js', 'ronda-aviso.css']) {
    assert.ok(!fs.existsSync(path.join(__dirname, '../public', n)), n);
  }
});
