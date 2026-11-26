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
const helpers = s => s.split('\n').filter(l => /^const dg/.test(l)).join('\n');
(async () => {
  const dom = new JSDOM('<html lang="en"><head><title>Fixture</title></head><body><main><span id="char-name"></span><h1 id="header-title"></h1><textarea id="draft"></textarea></main></body></html>', { url: 'https://example.invalid/p/fixture/', runScripts: 'outside-only' });
  const w = dom.window, d = w.document;
  for (const file of ['idiomas.js', 'idioma.js']) w.eval(fs.readFileSync(path.join(raiz, 'web/public/ds', file), 'utf8'));
  await new Promise(r => d.addEventListener('DOMContentLoaded', r, { once: true }));
  const select = d.querySelector('[data-dg-idioma-select]');
  const troca = idioma => { select.value = idioma; select.dispatchEvent(new w.Event('change')); };
  const app = fs.readFileSync(path.join(raiz, 'panel/public/js/app.js'), 'utf8');
  w.API = { config: async () => ({ agentName: 'Agente Senha', creatorName: 'Ana', extensions: [] }) };
  w.APP_CONFIG = {}; w.BASE = ''; w.NA_PLATAFORMA = false; w.applyExtensions = () => {}; w.aliveOn = () => false;
  w.eval(helpers(app) + '\n' + funcao(app, 'initConfig'));
  await w.initConfig();
  assert.equal(d.title, 'Agente Senha - Dashboard');
  assert.equal(d.getElementById('header-title').textContent, 'agent for Ana');
  troca('pt-BR'); assert.equal(d.title, 'Agente Senha - Painel');
  assert.equal(d.getElementById('header-title').textContent, 'agente de Ana');
  troca('en');
  const sessoes = fs.readFileSync(path.join(raiz, 'panel/public/js/sessoes.js'), 'utf8');
  w.eval(helpers(sessoes) + '\n' + ['el', 'caixaPedido', 'decidePedido', 'anexa'].map(n => funcao(sessoes, n)).join('\n'));
  const chamadas = [];
  w.grupoDe = () => 'esperando_voce'; w.recOn = () => true; w.soLeitura = () => false; w.modoLocal = () => true;
  w.ajuda = () => d.createElement('span'); w.det = null; w.carregaLista = () => {}; w.mostraAviso = () => {}; w.renderDetalhe = () => {}; w.guardaRascunho = () => {};
  w.chama = async (url, op) => { chamadas.push({ url, op }); return { ok: true, corpo: { caminho: '/arquivos/Senha.txt', nome: 'Senha.txt' } }; };
  const pedido = 'Senha <img src=x onerror=alert(1)>';
  const caixa = w.caixaPedido({ id: 'fixture', pedido }); d.body.appendChild(caixa);
  assert.equal(caixa.querySelector('.sx-ped-txt').textContent, pedido);
  assert.equal(caixa.querySelector('img'), null);
  assert.ok(!caixa.textContent.includes('[object HTMLParagraphElement]'));
  const aprovar = caixa.querySelector('.prim'); assert.equal(aprovar.textContent, 'Approve');
  aprovar.click(); await new Promise(r => setTimeout(r, 0));
  assert.equal(chamadas[0].url, '/api/sessoes/fixture/decidir');
  assert.equal(chamadas[0].op.body.acao, 'aprovar');
  troca('pt-BR'); assert.equal(aprovar.textContent, 'Aprovar');
  assert.equal(caixa.querySelector('.sx-ped-txt').textContent, pedido);
  troca('en');
  const arquivo = d.createElement('input'); arquivo.type = 'file';
  Object.defineProperty(arquivo, 'files', { value: [new w.File(['fixture'], 'Senha.txt', { type: 'text/plain' })] });
  const texto = d.getElementById('draft'); texto.value = 'Rascunho preservado';
  w.det = { id: 'fixture', ref: { arquivo, texto }, anexando: false };
  await w.anexa();
  const upload = chamadas.find(c => c.op.form);
  assert.ok(upload); assert.equal(upload.op.form.get('arquivo').name, 'Senha.txt');
  assert.equal(upload.op.form.get('file'), null);
  assert.equal(texto.value, 'Rascunho preservado\n[anexo: /arquivos/Senha.txt]');
  assert.equal(w.det.notaAnexo.texto, 'Attached: Senha.txt. Review the message and send.');
  dom.window.close();
  console.log('Panel DOM QA: título, pedido, permissão e multipart PT/EN preservam dados e protocolo.');
})().catch(e => { console.error(e); process.exitCode = 1; });
