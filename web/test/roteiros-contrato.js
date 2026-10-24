#!/usr/bin/env node
'use strict';
// Teste de contrato do modo roteiro, por HTTP puro. Roda contra qualquer backend que siga
// docs/MODO-ROTEIRO.md (DG Claw Web em Node, DG Telegram em Python).
//
//   node web/test/roteiros-contrato.js <BASE_URL> <BEARER>
//   node web/test/roteiros-contrato.js <BASE_URL> --cookie nome=valor
//
// Cria um roteiro local de teste, percorre o ciclo inteiro e o arquiva no fim. Sai com código 1 se
// algum passo falhar. Quem aprova ou desfaz precisa de credencial do dono: com credencial de agente
// esses passos aparecem como "pulado".

const assert = require('node:assert/strict');

const args = process.argv.slice(2);
const iCookie = args.indexOf('--cookie');
let cookie = null;
if (iCookie >= 0) { cookie = args[iCookie + 1]; args.splice(iCookie, 2); }
const [baseBruta, bearer] = args;
if (!baseBruta || (!bearer && !cookie)) {
  console.error('Uso: node web/test/roteiros-contrato.js <BASE_URL> <BEARER>\n     node web/test/roteiros-contrato.js <BASE_URL> --cookie nome=valor');
  process.exit(2);
}
const BASE = baseBruta.replace(/\/+$/, '');

async function api(metodo, caminho, json) {
  const h = { Origin: BASE, Accept: 'application/json' };
  if (cookie) h.Cookie = cookie; else h.Authorization = `Bearer ${bearer}`;
  let body;
  if (json !== undefined) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  const r = await fetch(`${BASE}/api/v1/roteiros${caminho}`, { method: metodo, headers: h, body });
  const texto = await r.text();
  let j = null; try { j = JSON.parse(texto); } catch (_) { /* conferido nos passos */ }
  return { status: r.status, json: j, texto };
}

const passos = [];
const passo = (nome, fn) => passos.push([nome, fn]);
class Pulado extends Error {}
const pula = (motivo) => { throw new Pulado(motivo); };
const esperaStatus = (r, ...ok) => assert.ok(ok.includes(r.status), `esperava status ${ok.join(' ou ')}, veio ${r.status}: ${r.texto.slice(0, 300)}`);

let id = null;
let v1 = null;

passo('docs.md responde markdown', async () => {
  const r = await fetch(`${BASE}/api/v1/roteiros/docs.md`, { headers: cookie ? { Cookie: cookie } : { Authorization: `Bearer ${bearer}` } });
  assert.equal(r.status, 200);
  assert.ok((await r.text()).length > 100, 'documentação vazia');
});

passo('cria roteiro local (201) com versão 1', async () => {
  const r = await api('POST', '', { titulo: `Contrato ${Date.now()}`, texto: 'Primeira versão do teste.', resumo: 'Teste de contrato' });
  esperaStatus(r, 201);
  const ro = r.json.roteiro || r.json;
  assert.match(ro.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal(ro.versao, 1);
  assert.equal(ro.origem, 'local');
  assert.ok(['em_ajuste', 'aguardando_aprovacao'].includes(ro.estado), `estado ${ro.estado}`);
  id = ro.id;
});

passo('lista traz o roteiro, sem texto, e fontes.dgsocial', async () => {
  const r = await api('GET', `?q=${encodeURIComponent('Contrato')}`);
  esperaStatus(r, 200);
  const x = r.json.roteiros.find((i) => i.id === id);
  assert.ok(x, 'roteiro criado não apareceu na lista');
  assert.equal(x.texto, undefined);
  assert.ok(r.json.fontes && r.json.fontes.dgsocial && typeof r.json.fontes.dgsocial.ligado === 'boolean', 'faltou fontes.dgsocial.ligado');
});

passo('lê o roteiro com texto', async () => {
  const r = await api('GET', `/${id}`);
  esperaStatus(r, 200);
  assert.equal(r.json.texto, 'Primeira versão do teste.');
  assert.equal(r.json.versao, 1);
  v1 = r.json;
});

passo('estado enxuto', async () => {
  const r = await api('GET', `/${id}/estado`);
  esperaStatus(r, 200);
  for (const k of ['id', 'versao', 'estado', 'ajustando', 'resumo', 'autor', 'atualizado_em']) assert.ok(k in r.json, `faltou ${k}`);
  assert.equal(r.json.texto, undefined);
});

passo('grava versão 2 com base certa', async () => {
  const r = await api('POST', `/${id}/versoes`, { texto: 'Segunda versão do teste.', resumo: 'Troquei o texto', base_versao: 1 });
  esperaStatus(r, 200, 201);
  assert.equal(r.json.mudou, true);
  assert.equal((r.json.roteiro || {}).versao, 2);
});

passo('texto igual não cria versão', async () => {
  const r = await api('POST', `/${id}/versoes`, { texto: 'Segunda versão do teste.', resumo: 'Igual', base_versao: 2 });
  esperaStatus(r, 200, 201);
  assert.equal(r.json.mudou, false);
});

passo('base velha dá 409 com atual', async () => {
  const r = await api('POST', `/${id}/versoes`, { texto: 'Texto de quem leu a versão velha.', resumo: 'Velha', base_versao: 1 });
  esperaStatus(r, 409);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.atual && r.json.atual.versao === 2 && typeof r.json.atual.texto === 'string', 'faltou atual com texto');
  assert.match(r.json.erro, /A versão atual é a 2/);
});

passo('sem base_versao dá 400', async () => {
  esperaStatus(await api('POST', `/${id}/versoes`, { texto: 'x', resumo: 'y' }), 400);
});

passo('forcar:true passa por cima', async () => {
  const r = await api('POST', `/${id}/versoes`, { texto: 'Terceira versão forçada.', resumo: 'Forçada', base_versao: 1, forcar: true });
  esperaStatus(r, 200, 201);
  assert.equal(r.json.roteiro.versao, 3);
});

passo('liga e desliga ajustando', async () => {
  let r = await api('POST', `/${id}/ajustando`, { ativo: true, nota: 'testando' });
  esperaStatus(r, 200);
  r = await api('GET', `/${id}/estado`);
  assert.ok(r.json.ajustando && r.json.ajustando.nota === 'testando', 'ajustando não apareceu no estado');
  r = await api('POST', `/${id}/ajustando`, { ativo: false });
  esperaStatus(r, 200);
  assert.equal((await api('GET', `/${id}/estado`)).json.ajustando, null);
});

passo('marca estado aguardando_aprovacao', async () => {
  const r = await api('POST', `/${id}/estado`, { estado: 'aguardando_aprovacao', nota: 'contrato' });
  esperaStatus(r, 200);
  assert.equal((await api('GET', `/${id}/estado`)).json.estado, 'aguardando_aprovacao');
  esperaStatus(await api('POST', `/${id}/estado`, { estado: 'inexistente' }), 400);
});

passo('lista versões e lê uma', async () => {
  const r = await api('GET', `/${id}/versoes`);
  esperaStatus(r, 200);
  assert.equal(r.json.versoes.length, 3);
  const v = await api('GET', `/${id}/versoes/1`);
  esperaStatus(v, 200);
  assert.equal((v.json.versao || v.json).texto, 'Primeira versão do teste.');
  esperaStatus(await api('GET', `/${id}/versoes/999`), 404);
});

passo('desfazer duas vezes seguidas anda para trás (3 -> 2 -> 1)', async () => {
  let r = await api('POST', `/${id}/desfazer`, { base_versao: 3 });
  if (r.status === 403) pula('credencial sem poder de desfazer (agente)');
  esperaStatus(r, 200, 201);
  assert.equal(r.json.roteiro.versao, 4);
  assert.equal(r.json.roteiro.texto, 'Segunda versão do teste.');
  r = await api('POST', `/${id}/desfazer`, { base_versao: 4 });
  esperaStatus(r, 200, 201);
  assert.equal(r.json.roteiro.versao, 5);
  assert.equal(r.json.roteiro.texto, 'Primeira versão do teste.');
  const lista = (await api('GET', `/${id}/versoes`)).json.versoes;
  assert.equal(lista.at(-1).restaurada_de, 1);
  assert.equal(lista.at(-2).restaurada_de, 2);
});

passo('restaurar a versão 3', async () => {
  const r = await api('POST', `/${id}/restaurar`, { versao: 3, base_versao: (await api('GET', `/${id}/estado`)).json.versao });
  esperaStatus(r, 200, 201);
  assert.equal(r.json.roteiro.texto, 'Terceira versão forçada.');
});

passo('eventos com desde', async () => {
  const todos = await api('GET', `/${id}/eventos`);
  esperaStatus(todos, 200);
  const tipos = todos.json.eventos.map((e) => e.tipo);
  for (const t of ['criado', 'versao', 'ajustando', 'estado', 'restaurar']) {
    if (t === 'versao' && !tipos.includes('versao') && tipos.includes('edicao_dono')) continue;
    assert.ok(tipos.includes(t), `faltou o evento ${t} (vieram ${tipos.join(', ')})`);
  }
  const ns = todos.json.eventos.map((e) => e.n);
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b), 'n não é crescente');
  const meio = ns[Math.floor(ns.length / 2)];
  const depois = await api('GET', `/${id}/eventos?desde=${meio}`);
  assert.deepEqual(depois.json.eventos.map((e) => e.n), ns.filter((n) => n > meio));
});

passo('abrir e aberto', async () => {
  const ab = await api('POST', `/${id}/abrir`);
  esperaStatus(ab, 200);
  assert.ok(ab.json.link && ab.json.link.includes(id), 'link de abrir sem o id');
  const lido = await api('GET', '/aberto');
  if (lido.status === 403) pula('credencial sem poder de ler o pedido de abrir (agente)');
  esperaStatus(lido, 200);
  assert.equal(lido.json.id, id);
});

passo('id inexistente dá 404 e id inválido dá 400', async () => {
  esperaStatus(await api('GET', '/nao-existe-contrato'), 404);
  esperaStatus(await api('GET', '/ID_Invalido'), 400);
});

passo('arquiva o roteiro de teste', async () => {
  const r = await api('POST', `/${id}/estado`, { estado: 'arquivado', nota: 'fim do teste de contrato' });
  esperaStatus(r, 200);
});

(async () => {
  let falhas = 0;
  for (const [nome, fn] of passos) {
    try { await fn(); console.log(`ok       ${nome}`); } catch (e) {
      if (e instanceof Pulado) { console.log(`pulado   ${nome} (${e.message})`); continue; }
      falhas += 1;
      console.log(`FALHOU   ${nome}\n         ${String(e.message).split('\n').join('\n         ')}`);
    }
  }
  void v1;
  console.log(falhas ? `\n${falhas} passo(s) falharam.` : '\nTodos os passos passaram.');
  process.exit(falhas ? 1 : 0);
})();
