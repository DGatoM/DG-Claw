'use strict';
// Escopo do colaborador: tabela de casos. O que não está na lista é negado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { avaliar, websocketLiberado } = require('../lib/escopo');

const DONO = { usuario: 'dono', papel: 'dono', agente: null };
const CAIXA = { usuario: 'agente:ana', via: 'caixa', agente: 'ana' };
const COLAB = { usuario: 'maria@x.com', papel: 'colaborador', agente: 'ana', trocar_senha: false };
const COLAB_TEMP = Object.assign({}, COLAB, { trocar_senha: true });

const LIBERADOS = [
  ['GET', '/'], ['HEAD', '/'],
  ['GET', '/a/ana'], ['GET', '/a/ana/'], ['GET', '/conectar'], ['GET', '/conectar/'], ['GET', '/trocar-senha'],
  ['GET', '/conversa.js'], ['GET', '/casca.css'], ['GET', '/icons/icon-192.png'], ['GET', '/manifest.webmanifest'], ['GET', '/sw.js'], ['GET', '/videos/x.mp4'],
  ['GET', '/api/v1/eu'], ['POST', '/api/v1/eu/senha'], ['GET', '/api/v1/agents'], ['GET', '/api/v1/nao-lidas'],
  ['GET', '/api/v1/agents/ana'], ['GET', '/api/v1/agents/ana/avatar'], ['HEAD', '/api/v1/agents/ana/avatar'],
  ['GET', '/api/v1/agents/ana/messages'], ['GET', '/api/v1/agents/ana/stream'], ['GET', '/api/v1/agents/ana/wait'],
  ['POST', '/api/v1/agents/ana/send'], ['POST', '/api/v1/agents/ana/permissao'], ['POST', '/api/v1/agents/ana/pergunta'],
  ['POST', '/api/v1/agents/ana/reiniciar'], ['POST', '/api/v1/agents/ana/lido'], ['POST', '/api/v1/agents/ana/nao-lido'],
  ['DELETE', '/api/v1/agents/ana/nao-lido'], ['POST', '/api/v1/agents/ana/vendo'], ['POST', '/api/v1/agents/ana/upload'],
  ['GET', '/api/v1/agents/ana/compartilhados'],
  ['GET', '/api/v1/agents/ana/login'], ['POST', '/api/v1/agents/ana/login'], ['DELETE', '/api/v1/agents/ana/login'],
  ['POST', '/api/v1/agents/ana/login/codigo'], ['POST', '/api/v1/agents/ana/login/oi'],
  ['GET', '/api/v1/agents/ana/alertas'], ['POST', '/api/v1/agents/ana/alertas/0123456789abcdef01234567/visto'],
  ['GET', '/api/v1/agents/ana/alertas/0123456789abcdef01234567/mensagem'],
  ['GET', '/api/v1/media/0123456789abcdef'], ['GET', '/api/v1/media/0123456789abcdef/thumb'], ['GET', '/api/v1/media/0123456789abcdef/visual'],
  ['POST', '/api/v1/transcribe'], ['POST', '/api/v1/tts'], ['GET', '/api/v1/tts/cota'],
  ['GET', '/api/v1/conectar/docs.md'], ['GET', '/api/v1/login/docs.md'],
];

test('escopo: dono e caixa passam por tudo, inclusive o que é só do dono', () => {
  for (const s of [DONO, CAIXA, { usuario: 'antigo' }]) {
    for (const [m, p] of [...LIBERADOS, ['GET', '/mesa'], ['GET', '/p/ana/'], ['GET', '/api/v1/colaboradores'], ['POST', '/api/v1/agents/bob/send'], ['GET', '/api/v1/cofre']]) {
      assert.deepEqual(avaliar(s, m, p), { ok: true }, `${s.usuario} ${m} ${p}`);
    }
  }
});

test('escopo: sem sessão não avalia nada como liberado', () => {
  assert.equal(avaliar(null, 'GET', '/a/ana').ok, false);
});

test('escopo: colaborador passa só a lista explícita, com o slug dele', () => {
  for (const [m, p] of LIBERADOS) assert.deepEqual(avaliar(COLAB, m, p), { ok: true }, `${m} ${p}`);
});

test('escopo: slug de outro agente é negado em cada forma', () => {
  const casos = [
    ['GET', '/api/v1/agents/bob'], ['GET', '/api/v1/agents/bob/messages'], ['POST', '/api/v1/agents/bob/send'], ['GET', '/api/v1/agents/bob/stream'],
    ['POST', '/api/v1/agents/bob/upload'], ['GET', '/api/v1/agents/bob/login'], ['POST', '/api/v1/agents/bob/login/codigo'], ['POST', '/api/v1/agents/bob/login/oi'],
    ['GET', '/api/v1/agents/bob/alertas'], ['GET', '/api/v1/agents/bob/avatar'], ['POST', '/api/v1/agents/bob/comando'],
    ['GET', '/api/v1/agents/admin/messages'], ['GET', '/api/v1/agents/ANA/messages'], ['GET', '/api/v1/agents/An%61/messages'],
    ['GET', '/api/v1/agents/ana%2Fbob/messages'], ['GET', '/api/v1/agents/%2e%2e/messages'], ['GET', '/api/v1/agents/bob%20/send'],
    ['GET', '/api/v1/agents/%E0%A4%A/messages'],
  ];
  for (const [m, p] of casos) {
    const r = avaliar(COLAB, m, p);
    assert.equal(r.ok, false, `${m} ${p} devia ser negado`);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.match(r.motivo, /agente/i);
  }
});

test('escopo: páginas de outro agente, outras telas e variações viram redirecionamento para o agente dele', () => {
  for (const p of ['/a/bob', '/a/admin', '/a/ANA', '/a/An%61', '/mesa', '/lembretes', '/avisos', '/seguranca', '/colaboradores', '/mesa.html', '/conversa.html', '//a/ana', '/a//ana', '/a/ana/extra', '/p']) {
    const r = avaliar(COLAB, 'GET', p);
    if (p === '/p') { assert.equal(r.ok, false); continue; }
    assert.equal(r.ok, false, p);
    assert.equal(r.status, 302, p);
    assert.equal(r.redirecionar, '/a/ana', p);
  }
});

test('escopo: o painel /p/ é negado, inclusive o do agente dele, com o motivo certo', () => {
  for (const p of ['/p/ana/', '/p/ana', '/p/bob/', '/p/ana/api/cofre', '/p/%2e%2e/x']) {
    const r = avaliar(COLAB, 'GET', p);
    assert.equal(r.ok, false, p); assert.equal(r.status, 403, p);
    assert.match(r.motivo, /painel de configuração do agente é só do dono/);
  }
});

test('escopo: rotas do dono e rotas desconhecidas são negadas', () => {
  const nega = [
    ['GET', '/api/v1/colaboradores'], ['POST', '/api/v1/colaboradores'], ['DELETE', '/api/v1/colaboradores/abc'], ['GET', '/api/v1/colaboradores/docs.md'],
    ['GET', '/api/v1/cofre'], ['POST', '/api/v1/cofre'], ['GET', '/api/v1/onboarding'], ['POST', '/api/v1/onboarding'], ['GET', '/api/v1/estados'],
    ['GET', '/api/v1/uso'], ['GET', '/api/v1/push/chave'], ['GET', '/api/v1/avisos'], ['GET', '/api/v1/lembretes'], ['GET', '/api/v1/foco/ana'],
    ['GET', '/api/v1/tarefas'], ['GET', '/api/v1/atualizacao'], ['GET', '/api/v1/seguranca'], ['POST', '/api/v1/sigilo'], ['GET', '/api/v1/sigilo/estado'],
    ['GET', '/api/v1/rota-nova-do-futuro'], ['GET', '/api/v1/agents/ana/rota-nova'], ['GET', '/api/v1/media/zzzz'],
    ['GET', '/api/v1/agents/ana/comandos'], ['POST', '/api/v1/agents/ana/comando'],
    ['POST', '/api/v1/agents'], ['DELETE', '/api/v1/agents/ana'], ['POST', '/api/v1/agents/ana/messages'], ['GET', '/api/v1/agents/ana/send'],
    ['GET', '/api/v1/push/docs.md/..'], ['POST', '/mesa'], ['POST', '/colaboradores'], ['DELETE', '/a/ana'],
  ];
  for (const [m, p] of nega) {
    const r = avaliar(COLAB, m, p);
    assert.equal(r.ok, false, `${m} ${p}`);
    assert.ok([403, 405].includes(r.status), `${m} ${p}: ${r.status}`);
  }
});

test('escopo: estáticos só os não-HTML, sem sair da pasta', () => {
  assert.equal(avaliar(COLAB, 'GET', '/seguranca.js').ok, true);
  for (const p of ['/seguranca.html', '/../server.js', '/x/../conversa.js', '/dados.json', '/segredo.txt', '/.env']) assert.equal(avaliar(COLAB, 'GET', p).ok, false, p);
});

test('escopo: com a senha temporária pendente só passa o caminho da troca', () => {
  const ok = [['GET', '/trocar-senha'], ['GET', '/api/v1/eu'], ['POST', '/api/v1/eu/senha'], ['GET', '/trocar-senha.js'], ['GET', '/sem-zoom.css']];
  for (const [m, p] of ok) assert.equal(avaliar(COLAB_TEMP, m, p).ok, true, `${m} ${p}`);
  for (const [m, p] of [['GET', '/api/v1/agents'], ['POST', '/api/v1/agents/ana/send'], ['GET', '/api/v1/agents/ana/stream'], ['GET', '/api/v1/media/0123456789abcdef']]) {
    const r = avaliar(COLAB_TEMP, m, p);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.motivo, 'Troque a senha temporária antes de continuar.');
    assert.deepEqual(r.extra, { trocar_senha: true });
  }
  for (const p of ['/', '/a/ana', '/conectar', '/mesa']) {
    const r = avaliar(COLAB_TEMP, 'GET', p);
    assert.equal(r.status, 302, p); assert.equal(r.redirecionar, '/trocar-senha', p);
  }
  assert.equal(avaliar(COLAB_TEMP, 'GET', '/p/ana/').status, 302);
});

test('escopo: colaborador nunca abre WebSocket; dono e caixa seguem a regra de sempre', () => {
  assert.equal(websocketLiberado(COLAB).ok, false);
  assert.equal(websocketLiberado(COLAB).status, 403);
  assert.equal(websocketLiberado(DONO).ok, true);
  assert.equal(websocketLiberado(CAIXA).ok, true);
  assert.equal(websocketLiberado(null).status, 401);
});
