'use strict';
// ultimaMensagemTs: o chamador espera no máximo 1,5 s, mas a leitura da thread continua e alimenta o cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarConversa } = require('../lib/conversa');
const { criarLeitor } = require('../lib/thread');
const { criarRunner } = require('../lib/runner');
const { criarMidia } = require('../lib/media');
const { criarRunnerFalso } = require('./runner-falso');
const { pastaTemp, capturaLog } = require('./ajuda');

const ATUAL = 'sess-atual-0001';
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

async function montar({ atrasoEstadoMs = 0, falhaEstado = false } = {}) {
  const transcripts = path.join(pastaTemp('ultima'), 'projects');
  fs.mkdirSync(transcripts, { recursive: true });
  const ts = new Date(Date.UTC(2026, 9, 12, 15, 0, 0)).toISOString();
  fs.writeFileSync(path.join(transcripts, `${ATUAL}.jsonl`), JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: `<dgchat from="pessoa" chat="c_ana" msg="m1" ts="${ts}">oi</dgchat>` } }) + '\n');
  const rf = criarRunnerFalso({ agenteId: 'ana1', sessionId: ATUAL });
  const porta = await rf.ouvir();
  const agente = { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: transcripts, home_host: pastaTemp('home'), home_container: '/home/agente' };
  const cap = capturaLog();
  const midia = criarMidia({ dataDir: pastaTemp('dados'), log: cap.log, registro: { obter: () => agente } });
  const real = criarLeitor({ log: cap.log, tz: 'America/Sao_Paulo', canalTelegram: 'plugin:telegram', midia });
  const cont = { leituras: 0, estados: 0 };
  const leitor = Object.assign(Object.create(real), { ler: (...a) => { cont.leituras += 1; return real.ler(...a); } });
  const base = criarRunner({ log: cap.log });
  const runner = Object.assign(Object.create(base), {
    estado: async (a) => {
      cont.estados += 1;
      if (falhaEstado) throw new Error('runner explodiu no teste');
      if (atrasoEstadoMs) await dorme(atrasoEstadoMs);
      return base.estado(a);
    },
  });
  const relogio = { t: 1_000_000 };
  const conversa = criarConversa({ config: {}, runner, leitor, midia, log: cap.log, agora: () => relogio.t });
  return { relogio, conversa, agente, cap, cont, fechar: () => rf.fechar() };
}
const ESPERADO = Math.round(Date.UTC(2026, 9, 12, 15, 0, 0));

test('ultimaMensagemTs: leitura que estoura 1,5 s devolve null, mas conclui e alimenta o cache', async () => {
  const c = await montar({ atrasoEstadoMs: 1800 });
  try {
    assert.equal(await c.conversa.ultimaMensagemTs(c.agente), null, 'estourou: não sei');
    await dorme(500); // a leitura que ficou para trás termina
    assert.equal(await c.conversa.ultimaMensagemTs(c.agente), ESPERADO, 'a 2ª chamada vem do cache');
    assert.equal(c.cont.leituras, 1, 'a thread foi lida uma vez só');
    assert.equal(c.cont.estados, 1);
  } finally { await c.fechar(); }
});

test('ultimaMensagemTs: duas chamadas simultâneas fazem uma leitura só', async () => {
  const c = await montar({ atrasoEstadoMs: 200 });
  try {
    const [a, b] = await Promise.all([c.conversa.ultimaMensagemTs(c.agente), c.conversa.ultimaMensagemTs(c.agente)]);
    assert.equal(a, ESPERADO); assert.equal(b, ESPERADO);
    assert.equal(c.cont.leituras, 1);
    assert.equal(c.cont.estados, 1);
  } finally { await c.fechar(); }
});

test('ultimaMensagemTs: erro vira null (nunca 0), avisa uma vez e não grava cache', async () => {
  const c = await montar({ falhaEstado: true });
  try {
    assert.equal(await c.conversa.ultimaMensagemTs(c.agente), null);
    c.relogio.t += 3000; // passa o cache de 2 s do estado do runner
    assert.equal(await c.conversa.ultimaMensagemTs(c.agente), null);
    assert.equal(c.cont.estados, 2, 'sem cache: tentou ler de novo');
    const avisos = c.cap.linhas.filter((l) => /Hora da última mensagem de Ana/.test(l));
    assert.equal(avisos.length, 1, 'avisou uma vez só');
  } finally { await c.fechar(); }
});

test('threadCompartilhada: chamadas simultâneas recebem a mesma promessa', async () => {
  const c = await montar({ atrasoEstadoMs: 100 });
  try {
    const p1 = c.conversa.threadCompartilhada(c.agente);
    const p2 = c.conversa.threadCompartilhada(c.agente);
    assert.equal(p1, p2);
    await p1;
    assert.notEqual(c.conversa.threadCompartilhada(c.agente), p1, 'depois de concluída, a próxima leitura é nova');
  } finally { await c.fechar(); }
});
