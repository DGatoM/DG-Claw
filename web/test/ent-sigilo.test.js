'use strict';
// Bloco F: com `sigilo_externo` desligado o modo escondido não manda texto para ninguém.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarSigilo } = require('../lib/sigilo');
const { criarProtecoes } = require('../lib/protecoes');
const { externoPermitido, MENSAGEM_BLOQUEIO } = require('../lib/ent/sigilo');
const { pastaTemp, capturaLog } = require('./ajuda');

// Valor de mentira, só para o fetch falso reconhecer o cabeçalho.
const ENV = { ANTHROPIC_API_KEY: 'valor-falso-claude-123456789' };

/** Troca o fetch global por um falso que conta os pedidos e responde no formato da Anthropic. */
function fetchFalso(t) {
  const pedidos = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    pedidos.push({ url: String(url), corpo: init && init.body });
    const corpo = JSON.parse(init.body);
    const itens = JSON.parse(corpo.messages[0].content.split('\n').pop());
    const r = itens.map((x) => ({ i: x.i, s: x.t.includes('Maria Souza') ? ['Maria Souza'] : [] }));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ r }) }] }), { status: 200 });
  };
  t.after(() => { global.fetch = original; });
  return pedidos;
}

function protecoesNoNivel(nivel, ajustes) {
  const dir = pastaTemp('sigilo');
  const caminho = path.join(dir, 'protecoes.json');
  if (nivel) fs.writeFileSync(caminho, JSON.stringify({ versao: 1, nivel, ajustes: ajustes || {}, org_uuid: '', atualizado_em: '2026-01-01T00:00:00Z' }));
  return { dir, caminho, protecoes: criarProtecoes({ caminho, log: () => {} }) };
}

test('nível pessoal: o modelo externo é chamado como sempre', async (t) => {
  const pedidos = fetchFalso(t);
  const { dir, protecoes } = protecoesNoNivel(null);
  const sigilo = criarSigilo({ env: ENV, dataDir: dir, log: () => {}, protecoes });
  const r = await sigilo.analisar(['A Maria Souza ligou']);
  assert.equal(pedidos.length, 1);
  assert.deepEqual(r.trechos, [['Maria Souza']]);
  assert.equal(r.so_regex, false);
  assert.equal(sigilo.estado().so_regex, false);
});

test('sem leitor de proteções (uso antigo) o comportamento é o de sempre', async (t) => {
  const pedidos = fetchFalso(t);
  const sigilo = criarSigilo({ env: ENV, dataDir: pastaTemp('sigilo'), log: () => {} });
  await sigilo.analisar(['A Maria Souza ligou']);
  assert.equal(pedidos.length, 1);
});

for (const nivel of ['escritorio', 'empresa', 'regulado']) {
  test(`nível ${nivel}: nenhum pedido sai, mesmo com chave configurada`, async (t) => {
    const pedidos = fetchFalso(t);
    const { dir, protecoes } = protecoesNoNivel(nivel);
    const sigilo = criarSigilo({ env: ENV, dataDir: dir, log: () => {}, protecoes });
    const r = await sigilo.analisar(['A Maria Souza ligou', 'bom dia']);
    assert.equal(pedidos.length, 0, 'fetch não pode ser chamado');
    assert.deepEqual(r.trechos, [[], []]);
    assert.equal(r.so_regex, true);
    assert.equal(r.modelo, null);
    assert.equal(r.analisados, 0);
    assert.match(r.avisos[0], /modelo rodando neste servidor/);
    const e = sigilo.estado();
    assert.equal(e.so_regex, true);
    assert.equal(e.bloqueado_por, 'sigilo_externo');
    assert.equal(sigilo.soRegex, true);
  });
}

test('mudar o nível sem reiniciar vale na hora (nos dois sentidos)', async (t) => {
  const pedidos = fetchFalso(t);
  const { dir, caminho, protecoes } = protecoesNoNivel('escritorio');
  const sigilo = criarSigilo({ env: ENV, dataDir: dir, log: () => {}, protecoes });
  await sigilo.analisar(['A Maria Souza ligou']);
  assert.equal(pedidos.length, 0);
  // escritório não trava sigilo_externo: o administrador pode liberar de propósito
  fs.writeFileSync(caminho, JSON.stringify({ versao: 1, nivel: 'escritorio', ajustes: { sigilo_externo: true }, org_uuid: '', atualizado_em: '2026-01-02T00:00:00Z' }));
  await sigilo.analisar(['A Maria Souza ligou']);
  assert.equal(pedidos.length, 1);
});

test('regulado trava: o ajuste para liberar é ignorado e nada sai', async (t) => {
  const pedidos = fetchFalso(t);
  const { dir, protecoes } = protecoesNoNivel('regulado', { sigilo_externo: true });
  const sigilo = criarSigilo({ env: ENV, dataDir: dir, log: () => {}, protecoes });
  await sigilo.analisar(['A Maria Souza ligou']);
  assert.equal(pedidos.length, 0);
});

test('proteção ilegível: por segurança nada sai e o log explica', async (t) => {
  const pedidos = fetchFalso(t);
  const cap = capturaLog();
  const quebrado = { valor() { throw new Error('matriz sumiu'); } };
  const sigilo = criarSigilo({ env: ENV, dataDir: pastaTemp('sigilo'), log: cap.log, protecoes: quebrado });
  const r = await sigilo.analisar(['A Maria Souza ligou']);
  assert.equal(pedidos.length, 0);
  assert.equal(r.so_regex, true);
  assert.ok(cap.linhas.some((l) => /matriz sumiu/.test(JSON.stringify(l)) && /nenhum texto sai/.test(JSON.stringify(l))));
});

test('externoPermitido: sem leitor vale sim; mensagem de bloqueio diz o que fazer', () => {
  assert.equal(externoPermitido(undefined), true);
  assert.equal(externoPermitido({ valor: () => true }), true);
  assert.equal(externoPermitido({ valor: () => false }), false);
  assert.match(MENSAGEM_BLOQUEIO, /dgclaw nivel ajustar sigilo_externo true/);
});
