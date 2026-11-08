'use strict';
// Aviso único de segurança: regras puras (o que conta, texto, ordem, quando reabre) e a janela com um DOM simulado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../public/seguranca-resumo');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const AGORA = Date.parse('2026-10-31T12:00:00Z');
const HORA = 3600 * 1000;
const memoria = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };
const bol = (extra) => Object.assign({ id: 'GHSA-1', severidade: 'HIGH', componente: 'Pillow', titulo: 'Falha no Pillow', pendente: true, dispensado: false }, extra || {});
const achado = (extra) => Object.assign({ id: 'UBUNTU-CVE-1', aliases: [], nivel: 2, severidade: 'CRITICAL', nome_simples: 'Falha no kernel', estado: 'aberto' }, extra || {});
const ronda = (...a) => ({ niveis: { 1: [], 2: a, 3: [] } });
const item = (id, severidade) => ({ tipo: 'boletim', id, nome: id, severidade });

test('conta boletins não dispensados e achados nível 2 abertos; ignora dispensado, agendado, fora do ar e níveis 1 e 3', () => {
  const st = memoria();
  const itens = S.pontosEmRisco({
    boletins: [bol(), bol({ id: 'GHSA-2', dispensado: true }), bol({ id: 'GHSA-3', adiado_ate: '2026-11-01T00:00:00Z', severidade: 'LOW' })],
    ronda: { niveis: { 1: [achado({ id: 'N1', nivel: 1 })], 2: [achado(), achado({ id: 'AGEND', estado: 'agendado' })], 3: [achado({ id: 'N3', nivel: 3 })] } },
    emergencia: null, storage: st, agora: AGORA,
  });
  assert.deepEqual(itens.map((i) => i.id), ['UBUNTU-CVE-1', 'GHSA-1', 'GHSA-3'], 'mais graves primeiro; adiado ainda conta');
  assert.deepEqual(S.pontosEmRisco({ boletins: [bol()], ronda: ronda(achado()), emergencia: { estado: { cortado: true } }, storage: st, agora: AGORA }).map((i) => i.id), ['GHSA-1'], 'fora do ar: só o boletim conta');
  R_decidido(st, 'UBUNTU-CVE-1');
  assert.deepEqual(S.pontosEmRisco({ boletins: [], ronda: ronda(achado()), storage: st, agora: AGORA }), [], 'achado já decidido neste aparelho não conta');
});

function R_decidido(st, id) { require('../public/ronda-comum').marcaDecidido(st, id, AGORA); }

test('o mesmo problema como boletim e como achado (id ou alias) conta uma vez só', () => {
  const itens = S.pontosEmRisco({ boletins: [bol({ id: 'GHSA-1' })], ronda: ronda(achado({ id: 'CVE-9', aliases: ['GHSA-1'] }), achado({ id: 'GHSA-1' })), storage: memoria(), agora: AGORA });
  assert.deepEqual(itens.map((i) => i.id), ['GHSA-1']);
});

test('mesmo problema nas duas fontes fica com a gravidade maior, e isso reabre a janela', () => {
  const itens = S.pontosEmRisco({ boletins: [bol({ id: 'GHSA-1', severidade: 'HIGH' })], ronda: ronda(achado({ id: 'CVE-9', aliases: ['GHSA-1'], severidade: 'CRITICAL' })), storage: memoria(), agora: AGORA });
  assert.deepEqual(itens.map((i) => [i.id, i.severidade]), [['GHSA-1', 'CRITICAL']]);
  const antes = S.assinaturaDe(S.pontosEmRisco({ boletins: [bol({ id: 'GHSA-1', severidade: 'HIGH' })], ronda: ronda(), storage: memoria(), agora: AGORA }), AGORA);
  assert.equal(S.deveReabrir(itens, antes, AGORA + 1000), true);
});

test('fontes ausentes (null, sem rede) não derrubam: lista vazia', () => {
  assert.deepEqual(S.pontosEmRisco({ boletins: null, ronda: null, emergencia: null, storage: memoria(), agora: AGORA }), []);
  assert.deepEqual(S.pontosEmRisco({}), []);
  assert.deepEqual(S.pontosEmRisco({ boletins: [null, { id: 5 }], ronda: { nunca_rodou: true }, storage: memoria() }), []);
});

test('texto da contagem e do selo: singular e plural', () => {
  assert.equal(S.textoContagem(1), 'Encontramos 1 ponto de segurança que precisa da sua atenção.');
  assert.equal(S.textoContagem(3), 'Encontramos 3 pontos de segurança que precisam da sua atenção.');
  assert.equal(S.textoSelo(1), '🛡 1 ponto de segurança');
  assert.equal(S.textoSelo(4), '🛡 4 pontos de segurança');
  assert.equal(S.textoResto(1), 'e mais 1 ponto');
  assert.equal(S.textoResto(3), 'e mais 3 pontos');
});

test('lista da janela: no máximo 5, com "e mais X"', () => {
  const sete = Array.from({ length: 7 }, (_, i) => item('ID-' + i, 'HIGH'));
  const h = S.modalHtml(sete);
  assert.equal((h.match(/class="sr-item"/g) || []).length, 5);
  assert.match(h, /e mais 2 pontos/);
  assert.match(h, /Encontramos 7 pontos de segurança/);
  assert.doesNotMatch(S.modalHtml(sete.slice(0, 5)), /e mais/);
  assert.match(S.modalHtml([item('A', 'LOW')]), /Encontramos 1 ponto de segurança que precisa/);
});

test('janela: título, botões e escape do que vem da API', () => {
  const ruim = '<img src=x onerror=alert(1)>';
  const h = S.modalHtml([{ tipo: 'boletim', id: ruim, nome: ruim, severidade: ruim }]);
  assert.match(h, /Seu ambiente está em risco/);
  assert.match(h, /data-sr="ver"[^>]*>Ver na Segurança</);
  assert.match(h, /id="srAgoraNao" data-sr="fechar">Agora não</);
  assert.match(h, /data-sr="ajuda"/);
  assert.doesNotMatch(h, /<img/i);
  assert.doesNotMatch(h, /[—–]/);
});

test('reabertura: lista vazia nunca abre; sem assinatura abre', () => {
  assert.equal(S.deveReabrir([], null, AGORA), false);
  assert.equal(S.deveReabrir([], S.assinaturaDe([item('A', 'HIGH')], AGORA), AGORA + 99 * HORA), false);
  assert.equal(S.deveReabrir([item('A', 'HIGH')], null, AGORA), true);
});

test('reabertura: mesmo conjunto dentro de 24 h não reabre; id novo, gravidade pior e 24 h reabrem', () => {
  const vistos = [item('A', 'HIGH'), item('B', 'LOW')];
  const ass = S.assinaturaDe(vistos, AGORA);
  assert.equal(S.deveReabrir(vistos, ass, AGORA + 23 * HORA), false);
  assert.equal(S.deveReabrir([item('B', 'LOW')], ass, AGORA + HORA), false, 'um ponto a menos não reabre');
  assert.equal(S.deveReabrir(vistos.concat(item('C', 'LOW')), ass, AGORA + HORA), true, 'id novo');
  assert.equal(S.deveReabrir([item('A', 'CRITICAL'), item('B', 'LOW')], ass, AGORA + HORA), true, 'gravidade pior');
  assert.equal(S.deveReabrir(vistos, ass, AGORA + 24 * HORA), true, '24 h depois');
  assert.equal(S.deveReabrir([item('A', 'MEDIUM')], ass, AGORA + HORA), false, 'gravidade menor não reabre');
});

test('assinatura: grava e lê do aparelho; lixo ou storage quebrado valem como "nunca fechou"', () => {
  const st = memoria();
  S.gravaAssinatura(st, [item('A', 'HIGH'), item('B', 'CRITICAL')], AGORA);
  assert.deepEqual(S.lerAssinatura(st), { ids: ['A', 'B'], pior: 0, em: AGORA });
  st.setItem(S.CHAVE_ASSINATURA, '{lixo');
  assert.equal(S.lerAssinatura(st), null);
  assert.equal(S.lerAssinatura({ getItem() { throw new Error('sem acesso'); } }), null);
  assert.doesNotThrow(() => S.gravaAssinatura({ setItem() { throw new Error('sem acesso'); } }, [item('A', 'HIGH')], AGORA));
});

test('tutorial: cada passo diz o que é, como funciona e por que está aqui, sem travessão', () => {
  const passos = S.passosDoModal(null);
  for (const a of ['#srTexto', '#srLista', '#srVer', '#srAgoraNao']) assert.ok(passos.some((p) => p.alvo === a), a);
  for (const p of passos.concat([S.PASSO_SELO])) {
    for (const k of ['titulo', 'oque', 'como', 'porque']) assert.ok(p[k] && p[k].length > 3, `${p.alvo} ${k}`);
    assert.doesNotMatch(JSON.stringify(p), /[—–]/);
  }
  assert.equal(S.PASSO_SELO.alvo, '#seloSeguranca');
});

test('ligação nas telas: casca, conversa, service worker, tour da conversa e CSS de celular', () => {
  assert.match(pub('casca.js'), /\/seguranca-resumo\.js/);
  assert.match(pub('conversa.html'), /<script src="\/seguranca-resumo\.js"><\/script>/);
  assert.match(pub('sw.js'), /'\/seguranca-resumo\.js'/);
  assert.match(pub('sw.js'), /'\/seguranca-resumo\.css'/);
  assert.match(pub('conversa.js'), /DGSegurancaResumo\.passoSelo\(\)/);
  const css = pub('seguranca-resumo.css');
  assert.match(css, /@media \(max-width:420px\)/);
  assert.match(css, /overflow-y:auto/);
  assert.match(css, /min-height:3[2-9]px/);
});

/* ── a janela com um DOM simulado ──────────────────────────────────────── */
function elemento() {
  const el = {
    dataset: {}, hidden: false, textContent: '', innerHTML: '', removido: false, ouvintes: {}, filhos: [], attrs: {},
    setAttribute(k, v) { el.attrs[k] = v; }, focus() {},
    appendChild(f) { el.filhos.push(f); },
    insertBefore(f) { el.filhos.push(f); },
    addEventListener(tipo, fn) { el.ouvintes[tipo] = fn; },
    remove() { el.removido = true; },
    querySelector() { return null; },
  };
  return el;
}

function montaPagina({ boletins, ronda: r, caminho = '/', storage = memoria(), semRede = false, emergencia = null, storageBloqueado = false }) {
  const corpo = elemento();
  const teclas = [];
  const selos = [];
  const documento = {
    readyState: 'complete', head: elemento(), body: corpo,
    createElement: () => { const e = elemento(); selos.push(e); return e; },
    querySelector: () => null, getElementById: () => null,
    addEventListener() {}, removeEventListener(tipo, fn) { teclas.push(['rm', tipo]); },
  };
  const resposta = (json) => ({ ok: true, status: 200, json: async () => json });
  const ctx = {
    document: documento, localStorage: storage, location: { pathname: caminho, href: caminho },
    fetch: async (url) => {
      if (semRede) throw new Error('sem rede');
      if (url.endsWith('/boletins')) return resposta({ boletins });
      if (url.endsWith('/emergencia')) return emergencia ? emergencia() : resposta({ estado: { cortado: false } });
      return resposta(r);
    },
    setInterval() {}, console: { warn() {}, log() {}, error() {} },
  };
  if (storageBloqueado) Object.defineProperty(ctx, 'localStorage', { get() { throw new Error('SecurityError: acesso negado'); } });
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(pub('ronda-comum.js'), ctx);
  vm.runInContext(pub('seguranca-resumo.js'), ctx);
  return { ctx, corpo, selos, storage };
}

const janelas = (corpo) => corpo.filhos.filter((f) => f.id === 'srFundo');
async function espera(corpo) {
  for (let i = 0; i < 40; i++) await new Promise((res) => setImmediate(res));
}
const clique = (fundo, acao) => fundo.ouvintes.click({ target: { closest: () => ({ dataset: { sr: acao } }) } });

test('DOM: com 3 pontos abre UMA janela só; "Agora não" fecha tudo, grava a assinatura e a janela não volta sozinha', async () => {
  const { corpo, storage, ctx } = montaPagina({ boletins: [bol(), bol({ id: 'GHSA-2' })], ronda: ronda(achado()) });
  await espera(corpo);
  assert.equal(janelas(corpo).length, 1, 'uma janela só');
  const fundo = janelas(corpo)[0];
  assert.match(fundo.innerHTML, /Encontramos 3 pontos de segurança/);
  clique(fundo, 'fechar');
  assert.equal(fundo.removido, true);
  const ass = JSON.parse(storage.getItem(S.CHAVE_ASSINATURA));
  assert.deepEqual(ass.ids.sort(), ['GHSA-1', 'GHSA-2', 'UBUNTU-CVE-1']);
  assert.equal(ass.pior, 0);
  corpo.filhos.length = 0;
  await ctx.DGSegurancaResumo.atualiza();
  assert.equal(janelas(corpo).length, 0, 'mesmo conjunto dentro de 24 h: não reabre sozinha');
});

test('DOM: clique fora da caixa fecha como "Agora não"; "Ver na Segurança" grava e vai para /seguranca', async () => {
  const a = montaPagina({ boletins: [bol()], ronda: ronda() });
  await espera(a.corpo);
  const fundoA = janelas(a.corpo)[0];
  fundoA.ouvintes.click({ target: fundoA });
  assert.equal(fundoA.removido, true);
  assert.ok(a.storage.getItem(S.CHAVE_ASSINATURA));

  const b = montaPagina({ boletins: [bol()], ronda: ronda() });
  await espera(b.corpo);
  const fundoB = janelas(b.corpo)[0];
  clique(fundoB, 'ver');
  assert.equal(fundoB.removido, true);
  assert.equal(b.ctx.location.href, '/seguranca');
  assert.ok(b.storage.getItem(S.CHAVE_ASSINATURA));
});

test('DOM: na tela /seguranca a janela não abre sozinha; com falha de rede nada abre nem quebra; sem pontos nada abre', async () => {
  const naTela = montaPagina({ boletins: [bol()], ronda: ronda(achado()), caminho: '/seguranca' });
  await espera(naTela.corpo);
  assert.equal(janelas(naTela.corpo).length, 0);
  const semRede = montaPagina({ boletins: [bol()], ronda: ronda(), semRede: true });
  await espera(semRede.corpo);
  assert.equal(janelas(semRede.corpo).length, 0);
  const vazio = montaPagina({ boletins: [bol({ dispensado: true })], ronda: ronda() });
  await espera(vazio.corpo);
  assert.equal(janelas(vazio.corpo).length, 0);
});

test('DOM: assinatura antiga com id novo reabre; assinatura de 25 h atrás reabre', async () => {
  const st = memoria();
  S.gravaAssinatura(st, [item('GHSA-1', 'HIGH')], Date.now());
  const novo = montaPagina({ boletins: [bol(), bol({ id: 'GHSA-NOVO' })], ronda: ronda(), storage: st });
  await espera(novo.corpo);
  assert.equal(janelas(novo.corpo).length, 1, 'id novo');

  const velho = memoria();
  S.gravaAssinatura(velho, [item('GHSA-1', 'HIGH')], Date.now() - 25 * HORA);
  const dia = montaPagina({ boletins: [bol()], ronda: ronda(), storage: velho });
  await espera(dia.corpo);
  assert.equal(janelas(dia.corpo).length, 1, '25 h depois');
});

test('DOM: alerta que chega com a janela aberta não vira "visto" ao fechar e reabre na consulta seguinte', async () => {
  const boletins = [bol({ id: 'GHSA-BAIXO', severidade: 'LOW' })];
  const { corpo, storage, ctx } = montaPagina({ boletins, ronda: ronda() });
  await espera(corpo);
  const fundo = janelas(corpo)[0];
  assert.ok(fundo, 'abriu com o primeiro alerta');
  boletins.push(bol({ id: 'GHSA-CRITICO', severidade: 'CRITICAL' }));
  await ctx.DGSegurancaResumo.atualiza();
  assert.equal(janelas(corpo).length, 1, 'continua uma janela só');
  clique(fundo, 'fechar');
  const ass = JSON.parse(storage.getItem(S.CHAVE_ASSINATURA));
  assert.deepEqual(ass.ids, ['GHSA-BAIXO'], 'grava só o que a janela mostrou');
  corpo.filhos.length = 0;
  await ctx.DGSegurancaResumo.atualiza();
  assert.equal(janelas(corpo).length, 1, 'o alerta novo reabre a janela');
  assert.match(janelas(corpo)[0].innerHTML, /2 pontos de segurança/);
});

test('DOM: emergência que deixa de responder não segura mais os alertas críticos escondidos', async () => {
  let falha = false;
  const emergencia = () => (falha
    ? { ok: false, status: 500, json: async () => ({ erro: 'quebrou' }) }
    : { ok: true, status: 200, json: async () => ({ estado: { cortado: true } }) });
  const { corpo, ctx } = montaPagina({ boletins: [], ronda: ronda(achado()), emergencia });
  await espera(corpo);
  assert.equal(janelas(corpo).length, 0, 'sistema fora do ar: a ronda não conta');
  falha = true;
  await ctx.DGSegurancaResumo.atualiza();
  assert.equal(janelas(corpo).length, 1, 'sem leitura boa da emergência, a falha crítica volta a aparecer');
});

test('DOM: navegador que bloqueia o localStorage ainda mostra o aviso', async () => {
  const { corpo } = montaPagina({ boletins: [bol({ severidade: 'CRITICAL' })], ronda: ronda(), storageBloqueado: true });
  await espera(corpo);
  assert.equal(janelas(corpo).length, 1);
  clique(janelas(corpo)[0], 'fechar');
  assert.equal(janelas(corpo)[0].removido, true);
});
