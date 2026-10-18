'use strict';
// Tela Aprovações: funções puras, arquivos ligados, tutorial em cada seção e o atalho do menu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../public/aprovacoes');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const pedido = (extra) => Object.assign({
  id: 'a'.repeat(24), tipo: 'controle', op: 'agente.remover', descricao: 'Remover o agente `ana`. A casa dele vai para aposentados.',
  estado: 'pendente', pedido_por: 'agente:admin', pedido_em: '2026-10-18T12:00:00Z', expira_em: '2026-10-19T12:00:00Z',
  params: { agente: 'ana' }, decidido_por: null, decidido_em: null, resultado: null,
}, extra || {});

test('pedido pendente: frase com destaque, quem pediu, parâmetros estruturados e os botões', () => {
  const h = P.htmlPedido(pedido());
  assert.match(h, /Remover o agente <code>ana<\/code>/);
  assert.match(h, /Pedido por agente:admin/);
  assert.match(h, /<dt>agente<\/dt><dd>ana<\/dd>/);
  assert.match(h, /data-ap-acao="aprovar"/);
  assert.match(h, /data-ap-acao="recusar"/);
  assert.match(h, /data-ap-codigo/);
  assert.match(h, /esperando você/);
});

test('tudo que vem do servidor é escapado, inclusive a frase e os parâmetros', () => {
  const h = P.htmlPedido(pedido({ descricao: 'Remover <img src=x onerror=alert(1)>', params: { agente: '<script>x</script>' }, pedido_por: '"><b>' }));
  assert.ok(!h.includes('<img'), h);
  assert.ok(!h.includes('<script>'));
  assert.ok(!h.includes('"><b>'));
  assert.match(h, /&lt;img/);
});

test('pedido decidido não tem botões; mostra quem decidiu e o resultado ou o erro', () => {
  const feito = P.htmlPedido(pedido({ estado: 'executada', decidido_por: 'dono', decidido_em: '2026-10-18T12:05:00Z', resultado: { tarefa: 'abc' } }));
  assert.ok(!feito.includes('data-ap-acao'));
  assert.match(feito, /Decidido por dono/);
  assert.match(feito, /feita/);
  assert.match(feito, /Tarefa abc/);
  const falhou = P.htmlPedido(pedido({ estado: 'falhou', resultado: { erro: 'o comando caiu' } }));
  assert.match(falhou, /falhou/);
  assert.match(falhou, /o comando caiu/);
});

test('corpo: separa o que espera você do histórico e explica quando está vazio', () => {
  const h = P.htmlCorpo({ aprovacoes: [pedido(), pedido({ id: 'b'.repeat(24), estado: 'recusada' })] });
  assert.match(h, /Esperando você/);
  assert.match(h, /Já decididos/);
  assert.equal((h.match(/class="ap-item/g) || []).length, 2);
  assert.match(P.htmlCorpo({ aprovacoes: [] }), /Nenhum pedido esperando/);
});

test('tutorial: cada seção tem o que é, como funciona e por que está aqui; a página inteira junta os passos', () => {
  for (const [nome, passos] of Object.entries(P.PASSOS)) {
    assert.ok(passos.length >= 1, nome);
    for (const p of passos) for (const campo of ['alvo', 'titulo', 'oque', 'como', 'porque']) assert.ok(p[campo] && p[campo].length > 10, `${nome}.${campo}`);
  }
  const html = P.htmlCorpo({ aprovacoes: [] });
  assert.match(html, /data-ap-tutorial="pendentes"/);
  assert.match(html, /data-ap-tutorial="historico"/);
  assert.match(html, /data-ap-tour="pendentes"/);
  assert.match(html, /data-ap-tour="historico"/);
});

test('arquivos ligados: a página carrega tour, casca e o script; o menu carrega o atalho; sem travessão em texto', () => {
  const html = pub('aprovacoes.html');
  for (const s of ['/tour.js', '/menu-lado.js', '/casca.js', '/aprovacoes.js', '/aprovacoes.css']) assert.ok(html.includes(s), s);
  assert.match(html, /data-ap-tutorial="pagina"/);
  assert.match(pub('menu-lado.js'), /\/ent-controle\.js/);
  assert.match(pub('ent-controle.js'), /\/api\/v1\/aprovacoes\/resumo/);
  assert.match(pub('ent-controle.js'), /\/api\/v1\/controle\/manutencao/);
  const css = pub('aprovacoes.css');
  assert.match(css, /overflow-wrap:anywhere/, 'sem rolagem horizontal');
  assert.match(css, /min-height:36px/, 'alvo de toque');
  for (const n of ['aprovacoes.js', 'aprovacoes.html', 'ent-controle.js']) assert.ok(!/[—–]/.test(pub(n)), `${n} sem travessão`);
});
