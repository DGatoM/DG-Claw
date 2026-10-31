'use strict';
// A janela vermelha com um DOM simulado: o clique completo em "Pedir ao Admin" tem que chegar ao atalho do Admin
// com o texto do achado (antes, fecha() zerava o achado e a montagem do texto quebrava).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

function elemento() {
  const el = {
    dataset: {}, hidden: false, disabled: false, textContent: '', innerHTML: '', removido: false, ouvintes: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, focus() {}, appendChild() {},
    addEventListener(tipo, fn) { el.ouvintes[tipo] = fn; },
    remove() { el.removido = true; },
    querySelector() { return elemento(); },
    querySelectorAll() { return []; },
  };
  return el;
}

function montaPagina(instalar) {
  const corpo = elemento();
  corpo.filhos = [];
  corpo.appendChild = (el) => corpo.filhos.push(el);
  const documento = {
    readyState: 'complete', head: elemento(), body: corpo,
    createElement: () => elemento(),
    querySelector: () => null, getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  const achado = {
    id: 'UBUNTU-CVE-2026-77001', aliases: [], nivel: 2, severidade: 'HIGH', nome_simples: 'Falha no OpenSSL', componente: 'openssl',
    publicado_em: '2026-10-15T12:00:00Z', fonte_url: 'https://ubuntu.com/security/CVE-2026-77001', noticia_url: null, onde: ['sistema'],
    o_que_faz: 'Trava o serviço.', como_corrigir: 'Atualizar o pacote.', estado: 'aberto', aplicado: null,
    correcao: { tipo: 'atualizar-pacote', disponivel: true, executavel: false },
  };
  const resposta = (json) => ({ ok: true, status: 200, json: async () => json });
  const ctx = {
    document: documento,
    localStorage: { getItem: () => null, setItem() {} },
    location: { pathname: '/', href: '/' },
    fetch: async (url) => resposta(url.endsWith('/emergencia') ? { estado: { cortado: false } } : { niveis: { 2: [achado] } }),
    setInterval() {}, console,
    DGAtualizacaoFaixa: { instalar },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(pub('ronda-comum.js'), ctx);
  vm.runInContext(pub('ronda-aviso.js'), ctx);
  return { ctx, corpo, documento };
}

async function esperaJanela(corpo) {
  for (let i = 0; i < 50 && !corpo.filhos.length; i++) await new Promise((r) => setImmediate(r));
  assert.equal(corpo.filhos.length, 1, 'a janela vermelha abriu');
  return corpo.filhos[0];
}

const clique = (fundo, acao) => fundo.ouvintes.click({ target: { closest: () => ({ dataset: { ra: acao }, disabled: false }) } });

test('"Pedir ao Admin" na janela vermelha fecha a janela e entrega o texto do achado ao atalho do Admin', async () => {
  const chamadas = [];
  const { corpo } = montaPagina((texto) => chamadas.push(texto));
  const fundo = await esperaJanela(corpo);
  assert.match(fundo.innerHTML, /Pedir ao Admin/);
  clique(fundo, 'pedir-admin');
  assert.equal(fundo.removido, true, 'a janela fechou');
  assert.equal(chamadas.length, 1, 'o atalho do Admin foi chamado uma vez');
  assert.match(chamadas[0], /UBUNTU-CVE-2026-77001/);
  assert.match(chamadas[0], /pacote openssl/);
});

test('"Lembrar depois" também usa o achado antes de fechar a janela', async () => {
  const gravou = [];
  const { corpo, ctx } = montaPagina(() => {});
  ctx.localStorage.setItem = (k, v) => gravou.push(k + '=' + v);
  const fundo = await esperaJanela(corpo);
  clique(fundo, 'lembrar');
  assert.equal(fundo.removido, true);
  assert.ok(gravou.some((x) => x.includes('UBUNTU-CVE-2026-77001')), 'o adiamento ficou gravado para o id do achado: ' + gravou.join(' | '));
});
