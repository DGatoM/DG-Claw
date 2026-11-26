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
    // Suspender o link falha com um erro que não é ENOENT (renomear um diretório funcionaria, então o erro é simulado).
    const alvo = path.join(path.dirname(webEnv), 'primeiro-acesso.json');
    fs.writeFileSync(alvo, '{"versao":1}\n', { mode: 0o600 });
    const antes = fs.readFileSync(webEnv, 'utf8');
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const renameOrig = fs.renameSync;
    fs.renameSync = function (de, ...resto) {
      if (de === alvo) { const e = new Error('sem permissão'); e.code = 'EACCES'; throw e; }
      return renameOrig.call(this, de, ...resto);
    };
    let r;
    try { r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } }); } finally { fs.renameSync = renameOrig; }
    assert.equal(r.status, 500, r.texto);
    assert.match(r.json.erro, /link de recuperação pendente/);
    assert.equal(fs.readFileSync(webEnv, 'utf8'), antes);
    assert.ok(fs.existsSync(alvo));
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
    // Reinício de verdade: a configuração vem do arquivo e do ambiente do processo, que segue com o hash ORIGINAL
    // (a unidade só carrega o web.env no start). O hash do arquivo é o novo e vence quando o processo não o define por fora.
    const { criarServidor } = require('../server');
    const salvo = {};
    for (const k of ['DGCLAW_WEB_ENV', 'DGCLAW_PANEL_USER', 'DGCLAW_PANEL_PASSWORD_HASH']) salvo[k] = process.env[k];
    process.env.DGCLAW_WEB_ENV = webEnv; delete process.env.DGCLAW_PANEL_USER; delete process.env.DGCLAW_PANEL_PASSWORD_HASH;
    let web2;
    try {
      web2 = criarServidor({ agentesPath: t.agentesPath, dataDir: path.join(dir, 'dados2'), publicDir: t.publico, log: () => {}, tz: 'America/Sao_Paulo' });
    } finally { for (const [k, v] of Object.entries(salvo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    const addr2 = await web2.ouvir(0, '127.0.0.1');
    try { assert.equal((await login(cliente(addr2.port), 'Mariana', NOVA)).status, 200); } finally { await web2.fechar(); }
  } finally { await t.fechar(); }
});

test('hash administrado fora do web.env: a comparação é a do carregamento', () => {
  const { hashAdministradoPorFora, carregaConfig } = require('../lib/config');
  assert.equal(hashAdministradoPorFora({ DGCLAW_PANEL_PASSWORD_HASH: 'a' }, { DGCLAW_PANEL_PASSWORD_HASH: 'a' }), false, 'igual: unidade carrega o web.env');
  assert.equal(hashAdministradoPorFora({ DGCLAW_PANEL_PASSWORD_HASH: 'a' }, {}), false, 'só no arquivo');
  assert.equal(hashAdministradoPorFora({ DGCLAW_PANEL_PASSWORD_HASH: 'a' }, { DGCLAW_PANEL_PASSWORD_HASH: '' }), false);
  assert.equal(hashAdministradoPorFora({ DGCLAW_PANEL_PASSWORD_HASH: 'a' }, { DGCLAW_PANEL_PASSWORD_HASH: 'b' }), false, 'o arquivo define a chave: ele governa');
  assert.equal(hashAdministradoPorFora({ DGCLAW_PANEL_PASSWORD_HASH: '' }, { DGCLAW_PANEL_PASSWORD_HASH: 'b' }), false, 'definida vazia no arquivo também governa');
  assert.equal(hashAdministradoPorFora({}, { DGCLAW_PANEL_PASSWORD_HASH: 'b' }), true, 'só no processo');
  const dir = pastaTemp('cfg');
  const webEnv = path.join(dir, 'web.env');
  fs.writeFileSync(webEnv, "DGCLAW_PANEL_PASSWORD_HASH='igual'\n");
  const salvo = { e: process.env.DGCLAW_WEB_ENV, h: process.env.DGCLAW_PANEL_PASSWORD_HASH };
  process.env.DGCLAW_WEB_ENV = webEnv;
  try {
    process.env.DGCLAW_PANEL_PASSWORD_HASH = 'igual';
    assert.equal(carregaConfig({}, () => {}).hashPorFora, false);
    process.env.DGCLAW_PANEL_PASSWORD_HASH = 'outro';
    const c = carregaConfig({}, () => {});
    assert.equal(c.hashPorFora, false);
    assert.equal(c.env.DGCLAW_PANEL_PASSWORD_HASH, 'igual', 'o hash do arquivo vence o do ambiente');
  } finally {
    if (salvo.e === undefined) delete process.env.DGCLAW_WEB_ENV; else process.env.DGCLAW_WEB_ENV = salvo.e;
    if (salvo.h === undefined) delete process.env.DGCLAW_PANEL_PASSWORD_HASH; else process.env.DGCLAW_PANEL_PASSWORD_HASH = salvo.h;
  }
});

test('troca de senha do dono: hash administrado fora do web.env responde 409 e não grava nada', async () => {
  const { t, webEnv } = await comWebEnv({ opcoesServidor: { hashPorFora: true } });
  try {
    const antes = fs.readFileSync(webEnv, 'utf8');
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 409, r.texto);
    assert.match(r.json.erro, /definida fora do web\.env/);
    assert.equal(fs.readFileSync(webEnv, 'utf8'), antes);
    assert.equal((await login(cliente(t.porta), 'Mariana', t.senha)).status, 200, 'a senha antiga segue valendo');
  } finally { await t.fechar(); }
});

for (const tipo of ['fifo', 'link', 'ausente']) {
  const nomeTipo = { fifo: 'um FIFO', link: 'um link simbólico', ausente: 'ausente' }[tipo];
  test(`troca de senha do dono: web.env ${tipo === 'ausente' ? 'ausente' : `que é ${nomeTipo}`} responde 409 sem gravar nem apagar o link de recuperação`, async () => {
    const dir = pastaTemp('sd3');
    const webEnv = path.join(dir, 'web.env');
    const real = path.join(dir, 'real.env');
    fs.writeFileSync(real, "DGCLAW_PANEL_USER=Mariana\n", { mode: 0o600 });
    if (tipo === 'fifo') require('node:child_process').execFileSync('mkfifo', [webEnv]);
    else if (tipo === 'link') fs.symlinkSync(real, webEnv);
    const pa = path.join(dir, 'primeiro-acesso.json');
    fs.writeFileSync(pa, '{"versao":1}\n', { mode: 0o600 });
    const t = await subirWeb({ agentes: AG, env: { DGCLAW_PANEL_USER: 'Mariana', DGCLAW_WEB_ENV: webEnv } });
    try {
      assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
      const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
      assert.equal(r.status, 409, r.texto);
      assert.match(r.json.erro, { fifo: /FIFO/, link: /link simbólico/, ausente: /não existe/ }[tipo]);
      if (tipo === 'ausente') assert.ok(!fs.existsSync(webEnv), 'o web.env ausente não foi criado');
      assert.ok(fs.existsSync(pa), 'o link de recuperação não foi apagado');
      assert.equal(fs.readFileSync(real, 'utf8'), "DGCLAW_PANEL_USER=Mariana\n");
      assert.equal((await login(cliente(t.porta), 'Mariana', t.senha)).status, 200);
    } finally { await t.fechar(); }
  });
}

test('troca de senha do dono: web.env que some durante a troca responde 409 sem recriar o arquivo nem apagar o link de recuperação', async () => {
  const dir = pastaTemp('sd4');
  const webEnv = path.join(dir, 'web.env');
  fs.writeFileSync(webEnv, "DGCLAW_PANEL_USER=Mariana\n", { mode: 0o600 });
  const pa = path.join(dir, 'primeiro-acesso.json');
  fs.writeFileSync(pa, '{"versao":1}\n', { mode: 0o600 });
  const t = await subirWeb({ agentes: AG, env: { DGCLAW_PANEL_USER: 'Mariana', DGCLAW_WEB_ENV: webEnv } });
  const lstatOrig = fs.lstatSync;
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    // A primeira conferência vê o arquivo; ele some antes da segunda (como uma manutenção no meio da troca).
    let vezes = 0;
    fs.lstatSync = function (alvo, ...resto) {
      if (alvo === webEnv && ++vezes === 2) fs.renameSync(webEnv, webEnv + '.movido');
      return lstatOrig.call(this, alvo, ...resto);
    };
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    fs.lstatSync = lstatOrig;
    assert.equal(r.status, 409, r.texto);
    assert.match(r.json.erro, /não existe/);
    assert.ok(vezes >= 2, 'a segunda conferência aconteceu');
    assert.ok(!fs.existsSync(webEnv), 'o web.env não foi recriado só com o hash');
    assert.ok(fs.existsSync(pa), 'o link de recuperação não foi apagado');
  } finally { fs.lstatSync = lstatOrig; await t.fechar(); }
});

test('troca de senha do dono: web.env vazio (sem DGCLAW_PANEL_USER) responde 409 sem gravar nem apagar o link de recuperação', async () => {
  const dir = pastaTemp('sd5');
  const webEnv = path.join(dir, 'web.env');
  fs.writeFileSync(webEnv, '', { mode: 0o600 });
  const pa = path.join(dir, 'primeiro-acesso.json');
  fs.writeFileSync(pa, '{"versao":1}\n', { mode: 0o600 });
  const t = await subirWeb({ agentes: AG, env: { DGCLAW_PANEL_USER: 'Mariana', DGCLAW_WEB_ENV: webEnv } });
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 409, r.texto);
    assert.match(r.json.erro, /DGCLAW_PANEL_USER/);
    assert.equal(fs.readFileSync(webEnv, 'utf8'), '', 'o web.env não foi gravado');
    assert.ok(fs.existsSync(pa), 'o link de recuperação não foi apagado');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'sem temporário largado');
    assert.equal((await login(cliente(t.porta), 'Mariana', t.senha)).status, 200, 'a senha antiga segue valendo');
  } finally { await t.fechar(); }
});

test('tamanho mínimo da senha: vale na forma digitada e na NFKC (troca de senha)', async () => {
  const { t } = await comWebEnv();
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    // U+FDFA tem 1 ponto de código e vira 18 no NFKC: a forma digitada tem 1 e é recusada.
    const expande = '\uFDFA';
    assert.ok([...expande.normalize('NFKC')].length >= 12);
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: expande, confirmacao: expande } });
    assert.equal(r.status, 400, r.texto); assert.match(r.json.erro, /a sua tem 1\)/);
    const r2 = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: 'abc' + expande, confirmacao: 'abc' + expande } });
    assert.equal(r2.status, 400, r2.texto);
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

test('troca de senha do dono: /wait aberto por outra sessão do dono termina 401 e sem mensagens quando a senha é trocada', async () => {
  const { t } = await comWebEnv();
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const outra = cliente(t.porta);
    assert.equal((await login(outra, 'Mariana', t.senha)).status, 200);
    const espera = outra.get('/api/v1/agents/admin/wait?since=4102444800&timeout=8');
    await new Promise((r) => setTimeout(r, 300));
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 200, r.texto);
    const w = await espera;
    assert.equal(w.status, 401, w.texto);
    assert.match(w.json.erro, /sessão foi encerrada/);
    assert.doesNotMatch(w.json.erro, /convite/);
    assert.equal(w.json.msgs, undefined);
  } finally { await t.fechar(); }
});

test('troca de senha do dono: senha que só chega a 12 em forma decomposta é recusada', async () => {
  const { t } = await comWebEnv();
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const s = 'ã'.normalize('NFD') + 'xxxxxxxxxx';
    assert.equal([...s].length, 12);
    assert.equal([...s.normalize('NFKC')].length, 11);
    const r = await t.c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: s, confirmacao: s } });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /a sua tem 11/);
  } finally { await t.fechar(); }
});

// ── o web.env governa o hash ───────────────────────────────────────────────
test('o web.env governa o hash: vale o do arquivo mesmo com outro no ambiente, e depois da troca vale o novo', () => {
  const { carregaConfig } = require('../lib/config');
  const dir = pastaTemp('gov');
  const webEnv = path.join(dir, 'web.env');
  const salvo = { e: process.env.DGCLAW_WEB_ENV, h: process.env.DGCLAW_PANEL_PASSWORD_HASH };
  try {
    process.env.DGCLAW_WEB_ENV = webEnv;
    process.env.DGCLAW_PANEL_PASSWORD_HASH = 'H0';
    fs.writeFileSync(webEnv, "DGCLAW_PANEL_PASSWORD_HASH='H1'\n");
    let c = carregaConfig({}, () => {});
    assert.equal(c.env.DGCLAW_PANEL_PASSWORD_HASH, 'H1');
    assert.equal(c.hashPorFora, false);
    fs.writeFileSync(webEnv, "DGCLAW_PANEL_PASSWORD_HASH='H2'\n"); // troca pelo painel; o processo segue com H0
    c = carregaConfig({}, () => {});
    assert.equal(c.env.DGCLAW_PANEL_PASSWORD_HASH, 'H2', 'depois do reinício vale o hash novo do arquivo');
    assert.equal(c.hashPorFora, false);
    fs.writeFileSync(webEnv, 'OUTRA=1\n');
    c = carregaConfig({}, () => {});
    assert.equal(c.hashPorFora, true, 'o arquivo não define a chave e o ambiente define');
    assert.equal(c.env.DGCLAW_PANEL_PASSWORD_HASH, 'H0');
  } finally {
    if (salvo.e === undefined) delete process.env.DGCLAW_WEB_ENV; else process.env.DGCLAW_WEB_ENV = salvo.e;
    if (salvo.h === undefined) delete process.env.DGCLAW_PANEL_PASSWORD_HASH; else process.env.DGCLAW_PANEL_PASSWORD_HASH = salvo.h;
  }
});

// ── trava do web.env ───────────────────────────────────────────────────────
const trocar = (c, t) => c.post('/api/v1/dono/senha', { json: { atual: t.senha, nova: NOVA, confirmacao: NOVA } });

test('troca de senha do dono: com a trava do web.env ocupada responde 409, não grava e não apaga o link', async () => {
  const { t, webEnv } = await comWebEnv({ opcoesServidor: { travaEsperaMs: 200 } });
  const dir = path.dirname(webEnv);
  const trava = path.join(dir, '.web.env.trava');
  const pa = path.join(dir, 'primeiro-acesso.json');
  fs.writeFileSync(pa, '{"versao":1}\n', { mode: 0o600 });
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    const antes = fs.readFileSync(webEnv, 'utf8');
    fs.mkdirSync(trava);
    const r = await trocar(t.c, t);
    assert.equal(r.status, 409, r.texto);
    assert.match(r.json.erro, /outro processo está gravando o web\.env/i);
    assert.match(r.json.erro, /senha antiga continua valendo/);
    assert.equal(fs.readFileSync(webEnv, 'utf8'), antes);
    assert.ok(fs.existsSync(pa));
    assert.ok(fs.existsSync(trava), 'a trava de outro processo não é apagada');
    assert.match(t.log.texto(), /outro processo está gravando o web\.env/);
  } finally { await t.fechar(); }
});

test('troca de senha do dono: trava abandonada (mais de 30 s) é removida e a troca segue; a trava é solta no fim', async () => {
  const { t, webEnv } = await comWebEnv();
  const trava = path.join(path.dirname(webEnv), '.web.env.trava');
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    fs.mkdirSync(trava);
    const velho = new Date(Date.now() - 2 * 60 * 1000);
    fs.utimesSync(trava, velho, velho);
    const r = await trocar(t.c, t);
    assert.equal(r.status, 200, r.texto);
    assert.ok(!fs.existsSync(trava), 'a trava foi solta');
    assert.match(fs.readFileSync(webEnv, 'utf8'), /^DGCLAW_PANEL_PASSWORD_HASH='scrypt\$/m);
  } finally { await t.fechar(); }
});

test('primeiro acesso: com a trava do web.env ocupada responde 409 e o link continua valendo', async () => {
  const crypto = require('node:crypto');
  const dir = pastaTemp('pa-trava');
  const webEnv = path.join(dir, 'web.env');
  fs.writeFileSync(webEnv, 'DGCLAW_PANEL_USER=Mariana\n', { mode: 0o600 });
  const token = crypto.randomBytes(32).toString('base64url');
  const pa = path.join(dir, 'primeiro-acesso.json');
  const conteudo = JSON.stringify({ versao: 1, usuario: 'Mariana', token_sha256: crypto.createHash('sha256').update(token).digest('hex'), criado: Date.now(), expira: Date.now() + 600000, usado_em: null }) + '\n';
  fs.writeFileSync(pa, conteudo, { mode: 0o600 });
  const t = await subirWeb({ agentes: AG, semHash: true, env: { DGCLAW_PANEL_USER: 'Mariana', DGCLAW_WEB_ENV: webEnv }, opcoesServidor: { travaEsperaMs: 200 } });
  try {
    fs.mkdirSync(path.join(dir, '.web.env.trava'));
    const r = await cliente(t.porta).post('/api/primeiro-acesso', { json: { token, senha: NOVA, confirmacao: NOVA } });
    assert.equal(r.status, 409, r.texto);
    assert.equal(fs.readFileSync(pa, 'utf8'), conteudo, 'o link não foi consumido');
    assert.equal(fs.readFileSync(webEnv, 'utf8'), 'DGCLAW_PANEL_USER=Mariana\n');
  } finally { await t.fechar(); }
});

// ── web.env preparado conferido com o leitor da inicialização ──────────────
for (const [nome, conteudo] of [
  ['usuário vazio logo antes do hash', "DGCLAW_PANEL_USER=\nDGCLAW_PANEL_PASSWORD_HASH='velho'\n"],
  ['usuário válido seguido de uma definição vazia', "DGCLAW_PANEL_USER=Mariana\nDGCLAW_PANEL_PASSWORD_HASH='velho'\nDGCLAW_PANEL_USER=\n"],
]) {
  test(`troca de senha do dono: ${nome} responde 409, web.env intacto e link preservado`, async () => {
    const dir = pastaTemp('sd6');
    const webEnv = path.join(dir, 'web.env');
    fs.writeFileSync(webEnv, conteudo, { mode: 0o600 });
    const pa = path.join(dir, 'primeiro-acesso.json');
    fs.writeFileSync(pa, '{"versao":1}\n', { mode: 0o600 });
    const t = await subirWeb({ agentes: AG, env: { DGCLAW_PANEL_USER: 'Mariana', DGCLAW_WEB_ENV: webEnv } });
    try {
      assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
      const r = await trocar(t.c, t);
      assert.equal(r.status, 409, r.texto);
      assert.match(r.json.erro, /DGCLAW_PANEL_USER/);
      assert.equal(fs.readFileSync(webEnv, 'utf8'), conteudo);
      assert.ok(fs.existsSync(pa), 'o link de recuperação continua lá');
      assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp') || n.endsWith('.suspenso')), []);
    } finally { await t.fechar(); }
  });
}

test('lerEnvTexto: a última definição de cada chave vence, como na inicialização', () => {
  const { lerEnvTexto } = require('../lib/config');
  assert.deepEqual(lerEnvTexto("A=1\n# c\nexport B='x y'\nA=\n"), { A: '', B: 'x y' });
});

// ── link de recuperação não se perde se a gravação falhar ──────────────────
test('troca de senha do dono: rename do web.env que falha (EBUSY) responde 500 e o link de recuperação volta intacto', async () => {
  const { t, webEnv } = await comWebEnv();
  const dir = path.dirname(webEnv);
  const pa = path.join(dir, 'primeiro-acesso.json');
  fs.writeFileSync(pa, '{"versao":1,"x":"y"}\n', { mode: 0o600 });
  const antes = fs.readFileSync(webEnv, 'utf8');
  const renameOrig = fs.renameSync;
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    fs.renameSync = function (de, para, ...resto) {
      if (para === webEnv) { const e = new Error('ocupado'); e.code = 'EBUSY'; throw e; }
      return renameOrig.call(this, de, para, ...resto);
    };
    const r = await trocar(t.c, t);
    fs.renameSync = renameOrig;
    assert.equal(r.status, 500, r.texto);
    assert.match(r.json.erro, /link de recuperação pendente continua valendo/);
    assert.equal(fs.readFileSync(webEnv, 'utf8'), antes);
    assert.equal(fs.readFileSync(pa, 'utf8'), '{"versao":1,"x":"y"}\n');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.suspenso') || n.endsWith('.tmp')), []);
    assert.ok(!fs.existsSync(path.join(dir, '.web.env.trava')), 'a trava foi solta');
    assert.equal((await login(cliente(t.porta), 'Mariana', t.senha)).status, 200, 'a senha antiga segue valendo');
  } finally { fs.renameSync = renameOrig; await t.fechar(); }
});

test('troca de senha do dono: depois de gravar, o link suspenso é apagado (nenhum .suspenso sobra)', async () => {
  const { t, webEnv } = await comWebEnv();
  const dir = path.dirname(webEnv);
  const pa = path.join(dir, 'primeiro-acesso.json');
  fs.writeFileSync(pa, '{"versao":1}\n', { mode: 0o600 });
  try {
    assert.equal((await login(t.c, 'Mariana', t.senha)).status, 200);
    assert.equal((await trocar(t.c, t)).status, 200);
    assert.ok(!fs.existsSync(pa));
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.suspenso') || n.endsWith('.tmp')), []);
  } finally { await t.fechar(); }
});

// ── escrita do dono (sem Face ID) pelo proxy revalidada no fim do corpo ────
test('dono sem Face ID: escrita pelo proxy com corpo lento e senha trocada antes do fim dá 401 e nada chega ao painel', async () => {
  const http = require('node:http');
  const visto = [];
  const painel = http.createServer((req, res) => { visto.push(req.url); req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }); });
  await new Promise((r) => painel.listen(0, '127.0.0.1', r));
  const dir = pastaTemp('sd7');
  const webEnv = path.join(dir, 'web.env');
  fs.writeFileSync(webEnv, "DGCLAW_PANEL_USER=Mariana\nDGCLAW_PANEL_PASSWORD_HASH='velho'\n", { mode: 0o600 });
  const segredo = path.join(dir, 'proxy.txt');
  fs.writeFileSync(segredo, 'segredo-do-proxy-so-de-teste\n');
  const ag = AG.concat([{ slug: 'ana', nome: 'Ana', runner: 'http://127.0.0.1:1', agente_id: 'a1', porta_painel: painel.address().port, proxy_segredo_arquivo: segredo }]);
  const t = await subirWeb({ agentes: ag, env: { DGCLAW_PANEL_USER: 'Mariana', DGCLAW_WEB_ENV: webEnv } });
  try {
    const lenta = cliente(t.porta);
    assert.equal((await login(lenta, 'Mariana', t.senha)).status, 200);
    const outra = cliente(t.porta);
    assert.equal((await login(outra, 'Mariana', t.senha)).status, 200);
    const cookie = Object.entries(lenta.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const resposta = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.porta, path: '/p/ana/api/rotinas', method: 'POST', headers: { Origin: `http://127.0.0.1:${t.porta}`, 'Content-Type': 'application/json', Cookie: cookie } }, (res) => {
        const partes = []; res.on('data', (x) => partes.push(x)); res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(partes).toString() }));
      });
      req.on('error', reject);
      req.write('{"a":');
      setTimeout(async () => {
        try {
          assert.equal((await trocar(outra, t)).status, 200);
          req.end('1}');
        } catch (e) { reject(e); }
      }, 150);
    });
    assert.equal(resposta.status, 401, resposta.texto);
    assert.deepEqual(visto, [], 'nada chegou ao painel');
  } finally { await t.fechar(); await new Promise((r) => { painel.closeAllConnections(); painel.close(r); }); }
});
