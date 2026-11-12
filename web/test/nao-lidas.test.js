'use strict';
// Bolinha de não lidas: GET /api/v1/nao-lidas, POST /api/v1/agents/<slug>/lido e o módulo por baixo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, pastaTemp, cliente, capturaLog } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { criarNaoLidas } = require('../lib/nao-lidas');

const FIXTURE = path.join(__dirname, 'fixtures', 'sessao-ana.jsonl');

async function cenario() {
  const rAna = criarRunnerFalso({ agenteId: 'ana1', sessionId: 'sess-ana-00001' });
  const pAna = await rAna.ouvir();
  const transcripts = path.join(pastaTemp('tr'), 'projects');
  fs.mkdirSync(path.join(transcripts, '-home-agente'), { recursive: true });
  const arq = path.join(transcripts, '-home-agente', 'sess-ana-00001.jsonl');
  fs.copyFileSync(FIXTURE, arq);
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: transcripts, home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes, opcoesServidor: { tickSseMs: 60 } });
  await t.login();
  let seq = 0;
  const hora = () => new Date(Date.now() + 1000 * (++seq)).toISOString();
  const fala = (texto) => fs.appendFileSync(arq, JSON.stringify({ type: 'assistant', timestamp: hora(), message: { content: [{ type: 'tool_use', id: `x${seq}`, name: 'mcp__dgchat__reply', input: { chat: 'c_ana', text: texto } }] } }) + '\n');
  const dono = (texto) => fs.appendFileSync(arq, JSON.stringify({ type: 'user', timestamp: hora(), message: { role: 'user', content: `<dgchat from="pessoa" chat="c_ana" msg="m${seq}" ts="${hora()}">${texto}</dgchat>` } }) + '\n');
  return { t, arq, fala, dono, fechar: async () => { await t.fechar(); await rAna.fechar(); } };
}
const conta = async (s) => (await s.t.c.get('/api/v1/nao-lidas')).json.agentes.ana;

test('marco novo: primeira contagem cria o marco na hora e conta 0 com marco_novo', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.get('/api/v1/nao-lidas');
    assert.equal(r.status, 200, r.texto);
    const ana = r.json.agentes.ana;
    assert.equal(ana.nao_lidas, 0);
    assert.equal(ana.marco_novo, true);
    assert.ok(ana.visto_ep > 1.7e9 && ana.visto_ep === ana.ultima_ep);
    const de_novo = await conta(s);
    assert.equal(de_novo.marco_novo, undefined);
    assert.equal(de_novo.nao_lidas, 0);
    const arquivo = path.join(s.t.dados, 'nao-lidas.json');
    assert.equal(fs.statSync(arquivo).mode & 0o777, 0o600);
  } finally { await s.fechar(); }
});

test('mensagem do agente depois do marco conta; a do dono não conta; /lido zera e não recua', async () => {
  const s = await cenario();
  try {
    await conta(s);
    s.dono('oi de novo');
    assert.equal((await conta(s)).nao_lidas, 0, 'mensagem do dono não é não lida');
    s.fala('resposta 1');
    const um = await conta(s);
    assert.equal(um.nao_lidas, 1);
    const antes = um.visto_ep;
    const r = await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: um.ultima_ep } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.visto_ep, um.ultima_ep);
    assert.ok(r.json.visto_ep > antes);
    assert.equal((await conta(s)).nao_lidas, 0);
    const recuo = await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: antes } });
    assert.equal(recuo.json.visto_ep, um.ultima_ep, 'marco só avança');
  } finally { await s.fechar(); }
});

test('/lido: ep inválido => 400 em português; slug inexistente => 404; GET => 405', async () => {
  const s = await cenario();
  try {
    for (const corpo of [{}, { ep: 'abc' }, { ep: -1 }, { ep: null }, { ep: 1e999 }]) {
      const r = await s.t.c.post('/api/v1/agents/ana/lido', { json: corpo });
      assert.equal(r.status, 400, JSON.stringify(corpo));
      assert.match(r.json.erro, /"ep" precisa ser um número/);
    }
    const nada = await s.t.c.post('/api/v1/agents/fantasma/lido', { json: { ep: 1 } });
    assert.equal(nada.status, 404);
    assert.match(nada.json.erro, /Não existe agente/);
    const get = await s.t.c.get('/api/v1/agents/ana/lido');
    assert.equal(get.status, 405);
  } finally { await s.fechar(); }
});

test('sem sessão => 401; POST sem Origin válido => 403 e nada é gravado', async () => {
  const s = await cenario();
  try {
    assert.equal((await cliente(s.t.porta).get('/api/v1/nao-lidas')).status, 401);
    assert.equal((await cliente(s.t.porta).post('/api/v1/agents/ana/lido', { json: { ep: 1 } })).status, 401);
    const sem = await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: 5 }, origin: false });
    assert.equal(sem.status, 403);
    const fora = await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: 5 }, origin: 'http://evil.example' });
    assert.equal(fora.status, 403);
    assert.ok(!fs.existsSync(path.join(s.t.dados, 'nao-lidas.json')));
  } finally { await s.fechar(); }
});

// ── módulo, com thread falsa ─────────────────────────────────────────────
function modulo(threads, extra) {
  const dir = pastaTemp('nl');
  const arquivo = path.join(dir, 'nao-lidas.json');
  const cap = capturaLog();
  const agentes = Object.keys(threads).map((slug) => ({ slug, nome: slug.toUpperCase() }));
  const conversa = { thread: async (a) => { const t = threads[a.slug]; if (typeof t === 'function') return t(); return { msgs: t }; } };
  const registro = { estado: () => ({ ok: true, agentes }) };
  const nl = criarNaoLidas(Object.assign({ arquivo, conversa, registro, log: cap.log, relogio: () => 123 }, extra));
  return { nl, arquivo, cap, dir };
}
const ag = (ep, extra) => Object.assign({ ep, origin: 'agente', text: 'x' }, extra);

test('módulo: aviso de sistema e mensagem do dono não contam', async () => {
  const msgs = [ag(10)];
  const m = modulo({ ana: msgs });
  await m.nl.contar('dono');
  msgs.push(ag(11, { sistema: 'compactacao' }), { ep: 12, origin: 'dono', text: 'oi' }, ag(13));
  const r = (await m.nl.contar('dono')).ana;
  assert.equal(r.nao_lidas, 1);
  assert.equal(r.ultima_ep, 13);
});

test('módulo: thread que falha ou estoura o tempo => null com erro, e não cria marco', async () => {
  const m = modulo({ ana: () => { throw new Error('disco sumiu'); }, bia: () => new Promise(() => {}), cai: [ag(5)] });
  const r = await m.nl.contar('dono');
  assert.equal(r.ana.nao_lidas, null);
  assert.match(r.ana.erro, /disco sumiu/);
  assert.equal(r.bia.nao_lidas, null);
  assert.match(r.bia.erro, /não respondeu em 1,5 s/);
  assert.equal(r.cai.nao_lidas, 0);
  const guardado = JSON.parse(fs.readFileSync(m.arquivo, 'utf8'));
  assert.deepEqual(Object.keys(guardado.usuarios.dono), ['cai'], 'só o agente medido ganhou marco');
  assert.match(m.cap.texto(), /disco sumiu/);
});

test('módulo: arquivo corrompido não derruba, é preservado e as bolinhas recomeçam', async () => {
  const m = modulo({ ana: [ag(10)] });
  fs.writeFileSync(m.arquivo, '{isto não é json');
  const r = (await m.nl.contar('dono')).ana;
  assert.equal(r.nao_lidas, 0);
  assert.equal(r.marco_novo, true);
  assert.match(m.cap.texto(), /corrompido/);
  const sobras = fs.readdirSync(m.dir).filter((n) => n.startsWith('nao-lidas.json.corrompido-'));
  assert.equal(sobras.length, 1);
  assert.equal(fs.readFileSync(path.join(m.dir, sobras[0]), 'utf8'), '{isto não é json');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(m.arquivo, 'utf8')));
});

test('módulo: teto de 99 devolve 99 e mais:true', async () => {
  const msgs = [ag(1)];
  const m = modulo({ ana: msgs });
  await m.nl.contar('dono');
  for (let i = 0; i < 150; i += 1) msgs.push(ag(2 + i));
  const r = (await m.nl.contar('dono')).ana;
  assert.equal(r.nao_lidas, 99);
  assert.equal(r.mais, true);
  const exato = modulo({ ana: [ag(1)] });
  await exato.nl.contar('dono');
  assert.equal(exato.nl.marcar('dono', 'ana', 1), 1);
});

test('módulo: cada usuário tem o seu marco', async () => {
  const msgs = [ag(1)];
  const m = modulo({ ana: msgs });
  await m.nl.contar('a'); await m.nl.contar('b');
  msgs.push(ag(2));
  m.nl.marcar('a', 'ana', 2);
  assert.equal((await m.nl.contar('a')).ana.nao_lidas, 0);
  assert.equal((await m.nl.contar('b')).ana.nao_lidas, 1);
});

test('módulo: GETs simultâneos dividem uma leitura por agente e lerThread é injetável', async () => {
  let leituras = 0;
  const dir = pastaTemp('nl');
  const nl = criarNaoLidas({
    arquivo: path.join(dir, 'nao-lidas.json'), registro: { estado: () => ({ ok: true, agentes: [{ slug: 'ana', nome: 'Ana' }] }) },
    log: capturaLog().log, conversa: null,
    lerThread: async () => { leituras += 1; await new Promise((r) => setTimeout(r, 50)); return { msgs: [{ ep: 1, origin: 'agente' }] }; },
  });
  const rs = await Promise.all([nl.contar('dono'), nl.contar('dono'), nl.contar('outro')]);
  assert.equal(leituras, 1);
  assert.ok(rs.every((r) => r.ana.nao_lidas === 0));
});

// ── revisão do Codex ─────────────────────────────────────────────────────
test('módulo: thread vazia COM aviso é falha (null, sem marco); vazia SEM aviso é agente novo (marco 0)', async () => {
  const m = modulo({
    quebrado: async () => ({ msgs: [], avisos: ['O runner não respondeu (recusou).'], arquivo: null }),
    marcado: async () => ({ msgs: [], avisos: [], incompleta: true }),
    novo: async () => ({ msgs: [], avisos: [], arquivo: null }),
  });
  const r = await m.nl.contar('dono');
  assert.equal(r.quebrado.nao_lidas, null);
  assert.match(r.quebrado.erro, /runner não respondeu/);
  assert.equal(r.marcado.nao_lidas, null);
  assert.equal(r.novo.nao_lidas, 0);
  assert.equal(r.novo.marco_novo, true);
  const guardado = JSON.parse(fs.readFileSync(m.arquivo, 'utf8'));
  assert.deepEqual(Object.keys(guardado.usuarios.dono), ['novo']);
});

test('thread(): sem registro e com runner fora do ar volta incompleta; agente que nunca conversou não', async () => {
  const rAna = criarRunnerFalso({ agenteId: 'ana1', falhaEstado: true });
  const pAna = await rAna.ouvir();
  const vazia = path.join(pastaTemp('tr'), 'projects');
  fs.mkdirSync(vazia, { recursive: true });
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', chat_id: 'c', provedor: 'claude', modelo: 'sonnet', transcripts_dir: vazia, home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes });
  try {
    await t.login();
    const r = (await t.c.get('/api/v1/nao-lidas')).json.agentes.ana;
    assert.equal(r.nao_lidas, null);
    assert.match(r.erro, /runner não respondeu/);
  } finally { await t.fechar(); await rAna.fechar(); }
});

test('módulo: falha ao gravar não adianta a memória; a repetição regrava', async () => {
  const msgs = [ag(10)];
  const m = modulo({ ana: msgs });
  fs.mkdirSync(m.arquivo); // um diretório no lugar do arquivo: ler dá EISDIR
  await assert.rejects(m.nl.contar('dono'), (e) => e.status === 503 && /EISDIR/.test(e.message));
  fs.rmdirSync(m.arquivo);
  const r = (await m.nl.contar('dono')).ana;
  assert.equal(r.marco_novo, true);
  fs.rmSync(m.arquivo);
  fs.mkdirSync(m.arquivo); // agora a leitura já passou; quem falha é a gravação
  assert.throws(() => m.nl.marcar('dono', 'ana', 20), (e) => e.status === 503);
  fs.rmdirSync(m.arquivo);
  assert.equal((await m.nl.contar('dono')).ana.visto_ep, 10, 'a memória não ficou adiantada');
  assert.equal(m.nl.marcar('dono', 'ana', 20), 20);
  assert.equal(JSON.parse(fs.readFileSync(m.arquivo, 'utf8')).usuarios.dono.ana, 20, 'regravou');
});

test('módulo: usuário e slug "__proto__" são dados comuns, sem poluir Object.prototype', async () => {
  const m = modulo({ ana: [ag(10)], __proto__x: [ag(1)] });
  await m.nl.contar('__proto__');
  m.nl.marcar('__proto__', '__proto__', 5);
  m.nl.marcar('dono', '__proto__', 6);
  assert.equal({}.ana, undefined);
  assert.equal({}.visto_ep, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const guardado = JSON.parse(fs.readFileSync(m.arquivo, 'utf8'));
  assert.equal(Object.hasOwn(guardado.usuarios, '__proto__'), true);
  // recarregar do disco também é seguro
  const m2 = criarNaoLidas({ arquivo: m.arquivo, conversa: { thread: async () => ({ msgs: [] }) }, registro: { estado: () => ({ ok: true, agentes: [] }) }, log: m.cap.log });
  assert.equal(m2.marcar('__proto__', '__proto__', 4), 5);
});

test('módulo: arquivo com formato errado em qualquer nível é tratado como corrompido', async () => {
  for (const conteudo of ['{"usuarios":{"dono":7}}', '{"usuarios":[]}', '{"usuarios":{"dono":[1]}}', '{"usuarios":{"dono":{"ana":-1}}}', '{"usuarios":{"dono":{"ana":"3"}}}', '[]', 'null']) {
    const m = modulo({ ana: [ag(10)] });
    fs.writeFileSync(m.arquivo, conteudo);
    const r = (await m.nl.contar('dono')).ana;
    assert.equal(r.marco_novo, true, conteudo);
    assert.ok(fs.readdirSync(m.dir).some((n) => n.startsWith('nao-lidas.json.corrompido-')), conteudo);
    assert.match(m.cap.texto(), /corrompido/);
  }
});

test('módulo: erro de leitura que não é "não existe" não vira estado vazio nem sobrescreve', async () => {
  const m = modulo({ ana: [ag(10)] });
  fs.mkdirSync(m.arquivo);
  await assert.rejects(m.nl.contar('dono'), (e) => e.status === 503 && /Não consegui ler/.test(e.message));
  assert.throws(() => m.nl.marcar('dono', 'ana', 1), (e) => e.status === 503);
  assert.ok(fs.statSync(m.arquivo).isDirectory(), 'nada foi gravado por cima');
});

test('módulo: ~200 mil mensagens não estouram a pilha', async () => {
  const msgs = [];
  for (let i = 0; i < 200000; i += 1) msgs.push(ag(i + 1));
  const m = modulo({ ana: msgs });
  const r = (await m.nl.contar('dono')).ana;
  assert.equal(r.ultima_ep, 200000);
});

test('/lido: ep no futuro (milissegundos em vez de segundos) => 400 explicando, e o marco não trava', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: Date.now() } });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /SEGUNDOS/);
    const ok = await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: Date.now() / 1000 + 100 } });
    assert.equal(ok.status, 200);
  } finally { await s.fechar(); }
});

test('tela: só marca como lido perto do fim e reavalia ao rolar; o poll só roda com a aba visível', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.js'), 'utf8');
  assert.match(js, /const pertoDoFim = \(\) => distanciaDoFim\(\) < 160;/);
  assert.match(js, /!msgs\.length \|\| !pertoDoFim\(\)\) return;/);
  assert.match(js, /document\.visibilityState !== 'visible' \|\| !pertoDoFim\(\)\) return;/);
  assert.match(js, /chat\.addEventListener\('scroll', agendaLido/);
  // o poll agora traz também o estado dos agentes: 10 s com a aba visível, 60 s escondida
  assert.match(js, /if \(document\.visibilityState !== 'visible' && agora - ultimoEstados < 60000\) return;/);
  assert.match(js, /atualizaNaoLidas\(\);\n\}, 10000\);/);
  assert.match(js, /api\('\/api\/v1\/estados'/);
});
