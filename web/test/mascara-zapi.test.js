'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mascarar, OCULTO } = require('../lib/mascara');

test('a trilha esconde o valor de ZAPI_INSTANCE, em qualquer forma de atribuição', () => {
  const id = '0123456789ABCDEF0123456789ABCDEF';
  for (const linha of [`ZAPI_INSTANCE=${id}`, `export ZAPI_INSTANCE='${id}'`, `"zapi_instance": "${id}"`]) {
    const r = mascarar(linha);
    assert.ok(!r.includes(id), `vazou em: ${r}`);
    assert.ok(r.includes(OCULTO));
  }
});
