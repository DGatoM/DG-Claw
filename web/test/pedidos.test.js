'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { criarPedidos } = require('../lib/pedidos');
const { pastaTemp, capturaLog, subirWeb } = require('./ajuda');

const AGENTES = [{ slug: 'luna', nome: 'Luna' }, { slug: 'marina', nome: 'Marina' }];
const registroFalso = {
  estado: () => ({ ok: true, agentes: AGENTES, erro: null }),
  obter: (slug) => AGENTES.find((a) => a.slug === slug) || null,
};
const EP0 = Date.parse('2026-11-12T10:00:00-03:00') / 1000;

/** Fila com relógio controlado, conversa falsa (msgs por agente) e servidor HTTP; quem vem no cabeçalho x-quem. */
async function montar() {
  const dir = pastaTemp('pedidos');
  const dados = path.join(dir, 'dados');
  fs.mkdirSync(dados, { mode: 0o700 });
  const arquivo = path.join(dados, 'pedidos', 'pedidos.json');
  const cap = capturaLog();
  const relogio = { ms: EP0 * 1000 };
  const conv = { luna: [], marina: [], quebrada: false };
  const conversa = {
    thread: async (ag) => {
      if (conv.quebrada) throw new Error('transcript ilegível');
      return { msgs: conv[ag.slug] || [], avisos: [] };
    },
  };
  const fila = criarPedidos({ arquivo, raiz: dados, registro: registroFalso, conversa, log: cap.log, tz: 'America/Sao_Paulo', agora: () => new Date(relogio.ms) });
  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const q = req.headers['x-quem'] || 'dono';
    const sessao = q === 'dono' ? { usuario: 'dono' } : { via: 'caixa', agente: q, usuario: 'x' };
    if (!(await fila.rota(req, res, url, sessao))) { res.writeHead(404); res.end('fora'); }
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  async function pedir(metodo, caminho, { json, quem, headers } = {}) {
    const h = Object.assign({ 'x-quem': quem || 'dono' }, headers || {});
    let body;
    if (json !== undefined) { body = typeof json === 'string' ? json : JSON.stringify(json); h['content-type'] = 'application/json'; }
    const r = await fetch(`http://127.0.0.1:${porta}${caminho}`, { method: metodo, headers: h, body });
    const texto = await r.text();
    let j = null; try { j = JSON.parse(texto); } catch (_) { /* não é JSON */ }
    return { status: r.status, headers: r.headers, texto, json: j };
  }
  let n = 0;
  const msg = (origin, extra) => { n += 1; return Object.assign({ id: String(n).padStart(16, 'a'), ep: relogio.ms / 1000 + n * 0.001, origin, text: 't', quem: origin === 'dono' ? 'pessoa' : 'agente' }, extra || {}); };
  return {
    dir, arquivo, cap, relogio, conv, pedir, msg,
    avanca: (min) => { relogio.ms += min * 60000; },
    async fechar() { servidor.closeAllConnections(); await new Promise((r) => servidor.close(r)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function criarPedido(m, quem, texto) {
  const r = await m.pedir('POST', '/api/v1/pedidos', { json: { texto: texto || 'Dono, 12/11 10h25: refazer a capa' }, quem: quem || 'luna' });
  assert.equal(r.status, 201, r.texto);
  return r.json.pedido;
}

test('criar: nasce fazendo, na ordem de chegada, com histórico', async () => {
  const m = await montar();
  try {
    const a = await criarPedido(m);
    const b = await criarPedido(m, 'luna', 'segundo');
    assert.equal(a.id, 1); assert.equal(b.id, 2);
    assert.equal(a.estado, 'fazendo');
    assert.equal(a.agente, 'luna');
    assert.equal(a.criado_por, 'agente luna');
    assert.equal(a.criado_em, '2026-11-12T10:00:00-03:00');
    assert.equal(a.historico.length, 1);
    assert.equal(a.historico[0].para, 'fazendo');
    const l = await m.pedir('GET', '/api/v1/pedidos');
    assert.deepEqual(l.json.pedidos.map((p) => p.id), [1, 2]);
    assert.equal(l.json.contagem.fazendo, 2);
  } finally { await m.fechar(); }
});

test('criar: dono não cria; agente não cria para outro; texto vazio, grande ou com controle é recusado', async () => {
  const m = await montar();
  try {
    assert.equal((await m.pedir('POST', '/api/v1/pedidos', { json: { texto: 'x' } })).status, 403);
    const outro = await m.pedir('POST', '/api/v1/pedidos', { json: { texto: 'x', agente: 'marina' }, quem: 'luna' });
    assert.equal(outro.status, 403);
    assert.match(outro.json.erro, /só cria pedido para si/);
    for (const texto of ['', '   ', 'x'.repeat(301), 'a\u0000b', 5]) {
      const r = await m.pedir('POST', '/api/v1/pedidos', { json: { texto }, quem: 'luna' });
      assert.equal(r.status, 400, `texto ${JSON.stringify(texto).slice(0, 20)}`);
      assert.ok(r.json.erros.texto);
    }
    assert.equal((await m.pedir('POST', '/api/v1/pedidos', { json: {}, quem: 'luna' })).status, 400);
    assert.equal((await m.pedir('POST', '/api/v1/pedidos', { json: '{quebrado', quem: 'luna' })).status, 400);
    assert.equal((await m.pedir('POST', '/api/v1/pedidos', { json: { texto: 'a'.repeat(20 * 1024) }, quem: 'luna' })).status, 413);
  } finally { await m.fechar(); }
});

test('transições do agente: esperando_dono exige motivo; entregue; cancelar exige motivo', async () => {
  const m = await montar();
  try {
    await criarPedido(m);
    const sem = await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'esperando_dono' }, quem: 'luna' });
    assert.equal(sem.status, 400);
    assert.match(sem.json.erros.motivo, /obrigatório/);
    const ok = await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'esperando_dono', motivo: 'Gancho A ou B?' }, quem: 'luna' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.pedido.motivo, 'Gancho A ou B?');
    const volta = await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'fazendo' }, quem: 'luna' });
    assert.equal(volta.json.pedido.estado, 'fazendo');
    assert.equal(volta.json.pedido.motivo, null);
    const mesmo = await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'fazendo' }, quem: 'luna' });
    assert.equal(mesmo.json.ja_estava, true);
    assert.equal((await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'cancelado' }, quem: 'luna' })).status, 400);
    assert.equal((await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'abacaxi' }, quem: 'luna' })).status, 400);
    assert.equal((await m.pedir('PATCH', '/api/v1/pedidos/1', { json: {}, quem: 'luna' })).status, 400);
    const cancel = await m.pedir('DELETE', '/api/v1/pedidos/1', { json: { motivo: 'o dono desistiu' }, quem: 'luna' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.json.pedido.estado, 'cancelado');
    assert.equal(cancel.json.pedido.motivo, 'o dono desistiu');
    const fechado = await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'fazendo' }, quem: 'luna' });
    assert.equal(fechado.status, 409);
    assert.match(fechado.json.erro, /não muda mais/);
  } finally { await m.fechar(); }
});

test('o agente NÃO marca feito: 403 com motivo em português, e o pedido não muda', async () => {
  const m = await montar();
  try {
    await criarPedido(m);
    const r = await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'feito' }, quem: 'luna' });
    assert.equal(r.status, 403);
    assert.match(r.json.erro, /não marca/);
    assert.match(r.json.erro, /entregue/);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos/1')).json.pedido.estado, 'fazendo');
    const abrir = await m.pedir('POST', '/api/v1/pedidos/1/abrir', { quem: 'luna' });
    assert.equal(abrir.status, 403);
  } finally { await m.fechar(); }
});

test('agente só vê e mexe nos próprios pedidos', async () => {
  const m = await montar();
  try {
    await criarPedido(m, 'luna', 'da luna');
    await criarPedido(m, 'marina', 'da marina');
    const lista = await m.pedir('GET', '/api/v1/pedidos', { quem: 'luna' });
    assert.deepEqual(lista.json.pedidos.map((p) => p.texto), ['da luna']);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos?agente=marina', { quem: 'luna' })).status, 403);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos/2', { quem: 'luna' })).status, 404);
    assert.equal((await m.pedir('PATCH', '/api/v1/pedidos/2', { json: { estado: 'cancelado', motivo: 'x' }, quem: 'luna' })).status, 404);
    assert.equal((await m.pedir('DELETE', '/api/v1/pedidos/2', { json: { motivo: 'x' }, quem: 'luna' })).status, 404);
    // o dono vê os dois
    assert.equal((await m.pedir('GET', '/api/v1/pedidos')).json.pedidos.length, 2);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos?agente=marina')).json.pedidos.length, 1);
  } finally { await m.fechar(); }
});

test('entregue sem msg pega a última mensagem do agente; com msg confere a conversa', async () => {
  const m = await montar();
  try {
    await criarPedido(m);
    const primeira = m.msg('agente'); const dono = m.msg('dono'); const ultima = m.msg('agente'); const aviso = m.msg('agente', { sistema: 'compactacao' });
    m.conv.luna.push(primeira, dono, ultima, aviso);
    const r = await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'entregue' }, quem: 'luna' });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.pedido.msg_entrega.id, ultima.id);
    assert.equal(r.json.pedido.link_conversa, `/a/luna?msg=${ultima.id}`);

    await criarPedido(m, 'luna', 'outro');
    const certa = await m.pedir('PATCH', '/api/v1/pedidos/2', { json: { estado: 'entregue', msg: primeira.id }, quem: 'luna' });
    assert.equal(certa.json.pedido.msg_entrega.id, primeira.id);

    await criarPedido(m, 'luna', 'terceiro');
    const doDono = await m.pedir('PATCH', '/api/v1/pedidos/3', { json: { estado: 'entregue', msg: dono.id }, quem: 'luna' });
    assert.equal(doDono.status, 400);
    assert.match(doDono.json.erros.msg, /não é do agente/);
    const inexistente = await m.pedir('PATCH', '/api/v1/pedidos/3', { json: { estado: 'entregue', msg: 'f'.repeat(16) }, quem: 'luna' });
    assert.equal(inexistente.status, 400);
    const malformada = await m.pedir('PATCH', '/api/v1/pedidos/3', { json: { estado: 'entregue', msg: '../../x' }, quem: 'luna' });
    assert.equal(malformada.status, 400);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos/3')).json.pedido.estado, 'fazendo');
  } finally { await m.fechar(); }
});

test('entregue com a conversa ilegível: marca, avisa e não finge que apontou a mensagem', async () => {
  const m = await montar();
  try {
    await criarPedido(m);
    m.conv.quebrada = true;
    const r = await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'entregue' }, quem: 'luna' });
    assert.equal(r.status, 200);
    assert.equal(r.json.pedido.msg_entrega, null);
    assert.match(r.json.aviso, /sem apontar a mensagem/);
    assert.match(m.cap.texto(), /não consegui ler a conversa de luna/);
    await criarPedido(m, 'luna', 'com msg explícita');
    const c = await m.pedir('PATCH', '/api/v1/pedidos/2', { json: { estado: 'entregue', msg: 'a'.repeat(16) }, quem: 'luna' });
    assert.equal(c.status, 503);
  } finally { await m.fechar(); }
});

test('o dono abre o item entregue: vira feito; abrir item não entregue não muda nada', async () => {
  const m = await montar();
  try {
    await criarPedido(m);
    await criarPedido(m, 'luna', 'ainda fazendo');
    m.conv.luna.push(m.msg('agente'));
    await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'entregue' }, quem: 'luna' });
    const nao = await m.pedir('POST', '/api/v1/pedidos/2/abrir');
    assert.equal(nao.json.mudou, false);
    assert.equal(nao.json.pedido.estado, 'fazendo');
    const r = await m.pedir('POST', '/api/v1/pedidos/1/abrir');
    assert.equal(r.status, 200);
    assert.equal(r.json.mudou, true);
    assert.equal(r.json.pedido.estado, 'feito');
    assert.match(r.json.pedido.link_conversa, /^\/a\/luna\?msg=/);
    const h = r.json.pedido.historico;
    assert.equal(h[h.length - 1].para, 'feito');
    assert.match(h[h.length - 1].por, /dono/);
  } finally { await m.fechar(); }
});

test('o dono responde na conversa depois da entrega: vira feito na próxima consulta; antes da entrega não conta', async () => {
  const m = await montar();
  try {
    await criarPedido(m);
    m.conv.luna.push(m.msg('dono'));                       // antes da entrega: não conta
    m.conv.luna.push(m.msg('agente'));
    await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'entregue' }, quem: 'luna' });
    assert.equal((await m.pedir('GET', '/api/v1/pedidos/1')).json.pedido.estado, 'entregue');
    m.conv.luna.push(m.msg('dono', { quem: 'colaborador: Ana (ana)' }));   // colaborador não conta
    m.conv.luna.push(m.msg('comando'));
    assert.equal((await m.pedir('GET', '/api/v1/pedidos')).json.pedidos[0].estado, 'entregue');
    m.conv.luna.push(m.msg('dono'));
    const l = await m.pedir('GET', '/api/v1/pedidos');
    assert.equal(l.json.pedidos[0].estado, 'feito');
    const h = (await m.pedir('GET', '/api/v1/pedidos/1')).json.pedido.historico;
    assert.match(h[h.length - 1].por, /respondeu na conversa/);
  } finally { await m.fechar(); }
});

test('conversa ilegível na consulta: o item continua entregue e o motivo vai para o log', async () => {
  const m = await montar();
  try {
    await criarPedido(m);
    m.conv.luna.push(m.msg('agente'));
    await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'entregue' }, quem: 'luna' });
    m.conv.quebrada = true;
    const r = await m.pedir('GET', '/api/v1/pedidos');
    assert.equal(r.status, 200);
    assert.equal(r.json.pedidos[0].estado, 'entregue');
    assert.match(m.cap.texto(), /transcript ilegível/);
  } finally { await m.fechar(); }
});

test('dono marca feito de qualquer estado aberto ou cancela (motivo opcional); não mexe nos estados do agente', async () => {
  const m = await montar();
  try {
    await criarPedido(m); await criarPedido(m, 'luna', 'b');
    const f = await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'feito' } });
    assert.equal(f.status, 200);
    assert.equal(f.json.pedido.estado, 'feito');
    const c = await m.pedir('DELETE', '/api/v1/pedidos/2');
    assert.equal(c.status, 200);
    assert.equal(c.json.pedido.estado, 'cancelado');
    await criarPedido(m, 'luna', 'c');
    const r = await m.pedir('PATCH', '/api/v1/pedidos/3', { json: { estado: 'entregue' } });
    assert.equal(r.status, 403);
  } finally { await m.fechar(); }
});

test('lista padrão: abertos e fechados de hoje e ontem; o resto fica arquivado e sai por dia=todos', async () => {
  const m = await montar();
  try {
    await criarPedido(m, 'luna', 'velho'); await criarPedido(m, 'luna', 'de ontem'); await criarPedido(m, 'luna', 'aberto');
    await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'feito' } });
    m.avanca(24 * 60 * 2);                                  // 2 dias depois
    await m.pedir('PATCH', '/api/v1/pedidos/2', { json: { estado: 'feito' } });
    m.avanca(24 * 60);                                      // 1 dia depois do fechamento do 2
    const padrao = await m.pedir('GET', '/api/v1/pedidos');
    assert.deepEqual(padrao.json.pedidos.map((p) => p.texto).sort(), ['aberto', 'de ontem']);
    const todos = await m.pedir('GET', '/api/v1/pedidos?dia=todos');
    assert.equal(todos.json.pedidos.length, 3);
    const dia = await m.pedir('GET', '/api/v1/pedidos?dia=2026-11-12');
    assert.deepEqual(dia.json.pedidos.map((p) => p.texto).sort(), ['aberto', 'velho']);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos?dia=2026-13-45')).status, 400);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos?dia=amanha')).status, 400);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos?estado=abacaxi')).status, 400);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos?agente=ninguem')).status, 400);
    const so = await m.pedir('GET', '/api/v1/pedidos?estado=feito&dia=todos');
    assert.equal(so.json.pedidos.length, 2);
  } finally { await m.fechar(); }
});

test('ordem: esperando o dono, entregue, fazendo; ETag muda com a gravação', async () => {
  const m = await montar();
  try {
    await criarPedido(m, 'luna', 'a'); await criarPedido(m, 'luna', 'b'); await criarPedido(m, 'luna', 'c');
    m.conv.luna.push(m.msg('agente'));
    await m.pedir('PATCH', '/api/v1/pedidos/2', { json: { estado: 'entregue' }, quem: 'luna' });
    await m.pedir('PATCH', '/api/v1/pedidos/3', { json: { estado: 'esperando_dono', motivo: 'm' }, quem: 'luna' });
    const l = await m.pedir('GET', '/api/v1/pedidos');
    assert.deepEqual(l.json.pedidos.map((p) => p.texto), ['c', 'b', 'a']);
    const etag = l.headers.get('etag');
    assert.equal((await m.pedir('GET', '/api/v1/pedidos', { headers: { 'if-none-match': etag } })).status, 304);
    await m.pedir('PATCH', '/api/v1/pedidos/1', { json: { estado: 'feito' } });
    assert.equal((await m.pedir('GET', '/api/v1/pedidos', { headers: { 'if-none-match': etag } })).status, 200);
  } finally { await m.fechar(); }
});

test('id inválido 400, inexistente 404, método errado 405, rota desconhecida 404', async () => {
  const m = await montar();
  try {
    assert.equal((await m.pedir('GET', '/api/v1/pedidos/abc')).status, 400);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos/99')).status, 404);
    assert.equal((await m.pedir('PUT', '/api/v1/pedidos')).status, 405);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos/1/abrir')).status, 405);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos/1/outra')).status, 404);
    assert.equal((await m.pedir('GET', '/api/v1/pedidos/1/abrir/x')).status, 404);
  } finally { await m.fechar(); }
});

test('arquivo corrompido: 503 com o motivo e o arquivo fica como está', async () => {
  const m = await montar();
  try {
    await criarPedido(m);
    fs.writeFileSync(m.arquivo, '{lixo');
    const r = await m.pedir('GET', '/api/v1/pedidos');
    assert.equal(r.status, 503);
    assert.match(r.json.erro, /está inválido/);
    assert.equal((await m.pedir('POST', '/api/v1/pedidos', { json: { texto: 'x' }, quem: 'luna' })).status, 503);
    assert.equal(fs.readFileSync(m.arquivo, 'utf8'), '{lixo');
  } finally { await m.fechar(); }
});

test('o arquivo é gravado com modo 600 e sobrevive a uma fila nova lendo o mesmo arquivo', async () => {
  const m = await montar();
  try {
    await criarPedido(m);
    assert.equal(fs.statSync(m.arquivo).mode & 0o777, 0o600);
    const j = JSON.parse(fs.readFileSync(m.arquivo, 'utf8'));
    assert.equal(j.pedidos.length, 1);
    assert.equal(j.proximo_id, 2);
  } finally { await m.fechar(); }
});

test('texto com HTML é guardado como texto puro (quem desenha é a tela, com textContent)', async () => {
  const m = await montar();
  try {
    const p = await criarPedido(m, 'luna', '<script>alert(1)</script> & "aspas"');
    assert.equal(p.texto, '<script>alert(1)</script> & "aspas"');
    assert.match((await m.pedir('GET', '/api/v1/pedidos/1')).headers.get('content-type'), /application\/json/);
  } finally { await m.fechar(); }
});

test('documentação em /api/v1/pedidos/docs.md', async () => {
  const m = await montar();
  try {
    const r = await m.pedir('GET', '/api/v1/pedidos/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /markdown/);
    assert.match(r.texto, /Fila de pedidos/);
  } finally { await m.fechar(); }
});

test('Web inteiro: sem sessão 401; escrita com Origin errada 403; pela caixa só passa a rota liberada', async () => {
  const s = await subirWeb({ agentes: [{ slug: 'luna', nome: 'Luna', runner: 'http://127.0.0.1:1', agente_id: 'l1' }] });
  try {
    assert.equal((await s.c.get('/api/v1/pedidos')).status, 401);
    await s.login();
    const ruim = await s.c.post('/api/v1/pedidos/1/abrir', { origin: 'http://evil.example' });
    assert.equal(ruim.status, 403);
    assert.match(ruim.json.erro, /origem/);
    const semOrigem = await s.c.post('/api/v1/pedidos/1/abrir', { origin: false });
    assert.equal(semOrigem.status, 403);
    const lista = await s.c.get('/api/v1/pedidos');
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.json.pedidos, []);
    assert.equal((await s.c.get('/api/v1/pedidos/docs.md')).status, 200);
  } finally { await s.fechar(); }
});
