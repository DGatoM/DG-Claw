'use strict';
// Bloco E, credencial da empresa: o Web recusa o modo token com motivo em português, o formulário de criação carrega o uso
// (pessoa ou setor), o helper do Admin passa --uso ao `dgclaw agente criar` e o nível pessoal fica como era.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { cenarioEnt } = require('./ent-usuarios-ajuda');
const { executar } = require('../bin/onboarding');
const { loja } = require('../lib/onboarding');

// Valor de mentira, só para o teste.
const CODIGO_TOKEN = 'codigo-de-teste-de-longa-duracao-0001';

async function com(nivel, fn) {
  const c = await cenarioEnt({ nivel });
  // dá cofre ao agente ana: sem o campo cofre_arquivo o Web não intercepta as rotas do cofre
  const lista = JSON.parse(fs.readFileSync(c.s.agentesPath, 'utf8'));
  const casa = path.join(c.s.dir, 'casa-ana');
  fs.mkdirSync(path.join(casa, 'cofre'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(casa, 'config'), { mode: 0o755 });
  for (const a of lista.agentes) if (a.slug === 'ana') a.cofre_arquivo = path.join(casa, 'cofre', 'cofre.env');
  fs.writeFileSync(c.s.agentesPath, JSON.stringify(lista));
  try { await fn(c); } finally { await c.fechar(); }
}

test('escritório: escolher o modo token é recusado (403) com o motivo e sem guardar nada', async () => {
  await com('escritorio', async (c) => {
    const cli = (await c.entrar('dono', c.senhaTi)).cli;
    const r = await cli.post('/p/ana/api/provedor', { json: { provedor: 'claude', auth: 'token', modelo: '', chave: CODIGO_TOKEN } });
    assert.equal(r.status, 403, r.texto);
    assert.match(r.json.error, /assento do Team ou do Enterprise/);
    assert.ok(r.json.howToFix);
    assert.ok(!r.texto.includes(CODIGO_TOKEN));
    assert.equal(fs.existsSync(path.join(c.s.dir, 'casa-ana', 'cofre', 'cofre.env')), false, 'nada foi gravado no cofre');
    assert.ok(!c.s.log.texto().includes(CODIGO_TOKEN));
  });
});

test('escritório: guardar CLAUDE_CODE_OAUTH_TOKEN direto no cofre também é recusado, e outras chaves continuam valendo', async () => {
  await com('escritorio', async (c) => {
    const cli = (await c.entrar('dono', c.senhaTi)).cli;
    const r = await cli.post('/p/ana/api/cofre', { json: { envName: 'CLAUDE_CODE_OAUTH_TOKEN', valor: CODIGO_TOKEN } });
    assert.equal(r.status, 403, r.texto);
    assert.match(r.json.error, /assento do Team ou do Enterprise/);
    const ok = await cli.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: 'sk-teste-valor-de-teste-123456789', provedor: 'openai' } });
    assert.equal(ok.status, 200, ok.texto);
  });
});

test('pessoal: o modo token continua aceito como sempre', async () => {
  await com('pessoal', async (c) => {
    await c.s.login();
    const r = await c.s.c.post('/p/ana/api/cofre', { json: { envName: 'CLAUDE_CODE_OAUTH_TOKEN', valor: CODIGO_TOKEN, provedor: 'claude-assinatura' } });
    assert.equal(r.status, 200, r.texto);
    assert.ok(fs.readFileSync(path.join(c.s.dir, 'casa-ana', 'cofre', 'cofre.env'), 'utf8').includes('CLAUDE_CODE_OAUTH_TOKEN'));
  });
});

const PEDIDO = { id: 'c'.repeat(32), nome: 'Sofia', papel: 'Organizar a agenda', jeito: 'Acolhedor e direto' };

/** Cria o pedido pelo formulário e roda o helper do Admin com um `dgclaw` falso; devolve o argv que chegou a ele. */
async function argvDoCriar(c, cli, extra) {
  const r = await cli.post('/api/v1/onboarding', { json: Object.assign({}, PEDIDO, extra) });
  assert.equal(r.status, 200, r.texto);
  let argv = null;
  const spawnFalso = (bin, args) => {
    argv = args;
    const p = loja(c.dataDir).ler(PEDIDO.id);
    const reg = JSON.parse(fs.readFileSync(c.s.agentesPath));
    reg.agentes.push({ slug: p.slug, nome: p.nome, agente_id: p.slug, runner: 'http://127.0.0.1:1', porta_painel: 8301 });
    fs.writeFileSync(c.s.agentesPath, JSON.stringify(reg));
    const e = new EventEmitter(); setImmediate(() => e.emit('exit', 0)); return e;
  };
  const feito = await executar('criar', PEDIDO.id, { web: c.s.web, spawn: spawnFalso });
  return { argv, feito };
}

test('escritório: o formulário avisa que a credencial da empresa está ligada e o helper cria agente de pessoa com --uso pessoa --usuario', async () => {
  await com('escritorio', async (c) => {
    const cli = (await c.entrar('dono', c.senhaTi)).cli;
    assert.equal((await cli.get('/api/v1/onboarding')).json.credencial_empresa, true);
    const { argv, feito } = await argvDoCriar(c, cli, { uso: 'pessoa' });
    assert.equal(feito.fase, 'login');
    const i = argv.indexOf('--uso');
    assert.ok(i > 0, `faltou --uso em ${argv.join(' ')}`);
    assert.equal(argv[i + 1], 'pessoa');
    assert.equal(argv[argv.indexOf('--auth') + 1], 'assinatura');
    assert.equal(argv[argv.indexOf('--usuario') + 1], 'dono', 'o dono é quem estava logado');
  });
});

test('escritório: agente de setor vai com --auth api --uso setor, sem --usuario, e a tela de login pede a chave da empresa', async () => {
  await com('escritorio', async (c) => {
    const cli = (await c.entrar('dono', c.senhaTi)).cli;
    const { argv, feito } = await argvDoCriar(c, cli, { uso: 'setor' });
    assert.equal(argv[argv.indexOf('--auth') + 1], 'api');
    assert.equal(argv[argv.indexOf('--uso') + 1], 'setor');
    assert.equal(argv.includes('--usuario'), false);
    assert.match(feito.mensagem, /chave de API da empresa/);
  });
});

test('escritório: uso desconhecido no formulário é recusado antes de enviar ao Admin', async () => {
  await com('escritorio', async (c) => {
    const cli = (await c.entrar('dono', c.senhaTi)).cli;
    const r = await cli.post('/api/v1/onboarding', { json: Object.assign({}, PEDIDO, { uso: 'familia' }) });
    assert.equal(r.status, 400);
    assert.match(r.json.erro || r.texto, /pessoa|setor/);
    assert.equal(c.runners.admin.rec.inputs.length, 0);
  });
});

test('pessoal: o helper cria como sempre (--auth assinatura, sem --uso) e o formulário não mostra a pergunta', async () => {
  await com('pessoal', async (c) => {
    await c.s.login();
    assert.equal((await c.s.c.get('/api/v1/onboarding')).json.credencial_empresa, false);
    const { argv } = await argvDoCriar(c, c.s.c, {});
    assert.equal(argv[argv.indexOf('--auth') + 1], 'assinatura');
    assert.equal(argv.includes('--uso'), false);
    assert.equal(argv.includes('--usuario'), false);
  });
});

test('o catálogo do controle aceita uso e usuario em agente.criar e repassa à CLI na ordem certa', () => {
  const catalogo = require('../../controle/catalogo');
  const v = catalogo.validar('agente.criar', { slug: 'ana', nome: 'Ana', uso: 'pessoa', usuario: 'fran' });
  assert.equal(v.ok, true, v.erro);
  const argv = catalogo.OPS['agente.criar'].cli(v.params, { quem: 'agente:admin' });
  assert.equal(argv[argv.indexOf('--uso') + 1], 'pessoa');
  assert.equal(argv[argv.indexOf('--usuario') + 1], 'fran');
  assert.match(catalogo.descrever('agente.criar', v.params), /uso pessoa da pessoa fran/);
  assert.equal(catalogo.validar('agente.criar', { slug: 'ana', nome: 'Ana', uso: 'dono' }).ok, false);
  const sem = catalogo.OPS['agente.criar'].cli(catalogo.validar('agente.criar', { slug: 'ana', nome: 'Ana' }).params, {});
  assert.equal(sem.includes('--uso'), false, 'sem uso, o comando é o de antes');
});
