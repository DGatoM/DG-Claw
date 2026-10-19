'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { criarFoco, isoNoFuso } = require('../lib/foco');
const { abrirStream } = require('../lib/sse');
const { subirWeb, pastaTemp } = require('./ajuda');
const { EventEmitter } = require('node:events');

const AGENTES = [{ slug: 'ana', nome: 'Ana' }, { slug: 'bruno', nome: 'Bruno' }];
const registroFalso = (extra) => ({
  estado: () => ({ ok: true, agentes: AGENTES }),
  obter: (s) => (extra && extra.fora === s ? null : AGENTES.find(a => a.slug === s) || null),
});

/** Servidor mínimo só com o foco; a sessão vem do cabeçalho x-sessao (JSON). */
async function subirFoco(opcoes) {
  const o = opcoes || {};
  const dir = pastaTemp('foco');
  const linhas = [];
  const foco = criarFoco({
    dir: path.join(dir, 'foco'), tz: 'America/Sao_Paulo', log: (n, m) => linhas.push(`[${n}] ${m}`),
    registro: registroFalso(), gravaRetrato: o.gravaRetrato || null, push: o.push || null, quemChamou: null,
  });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const sessao = JSON.parse(req.headers['x-sessao'] || '{"usuario":"dono"}');
    if (!await foco.tratarRota(req, res, url, sessao)) { res.writeHead(418); res.end('fora'); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const porta = srv.address().port;
  function pedir(metodo, caminho, corpo, sessao) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (sessao) headers['x-sessao'] = JSON.stringify(sessao);
      let txt;
      if (corpo !== undefined) { txt = typeof corpo === 'string' ? corpo : JSON.stringify(corpo); headers['content-type'] = 'application/json'; }
      const rq = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho, headers }, (res) => {
        const p = []; res.on('data', c => p.push(c));
        res.on('end', () => { const texto = Buffer.concat(p).toString('utf8'); let json = null; try { json = JSON.parse(texto); } catch (_) { /* markdown */ } resolve({ status: res.statusCode, headers: res.headers, texto, json }); });
      });
      rq.on('error', reject); if (txt) rq.write(txt); rq.end();
    });
  }
  return { foco, pedir, dir, linhas, arquivo: (s) => path.join(dir, 'foco', s + '.json'), fechar: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const CAIXA = (slug) => ({ usuario: 'agente:' + slug, via: 'caixa', agente: slug });

test('lista vazia, PUT, ids que não se repetem, ordem e fuso', async () => {
  const s = await subirFoco();
  try {
    const v = await s.pedir('GET', '/api/v1/foco/ana');
    assert.equal(v.status, 200);
    assert.deepEqual(v.json.lista, { agente: 'ana', titulo: 'Modo foco', itens: [], feitos: 0, total: 0, versao: 0, atualizada_em: null });
    const p = await s.pedir('PUT', '/api/v1/foco/ana', { titulo: '  Foco   de hoje ', itens: ['  Revisar   o contrato ', { texto: 'Ligar', feito: true }] });
    assert.equal(p.status, 200, p.texto);
    const l = p.json.lista;
    assert.equal(l.titulo, 'Foco de hoje'); assert.equal(l.versao, 1);
    assert.deepEqual(l.itens.map(i => [i.id, i.texto, i.feito, i.ordem, i.feito_por]), [[1, 'Revisar o contrato', false, 1, null], [2, 'Ligar', true, 2, 'dono']]);
    assert.match(l.itens[1].feito_em, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-03:00$/);
    assert.match(l.atualizada_em, /-03:00$/);
    const q = await s.pedir('PUT', '/api/v1/foco/ana', { itens: ['Novo'] });
    assert.equal(q.json.lista.titulo, 'Foco de hoje');
    assert.equal(q.json.lista.itens[0].id, 3);
    const pos = await s.pedir('POST', '/api/v1/foco/ana/itens', { texto: 'Outro' });
    assert.equal(pos.status, 201); assert.equal(pos.json.lista.itens[1].id, 4);
    await s.pedir('DELETE', '/api/v1/foco/ana/itens/4');
    const pos2 = await s.pedir('POST', '/api/v1/foco/ana/itens', { texto: 'Depois do apagar' });
    assert.equal(pos2.json.lista.itens[1].id, 5);
    assert.equal(fs.statSync(s.arquivo('ana')).mode & 0o777, 0o600);
    // a lista do Bruno é independente
    assert.equal((await s.pedir('GET', '/api/v1/foco/bruno')).json.lista.total, 0);
  } finally { s.fechar(); }
});

test('PATCH, mudou:false, DELETE da lista e eventos com cursor', async () => {
  const s = await subirFoco();
  try {
    await s.pedir('PUT', '/api/v1/foco/ana', { titulo: 'X', itens: ['a', 'b'] });
    let r = await s.pedir('PATCH', '/api/v1/foco/ana/itens/1', { feito: true });
    assert.equal(r.json.mudou, true); assert.equal(r.json.lista.feitos, 1); assert.equal(r.json.lista.versao, 2);
    r = await s.pedir('PATCH', '/api/v1/foco/ana/itens/1', { feito: true });
    assert.equal(r.status, 200); assert.equal(r.json.mudou, false); assert.equal(r.json.lista.versao, 2);
    r = await s.pedir('PATCH', '/api/v1/foco/ana/itens/1', { feito: false, texto: 'a2' });
    assert.equal(r.json.lista.itens[0].feito_em, null);
    r = await s.pedir('DELETE', '/api/v1/foco/ana/itens/2');
    assert.equal(r.json.lista.total, 1);
    const ev = await s.pedir('GET', '/api/v1/foco/ana/eventos');
    assert.deepEqual(ev.json.eventos.map(e => e.tipo), ['substituiu', 'ticou', 'editou', 'desticou', 'apagou']);
    assert.equal(ev.json.ultimo_id, 5); assert.equal(ev.json.tem_mais, false);
    assert.equal(ev.json.eventos[1].por, 'dono'); assert.equal(ev.json.eventos[1].texto, 'a');
    const de = await s.pedir('GET', '/api/v1/foco/ana/eventos?desde_id=3');
    assert.deepEqual(de.json.eventos.map(e => e.id), [4, 5]);
    const igual = await s.pedir('GET', '/api/v1/foco/ana/eventos?desde_id=5');
    assert.deepEqual(igual.json, { ok: true, eventos: [], ultimo_id: 5, tem_mais: false });
    r = await s.pedir('DELETE', '/api/v1/foco/ana');
    assert.equal(r.json.lista.total, 0); assert.equal(r.json.lista.titulo, 'Modo foco');
    r = await s.pedir('DELETE', '/api/v1/foco/ana');
    assert.equal(r.json.mudou, false);
  } finally { s.fechar(); }
});

test('eventos: até 200 por vez com tem_mais, e guarda só os últimos 1000', async () => {
  const s = await subirFoco();
  try {
    await s.pedir('PUT', '/api/v1/foco/ana', { itens: ['a'] });
    for (let i = 0; i < 1100; i++) await s.pedir('PATCH', '/api/v1/foco/ana/itens/1', { feito: i % 2 === 0 });
    const d = JSON.parse(fs.readFileSync(s.arquivo('ana'), 'utf8'));
    assert.equal(d.eventos.length, 1000); assert.equal(d.eventos[999].id, 1101);
    const e = await s.pedir('GET', '/api/v1/foco/ana/eventos?desde_id=0');
    assert.equal(e.json.eventos.length, 200); assert.equal(e.json.tem_mais, true);
    assert.equal(e.json.ultimo_id, e.json.eventos[199].id);
    const f = await s.pedir('GET', '/api/v1/foco/ana/eventos?desde_id=1000');
    assert.equal(f.json.tem_mais, false);
  } finally { s.fechar(); }
});

test('validações: limites, campo desconhecido, tipos e ids', async () => {
  const s = await subirFoco();
  try {
    const erro = async (m, c, corpo, status, rx, sessao) => {
      const r = await s.pedir(m, c, corpo, sessao);
      assert.equal(r.status, status, `${m} ${c} ${r.texto}`);
      assert.equal(r.json.ok, false); assert.match(r.json.erro, rx);
    };
    await erro('PUT', '/api/v1/foco/ana', '[1]', 400, /objeto JSON/);
    await erro('PUT', '/api/v1/foco/ana', '{quebrado', 400, /JSON válido/);
    await erro('PUT', '/api/v1/foco/ana', {}, 400, /"itens"/);
    await erro('PUT', '/api/v1/foco/ana', { itens: 'x' }, 400, /lista/);
    await erro('PUT', '/api/v1/foco/ana', { itens: [], cor: 'azul' }, 400, /"cor"/);
    await erro('PUT', '/api/v1/foco/ana', { itens: [{ texto: 'a', prazo: 1 }] }, 400, /"prazo"/);
    await erro('PUT', '/api/v1/foco/ana', { itens: Array.from({ length: 51 }, (_, i) => 'i' + i) }, 400, /51 itens.*50/);
    await erro('PUT', '/api/v1/foco/ana', { itens: ['  '] }, 400, /vazio/);
    await erro('PUT', '/api/v1/foco/ana', { itens: ['x'.repeat(301)] }, 400, /301.*300/);
    await erro('PUT', '/api/v1/foco/ana', { titulo: 'x'.repeat(81), itens: [] }, 400, /81.*80/);
    await erro('PUT', '/api/v1/foco/ana', { itens: [{ texto: 'a', feito: 'sim' }] }, 400, /true ou false/);
    assert.equal((await s.pedir('PUT', '/api/v1/foco/ana', { titulo: 'x'.repeat(80), itens: Array.from({ length: 50 }, () => 'y'.repeat(300)) })).status, 200);
    await erro('POST', '/api/v1/foco/ana/itens', { texto: 'mais um' }, 400, /50 itens/);
    await erro('PATCH', '/api/v1/foco/ana/itens/1', {}, 400, /"feito"/);
    await erro('PATCH', '/api/v1/foco/ana/itens/1', { feito: 1 }, 400, /true ou false/);
    await erro('PATCH', '/api/v1/foco/ana/itens/abc', { feito: true }, 400, /número/);
    await erro('PATCH', '/api/v1/foco/ana/itens/999', { feito: true }, 404, /GET \/api\/v1\/foco\/ana/);
    await erro('DELETE', '/api/v1/foco/ana/itens/999', undefined, 404, /GET \/api\/v1\/foco\/ana/);
    await erro('GET', '/api/v1/foco/ana/eventos?desde_id=-1', undefined, 400, /desde_id/);
    await erro('GET', '/api/v1/foco/ana/eventos?desde_id=1.5', undefined, 400, /desde_id/);
    await erro('GET', '/api/v1/foco/zeca', undefined, 404, /Não existe agente/);
    await erro('GET', '/api/v1/foco/ana/nada', undefined, 404, /Não existe a rota/);
    const m = await s.pedir('POST', '/api/v1/foco/ana');
    assert.equal(m.status, 405); assert.match(m.json.erro, /GET, PUT, DELETE/); assert.equal(m.headers.allow, 'GET, PUT, DELETE');
    assert.equal((await s.pedir('GET', '/api/v1/foco/ana/itens')).status, 405);
    assert.equal((await s.pedir('PUT', '/api/v1/foco/ana/itens/1')).status, 405);
    assert.equal((await s.pedir('POST', '/api/v1/foco/ana/eventos')).status, 405);
    assert.equal((await s.pedir('GET', '/api/v1/outra')).status, 418);
  } finally { s.fechar(); }
});

test('caixa: alias eu, 403 em lista alheia, eu com login é 400', async () => {
  const s = await subirFoco();
  try {
    const r = await s.pedir('PUT', '/api/v1/foco/eu', { itens: ['a'] }, CAIXA('ana'));
    assert.equal(r.status, 200); assert.equal(r.json.lista.agente, 'ana');
    const t = await s.pedir('PATCH', '/api/v1/foco/eu/itens/1', { feito: true }, CAIXA('ana'));
    assert.equal(t.json.lista.itens[0].feito_por, 'agente');
    assert.equal((await s.pedir('GET', '/api/v1/foco/ana', undefined, CAIXA('ana'))).status, 200);
    const proibido = await s.pedir('GET', '/api/v1/foco/bruno', undefined, CAIXA('ana'));
    assert.equal(proibido.status, 403); assert.match(proibido.json.erro, /"ana".*"bruno"/);
    assert.equal((await s.pedir('PUT', '/api/v1/foco/bruno', { itens: ['x'] }, CAIXA('ana'))).status, 403);
    assert.equal((await s.pedir('GET', '/api/v1/foco/bruno')).status, 200);
    const eu = await s.pedir('GET', '/api/v1/foco/eu');
    assert.equal(eu.status, 400); assert.match(eu.json.erro, /id do agente/);
    const ev = (await s.pedir('GET', '/api/v1/foco/eu/eventos', undefined, CAIXA('ana'))).json.eventos;
    assert.deepEqual(ev.map(e => e.por), ['agente', 'agente']);
  } finally { s.fechar(); }
});

test('arquivo inválido: 503 com caminho, nada é sobrescrito; falha de gravação é 503', async () => {
  const s = await subirFoco();
  try {
    await s.pedir('PUT', '/api/v1/foco/ana', { itens: ['a'] });
    fs.writeFileSync(s.arquivo('ana'), 'quebrado{');
    for (const [m, c, b] of [['GET', '/api/v1/foco/ana'], ['PUT', '/api/v1/foco/ana', { itens: ['b'] }], ['POST', '/api/v1/foco/ana/itens', { texto: 'x' }], ['DELETE', '/api/v1/foco/ana'], ['GET', '/api/v1/foco/ana/eventos']]) {
      const r = await s.pedir(m, c, b);
      assert.equal(r.status, 503, `${m} ${c}`); assert.ok(r.json.erro.includes(s.arquivo('ana')));
    }
    assert.equal(fs.readFileSync(s.arquivo('ana'), 'utf8'), 'quebrado{');
    assert.throws(() => s.foco.lista('ana'), /inválido/);
    // pasta que não aceita gravação
    fs.rmSync(path.join(s.dir, 'foco'), { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'foco'), 'sou um arquivo');
    const g = await s.pedir('PUT', '/api/v1/foco/bruno', { itens: ['a'] });
    assert.equal(g.status, 503); assert.match(g.json.erro, /Não consegui (ler|gravar)/);
    assert.ok(s.linhas.some(l => l.startsWith('[erro]')));
  } finally { s.fechar(); }
});

test('retrato: objeto certo a cada mudança, sem chamar quando mudou:false; falha não desfaz', async () => {
  const chamadas = []; let falha = false;
  const s = await subirFoco({ gravaRetrato: async (...a) => { chamadas.push(a); if (falha) throw new Error('disco cheio'); } });
  try {
    await s.pedir('PUT', '/api/v1/foco/ana', { titulo: 'T', itens: ['a'] });
    assert.equal(chamadas.length, 1);
    const [ag, frente, obj] = chamadas[0];
    assert.equal(ag, 'ana'); assert.equal(frente, 'foco');
    assert.deepEqual(Object.keys(obj).sort(), ['eventos', 'lista', 'ultimo_id']);
    assert.equal(obj.lista.titulo, 'T'); assert.equal(obj.ultimo_id, 1); assert.equal(obj.eventos.length, 1);
    await s.pedir('PATCH', '/api/v1/foco/ana/itens/1', { feito: false });
    assert.equal(chamadas.length, 1);
    falha = true;
    const r = await s.pedir('PATCH', '/api/v1/foco/ana/itens/1', { feito: true });
    assert.equal(r.status, 200); assert.equal(r.json.mudou, true); assert.equal(r.json.lista.feitos, 1);
    assert.equal(s.foco.lista('ana').feitos, 1);
    assert.ok(s.linhas.some(l => l.startsWith('[aviso]') && l.includes('disco cheio') && l.includes('ana')));
    // eventos ficam limitados a 50 no retrato
    falha = false;
    for (let i = 0; i < 60; i++) await s.pedir('PATCH', '/api/v1/foco/ana/itens/1', { feito: i % 2 === 1 });
    assert.equal(chamadas.at(-1)[2].eventos.length, 50);
  } finally { s.fechar(); }
});

test('push: só no PUT feito pelo agente; falha vai para o log e a resposta sai normal', async () => {
  const envios = []; let lancar = false;
  const s = await subirFoco({ push: { enviar: async (a) => { envios.push(a); if (lancar) throw new Error('chaves ilegíveis'); return { inscricoes: 0, ok: 0, removidas: 0, falhas: [] }; } } });
  try {
    await s.pedir('PUT', '/api/v1/foco/ana', { itens: ['a'] });
    await s.pedir('PUT', '/api/v1/foco/ana', { itens: ['a'] }, CAIXA('ana'));
    await s.pedir('POST', '/api/v1/foco/eu/itens', { texto: 'b' }, CAIXA('ana'));
    await s.pedir('PATCH', '/api/v1/foco/eu/itens/2', { feito: true }, CAIXA('ana'));
    assert.equal(envios.length, 1);
    assert.deepEqual(envios[0], { titulo: '🎯 Ana montou seu foco', corpo: '1 item', tag: 'foco-ana', url: '/a/ana' });
    lancar = true;
    const r = await s.pedir('PUT', '/api/v1/foco/eu', { itens: ['a', 'b', 'c'] }, CAIXA('ana'));
    assert.equal(r.status, 200); assert.equal(envios[1].corpo, '3 itens');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(s.linhas.some(l => l.includes('chaves ilegíveis')));
  } finally { s.fechar(); }
});

test('docs.md é servido como markdown', async () => {
  const s = await subirFoco();
  try {
    const r = await s.pedir('GET', '/api/v1/foco/docs.md');
    assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/markdown/); assert.match(r.texto, /^# Modo foco/);
    assert.equal((await s.pedir('POST', '/api/v1/foco/docs.md')).status, 405);
  } finally { s.fechar(); }
});

test('isoNoFuso devolve o deslocamento do fuso', () => {
  assert.equal(isoNoFuso(new Date('2026-10-16T13:12:03Z'), 'America/Sao_Paulo'), '2026-10-16T10:12:03-03:00');
  assert.equal(isoNoFuso(new Date('2026-10-16T13:12:03Z'), 'UTC'), '2026-10-16T13:12:03+00:00');
  assert.equal(isoNoFuso(new Date('2026-01-16T00:00:00Z'), 'Asia/Kolkata'), '2026-01-16T05:30:00+05:30');
});

test('pelo Web: 401 sem login, Origin exigido na escrita, fluxo com sessão e agente fora do registro', async () => {
  const agente = { slug: 'ana', nome: 'Ana', runner: 'http://127.0.0.1:1', agente_id: 'ana1' };
  const s = await subirWeb({ agentes: [agente] });
  try {
    assert.equal((await s.c.get('/api/v1/foco/ana')).status, 401);
    assert.equal((await s.c.get('/api/v1/foco/docs.md')).status, 401);
    await s.login();
    assert.equal((await s.c.pedir('PUT', '/api/v1/foco/ana', { json: { itens: ['a'] }, origin: 'https://intruso.example' })).status, 403);
    assert.equal((await s.c.pedir('PUT', '/api/v1/foco/ana', { json: { itens: ['a'] }, origin: false })).status, 403);
    const p = await s.c.pedir('PUT', '/api/v1/foco/ana', { json: { itens: ['a'] } });
    assert.equal(p.status, 200, p.texto);
    const t = await s.c.pedir('PATCH', '/api/v1/foco/ana/itens/1', { json: { feito: true } });
    assert.equal(t.json.lista.itens[0].feito_por, 'dono');
    assert.equal((await s.c.get('/api/v1/foco/ana')).json.lista.feitos, 1);
    assert.equal((await s.c.get('/api/v1/foco/zeca')).status, 404);
    assert.equal((await s.c.get('/api/v1/foco/eu')).status, 400);
    assert.equal((await s.c.get('/api/v1/foco/docs.md')).status, 200);
    assert.ok(fs.existsSync(path.join(s.dados, 'foco', 'ana.json')));
  } finally { await s.fechar(); }
});

// ── SSE ──
function streamDeTeste(fontes, tickMs) {
  const res = new EventEmitter(); const foco = [];
  res.writeHead = () => {}; res.flushHeaders = () => {}; res.end = () => {};
  res.write = (s) => { if (s.startsWith('event: foco')) foco.push(JSON.parse(s.split('data: ')[1].split('\n')[0])); };
  const logs = [];
  const encerra = abrirStream({ req: {}, res, agente: { slug: 'ana' }, since: 0, tickMs, log: (n, m) => logs.push(m),
    fontes: Object.assign({ versaoJs: () => '', atividade: async () => ({ estado: 'ocioso' }), thread: async () => ({ versao: 1, avisos: [], msgs: [] }) }, fontes) });
  return { foco, logs, encerra };
}
const espera = (ms) => new Promise(r => setTimeout(r, ms));

test('SSE: evento foco no primeiro tique e só quando a versão muda', async () => {
  let lista = { agente: 'ana', itens: [], versao: 0 };
  const st = streamDeTeste({ foco: async () => lista }, 5);
  try {
    await espera(40);
    assert.equal(st.foco.length, 1); assert.equal(st.foco[0].agente, 'ana'); assert.equal(st.foco[0].lista.versao, 0);
    lista = { agente: 'ana', itens: [{ id: 1 }], versao: 1 };
    await espera(40);
    assert.equal(st.foco.length, 2); assert.equal(st.foco[1].lista.versao, 1);
  } finally { st.encerra(); }
});

test('SSE: fonte do foco que lança vira lista:null com o erro, uma vez, sem derrubar o stream', async () => {
  let estado = 'erro1'; const msgs = [];
  const st = streamDeTeste({ foco: async () => { if (estado.startsWith('erro')) throw new Error(estado); return { agente: 'ana', itens: [], versao: 3 }; } }, 5);
  try {
    await espera(40);
    assert.deepEqual(st.foco, [{ agente: 'ana', lista: null, erro: 'erro1' }]);
    estado = 'erro2'; await espera(40);
    assert.equal(st.foco.length, 2); assert.equal(st.foco[1].erro, 'erro2');
    estado = 'ok'; await espera(40);
    assert.equal(st.foco.length, 3); assert.equal(st.foco[2].lista.versao, 3);
    assert.ok(!st.logs.some(l => /falha ao atualizar/.test(l)));
  } finally { st.encerra(); }
});

test('SSE: sem fonte de foco o stream segue como antes', async () => {
  const st = streamDeTeste({}, 5);
  try { await espera(30); assert.equal(st.foco.length, 0); } finally { st.encerra(); }
});

test('SSE pelo Web: o primeiro tique traz a lista do agente e a mudança chega depois', async () => {
  const agente = { slug: 'ana', nome: 'Ana', runner: 'http://127.0.0.1:1', agente_id: 'ana1', chat_id: 'c_ana' };
  const s = await subirWeb({ agentes: [agente] });
  let req;
  try {
    await s.login();
    await s.c.pedir('PUT', '/api/v1/foco/ana', { json: { itens: ['a', 'b'] } });
    const ck = Object.entries(s.c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const eventos = [];
    let buf = '';
    await new Promise((resolve, reject) => {
      req = http.request({ host: '127.0.0.1', port: s.porta, path: '/api/v1/agents/ana/stream', headers: { Cookie: ck } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          for (const bloco of buf.split('\n\n').slice(0, -1)) {
            if (bloco.startsWith('event: foco')) eventos.push(JSON.parse(bloco.split('data: ')[1]));
          }
          buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
          if (eventos.length === 1) s.c.pedir('PATCH', '/api/v1/foco/ana/itens/1', { json: { feito: true } }).catch(reject);
          if (eventos.length >= 2) resolve();
        });
      });
      req.on('error', reject); req.end();
      setTimeout(() => reject(new Error('o stream não trouxe os dois eventos foco')), 3000);
    });
    assert.equal(eventos[0].lista.total, 2); assert.equal(eventos[0].lista.versao, 1);
    assert.equal(eventos[1].lista.feitos, 1); assert.equal(eventos[1].lista.versao, 2);
  } finally { if (req) req.destroy(); await s.fechar(); }
});

test('DELETE da lista com ?versao: versão velha dá 409 com a lista atual e não apaga; versão atual limpa', async () => {
  const s = await subirFoco();
  try {
    await s.pedir('PUT', '/api/v1/foco/ana', { itens: ['a', 'b'] });
    const vista = (await s.pedir('GET', '/api/v1/foco/ana')).json.lista.versao;
    await s.pedir('POST', '/api/v1/foco/ana/itens', { texto: 'novo do agente' });
    let r = await s.pedir('DELETE', '/api/v1/foco/ana?versao=' + vista);
    assert.equal(r.status, 409);
    assert.equal(r.json.ok, false);
    assert.match(r.json.erro, /mudou desde a versão/);
    assert.equal(r.json.lista.total, 3);
    assert.equal((await s.pedir('GET', '/api/v1/foco/ana')).json.lista.total, 3, 'nada foi apagado');
    r = await s.pedir('DELETE', '/api/v1/foco/ana?versao=' + r.json.lista.versao);
    assert.equal(r.status, 200); assert.equal(r.json.lista.total, 0);
    r = await s.pedir('DELETE', '/api/v1/foco/ana?versao=abc');
    assert.equal(r.status, 400); assert.match(r.json.erro, /"versao"/);
    // sem o parâmetro, limpa como sempre
    await s.pedir('PUT', '/api/v1/foco/ana', { itens: ['x'] });
    assert.equal((await s.pedir('DELETE', '/api/v1/foco/ana')).json.lista.total, 0);
  } finally { s.fechar(); }
});
