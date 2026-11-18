'use strict';
// POST /api/v1/agents/<slug>/parar: o botão Parar (um Esc na sessão), com toda falha explicada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { cenario: cenarioColab, colaboradorAtivo } = require('./colab-ajuda');

async function cenario(opRunner) {
  const runner = criarRunnerFalso(Object.assign({ agenteId: 'ana1' }, opRunner));
  const porta = await runner.ouvir();
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: pastaTemp('tr'), home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes, opcoesServidor: { tickSseMs: 60 } });
  await t.login();
  return { t, runner, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}
const para = (s) => s.t.c.post('/api/v1/agents/ana/parar', { json: {} });

test('parar: trabalhando => 200 com trabalhando e a mensagem de interrupção', async () => {
  const s = await cenario({ status: 'working' });
  try {
    const r = await para(s);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.agente, 'ana');
    assert.equal(r.json.trabalhando, true);
    assert.equal(r.json.enviado_em, '2026-11-18T12:00:00.000Z');
    assert.match(r.json.mensagem, /Pedi para Ana parar/);
    assert.match(r.json.mensagem, /segundo plano continuam/);
    assert.equal(s.runner.rec.interrupcoes, 1);
  } finally { await s.fechar(); }
});

test('parar: sem corpo também vale, e o agente ocioso recebe o aviso de que o Esc não muda nada', async () => {
  const s = await cenario({ status: 'idle' });
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/parar', {});
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.trabalhando, false);
    assert.match(r.json.mensagem, /não estava trabalhando/);
    assert.match(r.json.mensagem, /não muda nada/);
  } finally { await s.fechar(); }
});

test('parar: runner fora do ar => 503 dizendo que nada foi enviado', async () => {
  const s = await cenario({});
  try {
    await s.runner.fechar();
    const r = await para(s);
    assert.equal(r.status, 503);
    assert.equal(r.json.ok, false);
    assert.match(r.json.erro, /Não consegui falar com o runner de Ana/);
    assert.match(r.json.erro, /O pedido de parar não foi enviado\. Tente de novo\./);
  } finally { await s.t.fechar(); }
});

test('parar: conexão derrubada DEPOIS do envio => 504 sem afirmar que não foi enviado', async () => {
  const s = await cenario({ derrubaInterromper: true });
  try {
    const r = await para(s);
    assert.equal(r.status, 504);
    assert.match(r.json.erro, /Não sei se o pedido de parar chegou/);
    assert.match(r.json.erro, /Olhe a conversa antes de apertar de novo/);
    assert.doesNotMatch(r.json.erro, /não foi enviado/);
  } finally { await s.fechar(); }
});

test('parar: trava de 3 s do runner => 429 repassando espere_s', async () => {
  const s = await cenario({ falhaInterromper: { status: 429, corpo: { success: false, error: 'Esc há pouco', howToFix: 'esperar', code: 'MUITO_RAPIDO', espereS: 2.4 } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 429);
    assert.equal(r.json.espere_s, 2.4);
    assert.equal(r.json.codigo, 'MUITO_RAPIDO');
    assert.match(r.json.erro, /Espere 2\.4 s/);
  } finally { await s.fechar(); }
});

test('parar: sem terminal (NO_PTY) => 409; outro 409 => 409 com o motivo; erro do runner => 502', async () => {
  let s = await cenario({ falhaInterromper: { status: 409, corpo: { success: false, error: 'sem pty', code: 'NO_PTY' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'NO_PTY');
    assert.equal(r.json.erro, 'Ana não tem sessão aberta agora, então não há o que parar.');
  } finally { await s.fechar(); }
  s = await cenario({ falhaInterromper: { status: 409, corpo: { success: false, error: 'respondendo pergunta', code: 'RESPOSTA_EM_ANDAMENTO' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /respondendo pergunta/);
  } finally { await s.fechar(); }
  s = await cenario({ falhaInterromper: { status: 500, corpo: { success: false, error: 'quebrou' } } });
  try { assert.equal((await para(s)).status, 502); } finally { await s.fechar(); }
});

test('parar: runner antigo (sem a rota) => 501 mandando atualizar pelo Admin', async () => {
  const s = await cenario({ semRotaInterromper: true });
  try {
    const r = await para(s);
    assert.equal(r.status, 501);
    assert.equal(r.json.codigo, 'RUNNER_ANTIGO');
    assert.match(r.json.erro, /Atualize o agente pelo Admin/);
  } finally { await s.fechar(); }
});

test('parar: sem login => 401, sem Origin => 403, GET => 405, e nada chega ao runner', async () => {
  const s = await cenario({});
  try {
    assert.equal((await cliente(s.t.porta).post('/api/v1/agents/ana/parar', { json: {} })).status, 401);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/parar', { json: {}, origin: false })).status, 403);
    assert.equal((await s.t.c.get('/api/v1/agents/ana/parar')).status, 405);
    assert.equal(s.runner.rec.interrupcoes, 0);
  } finally { await s.fechar(); }
});

test('parar: a doc abre para quem está logado e fala da trava de 3 s', async () => {
  const s = await cenario({});
  try {
    const r = await s.t.c.get('/api/v1/parar/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.texto, /3 s/);
  } finally { await s.fechar(); }
});

test('parar: colaborador não para o turno do dono (403, runner não chamado) e para o dele (200)', async () => {
  const s = await cenarioColab();
  try {
    const x = await colaboradorAtivo(s);
    // Turno do dono em curso.
    assert.equal((await s.dono.post('/api/v1/agents/ana/send', { json: { text: 'faz isso' } })).status, 200);
    const barrado = await x.c.post('/api/v1/agents/ana/parar', { json: {} });
    assert.equal(barrado.status, 403, barrado.texto);
    assert.match(barrado.json.erro, /só ele pode parar/);
    assert.equal(s.rAna.rec.interrupcoes, 0);
    // Turno do colaborador.
    assert.equal((await x.c.post('/api/v1/agents/ana/send', { json: { text: 'agora é comigo' } })).status, 200);
    const ok = await x.c.post('/api/v1/agents/ana/parar', { json: {} });
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(s.rAna.rec.interrupcoes, 1);
    // O agente de outro colaborador/dono (bob) não é alcançável por ele.
    assert.equal((await x.c.post('/api/v1/agents/bob/parar', { json: {} })).status, 403);
    assert.equal(s.rBob.rec.interrupcoes, 0);
  } finally { await s.fechar(); }
});
