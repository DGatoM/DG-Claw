'use strict';
// Bloco B: login multiusuário, 2FA, bloqueio de conta, sessões, usuários e auditoria (pela API, com Web de verdade).
// Nenhuma senha fica escrita aqui: as de teste nascem na hora (aleatoria) e a do TI vem do próprio Web de teste.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cliente, pastaTemp } = require('./ajuda');
const { cenarioEnt, criarUsuario, aleatoria } = require('./ent-usuarios-ajuda');
const { exigeReautenticacao } = require('../lib/ent/usuarios');
const { criarAuditoria } = require('../lib/auditoria');

const arquivoUsuarios = (c) => path.join(c.dataDir, 'usuarios.json');
const lerUsuarios = (c) => JSON.parse(fs.readFileSync(arquivoUsuarios(c), 'utf8')).usuarios;
const HTML = { headers: { Accept: 'text/html' } };
const login = (c, usuario, pass, extra) => cliente(c.s.porta).post('/login', Object.assign({ json: { usuario, senha: pass } }, extra));

test('nível pessoal: nada muda. Sem arquivo de usuários, sem rotas novas, login de um usuário só', async () => {
  const c = await cenarioEnt({ nivel: 'pessoal' });
  try {
    const { r, cli } = await c.entrar('dono', c.senhaTi);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, destino: '/' }, 'sem segunda etapa');
    const eu = await cli.get('/api/v1/eu');
    assert.deepEqual(eu.json, { ok: true, usuario: 'dono' }, 'o /api/v1/eu de sempre');
    assert.equal((await cli.get('/api/v1/usuarios')).status, 404);
    assert.equal((await cli.get('/usuarios', HTML)).status, 404);
    assert.equal((await cli.get('/conta', HTML)).status, 404);
    assert.equal((await cli.get('/login/2fa', HTML)).status, 404);
    assert.equal(fs.existsSync(arquivoUsuarios(c)), false, 'o usuarios.json nem é criado');
    const lista = await cli.get('/api/v1/agents');
    assert.deepEqual(lista.json.agentes.map((a) => a.id), ['admin', 'ana', 'marina']);
    assert.equal(c.eventos().length, 0, 'auditoria desligada no nível pessoal');
    assert.equal((await cli.get('/api/v1/protecoes')).status, 200);
    assert.notEqual((await cli.get('/api/v1/avisos')).status, 403);
    assert.equal((await cli.get('/a/marina', HTML)).status, 200);
    assert.equal((await cli.get('/', HTML)).headers.location, '/a/admin');
    // a sessão de sempre vale 30 dias (sessao_horas = 720)
    const l = await login(c, 'dono', c.senhaTi);
    assert.match(l.headers['set-cookie'][0], /Max-Age=2592000/);
  } finally { await c.fechar(); }
});

test('escritório: o usuário do web.env vira o primeiro TI (mesmo hash) e o login pede o 2FA', async () => {
  const c = await cenarioEnt();
  try {
    const cli = cliente(c.s.porta);
    const r = await cli.post('/login', { json: { usuario: 'dono', senha: c.senhaTi } });
    assert.equal(r.status, 200);
    assert.equal(r.json.etapa, 'ativar', '2fa = ti obriga o TI que ainda não ativou');
    assert.equal(r.json.destino, '/login/2fa?next=%2F');
    const u = lerUsuarios(c);
    assert.equal(u.length, 1);
    assert.equal(u[0].usuario, 'dono');
    assert.equal(u[0].papel, 'ti');
    assert.equal(u[0].hash, c.s.env.DGCLAW_PANEL_PASSWORD_HASH, 'o mesmo hash');
    assert.equal(u[0].origem, 'web.env');
    assert.equal(fs.statSync(arquivoUsuarios(c)).mode & 0o777, 0o600);
    // a sessão "meia" não abre nada, só a tela do código
    assert.equal((await cli.get('/api/v1/agents')).status, 401);
    assert.equal((await cli.get('/', HTML)).status, 302);
    const tela = await cli.get('/login/2fa', HTML);
    assert.equal(tela.status, 200);
    assert.match(tela.texto, /Segundo fator/);
    // sem a sessão meia, a tela manda para o login
    assert.equal((await cliente(c.s.porta).get('/login/2fa', HTML)).headers.location, '/login');
  } finally { await c.fechar(); }
});

test('2FA no login: ativar, receber 10 códigos de reserva, sair, entrar com código; reuso e reserva de uso único', async () => {
  const c = await cenarioEnt();
  try {
    const { r, cli, ativacao } = await c.entrar('dono', c.senhaTi);
    assert.equal(r.status, 200);
    assert.equal(ativacao.codigos_reserva.length, 10);
    for (const cod of ativacao.codigos_reserva) assert.match(cod, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.equal(ativacao.destino, '/');
    assert.equal((await cli.get('/api/v1/agents')).status, 200, 'sessão completa');
    const eu = (await cli.get('/api/v1/eu')).json;
    assert.equal(eu.papel, 'ti');
    assert.equal(eu.totp.ativo, true);
    assert.equal(eu.totp.codigos_reserva, 10);
    assert.equal(eu.pode_desativar_2fa, false, 'no escritório o TI é obrigado');
    // no disco: segredo, só o hash dos códigos de reserva
    const gravado = lerUsuarios(c)[0];
    assert.equal(gravado.totp.ativo, true);
    assert.equal(gravado.totp.codigos_reserva.length, 10);
    assert.ok(gravado.totp.codigos_reserva.every((h) => /^[0-9a-f]{64}$/.test(h)));
    assert.ok(!fs.readFileSync(arquivoUsuarios(c), 'utf8').includes(ativacao.codigos_reserva[0]), 'o código em claro nunca vai ao disco');

    await cli.post('/sair', { form: {} });
    // segundo login: pede o código
    const cli2 = cliente(c.s.porta);
    const p = await cli2.post('/login', { json: { usuario: 'dono', senha: c.senhaTi } });
    assert.equal(p.json.etapa, 'codigo');
    const estado = await cli2.get('/api/v1/login/2fa');
    assert.equal(estado.json.etapa, 'codigo');
    assert.equal(estado.json.segredo, undefined, 'o segredo não sai depois de ativado');
    const errado = await cli2.post('/api/v1/login/2fa', { json: { codigo: '000000' } });
    assert.equal(errado.status, 400);
    assert.match(errado.json.erro, /Código errado/);
    const bom = c.codigo('dono');
    const ok = await cli2.post('/api/v1/login/2fa', { json: { codigo: bom } });
    assert.equal(ok.status, 200);
    assert.equal((await cli2.get('/api/v1/agents')).status, 200);
    assert.ok(lerUsuarios(c)[0].ultimo_login, 'ultimo_login gravado');

    // o mesmo código não vale outra vez
    await cli2.post('/sair', { form: {} });
    const cli3 = cliente(c.s.porta);
    await cli3.post('/login', { json: { usuario: 'dono', senha: c.senhaTi } });
    const reuso = await cli3.post('/api/v1/login/2fa', { json: { codigo: bom } });
    assert.equal(reuso.status, 400);
    assert.match(reuso.json.erro, /já foi usado/);

    // código de reserva: vale uma vez
    const reserva = ativacao.codigos_reserva[3];
    const usa = await cli3.post('/api/v1/login/2fa', { json: { codigo: reserva.toUpperCase().replace(/-/g, ' ') } });
    assert.equal(usa.status, 200);
    assert.match(usa.json.aviso, /Restam 9/);
    await cli3.post('/sair', { form: {} });
    const cli4 = cliente(c.s.porta);
    await cli4.post('/login', { json: { usuario: 'dono', senha: c.senhaTi } });
    assert.equal((await cli4.post('/api/v1/login/2fa', { json: { codigo: reserva } })).status, 400, 'reserva usada não volta');

    const ev = c.eventos().map((e) => e.evento);
    for (const esperado of ['2fa_ativado', 'login_ok', 'logout', '2fa_falha', 'codigo_reserva_usado']) assert.ok(ev.includes(esperado), `falta o evento ${esperado}: ${ev.join(',')}`);
  } finally { await c.fechar(); }
});

test('senha errada: erro igual para usuário inexistente, sem a senha na auditoria, com IP e user-agent cortado', async () => {
  const c = await cenarioEnt();
  try {
    const cli = cliente(c.s.porta);
    const errada = aleatoria('errada');
    const ua = 'Mozilla/5.0 ' + 'x'.repeat(300);
    const a = await cli.post('/login', { json: { usuario: 'dono', senha: errada }, headers: { 'User-Agent': ua } });
    const b = await cli.post('/login', { json: { usuario: 'ninguem', senha: errada } });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.json.erro, b.json.erro);
    const falhas = c.eventos().filter((e) => e.evento === 'login_falha');
    assert.equal(falhas.length, 2);
    assert.ok(!JSON.stringify(falhas).includes(errada), 'a senha nunca entra na auditoria');
    assert.equal(falhas[0].dados.ip, '127.0.0.1');
    assert.ok(falhas[0].dados.ua.length <= 120);
    assert.equal(falhas[0].origem, 'web');
  } finally { await c.fechar(); }
});

test('10 falhas em 15 min trancam a conta por 15 min (e o evento sai uma vez); depois destranca', async () => {
  const c = await cenarioEnt();
  try {
    // IPs diferentes (proxy confiável é o loopback) para o bloqueio por IP não atrapalhar: quem tranca é a conta.
    let ultima;
    for (let i = 0; i < 12; i += 1) {
      ultima = await login(c, 'dono', aleatoria('errada'), { headers: { 'X-Forwarded-For': `10.0.0.${i}` } });
      c.tempo.avanca(1000);
    }
    assert.equal(ultima.status, 429);
    assert.match(ultima.json.erro, /trancada/);
    assert.ok(ultima.json.retryAfter > 0);
    // com a senha certa, trancada continua trancada
    const durante = await login(c, 'dono', c.senhaTi, { headers: { 'X-Forwarded-For': '10.9.9.9' } });
    assert.equal(durante.status, 429);
    assert.equal(c.eventos().filter((e) => e.evento === 'conta_trancada').length, 1);
    c.tempo.avanca(16 * 60000);
    const depois = await login(c, 'dono', c.senhaTi, { headers: { 'X-Forwarded-For': '10.9.9.8' } });
    assert.equal(depois.status, 200);
    const trancada = c.eventos().find((e) => e.evento === 'conta_trancada');
    assert.equal(trancada.dados.minutos, 15);
  } finally { await c.fechar(); }
});

test('código errado demais na etapa do 2FA derruba a etapa e exige a senha de novo', async () => {
  const c = await cenarioEnt();
  try {
    const cli = cliente(c.s.porta);
    await cli.post('/login', { json: { usuario: 'dono', senha: c.senhaTi } });
    let r;
    for (let i = 0; i < 5; i += 1) r = await cli.post('/api/v1/login/2fa', { json: { codigo: '111111' } });
    assert.equal(r.status, 429);
    assert.equal(r.json.reiniciar, true);
    assert.equal((await cli.get('/api/v1/login/2fa')).status, 401, 'a etapa acabou');
  } finally { await c.fechar(); }
});

test('a etapa do código expira em 5 minutos', async () => {
  const c = await cenarioEnt();
  try {
    const cli = cliente(c.s.porta);
    await cli.post('/login', { json: { usuario: 'dono', senha: c.senhaTi } });
    assert.equal((await cli.get('/api/v1/login/2fa')).status, 200);
    c.tempo.avanca(5 * 60000 + 1000);
    const r = await cli.get('/api/v1/login/2fa');
    assert.equal(r.status, 401);
    assert.match(r.json.erro, /expirou/);
  } finally { await c.fechar(); }
});

test('sessao_horas da matriz manda no prazo do cookie; empresa exige 2FA de todos', async () => {
  const c = await cenarioEnt({ nivel: 'empresa', ajustes: { sessao_horas: 24 } });
  try {
    const { cli: ti } = await c.entrar('dono', c.senhaTi);
    const r = await criarUsuario(c, ti, { usuario: 'ana.silva', nome: 'Ana', papel: 'funcionario', agentes: ['ana'] });
    const p = await login(c, r.usuario, r.senha);
    assert.equal(p.json.etapa, 'ativar', '2fa = todos obriga até o funcionário');
    // a sessão completa dura 24 h
    const e = await c.entrar('ana.silva', r.senha);
    assert.equal(e.r.status, 200);
    assert.match(e.r.headers['set-cookie'][0], /Max-Age=86400/);
    // a meia dura 5 min
    const meia = await login(c, 'ana.silva', r.senha);
    assert.match(meia.headers['set-cookie'][0], /Max-Age=300/);
  } finally { await c.fechar(); }
});

test('usuários: criar com link de uso único, listar, alterar, desativar (derruba sessões) e proteger o último TI', async () => {
  const c = await cenarioEnt();
  try {
    const { cli: ti } = await c.entrar('dono', c.senhaTi);
    const ruim = await ti.post('/api/v1/usuarios', { json: { usuario: 'A B', papel: 'ti' } });
    assert.equal(ruim.status, 400);
    assert.match(ruim.json.erro, /letras minúsculas/);
    assert.equal((await ti.post('/api/v1/usuarios', { json: { usuario: 'bia', papel: 'chefe' } })).status, 400);
    const agRuim = await ti.post('/api/v1/usuarios', { json: { usuario: 'bia', papel: 'funcionario', agentes: ['admin'] } });
    assert.equal(agRuim.status, 400);
    assert.match(agRuim.json.erro, /Admin não pode/);

    const criado = await ti.post('/api/v1/usuarios', { json: { usuario: 'Bia', nome: 'Bia Souza', email: 'bia@empresa.com', papel: 'funcionario', agentes: ['ana'] } });
    assert.equal(criado.status, 201);
    assert.equal(criado.json.usuario.usuario, 'bia');
    assert.match(criado.json.link, /^http:\/\/127\.0\.0\.1:\d+\/primeiro-acesso#[A-Za-z0-9_-]{43}$/);
    assert.equal(criado.json.usuario.link_pendente, true);
    assert.equal((await ti.post('/api/v1/usuarios', { json: { usuario: 'bia', papel: 'ti' } })).status, 409);
    const token = criado.json.link.split('#')[1];
    assert.ok(!JSON.stringify(c.eventos()).includes(token), 'o token do link não vai à auditoria');
    assert.ok(!fs.readFileSync(arquivoUsuarios(c), 'utf8').includes(token), 'nem ao disco: só o sha256');

    // antes de usar o link a conta não entra
    assert.equal((await login(c, 'bia', aleatoria('qualquer'))).status, 401);
    const anon = cliente(c.s.porta);
    const curta = aleatoria('c').slice(0, 5);
    const nova = aleatoria('nova');
    assert.equal((await anon.post('/api/primeiro-acesso', { json: { token, senha: curta, confirmacao: curta } })).status, 400);
    assert.equal((await anon.post('/api/primeiro-acesso', { json: { token, senha: nova, confirmacao: aleatoria('outra') } })).status, 400);
    const usou = await anon.post('/api/primeiro-acesso', { json: { token, senha: nova, confirmacao: nova } });
    assert.equal(usou.status, 200);
    assert.equal(usou.json.destino, '/login');
    const denovo = await anon.post('/api/primeiro-acesso', { json: { token, senha: nova, confirmacao: nova } });
    assert.equal(denovo.status, 410, 'link de uso único');

    const bia = await c.entrar('bia', nova);
    assert.equal(bia.r.status, 200);
    assert.equal(bia.r.json.etapa, undefined, 'funcionário não é obrigado a ter 2FA no escritório');
    assert.equal((await bia.cli.get('/api/v1/eu')).json.papel, 'funcionario');

    // lista e alteração
    const lista = (await ti.get('/api/v1/usuarios')).json;
    assert.deepEqual(lista.usuarios.map((u) => u.usuario), ['dono', 'bia']);
    assert.deepEqual(lista.agentes_disponiveis.map((a) => a.id), ['ana', 'marina']);
    assert.ok(!JSON.stringify(lista).includes('scrypt$'), 'o hash nunca sai pela API');
    assert.ok(!JSON.stringify(lista).includes('"segredo"'));
    const alt = await ti.pedir('PATCH', '/api/v1/usuarios/bia', { json: { agentes: ['ana', 'marina'], nome: 'Beatriz' } });
    assert.equal(alt.status, 200);
    assert.deepEqual(alt.json.usuario.agentes, ['ana', 'marina']);
    assert.equal((await ti.pedir('PATCH', '/api/v1/usuarios/bia', { json: { hash: 'x' } })).status, 400);
    assert.equal((await ti.pedir('PATCH', '/api/v1/usuarios/nao-existe', { json: { nome: 'x' } })).status, 404);
    const sem = await ti.pedir('PATCH', '/api/v1/usuarios/bia', { json: { agentes: ['ana', 'marina'] } });
    assert.equal(sem.json.mudou, false);

    // o último TI não sai nem se rebaixa; ninguém se desativa
    const ultimo = await ti.pedir('DELETE', '/api/v1/usuarios/dono');
    assert.equal(ultimo.status, 409);
    assert.match(ultimo.json.erro, /não pode desativar a si mesmo/);
    const rebaixa = await ti.pedir('PATCH', '/api/v1/usuarios/dono', { json: { papel: 'funcionario' } });
    assert.equal(rebaixa.status, 409);
    assert.match(rebaixa.json.erro, /único usuário TI ativo/);
    await ti.pedir('PATCH', '/api/v1/usuarios/bia', { json: { papel: 'ti' } });
    // Bia (agora TI) não se desativa
    const biaTI = await c.entrar('bia', nova);
    assert.equal((await biaTI.cli.pedir('DELETE', '/api/v1/usuarios/bia')).status, 409);
    await ti.pedir('PATCH', '/api/v1/usuarios/bia', { json: { papel: 'funcionario' } });

    // desativar derruba a sessão e impede o login
    const des = await ti.pedir('DELETE', '/api/v1/usuarios/bia');
    assert.equal(des.status, 200);
    assert.equal(des.json.usuario.ativo, false);
    assert.equal((await bia.cli.get('/api/v1/agents')).status, 401, 'a sessão dela caiu na hora');
    assert.equal((await login(c, 'bia', nova)).status, 401);
    assert.equal((await ti.pedir('DELETE', '/api/v1/usuarios/bia')).json.ja_estava, true);
    const re = await ti.pedir('PATCH', '/api/v1/usuarios/bia', { json: { ativo: true } });
    assert.equal(re.json.usuario.ativo, true);

    const ev = c.eventos().map((e) => e.evento);
    for (const esperado of ['usuario_criado', 'usuario_alterado', 'usuario_desativado', 'senha_trocada']) assert.ok(ev.includes(esperado), esperado);
  } finally { await c.fechar(); }
});

test('conta: trocar a senha confere a atual, encerra as outras sessões e audita; sessões listam e revogam', async () => {
  const c = await cenarioEnt();
  try {
    const { cli: ti } = await c.entrar('dono', c.senhaTi);
    const u = await criarUsuario(c, ti, { usuario: 'caio', papel: 'funcionario', agentes: ['ana'] });
    const a = await c.entrar('caio', u.senha, { cli: cliente(c.s.porta) });
    const b = await c.entrar('caio', u.senha, { cli: cliente(c.s.porta) });
    const sessoes = (await a.cli.get('/api/v1/eu/sessoes')).json.sessoes;
    assert.equal(sessoes.length, 2);
    assert.equal(sessoes.filter((s) => s.atual).length, 1);
    assert.equal(sessoes[0].ip, '127.0.0.1');
    assert.ok(sessoes.every((s) => /^[0-9a-f]{16}$/.test(s.id)));

    const nova = aleatoria('nova');
    const errada = await a.cli.post('/api/v1/eu/senha', { json: { senha_atual: aleatoria('x'), senha_nova: nova, confirmacao: nova } });
    assert.equal(errada.status, 403);
    assert.match(errada.json.erro, /senha atual não confere/);
    const curta = aleatoria('c').slice(0, 5);
    assert.equal((await a.cli.post('/api/v1/eu/senha', { json: { senha_atual: u.senha, senha_nova: curta, confirmacao: curta } })).status, 400);
    const ok = await a.cli.post('/api/v1/eu/senha', { json: { senha_atual: u.senha, senha_nova: nova, confirmacao: nova } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.sessoes_encerradas, 1);
    assert.equal((await a.cli.get('/api/v1/agents')).status, 200, 'a sessão que trocou continua');
    assert.equal((await b.cli.get('/api/v1/agents')).status, 401, 'a outra caiu');
    assert.equal((await login(c, 'caio', u.senha)).status, 401);
    assert.equal((await c.entrar('caio', nova)).r.status, 200);

    // revogar uma sessão pelo id, e todas
    const outra = await c.entrar('caio', nova, { cli: cliente(c.s.porta) });
    const lista = (await a.cli.get('/api/v1/eu/sessoes')).json.sessoes;
    const alvo = lista.find((s) => !s.atual);
    assert.equal((await a.cli.pedir('DELETE', `/api/v1/eu/sessoes/${alvo.id}`)).status, 200);
    assert.equal((await a.cli.pedir('DELETE', `/api/v1/eu/sessoes/${alvo.id}`)).status, 404);
    assert.equal((await a.cli.pedir('DELETE', '/api/v1/eu/sessoes/xx')).status, 400);
    const todas = await a.cli.pedir('DELETE', '/api/v1/eu/sessoes');
    assert.equal(todas.status, 200);
    assert.equal(todas.json.inclui_a_atual, true);
    assert.equal((await a.cli.get('/api/v1/agents')).status, 401);
    assert.equal((await outra.cli.get('/api/v1/agents')).status, 401);

    // o TI também vê e revoga as sessões de qualquer um
    const maisUma = await c.entrar('caio', nova, { cli: cliente(c.s.porta) });
    assert.equal((await ti.get('/api/v1/usuarios/caio/sessoes')).json.sessoes.length, 1);
    assert.equal((await ti.pedir('DELETE', '/api/v1/usuarios/caio/sessoes')).json.encerradas, 1);
    assert.equal((await maisUma.cli.get('/api/v1/agents')).status, 401);
    const ev = c.eventos();
    assert.ok(ev.some((e) => e.evento === 'senha_trocada' && e.quem === 'caio' && e.dados.via === 'conta'));
    assert.ok(ev.some((e) => e.evento === 'sessao_revogada'));
  } finally { await c.fechar(); }
});

test('2FA na conta: iniciar, ativar com código, funcionário pode desativar (senha + código) e o TI não', async () => {
  const c = await cenarioEnt();
  try {
    const { cli: ti } = await c.entrar('dono', c.senhaTi);
    const u = await criarUsuario(c, ti, { usuario: 'duda', papel: 'funcionario', agentes: ['ana'] });
    const { cli } = await c.entrar('duda', u.senha);
    const ini = await cli.post('/api/v1/eu/2fa/iniciar', { json: {} });
    assert.equal(ini.status, 200);
    assert.match(ini.json.segredo, /^[A-Z2-7]{32}$/);
    assert.match(ini.json.segredo_agrupado, /^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    assert.match(ini.json.otpauth, /^otpauth:\/\/totp\/DG%20Claw.*duda\?secret=/);
    c.segredos.duda = ini.json.segredo;
    assert.equal((await cli.post('/api/v1/eu/2fa/ativar', { json: { codigo: '123456' } })).status, 400);
    const ativ = await cli.post('/api/v1/eu/2fa/ativar', { json: { codigo: c.codigo('duda') } });
    assert.equal(ativ.status, 200);
    assert.equal(ativ.json.codigos_reserva.length, 10);
    assert.equal((await cli.post('/api/v1/eu/2fa/iniciar', { json: {} })).status, 409, 'já ativo');

    // agora o login pede o código
    assert.equal((await login(c, 'duda', u.senha)).json.etapa, 'codigo');

    // desativar: senha errada, código errado, certo
    assert.equal((await cli.post('/api/v1/eu/2fa/desativar', { json: { senha: aleatoria('x'), codigo: c.codigo('duda') } })).status, 403);
    assert.equal((await cli.post('/api/v1/eu/2fa/desativar', { json: { senha: u.senha, codigo: '000000' } })).status, 400);
    const des = await cli.post('/api/v1/eu/2fa/desativar', { json: { senha: u.senha, codigo: c.codigo('duda') } });
    assert.equal(des.status, 200);
    assert.equal((await login(c, 'duda', u.senha)).json.etapa, undefined);

    // o TI não pode desativar o próprio 2FA neste nível
    const r = await ti.post('/api/v1/eu/2fa/desativar', { json: { senha: c.senhaTi, codigo: c.codigo('dono') } });
    assert.equal(r.status, 403);
    assert.match(r.json.erro, /obrigatório/);
    const ev = c.eventos().map((e) => e.evento);
    assert.ok(ev.includes('2fa_ativado') && ev.includes('2fa_desativado'));
  } finally { await c.fechar(); }
});

test('zerar o 2FA pelo TI derruba as sessões e a pessoa ativa de novo no próximo login', async () => {
  const c = await cenarioEnt();
  try {
    const { cli: ti } = await c.entrar('dono', c.senhaTi);
    const u = await criarUsuario(c, ti, { usuario: 'edu', papel: 'ti' });
    const e = await c.entrar('edu', u.senha);
    assert.equal(e.r.status, 200);
    const z = await ti.post('/api/v1/usuarios/edu/zerar-2fa', { json: {} });
    assert.equal(z.status, 200);
    assert.equal(z.json.sessoes_encerradas, 1);
    assert.equal((await e.cli.get('/api/v1/agents')).status, 401);
    const deNovo = await login(c, 'edu', u.senha);
    assert.equal(deNovo.json.etapa, 'ativar', 'o TI é obrigado a ter 2FA, então ativa de novo');
    assert.equal(lerUsuarios(c).find((x) => x.usuario === 'edu').totp.ativo, false);
  } finally { await c.fechar(); }
});

test('reautenticar: exigeReautenticacao pede o 2FA de menos de 15 min', async () => {
  const c = await cenarioEnt();
  try {
    const { cli } = await c.entrar('dono', c.senhaTi);
    const sessaoDe = () => c.s.web.auth.sessaoDoPedido({ headers: { cookie: `dgclaw_sessao=${cli.jar.dgclaw_sessao}` } });
    const s0 = sessaoDe();
    assert.equal(s0.com_2fa, true);
    assert.equal(exigeReautenticacao(s0, 15, c.tempo.ms()), false, 'acabou de passar pelo 2FA');
    c.tempo.avanca(14 * 60000);
    assert.equal(exigeReautenticacao(s0, 15, c.tempo.ms()), false);
    c.tempo.avanca(2 * 60000);
    assert.equal(exigeReautenticacao(s0, 15, c.tempo.ms()), true, 'passou de 15 min');
    assert.equal(exigeReautenticacao(s0, 30, c.tempo.ms()), false, 'o prazo é parâmetro');
    assert.equal(exigeReautenticacao({ usuario: 'x', com_2fa: false }, 15, c.tempo.ms()), false, 'sem 2FA não há o que reautenticar');

    assert.equal((await cli.post('/api/v1/eu/reautenticar', { json: { codigo: '000000' } })).status, 400);
    const ok = await cli.post('/api/v1/eu/reautenticar', { json: { codigo: c.codigo('dono') } });
    assert.equal(ok.status, 200);
    assert.equal(exigeReautenticacao(sessaoDe(), 15, c.tempo.ms()), false, 'a reautenticação renovou');
    assert.ok(c.eventos().some((e) => e.evento === 'reautenticado'));
  } finally { await c.fechar(); }
});

test('sessão de antes do multiusuário (ou de quem passou a precisar de 2FA) não vale', async () => {
  const c = await cenarioEnt({ nivel: 'pessoal' });
  try {
    const { cli } = await c.entrar('dono', c.senhaTi);
    assert.equal((await cli.get('/api/v1/agents')).status, 200);
    // sobe o nível sem reiniciar o Web: o arquivo é relido
    fs.writeFileSync(c.protecoesPath, JSON.stringify({ nivel: 'escritorio', ajustes: {} }));
    const depois = await cli.get('/api/v1/agents');
    assert.equal(depois.status, 401, 'a sessão antiga não tem papel nem 2FA: entra de novo');
    assert.equal((await login(c, 'dono', c.senhaTi)).json.etapa, 'ativar');
  } finally { await c.fechar(); }
});

test('arquivo de usuários corrompido: ninguém entra e o erro diz o que fazer', async () => {
  const c = await cenarioEnt();
  try {
    await login(c, 'dono', c.senhaTi);   // cria o arquivo
    fs.writeFileSync(arquivoUsuarios(c), '{quebrado');
    const r = await login(c, 'dono', c.senhaTi);
    assert.equal(r.status, 403);
    assert.match(r.json.erro, /não é um JSON válido/);
    assert.match(r.json.erro, /Restaure/);
    assert.match(c.s.log.texto(), /\[erro\].*usuarios\.json/);
  } finally { await c.fechar(); }
});

test('a corrente da auditoria fica íntegra depois de tudo isso', async () => {
  const c = await cenarioEnt();
  try {
    const { cli: ti } = await c.entrar('dono', c.senhaTi);
    await criarUsuario(c, ti, { usuario: 'fabio', papel: 'funcionario', agentes: ['ana'] });
    await login(c, 'fabio', aleatoria('errada'));
    const v = criarAuditoria({ caminho: c.auditoriaPath }).verificar();
    assert.equal(v.ok, true);
    assert.ok(v.linhas >= 4);
    assert.ok(c.eventos().every((e) => e.origem === 'web'));
  } finally { await c.fechar(); }
});

test('o primeiro acesso do web.env continua valendo no multiusuário: grava o hash e a próxima entrada é pelo login normal', async () => {
  const dir = pastaTemp('pa-ent');
  const webEnv = path.join(dir, 'web.env');
  fs.writeFileSync(webEnv, "DGCLAW_PANEL_USER=maria\nDGCLAW_PANEL_PASSWORD_HASH=''\n", { mode: 0o600 });
  const c = await cenarioEnt({ web: { semHash: true, env: { DGCLAW_PANEL_USER: 'maria', DGCLAW_WEB_ENV: webEnv } } });
  try {
    const token = crypto.randomBytes(32).toString('base64url');
    const agora = c.tempo.ms();
    fs.writeFileSync(path.join(dir, 'primeiro-acesso.json'), JSON.stringify({
      versao: 1, usuario: 'maria', token_sha256: crypto.createHash('sha256').update(token).digest('hex'), criado: agora, expira: agora + 30 * 60 * 1000, usado_em: null,
    }) + '\n', { mode: 0o600 });
    const nova = aleatoria('nova');
    const cli = cliente(c.s.porta);
    const r = await cli.post('/api/primeiro-acesso', { json: { token, senha: nova, confirmacao: nova } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.destino, '/a/admin');
    assert.match(fs.readFileSync(webEnv, 'utf8'), /DGCLAW_PANEL_PASSWORD_HASH='scrypt\$/);
    // a sessão que esse caminho cria não tem papel: o multiusuário a recusa e a pessoa entra pelo login normal
    assert.equal((await cli.get('/api/v1/agents')).status, 401);
    const l = await login(c, 'maria', nova);
    assert.equal(l.status, 200);
    assert.equal(l.json.etapa, 'ativar');
    const u = lerUsuarios(c).find((x) => x.usuario === 'maria');
    assert.equal(u.papel, 'ti');
    assert.match(u.hash, /^scrypt\$/, 'o hash foi copiado para o arquivo de usuários');
    // token que não é de ninguém continua dando o erro de sempre
    const outro = await cliente(c.s.porta).post('/api/primeiro-acesso', { json: { token: crypto.randomBytes(32).toString('base64url'), senha: nova, confirmacao: nova } });
    assert.ok([403, 410, 404].includes(outro.status), String(outro.status));
  } finally { await c.fechar(); }
});
