'use strict';
// POST /api/v1/agents/<slug>/reiniciar: repassa ao runner do agente e explica toda falha.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

async function cenario(opRunner) {
  const runner = criarRunnerFalso(Object.assign({ agenteId: 'ana1' }, opRunner));
  const porta = await runner.ouvir();
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: pastaTemp('tr'), home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes, opcoesServidor: { tickSseMs: 60 } });
  await t.login();
  return { t, runner, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}
const reinicia = (s) => s.t.c.post('/api/v1/agents/ana/reiniciar', { json: {} });

test('reiniciar: repassa ao runner e devolve 202 com sessão e modo', async () => {
  const s = await cenario({});
  try {
    const r = await reinicia(s);
    assert.equal(r.status, 202, r.texto);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.modo, 'retomar');
    assert.equal(r.json.sessao, 'sess-0001-aaaa');
    assert.equal(s.runner.rec.reinicios, 1);
  } finally { await s.fechar(); }
});

test('reiniciar: runner fora do ar => 503 dizendo o que fazer', async () => {
  const s = await cenario({});
  try {
    await s.runner.fechar();
    const r = await reinicia(s);
    assert.equal(r.status, 503);
    assert.match(r.json.erro, /Não consegui falar com o runner de Ana/);
    assert.match(r.json.erro, /não foi pedido/);
  } finally { await s.t.fechar(); }
});

test('reiniciar: conexão derrubada DEPOIS do envio => 504 sem afirmar que o reinício não foi pedido', async () => {
  const s = await cenario({ derrubaReiniciar: true });
  try {
    const r = await reinicia(s);
    assert.equal(r.status, 504);
    assert.match(r.json.erro, /Não sei se o reinício chegou ao runner de Ana/);
    assert.match(r.json.erro, /Espere uns 30 s/);
    assert.doesNotMatch(r.json.erro, /não foi pedido/);
  } finally { await s.fechar(); }
});

test('reiniciar: runner recusa (capacidade) => 429 com o motivo; runner antigo => 501', async () => {
  let s = await cenario({ falhaReiniciar: { status: 429, corpo: { success: false, error: 'limite de sessões', howToFix: 'suspenda uma sessão' } } });
  try {
    const r = await reinicia(s);
    assert.equal(r.status, 429);
    assert.match(r.json.erro, /limite de sessões suspenda uma sessão/);
  } finally { await s.fechar(); }
  s = await cenario({ semRotaReiniciar: true });
  try {
    const r = await reinicia(s);
    assert.equal(r.status, 501);
    assert.match(r.json.erro, /versão antiga/);
  } finally { await s.fechar(); }
});

test('reiniciar: sem login => 401, sem Origin => 403, e nada chega ao runner', async () => {
  const s = await cenario({});
  try {
    assert.equal((await cliente(s.t.porta).post('/api/v1/agents/ana/reiniciar', { json: {} })).status, 401);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/reiniciar', { json: {}, origin: false })).status, 403);
    assert.equal(s.runner.rec.reinicios, 0);
    assert.equal((await s.t.c.get('/api/v1/agents/ana/reiniciar')).status, 405);
  } finally { await s.fechar(); }
});

test('reiniciar: o item do menu nasce escondido na casca e a conversa tem o diálogo e a faixa', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pub = path.join(__dirname, '..', 'public');
  const casca = require('../public/casca');
  assert.match(casca.MARCACAO_MENU, /id="mlSessao"[^>]*hidden/);
  assert.match(casca.MARCACAO_MENU, /id="gmReiniciar"/);
  const html = fs.readFileSync(path.join(pub, 'conversa.html'), 'utf8');
  for (const id of ['dlgReinicio', 'dlgReinicioSim', 'dlgReinicioNao', 'faixaReinicio']) assert.ok(html.includes(`id="${id}"`), id);
  const js = fs.readFileSync(path.join(pub, 'conversa.js'), 'utf8');
  assert.ok(js.includes("API + '/reiniciar'"));
  // a faixa de 3 minutos saiu: nada de "não respondeu em 3 minutos"
  assert.ok(!js.includes('não respondeu em 3 minutos'));
  // 504 (não sei se chegou): acompanha em vez de oferecer "Tentar de novo"
  assert.match(js, /e\.status === 504\) return acompanha\(e\.message\)/);
});
