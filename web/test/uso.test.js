'use strict';
// Uso da assinatura: GET /api/v1/uso (junta o runner de cada agente), a doc e as peças do menu ☰.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const M = require('../public/menu-lado');

const EM_BREVE = new Date(Date.now() + 3 * 3600_000).toISOString();
const PASSADO = new Date(Date.now() - 3600_000).toISOString();
const USO_ANA = { provedor: 'claude', sessao_5h: { usado_pct: 42.5, zera_em: EM_BREVE, vencida: false }, semanal: { usado_pct: 0, zera_em: EM_BREVE, vencida: false }, plano: null, medido_em: new Date().toISOString(), fonte: 'statusline' };

async function cenario(opAna, opBia, opWeb) {
  const rAna = criarRunnerFalso(Object.assign({ agenteId: 'ana1' }, opAna));
  const rBia = criarRunnerFalso(Object.assign({ agenteId: 'bia1' }, opBia));
  const pAna = await rAna.ouvir(); const pBia = await rBia.ouvir();
  const agentes = [
    { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', home_host: pastaTemp('home') },
    { slug: 'bia', nome: 'Bia', tipo: 'agente', runner: `http://127.0.0.1:${pBia}`, agente_id: 'bia1', home_host: pastaTemp('home') },
  ];
  const t = await subirWeb({ agentes, opcoesServidor: opWeb });
  await t.login();
  return { t, rAna, rBia, fechar: async () => { await t.fechar(); await rAna.fechar(); await rBia.fechar(); } };
}

test('GET /api/v1/uso sem sessão: 401', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    const r = await cliente(s.t.porta).get('/api/v1/uso');
    assert.equal(r.status, 401);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso: um agente medido, outro nunca medido (null, nunca 0) e o motivo vem junto', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    const r = await s.t.c.get('/api/v1/uso');
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true);
    assert.deepEqual(Object.keys(r.json.agentes).sort(), ['ana', 'bia']);
    assert.equal(r.json.agentes.ana.uso.sessao_5h.usado_pct, 42.5);
    assert.equal(r.json.agentes.ana.uso.semanal.usado_pct, 0, 'zero medido continua zero');
    assert.equal(r.json.agentes.bia.uso.sessao_5h, null);
    assert.equal(r.json.agentes.bia.uso.semanal, null);
    assert.match(r.json.agentes.bia.motivo, /próxima resposta do agente/);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso pela caixa de um agente: só o uso dele, nunca o dos outros', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    assert.equal(s.t.web.caixa.rotaPermitida('/api/v1/uso'), true);
    const cab = { 'x-dgclaw-caixa': s.t.web.caixa.segredo, 'x-dgclaw-agente': 'bia' };
    const r = await cliente(s.t.porta).pedir('GET', '/api/v1/uso', { headers: cab });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(Object.keys(r.json.agentes), ['bia']);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso: um runner com erro vira erro só dele, e os outros seguem', async () => {
  const s = await cenario({ uso: USO_ANA }, { falhaUso: { status: 500, corpo: { success: false, error: 'o medidor quebrou', howToFix: 'reiniciar o runner' } } });
  try {
    const r = await s.t.c.get('/api/v1/uso');
    assert.equal(r.status, 200);
    assert.equal(r.json.agentes.ana.uso.sessao_5h.usado_pct, 42.5);
    assert.equal(r.json.agentes.bia.uso, null);
    assert.match(r.json.agentes.bia.erro, /o medidor quebrou/);
    assert.match(r.json.agentes.bia.erro, /reiniciar o runner/);
    assert.match(s.t.log.texto(), /Uso da assinatura de Bia/);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso: runner antigo (404 sem code) e runner fora do ar explicam o que fazer', async () => {
  const s = await cenario({ uso: USO_ANA }, { falhaUso: { status: 404, corpo: { success: false, error: 'Not found' } } });
  try {
    const r = await s.t.c.get('/api/v1/uso');
    assert.match(r.json.agentes.bia.erro, /versão antiga/);
    await s.rBia.fechar();
    const r2 = await s.t.c.get('/api/v1/uso');
    assert.equal(r2.json.agentes.ana.uso.sessao_5h.usado_pct, 42.5);
    assert.match(r2.json.agentes.bia.erro, /Confira se o serviço do agente está rodando/);
  } finally { await s.t.fechar(); await s.rAna.fechar(); }
});

test('GET /api/v1/uso: runner lento estoura o prazo e não segura a resposta dos outros', async () => {
  const s = await cenario({ uso: USO_ANA }, { uso: USO_ANA, atrasoUsoMs: 1500 }, { timeoutUsoMs: 200 });
  try {
    const antes = Date.now();
    const r = await s.t.c.get('/api/v1/uso');
    assert.ok(Date.now() - antes < 1400, 'não esperou o runner lento até o fim');
    assert.equal(r.json.agentes.ana.uso.sessao_5h.usado_pct, 42.5);
    assert.match(r.json.agentes.bia.erro, /não respondeu/);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso: janela vencida passa adiante com vencida:true; método errado é 405', async () => {
  const vencida = Object.assign({}, USO_ANA, { sessao_5h: { usado_pct: 99, zera_em: PASSADO, vencida: true } });
  const s = await cenario({ uso: vencida });
  try {
    const r = await s.t.c.get('/api/v1/uso');
    assert.equal(r.json.agentes.ana.uso.sessao_5h.vencida, true);
    const p = await s.t.c.post('/api/v1/uso', { json: {} });
    assert.equal(p.status, 405);
    assert.match(p.json.erro, /Use GET/);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso/docs.md serve a doc e a caixa do agente libera a rota', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    const r = await s.t.c.get('/api/v1/uso/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /markdown/);
    assert.match(r.texto, /GET \/api\/v1\/uso/);
    assert.match(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), /caixa\.permitir\('\/api\/v1\/uso'\)/);
  } finally { await s.fechar(); }
});

test('menu ☰: seção "Uso das assinaturas" recolhida na casca, e a lista só é buscada ao abrir', () => {
  const casca = require('../public/casca');
  assert.match(casca.MARCACAO_MENU, /<details id="mlUsoDet">/);
  assert.doesNotMatch(casca.MARCACAO_MENU, /<details id="mlUsoDet" open/);
  assert.match(casca.MARCACAO_MENU, /Uso das assinaturas/);
  const js = fs.readFileSync(path.join(__dirname, '../public/menu-lado.js'), 'utf8');
  assert.match(js, /det\.addEventListener\('toggle'/);
  const depoisDoToggle = js.slice(js.indexOf("det.addEventListener('toggle'"));
  assert.equal((js.match(/carregaUso\(\);/g) || []).length, (depoisDoToggle.match(/carregaUso\(\);/g) || []).length, 'carregaUso() só é chamada dentro do toggle');
});

test('menu ☰: faixas de cor, "sem dado" no lugar de 0%, vencida e escape de HTML', () => {
  assert.equal(M.corUso(69.9), 'verde');
  assert.equal(M.corUso(70), 'ambar');
  assert.equal(M.corUso(89.9), 'ambar');
  assert.equal(M.corUso(90), 'vermelho');
  const semDado = M.miniBarraUso('5 h', null);
  assert.match(semDado, /sem dado/);
  assert.doesNotMatch(semDado, /0%/);
  const vencida = M.miniBarraUso('5 h', { usado_pct: 99, zera_em: PASSADO, vencida: true });
  assert.match(vencida, /zerou/);
  assert.doesNotMatch(vencida, /99%/);
  const medida = M.miniBarraUso('Sem', { usado_pct: 93.5, zera_em: EM_BREVE, vencida: false });
  assert.match(medida, /93,5%/);
  assert.match(medida, /ml-uso-bar vermelho/);
  assert.match(medida, /width:93\.5%/);
  const zero = M.miniBarraUso('Sem', { usado_pct: 0, zera_em: EM_BREVE, vencida: false });
  assert.match(zero, /0%/);
  assert.match(zero, /ml-uso-bar verde/);
  const item = M.itemUso({ id: 'x', nome: '<img src=x>' }, { uso: null, erro: 'falhou <b>feio</b>' });
  assert.doesNotMatch(item, /<img|<b>/);
  assert.match(item, /sem dado/);
  assert.match(item, /falhou &lt;b&gt;feio/);
});

test('menu ☰: horário de zerar em hoje, amanhã, dia da semana e data', () => {
  const agora = new Date(2026, 9, 19, 12, 0).getTime();
  assert.equal(M.quandoZeraUso(new Date(2026, 9, 19, 18, 40).toISOString(), agora), 'hoje 18:40');
  assert.equal(M.quandoZeraUso(new Date(2026, 9, 20, 9, 0).toISOString(), agora), 'amanhã 09:00');
  assert.equal(M.quandoZeraUso(new Date(2026, 9, 21, 9, 0).toISOString(), agora), 'qua 09:00');
  assert.equal(M.quandoZeraUso(new Date(2026, 9, 28, 9, 0).toISOString(), agora), '28/10 09:00');
  assert.equal(M.quandoZeraUso('lixo', agora), '');
});
