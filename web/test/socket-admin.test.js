'use strict';
// Socket de administração do host (<dataDir>/admin.sock): o `dgclaw colaborador` convida sem passar por senha do painel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { cliente, subirWeb, pastaTemp } = require('./ajuda');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');

function viaSocket(s, metodo, rota, json) {
  return new Promise((resolve, reject) => {
    const corpo = json === undefined ? null : Buffer.from(JSON.stringify(json));
    const headers = corpo ? { 'Content-Type': 'application/json', 'Content-Length': corpo.length } : {};
    const req = http.request({ socketPath: s.t.web.caminhoSocketAdmin, method: metodo, path: rota, headers }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => { const texto = Buffer.concat(partes).toString('utf8'); let j = null; try { j = JSON.parse(texto); } catch (_) { /* não é JSON */ } resolve({ status: res.statusCode, json: j, texto }); });
    });
    req.on('error', reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

test('socket: nasce em <dataDir>/admin.sock com permissão 600, dentro de uma pasta 700', async () => {
  const s = await cenario();
  try {
    const sock = s.t.web.caminhoSocketAdmin;
    assert.equal(sock, path.join(s.t.dados, 'admin.sock'));
    assert.ok(fs.lstatSync(sock).isSocket());
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
    assert.equal(fs.statSync(s.t.dados).mode & 0o777, 0o700);
  } finally { await s.fechar(); }
  assert.equal(fs.existsSync(path.join(s.t.dados, 'admin.sock')), false, 'o socket some quando o Web fecha');
});

test('socket: convida sem cookie, grava criado_por "admin" e usa o endereço que o comando mandou', async () => {
  const s = await cenario();
  try {
    const r = await viaSocket(s, 'POST', '/api/v1/colaboradores', { agente: 'ana', email: 'Paulo@X.com', nome: 'Paulo', base: 'https://painel.exemplo.com' });
    assert.equal(r.status, 201, r.texto);
    assert.equal(r.json.colaborador.criado_por, 'admin');
    assert.equal(r.json.convite.link, 'https://painel.exemplo.com/login?usuario=paulo%40x.com');
    assert.ok(!r.json.convite.aviso);
    assert.match(r.json.convite.texto, /Senha temporária: /);
    assert.equal(s.enviados.length, 1, 'o e-mail também sai');
    const lista = await viaSocket(s, 'GET', '/api/v1/colaboradores?agente=ana');
    assert.equal(lista.json.colaboradores.length, 1);
    const re = await viaSocket(s, 'POST', `/api/v1/colaboradores/${r.json.colaborador.id}/reenviar`, { base: 'https://painel.exemplo.com' });
    assert.equal(re.status, 200, re.texto);
    assert.notEqual(re.json.convite.senha_temporaria, r.json.convite.senha_temporaria);
    const rv = await viaSocket(s, 'DELETE', `/api/v1/colaboradores/${r.json.colaborador.id}`);
    assert.equal(rv.status, 200); assert.deepEqual(rv.json.contas_de_ia, []);
    assert.ok(!s.t.log.texto().includes(re.json.convite.senha_temporaria), 'a senha não vai para o log');
  } finally { await s.fechar(); }
});

test('socket: sem "base" usa DGCLAW_DOMINIO do ambiente do Web; sem nada, o endereço local e um aviso', async () => {
  const s = await cenario({ env: { DGCLAW_DOMINIO: 'meu.exemplo.com' } });
  try {
    const r = await viaSocket(s, 'POST', '/api/v1/colaboradores', { agente: 'ana', email: 'a@x.com' });
    assert.equal(r.json.convite.link, 'https://meu.exemplo.com/login?usuario=a%40x.com');
  } finally { await s.fechar(); }
  const s2 = await cenario();
  try {
    const r = await viaSocket(s2, 'POST', '/api/v1/colaboradores', { agente: 'ana', email: 'a@x.com' });
    assert.match(r.json.convite.link, /^http:\/\/127\.0\.0\.1:\d+\/login\?usuario=a%40x\.com$/);
    assert.match(r.json.convite.aviso, /só abre no próprio servidor/);
    const ruim = await viaSocket(s2, 'POST', '/api/v1/colaboradores', { agente: 'bob', email: 'b@x.com', base: 'https://x.com/caminho?a=b' });
    assert.equal(ruim.status, 400); assert.match(ruim.json.erro, /só o endereço/);
  } finally { await s2.fechar(); }
});

test('socket: o Admin nunca é compartilhado, nem pelo socket', async () => {
  const s = await cenario();
  try {
    const r = await viaSocket(s, 'POST', '/api/v1/colaboradores', { agente: 'admin', email: 'a@x.com' });
    assert.equal(r.status, 400); assert.match(r.json.erro, /Admin nunca pode ser compartilhado/);
  } finally { await s.fechar(); }
});

test('socket: qualquer outra rota é 404 explicando; só /api/v1/colaboradores é atendida', async () => {
  const s = await cenario();
  try {
    for (const [m, p] of [['GET', '/api/v1/agents'], ['GET', '/api/saude'], ['GET', '/a/ana'], ['POST', '/api/v1/agents/ana/send'], ['GET', '/api/v1/colaboradoresX'], ['GET', '/'], ['POST', '/login'], ['GET', '/p/ana/']]) {
      const r = await viaSocket(s, m, p, m === 'POST' ? {} : undefined);
      assert.equal(r.status, 404, `${m} ${p}: ${r.texto}`);
      assert.match(r.json.erro, /só atende \/api\/v1\/colaboradores/, `${m} ${p}`);
    }
  } finally { await s.fechar(); }
});

test('socket: o caminho HTTP continua fechado para quem não é o dono (sem sessão, caixa e colaborador)', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    const anonimo = cliente(s.t.porta);
    for (const [m, p, j] of [['GET', '/api/v1/colaboradores'], ['POST', '/api/v1/colaboradores', { agente: 'ana', email: 'z@x.com' }]]) {
      assert.equal((await anonimo.pedir(m, p, j ? { json: j } : {})).status, 401, `sem sessão ${m}`);
      assert.equal((await x.c.pedir(m, p, j ? { json: j } : {})).status, 403, `colaborador ${m}`);
      const caixa = await anonimo.pedir(m, p, Object.assign({ semCookie: true, headers: { 'x-dgclaw-caixa': s.t.web.caixa.segredo, 'x-dgclaw-agente': 'ana' } }, j ? { json: j } : {}));
      assert.equal(caixa.status, 403, `caixa ${m}: ${caixa.texto}`);
    }
    assert.equal((await x.c.pedir('DELETE', `/api/v1/colaboradores/${x.id}`)).status, 403);
    assert.equal((await s.dono.get('/api/v1/colaboradores')).status, 200, 'o dono pelo navegador segue igual');
  } finally { await s.fechar(); }
});

test('socket: na partida só apaga o arquivo antigo se for socket; outro arquivo no lugar vira log e não derruba o Web', async () => {
  // um socket velho no caminho (sobra de um Web que caiu) é substituído
  const dir = pastaTemp('sockvelho');
  const dados = path.join(dir, 'dados');
  fs.mkdirSync(dados, { recursive: true, mode: 0o700 });
  const velho = net.createServer();
  await new Promise((r) => velho.listen(path.join(dados, 'admin.sock'), r));
  assert.ok(fs.lstatSync(path.join(dados, 'admin.sock')).isSocket());
  const s = await subirWeb({ agentes: [], opcoesServidor: { dataDir: dados } });
  try {
    assert.ok(fs.lstatSync(path.join(dados, 'admin.sock')).isSocket());
    assert.doesNotMatch(s.log.texto(), /Não abri o socket/);
    const r = await new Promise((resolve, reject) => { const q = http.get({ socketPath: path.join(dados, 'admin.sock'), path: "/api/v1/nada" }, (res) => { res.resume(); resolve(res.statusCode); }); q.on('error', reject); });
    assert.equal(r, 404, 'quem responde agora é o Web novo');
  } finally { await s.fechar(); velho.close(); }

  // um arquivo comum no caminho: não é apagado, o Web sobe e o log explica
  const dir2 = pastaTemp('sockarquivo');
  const dados2 = path.join(dir2, 'dados');
  fs.mkdirSync(dados2, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dados2, 'admin.sock'), 'não sou um socket');
  const t = await subirWeb({ agentes: [], opcoesServidor: { dataDir: dados2 } });
  try {
    assert.equal(fs.readFileSync(path.join(dados2, 'admin.sock'), 'utf8'), 'não sou um socket', 'não pode apagar o que não é socket');
    assert.match(t.log.texto(), /Não abri o socket de administração .*não é um socket/);
    assert.equal((await t.c.get('/api/saude')).status, 200, 'o Web segue de pé');
  } finally { await t.fechar(); }
});

test('socket: caminho comprido demais vira log que se explica, sem derrubar o Web', async () => {
  const dir = pastaTemp('sockcomprido');
  const dados = path.join(dir, 'd'.repeat(120));
  const t = await subirWeb({ agentes: [], opcoesServidor: { dataDir: dados } });
  try {
    assert.match(t.log.texto(), /Não abri o socket de administração/);
    assert.equal((await t.c.get('/api/saude')).status, 200);
  } finally { await t.fechar(); }
});
