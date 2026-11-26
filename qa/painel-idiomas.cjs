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
function constante(source, name) {
  const ast = espree.parse(source, { ecmaVersion: 2023, range: true });
  const declaration = ast.body.find(n => n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === name));
  assert.ok(declaration, name); return source.slice(...declaration.range);
}
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
  // Real renderers: only code-owned map labels translate. Unknown keys are data,
  // even when they happen to equal a Portuguese source in the translation catalog.
  const ids = ['mood-badge', 'last-update', 'header-mood', 'ft-joy', 'ft-energy', 'emotion-bars', 'needs-bars', 'recent-events', 'big-five', 'proactivity-bars', 'opinions-list', 'costs-summary', 'costs-categories', 'costs-top-crons', 'haiku-analysis-out'];
  for (const id of ids) { const el = d.createElement('div'); el.id = id; d.body.appendChild(el); }
  w.eval(helpers(app) + '\n' + ['EMOCAO_LABELS', 'NECESSIDADE_LABELS', 'EVENTO_LABELS', 'CATEGORY_LABELS'].map(n => constante(app, n)).join('\n') + '\n' +
    ['escapeHtml', 'numeroSeguro', 'makeBar', 'achatarEventos', 'renderEmotions', 'loadPersonality', 'fmtUSD', 'fmtUSD4', 'loadCosts', 'runHaikuAnalysis'].map(n => funcao(app, n)).join('\n'));
  w.dsIcone = () => ''; w.updatedTag = () => ''; w.formatDate = () => 'fixture date';
  w.getDelta = () => 0; w.setTracked = () => {}; w.savePrevValues = () => {};
  w.aliveOn = () => true; w.moodSpriteFor = () => 'fixture'; w.pintaRetratoProprio = () => {}; w.getMoodColor = () => 'fixture';
  w.loadCostsExecutions = async () => {};
  w.ricoLinha = w.escapeHtml;
  w.API.costsAnalyze = async () => ({ transcript_found: true, analysis: {} });
  w.API.personalityChangelog = async () => null;
  w.API.personality = async () => ({ bigFive: { abertura: 7 }, proactivity: { humor: 4, Senha: 5, '<img src=x onerror=alert(1)>': 6 }, opinions: [] });
  w.API.costsOverview = async () => ({ month: { total: 4, executions: 4 }, today: { total: 1 }, yesterday: { total: 1 }, week: { total: 4 }, byCategory: { outro: { cost: 1, executions: 1 }, 'Atenção': { cost: 1, executions: 1 }, '<img src=x onerror=alert(1)>': { cost: 1, executions: 1 } }, topCrons: [] });
  w.renderEmotions({ mood: { energy: 0.8 }, emotions: { joy: 0.5, Senha: 0.2 }, needs: { growth: 0.3, Senha: 0.4 }, recentEvents: [{ type: 'positive_feedback' }, { type: 'Atenção' }, { type: '<img src=x onerror=alert(1)>' }] });
  await w.loadPersonality(); await w.loadCosts(); await w.runHaikuAnalysis('fixture'); w.DGI18n.aplicar();
  const barLabels = id => [...d.getElementById(id).querySelectorAll('.rpg-bar-label > span:first-child')].map(el => el.textContent);
  assert.deepEqual(barLabels('emotion-bars'), ['Energy', 'Happiness', 'Senha']);
  assert.deepEqual(barLabels('needs-bars'), ['Growth', 'Senha']);
  assert.deepEqual(barLabels('proactivity-bars'), ['Mood', 'Senha', '<img src=x onerror=alert(1)>']);
  assert.deepEqual(barLabels('big-five'), ['Openness']);
  const analysis = d.getElementById('haiku-analysis-out');
  assert.ok(analysis.textContent.includes('Transcript found · analysis based on transcript + metrics'));
  const events = d.getElementById('recent-events'), costs = d.getElementById('costs-categories');
  assert.ok(events.textContent.includes('Atenção')); assert.ok(costs.textContent.includes('Atenção'));
  assert.ok(costs.textContent.includes('Other'));
  for (const id of ids) assert.equal(d.getElementById(id).querySelector('img'), null, id);
  troca('pt-BR');
  assert.deepEqual(barLabels('emotion-bars'), ['Energia', 'Alegria', 'Senha']);
  assert.deepEqual(barLabels('needs-bars'), ['Crescimento', 'Senha']);
  assert.deepEqual(barLabels('proactivity-bars'), ['Humor', 'Senha', '<img src=x onerror=alert(1)>']);
  assert.deepEqual(barLabels('big-five'), ['Abertura']);
  assert.ok(analysis.textContent.includes('Transcript encontrado · análise baseada em transcript + métricas'));
  assert.ok(events.textContent.includes('Atenção')); assert.ok(costs.textContent.includes('Atenção'));
  assert.ok(costs.textContent.includes('Outro'));
  troca('en'); assert.deepEqual(barLabels('emotion-bars'), ['Energy', 'Happiness', 'Senha']);
  assert.ok(analysis.textContent.includes('Transcript found · analysis based on transcript + metrics'));
  w.API.costsAnalyze = async () => ({ transcript_found: false, analysis: {} });
  await w.runHaikuAnalysis('fixture'); w.DGI18n.aplicar();
  assert.ok(analysis.textContent.includes('Transcript not found · analysis based on metrics only'));
  troca('pt-BR'); assert.ok(analysis.textContent.includes('Transcript não encontrado · análise baseada só em métricas'));
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
