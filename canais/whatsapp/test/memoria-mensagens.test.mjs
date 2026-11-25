import test from 'node:test';
import assert from 'node:assert/strict';
import { criarMemoriaMensagens } from '../lib/memoria-mensagens.mjs';

test('memoria: ignora id ou texto vazio e transforma quebras de linha em espaço', () => {
  const m = criarMemoriaMensagens();
  m.lembrar('', 'x', '+5511987654321', 'recebida');
  m.lembrar('A', '', '+5511987654321', 'recebida');
  m.lembrar('B', '  \n ', '+5511987654321', 'recebida');
  m.lembrar('C', 'linha 1\nlinha 2\r\n\r\nlinha 3', '+5511987654321', 'recebida');
  assert.equal(m.trecho('A', '+5511987654321', 'recebida'), null);
  assert.equal(m.trecho('B', '+5511987654321', 'recebida'), null);
  assert.equal(m.trecho('C', '+5511987654321', 'recebida'), 'linha 1 linha 2 linha 3');
});

test('memoria: corta em 200 caracteres com reticências', () => {
  const m = criarMemoriaMensagens();
  m.lembrar('A', 'y'.repeat(200), '+5511987654321', 'recebida');
  m.lembrar('B', 'y'.repeat(201), '+5511987654321', 'recebida');
  assert.equal(m.trecho('A', '+5511987654321', 'recebida'), 'y'.repeat(200));
  assert.equal(m.trecho('B', '+5511987654321', 'recebida'), 'y'.repeat(200) + '…');
});

test('memoria: passando do teto, o mais antigo sai', () => {
  const m = criarMemoriaMensagens({ teto: 3 });
  for (const id of ['1', '2', '3', '4']) m.lembrar(id, 't' + id, '+5511987654321', 'recebida');
  assert.equal(m.trecho('1', '+5511987654321', 'recebida'), null);
  assert.equal(m.trecho('2', '+5511987654321', 'recebida'), 't2');
  assert.equal(m.trecho('4', '+5511987654321', 'recebida'), 't4');
});

test('memoria: outro numero nao enxerga o trecho', () => {
  const m = criarMemoriaMensagens();
  m.lembrar('A', 'segredo', '+5511987654321', 'recebida');
  assert.equal(m.trecho('A', '+5521999998888', 'recebida'), null);
  assert.equal(m.trecho('A', '+5511987654321', 'recebida'), 'segredo');
});

test('memoria: mesma id em direcoes diferentes nao troca os textos', () => {
  const m = criarMemoriaMensagens();
  m.lembrar('X', 'do contato', '+5511987654321', 'recebida');
  m.lembrar('X', 'do agente', '+5511987654321', 'enviada');
  assert.equal(m.trecho('X', '+5511987654321', 'recebida'), 'do contato');
  assert.equal(m.trecho('X', '+5511987654321', 'enviada'), 'do agente');
});

test('memoria: com e sem o nono digito e a mesma conversa', () => {
  const m = criarMemoriaMensagens();
  m.lembrar('X', 'oi', '+5511987654321', 'enviada');
  assert.equal(m.trecho('X', '+551187654321', 'enviada'), 'oi');
});

test('memoria: 200 mil espacos seguidos de texto processa rapido', () => {
  const m = criarMemoriaMensagens();
  const t0 = Date.now();
  m.lembrar('X', ' '.repeat(200000) + 'texto', '+5511987654321', 'recebida');
  m.lembrar('Y', 'a' + ' '.repeat(200000) + 'texto', '+5511987654321', 'recebida');
  assert.ok(Date.now() - t0 < 200);
  assert.equal(m.trecho('X', '+5511987654321', 'recebida'), 'texto');
  assert.ok(m.trecho('Y', '+5511987654321', 'recebida').endsWith('…'));
});
