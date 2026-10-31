'use strict';
// Aviso de segurança: contrato do boletim (validador) e rotas /api/v1/seguranca no servidor inteiro, com o
// boletins.json gravado à mão (quem o grava de verdade é scripts/checar-boletins.mjs, testado em tests/boletins).
// Contrato das rotas em web/docs/SEGURANCA-BOLETINS.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, cliente } = require('./ajuda');
const C = require('../lib/boletim-contrato');

const AGENTES = [
  { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://x', agente_id: 'admin' },
  { slug: 'luna', nome: 'Luna', tipo: 'agente', runner: 'http://x', agente_id: 'luna' },
];
const bol = (extra) => Object.assign({
  id: 'GHSA-332P-7HRC-92WF', relacionados: [], severidade: 'CRITICAL', componente: 'Pillow', acao: 'atualizar-dgclaw',
  titulo: 'Vulnerabilidade no Pillow', detalhe: 'linha 1\nlinha 2', o_que_muda: 'A imagem usa o Pillow 13.',
  publicado_em: '2026-10-21T21:28:09Z', boletim_em: '2026-10-31T10:00:00Z',
  fonte_url: 'https://github.com/advisories/GHSA-332p-7hrc-92wf', noticia_url: null,
}, extra || {});
const gravaEstado = (w, pendentes, extra) => {
  const dir = path.join(w.dados, 'atualizacao');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'boletins.json'), typeof pendentes === 'string' ? pendentes
    : JSON.stringify(Object.assign({ formato: 1, verificado_em: '2026-10-31T10:00:00.000Z', desligado: false, erro: null, pendentes }, extra || {})));
};
async function logado(opcoes) {
  const w = await subirWeb(Object.assign({ agentes: AGENTES }, opcoes));
  await w.login();
  return w;
}

// --- contrato -----------------------------------------------------------------------------------

test('contrato: boletim válido passa, com campos desconhecidos ignorados', () => {
  const r = C.validaBoletim(bol({ coisa_nova: 'x' }));
  assert.ok(r.boletim);
  assert.equal(r.boletim.coisa_nova, undefined);
  assert.equal(r.boletim.noticia_url, null);
});

test('contrato: sem fonte_url é descartado, com motivo', () => {
  const r = C.validaBoletim(bol({ fonte_url: undefined }));
  assert.equal(r.boletim, undefined);
  assert.match(r.motivo, /sem fonte_url/);
  assert.equal(C.validaBoletim(bol({ fonte_url: '' })).boletim, undefined);
});

test('contrato: URL http://, com usuário ou com espaço é recusada; noticia_url também', () => {
  for (const u of ['http://x.org/a', 'ftp://x.org', 'javascript:alert(1)', 'https://u:p@x.org/', 'https://x.org/a b', 'https:///sem-host', 'x.org']) {
    assert.equal(C.validaBoletim(bol({ fonte_url: u })).boletim, undefined, u);
    assert.equal(C.validaBoletim(bol({ noticia_url: u })).boletim, undefined, `noticia ${u}`);
  }
  assert.ok(C.validaBoletim(bol({ noticia_url: 'https://blog.exemplo.org/post' })).boletim);
});

test('contrato: caractere de controle e invisível recusados; \\n só no detalhe', () => {
  for (const campo of ['componente', 'titulo', 'o_que_muda']) {
    assert.equal(C.validaBoletim(bol({ [campo]: 'a\u0007b' })).boletim, undefined, campo);
    assert.equal(C.validaBoletim(bol({ [campo]: 'a\nb' })).boletim, undefined, `${campo} com quebra`);
    assert.equal(C.validaBoletim(bol({ [campo]: 'a‮b' })).boletim, undefined, `${campo} com marca de direção`);
  }
  assert.ok(C.validaBoletim(bol({ detalhe: 'a\nb' })).boletim);
  assert.equal(C.validaBoletim(bol({ detalhe: 'a\u0000b' })).boletim, undefined);
});

test('contrato: id, severidade, ação, datas e tamanhos', () => {
  assert.equal(C.validaBoletim(bol({ id: 'ghsa-minusculo' })).boletim, undefined);
  assert.equal(C.validaBoletim(bol({ id: 'A' })).boletim, undefined);
  assert.equal(C.validaBoletim(bol({ severidade: 'URGENTE' })).boletim, undefined);
  assert.ok(C.validaBoletim(bol({ severidade: 'desconhecida' })).boletim);
  assert.equal(C.validaBoletim(bol({ acao: 'rodar' })).boletim, undefined);
  assert.equal(C.validaBoletim(bol({ publicado_em: 'ontem' })).boletim, undefined);
  assert.equal(C.validaBoletim(bol({ titulo: 'x'.repeat(121) })).boletim, undefined);
  assert.ok(C.validaBoletim(bol({ titulo: 'x'.repeat(120) })).boletim);
  assert.equal(C.validaBoletim(bol({ detalhe: 'x'.repeat(601) })).boletim, undefined);
  assert.equal(C.validaBoletim(bol({ relacionados: ['ruim ruim'] })).boletim, undefined);
  assert.equal(C.validaBoletim(bol({ relacionados: Array(21).fill('GHSA-AAAA-0001') })).boletim, undefined);
});

test('contrato: arquivo versão 1 é lido, versão 3 não, e repetido sobra um', () => {
  const v1 = { id: 'GHSA-VELH-0001', severidade: 'HIGH', componente: 'X', acao: 'aguardar', titulo: 'T', detalhe: 'd', publicado_em: '2026-10-01T00:00:00Z', fonte_url: 'https://a.org/b' };
  const lido = C.validaArquivo({ versao: 1, boletins: [v1, { ...v1, id: 'GHSA-VELH-0002', fonte_url: undefined }, v1] });
  assert.equal(lido.boletins.length, 1);
  assert.equal(lido.boletins[0].o_que_muda, '');
  assert.equal(lido.descartados.length, 2);
  assert.throws(() => C.validaArquivo({ versao: 3, boletins: [] }), /não é 1 nem 2/);
  assert.throws(() => C.validaArquivo({ versao: 2, boletins: 'x' }), /não é uma lista/);
  assert.throws(() => C.validaArquivo([]), /não é um objeto/);
});

test('contrato: ordena pela gravidade e depois pelo mais recente', () => {
  const l = C.ordena([bol({ id: 'GHSA-LOW-0001', severidade: 'LOW' }), bol({ id: 'GHSA-OLD-0002', boletim_em: '2026-10-01T00:00:00Z' }), bol({ id: 'GHSA-NEW-0003' })]);
  assert.deepEqual(l.map((b) => b.id), ['GHSA-NEW-0003', 'GHSA-OLD-0002', 'GHSA-LOW-0001']);
});

// --- rotas --------------------------------------------------------------------------------------

test('sem sessão: 401 nas rotas', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    for (const [m, p] of [['GET', '/api/v1/seguranca/boletins'], ['POST', '/api/v1/seguranca/boletins/GHSA-AAAA-0001/adiar'], ['POST', '/api/v1/seguranca/boletins/GHSA-AAAA-0001/dispensar'], ['GET', '/api/v1/seguranca/docs.md']]) {
      assert.equal((await w.c.pedir(m, p, m === 'POST' ? { json: {} } : {})).status, 401, `${m} ${p}`);
    }
  } finally { await w.fechar(); }
});

test('nunca verificado: lista vazia com nunca_verificado', async () => {
  const w = await logado();
  try {
    const r = await w.c.get('/api/v1/seguranca/boletins');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, nunca_verificado: true, verificado_em: null, erro: null, boletins: [] });
  } finally { await w.fechar(); }
});

test('GET devolve os campos do contrato mais pendente, adiado_ate e mostrar_modal', async () => {
  const w = await logado();
  try {
    gravaEstado(w, [bol(), bol({ id: 'GHSA-LOW-0001', severidade: 'LOW' })]);
    const r = await w.c.get('/api/v1/seguranca/boletins');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.verificado_em, '2026-10-31T10:00:00.000Z');
    assert.equal(r.json.boletins.length, 2);
    const b = r.json.boletins[0];
    assert.equal(b.id, 'GHSA-332P-7HRC-92WF');
    assert.equal(b.pendente, true);
    assert.equal(b.adiado_ate, null);
    assert.equal(b.mostrar_modal, true);
    assert.equal(b.fonte_url, 'https://github.com/advisories/GHSA-332p-7hrc-92wf');
    assert.equal(r.json.boletins[1].id, 'GHSA-LOW-0001');
  } finally { await w.fechar(); }
});

test('cada campo é revalidado: boletim adulterado no disco não sai', async () => {
  const w = await logado();
  try {
    gravaEstado(w, [bol({ fonte_url: 'http://ruim.exemplo/x', id: 'GHSA-RUIM-0001' }), bol({ id: 'GHSA-BOM-0002' }), bol({ id: 'GHSA-SEMF-0003', fonte_url: undefined })]);
    const r = await w.c.get('/api/v1/seguranca/boletins');
    assert.deepEqual(r.json.boletins.map((b) => b.id), ['GHSA-BOM-0002']);
    assert.match(w.log.texto(), /GHSA-RUIM-0001/);
  } finally { await w.fechar(); }
});

test('erro da última checagem aparece junto com a lista guardada', async () => {
  const w = await logado();
  try {
    gravaEstado(w, [bol()], { erro: { quando: '2026-10-31T11:00:00.000Z', motivo: 'Não consegui falar com a internet.' } });
    const r = await w.c.get('/api/v1/seguranca/boletins');
    assert.equal(r.json.erro.motivo, 'Não consegui falar com a internet.');
    assert.equal(r.json.boletins.length, 1);
  } finally { await w.fechar(); }
});

test('arquivo corrompido: 500 com o caminho e o comando para refazer', async () => {
  const w = await logado();
  try {
    gravaEstado(w, '{quebrado');
    const r = await w.c.get('/api/v1/seguranca/boletins');
    assert.equal(r.status, 500);
    assert.match(r.json.erro, /boletins\.json/);
    assert.match(r.json.erro, /sudo systemctl start dgclaw-checar-boletins\.service/);
    gravaEstado(w, '{"formato":1}');
    assert.equal((await w.c.get('/api/v1/seguranca/boletins')).status, 500);
  } finally { await w.fechar(); }
});

test('adiar esconde só o modal por 24 h, grava atômico em 600 e o selo (pendente) continua', async () => {
  let agora = Date.parse('2026-10-31T12:00:00Z');
  const w = await logado({ opcoesServidor: { agora: () => agora } });
  try {
    gravaEstado(w, [bol()]);
    const r = await w.c.post('/api/v1/seguranca/boletins/GHSA-332P-7HRC-92WF/adiar', { json: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.adiado_ate, '2026-11-01T12:00:00.000Z');
    const arq = path.join(w.dados, 'atualizacao', 'boletins-adiados.json');
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(arq)).filter((n) => n.endsWith('.tmp')), []);
    let g = (await w.c.get('/api/v1/seguranca/boletins')).json.boletins[0];
    assert.equal(g.mostrar_modal, false);
    assert.equal(g.pendente, true);
    assert.equal(g.adiado_ate, '2026-11-01T12:00:00.000Z');
    agora += 25 * 3600 * 1000;
    g = (await w.c.get('/api/v1/seguranca/boletins')).json.boletins[0];
    assert.equal(g.mostrar_modal, true);
    assert.equal(g.adiado_ate, null);
  } finally { await w.fechar(); }
});

test('adiar: id malformado é 400 e id que não está pendente é 404', async () => {
  const w = await logado();
  try {
    gravaEstado(w, [bol()]);
    assert.equal((await w.c.post('/api/v1/seguranca/boletins/ruim%20id/adiar', { json: {} })).status, 400);
    const r = await w.c.post('/api/v1/seguranca/boletins/GHSA-NAO-0001/adiar', { json: {} });
    assert.equal(r.status, 404);
    assert.match(r.json.erro, /GHSA-NAO-0001/);
    assert.ok(!fs.existsSync(path.join(w.dados, 'atualizacao', 'boletins-adiados.json')));
  } finally { await w.fechar(); }
});

test('dispensar: só vale para aguardar; nas outras ações responde 409 explicando', async () => {
  const w = await logado();
  try {
    gravaEstado(w, [bol(), bol({ id: 'GHSA-AGUA-0001', acao: 'aguardar' }), bol({ id: 'GHSA-PARA-0002', acao: 'parar-servico' }), bol({ id: 'GHSA-SIST-0003', acao: 'atualizar-sistema' })]);
    for (const id of ['GHSA-332P-7HRC-92WF', 'GHSA-PARA-0002', 'GHSA-SIST-0003']) {
      const r = await w.c.post(`/api/v1/seguranca/boletins/${id}/dispensar`, { json: {} });
      assert.equal(r.status, 409, id);
      assert.match(r.json.erro, /só some quando o sistema for atualizado/);
    }
    const ok = await w.c.post('/api/v1/seguranca/boletins/GHSA-AGUA-0001/dispensar', { json: {} });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.dispensado, true);
    const g = (await w.c.get('/api/v1/seguranca/boletins')).json.boletins.find((b) => b.id === 'GHSA-AGUA-0001');
    assert.equal(g.dispensado, true);
    assert.equal(g.mostrar_modal, false);
  } finally { await w.fechar(); }
});

test('quando o boletim deixa de ser pendente, a marca de adiado sai do arquivo na próxima gravação', async () => {
  const w = await logado();
  try {
    gravaEstado(w, [bol(), bol({ id: 'GHSA-OUTR-0001' })]);
    await w.c.post('/api/v1/seguranca/boletins/GHSA-332P-7HRC-92WF/adiar', { json: {} });
    gravaEstado(w, [bol({ id: 'GHSA-OUTR-0001' })]);
    await w.c.post('/api/v1/seguranca/boletins/GHSA-OUTR-0001/adiar', { json: {} });
    const marca = JSON.parse(fs.readFileSync(path.join(w.dados, 'atualizacao', 'boletins-adiados.json'), 'utf8'));
    assert.deepEqual(Object.keys(marca.adiados), ['GHSA-OUTR-0001']);
  } finally { await w.fechar(); }
});

test('métodos errados dão 405 e rota inexistente 404', async () => {
  const w = await logado();
  try {
    assert.equal((await w.c.post('/api/v1/seguranca/boletins', { json: {} })).status, 405);
    assert.equal((await w.c.get('/api/v1/seguranca/boletins/GHSA-AAAA-0001/adiar')).status, 405);
    assert.equal((await w.c.post('/api/v1/seguranca/docs.md', { json: {} })).status, 405);
    assert.equal((await w.c.get('/api/v1/seguranca/nada')).status, 404);
  } finally { await w.fechar(); }
});

test('POST sem Origin do próprio site é recusado (CSRF)', async () => {
  const w = await logado();
  try {
    gravaEstado(w, [bol()]);
    const r = await w.c.post('/api/v1/seguranca/boletins/GHSA-332P-7HRC-92WF/adiar', { json: {}, origin: 'https://site-de-fora.exemplo' });
    assert.equal(r.status, 403);
    assert.ok(!fs.existsSync(path.join(w.dados, 'atualizacao', 'boletins-adiados.json')));
  } finally { await w.fechar(); }
});

test('agente pela caixa não acessa: 403, e a rota não está na lista liberada', async () => {
  const w = await logado();
  try {
    gravaEstado(w, [bol()]);
    assert.equal(w.web.caixa.rotaPermitida('/api/v1/seguranca/boletins'), false);
    const cab = { 'x-dgclaw-caixa': w.web.caixa.segredo, 'x-dgclaw-agente': 'luna' };
    const c = cliente(w.porta);
    assert.equal((await c.pedir('GET', '/api/v1/seguranca/boletins', { headers: cab })).status, 403);
    assert.equal((await c.pedir('POST', '/api/v1/seguranca/boletins/GHSA-332P-7HRC-92WF/adiar', { headers: cab, json: {} })).status, 403);
    assert.ok(!fs.existsSync(path.join(w.dados, 'atualizacao', 'boletins-adiados.json')));
  } finally { await w.fechar(); }
});

test('docs.md: documento para agente, em português, sem travessão', async () => {
  const w = await logado();
  try {
    const r = await w.c.get('/api/v1/seguranca/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/markdown/);
    assert.match(r.texto, /GET \/api\/v1\/seguranca\/boletins/);
    assert.match(r.texto, /POST \/api\/v1\/seguranca\/boletins\/<id>\/adiar/);
    assert.match(r.texto, /POST \/api\/v1\/seguranca\/boletins\/<id>\/dispensar/);
    assert.doesNotMatch(r.texto, /[—–]/);
  } finally { await w.fechar(); }
});
