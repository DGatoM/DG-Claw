'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../public/suporte.js');
const M = require('../public/menu-lado.js');

const pub = (n) => fs.readFileSync(path.join(__dirname, '..', 'public', n), 'utf8');

test('agrupar: máquina, admin e um grupo por agente, na ordem de chegada', () => {
  const g = S.agrupar([
    { grupo: 'maquina', id: 'a' }, { grupo: 'admin', id: 'b' },
    { grupo: 'agente', alvo: 'tina', id: 'c' }, { grupo: 'agente', alvo: 'luna', id: 'd' }, { grupo: 'agente', alvo: 'tina', id: 'e' },
  ]);
  assert.deepEqual(g.map((x) => x.titulo), ['Máquina', 'Admin', 'Agente tina', 'Agente luna']);
  assert.equal(g[2].itens.length, 2);
  assert.deepEqual(S.agrupar(null), []);
});

test('estado desconhecido vira não medido, nunca ok', () => {
  assert.equal(S.estadoValido('ok'), 'ok');
  assert.equal(S.estadoValido('inventado'), 'nao_medido');
  assert.equal(S.estadoValido(undefined), 'nao_medido');
});

test('dataHora: data ilegível ou ausente devolve vazio', () => {
  assert.equal(S.dataHora(null), '');
  assert.equal(S.dataHora('lixo'), '');
  assert.match(S.dataHora('2026-10-21T12:00:00Z'), /^\d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
});

test('textoDoErro junta o motivo e o como resolver', () => {
  assert.equal(S.textoDoErro({ erro: 'Deu ruim.', como_resolver: 'Tente de novo.' }, 500), 'Deu ruim. Tente de novo.');
  assert.match(S.textoDoErro(null, 502), /502/);
});

test('suporte.js nunca usa innerHTML nem insertAdjacentHTML (os textos podem vir de logs)', () => {
  assert.doesNotMatch(pub('suporte.js'), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});

test('textos da tela sem travessão no meio de frase', () => {
  for (const a of ['suporte.html', 'suporte.js', 'suporte.css']) assert.doesNotMatch(pub(a), /[—–]/, a);
});

test('suporte.html: casca antes do menu, tutorial ligado e uma ajuda por seção', () => {
  const h = pub('suporte.html');
  assert.doesNotMatch(h, /chat\.css|conversa\.css/);
  assert.ok(h.indexOf('/casca.css') > 0 && h.indexOf('/casca.css') < h.indexOf('/menu-lado.css'));
  assert.ok(h.indexOf('/menu-lado.js') < h.indexOf('/casca.js'));
  assert.match(h, /DGCasca\.monta\(\{ pagina: 'suporte', titulo: 'Suporte remoto'/);
  assert.equal((h.match(/data-ajuda="/g) || []).length, 4);
  assert.match(h, /não lê suas conversas, sua memória nem seus arquivos/);
});

test('menu: Suporte remoto é item fixo e marca a página ativa', () => {
  assert.equal(M.LINK_SUPORTE.href, '/suporte');
  assert.equal(M.LINK_SUPORTE.nome, 'Suporte remoto');
  assert.equal(M.chaveDoHref(M.comAgente(M.LINK_SUPORTE.href, 'tina')), 'suporte');
});

test('os passos do tutorial respondem o que é, como e por quê', () => {
  const js = pub('suporte.js');
  const passos = js.match(/oque: '/g) || [];
  assert.equal(passos.length, 4);
  assert.equal((js.match(/como: '/g) || []).length, 4);
  assert.equal((js.match(/porque: '/g) || []).length, 4);
});
