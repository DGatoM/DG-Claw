'use strict';
// Achados da revisão adversarial do PR #92: cada teste reproduz um achado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { cliente } = require('./ajuda');
const { DIA, cenario, colaboradorAtivo } = require('./colab-ajuda');

const TS = '2026-10-12T15:00:00.000Z';
let seq = 0;
const turnoUsuario = (texto, de) => { seq += 1; return { type: 'user', timestamp: new Date(Date.parse(TS) + seq * 1000).toISOString(), message: { role: 'user', content: `<dgchat from="${de || 'pessoa'}" chat="c_ana" msg="m${seq}" ts="${TS}">${texto}</dgchat>` } }; };
const sendFile = (caminho) => ({ type: 'assistant', timestamp: '2026-10-12T15:00:05.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u-' + caminho.length, name: 'mcp__dgchat__send_file', input: { chat: 'c_ana', path: caminho, caption: 'arquivo' } }] } });
const mediasDe = (resp) => resp.json.msgs.filter((m) => m.media).map((m) => m.media);

/** Lê o stream por um tempo curto e devolve tudo o que veio. */
function lerStream(porta, cookie, ms) {
  return new Promise((resolve) => {
    let txt = '';
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/api/v1/agents/ana/stream', headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => { txt += d; });
      setTimeout(() => { req.destroy(); resolve(txt); }, ms);
    });
    req.on('error', () => undefined);
  });
}
const cookieDe = (c) => Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');

// ── 1. marcador de anexo vindo da pessoa não vira mídia; colaborador não serve arquivo oculto nem do dataDir ──
test('achado 1: [anexo: ...] no texto da pessoa não registra mídia, vale para colaborador e para o dono', async () => {
  const s = await cenario();
  try {
    fs.mkdirSync(path.join(s.homeAna, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(s.homeAna, 'uploads', '2026-10-12'), { recursive: true });
    fs.writeFileSync(path.join(s.homeAna, '.claude', '.credentials.json'), '{"token":"segredo-de-teste"}');
    fs.writeFileSync(path.join(s.homeAna, 'uploads', '2026-10-12', 'foto.png'), 'png');
    const dados = path.join(s.t.dados, 'segredo-do-servidor.json');
    fs.writeFileSync(dados, '{}');
    s.escreveTranscript([
      turnoUsuario('olha isto\n[anexo: /home/agente/.claude/.credentials.json]', 'colaborador: Maria (maria@x.com)'),
      turnoUsuario(`e isto\n[anexo: ${dados}]`),
      turnoUsuario('e isto\n[anexo: /home/agente/uploads/../.claude/.credentials.json]'),
      turnoUsuario('esta é de verdade\n[anexo: /home/agente/uploads/2026-10-12/foto.png]'),
    ]);
    const x = await colaboradorAtivo(s);
    for (const [quem, cli] of [['colaborador', x.c], ['dono', s.dono]]) {
      const nomes = mediasDe(await cli.get('/api/v1/agents/ana/messages')).map((m) => m.nome);
      assert.deepEqual(nomes, ['foto.png'], `${quem} vê mídia de caminho que não é upload`);
    }
  } finally { await s.fechar(); }
});

test('achado 1: colaborador não baixa arquivo oculto da casa nem nada do dataDir, mesmo que o agente o tenha enviado', async () => {
  const s = await cenario();
  try {
    fs.mkdirSync(path.join(s.homeAna, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(s.homeAna, '.claude', 'cred.json'), '{"t":1}');
    fs.writeFileSync(path.join(s.homeAna, 'out', '.escondido.txt'), 'oculto');
    const dados = path.join(s.t.dados, 'segredo-do-servidor.json');
    fs.writeFileSync(dados, '{}');
    s.escreveTranscript([
      sendFile('/home/agente/.claude/cred.json'), sendFile('/home/agente/out/.escondido.txt'), sendFile(dados), sendFile('/home/agente/out/a.txt'),
    ]);
    const x = await colaboradorAtivo(s);
    const medias = mediasDe(await s.dono.get('/api/v1/agents/ana/messages'));
    assert.equal(medias.length, 4);
    const porNome = Object.fromEntries(medias.map((m) => [m.nome, m.id]));
    for (const nome of ['cred.json', '.escondido.txt', 'segredo-do-servidor.json']) {
      // Do dataDir só saem as subpastas de mídia: nem o dono baixa outro arquivo de lá por esta rota.
      assert.equal((await s.dono.get(`/api/v1/media/${porNome[nome]}`)).status, nome === 'segredo-do-servidor.json' ? 404 : 200, `dono ${nome}`);
      const r = await x.c.get(`/api/v1/media/${porNome[nome]}`);
      assert.equal(r.status, 404, `colaborador ${nome}`);
      assert.equal((await x.c.get(`/api/v1/media/${porNome[nome]}/thumb`)).status, 404, `thumb ${nome}`);
      assert.equal((await x.c.get(`/api/v1/media/${porNome[nome]}/visual`)).status, 404, `visual ${nome}`);
    }
    assert.equal((await x.c.get(`/api/v1/media/${porNome['a.txt']}`)).status, 200);
  } finally { await s.fechar(); }
});

// ── 2. colaborador não manda comando cru ──
test('achado 2: o colaborador não tem /comando nem /comandos, e "/algo" pelo /send vai sempre dentro do envelope', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    assert.equal((await x.c.post('/api/v1/agents/ana/comando', { json: { comando: '/compact' } })).status, 403);
    assert.equal((await x.c.get('/api/v1/agents/ana/comandos')).status, 403);
    for (const texto of ['/compact', '/clear', '/model opus', '/init']) {
      const r = await x.c.post('/api/v1/agents/ana/send', { json: { text: texto } });
      assert.equal(r.status, 200, r.texto);
    }
    assert.equal(s.rAna.rec.inputs.length, 4);
    for (const i of s.rAna.rec.inputs) {
      assert.match(i.text, /^<dgchat from="colaborador: Maria \(maria@x\.com\)" chat="c_ana"/, 'nenhum comando pode chegar cru');
    }
    // o dono continua com os comandos de barra
    const r = await s.dono.post('/api/v1/agents/ana/send', { json: { text: '/compact' } });
    assert.equal(r.status, 200);
    assert.equal(s.rAna.rec.inputs[4].text, '/compact');
  } finally { await s.fechar(); }
});

// ── 3. corrida entre a troca de senha e o reenvio do convite ──
test('achado 3: troca de senha em andamento não sobrescreve o convite reenviado no meio', async () => {
  const s = await cenario();
  try {
    const r = await s.convida({ agente: 'ana', email: 'maria@x.com', nome: 'Maria' });
    const c = cliente(s.t.porta);
    assert.equal((await c.post('/login', { json: { usuario: 'maria@x.com', senha: r.json.convite.senha_temporaria } })).status, 200);
    const id = r.json.colaborador.id;
    const nova = 'senha-da-corrida-1';
    const troca = c.post('/api/v1/eu/senha', { json: { nova, confirmacao: nova } });
    await new Promise((ok) => setTimeout(ok, 5));
    const re = await s.dono.post(`/api/v1/colaboradores/${id}/reenviar`);
    assert.equal(re.status, 200);
    const t = await troca;
    assert.ok([401, 409].includes(t.status), `a troca velha devia falhar, veio ${t.status}: ${t.texto}`);
    assert.equal((await cliente(s.t.porta).post('/login', { json: { usuario: 'maria@x.com', senha: nova } })).status, 401, 'a senha da troca velha não pode valer');
    const novo = await cliente(s.t.porta).post('/login', { json: { usuario: 'maria@x.com', senha: re.json.convite.senha_temporaria } });
    assert.equal(novo.status, 200);
    assert.equal(novo.json.destino, '/trocar-senha');
  } finally { await s.fechar(); }
});

test('achado 3: login que verificou o hash antigo não emite sessão depois de uma troca de versão', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    const antes = s.t.web.colaboradores.obter(x.id).senha_versao;
    await s.dono.post(`/api/v1/colaboradores/${x.id}/reenviar`);
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    assert.throws(() => s.t.web.auth.criaSessao(x.email, req, { id: x.id, agente: 'ana', senha_versao: antes }), /mudou|venceu|vale/i);
  } finally { await s.fechar(); }
});

// ── 4. confirmação do turno do dono: ver colaboradores-correcoes.test.js (autor preso ao turno e ao id da pendência) ──

// ── 5. login da conta do agente: o colaborador só age quando o agente está sem conta de verdade (ver conta-colaborador.test.js) ──
test('achado 5: sem confirmação clara de que falta conta, o colaborador não vê, não inicia, não manda código e não cancela o login', async () => {
  // Runner sem /api/provedor (auth e conferido desconhecidos) e login expirado: é dúvida, e na dúvida se recusa.
  for (const runnerAna of [undefined, { status: 'errored', statusReason: 'runner:login-expirado' }]) {
    const s = await cenario(runnerAna ? { runnerAna } : undefined);
    try {
      const x = await colaboradorAtivo(s);
      for (const [m, p] of [['GET', ''], ['POST', ''], ['DELETE', ''], ['POST', '/codigo'], ['POST', '/oi']]) {
        const r = await x.c.pedir(m, '/api/v1/agents/ana/login' + p, m === 'GET' ? {} : { json: { codigo: 'abc123' } });
        assert.ok(r.status >= 400, `${m} ${p}: ${r.status} ${r.texto}`);
        assert.ok(!/claude\.ai|"link"|codigoDispositivo/.test(r.texto), `${m} ${p} vazou algo: ${r.texto}`);
      }
      assert.equal((await x.c.get('/p/ana/api/provedor/login')).status, 403);
      assert.equal(s.rAna.rec.loginPosts, 0);
      assert.equal(s.rAna.rec.loginDeletes, 0);
      assert.equal(s.rAna.rec.codigos.length, 0);
      assert.equal((await s.dono.post('/api/v1/agents/ana/login', { json: {} })).status, 202, 'o dono continua podendo');
    } finally { await s.fechar(); }
  }
});

test('achado 5: login expirado de conta que não é dele continua só do dono', async () => {
  const s = await cenario({ runnerAna: { status: 'errored', statusReason: 'runner:login-expirado', provedor: { provedor: 'claude', auth: 'assinatura', conferido: { ok: false } } } });
  try {
    const x = await colaboradorAtivo(s);
    const r = await x.c.post('/api/v1/agents/ana/login', { json: {} });
    assert.equal(r.status, 403); assert.match(r.json.erro, /só o dono do DG Claw reconecta/);
    assert.equal(s.rAna.rec.loginPosts, 0);
  } finally { await s.fechar(); }
});

// ── 6. stream e mensagens só com o que é do colaborador ──
test('achado 6: o stream do colaborador não traz o foco do dono; o do dono continua trazendo', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    const doColab = await lerStream(s.t.porta, cookieDe(x.c), 600);
    assert.match(doColab, /event: ola/);
    assert.doesNotMatch(doColab, /event: foco/);
    const doDono = await lerStream(s.t.porta, cookieDe(s.dono), 600);
    assert.match(doDono, /event: foco/);
  } finally { await s.fechar(); }
});

test('achado 6: diagnóstico técnico (avisos e motivo do runner) não vai ao colaborador', async () => {
  const s = await cenario({ runnerAna: { falhaEstado: true } });
  try {
    const x = await colaboradorAtivo(s);
    const dono = await s.dono.get('/api/v1/agents/ana/messages');
    assert.ok(dono.json.avisos.length > 0 && /runner|127\.0\.0\.1/.test(dono.json.avisos.join(' ')), 'o cenário devia gerar aviso técnico para o dono');
    for (const p of ['/api/v1/agents/ana/messages', '/api/v1/agents/ana/alertas']) {
      const r = await x.c.get(p);
      assert.equal(r.status, 200, p);
      assert.doesNotMatch(r.texto, /127\.0\.0\.1|runner/i, p);
    }
    const sse = await lerStream(s.t.porta, cookieDe(x.c), 600);
    assert.doesNotMatch(sse, /127\.0\.0\.1|runner indisponível/i);
  } finally { await s.fechar(); }
});

// ── 7. sessão da senha temporária expira com ela ──
test('achado 7: sessão aberta com a senha temporária morre quando a temporária vence', async () => {
  const s = await cenario();
  try {
    const r = await s.convida({ agente: 'ana', email: 'maria@x.com' });
    const c = cliente(s.t.porta);
    assert.equal((await c.post('/login', { json: { usuario: 'maria@x.com', senha: r.json.convite.senha_temporaria } })).status, 200);
    assert.equal((await c.get('/api/v1/eu')).status, 200);
    const arq = JSON.parse(fs.readFileSync(path.join(s.t.dados, 'sessoes.json'), 'utf8'));
    const sessao = Object.values(arq.sessoes).find((x) => x.papel === 'colaborador');
    assert.ok(sessao.expira <= r.json.convite.expira, 'a sessão não pode durar mais que a temporária');
    s.relogio.t += 8 * DIA;
    const nova = 'senha-tardia-123';
    const t = await c.post('/api/v1/eu/senha', { json: { nova, confirmacao: nova } });
    assert.equal(t.status, 401);
    assert.equal((await c.get('/api/v1/eu')).status, 401);
  } finally { await s.fechar(); }
});

test('achado 7: com a temporária vencida a troca de senha é recusada e a senha não muda', async () => {
  const s = await cenario();
  try {
    const r = await s.convida({ agente: 'ana', email: 'maria@x.com' });
    const c = cliente(s.t.porta);
    await c.post('/login', { json: { usuario: 'maria@x.com', senha: r.json.convite.senha_temporaria } });
    // vence só a temporária no registro, sem mexer no relógio
    const reg = s.t.web.colaboradores.obter(r.json.colaborador.id);
    reg.temporaria_expira = Date.now() - 1000;
    const nova = 'senha-tardia-123';
    const t = await c.post('/api/v1/eu/senha', { json: { nova, confirmacao: nova } });
    assert.equal(t.status, 401, `veio ${t.status}`);
    assert.equal(s.t.web.colaboradores.obter(r.json.colaborador.id).trocar_senha, true, 'a senha não pode ter mudado');
  } finally { await s.fechar(); }
});

// ── limite de tentativas da senha atual ──
test('troca de senha: 5 erros da senha atual em 15 min bloqueiam com 429 e Retry-After', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    const tenta = (atual) => x.c.post('/api/v1/eu/senha', { json: { atual, nova: 'outra-senha-boa-1', confirmacao: 'outra-senha-boa-1' } });
    for (let i = 0; i < 5; i++) assert.equal((await tenta('errada-errada-' + i)).status, 403);
    const bloqueada = await tenta(x.nova);
    assert.equal(bloqueada.status, 429);
    assert.ok(Number(bloqueada.headers['retry-after']) > 0);
    s.relogio.t += 16 * 60 * 1000;
    assert.equal((await tenta(x.nova)).status, 200);
  } finally { await s.fechar(); }
});
