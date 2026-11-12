'use strict';
// Estado de atenção por agente (GET /api/v1/estados), marca "não lida" e preferências de aviso.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { criarNaoLidas } = require('../lib/nao-lidas');
const { estadoBase, resumoSeguro } = require('../lib/estados');

const FIXTURE = path.join(__dirname, 'fixtures', 'sessao-ana.jsonl');
// Prefixo montado por partes: o arquivo não carrega nada que pareça chave de verdade.
const CHAVE_FALSA = ['sk', 'ant', 'api03'].join('-') + '-' + 'Z'.repeat(95);

async function cenario(opcoesRunner) {
  const rAna = criarRunnerFalso(Object.assign({ agenteId: 'ana1', sessionId: 'sess-ana-00001' }, opcoesRunner || {}));
  const pAna = await rAna.ouvir();
  const transcripts = path.join(pastaTemp('tr'), 'projects');
  fs.mkdirSync(path.join(transcripts, '-home-agente'), { recursive: true });
  const arq = path.join(transcripts, '-home-agente', 'sess-ana-00001.jsonl');
  fs.copyFileSync(FIXTURE, arq);
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: transcripts, home_host: pastaTemp('home') }];
  // Relógio controlável: o estado do runner tem cache de 2 s e o teste precisa passar por cima dele.
  let agora = Date.now();
  const t = await subirWeb({ agentes, opcoesServidor: { tickSseMs: 60, agora: () => agora } });
  await t.login();
  let seq = 0;
  const hora = () => new Date(Date.now() + 1000 * (++seq)).toISOString();
  const fala = (texto) => fs.appendFileSync(arq, JSON.stringify({ type: 'assistant', timestamp: hora(), message: { content: [{ type: 'tool_use', id: `x${seq}`, name: 'mcp__dgchat__reply', input: { chat: 'c_ana', text: texto } }] } }) + '\n');
  const muda = (campos) => { Object.assign(rAna.opcoes, campos); agora += 3000; };
  const ana = async () => (await t.c.get('/api/v1/estados')).json.agentes.ana;
  return { t, rAna, fala, muda, ana, fechar: async () => { await t.fechar(); await rAna.fechar(); } };
}

test('estados: ocioso, trabalhando, precisa de você (permissão, pergunta, login) e runner fora = sem_sinal', async () => {
  const s = await cenario();
  try {
    let a = await s.ana();
    assert.equal(a.estado, 'ocioso');
    assert.equal(a.nao_lidas, 0);
    assert.equal(a.marcada_nao_lida, false);

    s.muda({ status: 'working', currentTool: 'Bash' });
    assert.equal((await s.ana()).estado, 'trabalhando');

    s.muda({ status: 'waiting_input', currentTool: 'Bash', motivo: 'permissao' });
    a = await s.ana();
    assert.equal(a.estado, 'precisa_de_voce');
    assert.equal(a.motivo, 'permissao');
    assert.equal(a.resumo, 'pede permissão para rodar Bash');

    s.muda({ status: 'waiting_input', currentTool: 'AskUserQuestion', motivo: 'pergunta' });
    a = await s.ana();
    assert.equal(a.motivo, 'pergunta');
    assert.equal(a.resumo, 'fez uma pergunta');

    s.muda({ status: 'waiting_input', currentTool: 'Write', motivo: undefined });
    a = await s.ana();
    assert.equal(a.motivo, 'permissao', 'runner antigo, sem motivo, só conhecia a permissão');
    assert.equal(a.resumo, 'pede permissão para usar Write');

    s.muda({ status: 'errored', statusReason: 'runner:login-expirado', motivo: 'login', currentTool: null });
    a = await s.ana();
    assert.equal(a.estado, 'precisa_de_voce');
    assert.equal(a.motivo, 'login');

    s.muda({ status: 'errored', statusReason: 'runner:sem-login', motivo: undefined });
    assert.equal((await s.ana()).motivo, 'login');

    s.muda({ status: 'idle', statusReason: null, falhaEstado: true });
    a = await s.ana();
    assert.equal(a.estado, 'sem_sinal');
    assert.match(a.erro, /runner/i);
    assert.notEqual(a.estado, 'ocioso', 'falha do runner nunca vira ocioso');
  } finally { await s.fechar(); }
});

test('estados: terminou = ocioso com resposta não lida, ou marcada; resumo não carrega comando nem segredo', async () => {
  const s = await cenario();
  try {
    await s.ana(); // cria o marco
    s.fala('resposta nova');
    s.muda({});
    let a = await s.ana();
    assert.equal(a.estado, 'terminou');
    assert.equal(a.nao_lidas, 1);
    await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: a.ultima_ep } });
    s.muda({});
    assert.equal((await s.ana()).estado, 'ocioso');

    const m = await s.t.c.post('/api/v1/agents/ana/nao-lido');
    assert.equal(m.status, 200, m.texto);
    s.muda({});
    a = await s.ana();
    assert.equal(a.estado, 'terminou');
    assert.equal(a.marcada_nao_lida, true);
    assert.equal(a.nao_lidas, 0);

    s.muda({ status: 'waiting_input', motivo: 'permissao', currentTool: `Bash -c "curl -H Authorization: Bearer ${CHAVE_FALSA}"` });
    a = await s.ana();
    assert.equal(a.resumo, 'pede a sua permissão', 'nome de ferramenta fora do padrão não entra no resumo');
    assert.ok(!JSON.stringify(a).includes('ZZZZZ'));
  } finally { await s.fechar(); }
});

test('resumoSeguro: corta em 80 caracteres e mascara segredo; estadoBase de Codex sem motivo', () => {
  const longo = resumoSeguro('x'.repeat(200));
  assert.equal(longo.length, 80);
  assert.ok(longo.endsWith('…'));
  assert.ok(!resumoSeguro(`veja ${CHAVE_FALSA}`).includes('ZZZZZ'));
  const b = estadoBase({ nome: 'Cod', provedor: 'codex' }, { ok: true, estado: { status: 'waiting_input' } });
  assert.equal(b.estado, 'precisa_de_voce');
  assert.equal(b.motivo, null);
  assert.equal(b.resumo, 'está esperando você');
});

test('marcar como não lida: POST/DELETE; o lido automático não limpa; abrir a conversa limpa', async () => {
  const s = await cenario();
  try {
    await s.ana();
    s.fala('oi');
    s.muda({});
    const a0 = await s.ana();
    assert.equal((await s.t.c.post('/api/v1/agents/ana/nao-lido')).json.marcada_nao_lida, true);
    // lido automático (rolagem): avança o marco, mantém a marca
    await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: a0.ultima_ep } });
    s.muda({});
    const a = await s.ana();
    assert.equal(a.nao_lidas, 0);
    assert.equal(a.marcada_nao_lida, true);
    // abrir a conversa limpa a marca
    const ab = await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: a0.ultima_ep, abriu: true } });
    assert.equal(ab.status, 200, ab.texto);
    s.muda({});
    assert.equal((await s.ana()).marcada_nao_lida, false);
    // DELETE desmarca; abriu sem ep também funciona
    await s.t.c.post('/api/v1/agents/ana/nao-lido');
    s.muda({});
    assert.equal((await s.ana()).marcada_nao_lida, true);
    const del = await s.t.c.pedir('DELETE', '/api/v1/agents/ana/nao-lido');
    assert.equal(del.json.marcada_nao_lida, false);
    await s.t.c.post('/api/v1/agents/ana/nao-lido');
    await s.t.c.post('/api/v1/agents/ana/lido', { json: { abriu: true } });
    s.muda({});
    assert.equal((await s.ana()).marcada_nao_lida, false);
    // abriu: ep inválido continua 400
    assert.equal((await s.t.c.post('/api/v1/agents/ana/lido', { json: { ep: 'x', abriu: true } })).status, 400);
    const arq = path.join(s.t.dados, 'nao-lidas.json');
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  } finally { await s.fechar(); }
});

test('nao-lidas.json antigo (só "usuarios") carrega, preserva os marcos e ganha "marcadas" ao marcar', () => {
  const pasta = pastaTemp('mig');
  const arquivo = path.join(pasta, 'nao-lidas.json');
  fs.writeFileSync(arquivo, JSON.stringify({ versao: 1, usuarios: { dono: { ana: 1700000000, bia: 5 } } }), { mode: 0o600 });
  const logs = [];
  const monta = () => criarNaoLidas({ arquivo, conversa: {}, registro: { estado: () => ({ ok: true, agentes: [] }) }, log: (n, m) => logs.push(`${n} ${m}`), relogio: () => 1700000100000, lerThread: async () => ({ msgs: [] }) });
  const nl = monta();
  assert.equal(nl.temMarca('dono', 'ana'), false);
  assert.equal(nl.marcar('dono', 'ana', 1700000050), 1700000050);
  assert.equal(nl.marcarNaoLida('dono', 'bia', true), true);
  assert.equal(nl.marcarNaoLida('dono', 'bia', true), false, 'marcar de novo não regrava');
  const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(j.usuarios.dono)), { ana: 1700000050, bia: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(j.marcadas)), { dono: { bia: true } });
  const de_novo = monta();
  assert.equal(de_novo.temMarca('dono', 'bia'), true);
  assert.equal(de_novo.marcarNaoLida('dono', 'bia', false), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, 'utf8')).marcadas, {});
  assert.deepEqual(logs.filter((l) => l.startsWith('erro')), []);
});

test('rotas novas: sem sessão = 401, sem Origin = 403, método errado = 405', async () => {
  const s = await cenario();
  try {
    const anon = cliente(s.t.porta);
    assert.equal((await anon.get('/api/v1/estados')).status, 401);
    assert.equal((await anon.post('/api/v1/agents/ana/nao-lido')).status, 401);
    assert.equal((await anon.post('/api/v1/agents/ana/vendo')).status, 401);
    assert.equal((await anon.get('/api/v1/push/preferencias')).status, 401);
    for (const [metodo, rota] of [['POST', '/api/v1/agents/ana/nao-lido'], ['DELETE', '/api/v1/agents/ana/nao-lido'], ['POST', '/api/v1/agents/ana/vendo'], ['POST', '/api/v1/push/preferencias']]) {
      const sem = await s.t.c.pedir(metodo, rota, { origin: false, json: metodo === 'DELETE' ? undefined : {} });
      assert.equal(sem.status, 403, `${metodo} ${rota} sem Origin`);
      const fora = await s.t.c.pedir(metodo, rota, { origin: 'https://outro.exemplo', json: metodo === 'DELETE' ? undefined : {} });
      assert.equal(fora.status, 403, `${metodo} ${rota} de outra origem`);
    }
    assert.equal((await s.t.c.post('/api/v1/estados', { json: {} })).status, 405);
    assert.equal((await s.t.c.get('/api/v1/agents/ana/nao-lido')).status, 405);
    assert.equal((await s.t.c.post('/api/v1/agents/fantasma/nao-lido')).status, 404);
    const docs = await s.t.c.get('/api/v1/estados/docs.md');
    assert.equal(docs.status, 200);
    assert.match(docs.texto, /precisa_de_voce/);
  } finally { await s.fechar(); }
});

test('preferências de aviso: padrão ligado, POST parcial grava com modo 600 e valida', async () => {
  const s = await cenario();
  try {
    let r = await s.t.c.get('/api/v1/push/preferencias');
    assert.deepEqual(r.json.preferencias, { precisa_de_voce: true, terminou: true });
    r = await s.t.c.post('/api/v1/push/preferencias', { json: { terminou: false } });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json.preferencias, { precisa_de_voce: true, terminou: false });
    assert.deepEqual((await s.t.c.get('/api/v1/push/preferencias')).json.preferencias, { precisa_de_voce: true, terminou: false });
    assert.equal(fs.statSync(path.join(s.t.dados, 'push', 'preferencias.json')).mode & 0o777, 0o600);
    const ruim = await s.t.c.post('/api/v1/push/preferencias', { json: { terminou: 'sim' } });
    assert.equal(ruim.status, 400);
    assert.match(ruim.json.erro, /true ou false/);
    assert.equal((await s.t.c.post('/api/v1/push/preferencias', { json: { barulho: true } })).status, 400);
  } finally { await s.fechar(); }
});
