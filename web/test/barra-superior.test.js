'use strict';
// Barra superior compacta da conversa: botões só com ícone, Voz agrupando ler e contínua.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lê = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const html = lê('conversa.html');
const css = lê('conversa.css');
const js = lê('conversa.js');

function trecho(id) {
  const ini = html.indexOf('id="' + id + '"');
  assert.ok(ini > 0, id + ' existe');
  const abre = html.lastIndexOf('<', ini);
  const tag = html.slice(abre, html.indexOf('>', ini) + 1);
  const nome = /^<(\w+)/.exec(tag)[1];
  const fim = html.indexOf('</' + nome + '>', ini);
  return { tag, corpo: html.slice(ini, fim) };
}

test('btnVoz existe e aponta para o popover', () => {
  const { tag } = trecho('btnVoz');
  assert.match(tag, /aria-haspopup=/);
  assert.match(tag, /aria-expanded="false"/);
  assert.match(tag, /aria-controls="menuVoz"/);
  assert.match(tag, /aria-label="Voz: leitura em voz alta e conversa contínua"/);
});

test('btnLer e btnContinua ficam dentro de #menuVoz, e fora de #tools', () => {
  const menu = trecho('menuVoz').corpo;
  assert.ok(menu.includes('id="btnLer"') && menu.includes('id="btnContinua"'));
  const tools = html.slice(html.indexOf('id="tools"'), html.indexOf('id="menuVoz"'));
  assert.ok(html.indexOf('id="menuVoz"') > html.indexOf('</header>'), '#menuVoz fica fora do header');
  assert.ok(!tools.includes('id="btnLer"') && !tools.includes('id="btnContinua"'));
});

test('todo botão e link de #tools tem aria-label', () => {
  const ini = html.indexOf('id="tools"');
  const bloco = html.slice(ini, html.indexOf('</header>'));
  const tags = bloco.match(/<(button|a)\b[^>]*>/g) || [];
  assert.ok(tags.length >= 5);
  for (const t of tags) {
    if (/id="btnParar"/.test(t)) continue;   // ação temporária, tem texto
    assert.match(t, /aria-label="[^"]+"/, t);
  }
});

test('o CSS esconde .lbl de #tools fora do media query', () => {
  const fora = css.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  assert.match(fora, /\.tools \.lbl\{display:none\}/);
});

test('o JS não deixa btnVoz fora de sincronia e trata Esc', () => {
  assert.match(js, /function pintaVoz\(/);
  assert.match(js, /ev\.key === 'Escape' && !menuVoz\.hidden/);
  assert.match(js, /addEventListener\('wheel'[\s\S]*passive: false/);
});

test('clique fora usa composedPath; sigilo.js na URL do pré-cache, com a classe aplicada antes dele', () => {
  assert.match(js, /ev\.composedPath\(\)/);
  // a URL tem que ser a mesma do ESTATICOS do sw.js, senão a cópia guardada não serve sem rede
  assert.ok(html.includes('<script src="/sigilo.js"></script>'));
  const cedo = html.indexOf("localStorage.getItem('dgclaw:sigilo')"), mod = html.indexOf('<script src="/sigilo.js">');
  assert.ok(cedo > 0 && cedo < mod, 'a classe sigilo entra antes do sigilo.js (falha fechada)');
  assert.ok(html.indexOf('<script src="/conversa.js">') > mod, 'o histórico só é pintado depois');
});
