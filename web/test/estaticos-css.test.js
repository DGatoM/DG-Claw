'use strict';
// Regressão: um `</style></head>` colado por engano dentro de conversa.css derrubou a regra
// seguinte (#overlayMenu) e o menu não fechava ao tocar fora. Folha de estilo não leva tag HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLICO = path.join(__dirname, '..', 'public');

test('nenhum .css de public/ contém tag HTML', () => {
  const achados = [];
  for (const nome of fs.readdirSync(PUBLICO).filter((n) => n.endsWith('.css'))) {
    // comentário pode citar `<slug>` à vontade: apaga o texto dele mas mantém as quebras de linha
    const css = fs.readFileSync(path.join(PUBLICO, nome), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    css.split('\n').forEach((linha, i) => {
      if (/<[A-Za-z/]/.test(linha)) achados.push(`${nome}:${i + 1}: ${linha.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(achados, [], `Tag HTML dentro de CSS (remova a linha, ela derruba as regras seguintes):\n${achados.join('\n')}`);
});

test('conversa.css: o respiro da área segura só sai da barra quando a fileira de avatares está na tela', () => {
  const css = fs.readFileSync(path.join(PUBLICO, 'conversa.css'), 'utf8');
  const js = fs.readFileSync(path.join(PUBLICO, 'conversa.js'), 'utf8');
  // nenhuma regra zera o padding da barra sem passar pela classe com-troca
  for (const m of css.matchAll(/([^{}]*\.barra[^{}]*)\{[^}]*padding-bottom:0\}/g)) {
    for (const seletor of m[1].split(',')) assert.match(seletor, /com-troca/, 'padding-bottom:0 na barra sem com-troca: ' + seletor.trim());
  }
  assert.match(css, /body\.com-troca \.barra/);
  assert.match(js, /document\.body\.classList\.toggle\('com-troca', agentesMenu\.length >= 2\)/);
});

test('a bolinha de não lidas do avatar existe no CSS e o service worker subiu de versão', () => {
  const css = fs.readFileSync(path.join(PUBLICO, 'conversa.css'), 'utf8');
  assert.match(css, /\.troca-baixo \.bolinha-nl\{[^}]*position:absolute[^}]*border:2px solid/);
  assert.match(fs.readFileSync(path.join(PUBLICO, 'sw.js'), 'utf8'), /dgclaw-estaticos-v24'/);
  assert.match(fs.readFileSync(path.join(PUBLICO, 'conversa.js'), 'utf8'), /class="bolinha-nl"/);
});
