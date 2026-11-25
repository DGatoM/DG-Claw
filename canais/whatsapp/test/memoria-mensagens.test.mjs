import test from 'node:test';
import assert from 'node:assert/strict';
import { criarMemoriaMensagens } from '../lib/memoria-mensagens.mjs';

const J1 = '5511987654321@s.whatsapp.net';
const J2 = '5521999998888@s.whatsapp.net';

test('memoria: ignora vazio e transforma quebras de linha em espaço', () => {
  const m = criarMemoriaMensagens();
  m.lembrar(J1, '', 'x');
  m.lembrar(J1, 'A', '');
  m.lembrar(J1, 'B', '  \n ');
  m.lembrar(J1, 'C', 'linha 1\nlinha 2\r\n\r\nlinha 3');
  assert.equal(m.trecho(J1, 'A'), null);
  assert.equal(m.trecho(J1, 'B'), null);
  assert.equal(m.trecho(J1, 'C'), 'linha 1 linha 2 linha 3');
});

test('memoria: corta em 200 caracteres com reticências', () => {
  const m = criarMemoriaMensagens();
  m.lembrar(J1, 'A', 'y'.repeat(200));
  m.lembrar(J1, 'B', 'y'.repeat(201));
  assert.equal(m.trecho(J1, 'A'), 'y'.repeat(200));
  assert.equal(m.trecho(J1, 'B'), 'y'.repeat(200) + '…');
});

test('memoria: passando do teto, o mais antigo sai', () => {
  const m = criarMemoriaMensagens({ teto: 3 });
  for (const id of ['1', '2', '3', '4']) m.lembrar(J1, id, 't' + id);
  assert.equal(m.trecho(J1, '1'), null);
  assert.equal(m.trecho(J1, '4'), 't4');
});

test('memoria: o mesmo id em outra conversa e outra entrada; esquecer e esquecerConversa tem escopo', () => {
  const m = criarMemoriaMensagens();
  m.lembrar(J1, 'X', 'um');
  m.lembrar(J2, 'X', 'dois');
  assert.equal(m.trecho(J1, 'X'), 'um');
  m.esquecer(J2, 'X');
  assert.equal(m.trecho(J2, 'X'), null);
  assert.equal(m.trecho(J1, 'X'), 'um');
  m.lembrar(J2, 'X', 'dois');
  m.esquecerConversa(J1);
  assert.equal(m.trecho(J1, 'X'), null);
  assert.equal(m.trecho(J2, 'X'), 'dois');
});

test('memoria: 200 mil espacos seguidos de texto processa rapido', () => {
  const m = criarMemoriaMensagens();
  const t0 = Date.now();
  m.lembrar(J1, 'X', ' '.repeat(200000) + 'texto');
  m.lembrar(J1, 'Y', 'a' + ' '.repeat(200000) + 'texto');
  assert.ok(Date.now() - t0 < 200);
  assert.equal(m.trecho(J1, 'X'), 'texto');
  assert.ok(m.trecho(J1, 'Y').endsWith('…'));
});
