'use strict';
// Bloco J, Admin desligado: o formulário /novo-agente cria o agente pelo controle (socket de mentira), sem Admin no registro.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const NA = require('../public/novo-agente');
const { criarSpawnControle } = require('../lib/ent/admin-desligado');
const { subirWeb, pastaTemp } = require('./ajuda');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const esperaAte = async (fn, ms) => {
  const limite = Date.now() + (ms || 4000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > limite) throw new Error('esperei demais por uma condição do teste');
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ── a página ────────────────────────────────────────────────────────────────
test('novo-agente.html: casca, tour, viewport e Tutorial; todo passo do tutorial responde o que é / como / por quê', () => {
  const h = pub('novo-agente.html');
  for (const src of ['/tour.js', '/menu-lado.js', '/casca.js', '/novo-agente.js']) assert.ok(h.includes(`<script src="${src}">`), src);
  assert.ok(h.includes('href="/novo-agente.css"'));
  assert.match(h, /DGCasca\.monta\(\{ pagina: 'novo-agente'/);
  assert.match(h, /name="viewport"[^>]*width=device-width/);
  for (const passos of Object.values(NA.PASSOS)) {
    for (const p of passos) for (const campo of ['titulo', 'oque', 'como', 'porque']) assert.ok(p[campo] && p[campo].length > (campo === 'titulo' ? 3 : 15), `${p.titulo}/${campo}`);
  }
  assert.match(pub('novo-agente.css'), /overflow-wrap:anywhere/);
});

test('formulário e andamento: campos, escape, erro com o que fazer, login e pronto', () => {
  const f = NA.htmlFormulario();
  for (const nome of ['nome', 'papel', 'jeito', 'dono']) assert.ok(f.includes(`name="${nome}"`), nome);
  assert.match(f, /maxlength="60"/);
  const erro = NA.htmlAndamento({ id: 'x', nome: 'Bia <b>', fase: 'erro', progresso: { pct: 42, etapa: 'Criando', erro: { motivo: 'O podman <falhou>', oQueFazer: 'rode "dgclaw status"' } } });
  assert.doesNotMatch(erro, /Bia <b>|<falhou>/);
  assert.match(erro, /Parou\./);
  assert.match(erro, /O que fazer: rode &quot;dgclaw status&quot;/);
  assert.match(erro, /data-na-acao="retomar"/);
  const login = NA.htmlAndamento({ id: 'x', nome: 'Bia', fase: 'login', login: '/p/bia/?aba=status', progresso: { pct: 85, etapa: 'Falta conectar a assinatura' } });
  assert.match(login, /href="\/p\/bia\/\?aba=status"/);
  assert.match(login, /data-na-acao="testar"/);
  const pronto = NA.htmlAndamento({ id: 'x', nome: 'Bia', fase: 'pronto', conversa: '/a/bia', progresso: { pct: 100 } });
  assert.match(pronto, /href="\/a\/bia"/);
  assert.match(pronto, /data-na-acao="outro"/);
});

// ── o spawn que fala com o controle ─────────────────────────────────────────
function fdTemp() {
  const arq = path.join(pastaTemp('spawn'), 'log.txt');
  return { fd: fs.openSync(arq, 'a'), ler: () => fs.readFileSync(arq, 'utf8') };
}
const esperaEvento = (proc) => new Promise((res) => { proc.once('exit', (c) => res({ codigo: c })); proc.once('error', (e) => res({ erro: e })); });

test('spawn do controle: agente criar vira agente.criar com os parâmetros, acompanha a tarefa e grava a saída no log', async () => {
  const chamadas = [];
  const respostas = [{ ok: true, resultado: { tarefa: 'abc123abc123' } }, { ok: true, resultado: { tarefa: { estado: 'rodando' } } }, { ok: true, resultado: { tarefa: { estado: 'ok', resultado: { saida: '[1] Reservando a faixa de uid' } } } }];
  const spawn = criarSpawnControle({ quem: 'ti:dono', env: {}, log: () => {}, intervaloMs: 5, chamarControle: async (p) => { chamadas.push(p); return respostas.shift(); } });
  const { fd, ler } = fdTemp();
  const r = await esperaEvento(spawn('dgclaw', ['agente', 'criar', 'bia', '--nome', 'Bia', '--provedor', 'claude', '--auth', 'assinatura', '--papel', 'Atende', '--jeito', 'Direto', '--dono', 'Marta', '--canal', 'chat'], { stdio: ['ignore', fd, fd] }));
  assert.equal(r.codigo, 0);
  assert.deepEqual(chamadas[0], { op: 'agente.criar', params: { slug: 'bia', nome: 'Bia', provedor: 'claude', auth: 'assinatura', papel: 'Atende', jeito: 'Direto', dono: 'Marta', canal: 'chat' }, quem: 'ti:dono' });
  assert.equal(chamadas[1].op, 'tarefa.ver');
  assert.deepEqual(chamadas[1].params, { id: 'abc123abc123' });
  assert.match(ler(), /\[1\] Reservando a faixa de uid/);
});

test('spawn do controle: erro da tarefa e controle fora do ar viram saída 1 com "Nao deu certo" no log; reiniciar vira agente.reiniciar', async () => {
  let a = fdTemp();
  let spawn = criarSpawnControle({ quem: 'ti:dono', env: {}, log: () => {}, intervaloMs: 5, chamarControle: async (p) => (p.op === 'agente.criar' ? { ok: true, resultado: { tarefa: 'abc123abc123' } } : { ok: true, resultado: { tarefa: { estado: 'erro', erro: 'O podman recusou' } } }) });
  let r = await esperaEvento(spawn('dgclaw', ['agente', 'criar', 'bia', '--nome', 'Bia'], { stdio: ['ignore', a.fd, a.fd] }));
  assert.equal(r.codigo, 1);
  assert.match(a.ler(), /Nao deu certo: O podman recusou/);
  a = fdTemp();
  spawn = criarSpawnControle({ quem: 'ti:dono', env: {}, log: () => {}, intervaloMs: 5, chamarControle: async () => ({ ok: false, motivo: 'controle_fora', erro: 'ninguém escuta em /run/dgclaw/controle.sock' }) });
  r = await esperaEvento(spawn('dgclaw', ['agente', 'criar', 'bia', '--nome', 'Bia'], { stdio: ['ignore', a.fd, a.fd] }));
  assert.equal(r.codigo, 1);
  assert.match(a.ler(), /ninguém escuta/);
  const vistas = [];
  spawn = criarSpawnControle({ quem: 'ti:dono', env: {}, log: () => {}, intervaloMs: 5, chamarControle: async (p) => { vistas.push(p); return { ok: true, resultado: { saida: 'ok' } }; } });
  r = await esperaEvento(spawn('dgclaw', ['agente', 'reiniciar', 'bia'], { stdio: 'ignore' }));
  assert.equal(r.codigo, 0);
  assert.deepEqual(vistas[0], { op: 'agente.reiniciar', params: { agente: 'bia' }, quem: 'ti:dono' });
  r = await esperaEvento(spawn('dgclaw', ['dominio', 'trocar', 'x.com'], { stdio: 'ignore' }));
  assert.ok(r.erro, 'qualquer outro comando é recusado');
  assert.match(r.erro.message, /só sabe pedir/);
});

// ── o Web inteiro, com um controle de mentira ───────────────────────────────
function controleDeMentira(agentesPath) {
  const sock = path.join(pastaTemp('sock'), 'c.sock');
  const estado = { chamadas: [], falhaCriar: 0 };
  const srv = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      const p = JSON.parse(buf.slice(0, buf.indexOf('\n')));
      estado.chamadas.push(p);
      let r;
      if (p.op === 'agente.criar') {
        r = { ok: true, resultado: { tarefa: 'abc123abc123' } };
        estado.ultimaCriacao = p.params;
      } else if (p.op === 'tarefa.ver') {
        if (estado.falhaCriar > 0) { estado.falhaCriar -= 1; r = { ok: true, resultado: { tarefa: { estado: 'erro', erro: 'a imagem dos agentes ainda nao existe' } } }; }
        else {
          const j = JSON.parse(fs.readFileSync(agentesPath, 'utf8'));
          j.agentes.push({ slug: estado.ultimaCriacao.slug, nome: estado.ultimaCriacao.nome, tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: estado.ultimaCriacao.slug, chat_id: 'c_x', porta_painel: 8301 });
          fs.writeFileSync(agentesPath, JSON.stringify(j));
          r = { ok: true, resultado: { tarefa: { estado: 'ok', resultado: { saida: '[1] Reservando a faixa de uid do agente' } } } };
        }
      } else r = { ok: false, motivo: 'op_desconhecida', erro: 'x' };
      c.end(`${JSON.stringify(r)}\n`);
    });
  });
  return new Promise((res) => srv.listen(sock, () => res({ sock, estado, fechar: () => srv.close() })));
}

async function cenario(ajustes) {
  const dirNivel = pastaTemp('nivel');
  const protecoesPath = path.join(dirNivel, 'protecoes.json');
  if (ajustes) fs.writeFileSync(protecoesPath, JSON.stringify({ nivel: 'pessoal', ajustes }));
  const dir = pastaTemp('agentes');
  const agentesPath = path.join(dir, 'agentes.json');
  fs.writeFileSync(agentesPath, JSON.stringify({ versao: 1, agentes: [] }));
  const ctrl = await controleDeMentira(agentesPath);
  const s = await subirWeb({ env: { DGCLAW_CONTROLE_SOCK: ctrl.sock, DGCLAW_NOVO_AGENTE_INTERVALO_MS: '20' }, opcoesServidor: { protecoesPath, agentesPath, auditoriaPath: path.join(dirNivel, 'auditoria.jsonl') } });
  fs.writeFileSync(s.agentesPath, JSON.stringify({ versao: 1, agentes: [] }));
  // subirWeb escreve o próprio agentes.json; o web e o controle de mentira precisam olhar o mesmo
  s.agentesPath = agentesPath;
  await s.login();
  return { s, ctrl, protecoesPath, agentesPath };
}

const FORM = { nome: 'Bia', papel: 'Responde os clientes sobre pedidos.', jeito: 'Direto e educado.', dono: 'Marta' };

test('Admin ligado (nível pessoal): o módulo não responde a nada além do estado', async () => {
  const { s, ctrl } = await cenario(null);
  try {
    const est = await s.c.get('/api/v1/novo-agente/estado');
    assert.equal(est.status, 200);
    assert.deepEqual({ ativo: est.json.ativo, ti: est.json.ti }, { ativo: false, ti: false });
    const pag = await s.c.get('/novo-agente');
    assert.equal(pag.status, 404, 'a página não existe com o Admin ligado');
    const post = await s.c.post('/api/v1/novo-agente', { json: FORM });
    assert.ok(post.status === 404 || post.status === 405, `POST recusado (veio ${post.status})`);
    assert.equal(ctrl.estado.chamadas.length, 0, 'o controle nem foi chamado');
  } finally { await s.fechar(); ctrl.fechar(); }
});

test('Admin desligado: / leva ao formulário; criar vai ao controle com o TI logado, audita e chega na fase de login', async () => {
  const { s, ctrl, agentesPath, protecoesPath } = await cenario({ admin_llm: false, auditoria: 'basica' });
  try {
    fs.copyFileSync(path.join(__dirname, '../public/novo-agente.html'), path.join(s.publico, 'novo-agente.html'));
    const est = await s.c.get('/api/v1/novo-agente/estado');
    assert.deepEqual({ ativo: est.json.ativo, ti: est.json.ti }, { ativo: true, ti: true });
    const raiz = await s.c.get('/');
    assert.equal(raiz.status, 302);
    assert.equal(raiz.headers.location, '/novo-agente');
    const pag = await s.c.get('/novo-agente');
    assert.equal(pag.status, 200);
    assert.match(pag.texto, /Novo agente/);
    for (const [campo, valor] of [['nome', ''], ['papel', 'x'.repeat(301)], ['jeito', 'a\nb'], ['dono', 5]]) {
      const r = await s.c.post('/api/v1/novo-agente', { json: Object.assign({}, FORM, { [campo]: valor }) });
      assert.equal(r.status, 400, campo);
      assert.match(r.json.erro, /Preencha/);
    }
    assert.equal(ctrl.estado.chamadas.length, 0, 'pedido inválido não chega ao controle');
    const sem = await s.c.post('/api/v1/novo-agente/testar', { json: {} });
    assert.equal(sem.status, 404, 'sem pedido não há o que testar');

    const r = await s.c.post('/api/v1/novo-agente', { json: FORM });
    assert.equal(r.status, 202, r.texto);
    assert.equal(r.json.slug, 'bia');
    const fase = await esperaAte(async () => { const d = await s.c.get('/api/v1/onboarding'); return d.json.fase === 'login' ? d.json : null; });
    assert.equal(fase.login, '/p/bia/?aba=status');
    const criar = ctrl.estado.chamadas.find((c) => c.op === 'agente.criar');
    assert.equal(criar.quem, 'ti:dono');
    assert.deepEqual(criar.params, { slug: 'bia', nome: 'Bia', provedor: 'claude', auth: 'assinatura', papel: FORM.papel, jeito: FORM.jeito, dono: 'Marta', canal: 'chat' });
    assert.ok(JSON.parse(fs.readFileSync(agentesPath, 'utf8')).agentes.some((a) => a.slug === 'bia'));
    const linhas = fs.readFileSync(path.join(path.dirname(protecoesPath), 'auditoria.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ev = linhas.find((l) => l.evento === 'agente.criar_formulario');
    assert.ok(ev, 'o pedido ficou na auditoria');
    assert.equal(ev.quem, 'dono');
    assert.equal(ev.dados.slug, 'bia');
    const outro = await s.c.post('/api/v1/novo-agente', { json: Object.assign({}, FORM, { nome: 'Caio' }) });
    assert.equal(outro.status, 409, 'enquanto há uma criação em andamento não cria outra');
    const retomar = await s.c.post('/api/v1/novo-agente/retomar', { json: {} });
    assert.equal(retomar.status, 409, 'só se retoma o que parou com erro');
  } finally { await s.fechar(); ctrl.fechar(); }
});

test('Admin desligado: criação que falha para na fase de erro com o motivo, e retomar tenta de novo', async () => {
  const { s, ctrl } = await cenario({ admin_llm: false });
  try {
    ctrl.estado.falhaCriar = 1;
    const r = await s.c.post('/api/v1/novo-agente', { json: FORM });
    assert.equal(r.status, 202);
    const erro = await esperaAte(async () => { const d = await s.c.get('/api/v1/onboarding'); return d.json.fase === 'erro' ? d.json : null; });
    assert.match(erro.progresso.erro.motivo, /imagem dos agentes ainda nao existe|A criação parou/);
    const testar = await s.c.post('/api/v1/novo-agente/testar', { json: {} });
    assert.equal(testar.status, 409, 'o agente ainda não existe: não há o que testar');
    assert.match(testar.json.erro, /ainda não foi criado/);
    const ok = await s.c.post('/api/v1/novo-agente/retomar', { json: {} });
    assert.equal(ok.status, 202);
    const fase = await esperaAte(async () => { const d = await s.c.get('/api/v1/onboarding'); return d.json.fase === 'login' ? d.json : null; });
    assert.equal(fase.nome, 'Bia');
  } finally { await s.fechar(); ctrl.fechar(); }
});

test('Admin desligado: sem sessão a API responde 401 e a página manda para o login', async () => {
  const { s, ctrl } = await cenario({ admin_llm: false });
  try {
    const { cliente } = require('./ajuda');
    const anon = cliente(s.porta);
    assert.equal((await anon.post('/api/v1/novo-agente', { json: FORM })).status, 401);
    assert.equal((await anon.get('/api/v1/novo-agente/estado')).status, 401);
    const pag = await anon.get('/novo-agente', { headers: { Accept: 'text/html' } });
    assert.ok([302, 303, 401].includes(pag.status), `página sem sessão (veio ${pag.status})`);
  } finally { await s.fechar(); ctrl.fechar(); }
});

test('registro vazio: erro com o Admin ligado, lista vazia válida com o Admin desligado', async () => {
  const ligado = await cenario(null);
  try {
    const r = await ligado.s.c.get('/api/v1/agents');
    assert.equal(r.status, 503, 'sem Admin e sem agente o arquivo continua sendo tratado como quebrado');
    assert.match(r.json.erro, /nenhum agente válido/);
  } finally { await ligado.s.fechar(); ligado.ctrl.fechar(); }
  const desligado = await cenario({ admin_llm: false });
  try {
    const r = await desligado.s.c.get('/api/v1/agents');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.agentes, []);
  } finally { await desligado.s.fechar(); desligado.ctrl.fechar(); }
});
