'use strict';
// A tela dos cartões e do Reset do modo demonstração: escape de dados, celular e regras do contrato.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLICO = path.join(__dirname, '..', 'public');
const js = fs.readFileSync(path.join(PUBLICO, 'demo-cartoes.js'), 'utf8');
const css = fs.readFileSync(path.join(PUBLICO, 'demo-cartoes.css'), 'utf8');

test('demo-cartoes.js é JavaScript válido', () => {
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'demo-cartoes.js' }));
});

test('nada que vem de dado entra como HTML: só textContent', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), 'dado do provedor ou do agente não pode virar HTML');
  assert.match(js, /textContent = txt/);
});

test('a tela consulta a cada 2 segundos, pede a frase NOVO CLIENTE e recarrega a página ao concluir', () => {
  assert.match(js, /INTERVALO = 2000/);
  assert.match(js, /FRASE = 'NOVO CLIENTE'/);
  assert.match(js, /\/api\/demo\/cartoes/);
  assert.match(js, /\/api\/demo\/reset\/estado/);
  assert.match(js, /location\.reload\(\)/);
  assert.match(js, /credentials: 'same-origin'/);
});

test('o cartão mostra canal, linha, destinatário, número completo, texto, anexos e os dois botões', () => {
  for (const rotulo of ["'Canal'", "'Linha'", "'Para'", "'Número'", "'Texto'", "'Confirmar'", "'Recusar'", "'Anexos ("]) assert.ok(js.includes(rotulo), `falta ${rotulo}`);
});

test('CSS: celular sem rolagem lateral, alvos de toque de 32px ou mais e campo com 16px ou mais', () => {
  assert.match(css, /\.dc-cartao\{[^}]*overflow-x:hidden/);
  assert.match(css, /\.dc-fundo\{[^}]*overflow-x:hidden/);
  assert.match(css, /overflow-wrap:anywhere/);
  for (const m of css.matchAll(/min-height:(\d+)px/g)) assert.ok(Number(m[1]) >= 32, `alvo de toque pequeno: ${m[0]}`);
  const campo = /\.dc-campo\{[^}]*font-size:(\d+)px/.exec(css);
  assert.ok(campo && Number(campo[1]) >= 16);
  const celular = /@media \(max-width:560px\)\{[\s\S]*\}/.exec(css)[0];
  assert.match(celular, /\.dc-campo\{font-size:1[6-9]px/);
  assert.ok(!/<[A-Za-z/]/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'folha de estilo sem tag HTML');
});

// ── a escolha do candidato sobrevive às consultas de 2 em 2 segundos ─────────
function domFalso() {
  function No(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.className = ''; this.textContent = '';
    this.dataset = {}; this.attrs = {}; this.ouvintes = {}; this.disabled = false; this.checked = false; this.foco = 0;
  }
  No.prototype.appendChild = function (f) { f.parentNode = this; this.children.push(f); return f; };
  No.prototype.removeChild = function (f) { this.children = this.children.filter((x) => x !== f); f.parentNode = null; return f; };
  No.prototype.insertBefore = function (f) { return this.appendChild(f); };
  No.prototype.setAttribute = function (k, v) { this.attrs[k] = v; };
  No.prototype.addEventListener = function (ev, fn) { (this.ouvintes[ev] = this.ouvintes[ev] || []).push(fn); };
  No.prototype.focus = function () { this.foco++; };
  No.prototype.dispara = function (ev) { (this.ouvintes[ev] || []).forEach((fn) => fn({})); };
  No.prototype.todos = function () { return this.children.reduce((a, f) => a.concat(f, f.todos()), []); };
  No.prototype.querySelector = function (sel) { return this.todos().find((n) => n.tagName === sel.toUpperCase()) || null; };
  const body = new No('body');
  const document = { body, hidden: false, readyState: 'complete', createElement: (t) => new No(t), getElementById: () => null, addEventListener() {} };
  return { document, body };
}

async function montaTela(respostas) {
  const { document, body } = domFalso();
  let intervalo = null;
  let n = 0;
  const fetchFalso = async (url) => {
    const corpo = respostas[Math.min(n++, respostas.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(corpo) };
  };
  const ctx = vm.createContext({ document, fetch: fetchFalso, setInterval: (fn) => { intervalo = fn; return 1; }, clearInterval() {}, setTimeout: () => 1, location: { reload() {} }, console });
  new vm.Script(js, { filename: 'demo-cartoes.js' }).runInContext(ctx);
  const espera = () => new Promise((ok) => setImmediate(ok));
  await espera();
  return { body, consulta: async () => { intervalo(); await espera(); await espera(); } };
}

test('duas consultas seguidas com o mesmo cartão de leitura preservam a escolha, o cartão e o foco', async () => {
  const cartao = { id: 'c1', tipo: 'leitura', canal: 'whatsapp', linha: 'danilo', linha_rotulo: 'Danilo', nome_pedido: 'maria', erro_busca: null, segundos_restantes: 500,
    candidatos: [{ ref: 'a', nome: 'Maria A', telefone_mascarado: '+55 ••••• 0001' }, { ref: 'b', nome: 'Maria B', telefone_mascarado: '+55 ••••• 0002' }] };
  const resp = () => ({ ok: true, resetando: false, cartoes: [Object.assign({}, cartao, { segundos_restantes: cartao.segundos_restantes-- })], recentes: [] });
  const { body, consulta } = await montaTela([resp(), resp(), resp()]);
  const fundo = body.children.find((x) => x.className === 'dc-fundo');
  assert.ok(fundo, 'o cartão apareceu');
  const radios = fundo.todos().filter((x) => x.tagName === 'INPUT');
  const confirmar = fundo.todos().find((x) => x.textContent === 'Confirmar');
  assert.equal(confirmar.disabled, true);
  radios[1].checked = true; radios[1].dispara('change');
  assert.equal(confirmar.disabled, false);
  await consulta();
  await consulta();
  const depois = body.children.find((x) => x.className === 'dc-fundo');
  assert.equal(depois, fundo, 'o conteúdo não mudou: o cartão não pode ser refeito');
  assert.equal(body.children.filter((x) => x.className === 'dc-fundo').length, 1);
  assert.equal(radios[1].checked, true);
  assert.equal(confirmar.disabled, false);
});

test('se o cartão é refeito (candidatos mudaram), a escolha que ainda existe continua marcada e com foco', async () => {
  const base = { id: 'c1', tipo: 'leitura', canal: 'whatsapp', linha: 'danilo', linha_rotulo: 'Danilo', nome_pedido: 'maria', erro_busca: null, segundos_restantes: 500 };
  const A = { ref: 'a', nome: 'Maria A', telefone_mascarado: '1' }; const B = { ref: 'b', nome: 'Maria B', telefone_mascarado: '2' };
  const r1 = { ok: true, cartoes: [Object.assign({ candidatos: [A, B] }, base)], recentes: [] };
  const r2 = { ok: true, cartoes: [Object.assign({ candidatos: [B, A, { ref: 'c', nome: 'Maria C', telefone_mascarado: '3' }] }, base)], recentes: [] };
  const { body, consulta } = await montaTela([r1, r2]);
  const fundo1 = body.children.find((x) => x.className === 'dc-fundo');
  const rb = fundo1.todos().filter((x) => x.tagName === 'INPUT')[1];
  rb.checked = true; rb.dispara('change');
  await consulta();
  const fundo2 = body.children.find((x) => x.className === 'dc-fundo');
  assert.notEqual(fundo2, fundo1);
  const radios = fundo2.todos().filter((x) => x.tagName === 'INPUT');
  const marcado = radios.find((x) => x.checked);
  assert.ok(marcado && marcado.value === 'b', 'a escolha "b" foi preservada');
  assert.ok(marcado.foco > 0, 'o foco volta ao candidato escolhido');
  assert.equal(fundo2.todos().find((x) => x.textContent === 'Confirmar').disabled, false);
});
