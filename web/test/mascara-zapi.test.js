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

test('a máscara mantém o que a base já escondia e não esconde o segundo comando', () => {
  const { descreveUso } = require('../lib/trilha');
  const senha = 'amostra-local';
  for (const description of [`{"credentials": {"password": "${senha}"}}`, `{\n  "password":\n    "${senha}"\n}`]) {
    const uso = descreveUso('Bash', { command: 'true', description });
    assert.ok(!uso.titulo.includes(senha), `vazou no título: ${uso.titulo}`);
  }
  const uso = descreveUso('Bash', { command: `echo "token=a" && rm -rf "pasta"` });
  assert.ok(uso.comando.includes('&& rm -rf'), `o segundo comando sumiu: ${uso.comando}`);
  assert.ok(uso.titulo.includes('&& rm -rf'), `o segundo comando sumiu do título: ${uso.titulo}`);
});

test('valor com : ou = depois de espaço continua escondido (YAML, base64)', () => {
  for (const [linha, segredo] of [['token: abc:def', 'abc:def'], ['token: dGVzdA==', 'dGVzdA'], ['password: dGVzdA=', 'dGVzdA'], ['TOKEN=abc==', 'abc']]) {
    const r = mascarar(linha);
    assert.ok(!r.includes(segredo), `vazou em: ${r}`);
  }
  const yaml = mascarar('zapi_instance:\nzapi_token: segredo-yaml');
  assert.ok(!yaml.includes('segredo-yaml'), `vazou em: ${yaml}`);
});
