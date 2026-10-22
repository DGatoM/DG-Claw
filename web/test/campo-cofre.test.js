'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cc = require('../public/campo-cofre.js');
const fs = require('node:fs');
const path = require('node:path');

test('analisa: bloco dgcofre válido, com e sem rótulo', () => {
  assert.deepStrictEqual(cc.analisa('dgcofre\nGROQ_API_KEY\n'), { envName: 'GROQ_API_KEY', rotulo: '' });
  assert.deepStrictEqual(cc.analisa('dgcofre\nGROQ_API_KEY\nChave da Groq'), { envName: 'GROQ_API_KEY', rotulo: 'Chave da Groq' });
  assert.deepStrictEqual(cc.analisa('dgcofre\nGROQ\\_API\\_KEY'), { envName: 'GROQ_API_KEY', rotulo: '' });
});

test('analisa: nome inválido ou outra linguagem cai no bloco normal (null)', () => {
  for (const b of ['dgcofre\ngroq_key', 'dgcofre\nA', 'dgcofre\n1ABC', 'dgcofre\nA B', 'dgcofre\n', 'js\nGROQ_API_KEY', 'dgcofre\n<img>']) {
    assert.strictEqual(cc.analisa(b), null, b);
  }
});

test('html: escapa nome e rótulo e usa input de senha', () => {
  const h = cc.html('GROQ_API_KEY', '<b>"x"</b>', 'id1');
  assert.ok(!h.includes('<b>"x"</b>'));
  assert.ok(h.includes('&lt;b&gt;&quot;x&quot;&lt;/b&gt;'));
  assert.ok(h.includes('type="password"') && h.includes('autocomplete="off"') && h.includes('spellcheck="false"'));
  assert.ok(h.includes('Salvar no cofre'));
});

test('blocoParaHtml: devolve null para nome inválido e HTML para válido', () => {
  assert.strictEqual(cc.blocoParaHtml('dgcofre\nminuscula', 'x'), null);
  assert.ok(cc.blocoParaHtml('dgcofre\nGEMINI_API_KEY', 'msg').includes('GEMINI_API_KEY'));
});

test('conversa.js liga o gancho e o html carrega os arquivos novos', () => {
  const pub = path.join(__dirname, '..', 'public');
  assert.match(fs.readFileSync(path.join(pub, 'conversa.js'), 'utf8'), /campoCofre\.blocoParaHtml/);
  const html = fs.readFileSync(path.join(pub, 'conversa.html'), 'utf8');
  assert.ok(html.includes('/campo-cofre.js') && html.includes('/campo-cofre.css'));
});

/* ── caixa de cofre: pedido do iframe, cartão novo, aviso e vazamento ─────────── */

test('validaPedido: nome fora da régua é recusado; rótulo e ajuda viram texto limpo', () => {
  for (const nome of ['path', 'A', '1ABC', 'A B', '', null, 42, '<img>']) {
    const r = cc.validaPedido({ nome });
    assert.equal(r.erro && r.erro.motivo, 'nome', String(nome));
    assert.ok(/inválido/.test(r.erro.msg));
  }
  const ok = cc.validaPedido({ nome: ' HOSTINGER_API_TOKEN ', rotulo: 'Token\u0000 <b>x</b>\n' + 'a'.repeat(200), ajuda: 'hPanel > API' });
  assert.equal(ok.ok.nome, 'HOSTINGER_API_TOKEN');
  assert.equal(ok.ok.rotulo.length, 80);
  assert.ok(!/[\u0000-\u001f]/.test(ok.ok.rotulo));
  assert.ok(ok.ok.rotulo.includes('<b>x</b>'), 'o texto fica como veio; quem desenha usa textContent ou esc()');
  assert.equal(cc.validaPedido({ nome: 'ABC', rotulo: { x: 1 }, ajuda: 5 }).ok.rotulo, '');
});

test('html: rótulo e ajuda com HTML viram texto; campo à prova de gerenciador de senha; garantia fixa', () => {
  cc.configurar({ agente: 'ana', nome: 'Ana' });
  const h = cc.html('GROQ_API_KEY', '<i>r</i>', 'id9', { ajuda: '<script>x</script>', cancelavel: true });
  assert.ok(!h.includes('<script>') && !h.includes('<i>r</i>'));
  for (const a of ['autocomplete="off"', 'autocapitalize="off"', 'autocorrect="off"', 'spellcheck="false"', 'data-1p-ignore', 'data-lpignore="true"']) assert.ok(h.includes(a), a);
  assert.ok(!/<input[^>]*\bname=/.test(h) && !h.includes('<form'));
  assert.match(h, /aria-label="Mostrar a chave"/);
  assert.ok(h.includes('O valor vai direto para o cofre. Não entra na conversa nem chega à Ana. Salvar reinicia a Ana para a chave valer; a conversa continua de onde parou.'));
  assert.ok(h.includes('dgc-cancelar'));
  assert.ok(!cc.html('GROQ_API_KEY', '', 'id9').includes('dgc-cancelar'));
});

/** Cartão de mentira: só o que salvar() toca. */
function cartaoFalso(valor, armado = true) {
  const campos = {
    '.dgc-valor': { value: valor, focus() {} },
    '.dgc-salvar': { disabled: false, textContent: 'Salvar no cofre', removeAttribute() {}, setAttribute() {} },
    '.dgc-msg': { hidden: true, textContent: '' },
  };
  const dataset = { env: 'HOSTINGER_API_TOKEN', id: 'c1' };
  if (armado) Object.assign(dataset, { pronto: '1', gesto: '1', toque: '1' });
  return { dataset, innerHTML: '', isConnected: true, campos,
    querySelector(sel) { return campos[sel] || null; } };
}

test('salvar: grava, pede o aviso ao servidor (avisar:true) e o valor não aparece em lugar nenhum', async () => {
  const SEGREDO = 'tok_SEGREDO_super_secreto_9z8y';
  const saidas = [];
  const originais = {};
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) { originais[k] = console[k]; console[k] = (...a) => saidas.push(a.map(String).join(' ')); }
  const fetchOrig = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url, op) => {
    pedidos.push({ url, op });
    return { status: 200, json: async () => ({ ok: true, envName: 'HOSTINGER_API_TOKEN', ultimos4: '9z8y', aplicado: { ok: true } }) };
  };
  const guardados = [];
  cc.configurar({ agente: 'ana', nome: 'Ana' });
  const card = cartaoFalso('  ' + SEGREDO + '\n');
  card._cb = { aoGuardar: (i) => guardados.push(i), aoErro: () => assert.fail('não devia dar erro') };
  try {
    await cc.salvar(card);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = fetchOrig;
    for (const k of Object.keys(originais)) console[k] = originais[k];
  }
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].url, '/p/ana/api/cofre');
  const corpo = JSON.parse(pedidos[0].op.body);
  assert.equal(corpo.valor, SEGREDO);
  assert.equal(corpo.aplicar, true);
  assert.equal(corpo.avisar, true);
  assert.deepEqual(Object.keys(corpo).sort(), ['aplicar', 'avisar', 'envName', 'valor'], 'o navegador não manda texto de aviso');
  assert.deepEqual(guardados, [{ envName: 'HOSTINGER_API_TOKEN', final: '9z8y' }]);
  assert.equal(card.campos['.dgc-valor'].value, '', 'o campo é limpo depois de gravar');
  assert.ok(card.innerHTML.includes('final 9z8y'));
  for (const texto of [card.innerHTML, ...saidas, JSON.stringify(guardados)]) assert.ok(!texto.includes(SEGREDO), 'o valor vazou: ' + texto.slice(0, 80));
});

test('salvar: erro do servidor mostra a mensagem e mantém o campo', async () => {
  const fetchOrig = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 403, json: async () => ({ error: 'Nome fora da lista.', howToFix: 'Use outro nome.' }) });
  const erros = [];
  cc.configurar({ agente: 'ana', nome: 'Ana' });
  const card = cartaoFalso('valor-qualquer');
  card._cb = { aoErro: (e) => erros.push(e) };
  try { await cc.salvar(card); } finally { globalThis.fetch = fetchOrig; }
  assert.equal(card.campos['.dgc-msg'].textContent, 'Nome fora da lista. Use outro nome.');
  assert.equal(card.campos['.dgc-valor'].value, 'valor-qualquer');
  assert.equal(erros[0].motivo, 'envio');
});

test('conversa.js: etiqueta "do cofre", ouvinte da peça com ev.source e valor fora do iframe', () => {
  const pub = path.join(__dirname, '..', 'public');
  const conv = fs.readFileSync(path.join(pub, 'conversa.js'), 'utf8');
  assert.match(conv, /separaDoCofre/);
  assert.match(conv, /do cofre/);
  assert.match(conv, /d\.tipo === 'cofre'/);
  assert.match(conv, /visuais\.get\(ev\.source\)/);
  const dv = fs.readFileSync(path.join(pub, 'dgvis.js'), 'utf8');
  assert.match(dv, /\.dv-cofre/);
  assert.ok(!/tipo: 'cofre'[^}]*valor/.test(dv), 'o pedido do iframe não leva valor');
  assert.match(fs.readFileSync(path.join(pub, 'dgvis.css'), 'utf8'), /\.dv-cofre\b/);
});

test('GET /api/v1/cofre/docs.md serve o documento do agente com a sessão do dono', async () => {
  const { subirWeb } = require('./ajuda');
  const t = await subirWeb({ agentes: [] });
  try {
    await t.login();
    const r = await t.c.get('/api/v1/cofre/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.texto, /# Caixa de cofre na conversa/);
    assert.match(r.texto, /\[cofre\] HOSTINGER_API_TOKEN guardada \(final 1a2b\)\./);
  } finally { await t.fechar(); }
});

/* ── o visual (código não confiável) nunca recebe o final; pedidos de estado têm freio ───── */
test('estados: só {guardada}, sem final, e 1000 pedidos seguidos geram no máximo 1 fetch', async () => {
  const fetchOrig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => { n++; return { ok: true, status: 200, json: async () => ({ chaves: [{ envName: 'HOSTINGER_API_TOKEN', ultimos4: '9z8y' }] }) }; };
  cc.configurar({ agente: 'ana', nome: 'Ana' });
  try {
    await cc.salvar({ dataset: { enviando: '1' } });   // zera nada; só garante o módulo carregado
    const rs = await Promise.all(Array.from({ length: 1000 }, () => cc.estados(['HOSTINGER_API_TOKEN', 'OUTRA_CHAVE'])));
    assert.ok(n <= 1, 'fetches: ' + n);
    for (const r of rs) {
      assert.deepEqual(r, { HOSTINGER_API_TOKEN: { guardada: true }, OUTRA_CHAVE: { guardada: false } });
      assert.ok(!JSON.stringify(r).includes('9z8y') && !JSON.stringify(r).includes('final'));
    }
  } finally { globalThis.fetch = fetchOrig; }
});

test('freioEstado: 1 resposta a cada 3 s, 20 nomes no máximo, aviso uma vez só', () => {
  const reg = { ultimo: 0, avisou: false };
  assert.deepEqual(cc.freioEstado(reg, 10000, 3), { ok: true, avisar: false });
  assert.deepEqual(cc.freioEstado(reg, 11000, 3), { ok: false, avisar: true });
  assert.deepEqual(cc.freioEstado(reg, 11500, 3), { ok: false, avisar: false });
  assert.deepEqual(cc.freioEstado(reg, 14000, 21), { ok: false, avisar: false });
  assert.deepEqual(cc.freioEstado(reg, 14000, 20), { ok: true, avisar: false });
});

test('conversa.js: nada com final vai ao iframe e o estado só responde com o visual à vista', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.js'), 'utf8');
  const ini = src.indexOf('function tratarCofreEstado');
  const corpo = src.slice(ini, src.indexOf('/* Balão desmontado', ini));
  assert.match(corpo, /document\.visibilityState !== 'visible'/);
  assert.match(corpo, /!est\.cheia && !est\.noViewport/);
  assert.match(corpo, /freioEstado/);
  const ok = src.match(/enviaAoVisual\(alvo, \{ tipo: 'cofre-ok'[^}]*\}/)[0];
  assert.ok(!/final/.test(ok), ok);
  const todos = src.match(/enviaAoVisual\([^;]*cofre-[^;]*;/g) || [];
  for (const l of todos) assert.ok(!/final|ultimos4/.test(l), l);
  const dv = fs.readFileSync(path.join(__dirname, '..', 'public', 'dgvis.js'), 'utf8');
  assert.ok(!/\.final/.test(dv), 'dgvis.js não lê final');
});

/* ── armação por gesto confiável do dono (achado da 3ª rodada do Codex) ─────────── */

/** Documento de mentira: guarda os ouvintes para disparar eventos à mão. */
function docFalso() {
  const ouvintes = {};
  return { readyState: 'complete', body: null, ouvintes,
    addEventListener(tipo, fn) { (ouvintes[tipo] = ouvintes[tipo] || []).push(fn); },
    querySelectorAll() { return []; },
    dispara(tipo, ev) { (ouvintes[tipo] || []).forEach(fn => fn(ev)); } };
}
function cartaoDom(valor) {
  const campo = { value: valor, classList: { contains: c => c === 'dgc-valor' }, closest: s => (s === '.dgcofre' ? card : null) };
  const botao = { disabled: true, textContent: 'Salvar no cofre', attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const card = { dataset: { env: 'HOSTINGER_API_TOKEN', id: '' }, innerHTML: '', isConnected: true,
    querySelector(sel) { return { '.dgc-valor': campo, '.dgc-salvar': botao, '.dgc-msg': { hidden: true, textContent: '' } }[sel] || null; },
    closest: s => (s === '.dgcofre' ? card : null) };
  campo.closest = s => (s === '.dgcofre' ? card : null);
  return { card, campo, botao };
}

test('pedido espontâneo do visual + digitação + Enter NÃO grava; após toque confiável no campo, grava', async () => {
  const fetchOrig = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url, op) => { pedidos.push({ url, op }); return { status: 200, json: async () => ({ ok: true, ultimos4: 'abcd' }) }; };
  cc.configurar({ agente: 'ana', nome: 'Ana' });
  const doc = docFalso();
  cc.ligar(doc);
  const { card, campo, botao } = cartaoDom('texto que o dono digitou no compositor');
  const enter = () => doc.dispara('keydown', { target: campo, key: 'Enter', stopPropagation() {}, preventDefault() {} });
  try {
    // 400 ms passaram, mas ninguém tocou no cartão: o botão segue desligado, com a dica.
    card.dataset.pronto = '1';
    enter();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(pedidos.length, 0, 'Enter sem gesto do dono não pode gravar');
    // evento sintético (isTrusted falso), como um script dispararia: também não arma.
    doc.dispara('pointerdown', { target: campo, isTrusted: false });
    enter();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(pedidos.length, 0, 'gesto não confiável não arma');
    assert.equal(botao.disabled, true);
    assert.equal(botao.attrs.title, 'Toque no campo e cole a chave');
    // toque confiável no campo: arma e libera.
    doc.dispara('pointerdown', { target: campo, isTrusted: true });
    assert.equal(botao.disabled, false);
    enter();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(pedidos.length, 1, 'após o toque confiável o Enter grava');
  } finally { globalThis.fetch = fetchOrig; }
});

test('toque confiável só no cartão (não no campo) libera o botão mas não autoriza gravar', async () => {
  const fetchOrig = globalThis.fetch;
  let chamadas = 0;
  globalThis.fetch = async () => { chamadas++; return { status: 200, json: async () => ({}) }; };
  cc.configurar({ agente: 'ana', nome: 'Ana' });
  const { card } = cartaoDom('valor');
  card.dataset.pronto = '1';
  try {
    assert.equal(cc.registraGesto(card, { isTrusted: true, target: { classList: { contains: () => false } } }), true);
    assert.equal(card.dataset.toque, undefined);
    await cc.salvar(card);
    assert.equal(chamadas, 0, 'sem toque no campo o valor não pode ser gravado');
  } finally { globalThis.fetch = fetchOrig; }
});

test('conversa.js não dá focus() no cartão aberto por pedido do iframe e campo-cofre.js não foca em montar()', () => {
  const pub = path.join(__dirname, '..', 'public');
  const conv = fs.readFileSync(path.join(pub, 'conversa.js'), 'utf8');
  const ini = conv.indexOf('function tratarCofre(');
  const trecho = conv.slice(ini, conv.indexOf('function tratarCofreEstado', ini));
  assert.ok(!/\.focus\(/.test(trecho), 'tratarCofre não pode focar nada');
  assert.ok(!/scrollIntoView\(/.test(trecho));
  const cofre = fs.readFileSync(path.join(pub, 'campo-cofre.js'), 'utf8');
  const m = cofre.slice(cofre.indexOf('function montar('), cofre.indexOf('function limpaCampo'));
  assert.ok(!/\.focus\(/.test(m), 'montar() não pode focar o campo');
});
