'use strict';
// Fila de leitura em voz: resposta nova não derruba a que está tocando (21/10/2026).
// Carrega só o bloco delimitado de public/conversa.js, com as dependências de mentira.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fonte = fs.readFileSync(path.join(__dirname, '../public/conversa.js'), 'utf8');
const ini = fonte.indexOf('/* ── Fila de leitura ──');
const fim = fonte.indexOf('/* ── fim da fila de leitura ── */');
assert.ok(ini > 0 && fim > ini, 'delimitadores da fila de leitura não encontrados em conversa.js');
const bloco = fonte.slice(ini, fim);
const tick = () => new Promise(r => setImmediate(r));

function mundo(extra) {
  const m = { log: [], avisos: [], mic: 0, resolve: null, pos: { tempo: 0, duracao: 0 }, paradas: 0, ocioso: 0 };
  const c = vm.createContext({
    gravando: false, pedindoMic: false, gravacao: null, esperando: false, transcrevendo: false,
    continua: false, pararPedido: false,
    msgs: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id })),
    mostraAviso(t) { m.avisos.push(t); },
    estadoOcioso() { m.ocioso++; },
    comecaGravar() { m.mic++; return Promise.resolve(); },
    pintaFilaLeitura() {},
    microfoneOcupado() { return !!(c.gravando || c.pedindoMic || c.gravacao); },
    posicaoDoPlayer() { return m.pos; },
    pararSomAtual() { m.paradas++; if (m.resolve) { const r = m.resolve; m.resolve = null; r(); } },
    // imita o real: `tocando` fica true enquanto o pedaço está no ar
    tocarMensagemNaFila(item, desde) {
      m.log.push(item.id + '@' + desde.parte + ':' + desde.tempo);
      item.tocando = true;
      return new Promise(r => { m.resolve = () => { item.tocando = false; r(m.resultado); }; });
    },
    console, ...extra });
  vm.runInContext(bloco, c);
  m.c = c;
  m.fim = async () => { const r = m.resolve; m.resolve = null; if (r) r(); await tick(); };   // a atual acabou sozinha
  m.estado = () => JSON.parse(vm.runInContext('JSON.stringify(estadoFilaLeitura())', c));
  m.fala = id => vm.runInContext(`enfileiraFala({id:${JSON.stringify(id)},texto:'texto '+${JSON.stringify(id)}})`, c);
  m.fone = id => vm.runInContext(`ouvirAPartirDe({id:${JSON.stringify(id)},texto:'texto '+${JSON.stringify(id)}})`, c);
  m.comecaMic = () => { c.gravando = true; vm.runInContext('pausaPelaGravacao()', c); };
  m.terminaMic = async () => { c.gravando = false; vm.runInContext('filaRetoma()', c); await tick(); };
  return m;
}

test('chegada durante a reprodução não interrompe e entra no fim', async () => {
  const m = mundo();
  m.fala('a'); await tick();
  m.fala('b'); m.fala('c'); await tick();
  assert.deepEqual(m.log, ['a@0:0']);
  assert.equal(m.paradas, 0);
  assert.deepEqual(m.estado().fila, ['b', 'c']);
  await m.fim(); assert.deepEqual(m.log, ['a@0:0', 'b@0:0']);
  await m.fim(); await m.fim();
  assert.deepEqual(m.log, ['a@0:0', 'b@0:0', 'c@0:0']);
  assert.equal(m.estado().tocando, null);
});

test('sem duplicata: mesmo id não entra duas vezes, nem tocando', async () => {
  const m = mundo();
  assert.equal(m.fala('a'), true); await tick();
  assert.equal(m.fala('a'), false);
  m.fala('b'); assert.equal(m.fala('b'), false);
  assert.deepEqual(m.estado().fila, ['b']);
});

test('chegada durante a gravação fica pendente e nada toca', async () => {
  const m = mundo();
  m.c.gravando = true;
  m.fala('a'); m.fala('b'); await tick();
  assert.deepEqual(m.log, []);
  assert.deepEqual(m.estado().fila, ['a', 'b']);
  m.c.gravando = false; m.c.pedindoMic = true; m.fala('c'); await tick();   // pedindoMic também segura
  assert.deepEqual(m.log, []);
  m.c.pedindoMic = false; m.c.gravacao = {}; m.fala('d'); await tick();      // e gravacao também
  assert.deepEqual(m.log, []);
});

test('interrupção com menos de 20% reinicia do começo', async () => {
  const m = mundo();
  m.fala('a'); await tick();
  m.pos = { tempo: 1, duracao: 10 };
  m.comecaMic();
  assert.equal(m.estado().pausada, 'a');
  await m.terminaMic();
  assert.deepEqual(m.log, ['a@0:0', 'a@0:0']);
});

test('interrupção com 20% ou mais retoma de onde parou, no pedaço certo', async () => {
  const m = mundo();
  m.fala('a'); await tick();
  m.pos = { tempo: 2, duracao: 10 };
  m.comecaMic(); await m.terminaMic();
  assert.equal(m.log[1], 'a@0:2');
  // no pedaço 2: retoma ali mesmo com pouco tempo
  const n = mundo();
  n.fala('a'); await tick();
  vm.runInContext('tocandoAgora.parte=2', n.c);
  n.pos = { tempo: 0.5, duracao: 10 };
  n.comecaMic(); await n.terminaMic();
  assert.equal(n.log[1], 'a@2:0.5');
});

test('pausa antes do som sair não usa a posição velha do player', async () => {
  const m = mundo();
  m.fala('a'); await tick();
  vm.runInContext('tocandoAgora.tocando = false', m.c);         // ainda gerando a voz: o player guarda o fim da anterior
  m.pos = { tempo: 9, duracao: 10 };
  m.comecaMic(); await m.terminaMic();
  assert.equal(m.log[1], 'a@0:0');
});

test('ao fim da gravação toca a retomada e depois a fila em ordem; chegadas durante a gravação entram', async () => {
  const m = mundo();
  m.fala('a'); await tick();
  m.fala('b');
  m.pos = { tempo: 5, duracao: 10 };
  m.comecaMic();
  m.fala('c'); await tick();
  assert.deepEqual(m.log, ['a@0:0']);          // nada novo durante a gravação
  await m.terminaMic();
  assert.equal(m.log[1], 'a@0:5');
  await m.fim(); await m.fim();
  assert.deepEqual(m.log.slice(2), ['b@0:0', 'c@0:0']);
});

test('🎧 pula, descarta as anteriores pendentes e mantém as seguintes', async () => {
  const m = mundo();
  m.fala('a'); await tick();
  m.fala('b'); m.fala('c'); m.fala('d');
  m.fone('c'); await tick();
  assert.equal(m.log[1], 'c@0:0');             // a foi interrompida e descartada
  assert.deepEqual(m.estado().fila, ['d']);     // b (anterior) saiu, d (seguinte) ficou
  await m.fim();
  assert.equal(m.log[2], 'd@0:0');
});

test('🎧 numa mensagem antiga mantém todos os pendentes mais novos', async () => {
  const m = mundo();
  m.fala('d'); await tick();
  m.fala('e');
  m.fone('a'); await tick();
  assert.equal(m.log[1], 'a@0:0');
  assert.deepEqual(m.estado().fila, ['e']);     // d tocando foi descartada; e é mais nova que a e fica
});

test('🎧 durante a gravação não toca e avisa', async () => {
  const m = mundo();
  m.c.gravando = true;
  assert.equal(m.fone('b'), false); await tick();
  assert.deepEqual(m.log, []);
  assert.match(m.avisos.at(-1), /Termine a gravação antes de ouvir/);
});

test('parar tudo esvazia a atual, a fila e a retomada', async () => {
  const m = mundo();
  m.fala('a'); await tick(); m.fala('b');
  vm.runInContext('pararTudoFila()', m.c); await tick();
  assert.deepEqual(m.estado(), { tocando: null, pausada: null, fila: [] });
  assert.deepEqual(m.log, ['a@0:0']);
  // e a retomada também
  const n = mundo();
  n.fala('a'); await tick(); n.comecaMic();
  vm.runInContext('pararTudoFila()', n.c);
  await n.terminaMic();
  assert.deepEqual(n.log, ['a@0:0']);
});

test('aparelho que não tocou (false) para o dreno inteiro e não mexe no microfone', async () => {
  const m = mundo({ continua: true });
  m.resultado = false;
  m.fala('a'); await tick(); m.fala('b');
  await m.fim();
  assert.deepEqual(m.log, ['a@0:0']);          // b não é tentada: não gasta cota à toa
  assert.deepEqual(m.estado(), { tocando: null, pausada: null, fila: [] });
  assert.equal(m.mic, 0);
});

test('continua só reabre o microfone no fim da fila inteira', async () => {
  const m = mundo({ continua: true });
  m.fala('a'); await tick(); m.fala('b');
  await m.fim(); assert.equal(m.mic, 0);          // ainda falta b
  await m.fim(); assert.equal(m.mic, 1);          // acabou tudo
  // com pergunta ainda em voo (transcrevendo/esperando) não reabre
  const n = mundo({ continua: true, esperando: true });
  n.fala('a'); await tick(); await n.fim();
  assert.equal(n.mic, 0);
  const o = mundo({ continua: true, transcrevendo: true });
  o.fala('a'); await tick(); await o.fim();
  assert.equal(o.mic, 0);
});

test('continua não reabre o microfone depois de uma parada pedida (corteFala)', async () => {
  const m = mundo({ continua: true });
  m.fala('a'); await tick();
  vm.runInContext('corteFala++', m.c);        // o que cancelaFala() faz
  await m.fim();
  assert.equal(m.mic, 0);
});

test('o 🎧 não reabre o microfone no fim; resposta nova do agente devolve o fluxo normal', async () => {
  const m = mundo({ continua: true });
  m.fone('b'); await tick();
  await m.fim();
  assert.equal(m.mic, 0);
  const n = mundo({ continua: true });
  n.fone('b'); await tick();
  n.fala('c');
  await n.fim(); await n.fim();
  assert.equal(n.mic, 1);
});

test('filaFala não fica pendurada com o microfone aberto', async () => {
  const m = mundo();
  m.fala('a'); await tick();
  m.comecaMic(); await tick();
  await Promise.race([vm.runInContext('filaFala', m.c), new Promise((_, rej) => setTimeout(() => rej(new Error('filaFala travou')), 500))]);
});

test('só a conversa normal (origin agente) entra na fila; rotina e o resto não', () => {
  const a = fonte.indexOf('const ehRespostaFalavel');
  const b = fonte.indexOf('\n', a);
  const c = vm.createContext({});
  vm.runInContext(fonte.slice(a, b) + '\n;this.ehRespostaFalavel = ehRespostaFalavel;', c);
  const r = m => c.ehRespostaFalavel(Object.assign({ ep: 10, text: 'resultado' }, m), 5);
  assert.equal(r({ origin: 'agente' }), true);
  assert.equal(r({ origin: 'rotina' }), false);
  assert.equal(r({ origin: 'dono' }), false);
  assert.equal(r({ origin: 'agente', ep: 5 }), false);
});

test('falaNovas enfileira só origin agente, sem duplicar, e a rotina fica de fora', async () => {
  const a = fonte.indexOf('const ehRespostaFalavel');
  const b = fonte.indexOf('\n', a);
  const i = fonte.indexOf('function falaNovas()');
  const j = fonte.indexOf('\n}\n', i) + 3;
  const m = mundo({
    escuta: { since: 0, ate: Date.now() + 60000 }, lerRespostas: true, faladas: new Set(),
    ehVisual: () => false, legendaUtil: x => x.text,
    msgs: [{ id: 1, ep: 1, origin: 'agente', text: 'oi' }, { id: 2, ep: 2, origin: 'rotina', text: 'rotina' },
           { id: 3, ep: 3, origin: 'agente', text: 'tchau' }],
  });
  vm.runInContext(fonte.slice(a, b) + '\n' + fonte.slice(i, j), m.c);
  vm.runInContext('falaNovas(); falaNovas();', m.c);
  await tick();
  assert.deepEqual(m.log, ['1@0:0']);
  assert.deepEqual(m.estado().fila, [3]);
});
