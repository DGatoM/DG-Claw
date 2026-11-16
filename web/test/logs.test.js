'use strict';
// Seção Logs do Admin: acesso, leitor (Claude e Codex), paginação, segurança da descoberta, máscara e fontes.
// Tudo com fixtures sintéticas em pastas temporárias; nada aqui encosta em /var/lib/dgclaw.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');
const { criarLeitor, limpaCamadaAntiga: limpa, decodificaCursor, codificaCursor, ErroEntrada, abrirSeguro } = require('../lib/logs-leitor');
const { autorizado } = require('../lib/logs-rotas');

// ── fixtures ────────────────────────────────────────────────────────────────
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (n) => new Date(BASE_T + n * 1000).toISOString();

const cUser = (n, texto) => ({ type: 'user', timestamp: iso(n), sessionId: U1, message: { role: 'user', content: texto } });
const cTexto = (n, texto) => ({ type: 'assistant', timestamp: iso(n), sessionId: U1, message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });
const cUso = (n, id, name, input) => ({ type: 'assistant', timestamp: iso(n), sessionId: U1, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const cRes = (n, id, content, erro) => ({ type: 'user', timestamp: iso(n), sessionId: U1, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!erro }] } });

const jl = (linhas) => linhas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

function casa() {
  const home = pastaTemp('logs-casa');
  return { home, ag: { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente', codex_home_host: null } };
}
function escreveClaude(c, sessao, linhas, opc) {
  const o = opc || {};
  const dir = path.join(c.home, '.claude', 'projects', o.projeto || '-workspace');
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, `${sessao}.jsonl`);
  fs.writeFileSync(arq, o.cru != null ? o.cru : jl(linhas));
  if (o.mtime) fs.utimesSync(arq, o.mtime, o.mtime);
  return arq;
}
function escreveCodex(c, nome, linhas, opc) {
  const o = opc || {};
  const dir = path.join(c.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, `rollout-2026-11-01T12-00-00-${nome}.jsonl`);
  fs.writeFileSync(arq, o.cru != null ? o.cru : jl(linhas));
  if (o.mtime) fs.utimesSync(arq, o.mtime, o.mtime);
  return arq;
}
const xItem = (n, item) => ({ timestamp: iso(n), type: 'event_msg', payload: { type: 'item_completed', item } });

const pagina = (l, ag, f) => l.eventos(ag, Object.assign({ limite: 50, cursor: null }, f || {}));

/** Percorre todas as páginas; `mexe` pode adulterar o cursor entre elas. */
async function todasAsPaginas(l, ag, f, mexe, tamanho) {
  const ids = [];
  let cursor = null;
  for (let i = 0; i < 400; i++) {
    const r = await l.eventos(ag, Object.assign({ limite: tamanho || 7, cursor }, f || {}));
    for (const e of r.eventos) ids.push(e.id);
    if (!r.proximo) return ids;
    cursor = decodificaCursor(r.proximo);
    if (mexe) cursor = mexe(cursor, i);
  }
  throw new Error('a paginação não terminou em 400 páginas');
}

// ── acesso ──────────────────────────────────────────────────────────────────
test('autorizado: só o dono na sessão do navegador', () => {
  assert.equal(autorizado({ usuario: 'dono', papel: 'dono' }), true);
  assert.equal(autorizado({ usuario: 'x', papel: 'comum' }), false);
  assert.equal(autorizado({ usuario: 'x', papel: 'colaborador' }), false);
  assert.equal(autorizado({ via: 'caixa', papel: 'dono' }), false);
  assert.equal(autorizado({ usuario: 'x' }), false);
  assert.equal(autorizado(null), false);
});

async function webComLogs(extra) {
  const c = casa();
  const admTr = pastaTemp('logs-adm');
  const agentes = [
    { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'adm1', provedor: 'claude', transcripts_dir: admTr, home_host: pastaTemp('logs-admhome') },
    { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'ana1', provedor: 'claude', home_host: c.home, home_container: '/home/agente' },
  ];
  const t = await subirWeb(Object.assign({ agentes }, extra || {}));
  return { t, c, admTr };
}

test('acesso: sem sessão é 401 em todas as rotas', async () => {
  const { t } = await webComLogs();
  try {
    for (const p of ['/api/v1/logs/docs.md', '/api/v1/logs/agentes', '/api/v1/logs/agentes/ana/sessoes', '/api/v1/logs/agentes/ana/eventos']) {
      const r = await t.c.get(p);
      assert.equal(r.status, 401, p);
      assert.equal(r.json.ok, false);
    }
  } finally { await t.fechar(); }
});

test('acesso: o dono lê a documentação e a lista de agentes; outro método é 405', async () => {
  const { t, c } = await webComLogs();
  try {
    await t.login();
    escreveClaude(c, U1, [cUser(1, 'oi')]);
    const d = await t.c.get('/api/v1/logs/docs.md');
    assert.equal(d.status, 200);
    assert.match(d.headers['content-type'], /text\/markdown/);
    assert.match(d.texto, /Logs dos agentes/);
    const a = await t.c.get('/api/v1/logs/agentes');
    assert.equal(a.status, 200);
    assert.equal(a.headers['cache-control'], 'no-store');
    assert.deepEqual(a.json.agentes.map((x) => x.id), ['admin', 'ana']);
    const ana = a.json.agentes[1];
    assert.equal(ana.fontes.find((f) => f.motor === 'claude').estado, 'ok');
    assert.equal(ana.fontes.find((f) => f.motor === 'codex').estado, 'ausente');
    assert.equal(a.json.agentes[0].fontes.find((f) => f.motor === 'codex'), undefined, 'o Admin sem codex_home_host não tem fonte do Codex');
    const p = await t.c.post('/api/v1/logs/agentes', { json: {} });
    assert.equal(p.status, 405);
  } finally { await t.fechar(); }
});

test('acesso: a página /logs é do dono; /p/<agente>/... fica fechado até para o dono', async () => {
  const { t } = await webComLogs();
  try {
    fs.writeFileSync(path.join(t.publico, 'logs.html'), '<html>logs de teste</html>');
    const anon = await t.c.get('/logs', { headers: { Accept: 'text/html' } });
    assert.ok([302, 303, 401].includes(anon.status), String(anon.status));
    await t.login();
    const ok = await t.c.get('/logs');
    assert.equal(ok.status, 200);
    assert.match(ok.texto, /logs de teste/);
    for (const p of ['/p/ana/api/v1/logs/agentes', '/p/ana/logs', '/p/ana/logs/', '/p/outro/api/v1/logs/agentes/ana/eventos', '/p/ana/LOGS', '/p/ana/%6cogs']) {
      const r = await t.c.get(p);
      assert.equal(r.status, 403, p);
      assert.equal(r.json.erro, 'Os logs só existem na tela do Admin');
    }
  } finally { await t.fechar(); }
});

test('acesso: o agente pela caixa não chega nas rotas', async () => {
  const { t } = await webComLogs();
  try {
    for (const p of ['/api/v1/logs/agentes', '/api/v1/logs/docs.md', '/api/v1/logs/agentes/ana/eventos']) {
      const r = await t.c.get(p, { headers: { 'x-dgclaw-caixa': t.web.caixa.segredo, 'x-dgclaw-agente': 'ana' } });
      assert.equal(r.status, 403, p);
      assert.match(r.json.erro, /não está liberada para agentes/);
    }
  } finally { await t.fechar(); }
});

test('acesso: o colaborador recebe 403 em todas as rotas e 302 na página', async () => {
  const s = await cenario();
  try {
    const col = await colaboradorAtivo(s);
    for (const p of ['/api/v1/logs/docs.md', '/api/v1/logs/agentes', '/api/v1/logs/agentes/ana/sessoes', '/api/v1/logs/agentes/ana/eventos', '/api/v1/logs/agentes/admin/eventos']) {
      const r = await col.c.get(p);
      assert.equal(r.status, 403, p);
      assert.equal(r.json.ok, false);
    }
    const pag = await col.c.get('/logs', { headers: { Accept: 'text/html' } });
    assert.equal(pag.status, 302);
    assert.match(pag.headers.location, /^\/a\/ana/);
    const painel = await col.c.get('/p/ana/api/v1/logs/agentes');
    assert.equal(painel.status, 403);
    const dono = await s.dono.get('/api/v1/logs/agentes');
    assert.equal(dono.status, 200);
  } finally { await s.fechar(); }
});

test('acesso: cookie de papel forjado, sem login, não abre nada', async () => {
  const { t } = await webComLogs();
  try {
    const c2 = cliente(t.porta);
    const r = await c2.get('/api/v1/logs/agentes', { headers: { Cookie: 'dgclaw_papel=dono' } });
    assert.equal(r.status, 401);
  } finally { await t.fechar(); }
});

// ── validação dos parâmetros ────────────────────────────────────────────────
test('parâmetros: slug fora da lista, datas, tipo, q, sessão, limite e cursor', async () => {
  const { t, c } = await webComLogs();
  try {
    await t.login();
    escreveClaude(c, U1, [cUser(1, 'oi')]);
    const base = '/api/v1/logs/agentes/ana/eventos';
    const ev = (qs) => t.c.get(`${base}?${qs}`);
    assert.equal((await t.c.get('/api/v1/logs/agentes/..%2Fetc/eventos')).status, 400);
    assert.equal((await t.c.get('/api/v1/logs/agentes/..%2F..%2Fetc/sessoes')).status, 400);
    assert.equal((await t.c.get('/api/v1/logs/agentes/%2e%2e/eventos')).status, 404, 'o servidor normaliza ..');
    assert.equal((await t.c.get('/api/v1/logs/agentes/nao-existe/eventos')).status, 404);
    assert.equal((await ev('desde=ontem')).status, 400);
    assert.equal((await ev('desde=2026-02-31')).status, 400);
    assert.equal((await ev('desde=2026-11-05&ate=2026-11-01')).status, 400);
    assert.equal((await ev('desde=2026-11-01&ate=2026-11-05')).status, 200);
    assert.equal((await ev('desde=2026-11-01T10:00:00Z')).status, 200);
    assert.equal((await ev('tipo=comando,arquivo')).status, 200);
    assert.equal((await ev('tipo=comando,x')).status, 400);
    assert.equal((await ev(`q=${'a'.repeat(201)}`)).status, 400);
    assert.equal((await ev(`q=${'a'.repeat(200)}`)).status, 200);
    assert.equal((await ev('sessao=nao-e-id')).status, 400);
    assert.equal((await ev(`sessao=${U2}`)).status, 404, 'uuid válido que não existe');
    assert.equal((await ev('sessao=aaaaaaaaaaaa')).status, 404);
    assert.equal((await ev(`sessao=${U1}`)).status, 200);
    assert.equal((await ev('limite=0')).status, 400);
    assert.equal((await ev('limite=201')).status, 400);
    assert.equal((await ev('limite=200')).status, 200);
    assert.equal((await ev('cursor=@@@')).status, 400);
    assert.equal((await ev(`cursor=${Buffer.from('nao json').toString('base64url')}`)).status, 400);
    assert.equal((await ev(`cursor=${'A'.repeat(9000)}`)).status, 400);
    assert.equal((await ev(`cursor=${codificaCursor({ t: 'x', f: 'zz', o: 1, i: 0 })}`)).status, 400);
    const sess = await t.c.get('/api/v1/logs/agentes/ana/sessoes');
    assert.equal(sess.status, 200);
    assert.equal(sess.json.sessoes.length, 1);
    assert.equal(sess.json.sessoes[0].sessao, U1);
    assert.match(sess.json.sessoes[0].id, /^[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(sess.json).includes(c.home), 'nunca caminho absoluto do host');
  } finally { await t.fechar(); }
});

test('registro inválido: 503 com o motivo', async () => {
  const { t } = await webComLogs();
  try {
    await t.login();
    fs.writeFileSync(t.agentesPath, '{ quebrado');
    const r = await t.c.get('/api/v1/logs/agentes');
    assert.equal(r.status, 503);
    assert.match(r.json.erro, /registro de agentes/);
  } finally { await t.fechar(); }
});

// ── Claude ──────────────────────────────────────────────────────────────────
test('claude: mensagem, comando com resultado pareado, arquivo, ferramenta MCP, sistema; thinking e lixo não aparecem', async () => {
  const c = casa();
  escreveClaude(c, U1, [
    { type: 'mode', mode: 'x', sessionId: U1 },
    { type: 'attachment', timestamp: iso(0), sessionId: U1, attachment: { type: 'a' } },
    { type: 'ai-title', aiTitle: 'titulo', sessionId: U1 },
    cUser(1, 'faça o deploy'),
    { type: 'assistant', timestamp: iso(2), sessionId: U1, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PENSAMENTO-INTERNO', signature: 's' }] } },
    cUso(3, 'tu_1', 'Bash', { command: 'ls -la', description: 'Lista os arquivos' }),
    cRes(4, 'tu_1', 'total 0\narquivo.txt', false),
    cUso(5, 'tu_2', 'Read', { file_path: '/home/agente/projeto/a.txt' }),
    cRes(6, 'tu_2', [{ type: 'text', text: 'conteudo' }], false),
    cUso(7, 'tu_3', 'mcp__dgchat__reply', { chat: 'c1', texto: 'olá' }),
    cUso(8, 'tu_4', 'Bash', { command: 'false' }),
    cRes(9, 'tu_4', 'falhou', true),
    cUso(10, 'tu_5', 'Write', { file_path: '/opt/segredo/fora/x.txt', content: 'dados' }),
    { type: 'system', subtype: 'compact_boundary', timestamp: iso(11), sessionId: U1 },
    { type: 'system', subtype: 'turn_duration', timestamp: iso(12), sessionId: U1 },
    cTexto(13, 'pronto, feito'),
  ]);
  const r = await pagina(criarLeitor(), c.ag);
  assert.equal(r.contagens.linhas_ilegiveis, 0);
  const por = (tipo) => r.eventos.filter((e) => e.tipo === tipo);
  assert.deepEqual(r.eventos.map((e) => e.t), [...r.eventos.map((e) => e.t)].sort((a, b) => b - a), 'mais novo primeiro');
  assert.ok(!JSON.stringify(r).includes('PENSAMENTO-INTERNO'), 'thinking não é exibido');
  assert.deepEqual(por('mensagem').map((m) => [m.papel, m.texto]), [['agente', 'pronto, feito'], ['pessoa', 'faça o deploy']]);
  const cmd = por('comando');
  assert.equal(cmd.length, 2);
  const ls = cmd.find((e) => e.detalhes.comando === 'ls -la');
  assert.equal(ls.titulo, 'Lista os arquivos');
  assert.deepEqual(ls.resultado, { erro: false, texto: 'total 0\narquivo.txt', truncado: false });
  assert.equal(cmd.find((e) => e.detalhes.comando === 'false').resultado.erro, true);
  const arq = por('arquivo');
  assert.equal(arq.length, 2);
  assert.equal(arq.find((e) => e.detalhes.operacao === 'ler').detalhes.caminho, '~/projeto/a.txt');
  assert.equal(arq.find((e) => e.detalhes.operacao === 'ler').resultado.texto, 'conteudo');
  assert.equal(arq.find((e) => e.detalhes.operacao === 'escrever').detalhes.caminho, '…/segredo/fora/x.txt', 'caminho fora da casa não vaza o absoluto');
  const fer = por('ferramenta');
  assert.equal(fer.length, 1);
  assert.equal(fer[0].detalhes.ferramenta, 'mcp__dgchat__reply');
  assert.equal(fer[0].resultado, null, 'sem resultado registrado é null');
  assert.equal(por('sistema').length, 1);
  assert.equal(r.eventos.find((e) => e.tipo === 'comando').sessao, U1);
  assert.match(r.eventos[0].id, /^[0-9a-f]{12}:\d+/);
  assert.equal(r.fontes.find((f) => f.motor === 'claude').estado, 'ok');
});

test('claude: subagente fica marcado e a instrução recebida não vira "pessoa"', async () => {
  const c = casa();
  const dir = path.join(c.home, '.claude', 'projects', '-workspace', U1, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-abc123.jsonl'), jl([cUser(1, 'pesquise isso'), cTexto(2, 'achei')]));
  const r = await pagina(criarLeitor(), c.ag);
  assert.equal(r.eventos.length, 2);
  assert.ok(r.eventos.every((e) => e.subagente === true && e.sessao === U1));
  assert.equal(r.eventos.find((e) => e.texto === 'pesquise isso').papel, 'sistema');
});

test('claude: registro sem horário válido é contado e não vira meia-noite de 1970; horário suspeito é marcado', async () => {
  const c = casa();
  const velho = new Date(BASE_T + 4000);
  escreveClaude(c, U1, [
    cUser(1, 'normal'),
    { type: 'user', sessionId: U1, message: { role: 'user', content: 'sem horario' } },
    { type: 'user', timestamp: 'nao-e-data', sessionId: U1, message: { role: 'user', content: 'data ruim' } },
    cUser(3, 'futuro'),
  ], { mtime: velho });
  const r = await pagina(criarLeitor(), c.ag);
  assert.equal(r.contagens.sem_horario, 2);
  assert.deepEqual(r.eventos.map((e) => e.texto).sort(), ['futuro', 'normal']);

  const c2 = casa();
  escreveClaude(c2, U1, [cUser(1, 'antes'), cUser(1000, 'muito depois')], { mtime: velho });
  const r2 = await pagina(criarLeitor(), c2.ag);
  const susp = r2.eventos.find((e) => e.texto === 'muito depois');
  assert.equal(susp.horario_suspeito, true);
  assert.equal(susp.horario, iso(1000), 'o horário exibido é o original');
  assert.equal(r2.eventos.find((e) => e.texto === 'antes').horario_suspeito, undefined);
});

// ── Codex ───────────────────────────────────────────────────────────────────
test('codex (itens): mensagens, comando, MCP; o que não é ação é ignorado', async () => {
  const c = casa();
  escreveCodex(c, U1, [
    { timestamp: iso(0), type: 'session_meta', payload: { id: U1 } },
    xItem(1, { type: 'UserMessage', content: [{ type: 'text', text: 'rode os testes' }] }),
    { timestamp: iso(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rode os testes' }] } },
    xItem(2, { type: 'Reasoning', summary_text: [], raw_content: [] }),
    xItem(3, { type: 'CommandExecution', command: ['bash', '-lc', 'npm test'], exit_code: 1, status: 'failed', aggregated_output: 'falhou' }),
    xItem(4, { type: 'CommandExecution', command: ['bash', '-lc', 'echo ok'], exit_code: 0, status: 'completed', aggregated_output: 'ok' }),
    xItem(5, { type: 'McpToolCall', server: 'dgchat', tool: 'reply', arguments: { chat: 'c', text: 'oi' }, status: 'completed', result: { content: [{ type: 'text', text: 'enviado' }] } }),
    xItem(6, { type: 'AgentMessage', content: [{ type: 'text', text: 'testes passaram' }] }),
    { timestamp: iso(7), type: 'event_msg', payload: { type: 'token_count' } },
  ]);
  const r = await pagina(criarLeitor(), c.ag);
  assert.equal(r.eventos.length, 5);
  assert.equal(r.eventos.filter((e) => e.texto === 'rode os testes').length, 1, 'a mesma mensagem nas duas famílias aparece uma vez');
  const cmd = r.eventos.filter((e) => e.tipo === 'comando');
  assert.equal(cmd.find((e) => e.detalhes.comando === 'npm [argumentos ocultos: comando que pode levar credencial]').resultado.erro, true);
  assert.equal(cmd.find((e) => e.detalhes.comando === 'echo ok').resultado.erro, false);
  const mcp = r.eventos.find((e) => e.tipo === 'ferramenta');
  assert.equal(mcp.detalhes.ferramenta, 'dgchat/reply');
  assert.equal(mcp.resultado.texto, 'enviado');
  assert.deepEqual(r.eventos.filter((e) => e.tipo === 'mensagem').map((e) => e.papel), ['agente', 'pessoa']);
  assert.equal(r.eventos[0].motor, 'codex');
  assert.equal(r.eventos[0].sessao, U1);
});

test('codex (formato antigo): response_item com resultado pareado por call_id, sem o contexto injetado', async () => {
  const c = casa();
  const msg = (n, role, texto) => ({ timestamp: iso(n), type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text: texto }] } });
  escreveCodex(c, U2, [
    { timestamp: iso(0), type: 'session_meta', payload: { id: U2 } },
    msg(1, 'user', '<environment_context>cwd</environment_context>'),
    msg(2, 'developer', 'instrução do sistema'),
    msg(3, 'user', 'liste a pasta'),
    { timestamp: iso(4), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }) } },
    { timestamp: iso(5), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'a.txt', metadata: { exit_code: 0 } }) } },
    { timestamp: iso(6), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'cat /etc/hostname' } },
    { timestamp: iso(7), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'text', text: 'maquina' }] } },
    { timestamp: iso(8), type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'c3', arguments: '{}' } },
    msg(9, 'assistant', 'feito'),
  ]);
  const r = await pagina(criarLeitor(), c.ag);
  assert.deepEqual(r.eventos.map((e) => e.tipo), ['mensagem', 'ferramenta', 'comando', 'comando', 'mensagem']);
  assert.ok(!JSON.stringify(r).includes('environment_context'));
  assert.ok(!JSON.stringify(r).includes('instrução do sistema'));
  assert.equal(r.eventos[3].detalhes.comando, 'ls');
  assert.equal(r.eventos[3].resultado.texto, 'a.txt');
  assert.equal(r.eventos[2].resultado.texto, 'maquina');
  assert.equal(r.eventos[1].resultado, null);
});

test('codex: arquivo sem os dois formatos é "formato não reconhecido", com aviso, nunca "sem ações"', async () => {
  const c = casa();
  escreveCodex(c, U3, [{ timestamp: iso(0), type: 'session_meta', payload: { id: U3 } }, { timestamp: iso(1), type: 'turn_context', payload: {} }]);
  const r = await pagina(criarLeitor(), c.ag);
  assert.equal(r.eventos.length, 0);
  assert.ok(r.avisos.some((a) => a.tipo === 'formato_desconhecido' && /formato não reconhecido/.test(a.motivo) && /^codex:/.test(a.arquivo)), JSON.stringify(r.avisos));
});

// ── ordem e paginação ───────────────────────────────────────────────────────
test('ordem: dois arquivos com horários intercalados saem numa linha do tempo só', async () => {
  const c = casa();
  const a = []; const b = [];
  for (let i = 1; i <= 6; i++) (i % 2 ? a : b).push(cUser(i, `n${i}`));
  const mt = new Date(BASE_T + 100000);
  escreveClaude(c, U1, a, { mtime: mt });
  escreveClaude(c, U2, b, { mtime: mt });
  const r = await pagina(criarLeitor(), c.ag);
  assert.deepEqual(r.eventos.map((e) => e.texto), ['n6', 'n5', 'n4', 'n3', 'n2', 'n1']);
});

test('ordem: o arquivo mais velho só entra quando chega a sua vez', async () => {
  const c = casa();
  escreveClaude(c, U1, [cUser(10, 'a1'), cUser(20, 'a2')], { mtime: new Date(BASE_T + 20000) });
  escreveClaude(c, U2, [cUser(30, 'b1'), cUser(40, 'b2')], { mtime: new Date(BASE_T + 40000) });
  const r = await pagina(criarLeitor(), c.ag, { limite: 3 });
  assert.deepEqual(r.eventos.map((e) => e.texto), ['b2', 'b1', 'a2']);
  assert.ok(r.proximo);
});

function montaVolume(c) {
  const mt = new Date(BASE_T + 500000);
  for (const [u, off] of [[U1, 0], [U2, 1]]) {
    const linhas = [];
    for (let i = 0; i < 30; i++) linhas.push(cUser(i * 2 + off + 1, `msg-${u.slice(0, 2)}-${i}`));
    escreveClaude(c, u, linhas, { mtime: mt });
  }
  escreveCodex(c, U3, Array.from({ length: 20 }, (_, i) => xItem(i * 2 + 1, { type: 'AgentMessage', content: [{ type: 'text', text: `cdx-${i}` }] })), { mtime: mt });
}

test('paginação: percorre tudo sem repetir nem perder, com e sem hint, com hint inválido', async () => {
  const c = casa();
  montaVolume(c);
  const l = criarLeitor();
  const tudo = (await pagina(l, c.ag, { limite: 200 })).eventos;
  assert.equal(tudo.length, 80);
  const esperado = tudo.map((e) => e.id);
  assert.equal(new Set(esperado).size, 80);

  assert.deepEqual(await todasAsPaginas(l, c.ag, {}, null, 7), esperado);
  assert.deepEqual(await todasAsPaginas(l, c.ag, {}, (cur) => ({ chave: cur.chave, h: {} }), 9), esperado, 'sem hint relê do fim e descarta');
  const ruim = (cur) => ({ chave: cur.chave, h: Object.fromEntries(Object.keys(cur.h).map((k, i) => [k, i % 2 ? { o: 99999999999, teto: 1 } : { o: 12345, teto: 1 }])) });
  assert.deepEqual(await todasAsPaginas(l, c.ag, {}, ruim, 5), esperado, 'hint fora do arquivo ou fora de linha é ignorado');
  const um = await l.eventos(c.ag, { limite: 1, cursor: null });
  assert.equal(um.parcial, false);
  assert.ok(um.proximo);
});

test('paginação com filtro (tipo e busca) também fecha a conta', async () => {
  const c = casa();
  const linhas = [];
  for (let i = 0; i < 40; i++) linhas.push(i % 3 === 0 ? cUso(i + 1, `t${i}`, 'Bash', { command: `cmd-${i}` }) : cUser(i + 1, `texto-${i}`));
  escreveClaude(c, U1, linhas);
  const l = criarLeitor();
  const cmds = await todasAsPaginas(l, c.ag, { tipos: new Set(['comando']) }, null, 4);
  assert.equal(cmds.length, 14);
  const achados = await todasAsPaginas(l, c.ag, { q: 'texto-1' }, null, 3);
  assert.equal(achados.length, 8);
});

test('paginação: a última página não traz "proximo" e o cursor adulterado é 400', async () => {
  const c = casa();
  escreveClaude(c, U1, [cUser(1, 'a'), cUser(2, 'b'), cUser(3, 'c')]);
  const l = criarLeitor();
  const p1 = await l.eventos(c.ag, { limite: 2, cursor: null });
  assert.equal(p1.eventos.length, 2);
  const p2 = await l.eventos(c.ag, { limite: 2, cursor: decodificaCursor(p1.proximo) });
  assert.equal(p2.eventos.length, 1);
  assert.equal(p2.proximo, null);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.throws(() => decodificaCursor('%%%'), (e) => e instanceof ErroEntrada && e.status === 400);
  assert.throws(() => decodificaCursor(b64([1, 2])), ErroEntrada);
  assert.throws(() => decodificaCursor(b64({ t: 1 })), ErroEntrada);
  assert.throws(() => decodificaCursor(b64({ t: 1, f: 'aa', o: 0, i: 0 })), ErroEntrada);
  assert.throws(() => decodificaCursor(b64({ t: 1, f: 'aaaaaaaaaaaa', o: -1, i: 0 })), ErroEntrada);
});

test('arquivo grande (mais de 20 MB): a primeira página não lê o arquivo todo', async () => {
  const c = casa();
  const enchimento = JSON.stringify({ type: 'attachment', timestamp: iso(0), sessionId: U1, attachment: { texto: 'x'.repeat(2000) } });
  const antigas = Array.from({ length: 11000 }, () => enchimento);
  const arq = escreveClaude(c, U1, [...antigas, cUser(50, 'recente 1'), cUser(51, 'recente 2')]);
  const tamanho = fs.statSync(arq).size;
  assert.ok(tamanho > 20 * 1024 * 1024, `fixture com ${tamanho} bytes`);
  const r = await pagina(criarLeitor(), c.ag, { limite: 2 });
  assert.deepEqual(r.eventos.map((e) => e.texto), ['recente 2', 'recente 1']);
  assert.ok(r.lidos_bytes < 1024 * 1024, `leu ${r.lidos_bytes} bytes de ${tamanho}`);
});

test('linha gigante (mais de 4 MB) é pulada e contada; JSON quebrado é contado; a última linha incompleta é ignorada', async () => {
  const c = casa();
  const gigante = JSON.stringify(cUser(5, 'G'.repeat(5 * 1024 * 1024)));
  escreveClaude(c, U1, null, {
    cru: [JSON.stringify(cUser(1, 'primeira')), gigante, '{ json quebrado', JSON.stringify(cUser(6, 'depois'))].join('\n') + '\n' +
      JSON.stringify(cUser(7, 'sem quebra no fim')),
  });
  const r = await pagina(criarLeitor(), c.ag);
  assert.deepEqual(r.eventos.map((e) => e.texto), ['depois', 'primeira']);
  assert.equal(r.contagens.linhas_gigantes, 1);
  assert.equal(r.contagens.linhas_ilegiveis, 1);
  assert.ok(!JSON.stringify(r).includes('GGGGGGGG'));
});

test('orçamento: sem encher a página responde "parcial" com cursor, e continuar termina', async () => {
  const c = casa();
  const filler = JSON.stringify({ type: 'attachment', timestamp: iso(0), sessionId: U1, attachment: { texto: 'x'.repeat(1000) } });
  const linhas = [cUser(1, 'agulha: comando'), ...Array.from({ length: 4000 }, () => filler), cUser(9000, 'topo')];
  escreveClaude(c, U1, linhas);
  const l = criarLeitor({ orcamento: { maxBytes: 1536 * 1024 } });
  const r = await l.eventos(c.ag, { limite: 50, cursor: null, q: 'agulha' });
  assert.equal(r.parcial, true);
  assert.ok(r.proximo);
  assert.equal(r.eventos.length, 0);
  let cursor = decodificaCursor(r.proximo);
  let achou = null;
  for (let i = 0; i < 40 && !achou; i++) {
    const x = await l.eventos(c.ag, { limite: 50, cursor, q: 'agulha' });
    if (x.eventos.length) achou = x.eventos[0];
    else if (x.proximo) cursor = decodificaCursor(x.proximo);
    else break;
  }
  assert.ok(achou, 'a busca continuada achou o registro antigo');
  assert.equal(achou.texto, 'agulha: comando');
});

// ── filtros ─────────────────────────────────────────────────────────────────
test('filtros: período, tipo, sessão e busca sem diferenciar acento nem maiúscula', async () => {
  const c = casa();
  const dia = (d, h) => new Date(`2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00`).toISOString();
  const L = (d, h, texto, u) => ({ type: 'user', timestamp: dia(d, h), sessionId: u || U1, message: { role: 'user', content: texto } });
  escreveClaude(c, U1, [
    L(1, 8, 'Revisão do ÁLBUM'), L(2, 9, 'segundo dia'), L(2, 23, 'fim do segundo dia'), L(3, 0, 'terceiro dia'),
    { ...cUso(0, 'k1', 'Bash', { command: 'ls' }), timestamp: dia(2, 10) },
  ]);
  escreveClaude(c, U2, [L(2, 11, 'outra sessão', U2)]);
  const l = criarLeitor();
  const textos = (r) => r.eventos.map((e) => e.texto).filter(Boolean).sort();
  assert.deepEqual(textos(await pagina(l, c.ag, { desde: new Date(2026, 10, 2).getTime(), ate: new Date(2026, 10, 3).getTime() - 1 })), ['fim do segundo dia', 'outra sessão', 'segundo dia']);
  assert.equal((await pagina(l, c.ag, { tipos: new Set(['comando']) })).eventos.length, 1);
  assert.equal((await pagina(l, c.ag, { tipos: new Set(['comando', 'mensagem']) })).eventos.length, 6);
  const sess = (await l.sessoes(c.ag, { limite: 10, cursor: null })).sessoes;
  const s2 = sess.find((s) => s.sessao === U2);
  assert.deepEqual(textos(await pagina(l, c.ag, { sessao: s2.id })), ['outra sessão']);
  assert.deepEqual(textos(await pagina(l, c.ag, { sessao: U2 })), ['outra sessão']);
  assert.deepEqual(textos(await pagina(l, c.ag, { q: 'revisao do album' })), ['Revisão do ÁLBUM']);
  assert.deepEqual(textos(await pagina(l, c.ag, { q: 'ÁLBUM' })), ['Revisão do ÁLBUM']);
  await assert.rejects(pagina(l, c.ag, { sessao: 'ffffffffffff' }), (e) => e instanceof ErroEntrada && e.status === 404);
});

test('sessões: paginação por data e nunca caminho absoluto', async () => {
  const c = casa();
  for (let i = 0; i < 5; i++) {
    const u = `0000000${i}-0000-4000-8000-000000000000`;
    escreveClaude(c, u, [cUser(i + 1, 'x')], { mtime: new Date(BASE_T + i * 1000) });
  }
  const l = criarLeitor();
  const p1 = await l.sessoes(c.ag, { limite: 2, cursor: null });
  assert.equal(p1.sessoes.length, 2);
  const p2 = await l.sessoes(c.ag, { limite: 2, cursor: decodificaCursor(p1.proximo) });
  const p3 = await l.sessoes(c.ag, { limite: 2, cursor: decodificaCursor(p2.proximo) });
  const ids = [...p1.sessoes, ...p2.sessoes, ...p3.sessoes].map((s) => s.sessao);
  assert.equal(ids.length, 5);
  assert.equal(p3.proximo, null);
  assert.deepEqual(ids, [...ids].sort().reverse());
  assert.ok(!JSON.stringify([p1, p2, p3]).includes(c.home));
});

// ── segurança da descoberta ─────────────────────────────────────────────────
test('segurança: atalho para arquivo fora da raiz é ignorado e contado', async () => {
  const c = casa();
  escreveClaude(c, U1, [cUser(1, 'legítimo')]);
  const fora = path.join(pastaTemp('fora'), 'alheio.jsonl');
  fs.writeFileSync(fora, jl([cUser(2, 'CONTEUDO-ALHEIO')]));
  fs.symlinkSync(fora, path.join(c.home, '.claude', 'projects', '-workspace', `${U2}.jsonl`));
  const r = await pagina(criarLeitor(), c.ag);
  assert.deepEqual(r.eventos.map((e) => e.texto), ['legítimo']);
  assert.equal(r.contagens.atalhos_ignorados, 1);
  assert.ok(!JSON.stringify(r).includes('CONTEUDO-ALHEIO'));
});

test('segurança: pasta de projeto que é atalho para fora não é percorrida', async () => {
  const c = casa();
  const fora = pastaTemp('fora-dir');
  fs.writeFileSync(path.join(fora, `${U1}.jsonl`), jl([cUser(1, 'DENTRO-DA-PASTA-ALHEIA')]));
  fs.mkdirSync(path.join(c.home, '.claude', 'projects'), { recursive: true });
  fs.symlinkSync(fora, path.join(c.home, '.claude', 'projects', '-atalho'));
  const r = await pagina(criarLeitor(), c.ag);
  assert.equal(r.eventos.length, 0);
  assert.equal(r.contagens.atalhos_ignorados, 1);
  assert.ok(!JSON.stringify(r).includes('DENTRO-DA-PASTA-ALHEIA'));
});

test('segurança: raiz que é atalho para fora da casa é recusada com motivo', async () => {
  const c = casa();
  const fora = pastaTemp('fora-raiz');
  fs.mkdirSync(path.join(fora, '-ws'), { recursive: true });
  fs.writeFileSync(path.join(fora, '-ws', `${U1}.jsonl`), jl([cUser(1, 'RAIZ-ALHEIA')]));
  fs.mkdirSync(path.join(c.home, '.claude'), { recursive: true });
  fs.symlinkSync(fora, path.join(c.home, '.claude', 'projects'));
  const r = await pagina(criarLeitor(), c.ag);
  const f = r.fontes.find((x) => x.motor === 'claude');
  assert.equal(f.estado, 'ilegivel');
  assert.match(f.motivo, /fora da pasta do agente/);
  assert.equal(r.eventos.length, 0);
  assert.ok(!JSON.stringify(r).includes('RAIZ-ALHEIA'));
});

test('segurança: FIFO com nome de sessão não trava a leitura', async () => {
  const c = casa();
  escreveClaude(c, U1, [cUser(1, 'normal')]);
  const fifo = path.join(c.home, '.claude', 'projects', '-workspace', `${U2}.jsonl`);
  execFileSync('mkfifo', [fifo]);
  const r = await Promise.race([pagina(criarLeitor(), c.ag), new Promise((_, rej) => setTimeout(() => rej(new Error('travou no FIFO')), 5000))]);
  assert.deepEqual(r.eventos.map((e) => e.texto), ['normal']);
  assert.ok(r.avisos.some((a) => a.tipo === 'arquivo_recusado' && /arquivo regular/.test(a.motivo)));
});

test('segurança: hardlink é recusado com aviso', async () => {
  const c = casa();
  const a = escreveClaude(c, U1, [cUser(1, 'LEGIVEL-POR-DOIS-NOMES')]);
  fs.linkSync(a, path.join(c.home, '.claude', 'projects', '-workspace', `${U2}.jsonl`));
  const r = await pagina(criarLeitor(), c.ag);
  assert.equal(r.eventos.length, 0);
  assert.equal(r.avisos.filter((x) => x.tipo === 'arquivo_recusado' && /hardlink/.test(x.motivo)).length, 2);
});

test('segurança: arquivo que vira atalho depois da lista é recusado na abertura', async () => {
  const c = casa();
  const a = escreveClaude(c, U1, [cUser(1, 'x')]);
  const raizReal = fs.realpathSync(path.join(c.home, '.claude', 'projects'));
  const fora = path.join(pastaTemp('fora-troca'), 'a.jsonl');
  fs.writeFileSync(fora, 'x\n');
  fs.rmSync(a);
  fs.symlinkSync(fora, a);
  await assert.rejects(abrirSeguro({ abs: path.join(raizReal, '-workspace', `${U1}.jsonl`), raizReal }), (e) => /atalho/.test(e.motivo));
});

test('segurança: arquivo aberto cujo caminho real sai da raiz é recusado', async () => {
  const c = casa();
  const raizReal = fs.realpathSync(c.home);
  const outro = pastaTemp('fora-raiz2');
  fs.writeFileSync(path.join(outro, 'a.jsonl'), 'x\n');
  await assert.rejects(abrirSeguro({ abs: path.join(outro, 'a.jsonl'), raizReal }), (e) => /fora da pasta do agente/.test(e.motivo));
});

// ── fontes ──────────────────────────────────────────────────────────────────
test('fontes: ausente, vazia, ilegível e formato desconhecido aparecem com motivo', async () => {
  const l = criarLeitor();
  const c = casa();
  let r = await l.resumoDasFontes(c.ag);
  assert.deepEqual(r.fontes.map((f) => [f.motor, f.estado]), [['claude', 'ausente'], ['codex', 'ausente']]);
  assert.match(r.fontes[0].motivo, /nunca rodou/);
  assert.equal(r.fontes[0].arquivos, null);

  fs.mkdirSync(path.join(c.home, '.claude', 'projects', '-ws'), { recursive: true });
  r = await l.resumoDasFontes(c.ag);
  assert.equal(r.fontes[0].estado, 'vazia');
  assert.equal(r.fontes[0].arquivos, 0);

  fs.mkdirSync(path.join(c.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(c.home, '.codex', 'sessions'), 'sou um arquivo, não uma pasta');
  r = await l.resumoDasFontes(c.ag);
  const cdx = r.fontes.find((f) => f.motor === 'codex');
  assert.equal(cdx.estado, 'ilegivel');
  assert.match(cdx.motivo, /ENOTDIR/);

  const pag = await pagina(l, c.ag);
  assert.equal(pag.eventos.length, 0);
  assert.ok(pag.avisos.length >= 1 && pag.avisos.every((a) => a.motivo), 'sem fonte lida, os avisos trazem os motivos');
  assert.deepEqual(pag.fontes.map((f) => f.estado).sort(), ['ilegivel', 'vazia']);
});

test('fontes: agente sem home_host, e Admin com transcripts_dir e codex_home_host', async () => {
  const l = criarLeitor();
  const sem = await l.resumoDasFontes({ slug: 'x', tipo: 'agente', home_host: null });
  assert.ok(sem.fontes.every((f) => f.estado === 'ausente' && /home_host/.test(f.motivo)));
  const tr = pastaTemp('adm-tr');
  fs.writeFileSync(path.join(tr, `${U1}.jsonl`), jl([cUser(1, 'do admin')]));
  const cx = pastaTemp('adm-cx');
  fs.mkdirSync(path.join(cx, 'sessions', '2026', '11', '01'), { recursive: true });
  fs.writeFileSync(path.join(cx, 'sessions', '2026', '11', '01', `rollout-x-${U2}.jsonl`), jl([xItem(2, { type: 'AgentMessage', content: [{ type: 'text', text: 'resposta codex' }] })]));
  const r = await pagina(l, { slug: 'admin', tipo: 'admin', transcripts_dir: tr, codex_home_host: cx });
  assert.deepEqual(r.eventos.map((e) => [e.motor, e.texto]), [['codex', 'resposta codex'], ['claude', 'do admin']]);
});

// ── máscara e XSS ───────────────────────────────────────────────────────────
// Os valores são montados na hora e as chaves do objeto são neutras: nada aqui é segredo de verdade.
const S = {
  s01: 'sk-' + 'a1B2c3D4'.repeat(4),
  s02: 'sk_' + 'abcdef0123'.repeat(3),
  s03: 'gsk_' + 'Zx9Yw8Vu7T'.repeat(2),
  s04: 'xai-' + 'Qq1Ww2Ee3R'.repeat(2),
  s05: 'xoxb-' + '1234567890-abcdefghij',
  s06: 'ghs_' + 'A1b2C3d4E5'.repeat(3),
  s07: ['eyJhbGciOiJI', 'eyJzdWIiOiIx', 'c2lnbmF0dXJl'].join('.'),
  s08: 'dXNlcjpzZWNyZXRv',
  s09: 'valor-do-cabecalho-123',
  s10: 'valor-na-flag',
  s11: 'usuario:valor-no-curl',
  s12: 'valormysql',
  s13: 'valor-do-cookie-xyz',
  s14: 'valor-em-pwd-1234',
};

test('limpa: cada formato sai escondido', () => {
  const casos = [
    [`chave ${S.s01}`, S.s01], [`k ${S.s02}`, S.s02], [`k ${S.s03}`, S.s03], [`k ${S.s04}`, S.s04], [`k ${S.s05}`, S.s05],
    [`k ${S.s06}`, S.s06], [`t ${S.s07}`, S.s07], [`Authorization: Basic ${S.s08}`, S.s08], [`X-Api-Key: ${S.s09}`, S.s09],
    [`app --password ${S.s10} --x`, S.s10], [`app --token=${S.s10}`, S.s10], [`app --api-key ${S.s10}`, S.s10],
    [`app --senha=${S.s10}`, S.s10], [`curl -u ${S.s11} https://x`, S.s11], [`mysql -u root -p${S.s12} db`, S.s12],
    [`Cookie: nome=${S.s13}`, S.s13], [`pwd=${S.s14}`, S.s14], [`{"chave": "${S.s14}"}`, S.s14],
  ];
  for (const [entrada, valor] of casos) {
    const s = limpa(entrada);
    assert.ok(!s.includes(valor), `vazou ${valor} em: ${s}`);
    assert.match(s, /oculto/);
  }
  assert.equal(limpa('texto comum, sem nada'), 'texto comum, sem nada');
});

test('máscara na resposta: mensagem, comando, entrada, título, caminho e resultado; a busca não serve de oráculo', async () => {
  const c = casa();
  escreveClaude(c, U1, [
    cUser(1, `minha chave é ${S.s01}`),
    cUso(2, 'a', 'Bash', { command: `curl -H "Authorization: Basic ${S.s08}" -u ${S.s11} https://x`, description: `usa ${S.s03}` }),
    cRes(3, 'a', `resposta com ${S.s04} e pwd=${S.s14}`, false),
    cUso(4, 'b', 'Read', { file_path: `/home/agente/${S.s05}.txt` }),
    cUso(5, 'c', 'mcp__x__faz', { token: S.s06, chave: S.s13, nada: 'ok' }),
    cUso(6, 'd', `ferr-${S.s02}`, { a: 1 }),
  ]);
  const l = criarLeitor();
  const r = await pagina(l, c.ag);
  const texto = JSON.stringify(r);
  for (const [k, v] of Object.entries(S)) assert.ok(!texto.includes(v), `vazou ${k}`);
  assert.ok(texto.includes('oculto'));
  for (const v of [S.s01, S.s11, S.s03, S.s04, S.s13]) {
    assert.equal((await pagina(l, c.ag, { q: v })).eventos.length, 0, 'a busca olha o texto já mascarado');
  }
  assert.ok((await pagina(l, c.ag, { q: 'segredo oculto' })).eventos.length > 0);
});

test('texto muito longo: mascara antes de truncar e marca "truncado"', async () => {
  const c = casa();
  const longo = 'a '.repeat(2040) + S.s01 + ' fim';
  escreveClaude(c, U1, [cUser(1, longo), cUso(2, 'x', 'Bash', { command: 'c '.repeat(2500) }), cRes(3, 'x', 'r '.repeat(4500), false)]);
  const r = await pagina(criarLeitor(), c.ag);
  const msg = r.eventos.find((e) => e.tipo === 'mensagem');
  assert.equal(msg.truncado, true);
  assert.ok(msg.texto.length <= 4096);
  assert.ok(!msg.texto.includes('sk-a1B2'), 'o pedaço do segredo no corte também não passa');
  const cmd = r.eventos.find((e) => e.tipo === 'comando');
  assert.equal(cmd.detalhes.comando.length, 2048);
  assert.equal(cmd.resultado.truncado, true);
  assert.equal(cmd.resultado.texto.length, 4096);
});

test('XSS: o conteúdo volta literal em JSON, com tipo application/json', async () => {
  const { t, c } = await webComLogs();
  try {
    await t.login();
    const x = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    escreveClaude(c, U1, [cUser(1, x), cUso(2, 'a', 'Bash', { command: x })]);
    const r = await t.c.get('/api/v1/logs/agentes/ana/eventos');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.ok(r.json.eventos.some((e) => e.texto === x));
    assert.ok(r.json.eventos.some((e) => e.detalhes.comando === x));
  } finally { await t.fechar(); }
});

test('servidor: percorre as páginas pela API e o cursor volta como veio', async () => {
  const { t, c } = await webComLogs();
  try {
    await t.login();
    escreveClaude(c, U1, Array.from({ length: 25 }, (_, i) => cUser(i + 1, `m${i}`)));
    const ids = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const r = await t.c.get(`/api/v1/logs/agentes/ana/eventos?limite=10${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200, r.texto);
      ids.push(...r.json.eventos.map((e) => e.id));
      if (!r.json.proximo) break;
      cursor = r.json.proximo;
    }
    assert.equal(ids.length, 25);
    assert.equal(new Set(ids).size, 25);
  } finally { await t.fechar(); }
});
