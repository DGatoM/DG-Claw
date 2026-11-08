'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, cliente, pastaTemp } = require('./ajuda');

const AG = [{ slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'a1' }];
const PW = 'uma-frase-bem-longa-1';

/** Sobe um Web sem senha e grava o primeiro-acesso.json conforme o contrato. */
async function cenario() {
  const dir = pastaTemp('pa');
  const webEnv = path.join(dir, 'web.env');
  fs.writeFileSync(webEnv, "DGCLAW_PANEL_USER=maria\nDGCLAW_PANEL_PASSWORD_HASH=''\nOUTRA=valor\n", { mode: 0o600 });
  let agora = 1_800_000_000_000;
  const t = await subirWeb({ agentes: AG, semHash: true, env: { DGCLAW_PANEL_USER: 'maria', DGCLAW_WEB_ENV: webEnv }, opcoesServidor: { agora: () => agora } });
  fs.writeFileSync(path.join(t.publico, 'primeiro-acesso.html'), '<html>primeiro acesso de teste</html>');
  const token = crypto.randomBytes(32).toString('base64url');
  const arq = path.join(dir, 'primeiro-acesso.json');
  const escreve = (extra) => fs.writeFileSync(arq, JSON.stringify(Object.assign({
    versao: 1, usuario: 'maria', token_sha256: crypto.createHash('sha256').update(token).digest('hex'),
    criado: agora, expira: agora + 30 * 60 * 1000, usado_em: null,
  }, extra || {})) + '\n', { mode: 0o600 });
  escreve();
  return { t, token, webEnv, arq, escreve, avanca: (ms) => { agora += ms; }, post: (corpo) => t.c.post('/api/primeiro-acesso', { json: corpo }) };
}

test('primeiro acesso: token valido cadastra a senha, grava o scrypt no web.env e abre a sessao', async () => {
  const x = await cenario();
  try {
    const est = await x.t.c.get('/api/login-estado');
    assert.equal(est.json.sem_senha, true); assert.equal(est.json.usuario, 'maria');
    assert.match(est.json.mensagem, /sudo dgclaw primeiro-acesso/);
    assert.equal((await x.t.c.get('/primeiro-acesso')).status, 200);

    const r = await x.post({ token: x.token, senha: PW, confirmacao: PW });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, destino: '/a/admin' });
    assert.match(r.headers['set-cookie'][0], /^dgclaw_sessao=/);
    const env = fs.readFileSync(x.webEnv, 'utf8');
    assert.match(env, /^DGCLAW_PANEL_PASSWORD_HASH='scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+'$/m);
    assert.match(env, /OUTRA=valor/); assert.match(env, /DGCLAW_PANEL_USER=maria/);
    assert.equal(fs.statSync(x.webEnv).mode & 0o777, 0o600);
    assert.notEqual(JSON.parse(fs.readFileSync(x.arq, 'utf8')).usado_em, null);
    assert.equal((await x.t.c.get('/a/admin')).status, 200);
    assert.deepEqual((await x.t.c.get('/api/v1/eu')).json, { ok: true, usuario: 'maria', papel: 'dono', agente: null, nome: '', trocar_senha: false });
    const log = x.t.log.texto();
    assert.ok(!log.includes(x.token) && !log.includes(PW));

    // login normal com a senha nova
    const outro = cliente(x.t.porta);
    assert.equal((await outro.post('/login', { json: { usuario: 'maria', senha: PW } })).status, 200);
    assert.equal((await x.t.c.get('/api/login-estado')).json.sem_senha, false);

    // reuso
    const re = await x.post({ token: x.token, senha: PW, confirmacao: PW });
    assert.equal(re.status, 410); assert.match(re.json.erro, /já foi usado/);
  } finally { await x.t.fechar(); }
});

test('primeiro acesso: token usado (usado_em preenchido) e expirado dao 410', async () => {
  const x = await cenario();
  try {
    x.escreve({ usado_em: 1 });
    let r = await x.post({ token: x.token, senha: PW, confirmacao: PW });
    assert.equal(r.status, 410); assert.match(r.json.erro, /já foi usado/);
    x.escreve();
    x.avanca(31 * 60 * 1000);
    r = await x.post({ token: x.token, senha: PW, confirmacao: PW });
    assert.equal(r.status, 410); assert.match(r.json.erro, /expirou/);
  } finally { await x.t.fechar(); }
});

test('primeiro acesso: senhas diferentes ou curtas dao 400 e o token continua valendo', async () => {
  const x = await cenario();
  try {
    let r = await x.post({ token: x.token, senha: PW, confirmacao: PW + 'x' });
    assert.equal(r.status, 400); assert.match(r.json.erro, /não conferem/);
    r = await x.post({ token: x.token, senha: 'curta', confirmacao: 'curta' });
    assert.equal(r.status, 400); assert.match(r.json.erro, /pelo menos 12 caracteres \(a sua tem 5\)/);
    assert.equal(JSON.parse(fs.readFileSync(x.arq, 'utf8')).usado_em, null);
    r = await x.post({ token: x.token, senha: PW, confirmacao: PW });
    assert.equal(r.status, 200);
  } finally { await x.t.fechar(); }
});

test('primeiro acesso: token errado 403, incompleto 400, arquivo ausente 404', async () => {
  const x = await cenario();
  try {
    const errado = crypto.randomBytes(32).toString('base64url');
    let r = await x.post({ token: errado, senha: PW, confirmacao: PW });
    assert.equal(r.status, 403); assert.match(r.json.erro, /Gere outro com: sudo dgclaw primeiro-acesso/);
    r = await x.post({ token: x.token.slice(0, 20), senha: PW, confirmacao: PW });
    assert.equal(r.status, 400); assert.match(r.json.erro, /incompleto/);
    fs.unlinkSync(x.arq);
    r = await x.post({ token: x.token, senha: PW, confirmacao: PW });
    assert.equal(r.status, 404); assert.match(r.json.erro, /não vale mais/);
  } finally { await x.t.fechar(); }
});

test('primeiro acesso: a 11a tentativa no mesmo IP dentro de 10 min leva 429', async () => {
  const x = await cenario();
  try {
    const errado = crypto.randomBytes(32).toString('base64url');
    for (let i = 0; i < 10; i++) assert.equal((await x.post({ token: errado, senha: PW, confirmacao: PW })).status, 403);
    const r = await x.post({ token: errado, senha: PW, confirmacao: PW });
    assert.equal(r.status, 429); assert.match(r.json.erro, /Muitas tentativas\. Tente de novo em \d+ min\./);
  } finally { await x.t.fechar(); }
});

test('primeiro acesso: exige a mesma checagem de origem do login', async () => {
  const x = await cenario();
  try {
    const r = await x.t.c.post('/api/primeiro-acesso', { json: { token: x.token, senha: PW, confirmacao: PW }, origin: 'http://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(fs.readFileSync(x.arq, 'utf8')).usado_em, null);
  } finally { await x.t.fechar(); }
});

test('auth.gerarHash produz hash aceito por verificaSenha', async () => {
  const x = await cenario();
  try {
    const h = await x.t.web.auth.gerarHash(PW);
    assert.equal(x.t.web.auth.definirHash(h).ok, true);
    assert.equal((await x.t.web.auth.verificaSenha('maria', PW, '1.2.3.4')).ok, true);
    assert.equal((await x.t.web.auth.verificaSenha('maria', 'errada-errada', '1.2.3.4')).ok, false);
    assert.equal(x.t.web.auth.definirHash('lixo').ok, false);
  } finally { await x.t.fechar(); }
});
