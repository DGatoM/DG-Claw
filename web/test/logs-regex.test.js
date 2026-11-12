'use strict';
// Auditoria de retrocesso: toda regex de logs-leitor.js e logs-rotas.js (listas REGEX_AUDITAVEIS) contra entradas hostis de
// 64 KB, em processo filho com timeout, para uma regex travada falhar o teste em vez de pendurar a suíte.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REGEX_AUDITAVEIS: doLeitor } = require('../lib/logs-leitor');
const { REGEX_AUDITAVEIS: dasRotas } = require('../lib/logs-rotas');

test('toda regex dos módulos de logs fica abaixo de 200 ms em entradas hostis de 64 KB', () => {
  const total = doLeitor.length + dasRotas.length;
  assert.ok(total >= 30, `a lista tem ${total} regex`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'logs-regex-filho.js')], { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  const linhas = (r.stdout || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (r.error || r.status !== 0) {
    const ultima = linhas.filter((l) => l.evento === 'comeco').pop();
    const terminou = linhas.filter((l) => l.evento === 'fim').map((l) => l.nome);
    assert.fail(`o processo filho não terminou (${r.error ? r.error.code : `saída ${r.status}`}); regex em andamento: ${ultima && !terminou.includes(ultima.nome) ? ultima.nome : '(nenhuma)'}\n${(r.stderr || '').slice(0, 500)}`);
  }
  const fins = linhas.filter((l) => l.evento === 'fim');
  assert.equal(fins.length, total, 'todas as regex rodaram');
  for (const f of fins) assert.ok(f.ms < 200, `${f.nome}: ${f.ms} ms em ${f.quem}`);
});

test('a lista cobre as regex de máscara, de nomes de arquivo e das rotas', () => {
  const nomes = [...doLeitor, ...dasRotas].map((x) => x.nome);
  for (const esperado of ['PRE[0]', 'PRE[1]', 'EXTRAS[0]', 'RX_SEQUENCIA_LONGA', 'RX_CLAUDE', 'RX_DIA', 'RX_ROTA_AGENTE', 'RX_PATCH']) assert.ok(nomes.includes(esperado), esperado);
  for (const { rx } of [...doLeitor, ...dasRotas]) assert.ok(rx instanceof RegExp);
});
