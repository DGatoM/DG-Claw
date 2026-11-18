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
  fs.writeFileSync(webEnv, "DGCLAW_PANEL_USER=Cassio\nDGCLAW_PANEL_PASSWORD_HASH='velho'\nLINHA_ALHEIA=preciso-sobreviver # comentario\nDGCLAW_OUTRA='x y'\n", { mode: 0o600 });
  const t = await subirWeb(Object.assign({ agentes: AG, env: { DGCLAW_PANEL_USER: 'Cassio', DGCLAW_WEB_ENV: webEnv } }, extra || {}));
  return { t, webEnv };
}
const login = (c, usuario, senha) => c.post('/login', { json: { usuario, senha } });

test('login do dono: maiúscula e espaços nas pontas do usuário não impedem a entrada; a senha continua exata', async () => {
  const { t } = await comWebEnv();
  try {
    for (const u of ['Cassio ', 'CASSIO', ' cassio', 'cassio']) {
      const r = await login(cliente(t.porta), u, t.senha);
      assert.equal(r.status, 200, `usuário "${u}": ${r.texto}`);
    }
    const errada = await login(cliente(t.porta), 'Cassio', t.senha.toUpperCase());
    assert.equal(errada.status, 401);
    assert.equal(errada.json.erro, 'Usuário ou senha incorretos.');
    const outro = await login(cliente(t.porta), 'Cassio2', t.senha);
    assert.equal(outro.status, 401);
  } finally { await t.fechar(); }
});

test('login do dono: o log diz qual campo não conferiu, sem registrar o que foi digitado', async () => {
  const { t } = await comWebEnv();
  try {
    assert.equal((await login(cliente(t.porta), 'quemsera-xyz', t.senha)).status, 401);
    assert.equal((await login(cliente(t.porta), 'Cassio', 'senha-digitada-errada')).status, 401);
    const log = t.log.texto();
    assert.match(log, /usuário não confere/);
    assert.match(log, /senha não confere/);
    assert.ok(!log.includes('quemsera-xyz') && !log.includes('senha-digitada-errada') && !log.includes(t.senha));
  } finally { await t.fechar(); }
});

test('login por formulário: o bloqueio por tentativas leva os minutos que faltam para a tela', async () => {
  const { t } = await comWebEnv();
  try {
    for (let i = 0; i < 5; i += 1) await login(t.c, 'Cassio', `x${i}`);
    const r = await t.c.post('/login', { form: { usuario: 'Cassio', senha: 'x' } });
    assert.equal(r.status, 302);
    assert.match(r.headers.location, /^\/login\?erro=limite&espera=\d+&usuario=Cassio$/);
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
    assert.equal((await login(t.c, 'Cassio', t.senha)).status, 200);
    const outra = cliente(t.porta);
    await login(outra, 'Cassio', t.senha);
    assert.equal((await outra.get('/api/v1/eu')).status, 200);

    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, destino: '/' });
    assert.match(r.headers['set-cookie'][0], /^dgclaw_sessao=/);

    const env = fs.readFileSync(webEnv, 'utf8');
    assert.match(env, /^DGCLAW_PANEL_PASSWORD_HASH='scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+'$/m);
    assert.match(env, /^LINHA_ALHEIA=preciso-sobreviver # comentario$/m);
    assert.match(env, /^DGCLAW_OUTRA='x y'$/m);
    assert.match(env, /^DGCLAW_PANEL_USER=Cassio$/m);
    assert.equal(env.split('\n').filter((l) => l.startsWith('DGCLAW_PANEL_PASSWORD_HASH')).length, 1);
    assert.equal(fs.statSync(webEnv).mode & 0o777, 0o600);

    assert.equal((await t.c.get('/api/v1/eu')).status, 200, 'a sessão de quem trocou continua');
    assert.equal((await outra.get('/api/v1/eu')).status, 401, 'as outras sessões caíram');
    assert.equal((await login(cliente(t.porta), 'cassio', t.senha)).status, 401, 'a senha antiga não vale mais');
    assert.equal((await login(cliente(t.porta), 'cassio', NOVA)).status, 200);
    const log = t.log.texto();
    assert.ok(!log.includes(NOVA) && !log.includes(t.senha));
  } finally { await t.fechar(); }
});

test('troca de senha do dono: senha atual errada, regras de força e confirmação são recusadas sem gravar nada', async () => {
  const { t, webEnv } = await comWebEnv();
  try {
    assert.equal((await login(t.c, 'Cassio', t.senha)).status, 200);
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
    assert.equal((await login(t.c, 'Cassio', t.senha)).status, 200);
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
    assert.equal((await login(t.c, 'Cassio', t.senha)).status, 200);
    assert.equal((await t.c.post('/api/v1/dono/senha', { json: corpo, origin: 'https://mal.com' })).status, 403);
    assert.equal((await t.c.get('/api/v1/dono/senha')).status, 405);
    assert.equal((await login(cliente(t.porta), 'cassio', t.senha)).status, 200, 'nada foi trocado');
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
