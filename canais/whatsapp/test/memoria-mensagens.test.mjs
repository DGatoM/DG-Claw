import test from 'node:test';
import assert from 'node:assert/strict';
import { criarMemoriaMensagens } from '../lib/memoria-mensagens.mjs';

test('memoria: ignora id ou texto vazio e transforma quebras de linha em espaço', () => {
  const m = criarMemoriaMensagens();
  m.lembrar('', 'x', 'N');
  m.lembrar('A', '', 'N');
  m.lembrar('B', '  \n ', 'N');
  m.lembrar('C', 'linha 1\nlinha 2\r\n\r\nlinha 3', 'N');
  assert.equal(m.trecho('A', 'N'), null);
  assert.equal(m.trecho('B', 'N'), null);
  assert.equal(m.trecho('C', 'N'), 'linha 1 linha 2 linha 3');
});

test('memoria: corta em 200 caracteres com reticências', () => {
  const m = criarMemoriaMensagens();
  m.lembrar('A', 'y'.repeat(200), 'N');
  m.lembrar('B', 'y'.repeat(201), 'N');
  assert.equal(m.trecho('A', 'N'), 'y'.repeat(200));
  assert.equal(m.trecho('B', 'N'), 'y'.repeat(200) + '…');
});

test('memoria: passando do teto, o mais antigo sai', () => {
  const m = criarMemoriaMensagens({ teto: 3 });
  for (const id of ['1', '2', '3', '4']) m.lembrar(id, 't' + id, 'N');
  assert.equal(m.trecho('1', 'N'), null);
  assert.equal(m.trecho('2', 'N'), 't2');
  assert.equal(m.trecho('4', 'N'), 't4');
});

test('memoria: outro numero nao enxerga o trecho', () => {
  const m = criarMemoriaMensagens();
  m.lembrar('A', 'segredo', 'N1');
  assert.equal(m.trecho('A', 'N2'), null);
  assert.equal(m.trecho('A', 'N1'), 'segredo');
});
