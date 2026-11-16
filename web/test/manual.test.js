'use strict';
// Manual: rotas de leitura de docs/manual (lista, página, índice), segurança do nome e do caminho, liberação da caixa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarManual } = require('../lib/manual');
const escopo = require('../lib/escopo');
const { subirWeb, pastaTemp } = require('./ajuda');

/** Pasta de manual de mentira, com índice, duas páginas, um arquivo de fora e um atalho para ele. */
function montaManual() {
  const raiz = pastaTemp('manual');
  const dir = path.join(raiz, 'docs', 'manual');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Manual do teste\n\n[Primeiros passos](primeiros-passos.md)\n');
  fs.writeFileSync(path.join(dir, 'primeiros-passos.md'), '# Primeiros passos\n\nTexto.\n');
  fs.writeFileSync(path.join(dir, 'cofre-2.md'), 'sem titulo aqui\n');
  fs.writeFileSync(path.join(dir, 'Maiuscula.md'), '# Não deve aparecer\n');
  fs.writeFileSync(path.join(dir, 'excecoes.tsv'), 'rota\t/x\tmotivo\n');
  fs.writeFileSync(path.join(raiz, 'segredo.md'), '# SEGREDO DE FORA\n');
  fs.symlinkSync(path.join(raiz, 'segredo.md'), path.join(dir, 'atalho.md'));
  return { raiz, dir };
}

async function sobe(extra) {
  const { raiz, dir } = montaManual();
  const agente = { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'ana1', chat_id: 'c_ana', transcripts_dir: raiz, home_host: raiz, home_container: '/home/agente' };
  const s = await subirWeb(Object.assign({ agentes: [agente], opcoesServidor: { manualDir: dir } }, extra || {}));
  fs.writeFileSync(path.join(s.publico, 'manual.html'), '<html>manual de teste</html>');
  const fechar = s.fechar;
  s.fechar = async () => { await fechar(); fs.rmSync(raiz, { recursive: true, force: true }); };
  s.dirManual = dir; s.raizManual = raiz;
  return s;
}

test('sem sessão: a tela redireciona ao login e a API responde 401', async () => {
  const s = await sobe();
  try {
    const pag = await s.c.get('/manual', { headers: { Accept: 'text/html' } });
    assert.equal(pag.status, 302);
    assert.match(pag.headers.location, /^\/login\?next=%2Fmanual/);
    assert.equal((await s.c.get('/api/v1/manual')).status, 401);
    assert.equal((await s.c.get('/api/v1/manual/primeiros-passos.md')).status, 401);
  } finally { await s.fechar(); }
});

test('com sessão: a tela abre, a lista traz só páginas de nome válido e a página volta em markdown', async () => {
  const s = await sobe();
  try {
    await s.login();
    for (const u of ['/manual', '/manual/', '/manual/primeiros-passos']) {
      const r = await s.c.get(u);
      assert.equal(r.status, 200, u);
      assert.match(r.texto, /manual de teste/);
    }
    const lista = await s.c.get('/api/v1/manual');
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.json.paginas.map((p) => p.nome), ['cofre-2', 'primeiros-passos']);
    assert.equal(lista.json.paginas[1].titulo, 'Primeiros passos');
    assert.equal(lista.json.paginas[0].titulo, 'cofre-2', 'sem H1 o título é o nome');
    assert.equal(lista.json.indice.titulo, 'Manual do teste');
    const pg = await s.c.get('/api/v1/manual/primeiros-passos.md');
    assert.equal(pg.status, 200);
    assert.match(pg.headers['content-type'], /text\/markdown/);
    assert.match(pg.texto, /^# Primeiros passos/);
    const idx = await s.c.get('/api/v1/manual/README.md');
    assert.match(idx.texto, /Manual do teste/);
  } finally { await s.fechar(); }
});

test('docs.md devolve o índice sem credencial', async () => {
  const s = await sobe();
  try {
    const r = await s.c.get('/api/v1/manual/docs.md', { semCookie: true });
    assert.equal(r.status, 200);
    assert.match(r.texto, /^# Manual do teste/);
  } finally { await s.fechar(); }
});

test('nomes perigosos ou fora da lista dão 404 explicado, nunca arquivo de fora', async () => {
  const s = await sobe();
  try {
    await s.login();
    const ruins = ['..%2fsegredo', '%2e%2e/segredo', '..', '%2e%2e', 'a%2fb', 'Maiuscula', 'MAIUSCULA', 'excecoes', 'excecoes.tsv', 'nao-existe', 'atalho', 'primeiros_passos', '%00'];
    for (const n of ruins) {
      const r = await s.c.get(`/api/v1/manual/${n}.md`);
      assert.ok(r.status === 404 || r.status === 400, `${n} deu ${r.status}`);
      assert.doesNotMatch(r.texto, /SEGREDO DE FORA/, n);
    }
    const r = await s.c.get('/api/v1/manual/nao-existe.md');
    assert.equal(r.status, 404);
    assert.match(r.json.erro, /"nao-existe"/);
    assert.match(r.json.erro, /\/api\/v1\/manual/);
    const barra = await s.c.get('/api/v1/manual/a/b.md');
    assert.equal(barra.status, 404);
    const tela = await s.c.get('/manual/..%2fsegredo');
    assert.equal(tela.status, 404);
    assert.equal((await s.c.get('/manual/Maiuscula')).status, 404);
  } finally { await s.fechar(); }
});

test('symlink para fora da pasta não é listado nem lido', async () => {
  const s = await sobe();
  try {
    await s.login();
    const lista = await s.c.get('/api/v1/manual');
    assert.ok(!lista.json.paginas.some((p) => p.nome === 'atalho'));
    const r = await s.c.get('/api/v1/manual/atalho.md');
    assert.equal(r.status, 404);
    assert.doesNotMatch(r.texto, /SEGREDO/);
    assert.match(s.log.texto(), /aponta para fora da pasta do manual/);
  } finally { await s.fechar(); }
});

test('só leitura: escrita responde 405 e não cria arquivo', async () => {
  const s = await sobe();
  try {
    await s.login();
    for (const m of ['post', 'put', 'delete']) {
      const r = await s.c.pedir(m.toUpperCase(), '/api/v1/manual/novo.md', m === 'delete' ? undefined : { json: { x: 1 } });
      assert.equal(r.status, 405, m);
    }
    assert.ok(!fs.existsSync(path.join(s.dirManual, 'novo.md')));
  } finally { await s.fechar(); }
});

test('manual ausente na instalação: erro que explica, na API e em docs.md', async () => {
  const s = await sobe({ opcoesServidor: { manualDir: path.join(pastaTemp('vazio'), 'nao-existe') } });
  try {
    await s.login();
    const r = await s.c.get('/api/v1/manual');
    assert.equal(r.status, 503);
    assert.match(r.json.erro, /não está instalado/);
    assert.match(r.json.erro, /atualiza o DG Claw/);
    assert.equal((await s.c.get('/api/v1/manual/docs.md', { semCookie: true })).status, 503);
    assert.match(s.log.texto(), /\[erro\].*O manual não está instalado/);
  } finally { await s.fechar(); }
});

test('manual sem o índice: 404 que diz o que fazer', () => {
  const { dir, raiz } = montaManual();
  try {
    fs.rmSync(path.join(dir, 'README.md'));
    const m = criarManual({ dir });
    assert.throws(() => m.ler('README'), /\(README\.md\) não está na pasta/);
    assert.equal(m.listar().indice, null);
  } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});

test('caixa: o agente lê o manual e a liberação é só do prefixo do manual', async () => {
  const s = await sobe();
  try {
    const caixa = s.web.caixa;
    for (const ok of ['/api/v1/manual', '/api/v1/manual/docs.md', '/api/v1/manual/primeiros-passos.md']) assert.equal(caixa.rotaPermitida(ok), true, ok);
    for (const nao of ['/api/v1/manualx', '/api/v1/manuais', '/api/v1/colaboradores', '/api/v1/seguranca', '/api/v1/estados']) assert.equal(caixa.rotaPermitida(nao), false, nao);
    const cab = { 'X-DGClaw-Caixa': caixa.segredo, 'X-DGClaw-Agente': 'ana' };
    const lista = await s.c.get('/api/v1/manual', { headers: cab, semCookie: true });
    assert.equal(lista.status, 200, lista.texto);
    const pg = await s.c.get('/api/v1/manual/primeiros-passos.md', { headers: cab, semCookie: true });
    assert.equal(pg.status, 200);
    const fora = await s.c.get('/api/v1/estados', { headers: cab, semCookie: true });
    assert.equal(fora.status, 403);
    const escrita = await s.c.post('/api/v1/manual/x.md', { headers: cab, semCookie: true, json: {} });
    assert.equal(escrita.status, 405);
  } finally { await s.fechar(); }
});

test('colaborador: a tela e a lista do manual ficam fechadas (rota sem o agente dele); o índice docs.md é público', () => {
  const colab = { usuario: 'c', papel: 'colaborador', agente: 'ana' };
  assert.equal(escopo.avaliar(colab, 'GET', '/manual', '/manual').ok, false);
  assert.equal(escopo.avaliar(colab, 'GET', '/api/v1/manual', '/api/v1/manual').ok, false);
  assert.equal(escopo.avaliar(colab, 'GET', '/api/v1/manual/docs.md', '/api/v1/manual/docs.md').ok, true);
});
