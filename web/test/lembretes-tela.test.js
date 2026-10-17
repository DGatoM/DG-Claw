'use strict';
// Telas dos lembretes: arquivos ligados, menu, service worker e as funções puras da faixa e da página.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/menu-lado');
const Faixa = require('../public/lembretes-faixa');
const Tela = require('../public/lembretes');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

test('o menu lateral tem a entrada ⏰ Lembretes apontando para /lembretes', () => {
  assert.deepEqual(M.LINK_LEMBRETES, { nome: 'Lembretes', ico: '⏰', href: '/lembretes' });
  assert.match(pub('menu-lado.js'), /mlTabs'\)\.insertAdjacentHTML/);
});

test('conversa.html inclui a faixa com uma linha de script e uma de css', () => {
  const h = pub('conversa.html');
  assert.equal(h.split('/lembretes-faixa.js').length - 1, 1);
  assert.equal(h.split('/lembretes.css').length - 1, 1);
  assert.ok(h.indexOf('/tour.js') < h.indexOf('/lembretes-faixa.js'), 'a faixa usa o DGTour');
});

test('sw.js guarda os estáticos dos lembretes e está na v19 ou mais', () => {
  const s = pub('sw.js');
  assert.match(s, /dgclaw-estaticos-v(1[9]|[2-9][0-9])\b/);
  for (const u of ['/lembretes-faixa.js', '/lembretes.js', '/lembretes.css']) assert.ok(s.includes(`'${u}'`), u);
});

test('lembretes.html carrega avisos, tour e a tela, com Tutorial e ? por seção', () => {
  const h = pub('lembretes.html');
  for (const src of ['/avisos-aparelho.js', '/tour.js', '/lembretes.js']) assert.ok(h.includes(`<script src="${src}">`), src);
  assert.ok(h.includes('href="/lembretes.css"'));
  // o Tutorial e o título agora vêm do cabeçalho da casca; a página não tem mais cabeçalho próprio
  assert.match(h, /DGCasca\.monta\(\{ pagina: 'lembretes'/);
  assert.doesNotMatch(h, /lp-voltar|lp-topo/);
  assert.ok(h.indexOf('href="/casca.css"') < h.indexOf('href="/menu-lado.css"'), 'casca.css vem antes do menu-lado.css');
  assert.equal((h.match(/data-ajuda="/g) || []).length, 3);
  assert.match(h, /Ativar avisos neste aparelho/);
  assert.match(h, /Mandar aviso de teste/);
  assert.match(h, /name="viewport"[^>]*width=device-width/);
});

test('faixa: linha com agente, texto, "aviso n de teto" e os botões; HTML do texto é escapado', () => {
  const html = Faixa.linhaHtml({ id: 'oc_1', agente: 'luna', agente_nome: 'Luna', texto: '<b>x</b>', envio: 3, teto: 12 });
  assert.match(html, /<b>Luna<\/b>/);
  assert.match(html, /aviso 3 de 12/);
  assert.match(html, /data-feito="oc_1"/);
  for (const min of [10, 30, 60]) assert.match(html, new RegExp(`data-min="${min}"`));
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.equal(Faixa.rotuloAviso({ teto: 5 }), 'aviso 1 de 5');
  for (const campo of ['oque', 'como', 'porque']) assert.ok(Faixa.PASSO[campo].length > 20, campo);
});

test('página: o formulário vira o corpo certo de cada tipo de regra', () => {
  const base = { texto: ' ligar ', agente: 'luna', intervalo: '5', teto: '12', peloAgente: true };
  assert.deepEqual(Tela.montaCorpo({ ...base, quando: 'daqui', daqui: '20' }).corpo,
    { texto: 'ligar', agente: 'luna', daqui_min: 20, intervalo_min: 5, teto_envios: 12, pelo_agente: true });
  assert.deepEqual(Tela.montaCorpo({ ...base, quando: 'unico', data: '2026-10-20', hora: '14:30' }).corpo.regra,
    { tipo: 'unico', data: '2026-10-20', hora: '14:30' });
  const sem = Tela.montaCorpo({ ...base, quando: 'semanal', dias: ['seg', 'qua'], hora: '09:00', fim: '2026-12-31' }).corpo;
  assert.deepEqual(sem.regra, { tipo: 'semanal', dias: ['seg', 'qua'], hora: '09:00' });
  assert.equal(sem.fim, '2026-12-31');
  assert.deepEqual(Tela.montaCorpo({ ...base, quando: 'a_cada_n_dias', n: '3', inicio: '2026-10-17', hora: '20:00' }).corpo.regra,
    { tipo: 'a_cada_n_dias', n: 3, inicio: '2026-10-17', hora: '20:00' });
  assert.equal(Tela.montaCorpo({ ...base, quando: 'diario', hora: '08:00', peloAgente: false }).corpo.pelo_agente, false);
});

test('página: campos faltando dão a frase do que fazer, nunca um corpo pela metade', () => {
  assert.match(Tela.montaCorpo({ texto: '  ', quando: 'daqui' }).erro, /Escreva o que lembrar/);
  assert.match(Tela.montaCorpo({ texto: 'x', quando: 'daqui', daqui: '0' }).erro, /1 a 10080/);
  assert.match(Tela.montaCorpo({ texto: 'x', quando: 'unico', hora: '08:00' }).erro, /data/);
  assert.match(Tela.montaCorpo({ texto: 'x', quando: 'semanal', hora: '08:00', dias: [] }).erro, /dia da semana/);
  assert.match(Tela.montaCorpo({ texto: 'x', quando: 'diario', hora: '08:00', intervalo: '500' }).erro, /1 a 120/);
});

test('página: cada estado dos avisos no aparelho tem frase e botões, inclusive iPhone sem instalar', () => {
  assert.equal(Tela.fraseAvisos('ativo').desativar, true);
  assert.equal(Tela.fraseAvisos('inativo').ativar, true);
  assert.match(Tela.fraseAvisos('iphone-precisa-instalar').texto, /Adicionar à Tela de Início/);
  assert.equal(Tela.fraseAvisos('iphone-precisa-instalar').ativar, false);
  assert.match(Tela.fraseAvisos('negado').texto, /bloqueou/);
  assert.match(Tela.fraseAvisos('sem-suporte').texto, /não aceita avisos/);
  assert.equal(Tela.fmt('2026-10-20T14:30:00-03:00'), '20/10/2026 14:30');
  assert.equal(Tela.fmt(null), '-');
});
