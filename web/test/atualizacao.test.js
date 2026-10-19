'use strict';
// Aviso de nova versão: rotas /api/v1/atualizacao no servidor inteiro, com o estado gravado à mão
// (quem o grava de verdade é scripts/checar-atualizacao.mjs, testado em tests/aviso-atualizacao).
// Contrato em web/docs/ATUALIZACAO.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, cliente } = require('./ajuda');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const AGENTES = [
  { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://x', agente_id: 'admin' },
  { slug: 'luna', nome: 'Luna', tipo: 'agente', runner: 'http://x', agente_id: 'luna' },
];

function estado(extra) {
  return Object.assign({
    formato: 1, verificado_em: '2026-10-19T12:00:00.000Z', desligado: false, disponivel: true, motivo: null,
    instalado: { commit: A, versao: 'v1-aaaaaaaaaaaa' },
    publicado: { commit: B, versao: '1.1.0', data: '2026-10-19T11:00:00Z' },
    commits_a_frente: 3, fonte_resumo: 'changelog', novidades: ['Lousa para o agente desenhar.', '<img src=x onerror=alert(1)>'], erro: null,
  }, extra || {});
}
function gravaEstado(w, e) {
  const dir = path.join(w.dados, 'atualizacao');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'estado.json'), typeof e === 'string' ? e : JSON.stringify(e));
}
async function logado(opcoes) {
  const w = await subirWeb(Object.assign({ agentes: AGENTES }, opcoes));
  await w.login();
  return w;
}

test('sem sessão: 401 nas três rotas', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    for (const [m, p] of [['GET', '/api/v1/atualizacao'], ['POST', '/api/v1/atualizacao/descansar'], ['GET', '/api/v1/atualizacao/docs.md']]) {
      const r = await w.c.pedir(m, p, m === 'POST' ? { json: { commit: B } } : {});
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  } finally { await w.fechar(); }
});

test('nunca verificado: disponivel falso, sem faixa', async () => {
  const w = await logado();
  try {
    const r = await w.c.get('/api/v1/atualizacao');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, disponivel: false, mostrar_faixa: false, nunca_verificado: true });
  } finally { await w.fechar(); }
});

test('com versão nova: mostrar_faixa, versões e novidades', async () => {
  const w = await logado();
  try {
    gravaEstado(w, estado());
    const r = await w.c.get('/api/v1/atualizacao');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.disponivel, true);
    assert.equal(r.json.mostrar_faixa, true);
    assert.equal(r.json.desligado, false);
    assert.deepEqual(r.json.instalado, { commit: A, versao: 'v1-aaaaaaaaaaaa' });
    assert.deepEqual(r.json.publicado, { commit: B, versao: '1.1.0', data: '2026-10-19T11:00:00Z' });
    assert.equal(r.json.commits_a_frente, 3);
    assert.equal(r.json.fonte_resumo, 'changelog');
    assert.equal(r.json.novidades.length, 2);
    assert.equal(r.json.novidades[1], '<img src=x onerror=alert(1)>', 'o texto sai cru: quem desenha é que escapa');
    assert.equal(r.json.erro, null);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally { await w.fechar(); }
});

test('em dia ou sem comparação: sem faixa', async () => {
  const w = await logado();
  try {
    gravaEstado(w, estado({ disponivel: false, publicado: null, novidades: [], commits_a_frente: 0, fonte_resumo: null }));
    let r = await w.c.get('/api/v1/atualizacao');
    assert.equal(r.json.disponivel, false);
    assert.equal(r.json.mostrar_faixa, false);
    gravaEstado(w, estado({ disponivel: false, motivo: 'instalacao-fora-do-github', publicado: null }));
    r = await w.c.get('/api/v1/atualizacao');
    assert.equal(r.json.motivo, 'instalacao-fora-do-github');
    assert.equal(r.json.mostrar_faixa, false);
  } finally { await w.fechar(); }
});

test('o servidor não repassa o que não confere (sha ruim, tipos errados, lista enorme)', async () => {
  const w = await logado();
  try {
    gravaEstado(w, estado({
      publicado: { commit: '../../etc/passwd', versao: '1.1.0' },
      novidades: Array.from({ length: 40 }, () => 'x'.repeat(900)),
    }));
    let r = await w.c.get('/api/v1/atualizacao');
    assert.equal(r.json.publicado, null);
    assert.equal(r.json.mostrar_faixa, false, 'sem commit publicado válido não há o que dispensar');
    assert.equal(r.json.novidades.length, 15);
    assert.ok(r.json.novidades.every(n => n.length <= 400));
    gravaEstado(w, estado({ instalado: { commit: A, versao: 'tem espaço <b>' }, commits_a_frente: 'muitos', fonte_resumo: 'inventada' }));
    r = await w.c.get('/api/v1/atualizacao');
    assert.equal(r.json.instalado.versao, null);
    assert.equal(r.json.commits_a_frente, 0);
    assert.equal(r.json.fonte_resumo, null);
  } finally { await w.fechar(); }
});

test('estado ilegível: 500 com o motivo e o que fazer', async () => {
  const w = await logado();
  try {
    gravaEstado(w, '{ isto não é json');
    let r = await w.c.get('/api/v1/atualizacao');
    assert.equal(r.status, 500);
    assert.equal(r.json.ok, false);
    assert.match(r.json.erro, /corrompido/);
    assert.match(r.json.erro, /dgclaw atualizar --checar/);
    gravaEstado(w, '[1,2]');
    r = await w.c.get('/api/v1/atualizacao');
    assert.equal(r.status, 500);
    assert.match(w.log.texto(), /\[erro\] Atualização:/);
  } finally { await w.fechar(); }
});

test('descansar: commit inválido é 400', async () => {
  const w = await logado();
  try {
    gravaEstado(w, estado());
    for (const corpo of [{}, { commit: 'abc' }, { commit: 123 }, { commit: `${B}\n` }, { commit: 'B'.repeat(40) }, { commit: '../../x' }]) {
      const r = await w.c.post('/api/v1/atualizacao/descansar', { json: corpo });
      assert.equal(r.status, 400, JSON.stringify(corpo));
      assert.equal(r.json.ok, false);
    }
    assert.ok(!fs.existsSync(path.join(w.dados, 'atualizacao', 'descanso.json')));
  } finally { await w.fechar(); }
});

test('descansar: commit que não é o publicado é 409', async () => {
  const w = await logado();
  try {
    gravaEstado(w, estado());
    let r = await w.c.post('/api/v1/atualizacao/descansar', { json: { commit: C } });
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /mais nova/);
    assert.ok(!fs.existsSync(path.join(w.dados, 'atualizacao', 'descanso.json')));
    gravaEstado(w, estado({ disponivel: false, publicado: null }));
    r = await w.c.post('/api/v1/atualizacao/descansar', { json: { commit: B } });
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /não há aviso/i);
  } finally { await w.fechar(); }
});

test('descansar: some a faixa, grava 600, e volta só com versão mais nova', async () => {
  const w = await logado();
  try {
    gravaEstado(w, estado());
    const r = await w.c.post('/api/v1/atualizacao/descansar', { json: { commit: B } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, dispensado: B });
    const arq = path.join(w.dados, 'atualizacao', 'descanso.json');
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.dirname(arq)).filter(n => n.endsWith('.tmp')).length, 0);
    let g = await w.c.get('/api/v1/atualizacao');
    assert.equal(g.json.disponivel, true, 'o aviso continua existindo');
    assert.equal(g.json.mostrar_faixa, false, 'mas a faixa descansa');
    gravaEstado(w, estado({ publicado: { commit: C, versao: '1.2.0', data: null } }));
    g = await w.c.get('/api/v1/atualizacao');
    assert.equal(g.json.mostrar_faixa, true, 'versão mais nova traz a faixa de volta');
  } finally { await w.fechar(); }
});

test('descansar: descanso.json ilegível não trava a faixa', async () => {
  const w = await logado();
  try {
    gravaEstado(w, estado());
    fs.writeFileSync(path.join(w.dados, 'atualizacao', 'descanso.json'), 'lixo');
    const g = await w.c.get('/api/v1/atualizacao');
    assert.equal(g.json.mostrar_faixa, true);
    assert.match(w.log.texto(), /descanso\.json está ilegível/);
  } finally { await w.fechar(); }
});

test('método errado é 405 e rota desconhecida é 404', async () => {
  const w = await logado();
  try {
    assert.equal((await w.c.post('/api/v1/atualizacao', { json: {} })).status, 405);
    assert.equal((await w.c.get('/api/v1/atualizacao/descansar')).status, 405);
    assert.equal((await w.c.post('/api/v1/atualizacao/docs.md', { json: {} })).status, 405);
    const r = await w.c.get('/api/v1/atualizacao/nada');
    assert.equal(r.status, 404);
    assert.match(r.json.erro, /docs\.md/);
  } finally { await w.fechar(); }
});

test('POST sem Origin do próprio site é recusado (CSRF), como nas outras rotas', async () => {
  const w = await logado();
  try {
    gravaEstado(w, estado());
    let r = await w.c.post('/api/v1/atualizacao/descansar', { json: { commit: B }, origin: 'https://site-de-fora.exemplo' });
    assert.equal(r.status, 403);
    r = await w.c.post('/api/v1/atualizacao/descansar', { json: { commit: B }, origin: false });
    assert.equal(r.status, 403);
    assert.ok(!fs.existsSync(path.join(w.dados, 'atualizacao', 'descanso.json')));
  } finally { await w.fechar(); }
});

test('agente pela caixa não acessa: 403, e a rota não está na lista liberada', async () => {
  const w = await logado();
  try {
    gravaEstado(w, estado());
    assert.equal(w.web.caixa.rotaPermitida('/api/v1/atualizacao'), false);
    assert.equal(w.web.caixa.rotaPermitida('/api/v1/atualizacao/descansar'), false);
    const c = cliente(w.porta);
    const cab = { 'x-dgclaw-caixa': w.web.caixa.segredo, 'x-dgclaw-agente': 'luna' };
    const g = await c.pedir('GET', '/api/v1/atualizacao', { headers: cab });
    assert.equal(g.status, 403);
    const p = await c.pedir('POST', '/api/v1/atualizacao/descansar', { headers: cab, json: { commit: B } });
    assert.equal(p.status, 403);
    assert.ok(!fs.existsSync(path.join(w.dados, 'atualizacao', 'descanso.json')));
  } finally { await w.fechar(); }
});

test('docs.md: documento para agente, em português, sem travessão', async () => {
  const w = await logado();
  try {
    const r = await w.c.get('/api/v1/atualizacao/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/markdown/);
    assert.match(r.texto, /GET \/api\/v1\/atualizacao/);
    assert.match(r.texto, /POST \/api\/v1\/atualizacao\/descansar/);
    assert.doesNotMatch(r.texto, /[—–]/);
  } finally { await w.fechar(); }
});
