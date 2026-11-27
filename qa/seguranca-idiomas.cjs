'use strict';
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const espree = require('espree');
const raiz = path.join(__dirname, '..');
function funcao(source, name) {
  const ast = espree.parse(source, { ecmaVersion: 2023, range: true });
  let achada;
  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'FunctionDeclaration' && n.id.name === name) achada = source.slice(...n.range);
    for (const [k, v] of Object.entries(n)) {
      if (k === 'range') continue;
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
    }
  }
  walk(ast); assert.ok(achada, name); return achada;
}
(async () => {
  const dom = new JSDOM('<html lang="en"><body><main><textarea id="draft"></textarea><p id="autoAdminEstado"></p><p id="autoAdminAviso" hidden></p><div id="autoAdminAcoes"></div><p id="autoAdminSuspenso" hidden></p></main></body></html>', { url: 'https://example.invalid/seguranca', runScripts: 'outside-only' });
  const w = dom.window, d = w.document;
  for (const file of ['idiomas.js', 'idioma.js']) w.eval(fs.readFileSync(path.join(raiz, 'web/public/ds', file), 'utf8'));
  await new Promise(r => d.addEventListener('DOMContentLoaded', r, { once: true }));
  const source = fs.readFileSync(path.join(raiz, 'web/public/seguranca.js'), 'utf8');
  const helpers = source.split('\n').filter(l => /^const (dgSeg|RSegEsc)/.test(l)).join('\n');
  const constants = ['AVISO_AUTO_ADMIN','TEXTO_SUSPENSO'].map(n => source.split('\n').find(l=>l.trimStart().startsWith('const '+n+' ='))).join('\n');
  w.eval(helpers + '\n' + constants + '\nconst $ = id => document.getElementById(id); const auto = { ligado: false, confirmando: true, suspenso: true };\n' + ['autoAdminEstadoTexto','autoAdminBotoes','pintaAutoAdmin','resumoGrupoAtualizacoes'].map(n=>funcao(source,n)).join('\n') + '\npintaAutoAdmin(); window.resumoGrupoTeste = resumoGrupoAtualizacoes;');
  const warning = d.getElementById('autoAdminAviso');
  assert.match(warning.textContent, /full access to the server/);
  assert.match(warning.textContent, /Nothing is applied without your approval/);
  assert.match(d.getElementById('autoAdminSuspenso').textContent, /Automatic requests are suspended/);
  assert.equal(warning.hidden, false);
  const confirmation = d.querySelector('[data-rp="auto-confirmar"]');
  assert.equal(confirmation.textContent, 'I understand the risk, enable');
  d.getElementById('draft').value = 'rascunho de emergência';
  const group = d.createElement('div');
  group.innerHTML = w.resumoGrupoTeste({nome:'Senha <img src=x onerror=1>',itens:[{componente:'Senha <img src=x onerror=1>'}]}, true);
  d.querySelector('main').appendChild(group);
  assert.equal(group.querySelector('img'), null);
  assert.match(group.textContent,/Senha <img src=x onerror=1>: 1 fix/);
  const select = d.querySelector('[data-dg-idioma-select]');
  select.value = 'pt-BR'; select.dispatchEvent(new w.Event('change'));
  assert.match(warning.textContent, /acesso total ao servidor/);
  assert.equal(confirmation.textContent, 'Entendi o risco, ligar');
  assert.match(group.textContent,/Senha <img src=x onerror=1>: 1 correção/);
  assert.equal(d.querySelector('[data-rp="auto-confirmar"]'),confirmation);
  assert.equal(d.getElementById('draft').value,'rascunho de emergência');
  assert.equal(warning.hidden,false);
  assert.equal(group.querySelector('img'),null);
  dom.window.close();
  console.log('OK: security warning, suspension, explicit confirmation, live PT/EN, preserved draft and escaped component data.');
})().catch(e=>{console.error(e);process.exitCode=1;});
