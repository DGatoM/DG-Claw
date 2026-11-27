'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: pausa } = require('node:timers/promises');
const UI = require('../lib/idioma-contexto');
const I = require('../public/ds/idioma');
const req = idioma => ({ headers: { cookie: 'dgclaw_idioma=' + idioma } });
const en = fn => UI.executar(req('en'), 'pt-BR', fn);
const json = v => JSON.parse(JSON.stringify(v, UI.replacer));

test('identidade do campo, não igualdade textual, autoriza a tradução HTTP', () => en(() => {
  const fonte = 'Usuário ou senha incorretos.';
  const propria = UI.objeto({ erro: UI.descricao(fonte) });
  const externo = { erro: fonte, conversa: fonte };
  assert.equal(typeof propria.erro, 'string'); assert.equal(propria.erro, fonte);
  assert.equal(UI.erro(externo), externo);
  assert.equal(UI.localizar(fonte), fonte);
  assert.equal(UI.mensagem(fonte), fonte, 'diagnóstico legado não registra palavras');
  const corpo = { propria, externo, dados: [fonte, externo] };
  const resposta = json(corpo);
  assert.equal(resposta.propria.erro, I.t(fonte, 'en'));
  assert.deepEqual(resposta.externo, externo);
  assert.deepEqual(resposta.dados, corpo.dados);
  assert.equal(JSON.parse(JSON.stringify(corpo)).propria.erro, fonte, 'persistência continua PT');
  assert.equal(UI.erro(corpo).externo, externo, 'adaptador não recria dados comuns');
}));

test('parâmetros externos idênticos a uma mensagem própria permanecem literais', () => en(() => {
  const fonte = 'Não consegui ler {p0}: {p1}';
  const conhecida = UI.descricao('Pedido inválido.');
  const externa = UI.descricao(fonte, { p0: '<img>', p1: 'Pedido inválido.' });
  const encadeada = UI.descricao(fonte, { p0: '<img>', p1: conhecida });
  assert.equal(UI.localizar(externa), 'I could not read <img>: Pedido inválido.');
  assert.equal(UI.localizar(encadeada), 'I could not read <img>: Invalid request.');
  assert.equal(UI.original(externa), 'Não consegui ler <img>: Pedido inválido.');
  assert.equal(UI.texto(fonte, { p0: '<img>', p1: conhecida }), 'I could not read <img>: Invalid request.');
  assert.equal(JSON.stringify(conhecida), '"Pedido inválido."');
}));

test('erro próprio e erro externo com message igual têm identidades distintas', () => en(() => {
  const fonte = 'Pedido inválido.';
  const propria = UI.criarErro(Error, [UI.descricao(fonte)]);
  const externa = new Error(fonte);
  assert.ok(propria instanceof Error); assert.equal(propria.message, fonte);
  assert.equal(typeof propria.message, 'string'); assert.match(propria.stack, /Pedido inválido/);
  assert.equal(UI.localizar(UI.campo(propria, 'message')), 'Invalid request.');
  assert.equal(UI.localizar(UI.campo(externa, 'message')), fonte);
  assert.equal(json(UI.objeto({ erro: UI.campo(propria, 'message') })).erro, 'Invalid request.');
  assert.equal(json(UI.objeto({ erro: UI.campo(externa, 'message') })).erro, fonte);
}));

test('construtores mantêm ordem, avaliação única, tipo e campos PT', () => en(() => {
  const eventos = [];
  class ErroArquivo extends Error {
    constructor(tipo, motivo) { super(motivo); eventos.push('construtor'); this.tipo = tipo; this.motivo = motivo; }
  }
  const a = () => { eventos.push('tipo'); return 'caminho'; };
  const b = () => { eventos.push('mensagem'); return UI.descricao('Pedido inválido.'); };
  const e = UI.criarErro(ErroArquivo, [a(), b()], { motivo: 1 });
  assert.deepEqual(eventos, ['tipo', 'mensagem', 'construtor']);
  assert.ok(e instanceof ErroArquivo); assert.equal(e.motivo, 'Pedido inválido.');
  assert.equal(UI.localizar(UI.campo(e, 'motivo')), 'Invalid request.');
}));

test('assign e spread conservam a identidade da última propriedade, inclusive texto igual', () => en(() => {
  const fonte = 'Pedido inválido.';
  const propria = UI.objeto({ erro: UI.descricao(fonte) });
  assert.equal(json(UI.atribuir({}, propria)).erro, 'Invalid request.');
  assert.equal(json(UI.atribuir({}, propria, { erro: fonte })).erro, fonte);
  assert.equal(json(UI.atribuir({}, { erro: fonte }, propria)).erro, 'Invalid request.');
  assert.equal(json(UI.objeto({ ...UI.espalhar(propria) })).erro, 'Invalid request.');
  assert.equal(json(UI.objeto({ ...UI.espalhar(propria), erro: fonte })).erro, fonte);
  assert.equal(json(UI.objeto({ erro: fonte, ...UI.espalhar(propria) })).erro, 'Invalid request.');
  UI.definir(propria, 'erro', fonte);
  assert.equal(json(propria).erro, fonte, 'atribuição externa igual remove a identidade anterior');
}));

test('mutação e redefinição não mantêm uma tradução antiga', () => en(() => {
  const d = UI.objeto({ erro: UI.descricao('Pedido inválido.') });
  d.erro = 'nome externo';
  assert.equal(json(d).erro, 'nome externo');
  d.erro = 'Pedido inválido.';
  assert.equal(json(d).erro, 'Pedido inválido.', 'identidade invalidada não reaparece pela igualdade textual');
  UI.definir(d, 'erro', UI.descricao('Pedido inválido.'));
  Object.defineProperty(d, 'erro', { get: () => 'nome externo', enumerable: true });
  assert.equal(json(d).erro, 'nome externo');
  const congelado = Object.freeze(UI.objeto({ erro: UI.descricao('Pedido inválido.') }));
  assert.throws(() => UI.definir(congelado, 'erro', 'outro'), TypeError);
  assert.equal(json(congelado).erro, 'Invalid request.');
  const vazio = UI.objeto({ erro: UI.descricao('') });
  assert.equal(UI.campo(vazio, 'erro') || 'alternativa', 'alternativa');
}));

test('cópia de dados preserva símbolos, getters e __proto__ conforme spread/assign', () => en(() => {
  const s = Symbol('dado'); let lidas = 0;
  const fonte = { get erro() { lidas++; return 'Pedido inválido.'; }, [s]: 42 };
  const copia = UI.objeto({ ...UI.espalhar(fonte) });
  assert.equal(lidas, 1); assert.equal(copia[s], 42); assert.equal(json(copia).erro, 'Pedido inválido.');
  const proto = JSON.parse('{"__proto__":{"dado":1}}');
  const espalhada = UI.espalhar(proto);
  assert.ok(Object.hasOwn(espalhada, '__proto__'));
  assert.equal(Object.getPrototypeOf(espalhada), Object.prototype);
}));

test('descritores não são forjáveis por JSON, nomes ou objetos parecidos', () => en(() => {
  const fake = { fonte: 'Pedido inválido.', valores: {}, original: 'Pedido inválido.' };
  assert.equal(UI.localizar(fake), fake);
  const dados = UI.objeto({ erro: fake, mensagem: 'Pedido inválido.' });
  assert.deepEqual(json(dados), dados);
}));

test('requisições simultâneas usam o idioma próprio sem alterar DTO compartilhado', async () => {
  const fonte = 'Pedido inválido.';
  const compartilhado = UI.objeto({ erro: UI.descricao(fonte) });
  const resultados = await Promise.all(['en', 'pt-BR', 'en'].map((lingua, n) => UI.executar(req(lingua), 'pt-BR', async () => {
    await pausa(5 * (3 - n));
    return { lingua: UI.idioma(), texto: json(compartilhado).erro };
  })));
  for (const r of resultados) assert.equal(r.texto, I.t(fonte, r.lingua));
  assert.equal(compartilhado.erro, fonte); assert.equal(UI.idioma(), 'pt-BR');
});

test('cookie inválido usa padrão; mensagens de sucesso têm identidade explícita', () => UI.executar(req('../../en'), 'en', () => {
  const fonte = 'Instalação iniciada. Acompanhe o progresso em GET /api/v1/anonimizar/estado.';
  const d = UI.objeto({ ok: true, mensagem: UI.descricao(fonte) });
  assert.equal(UI.idioma(), 'en'); assert.equal(json(d).mensagem, I.t(fonte, 'en'));
  assert.equal(UI.erro(null), null); assert.equal(UI.erro('dado'), 'dado');
}));
