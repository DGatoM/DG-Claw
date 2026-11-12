'use strict';
// Abertura da conversa: rótulo e hora da última mensagem atualizam por trás depois de vencidos
// (ninguém espera o runner), e o onboarding só relê do disco quando a pasta muda.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { criarConversa } = require('../lib/conversa');
const { criarLeitor } = require('../lib/thread');
const { criarRunner } = require('../lib/runner');
const { criarMidia } = require('../lib/media');
const { criarRunnerFalso } = require('./runner-falso');
const { pastaTemp, capturaLog } = require('./ajuda');

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

async function montar(opRunner) {
  const transcripts = path.join(pastaTemp('swr'), 'projects');
  fs.mkdirSync(transcripts, { recursive: true });
  const rf = criarRunnerFalso(Object.assign({ agenteId: 'ana1', sessionId: 'sess-swr-0001', provedor: { ok: true, rotulo: 'Claude, v1' } }, opRunner));
  const porta = await rf.ouvir();
  const agente = { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: transcripts, home_host: pastaTemp('home'), home_container: '/home/agente' };
  const cap = capturaLog();
  const midia = criarMidia({ dataDir: pastaTemp('dados'), log: cap.log, registro: { obter: () => agente } });
  const leitor = criarLeitor({ log: cap.log, tz: 'America/Sao_Paulo', canalTelegram: 'plugin:telegram', midia });
  const relogio = { t: 1_000_000 };
  const conversa = criarConversa({ config: {}, runner: criarRunner({ log: cap.log }), leitor, midia, log: cap.log, agora: () => relogio.t });
  return { rf, agente, conversa, relogio, cap };
}

test('rotuloProvedor: com o cache vencido devolve o valor antigo na hora e atualiza em seguida', async () => {
  const c = await montar();
  try {
    assert.equal(await c.conversa.rotuloProvedor(c.agente), 'Claude, v1');
    c.rf.opcoes.provedor = { ok: true, rotulo: 'Claude, v2' };
    c.rf.opcoes.atrasoProvedorMs = 400;
    c.relogio.t += 61_000;
    const t0 = Date.now();
    assert.equal(await c.conversa.rotuloProvedor(c.agente), 'Claude, v1', 'vencido: devolve o antigo');
    assert.ok(Date.now() - t0 < 150, 'não esperou o runner lento');
    await dorme(600);
    assert.equal(await c.conversa.rotuloProvedor(c.agente), 'Claude, v2', 'a atualização por trás chegou ao cache');
  } finally { await c.rf.fechar(); }
});

test('rotuloProvedor: pedidos simultâneos com o cache vencido disparam uma consulta só', async () => {
  const c = await montar();
  try {
    await c.conversa.rotuloProvedor(c.agente);
    const antes = c.rf.rec.provedorPedidos;
    c.rf.opcoes.atrasoProvedorMs = 200;
    c.relogio.t += 61_000;
    await Promise.all([1, 2, 3, 4].map(() => c.conversa.rotuloProvedor(c.agente)));
    await dorme(400);
    assert.equal(c.rf.rec.provedorPedidos - antes, 1);
  } finally { await c.rf.fechar(); }
});

test('rotuloProvedor: atualização por trás que falha loga o motivo e mantém o valor antigo', async () => {
  const c = await montar();
  try {
    await c.conversa.rotuloProvedor(c.agente);
    c.rf.opcoes.provedor = null; // o runner passa a responder 404
    c.relogio.t += 61_000;
    assert.equal(await c.conversa.rotuloProvedor(c.agente), 'Claude, v1');
    await dorme(100);
    assert.ok(c.cap.linhas.some((l) => /Rótulo do provedor de Ana/.test(JSON.stringify(l))), 'o motivo foi para o log');
  } finally { await c.rf.fechar(); }
});

test('rotuloProvedor: sem cache nenhum (primeira vez) espera o runner como antes', async () => {
  const c = await montar({ atrasoProvedorMs: 150 });
  try {
    const t0 = Date.now();
    assert.equal(await c.conversa.rotuloProvedor(c.agente), 'Claude, v1');
    assert.ok(Date.now() - t0 >= 140);
  } finally { await c.rf.fechar(); }
});

test('ultimaMensagemTs: cache vencido devolve o valor antigo na hora e relê por trás', async () => {
  const c = await montar();
  try {
    const dir = c.agente.transcripts_dir;
    const grava = (ts, txt = 'oi', msg = 'm1') => fs.appendFileSync(path.join(dir, 'sess-swr-0001.jsonl'), JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: `<dgchat from="pessoa" chat="c_ana" msg="${msg}" ts="${ts}">${txt}</dgchat>` } }) + '\n');
    grava('2026-10-12T15:00:00.000Z');
    const v1 = Date.UTC(2026, 9, 12, 15, 0, 0);
    assert.equal(await c.conversa.ultimaMensagemTs(c.agente), v1);
    grava('2026-10-12T16:00:00.000Z', 'de novo', 'm2');
    c.relogio.t += 61_000;
    assert.equal(await c.conversa.ultimaMensagemTs(c.agente), v1, 'vencido: antigo na hora');
    await dorme(300);
    assert.equal(await c.conversa.ultimaMensagemTs(c.agente), Date.UTC(2026, 9, 12, 16, 0, 0));
  } finally { await c.rf.fechar(); }
});

test('onboarding: a foto dos pedidos só é relida do disco quando a pasta muda', () => {
  const { criarOnboarding } = require('../lib/onboarding');
  const dataDir = pastaTemp('onb');
  const o = criarOnboarding({ config: { dataDir }, registro: {}, conversa: {}, midia: {} });
  const id = 'a'.repeat(32);
  assert.deepEqual(o.db.todos(), []);
  o.db.gravar({ id, criado: '2026-11-12T10:00:00.000Z', slug: 'ana', foto: null, fase: 'solicitado' });
  const lidos = [];
  const lerOriginal = fs.readFileSync;
  fs.readFileSync = function (p, ...r) { if (String(p).startsWith(dataDir)) lidos.push(String(p)); return lerOriginal.call(this, p, ...r); };
  try {
    assert.equal(o.db.todos().length, 1);
    const primeira = lidos.length;
    assert.equal(primeira, 1);
    o.db.todos(); o.db.todos();
    assert.equal(lidos.length, primeira, 'sem mudança, não relê');
    // mudança por fora (outro processo): rename muda o mtime da pasta
    const id2 = 'b'.repeat(32);
    const tmp = path.join(dataDir, 'onboarding', id2 + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ id: id2, criado: '2026-11-12T11:00:00.000Z', slug: 'bia' }));
    const alvo = path.join(dataDir, 'onboarding', id2 + '.json');
    const st = fs.statSync(path.join(dataDir, 'onboarding'));
    fs.utimesSync(path.join(dataDir, 'onboarding'), st.atime, new Date(st.mtimeMs - 5000)); // garante mtime diferente
    const antes = o.db.todos().length; // refaz a assinatura com o mtime recuado
    fs.renameSync(tmp, alvo);
    assert.equal(o.db.todos().length, antes + 1, 'pasta mudou: relê');
    // gravação do próprio servidor invalida na hora
    o.db.gravar({ id, criado: '2026-11-12T10:00:00.000Z', slug: 'ana', foto: null, fase: 'pronto' });
    assert.equal(o.db.todos().find((p) => p.id === id).fase, 'pronto');
  } finally { fs.readFileSync = lerOriginal; }
});

test('conversa.js: o histórico inicial sai junto com /agents, sem esperar por ele', async () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../public/conversa.js'), 'utf8');
  const ini = fonte.indexOf('let historicoAntecipado');
  const fim = fonte.indexOf('function iniciaTela');
  const bloco = fonte.slice(ini, fim) + '\nthis.boot = boot; this.pegaHistorico = () => historicoAntecipado;';
  const pedidos = [];
  let liberaAgents;
  const agentesResp = new Promise((r) => { liberaAgents = r; });
  const resp = (corpo) => ({ ok: true, status: 200, json: async () => corpo });
  const ctx = vm.createContext({
    console, encodeURIComponent, decodeURIComponent, Array, Error,
    location: { pathname: '/a/ana', search: '', href: '' },
    slugDaUrl: () => 'ana',
    $: () => ({ hidden: false, textContent: '' }), document: { querySelector: () => null },
    mostraErroTela() {}, iniciaTela() {},
    fetch: (url) => {
      pedidos.push(url);
      return /\/messages/.test(url) ? Promise.resolve(resp({ ok: true, msgs: [] })) : agentesResp.then(() => resp({ ok: true, agentes: [] }));
    },
  });
  vm.runInContext(bloco, ctx);
  const p = ctx.boot();
  await dorme(20);
  assert.ok(pedidos.some((u) => u === '/api/v1/agents/ana/messages?limit=60'), '/messages saiu antes de /agents responder');
  assert.ok(pedidos.includes('/api/v1/agents'));
  assert.ok(ctx.pegaHistorico(), 'a promessa fica guardada para a primeira carga');
  liberaAgents();
  await p;
});
