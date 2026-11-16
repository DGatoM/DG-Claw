'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./_ds-stub');
const { subirWeb } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { loja } = require('../lib/onboarding');

const ANSI = '\x1b[1;36m', FIM = '\x1b[0m';
const passoLog = (n, t) => `\n${ANSI}[${n}] ${t}${FIM}\n   ok  feito\n`;
const pedido = { id: 'a'.repeat(32), nome: 'Sofia', papel: 'Organizar minha agenda', jeito: 'Acolhedor e direto' };

async function cenario(t, estado = async () => 'inactive') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'progresso-'));
  const logImagem = path.join(tmp, 'imagem.log');
  const runner = criarRunnerFalso({ agenteId: 'admin' }), porta = await runner.ouvir();
  const web = await subirWeb({ agentes: [{ slug: 'admin', tipo: 'admin', nome: 'Admin', provedor: 'claude', runner: 'http://127.0.0.1:' + porta, agente_id: 'admin' }],
    opcoesServidor: { imagem: { estado: (...a) => estado(...a), ttlMs: 0, log: logImagem } } });
  t.after(async () => { await web.fechar(); await runner.fechar(); fs.rmSync(web.dir, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); });
  await web.login();
  const db = loja(web.dados);
  const base = { ...pedido, criado: new Date().toISOString(), slug: 'sofia' };
  const ver = async () => (await web.c.get('/api/v1/onboarding')).json.progresso;
  return { web, db, base, ver, logImagem, logCli: () => path.join(db.dir, pedido.id + '.log') };
}

test('percentual e etapa por fase, sem diminuir dentro do mesmo pedido', async t => {
  const { db, base, ver } = await cenario(t);
  const esperado = { enviando: [2, 'Enviando'], solicitado: [5, 'O Admin está lendo'], login: [85, 'Falta conectar a assinatura'], testando: [92, 'primeiro oi'], pronto: [100, 'Pronto!'] };
  let anterior = 0;
  for (const [fase, [pct, texto]] of Object.entries(esperado)) {
    db.gravar({ ...base, fase, mensagem: '' });
    const pr = await ver();
    assert.equal(pr.pct, pct, fase); assert.match(pr.etapa, new RegExp(texto)); assert.equal(pr.erro, null);
    assert.ok(pr.pct >= anterior); anterior = pr.pct;
    // o próximo marco nunca fica atrás do atual; fora do pronto, fica à frente
    assert.ok(pr.proximo >= pr.pct, fase); if (fase !== 'pronto') assert.ok(pr.proximo > pr.pct, fase);
  }
  db.gravar({ ...base, fase: 'solicitado', mensagem: '' });
  assert.equal((await ver()).pct, 100);
});

test('log da criação com ANSI dá a etapa certa e pct crescente; etapa desconhecida não faz voltar', async t => {
  const { db, base, ver, logCli } = await cenario(t);
  db.gravar({ ...base, fase: 'criando', mensagem: '' });
  assert.equal((await ver()).etapa, 'Preparando a criação do agente');
  const etapas = ['Reservando a faixa de uid e as portas do agente sofia', 'Montando a casa do agente', 'Escrevendo a identidade e a configuracao', 'Gerando os segredos', 'Criando a rede e o container', 'Aplicando as regras de firewall', 'Esperando a maquina do agente ligar'];
  const lidos = []; let texto = '';
  for (const [i, e] of etapas.entries()) { texto += passoLog(i + 1, e); fs.writeFileSync(logCli(), texto); lidos.push(await ver()); }
  assert.deepEqual(lidos.map(p => p.passo), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(lidos.every((p, i) => i === 0 || p.pct > lidos[i - 1].pct));
  assert.ok(lidos[0].pct >= 30 && lidos.at(-1).pct < 80);
  assert.equal(lidos.at(-1).etapa, 'Ligando a máquina do agente'); assert.equal(lidos.at(-1).total, 11);
  fs.writeFileSync(logCli(), texto + passoLog(8, 'Etapa que ainda nao existe'));
  const pr = await ver(); assert.equal(pr.passo, 7); assert.equal(pr.pct, lidos.at(-1).pct);
});

test('falha da CLI vira erro com motivo e o que fazer, sem segredo, até 300 caracteres', async t => {
  const { db, base, ver, logCli } = await cenario(t);
  db.gravar({ ...base, fase: 'criando', mensagem: '' });
  fs.writeFileSync(logCli(), passoLog(1, 'Reservando a faixa de uid') + passoLog(2, 'Montando a casa do agente'));
  const antes = (await ver()).pct;
  const segredo = 'sk-' + 'teste1234567890abcdef';
  fs.appendFileSync(logCli(), `\n${ANSI}Nao deu certo:${FIM} falhou com token=abc123 e ${segredo} em /etc/dgclaw/segredos/x.env ${'x'.repeat(400)}\nO que fazer: rode dgclaw doctor. Authorization: Bearer ZZZtop\n`);
  db.gravar({ ...base, fase: 'erro', ultimaFase: 'criando', mensagem: 'genérica' });
  const pr = await ver();
  assert.equal(pr.pct, antes); assert.equal(pr.etapa, 'Preparando a casa do agente');
  assert.match(pr.erro.motivo, /^falhou com/); assert.ok(pr.erro.motivo.length <= 300);
  assert.match(pr.erro.oQueFazer, /dgclaw doctor/);
  const json = JSON.stringify(pr);
  for (const proibido of [segredo, 'abc123', '/etc/dgclaw', 'ZZZtop', '\x1b']) assert.ok(!json.includes(proibido), proibido);
});

test('uma nova tentativa vale só a execução mais recente do log', async t => {
  const { db, base, ver, logCli } = await cenario(t);
  db.gravar({ ...base, fase: 'criando', mensagem: '' });
  fs.writeFileSync(logCli(), passoLog(1, 'Reservando a faixa de uid') + '\nNao deu certo: erro antigo\nO que fazer: antigo\n' + passoLog(1, 'Reservando a faixa de uid'));
  db.gravar({ ...base, fase: 'erro', ultimaFase: 'criando', mensagem: 'genérica' });
  assert.equal((await ver()).erro.motivo, 'genérica');
});

test('erro sem linha de falha usa o motivo do pedido; erro de envio fica em 2%', async t => {
  const { db, base, ver } = await cenario(t);
  db.gravar({ ...base, fase: 'erro', ultimaFase: 'testando', mensagem: 'genérica', motivo: 'O agente ainda não respondeu.' });
  let pr = await ver(); assert.equal(pr.pct, 92); assert.equal(pr.erro.motivo, 'O agente ainda não respondeu.'); assert.equal(pr.erro.oQueFazer, null);
  db.gravar({ ...base, id: 'c'.repeat(32), criado: new Date(Date.now() + 1000).toISOString(), fase: 'erro-envio', mensagem: 'O pedido não chegou ao Admin.' });
  pr = await ver(); assert.equal(pr.pct, 2); assert.equal(pr.erro.motivo, 'O pedido não chegou ao Admin.');
});

test('imagem: build ativo com STEP 4/10 ocupa a faixa de 5 a 30; failed vira erro; sem build segue o fluxo', async t => {
  let estado = 'active';
  const { db, base, ver, logImagem, logCli } = await cenario(t, async () => estado);
  db.gravar({ ...base, fase: 'solicitado', mensagem: '' });
  assert.equal((await ver()).pct, 5);
  fs.writeFileSync(logImagem, 'STEP 1/10: FROM debian\n--> abc\nSTEP 4/10: RUN apt-get install\n');
  let pr = await ver();
  assert.equal(pr.pct, 5 + Math.floor(25 * 4 / 10)); assert.match(pr.etapa, /Preparando a imagem dos agentes/); assert.match(pr.etapa, /de 5 a 15 minutos/);
  assert.equal(pr.passo, 4); assert.equal(pr.total, 10); assert.equal(pr.erro, null);

  // a criação começa com a imagem ainda ativa e sem etapas: a barra continua na imagem
  db.gravar({ ...base, fase: 'criando', mensagem: '' });
  assert.match((await ver()).etapa, /imagem/);
  // com etapa do dgclaw no log a criação assume a faixa de 30 a 80
  fs.writeFileSync(logCli(), passoLog(1, 'Reservando a faixa de uid'));
  pr = await ver(); assert.equal(pr.pct, 30); assert.equal(pr.passo, 1);

  estado = 'failed';
  db.gravar({ ...base, id: 'd'.repeat(32), criado: new Date(Date.now() + 1000).toISOString(), fase: 'solicitado', mensagem: '' });
  fs.writeFileSync(logImagem, 'STEP 5/10: RUN npm ci\nError: build falhou\n');
  const falha = await ver();
  assert.match(falha.erro.motivo, /imagem dos agentes falhou/); assert.match(falha.erro.motivo, /build falhou/);
  assert.match(falha.erro.oQueFazer, /dgclaw imagem construir/);

  estado = 'inactive';
  const normal = await ver();
  assert.equal(normal.erro, null); assert.equal(normal.etapa, 'O Admin está lendo o seu pedido');
});

test('consulta ao systemd que falha não derruba a tela nem o fluxo normal', async t => {
  const { db, base, ver } = await cenario(t, async () => { throw new Error('sem systemd'); });
  db.gravar({ ...base, fase: 'solicitado', mensagem: '' });
  const pr = await ver(); assert.equal(pr.pct, 5); assert.equal(pr.erro, null);
});

test('animação de nascimento: marca no servidor, só em pedido pronto, e vira cartão com a hora de conclusão', async t => {
  const { db, base, web } = await cenario(t);
  const post = id => web.c.post('/api/v1/onboarding/animacao-vista', { json: { id } });
  db.gravar({ ...base, fase: 'login', mensagem: '' });
  assert.equal((await post(pedido.id)).status, 409);
  assert.equal((await post('b'.repeat(32))).status, 404);
  db.gravar({ ...base, fase: 'pronto', mensagem: '' });
  let est = (await web.c.get('/api/v1/onboarding')).json;
  assert.equal(est.animacaoVista, false); assert.deepEqual(est.cartoes, []);
  const concluido = est.concluido; assert.ok(concluido > 0);
  assert.equal((await post(pedido.id)).status, 200);
  assert.equal((await post(pedido.id)).status, 200);
  est = (await web.c.get('/api/v1/onboarding')).json;
  assert.equal(est.animacaoVista, true);
  assert.equal(est.cartoes.length, 1); assert.equal(est.cartoes[0].nome, 'Sofia'); assert.equal(est.cartoes[0].concluido, concluido);
});

test('X do cartão: dispensar some de cartoes(), é idempotente e valida o pedido', async t => {
  const { db, base, web } = await cenario(t);
  const post = (id, opcoes) => web.c.post('/api/v1/onboarding/cartao-dispensado', { json: { id }, ...opcoes });
  assert.equal((await post('b'.repeat(32))).status, 404);
  assert.equal((await post('lixo')).status, 404);
  db.gravar({ ...base, fase: 'login', mensagem: '' });
  const r409 = await post(pedido.id);
  assert.equal(r409.status, 409); assert.match(r409.json.erro, /Aguarde/);
  db.gravar({ ...base, fase: 'pronto', mensagem: '' });
  await web.c.post('/api/v1/onboarding/animacao-vista', { json: { id: pedido.id } });
  let est = (await web.c.get('/api/v1/onboarding')).json;
  assert.equal(est.cartoes.length, 1); assert.equal(est.cartaoDispensado, false);
  const r = await post(pedido.id);
  assert.equal(r.status, 200); assert.equal(r.json.cartaoDispensado, true);
  const gravadoEm = db.ler(pedido.id).cartaoDispensado;
  assert.ok(gravadoEm);
  assert.equal((await post(pedido.id)).status, 200);
  assert.equal(db.ler(pedido.id).cartaoDispensado, gravadoEm, 'segunda chamada não regrava');
  est = (await web.c.get('/api/v1/onboarding')).json;
  assert.deepEqual(est.cartoes, []); assert.equal(est.cartaoDispensado, true);
});

test('X do cartão: rota exige sessão e aceita só POST', async t => {
  const { web } = await cenario(t);
  const get = await web.c.get('/api/v1/onboarding/cartao-dispensado');
  assert.equal(get.status, 405);
  const corpo = { json: { id: pedido.id } };
  for (const opcoes of [{ semCookie: true }, { origin: 'http://outro-site.example' }]) {
    const nova = await web.c.post('/api/v1/onboarding/cartao-dispensado', { ...corpo, ...opcoes });
    const ref = await web.c.post('/api/v1/onboarding/animacao-vista', { ...corpo, ...opcoes });
    assert.equal(nova.status, ref.status);
    assert.ok(nova.status === 401 || nova.status === 403, 'status ' + nova.status);
  }
});

test('X do cartão: htmlCartao põe o botão fora do link, com rótulo acessível', () => {
  const win = {}; new Function('window', 'document', fs.readFileSync(path.join(__dirname, '../public/onboarding.js'), 'utf8'))(win, {});
  const html = win.DGOnboarding.htmlCartao({ id: 'a'.repeat(32), nome: 'Sofia', hhmm: '10:30', conversa: '/a/sofia', foto: null });
  assert.match(html, /<button type="button" class="nas-x" data-dispensar="a{32}" aria-label="Dispensar o cartão de Sofia">/);
  const dentroDoLink = html.match(/<a [^>]*>[\s\S]*<\/a>/)[0];
  assert.ok(!dentroDoLink.includes('<button'), 'o X não pode ficar dentro do <a>');
});
