'use strict';
// Corrida apontada na revisão adversarial do PR #86: em "Gerar novo link", a consulta disparada depois do
// DELETE pode chegar DEPOIS do POST que começou o login novo. O estado velho ("nenhum") não pode
// sobrescrever o login em andamento. A página roda num vm com fetch controlado à mão.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public');

function montaPagina() {
  const pedidos = [];
  const ctx = {
    document: { addEventListener() {}, visibilityState: 'visible' },
    AbortController,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
    fetch(url, init) {
      return new Promise((resolve) => pedidos.push({
        metodo: init.method,
        responde: (dados) => resolve({ ok: true, status: init.method === 'POST' ? 202 : 200, json: async () => dados }),
      }));
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['login-cartao.js', 'conectar-puro.js']) vm.runInContext(fs.readFileSync(path.join(PUB, f), 'utf8'), ctx);
  let src = fs.readFileSync(path.join(PUB, 'conectar.js'), 'utf8');
  const corte = src.indexOf('  window.DGConectarTela =');
  assert.ok(corte > 0, 'conectar.js mudou de forma: ajuste este teste');
  src = src.slice(0, corte) + 'desenhaCartao = () => {}; desenhaTudo = () => {}; window.sonda = { est, novoEstado, novoLink, visaoDe };})();';
  vm.runInContext(src, ctx);
  return { sonda: ctx.sonda, pedidos };
}

const volta = () => new Promise((resolve) => setImmediate(resolve));

test('Gerar novo link: consulta velha que chega depois do POST é descartada', async () => {
  const { sonda, pedidos } = montaPagina();
  const a = { id: 'ana', nome: 'Ana', provedor: 'claude' };
  sonda.est.agentes = [a];
  sonda.est.por.ana = sonda.novoEstado();
  sonda.est.por.ana.dados = { estado: 'aguardando_codigo', auth: 'assinatura', conferido: { ok: false }, precisa_login: true };
  sonda.est.por.ana.iniciado = true;

  sonda.novoLink(a);
  assert.equal(pedidos[0].metodo, 'DELETE');
  pedidos[0].responde({ ok: true, estado: 'nenhum' });
  await volta();
  assert.deepEqual(pedidos.map((p) => p.metodo), ['DELETE', 'GET', 'POST']);

  pedidos[2].responde({ ok: true, estado: 'aguardando_link' });
  await volta();
  assert.equal(sonda.est.por.ana.dados.estado, 'aguardando_link');

  // a consulta que saiu antes do POST chega por último, com o estado velho
  pedidos[1].responde({ ok: true, estado: 'nenhum', auth: 'assinatura', conferido: { ok: false }, precisa_login: true });
  await volta();
  assert.equal(sonda.est.por.ana.dados.estado, 'aguardando_link');
  const v = sonda.visaoDe(a);
  assert.equal(v.cancelar, true, 'o cartão continua com o login em andamento e o botão Cancelar');
});
