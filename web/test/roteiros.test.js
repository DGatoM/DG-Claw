'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { criarRoteiros, slugDoTitulo } = require('../lib/roteiros');
const { criarConectorDgSocial } = require('../lib/roteiros-dgsocial');
const { pastaTemp, capturaLog } = require('./ajuda');

const AGENTES = [{ slug: 'isa', nome: 'Isa' }, { slug: 'luna', nome: 'Luna' }];
const registroFalso = {
  estado: () => ({ ok: true, agentes: AGENTES, erro: null }),
  obter: (slug) => AGENTES.find((a) => a.slug === slug) || null,
};

/** Um DG Social de mentira: guarda conteúdos na memória e responde só o que o conector usa. */
async function dgsocialFalso() {
  const estado = {
    itens: [], textos: new Map(), chamadas: [], aprovados: [], fora: false, chave: 'segredo-teste',
  };
  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const corpoPartes = [];
    req.on('data', (c) => corpoPartes.push(c));
    req.on('end', () => {
      estado.chamadas.push(`${req.method} ${url.pathname}${url.search}`);
      const json = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (estado.fora) return json(500, { ok: false, error: 'banco indisponível' });
      if (req.headers.authorization !== `Bearer ${estado.chave}`) return json(401, { ok: false, error: 'sem chave' });
      const corpo = corpoPartes.length ? JSON.parse(Buffer.concat(corpoPartes).toString()) : {};
      if (url.pathname === '/api/v1/content/fases') {
        const porFase = {};
        for (const it of estado.itens) (porFase[it.fase] = porFase[it.fase] || []).push(it);
        return json(200, { ok: true, data: { fases: Object.entries(porFase).map(([key, items]) => ({ key, items })) } });
      }
      const m = /^\/api\/v1\/content\/([^/]+)(?:\/(files|roteiro|aprovar-roteiro))?$/.exec(url.pathname);
      if (!m) return json(404, { ok: false, error: 'rota' });
      const [, slug, sub] = m;
      const it = estado.itens.find((i) => i.slug === slug);
      if (!it) return json(404, { ok: false, error: `conteúdo "${slug}" não existe` });
      if (!sub && req.method === 'GET') return json(200, { ok: true, data: { slug, stages: [{ key: 'roteiro', artifactPath: 'roteiro.md' }] } });
      if (sub === 'files') {
        if (!estado.textos.has(slug)) return json(404, { ok: false, error: 'arquivo não encontrado: "roteiro.md"' });
        return json(200, { ok: true, data: { path: 'roteiro.md', text: estado.textos.get(slug) } });
      }
      if (sub === 'roteiro') { estado.textos.set(slug, corpo.text); estado.ultimoActor = corpo.actor; it.updatedAt = new Date().toISOString(); return json(200, { ok: true, data: { saved: true } }); }
      if (sub === 'aprovar-roteiro') { estado.aprovados.push({ slug, actor: corpo.actor }); return json(200, { ok: true, data: { session: { sent: true, queued: false, error: null } } }); }
      return json(404, { ok: false, error: 'rota' });
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  estado.url = `http://127.0.0.1:${servidor.address().port}`;
  estado.fechar = () => { servidor.closeAllConnections(); return new Promise((r) => servidor.close(r)); };
  estado.add = (slug, fase, extra) => {
    estado.itens.push(Object.assign({ slug, title: `Título ${slug}`, fase, updatedAt: '2026-10-20T10:00:00Z', createdAt: '2026-10-19T10:00:00Z', folder: `/x/${slug}`, canal: 'danilo' }, extra || {}));
  };
  return estado;
}

async function montar(opcoes) {
  const o = opcoes || {};
  const dir = pastaTemp('roteiros');
  const pasta = path.join(dir, 'roteiros');
  const cap = capturaLog();
  const relogio = { ms: Date.parse('2026-10-23T23:00:00-03:00') };
  const falso = o.dgsocial === false ? null : o.dgsocial;
  const conector = falso ? criarConectorDgSocial({ url: falso.url, chave: falso.chave, link: 'https://social.exemplo.com', log: cap.log, agora: () => relogio.ms, timeoutMs: 1500 }) : null;
  const roteiros = criarRoteiros({
    dir: pasta, registro: registroFalso, log: cap.log, tz: 'America/Sao_Paulo', agora: () => new Date(relogio.ms),
    dgsocial: conector, agenteDgSocial: o.agenteDgSocial,
  });
  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const q = req.headers['x-quem'] || 'dono';
    const sessao = q === 'dono' ? { usuario: 'dono' } : { via: 'caixa', agente: q, usuario: 'x' };
    if (!(await roteiros.rota(req, res, url, sessao))) { res.writeHead(404); res.end('fora'); }
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  async function pedir(metodo, caminho, { json, quem } = {}) {
    const h = { 'x-quem': quem || 'dono' };
    let body;
    if (json !== undefined) { body = typeof json === 'string' ? json : JSON.stringify(json); h['content-type'] = 'application/json'; }
    const r = await fetch(`http://127.0.0.1:${porta}${caminho}`, { method: metodo, headers: h, body });
    const texto = await r.text();
    let j = null; try { j = JSON.parse(texto); } catch (_) { /* não é JSON */ }
    return { status: r.status, headers: r.headers, texto, json: j };
  }
  return {
    dir, pasta, cap, relogio, pedir, avanca: (min) => { relogio.ms += min * 60000; },
    async fechar() { servidor.closeAllConnections(); await new Promise((r) => servidor.close(r)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function criarLocal(m, extra, quem) {
  const r = await m.pedir('POST', '/api/v1/roteiros', { json: Object.assign({ titulo: 'China demite com IA', texto: 'versão um', resumo: 'Primeira' }, extra || {}), quem });
  assert.equal(r.status, 201, r.texto);
  return r.json.roteiro;
}
const gravar = (m, id, texto, base, extra, quem) => m.pedir('POST', `/api/v1/roteiros/${id}/versoes`, { json: Object.assign({ texto, resumo: `ajuste ${texto}`, base_versao: base }, extra || {}), quem });

test('slug do título tira acento e limita o tamanho', () => {
  assert.equal(slugDoTitulo('China demite: 50% com IA!'), 'china-demite-50-com-ia');
  assert.equal(slugDoTitulo('!!!'), 'roteiro');
  assert.ok(slugDoTitulo('a'.repeat(100)).length <= 40);
});

test('cria, lê e lista com busca e filtro de estado', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r1 = await criarLocal(m);
    assert.match(r1.id, /^rt-china-demite-com-ia-[a-z]{4}$/);
    assert.equal(r1.versao, 1);
    assert.equal(r1.estado, 'em_ajuste');
    assert.equal(r1.agente, 'isa');
    assert.equal(r1.origem, 'local');
    assert.equal(fs.statSync(path.join(m.pasta, `${r1.id}.json`)).mode & 0o777, 0o600);
    m.avanca(5);
    const r2 = await criarLocal(m, { titulo: 'Água no Marte', texto: 'abc', agente: 'luna' });
    const lista = await m.pedir('GET', '/api/v1/roteiros');
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.json.roteiros.map((x) => x.id), [r2.id, r1.id]);
    assert.equal(lista.json.roteiros[0].texto, undefined);
    assert.deepEqual(lista.json.fontes.dgsocial, { ligado: false, ok: true });
    assert.deepEqual((await m.pedir('GET', '/api/v1/roteiros?q=agua')).json.roteiros.map((x) => x.id), [r2.id]);
    assert.deepEqual((await m.pedir('GET', '/api/v1/roteiros?agente=isa')).json.roteiros.map((x) => x.id), [r1.id]);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros?estado=aprovado')).json.roteiros.length, 0);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros?estado=bobagem')).status, 400);
    const um = await m.pedir('GET', `/api/v1/roteiros/${r1.id}`);
    assert.equal(um.json.texto, 'versão um');
    assert.equal((await m.pedir('POST', '/api/v1/roteiros', { json: { texto: 'x' } })).status, 400);
    assert.equal((await m.pedir('POST', '/api/v1/roteiros', { json: { titulo: 'a', texto: 'x', agente: 'nao-existe' } })).status, 400);
  } finally { await m.fechar(); }
});

test('versão: base certa grava, base errada dá 409 com atual, texto igual não cria', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r = await criarLocal(m);
    const ok = await gravar(m, r.id, 'versão dois', 1);
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(ok.json.mudou, true);
    assert.equal(ok.json.roteiro.versao, 2);
    assert.equal(ok.json.roteiro.texto, 'versão dois');
    assert.equal(ok.json.roteiro.hash.length, 64);
    const velha = await gravar(m, r.id, 'outra', 1);
    assert.equal(velha.status, 409);
    assert.match(velha.json.erro, /A versão atual é a 2 \(de dono, 23:00\); você partiu da 1\. Leia a 2 e grave de novo, ou mande forcar:true\./);
    assert.equal(velha.json.atual.versao, 2);
    assert.equal(velha.json.atual.texto, 'versão dois');
    const forcada = await gravar(m, r.id, 'outra', 1, { forcar: true });
    assert.equal(forcada.json.roteiro.versao, 3);
    const igual = await gravar(m, r.id, 'outra', 3);
    assert.equal(igual.json.mudou, false);
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}/versoes`)).json.versoes.length, 3);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/versoes`, { json: { texto: 'x', resumo: 'y' } })).status, 400);
    const semResumo = await m.pedir('POST', `/api/v1/roteiros/${r.id}/versoes`, { json: { texto: 'zzz', base_versao: 3 } });
    assert.equal(semResumo.json.roteiro.resumo, 'Edição à mão');
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/versoes`, { json: { texto: 'q'.repeat(200 * 1024 + 1), resumo: 'a', base_versao: 4 } })).status, 413);
  } finally { await m.fechar(); }
});

test('agente: resumo obrigatório, estado vira aguardando_aprovacao, só os próprios roteiros', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r = await criarLocal(m);
    const semResumo = await m.pedir('POST', `/api/v1/roteiros/${r.id}/versoes`, { json: { texto: 'novo', base_versao: 1 }, quem: 'isa' });
    assert.equal(semResumo.status, 400);
    assert.match(semResumo.json.erro, /resumo/);
    const ok = await gravar(m, r.id, 'novo', 1, undefined, 'isa');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.roteiro.autor, 'isa');
    assert.equal(ok.json.roteiro.estado, 'aguardando_aprovacao');
    // outro agente não vê
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}`, { quem: 'luna' })).status, 404);
    assert.equal((await gravar(m, r.id, 'x', 2, undefined, 'luna')).status, 404);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros', { quem: 'luna' })).json.roteiros.length, 0);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros', { quem: 'isa' })).json.roteiros.length, 1);
    // agente cria só para si
    assert.equal((await m.pedir('POST', '/api/v1/roteiros', { json: { titulo: 'x', texto: 'y', agente: 'luna' }, quem: 'isa' })).status, 403);
    const criado = await m.pedir('POST', '/api/v1/roteiros', { json: { titulo: 'do agente', texto: 'y' }, quem: 'isa' });
    assert.equal(criado.json.roteiro.agente, 'isa');
    assert.equal(criado.json.roteiro.estado, 'aguardando_aprovacao');
    // dono edita um aprovado: volta a em_ajuste
    await m.pedir('POST', `/api/v1/roteiros/${r.id}/aprovar`, { json: { base_versao: 2 } });
    const edicao = await gravar(m, r.id, 'dono mexeu', 2);
    assert.equal(edicao.json.roteiro.estado, 'em_ajuste');
    assert.equal(edicao.json.roteiro.aprovado_em !== null, true);
  } finally { await m.fechar(); }
});

test('desfazer duas vezes seguidas vai 7 -> 6 -> 5 usando restaurada_de', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r = await criarLocal(m, { texto: 't1' });
    for (let i = 2; i <= 7; i++) assert.equal((await gravar(m, r.id, `t${i}`, i - 1)).json.roteiro.versao, i);
    const d1 = await m.pedir('POST', `/api/v1/roteiros/${r.id}/desfazer`, { json: { base_versao: 7 } });
    assert.equal(d1.status, 200, d1.texto);
    assert.equal(d1.json.roteiro.versao, 8);
    assert.equal(d1.json.roteiro.texto, 't6');
    assert.equal(d1.json.roteiro.autor, 'desfazer');
    assert.equal(d1.json.roteiro.resumo, 'Voltou ao texto da versão 6');
    const d2 = await m.pedir('POST', `/api/v1/roteiros/${r.id}/desfazer`, { json: { base_versao: 8 } });
    assert.equal(d2.json.roteiro.versao, 9);
    assert.equal(d2.json.roteiro.texto, 't5');
    const lista = (await m.pedir('GET', `/api/v1/roteiros/${r.id}/versoes`)).json.versoes;
    assert.equal(lista[7].restaurada_de, 6);
    assert.equal(lista[8].restaurada_de, 5);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/desfazer`, { json: { base_versao: 7 } })).status, 409);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/desfazer`, { json: { base_versao: 9 }, quem: 'isa' })).status, 403);
    const r1 = await criarLocal(m, { titulo: 'só uma' });
    const sem = await m.pedir('POST', `/api/v1/roteiros/${r1.id}/desfazer`, { json: { base_versao: 1 } });
    assert.equal(sem.status, 409);
    assert.match(sem.json.erro, /Não há versão anterior/);
  } finally { await m.fechar(); }
});

test('restaurar cria versão nova com o texto antigo', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r = await criarLocal(m, { texto: 'um' });
    await gravar(m, r.id, 'dois', 1);
    await gravar(m, r.id, 'tres', 2);
    const rest = await m.pedir('POST', `/api/v1/roteiros/${r.id}/restaurar`, { json: { versao: 1, base_versao: 3 }, quem: 'isa' });
    assert.equal(rest.status, 200, rest.texto);
    assert.equal(rest.json.roteiro.versao, 4);
    assert.equal(rest.json.roteiro.texto, 'um');
    assert.equal(rest.json.roteiro.autor, 'isa');
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/restaurar`, { json: { versao: 99, base_versao: 4 } })).status, 404);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/restaurar`, { json: { versao: 2, base_versao: 3 } })).status, 409);
    const v1 = await m.pedir('GET', `/api/v1/roteiros/${r.id}/versoes/1`);
    assert.equal(v1.json.versao.texto, 'um');
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}/versoes/50`)).status, 404);
  } finally { await m.fechar(); }
});

test('aprovar: dono aprova, agente recebe 403, base errada dá 409', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r = await criarLocal(m);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/aprovar`, { json: { base_versao: 1 }, quem: 'isa' })).status, 403);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/estado`, { json: { estado: 'aprovado' }, quem: 'isa' })).status, 403);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/aprovar`, { json: { base_versao: 5 } })).status, 409);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/aprovar`, { json: {} })).status, 400);
    const ok = await m.pedir('POST', `/api/v1/roteiros/${r.id}/aprovar`, { json: { base_versao: 1 } });
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(ok.json.roteiro.estado, 'aprovado');
    assert.ok(ok.json.roteiro.aprovado_em);
    const arq = await m.pedir('POST', `/api/v1/roteiros/${r.id}/estado`, { json: { estado: 'arquivado', nota: 'velho' }, quem: 'isa' });
    assert.equal(arq.json.roteiro.estado, 'arquivado');
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/estado`, { json: { estado: 'xis' } })).status, 400);
  } finally { await m.fechar(); }
});

test('ajustando expira em 15 minutos e some quando entra versão nova', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r = await criarLocal(m);
    const lig = await m.pedir('POST', `/api/v1/roteiros/${r.id}/ajustando`, { json: { ativo: true, nota: 'cortando o gancho' }, quem: 'isa' });
    assert.equal(lig.json.ajustando.por, 'isa');
    assert.equal(lig.json.ajustando.nota, 'cortando o gancho');
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}/estado`)).json.ajustando.por, 'isa');
    m.avanca(14);
    assert.ok((await m.pedir('GET', `/api/v1/roteiros/${r.id}/estado`)).json.ajustando);
    m.avanca(2);
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}/estado`)).json.ajustando, null);
    await m.pedir('POST', `/api/v1/roteiros/${r.id}/ajustando`, { json: { ativo: true }, quem: 'isa' });
    await gravar(m, r.id, 'nova', 1, undefined, 'isa');
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}`)).json.ajustando, null);
    await m.pedir('POST', `/api/v1/roteiros/${r.id}/ajustando`, { json: { ativo: true } });
    await m.pedir('POST', `/api/v1/roteiros/${r.id}/ajustando`, { json: { ativo: false } });
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}`)).json.ajustando, null);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/ajustando`, { json: {} })).status, 400);
  } finally { await m.fechar(); }
});

test('eventos com desde e abrir/aberto', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r = await criarLocal(m);
    await gravar(m, r.id, 'dois', 1, undefined, 'isa');
    await gravar(m, r.id, 'tres', 2);
    const todos = (await m.pedir('GET', `/api/v1/roteiros/${r.id}/eventos`)).json;
    assert.deepEqual(todos.eventos.map((e) => e.tipo), ['criado', 'versao', 'edicao_dono']);
    assert.deepEqual(todos.eventos.map((e) => e.n), [1, 2, 3]);
    assert.equal(todos.eventos[1].autor, 'isa');
    assert.equal(todos.eventos[1].versao, 2);
    const desde = (await m.pedir('GET', `/api/v1/roteiros/${r.id}/eventos?desde=2`)).json;
    assert.deepEqual(desde.eventos.map((e) => e.n), [3]);
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}/eventos?desde=x`)).status, 400);

    assert.equal((await m.pedir('GET', '/api/v1/roteiros/aberto?agente=isa')).json.id, null);
    const ab = await m.pedir('POST', `/api/v1/roteiros/${r.id}/abrir`, { quem: 'isa' });
    assert.equal(ab.json.link, `/a/isa?roteiro=${r.id}`);
    const lido = (await m.pedir('GET', '/api/v1/roteiros/aberto?agente=isa')).json;
    assert.equal(lido.id, r.id);
    assert.ok(lido.pedido_em);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros/aberto?agente=luna')).json.id, null);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros/aberto?agente=isa', { quem: 'isa' })).status, 403);
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}/eventos`)).json.eventos.at(-1).tipo, 'abrir');
    assert.equal(fs.statSync(path.join(m.pasta, '_aberto.json')).mode & 0o777, 0o600);
  } finally { await m.fechar(); }
});

test('eventos guardam no máximo 200 e as versões no máximo 300 (a 1 fica)', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r = await criarLocal(m, { texto: 't1' });
    for (let i = 2; i <= 305; i++) await gravar(m, r.id, `t${i}`, i - 1);
    const vs = (await m.pedir('GET', `/api/v1/roteiros/${r.id}/versoes`)).json.versoes;
    assert.equal(vs.length, 300);
    assert.equal(vs[0].versao, 1);
    assert.equal(vs.at(-1).versao, 305);
    const ev = (await m.pedir('GET', `/api/v1/roteiros/${r.id}/eventos`)).json;
    assert.equal(ev.eventos.length, 200);
    assert.equal(ev.eventos.at(-1).n, ev.ultimo);
  } finally { await m.fechar(); }
});

test('arquivo inválido responde 503 e não é sobrescrito', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const r = await criarLocal(m);
    const bom = await criarLocal(m, { titulo: 'outro' });
    const arq = path.join(m.pasta, `${r.id}.json`);
    fs.writeFileSync(arq, '{quebrado', { mode: 0o600 });
    const leitura = await m.pedir('GET', `/api/v1/roteiros/${r.id}`);
    assert.equal(leitura.status, 503);
    assert.match(leitura.json.erro, /inválido/);
    assert.equal((await gravar(m, r.id, 'x', 1)).status, 503);
    assert.equal(fs.readFileSync(arq, 'utf8'), '{quebrado');
    const lista = await m.pedir('GET', '/api/v1/roteiros');
    assert.deepEqual(lista.json.roteiros.map((x) => x.id), [bom.id]);
    assert.equal(lista.json.fontes.local.ok, false);
    assert.match(lista.json.fontes.local.erro, new RegExp(r.id));
    assert.match(m.cap.texto(), /\[erro\].*inválido/);
  } finally { await m.fechar(); }
});

test('docs.md é servido e rotas erradas respondem com motivo', async () => {
  const m = await montar({ dgsocial: false });
  try {
    const d = await m.pedir('GET', '/api/v1/roteiros/docs.md');
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-type'), /markdown/);
    assert.match(d.texto, /base_versao/);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros/Maiuscula')).status, 400);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros/nao-existe-123')).status, 404);
    const r = await criarLocal(m);
    assert.equal((await m.pedir('DELETE', `/api/v1/roteiros/${r.id}`)).status, 405);
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${r.id}/coisa`)).status, 404);
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${r.id}/versoes`, { json: '{nao json' })).status, 400);
  } finally { await m.fechar(); }
});

test('DG Social: lista mapeia as fases e deixa de fora ideia e card sem pasta', async () => {
  const f = await dgsocialFalso();
  const m = await montar({ dgsocial: f, agenteDgSocial: 'isa' });
  try {
    f.add('a-aprovada', 'aprovada');
    f.add('b-roteiro', 'roteiro', { updatedAt: '2026-10-22T10:00:00Z' });
    f.add('c-assets', 'assets');
    f.add('d-prontos', 'prontos');
    f.add('e-render', 'render');
    f.add('f-publicar', 'publicar');
    f.add('g-ideia', 'ideia');
    f.add('h-sem-pasta', 'roteiro', { folder: null });
    const local = await criarLocal(m);
    const lista = await m.pedir('GET', '/api/v1/roteiros');
    assert.equal(lista.status, 200, lista.texto);
    assert.deepEqual(lista.json.fontes.dgsocial, { ligado: true, ok: true });
    const porId = Object.fromEntries(lista.json.roteiros.map((x) => [x.id, x]));
    assert.equal(porId['dgs-a-aprovada'].estado, 'em_ajuste');
    assert.equal(porId['dgs-b-roteiro'].estado, 'aguardando_aprovacao');
    for (const s of ['c-assets', 'd-prontos', 'e-render', 'f-publicar']) assert.equal(porId[`dgs-${s}`].estado, 'aprovado', s);
    assert.equal(porId['dgs-g-ideia'], undefined);
    assert.equal(porId['dgs-h-sem-pasta'], undefined);
    assert.ok(porId[local.id]);
    assert.equal(porId['dgs-b-roteiro'].origem, 'dgsocial');
    assert.equal(porId['dgs-b-roteiro'].ref, 'b-roteiro');
    assert.equal(porId['dgs-b-roteiro'].agente, 'isa');
    assert.equal(porId['dgs-b-roteiro'].link, 'https://social.exemplo.com/content/b-roteiro');
    assert.equal(porId['dgs-b-roteiro'].titulo, 'Título b-roteiro');
    assert.equal(porId['dgs-b-roteiro'].texto, undefined);
    assert.equal(lista.json.roteiros.filter((x) => x.estado === 'aprovado').length, 4);
    // a chave nunca vai para o log
    assert.doesNotMatch(m.cap.texto(), /segredo-teste/);
  } finally { await m.fechar(); await f.fechar(); }
});

test('DG Social: leitura, primeira versão externa, mudança de fora e gravação repassada', async () => {
  const f = await dgsocialFalso();
  const m = await montar({ dgsocial: f, agenteDgSocial: 'isa' });
  try {
    f.add('china', 'roteiro');
    f.textos.set('china', 'texto do DG Social');
    const id = 'dgs-china';
    const um = await m.pedir('GET', `/api/v1/roteiros/${id}`);
    assert.equal(um.status, 200, um.texto);
    assert.equal(um.json.texto, 'texto do DG Social');
    assert.equal(um.json.versao, 1);
    assert.equal(um.json.autor, 'externo');
    assert.equal(um.json.resumo, 'Primeira leitura do DG Social');
    assert.equal(um.json.estado, 'aguardando_aprovacao');
    // dentro do cache de 10 s, mudança de fora ainda não aparece; depois do cache, sim
    f.textos.set('china', 'alguém editou lá');
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${id}/estado`)).json.versao, 1);
    m.avanca(1);
    const dois = await m.pedir('GET', `/api/v1/roteiros/${id}`);
    assert.equal(dois.json.versao, 2);
    assert.equal(dois.json.autor, 'externo');
    assert.equal(dois.json.resumo, 'Mudou fora do modo roteiro');
    assert.equal(dois.json.texto, 'alguém editou lá');
    // gravação do agente vai para o DG Social com actor = autor
    const gr = await gravar(m, id, 'texto da Isa', 2, undefined, 'isa');
    assert.equal(gr.status, 200, gr.texto);
    assert.equal(f.textos.get('china'), 'texto da Isa');
    assert.equal(f.ultimoActor, 'isa');
    assert.equal(gr.json.roteiro.versao, 3);
    assert.equal(gr.json.roteiro.estado, 'aguardando_aprovacao');
    // 409 com base velha
    assert.equal((await gravar(m, id, 'outra', 1, undefined, 'isa')).status, 409);
    // desfazer do dono grava o texto antigo lá
    const d = await m.pedir('POST', `/api/v1/roteiros/${id}/desfazer`, { json: { base_versao: 3 } });
    assert.equal(d.status, 200, d.texto);
    assert.equal(f.textos.get('china'), 'alguém editou lá');
    const ev = (await m.pedir('GET', `/api/v1/roteiros/${id}/eventos`)).json.eventos.map((e) => e.tipo);
    assert.deepEqual(ev, ['externo', 'externo', 'versao', 'desfazer']);
    // agente de outro slug não vê o roteiro do DG Social
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${id}`, { quem: 'luna' })).status, 404);
    // registro fica em disco
    assert.ok(fs.existsSync(path.join(m.pasta, `${id}.json`)));
  } finally { await m.fechar(); await f.fechar(); }
});

test('DG Social: arquivo ainda não escrito vale roteiro vazio', async () => {
  const f = await dgsocialFalso();
  const m = await montar({ dgsocial: f, agenteDgSocial: 'isa' });
  try {
    f.add('novo', 'aprovada');
    const r = await m.pedir('GET', '/api/v1/roteiros/dgs-novo');
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.texto, '');
    assert.equal(r.json.estado, 'em_ajuste');
    const gr = await gravar(m, 'dgs-novo', 'primeiro texto', 1, undefined, 'isa');
    assert.equal(gr.status, 200);
    assert.equal(f.textos.get('novo'), 'primeiro texto');
  } finally { await m.fechar(); await f.fechar(); }
});

test('DG Social: aprovar repassa e devolve o session; estado marcado vence o da fase', async () => {
  const f = await dgsocialFalso();
  const m = await montar({ dgsocial: f, agenteDgSocial: 'isa' });
  try {
    f.add('china', 'aprovada');
    f.textos.set('china', 'texto');
    const id = 'dgs-china';
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${id}`)).json.estado, 'em_ajuste');
    assert.equal((await m.pedir('POST', `/api/v1/roteiros/${id}/aprovar`, { json: { base_versao: 1 }, quem: 'isa' })).status, 403);
    // o agente marca aguardando_aprovacao agora, depois da última atualização do card: vale o marcado
    const est = await m.pedir('POST', `/api/v1/roteiros/${id}/estado`, { json: { estado: 'aguardando_aprovacao' }, quem: 'isa' });
    assert.equal(est.json.roteiro.estado, 'aguardando_aprovacao');
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${id}/estado`)).json.estado, 'aguardando_aprovacao');
    // card muda de fase depois: o derivado fica mais recente e vence
    f.itens[0].fase = 'assets';
    f.itens[0].updatedAt = '2026-10-24T10:00:00Z';
    m.avanca(1);
    assert.equal((await m.pedir('GET', `/api/v1/roteiros/${id}/estado`)).json.estado, 'aprovado');
    f.itens[0].fase = 'roteiro';
    m.avanca(1);
    const ok = await m.pedir('POST', `/api/v1/roteiros/${id}/aprovar`, { json: { base_versao: 1 } });
    assert.equal(ok.status, 200, ok.texto);
    assert.deepEqual(ok.json.session, { sent: true, queued: false, error: null });
    assert.deepEqual(f.aprovados, [{ slug: 'china', actor: 'danilo' }]);
    assert.ok(ok.json.roteiro.aprovado_em);
  } finally { await m.fechar(); await f.fechar(); }
});

test('DG Social fora do ar: lista mostra os locais com a causa; ler e gravar dão 502; aprovar não muda nada', async () => {
  const f = await dgsocialFalso();
  const m = await montar({ dgsocial: f, agenteDgSocial: 'isa' });
  try {
    f.add('china', 'roteiro');
    f.textos.set('china', 'texto');
    const local = await criarLocal(m);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros/dgs-china')).status, 200);
    f.fora = true;
    m.avanca(1);
    const lista = await m.pedir('GET', '/api/v1/roteiros');
    assert.equal(lista.status, 200);
    assert.equal(lista.json.fontes.dgsocial.ligado, true);
    assert.equal(lista.json.fontes.dgsocial.ok, false);
    assert.match(lista.json.fontes.dgsocial.erro, /DG Social respondeu HTTP 500/);
    assert.ok(lista.json.roteiros.some((x) => x.id === local.id));
    assert.ok(lista.json.roteiros.some((x) => x.id === 'dgs-china'), 'o roteiro já registrado continua na lista');
    const leitura = await m.pedir('GET', '/api/v1/roteiros/dgs-china');
    assert.equal(leitura.status, 502);
    assert.match(leitura.json.erro, /DG Social/);
    assert.equal((await gravar(m, 'dgs-china', 'novo', 1, undefined, 'isa')).status, 502);
    assert.equal((await m.pedir('POST', '/api/v1/roteiros/dgs-china/aprovar', { json: { base_versao: 1 } })).status, 502);
    assert.equal((await m.pedir('GET', '/api/v1/roteiros/dgs-china/versoes')).json.versoes.length, 1);
    // o roteiro local segue normal
    assert.equal((await gravar(m, local.id, 'x', 1)).status, 200);
    assert.match(m.cap.texto(), /\[erro\].*http:\/\/127\.0\.0\.1:\d+\/api\/v1\/content/);
    assert.doesNotMatch(m.cap.texto(), /segredo-teste/);
    // sem servidor nenhum (conexão recusada)
    await f.fechar();
    m.avanca(1);
    const semServidor = await m.pedir('GET', '/api/v1/roteiros');
    assert.equal(semServidor.json.fontes.dgsocial.ok, false);
    assert.match(semServidor.json.fontes.dgsocial.erro, /não abriu a conexão|não respondeu/);
  } finally { await m.fechar(); try { await f.fechar(); } catch (_) { /* já fechado no teste */ } }
});

test('DG Social: chave recusada é explicada e agente padrão vem do registro quando a variável está vazia', async () => {
  const f = await dgsocialFalso();
  const m = await montar({ dgsocial: f });
  try {
    f.chave = 'outra-chave';
    f.add('china', 'roteiro');
    const lista = await m.pedir('GET', '/api/v1/roteiros');
    assert.match(lista.json.fontes.dgsocial.erro, /recusou a chave \(HTTP 401\)/);
    f.chave = 'segredo-teste';
    m.avanca(1);
    const ok = await m.pedir('GET', '/api/v1/roteiros');
    assert.equal(ok.json.roteiros[0].agente, 'isa');
    assert.match(m.cap.texto(), /\[aviso\].*DGCLAW_ROTEIROS_DGSOCIAL_AGENTE está vazio.*isa/);
  } finally { await m.fechar(); await f.fechar(); }
});

test('web real: o teste de contrato passa contra o servidor e a documentação está ligada', async () => {
  const { spawn } = require('node:child_process');
  const { subirWeb } = require('./ajuda');
  const t = await subirWeb({ agentes: [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'ana1', chat_id: 'c', avatar: 'A', provedor: 'claude', modelo: 'sonnet', transcripts_dir: '/tmp', home_host: '/tmp', home_container: '/home/agente' }] });
  try {
    await t.login();
    const cookie = Object.entries(t.c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const saida = await new Promise((resolve) => {
      const filho = spawn(process.execPath, [path.join(__dirname, 'roteiros-contrato.js'), `http://127.0.0.1:${t.porta}`, '--cookie', cookie], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      filho.stdout.on('data', (c) => { out += c; });
      filho.stderr.on('data', (c) => { out += c; });
      filho.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(saida.code, 0, saida.out);
    assert.match(saida.out, /Todos os passos passaram/);
    assert.doesNotMatch(saida.out, /FALHOU/);
    const docs = await t.c.get('/api/v1/roteiros/docs.md');
    assert.equal(docs.status, 200);
    assert.equal((await t.c.get('/api/v1/roteiros', { semCookie: true })).status, 401);
  } finally { await t.fechar(); }
});
