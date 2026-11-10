'use strict';
// Correções da revisão adversarial do modo demonstração: chave do provedor fora das respostas ao agente,
// pedido em andamento que não recria cartão depois do reset, e leitura de conversa pelo CPDF.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirDemo, CHAVES } = require('./demo-ajuda');
const { pastaTemp } = require('./ajuda');
const { sanitiza } = require('../lib/demo-provedores');

const ROTAS = { contato: '/api/demo/v1/contato', envio: '/api/demo/v1/envio' };
const CHAVE = CHAVES['organizap.key'];
const lerAuditoria = (w) => fs.readFileSync(path.join(w.dados, 'demo', 'auditoria.jsonl'), 'utf8');
const json = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

async function comTeste(opcoes, corpo) {
  const w = await subirDemo(opcoes);
  try { await corpo(w); } finally { await w.fechar(); }
}

test('sanitiza tira a chave, Bearer, sk- e sequências longas, e deixa o texto comum', () => {
  const t = sanitiza(`Invalid credential ${CHAVE} Bearer abc.def sk-proj-ABCDEF123456 ${'x'.repeat(30)} fim`, CHAVE);
  assert.ok(!t.includes(CHAVE) && !/abc\.def|ABCDEF|xxxxxxxx/.test(t), t);
  assert.match(t, /Invalid credential/);
  assert.match(t, /fim/);
});

test('provedor que devolve a chave no erro: nem o agente, nem o cartão, nem a auditoria, nem o log a recebem', () => comTeste({}, async (w) => {
  const ref = await w.liberaContato();
  const pedido = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref, texto: 'oi' });
  assert.equal(pedido.status, 201);
  for (const corpoErro of [{ error: `Invalid credential ${CHAVE}` }, { message: `token ${CHAVE} Bearer ${CHAVE}` }, { details: `x ${CHAVE}` }]) {
    const id = (await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref, texto: 'oi' })).json.id;
    w.fake.falha = { status: 400, corpo: corpoErro };
    await w.decide(id, { decisao: 'confirmar' });
    const fim = await w.esperaFim(id);
    assert.equal(fim.estado, 'falhou');
    assert.equal(fim.codigo, 'PROVEDOR_RECUSOU');
    assert.match(fim.motivo, /recusou o pedido \(HTTP 400\)/);
    const cru = (await w.portao('GET', `/api/demo/v1/envio/${id}`)).texto;
    assert.ok(!cru.includes(CHAVE), 'resposta ao agente sem a chave');
  }
  const tela = await w.c.get('/api/demo/cartoes');
  assert.ok(!tela.texto.includes(CHAVE), 'a tela do dono não mostra a chave');
  assert.match(tela.texto, /\[chave\]/, 'a tela do dono vê a mensagem do provedor, sanitizada');
  assert.ok(!lerAuditoria(w).includes(CHAVE), 'a auditoria sem a chave');
  assert.ok(!w.log.texto().includes(CHAVE), 'o log sem a chave');
  assert.match(w.log.texto(), /HTTP 400/);
  for (const arq of fs.readdirSync(path.join(w.dados, 'demo', 'cartoes'))) {
    assert.ok(!fs.readFileSync(path.join(w.dados, 'demo', 'cartoes', arq), 'utf8').includes(CHAVE), 'cartão em disco sem a chave');
  }
}));

test('leitura de conversa pelo CPDF: completa, com limit e offset das últimas mensagens', async () => {
  const pedidos = [];
  await comTeste({
    opcoesServidor: {
      demoFetch: async (url) => {
        const u = new URL(url);
        if (u.host === 'cpdf.teste' && u.pathname.endsWith('/contacts')) return json(200, { items: [{ id: 'ct-1', displayName: 'Isa Contato', phone: '5511988887777' }] });
        if (u.host === 'cpdf.teste' && u.pathname.endsWith('/conversations')) return json(200, { items: [{ id: 'cv1' }] });
        if (u.host === 'cpdf.teste' && u.pathname.endsWith('/conversations/cv1/messages')) {
          pedidos.push(u.search);
          const todas = [1, 2, 3, 4, 5].map((n) => ({ id: `m${n}`, direction: n % 2 ? 'INBOUND' : 'OUTBOUND', content: `msg ${n}`, createdAt: `2026-11-09T10:0${n}:00Z` }));
          const limit = Number(u.searchParams.get('limit')); const offset = Number(u.searchParams.get('offset') || 0);
          return json(200, { total: 5, items: todas.slice(offset, offset + limit) });
        }
        return json(404, { error: 'nao previsto' });
      },
    },
  }, async (w) => {
    const id = await w.liberaContato('ct-1', 'isa');
    const r = await w.portao('GET', `${ROTAS.contato}/${id}/conversa?limite=3`);
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json.mensagens.map((m) => m.texto), ['msg 3', 'msg 4', 'msg 5']);
    assert.ok(pedidos.some((p) => /limit=3/.test(p) && /offset=2/.test(p)), pedidos.join(' | '));
  });
});

test('pedido em andamento quando o reset acontece não recria cartão do cliente anterior', async () => {
  const dir = pastaTemp('demo-geracao');
  const script = path.join(dir, 'reset-falso.sh');
  fs.writeFileSync(script, '#!/usr/bin/env bash\necho "==> ok"\nexit 0\n', { mode: 0o755 });
  let solta; const portaDoProvedor = new Promise((ok) => { solta = ok; });
  let segurar = false; let preso;
  const espera = new Promise((ok) => { preso = ok; });
  await comTeste({
    opcoesServidor: {
      demoResetBin: script,
      demoFetch: async (url, init) => {
        const u = new URL(url);
        if (segurar && u.host === 'organizap.teste' && u.pathname.endsWith('/chats')) { preso(); await portaDoProvedor; }
        if (u.host === 'organizap.teste' && u.pathname.endsWith('/chats')) {
          return json(200, { success: true, data: [{ id: 'chat-maria-silva', name: 'Maria Silva', remoteJid: '5511999990001@s.whatsapp.net', isGroup: false }] });
        }
        return json(404, { error: 'nao previsto' });
      },
    },
  }, async (w) => {
    segurar = true;
    const antigo = w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', telefone: '5511999990001', texto: 'cliente antigo' });
    await espera; // o pedido está dentro do provedor
    assert.equal((await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } })).status, 202);
    for (let i = 0; i < 100; i++) { if ((await w.c.get('/api/demo/reset/estado')).json.fase !== 'em_andamento') break; await new Promise((ok) => setTimeout(ok, 20)); }
    assert.equal((await w.c.get('/api/demo/reset/estado')).json.fase, 'ok');
    solta();
    const r = await antigo;
    assert.equal(r.status, 503, r.texto);
    assert.equal(r.json.codigo, 'RESET_EM_ANDAMENTO');
    const pasta = path.join(w.dados, 'demo', 'cartoes');
    assert.deepEqual(fs.existsSync(pasta) ? fs.readdirSync(pasta) : [], [], 'nenhum cartão do cliente antigo foi recriado');
    assert.equal((await w.c.get('/api/demo/cartoes')).json.cartoes.length, 0);
    assert.ok(!/cliente antigo/.test(lerAuditoria(w).replace(/texto_sha256/g, '')), 'a auditoria não registra o pedido descartado como "pediu"');
    assert.ok(!/"evento":"pediu"/.test(lerAuditoria(w)));
  });
});

test('envio em segundo plano que termina depois do reset não recria o cartão arquivado', async () => {
  const dir = pastaTemp('demo-geracao-envio');
  const script = path.join(dir, 'reset-falso.sh');
  // o script de verdade MOVE os cartões para o arquivo; aqui o falso só os tira do lugar
  fs.writeFileSync(script, '#!/usr/bin/env bash\nmv "$3/demo/cartoes" "$3/demo/cartoes-arquivados"\nexit 0\n', { mode: 0o755 });
  let solta; const liberado = new Promise((ok) => { solta = ok; });
  let preso; const espera = new Promise((ok) => { preso = ok; });
  await comTeste({
    opcoesServidor: {
      demoResetBin: script,
      demoFetch: async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/chats')) return json(200, { success: true, data: [{ id: 'chat-maria-silva', name: 'Maria Silva', remoteJid: '5511999990001@s.whatsapp.net', isGroup: false }] });
        if (u.pathname.endsWith('/messages/send')) { preso(); await liberado; return json(200, { success: true, data: { status: 'SENT' } }); }
        return json(404, { error: 'nao previsto' });
      },
    },
  }, async (w) => {
    const ref = await w.liberaContato();
    const id = (await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref, texto: 'oi' })).json.id;
    assert.equal((await w.decide(id, { decisao: 'confirmar' })).status, 200);
    await espera;
    assert.equal((await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } })).status, 202);
    for (let i = 0; i < 100; i++) { if ((await w.c.get('/api/demo/reset/estado')).json.fase !== 'em_andamento') break; await new Promise((ok) => setTimeout(ok, 20)); }
    solta();
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal(fs.existsSync(path.join(w.dados, 'demo', 'cartoes', `${id}.json`)), false, 'o cartão do cliente anterior não voltou');
    assert.match(w.log.texto(), /depois de um reset/);
  });
});
