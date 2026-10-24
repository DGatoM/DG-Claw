'use strict';
// A tela do modo roteiro (public/roteiro.js): só as partes puras, sem DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/roteiro');

const tipos = d => d.map(e => e.tipo);

test('diff: blocos iguais ficam iguais', () => {
  const d = R._diff('Um.\n\nDois.', 'Um.\n\nDois.');
  assert.deepEqual(tipos(d), ['igual', 'igual']);
});

test('diff: bloco novo e bloco que saiu', () => {
  assert.deepEqual(tipos(R._diff('Um.\n\nDois.', 'Um.\n\nDois.\n\nTrês parágrafos novos aqui.')), ['igual', 'igual', 'novo']);
  const d = R._diff('Um.\n\nDois sobrando.\n\nTrês.', 'Um.\n\nTrês.');
  assert.deepEqual(tipos(d), ['igual', 'saiu', 'igual']);
  assert.equal(d[1].texto, 'Dois sobrando.');
});

test('diff: palavra trocada dentro do bloco vira segmentos igual, saiu e entrou', () => {
  const d = R._diff('Intro.\n\nA casa é azul e grande.', 'Intro.\n\nA casa é verde e grande.');
  assert.deepEqual(tipos(d), ['igual', 'mudou']);
  assert.deepEqual(d[1].segmentos, [
    { tipo: 'igual', texto: 'A casa é ' },
    { tipo: 'saiu', texto: 'azul' },
    { tipo: 'entrou', texto: 'verde' },
    { tipo: 'igual', texto: ' e grande.' },
  ]);
  assert.equal(d[1].porBloco, false);
});

test('diff: texto enorme cai para diff só por bloco, sem estourar', () => {
  const grande = (p) => Array.from({ length: 2500 }, (_, i) => (i % 50 === 0 ? p : 'w') + i).join(' ');
  const d = R._diff('Início.\n\n' + grande('a'), 'Início.\n\n' + grande('b'));
  assert.deepEqual(tipos(d), ['igual', 'mudou']);
  assert.equal(d[1].porBloco, true);
  assert.deepEqual(d[1].segmentos.map(s => s.tipo), ['saiu', 'entrou']);
});

test('marcas do realce: mudou, novo e quantos trechos saíram', () => {
  const m = R._marcas(R._diff('Um.\n\nDois sobrando.\n\nTrês casas azuis.', 'Um.\n\nTrês casas verdes.\n\nQuatro novinho em folha.'));
  assert.deepEqual(m.marcas, [null, 'mudou', 'novo']);
  assert.equal(m.saiuAntes[1], 1);
});

test('prefixar: fechado devolve o texto; aberto prefixa; comando de barra nunca', () => {
  R._estado.aberto = false; R._estado.id = null;
  assert.equal(R.prefixar('corta o gancho'), 'corta o gancho');
  assert.equal(R.ativo(), false);
  R._estado.aberto = true; R._estado.id = 'dgs-china';
  assert.equal(R.ativo(), true);
  assert.equal(R.prefixar('corta o gancho'), '[roteiro dgs-china] corta o gancho');
  assert.equal(R.prefixar('/compact'), '/compact');
  assert.ok(R._estado.pedido, 'marca o pedido enviado, esperando o agente');
  R._estado.aberto = false; R._estado.id = null; R._estado.pedido = null;
});

test('markdown: HTML vira texto, nunca elemento', () => {
  const blocos = R._md('# Título\n\n<img src=x onerror=alert(1)> e **negrito** com *itálico*\n\n- um\n- <b>dois</b>\n\n> citação\n\n---');
  const json = JSON.stringify(blocos);
  // o único nó "b" é o do negrito de markdown; a tag <b> literal ficou como texto
  const p = blocos[1].nos[0].filhos;
  assert.equal(p[0].t, 'txt');
  assert.equal(p[0].v, '<img src=x onerror=alert(1)> e ');
  assert.equal(p[1].t, 'b');
  assert.equal(p[1].filhos[0].v, 'negrito');
  assert.equal(p[3].t, 'i');
  const itens = blocos[2].nos[0].itens;
  assert.equal(blocos[2].nos[0].t, 'ul');
  assert.equal(itens[1][0].v, '<b>dois</b>');
  assert.equal(blocos[0].nos[0].t, 'h');
  assert.equal(blocos[3].nos[0].t, 'cit');
  assert.equal(blocos[4].nos[0].t, 'hr');
  assert.ok(json.includes('onerror'), 'o texto fica, como texto');
});

test('blocos: guardam a posição para trocar um bloco só', () => {
  const t = 'Um.\n\nDois\ncom quebra.\n\n\nTrês.';
  const b = R._blocos(t);
  assert.equal(b.length, 3);
  assert.equal(b[1].md, 'Dois\ncom quebra.');
  assert.equal(t.slice(0, b[1].ini) + 'NOVO' + t.slice(b[1].fim), 'Um.\n\nNOVO\n\n\nTrês.');
});

test('lista do seletor: busca sem acento e sem caixa, mais recente em cima', () => {
  const itens = [
    { titulo: 'China demite com IA', atualizado_em: '2026-10-22T10:00:00Z' },
    { titulo: 'Inflação em março', atualizado_em: '2026-10-23T10:00:00Z' },
    { titulo: 'Aula de Inflacao', atualizado_em: '2026-10-21T10:00:00Z' },
  ];
  assert.deepEqual(R._filtrar(itens, 'INFLAÇÃO').map(i => i.titulo), ['Inflação em março', 'Aula de Inflacao']);
  assert.equal(R._filtrar(itens, '')[0].titulo, 'Inflação em março');
});

test('há quanto tempo', () => {
  const agora = Date.parse('2026-10-23T12:00:00Z');
  assert.equal(R._haQuando('2026-10-23T11:57:00Z', agora), 'há 3 min');
  assert.equal(R._haQuando('2026-10-23T09:00:00Z', agora), 'há 3 h');
  assert.equal(R._haQuando('2026-10-21T12:00:00Z', agora), 'há 2 dias');
});

test('o módulo não toca no DOM ao carregar e a conversa tem a ponte', () => {
  const fs = require('node:fs'), path = require('node:path');
  const pub = n => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
  assert.match(pub('conversa.html'), /\/roteiro\.css/);
  assert.match(pub('conversa.html'), /\/roteiro\.js/);
  assert.match(pub('conversa.js'), /DGRoteiro\.prefixar\(t\)/);
  assert.match(pub('conversa.js'), /DGRoteiro\.respostaDoAgente/);
  assert.match(pub('sw.js'), /\/roteiro\.js/);
  const texto = pub('roteiro.js') + pub('roteiro.css');
  assert.ok(!/[—–]/.test(texto), 'travessão dentro do módulo');
  assert.ok(!/innerHTML/.test(pub('roteiro.js').replace(/\/\*[\s\S]*?\*\//g, '')), 'innerHTML no roteiro.js');
});
