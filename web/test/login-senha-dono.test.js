'use strict';
// Login do dono sem diferença de maiúscula e espaços no usuário, motivo da recusa no log, e troca da senha do dono pelo painel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, cliente, pastaTemp } = require('./ajuda');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');

const AG = [{ slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'a1' }];
const NOVA = 'outra-frase-bem-longa-9';

async function comWebEnv(extra) {
  const dir = pastaTemp('sd');
  const webEnv = path.join(dir, 'web.env');
  fs.writeFileSync(webEnv, "DGCLAW_PANEL_USER=Mariana\nDGCLAW_PANEL_PASSWORD_HASH='velho'\nLINHA_ALHEIA=preciso-sobreviver # comentario\nDGCLAW_OUTRA='x y'\n", { mode: 0o600 });
  const t = await subirWeb(Object.assign({ agentes: AG, env: { DGCLAW_PANEL_USER: 'Mariana', DGCLAW_WEB_ENV: webEnv } }, extra || {}));
  return { t, webEnv };
}
const login = (c, usuario, senha) => c.post('/login', { json: { usuario, senha } });

test('login do dono: maiúscula e espaços nas pontas do usuário não impedem a entrada; a senha continua exata', async () => {
  const { t } = await comWebEnv();
  try {
    for (const u of ['Mariana ', 'MARIANA', ' mariana', 'mariana']) {
      const r = await login(cliente(t.porta), u, t.senha);
      assert.equal(r.status, 200, `usuário "${u}": ${r.texto}`);
    }
    const errada = await login(cliente(t.porta), 'Mariana', t.senha.toUpperCase());
    assert.equal(errada.status, 401);
    assert.equal(errada.json.erro, 'Usuário ou senha incorretos.');
    const outro = await login(cliente(t.porta), 'Mariana2', t.senha);
    assert.equal(outro.status, 401);
  } finally { await t.fechar(); }
});

test('login do dono: o log diz qual campo não conferiu, sem registrar o que foi digitado', async () => {
  const { t } = await comWebEnv();
  try {
    assert.equal((await login(cliente(t.porta), 'quemsera-xyz', t.senha)).status, 401);
    assert.equal((await login(cliente(t.porta), 'Mariana', 'senha-digitada-errada')).status, 401);
    const log = t.log.texto();
    assert.match(log, /usuário não confere/);
    assert.match(log, /senha não confere/);
    assert.ok(!log.includes('quemsera-xyz') && !log.includes('senha-digitada-errada') && !log.includes(t.senha));
  } finally { await t.fechar(); }
});

test('login por formulário: o bloqueio por tentativas leva os minutos que faltam para a tela', async () => {
  const { t } = await comWebEnv();
  try {
    for (let i = 0; i < 5; i += 1) await login(t.c, 'Mariana', `x${i}`);
    const r = await t.c.post('/login', { form: { usuario: 'Mariana', senha: 'x' } });
    assert.equal(r.status, 302);
    assert.match(r.headers.location, /^\/login\?erro=limite&espera=\d+&usuario=Mariana$/);
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.js'), 'utf8');
    assert.match(js, /get\('espera'\)/);
  } finally { await t.fechar(); }
});

test('colaborador continua entrando com o e-mail normalizado', async () => {
  const s = await cenario();
  try {
    const { c, email, nova } = await colaboradorAtivo(s);
    const r = await login(cliente(s.t.porta), email.toUpperCase() + ' ', nova);
    assert.equal(r.status, 200, r.texto);
    assert.equal((await c.get('/api/v1/eu')).json.papel, 'colaborador');
  } finally { await s.fechar(); }
});

test('troca de senha do dono: exige a atual, grava só o hash no web.env, derruba as outras sessões e mantém esta', async () => {
  const { t, webEnv } = await comWebEnv();
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const outra = cliente(t.porta);
    await login(outra, 'Mariana', t.senha);
    assert.equal((await outra.get('/api/v1/eu')).status, 200);

    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, destino: '/' });
    assert.match(r.headers['set-cookie'][0], /^dgclaw_sessao=/);

    const env = fs.readFileSync(webEnv, 'utf8');
    assert.match(env, /^DGCLAW_PANEL_PASSWORD_HASH='scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+'$/m);
    assert.match(env, /^LINHA_ALHEIA=preciso-sobreviver # comentario$/m);
    assert.match(env, /^DGCLAW_OUTRA='x y'$/m);
    assert.match(env, /^DGCLAW_PANEL_USER=Mariana$/m);
    assert.equal(env.split('\n').filter((l) => l.startsWith('DGCLAW_PANEL_PASSWORD_HASH')).length, 1);
    assert.equal(fs.statSync(webEnv).mode & 0o777, 0o600);

    assert.equal((await t.c.get('/api/v1/eu')).status, 200, 'a sessão de quem trocou continua');
    assert.equal((await outra.get('/api/v1/eu')).status, 401, 'as outras sessões caíram');
    assert.equal((await login(cliente(t.porta), 'mariana', t.senha)).status, 401, 'a senha antiga não vale mais');
    assert.equal((await login(cliente(t.porta), 'mariana', NOVA)).status, 200);
    const log = t.log.texto();
    assert.ok(!log.includes(NOVA) && !log.includes(t.senha));
  } finally { await t.fechar(); }
});

test('troca de senha do dono: senha atual errada, regras de força e confirmação são recusadas sem gravar nada', async () => {
  const { t, webEnv } = await comWebEnv();
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const antes = fs.readFileSync(webEnv, 'utf8');
    const post = (json) => t.c.post('/api/v1/dono/senha', { json });
    assert.equal((await post({ atual: 'errada', nova: NOVA, confirmacao: NOVA })).status, 403);
    assert.equal((await post({ nova: NOVA, confirmacao: NOVA })).status, 400);
    assert.equal((await post({ atual: t.senha, nova: NOVA, confirmacao: NOVA + 'x' })).status, 400);
    const curta = await post({ atual: t.senha, nova: 'curta-11-ch', confirmacao: 'curta-11-ch' });
    assert.equal(curta.status, 400); assert.match(curta.json.erro, /pelo menos 12/);
    assert.equal((await post({ atual: t.senha, nova: t.senha, confirmacao: t.senha })).status, 400);
    assert.equal((await post({ atual: t.senha, nova: 'admin', confirmacao: 'admin' })).status, 400);
    assert.equal(fs.readFileSync(webEnv, 'utf8'), antes);
    assert.match(t.log.texto(), /senha atual não confere/);
  } finally { await t.fechar(); }
});

test('troca de senha do dono: erros da senha atual usam o limitador do login', async () => {
  const { t } = await comWebEnv();
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    for (let i = 0; i < 5; i += 1) assert.equal((await t.c.post('/api/v1/dono/senha', { json: { atual: `x${i}`, nova: NOVA, confirmacao: NOVA } })).status, 403);
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers['retry-after']) > 0);
  } finally { await t.fechar(); }
});

test('troca de senha do dono: sem sessão, origem de fora e método errado são recusados', async () => {
  const { t } = await comWebEnv();
  try {
    const corpo = { atual: t.senha, nova: NOVA, confirmacao: NOVA };
    assert.equal((await cliente(t.porta).post('/api/v1/dono/senha', { json: corpo })).status, 401);
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    assert.equal((await t.c.post('/api/v1/dono/senha', { json: corpo, origin: 'https://mal.com' })).status, 403);
    assert.equal((await t.c.get('/api/v1/dono/senha')).status, 405);
    assert.equal((await login(cliente(t.porta), 'mariana', t.senha)).status, 200, 'nada foi trocado');
  } finally { await t.fechar(); }
});

test('troca de senha do dono: colaborador não troca a senha do dono por esta rota', async () => {
  const s = await cenario();
  try {
    const { c, nova } = await colaboradorAtivo(s);
    const r = await c.post('/api/v1/dono/senha', { json: { atual: nova, nova: NOVA, confirmacao: NOVA } });
    assert.ok(r.status === 403, r.texto);
    assert.equal((await login(cliente(s.t.porta), 'dono', s.t.senha)).status, 200, 'a senha do dono não mudou');
  } finally { await s.fechar(); }
});

test('troca de senha do dono: o link de primeiro acesso pendente deixa de valer', async () => {
  const { t, webEnv } = await comWebEnv();
  try {
    const crypto = require('node:crypto');
    const token = crypto.randomBytes(32).toString('base64url');
    const agora = Date.now();
    fs.writeFileSync(path.join(path.dirname(webEnv), 'primeiro-acesso.json'), JSON.stringify({
      versao: 1, usuario: 'Mariana', token_sha256: crypto.createHash('sha256').update(token).digest('hex'),
      criado: agora, expira: agora + 30 * 60 * 1000, usado_em: null,
    }) + '\n', { mode: 0o600 });
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 200, r.texto);
    const outraSenha = 'terceira-frase-longa-7';
    const uso = await cliente(t.porta).post('/api/primeiro-acesso', { json: { token, senha: outraSenha, confirmacao: outraSenha } });
    assert.equal(uso.status, 410, uso.texto);
    assert.equal((await login(cliente(t.porta), 'mariana', NOVA)).status, 200, 'a senha da troca segue valendo');
  } finally { await t.fechar(); }
});

test('troca de senha do dono: se o link pendente não puder ser invalidado, a senha antiga continua valendo', async () => {
  const { t, webEnv } = await comWebEnv();
  try {
    // Um diretório cheio no lugar do arquivo faz o rm falhar com erro que não é ENOENT.
    const alvo = path.join(path.dirname(webEnv), 'primeiro-acesso.json');
    fs.mkdirSync(alvo); fs.writeFileSync(path.join(alvo, 'x'), '1');
    const antes = fs.readFileSync(webEnv, 'utf8');
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 500, r.texto);
    assert.match(r.json.erro, /link de recuperação pendente/);
    assert.equal(fs.readFileSync(webEnv, 'utf8'), antes);
    assert.equal((await login(cliente(t.porta), 'mariana', t.senha)).status, 200);
  } finally { await t.fechar(); }
});

test('troca de senha do dono: web.env com duas definições do hash fica com uma só e o login funciona ao recarregar', async () => {
  const dir = pastaTemp('sd2');
  const webEnv = path.join(dir, 'web.env');
  fs.writeFileSync(webEnv, "DGCLAW_PANEL_USER=Mariana\nDGCLAW_PANEL_PASSWORD_HASH='velho1'\nLINHA_ALHEIA=fica # c\nexport DGCLAW_PANEL_PASSWORD_HASH='velho2'\nFIM=1", { mode: 0o600 });
  const t = await subirWeb({ agentes: AG, env: { DGCLAW_PANEL_USER: 'Mariana', DGCLAW_WEB_ENV: webEnv } });
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 200, r.texto);
    const linhas = fs.readFileSync(webEnv, 'utf8').split('\n');
    assert.equal(linhas.filter((l) => l.includes('DGCLAW_PANEL_PASSWORD_HASH')).length, 1);
    assert.deepEqual(linhas.filter((l) => !l.includes('DGCLAW_PANEL_PASSWORD_HASH')), ['DGCLAW_PANEL_USER=Mariana', 'LINHA_ALHEIA=fica # c', 'FIM=1']);
    assert.ok(linhas[1].startsWith("DGCLAW_PANEL_PASSWORD_HASH='scrypt$"), 'a nova ficou no lugar da primeira');
    const { lerEnvArquivo } = require('../lib/config');
    const vars = lerEnvArquivo(webEnv).vars;
    const t2 = await subirWeb({ agentes: AG, env: { DGCLAW_PANEL_USER: 'Mariana', DGCLAW_PANEL_PASSWORD_HASH: vars.DGCLAW_PANEL_PASSWORD_HASH, DGCLAW_WEB_ENV: webEnv } });
    try { assert.equal((await login(cliente(t2.porta), 'Mariana', NOVA)).status, 200); } finally { await t2.fechar(); }
  } finally { await t.fechar(); }
});

test('troca de senha do dono: a mesma senha em forma composta e decomposta conta como igual', async () => {
  const { t } = await comWebEnv();
  try {
    const comp = 'senha-longa-ação-1234'.normalize('NFC');
    const decomp = comp.normalize('NFD');
    assert.notEqual(comp, decomp);
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    assert.equal((await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: comp, confirmacao: comp } })).status, 200);
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: decomp, nova: comp, confirmacao: decomp } });
    assert.equal(r.status, 400, r.texto); assert.match(r.json.erro, /diferente da atual/);
  } finally { await t.fechar(); }
});

test('troca de senha do dono: o proxy de WebSocket é revalidado na troca', async () => {
  const { t } = await comWebEnv();
  try {
    let chamadas = 0;
    const orig = t.web.proxy.revalidar;
    t.web.proxy.revalidar = () => { chamadas += 1; return orig(); };
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    assert.equal((await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } })).status, 200);
    assert.equal(chamadas, 1);
  } finally { await t.fechar(); }
});
