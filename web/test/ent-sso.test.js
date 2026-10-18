'use strict';
// Bloco G, login único (SSO) por OIDC: fluxo completo contra um provedor falso (servidor HTTP local, chaves geradas
// aqui), os modos opcional/padrão/obrigatório, e cada recusa: state, nonce, aud, token vencido, assinatura, domínio,
// e-mail não cadastrado, usuário desativado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cenarioEnt, criarUsuario } = require('./ent-usuarios-ajuda');
const { cliente } = require('./ajuda');
const { criarIdp, pedidoDeAutorizacao } = require('./ent-sso-ajuda');
const ssoConfig = require('../lib/sso-config');

const EMISSOR = 'https://login.empresa.example/realms/principal';
const CLIENT_ID = 'dgclaw-teste';
const SEGREDO = 'segredo-de-teste-gerado-na-hora';

/** Sobe o Web num nível, com o provedor falso e o sso.json. `cfg` sobrepõe os campos do sso.json. */
async function montar(opcoes) {
  const o = Object.assign({ nivel: 'empresa', ajustes: {}, alg: 'RS256', cfg: {}, emissor: EMISSOR, provedor: 'oidc' }, opcoes || {});
  let tempo = null;
  const idp = await criarIdp({ emissor: o.emissorToken || o.emissor, clientId: CLIENT_ID, segredo: SEGREDO, alg: o.alg, agora: () => tempo.ms() });
  const c = await cenarioEnt({ nivel: o.nivel, ajustes: o.ajustes, opcoesServidor: { sso: { fetch: idp.fetch } } });
  tempo = c.tempo;
  const cfg = Object.assign({ provedor: o.provedor, client_id: CLIENT_ID, client_secret: SEGREDO, dominios_permitidos: ['empresa.com.br'] }, o.provedor === 'oidc' ? { emissor: o.emissor } : {}, o.cfg);
  const caminhoSso = path.join(path.dirname(c.protecoesPath), 'sso.json');
  fs.writeFileSync(caminhoSso, JSON.stringify(cfg), { mode: 0o600 });
  const ti = (await c.entrar('dono', c.senhaTi)).cli;
  const fechar = async () => { await c.fechar(); await idp.fechar(); };
  return { c, idp, ti, caminhoSso, fechar, cfg };
}

/** Cria a Ana (funcionária) com o e-mail e devolve os dados. */
async function criarAna(m, extra) {
  return criarUsuario(m.c, m.ti, Object.assign({ usuario: 'ana', nome: 'Ana', papel: 'funcionario', agentes: ['ana'], email: 'ana@empresa.com.br' }, extra || {}));
}

/**
 * Faz o fluxo inteiro: /sso/entrar, o "provedor" emite o código com as alterações pedidas, /sso/retorno.
 * t: { claims, assinadoPorOutra, state (troca o state na volta), semCookie, next }
 */
async function fluxo(m, t) {
  const o = t || {};
  const cli = o.cli || cliente(m.c.s.porta);
  const ini = await cli.get(`/sso/entrar${o.next ? `?next=${encodeURIComponent(o.next)}` : ''}`);
  if (ini.status !== 302) return { ini, cli };
  const pa = pedidoDeAutorizacao(ini.headers.location);
  const code = m.idp.emitir({ nonce: o.nonce || pa.nonce, challenge: pa.challenge, redirectUri: pa.redirectUri, claims: o.claims, assinadoPorOutra: o.assinadoPorOutra });
  const volta = await cli.get(`/sso/retorno?code=${code}&state=${encodeURIComponent(o.state || pa.state)}`, o.semCookie ? { semCookie: true } : undefined);
  return { ini, pa, volta, cli, code };
}

const eventos = (m, nome) => m.c.eventos().filter((e) => e.evento === nome);

test('sucesso: abre a sessão do usuário do e-mail, conta como segundo fator e audita; PKCE, state e nonce vão ao provedor', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const r = await fluxo(m, { next: '/lembretes' });
    assert.equal(r.ini.status, 302);
    assert.equal(r.pa.tipo, 'code');
    assert.equal(r.pa.metodo, 'S256');
    assert.equal(r.pa.clientId, CLIENT_ID);
    assert.match(r.pa.escopo, /openid/);
    assert.ok(r.pa.state.length >= 24 && r.pa.nonce.length >= 24);
    assert.equal(r.pa.redirectUri, `http://127.0.0.1:${m.c.s.porta}/sso/retorno`);
    assert.match(r.ini.headers['set-cookie'][0], /^dgclaw_sso=.*HttpOnly; SameSite=Lax; Path=\/sso; Max-Age=600/);
    assert.equal(r.volta.status, 302, r.volta.texto);
    assert.equal(r.volta.headers.location, '/lembretes');
    // a troca de código levou o segredo no corpo e o verificador do PKCE
    assert.equal(m.idp.trocas.length, 1);
    assert.equal(m.idp.trocas[0].client_secret, SEGREDO);
    assert.ok(m.idp.trocas[0].code_verifier.length >= 43);
    // a sessão vale, é da Ana, e conta como segundo fator feito pelo provedor
    const eu = await r.cli.get('/api/v1/eu');
    assert.equal(eu.status, 200, eu.texto);
    assert.equal(eu.json.usuario, 'ana');
    assert.equal(eu.json.fa2_em, m.c.tempo.ms());
    const ev = eventos(m, 'login_ok').filter((e) => e.dados.via === 'sso');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].quem, 'ana');
    assert.equal(ev[0].dados.email, 'ana@empresa.com.br');
    // o cookie do fluxo é descartado e o login seguinte precisa de um fluxo novo
    assert.match(r.volta.headers['set-cookie'].join(';'), /dgclaw_sso=; .*Max-Age=0/);
    // o ultimo_login do arquivo foi gravado
    const arq = JSON.parse(fs.readFileSync(path.join(m.c.dataDir, 'usuarios.json'), 'utf8'));
    assert.equal(arq.usuarios.find((u) => u.usuario === 'ana').ultimo_login, m.c.tempo.ms());
  } finally { await m.fechar(); }
});

test('ES256 também vale', async () => {
  const m = await montar({ alg: 'ES256' });
  try {
    await criarAna(m);
    const r = await fluxo(m);
    assert.equal(r.volta.status, 302, r.volta.texto);
    assert.equal((await r.cli.get('/api/v1/eu')).json.usuario, 'ana');
  } finally { await m.fechar(); }
});

test('o código só vale uma vez e o retorno sem o cookie do fluxo é recusado', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const r = await fluxo(m);
    const outra = cliente(m.c.s.porta);
    const repetido = await outra.get(`/sso/retorno?code=${r.code}&state=${encodeURIComponent(r.pa.state)}`);
    assert.equal(repetido.status, 302);
    assert.match(repetido.headers.location, /erro=sso_estado/, 'sem o cookie do fluxo, nem chega ao provedor');
    assert.equal(m.idp.trocas.length, 1);
  } finally { await m.fechar(); }
});

test('state errado: recusa sem falar com o provedor', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const r = await fluxo(m, { state: 'outro-state' });
    assert.match(r.volta.headers.location, /\/login\?erro=sso_estado/);
    assert.equal(m.idp.trocas.length, 0);
    assert.equal(eventos(m, 'sso_falha')[0].dados.motivo, 'estado');
    assert.equal((await r.cli.get('/api/v1/eu')).status, 401);
  } finally { await m.fechar(); }
});

test('cookie do fluxo adulterado ou vencido é recusado', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const ini = await cliente(m.c.s.porta).get('/sso/entrar');
    const pa = pedidoDeAutorizacao(ini.headers.location);
    const cookie = ini.headers['set-cookie'][0].split(';')[0];
    const code = m.idp.emitir({ nonce: pa.nonce, challenge: pa.challenge, redirectUri: pa.redirectUri });
    const adulterado = cookie.replace(/^dgclaw_sso=./, 'dgclaw_sso=A');
    const cli = cliente(m.c.s.porta);
    const r1 = await cli.get(`/sso/retorno?code=${code}&state=${pa.state}`, { headers: { Cookie: adulterado }, semCookie: true });
    assert.match(r1.headers.location, /erro=sso_estado/);
    // passados 11 minutos o fluxo expirou
    m.c.tempo.avanca(11 * 60 * 1000);
    const r2 = await cli.get(`/sso/retorno?code=${code}&state=${pa.state}`, { headers: { Cookie: cookie }, semCookie: true });
    assert.match(r2.headers.location, /erro=sso_estado/);
  } finally { await m.fechar(); }
});

test('nonce errado no token', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const r = await fluxo(m, { claims: { nonce: 'nonce-de-outra-tentativa' } });
    assert.match(r.volta.headers.location, /erro=sso_token/);
    assert.equal((await r.cli.get('/api/v1/eu')).status, 401);
    assert.match(eventos(m, 'sso_falha')[0].dados.detalhe, /nonce/);
  } finally { await m.fechar(); }
});

test('audiência (aud) errada', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const r = await fluxo(m, { claims: { aud: 'outro-aplicativo' } });
    assert.match(r.volta.headers.location, /erro=sso_token/);
    assert.match(eventos(m, 'sso_falha')[0].dados.detalhe, /aud/);
  } finally { await m.fechar(); }
});

test('emissor (iss) errado', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const r = await fluxo(m, { claims: { iss: 'https://outro.example/realms/x' } });
    assert.match(r.volta.headers.location, /erro=sso_token/);
    assert.match(eventos(m, 'sso_falha')[0].dados.detalhe, /emissor/);
  } finally { await m.fechar(); }
});

test('token vencido, e token emitido no futuro (relógio adiantado além de 2 min)', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const agoraS = Math.floor(m.c.tempo.ms() / 1000);
    let r = await fluxo(m, { claims: { exp: agoraS - 10, iat: agoraS - 3600 } });
    assert.match(r.volta.headers.location, /erro=sso_token/);
    assert.match(eventos(m, 'sso_falha')[0].dados.detalhe, /venceu/);
    r = await fluxo(m, { claims: { iat: agoraS + 600 } });
    assert.match(r.volta.headers.location, /erro=sso_token/);
    assert.match(eventos(m, 'sso_falha')[1].dados.detalhe, /futuro/);
    // 1 minuto de folga é aceito
    r = await fluxo(m, { claims: { iat: agoraS + 60 } });
    assert.equal(r.volta.headers.location, '/');
  } finally { await m.fechar(); }
});

test('assinatura inválida: token assinado por outra chave com o mesmo kid', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const r = await fluxo(m, { assinadoPorOutra: true });
    assert.match(r.volta.headers.location, /erro=sso_token/);
    assert.match(eventos(m, 'sso_falha')[0].dados.detalhe, /assinatura/);
    assert.equal((await r.cli.get('/api/v1/eu')).status, 401);
  } finally { await m.fechar(); }
});

test('domínio fora da lista e e-mail não verificado', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    await criarUsuario(m.c, m.ti, { usuario: 'bruno', papel: 'funcionario', agentes: [], email: 'bruno@outra.com' });
    let r = await fluxo(m, { claims: { email: 'bruno@outra.com' } });
    assert.match(r.volta.headers.location, /erro=sso_dominio/);
    r = await fluxo(m, { claims: { email_verified: false } });
    assert.match(r.volta.headers.location, /erro=sso_email/);
    assert.equal(eventos(m, 'login_ok').filter((e) => e.dados.via === 'sso').length, 0);
  } finally { await m.fechar(); }
});

test('e-mail não cadastrado: tela explicando que o TI cadastra, sem criar usuário', async () => {
  const m = await montar();
  try {
    const antes = fs.readFileSync(path.join(m.c.dataDir, 'usuarios.json'), 'utf8');
    const r = await fluxo(m, { claims: { email: 'novato@empresa.com.br' } });
    assert.equal(r.volta.status, 403);
    assert.match(r.volta.texto, /administrador de TI/);
    assert.match(r.volta.texto, /cadastrar o seu e-mail/);
    assert.match(r.volta.texto, /novato@empresa\.com\.br/);
    assert.equal(fs.readFileSync(path.join(m.c.dataDir, 'usuarios.json'), 'utf8'), antes, 'nenhum usuário foi criado');
    assert.equal(eventos(m, 'sso_falha')[0].dados.motivo, 'email_nao_cadastrado');
    assert.equal((await r.cli.get('/api/v1/eu')).status, 401);
  } finally { await m.fechar(); }
});

test('usuário desativado não entra', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const d = await m.ti.pedir('PATCH', '/api/v1/usuarios/ana', { json: { ativo: false } });
    assert.equal(d.status, 200, d.texto);
    const r = await fluxo(m);
    assert.match(r.volta.headers.location, /erro=sso_desativado/);
    assert.equal((await r.cli.get('/api/v1/eu')).status, 401);
  } finally { await m.fechar(); }
});

test('next fora do site vira /', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    const r = await fluxo(m, { next: '//evil.example/x' });
    assert.equal(r.volta.headers.location, '/');
  } finally { await m.fechar(); }
});

test('Google: exige hd no domínio permitido; Microsoft: confere o tid', async () => {
  const g = await montar({ provedor: 'google', emissor: 'https://accounts.google.com' });
  try {
    await criarAna(g);
    let r = await fluxo(g, { claims: { hd: 'empresa.com.br' } });
    assert.equal(r.volta.status, 302, r.volta.texto);
    assert.equal((await r.cli.get('/api/v1/eu')).json.usuario, 'ana');
    r = await fluxo(g, {});
    assert.match(r.volta.headers.location, /erro=sso_dominio/, 'conta sem hd (Gmail comum) não entra');
    r = await fluxo(g, { claims: { hd: 'outra.com' } });
    assert.match(r.volta.headers.location, /erro=sso_dominio/);
    r = await fluxo(g, { claims: { hd: 'empresa.com.br', email_verified: false } });
    assert.match(r.volta.headers.location, /erro=sso_email/);
  } finally { await g.fechar(); }

  const tenant = '11111111-2222-3333-4444-555555555555';
  const ms = await montar({ provedor: 'microsoft', emissor: `https://login.microsoftonline.com/${tenant}/v2.0`, cfg: { tenant } });
  try {
    await criarAna(ms);
    let r = await fluxo(ms, { claims: { tid: tenant, email: undefined, preferred_username: 'ana@empresa.com.br' } });
    assert.equal(r.volta.status, 302, r.volta.texto);
    assert.equal((await r.cli.get('/api/v1/eu')).json.usuario, 'ana');
    r = await fluxo(ms, { claims: { tid: '99999999-2222-3333-4444-555555555555' } });
    assert.match(r.volta.headers.location, /erro=sso_token/);
    assert.match(eventos(ms, 'sso_falha').pop().dados.detalhe, /diretório/);
  } finally { await ms.fechar(); }
});

test('provedor fora do ar: erro explicado, sem sessão', async () => {
  const m = await montar();
  try {
    await criarAna(m);
    await m.idp.fechar();
    const r = await cliente(m.c.s.porta).get('/sso/entrar');
    assert.equal(r.status, 302);
    assert.match(r.headers.location, /erro=sso_provedor/);
    assert.match(eventos(m, 'sso_falha')[0].dados.detalhe, /Não consegui falar com o provedor/);
  } finally { await m.c.fechar(); }
});

test('login-estado traz o botão por modo; escritório = opcional, empresa = padrão, pessoal = nada', async () => {
  for (const [nivel, modo] of [['escritorio', 'opcional'], ['empresa', 'padrao']]) {
    const m = await montar({ nivel });
    try {
      const j = (await cliente(m.c.s.porta).get('/api/login-estado')).json;
      assert.deepEqual(j.sso, { provedor: 'a conta da empresa', modo, url: '/sso/entrar' });
    } finally { await m.fechar(); }
  }
  const p = await cenarioEnt({ nivel: 'pessoal' });
  try {
    const cli = cliente(p.s.porta);
    assert.equal((await cli.get('/api/login-estado')).json.sso, undefined);
    const r = await cli.get('/sso/entrar');
    assert.notEqual(r.status, 302, 'no nível pessoal a rota não existe');
    assert.equal(r.headers.location === undefined || !/authorize/.test(r.headers.location), true);
  } finally { await p.fechar(); }
});

test('sem sso.json válido: o botão some, a rota explica o que fazer, a senha continua (modo padrão)', async () => {
  const m = await montar();
  try {
    fs.writeFileSync(m.caminhoSso, '{"provedor":"oidc"}', { mode: 0o600 });
    const cli = cliente(m.c.s.porta);
    assert.equal((await cli.get('/api/login-estado')).json.sso, undefined);
    const r = await cli.get('/sso/entrar');
    assert.equal(r.status, 503);
    assert.match(r.texto, /dgclaw sso configurar/);
    assert.match(m.c.s.log.texto(), /Login único \(SSO\) indisponível/);
    assert.equal((await m.c.entrar('dono', m.c.senhaTi)).r.status, 200, 'a senha segue valendo fora do modo obrigatório');
  } finally { await m.fechar(); }
});

test('modo obrigatório: a senha deixa de valer para todos, menos para a conta de emergência (senha + 2FA)', async () => {
  const m = await montar();
  try {
    const ana = await criarAna(m);
    // o TI "dono" vira a conta de emergência (a CLI faz isto; aqui editamos o arquivo como ela)
    const arqUsuarios = path.join(m.c.dataDir, 'usuarios.json');
    const j = JSON.parse(fs.readFileSync(arqUsuarios, 'utf8'));
    j.usuarios.find((u) => u.usuario === 'dono').emergencia = true;
    fs.writeFileSync(arqUsuarios, JSON.stringify(j), { mode: 0o600 });
    // liga o modo obrigatório sem reiniciar (a matriz é relida)
    fs.writeFileSync(m.c.protecoesPath, JSON.stringify({ nivel: 'empresa', ajustes: { sso: 'obrigatorio' } }));

    const cli = cliente(m.c.s.porta);
    const estado = (await cli.get('/api/login-estado')).json;
    assert.equal(estado.sso.modo, 'obrigatorio');

    // a Ana, com a senha certa, é recusada com o motivo
    const r = await cli.post('/login', { json: { usuario: 'ana', senha: ana.senha } });
    assert.equal(r.status, 401);
    assert.match(r.json.erro, /login único/);
    // pelo formulário, o código leva a tela a explicar
    const f = await cliente(m.c.s.porta).post('/login', { form: { usuario: 'ana', senha: ana.senha, next: '/' } });
    assert.equal(f.status, 302);
    assert.match(f.headers.location, /erro=sso_obrigatorio/);
    assert.equal(eventos(m, 'login_recusado_sso').length, 2);

    // a conta de emergência entra com senha + 2FA e fica registrada em destaque
    const e = await m.c.entrar('dono', m.c.senhaTi);
    assert.equal(e.r.status, 200, e.r.texto);
    assert.equal((await e.cli.get('/api/v1/eu')).json.usuario, 'dono');
    assert.ok(eventos(m, 'login_emergencia_tentativa').length >= 1);
    assert.match(m.c.s.log.texto(), /conta de EMERGÊNCIA/);

    // o SSO segue funcionando para a Ana
    const s = await fluxo(m);
    assert.equal(s.volta.status, 302);
    assert.equal((await s.cli.get('/api/v1/eu')).json.usuario, 'ana');
  } finally { await m.fechar(); }
});

test('modo obrigatório sem conta de emergência marcada: ninguém entra com senha, nem o TI', async () => {
  const m = await montar();
  try {
    fs.writeFileSync(m.c.protecoesPath, JSON.stringify({ nivel: 'empresa', ajustes: { sso: 'obrigatorio' } }));
    const r = await cliente(m.c.s.porta).post('/login', { json: { usuario: 'dono', senha: m.c.senhaTi } });
    assert.equal(r.status, 401);
    assert.match(r.json.erro, /login único/);
  } finally { await m.fechar(); }
});

test('nos modos opcional e padrão a senha continua entrando normalmente', async () => {
  for (const nivel of ['escritorio', 'empresa']) {
    const m = await montar({ nivel });
    try {
      const r = await m.c.entrar('dono', m.c.senhaTi);
      assert.equal(r.r.status, 200);
      assert.equal(eventos(m, 'login_recusado_sso').length, 0);
    } finally { await m.fechar(); }
  }
});

test('sso-config: validações explicam o que corrigir e o segredo nunca vai para a mensagem', () => {
  const ok = { provedor: 'oidc', emissor: 'https://idp.exemplo.com/realms/x/', client_id: 'a', client_secret: 'seg-secreto-xyz', dominios_permitidos: ['Empresa.com.br'] };
  const v = ssoConfig.validar(ok);
  assert.equal(v.emissor, 'https://idp.exemplo.com/realms/x');
  assert.deepEqual(v.dominios_permitidos, ['empresa.com.br']);
  assert.throws(() => ssoConfig.validar({ ...ok, provedor: 'saml' }), /não existe/);
  assert.throws(() => ssoConfig.validar({ ...ok, emissor: 'http://idp.exemplo.com' }), /https/);
  assert.throws(() => ssoConfig.validar({ ...ok, client_secret: '' }), /client_secret/);
  assert.throws(() => ssoConfig.validar({ ...ok, dominios_permitidos: ['sem ponto'] }), /domínio/);
  assert.throws(() => ssoConfig.validar({ provedor: 'google', client_id: 'a', client_secret: 'b' }), /domínio da empresa é obrigatório/);
  assert.throws(() => ssoConfig.validar({ provedor: 'microsoft', client_id: 'a', client_secret: 'b', tenant: 'common' }), /ID do diretório/);
  assert.throws(() => ssoConfig.validar({ ...ok, redirect_uri: 'https://x.com/outro' }), /sso\/retorno/);
  try { ssoConfig.validar({ ...ok, emissor: 'http://ruim' }); } catch (e) { assert.doesNotMatch(e.message, /seg-secreto-xyz/); }
  assert.equal(ssoConfig.emissorEfetivo(ssoConfig.validar({ provedor: 'google', client_id: 'a', client_secret: 'b', dominios_permitidos: ['x.com'] })), 'https://accounts.google.com');
});

test('sso-config: ler e gravar usam modo 600 e avisam quando o arquivo está aberto demais', () => {
  const { pastaTemp, capturaLog } = require('./ajuda');
  const dir = pastaTemp('ssocfg');
  fs.chmodSync(dir, 0o700);
  const arq = path.join(dir, 'sso.json');
  assert.equal(ssoConfig.ler(arq), null);
  ssoConfig.gravar(arq, { provedor: 'oidc', emissor: 'https://idp.exemplo.com', client_id: 'a', client_secret: 'b' });
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).emissor_efetivo, undefined, 'campos derivados não vão para o disco');
  fs.chmodSync(arq, 0o644);
  const cap = capturaLog();
  ssoConfig.ler(arq, { log: cap.log });
  assert.match(cap.texto(), /modo 644/);
  fs.writeFileSync(arq, '{quebrado');
  assert.throws(() => ssoConfig.ler(arq), /não é um JSON válido/);
});
