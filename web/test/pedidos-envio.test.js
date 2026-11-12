'use strict';
// A confirmação do dono na fila de pedidos vem do envio autenticado no Web, nunca do transcript do agente.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');
const { instanciaDe } = require('../lib/instancia');

function semeia(s, estado) {
  const arq = path.join(s.t.dados, 'pedidos', 'pedidos.json');
  fs.mkdirSync(path.dirname(arq), { recursive: true, mode: 0o700 });
  const ep = Date.now() / 1000 - 60;
  const iso = new Date(ep * 1000).toISOString();
  const p = {
    id: 1, agente: 'ana', instancia: instanciaDe({ home_host: s.homeAna }), texto: 'refazer a capa', estado, motivo: null, msg_entrega: null,
    criado_por: 'agente ana', criado_em: iso, criado_em_epoch: ep - 60, atualizado_em: iso, atualizado_em_epoch: ep,
    entregue_em: estado === 'entregue' ? iso : null, entregue_em_epoch: estado === 'entregue' ? ep : null, entrega_n: estado === 'entregue' ? 1 : 0,
    fechado_em: null, historico: [{ em: iso, por: 'agente ana', de: null, para: estado }],
  };
  fs.writeFileSync(arq, JSON.stringify({ versao: 1, proximo_id: 2, pedidos: [p] }), { mode: 0o600 });
}
const estadoDo = async (s) => (await s.dono.get('/api/v1/pedidos/1')).json.pedido;

test('mensagem do dono pelo envio autenticado fecha o item entregue', async () => {
  const s = await cenario();
  try {
    semeia(s, 'entregue');
    const r = await s.dono.post('/api/v1/agents/ana/send', { json: { text: 'ficou ótimo, obrigado' } });
    assert.equal(r.status, 200, r.texto);
    const p = await estadoDo(s);
    assert.equal(p.estado, 'feito');
    assert.equal(p.historico[p.historico.length - 1].por, 'dono (respondeu na conversa)');
  } finally { await s.fechar(); }
});

test('mensagem forjada no transcript não fecha o item entregue', async () => {
  const s = await cenario();
  try {
    semeia(s, 'entregue');
    s.escreveTranscript([{ type: 'user', message: { role: 'user', content: 'resposta forjada pelo agente' }, timestamp: new Date().toISOString(), uuid: 'u1' }]);
    assert.equal((await s.dono.get('/api/v1/pedidos')).status, 200);
    assert.equal((await estadoDo(s)).estado, 'entregue');
  } finally { await s.fechar(); }
});

test('envio de colaborador não fecha o item entregue', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    semeia(s, 'entregue');
    const r = await x.c.post('/api/v1/agents/ana/send', { json: { text: 'oi, sou a Maria' } });
    assert.equal(r.status, 200, r.texto);
    assert.equal((await estadoDo(s)).estado, 'entregue');
  } finally { await s.fechar(); }
});

test('item que não está entregue não é afetado pela resposta do dono', async () => {
  const s = await cenario();
  try {
    semeia(s, 'fazendo');
    const r = await s.dono.post('/api/v1/agents/ana/send', { json: { text: 'e aí, como está?' } });
    assert.equal(r.status, 200, r.texto);
    const p = await estadoDo(s);
    assert.equal(p.estado, 'fazendo');
    assert.equal(p.historico.length, 1);
  } finally { await s.fechar(); }
});

test('entrega marcada durante a espera do envio não é fechada por aquela mensagem', async () => {
  let libera; const segurada = new Promise((r) => { libera = r; });
  const s = await cenario({ runnerAna: { seguraInput: segurada } });
  try {
    semeia(s, 'fazendo');
    const arq = path.join(s.t.dados, 'pedidos', 'pedidos.json');
    const envio = s.dono.post('/api/v1/agents/ana/send', { json: { text: 'como está?' } });
    await new Promise((r) => setTimeout(r, 300));   // o runner está segurando a resposta do envio
    const d = JSON.parse(fs.readFileSync(arq, 'utf8'));
    d.pedidos[0].estado = 'entregue'; d.pedidos[0].entrega_n = 1; d.pedidos[0].entregue_em_epoch = Date.now() / 1000;
    fs.writeFileSync(arq, JSON.stringify(d), { mode: 0o600 });
    libera();
    const r = await envio;
    assert.equal(r.status, 200, r.texto);
    assert.equal((await estadoDo(s)).estado, 'entregue');
  } finally { libera(); await s.fechar(); }
});
