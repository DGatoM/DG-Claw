'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { criarAvatar } = require('../lib/avatar');
const { pastaTemp } = require('./ajuda');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function resposta(corpo, tipo, status = 200) {
  return { ok: status < 400, status, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? tipo : null) }, arrayBuffer: async () => corpo };
}

async function subir(buscar, agente) {
  const logs = [];
  const av = criarAvatar({ dataDir: pastaTemp('avatar'), log: (n, m) => logs.push(`${n}: ${m}`), buscar });
  const srv = http.createServer(async (req, res) => {
    const falha = await av.servir(req, res, agente);
    if (falha) { res.writeHead(falha.status); res.end(falha.erro); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const get = (cab, metodo = 'GET') => new Promise((ok, ko) => {
    const rq = http.request({ port: srv.address().port, method: metodo, headers: cab || {} }, (rs) => {
      const pedacos = []; rs.on('data', (d) => pedacos.push(d)); rs.on('end', () => ok({ status: rs.statusCode, headers: rs.headers, corpo: Buffer.concat(pedacos) }));
    });
    rq.on('error', ko); rq.end();
  });
  return { av, logs, get, fechar: () => srv.close() };
}

test('baixa a foto uma vez, serve inteira com cache longo e Range', async () => {
  let baixadas = 0;
  const s = await subir(async () => { baixadas++; return resposta(PNG, 'image/png'); }, { slug: 'ana', avatar: 'https://fora.exemplo/ana.png' });
  const a = await s.get();
  assert.equal(a.status, 200); assert.equal(a.headers['content-type'], 'image/png');
  assert.match(a.headers['cache-control'], /max-age=31536000/); assert.deepEqual(a.corpo, PNG);
  const b = await s.get({ Range: 'bytes=0-3' });
  assert.equal(b.status, 206); assert.equal(b.headers['content-range'], `bytes 0-3/${PNG.length}`); assert.equal(b.corpo.length, 4);
  assert.equal((await s.get({ Range: 'bytes=999-' })).status, 416);
  assert.equal(baixadas, 1);
  s.fechar();
});

test('sem foto por endereço: 404 com motivo; fonte que não é imagem: 502 com motivo e log', async () => {
  const s1 = await subir(async () => { throw new Error('não deveria baixar'); }, { slug: 'ana', avatar: '🌿' });
  const r1 = await s1.get(); assert.equal(r1.status, 404); assert.match(r1.corpo.toString(), /não tem foto/);
  s1.fechar();
  const s2 = await subir(async () => resposta(Buffer.from('<svg/>'), 'image/svg+xml'), { slug: 'ana', avatar: 'https://fora.exemplo/x.svg' });
  const r2 = await s2.get(); assert.equal(r2.status, 502); assert.match(r2.corpo.toString(), /foto aceita/);
  assert.match(s2.logs[0], /Avatar de ana/);
  s2.fechar();
});

test('a URL pública muda quando a URL do cadastro muda', () => {
  const av = criarAvatar({ dataDir: pastaTemp('avatar'), log() {} });
  assert.notEqual(av.urlPublica('ana', 'https://a/1.png'), av.urlPublica('ana', 'https://a/2.png'));
  assert.match(av.urlPublica('ana', 'https://a/1.png'), /^\/api\/v1\/agents\/ana\/avatar\?v=[0-9a-f]{8}$/);
});
