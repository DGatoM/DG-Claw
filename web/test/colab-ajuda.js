'use strict';
// Cenário compartilhado dos testes de colaborador.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { subirWeb, cliente, pastaTemp, entregaAoAgente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

const DIA = 24 * 60 * 60 * 1000;

/** Web com admin, ana e bob (cada um com home e arquivo), e um e-mail falso que guarda o que "enviou". */
async function cenario(opcoes) {
  const o = opcoes || {};
  const rAna = criarRunnerFalso(Object.assign({ agenteId: 'ana1', sessionId: 'sess-ana-00001' }, o.runnerAna || {}));
  const rBob = criarRunnerFalso({ agenteId: 'bob1', sessionId: 'sess-bob-00001' });
  const pAna = await rAna.ouvir(); const pBob = await rBob.ouvir();
  const homeAna = pastaTemp('home-ana'); const homeBob = pastaTemp('home-bob');
  fs.mkdirSync(path.join(homeAna, 'out'), { recursive: true }); fs.mkdirSync(path.join(homeBob, 'out'), { recursive: true });
  fs.writeFileSync(path.join(homeAna, 'out', 'a.txt'), 'arquivo da ana');
  fs.writeFileSync(path.join(homeBob, 'out', 'b.txt'), 'arquivo do bob');
  entregaAoAgente(homeAna); entregaAoAgente(homeBob);
  const trAna = pastaTemp('tr');
  fs.mkdirSync(path.join(trAna, '-home-agente'), { recursive: true });
  const base = { runner: 'http://127.0.0.1:1', chat_id: 'c', provedor: 'claude', modelo: 'sonnet', transcripts_dir: pastaTemp('tr') };
  const agentes = [
    { slug: 'admin', nome: 'Admin', tipo: 'admin', agente_id: 'adm1', home_host: pastaTemp('home-adm'), home_container: '/opt/admin', ...base },
    { slug: 'ana', nome: 'Ana', tipo: 'agente', agente_id: 'ana1', home_host: homeAna, home_container: '/home/agente', ...base, transcripts_dir: trAna, runner: `http://127.0.0.1:${pAna}`, chat_id: 'c_ana', ...(o.painelAna || {}) },
    { slug: 'bob', nome: 'Bob', tipo: 'agente', agente_id: 'bob1', home_host: homeBob, home_container: '/home/agente', ...base, runner: `http://127.0.0.1:${pBob}`, chat_id: 'c_bob' },
  ];
  const relogio = { t: Date.now() };
  const enviados = [];
  const email = { enviar: async (m) => { enviados.push(m); return o.emailFalha ? { enviado: false, motivo: o.emailFalha } : { enviado: true }; } };
  const t = await subirWeb({ agentes, env: o.env, opcoesServidor: Object.assign({ agora: () => relogio.t, email }, o.opcoesServidor) });
  const donoUsuario = (o.env && o.env.DGCLAW_PANEL_USER) || 'dono';
  await t.c.post('/login', { json: { usuario: donoUsuario, senha: t.senha } });
  const idAna = t.web.midia.registrar('ana', path.join(homeAna, 'out', 'a.txt')).id;
  const idBob = t.web.midia.registrar('bob', path.join(homeBob, 'out', 'b.txt')).id;
  const convida = (corpo) => t.c.post('/api/v1/colaboradores', { json: corpo });
  const fechar = async () => { await t.fechar(); await rAna.fechar(); await rBob.fechar(); };
  const escreveTranscript = (linhas) => fs.writeFileSync(path.join(trAna, '-home-agente', 'sess-ana-00001.jsonl'), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { t, rAna, rBob, relogio, enviados, idAna, idBob, homeAna, trAna, escreveTranscript, convida, fechar, dono: t.c };
}

/** Convida maria@x.com para a ana e devolve o cliente logado e já com a senha trocada. */
async function colaboradorAtivo(s, email) {
  const r = await s.convida({ agente: 'ana', email: email || 'maria@x.com', nome: 'Maria' });
  assert.equal(r.status, 201, r.texto);
  const c = cliente(s.t.porta);
  const l = await c.post('/login', { json: { usuario: email || 'maria@x.com', senha: r.json.convite.senha_temporaria } });
  assert.equal(l.status, 200, l.texto);
  const nova = 'minha-senha-nova-1';
  const tr = await c.post('/api/v1/eu/senha', { json: { nova, confirmacao: nova } });
  assert.equal(tr.status, 200, tr.texto);
  return { c, id: r.json.colaborador.id, nova, email: email || 'maria@x.com' };
}


module.exports = { DIA, cenario, colaboradorAtivo };
