'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarEnterprise } = require('../lib/ent');
const { pastaTemp, capturaLog, subirWeb } = require('./ajuda');

/** Uma pasta de módulos de mentira: { 'a.js': 'código do módulo' }. */
function pastaDe(modulos) {
  const dir = pastaTemp('ent');
  for (const [nome, codigo] of Object.entries(modulos)) fs.writeFileSync(path.join(dir, nome), codigo);
  return dir;
}
const modulo = (corpo) => `'use strict'; module.exports = ${corpo};`;

test('sem nenhum módulo: antes não responde e todo mundo vê todo agente', async () => {
  const { log } = capturaLog();
  const ent = criarEnterprise({ log }, { pasta: pastaDe({}) });
  assert.deepEqual(ent.modulos, []);
  assert.equal(await ent.antes({}, {}, new URL('http://x/'), null), false);
  assert.equal(ent.podeVerAgente({ usuario: 'a' }, 'luna'), true);
});

test('antes roda na ordem (ordem, depois nome) e para no primeiro que responde', async () => {
  const chamadas = [];
  global.__ent_teste = chamadas;
  const dir = pastaDe({
    'c.js': modulo(`{ nome: 'c', ordem: 10, criar: () => ({ antes: () => { global.__ent_teste.push('c'); return false; } }) }`),
    'a.js': modulo(`{ nome: 'a', criar: () => ({ antes: () => { global.__ent_teste.push('a'); return false; } }) }`),
    'b.js': modulo(`{ nome: 'b', ordem: 10, criar: () => ({ antes: async () => { global.__ent_teste.push('b'); return true; } }) }`),
    'd.js': modulo(`{ nome: 'd', ordem: 200, criar: () => ({ antes: () => { global.__ent_teste.push('d'); return false; } }) }`),
  });
  const ent = criarEnterprise({ log: () => {} }, { pasta: dir });
  assert.deepEqual(ent.modulos, ['b', 'c', 'a', 'd'], 'ordem 10 (b, c por nome), depois 100 (a), depois 200 (d)');
  assert.equal(await ent.antes({}, {}, new URL('http://x/'), null), true);
  assert.deepEqual(chamadas, ['b'], 'b respondeu primeiro e os outros não rodaram');
  delete global.__ent_teste;
});

test('antes recebe req, res, url e sessao', async () => {
  const dir = pastaDe({ 'a.js': modulo(`{ nome: 'a', criar: (ctx) => ({ antes: (req, res, url, sessao) => { ctx.visto = { req, res, url, sessao }; return false; } }) }`) });
  const ctx = { log: () => {} };
  const ent = criarEnterprise(ctx, { pasta: dir });
  const url = new URL('http://x/a');
  await ent.antes('REQ', 'RES', url, { usuario: 'ana' });
  assert.deepEqual(ctx.visto, { req: 'REQ', res: 'RES', url, sessao: { usuario: 'ana' } });
});

test('podeVerAgente: todos os módulos que definem precisam concordar; quem não define não conta', () => {
  const dir = pastaDe({
    'a.js': modulo(`{ nome: 'a', criar: () => ({ podeVerAgente: (s, slug) => slug !== 'secreto' }) }`),
    'b.js': modulo(`{ nome: 'b', criar: () => ({ podeVerAgente: (s) => s.usuario !== 'visita' }) }`),
    'c.js': modulo(`{ nome: 'c', criar: () => ({}) }`),
  });
  const ent = criarEnterprise({ log: () => {} }, { pasta: dir });
  assert.equal(ent.podeVerAgente({ usuario: 'ana' }, 'luna'), true);
  assert.equal(ent.podeVerAgente({ usuario: 'ana' }, 'secreto'), false);
  assert.equal(ent.podeVerAgente({ usuario: 'visita' }, 'luna'), false);
});

test('podeVerAgente só vale true quando o módulo devolve exatamente true (valor truthy qualquer nega)', () => {
  const dir = pastaDe({ 'a.js': modulo(`{ nome: 'a', criar: () => ({ podeVerAgente: () => 'sim' }) }`) });
  const ent = criarEnterprise({ log: () => {} }, { pasta: dir });
  assert.equal(ent.podeVerAgente({}, 'x'), false);
});

test('o ctx chega ao módulo, com o que o server passa', () => {
  const dir = pastaDe({ 'a.js': modulo(`{ nome: 'a', criar: (ctx) => { ctx.recebido = Object.keys(ctx).sort(); return {}; } }`) });
  const ctx = { config: {}, registro: {}, auth: {}, log: () => {}, protecoes: {}, auditoria: {} };
  criarEnterprise(ctx, { pasta: dir });
  assert.deepEqual(ctx.recebido, ['auditoria', 'auth', 'config', 'log', 'protecoes', 'registro']);
});

test('módulo quebrado ou fora do contrato derruba a partida, dizendo qual arquivo', () => {
  assert.throws(() => criarEnterprise({ log: () => {} }, { pasta: pastaDe({ 'x.js': 'throw new Error("boom");' }) }), /x\.js não carregou \(boom\)/);
  assert.throws(() => criarEnterprise({ log: () => {} }, { pasta: pastaDe({ 'y.js': modulo('{ criar: () => ({}) }') }) }), /y\.js precisa exportar \{ nome/);
  assert.throws(() => criarEnterprise({ log: () => {} }, { pasta: pastaDe({ 'z.js': modulo(`{ nome: 'z', criar: () => { throw new Error('sem chave'); } }`) }) }), /"z" \(z\.js\) falhou ao iniciar: sem chave/);
});

test('só carrega .js e ignora o próprio index', () => {
  const dir = pastaDe({ 'index.js': 'throw new Error("nunca");', 'notas.txt': 'oi', 'a.js': modulo(`{ nome: 'a', criar: () => ({}) }`) });
  assert.deepEqual(criarEnterprise({ log: () => {} }, { pasta: dir }).modulos, ['a']);
});

test('a pasta de verdade carrega a tela de proteções', () => {
  const ent = criarEnterprise({ log: () => {}, protecoes: {}, servirArquivo() {}, semSessaoPagina() {}, config: {} });
  assert.ok(ent.modulos.includes('protecoes-tela'));
});

test('server.js expõe ent e, no nível pessoal, não muda nada: agentes e saúde respondem como sempre', async () => {
  const s = await subirWeb({ agentes: [{ slug: 'luna', nome: 'Luna', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'luna', chat_id: 'c_luna', porta_painel: null }] });
  try {
    assert.ok(s.web.ent.modulos.includes('protecoes-tela'));
    assert.equal(s.web.ent.podeVerAgente({ usuario: 'dono' }, 'luna'), true);
    assert.equal(s.web.protecoes.nivel(), 'pessoal');
    const saude = await s.c.get('/api/saude');
    assert.equal(saude.status, 200);
    const sem = await s.c.get('/api/v1/agents');
    assert.equal(sem.status, 401, 'sem sessão a API continua recusando');
    await s.login();
    const com = await s.c.get('/api/v1/agents');
    assert.equal(com.status, 200);
  } finally { await s.fechar(); }
});
