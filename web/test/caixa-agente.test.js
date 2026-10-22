'use strict';
// Caixa do agente: pedido em arquivo, resposta em arquivo.
//
// Casa temporária: os testes rodam como root no servidor de CI e a caixa recusa casa de root
// (uid 0). Por isso, como root, a casa é entregue (chown) ao uid 65534 (nobody), que existe em
// qualquer Linux e não é root; sem ser root, a casa já é do usuário que roda o teste. O caso
// "casa de root" é testado de verdade só quando o processo é root (dá para criar a casa dele).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { criarCaixaAgente, quemChamou } = require('../lib/caixa-agente');
const { ErroGravacao } = require('../lib/grava-seguro');
const { subirWeb, capturaLog } = require('./ajuda');

const souRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const UID = souRoot ? 65534 : process.getuid();
const GID = souRoot ? 65534 : process.getgid();
const dar = (p) => { if (souRoot) fs.chownSync(p, UID, GID); };

/** Casa de agente com .dgclaw/caixa/entrada pronta e entregue ao dono. */
function casa() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'caixa-casa-'));
  fs.chmodSync(h, 0o755); dar(h);
  let atual = h;
  for (const d of ['.dgclaw', 'caixa', 'entrada']) {
    atual = path.join(atual, d);
    fs.mkdirSync(atual, { mode: 0o700 }); dar(atual);
  }
  return h;
}
const limpa = (h) => fs.rmSync(h, { recursive: true, force: true });
const entrada = (h) => path.join(h, '.dgclaw', 'caixa', 'entrada');
const saida = (h) => path.join(h, '.dgclaw', 'caixa', 'saida');
let contador = 0;
const novoId = () => `pedido-${String(++contador).padStart(6, '0')}`;

function pedido(h, obj, opcoes) {
  const o = opcoes || {};
  const id = o.id || novoId();
  const arq = path.join(entrada(h), `${id}.json`);
  fs.writeFileSync(arq, o.texto != null ? o.texto : JSON.stringify(Object.assign({ v: 1, id, metodo: 'GET', rota: '/api/v1/ok' }, obj)));
  dar(arq);
  return { id, arq };
}
const resposta = (h, id) => JSON.parse(fs.readFileSync(path.join(saida(h), `${id}.json`), 'utf8'));

/** API interna de mentira: devolve o que a caixa mandou. */
async function apiFalsa() {
  const vistos = [];
  const srv = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      vistos.push({ metodo: req.method, url: req.url, headers: req.headers, corpo: Buffer.concat(partes).toString('utf8') });
      if (req.url.startsWith('/api/v1/texto')) { res.writeHead(200, { 'Content-Type': 'text/markdown' }); return res.end('# oi'); }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, eco: req.url }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { vistos, porta: srv.address().port, fechar: () => new Promise((r) => srv.close(r)) };
}

async function cenario(opcoes) {
  const o = opcoes || {};
  const h = o.home || casa();
  const api = await apiFalsa();
  const cap = capturaLog();
  const relogio = { t: Date.now() };
  const agentes = [{ slug: 'ana', tipo: 'agente', home_host: h }, { slug: 'admin', tipo: 'admin', home_host: h }];
  const registro = { estado: () => ({ ok: true, agentes }), obter: (s) => agentes.find((a) => a.slug === s) || null };
  const caixa = criarCaixaAgente({ config: {}, registro, log: cap.log, porta: () => api.porta, agora: () => relogio.t });
  caixa.permitir('/api/v1/ok');
  caixa.permitir('/api/v1/texto');
  return { h, api, cap, relogio, caixa, agentes, fim: async () => { caixa.parar(); await api.fechar(); limpa(h); } };
}

test('pedido ok: vira saida com status e corpo, a entrada some e os cabeçalhos internos seguem', async () => {
  const s = await cenario();
  try {
    const { id } = pedido(s.h, { metodo: 'POST', rota: '/api/v1/ok?x=1', corpo: { texto: 'oi' } });
    await s.caixa.volta();
    const r = resposta(s.h, id);
    assert.deepEqual(r, { v: 1, id, status: 201, corpo: { ok: true, eco: '/api/v1/ok?x=1' } });
    assert.deepEqual(fs.readdirSync(entrada(s.h)), []);
    const visto = s.api.vistos[0];
    assert.equal(visto.metodo, 'POST');
    assert.equal(visto.url, '/api/v1/ok?x=1');
    assert.equal(visto.headers['x-dgclaw-caixa'], s.caixa.segredo);
    assert.equal(visto.headers['x-dgclaw-agente'], 'ana');
    assert.equal(visto.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(visto.corpo), { texto: 'oi' });
    const st = fs.statSync(path.join(saida(s.h), `${id}.json`));
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, UID);
    assert.equal(fs.statSync(saida(s.h)).mode & 0o777, 0o700);
    assert.doesNotMatch(s.cap.texto(), new RegExp(s.caixa.segredo), 'o segredo nunca vai para o log');
  } finally { await s.fim(); }
});

test('resposta que não é JSON volta como texto', async () => {
  const s = await cenario();
  try {
    const { id } = pedido(s.h, { rota: '/api/v1/texto/docs.md' });
    await s.caixa.volta();
    assert.deepEqual(resposta(s.h, id), { v: 1, id, status: 200, corpo: '# oi' });
  } finally { await s.fim(); }
});

test('pasta entrada/ que é atalho: recusada, nada fora dela é tocado', async () => {
  const s = await cenario();
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'caixa-fora-'));
  try {
    const id = 'pedido-fora-01';
    fs.writeFileSync(path.join(fora, `${id}.json`), JSON.stringify({ v: 1, id, metodo: 'GET', rota: '/api/v1/ok' }));
    fs.rmSync(entrada(s.h), { recursive: true });
    fs.symlinkSync(fora, entrada(s.h));
    await s.caixa.volta();
    assert.ok(fs.existsSync(path.join(fora, `${id}.json`)), 'o pedido de fora continua lá');
    assert.equal(s.api.vistos.length, 0);
    assert.match(s.cap.texto(), /\[aviso\] Caixa de ana: .*entrada é um atalho/);
  } finally { await s.fim(); limpa(fora); }
});

test('arquivo que é atalho: recusado com 403, o alvo fica intacto', async () => {
  const s = await cenario();
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'caixa-fora-'));
  try {
    const alvo = path.join(fora, 'segredo.txt');
    fs.writeFileSync(alvo, 'conteudo-secreto');
    const id = 'pedido-link-01';
    fs.symlinkSync(alvo, path.join(entrada(s.h), `${id}.json`));
    await s.caixa.volta();
    const r = resposta(s.h, id);
    assert.equal(r.status, 403);
    assert.match(r.corpo.erro, /não é um arquivo comum/);
    assert.equal(fs.readFileSync(alvo, 'utf8'), 'conteudo-secreto');
    assert.equal(s.api.vistos.length, 0);
    assert.match(s.cap.texto(), /não é um arquivo comum \(é um atalho\)/);
    assert.doesNotMatch(JSON.stringify(r), /conteudo-secreto/);
  } finally { await s.fim(); limpa(fora); }
});

test('arquivo com mais de 1 MB: 413', async () => {
  const s = await cenario();
  try {
    const { id } = pedido(s.h, null, { texto: JSON.stringify({ v: 1, id: 'x', lixo: 'a'.repeat(1024 * 1024 + 10) }), id: 'pedido-grande-01' });
    await s.caixa.volta();
    const r = resposta(s.h, id);
    assert.equal(r.status, 413);
    assert.match(r.corpo.erro, /1 MB/);
    assert.equal(s.api.vistos.length, 0);
  } finally { await s.fim(); }
});

test('JSON inválido e pedido mal formado: 400 explicando', async () => {
  const s = await cenario();
  try {
    const a = pedido(s.h, null, { texto: '{nao é json', id: 'pedido-ruim-01' });
    const b = pedido(s.h, { metodo: 'TRACE' });
    const c = pedido(s.h, { rota: '/outra/rota' });
    const d = pedido(s.h, { rota: '/api/v1/ok/../../x' });
    const e = pedido(s.h, null, { texto: JSON.stringify({ v: 1, id: 'outro-id-1234', metodo: 'GET', rota: '/api/v1/ok' }), id: 'pedido-id-errado' });
    await s.caixa.volta();
    assert.equal(resposta(s.h, a.id).status, 400);
    assert.match(resposta(s.h, a.id).corpo.erro, /não é um JSON válido/);
    assert.match(resposta(s.h, b.id).corpo.erro, /metodo/);
    assert.match(resposta(s.h, c.id).corpo.erro, /começando por \/api\/v1\//);
    assert.match(resposta(s.h, d.id).corpo.erro, /\.\./);
    assert.match(resposta(s.h, e.id).corpo.erro, /igual ao nome do arquivo/);
    for (const x of [a, b, c, d, e]) assert.equal(resposta(s.h, x.id).status, 400);
    assert.equal(s.api.vistos.length, 0);
  } finally { await s.fim(); }
});

test('rota fora dos prefixos liberados: 403 dizendo que não está liberada', async () => {
  const s = await cenario();
  try {
    const { id } = pedido(s.h, { rota: '/api/v1/cofre/chaves' });
    const { id: id2 } = pedido(s.h, { rota: '/api/v1/okay' });
    await s.caixa.volta();
    for (const i of [id, id2]) {
      const r = resposta(s.h, i);
      assert.equal(r.status, 403);
      assert.match(r.corpo.erro, /não está liberada para agentes/);
    }
    assert.equal(s.api.vistos.length, 0, 'prefixo é por pasta: /api/v1/okay não casa com /api/v1/ok');
  } finally { await s.fim(); }
});

test('teto de 120 pedidos por minuto: o 121º volta 429 com retryAfter', async () => {
  const s = await cenario();
  try {
    const ids = [];
    for (let i = 0; i < 121; i++) ids.push(pedido(s.h, {}).id);
    for (let v = 0; v < 8; v++) await s.caixa.volta();
    const status = ids.map((i) => resposta(s.h, i).status);
    assert.equal(status.filter((x) => x === 201).length, 120);
    const barrados = ids.map((i) => resposta(s.h, i)).filter((r) => r.status === 429);
    assert.equal(barrados.length, 1);
    assert.equal(barrados[0].corpo.ok, false);
    assert.ok(barrados[0].corpo.retryAfter >= 1 && barrados[0].corpo.retryAfter <= 60);
    assert.match(barrados[0].corpo.erro, /120 por minuto/);
    s.relogio.t += 61000;
    const { id } = pedido(s.h, {});
    await s.caixa.volta();
    assert.equal(resposta(s.h, id).status, 201, 'passado o minuto, volta a atender');
  } finally { await s.fim(); }
});

test('no máximo 20 pedidos por volta', async () => {
  const s = await cenario();
  try {
    for (let i = 0; i < 25; i++) pedido(s.h, {});
    await s.caixa.volta();
    assert.equal(fs.readdirSync(saida(s.h)).length, 20);
    assert.equal(fs.readdirSync(entrada(s.h)).length, 5);
  } finally { await s.fim(); }
});

test('pedido com mais de 5 minutos: 408 e linha no log', async () => {
  const s = await cenario();
  try {
    const { id, arq } = pedido(s.h, {});
    const velho = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(arq, velho, velho);
    await s.caixa.volta();
    const r = resposta(s.h, id);
    assert.equal(r.status, 408);
    assert.match(r.corpo.erro, /5 minutos/);
    assert.match(s.cap.texto(), /esperou mais de 5 minutos/);
    assert.equal(s.api.vistos.length, 0);
  } finally { await s.fim(); }
});

test('nome que não segue o padrão ou começa com ponto é ignorado', async () => {
  const s = await cenario();
  try {
    for (const nome of ['.pedido-oculto-01.json', 'curto.json', 'Maiusculo-01234.json', 'pedido-ok-0001.txt']) {
      fs.writeFileSync(path.join(entrada(s.h), nome), '{}'); dar(path.join(entrada(s.h), nome));
    }
    await s.caixa.volta();
    assert.equal(fs.readdirSync(entrada(s.h)).length, 4);
    assert.equal(fs.existsSync(saida(s.h)), false);
  } finally { await s.fim(); }
});

test('falha da API interna vira 502 explicado', async () => {
  const s = await cenario();
  try {
    await s.api.fechar();
    const { id } = pedido(s.h, {});
    await s.caixa.volta();
    const r = resposta(s.h, id);
    assert.equal(r.status, 502);
    assert.match(r.corpo.erro, /Tente de novo/);
    assert.match(s.cap.texto(), /\[erro\] Caixa de ana: a chamada interna GET \/api\/v1\/ok falhou/);
    s.api.fechar = async () => {};
  } finally { await s.fim(); }
});

test('casa de root é recusada, com um aviso só', { skip: !souRoot }, async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'caixa-root-'));
  fs.mkdirSync(path.join(h, '.dgclaw', 'caixa', 'entrada'), { recursive: true });
  const s = await cenario({ home: h });
  try {
    const { id } = pedido(s.h, {});
    await s.caixa.volta(); await s.caixa.volta();
    assert.equal(fs.existsSync(path.join(saida(s.h), `${id}.json`)), false);
    assert.equal(s.api.vistos.length, 0);
    assert.equal((s.cap.texto().match(/pertence ao root/g) || []).length, 1);
  } finally { await s.fim(); }
});

test('quemChamou separa dono e agente', () => {
  assert.deepEqual(quemChamou({ usuario: 'danilo' }), { tipo: 'dono', usuario: 'danilo' });
  assert.deepEqual(quemChamou({ usuario: 'agente:luna', via: 'caixa', agente: 'luna' }), { tipo: 'agente', slug: 'luna' });
});

test('gravaRetrato e gravaNaCasa: gravam 0600 no dono da casa e recusam caminho ruim', async () => {
  const s = await cenario();
  try {
    const r = s.caixa.gravaRetrato('ana', 'foco', { tarefa: 'x' });
    const arq = path.join(s.h, '.dgclaw', 'retratos', 'foco.json');
    assert.equal(r.caminho, fs.realpathSync(arq));
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    assert.equal(j.tarefa, 'x');
    assert.ok(!Number.isNaN(Date.parse(j.atualizado_em)));
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    assert.equal(fs.statSync(arq).uid, UID);
    assert.equal(fs.statSync(path.dirname(arq)).mode & 0o777, 0o700);
    s.caixa.gravaNaCasa(s.agentes[0], 'a/b/c.json', { v: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.h, '.dgclaw', 'a', 'b', 'c.json'), 'utf8')), { v: 1 });
    for (const ruim of ['../fora.json', 'a/../b.json', '/abs.json', 'A.json', 'a//b.json', '', '.oculto', 'a/.b']) {
      assert.throws(() => s.caixa.gravaNaCasa('ana', ruim, {}), (e) => e instanceof ErroGravacao && /não vale/.test(e.message), ruim);
    }
    for (const ruim of ['../x', 'Foco', 'a/b', '', 'x'.repeat(41)]) {
      assert.throws(() => s.caixa.gravaRetrato('ana', ruim, {}), (e) => e instanceof ErroGravacao, ruim);
    }
    assert.throws(() => s.caixa.gravaRetrato('naoexiste', 'foco', {}), (e) => e instanceof ErroGravacao && /Não achei a casa/.test(e.message));
  } finally { await s.fim(); }
});

test('gravaNaCasa recusa pasta que é atalho e não escreve fora da casa', async () => {
  const s = await cenario();
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'caixa-fora-'));
  try {
    fs.symlinkSync(fora, path.join(s.h, '.dgclaw', 'retratos'));
    assert.throws(() => s.caixa.gravaRetrato('ana', 'foco', { a: 1 }), (e) => e instanceof ErroGravacao && e.code === 'ATALHO');
    assert.deepEqual(fs.readdirSync(fora), []);
  } finally { await s.fim(); limpa(fora); }
});

// ── dentro do servidor de verdade ────────────────────────────────────────────
async function esperarArquivo(arq, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (fs.existsSync(arq)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function pedirCru(porta, metodo, caminho, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json = null; try { json = JSON.parse(texto); } catch (_) { /* texto */ }
        resolve({ status: res.statusCode, texto, json });
      });
    });
    req.on('error', reject);
    req.end(metodo === 'POST' ? '{}' : undefined);
  });
}

test('servidor: a volta de 1 s atende a caixa, a sessão é do agente e Origin não é exigido dela', async () => {
  const h = casa();
  const t = await subirWeb({ agentes: [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'a1', home_host: h }] });
  try {
    t.web.caixa.permitir('/api/v1/push');
    const { id } = pedido(h, { rota: '/api/v1/push/docs.md' });
    assert.ok(await esperarArquivo(path.join(saida(h), `${id}.json`), 4000), 'a resposta apareceu sozinha');
    const r = resposta(h, id);
    assert.equal(r.status, 200);
    assert.match(r.corpo, /Avisos no aparelho/);

    const seg = t.web.caixa.segredo;
    const cab = { 'X-DGClaw-Caixa': seg, 'X-DGClaw-Agente': 'ana', 'Content-Type': 'application/json' };
    // Caixa: POST sem Origin passa pelo CSRF e chega ao push, que recusa agente.
    const dagente = await pedirCru(t.porta, 'POST', '/api/v1/push/teste', cab);
    assert.equal(dagente.status, 403);
    assert.match(dagente.json.erro, /são do dono/);
    // Navegador (sem cabeçalho da caixa): o CSRF barra por falta de Origin.
    const navegador = await pedirCru(t.porta, 'POST', '/api/v1/push/teste', { 'Content-Type': 'application/json' });
    assert.equal(navegador.status, 403);
    assert.match(navegador.json.erro, /origem/);
    // A documentação do cofre é liberada só no caminho exato; o cofre em si não.
    const docsCofre = await pedirCru(t.porta, 'GET', '/api/v1/cofre/docs.md', cab);
    assert.equal(docsCofre.status, 200);
    assert.match(docsCofre.texto, /cofre/i);
    assert.equal((await pedirCru(t.porta, 'GET', '/api/v1/cofre', cab)).status, 403);
    // Rota que ninguém liberou, e fora de /api/.
    assert.match((await pedirCru(t.porta, 'GET', '/api/v1/eu', cab)).json.erro, /não está liberada para agentes/);
    assert.equal((await pedirCru(t.porta, 'GET', '/login', cab)).status, 403);
    assert.equal((await pedirCru(t.porta, 'POST', '/sair', cab)).status, 403);
    // Segredo errado, ou agente que não existe (ou é o admin): nunca vira sessão da caixa.
    assert.equal((await pedirCru(t.porta, 'GET', '/api/v1/push/chave', Object.assign({}, cab, { 'X-DGClaw-Caixa': 'errado' }))).status, 401);
    assert.equal((await pedirCru(t.porta, 'GET', '/api/v1/push/chave', Object.assign({}, cab, { 'X-DGClaw-Agente': 'fantasma' }))).status, 401);
    assert.equal((await pedirCru(t.porta, 'GET', '/api/v1/push/chave', Object.assign({}, cab, { 'X-DGClaw-Agente': 'admin' }))).status, 401);
    assert.equal((await pedirCru(t.porta, 'GET', '/api/v1/push/chave', {})).status, 401);
  } finally { await t.fechar(); limpa(h); }
});
