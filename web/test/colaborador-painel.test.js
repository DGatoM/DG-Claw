'use strict';
// O colaborador usa o painel inteiro do agente dele (pelo proxy do Web), menos o cofre, as chaves de API,
// a troca da conta de IA, os canais e a senha da Tela. Com um painel falso, o teste confere o que CHEGA a ele.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');

const SEGREDO_DO_PROXY = 'segredo-do-proxy-so-para-teste-4321';

function painelFalso() {
  const visto = [];
  const socketsWs = new Set();
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      visto.push({ metodo: req.method, url: req.url, usuario: req.headers['x-dgclaw-usuario'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, do_painel: true }));
    });
  });
  servidor.on('upgrade', (req, socket) => {
    visto.push({ metodo: 'UPGRADE', url: req.url, usuario: req.headers['x-dgclaw-usuario'] });
    socketsWs.add(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('eco:'), d])));
    socket.on('error', () => socket.destroy());
  });
  return {
    visto,
    ouvir: () => new Promise((r) => servidor.listen(0, '127.0.0.1', () => r(servidor.address().port))),
    fechar: () => new Promise((r) => { for (const x of socketsWs) x.destroy(); servidor.closeAllConnections(); servidor.close(() => r()); }),
  };
}

async function cenarioComPainel() {
  const painel = painelFalso();
  const porta = await painel.ouvir();
  const arq = path.join(pastaTemp('proxy'), 'proxy.txt');
  fs.writeFileSync(arq, `${SEGREDO_DO_PROXY}\n`);
  const s = await cenario({ painelAna: { porta_painel: porta, proxy_segredo_arquivo: arq } });
  const x = await colaboradorAtivo(s);
  const fechar = async () => { await s.fechar(); await painel.fechar(); };
  return { s, x, painel, fechar };
}

test('colaborador usa o painel inteiro do agente dele: sessões, rotinas, memória, arquivos e Tela chegam ao painel', async () => {
  const { x, painel, fechar } = await cenarioComPainel();
  try {
    const casos = [
      ['GET', '/p/ana/'], ['GET', '/p/ana/api/sessoes'], ['POST', '/p/ana/api/sessoes'], ['GET', '/p/ana/api/rotinas'], ['GET', '/p/ana/api/rotinas/usuario'],
      ['GET', '/p/ana/api/memory'], ['PUT', '/p/ana/api/memoria/arquivo'], ['GET', '/p/ana/api/arquivos'], ['PUT', '/p/ana/api/arquivos'],
      ['GET', '/p/ana/api/tela'], ['GET', '/p/ana/api/provedor'], ['POST', '/p/ana/api/chat/mensagem'],
    ];
    for (const [m, p] of casos) {
      const r = await x.c.pedir(m, p, m === 'GET' ? {} : { json: {} });
      assert.equal(r.status, 200, `${m} ${p}: ${r.texto}`);
      assert.equal(r.json.do_painel, true, `${m} ${p} devia ter vindo do painel`);
    }
    assert.equal(painel.visto.length, casos.length);
    assert.ok(painel.visto.every((v) => v.usuario === 'maria@x.com'), 'o painel sabe quem é a pessoa');
  } finally { await fechar(); }
});

test('colaborador: as rotas globais que aceitam agente só devolvem o dele ou ficam fechadas', async () => {
  const { x, s, fechar } = await cenarioComPainel();
  try {
    // filtradas no handler: só o agente dele, nunca os outros
    const ag = await x.c.get('/api/v1/agents');
    assert.deepEqual(ag.json.agentes.map((a) => a.id), ['ana']);
    assert.deepEqual((await s.dono.get('/api/v1/agents')).json.agentes.map((a) => a.id), ['admin', 'ana', 'bob']);
    const nl = await x.c.get('/api/v1/nao-lidas');
    assert.deepEqual(Object.keys(nl.json.agentes), ['ana']);
    // fechadas: globais, sem o agente no caminho, e as ações delas são do dono (push no aparelho dele, assinatura, lista dos outros)
    for (const p of ['/api/v1/estados', '/api/v1/uso', '/api/v1/lembretes', '/api/v1/tarefas', '/api/v1/foco/ana', '/api/v1/avisos', '/api/v1/push/chave', '/api/v1/sigilo/estado', '/api/v1/atualizacao', '/api/v1/seguranca', '/api/v1/onboarding', '/api/v1/cofre', '/api/v1/colaboradores']) {
      const r = await x.c.get(p);
      assert.equal(r.status, 403, `${p}: ${r.status}`);
    }
    assert.equal((await x.c.post('/api/v1/lembretes', { json: { agente: 'bob', texto: 'x' } })).status, 403);
    assert.equal((await x.c.post('/api/v1/tarefas', { json: { agente: 'bob', titulo: 'x' } })).status, 403);
  } finally { await fechar(); }
});

test('colaborador: cofre, chaves de API, conta de IA, canais e senha da Tela não chegam ao painel, em nenhuma forma', async () => {
  const { x, s, painel, fechar } = await cenarioComPainel();
  try {
    const fechados = [
      ['GET', '/p/ana/api/cofre'], ['POST', '/p/ana/api/cofre'], ['PUT', '/p/ana/api/cofre'], ['DELETE', '/p/ana/api/cofre?envName=X'], ['POST', '/p/ana/api/cofre/aplicar'],
      ['GET', '/p/ana/API/Cofre/'], ['GET', '/p/ana/api/cofre/'],
      ['GET', '/p/ana/api/chaves-api'], ['POST', '/p/ana/api/chaves-api'], ['DELETE', '/p/ana/api/chaves-api'],
      ['POST', '/p/ana/api/provedor'], ['DELETE', '/p/ana/api/provedor/login'], ['POST', '/p/ana/api/provedor/login/codigo'],
      ['PUT', '/p/ana/api/tela/senha'], ['PUT', '/p/ana/API/Tela/Senha/'],
      ['POST', '/p/ana/api/canais/telegram'],
      // desvios do caminho cru
      ['GET', '/p/ana/api%2fcofre'], ['GET', '/p/ana/./api/cofre'], ['GET', '/p/ana/x/../api/cofre'], ['GET', '/p/ana//api/cofre'], ['GET', '/p/ana/api/%63ofre'],
      ['GET', '/p/ana/%2e%2e/bob/api/memory'], ['GET', '/p/bob/api/memory'],
    ];
    for (const [m, p] of fechados) {
      const r = await x.c.pedir(m, p, m === 'GET' || m === 'DELETE' ? {} : { json: {} });
      assert.equal(r.status, 403, `${m} ${p}: ${r.status} ${r.texto}`);
      assert.ok(r.json && r.json.erro, `${m} ${p} devia trazer o motivo`);
    }
    assert.equal(painel.visto.length, 0, `nada disso pode ter chegado ao painel: ${JSON.stringify(painel.visto)}`);
    // a frase do cofre é a do painel (error) e a do Web (erro)
    const cofre = await x.c.get('/p/ana/api/cofre');
    assert.equal(cofre.json.error, 'O cofre é só do dono do DG Claw.');
    assert.equal(cofre.json.erro, 'O cofre é só do dono do DG Claw.');
    // o dono segue com tudo
    assert.equal((await s.dono.get('/p/ana/api/cofre')).status, 200);
    assert.equal((await s.dono.pedir('PUT', '/p/ana/api/tela/senha', { json: {} })).status, 200);
  } finally { await fechar(); }
});

test('colaborador: WebSocket da Tela do agente dele abre (101) e leva o usuário ao painel; o de outro agente não', async () => {
  const { x, s, painel, fechar } = await cenarioComPainel();
  try {
    const cookie = Object.entries(x.c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const abre = (caminho, porta2) => new Promise((resolve) => {
      const limite = setTimeout(() => resolve({ erro: `sem resposta em ${caminho}` }), 3000);
      limite.unref();
      const req = http.request({ host: '127.0.0.1', port: porta2, path: caminho, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: `http://127.0.0.1:${porta2}`, Cookie: cookie } });
      req.on('upgrade', (res, socket) => { socket.write('oi'); socket.once('data', (d) => { socket.destroy(); resolve({ status: res.statusCode, eco: d.toString() }); }); });
      req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
      req.on('error', (e) => resolve({ erro: e.code }));
      req.end();
    });
    const portaWeb = s.t.porta;
    const ok = await abre('/p/ana/tela/websockify', portaWeb);
    assert.equal(ok.status, 101); assert.equal(ok.eco, 'eco:oi');
    const up = painel.visto.find((v) => v.metodo === 'UPGRADE');
    assert.equal(up.usuario, 'maria@x.com');
    for (const p of ['/p/bob/tela/websockify', '/p/ana/api/cofre', '/p/ana/%2e%2e/bob/tela/websockify']) assert.notEqual((await abre(p, portaWeb)).status, 101, p);
    assert.equal(painel.visto.filter((v) => v.metodo === 'UPGRADE').length, 1);
  } finally { await fechar(); }
});
