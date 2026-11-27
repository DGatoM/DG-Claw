'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const UI = require('../lib/idioma-contexto');

test('rota real do painel encaminha o aviso próprio EN/PT sem traduzir nomes iguais', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../panel/lib/sessoes-local.js'), 'utf8');
  const inicio = source.indexOf('  async function rotaLista(req, res, query)');
  const fim = source.indexOf('\n  function motivoDaConversaVazia(', inicio);
  assert.ok(inicio >= 0 && fim > inicio, 'extrai a função de produção, sem copiá-la para a fixture');
  const fonte = 'O registro {p0} está ilegível ({p1}). Conserte ou apague o arquivo para voltar a guardar nomes e estrelas.';
  const desc = UI.descricao(fonte, { p0: 'fixture.json', p1: 'formato' });
  const original = UI.original(desc);
  const item = { id: 's1', nome: original, erro_externo: original };
  const entrada = UI.objeto({ itens: [item], avisoRegistro: desc });
  const persistido = JSON.stringify(entrada);
  const saidas = [];
  const contexto = vm.createContext({
    dgIdiomaBackend: UI,
    GRUPOS_FILTRO: ['ativos'],
    itens: async () => entrada,
    montarLista: todos => ({ contagem: { ativos: todos.length }, itens: todos, total: todos.length }),
    agenteSlug: () => 'fixture',
    FONTE: { id: 'local' },
    enviarJson: (_res, status, corpo) => {
      assert.equal(typeof corpo.aviso_registro, 'string', 'campo interno continua primitivo PT');
      assert.equal(corpo.aviso_registro, original);
      saidas.push({ status, corpo: JSON.parse(JSON.stringify(corpo, UI.replacer)) });
    },
  });
  vm.runInContext(source.slice(inicio, fim) + '\nglobalThis.rota = rotaLista;', contexto);
  for (const idioma of ['en', 'pt-BR', 'en']) {
    await UI.executar({ headers: { cookie: 'dgclaw_idioma=' + idioma } }, 'pt-BR', async () => {
      await contexto.rota({}, {}, new URLSearchParams());
      const r = saidas.at(-1);
      assert.equal(r.status, 200);
      assert.equal(r.corpo.aviso_registro, UI.localizar(desc));
      assert.deepEqual(r.corpo.itens[0], item, 'nome e dado externo coincidentes permanecem literais');
      assert.equal(JSON.stringify(entrada), persistido, 'resposta não modifica a origem nem sua persistência');
    });
  }
  assert.notEqual(saidas[0].corpo.aviso_registro, original, 'EN realmente traduz o aviso próprio');
  assert.equal(saidas[1].corpo.aviso_registro, original);
  assert.equal(entrada.itens[0], item);
});
