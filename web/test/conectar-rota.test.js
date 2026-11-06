'use strict';
// A página /conectar: rota atrás da sessão, docs atrás da sessão, o campo login_expirado do GET de login
// e a ligação da página (HTML, menu, pop-up de login expirado, service worker).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

const PUB = path.join(__dirname, '..', 'public');
const lePub = (n) => fs.readFileSync(path.join(PUB, n), 'utf8');

async function cenario(opRunner) {
  const runner = criarRunnerFalso(Object.assign({ agenteId: 'ana1' }, opRunner));
  const porta = await runner.ouvir();
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: pastaTemp('tr'), home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes });
  await t.login();
  return { t, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}

test('/conectar sem sessão vai para o login com next; com sessão serve o HTML', async () => {
  const s = await cenario();
  try {
    fs.writeFileSync(path.join(s.t.publico, 'conectar.html'), '<html>conectar de teste</html>');
    const anon = cliente(s.t.porta);
    for (const p of ['/conectar', '/conectar/']) {
      const sem = await anon.get(p, { origin: false });
      assert.equal(sem.status, 302);
      assert.equal(sem.headers.location, '/login?next=' + encodeURIComponent(p));
    }
    const r = await s.t.c.get('/conectar');
    assert.equal(r.status, 200);
    assert.match(r.texto, /conectar de teste/);
    assert.equal((await s.t.c.get('/conectar/')).status, 200);
  } finally { await s.fechar(); }
});

test('/conectar sem o arquivo da tela explica o que faltou', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.get('/conectar', { headers: { Accept: 'text/html' } });
    assert.equal(r.status, 500);
    assert.match(r.texto, /Reinstale o DG Claw Web/);
  } finally { await s.fechar(); }
});

test('/login?next=/conectar volta para a página depois de entrar', async () => {
  const s = await cenario();
  try {
    const anon = cliente(s.t.porta);
    const r = await s.t.c.get('/login?next=' + encodeURIComponent('/conectar'), { origin: false });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/conectar');
    assert.equal((await anon.get('/login?next=' + encodeURIComponent('/conectar'), { origin: false })).status, 200);
  } finally { await s.fechar(); }
});

test('docs da página: 401 sem sessão, markdown com a sessão e sem travessão', async () => {
  const s = await cenario();
  try {
    assert.equal((await cliente(s.t.porta).get('/api/v1/conectar/docs.md', { origin: false })).status, 401);
    const r = await s.t.c.get('/api/v1/conectar/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/markdown/);
    assert.match(r.texto, /Página Conectar conta/);
    assert.ok(!/[—–]/.test(r.texto));
    for (const rota of ['GET /api/v1/agents/<id>/login', 'POST /api/v1/agents/<id>/login/codigo', 'DELETE /api/v1/agents/<id>/login', 'POST /api/v1/agents/<id>/login/oi']) assert.ok(r.texto.includes(rota), rota);
  } finally { await s.fechar(); }
});

test('GET de login: login_expirado só quando o runner informa login-expirado', async () => {
  const exp = await cenario({ status: 'errored', statusReason: 'runner:login-expirado', provedor: { provedor: 'claude', auth: 'assinatura', conferido: { ok: true } } });
  try {
    const r = await exp.t.c.get('/api/v1/agents/ana/login');
    assert.equal(r.json.login_expirado, true);
    assert.equal(r.json.precisa_login, true);
  } finally { await exp.fechar(); }
  const sem = await cenario({ status: 'errored', statusReason: 'runner:sem-login' });
  try {
    const r = await sem.t.c.get('/api/v1/agents/ana/login');
    assert.equal(r.json.login_expirado, false);
    assert.equal(r.json.precisa_login, true);
  } finally { await sem.fechar(); }
});

test('a página real carrega os scripts certos e todos existem', () => {
  const html = lePub('conectar.html');
  for (const s of ['/tour.js', '/menu-lado.js', '/casca.js', '/login-cartao.js', '/conectar-puro.js', '/conectar.js', '/conectar.css']) {
    assert.ok(html.includes(s), 'falta ' + s);
    assert.ok(fs.existsSync(path.join(PUB, s)), 'não existe ' + s);
  }
  assert.match(html, /pagina: 'conectar'/);
  // login-cartao e conectar-puro antes de conectar.js
  assert.ok(html.indexOf('/conectar-puro.js') < html.indexOf('/conectar.js'));
  assert.ok(html.indexOf('/login-cartao.js') < html.indexOf('/conectar-puro.js'));
  const sw = lePub('sw.js');
  for (const s of ['/conectar.js', '/conectar.css', '/conectar-puro.js']) assert.ok(sw.includes("'" + s + "'"), 'sw sem ' + s);
});

test('menu: item Conectar conta com 🔑 e o reconhecimento da página', () => {
  const M = require('../public/menu-lado');
  assert.deepEqual(M.LINK_CONECTAR, { nome: 'Conectar conta', ico: '🔑', href: '/conectar' });
  assert.equal(M.chaveDoHref('/conectar?a=ana'), 'conectar');
  assert.equal(M.chaveDoHref('/conectar/'), 'conectar');
});

test('pop-up de login expirado tem o link discreto para a página', () => {
  assert.match(lePub('conversa.html'), /<a href="\/conectar">Abrir a página Conectar conta<\/a>/);
  assert.match(lePub('conversa.js'), /\$\('leConectar'\)\.hidden = f === 'pronto'/);
  assert.match(lePub('login-expirado.css'), /\.le-conectar/);
});
