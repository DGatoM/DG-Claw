'use strict';
// No modo de tunel o cloudflared chega ao Caddy pelo loopback e o Caddy poe o IP real do visitante
// (Cf-Connecting-IP) no X-Forwarded-For; o painel usa esse IP para contar as tentativas de login.
const test = require('node:test');
const assert = require('node:assert');
const { ipDoPedido } = require('../lib/http');

test('XFF vindo do loopback vira o IP do pedido', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } };
  assert.strictEqual(ipDoPedido(req), '203.0.113.9');
});

test('XFF vindo de fora do loopback e ignorado', () => {
  const req = { socket: { remoteAddress: '198.51.100.4' }, headers: { 'x-forwarded-for': '203.0.113.9' } };
  assert.strictEqual(ipDoPedido(req), '198.51.100.4');
});
