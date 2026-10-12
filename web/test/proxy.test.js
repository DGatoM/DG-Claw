'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { subirWeb } = require('./ajuda');

const VALOR_PROXY = 'valor-do-proxy-so-para-teste-9876';

/** Painel falso: devolve ao teste os cabeçalhos que recebeu; também faz SSE e eco de WebSocket. */
function painelFalso() {
  const visto = [];
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      visto.push({ metodo: req.method, url: req.url, headers: req.headers, corpo: Buffer.concat(partes).toString('utf8') });
      if (req.url.startsWith('/p/ana/sse')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: um\n\n');
        setTimeout(() => { res.write('data: dois\n\n'); res.end(); }, 150);
        return;
      }
      if (req.url.startsWith('/p/ana/grande')) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.alloc(3 * 1024 * 1024, 7));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Do-Painel': 'sim', 'Set-Cookie': 'dash=1; Path=/p/ana' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  servidor.on('upgrade', (req, socket) => {
    visto.push({ metodo: 'UPGRADE', url: req.url, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('eco:'), d])));
    socket.on('end', () => socket.end());
    socket.on('error', () => socket.destroy());
  });
  return {
    visto,
    ouvir: () => new Promise((r) => servidor.listen(0, '127.0.0.1', () => r(servidor.address().port))),
    fechar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(() => r()); }),
  };
}

async function cenario(extra) {
  const painel = painelFalso();
  const porta = await painel.ouvir();
  const dirTmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dgclaw-proxy-'));
  const arquivoProxy = path.join(dirTmp, 'proxy.txt');
  fs.writeFileSync(arquivoProxy, `${VALOR_PROXY}\n`);
  const agentes = [
    { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'a0' },
    { slug: 'ana', nome: 'Ana', runner: 'http://127.0.0.1:1', agente_id: 'a1', porta_painel: porta, proxy_segredo_arquivo: arquivoProxy },
    { slug: 'caida', nome: 'Caída', runner: 'http://127.0.0.1:1', agente_id: 'a2', porta_painel: 1, proxy_segredo_arquivo: arquivoProxy },
    { slug: 'semsegredo', nome: 'Sem Segredo', runner: 'http://127.0.0.1:1', agente_id: 'a3', porta_painel: porta },
  ];
  const t = await subirWeb(Object.assign({ agentes }, extra));
  await t.login();
  return { t, painel, fechar: async () => { await t.fechar(); await painel.fechar(); } };
}

test('proxy: sem sessão não passa (401 para API, 302 para navegador)', async () => {
  const s = await cenario();
  try {
    const anon = require('./ajuda').cliente(s.t.porta);
    const a = await anon.get('/p/ana/api/x');
    assert.equal(a.status, 401);
    const b = await anon.get('/p/ana/', { headers: { Accept: 'text/html' } });
    assert.equal(b.status, 302);
    assert.match(b.headers.location, /^\/login\?next=/);
    assert.equal(s.painel.visto.length, 0, 'nada chegou ao painel');
  } finally { await s.fechar(); }
});

test('proxy: apaga X-DGClaw-* do navegador (em qualquer caixa) e acrescenta os dois certos', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.get('/p/ana/api/estado?x=1', { headers: { 'X-DGClaw-Proxy': 'forjado', 'x-dgclaw-usuario': 'invasor', 'X-DGCLAW-PROXY': 'forjado2', Accept: 'application/json' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-do-painel'], 'sim', 'cabeçalhos do painel passam');
    assert.match(r.headers['set-cookie'][0], /^dash=1/);
    const v = s.painel.visto[0];
    assert.equal(v.url, '/p/ana/api/estado?x=1', 'o caminho segue inteiro, com o prefixo do painel');
    assert.equal(v.headers['x-dgclaw-proxy'], VALOR_PROXY);
    assert.equal(v.headers['x-dgclaw-usuario'], 'dono');
    assert.ok(!Object.values(v.headers).some((h) => String(h).includes('forjado') || String(h).includes('invasor')));
    assert.equal(v.headers['x-forwarded-for'], '127.0.0.1');
    assert.ok(!(v.headers.cookie || '').includes('dgclaw_sessao'), 'o cookie de sessão do Web não vai para o painel');
  } finally { await s.fechar(); }
});

test('proxy: o cookie próprio do painel segue, o da sessão do Web é tirado', async () => {
  const s = await cenario();
  try {
    await s.t.c.get('/p/ana/x', { headers: { Cookie: 'dash_token=abc' } });
    assert.equal(s.painel.visto[0].headers.cookie, 'dash_token=abc');
  } finally { await s.fechar(); }
});

test('proxy: o valor do proxy nunca aparece em log nem em resposta de erro', async () => {
  const s = await cenario();
  try {
    await s.t.c.get('/p/ana/x');
    await s.t.c.get('/p/caida/x');
    await s.t.c.get('/p/semsegredo/x');
    const rErr = await s.t.c.get('/p/caida/x');
    assert.ok(!s.t.log.texto().includes(VALOR_PROXY), 'log limpo');
    assert.ok(!rErr.texto.includes(VALOR_PROXY), 'resposta limpa');
    assert.ok(!JSON.stringify(s.t.web.registro.estado()).includes(VALOR_PROXY));
  } finally { await s.fechar(); }
});

test('proxy: POST com Origin errada leva 403 e não chega ao painel; Origin certa passa com o corpo', async () => {
  const s = await cenario();
  try {
    const mal = await s.t.c.post('/p/ana/api/acao', { json: { a: 1 }, origin: 'https://mal.com' });
    assert.equal(mal.status, 403);
    assert.match(mal.json.erro, /origem/);
    assert.equal(s.painel.visto.length, 0);
    const sem = await s.t.c.post('/p/ana/api/acao', { json: { a: 1 }, origin: false });
    assert.equal(sem.status, 403);
    const ok = await s.t.c.post('/p/ana/api/acao', { json: { a: 1 } });
    assert.equal(ok.status, 200);
    assert.equal(s.painel.visto[0].corpo, '{"a":1}');
    assert.equal(s.painel.visto[0].metodo, 'POST');
  } finally { await s.fechar(); }
});

test('proxy: Admin sem painel dá 404 com motivo, painel fora do ar dá 502, sem segredo configurado dá 500', async () => {
  const s = await cenario();
  try {
    const adm = await s.t.c.get('/p/admin/');
    assert.equal(adm.status, 404); assert.match(adm.json.erro, /não tem painel/);
    const caida = await s.t.c.get('/p/caida/');
    assert.equal(caida.status, 502); assert.match(caida.json.erro, /não está respondendo/);
    const sem = await s.t.c.get('/p/semsegredo/');
    assert.equal(sem.status, 500); assert.match(sem.json.erro, /proxy_segredo_arquivo/);
    const nao = await s.t.c.get('/p/fantasma/');
    assert.equal(nao.status, 404);
    const raiz = await s.t.c.get('/p/ana');
    assert.equal(raiz.status, 302); assert.equal(raiz.headers.location, '/p/ana/');
  } finally { await s.fechar(); }
});

test('proxy: repassa SSE em stream e corpo grande sem estragar', async () => {
  const s = await cenario();
  try {
    const eventos = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: '/p/ana/sse', headers: { Cookie: Object.entries(s.t.c.jar).map(([k, v]) => `${k}=${v}`).join('; ') } }, (res) => {
        const tempos = []; let acc = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { acc += d; tempos.push([Date.now(), d]); });
        res.on('end', () => resolve({ acc, tempos, tipo: res.headers['content-type'] }));
      });
      req.on('error', reject); req.end();
    });
    assert.match(eventos.tipo, /event-stream/);
    assert.equal(eventos.acc, 'data: um\n\ndata: dois\n\n');
    assert.ok(eventos.tempos.length >= 2 && eventos.tempos[1][0] - eventos.tempos[0][0] >= 100, 'o primeiro evento chegou antes do segundo (streaming de verdade)');
    const g = await s.t.c.get('/p/ana/grande');
    assert.equal(g.buf.length, 3 * 1024 * 1024);
  } finally { await s.fechar(); }
});

test('proxy: WebSocket (upgrade) passa com os mesmos cabeçalhos de confiança e exige sessão e Origin', async () => {
  const s = await cenario();
  try {
    const cookie = Object.entries(s.t.c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const abre = (headers) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: '/p/ana/ws', headers: Object.assign({ Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGVzdGVkZXRlc3RlMTIzNA==', 'Sec-WebSocket-Version': '13' }, headers) });
      req.on('upgrade', (res, socket) => {
        socket.write('oi');
        socket.once('data', (d) => { socket.destroy(); resolve({ status: res.statusCode, eco: d.toString() }); });
      });
      req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
      req.on('error', (e) => resolve({ erro: e.code }));
      req.end();
    });
    const ok = await abre({ Cookie: cookie, Origin: `http://127.0.0.1:${s.t.porta}`, 'X-DGClaw-Proxy': 'forjado' });
    assert.equal(ok.status, 101); assert.equal(ok.eco, 'eco:oi');
    const up = s.painel.visto.find((v) => v.metodo === 'UPGRADE');
    assert.equal(up.headers['x-dgclaw-proxy'], VALOR_PROXY);
    assert.equal(up.headers['x-dgclaw-usuario'], 'dono');
    const semSessao = await abre({ Origin: `http://127.0.0.1:${s.t.porta}` });
    assert.notEqual(semSessao.status, 101);
    const origemRuim = await abre({ Cookie: cookie, Origin: 'https://mal.com' });
    assert.notEqual(origemRuim.status, 101);
  } finally { await s.fechar(); }
});
