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

test('vídeos estáticos: Content-Type, Range 206, sufixo, 416 e sem path traversal', async () => {
  const s = await cenario();
  try {
    fs.mkdirSync(path.join(s.t.publico, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(s.t.publico, 'videos', 'v.mp4'), '0123456789ABCDEFGHIJ');
    fs.writeFileSync(path.join(s.t.publico, 'videos', 'v.jpg'), 'jpg');
    const inteiro = await s.t.c.get('/videos/v.mp4');
    assert.equal(inteiro.status, 200);
    assert.equal(inteiro.headers['content-type'], 'video/mp4');
    assert.equal(inteiro.headers['accept-ranges'], 'bytes');
    assert.equal((await s.t.c.get('/videos/v.jpg')).headers['content-type'], 'image/jpeg');
    const h = (range) => s.t.c.get('/videos/v.mp4', { headers: { Range: range } });
    const r1 = await h('bytes=0-9');
    assert.equal(r1.status, 206); assert.equal(r1.headers['content-range'], 'bytes 0-9/20'); assert.equal(r1.texto, '0123456789');
    assert.equal(r1.headers['content-length'], '10');
    const r2 = await h('bytes=15-'); assert.equal(r2.status, 206); assert.equal(r2.headers['content-range'], 'bytes 15-19/20'); assert.equal(r2.texto, 'FGHIJ');
    const r3 = await h('bytes=-4'); assert.equal(r3.status, 206); assert.equal(r3.headers['content-range'], 'bytes 16-19/20'); assert.equal(r3.texto, 'GHIJ');
    const r4 = await h('bytes=10-999'); assert.equal(r4.headers['content-range'], 'bytes 10-19/20');
    for (const ruim of ['bytes=30-40', 'bytes=9-2', 'bytes=-', 'bytes=abc', 'bytes=-0']) {
      const r = await h(ruim);
      assert.equal(r.status, 416, ruim); assert.equal(r.headers['content-range'], 'bytes */20', ruim);
    }
    assert.equal((await h('bytes=0-1,5-6')).status, 200, 'vários intervalos: serve inteiro');
    assert.equal((await s.t.c.pedir('HEAD', '/videos/v.mp4', { headers: { Range: 'bytes=0-4' } })).status, 206);
    // fora da pasta pública
    for (const p of ['/videos/../../etc/passwd', '/videos/%2e%2e/%2e%2e/etc/passwd']) assert.notEqual((await s.t.c.get(p)).status, 200, p);
    // estático não exige sessão, como os outros arquivos da pasta pública
    assert.equal((await cliente(s.t.porta).get('/videos/v.mp4', { origin: false })).status, 200);
    // fora do pre-cache do service worker
    assert.ok(!lePub('sw.js').includes('/videos/'));
  } finally { await s.fechar(); }
});

test('a página real tem a seção #cnPronto e o vídeo com erro some sozinho', () => {
  const html = lePub('conectar.html');
  assert.match(html, /id="cnPronto"[^>]*hidden/);
  assert.ok(!/cnTudo/.test(html));
  const js = lePub('conectar.js');
  assert.match(js, /\/videos\/conhecendo-o-dgclaw\.mp4/);
  assert.match(js, /\/videos\/conhecendo-o-dgclaw\.jpg/);
  assert.match(js, /alvo: '#cnPronto'/);
});
