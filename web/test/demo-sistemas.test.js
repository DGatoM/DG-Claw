'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarDemoSistemas } = require('../lib/demo-sistemas');
const { pastaTemp, subirWeb } = require('./ajuda');

const CHAVE_ORG = 'chave-organizap-SEGREDO-123';
const CHAVE_OAI = 'sk-openai-SEGREDO-456';
const BASE = 'https://org.exemplo/api/assistant';

/** Monta demo.json + arquivos de chave numa pasta temporária. */
function montaConfig(extra) {
  const dir = pastaTemp('demo-sis');
  const arq = (nome, txt) => { const p = path.join(dir, nome); fs.writeFileSync(p, txt, { mode: 0o600 }); return p; };
  const cfg = Object.assign({
    versao: 1, agente: 'nova',
    linhas_whatsapp: [
      { id: 'danilo', rotulo: 'WhatsApp do Danilo', tipo: 'organizap', base: BASE, chave_arquivo: arq('org.key', CHAVE_ORG + '\n') },
      { id: 'isa', rotulo: 'WhatsApp da Isa', tipo: 'cpdf', base: 'https://cpdf.exemplo', chave_arquivo: arq('cpdf.key', 'x-cpdf-chave') },
    ],
    email: { tipo: 'organizap', base: BASE, chave_arquivo: path.join(dir, 'org.key'), rotulo: 'E-mail' },
    crm: { url_saude: 'http://crm.local/saude', rotulo: 'CRM' },
    imagem: { chave_arquivo: arq('openai.key', CHAVE_OAI), rotulo: 'Geração de imagens' },
  }, extra || {});
  const caminho = path.join(dir, 'demo.json');
  fs.writeFileSync(caminho, JSON.stringify(cfg), { mode: 0o600 });
  return { dir, caminho, cfg };
}

const resp = (status, corpo) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

/** fetch falso: `rotas` é { 'trecho da URL': resposta | função }. Conta as chamadas. */
function fetchFalso(rotas) {
  const f = async (url, op) => {
    f.chamadas.push(String(url));
    for (const [trecho, r] of Object.entries(rotas)) if (String(url).includes(trecho)) return typeof r === 'function' ? r(url, op) : r;
    throw new Error('rota não prevista no teste: ' + url);
  };
  f.chamadas = [];
  return f;
}

const BOAS = () => ({
  '/instances': resp(200, { success: true, data: [{ id: 'i1', name: 'Principal', status: 'connected', phoneNumber: '+5511987654321', canSend: true }] }),
  'crm.local': resp(200, { ok: true }),
  'api.openai.com': resp(200, { data: [] }),
});

const registroFalso = { obter: (slug) => (slug === 'nova' ? { slug: 'nova', nome: 'Nova', cor: '#112233' } : null) };
const runnerVivo = { estado: async () => ({ ok: true, estado: { status: 'running' } }) };

function monta(extra, fetchFn, opc) {
  const { caminho, cfg } = montaConfig(extra);
  const logs = [];
  const d = criarDemoSistemas(Object.assign({ env: { DGCLAW_DEMO_CONFIG: caminho }, runner: runnerVivo, registro: registroFalso, avatarDe: () => ({ avatar_img: '/foto.png' }), log: (n, m) => logs.push(`${n}: ${m}`), fetchFn }, opc || {}));
  return { d, logs, cfg };
}
const achar = (corpo, id) => corpo.sistemas.find((s) => s.id === id);

test('instância conectada e canSend verdadeiro = conectado; foto e agente vêm na resposta', async () => {
  const { d } = monta(null, fetchFalso(BOAS()));
  const r = await d.sistemas();
  assert.equal(r.ok, true);
  assert.equal(achar(r, 'whatsapp-danilo').estado, 'conectado');
  assert.equal(achar(r, 'agente').estado, 'conectado');
  assert.equal(achar(r, 'crm').estado, 'conectado');
  assert.equal(achar(r, 'imagem').estado, 'conectado');
  assert.equal(r.agente.nome, 'Nova');
  assert.equal(r.agente.avatar_url, '/foto.png');
  assert.ok(Date.parse(r.medido_em));
});

test('canSend falso = caido, com o motivo', async () => {
  const f = fetchFalso(Object.assign(BOAS(), { '/instances': resp(200, { data: [{ id: 'i1', status: 'connected', canSend: false }] }) }));
  const s = achar(await monta(null, f).d.sistemas(), 'whatsapp-danilo');
  assert.equal(s.estado, 'caido');
  assert.match(s.motivo, /canSend/);
});

test('instância desconectada = caido', async () => {
  const f = fetchFalso(Object.assign(BOAS(), { '/instances': resp(200, { data: [{ id: 'i1', status: 'disconnected', canSend: true }] }) }));
  assert.equal(achar(await monta(null, f).d.sistemas(), 'whatsapp-danilo').estado, 'caido');
});

test('prazo estourado = caido, mesmo se o provedor ignorar o sinal de cancelamento', async () => {
  const f = fetchFalso(Object.assign(BOAS(), { 'crm.local': () => new Promise(() => {}) }));
  const s = achar(await monta(null, f, { prazoMs: 40 }).d.sistemas(), 'crm');
  assert.equal(s.estado, 'caido');
  assert.match(s.motivo, /não respondeu/);
});

test('erro de rede = caido com a causa', async () => {
  const f = fetchFalso(Object.assign(BOAS(), { 'crm.local': () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } }));
  const s = achar(await monta(null, f).d.sistemas(), 'crm');
  assert.equal(s.estado, 'caido');
  assert.match(s.motivo, /ECONNREFUSED/);
});

test('OpenAI: 401 é caido, 403 é nao_medido com motivo', async () => {
  const f401 = fetchFalso(Object.assign(BOAS(), { 'api.openai.com': resp(401, {}) }));
  assert.equal(achar(await monta(null, f401).d.sistemas(), 'imagem').estado, 'caido');
  const f403 = fetchFalso(Object.assign(BOAS(), { 'api.openai.com': resp(403, {}) }));
  const s = achar(await monta(null, f403).d.sistemas(), 'imagem');
  assert.equal(s.estado, 'nao_medido');
  assert.match(s.motivo, /403/);
});

test('arquivo de chave ausente = nao_medido com motivo, sem chamar o provedor', async () => {
  const f = fetchFalso(BOAS());
  const { d, cfg } = monta(null, f);
  fs.rmSync(cfg.imagem.chave_arquivo);
  const s = achar(await d.sistemas(), 'imagem');
  assert.equal(s.estado, 'nao_medido');
  assert.match(s.motivo, /openai\.key.*não existe/);
  assert.ok(!f.chamadas.some((u) => u.includes('openai')));
});

test('linha cpdf e e-mail sem rota de status = nao_medido, nunca conectado', async () => {
  const r = await monta(null, fetchFalso(BOAS())).d.sistemas();
  assert.equal(achar(r, 'whatsapp-isa').estado, 'nao_medido');
  assert.equal(achar(r, 'email').estado, 'nao_medido');
  assert.ok(achar(r, 'email').motivo.length > 10);
});

test('status desconhecido ou corpo sem lista = nao_medido (null nunca vira conectado)', async () => {
  const f1 = fetchFalso(Object.assign(BOAS(), { '/instances': resp(200, { data: [{ id: 'i1', status: 'qualquercoisa', canSend: true }] }) }));
  assert.equal(achar(await monta(null, f1).d.sistemas(), 'whatsapp-danilo').estado, 'nao_medido');
  const f2 = fetchFalso(Object.assign(BOAS(), { '/instances': resp(200, { success: true }) }));
  assert.equal(achar(await monta(null, f2).d.sistemas(), 'whatsapp-danilo').estado, 'nao_medido');
  const f3 = fetchFalso(Object.assign(BOAS(), { 'crm.local': resp(200, {}) }));
  assert.notEqual(achar(await monta(null, f3).d.sistemas(), 'crm').estado, 'conectado');
});

test('runner sem resposta = agente caido', async () => {
  const runner = { estado: async () => ({ ok: false, erro: 'Não consegui falar com o runner de Nova.' }) };
  const s = achar(await monta(null, fetchFalso(BOAS()), { runner }).d.sistemas(), 'agente');
  assert.equal(s.estado, 'caido');
  assert.match(s.motivo, /runner/);
});

test('cache de 20 s: segunda leitura não chama os provedores; depois do prazo, mede de novo; pedidos juntos dividem uma medição', async () => {
  let t = 1_000_000;
  const f = fetchFalso(BOAS());
  const { d } = monta(null, f, { agora: () => t });
  const [a, b] = await Promise.all([d.sistemas(), d.sistemas()]);
  assert.equal(a, b);
  const n = f.chamadas.length;
  assert.ok(n > 0);
  await d.sistemas();
  assert.equal(f.chamadas.length, n);
  t += 19_000; await d.sistemas();
  assert.equal(f.chamadas.length, n);
  t += 2_000; await d.sistemas();
  assert.equal(f.chamadas.length, 2 * n);
});

test('a resposta não tem número completo nem segredo', async () => {
  const f = fetchFalso(Object.assign(BOAS(), { '/instances': resp(200, { data: [{ id: 'i1', name: 'Principal', status: 'connected', phoneNumber: '+5511987654321', canSend: true }] }) }));
  const texto = JSON.stringify(await monta(null, f).d.sistemas());
  assert.ok(!texto.includes('5511987654321'));
  assert.ok(!texto.includes('987654321'));
  assert.ok(!texto.includes(CHAVE_ORG));
  assert.ok(!texto.includes(CHAVE_OAI));
  assert.match(texto, /final 4321/);
});

test('sem DGCLAW_DEMO_CONFIG ou com arquivo inválido, o modo fica desligado (e o motivo vai para o log)', () => {
  assert.equal(criarDemoSistemas({ env: {}, runner: runnerVivo, registro: registroFalso, log: () => {} }).ativo(), false);
  const dir = pastaTemp('demo-ruim');
  const p = path.join(dir, 'demo.json');
  fs.writeFileSync(p, '{"versao":1}');
  const logs = [];
  const d = criarDemoSistemas({ env: { DGCLAW_DEMO_CONFIG: p }, runner: runnerVivo, registro: registroFalso, log: (n, m) => logs.push(m) });
  assert.equal(d.ativo(), false);
  assert.match(logs[0], /"agente"/);
});

// ── pelo servidor de verdade ──
const AGENTE = { slug: 'nova', nome: 'Nova', agente_id: 'ag1', runner: 'http://127.0.0.1:1', avatar: 'N' };

test('modo desligado: a rota e a página dão 404 e /api/v1/agents não marca demo', async () => {
  const s = await subirWeb({ agentes: [AGENTE] });
  try {
    await s.login();
    assert.equal((await s.c.get('/api/demo/sistemas')).status, 404);
    assert.equal((await s.c.get('/sistemas')).status, 404);
    assert.equal((await s.c.get('/api/v1/agents')).json.demo, false);
  } finally { await s.fechar(); }
});

test('modo ligado: sem sessão é recusado; com sessão devolve os sistemas e a página abre', async () => {
  const { caminho } = montaConfig({ crm: { url_saude: 'http://crm.local/saude' }, linhas_whatsapp: [], email: undefined, imagem: undefined });
  const s = await subirWeb({ agentes: [AGENTE], env: { DGCLAW_DEMO_CONFIG: caminho }, opcoesServidor: { demoFetch: fetchFalso({ 'crm.local': resp(200, { ok: true }) }) } });
  fs.writeFileSync(path.join(s.publico, 'sistemas.html'), '<html>sistemas</html>');
  try {
    const sem = await s.c.get('/api/demo/sistemas');
    assert.ok(sem.status === 401 || sem.status === 403, `esperava recusa, veio ${sem.status}`);
    await s.login();
    const r = await s.c.get('/api/demo/sistemas');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(achar(r.json, 'crm').estado, 'conectado');
    assert.equal(achar(r.json, 'agente').estado, 'caido');
    assert.equal((await s.c.get('/sistemas')).status, 200);
    assert.equal((await s.c.get('/api/v1/agents')).json.demo, true);
  } finally { await s.fechar(); }
});

test('sessão do runner em "errored" (sem login, por exemplo) = agente caido, nunca conectado', async () => {
  const runnerErro = { estado: async () => ({ ok: true, estado: { status: 'errored' } }) };
  const { d } = monta(null, fetchFalso(BOAS()), { runner: runnerErro });
  const r = await d.sistemas();
  assert.equal(achar(r, 'agente').estado, 'caido');
  assert.match(achar(r, 'agente').motivo, /errored/);
});
