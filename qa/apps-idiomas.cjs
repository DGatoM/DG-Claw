'use strict';
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');
const assert = require('node:assert/strict');
const raiz = path.join(__dirname, '..');
(async () => {
  const dom = new JSDOM('<html lang="en"><body><header></header><button id="gerar">Gerar link para o cliente</button><div id="compartilhar-fixture"></div></body></html>', { url: 'https://example.invalid', runScripts: 'outside-only' });
  const w = dom.window, d = w.document;
  for (const file of ['idiomas.js', 'idioma.js']) w.eval(fs.readFileSync(path.join(raiz, 'web/public/ds', file), 'utf8'));
  await new Promise(resolve => d.addEventListener('DOMContentLoaded', resolve, { once: true }));
  const source = fs.readFileSync(path.join(raiz, 'panel/public/js/apps.js'), 'utf8');
  let funcao;
  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'FunctionDeclaration' && n.id.name === 'gerarLink') funcao = source.slice(...n.range);
    for (const [key, value] of Object.entries(n)) {
      if (key === 'range') continue;
      if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(espree.parse(source, { ecmaVersion: 'latest', range: true })); assert.ok(funcao);
  w.appAtual = 'fixture';
  w.esc = valor => String(valor).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  w.bytes = () => '<img src=x onerror=alert(1)>';
  let resposta, chamadas = 0;
  w.enviar = async () => { chamadas++; return { ok: true, corpo: resposta }; };
  w.eval(source.split('\n').filter(line => /^const dg/.test(line)).join('\n') + '\n' + funcao);
  const select = d.querySelector('[data-dg-idioma-select]');
  const troca = idioma => { select.value = idioma; select.dispatchEvent(new w.Event('change')); };
  for (const quantidade of [1, 2]) {
    resposta = { url: 'https://example.invalid/?x="<img src=x>', embutidos: quantidade, deFora: quantidade, tamanho: 123 };
    await w.gerarLink('fixture', d.getElementById('gerar'));
    assert.equal(d.getElementById('gerar').textContent, w.DGI18n.t('Gerar link para o cliente'));
    const nota = d.querySelector('.app-compartilhar-nota');
    assert.match(nota.textContent, quantidade === 1 ? /1 image was embedded/ : /2 images were embedded/);
    assert.match(nota.textContent, quantidade === 1 ? /1 file was not included/ : /2 files were not included/);
    assert.match(nota.textContent, /Anyone opening this link does not need a password/);
    assert.ok(nota.textContent.includes('<img src=x onerror=alert(1)>'));
    assert.equal(d.querySelector('#compartilhar-fixture img'), null);
    const campo = d.querySelector('.app-compartilhar-linha input');
    assert.equal(campo.value, resposta.url);
    const antes = chamadas;
    troca('pt-BR');
    assert.match(nota.textContent, quantidade === 1 ? /1 imagem entrou dentro do arquivo/ : /2 imagens entraram dentro do arquivo/);
    assert.match(nota.textContent, quantidade === 1 ? /1 arquivo não entrou/ : /2 arquivos não entraram/);
    assert.match(nota.textContent, /Quem abrir este link não precisa de senha/);
    assert.equal(campo.value, resposta.url); assert.equal(chamadas, antes);
    troca('en');
  }
  dom.window.close();
  console.log('Apps DOM QA: complete sharing note PT/EN, both plurals, escaped size/URL and no publication during language switching.');
})().catch(error => { console.error(error); process.exitCode = 1; });
