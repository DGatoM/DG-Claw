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

test('textoAviso: formato fixo com o final, sem valor', () => {
  assert.equal(cc.textoAviso('HOSTINGER_API_TOKEN', '1a2b', false), '[cofre] HOSTINGER_API_TOKEN guardada (final 1a2b).');
  assert.equal(cc.textoAviso('X_KEY', '', false), '[cofre] X_KEY guardada.');
  assert.match(cc.textoAviso('X_KEY', '1a2b', true), /^\[cofre\] X_KEY guardada \(final 1a2b\)\. O agente ainda não reiniciou/);
});

/** Cartão de mentira: só o que salvar() toca. */
function cartaoFalso(valor) {
  const campos = {
    '.dgc-valor': { value: valor, focus() {} },
    '.dgc-salvar': { disabled: false, textContent: 'Salvar no cofre' },
    '.dgc-msg': { hidden: true, textContent: '' },
  };
  return { dataset: { env: 'HOSTINGER_API_TOKEN', id: 'c1' }, innerHTML: '', isConnected: true, campos,
    querySelector(sel) { return campos[sel] || null; } };
}

test('salvar: grava, avisa o agente no formato novo com o final do servidor e o valor não aparece em lugar nenhum', async () => {
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
  const enviados = [];
  const guardados = [];
  cc.configurar({ agente: 'ana', nome: 'Ana', esperaMs: 0, enviar: async (t) => { enviados.push(t); } });
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
  assert.deepEqual(enviados, ['[cofre] HOSTINGER_API_TOKEN guardada (final 9z8y).']);
  assert.deepEqual(guardados, [{ envName: 'HOSTINGER_API_TOKEN', final: '9z8y' }]);
  assert.equal(card.campos['.dgc-valor'].value, '', 'o campo é limpo depois de gravar');
  assert.ok(card.innerHTML.includes('final 9z8y'));
  for (const texto of [...enviados, card.innerHTML, ...saidas, JSON.stringify(guardados)]) assert.ok(!texto.includes(SEGREDO), 'o valor vazou: ' + texto.slice(0, 80));
});

test('salvar: erro do servidor mostra a mensagem, mantém o campo e não avisa o agente', async () => {
  const fetchOrig = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 403, json: async () => ({ error: 'Nome fora da lista.', howToFix: 'Use outro nome.' }) });
  const enviados = [], erros = [];
  cc.configurar({ agente: 'ana', nome: 'Ana', esperaMs: 0, enviar: async (t) => { enviados.push(t); } });
  const card = cartaoFalso('valor-qualquer');
  card._cb = { aoErro: (e) => erros.push(e) };
  try { await cc.salvar(card); } finally { globalThis.fetch = fetchOrig; }
  assert.equal(card.campos['.dgc-msg'].textContent, 'Nome fora da lista. Use outro nome.');
  assert.equal(card.campos['.dgc-valor'].value, 'valor-qualquer');
  assert.equal(erros[0].motivo, 'envio');
  assert.deepEqual(enviados, []);
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
