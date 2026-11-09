'use strict';
// A tela dos cartões e do Reset do modo demonstração: escape de dados, celular e regras do contrato.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLICO = path.join(__dirname, '..', 'public');
const js = fs.readFileSync(path.join(PUBLICO, 'demo-cartoes.js'), 'utf8');
const css = fs.readFileSync(path.join(PUBLICO, 'demo-cartoes.css'), 'utf8');

test('demo-cartoes.js é JavaScript válido', () => {
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'demo-cartoes.js' }));
});

test('nada que vem de dado entra como HTML: só textContent', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), 'dado do provedor ou do agente não pode virar HTML');
  assert.match(js, /textContent = txt/);
});

test('a tela consulta a cada 2 segundos, pede a frase NOVO CLIENTE e recarrega a página ao concluir', () => {
  assert.match(js, /INTERVALO = 2000/);
  assert.match(js, /FRASE = 'NOVO CLIENTE'/);
  assert.match(js, /\/api\/demo\/cartoes/);
  assert.match(js, /\/api\/demo\/reset\/estado/);
  assert.match(js, /location\.reload\(\)/);
  assert.match(js, /credentials: 'same-origin'/);
});

test('o cartão mostra canal, linha, destinatário, número completo, texto, anexos e os dois botões', () => {
  for (const rotulo of ["'Canal'", "'Linha'", "'Para'", "'Número'", "'Texto'", "'Confirmar'", "'Recusar'", "'Anexos ("]) assert.ok(js.includes(rotulo), `falta ${rotulo}`);
});

test('CSS: celular sem rolagem lateral, alvos de toque de 32px ou mais e campo com 16px ou mais', () => {
  assert.match(css, /\.dc-cartao\{[^}]*overflow-x:hidden/);
  assert.match(css, /\.dc-fundo\{[^}]*overflow-x:hidden/);
  assert.match(css, /overflow-wrap:anywhere/);
  for (const m of css.matchAll(/min-height:(\d+)px/g)) assert.ok(Number(m[1]) >= 32, `alvo de toque pequeno: ${m[0]}`);
  const campo = /\.dc-campo\{[^}]*font-size:(\d+)px/.exec(css);
  assert.ok(campo && Number(campo[1]) >= 16);
  const celular = /@media \(max-width:560px\)\{[\s\S]*\}/.exec(css)[0];
  assert.match(celular, /\.dc-campo\{font-size:1[6-9]px/);
  assert.ok(!/<[A-Za-z/]/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'folha de estilo sem tag HTML');
});
