'use strict';
// TOTP (RFC 6238) sem dependência: vetores do RFC, base32, janela de ±1 passo e proteção contra reuso.
const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../lib/totp');

// Apêndice B do RFC 6238: segredo ASCII "12345678901234567890", SHA1, 8 dígitos.
const SEGREDO_RFC = totp.base32Codifica(Buffer.from('12345678901234567890'));
const VETORES = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];

test('vetores do RFC 6238 (SHA1, 8 dígitos)', () => {
  for (const [segundos, esperado] of VETORES) assert.equal(totp.codigoEm(SEGREDO_RFC, segundos * 1000, 8), esperado, `t=${segundos}`);
});

test('com 6 dígitos o código é o final do de 8', () => {
  for (const [segundos, esperado] of VETORES) assert.equal(totp.codigoEm(SEGREDO_RFC, segundos * 1000), esperado.slice(-6));
});

test('base32: ida e volta, minúsculas, espaços e traços; caractere fora do alfabeto avisa qual', () => {
  const b = Buffer.from('segredo de teste 123');
  assert.deepEqual(totp.base32Decodifica(totp.base32Codifica(b)), b);
  assert.deepEqual(totp.base32Decodifica(totp.base32Codifica(b).toLowerCase().replace(/(.{4})/g, '$1 ')), b);
  assert.throws(() => totp.base32Decodifica('ABC1'), /caractere "1"/);
});

test('segredo novo: 20 bytes em base32 (32 caracteres), diferente a cada vez', () => {
  const a = totp.gerarSegredo(); const b = totp.gerarSegredo();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.equal(totp.base32Decodifica(a).length, 20);
  assert.notEqual(a, b);
});

test('verificar: janela de ±1 passo, formato e código errado', () => {
  const t0 = 1700000000000;
  const certo = totp.codigoEm(SEGREDO_RFC, t0);
  assert.deepEqual(totp.verificar(SEGREDO_RFC, certo, { agora: t0 }), { ok: true, passo: totp.passoDe(t0) });
  assert.equal(totp.verificar(SEGREDO_RFC, certo, { agora: t0 + 30000 }).ok, true, 'um passo depois ainda vale');
  assert.equal(totp.verificar(SEGREDO_RFC, certo, { agora: t0 - 30000 }).ok, true, 'um passo antes ainda vale');
  assert.deepEqual(totp.verificar(SEGREDO_RFC, certo, { agora: t0 + 90000 }), { ok: false, motivo: 'errado' });
  assert.deepEqual(totp.verificar(SEGREDO_RFC, '12345', { agora: t0 }), { ok: false, motivo: 'formato' });
  assert.deepEqual(totp.verificar(SEGREDO_RFC, 'abcdef', { agora: t0 }), { ok: false, motivo: 'formato' });
  assert.equal(totp.verificar(SEGREDO_RFC, ` ${certo.slice(0, 3)} ${certo.slice(3)} `, { agora: t0 }).ok, true, 'espaços são ignorados');
});

test('reuso: o mesmo código (mesmo passo) não vale duas vezes, o passo seguinte vale', () => {
  const t0 = 1700000000000;
  const r1 = totp.verificar(SEGREDO_RFC, totp.codigoEm(SEGREDO_RFC, t0), { agora: t0 });
  assert.equal(r1.ok, true);
  assert.deepEqual(totp.verificar(SEGREDO_RFC, totp.codigoEm(SEGREDO_RFC, t0), { agora: t0, depoisDoPasso: r1.passo }), { ok: false, motivo: 'reuso' });
  const prox = totp.verificar(SEGREDO_RFC, totp.codigoEm(SEGREDO_RFC, t0 + 30000), { agora: t0 + 30000, depoisDoPasso: r1.passo });
  assert.equal(prox.ok, true);
  assert.equal(prox.passo, r1.passo + 1);
});

test('otpauth: endereço no formato que os aplicativos leem, com o nome escapado', () => {
  const u = totp.otpauth({ segredo: 'ABCDEFGH', conta: 'ana@empresa.com', emissor: 'DG Claw (x.com)' });
  assert.equal(u, 'otpauth://totp/DG%20Claw%20(x.com):ana%40empresa.com?secret=ABCDEFGH&issuer=DG%20Claw%20(x.com)&algorithm=SHA1&digits=6&period=30');
  assert.equal(totp.agrupa('ABCDEFGHIJKL'), 'ABCD EFGH IJKL');
});
