'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { gravaSemSobrescrever } = require('../lib/uploads');
test('esgotar os nomes disponíveis devolve erro útil sem sobrescrever arquivo', t => {
  let tentativas = 0;
  t.mock.method(fs, 'writeFileSync', (_p, _dados, opcoes) => {
    tentativas++;
    assert.ok(opcoes.flag & fs.constants.O_EXCL);
    throw Object.assign(new Error('fixture: nome ocupado'), { code: 'EEXIST' });
  });
  assert.throws(() => gravaSemSobrescrever('/fixture', 'anexo.txt', Buffer.from('fixture')), /Não achei um nome livre/);
  assert.equal(tentativas, 1000);
});
