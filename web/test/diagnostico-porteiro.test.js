'use strict';
// O porteiro das chaves de API no server.js. O coletor (Parte B) é trocado por um falso que só anota quem chamou.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../lib/http');
const { subirWeb, cliente } = require('./ajuda');

const AGENTES = [
  { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://x', agente_id: 'adm' },
  { slug: 'luna', nome: 'Luna', tipo: 'agente', runner: 'http://x', agente_id: 'luna' },
];

async function cenario(opcoes) {
  const chamadas = [];
  const diagnostico = {
    async responder(req, res, url, quem) {
      chamadas.push({ metodo: req.method, caminho: url.pathname, quem });
      if (quem.tipo === 'publico') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end('# Diagnóstico remoto\n');
      }
      return H.enviaJson(res, 200, { ok: true, schema: 1, quem: quem.tipo });
    },
  };
  const t = await subirWeb(Object.assign({ agentes: AGENTES, opcoesServidor: { diagnostico } }, opcoes));
  const nova = (nome) => t.web.chavesApi.criar({ nome: nome || 'Suporte DG', escopos: ['diagnostico'], quem: 'teste' });
  const com = (token, extra) => Object.assign({ headers: { Authorization: `Bearer ${token}` }, origin: `http://127.0.0.1:${t.porta}` }, extra);
  return { t, chamadas, nova, com };
}

test('sem Bearer e sem sessão: 401', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.get('/api/v1/diagnostico');
    assert.equal(r.status, 401);
    assert.equal(s.chamadas.length, 0);
  } finally { await s.t.fechar(); }
});

test('docs.md é público, sem chave nem sessão', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.get('/api/v1/diagnostico/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/markdown/);
    assert.equal(s.chamadas[0].quem.tipo, 'publico');
    assert.equal((await s.t.c.pedir('POST', '/api/v1/diagnostico/docs.md')).status, 401, 'só GET/HEAD é público');
  } finally { await s.t.fechar(); }
});

test('Bearer lixo ou desconhecida: 401 com motivo e como resolver, sem dizer "revogada"', async () => {
  const s = await cenario();
  try {
    const lixo = await s.t.c.get('/api/v1/diagnostico', { headers: { Authorization: 'Bearer lixo' }, semCookie: true });
    assert.equal(lixo.status, 401);
    assert.equal(lixo.json.ok, false);
    assert.match(lixo.json.erro, /formato/);
    assert.ok(lixo.json.como_resolver);
    const falsa = await s.t.c.get('/api/v1/diagnostico', s.com('dgc_' + 'a'.repeat(43)));
    assert.equal(falsa.status, 401);
    assert.match(falsa.json.erro, /não é válida/);
    assert.doesNotMatch(falsa.json.erro, /revogad/);
    assert.equal(falsa.headers['cache-control'], 'no-store');
    assert.equal(s.chamadas.length, 0);
  } finally { await s.t.fechar(); }
});

test('Bearer de chave revogada: 401 dizendo que foi revogada, com a data', async () => {
  const s = await cenario();
  try {
    const k = s.nova();
    s.t.web.chavesApi.revogar(k.chave.id, 'dono');
    const r = await s.t.c.get('/api/v1/diagnostico', s.com(k.token));
    assert.equal(r.status, 401);
    assert.match(r.json.erro, /revogada em \d{2}\/\d{2}\/\d{4} pelo dono da máquina/);
    assert.match(r.json.como_resolver, /chave nova/);
    assert.equal(s.chamadas.length, 0);
  } finally { await s.t.fechar(); }
});

test('Bearer válida em GET e HEAD /api/v1/diagnostico: chama o coletor com {tipo:chave,id,nome} e anota o uso', async () => {
  const s = await cenario();
  try {
    const k = s.nova('Suporte DG');
    const r = await s.t.c.get('/api/v1/diagnostico', s.com(k.token));
    assert.equal(r.status, 200);
    assert.equal(r.json.quem, 'chave');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(s.chamadas[0].quem, { tipo: 'chave', id: k.chave.id, nome: 'Suporte DG' });
    const barra = await s.t.c.get('/api/v1/diagnostico/', s.com(k.token));
    assert.equal(barra.status, 200, 'barra final é aceita');
    const head = await s.t.c.pedir('HEAD', '/api/v1/diagnostico', s.com(k.token));
    assert.equal(head.status, 200);
    const c = s.t.web.chavesApi.listar()[0];
    assert.ok(c.ultimoUsoEm);
    assert.equal(c.ultimoUsoIp, '127.0.0.1');
    assert.ok(!s.t.log.texto().includes(k.token), 'o token não pode ir para o log');
    assert.match(s.t.log.texto(), new RegExp(`chave ${k.chave.id}`));
  } finally { await s.t.fechar(); }
});

test('a mesma chave em qualquer outra rota ou método: 403 com motivo', async () => {
  const s = await cenario();
  try {
    await s.t.login();
    const k = s.nova();
    const casos = [
      ['GET', '/api/v1/agents'],
      ['POST', '/api/v1/diagnostico'],
      ['DELETE', '/api/v1/diagnostico'],
      ['GET', '/api/v1/diagnostico/outra'],
      ['GET', '/api/v1/chaves-api'],
      ['POST', '/api/v1/chaves-api'],
      ['DELETE', `/api/v1/chaves-api?id=${k.chave.id}`],
      ['GET', '/p/admin/'],
      ['GET', '/lembretes'],
      ['GET', '/suporte'],
      ['GET', '/'],
    ];
    for (const [m, p] of casos) {
      const r = await cliente(s.t.porta).pedir(m, p, s.com(k.token, m === 'POST' ? { json: { nome: 'x', escopos: ['diagnostico'] } } : {}));
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.match(r.json.erro, /só pode ler GET \/api\/v1\/diagnostico/);
      assert.ok(r.json.como_resolver);
    }
    assert.equal(s.t.web.chavesApi.listar().length, 1, 'a chave não criou nem apagou chave');
    assert.equal(s.t.web.chavesApi.listar()[0].revogadaEm, null);
    assert.equal(s.chamadas.length, 0);
  } finally { await s.t.fechar(); }
});

test('Bearer válida + cookie de sessão válido em /api/v1/agents: 403 (a chave manda, o cookie é ignorado)', async () => {
  const s = await cenario();
  try {
    await s.t.login();
    assert.equal((await s.t.c.get('/api/v1/agents')).status, 200, 'sanidade: a sessão sozinha funciona');
    const k = s.nova();
    const r = await s.t.c.get('/api/v1/agents', s.com(k.token));
    assert.equal(r.status, 403);
    const inv = await s.t.c.get('/api/v1/agents', { headers: { Authorization: 'Bearer lixo' } });
    assert.equal(inv.status, 401, 'chave inválida não cai de volta na sessão');
  } finally { await s.t.fechar(); }
});

test('21 tentativas ruins do mesmo IP: a 21ª recebe 429 com Retry-After, até com chave boa', async () => {
  const s = await cenario();
  try {
    const k = s.nova();
    for (let i = 0; i < 20; i += 1) {
      const r = await s.t.c.get('/api/v1/diagnostico', s.com('dgc_' + String(i).padStart(43, 'b')));
      assert.equal(r.status, 401, `tentativa ${i + 1}`);
    }
    const r = await s.t.c.get('/api/v1/diagnostico', s.com('dgc_' + 'z'.repeat(43)));
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers['retry-after']) > 0);
    assert.match(r.json.erro, /Tentativas demais/);
    assert.ok(r.json.como_resolver);
    const boa = await s.t.c.get('/api/v1/diagnostico', s.com(k.token));
    assert.equal(boa.status, 429, 'enquanto bloqueado, nem a chave boa passa');
  } finally { await s.t.fechar(); }
});

test('o limite conta pelo IP da conexão', async () => {
  const s = await cenario();
  try {
    for (let i = 0; i < 20; i += 1) {
      await s.t.c.get('/api/v1/diagnostico', s.com('dgc_' + String(i).padStart(43, 'c')));
    }
    assert.equal(s.t.web.chavesApi.bloqueio('127.0.0.1').bloqueado, true);
  } finally { await s.t.fechar(); }
});

test('sessão do dono lê o diagnóstico com {tipo:sessao}; a caixa do agente não', async () => {
  const s = await cenario();
  try {
    await s.t.login();
    const r = await s.t.c.get('/api/v1/diagnostico');
    assert.equal(r.status, 200);
    assert.equal(s.chamadas[0].quem.tipo, 'sessao');
    assert.equal(s.chamadas[0].quem.usuario, 'dono');
    assert.equal((await s.t.c.pedir('POST', '/api/v1/diagnostico', { json: {} })).status, 405);
    const cab = { 'x-dgclaw-caixa': s.t.web.caixa.segredo, 'x-dgclaw-agente': 'luna' };
    const sem = cliente(s.t.porta);
    assert.equal(s.t.web.caixa.rotaPermitida('/api/v1/diagnostico'), false);
    const c1 = await sem.pedir('GET', '/api/v1/diagnostico', { headers: cab });
    assert.equal(c1.status, 403);
    const c2 = await sem.pedir('GET', '/api/v1/chaves-api', { headers: cab });
    assert.equal(c2.status, 403);
    assert.equal(s.chamadas.length, 1, 'a caixa não chegou ao coletor');
  } finally { await s.t.fechar(); }
});

test('gestão por sessão: lista, cria (token só na resposta), revoga; erros com motivo', async () => {
  const s = await cenario();
  try {
    assert.equal((await s.t.c.get('/api/v1/chaves-api')).status, 401, 'sem sessão não entra');
    await s.t.login();
    const vazio = await s.t.c.get('/api/v1/chaves-api');
    assert.equal(vazio.status, 200);
    assert.deepEqual(vazio.json.chaves, []);

    const sem_origin = await s.t.c.post('/api/v1/chaves-api', { json: { nome: 'x', escopos: ['diagnostico'] }, origin: false });
    assert.equal(sem_origin.status, 403, 'o CSRF por Origin continua valendo');
    const outra = await s.t.c.post('/api/v1/chaves-api', { json: { nome: 'x', escopos: ['diagnostico'] }, origin: 'https://evil.example' });
    assert.equal(outra.status, 403);
    assert.equal(s.t.web.chavesApi.listar().length, 0);

    const ruim = await s.t.c.post('/api/v1/chaves-api', { json: { nome: 'x', escopos: ['escrita'] } });
    assert.equal(ruim.status, 400);
    assert.match(ruim.json.erro, /escopo/);
    const semNome = await s.t.c.post('/api/v1/chaves-api', { json: { escopos: ['diagnostico'] } });
    assert.equal(semNome.status, 400);

    const cria = await s.t.c.post('/api/v1/chaves-api', { json: { nome: 'Suporte DG', escopos: ['diagnostico'] } });
    assert.equal(cria.status, 201);
    assert.match(cria.json.token, /^dgc_/);
    assert.equal(cria.json.chave.criadaPor, 'dono');
    assert.equal(cria.json.chave.hash, undefined);
    assert.ok(!s.t.log.texto().includes(cria.json.token));

    const lista = await s.t.c.get('/api/v1/chaves-api');
    assert.equal(lista.json.chaves.length, 1);
    assert.ok(!JSON.stringify(lista.json).includes(cria.json.token));
    assert.ok(!JSON.stringify(lista.json).includes('"hash"'));

    const nada = await s.t.c.pedir('DELETE', '/api/v1/chaves-api?id=nao-existe');
    assert.equal(nada.status, 404);
    const id = cria.json.chave.id;
    const rev = await s.t.c.pedir('DELETE', `/api/v1/chaves-api?id=${id}`);
    assert.equal(rev.status, 200);
    assert.ok(rev.json.chave.revogadaEm);
    assert.equal((await s.t.c.pedir('DELETE', `/api/v1/chaves-api?id=${id}`)).status, 409);

    const depois = await cliente(s.t.porta).get('/api/v1/diagnostico', s.com(cria.json.token));
    assert.equal(depois.status, 401, 'revogada na hora');
  } finally { await s.t.fechar(); }
});

test('a chave criada pela gestão lê o diagnóstico de ponta a ponta', async () => {
  const s = await cenario();
  try {
    await s.t.login();
    const cria = await s.t.c.post('/api/v1/chaves-api', { json: { nome: 'Suporte DG', escopos: ['diagnostico'] } });
    const r = await cliente(s.t.porta).get('/api/v1/diagnostico', s.com(cria.json.token));
    assert.equal(r.status, 200);
    assert.equal(r.json.quem, 'chave');
  } finally { await s.t.fechar(); }
});

test('/suporte: só com sessão; sem sessão vai ao login; a tela existe nos arquivos públicos reais', async () => {
  const s = await cenario();
  try {
    const sem = await s.t.c.get('/suporte', { headers: { Accept: 'text/html' } });
    assert.equal(sem.status, 302);
    assert.match(sem.headers.location, /^\/login\?next=%2Fsuporte/);
    fs.writeFileSync(path.join(s.t.publico, 'suporte.html'), '<html>suporte de teste</html>');
    await s.t.login();
    const com = await s.t.c.get('/suporte');
    assert.equal(com.status, 200);
    assert.match(com.texto, /suporte de teste/);
    const real = path.join(__dirname, '..', 'public');
    for (const a of ['suporte.html', 'suporte.js', 'suporte.css']) assert.ok(fs.existsSync(path.join(real, a)), a);
  } finally { await s.t.fechar(); }
});

test('sem o módulo do coletor instalado a rota responde 503 com o motivo, e não derruba o Web', async () => {
  const s = await cenario({ opcoesServidor: {} });
  try {
    await s.t.login();
    const r = await s.t.c.get('/api/v1/diagnostico');
    if (fs.existsSync(path.join(__dirname, '..', 'lib', 'diagnostico'))) {
      assert.notEqual(r.status, 404);
    } else {
      assert.equal(r.status, 503);
      assert.match(r.json.erro, /coletor/);
    }
  } finally { await s.t.fechar(); }
});
