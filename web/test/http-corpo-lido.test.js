'use strict';
// lerCorpo quando o Web já consumiu o corpo (req.dgCorpoLido): devolve o mesmo Buffer, com o mesmo limite e a mesma revalidação.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const H = require('../lib/http');

/** Pedido sem stream de verdade: se lerCorpo tentasse ler dele, ficaria esperando para sempre. */
function pedido(extra) { return Object.assign(new EventEmitter(), extra); }

test('lerCorpo com req.dgCorpoLido devolve o mesmo Buffer, sem esperar o stream', async () => {
  const buf = Buffer.from('{"provedor":"claude"}');
  const r = await Promise.race([H.lerCorpo(pedido({ dgCorpoLido: buf }), 1024), new Promise((_, rej) => setTimeout(() => rej(new Error('pendurou')), 1000))]);
  assert.equal(r, buf);
  const vazio = await H.lerCorpo(pedido({ dgCorpoLido: Buffer.alloc(0) }), 1024);
  assert.equal(vazio.length, 0);
});

test('lerCorpo com req.dgCorpoLido acima de max rejeita com 413', async () => {
  await assert.rejects(H.lerCorpo(pedido({ dgCorpoLido: Buffer.alloc(100) }), 99), (e) => e.status === 413 && /passou de 99 bytes/.test(e.message));
  assert.equal((await H.lerCorpo(pedido({ dgCorpoLido: Buffer.alloc(99) }), 99)).length, 99, 'no limite exato passa');
});

test('lerCorpo com req.dgCorpoLido e dgRevalidar falso rejeita com 401; verdadeiro passa', async () => {
  const buf = Buffer.from('x');
  await assert.rejects(H.lerCorpo(pedido({ dgCorpoLido: buf, dgRevalidar: () => false }), 1024), (e) => e.status === 401 && /Nada foi feito/.test(e.message));
  await assert.rejects(H.lerCorpo(pedido({ dgCorpoLido: buf, dgRevalidar: () => false, dgRevalidarMsg: 'motivo próprio' }), 1024), (e) => e.status === 401 && e.message === 'motivo próprio');
  assert.equal(await H.lerCorpo(pedido({ dgCorpoLido: buf, dgRevalidar: () => true }), 1024), buf);
});
