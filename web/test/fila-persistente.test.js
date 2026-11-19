'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirWeb, pastaTemp } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

async function cenario(opRunner) {
  const runner = criarRunnerFalso(Object.assign({ agenteId: 'ana1' }, opRunner));
  const porta = await runner.ouvir();
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: pastaTemp('tr'), home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes });
  await t.login();
  return { t, runner, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}

test('fila: a mensagem entregue enquanto o agente trabalha volta na atividade, com texto, até sair da fila do runner', async () => {
  const s = await cenario({ status: 'working' });
  try {
    const agente = s.t.web.registro.obter('ana');
    const r = await s.t.web.conversa.entregar(agente, 'ok', { cru: false, from: 'pessoa' });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.fila.motivo, 'resposta');
    assert.match(r.corpo.fila.msg, /^w/);
    // o runner informa o que ainda espera (só id e hora): o texto vem da memória do Web
    s.runner.opcoes.naFila = [{ em: 1000, msg: r.corpo.fila.msg }, { em: 2000, msg: 'w-de-outro-aparelho' }];
    const a = await s.t.web.conversa.atividade(agente);
    assert.equal(a.na_fila.length, 2);
    assert.deepEqual(a.na_fila[0], { msg: r.corpo.fila.msg, em: 1000, texto: 'ok' });
    assert.deepEqual(a.na_fila[1], { msg: 'w-de-outro-aparelho', em: 2000 }, 'sem texto guardado, só id e hora');
    // saiu da fila: a lista esvazia, mesmo com o agente ainda trabalhando
    s.runner.opcoes.naFila = [];
    await new Promise((r) => setTimeout(r, 2100));   // o estado do runner fica 2 s em cache
    const b = await s.t.web.conversa.atividade(agente);
    assert.deepEqual(b.na_fila, []);
  } finally { await s.fechar(); }
});

test('fila: runner que não informa a fila não inventa na_fila enquanto trabalha', async () => {
  const s = await cenario({ status: 'working' });
  try {
    const a = await s.t.web.conversa.atividade(s.t.web.registro.obter('ana'));
    assert.equal(a.na_fila, undefined);
  } finally { await s.fechar(); }
});

test('fila: fala de colaborador não guarda texto para a tela', async () => {
  const s = await cenario({ status: 'working' });
  try {
    const agente = s.t.web.registro.obter('ana');
    const r = await s.t.web.conversa.entregar(agente, 'segredo do colega', { cru: false, from: 'colaborador', colaboradorId: 'c1' });
    s.runner.opcoes.naFila = [{ em: 1000, msg: r.corpo.fila.msg }];
    const a = await s.t.web.conversa.atividade(agente);
    assert.equal(a.na_fila[0].texto, undefined);
  } finally { await s.fechar(); }
});

test('fila: um retrato do runner anterior ao envio não apaga o texto de mensagem que ainda espera', async () => {
  const s = await cenario({ status: 'working' });
  try {
    const agente = s.t.web.registro.obter('ana');
    const a = await s.t.web.conversa.entregar(agente, 'primeira', { cru: false, from: 'pessoa' });
    const b = await s.t.web.conversa.entregar(agente, 'segunda', { cru: false, from: 'pessoa' });
    s.runner.opcoes.naFila = [{ em: 1, msg: a.corpo.fila.msg }];   // retrato velho: só a primeira
    await s.t.web.conversa.atividade(agente);
    await new Promise((r) => setTimeout(r, 2100));
    s.runner.opcoes.naFila = [{ em: 1, msg: a.corpo.fila.msg }, { em: 2, msg: b.corpo.fila.msg }];
    const x = await s.t.web.conversa.atividade(agente);
    assert.equal(x.na_fila[1].texto, 'segunda');
  } finally { await s.fechar(); }
});

test('stream: mudança só na fila muda a chave do evento de atividade', () => {
  const { chaveAtividade } = require('../lib/sse');
  const base = { estado: 'trabalhando', acao: 'x', alerta: null, desde: 't', detalhe: null };
  assert.notEqual(chaveAtividade(base), chaveAtividade(Object.assign({}, base, { na_fila: [{ msg: 'w1', em: 1 }] })));
});

test('fila: lista enorme ou repetida do runner é cortada e deduplicada antes de ir para a tela', async () => {
  const s = await cenario({ status: 'working' });
  try {
    s.runner.opcoes.naFila = Array.from({ length: 5000 }, () => ({ em: 1, msg: 'wrepetido' }));
    const a = await s.t.web.conversa.atividade(s.t.web.registro.obter('ana'));
    assert.equal(a.na_fila.length, 1);
    s.runner.opcoes.naFila = Array.from({ length: 5000 }, (_, i) => ({ em: i, msg: 'w' + i }));
    await new Promise((r) => setTimeout(r, 2100));
    const b = await s.t.web.conversa.atividade(s.t.web.registro.obter('ana'));
    assert.ok(b.na_fila.length <= 50);
  } finally { await s.fechar(); }
});
