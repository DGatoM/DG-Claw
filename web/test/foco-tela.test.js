'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/foco-tela');

const pub = n => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

/* DOM falso mínimo: só o que o foco-tela.js usa. */
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentNode = null; this.className = '';
    this.style = { setProperty(k, v) { this[k] = v; } }; this.hidden = false; this.textContent = ''; this.attrs = {}; this.ouvintes = {};
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(n, fn) { (this.ouvintes[n] = this.ouvintes[n] || []).push(fn); }
  clica() { for (const fn of this.ouvintes.click || []) fn(); }
  acha(pred, acc = []) { if (pred(this)) acc.push(this); this.children.forEach(c => c.acha(pred, acc)); return acc; }
  getBoundingClientRect() { return this.rect || { left: 0, right: 0 }; }
}
const tem = (e, cls) => e.className.split(' ').includes(cls);
const porClasse = (e, cls) => e.acha(x => tem(x, cls));

function monta({ wrapEsq = 0, menuDir = 0, resposta, armazenado = {} } = {}) {
  const body = new El('body'), html = new El('html');
  const wrap = new El('div'); wrap.rect = { left: wrapEsq, right: wrapEsq + 880 };
  const menu = new El('aside'); menu.rect = { left: 0, right: menuDir };
  const doc = { body, documentElement: html, createElement: t => new El(t), getElementById: id => ({ wrap, menu }[id] || null) };
  const chamadas = [];
  const fetch = async (url, init = {}) => {
    chamadas.push({ url, metodo: init.method || 'GET', corpo: init.body ? JSON.parse(init.body) : null, cred: init.credentials });
    const r = resposta ? await resposta(url, init) : { status: 200, corpo: { ok: true } };
    return { ok: r.status < 400, status: r.status, json: async () => r.corpo };
  };
  const guardado = Object.assign({}, armazenado);
  const storage = { getItem: k => (k in guardado ? guardado[k] : null), setItem: (k, v) => { guardado[k] = v; } };
  const ouvintesJanela = {};
  const win = { addEventListener: (n, fn) => { ouvintesJanela[n] = fn; }, DGTour: { inicia: o => { win.tourPassos = o.passos; } } };
  const f = F.criar({ doc, win, fetch, storage, agente: 'ana' });
  return { f, body, html, doc, chamadas, guardado, win, ouvintesJanela, wrap, menu };
}
const lista = (itens, versao = 1, titulo = 'Foco de hoje') => ({ agente: 'ana', titulo, versao,
  itens: itens.map(([id, texto, feito], i) => ({ id, texto, feito: !!feito, ordem: i + 1 })) });
const tres = () => lista([[1, 'A', true], [2, 'B', false], [3, 'C', false]]);

test('modoLayout: painel só quando sobra pelo menos 252 px à esquerda da coluna', () => {
  assert.equal(F.modoLayout(120, 0).tipo, 'faixa');            // celular/janela estreita
  assert.equal(F.modoLayout(400, 240).tipo, 'faixa');          // 160 px livres depois do menu
  const p = F.modoLayout(560, 240);                            // 320 livres
  assert.equal(p.tipo, 'painel'); assert.equal(p.largura, 300); assert.equal(p.esq, 252);
  assert.equal(F.modoLayout(500, 240).largura, 248);           // 260 livres: cabe, menor que 300
});

test('contador: conta pelos itens, sem confiar em totais prontos', () => {
  assert.deepEqual(F.contador(lista([[1, 'A', true], [2, 'B', false], [3, 'C', true], [4, 'D', false]])), { feitos: 2, total: 4, pct: 50 });
  assert.deepEqual(F.contador(null), { feitos: 0, total: 0, pct: 0 });
});

test('lista vazia ou null: nada aparece', () => {
  const t = monta();
  t.f.recebe({ agente: 'ana', lista: lista([]) });
  assert.equal(t.f._raiz.hidden, true);
  t.f.recebe({ agente: 'ana', lista: null, erro: undefined });
  assert.equal(t.f._raiz.hidden, false, 'lista null sem motivo ainda explica o que houve');
});

test('lista null com erro: mostra o motivo e avisa no console', () => {
  const t = monta();
  const avisos = []; const antes = console.warn; console.warn = (...a) => avisos.push(a.join(' '));
  try { t.f.recebe({ agente: 'ana', lista: null, erro: 'arquivo corrompido em /x/ana.json' }); } finally { console.warn = antes; }
  assert.equal(t.f._raiz.hidden, false);
  assert.match(porClasse(t.f._raiz, 'foco-aviso')[0].textContent, /arquivo corrompido em \/x\/ana\.json/);
  assert.equal(avisos.length, 1);
});

test('contador, progresso, ordem por "ordem" e item feito marcado', () => {
  const t = monta();
  const l = tres(); l.itens[0].ordem = 3; l.itens[2].ordem = 1;   // C, B, A
  t.f.recebe({ agente: 'ana', lista: l });
  const r = t.f._raiz;
  assert.equal(r.hidden, false);
  assert.equal(porClasse(r, 'foco-placar')[0].textContent, '1 de 3');
  assert.equal(porClasse(r, 'foco-enche')[0].style.width, '33%');
  assert.deepEqual(porClasse(r, 'foco-texto').map(e => e.textContent), ['C', 'B', 'A']);
  const feitos = porClasse(r, 'foco-item').filter(e => tem(e, 'feito'));
  assert.equal(feitos.length, 1);
  assert.equal(porClasse(feitos[0], 'foco-caixa')[0].textContent, '✓');
});

test('sem espaço: faixa recolhida; tocar abre e guarda no aparelho', () => {
  const t = monta({ wrapEsq: 8 });
  t.f.recebe({ agente: 'ana', lista: tres() });
  const r = t.f._raiz;
  assert.ok(tem(r, 'foco-faixa')); assert.ok(!tem(r, 'aberto'));
  assert.ok(!('--foco-h' in t.html.style), 'a faixa é item do fluxo: nada de variável para empurrar o chat');
  porClasse(r, 'foco-abre')[0].clica();
  assert.ok(tem(r, 'aberto')); assert.equal(t.guardado['dgclaw:foco:aberto:ana'], '1');
  porClasse(r, 'foco-abre')[0].clica();
  assert.ok(!tem(r, 'aberto')); assert.equal(t.guardado['dgclaw:foco:aberto:ana'], '0');
});

test('com espaço: painel aberto, posicionado ao lado da coluna; escolha guardada vale', () => {
  const t = monta({ wrapEsq: 600, menuDir: 240 });
  t.f.recebe({ agente: 'ana', lista: tres() });
  let r = t.f._raiz;
  assert.ok(tem(r, 'foco-painel')); assert.ok(tem(r, 'aberto'));
  assert.equal(r.style.width, '300px'); assert.equal(r.style.left, '292px');
  const t2 = monta({ wrapEsq: 600, menuDir: 240, armazenado: { 'dgclaw:foco:aberto:ana': '0' } });
  t2.f.recebe({ agente: 'ana', lista: tres() });
  assert.ok(!tem(t2.f._raiz, 'aberto'));
});

test('resize reposiciona: painel vira faixa quando a coluna encosta', () => {
  const t = monta({ wrapEsq: 600, menuDir: 240 });
  t.f.recebe({ agente: 'ana', lista: tres() });
  assert.ok(tem(t.f._raiz, 'foco-painel'));
  t.wrap.rect = { left: 10, right: 890 }; t.menu.rect = { left: -310, right: 0 };
  t.ouvintesJanela.resize();
  assert.ok(tem(t.f._raiz, 'foco-faixa'));
});

test('tique otimista: marca na hora, manda PATCH com {feito} e aceita a lista devolvida', async () => {
  let solta;
  const t = monta({ wrapEsq: 600, menuDir: 240, resposta: () => new Promise(res => { solta = () => res({ status: 200, corpo: { ok: true, lista: lista([[1, 'A', true], [2, 'B', true], [3, 'C', false]], 2) } }); }) });
  t.f.recebe({ agente: 'ana', lista: tres() });
  const p = t.f._tica(2);
  assert.equal(porClasse(t.f._raiz, 'foco-placar')[0].textContent, '2 de 3', 'já mudou antes da resposta');
  await new Promise(r => setImmediate(r));
  solta(); await p;
  assert.deepEqual(t.chamadas[0], { url: '/api/v1/foco/ana/itens/2', metodo: 'PATCH', corpo: { feito: true }, cred: 'same-origin' });
  assert.equal(t.f._est.lista.versao, 2);
});

test('tique que falha: volta o estado e mostra o motivo do servidor', async () => {
  const t = monta({ resposta: () => ({ status: 404, corpo: { ok: false, erro: 'Item 2 não existe nesta lista.' } }) });
  const antes = console.warn; console.warn = () => {};
  t.f.recebe({ agente: 'ana', lista: tres() });
  try { await t.f._tica(2); } finally { console.warn = antes; }
  assert.equal(porClasse(t.f._raiz, 'foco-placar')[0].textContent, '1 de 3');
  const aviso = porClasse(t.f._raiz, 'foco-aviso')[0];
  assert.equal(aviso.hidden, false);
  assert.match(aviso.textContent, /Item 2 não existe nesta lista\./);
  assert.match(aviso.textContent, /Tente de novo/);
});

test('ignora lista com versão menor que a mostrada', () => {
  const t = monta();
  t.f.recebe({ agente: 'ana', lista: lista([[1, 'Nova', false]], 5) });
  t.f.recebe({ agente: 'ana', lista: lista([[1, 'Velha', false], [2, 'Outra', false]], 4) });
  assert.deepEqual(porClasse(t.f._raiz, 'foco-texto').map(e => e.textContent), ['Nova']);
  t.f.recebe({ agente: 'ana', lista: lista([[1, 'Mais nova', false]], 6) });
  assert.deepEqual(porClasse(t.f._raiz, 'foco-texto').map(e => e.textContent), ['Mais nova']);
});

test('ignora evento de outro agente', () => {
  const t = monta();
  t.f.recebe({ agente: 'bruno', lista: tres() });
  assert.equal(t.f._raiz.hidden, true);
});

test('carga inicial: GET na rota do agente; falha vira aviso com causa', async () => {
  const ok = monta({ resposta: () => ({ status: 200, corpo: { ok: true, lista: tres() } }) });
  await ok.f.carrega();
  assert.equal(ok.chamadas[0].url, '/api/v1/foco/ana');
  assert.equal(porClasse(ok.f._raiz, 'foco-placar')[0].textContent, '1 de 3');
  const ruim = monta({ resposta: () => ({ status: 503, corpo: { ok: false, erro: 'não consegui ler /d/foco/ana.json' } }) });
  const antes = console.warn; console.warn = () => {};
  try { await ruim.f.carrega(); } finally { console.warn = antes; }
  assert.match(porClasse(ruim.f._raiz, 'foco-aviso')[0].textContent, /não consegui ler \/d\/foco\/ana\.json/);
});

test('evento dgclaw:foco da janela é ouvido', () => {
  const t = monta();
  t.ouvintesJanela['dgclaw:foco']({ detail: { agente: 'ana', lista: tres() } });
  assert.equal(t.f._raiz.hidden, false);
});

test('passoTutorial: campos completos e funciona com lista vazia (exemplo temporário)', () => {
  const t = monta({ wrapEsq: 8 });
  const p = t.f.passoTutorial();
  assert.equal(p.alvo, '[data-tour="foco"]');
  for (const k of ['titulo', 'oque', 'como', 'porque']) assert.ok(p[k] && p[k].length > 5, k);
  assert.equal(t.f._raiz.hidden, true);
  p.antes();
  assert.equal(t.f._raiz.hidden, false, 'o exemplo aparece durante a visita');
  assert.equal(porClasse(t.f._raiz, 'foco-placar')[0].textContent, '1 de 3');
  p.depois();
  assert.equal(t.f._raiz.hidden, true);
  // botão ? chama o tour com o passo
  t.f.recebe({ agente: 'ana', lista: tres() });
  porClasse(t.f._raiz, 'foco-ajuda')[0].clica();
  assert.equal(t.win.tourPassos.length, 1);
  assert.equal(t.win.tourPassos[0].alvo, '[data-tour="foco"]');
});

test('conversa.html, conversa.js e sw.js ligam o modo foco; sem travessão nos arquivos', () => {
  const h = pub('conversa.html');
  assert.match(h, /<link rel="stylesheet" href="\/foco-tela\.css">/);
  assert.ok(h.indexOf('/foco-tela.js') > 0 && h.indexOf('/foco-tela.js') < h.indexOf('/conversa.js'));
  const c = pub('conversa.js');
  assert.match(c, /ouve\('foco', d => window\.DGFoco && window\.DGFoco\.recebe\(d\), false\)/);
  assert.match(c, /window\.DGFoco\.passoTutorial\(\)/);
  assert.match(pub('sw.js'), /'\/foco-tela\.js', '\/foco-tela\.css'/);
  for (const n of ['foco-tela.js', 'foco-tela.css', '../test/foco-tela.test.js']) assert.doesNotMatch(pub(n), /[\u2014\u2013]/, n);
});

test('foco-tela.css não posiciona o #chat com top (a faixa é item do fluxo flex)', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/foco-tela.css'), 'utf8');
  assert.ok(!/#chat\s*\{/.test(css), '#chat não pode ser mexido pelo foco');
  assert.ok(/\.foco-faixa\{position:relative;/.test(css));
});

test('conversa.html tem os botões Painel, Mesa e Lembretes antes do ler', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/conversa.html'), 'utf8');
  const i = ['btnPainel', 'btnMesa', 'btnLembretes', 'btnLer'].map(id => html.indexOf('id="' + id + '"'));
  assert.ok(i.every(n => n > 0) && i.every((n, k) => k === 0 || n > i[k - 1]));
});
