'use strict';
// Só fixtures locais: nenhum login, mudança de senha ou comando em uma instalação.
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { renderizarIdioma } = require('../web/lib/idioma');
const pub = path.join(__dirname, '../web/public');
const source = f => fs.readFileSync(path.join(pub, f), 'utf8');
const wait = () => new Promise(r => setTimeout(r, 20));
(async () => {
  const dom = new JSDOM(renderizarIdioma(source('trocar-senha.html'), { headers: {} }, 'en'), {
    url: 'https://fixture.example/trocar-senha', runScripts: 'outside-only',
  });
  const w = dom.window, d = w.document, requests = [];
  w.fetch = async (url, opts) => {
    requests.push({ url, opts });
    return url === '/api/v1/eu'
      ? { ok: true, json: async () => ({ papel: 'dono' }) }
      : { ok: false, status: 403, json: async () => ({ erro: 'Fixture refusal' }) };
  };
  for (const f of ['ds/idiomas.js', 'ds/idioma.js', 'trocar-senha.js']) w.eval(source(f));
  await wait();
  assert.equal(d.querySelector('h1').textContent, 'Change password');
  assert.equal(d.getElementById('tsEnviar').textContent, 'Save');
  assert.match(d.getElementById('tsDica').textContent, /12 to 128/);
  assert.match(d.getElementById('tsSub').textContent, /other signed-in devices/);
  const atual = d.getElementById('tsAtual'), nova = d.getElementById('tsNova'), conf = d.getElementById('tsConf');
  atual.value = 'fixture-current'; nova.value = conf.value = 'fixture-new-long';
  const select = d.querySelector('[data-dg-idioma-select]');
  select.value = 'pt-BR'; select.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelector('h1').textContent, 'Trocar senha');
  assert.equal(d.getElementById('tsEnviar').textContent, 'Salvar');
  assert.match(d.getElementById('tsSub').textContent, /outros aparelhos/);
  assert.equal(atual.value, 'fixture-current'); assert.equal(nova.value, 'fixture-new-long');
  select.value = 'en'; select.dispatchEvent(new w.Event('change'));
  d.getElementById('tsForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/api/v1/dono/senha');
  assert.deepEqual(JSON.parse(requests[1].opts.body), { atual: 'fixture-current', nova: 'fixture-new-long', confirmacao: 'fixture-new-long' });
  assert.equal(d.getElementById('erro').textContent, 'Fixture refusal');
  assert.equal(d.getElementById('tsEnviar').textContent, 'Save');
  assert.equal(nova.value, 'fixture-new-long');
  nova.value = conf.value = 'abc';
  d.getElementById('tsForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.match(d.getElementById('erro').textContent, /has 3 characters.*at least 12/);
  select.value = 'pt-BR'; select.dispatchEvent(new w.Event('change'));
  assert.match(d.getElementById('erro').textContent, /tem 3 caracteres.*pelo menos 12/);
  assert.equal(requests.length, 2);
  // Falha do asset de idioma conserva validação legível e nunca envia senha curta.
  w.DGI18n = undefined;
  nova.value = conf.value = 'abc';
  d.getElementById('tsForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait();
  assert.equal(requests.length, 2);
  assert.match(d.getElementById('erro').textContent, /tem 3 caracteres.*pelo menos 12/);
  dom.window.close();

  // As funções reais da Voz mantêm o mesmo botão/ícone, sem tocar no histórico.
  const voice = new JSDOM(renderizarIdioma(source('conversa.html'), { headers: {} }, 'en'), { url: 'https://fixture.example/', runScripts: 'outside-only' });
  const v = voice.window, vd = v.document;
  for (const f of ['ds/idiomas.js', 'ds/idioma.js']) v.eval(source(f));
  await wait();
  const chat = vd.getElementById('wrap');
  chat.innerHTML = '<p>Senha &lt;img&gt;</p><audio></audio>';
  const audio = chat.querySelector('audio'), paragraph = chat.querySelector('p');
  const src = source('conversa.js');
  const paint = src.slice(src.indexOf('function pintaVoz()'), src.indexOf('\nfunction posicionaMenuVoz()'));
  v.eval("const btnVoz=document.getElementById('btnVoz'); let lerRespostas=true, continua=false; const dgUiLabel_conversa_js=(el,s,a)=>DGI18n.rotulo(el,s,a);" + paint + "\npintaVoz(); window.addEventListener('dgclaw:idioma',pintaVoz);");
  const button = vd.getElementById('btnVoz'), icon = button.querySelector('svg');
  assert.equal(button.title, 'Voice: reading aloud enabled');
  const vs = vd.querySelector('[data-dg-idioma-select]');
  vs.value = 'pt-BR'; vs.dispatchEvent(new v.Event('change'));
  assert.equal(button.title, 'Voz: leitura em voz alta ligada');
  assert.equal(button.querySelector('svg'), icon); assert.equal(chat.querySelector('audio'), audio);
  assert.equal(chat.querySelector('p'), paragraph); assert.equal(paragraph.textContent, 'Senha <img>');
  voice.window.close();
  console.log('PASS: owner password fixture + voice locale switch preserve state and protocol.');
})().catch(e => { console.error(e); process.exitCode = 1; });
