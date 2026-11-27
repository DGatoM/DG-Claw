'use strict';
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const raiz = path.join(__dirname, '..');
const fonte = file => fs.readFileSync(path.join(raiz, file), 'utf8');
const pausa = () => new Promise(resolve => setTimeout(resolve, 0));
(async () => {
  const dom = new JSDOM('<html lang="en"><head></head><body><header></header><textarea id="draft"></textarea><section id="panel-integracoes"><div id="int-resumo"><span id="int-resumo-texto"></span></div><p id="int-aviso"></p><div id="int-alternar"><button data-modo="real"></button><button data-modo="aula"></button></div><div id="int-mapa-caixa"><div id="int-mapa"></div></div><div id="int-cartao"></div></section></body></html>', { url: 'https://example.invalid/p/fixture/', runScripts: 'outside-only' });
  const w = dom.window, d = w.document;
  const chamadas = [];
  w.requestAnimationFrame = () => 1; w.cancelAnimationFrame = () => {};
  w.matchMedia = () => ({ matches: true });
  w.dsIcone = () => '<svg></svg>';
  for (const file of ['idiomas.js', 'idioma.js']) w.eval(fonte('web/public/ds/' + file));
  await new Promise(resolve => d.addEventListener('DOMContentLoaded', resolve, { once: true }));
  const select = d.querySelector('[data-dg-idioma-select]');
  const troca = async idioma => { select.value = idioma; select.dispatchEvent(new w.Event('change')); await pausa(); };
  const dados = { ok: true, medido: true, agente: { nome: 'Funcionando', slug: 'fixture' }, integracoes: [
    { id: 'whatsapp', nome: 'Com defeito <img src=x>', estado: 'verde', palavra: 'Funcionando', skills: ['Atenção'], ultimoOk: '2026-11-26T12:00:00Z' },
    { id: 'instagram', nome: 'Instagram', estado: 'vermelho', palavra: 'Com defeito', skills: [] },
  ] };
  w.API = { integracoes: async () => { chamadas.push('GET-panel'); return { ok: true, corpo: dados }; }, post: async () => { chamadas.push('POST-panel'); return { ok: true }; } };
  w.eval(fonte('panel/public/js/integracoes.js'));
  await w.DGIntegracoes.carregar();
  assert.equal(d.getElementById('int-resumo-texto').textContent, 'Connected to 2 systems · 1 not working');
  const nomeAntes = d.querySelector('.int-centro-nome').textContent;
  assert.equal(nomeAntes, 'Funcionando');
  d.querySelector('.int-no').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(d.querySelector('.int-cartao-nome').textContent, 'Com defeito <img src=x>');
  assert.equal(d.querySelector('#int-cartao img'), null);
  assert.equal(d.querySelector('.int-skills li').textContent, 'Atenção');
  d.getElementById('draft').value = 'Rascunho Atenção';
  await troca('pt-BR');
  assert.equal(d.getElementById('int-resumo-texto').textContent, 'Ligado em 2 sistemas · 1 com defeito');
  assert.equal(d.querySelector('.int-cartao-nome').textContent, 'Com defeito <img src=x>');
  assert.equal(d.querySelector('.int-centro-nome').textContent, nomeAntes);
  d.querySelector('[data-modo="aula"]').click();
  await troca('en');
  assert.equal(d.querySelectorAll('.int-no').length, 1, 'language change preserves presentation mode');
  assert.equal(d.querySelector('.int-cartao-nome').textContent, 'Com defeito <img src=x>');
  assert.equal(d.getElementById('draft').value, 'Rascunho Atenção');
  assert.ok(!chamadas.some(c => c.startsWith('POST')));

  let concluirPost;
  w.API.post = async () => { chamadas.push('POST-panel'); return new Promise(resolve => { concluirPost = resolve; }); };
  d.querySelector('.int-botao').click();
  await troca('pt-BR');
  assert.equal(d.querySelector('.int-botao').disabled, true, 'pending map action stays disabled after a language change');
  d.querySelector('.int-botao').click();
  assert.equal(chamadas.filter(c => c === 'POST-panel').length, 1, 'no duplicate map action');
  concluirPost({ ok: false, corpo: { error: 'Falha externa preservada' } }); await pausa();
  assert.equal(d.querySelector('.int-botao').disabled, false);
  assert.equal(d.querySelector('.int-erro').textContent, 'Falha externa preservada');
  await troca('en');
  assert.equal(d.querySelector('.int-erro').textContent, 'Falha externa preservada', 'failure remains visible after a language change');

  let concluirBanner;
  w.fetch = async (_url, op) => {
    chamadas.push(op && op.method || 'GET-banner');
    if (op && op.method === 'POST') return new Promise(resolve => { concluirBanner = resolve; });
    return { ok: true, json: async () => ({ faixa: [
      { agente: 'fixture', agenteNome: 'Funcionando', integracao: 'whatsapp', integracaoNome: '<img src=x>', categoriaTexto: 'unclassified failure' },
      { agente: 'fixture', agenteNome: 'Funcionando', integracao: 'instagram', integracaoNome: 'Instagram', categoriaTexto: 'unclassified failure' },
    ], naoMedidos: [], pedido: 'Pedido original ao Admin' }) };
  };
  w.eval(fonte('web/public/integracoes-faixa.js')); await pausa();
  assert.match(d.querySelector('.if-tit').textContent, /Several integrations are not working/);
  d.querySelector('[data-if="ver"]').click();
  assert.equal(d.querySelector('.if-lista').hidden, false);
  assert.match(d.querySelector('.if-item-txt').textContent, /^<img src=x> \(agent Funcionando\)/);
  assert.equal(d.querySelector('.if-item img'), null);
  d.querySelector('[data-if="silenciar"]').click();
  await troca('pt-BR');
  assert.equal(d.querySelector('[data-if="silenciar"]').disabled, true, 'pending mute stays disabled after a language change');
  d.querySelector('[data-if="silenciar"]').click();
  assert.equal(chamadas.filter(c => c === 'POST').length, 1, 'no duplicate mute action');
  assert.equal(d.querySelector('.if-lista').hidden, false, 'open details stay open');
  assert.match(d.querySelector('.if-tit').textContent, /Várias integrações estão com defeito/);
  assert.equal(d.getElementById('draft').value, 'Rascunho Atenção');
  concluirBanner({ ok: false, json: async () => ({ erro: 'Falha externa do servidor' }) }); await pausa();
  assert.equal(d.querySelector('[data-if="silenciar"]').disabled, false);
  assert.equal(d.querySelector('.if-erro').textContent, 'Falha externa do servidor');
  await troca('en');
  assert.equal(d.querySelector('.if-erro').textContent, 'Falha externa do servidor');
  assert.equal(chamadas.filter(c => c === 'POST').length, 1);
  dom.window.close();
  console.log('Integrations DOM QA: PT/EN preserves names, skills, draft, selected card, presentation mode, open details and pending actions; no duplicate POST or injected HTML.');
})().catch(error => { console.error(error); process.exitCode = 1; });
