'use strict';
// Ferramenta de suporte (scripts/suporte/diagnostico-clientes.mjs) contra um servidor HTTP local falso.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'suporte', 'diagnostico-clientes.mjs');
// Montado em pedaços para o arquivo de teste não parecer uma chave de verdade.
const TOKEN = ['dgc', 'TokenDeTesteQueNuncaPodeAparecerNaSaida0123'].join('_');

function resposta(estado, itens) {
  return {
    ok: true, schema: 1, gerado_em: '2026-10-21T12:00:00Z', duracao_ms: 10,
    versao: { instalada: '1.0.0', commit: 'abc1234', publicada: '1.0.1', atualizacao_disponivel: true, commits_a_frente: 2, verificado_em: null },
    resumo: { estado, frase: estado === 'ok' ? 'Tudo certo: 3 itens conferidos.' : '1 item quebrado.', contagem: { ok: 2, atencao: 0, quebrado: estado === 'ok' ? 0 : 1, nao_medido: 0 } },
    verificacoes: itens,
  };
}

const ITEM_QUEBRADO = { id: 'agente.tina.container', grupo: 'agente', alvo: 'tina', nome: 'Container do agente Tina', estado: 'quebrado', ultimo_sinal: null,
  motivo: 'O container está parado desde 19/10 às 14h19.', evidencia: { horario: '2026-10-19T17:19:00Z', codigo_saida: 137, trecho: 'estado exited' },
  o_que_fazer: 'Cole o prompt na conversa do Admin.', prompt_sugerido: 'Oi, Admin. O container da Tina está parado. Rode dgclaw agente iniciar tina.' };

function servidor(tratador) {
  return new Promise((resolve) => {
    const s = http.createServer(tratador);
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

function rodar(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 30000 }, (err, stdout, stderr) => resolve({ codigo: err ? err.code : 0, stdout, stderr }));
  });
}

function lista(clientes, modo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'));
  const arq = path.join(dir, 'clientes.json');
  fs.writeFileSync(arq, JSON.stringify({ clientes }), { mode: modo || 0o600 });
  fs.chmodSync(arq, modo || 0o600);
  return { arq, limpa: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('relatório: cliente ok, cliente quebrado, erro de chave; token nunca aparece; saída 2 por causa do erro', async () => {
  const vistos = [];
  const bom = await servidor((req, res) => { vistos.push(req.headers.authorization); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(resposta('ok', []))); });
  const ruim = await servidor((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(resposta('quebrado', [ITEM_QUEBRADO]))); });
  const revogada = await servidor((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, erro: 'Chave revogada.' })); });
  const l = lista([{ nome: 'Bom', url: bom.url, token: TOKEN }, { nome: 'Ruim', url: ruim.url, token: TOKEN }, { nome: 'Revogado', url: revogada.url, token: TOKEN }]);
  const r = await rodar(['--arquivo', l.arq]);
  assert.equal(r.codigo, 2);
  assert.match(r.stdout, /Bom\s+Tudo certo/);
  assert.match(r.stdout, /Ruim\s+1 item quebrado/);
  assert.match(r.stdout, /versão 1\.0\.0 \(abc1234\) \| atualização disponível/);
  assert.match(r.stdout, /Container do agente Tina/);
  assert.match(r.stdout, /O que fazer: Cole o prompt/);
  assert.match(r.stdout, /Revogado\s+não consegui consultar/);
  assert.match(r.stdout, /revogou a chave/);
  assert.ok(!r.stdout.includes('estado exited'), 'sem --detalhe a evidência não aparece');
  assert.equal(vistos[0], `Bearer ${TOKEN}`);
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  for (const x of [bom, ruim, revogada]) x.s.close();
  l.limpa();
});

test('--detalhe mostra evidência e prompt; --cliente filtra; saída 1 quando há item quebrado', async () => {
  const ruim = await servidor((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(resposta('quebrado', [ITEM_QUEBRADO]))); });
  const l = lista([{ nome: 'Outro', url: 'http://127.0.0.1:9', token: TOKEN }, { nome: 'Ruim', url: ruim.url, token: TOKEN }]);
  const r = await rodar(['--arquivo', l.arq, '--cliente', 'ruim', '--detalhe']);
  assert.equal(r.codigo, 1);
  assert.match(r.stdout, /código de saída 137/);
  assert.match(r.stdout, /\| estado exited/);
  assert.match(r.stdout, /dgclaw agente iniciar tina/);
  assert.ok(!r.stdout.includes('Outro'));
  ruim.s.close();
  l.limpa();
});

test('saída 0 quando todos estão ok, e --json devolve o bruto combinado', async () => {
  const bom = await servidor((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(resposta('ok', []))); });
  const l = lista([{ nome: 'Bom', url: bom.url, token: TOKEN }]);
  const r = await rodar(['--arquivo', l.arq, '--json']);
  assert.equal(r.codigo, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j[0].cliente, 'Bom');
  assert.equal(j[0].resposta.schema, 1);
  assert.ok(!r.stdout.includes(TOKEN));
  bom.s.close();
  l.limpa();
});

test('403, 429 e 404 viram linhas que explicam o que fazer', async () => {
  const faz = (status) => servidor((req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, erro: 'x' })); });
  const [a, b, c] = await Promise.all([faz(403), faz(429), faz(404)]);
  const l = lista([{ nome: 'A', url: a.url, token: TOKEN }, { nome: 'B', url: b.url, token: TOKEN }, { nome: 'C', url: c.url, token: TOKEN }]);
  const r = await rodar(['--arquivo', l.arq]);
  assert.equal(r.codigo, 2);
  assert.match(r.stdout, /escopo diagnostico/);
  assert.match(r.stdout, /10 minutos/);
  assert.match(r.stdout, /peça para atualizar/);
  for (const x of [a, b, c]) x.s.close();
  l.limpa();
});

test('servidor fora do ar: erro de rede explicado, saída 2', async () => {
  const l = lista([{ nome: 'Fora', url: 'http://127.0.0.1:9', token: TOKEN }]);
  const r = await rodar(['--arquivo', l.arq]);
  assert.equal(r.codigo, 2);
  assert.match(r.stdout, /Fora\s+não consegui consultar/);
  assert.ok(!r.stdout.includes(TOKEN));
  l.limpa();
});

test('arquivo legível por outros é recusado com a instrução do chmod; token_arquivo funciona', async () => {
  const aberto = lista([{ nome: 'X', url: 'http://127.0.0.1:9', token: TOKEN }], 0o644);
  const r = await rodar(['--arquivo', aberto.arq]);
  assert.equal(r.codigo, 2);
  assert.match(r.stderr, /chmod 600/);
  assert.ok(!r.stderr.includes(TOKEN));
  aberto.limpa();

  const vistos = [];
  const bom = await servidor((req, res) => { vistos.push(req.headers.authorization); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(resposta('ok', []))); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'));
  const tokenArq = path.join(dir, 'x.token');
  fs.writeFileSync(tokenArq, `${TOKEN}\n`, { mode: 0o600 });
  const l = lista([{ nome: 'Bom', url: bom.url, token_arquivo: tokenArq }]);
  const r2 = await rodar(['--arquivo', l.arq]);
  assert.equal(r2.codigo, 0);
  assert.equal(vistos[0], `Bearer ${TOKEN}`);
  bom.s.close();
  l.limpa();
  fs.rmSync(dir, { recursive: true, force: true });
});
