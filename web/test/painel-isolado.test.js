'use strict';
// Painel isolado: o painel do agente roda numa origem opaca (iframe sandbox) e fala com a própria API por um token
// no caminho (/pv/<token>/...). Estes testes provam a fronteira: o cookie do dono não vale fora da origem do Web,
// o token só abre o agente dele, e tudo o que o /p/ nega o /pv/ também nega.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pastaTemp, cliente } = require('./ajuda');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');
const { criarPainelToken } = require('../lib/painel-token');

const SEGREDO_DO_PROXY = 'segredo-do-proxy-so-para-teste-4321';

/** Painel falso: guarda o que recebeu e responde com cabeçalhos "hostis" (cookie, CORS aberto, CSP própria). */
function painelFalso() {
  const visto = [];
  const sockets = new Set();
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      visto.push({ metodo: req.method, url: req.url, headers: req.headers, corpo: Buffer.concat(partes).toString('utf8') });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'dash=1; Path=/',
        'Access-Control-Allow-Origin': 'https://mal.example',
        'Access-Control-Allow-Credentials': 'true',
        'Content-Security-Policy': "default-src 'self'",
        'Referrer-Policy': 'same-origin',
        'Cache-Control': 'public, max-age=31536000, immutable',
        Expires: 'Wed, 01 Jan 2031 00:00:00 GMT',
      });
      res.end(JSON.stringify({ ok: true, do_painel: true }));
    });
  });
  servidor.on('upgrade', (req, socket) => {
    visto.push({ metodo: 'UPGRADE', url: req.url, headers: req.headers });
    sockets.add(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('eco:'), d])));
    socket.on('error', () => socket.destroy());
  });
  return {
    visto,
    ouvir: () => new Promise((r) => servidor.listen(0, '127.0.0.1', () => r(servidor.address().port))),
    fechar: () => new Promise((r) => { for (const x of sockets) x.destroy(); servidor.closeAllConnections(); servidor.close(() => r()); }),
  };
}

async function montar() {
  const painel = painelFalso();
  const porta = await painel.ouvir();
  const arq = path.join(pastaTemp('proxy'), 'proxy.txt');
  fs.writeFileSync(arq, `${SEGREDO_DO_PROXY}\n`);
  const s = await cenario({ painelAna: { porta_painel: porta, proxy_segredo_arquivo: arq } });
  // A moldura é um arquivo de web/public: o teste usa o verdadeiro.
  for (const f of ['painel.html']) fs.copyFileSync(path.join(__dirname, '..', 'public', f), path.join(s.t.publico, f));
  const dono = s.dono;
  const mintar = async (cli, slug) => {
    const r = await cli.post(`/api/v1/agents/${slug}/painel-token`);
    assert.equal(r.status, 200, r.texto);
    return r.json.token;
  };
  // Cliente do painel isolado: sem cookie, com a origem opaca.
  const anonimo = cliente(s.t.porta);
  const pv = (metodo, token, resto, o) => anonimo.pedir(metodo, `/pv/${token}${resto}`, Object.assign({ semCookie: true, origin: 'null' }, o || {}));
  const fechar = async () => { await s.fechar(); await painel.fechar(); };
  return { s, painel, dono, mintar, pv, fechar, porta: s.t.porta };
}

const ORIGEM = (porta) => `http://127.0.0.1:${porta}`;

test('a API do Web não aceita o cookie do dono vindo de origem opaca nem de outro site; a tela do Web segue funcionando', async () => {
  const m = await montar();
  try {
    const h = (o) => ({ headers: o });
    assert.equal((await m.dono.get('/api/v1/agents', { origin: 'null' })).status, 403, 'Origin null');
    assert.equal((await m.dono.get('/api/v1/agents', { origin: 'https://mal.example' })).status, 403, 'outro Origin');
    assert.equal((await m.dono.get('/api/v1/agents', h({ 'Sec-Fetch-Site': 'cross-site' }))).status, 403, 'cross-site');
    assert.equal((await m.dono.get('/api/v1/agents', h({ 'Sec-Fetch-Site': 'same-site' }))).status, 403, 'same-site');
    // escrita: mandar mensagem ao Admin
    for (const extra of [{ origin: 'null' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }, { origin: false, headers: { 'Sec-Fetch-Site': 'same-site' } }]) {
      const r = await m.dono.post('/api/v1/agents/admin/send', Object.assign({ json: { text: 'oi' } }, extra));
      assert.equal(r.status, 403, JSON.stringify(extra));
      assert.ok(r.json && r.json.erro, 'o motivo vem em português');
    }
    // o que continua valendo: mesma origem (sem cabeçalhos de busca, ou same-origin) e o dono que digitou o endereço (none)
    assert.equal((await m.dono.get('/api/v1/agents')).status, 200);
    assert.equal((await m.dono.get('/api/v1/agents', h({ 'Sec-Fetch-Site': 'same-origin' }))).status, 200);
    assert.equal((await m.dono.get('/api/v1/agents', { origin: false, headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
    assert.equal((await m.dono.get('/api/v1/agents', { origin: false })).status, 200, 'GET da própria tela não manda Origin');
    // rotas públicas não mudam
    assert.equal((await cliente(m.porta).get('/api/saude', { origin: 'null' })).status, 200);
    assert.equal((await cliente(m.porta).get('/api/login-estado', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
    // quem pede o token precisa estar na própria tela
    assert.equal((await m.dono.post('/api/v1/agents/ana/painel-token', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await m.dono.post('/api/v1/agents/ana/painel-token', { origin: 'null' })).status, 403);
  } finally { await m.fechar(); }
});

test('/p/<agente>/api com o cookie do dono: origem opaca ou outro site levam 403 e nada chega ao painel; mesma origem passa', async () => {
  const m = await montar();
  try {
    assert.equal((await m.dono.get('/p/ana/api/estado', { origin: 'null' })).status, 403);
    assert.equal((await m.dono.get('/p/ana/api/estado', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await m.dono.get('/p/ana/api/estado', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal((await m.dono.get('/p/ana/api/estado', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 403, 'em /p/ o none só vale para navegação');
    assert.equal((await m.dono.post('/p/ana/api/acao', { json: {}, origin: 'null' })).status, 403);
    assert.equal(m.painel.visto.length, 0);
    const ok = await m.dono.get('/p/ana/api/estado', { headers: { 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json' } });
    assert.equal(ok.status, 200);
    assert.equal(m.painel.visto.length, 1);
  } finally { await m.fechar(); }
});

test('navegação a /p/<agente>/... devolve a moldura (iframe sandbox sem allow-same-origin), nunca o HTML do painel', async () => {
  const m = await montar();
  try {
    for (const cab of [{ Accept: 'text/html,application/xhtml+xml' }, { 'Sec-Fetch-Dest': 'document', Accept: '*/*' }]) {
      const r = await m.dono.get('/p/ana/x?y=1', { headers: cab });
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.match(r.texto, /<iframe id="painelQuadro"/);
      const sandbox = /sandbox="([^"]*)"/.exec(r.texto)[1];
      assert.ok(sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin') && !sandbox.includes('allow-top-navigation'), sandbox);
      assert.match(r.texto, /referrerpolicy="no-referrer"/);
      assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
      assert.ok(!r.texto.includes('do_painel'));
    }
    assert.equal(m.painel.visto.length, 0, 'a navegação não chega ao painel');
    // sem sessão: continua mandando para o login
    const anon = await cliente(m.porta).get('/p/ana/', { headers: { Accept: 'text/html' } });
    assert.equal(anon.status, 302);
    // o link velho /p/<agente> sem barra continua indo para /p/<agente>/
    assert.equal((await m.dono.get('/p/ana', { headers: { Accept: 'text/html' } })).status, 302);
  } finally { await m.fechar(); }
});

test('/pv/<token>: chega ao painel com a base nova, sem nenhum cookie, e aceita POST com Origin null ou sem Origin', async () => {
  const m = await montar();
  try {
    const tok = await m.mintar(m.dono, 'ana');
    assert.match(tok, /^[A-Za-z0-9_.-]+$/);
    const r = await m.pv('GET', tok, '/api/estado?x=1', { headers: { Cookie: `dgclaw_sessao=${m.dono.jar.dgclaw_sessao}; outro=1`, 'X-DGClaw-Base': '/pv/forjado', 'X-DGClaw-Proxy': 'forjado', Accept: 'application/json' } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.do_painel, true);
    const v = m.painel.visto[0];
    assert.equal(v.url, '/p/ana/api/estado?x=1');
    assert.equal(v.headers['x-dgclaw-base'], `/pv/${tok}`);
    assert.equal(v.headers['x-dgclaw-proxy'], SEGREDO_DO_PROXY);
    assert.equal(v.headers.cookie, undefined, 'nenhum cookie vai ao painel isolado, nem o dele');
    const post = await m.pv('POST', tok, '/api/acao', { json: { a: 1 } });
    assert.equal(post.status, 200);
    assert.equal(m.painel.visto[1].corpo, '{"a":1}');
    assert.equal((await m.pv('POST', tok, '/api/acao', { json: { a: 2 }, origin: false })).status, 200, 'sem Origin');
    // raiz do painel e caminho com barra final
    assert.equal((await m.pv('GET', tok, '/', { headers: { Accept: 'text/html' } })).status, 200);
    assert.equal(m.painel.visto.at(-1).url, '/p/ana/');
    // outro Origin (inclusive o do próprio Web) não escreve por aqui
    for (const origem of ['https://mal.example', ORIGEM(m.porta)]) {
      const mal = await m.pv('POST', tok, '/api/acao', { json: { a: 3 }, origin: origem });
      assert.equal(mal.status, 403, origem);
    }
    assert.ok(!m.painel.visto.some((x) => x.corpo.includes('"a":3')));
  } finally { await m.fechar(); }
});

test('/pv/: token adulterado, de outro agente, sem MAC, expirado ou de sessão encerrada leva 401 com o motivo', async () => {
  const m = await montar();
  try {
    const tok = await m.mintar(m.dono, 'ana');
    const [corpo, mac] = tok.split('.');
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    const reescrito = Buffer.from(JSON.stringify({ ...dados, s: 'bob' })).toString('base64url');
    const estendido = Buffer.from(JSON.stringify({ ...dados, e: dados.e + 99999 })).toString('base64url');
    const ruins = [
      `${reescrito}.${mac}`, `${estendido}.${mac}`, `${corpo}.${mac.slice(0, -2)}AA`, `${corpo}.`, corpo, `${corpo}.${mac}x`,
      'a'.repeat(40), `${'A'.repeat(30)}.${'B'.repeat(43)}`,
    ];
    for (const t of ruins) {
      const r = await m.pv('GET', t, '/api/estado');
      assert.equal(r.status, 401, t.slice(0, 30));
      assert.match(r.json.erro, /expirou|não é válido|malformado/);
    }
    assert.equal((await m.pv('GET', tok, '/api/estado', { headers: { Accept: 'text/html' } })).status, 200);
    // pedido de navegação com token ruim: página curta com o motivo e o aviso à moldura
    const pag = await m.pv('GET', ruins[0], '/', { headers: { Accept: 'text/html' } });
    assert.equal(pag.status, 401);
    assert.match(pag.texto, /O acesso deste painel expirou|não é válido/);
    assert.match(pag.texto, /postMessage/);
    assert.ok(!/allow-same-origin/.test(pag.headers['content-security-policy']));
    assert.equal(m.painel.visto.filter((x) => x.url.includes('estado')).length, 1, 'só o token bom chegou ao painel');
  } finally { await m.fechar(); }
});

test('/pv/: logout, expiração e agente sem painel invalidam o token na hora', async () => {
  const m = await montar();
  try {
    const outro = cliente(m.porta);
    await m.s.t.login(outro);
    const tok = await m.mintar(outro, 'ana');
    assert.equal((await m.pv('GET', tok, '/api/estado')).status, 200);
    await outro.post('/sair', { origin: ORIGEM(m.porta) });
    const r = await m.pv('GET', tok, '/api/estado');
    assert.equal(r.status, 401);
    assert.equal(r.json.erro, 'O acesso deste painel expirou. Recarregue a página.');

    // expirado: 12 h depois o token deixa de valer mesmo com a sessão de pé
    const tok2 = await m.mintar(m.dono, 'ana');
    assert.equal((await m.pv('GET', tok2, '/api/estado')).status, 200);
    m.s.relogio.t += 12 * 3600 * 1000 + 5000;
    assert.equal((await m.pv('GET', tok2, '/api/estado')).status, 401);
    m.s.relogio.t -= 12 * 3600 * 1000 + 5000;

    // token assinado para um agente sem painel (ou que não existe) não abre nada
    const pt = criarPainelToken({ dataDir: m.s.t.dados, agora: () => m.s.relogio.t });
    const id = m.s.t.web.auth.idPainelDe(m.dono.jar.dgclaw_sessao ? { headers: { cookie: `dgclaw_sessao=${m.dono.jar.dgclaw_sessao}` } } : null);
    assert.ok(id, 'o dono tem identificador de painel');
    for (const slug of ['bob', 'nao-existe', '../x']) {
      const t = pt.emitir({ slug, id, sessaoExpiraMs: m.s.relogio.t + 3600 * 1000 }).token;
      const x = await m.pv('GET', t, '/api/estado');
      assert.equal(x.status, 404, slug);
    }
    // o endpoint também recusa agente sem painel
    assert.equal((await m.dono.post('/api/v1/agents/bob/painel-token')).status, 404);
    assert.equal((await m.dono.get('/api/v1/agents/ana/painel-token')).status, 405);
    assert.equal((await cliente(m.porta).post('/api/v1/agents/ana/painel-token')).status, 401);
    assert.equal(m.painel.visto.filter((x) => x.url.includes('estado')).length, 2);
  } finally { await m.fechar(); }
});

function trocaInstanciaAna(m, instancia) {
  const j = JSON.parse(fs.readFileSync(m.s.t.agentesPath, 'utf8'));
  for (const a of j.agentes) if (a.slug === 'ana') a.instancia = instancia;
  fs.writeFileSync(m.s.t.agentesPath, JSON.stringify(j));
  const futuro = new Date(Date.now() + 5000); fs.utimesSync(m.s.t.agentesPath, futuro, futuro);
}

test('/pv/: token de agente removido e recriado com o mesmo nome (instância nova) é recusado', async () => {
  const m = await montar();
  try {
    trocaInstanciaAna(m, 'primeira-1');
    const tok = await m.mintar(m.dono, 'ana');
    assert.equal((await m.pv('GET', tok, '/api/estado')).status, 200);
    trocaInstanciaAna(m, 'segunda-2');
    const r = await m.pv('GET', tok, '/api/estado');
    assert.equal(r.status, 401);
    assert.equal(r.json.erro, 'O acesso deste painel expirou. Recarregue a página.');
    assert.equal((await m.pv('GET', await m.mintar(m.dono, 'ana'), '/api/estado')).status, 200, 'o token novo vale');
  } finally { await m.fechar(); }
});

test('WebSocket por /pv/ fecha na revalidação quando o agente é recriado (instância muda)', async () => {
  const m = await montar();
  try {
    trocaInstanciaAna(m, 'primeira-1');
    const tok = await m.mintar(m.dono, 'ana');
    const w = await wsAberto(m.porta, `/pv/${tok}/tela/websockify`);
    assert.equal(w.status, 101);
    m.s.t.web.proxy.revalidar();
    assert.equal(await caiu(w), false);
    trocaInstanciaAna(m, 'segunda-2');
    m.s.t.web.proxy.revalidar();
    assert.equal(await caiu(w), true);
  } finally { await m.fechar(); }
});

test('/pv/: trocar a senha do dono derruba o token na hora', async () => {
  const m = await montar();
  try {
    const tok = await m.mintar(m.dono, 'ana');
    assert.equal((await m.pv('GET', tok, '/api/estado')).status, 200);
    const novo = require('./ajuda').gerarHash('outra-senha-bem-longa-9');
    assert.equal(m.s.t.web.auth.definirHash(novo).ok, true);
    assert.equal((await m.pv('GET', tok, '/api/estado')).status, 401);
  } finally { await m.fechar(); }
});

test('/pv/: caminhos com desvio (.., %2e, contrabarra) são recusados antes de chegar ao painel', async () => {
  const m = await montar();
  try {
    const tok = await m.mintar(m.dono, 'ana');
    for (const resto of ['/../api/v1/agents', '/x/../../api/v1/agents', '/%2e%2e/api/v1/agents', '/x/%2E%2e/y', '/x\\y', '/x%5cy', '/./x']) {
      const r = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: m.porta, method: 'GET', path: `/pv/${tok}${resto}`, headers: {} }, (res) => {
          const p = []; res.on('data', (d) => p.push(d)); res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(p).toString('utf8') }));
        });
        req.on('error', reject); req.end();
      });
      assert.equal(r.status, 400, resto);
    }
    assert.equal(m.painel.visto.length, 0);
  } finally { await m.fechar(); }
});

test('cabeçalhos de /pv/: CSP sandbox sem allow-same-origin (e a do painel preservada), CORS sem credencial, sem Set-Cookie; preflight responde', async () => {
  const m = await montar();
  try {
    const tok = await m.mintar(m.dono, 'ana');
    const r = await m.pv('GET', tok, '/api/estado');
    const csp = String(r.headers['content-security-policy']);
    assert.match(csp, /default-src 'self'/, 'a CSP do painel fica');
    assert.match(csp, /sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads/, 'a nossa entra');
    assert.ok(!/frame-ancestors/.test(csp), 'sem frame-ancestors: a Tela (iframe aninhado) precisa enquadrar sob origem opaca');
    assert.ok(csp.indexOf("default-src 'self'") < csp.indexOf('sandbox allow-scripts'), 'a nossa é o segundo cabeçalho');
    assert.ok(!/allow-same-origin|allow-top-navigation/.test(csp));
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['access-control-allow-credentials'], undefined);
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store', 'o cache imutável do painel não vale: o endereço leva o token');
    assert.equal(r.headers.expires, undefined);

    const pre = await m.pv('OPTIONS', tok, '/api/acao', { headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], '*');
    assert.match(pre.headers['access-control-allow-methods'], /POST/);
    assert.match(pre.headers['access-control-allow-headers'].toLowerCase(), /content-type/);
    assert.equal(pre.headers['access-control-allow-credentials'], undefined);
    assert.equal(pre.headers['cache-control'], 'no-store');
    assert.equal(m.painel.visto.length, 1, 'o preflight não chega ao painel');

    // as respostas do próprio Web em /pv/ (erro de escopo, 401) levam o mesmo conjunto
    const neg = await m.pv('GET', tok, '/logs');
    assert.equal(neg.status, 403);
    assert.equal(neg.headers['access-control-allow-origin'], '*');
    assert.match(String(neg.headers['content-security-policy']), /^sandbox allow-scripts/);
    const inv = await m.pv('GET', 'x'.repeat(30), '/api/estado');
    assert.equal(inv.headers['access-control-allow-origin'], '*');
    assert.equal(inv.headers['cache-control'], 'no-store');
    assert.equal(neg.headers['cache-control'], 'no-store');
  } finally { await m.fechar(); }
});

test('/p/ repassado: CSP sandbox com default-src none, sem Set-Cookie nem CORS do painel', async () => {
  const m = await montar();
  try {
    const r = await m.dono.get('/p/ana/api/estado', { headers: { Accept: 'application/json' } });
    assert.equal(r.status, 200);
    const csp = String(r.headers['content-security-policy']);
    assert.match(csp, /sandbox; default-src 'none'/);
    assert.match(csp, /default-src 'self'/, 'a do painel fica');
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(r.headers['access-control-allow-credentials'], undefined);
  } finally { await m.fechar(); }
});

test('colaborador: o que o escopo nega em /p/ também é negado em /pv/, logs inclusive; o que passa em /p/ passa em /pv/', async () => {
  const m = await montar();
  try {
    const x = await colaboradorAtivo(m.s);
    const tok = await m.mintar(x.c, 'ana');
    assert.equal((await x.c.post('/api/v1/agents/bob/painel-token')).status, 403, 'o colaborador não pede o token de outro agente');
    for (const [metodo, resto] of [['GET', '/api/cofre'], ['POST', '/api/chat/mensagem'], ['GET', '/api/chaves-api'], ['POST', '/api/provedor'], ['GET', '/api/tela'],
      ['POST', '/api/sessoes'], ['POST', '/api/sessoes/abc/decidir'], ['POST', '/api/canais/telegram'], ['PUT', '/api/memoria/arquivo'], ['GET', '/api%2fcofre'], ['GET', '/logs'], ['GET', '/api/v1/logs/x']]) {
      const r = await m.pv(metodo, tok, resto, metodo === 'GET' ? {} : { json: {} });
      assert.equal(r.status, 403, `${metodo} ${resto}: ${r.status} ${r.texto}`);
    }
    assert.equal(m.painel.visto.length, 0, `nada disso chega ao painel: ${JSON.stringify(m.painel.visto.map((v) => v.url))}`);
    for (const resto of ['/api/memory', '/api/sessoes', '/']) {
      const r = await m.pv('GET', tok, resto);
      assert.equal(r.status, 200, resto);
    }
    assert.equal((await m.pv('POST', tok, '/api/sessoes/abc/arquivar', { json: {} })).status, 200);
    const antes = m.painel.visto.length;
    // os logs também são fechados para o dono: nenhum painel os serve
    const dono = await m.mintar(m.dono, 'ana');
    for (const resto of ['/logs', '/api/v1/logs', '/LOGS/x', '/%6cogs']) {
      assert.equal((await m.pv('GET', dono, resto)).status, 403, resto);
    }
    assert.equal(m.painel.visto.length, antes);
    // colaborador revogado: o token cai na hora
    assert.equal((await m.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`)).status, 200);
    const r = await m.pv('GET', tok, '/api/memory');
    assert.equal(r.status, 401);
  } finally { await m.fechar(); }
});

test('autoria: o envio do painel do dono por /pv/ conta como do dono, como em /p/', async () => {
  const m = await montar();
  try {
    const tok = await m.mintar(m.dono, 'ana');
    const r = await m.pv('POST', tok, '/api/chat/mensagem', { json: { texto: 'oi' } });
    assert.equal(r.status, 200);
    const v = m.painel.visto.at(-1);
    assert.equal(v.headers['x-dgclaw-papel'], 'dono');
    assert.equal(v.url, '/p/ana/api/chat/mensagem');
  } finally { await m.fechar(); }
});

function abreWs(porta, caminho, headers) {
  return new Promise((resolve) => {
    const limite = setTimeout(() => resolve({ erro: 'sem resposta' }), 3000);
    limite.unref();
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, headers: Object.assign({ Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' }, headers || {}) }); // gitleaks:allow
    req.on('upgrade', (res, socket) => {
      socket.write('ping');
      socket.once('data', (d) => { socket.destroy(); clearTimeout(limite); resolve({ status: res.statusCode, eco: d.toString() }); });
    });
    req.on('response', (res) => { res.resume(); clearTimeout(limite); resolve({ status: res.statusCode }); });
    req.on('error', (e) => resolve({ erro: e.code }));
    req.end();
  });
}

test('WebSocket por /pv/<token>: aceito com Origin null, recusado com token ruim, outro Origin ou escopo de colaborador', async () => {
  const m = await montar();
  try {
    const tok = await m.mintar(m.dono, 'ana');
    const ok = await abreWs(m.porta, `/pv/${tok}/tela/websockify?x=1`, { Origin: 'null' });
    assert.equal(ok.status, 101);
    assert.equal(ok.eco, 'eco:ping');
    const v = m.painel.visto.at(-1);
    assert.equal(v.url, '/p/ana/tela/websockify?x=1');
    assert.equal(v.headers.cookie, undefined);
    assert.equal(v.headers['x-dgclaw-base'], `/pv/${tok}`);
    assert.equal((await abreWs(m.porta, `/pv/${tok}/tela/websockify`)).status, 101, 'sem Origin');
    assert.notEqual((await abreWs(m.porta, `/pv/${tok.slice(0, -3)}AAA/tela/websockify`, { Origin: 'null' })).status, 101, 'token adulterado');
    assert.notEqual((await abreWs(m.porta, `/pv/${'z'.repeat(40)}/tela/websockify`, { Origin: 'null' })).status, 101, 'token inventado');
    assert.equal((await abreWs(m.porta, `/pv/${tok}/tela/websockify`, { Origin: 'https://mal.example' })).status, 403);
    assert.equal((await abreWs(m.porta, `/pv/${tok}/tela/websockify`, { Origin: ORIGEM(m.porta) })).status, 403, 'nem o Origin do Web: o cookie não é a credencial aqui');
    // com o cookie do dono mas sem token, de origem opaca: nada
    const cookie = `dgclaw_sessao=${m.dono.jar.dgclaw_sessao}`;
    assert.notEqual((await abreWs(m.porta, '/p/ana/tela/websockify', { Origin: 'null', Cookie: cookie })).status, 101);

    const x = await colaboradorAtivo(m.s);
    const tokC = await m.mintar(x.c, 'ana');
    assert.equal((await abreWs(m.porta, `/pv/${tokC}/tela/websockify`, { Origin: 'null' })).status, 403, 'a Tela é do dono');
  } finally { await m.fechar(); }
});

test('o WebSocket de colaborador por /pv/ fecha quando o acesso é revogado', async () => {
  const m = await montar();
  try {
    const x = await colaboradorAtivo(m.s);
    const tok = await m.mintar(x.c, 'ana');
    // a Tela é fechada ao colaborador; o escopo de WebSocket só abre /p/<dele>/** que não seja Tela: usa um caminho do painel
    const ws = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: m.porta, path: `/pv/${tok}/api/eventos`, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: 'null' } }); // gitleaks:allow
      req.on('upgrade', (res, socket) => { resolve({ socket, status: res.statusCode }); });
      req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
      req.on('error', (e) => resolve({ erro: e.code }));
      req.end();
    });
    assert.equal(ws.status, 101);
    const fechou = new Promise((r) => ws.socket.on('close', r));
    assert.equal((await m.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`)).status, 200);
    const limite = new Promise((r) => setTimeout(() => r('aberto'), 4000));
    m.s.t.web.proxy.revalidar();
    assert.notEqual(await Promise.race([fechou.then(() => 'fechou'), limite]), 'aberto', 'a conexão devia ter caído');
  } finally { await m.fechar(); }
});

function wsAberto(porta, caminho) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: 'null' } }); // gitleaks:allow
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket, fechou: new Promise((r) => socket.on('close', r)) }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', (e) => resolve({ erro: e.code }));
    req.end();
  });
}
const caiu = (ws) => Promise.race([ws.fechou.then(() => true), new Promise((r) => setTimeout(() => r(false), 1500))]);

test('WebSocket por /pv/ do DONO fecha na revalidação: logout, troca de senha e prazo do token', async () => {
  const m = await montar();
  try {
    const revalida = () => m.s.t.web.proxy.revalidar();
    // logout
    const outro = cliente(m.porta);
    await m.s.t.login(outro);
    const t1 = await m.mintar(outro, 'ana');
    const w1 = await wsAberto(m.porta, `/pv/${t1}/tela/websockify`);
    assert.equal(w1.status, 101);
    revalida();
    assert.equal(await caiu(w1), false, 'com a sessão de pé, segue aberto');
    await outro.post('/sair', { origin: ORIGEM(m.porta) });
    revalida();
    assert.equal(await caiu(w1), true, 'logout fecha o socket');
    // prazo do token (relógio falso)
    const t2 = await m.mintar(m.dono, 'ana');
    const w2 = await wsAberto(m.porta, `/pv/${t2}/tela/websockify`);
    assert.equal(w2.status, 101);
    m.s.relogio.t += 12 * 3600 * 1000 + 5000;
    revalida();
    assert.equal(await caiu(w2), true, 'token vencido fecha o socket');
    m.s.relogio.t -= 12 * 3600 * 1000 + 5000;
    // troca de senha
    const t3 = await m.mintar(m.dono, 'ana');
    const w3 = await wsAberto(m.porta, `/pv/${t3}/tela/websockify`);
    assert.equal(w3.status, 101);
    m.s.t.web.auth.definirHash(require('./ajuda').gerarHash('outra-senha-bem-longa-9'));
    revalida();
    assert.equal(await caiu(w3), true, 'troca de senha fecha o socket');
  } finally { await m.fechar(); }
});

test('WebSocket por /pv/ de COLABORADOR também fecha quando o prazo do token vence', async () => {
  const m = await montar();
  try {
    const x = await colaboradorAtivo(m.s);
    const tok = await m.mintar(x.c, 'ana');
    const w = await wsAberto(m.porta, `/pv/${tok}/api/eventos`);
    assert.equal(w.status, 101);
    m.s.t.web.proxy.revalidar();
    assert.equal(await caiu(w), false);
    m.s.relogio.t += 12 * 3600 * 1000 + 5000;
    m.s.t.web.proxy.revalidar();
    assert.equal(await caiu(w), true);
  } finally { await m.fechar(); }
});

test('o token nunca aparece em linha de log', async () => {
  const m = await montar();
  try {
    const x = await colaboradorAtivo(m.s);
    const tokens = [await m.mintar(m.dono, 'ana'), await m.mintar(x.c, 'ana')];
    for (const tk of tokens) {
      await m.pv('POST', tk, '/api/acao', { json: {}, origin: 'https://mal.example' });   // CSRF recusado: loga o caminho
      await m.pv('GET', tk, '/api/cofre');                                                  // negado ao colaborador: loga o caminho
      await m.pv('GET', tk, '/logs');
      await abreWs(m.porta, `/pv/${tk}/tela/websockify`, { Origin: 'https://mal.example' });
      await abreWs(m.porta, `/pv/${tk}/tela/websockify`, { Origin: 'null' });
      await m.pv('GET', `${tk}xx`, '/api/estado');                                          // token ruim
    }
    await m.pv('GET', 'curto', '/api/estado');
    const log = m.s.t.log.texto();
    assert.match(log, /Pedido POST \/p\/ana\/api\/acao recusado/, 'o log tem a linha do caminho, sem o token');
    assert.match(log, /barrado em GET \/p\/ana\/api\/cofre/);
    for (const tk of tokens) {
      assert.ok(!log.includes(tk), 'o token inteiro está no log');
      assert.ok(!log.includes(tk.split('.')[0]) && !log.includes(tk.split('.')[1]), 'um pedaço do token está no log');
    }
    assert.ok(!/\/pv\//.test(log.replace(/\/pv\/\[token\]/g, '')), 'qualquer /pv/ no log precisa estar com o token oculto');
  } finally { await m.fechar(); }
});

test('sw.js deixa /pv/ fora do cache', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /const PROIBIDOS = \[[^\]]*\/\^\\\/pv\\\//);
});
