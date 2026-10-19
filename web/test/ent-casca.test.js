'use strict';
// As telas enterprise seguem as regras que o main impôs às demais (web/test/casca.test.js): casca única,
// tutorial ligado ao botão da casca e zoom banido. Aqui só se leem os arquivos; nada sobe servidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const TELAS = [
  ['aprovacoes.html', 'aprovacoes', 'Aprovações'],
  ['auditoria.html', 'auditoria', 'Auditoria'],
  ['conta.html', 'conta', 'Minha conta'],
  ['novo-agente.html', 'novo-agente', 'Novo agente'],
  ['protecoes.html', 'protecoes', 'Proteções'],
  ['usuarios.html', 'usuarios', 'Usuários'],
];

for (const [arquivo, pagina, titulo] of TELAS) {
  test(`${arquivo}: usa a casca única, com o tutorial no cabeçalho dela`, () => {
    const h = pub(arquivo);
    assert.doesNotMatch(h, /chat\.css|conversa\.css/, 'não herda o CSS da conversa');
    assert.ok(h.indexOf('/casca.css') > 0 && h.indexOf('/casca.css') < h.indexOf('/menu-lado.css'), 'casca.css antes do menu-lado.css');
    assert.ok(h.indexOf('/menu-lado.js') > 0 && h.indexOf('/menu-lado.js') < h.indexOf('/casca.js'), 'menu-lado.js antes da casca.js');
    assert.match(h, new RegExp(`DGCasca\\.monta\\(\\{ pagina: '${pagina}', titulo: '${titulo}'`));
    assert.match(h, /aoTutorial:/);
    assert.doesNotMatch(h, /[—–]/, 'sem travessão');
  });
}

for (const arquivo of [...TELAS.map((t) => t[0]), 'login-2fa.html']) {
  test(`${arquivo}: zoom banido (viewport sem zoom, sem-zoom.css e sem-zoom.js)`, () => {
    const h = pub(arquivo);
    assert.match(h, /name="viewport"[^>]*maximum-scale=1, user-scalable=no/);
    assert.match(h, /<link rel="stylesheet" href="\/sem-zoom\.css">/);
    assert.match(h, /<script src="\/sem-zoom\.js"><\/script>/);
  });
}
