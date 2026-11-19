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

test('atribuição vazia não expõe o segredo da atribuição seguinte (mesma linha ou linha de baixo)', () => {
  const { descreveUso } = require('../lib/trilha');
  const segredo = 'token-ficticio';
  for (const command of [`ZAPI_INSTANCE=\nZAPI_TOKEN="${segredo}"`, `ZAPI_INSTANCE= ZAPI_TOKEN="${segredo}"`, `ZAPI_INSTANCE=\nZAPI_TOKEN=${segredo}`]) {
    const uso = descreveUso('Bash', { command });
    assert.ok(!uso.titulo.includes(segredo), `vazou no título: ${uso.titulo}`);
    assert.ok(!uso.comando.includes(segredo), `vazou no comando: ${uso.comando}`);
  }
});
