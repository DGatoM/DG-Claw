'use strict';
// Auditoria "tela igual à do dono, sem trocador": o colaborador não tem como chegar a outro agente, nem pela tela
// (nada de trocador no DOM) nem pelo servidor (caminho, parâmetro, cookie e localStorage adulterados).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');
const casca = require('../public/casca');
const puro = require('../public/conectar-puro');

const HTML_REAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.html'), 'utf8');

test('a conversa chega ao colaborador sem a fileira #trocaBaixo (o elemento nem é enviado); o dono continua com ela', async () => {
  const s = await cenario();
  try {
    fs.writeFileSync(path.join(s.t.publico, 'conversa.html'), HTML_REAL);
    const x = await colaboradorAtivo(s);
    const colab = await x.c.get('/a/ana', { headers: { Accept: 'text/html' } });
    assert.equal(colab.status, 200);
    assert.doesNotMatch(colab.texto, /trocaBaixo|troca-baixo|Trocar de agente/);
    assert.match(colab.texto, /id="entrada"/, 'o resto da conversa está lá');
    const dono = await s.dono.get('/a/ana', { headers: { Accept: 'text/html' } });
    assert.match(dono.texto, /id="trocaBaixo"/);
  } finally { await s.fechar(); }
});

test('a casca do colaborador não injeta o trocador de agentes nem a bolinha de soma dos outros; a do dono injeta', () => {
  assert.match(casca.MARCACAO_MENU, /id="mlTroca"/);
  assert.match(casca.MARCACAO_MENU, /id="mlLista"/);
  for (const id of ['mlTroca', 'mlTrocaBtn', 'mlLista', 'trocar de agente']) assert.ok(!casca.MARCACAO_MENU_COLAB.includes(id), `sobrou ${id}`);
  assert.match(casca.MARCACAO_MENU_COLAB, /id="mlTabs"/, 'o resto do menu continua');
});

test('o tutorial do colaborador não tem passo de troca de agente nem de Admin', () => {
  const M = require('../public/menu-lado');
  const passos = M.passosMenu({ nome: 'Ana', abre() {}, fecha() {}, comTroca: false, naConversa: true, colaborador: true });
  assert.equal(passos.length, 1);
  assert.doesNotMatch(JSON.stringify(passos), /#mlTroca|Trocar de agente|Admin vem primeiro/);
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.js'), 'utf8');
  assert.match(fonte, /comTroca: !COLAB && agentesMenu\.length > 1/);
  assert.match(fonte, /if \(\$\('trocaBaixo'\) && \$\('trocaBaixo'\)\.offsetParent !== null\)/, 'o passo da fileira só existe se o elemento existe');
});

test('a página Conectar do colaborador não fala em Admin e não oferece botão quando já está conectado', () => {
  const a = { id: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude' };
  const conectado = puro.visaoCartao({ ok: true, conectado: true, precisa_login: false, provedor: 'claude' }, { agente: a, colaborador: true });
  assert.equal(conectado.texto, 'Este agente já está conectado.');
  assert.equal(conectado.gerar, false); assert.equal(conectado.entrarOutra, false); assert.equal(conectado.cancelar, false); assert.equal(conectado.novoLink, false);
  const sem = puro.visaoCartao({ ok: true, conectado: false, precisa_login: true, provedor: 'claude', estado: 'nenhum' }, { agente: a, colaborador: true });
  assert.equal(sem.gerar, true);
  const ocupado = puro.visaoCartao({ ok: true, conectado: false, precisa_login: true, ocupado: true, estado: 'nenhum', provedor: 'claude', mensagem: 'Outra pessoa está conectando.' }, { agente: a, colaborador: true });
  assert.equal(ocupado.gerar, false); assert.match(ocupado.texto, /Outra pessoa/);
  const soDono = puro.visaoCartao({ ok: true, conectado: false, precisa_login: false, login_expirado: true, so_dono: true, provedor: 'claude', mensagem: 'Avise o dono.' }, { agente: a, colaborador: true });
  assert.equal(soDono.gerar, false); assert.equal(soDono.fase, 'so_dono');
  for (const v of [conectado, sem, ocupado, soDono]) assert.doesNotMatch(JSON.stringify(v), /Admin|admin/);
  // erros do servidor chegam como estão (já em português) e não mandam "pedir ao Admin"
  assert.equal(puro.traduzErro(409, 'Outra pessoa está conectando a conta.', 'gerar', 'Ana', true).texto, 'Outra pessoa está conectando a conta.');
  assert.doesNotMatch(puro.traduzErro(503, 'sem resposta', 'conferir', 'Ana', true).texto, /Admin/);
  assert.doesNotMatch(puro.traduzErro(500, 'x', 'gerar', 'Ana', true).texto, /Admin/);
});

test('servidor: o colaborador não chega a outro agente por caminho, parâmetro, cookie nem localStorage adulterado', async () => {
  const s = await cenario();
  try {
    fs.writeFileSync(path.join(s.t.publico, 'conversa.html'), HTML_REAL);
    fs.copyFileSync(path.join(__dirname, '..', 'public', 'conectar.html'), path.join(s.t.publico, 'conectar.html'));
    const x = await colaboradorAtivo(s);
    const adulterado = { headers: { Accept: 'text/html', Cookie: 'dgclaw_agente=bob; dgclaw:agente=bob' } };
    // páginas
    for (const p of ['/a/bob', '/a/admin', '/a/BOB', '/a/bo%62', '/a/ana%2Fbob', '/mesa?a=bob', '/conectar?agente=bob', '/conectar?a=admin', '/lembretes?a=bob']) {
      const r = await x.c.get(p, adulterado);
      // /conectar abre (é do colaborador) e o parâmetro ?agente= não muda nada: a lista de agentes que a página busca é só a dele
      assert.ok([200, 302, 403].includes(r.status) && (r.status !== 200 || p.startsWith('/conectar')), `${p}: ${r.status}`);
      if (r.status === 302) assert.match(r.headers.location, /^\/a\/ana$|^\/trocar|^\/conectar|^\/a\/ana/, `${p} -> ${r.headers.location}`);
    }
    // a raiz, mesmo com o cookie do "último agente" apontando para outro
    const raiz = await x.c.get('/', adulterado);
    assert.equal(raiz.status, 302); assert.equal(raiz.headers.location, '/a/ana');
    // painel
    for (const p of ['/p/bob/', '/p/admin/', '/p/bob/api/memory', '/p/ana/../bob/', '/p/ana/%2e%2e/bob/']) assert.equal((await x.c.get(p)).status, 403, p);
    // API
    for (const p of ['/api/v1/agents/bob', '/api/v1/agents/bob/messages', '/api/v1/agents/admin/stream', '/api/v1/agents/bob/login', '/api/v1/agents/bob/alertas', '/api/v1/agents/ana%2F..%2Fbob/messages']) {
      assert.equal((await x.c.get(p)).status, 403, p);
    }
    for (const [m, p] of [['POST', '/api/v1/agents/bob/send'], ['POST', '/api/v1/agents/bob/login'], ['POST', '/api/v1/agents/bob/upload'], ['POST', '/api/v1/agents/bob/login/codigo']]) {
      assert.equal((await x.c.pedir(m, p, { json: { text: 'oi' } })).status, 403, `${m} ${p}`);
    }
    assert.equal(s.rBob.rec.inputs.length, 0); assert.equal(s.rBob.rec.loginPosts, 0);
    // ?agente=<outro> em rotas dele não muda de agente: a lista continua sendo só a dele
    const lista = await x.c.get('/api/v1/agents?agente=bob&a=bob');
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.json.agentes.map((a) => a.id), ['ana']);
    const nl = await x.c.get('/api/v1/nao-lidas?agente=bob');
    assert.deepEqual(Object.keys(nl.json.agentes).filter((k) => k !== 'ana'), []);
    // rotas do dono: Mesa, estados, uso, tarefas, colaboradores
    for (const p of ['/api/v1/estados', '/api/v1/uso', '/api/v1/tarefas', '/api/v1/colaboradores', '/api/v1/modal-login/preferencia', '/api/v1/alertas']) assert.ok([403, 404].includes((await x.c.get(p)).status), p);
  } finally { await s.fechar(); }
});
