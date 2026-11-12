'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../public/pedidos');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

test('rótulo do estado cobre os cinco estados e um desconhecido', () => {
  assert.equal(P.rotuloEstado('fazendo').texto, 'fazendo');
  assert.equal(P.rotuloEstado('esperando_dono').texto, 'esperando você');
  assert.equal(P.rotuloEstado('entregue').texto, 'entregue');
  assert.equal(P.rotuloEstado('feito').texto, 'feito ✓');
  assert.equal(P.rotuloEstado('cancelado').texto, 'cancelado');
  assert.equal(P.rotuloEstado('abacaxi').texto, 'abacaxi');
  assert.equal(P.rotuloEstado(undefined).texto, 'sem estado');
});

test('aberto: fazendo, esperando_dono e entregue', () => {
  for (const e of ['fazendo', 'esperando_dono', 'entregue']) assert.equal(P.estaAberto({ estado: e }), true);
  for (const e of ['feito', 'cancelado']) assert.equal(P.estaAberto({ estado: e }), false);
  assert.equal(P.estaAberto(null), false);
});

test('há quanto tempo: agora, minutos, horas, dias; data ruim não vira zero', () => {
  const t0 = Date.parse('2026-11-12T10:00:00-03:00');
  assert.equal(P.haTempo('2026-11-12T10:00:00-03:00', t0 + 20000), 'agora mesmo');
  assert.equal(P.haTempo('2026-11-12T10:00:00-03:00', t0 + 5 * 60000), 'há 5 min');
  assert.equal(P.haTempo('2026-11-12T10:00:00-03:00', t0 + 3 * 3600000), 'há 3 h');
  assert.equal(P.haTempo('2026-11-12T10:00:00-03:00', t0 + 2 * 86400000), 'há 2 d');
  assert.equal(P.haTempo('2026-11-12T10:00:00-03:00', t0 - 60000), 'agora mesmo');
  assert.equal(P.haTempo('lixo'), 'sem registro de horário');
  assert.equal(P.haTempo(null), 'sem registro de horário');
});

test('link da conversa: só /a/<agente> com ?msg=<id de 16 hex>; o resto é recusado', () => {
  assert.equal(P.linkSeguro('/a/luna'), '/a/luna');
  assert.equal(P.linkSeguro('/a/luna?msg=3fa9c01b22d4e7a1'), '/a/luna?msg=3fa9c01b22d4e7a1');
  for (const ruim of ['javascript:alert(1)', '//evil.example/a/x', 'https://evil.example', '/a/luna?msg=zz', '/a/../x', '/a/luna?msg=3fa9c01b22d4e7a1&x=1', '/outra', '', null, undefined, 5]) {
    assert.equal(P.linkSeguro(ruim), null, String(ruim));
  }
});

test('frase de erro usa o erro da API, os campos e, sem nada, o código', () => {
  assert.equal(P.fraseErro({ erro: 'motivo claro' }, 403).texto, 'motivo claro');
  assert.deepEqual(P.fraseErro({ erros: { motivo: 'obrigatório' } }, 400).campos, { motivo: 'obrigatório' });
  assert.match(P.fraseErro({ erros: { motivo: 'x' } }, 400).texto, /campos precisam/);
  assert.match(P.fraseErro(null, 502).texto, /código 502/);
});

test('bolinha acende com item esperando o dono ou entregue; sem contagem, apagada', () => {
  assert.equal(P.bolinhaLigada({ esperando_dono: 1, entregues: 0 }), true);
  assert.equal(P.bolinhaLigada({ esperando_dono: 0, entregues: 2 }), true);
  assert.equal(P.bolinhaLigada({ esperando_dono: 0, entregues: 0, fazendo: 5 }), false);
  assert.equal(P.bolinhaLigada(null), false);
});

test('tutorial: cada passo responde o que é, como eu calculo e por que está aqui', () => {
  const todos = [].concat(P.PASSOS.pagina, P.PASSOS.contagem, P.PASSOS.lista);
  assert.ok(todos.length >= 4);
  for (const p of todos) for (const k of ['alvo', 'titulo', 'oque', 'como', 'porque']) assert.ok(p[k], `${p.titulo || p.alvo}: falta ${k}`);
});

test('XSS: a tela de pedidos não usa innerHTML nem insertAdjacentHTML (tudo entra por textContent)', () => {
  const js = pub('pedidos.js');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('a aba Pedidos é registrada antes do quadro de avisos e depois do mesa.js; o CSS entra na página', () => {
  const h = pub('mesa.html');
  assert.ok(h.indexOf('<script src="/mesa.js">') < h.indexOf('<script src="/pedidos.js">'));
  assert.ok(h.indexOf('<script src="/pedidos.js">') < h.indexOf('<script src="/avisos.js">'));
  assert.match(h, /<link rel="stylesheet" href="\/pedidos\.css">/);
  const mesa = pub('mesa.js');
  assert.match(mesa, /abas\.some\(a => a\.id === 'pedidos'\) \? 'pedidos' : 'tarefas'/);
});

test('o link da fila pula para a mensagem na conversa (?msg=) e o service worker subiu de versão', () => {
  const c = pub('conversa.js');
  assert.match(c, /new URLSearchParams\(location\.search\)\.get\('msg'\)/);
  assert.match(c, /compartilhados\?mensagem=/);
});

test('nenhum travessão nos arquivos da aba', () => {
  for (const f of ['pedidos.js', 'pedidos.css', '../docs/PEDIDOS.md']) assert.doesNotMatch(pub(f), /[—–]/, f);
});

test('o servidor libera a rota para a caixa do agente', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), /caixa\.permitir\('\/api\/v1\/pedidos'\)/);
});
