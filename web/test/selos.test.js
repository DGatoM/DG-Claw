'use strict';
// Selos de atenção na tela: prioridade, texto acessível, ⋯ de "Marcar como não lida" e o que o front manda ao servidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/menu-lado');
const TR = require('../public/trilha-tela');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const ag = (extra) => Object.assign({ id: 'ana', nome: 'Ana' }, extra);

test('seloDe: precisa de você > não lido > marcada > trabalhando; o agente atual e "não medido" ficam sem selo', () => {
  assert.equal(M.seloDe(ag({ estado: 'precisa_de_voce', resumo: 'fez uma pergunta', nao_lidas: 3 }), false).tipo, 'precisa');
  assert.equal(M.seloDe(ag({ estado: 'trabalhando', nao_lidas: 2 }), false).tipo, 'nao_lido');
  assert.equal(M.seloDe(ag({ estado: 'trabalhando', nao_lidas: 0, marcada_nao_lida: true }), false).tipo, 'marcada');
  assert.equal(M.seloDe(ag({ estado: 'trabalhando', nao_lidas: 0 }), false).tipo, 'trabalhando');
  assert.equal(M.seloDe(ag({ estado: 'trabalhando' }), true), null, 'o agente em que a pessoa está não ganha selo');
  assert.equal(M.seloDe(ag({ estado: 'sem_sinal', nao_lidas: null }), false), null, 'sem sinal e null não viram selo nem número');
  assert.equal(M.seloDe(ag({ estado: 'ocioso', nao_lidas: 0 }), false), null);
});

test('itemAgente: selo âmbar com "!", texto acessível e resumo no lugar do subtítulo; sem comando', () => {
  const h = M.itemAgente(ag({ estado: 'precisa_de_voce', resumo: 'pede permissão para rodar Bash', subtitulo: 'vendas' }), 'outro');
  assert.match(h, /<span class="ml-aten" role="img" aria-label="precisa de você: pede permissão para rodar Bash">!<\/span>/);
  assert.match(h, /<small>pede permissão para rodar Bash<\/small>/);
  assert.doesNotMatch(h, /vendas/);
  assert.match(h, /class="ml-ag precisa"/);
});

test('itemAgente: trabalhando = pontinhos com texto acessível; marcada com 0 = ponto; texto do resumo é escapado', () => {
  assert.match(M.itemAgente(ag({ estado: 'trabalhando' }), 'outro'), /class="ml-trab" role="img" aria-label="trabalhando"/);
  const marcada = M.itemAgente(ag({ estado: 'ocioso', nao_lidas: 0, marcada_nao_lida: true }), 'outro');
  assert.match(marcada, /ml-nl ml-nl-ponto" role="img" aria-label="marcada como não lida"/);
  assert.match(marcada, /Desmarcar como não lida/);
  assert.match(marcada, /data-ligar="0"/);
  const xss = M.itemAgente(ag({ estado: 'precisa_de_voce', resumo: '<img src=x onerror=alert(1)>' }), 'outro');
  assert.doesNotMatch(xss, /<img src=x/);
});

test('itemAgente: ⋯ com rótulo e alvo de toque; o agente atual não tem ⋯; ações abertas aparecem sem hidden', () => {
  const h = M.itemAgente(ag(), 'outro');
  assert.match(h, /<button type="button" class="ml-mais" data-mais="ana"[^>]*aria-label="Mais ações de Ana"/);
  assert.match(h, /<div class="ml-acoes" hidden>/);
  assert.match(h, /Marcar como não lida/);
  assert.doesNotMatch(M.itemAgente(ag(), 'ana'), /ml-mais/);
  assert.doesNotMatch(M.itemAgente(ag({ acoes_abertas: true }), 'outro'), /ml-acoes" hidden/);
  const css = pub('menu-lado.css');
  assert.match(css, /\.ml-mais\{[^}]*width:34px;height:34px/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.ml-trab i\{animation:none/);
});

test('totais: marcada conta 1; precisam só conta os outros agentes', () => {
  const lista = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const c = { a: { nao_lidas: 2, estado: 'ocioso' }, b: { nao_lidas: 0, marcada_nao_lida: true, estado: 'precisa_de_voce' }, c: { nao_lidas: null, estado: 'precisa_de_voce' } };
  assert.equal(M.totalNaoLidas(lista, c, 'x'), 3);
  assert.equal(M.totalNaoLidas(lista, c, 'a'), 1);
  assert.equal(M.totalPrecisam(lista, c, 'x'), 2);
  assert.equal(M.totalPrecisam(lista, c, 'b'), 1);
});

test('fila: mensagem enviada com uma pergunta aberta explica a espera sem falar em permissão', () => {
  assert.match(TR.textoFila('pergunta'), /pergunta/);
  assert.doesNotMatch(TR.textoFila('pergunta'), /permissão/);
});

test('tela: manda "abriu" ao abrir a conversa, "vendo" a cada 20 s, DELETE/POST do nao-lido e tem o botão no cabeçalho', () => {
  const js = pub('conversa.js');
  assert.match(js, /api\(API \+ '\/lido', \{ method: 'POST', body: \{ abriu: true \}/);
  assert.match(js, /api\(API \+ '\/vendo', \{ method: 'POST'/);
  assert.match(js, /setInterval\(avisaVendo, 20000\)/);
  assert.match(js, /'\/nao-lido'/);
  assert.match(js, /method: 'DELETE'/);
  assert.match(pub('conversa.html'), /id="btnNaoLida"[^>]*aria-label="Marcar esta conversa como não lida"/);
  assert.match(js, /alvo: '#btnNaoLida'/);
  assert.match(pub('conversa.css'), /prefers-reduced-motion:reduce\)\{\.troca-baixo \.selo-trab\{animation:none/);
});

test('avisos do aparelho: interruptores ligados à API de preferências', () => {
  assert.match(pub('avisos-aparelho.js'), /'\/api\/v1\/push\/preferencias'/);
  const h = pub('lembretes.html');
  assert.match(h, /id="prefPrecisa"/);
  assert.match(h, /id="prefTerminou"/);
});
