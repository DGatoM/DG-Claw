'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirWeb, pastaTemp } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

const CODIGO = 'CODIGO-SECRETO-9f8e7d6c#abc';
const LINK = 'https://claude.ai/oauth/authorize?state=ESTADO-SECRETO-123';
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

async function cenario(opRunner, opServidor) {
  const runner = criarRunnerFalso(Object.assign({ agenteId: 'ana1' }, opRunner));
  const porta = await runner.ouvir();
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: pastaTemp('tr'), home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes, opcoesServidor: opServidor });
  await t.login();
  return { t, runner, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}
const J = (r) => r.json;

test('login: sem sessão 401 e sem Origin 403 nas escritas', async () => {
  const s = await cenario();
  try {
    const anon = require('./ajuda').cliente(s.t.porta);
    assert.equal((await anon.get('/api/v1/agents/ana/login')).status, 401);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/login', { json: {}, origin: false })).status, 403);
    assert.equal((await s.t.c.pedir('DELETE', '/api/v1/agents/ana/login', { origin: false })).status, 403);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/login/codigo', { json: { codigo: 'x' }, origin: 'http://outro.com' })).status, 403);
    assert.equal(s.runner.rec.loginPosts, 0);
  } finally { await s.fechar(); }
});

test('login: GET devolve estado, provedor, auth, conferido e precisa_login', async () => {
  const s = await cenario({ status: 'errored', statusReason: 'runner:sem-login', login: { estado: 'aguardando_codigo', link: LINK },
    provedor: { provedor: 'codex', auth: 'assinatura', conferido: { ok: false, detalhe: 'sem login' } } });
  try {
    const r = await s.t.c.get('/api/v1/agents/ana/login');
    assert.equal(r.status, 200);
    assert.equal(J(r).ok, true); assert.equal(J(r).estado, 'aguardando_codigo'); assert.equal(J(r).link, LINK);
    assert.equal(J(r).provedor, 'codex'); assert.equal(J(r).auth, 'assinatura');
    assert.equal(J(r).conferido.ok, false); assert.equal(J(r).precisa_login, true);
  } finally { await s.fechar(); }
});

test('login: sem /api/provedor no runner cai no provedor do registro, auth null; logado => precisa_login false', async () => {
  const s = await cenario({ status: 'idle' });
  try {
    const r = await s.t.c.get('/api/v1/agents/ana/login');
    assert.equal(r.status, 200);
    assert.equal(J(r).provedor, 'claude'); assert.equal(J(r).auth, null); assert.equal(J(r).precisa_login, false);
  } finally { await s.fechar(); }
});

test('atividade: errored + runner:sem-login vira sem_sinal com alerta sem_login', async () => {
  const s = await cenario({ status: 'errored', statusReason: 'runner:sem-login', erroEstado: 'O Claude não está logado.' });
  try {
    const a = await s.t.web.conversa.atividade(s.t.web.registro.obter('ana'));
    assert.equal(a.estado, 'sem_sinal'); assert.equal(a.alerta, 'sem_login'); assert.equal(a.motivo, 'O Claude não está logado.');
  } finally { await s.fechar(); }
});

test('atividade: errored + runner:login-expirado vira alerta login_expirado (distinto de sem_login), com expirou_em e provedor', async () => {
  const s = await cenario({ status: 'errored', statusReason: 'runner:login-expirado', erroEstado: 'O login expirou às 14:05.' });
  try {
    const a = await s.t.web.conversa.atividade(s.t.web.registro.obter('ana'));
    assert.equal(a.estado, 'sem_sinal'); assert.equal(a.alerta, 'login_expirado'); assert.equal(a.motivo, 'O login expirou às 14:05.');
    assert.equal(a.provedor, 'claude'); assert.equal(a.expirou_em, null, 'o runner falso não manda loginExpiradoEm: sem inventar hora');
    assert.ok(a.desde, 'tem desde');
  } finally { await s.fechar(); }
});

test('login: com o login expirado o GET diz precisa_login, para o cartão oferecer Conectar', async () => {
  const s = await cenario({ status: 'errored', statusReason: 'runner:login-expirado' });
  try {
    const r = await s.t.c.get('/api/v1/agents/ana/login');
    assert.equal(r.status, 200); assert.equal(J(r).precisa_login, true);
  } finally { await s.fechar(); }
});

test('enviar: o 409 LOGIN_EXPIRADO do runner chega à tela com codigo e com a causa em português', async () => {
  const s = await cenario({ status: 'errored', statusReason: 'runner:login-expirado',
    falhaInput: { status: 409, corpo: { success: false, error: 'O login da conta do Claude de ana expirou às 14:05.', howToFix: 'reconectar a conta do agente', code: 'LOGIN_EXPIRADO' } } });
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'oi, tudo bem?' } });
    assert.equal(r.status, 409); assert.equal(J(r).ok, false); assert.equal(J(r).codigo, 'LOGIN_EXPIRADO');
    assert.match(J(r).erro, /expirou às 14:05/); assert.match(J(r).erro, /reconectar a conta/);
  } finally { await s.fechar(); }
});

test('login: POST começa, codigo e DELETE repassam ao runner', async () => {
  const s = await cenario({ status: 'errored', statusReason: 'runner:sem-login' });
  try {
    const ini = await s.t.c.post('/api/v1/agents/ana/login', { json: {} });
    assert.equal(ini.status, 202); assert.equal(J(ini).estado, 'aguardando_link'); assert.equal(s.runner.rec.loginPosts, 1);
    const cod = await s.t.c.post('/api/v1/agents/ana/login/codigo', { json: { codigo: `  ${CODIGO} ` } });
    assert.equal(cod.status, 200); assert.deepEqual(s.runner.rec.codigos, [CODIGO]);
    const del = await s.t.c.pedir('DELETE', '/api/v1/agents/ana/login');
    assert.equal(del.status, 200); assert.equal(s.runner.rec.loginDeletes, 1);
    assert.equal((await s.t.c.get('/api/v1/agents/ana/login')).json.estado, 'nenhum');
  } finally { await s.fechar(); }
});

test('login: código inválido dá 400 em português sem chamar o runner', async () => {
  const s = await cenario();
  try {
    for (const corpo of [{}, { codigo: '' }, { codigo: '   ' }, { codigo: 123 }, { codigo: 'a b' }, { codigo: 'a\nb' }, { codigo: 'x'.repeat(513) }]) {
      const r = await s.t.c.post('/api/v1/agents/ana/login/codigo', { json: corpo });
      assert.equal(r.status, 400, JSON.stringify(corpo).slice(0, 40));
      assert.equal(J(r).ok, false); assert.match(J(r).erro, /código|Cole|Copie/i);
    }
    assert.deepEqual(s.runner.rec.codigos, []);
  } finally { await s.fechar(); }
});

test('login: recusa do runner (agente na API) volta com o mesmo status e error + howToFix', async () => {
  const s = await cenario({ loginRecusa: { status: 409, corpo: { error: 'O login assistido só existe para a assinatura.', howToFix: 'guardar a chave no Cofre', code: 'LOGIN_SO_NA_ASSINATURA' } } });
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/login', { json: {} });
    assert.equal(r.status, 409); assert.equal(J(r).ok, false);
    assert.match(J(r).erro, /só existe para a assinatura/); assert.match(J(r).erro, /guardar a chave no Cofre/);
  } finally { await s.fechar(); }
});

test('login: 401 do runner não vira 401 para a tela (não pode parecer sessão expirada)', async () => {
  const s = await cenario({ token: 'certo' });
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/login', { json: {} });
    assert.equal(r.status, 502); assert.match(J(r).erro, /token/i);
  } finally { await s.fechar(); }
});

test('login: runner fora do ar dá 503 com o motivo', async () => {
  const s = await cenario();
  try {
    await s.runner.fechar();
    for (const r of [await s.t.c.get('/api/v1/agents/ana/login'), await s.t.c.post('/api/v1/agents/ana/login', { json: {} }),
      await s.t.c.post('/api/v1/agents/ana/login/codigo', { json: { codigo: CODIGO } })]) {
      assert.equal(r.status, 503); assert.equal(J(r).ok, false); assert.match(J(r).erro, /runner|Ana/);
    }
  } finally { await s.t.fechar(); }
});

test('login: agente que não existe dá 404', async () => {
  const s = await cenario();
  try { assert.equal((await s.t.c.get('/api/v1/agents/nao-existe/login')).status, 404); } finally { await s.fechar(); }
});

test('login/oi: espera o runner ficar idle, entrega uma vez e a segunda chamada não repete', async () => {
  const s = await cenario({ status: 'errored', statusReason: 'runner:sem-login', provedor: { provedor: 'codex', auth: 'assinatura', conferido: { ok: true } } },
    { loginOiPassoMs: 40, loginOiPrazoMs: 4000 });
  try {
    setTimeout(() => { s.runner.opcoes.status = 'idle'; s.runner.opcoes.statusReason = null; }, 250);
    const t0 = Date.now();
    const r = await s.t.c.post('/api/v1/agents/ana/login/oi', { json: {} });
    assert.equal(r.status, 200); assert.equal(J(r).ok, true); assert.equal(J(r).ja_enviado, false);
    assert.ok(Date.now() - t0 >= 200, 'esperou o idle');
    assert.equal(s.runner.rec.inputs.length, 1);
    assert.match(s.runner.rec.inputs[0].text, /^<plataforma recado="login-concluido"[^>]*>A conta do Codex deste agente acabou de ser conectada/);
    assert.doesNotMatch(s.runner.rec.inputs[0].text, /<dgchat /, 'recado da plataforma, nunca fala do dono');
    const de_novo = await s.t.c.post('/api/v1/agents/ana/login/oi', { json: {} });
    assert.equal(de_novo.status, 200); assert.equal(J(de_novo).ja_enviado, true);
    assert.equal(s.runner.rec.inputs.length, 1);
  } finally { await s.fechar(); }
});

test('login/oi: agente que não fica idle no prazo dá 504 e não trava uma nova tentativa', async () => {
  const s = await cenario({ status: 'errored', statusReason: 'runner:sem-login' }, { loginOiPassoMs: 30, loginOiPrazoMs: 250 });
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/login/oi', { json: {} });
    assert.equal(r.status, 504); assert.equal(J(r).ok, false); assert.match(J(r).erro, /não ficou pronto/); assert.match(J(r).erro, /errored|runner:sem-login/);
    assert.equal(s.runner.rec.inputs.length, 0);
    s.runner.opcoes.status = 'idle';
    const outra = await s.t.c.post('/api/v1/agents/ana/login/oi', { json: {} });
    assert.equal(outra.status, 200); assert.equal(J(outra).ja_enviado, false);
    assert.equal(s.runner.rec.inputs.length, 1);
  } finally { await s.fechar(); }
});

test('login: o log não contém o código nem o link', async () => {
  const s = await cenario({ login: { estado: 'aguardando_codigo', link: LINK }, status: 'idle' }, { loginOiPassoMs: 20 });
  try {
    await s.t.c.get('/api/v1/agents/ana/login');
    await s.t.c.post('/api/v1/agents/ana/login', { json: {} });
    await s.t.c.post('/api/v1/agents/ana/login/codigo', { json: { codigo: CODIGO } });
    await s.t.c.post('/api/v1/agents/ana/login/codigo', { json: { codigo: 'com espaço' } });
    await s.t.c.pedir('DELETE', '/api/v1/agents/ana/login');
    s.runner.opcoes.loginRecusa = { status: 500, corpo: { error: 'falhou' } };
    await s.t.c.post('/api/v1/agents/ana/login/codigo', { json: { codigo: CODIGO } });
    const log = s.t.log.texto();
    assert.ok(/Login de ana/.test(log), 'o log registra o login');
    assert.ok(!log.includes(CODIGO) && !log.includes('SECRETO'), 'sem código nem link no log');
  } finally { await s.fechar(); }
});

test('login: docs.md é servido para quem tem sessão', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.get('/api/v1/login/docs.md');
    assert.equal(r.status, 200); assert.match(r.texto, /login\/codigo/);
  } finally { await s.fechar(); }
});
