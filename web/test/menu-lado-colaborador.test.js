'use strict';
// Roda a inicialização real do menu (DGMenuLado.inicia) num DOM mínimo que imita o navegador onde importa:
// inserir HTML ao lado de um elemento sem pai lança NoModificationAllowedError, como no Chrome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codigo = fs.readFileSync(path.join(__dirname, '..', 'public', 'menu-lado.js'), 'utf8');

/** Elemento "solto": aceita qualquer chamada sem fazer nada. Serve para as partes do menu que este teste não olha. */
function solto() {
  const alvo = { style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
  return new Proxy(alvo, {
    get(t, p) { if (p in t) return t[p]; if (p === 'then') return undefined; return () => solto(); },
    set(t, p, v) { t[p] = v; return true; },
  });
}

class Elemento {
  constructor(id) { this.id = id; this.filhos = []; this.pai = null; this.html = ''; }
  get parentElement() { return this.pai; }
  addEventListener() {}
  querySelector() { return solto(); }
  querySelectorAll() { return []; }
  remove() { if (this.pai) { this.pai.filhos = this.pai.filhos.filter((x) => x !== this); this.pai = null; } }
  insertAdjacentHTML(pos, html) {
    if ((pos === 'afterend' || pos === 'beforebegin') && !this.pai) {
      const e = new Error('Failed to execute \'insertAdjacentHTML\' on \'Element\': The element has no parent.');
      e.name = 'NoModificationAllowedError';
      throw e;
    }
    const novo = new Elemento(null); novo.html = html;
    if (pos === 'beforeend') { novo.pai = this; this.filhos.push(novo); return; }
    const irmaos = this.pai.filhos; const i = irmaos.indexOf(this);
    novo.pai = this.pai; irmaos.splice(pos === 'afterend' ? i + 1 : i, 0, novo);
  }
  todoHtml() { return this.html + this.filhos.map((f) => f.todoHtml()).join(''); }
}

function montar({ colaborador }) {
  const mlTabs = new Elemento('mlTabs');
  const envoltoMesa = new Elemento(null); envoltoMesa.html = '<a href="/mesa">Mesa</a>';
  const ancoraMesa = new Elemento(null);
  ancoraMesa.pai = envoltoMesa; ancoraMesa.attrs = { href: '/mesa' };
  ancoraMesa.setAttribute = function (k, v) { this.attrs[k] = v; };
  envoltoMesa.pai = mlTabs; mlTabs.filhos.push(envoltoMesa);
  const outros = new Map();
  const document = {
    getElementById(id) { if (id === 'mlTabs') return mlTabs; if (id === 'mlSessoes') { const e = mlTabs.filhos.find((f) => f.html.includes('id="mlSessoes"')); return e ? { parentElement: e } : null; } if (!outros.has(id)) outros.set(id, solto()); return outros.get(id); },
    querySelector(seletor) { if (seletor === '#mlTabs a[href="/mesa"]') return envoltoMesa.pai ? ancoraMesa : (ancoraMesa.pai ? ancoraMesa : null); return solto(); },
    querySelectorAll() { return []; },
    createElement() { return solto(); },
    addEventListener() {},
    documentElement: solto(),
    visibilityState: 'hidden',
  };
  const janela = {
    document, DGPapel: { colaborador },
    window: null, navigator: { userAgent: 'teste', maxTouchPoints: 0 },
    // a rede do teste não responde: o menu precisa seguir mesmo assim, sem estourar
    fetch: () => Promise.reject(new Error('sem rede no teste')),
    console: { warn() {}, log() {}, error() {} }, setInterval() { return 0; }, setTimeout() { return 0; }, clearInterval() {},
    addEventListener() {}, matchMedia: () => ({ matches: false }),
  };
  janela.window = janela;
  vm.createContext(janela);
  vm.runInContext(codigo, janela, { filename: 'menu-lado.js' });
  return { janela, mlTabs, ancoraMesa, envoltoMesa };
}

const AGENTE = { id: 'ana', nome: 'Ana', tipo: 'agente', tem_painel: true, painel_url: '/p/ana/', provedor: 'claude', modelo: 'sonnet' };

test('menu do colaborador: a inicialização completa não estoura, Sessões entra e a Mesa sai', () => {
  const { janela, mlTabs, envoltoMesa } = montar({ colaborador: true });
  assert.ok(janela.DGMenuLado && janela.DGMenuLado.inicia, 'o menu carregou com DOM');
  janela.DGMenuLado.inicia({ agente: AGENTE, agentes: [AGENTE], fecha() {}, extras: [] });
  const html = mlTabs.todoHtml();
  assert.match(html, /id="mlSessoes"/, 'o item Sessões foi inserido');
  assert.match(html, /href="\/p\/ana\/#aba=sessoes"/);
  assert.match(html, /Conectar conta/);
  assert.doesNotMatch(html, /Convidar colaborador|Lembretes|Avisos|Segurança/);
  assert.equal(envoltoMesa.pai, null, 'a Mesa foi retirada do menu do colaborador');
});

test('menu do dono: a Mesa fica, leva o agente, e Sessões entra logo depois', () => {
  const { janela, mlTabs, ancoraMesa, envoltoMesa } = montar({ colaborador: false });
  janela.DGMenuLado.inicia({ agente: AGENTE, agentes: [AGENTE], fecha() {}, extras: [] });
  assert.equal(ancoraMesa.attrs.href, '/mesa?a=ana');
  const i = mlTabs.filhos.indexOf(envoltoMesa);
  assert.match(mlTabs.filhos[i + 1].html, /id="mlSessoes"/);
});

test('Navegador: o dono vê o item, que abre em outra aba; o colaborador não vê', () => {
  const dono = montar({ colaborador: false });
  dono.janela.DGMenuLado.inicia({ agente: AGENTE, agentes: [AGENTE], fecha() {}, extras: [] });
  const htmlDono = dono.mlTabs.todoHtml();
  assert.match(htmlDono, /id="mlTela" href="\/p\/ana\/#aba=tela" target="_blank" rel="noopener"/);
  assert.match(htmlDono, /Navegador/);
  const colab = montar({ colaborador: true });
  colab.janela.DGMenuLado.inicia({ agente: AGENTE, agentes: [AGENTE], fecha() {}, extras: [] });
  const htmlColab = colab.mlTabs.todoHtml();
  assert.doesNotMatch(htmlColab, /mlTela|Navegador|aba=tela/);
});

test('o DOM de teste de fato lança NoModificationAllowedError ao inserir ao lado de elemento sem pai', () => {
  const solta = new Elemento(null);
  assert.throws(() => solta.insertAdjacentHTML('afterend', '<i></i>'), (e) => e.name === 'NoModificationAllowedError');
});
