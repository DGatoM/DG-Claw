'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: pausa } = require('node:timers/promises');
const UI = require('../lib/idioma-contexto');
const I = require('../public/ds/idioma');
const req = idioma => ({ headers: { cookie: 'dgclaw_idioma=' + idioma } });

test('contexto localiza somente mensagens próprias registradas, sem alterar erro interno ou dados', () => UI.executar(req('en'), 'pt-BR', () => {
  const fonte = 'Usuário ou senha incorretos.';
  const externo = { ok: false, erro: fonte, conversa: fonte };
  assert.equal(UI.erro(externo), externo, 'texto externo não é chave de tradução');
  const erro = new Error(UI.mensagem(fonte));
  assert.equal(erro.message, fonte, 'comparações e logs mantêm o valor original');
  const corpo = { ok: false, erro: erro.message, dados: { erro: fonte }, conversa: fonte };
  const saida = UI.erro(corpo);
  assert.equal(saida.erro, I.t(fonte, 'en'));
  assert.notEqual(saida.erro, fonte, 'catálogo precisa conter a tradução');
  assert.equal(corpo.erro, fonte, 'não modifica a resposta original');
  assert.equal(saida.dados, corpo.dados, 'não percorre dados arbitrários');
  assert.equal(saida.conversa, fonte);
  assert.equal(UI.erro([fonte])[0], fonte);
}));

test('requisições simultâneas não compartilham idioma nem registro, inclusive após await', async () => {
  const fonte = 'Pedido inválido.';
  const resultados = await Promise.all(['en', 'pt-BR', 'en'].map((idioma, n) => UI.executar(req(idioma), 'pt-BR', async () => {
    await pausa(5 * (3 - n));
    const mensagem = UI.mensagem(fonte);
    await pausa(n);
    return { idioma: UI.idioma(), mensagem, resposta: UI.erro({ erro: mensagem }).erro };
  })));
  for (const [n, r] of resultados.entries()) {
    assert.equal(r.idioma, n === 1 ? 'pt-BR' : 'en');
    assert.equal(r.mensagem, fonte);
    assert.equal(r.resposta, I.t(fonte, r.idioma));
  }
  assert.equal(UI.idioma(), 'pt-BR');
  assert.equal(UI.localizar(fonte), fonte, 'registro termina com a requisição');
});

test('parâmetros não são fontes de tradução, mensagens internas encadeadas são localizadas', () => UI.executar(req('en'), 'pt-BR', () => {
  const fonte = 'Não consegui ler {p0}: {p1}';
  const dados = { p0: '<img src=x onerror=alert(1)>', p1: 'Senha' };
  const original = UI.mensagem(fonte, dados);
  assert.equal(original, 'Não consegui ler <img src=x onerror=alert(1)>: Senha');
  assert.equal(UI.localizar(original), 'I could not read <img src=x onerror=alert(1)>: Senha');
  const interno = UI.mensagem('Pedido inválido.');
  const pai = UI.mensagem(fonte, { p0: '/dados/original', p1: interno });
  assert.equal(UI.localizar(pai), 'I could not read /dados/original: Invalid request.');
}));

test('cookie inválido usa padrão; mensagem de sucesso própria também é localizada', () => UI.executar(req('../../en'), 'en', () => {
  const fonte = 'Instalação iniciada. Acompanhe o progresso em GET /api/v1/anonimizar/estado.';
  const mensagem = UI.mensagem(fonte);
  assert.equal(UI.idioma(), 'en');
  assert.equal(UI.erro({ ok: true, mensagem }).mensagem, I.t(fonte, 'en'));
  assert.equal(UI.erro(null), null);
  assert.equal(UI.erro('dado'), 'dado');
}));
