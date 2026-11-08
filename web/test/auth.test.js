'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, cliente } = require('./ajuda');
const { proximoSeguro } = require('../server');

const AG = [{ slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'a1' }];

test('login: senha certa entra, cookie httpOnly/SameSite e só o hash do token no disco', async () => {
  const t = await subirWeb({ agentes: AG });
  try {
    const r = await t.c.post('/login', { json: { usuario: 'dono', senha: t.senha } });
    assert.equal(r.status, 200);
    const sc = r.headers['set-cookie'][0];
    assert.match(sc, /^dgclaw_sessao=[A-Za-z0-9_-]{43};/);
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Path=\//); assert.match(sc, /Max-Age=2592000/);
    assert.ok(!/Secure/.test(sc), 'sem X-Forwarded-Proto https não leva Secure');
    const eu = await t.c.get('/api/v1/eu');
    assert.deepEqual(eu.json, { ok: true, usuario: 'dono', papel: 'dono', agente: null, nome: '', trocar_senha: false });
    const token = sc.split(';')[0].split('=')[1];
    const arquivo = path.join(t.dados, 'sessoes.json');
    const salvo = fs.readFileSync(arquivo, 'utf8');
    assert.ok(!salvo.includes(token), 'o token nunca vai para o disco');
    assert.equal((fs.statSync(arquivo).mode & 0o777), 0o600);
    assert.equal((fs.statSync(t.dados).mode & 0o777), 0o700);
    assert.ok(!t.log.texto().includes(token) && !t.log.texto().includes(t.senha));
  } finally { await t.fechar(); }
});

test('login: senha errada e usuário errado dão 401 sem dizer qual dos dois', async () => {
  const t = await subirWeb({ agentes: AG });
  try {
    const a = await t.c.post('/login', { json: { usuario: 'dono', senha: 'errada' } });
    const b = await t.c.post('/login', { json: { usuario: 'outro', senha: t.senha } });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.json.erro, b.json.erro);
    assert.equal(a.json.ok, false);
    assert.ok(!a.headers['set-cookie']);
    assert.ok(!t.log.texto().includes('errada'), 'a senha digitada não aparece no log');
  } finally { await t.fechar(); }
});

test('login por formulário: erro volta para /login com o motivo e next só relativo', async () => {
  const t = await subirWeb({ agentes: AG });
  try {
    const r = await t.c.post('/login', { form: { usuario: 'dono', senha: 'x', next: '/a/admin' } });
    assert.equal(r.status, 302);
    assert.match(r.headers.location, /^\/login\?erro=credenciais&next=%2Fa%2Fadmin&usuario=dono$/);
    const vazio = await t.c.post('/login', { form: { usuario: '', senha: '' } });
    assert.equal(vazio.status, 302); assert.match(vazio.headers.location, /^\/login\?erro=campos/);
    const origem = await t.c.post('/login', { form: { usuario: 'dono', senha: t.senha }, origin: 'https://mal.com' });
    assert.equal(origem.status, 302); assert.match(origem.headers.location, /^\/login\?erro=origem/);
    assert.ok(!origem.headers['set-cookie'], 'origem recusada não cria sessão');
    const ok = await t.c.post('/login', { form: { usuario: 'dono', senha: t.senha, next: 'https://mal.com' } });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/');
    assert.equal(proximoSeguro('//mal.com'), '/');
    assert.equal(proximoSeguro('/\\mal.com'), '/');
    assert.equal(proximoSeguro('/a/ana?x=1'), '/a/ana?x=1');
    assert.equal(proximoSeguro('http://mal.com'), '/');
  } finally { await t.fechar(); }
});

test('login: 5 erros por IP em 15 min viram 429 com Retry-After, até com a senha certa', async () => {
  const t = await subirWeb({ agentes: AG });
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await t.c.post('/login', { json: { usuario: 'dono', senha: `x${i}` } })).status, 401);
    const r = await t.c.post('/login', { json: { usuario: 'dono', senha: t.senha } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers['retry-after']) > 0);
    assert.match(r.json.erro, /tentativas/);
    const form = await t.c.post('/login', { form: { usuario: 'dono', senha: t.senha } });
    assert.equal(form.status, 302); assert.match(form.headers.location, /^\/login\?erro=limite/);
  } finally { await t.fechar(); }
});

test('login: X-Forwarded-For só vale vindo de 127.0.0.1 (último valor) e separa os IPs', async () => {
  const t = await subirWeb({ agentes: AG });
  try {
    for (let i = 0; i < 5; i += 1) await t.c.post('/login', { json: { usuario: 'dono', senha: 'x' }, headers: { 'X-Forwarded-For': '9.9.9.9, 1.1.1.1' } });
    const bloqueado = await t.c.post('/login', { json: { usuario: 'dono', senha: t.senha }, headers: { 'X-Forwarded-For': '8.8.8.8, 1.1.1.1' } });
    assert.equal(bloqueado.status, 429, 'o último valor (1.1.1.1) é quem conta, o resto o cliente pode inventar');
    const outro = await t.c.post('/login', { json: { usuario: 'dono', senha: t.senha }, headers: { 'X-Forwarded-For': '2.2.2.2' } });
    assert.equal(outro.status, 200, 'outro IP não é afetado');
  } finally { await t.fechar(); }
});

test('login: modo trancado (sem hash) ninguém entra e a página explica', async () => {
  const t = await subirWeb({ agentes: AG, semHash: true });
  try {
    const form = await t.c.post('/login', { form: { usuario: 'dono', senha: 'qualquer' } });
    assert.equal(form.status, 302); assert.match(form.headers.location, /^\/login\?erro=bloqueado/);
    const r = await t.c.post('/login', { json: { usuario: 'dono', senha: 'qualquer' } });
    assert.equal(r.status, 403);
    assert.match(r.json.erro, /ainda não tem senha/);
    assert.match(r.json.erro, /primeiro acesso/);
    const estado = await t.c.get('/api/login-estado');
    assert.equal(estado.json.trancado, true);
    assert.equal(estado.json.sem_senha, true);
    assert.match(estado.json.mensagem, /sudo dgclaw primeiro-acesso/);
    assert.match(t.log.texto(), /primeiro acesso/);
    assert.equal((await t.c.get('/api/v1/eu')).status, 401);
  } finally { await t.fechar(); }
});

test('login: hash com N acima de 2^20 é recusado (modo trancado)', async () => {
  const t = await subirWeb({ agentes: AG, env: { DGCLAW_PANEL_PASSWORD_HASH: 'scrypt$2097152$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g' } });
  try {
    const r = await t.c.post('/login', { json: { usuario: 'dono', senha: 'x' } });
    assert.equal(r.status, 403);
    assert.match(t.log.texto(), /passa do limite/);
  } finally { await t.fechar(); }
});

test('cookie leva Secure quando o proxy local avisa X-Forwarded-Proto: https', async () => {
  const t = await subirWeb({ agentes: AG });
  try {
    const r = await t.c.post('/login', { json: { usuario: 'dono', senha: t.senha }, headers: { 'X-Forwarded-Proto': 'https', Origin: 'https://127.0.0.1' , Host: '127.0.0.1' }, origin: 'https://127.0.0.1' });
    assert.equal(r.status, 200, r.texto);
    assert.match(r.headers['set-cookie'][0], /; Secure/);
  } finally { await t.fechar(); }
});

test('sem sessão: página vira 302 para /login?next= e a API vira 401 JSON; /sair encerra', async () => {
  const t = await subirWeb({ agentes: AG });
  try {
    const p = await t.c.get('/a/admin');
    assert.equal(p.status, 302);
    assert.equal(p.headers.location, '/login?next=%2Fa%2Fadmin');
    const raiz = await t.c.get('/');
    assert.equal(raiz.status, 302);
    const a = await t.c.get('/api/v1/agents');
    assert.equal(a.status, 401);
    assert.equal(a.json.ok, false);
    assert.equal((await t.c.get('/conversa.html')).status, 302, 'html direto também pede login');
    assert.equal((await t.c.get('/app.js')).status, 200, 'js/css públicos servem sem sessão (a página de login precisa)');
    await t.login();
    assert.equal((await t.c.get('/')).headers.location, '/a/admin');
    const s = await t.c.post('/sair');
    assert.equal(s.status, 303);
    assert.equal((await t.c.get('/api/v1/eu')).status, 401, 'a sessão some do servidor');
  } finally { await t.fechar(); }
});

test('CSRF: escrita sem Origin igual à do Web leva 403, e DGCLAW_WEB_ORIGENS libera outra', async () => {
  const t = await subirWeb({ agentes: AG, env: { DGCLAW_WEB_ORIGENS: 'https://app.exemplo.com' } });
  try {
    const mal = await t.c.post('/login', { json: { usuario: 'dono', senha: t.senha }, origin: 'https://mal.com' });
    assert.equal(mal.status, 403);
    assert.match(mal.json.erro, /origem/);
    const sem = await t.c.post('/login', { json: { usuario: 'dono', senha: t.senha }, origin: false });
    assert.equal(sem.status, 403);
    const nula = await t.c.post('/login', { json: { usuario: 'dono', senha: t.senha }, origin: 'null' });
    assert.equal(nula.status, 403);
    const extra = await t.c.post('/login', { json: { usuario: 'dono', senha: t.senha }, origin: 'https://app.exemplo.com' });
    assert.equal(extra.status, 200);
    const send = await t.c.post('/api/v1/agents/admin/send', { json: { text: 'oi' }, origin: 'https://mal.com' });
    assert.equal(send.status, 403);
  } finally { await t.fechar(); }
});

test('estáticos: sem listar pasta e sem sair da pasta public', async () => {
  const t = await subirWeb({ agentes: AG });
  try {
    fs.writeFileSync(path.join(t.dir, 'segredo.txt'), 'nao pode');
    assert.equal((await t.c.get('/')).status, 302);
    assert.equal((await t.c.get('/..%2fsegredo.txt')).status, 404);
    assert.equal((await t.c.get('/%2e%2e/segredo.txt')).status, 404);
    assert.equal((await t.c.get('/%00')).status, 404);
    fs.mkdirSync(path.join(t.publico, 'img'));
    assert.equal((await t.c.get('/img/')).status, 404);
    fs.symlinkSync(path.join(t.dir, 'segredo.txt'), path.join(t.publico, 'atalho.txt'));
    assert.equal((await t.c.get('/atalho.txt')).status, 404, 'link simbólico para fora é recusado');
    const js = await t.c.get('/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    const et = await t.c.get('/app.js', { headers: { 'If-None-Match': js.headers.etag } });
    assert.equal(et.status, 304);
  } finally { await t.fechar(); }
});

// ── sessão amarrada à credencial (senha e usuário) ──────────────────────────
const os = require('node:os');
const { criarAuth, NOME_COOKIE } = require('../lib/auth');

async function ambienteAuth() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-auth-'));
  const logs = [];
  const log = (n, m) => logs.push([n, m]);
  const agora = () => 1_700_000_000_000;
  const mk = (usuario, hash) => criarAuth({ config: { env: { DGCLAW_PANEL_USER: usuario, DGCLAW_PANEL_PASSWORD_HASH: hash }, dataDir, sessaoDias: 30, proxiesConfiaveis: [] }, log, agora });
  const gerador = mk('dono', '');
  const hashA = await gerador.gerarHash('senha-a-12345');
  const hashB = await gerador.gerarHash('senha-b-12345');
  const pedido = (token) => ({ headers: { cookie: `${NOME_COOKIE}=${token}` }, socket: {} });
  return { dataDir, logs, mk, hashA, hashB, pedido, arquivo: path.join(dataDir, 'sessoes.json'), limpa: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('sessão: hash trocado entre restarts derruba a sessão e o arquivo fica sem ela', async () => {
  const e = await ambienteAuth();
  try {
    const a1 = e.mk('dono', e.hashA);
    const { token } = a1.criaSessao('dono');
    assert.ok(a1.sessaoDoPedido(e.pedido(token)));
    const a2 = e.mk('dono', e.hashA);
    assert.ok(a2.sessaoDoPedido(e.pedido(token)), 'mesmo hash após restart: continua valendo');
    const a3 = e.mk('dono', e.hashB);
    assert.equal(a3.sessaoDoPedido(e.pedido(token)), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(e.arquivo, 'utf8')).sessoes, {});
    assert.ok(e.logs.some(([n, m]) => n === 'info' && /1 sessão/.test(m) && /entrar de novo/.test(m)));
    assert.ok(!fs.readFileSync(e.arquivo, 'utf8').includes(e.hashA), 'o hash da senha não vai para o disco');
  } finally { e.limpa(); }
});

test('sessão: mudar só o usuário também derruba', async () => {
  const e = await ambienteAuth();
  try {
    const { token } = e.mk('dono', e.hashA).criaSessao('dono');
    assert.equal(e.mk('outro', e.hashA).sessaoDoPedido(e.pedido(token)), null);
  } finally { e.limpa(); }
});

test('sessão: sessoes.json antigo, sem marca, é descartado no carregamento', async () => {
  const e = await ambienteAuth();
  try {
    const token = 'tokenantigo';
    const k = crypto.createHash('sha256').update(token).digest('hex');
    fs.writeFileSync(e.arquivo, JSON.stringify({ versao: 1, sessoes: { [k]: { usuario: 'dono', criada: 1, expira: 1_700_000_000_000 + 1e9 } } }));
    const a = e.mk('dono', e.hashA);
    assert.equal(a.sessaoDoPedido(e.pedido(token)), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(e.arquivo, 'utf8')).sessoes, {});
  } finally { e.limpa(); }
});

test('sessão: definirHash derruba as existentes e a criada depois vale', async () => {
  const e = await ambienteAuth();
  try {
    const a = e.mk('dono', e.hashA);
    const velha = a.criaSessao('dono');
    assert.equal(a.definirHash(e.hashB).ok, true);
    assert.equal(a.sessaoDoPedido(e.pedido(velha.token)), null);
    const nova = a.criaSessao('dono');
    assert.ok(a.sessaoDoPedido(e.pedido(nova.token)));
    assert.ok(e.mk('dono', e.hashB).sessaoDoPedido(e.pedido(nova.token)), 'e sobrevive ao restart com o hash novo');
  } finally { e.limpa(); }
});

test('sessão: painel sem senha ainda não lança e o primeiro acesso cria sessão válida', async () => {
  const e = await ambienteAuth();
  try {
    const a = e.mk('dono', '');
    assert.equal(a.semSenha, true);
    assert.equal(a.sessaoDoPedido(e.pedido('qualquer')), null);
    assert.equal(a.definirHash(e.hashA).ok, true);
    const s = a.criaSessao('dono');
    assert.ok(a.sessaoDoPedido(e.pedido(s.token)));
  } finally { e.limpa(); }
});
void cliente;
