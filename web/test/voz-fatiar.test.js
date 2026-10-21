'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criarVoz, limparParaTts, fatiarParaTts, TTS_MAX_CHARS, TTS_PRIMEIRO_CHARS, TTS_MAX_PARTES } = require('../lib/voz');

const normaliza = (t) => t.split(/\s+/).filter(Boolean).join(' ');
const vozComChave = () => criarVoz({ env: { ELEVENLABS_API_KEY: 'chave-falsa', ELEVENLABS_VOICE_ID: 'abcdefghij12' }, log: () => {} });

test('fatiar: texto curto é um pedaço só', () => {
  assert.deepEqual(fatiarParaTts('Oi, Danilo. Tudo certo.'), ['Oi, Danilo. Tudo certo.']);
});

test('fatiar: ~4000 caracteres viram vários pedaços, o 1º até 450, os outros até 1200, sem perder nada', () => {
  const paragrafo = 'Esta é uma frase de teste com tamanho razoável para a voz. '.repeat(6).trim();
  const texto = Array(12).fill(paragrafo).join('\n\n');
  assert.ok(texto.length > 4000);
  const pedacos = fatiarParaTts(texto);
  assert.ok(pedacos.length > 3);
  assert.ok(pedacos[0].length <= TTS_PRIMEIRO_CHARS);
  for (const p of pedacos) assert.ok(p.length <= TTS_MAX_CHARS);
  assert.equal(normaliza(pedacos.join(' ')), normaliza(texto));
});

test('fatiar: parágrafos curtos se juntam e a quebra cai entre frases', () => {
  const texto = ['Primeiro parágrafo curto.', 'Segundo parágrafo curto.', `${'Terceiro com muitas palavras. '.repeat(30).trim()}`].join('\n\n');
  const pedacos = fatiarParaTts(texto);
  assert.ok(pedacos[0].startsWith('Primeiro parágrafo curto.'));
  assert.ok(pedacos[0].includes('Segundo parágrafo curto.'), 'cabe junto no 1º pedaço');
  for (const p of pedacos) assert.ok(/[.!?…]$/.test(p), `pedaço termina em fim de frase: ${p.slice(-20)}`);
});

test('fatiar: frase gigante sem pontuação quebra no espaço, sem cortar palavra', () => {
  const texto = 'palavra '.repeat(400).trim();
  const pedacos = fatiarParaTts(texto);
  assert.ok(pedacos.length > 2);
  assert.ok(pedacos[0].length <= TTS_PRIMEIRO_CHARS);
  for (const p of pedacos) {
    assert.ok(p.length <= TTS_MAX_CHARS);
    assert.ok(p.startsWith('palavra') && p.endsWith('palavra'));
  }
  assert.equal(normaliza(pedacos.join(' ')), texto);
});

test('fatiar: sem espaço nenhum ainda respeita o limite e não perde letra', () => {
  const pedacos = fatiarParaTts('x'.repeat(3000));
  assert.ok(pedacos[0].length <= TTS_PRIMEIRO_CHARS);
  assert.ok(pedacos.every((p) => p.length <= TTS_MAX_CHARS));
  assert.equal(pedacos.join(''), 'x'.repeat(3000));
});

test('fatiar: é determinístico', () => {
  const t = 'Frase um. '.repeat(200);
  assert.deepEqual(fatiarParaTts(t), fatiarParaTts(t));
});

test('limpar: tabela, código e link não viram fala e os parágrafos sobrevivem', () => {
  const t = limparParaTts('Veja https://exemplo.com/muito/longo\n\n```\nprint(1)\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n\nFim.');
  assert.ok(!t.includes('http') && !t.includes('print') && !t.includes('|'));
  assert.ok(t.includes('Fim.'));
  assert.ok(t.includes('\n\n'), 'a quebra de parágrafo continua até o fatiamento');
});

test('falar: texto que rende mais de 40 pedaços dá 413 explicando', async () => {
  const gigante = Array(60).fill('Uma frase longa o bastante para encher o pedaço. '.repeat(25).trim()).join('\n\n');
  assert.ok(fatiarParaTts(limparParaTts(gigante)).length > TTS_MAX_PARTES);
  const r = await vozComChave().falar({ slug: 'ana' }, gigante, null, 0);
  assert.equal(r.status, 413);
  assert.match(r.erro, new RegExp(`limite é ${TTS_MAX_PARTES}`));
});

test('falar: parte fora do intervalo dá 400 dizendo quantas partes existem', async () => {
  const r = await vozComChave().falar({ slug: 'ana' }, 'Oi.', null, 5);
  assert.equal(r.status, 400);
  assert.match(r.erro, /0 a 0/);
});

test('falar: devolve só o pedaço pedido, com partes e parte, e sem cortado', async () => {
  const original = global.fetch;
  const enviados = [];
  global.fetch = async (url, init) => { enviados.push(JSON.parse(init.body).text); return new Response(Buffer.from('mp3'), { status: 200 }); };
  try {
    const texto = Array(10).fill('Uma frase longa o bastante para encher o pedaço. '.repeat(10).trim()).join('\n\n');
    const esperado = fatiarParaTts(limparParaTts(texto));
    assert.ok(esperado.length > 1);
    const r = await vozComChave().falar({ slug: 'ana' }, texto, null, 1);
    assert.equal(r.partes, esperado.length);
    assert.equal(r.parte, 1);
    assert.equal(r.chars, esperado[1].length);
    assert.equal(r.cortado, undefined);
    assert.deepEqual(enviados, [esperado[1]]);
    const r0 = await vozComChave().falar({ slug: 'ana' }, texto, null);
    assert.equal(r0.parte, 0, 'sem parte vale a primeira');
  } finally { global.fetch = original; }
});
