'use strict';
// Faixa de integração com defeito: funções puras (fora do DOM) e ligação nas telas.
require('./_ds-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/integracoes-faixa');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const item = (extra) => Object.assign({
  id: 'i1', agente: 'luna', agenteNome: 'Luna', integracao: 'whatsapp', integracaoNome: 'WhatsApp',
  categoria: 'desconectado', categoriaTexto: 'a conexão caiu e precisa ser refeita', abertoEm: '2026-11-17T12:00:00.000Z',
}, extra || {});

test('uma integração: frase por extenso', () => {
  assert.equal(F.textoDaFaixa([item()]), 'A integração WhatsApp do agente Luna está com defeito: a conexão caiu e precisa ser refeita.');
});

test('várias integrações: frase resumida; lista vazia não escreve nada', () => {
  assert.equal(F.textoDaFaixa([item(), item({ id: 'i2', integracao: 'groq' })]), 'Várias integrações estão com defeito.');
  assert.equal(F.textoDaFaixa([]), '');
  assert.equal(F.textoDaFaixa(null), '');
});

test('linha de detalhe de cada incidente', () => {
  assert.equal(F.textoDaLinha(item()), 'WhatsApp (agente Luna): a conexão caiu e precisa ser refeita.');
});

test('agente que não deu para medir: uma linha discreta com o nome e o motivo', () => {
  assert.equal(F.textoNaoMedido({ agente: 'luna', agenteNome: 'Luna', motivo: 'o estado.json está ilegível' }), 'Não consegui medir as integrações de Luna: o estado.json está ilegível');
  assert.equal(F.textoNaoMedido({ agente: 'luna', motivo: 'x' }), 'Não consegui medir as integrações de luna: x');
  const js = pub('integracoes-faixa.js');
  assert.match(js, /pintaNaoMedidos\(estado\);\s*\n\s*if \(!estado/, 'as linhas aparecem mesmo sem incidente: são pintadas antes da saída sem faixa');
  assert.match(js, /el\('p', 'if-nm-linha', textoNaoMedido\(n\)\)/, 'o texto entra por textContent (el)');
});

test('link do painel do agente na aba Integrações; slug fora do formato não gera link', () => {
  assert.equal(F.hrefPainel('luna'), '/p/luna/#aba=integracoes');
  assert.equal(F.hrefPainel('../x'), null);
  assert.equal(F.hrefPainel(null), null);
});

test('o passo do tutorial responde o que é, como calcula e por que está aqui', () => {
  for (const k of ['alvo', 'titulo', 'oque', 'como', 'porque']) assert.ok(F.PASSO[k], k);
  assert.equal(F.PASSO.alvo, '#faixaIntegracoes');
});

test('o código da faixa só escreve dado da API por textContent, sem innerHTML com dado', () => {
  const js = pub('integracoes-faixa.js');
  const usos = js.split('\n').filter((l) => /\.innerHTML/.test(l));
  assert.deepEqual(usos.map((l) => l.trim()), ["ico.innerHTML = dsIcone('alert');   // HTML fixo do próprio sistema de ícones, sem dado da API"]);
  assert.match(js, /raiz\.DGAtualizacaoFaixa\.instalar\(atual\.pedido\)/);
  assert.ok(!/[—–]/.test(js));
});

test('a faixa entra em todas as telas: casca.js, conversa.html, service worker e CSS no ar', () => {
  assert.match(pub('casca.js'), /\/integracoes-faixa\.js/);
  assert.match(pub('conversa.html'), /<script src="\/integracoes-faixa\.js"><\/script>/);
  const sw = pub('sw.js');
  assert.match(sw, /'\/integracoes-faixa\.js'/);
  assert.match(sw, /'\/integracoes-faixa\.css'/);
  const css = pub('integracoes-faixa.css');
  assert.match(css, /\.if\{/);
  assert.match(css, /min-height:32px/);
});
