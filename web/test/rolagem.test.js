'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/rolagem');

test('estaNoFim: tolerância de 80 px', () => {
  assert.equal(R.estaNoFim(1000, 1800, 800), true);   // colado no fim
  assert.equal(R.estaNoFim(930, 1800, 800), true);    // 70 px acima
  assert.equal(R.estaNoFim(900, 1800, 800), false);   // 100 px acima
  assert.equal(R.estaNoFim(900, 1800, 800, 160), true);
});

test('novaPosicao: quem estava no fim acompanha o fim novo', () => {
  assert.equal(R.novaPosicao({ estavaNoFim: true, scrollTopAgora: 1000, scrollHeight: 2400, clientHeight: 800, alvoAncora: 500 }), 1600);
});

test('novaPosicao: quem rolou para cima fica na âncora, nunca vai ao fim', () => {
  assert.equal(R.novaPosicao({ estavaNoFim: false, scrollTopAgora: 300, scrollHeight: 2400, clientHeight: 800, alvoAncora: 480 }), 480);
});

test('novaPosicao: conteúdo que cresce acima empurra a âncora para baixo e a tela acompanha', () => {
  // antes: âncora no topo de 300 com offset 0; depois de 120 px entrarem acima, o alvo vira 420
  assert.equal(R.novaPosicao({ estavaNoFim: false, scrollTopAgora: 300, scrollHeight: 2520, clientHeight: 800, alvoAncora: 420 }), 420);
});

test('novaPosicao: sem âncora mantém a posição atual, limitada ao possível', () => {
  assert.equal(R.novaPosicao({ estavaNoFim: false, scrollTopAgora: 300, scrollHeight: 2400, clientHeight: 800, alvoAncora: null }), 300);
  assert.equal(R.novaPosicao({ estavaNoFim: false, scrollTopAgora: 5000, scrollHeight: 2400, clientHeight: 800, alvoAncora: null }), 1600);
});

test('novaPosicao: nunca negativa e nunca puxa para cima por causa de re-render', () => {
  assert.equal(R.novaPosicao({ estavaNoFim: false, scrollTopAgora: 0, scrollHeight: 500, clientHeight: 800, alvoAncora: -50 }), 0);
  assert.equal(R.novaPosicao({ estavaNoFim: true, scrollTopAgora: 0, scrollHeight: 500, clientHeight: 800 }), 0);
});

test('primeiroVisivel: busca binária pelo primeiro item com fundo abaixo do topo', () => {
  const fundos = [100, 220, 340, 460, 580];
  const f = i => fundos[i];
  assert.equal(R.primeiroVisivel(5, f, 0), 0);
  assert.equal(R.primeiroVisivel(5, f, 100), 1);
  assert.equal(R.primeiroVisivel(5, f, 339), 2);
  assert.equal(R.primeiroVisivel(5, f, 579), 4);
  assert.equal(R.primeiroVisivel(5, f, 580), -1);
  assert.equal(R.primeiroVisivel(0, f, 0), -1);
});

test('moveuDeVerdade: o eco do scroll que nós fizemos não conta como a pessoa rolar', () => {
  assert.equal(R.moveuDeVerdade(9625, 9625), false);
  assert.equal(R.moveuDeVerdade(9625, 9625.3), false);
  assert.equal(R.moveuDeVerdade(9625, 9100), true);
  assert.equal(R.moveuDeVerdade(0, 40), true);
});
