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
  const fechadosDoPainel = { n: 0 };
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      visto.push({ metodo: req.method, url: req.url, usuario: req.headers['x-dgclaw-usuario'], papel: req.headers['x-dgclaw-papel'], colaborador: req.headers['x-dgclaw-colaborador'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, do_painel: true }));
    });
  });
  servidor.on('upgrade', (req, socket) => {
    visto.push({ metodo: 'UPGRADE', url: req.url, usuario: req.headers['x-dgclaw-usuario'] });
    socketsWs.add(socket);
    socket.on('close', () => { fechadosDoPainel.n += 1; });
    socket.on('end', () => socket.end());
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('eco:'), d])));
    socket.on('error', () => socket.destroy());
  });
  return {
    visto, fechadosDoPainel,
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

test('colaborador usa o painel inteiro do agente dele: sessões, rotinas, memória e arquivos chegam ao painel', async () => {
  const { x, painel, fechar } = await cenarioComPainel();
  try {
    const casos = [
      ['GET', '/p/ana/'], ['GET', '/p/ana/api/sessoes'], ['POST', '/p/ana/api/sessoes/abc/arquivar'], ['GET', '/p/ana/api/rotinas'], ['GET', '/p/ana/api/rotinas/usuario'],
      ['GET', '/p/ana/api/memory'], ['GET', '/p/ana/api/memoria/arquivo'], ['GET', '/p/ana/api/arquivos'],
      ['GET', '/p/ana/api/chat/mensagens'],
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
      // mandar mensagem, decidir e abrir sessão com instrução: só pelas rotas do Web, que têm identidade
      ['POST', '/p/ana/api/chat/mensagem'], ['POST', '/p/ana/api/chat/parar'], ['POST', '/p/ana/api/chat/reativar'],
      ['POST', '/p/ana/api/socorro/mensagem'], ['POST', '/p/ana/api/socorro/encerrar'], ['POST', '/p/ana/api/sessoes'],
      ['POST', '/p/ana/api/sessoes/abc/recado'], ['POST', '/p/ana/api/sessoes/abc/decidir'], ['POST', '/p/ana/API/Sessoes/abc/Decidir/'],
      ['POST', '/p/ana/api/sessoes/abc/retomar'], ['POST', '/p/ana/api/sessoes/abc/handoff'], ['POST', '/p/ana/api/sessoes/abc/apagar'],
      ['POST', '/p/ana/api/sessoes/abc/dec%69dir'], ['POST', '/p/ana/api/sessoes/abc/./decidir'],
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

test('colaborador: a Tela (WebSocket, página e senha) é fechada com 403 e nada chega ao painel', async () => {
  const { x, s, painel, fechar } = await cenarioComPainel();
  try {
    const cookie = Object.entries(x.c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const abre = (caminho) => new Promise((resolve) => {
      const limite = setTimeout(() => resolve({ erro: `sem resposta em ${caminho}` }), 3000);
      limite.unref();
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: caminho, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: `http://127.0.0.1:${s.t.porta}`, Cookie: cookie } }); // gitleaks:allow
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }); });
      req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
      req.on('error', (e) => resolve({ erro: e.code }));
      req.end();
    });
    for (const p of ['/p/ana/tela/websockify', '/p/bob/tela/websockify', '/p/ana/api/cofre']) assert.notEqual((await abre(p)).status, 101, p);
    assert.equal((await abre('/p/ana/tela/websockify')).status, 403);
    for (const p of ['/p/ana/api/tela', '/p/ana/tela/novnc/vnc.html']) {
      const r = await x.c.get(p);
      assert.equal(r.status, 403, p); assert.match(r.texto, /A Tela do agente dá acesso aos arquivos e às contas dele/);
    }
    assert.equal(painel.visto.length, 0, 'o painel não pode ter recebido nada');
    assert.equal((await s.dono.get('/p/ana/api/tela')).status, 200, 'o dono segue com a Tela');
  } finally { await fechar(); }
});

const TS = '2026-10-12T15:00:00.000Z';
// `colab`: o colaborador_id que o servidor grava no envelope da mensagem de um colaborador.
const msg = (n, texto, colab) => ({ type: 'user', timestamp: TS, message: { role: 'user', content: `<dgchat from="${colab ? 'colaborador: Maria (maria@x.com)' : 'pessoa'}" chat="c_ana" msg="m${n}" ts="${TS}"${colab ? ` colaborador_id="${colab}"` : ''}>${texto}</dgchat>` } });
const usoBash = (id) => ({ type: 'assistant', timestamp: '2026-10-12T15:00:05.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo oi > /tmp/x', description: 'Grava um arquivo' } }] } });
const mudaEstado = (s, status) => { s.rAna.opcoes.status = status; s.relogio.t += 3000; };

test('proxy manda ao painel quem é (papel e colaborador) e apaga o que o navegador forjar', async () => {
  const { x, s, painel, fechar } = await cenarioComPainel();
  try {
    const forjados = { 'X-DGClaw-Papel': 'dono', 'X-DGClaw-Colaborador': 'forjado', 'X-DGClaw-Usuario': 'dono' };
    await x.c.get('/p/ana/api/sessoes', { headers: forjados });
    await s.dono.get('/p/ana/api/sessoes', { headers: forjados });
    const [doColab, doDono] = painel.visto;
    assert.equal(doColab.papel, 'colaborador'); assert.equal(doColab.colaborador, x.id); assert.equal(doColab.usuario, 'maria@x.com');
    assert.equal(doDono.papel, 'dono'); assert.equal(doDono.colaborador, undefined); assert.equal(doDono.usuario, 'dono');
  } finally { await fechar(); }
});

const cookieDe = (c) => Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');

test('repetir um envio antigo (mesmo cliente_id) não devolve ao colaborador a autoria do turno', async () => {
  const { x, s, fechar } = await cenarioComPainel();
  try {
    assert.equal((await x.c.post('/api/v1/agents/ana/send', { json: { text: 'primeiro', cliente_id: 'cliente-antigo-1' } })).status, 200);
    const doDono = await s.dono.post('/api/v1/agents/ana/send', { json: { text: 'agora sou eu', cliente_id: 'cliente-antigo-1' } });
    assert.equal(doDono.status, 200); assert.equal(doDono.json.repetido, undefined, 'o cliente_id do colaborador não vale para o dono');
    s.escreveTranscript([msg(1, 'agora sou eu'), usoBash('tuZ')]);
    mudaEstado(s, 'waiting_input');
    const repete = await x.c.post('/api/v1/agents/ana/send', { json: { text: 'primeiro', cliente_id: 'cliente-antigo-1' } });
    assert.equal(repete.json.repetido, true);
    const nega = await x.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 'tuZ' } });
    assert.equal(nega.status, 403, nega.texto);
    assert.equal(s.rAna.rec.permissoes.length, 0);
  } finally { await fechar(); }
});

test('turno que vira misto invalida o vínculo da pendência que já tinha sido vista', async () => {
  const { x, s, fechar } = await cenarioComPainel();
  try {
    await x.c.post('/api/v1/agents/ana/send', { json: { text: 'grava aquele arquivo' } });
    s.escreveTranscript([msg(1, 'grava aquele arquivo', x.id), usoBash('tu5')]);
    mudaEstado(s, 'waiting_input');
    // o colaborador vê a pendência (um pedido com id errado já a vincula ao turno dele)
    assert.equal((await x.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 'tuX' } })).status, 409);
    assert.equal((await s.dono.post('/api/v1/agents/ana/send', { json: { text: 'e depois isto' } })).json.fila.motivo, 'permissao');
    const nega = await x.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 'tu5' } });
    assert.equal(nega.status, 403, nega.texto);
    assert.equal(s.rAna.rec.permissoes.length, 0);
  } finally { await fechar(); }
});

test('colaborador revogado no meio do corpo de uma escrita em /p/ não faz o painel receber nada', async () => {
  const { x, s, painel, fechar } = await cenarioComPainel();
  try {
    const corpo = Buffer.from(JSON.stringify({ conteudo: 'não pode chegar ao painel' }));
    const cookie = Object.entries(x.c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, method: 'POST', path: '/p/ana/api/sessoes/abc/arquivar', headers: {
        Cookie: cookie, Origin: `http://127.0.0.1:${s.t.porta}`, 'Content-Type': 'application/json', 'Content-Length': corpo.length } }, (res) => {
        const p = []; res.on('data', (d) => p.push(d)); res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(p).toString('utf8') }));
      });
      req.on('error', reject);
      req.write(corpo.subarray(0, 8));
      setTimeout(async () => {
        try { assert.equal((await s.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`)).status, 200); req.end(corpo.subarray(8)); } catch (e) { reject(e); }
      }, 100);
    });
    assert.equal(r.status, 401, r.texto);
    assert.equal(painel.visto.length, 0, 'o painel não pode ter recebido pedido nenhum');
  } finally { await fechar(); }
});
