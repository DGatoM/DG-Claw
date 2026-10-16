'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { ehToken, gravaComoAgente, criaInterceptor } = require('../lib/token-telegram');

const ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const NOBODY = 65534;

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x9';
const FINAL = TOKEN.slice(-4);

/** Gravador falso: grava de verdade em <home>/.dgclaw/telegram/.env e registra o que recebeu. */
function gravadorFalso() {
  const chamadas = [];
  const grava = async ({ token, home, uid, gid }) => {
    chamadas.push({ home, uid, gid, conteudo: `TELEGRAM_BOT_TOKEN=${token}\n` });
    const d = path.join(home, '.dgclaw', 'telegram'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`, { mode: 0o600 });
  };
  return { grava, chamadas };
}

/** Pasta temporária que pertence a um usuário comum (o Web recusa casa do root). */
function casaDeAgente(prefixo) {
  const d = pastaTemp(prefixo);
  if (ROOT) { fs.chownSync(d, NOBODY, NOBODY); }
  return d;
}

async function cenario(opcoes) {
  const o = opcoes || {};
  const rAdmin = criarRunnerFalso({ agenteId: 'adm1', sessionId: 'sess-admin-0001' });
  const rAna = criarRunnerFalso({ agenteId: 'ana1', sessionId: 'sess-ana-00001' });
  const pAdmin = await rAdmin.ouvir(); const pAna = await rAna.ouvir();
  const home = casaDeAgente('home-ana');
  const agentes = [
    { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', chat_id: 'c_ana', home_host: o.homeInexistente ? path.join(home, 'nao-existe') : home, home_container: '/home/agente' },
    { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: `http://127.0.0.1:${pAdmin}`, agente_id: 'adm1', chat_id: 'c_admin', home_host: casaDeAgente('home-adm') },
  ];
  const g = gravadorFalso();
  return { rAdmin, rAna, home, agentes, g, o, pAdmin, pAna };
}

// subirWeb não conhece a opção gravaArquivoSeguro, então montamos o servidor aqui.
async function subir(opcoes) {
  const c = await cenario(opcoes);
  const { criarServidor } = require('../server');
  const { gerarHash, capturaLog, cliente } = require('./ajuda');
  const dir = pastaTemp('srv');
  const publico = path.join(dir, 'public'); fs.mkdirSync(publico, { recursive: true });
  fs.writeFileSync(path.join(publico, 'login.html'), '<html>x</html>');
  fs.writeFileSync(path.join(publico, 'conversa.html'), '<html>x</html>');
  const agentesPath = path.join(dir, 'agentes.json');
  fs.writeFileSync(agentesPath, JSON.stringify({ versao: 1, agentes: c.agentes }));
  const cap = capturaLog();
  const opcoesWeb = { env: { DGCLAW_PANEL_USER: 'dono', DGCLAW_PANEL_PASSWORD_HASH: gerarHash('senha-certa-123') }, agentesPath, dataDir: path.join(dir, 'dados'), publicDir: publico, log: cap.log, tz: 'America/Sao_Paulo', tickSseMs: 80 };
  if (!(opcoes && opcoes.gravadorReal)) opcoesWeb.gravaToken = c.g.grava;
  const web = criarServidor(opcoesWeb);
  const addr = await web.ouvir(0, '127.0.0.1');
  const cli = cliente(addr.port);
  const r = await cli.post('/login', { json: { usuario: 'dono', senha: 'senha-certa-123' } });
  assert.equal(r.status, 200);
  c.cli = cli; c.cap = cap;
  c.fechar = async () => { await web.fechar(); await c.rAdmin.fechar(); await c.rAna.fechar(); };
  return c;
}

/** Captura console.* durante o teste. */
function capturaConsole() {
  const saida = []; const orig = {};
  for (const k of ['log', 'error', 'warn', 'info']) { orig[k] = console[k]; console[k] = (...a) => saida.push(a.map(String).join(' ')); }
  const write = process.stdout.write.bind(process.stdout);
  const werr = process.stderr.write.bind(process.stderr);
  return { saida, volta() { for (const k of Object.keys(orig)) console[k] = orig[k]; process.stdout.write = write; process.stderr.write = werr; } };
}

const todosCorpos = (r) => JSON.stringify(r.rec.inputs);

test('ehToken: só vale a mensagem inteira', () => {
  assert.equal(ehToken(TOKEN), true);
  assert.equal(ehToken(`  ${TOKEN}\n`), true);
  assert.equal(ehToken(`aqui o token ${TOKEN}`), false);
  assert.equal(ehToken(`${TOKEN} obrigado`), false);
  assert.equal(ehToken('12345:curto'), false);
  assert.equal(ehToken(''), false);
});

test('token sozinho: gravado com o dono da casa, runner só recebe a frase mascarada, nada vaza', async () => {
  const cap = capturaConsole();
  const s = await subir();
  let r;
  try {
    r = await s.cli.post('/api/v1/agents/ana/send', { json: { text: `  ${TOKEN}  `, cliente_id: 'cid-token-0001' } });
    await new Promise((x) => setTimeout(x, 100));
  } finally { await s.fechar(); cap.volta(); }
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.token_guardado, true);
  assert.equal(r.json.mascarado, `123456789:••••••${FINAL}`);
  assert.ok(!r.texto.includes(TOKEN));
  // gravador
  assert.equal(s.g.chamadas.length, 1);
  const ch = s.g.chamadas[0];
  const st = fs.statSync(s.home);
  assert.equal(ch.home, s.home);
  assert.equal(ch.conteudo, `TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
  assert.equal(ch.uid, st.uid); assert.equal(ch.gid, st.gid);
  // runner
  assert.equal(s.rAna.rec.inputs.length, 1);
  assert.ok(!todosCorpos(s.rAna).includes(TOKEN));
  assert.ok(!todosCorpos(s.rAna).includes(TOKEN.split(':')[1]));
  assert.match(s.rAna.rec.inputs[0].text, new RegExp(`\\[token do Telegram guardado com segurança, final ${FINAL}\\]`));
  // logs
  assert.ok(!s.cap.texto().includes(TOKEN)); assert.ok(!s.cap.texto().includes(TOKEN.split(':')[1]));
  assert.ok(!cap.saida.join('\n').includes(TOKEN));
});

test('token com texto junto não é interceptado: segue o envio normal', async () => {
  const s = await subir();
  try {
    const r = await s.cli.post('/api/v1/agents/ana/send', { json: { text: `meu token é ${TOKEN}` } });
    assert.equal(r.status, 200);
    assert.equal(r.json.token_guardado, undefined);
    assert.equal(s.g.chamadas.length, 0);
    assert.equal(s.rAna.rec.inputs.length, 1);
  } finally { await s.fechar(); }
});

test('Admin recusa: 400, sem gravar e sem chamar o runner', async () => {
  const s = await subir();
  try {
    const r = await s.cli.post('/api/v1/agents/admin/send', { json: { text: TOKEN } });
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.erro, 'O Admin não tem canal externo. Abra a conversa do agente que vai usar o Telegram e cole o token lá.');
    assert.equal(s.g.chamadas.length, 0);
    assert.equal(s.rAdmin.rec.inputs.length, 0);
    assert.ok(!r.texto.includes(TOKEN)); assert.ok(!s.cap.texto().includes(TOKEN));
  } finally { await s.fechar(); }
});

test('casa do agente pertencendo ao root: recusa e não grava', async () => {
  if (!ROOT) return;
  const s = await subir();
  try {
    fs.chownSync(s.home, 0, 0);
    const r = await s.cli.post('/api/v1/agents/ana/send', { json: { text: TOKEN } });
    assert.equal(r.status, 500);
    assert.match(r.json.erro, /pertence ao root/);
    assert.ok(r.json.erro.includes(s.home));
    assert.equal(s.g.chamadas.length, 0); assert.equal(s.rAna.rec.inputs.length, 0);
  } finally { await s.fechar(); }
});

test('gravador que recusa: 500 com a mensagem dele, sem o token e sem ir ao runner', async () => {
  const s = await subir();
  try {
    const i = criaInterceptor({ gravaToken: async () => { throw new Error(`o destino é um atalho (${TOKEN})`); } });
    const g = await i.guardar(s.agentes[0], TOKEN);
    assert.equal(g.erro.status, 500);
    assert.ok(!JSON.stringify(g.erro).includes(TOKEN));
    assert.match(g.erro.corpo.erro, /NÃO foi guardado/);
  } finally { await s.fechar(); }
});

test('home_host inexistente: 500 dizendo o caminho', async () => {
  const s = await subir({ homeInexistente: true });
  try {
    const r = await s.cli.post('/api/v1/agents/ana/send', { json: { text: TOKEN } });
    assert.equal(r.status, 500);
    assert.ok(r.json.erro.includes('nao-existe'));
    assert.equal(s.rAna.rec.inputs.length, 0);
  } finally { await s.fechar(); }
});

test('mesmo cliente_id: devolve a mesma resposta (repetido) sem regravar nem reenviar', async () => {
  const s = await subir();
  try {
    const a = await s.cli.post('/api/v1/agents/ana/send', { json: { text: TOKEN, cliente_id: 'cid-token-0002' } });
    const b = await s.cli.post('/api/v1/agents/ana/send', { json: { text: TOKEN, cliente_id: 'cid-token-0002' } });
    assert.equal(b.status, 200);
    assert.equal(b.json.repetido, true);
    assert.equal(b.json.mascarado, a.json.mascarado);
    assert.equal(s.g.chamadas.length, 1);
    assert.equal(s.rAna.rec.inputs.length, 1);
  } finally { await s.fechar(); }
});

// ── gravador REAL (processo filho com o uid do agente) ────────────────────
const pulaReal = ROOT ? false : 'precisa rodar como root para trocar de usuário (chown e uid do filho)';

test('gravador real: .env 600, pastas 700, tudo do agente, outras linhas preservadas', { skip: pulaReal }, async () => {
  const home = casaDeAgente('real');
  fs.mkdirSync(path.join(home, '.dgclaw', 'telegram'), { recursive: true, mode: 0o755 });
  fs.chownSync(path.join(home, '.dgclaw'), NOBODY, NOBODY); fs.chownSync(path.join(home, '.dgclaw', 'telegram'), NOBODY, NOBODY);
  const env = path.join(home, '.dgclaw', 'telegram', '.env');
  fs.writeFileSync(env, 'OUTRA=1\nTELEGRAM_BOT_TOKEN=velho\nMAIS=2\n'); fs.chownSync(env, NOBODY, NOBODY);
  await gravaComoAgente({ token: TOKEN, home, uid: NOBODY, gid: NOBODY });
  assert.equal(fs.readFileSync(env, 'utf8'), `TELEGRAM_BOT_TOKEN=${TOKEN}\nOUTRA=1\nMAIS=2\n`);
  for (const [f, modo] of [[env, 0o600], [path.dirname(env), 0o700], [path.join(home, '.dgclaw'), 0o700]]) {
    const st = fs.statSync(f);
    assert.equal(st.mode & 0o777, modo, f); assert.equal(st.uid, NOBODY); assert.equal(st.gid, NOBODY);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(env)).sort(), ['.env']);
});

test('gravador real: cria as pastas que faltam, 700, do agente', { skip: pulaReal }, async () => {
  const home = casaDeAgente('real2');
  await gravaComoAgente({ token: TOKEN, home, uid: NOBODY, gid: NOBODY });
  const env = path.join(home, '.dgclaw', 'telegram', '.env');
  assert.equal(fs.readFileSync(env, 'utf8'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
  assert.equal(fs.statSync(env).uid, NOBODY); assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(env)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, '.dgclaw')).mode & 0o777, 0o700);
});

test('gravador real: telegram é atalho para pasta do root, falha e nada aparece lá', { skip: pulaReal }, async () => {
  const home = casaDeAgente('real3');
  const alvo = pastaTemp('alvo-root'); fs.chmodSync(alvo, 0o700);
  fs.mkdirSync(path.join(home, '.dgclaw'), { mode: 0o700 }); fs.chownSync(path.join(home, '.dgclaw'), NOBODY, NOBODY);
  fs.symlinkSync(alvo, path.join(home, '.dgclaw', 'telegram'));
  await assert.rejects(() => gravaComoAgente({ token: TOKEN, home, uid: NOBODY, gid: NOBODY }), (e) => {
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
  assert.deepEqual(fs.readdirSync(alvo), []);
  // o mesmo vale para .dgclaw como atalho
  const home2 = casaDeAgente('real4');
  fs.symlinkSync(alvo, path.join(home2, '.dgclaw'));
  await assert.rejects(() => gravaComoAgente({ token: TOKEN, home: home2, uid: NOBODY, gid: NOBODY }));
  assert.deepEqual(fs.readdirSync(alvo), []);
});

test('rota com gravador real: casa de agente comum recebe o .env e o runner só a frase mascarada', { skip: pulaReal }, async () => {
  const s = await subir({ gravadorReal: true });
  try {
    const r = await s.cli.post('/api/v1/agents/ana/send', { json: { text: TOKEN } });
    assert.equal(r.status, 200, r.texto);
    const env = path.join(s.home, '.dgclaw', 'telegram', '.env');
    assert.equal(fs.readFileSync(env, 'utf8'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    assert.equal(fs.statSync(env).uid, NOBODY);
    assert.ok(!todosCorpos(s.rAna).includes(TOKEN));
  } finally { await s.fechar(); }
});
