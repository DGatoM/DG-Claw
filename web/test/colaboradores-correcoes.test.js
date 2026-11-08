'use strict';
// Segunda rodada da revisão adversarial do PR #92: um teste por achado.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { cliente, pastaTemp, capturaLog } = require('./ajuda');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');
const { criarAuth } = require('../lib/auth');

const TS = '2026-10-12T15:00:00.000Z';
// `colab`: o colaborador_id que o servidor grava no envelope da mensagem de um colaborador.
const msg = (n, texto, colab) => ({ type: 'user', timestamp: TS, message: { role: 'user', content: `<dgchat from="${colab ? 'colaborador: Maria (maria@x.com)' : 'pessoa'}" chat="c_ana" msg="m${n}" ts="${TS}"${colab ? ` colaborador_id="${colab}"` : ''}>${texto}</dgchat>` } });
const usoBash = (id) => ({ type: 'assistant', timestamp: '2026-10-12T15:00:05.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo oi > /tmp/x', description: 'Grava um arquivo' } }] } });
const PALPITE = 'palpite-errado';
const OUTRO_PALPITE = 'qualquer-coisa-1';
const VALOR_ANTIGO = 'valor-antigo-boa-1';
const ESCOLHA_DO_ATACANTE = 'escolha-do-atacante-1';
const entrar = (porta, usuario, valor) => cliente(porta).post('/login', { json: { usuario, senha: valor } });
/** O estado do runner tem cache de 2 s no relógio do Web: avança o relógio do cenário para o novo estado valer. */
const mudaEstado = (s, status) => { s.rAna.opcoes.status = status; s.relogio.t += 3000; };

// ── achado 1: acerto de colaborador não zera as tentativas contra a senha do dono ──
test('achado 1: login válido de colaborador não zera os erros contra a senha do dono no mesmo IP', async () => {
  const s = await cenario();
  try {
    const { email, nova } = await colaboradorAtivo(s);
    for (let i = 0; i < 4; i++) assert.equal((await entrar(s.t.porta, 'dono', PALPITE)).status, 401);
    assert.equal((await entrar(s.t.porta, email, nova)).status, 200, 'o login do colaborador segue valendo');
    assert.equal((await entrar(s.t.porta, 'dono', PALPITE)).status, 401, 'o 5º erro ainda é 401');
    const certa = await entrar(s.t.porta, 'dono', s.t.senha);
    assert.equal(certa.status, 429, 'o acerto do colaborador não pode ter devolvido as tentativas');
  } finally { await s.fechar(); }
});

test('achado 1: o limite do dono não tranca o colaborador, e o teto por IP não é zerado por nenhum acerto', async () => {
  const s = await cenario();
  try {
    const { email, nova } = await colaboradorAtivo(s);
    for (let i = 0; i < 5; i++) await entrar(s.t.porta, 'dono', PALPITE);
    assert.equal((await entrar(s.t.porta, 'dono', s.t.senha)).status, 429);
    assert.equal((await entrar(s.t.porta, email, nova)).status, 200, 'o dono trancado não tranca o colaborador');
    // E-mails diferentes não se somam por identidade, mas somam no teto do IP, que o acerto do colaborador não limpa.
    for (let i = 0; i < 15; i++) await entrar(s.t.porta, `ninguem${i}@x.com`, OUTRO_PALPITE);
    assert.equal((await entrar(s.t.porta, email, nova)).status, 429, 'passou do teto de erros por IP');
  } finally { await s.fechar(); }
});

// ── achado 2: o autor da confirmação é preso ao turno que roda e ao id da pendência ──
test('achado 2: envio do colaborador que só entra na fila não o torna autor da permissão pendente do dono', async () => {
  const s = await cenario({ runnerAna: { status: 'waiting_input' } });
  try {
    const x = await colaboradorAtivo(s);
    s.escreveTranscript([msg(1, 'mexe na config'), usoBash('tu1')]);
    assert.equal((await s.dono.post('/api/v1/agents/ana/send', { json: { text: 'mexe na config' } })).json.fila.motivo, 'permissao');
    const fila = await x.c.post('/api/v1/agents/ana/send', { json: { text: 'só entrei na fila' } });
    assert.equal(fila.status, 200); assert.equal(fila.json.fila.motivo, 'permissao');
    const nega = await x.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 'tu1' } });
    assert.equal(nega.status, 403); assert.match(nega.json.erro, /Essa confirmação é do dono do DG Claw/);
    assert.equal(s.rAna.rec.permissoes.length, 0, 'nada pode ter chegado ao runner');
    assert.equal((await s.dono.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 'tu1' } })).status, 200);
  } finally { await s.fechar(); }
});

test('achado 2: o colaborador confirma a pendência do turno que ele iniciou, e só com o id certo', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    const r = await x.c.post('/api/v1/agents/ana/send', { json: { text: 'grava aquele arquivo' } });
    assert.equal(r.status, 200); assert.equal(r.json.fila, undefined, 'o agente estava ocioso: o turno começou');
    s.escreveTranscript([msg(1, 'grava aquele arquivo', x.id), usoBash('tu2')]);
    mudaEstado(s, 'waiting_input');
    assert.equal((await x.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar' } })).status, 400, 'sem id não vale');
    const errado = await x.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 'tuX' } });
    assert.equal(errado.status, 409);
    assert.equal(s.rAna.rec.permissoes.length, 0);
    assert.equal((await x.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 'tu2' } })).status, 200);
    assert.deepEqual(s.rAna.rec.permissaoIds, ['tu2']);
  } finally { await s.fechar(); }
});

test('achado 2: mensagem do dono na fila de um turno do colaborador tira dele a confirmação', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    await x.c.post('/api/v1/agents/ana/send', { json: { text: 'grava aquele arquivo' } });
    s.escreveTranscript([msg(1, 'grava aquele arquivo', x.id), usoBash('tu3')]);
    mudaEstado(s, 'waiting_input');
    assert.equal((await s.dono.post('/api/v1/agents/ana/send', { json: { text: 'e depois faz isto' } })).json.fila.motivo, 'permissao');
    const nega = await x.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 'tu3' } });
    assert.equal(nega.status, 403, nega.texto);
    assert.equal(s.rAna.rec.permissoes.length, 0);
  } finally { await s.fechar(); }
});

// ── achado 3: o login não emite sessão se o registro mudou durante o scrypt ──
test('achado 3: login cuja senha foi conferida contra um registro que mudou no meio não vira sessão', async () => {
  const t = capturaLog();
  const auth = criarAuth({ config: { env: { DGCLAW_PANEL_USER: 'dono' }, dataDir: pastaTemp('dados'), sessaoDias: 1, proxiesConfiaveis: [] }, log: t.log });
  const hashAntigo = await auth.gerarHash(VALOR_ANTIGO);
  auth.ligarInstancias(() => 'i1');
  const c = { id: 'idcolab01', instancia: 'i1', email: 'maria@x.com', agente: 'ana', hash: hashAntigo, senha_versao: 1, trocar_senha: false, revogado_em: null };
  auth.ligarColaboradores({ porEmailAtivo: () => c, obter: () => c, registrarLogin() {} });
  const pendente = auth.verificaSenha('maria@x.com', VALOR_ANTIGO, '9.9.9.9');
  // o dono reenvia o convite enquanto o scrypt roda: o registro é alterado no próprio objeto
  setImmediate(() => { c.hash = hashAntigo + 'x'; c.senha_versao = 2; c.trocar_senha = true; });
  const r = await pendente;
  assert.equal(r.ok, false, 'não pode emitir sessão com a versão nova de um login conferido na antiga');
  assert.match(r.erro, /mudou/);
  // sem mudança no meio, o mesmo caminho entra e leva o hash conferido para a emissão da sessão
  const c2 = { id: 'idcolab02', instancia: 'i1', email: 'jose@x.com', agente: 'ana', hash: hashAntigo, senha_versao: 1, trocar_senha: false, revogado_em: null };
  auth.ligarColaboradores({ porEmailAtivo: () => c2, obter: () => c2, registrarLogin() {} });
  const ok = await auth.verificaSenha('jose@x.com', VALOR_ANTIGO, '9.9.9.8');
  assert.equal(ok.ok, true);
  assert.equal(ok.colaborador.senha_versao, 1);
  assert.equal(ok.colaborador.hash, hashAntigo);
});

// ── achado 4: a troca de senha amarra o pedido à versão da sessão que o autorizou ──
test('achado 4: sessão velha, com o corpo ainda a caminho, não troca a senha do convite reenviado sem a senha atual', async () => {
  const s = await cenario();
  try {
    const r = await s.convida({ agente: 'ana', email: 'maria@x.com', nome: 'Maria' });
    const c = cliente(s.t.porta);
    assert.equal((await c.post('/login', { json: { usuario: 'maria@x.com', senha: r.json.convite.senha_temporaria } })).status, 200);
    const id = r.json.colaborador.id;
    const corpo = JSON.stringify({ nova: ESCOLHA_DO_ATACANTE, confirmacao: ESCOLHA_DO_ATACANTE });
    const cookie = Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const resposta = new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, method: 'POST', path: '/api/v1/eu/senha', headers: {
        Cookie: cookie, Origin: `http://127.0.0.1:${s.t.porta}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) } }, (res) => {
        const partes = []; res.on('data', (d) => partes.push(d)); res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(partes).toString('utf8') }));
      });
      req.on('error', reject);
      req.write(corpo.slice(0, 10));
      // o resto do corpo só sai depois que o dono reenviou o convite
      setTimeout(async () => {
        const re = await s.dono.post(`/api/v1/colaboradores/${id}/reenviar`);
        assert.equal(re.status, 200);
        req.end(corpo.slice(10));
      }, 100);
    });
    const t = await resposta;
    assert.ok([401, 409].includes(t.status), `devia recusar, veio ${t.status}: ${t.texto}`);
    assert.equal((await entrar(s.t.porta, 'maria@x.com', ESCOLHA_DO_ATACANTE)).status, 401, 'a escolha da sessão velha não pode valer');
  } finally { await s.fechar(); }
});
