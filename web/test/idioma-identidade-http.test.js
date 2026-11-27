'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const UI = require('../lib/idioma-contexto');
const I = require('../public/ds/idioma');
const H = require('../lib/http');
const { subirWeb } = require('./ajuda');

test('HTTP: nome idêntico a aviso do registro não é traduzido dentro do erro do proxy', async () => {
  const nome = 'o item 0 da lista não é um objeto';
  const agente = { slug: 'fixture', nome: 'original', runner: 'http://127.0.0.1:1', agente_id: 'fixture', porta_painel: 9999 };
  const s = await subirWeb({ agentes: [agente] });
  try {
    await s.login();
    fs.writeFileSync(s.agentesPath, JSON.stringify({ versao: 1, agentes: [null, { ...agente, nome }] }));
    const r = await s.c.get('/p/fixture/', { headers: { Cookie: 'dgclaw_idioma=en' } });
    const fonte = 'O agente {p0} não tem proxy_segredo_arquivo no registro; sem o segredo o painel não confia no Web. Rode o instalador para configurar o painel.';
    assert.equal(r.status, 500);
    assert.equal(r.json.erro, I.frase(fonte, { p0: nome }, 'en'));
    assert.ok(r.json.erro.includes(nome), 'o nome é dado literal, mesmo após o aviso próprio');
    assert.equal(s.web.registro.obter('fixture').nome, nome);
    assert.equal(r.headers['content-language'], 'en');
    assert.equal(Number(r.headers['content-length']), r.buf.length);
    const pt = await s.c.get('/p/fixture/', { headers: { Cookie: 'dgclaw_idioma=pt-BR' } });
    assert.equal(pt.json.erro, I.frase(fonte, { p0: nome }, 'pt-BR'));
  } finally { await s.fechar(); }
});

test('HTTP: campos externos iguais permanecem literais; só propriedade própria é localizada', async () => {
  const fonte = 'Pedido inválido.';
  const propria = UI.objeto({ erro: UI.descricao(fonte) });
  const externo = { erro: fonte, mensagem: fonte };
  const servidor = http.createServer((req, res) => UI.executar(req, 'pt-BR', () => {
    H.enviaJson(res, 400, { propria, externo, conversa: [fonte] });
  }));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${servidor.address().port}/`, { headers: { Cookie: 'dgclaw_idioma=en' } });
    const d = await r.json();
    assert.equal(r.status, 400); assert.equal(d.propria.erro, 'Invalid request.');
    assert.deepEqual(d.externo, externo); assert.deepEqual(d.conversa, [fonte]);
    assert.equal(propria.erro, fonte);
    assert.equal(JSON.parse(JSON.stringify(propria)).erro, fonte, 'o transporte não regrava o objeto');
  } finally {
    servidor.closeAllConnections();
    await new Promise(resolve => servidor.close(resolve));
  }
});
