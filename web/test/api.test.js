'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { subirWeb, pastaTemp } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { montarEnvelope } = require('../lib/conversa');

const FIXTURE = path.join(__dirname, 'fixtures', 'sessao-ana.jsonl');
const CREDENCIAL_FALSA = 'valor-falso-de-teste-1234';

/** Web com dois agentes (admin e ana) e um runner falso para cada. */
async function cenario(opRunner, opWeb) {
  const rAdmin = criarRunnerFalso(Object.assign({ agenteId: 'adm1', sessionId: 'sess-admin-0001' }, opRunner && opRunner.admin));
  const rAna = criarRunnerFalso(Object.assign({ agenteId: 'ana1', sessionId: 'sess-ana-00001' }, opRunner && opRunner.ana));
  const pAdmin = await rAdmin.ouvir(); const pAna = await rAna.ouvir();
  const home = pastaTemp('home-ana');
  const transcripts = path.join(pastaTemp('tr'), 'projects');
  fs.mkdirSync(path.join(transcripts, '-home-agente'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(transcripts, '-home-agente', 'sess-ana-00001.jsonl'));
  fs.mkdirSync(path.join(home, 'uploads', '2026-10-12'), { recursive: true });
  fs.mkdirSync(path.join(home, 'out'), { recursive: true });
  fs.writeFileSync(path.join(home, 'uploads', '2026-10-12', 'foto.png'), 'png');
  fs.writeFileSync(path.join(home, 'out', 'relatorio.pdf'), '0123456789');
  const agentes = [
    { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', chat_id: 'c_ana', avatar: '🌿', cor: '#2f9e5e', provedor: 'claude', modelo: 'sonnet', transcripts_dir: transcripts, home_host: home, home_container: '/home/agente' },
    { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: `http://127.0.0.1:${pAdmin}`, agente_id: 'adm1', chat_id: 'c_admin', avatar: '🛠', provedor: 'claude', modelo: 'opus', transcripts_dir: transcripts, home_host: pastaTemp('home-adm'), home_container: '/opt/dgclaw/admin' },
  ];
  const t = await subirWeb(Object.assign({ agentes }, opWeb));
  await t.login();
  const fechar = async () => { await t.fechar(); await rAdmin.fechar(); await rAna.fechar(); };
  return { t, rAdmin, rAna, home, transcripts, agentes, fechar };
}

test('GET /api/v1/agents: Admin primeiro, formato esperado e voz/microfone falsos sem chave', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.get('/api/v1/agents');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.agentes.map((a) => a.id), ['admin', 'ana']);
    const ana = r.json.agentes[1];
    assert.equal(ana.nome, 'Ana'); assert.equal(ana.avatar, '🌿'); assert.equal(ana.avatar_img, null);
    assert.equal(ana.tipo, 'agente'); assert.equal(ana.provedor, 'claude'); assert.equal(ana.modelo, 'sonnet');
    assert.equal(r.json.voz, false); assert.equal(r.json.microfone, false);
    assert.equal(ana.voz, false); assert.equal(ana.microfone, false);
    assert.equal((await s.t.c.post('/api/v1/transcribe', { corpo: 'x' })).status, 503);
    const tts = await s.t.c.post('/api/v1/tts', { json: { text: 'oi', agent_id: 'ana' } });
    assert.equal(tts.status, 503); assert.match(tts.json.erro, /ELEVENLABS_API_KEY/);
    assert.equal((await s.t.c.get('/api/v1/tts/cota')).status, 503);
  } finally { await s.fechar(); }
});

test('GET /api/v1/agents: ultima_ts em epoch ms da última mensagem; null (nunca 0) sem conversa', async () => {
  const s = await cenario();
  try {
    const ag = (await s.t.c.get('/api/v1/agents')).json.agentes;
    const ana = ag.find((x) => x.id === 'ana'), admin = ag.find((x) => x.id === 'admin');
    assert.ok(Number.isFinite(ana.ultima_ts) && ana.ultima_ts > 1.7e12, `ultima_ts da Ana: ${ana.ultima_ts}`);
    assert.equal(admin.ultima_ts, null);
  } finally { await s.fechar(); }
});

test('rotulo_provedor: usa a rota do runner, guarda 60 s em cache', async () => {
  const s = await cenario({ ana: { provedor: { sessao: 's', provedor: 'claude', rotulo: 'Claude Opus 5.5, na assinatura' } } });
  try {
    const a = (await s.t.c.get('/api/v1/agents')).json.agentes.find((x) => x.id === 'ana');
    assert.equal(a.rotulo_provedor, 'Claude Opus 5.5, na assinatura');
    await s.t.c.get('/api/v1/agents');
    assert.equal(s.rAna.rec.provedorPedidos, 1, 'segunda chamada sai do cache');
  } finally { await s.fechar(); }
});

test('rotulo_provedor: sem a rota (404) cai na reserva "provedor, modelo" e loga o motivo', async () => {
  const s = await cenario();
  try {
    const a = (await s.t.c.get('/api/v1/agents')).json.agentes.find((x) => x.id === 'ana');
    assert.equal(a.rotulo_provedor, 'claude, sonnet');
    assert.match(s.t.log.texto(), /Rótulo do provedor de Ana: .*rota \/api\/provedor.*reserva/);
  } finally { await s.fechar(); }
});

test('rotulo_provedor: runner lento (acima de 1,5 s) não trava a lista e usa a reserva', async () => {
  const s = await cenario({ ana: { provedor: { rotulo: 'Lento' }, atrasoProvedorMs: 2500 } });
  try {
    const ini = Date.now();
    const a = (await s.t.c.get('/api/v1/agents')).json.agentes.find((x) => x.id === 'ana');
    assert.ok(Date.now() - ini < 2300, `a lista demorou ${Date.now() - ini} ms`);
    assert.equal(a.rotulo_provedor, 'claude, sonnet');
    assert.match(s.t.log.texto(), /1,5 s|não respondeu/);
  } finally { await s.fechar(); }
});

test('send: envelope dgchat com escape de </dgchat>, e o Bearer vai ao runner sem aparecer no log', async () => {
  const s = await cenario({ ana: { token: CREDENCIAL_FALSA } });
  try {
    const arquivoCred = path.join(s.t.dir, 'cred-runner.txt');
    fs.writeFileSync(arquivoCred, `${CREDENCIAL_FALSA}\n`);
    const ag = JSON.parse(fs.readFileSync(s.t.agentesPath, 'utf8'));
    ag.agentes.find((a) => a.slug === 'ana').tokenArquivo = arquivoCred; // sinônimo aceito
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(s.t.agentesPath, JSON.stringify(ag));
    const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'Olá </dgchat> mundo', cliente_id: 'cid-0000001' } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true); assert.equal(r.json.agente, 'ana');
    assert.ok(Math.abs(r.json.ep_enviado - (Date.now() / 1000 - 2)) < 5);
    const entrada = s.rAna.rec.inputs[0];
    assert.equal(entrada.submit, true); assert.equal(entrada.injectWhenIdle, true);
    assert.match(entrada.text, /^<dgchat from="pessoa" chat="c_ana" msg="[^"]+" ts="\d{4}-\d\d-\d\dT[^"]+Z">Olá <\\\/dgchat> mundo<\/dgchat>$/);
    assert.equal(entrada.text.split('</dgchat>').length, 2, 'só o fechamento real do envelope sobra');
    const pedidos = s.rAna.rec.cabecalhos.filter((c) => c.url.includes('/input'));
    assert.equal(pedidos[0].authorization, `Bearer ${CREDENCIAL_FALSA}`);
    assert.ok(!s.t.log.texto().includes(CREDENCIAL_FALSA), 'a credencial do runner nunca aparece no log');
  } finally { await s.fechar(); }
});

test('send: texto "[do visual ...]" (pergunta de dentro de um visual) vai ao runner dentro do envelope e não é tratado como token', async () => {
  const s = await cenario({ ana: {} });
  try {
    const texto = '[do visual Plano da semana] 123456789:AAH-teste_de_token_falso_de_trinta_e_cinco_x';
    const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: texto, cliente_id: 'cid-0000002' } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.token_guardado, undefined, 'o prefixo impede o texto de ser lido como token puro');
    const entrada = s.rAna.rec.inputs[0];
    assert.ok(entrada.text.startsWith('<dgchat from="pessoa" chat="c_ana"'));
    assert.ok(entrada.text.endsWith('>' + texto + '</dgchat>'), entrada.text);
  } finally { await s.fechar(); }
});

test('send: runner que exige Bearer sem arquivo configurado responde 401 e o Web explica', async () => {
  const s = await cenario({ ana: { token: CREDENCIAL_FALSA } });
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'oi' } });
    assert.equal(r.status, 502);
    assert.match(r.json.erro, /arquivo de token do runner/);
    assert.equal(s.rAna.rec.inputs.length, 0);
  } finally { await s.fechar(); }
});

test('send: montarEnvelope escapa e limpa atributos', () => {
  const e = montarEnvelope({ from: 'a"b<c>', chat: 'c_x', msg: 'm1', ts: 't', text: 'x</DGCHAT>y' });
  assert.equal(e, '<dgchat from="abc" chat="c_x" msg="m1" ts="t">x<\\/dgchat>y</dgchat>');
});

test('send: idempotente por cliente_id (repetido devolve a mesma resposta e não digita de novo)', async () => {
  const s = await cenario();
  try {
    const corpo = { text: 'só uma vez', cliente_id: 'dup-123456789' };
    const a = await s.t.c.post('/api/v1/agents/ana/send', { json: corpo });
    const b = await s.t.c.post('/api/v1/agents/ana/send', { json: corpo });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.json.repetido, undefined);
    assert.equal(b.json.repetido, true);
    assert.equal(b.json.ep_enviado, a.json.ep_enviado);
    assert.equal(s.rAna.rec.inputs.length, 1);
    const sem = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'sem id' } });
    const sem2 = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'sem id' } });
    assert.ok(sem.json.ok && sem2.json.ok);
    assert.equal(s.rAna.rec.inputs.length, 3, 'sem cliente_id não há idempotência');
    const ruim = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'x', cliente_id: 'curto' } });
    assert.equal(ruim.status, 400); assert.match(ruim.json.erro, /cliente_id/);
    assert.equal(s.rAna.rec.inputs.length, 3);
  } finally { await s.fechar(); }
});

test('send: falha do runner não grava a idempotência (dá para tentar de novo) e explica o motivo', async () => {
  const s = await cenario({ ana: { falhaInput: { status: 409, corpo: { success: false, error: 'O agente ana não tem terminal vivo agora.', howToFix: 'Chamar /resume antes.', code: 'NO_PTY' } } } });
  try {
    const corpo = { text: 'tenta', cliente_id: 'falha-1234567' };
    const a = await s.t.c.post('/api/v1/agents/ana/send', { json: corpo });
    assert.equal(a.status, 409);
    assert.equal(a.json.ok, false);
    assert.match(a.json.erro, /terminal vivo/); assert.match(a.json.erro, /resume/);
    s.rAna.opcoes.falhaInput = null;
    const b = await s.t.c.post('/api/v1/agents/ana/send', { json: corpo });
    assert.equal(b.status, 200);
    assert.equal(b.json.repetido, undefined);
  } finally { await s.fechar(); }
});

test('send: runner fora do ar vira 502 com motivo', async () => {
  const s = await cenario();
  try {
    await s.rAna.fechar();
    const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'oi' } });
    assert.equal(r.status, 502);
    assert.match(r.json.erro, /Não consegui entregar a mensagem a Ana/);
    assert.match(r.json.erro, /runner/);
  } finally { await s.t.fechar(); await s.rAdmin.fechar(); }
});

test('send: "/compact" vai cru para o Admin e para o agente comum; texto comum vai no envelope', async () => {
  const s = await cenario();
  try {
    await s.t.c.post('/api/v1/agents/admin/send', { json: { text: '/compact' } });
    await s.t.c.post('/api/v1/agents/admin/send', { json: { text: 'oi admin' } });
    await s.t.c.post('/api/v1/agents/ana/send', { json: { text: '/compact' } });
    assert.equal(s.rAdmin.rec.inputs[0].text, '/compact');
    assert.match(s.rAdmin.rec.inputs[1].text, /^<dgchat from="pessoa" chat="c_admin"/);
    // Mudou com os comandos de barra: antes só o Admin mandava cru, agora vale para todos (com checagem do catálogo).
    assert.equal(s.rAna.rec.inputs[0].text, '/compact');
  } finally { await s.fechar(); }
});

test('send: vazio, grande demais, agente inexistente e JSON quebrado', async () => {
  const s = await cenario({}, { env: { DGCLAW_WEB_MAX_TEXTO: '50' } });
  try {
    assert.equal((await s.t.c.post('/api/v1/agents/ana/send', { json: { text: '  ' } })).status, 400);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'x'.repeat(51) } })).status, 413);
    assert.equal((await s.t.c.post('/api/v1/agents/nao/send', { json: { text: 'oi' } })).status, 404);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/send', { corpo: '{quebrado', headers: { 'Content-Type': 'application/json' } })).status, 400);
    assert.equal(s.rAna.rec.inputs.length, 0);
  } finally { await s.fechar(); }
});

test('messages: pagina pela fixture (limit, before, after) com o formato da tela', async () => {
  const s = await cenario();
  try {
    const todas = (await s.t.c.get('/api/v1/agents/ana/messages')).json;
    assert.equal(todas.ok, true);
    assert.equal(todas.msgs.length, 10); // inclui o eco "/clear" da fixture, que agora aparece
    assert.equal(todas.mais_antigas, false);
    assert.deepEqual(todas.avisos, []);
    const p1 = (await s.t.c.get('/api/v1/agents/ana/messages?limit=3')).json;
    assert.deepEqual(p1.msgs.map((m) => m.id), todas.msgs.slice(-3).map((m) => m.id));
    assert.equal(p1.mais_antigas, true); assert.equal(p1.limit, 3);
    const p2 = (await s.t.c.get(`/api/v1/agents/ana/messages?limit=3&before=${p1.msgs[0].ep}`)).json;
    assert.deepEqual(p2.msgs.map((m) => m.id), todas.msgs.slice(-6, -3).map((m) => m.id));
    const dep = (await s.t.c.get(`/api/v1/agents/ana/messages?after=${todas.msgs[7].ep}`)).json;
    assert.equal(dep.msgs.length, 2);
    assert.equal((await s.t.c.get('/api/v1/agents/ana/messages?limit=0')).status, 400);
    assert.equal((await s.t.c.get('/api/v1/agents/ana/messages?before=abc')).status, 400);
    const vazia = (await s.t.c.get('/api/v1/agents/admin/messages')).json;
    assert.equal(vazia.ok, true);
  } finally { await s.fechar(); }
});

test('messages: agente que nunca conversou não mostra faixa de erro', async () => {
  const s = await cenario({ ana: { sessionId: 'sess-nova-0001' } });
  try {
    fs.rmSync(path.join(s.transcripts, '-home-agente', 'sess-ana-00001.jsonl'));
    const r = (await s.t.c.get('/api/v1/agents/ana/messages')).json;
    assert.equal(r.ok, true); assert.deepEqual(r.msgs, []);
    assert.deepEqual(r.avisos, [], 'sem nenhum registro é o estado normal: sem faixa');
    assert.match(s.t.log.texto(), /\[info\] Thread de Ana: sessão nova, aguardando a primeira troca/);
    assert.doesNotMatch(s.t.log.texto(), /\[aviso\] Thread de Ana/, 'sessão que acabou de nascer não vira aviso');
  } finally { await s.fechar(); }
});

test('messages: sessão sem arquivo por mais de 10 minutos vira aviso no log', async () => {
  let agora = Date.now();
  const s = await cenario({ ana: { sessionId: 'sess-nova-0001' } }, { opcoesServidor: { agora: () => agora } });
  try {
    fs.rmSync(path.join(s.transcripts, '-home-agente', 'sess-ana-00001.jsonl'));
    await s.t.c.get('/api/v1/agents/ana/messages');
    assert.doesNotMatch(s.t.log.texto(), /\[aviso\] Thread de Ana/);
    agora += 11 * 60 * 1000;
    await s.t.c.get('/api/v1/agents/ana/messages');
    assert.match(s.t.log.texto(), /\[aviso\] Thread de Ana: o runner diz que a sessão é sess-nova-0001.*Já faz 11 min/);
  } finally { await s.fechar(); }
});

test('messages: sessão nova com conversa antiga avisa sem caminho nem Codex', async () => {
  const s = await cenario({ ana: { sessionId: 'sess-nova-0001' } });
  try {
    const r = (await s.t.c.get('/api/v1/agents/ana/messages')).json;
    assert.equal(r.avisos.length, 1);
    assert.doesNotMatch(r.avisos[0], /Codex|\/|sess-nova/);
  } finally { await s.fechar(); }
});

test('wait: devolve na hora quando já há resposta direta, e timeout:true quando não há', async () => {
  const s = await cenario();
  try {
    const desde = new Date('2026-10-12T15:00:07Z').getTime() / 1000;
    const r = await s.t.c.get(`/api/v1/agents/ana/wait?since=${desde}&timeout=2`);
    assert.equal(r.json.timeout, false);
    assert.ok(r.json.msgs.some((m) => m.origin === 'agente'));
    const depois = 4102444800; // ano 2100: nada é mais novo que isso
    const ini = Date.now();
    const v = await s.t.c.get(`/api/v1/agents/ana/wait?since=${depois}&timeout=1`);
    assert.equal(v.json.timeout, true); assert.deepEqual(v.json.msgs, []);
    assert.ok(Date.now() - ini >= 900);
    assert.equal((await s.t.c.get('/api/v1/agents/ana/wait')).status, 400);
  } finally { await s.fechar(); }
});

/** Abre o SSE e junta os eventos até `ate(eventos)` ser verdadeiro. */
function lerSse(porta, caminho, cookie, ate) {
  return new Promise((resolve, reject) => {
    const eventos = [];
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      let resto = '';
      const fim = setTimeout(() => { req.destroy(); resolve({ eventos, status: res.statusCode, headers: res.headers }); }, 6000);
      res.on('data', (d) => {
        resto += d;
        const blocos = resto.split('\n\n'); resto = blocos.pop();
        for (const b of blocos) {
          if (b.startsWith(':') || b.startsWith('retry')) continue;
          const ev = {};
          for (const l of b.split('\n')) { const i = l.indexOf(':'); ev[l.slice(0, i)] = l.slice(i + 1).trim(); }
          if (ev.data) ev.dados = JSON.parse(ev.data);
          eventos.push(ev);
        }
        if (ate(eventos)) { clearTimeout(fim); req.destroy(); resolve({ eventos, status: res.statusCode, headers: res.headers }); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}
const cookieDe = (c) => Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');

test('stream SSE: ola, msgs, atividade (ocioso) e msgs novas quando o transcript cresce', async () => {
  const s = await cenario();
  try {
    const arq = path.join(s.transcripts, '-home-agente', 'sess-ana-00001.jsonl');
    const since = new Date('2026-10-12T15:00:00Z').getTime() / 1000;
    setTimeout(() => {
      fs.appendFileSync(arq, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__dgchat__reply', input: { chat: 'c_ana', text: 'chegou agora' } }] } }) + '\n');
    }, 600);
    const r = await lerSse(s.t.porta, `/api/v1/agents/ana/stream?since=${since}`, cookieDe(s.t.c), (ev) => ev.some((e) => e.event === 'msgs' && e.dados.novas.some((m) => m.text === 'chegou agora')));
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/event-stream/);
    assert.equal(r.eventos[0].event, 'ola');
    assert.equal(r.eventos[0].dados.agente, 'ana');
    assert.ok('versao_js' in r.eventos[0].dados);
    const primeiro = r.eventos.find((e) => e.event === 'msgs');
    assert.equal(primeiro.dados.novas.length, 10);
    assert.ok(Number(primeiro.id) > since, 'o id do evento é o maior ep entregue');
    const ativ = r.eventos.find((e) => e.event === 'atividade');
    assert.equal(ativ.dados.agentes.ana.estado, 'ocioso');
    assert.ok('agora' in ativ.dados);
    const nova = r.eventos.filter((e) => e.event === 'msgs').pop();
    assert.deepEqual(nova.dados.sumidas, []);
  } finally { await s.fechar(); }
});

test('stream SSE: Last-Event-ID vence o since', async () => {
  const s = await cenario();
  try {
    const todas = (await s.t.c.get('/api/v1/agents/ana/messages')).json.msgs;
    const ultimo = todas[todas.length - 1].ep;
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: '/api/v1/agents/ana/stream?since=1', headers: { Cookie: cookieDe(s.t.c), 'Last-Event-ID': String(ultimo) } }, (res) => {
        res.setEncoding('utf8'); let acc = '';
        res.on('data', (d) => { acc += d; if (acc.includes('event: atividade')) { req.destroy(); resolve(acc); } });
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      req.end();
    });
    const msgs = /event: msgs\nid: [^\n]+\ndata: (.+)\n/.exec(r);
    assert.deepEqual(JSON.parse(msgs[1]).novas, []);
  } finally { await s.fechar(); }
});

test('atividade: working vira trabalhando (acao = ferramenta), waiting_input vira alerta permissao, runner fora vira sem_sinal', async () => {
  const s = await cenario();
  try {
    const ck = cookieDe(s.t.c);
    const atividade = (r) => r.eventos.find((e) => e.event === 'atividade').dados.agentes.ana;
    s.rAna.opcoes.status = 'working'; s.rAna.opcoes.currentTool = 'Bash';
    let r = await lerSse(s.t.porta, '/api/v1/agents/ana/stream', ck, (ev) => ev.some((e) => e.event === 'atividade'));
    let a = atividade(r);
    assert.equal(a.estado, 'trabalhando'); assert.equal(a.acao, 'Bash'); assert.equal(a.alerta, null);
    assert.match(a.desde, /^\d{4}-/);
    assert.ok('ultimo_sinal' in a);

    await new Promise((r2) => setTimeout(r2, 2100)); // passa o cache de 2 s do estado do runner
    s.rAna.opcoes.status = 'waiting_input'; s.rAna.opcoes.currentTool = null;
    r = await lerSse(s.t.porta, '/api/v1/agents/ana/stream', ck, (ev) => ev.some((e) => e.event === 'atividade'));
    assert.equal(atividade(r).alerta, 'permissao');

    await s.rAna.fechar();
    await new Promise((r2) => setTimeout(r2, 2100));
    r = await lerSse(s.t.porta, '/api/v1/agents/ana/stream', ck, (ev) => ev.some((e) => e.event === 'atividade'));
    a = atividade(r);
    assert.equal(a.estado, 'sem_sinal');
    assert.match(a.motivo, /runner/);
  } finally { await s.t.fechar(); await s.rAdmin.fechar(); }
});

function multipart(limite, campos, nome, dados) {
  return Buffer.concat([
    ...Object.entries(campos).map(([k, v]) => Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
    Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="file"; filename="${nome}"\r\nContent-Type: image/png\r\n\r\n`),
    dados,
    Buffer.from(`\r\n--${limite}--\r\n`),
  ]);
}

test('upload: grava em uploads/AAAA-MM-DD, nome seguro, enviar=0 só guarda e o /send leva o marcador', async () => {
  const s = await cenario();
  try {
    const limite = '----teste1234';
    const h = { 'Content-Type': `multipart/form-data; boundary=${limite}` };
    const r = await s.t.c.post('/api/v1/agents/ana/upload', { corpo: multipart(limite, { enviar: '0', cliente_id: 'up-1234567890' }, '../../Foto Ação.PNG', Buffer.from([1, 2, 3, 0, 255])), headers: h });
    assert.equal(r.status, 201, r.texto);
    assert.equal(r.json.ok, true);
    assert.match(r.json.anexo.path, /^\/home\/agente\/uploads\/\d{4}-\d\d-\d\d\/Foto_Acao\.png$/);
    assert.equal(r.json.anexo.kind, 'photo'); assert.equal(r.json.anexo.bytes, 5);
    assert.equal(r.json.marcador, `[anexo: ${r.json.anexo.path}]`);
    assert.equal(r.json.media.id, r.json.anexo.id);
    const noDisco = path.join(s.home, r.json.anexo.path.replace('/home/agente/', ''));
    assert.deepEqual([...fs.readFileSync(noDisco)], [1, 2, 3, 0, 255]);
    assert.equal(s.rAna.rec.inputs.length, 0, 'enviar=0 não manda nada ao agente');
    const rep = await s.t.c.post('/api/v1/agents/ana/upload', { corpo: multipart(limite, { enviar: '0', cliente_id: 'up-1234567890' }, 'Foto Ação.PNG', Buffer.from([9])), headers: h });
    assert.equal(rep.json.repetido, true);
    const send = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'veja', anexos: [r.json.anexo.id] } });
    assert.equal(send.status, 200, send.texto);
    assert.match(s.rAna.rec.inputs[0].text, /veja\n\[anexo: \/home\/agente\/uploads\/[\d-]+\/Foto_Acao\.png\]<\/dgchat>$/);
    const ruim = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'x', anexos: ['0123456789abcdef'] } });
    assert.equal(ruim.status, 404);
    const m = await s.t.c.get(r.json.media.url);
    assert.equal(m.status, 200); assert.equal(m.headers['content-type'], 'image/png');
    const faixa = await s.t.c.get(r.json.media.url, { headers: { Range: 'bytes=1-2' } });
    assert.equal(faixa.status, 206); assert.equal(faixa.headers['content-range'], 'bytes 1-2/5'); assert.deepEqual([...faixa.buf], [2, 3]);
    assert.equal((await s.t.c.get(r.json.media.url, { headers: { Range: 'bytes=99-' } })).status, 416);
    const direto = await s.t.c.post('/api/v1/agents/ana/upload', { corpo: multipart(limite, { legenda: 'olha' }, 'doc.pdf', Buffer.from('%PDF')), headers: h });
    assert.equal(direto.status, 201, direto.texto);
    assert.equal(direto.json.enviado, true);
    assert.match(s.rAna.rec.inputs[1].text, />olha\n\[anexo: \/home\/agente\/uploads\/[\d-]+\/doc\.pdf\]<\/dgchat>$/);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/upload', { corpo: `--${limite}--\r\n`, headers: h })).status, 400);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/upload', { corpo: multipart(limite, {}, 'vazio.txt', Buffer.alloc(0)), headers: h })).status, 400);
  } finally { await s.fechar(); }
});

test('upload: acima do limite configurado leva 413 com motivo', async () => {
  const s = await cenario({}, { env: { DGCLAW_WEB_MAX_UPLOAD_MB: '0.0001' } });
  try {
    const limite = 'xx99';
    const corpo = Buffer.concat([Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="file"; filename="g.bin"\r\n\r\n`), Buffer.alloc(200 * 1024, 1), Buffer.from(`\r\n--${limite}--\r\n`)]);
    const r = await s.t.c.post('/api/v1/agents/ana/upload', { corpo, headers: { 'Content-Type': `multipart/form-data; boundary=${limite}` } });
    assert.equal(r.status, 413);
    assert.match(r.json.erro, /limite/);
  } finally { await s.fechar(); }
});

test('upload de arquivo que não é mídia: marcador com o caminho, MIME certo e download como anexo', async () => {
  const s = await cenario();
  try {
    const limite = '----doc1234';
    const h = { 'Content-Type': `multipart/form-data; boundary=${limite}` };
    const casos = [
      ['pacote.zip', 'application/zip'], ['relatorio.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['planilha.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['dados.csv', 'text/csv; charset=utf-8'],
      ['notas.md', 'text/plain; charset=utf-8'], ['config.json', 'application/json'], ['script.py', 'application/octet-stream'],
    ];
    for (const [nome, mime] of casos) {
      const r = await s.t.c.post('/api/v1/agents/ana/upload', { corpo: multipart(limite, { enviar: '0', cliente_id: 'doc-' + Buffer.from(nome).toString('hex') }, nome, Buffer.from('PK dados')), headers: h });
      assert.equal(r.status, 201, r.texto);
      assert.equal(r.json.anexo.kind, 'document', nome);
      assert.equal(r.json.marcador, `[anexo: ${r.json.anexo.path}]`, 'o agente recebe o caminho absoluto');
      assert.match(r.json.anexo.path, /^\/home\/agente\/uploads\//);
      const d = await s.t.c.get(r.json.media.url + (r.json.media.url.includes('?') ? '&' : '?') + 'baixar=1');
      assert.equal(d.status, 200, nome);
      assert.equal(d.headers['content-type'], mime, nome);
    }
  } finally { await s.fechar(); }
});

test('upload: /agents expõe o limite real e o 413 diz o tamanho do limite em MB', async () => {
  const s = await cenario({}, { env: { DGCLAW_WEB_MAX_UPLOAD_MB: '1' } });
  try {
    const lista = await s.t.c.get('/api/v1/agents');
    assert.equal(lista.json.limite_upload_bytes, 1024 * 1024);
    const limite = 'xx98';
    const corpo = Buffer.concat([Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="file"; filename="g.zip"\r\n\r\n`), Buffer.alloc(2 * 1024 * 1024, 1), Buffer.from(`\r\n--${limite}--\r\n`)]);
    const r = await s.t.c.post('/api/v1/agents/ana/upload', { corpo, headers: { 'Content-Type': `multipart/form-data; boundary=${limite}` } });
    assert.equal(r.status, 413);
    assert.equal(r.json.ok, false);
    assert.match(r.json.erro, /limite de 1 MB/);
  } finally { await s.fechar(); }
});

test('media: arquivo fora do home do agente é recusado (inclusive por link simbólico)', async () => {
  const s = await cenario();
  try {
    const fora = path.join(s.t.dir, 'fora.txt');
    fs.writeFileSync(fora, 'conteudo de fora');
    const arq = path.join(s.transcripts, '-home-agente', 'sess-ana-00001.jsonl');
    const linha = (id, caminho, legenda) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id, name: 'mcp__dgchat__send_file', input: { chat: 'c_ana', path: caminho, caption: legenda } }] } }) + '\n';
    fs.appendFileSync(arq, linha('y', fora, 'fora'));
    fs.symlinkSync(fora, path.join(s.home, 'out', 'atalho.txt'));
    fs.appendFileSync(arq, linha('z', '/home/agente/out/atalho.txt', 'atalho'));
    const msgs = (await s.t.c.get('/api/v1/agents/ana/messages')).json.msgs;
    const foraMsg = msgs.find((m) => m.text === 'fora');
    assert.equal(foraMsg.media.url, null); assert.equal(foraMsg.media.disponivel, false);
    const atalho = msgs.find((m) => m.text === 'atalho');
    assert.equal(atalho.media.disponivel, false, 'o realpath do atalho sai do home');
    const r = await s.t.c.get(`/api/v1/media/${atalho.media.id}`);
    assert.equal(r.status, 404);
    assert.ok(!r.texto.includes('conteudo de fora'));
    assert.equal((await s.t.c.get('/api/v1/media/0000000000000000')).status, 404);
    assert.equal((await s.t.c.get('/api/v1/media/..%2f..%2fetc%2fpasswd')).status, 404);
    const pdf = msgs.find((m) => m.text === 'Segue o relatório');
    const ok = await s.t.c.get(pdf.media.url);
    assert.equal(ok.status, 200); assert.equal(ok.texto, '0123456789');
    assert.equal((await s.t.c.get(`/api/v1/media/${pdf.media.id}/thumb`)).status, 404, 'thumb de PDF responde 404 com motivo');
  } finally { await s.fechar(); }
});

test('registro: relido quando o mtime muda; sinônimo tokenArquivo; arquivo ausente ou inválido dá 503 com motivo', async () => {
  const s = await cenario();
  try {
    assert.equal((await s.t.c.get('/api/v1/agents')).json.agentes.length, 2);
    const ag = JSON.parse(fs.readFileSync(s.t.agentesPath, 'utf8'));
    ag.agentes.push({ slug: 'bia', nome: 'Bia', runner: 'http://127.0.0.1:1', agente_id: 'b1', tokenArquivo: '/tmp/arquivo-x' });
    ag.agentes.push({ slug: 'Inválido!', nome: 'X', runner: 'http://127.0.0.1:1', agente_id: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(s.t.agentesPath, JSON.stringify(ag));
    const novo = (await s.t.c.get('/api/v1/agents')).json.agentes.map((a) => a.id);
    assert.deepEqual(novo, ['admin', 'ana', 'bia']);
    assert.equal(s.t.web.registro.obter('bia').runner_token_arquivo, '/tmp/arquivo-x');
    assert.match(s.t.log.texto(), /ignorei um agente porque .*slug/);
    fs.writeFileSync(s.t.agentesPath, '{quebrado');
    const r = await s.t.c.get('/api/v1/agents');
    assert.equal(r.status, 503);
    assert.match(r.json.erro, /JSON/);
    assert.ok(r.json.erro.includes(s.t.agentesPath), 'o motivo diz o caminho do arquivo');
    const pagina = await s.t.c.get('/a/ana', { headers: { Accept: 'text/html' } });
    assert.equal(pagina.status, 503);
    fs.unlinkSync(s.t.agentesPath);
    const r2 = await s.t.c.get('/api/v1/agents');
    assert.equal(r2.status, 503); assert.match(r2.json.erro, /Não achei o registro de agentes/);
    assert.equal((await s.t.c.get('/api/saude')).json.registro_ok, false);
  } finally { await s.fechar(); }
});

test('páginas: / vai para o Admin, /a/<slug> serve a conversa e slug inexistente leva 404 com motivo', async () => {
  const s = await cenario();
  try {
    // sem cookie, "/" abre o primeiro agente que não é o Admin; com o cookie do último usado, abre esse; cookie de agente que sumiu não quebra
    assert.equal((await s.t.c.get('/')).headers.location, '/a/ana');
    assert.equal((await s.t.c.get('/', { headers: { Cookie: 'dgclaw_agente=admin' } })).headers.location, '/a/admin');
    assert.equal((await s.t.c.get('/', { headers: { Cookie: 'dgclaw_agente=ana' } })).headers.location, '/a/ana');
    assert.equal((await s.t.c.get('/', { headers: { Cookie: 'dgclaw_agente=fantasma' } })).headers.location, '/a/ana');
    assert.equal((await s.t.c.get('/', { headers: { Cookie: 'dgclaw_agente=%E0%A4%A' } })).headers.location, '/a/ana');
    const ok = await s.t.c.get('/a/ana');
    assert.equal(ok.status, 200); assert.match(ok.texto, /conversa de teste/);
    const nao = await s.t.c.get('/a/fantasma');
    assert.equal(nao.status, 404); assert.match(nao.texto, /Não existe agente/);
    assert.equal((await s.t.c.get('/api/saude', { semCookie: true })).json.ok, true);
  } finally { await s.fechar(); }
});

test('avatar por https sai pelo mesmo domínio e sem foto dá 404 explicado', async () => {
  const s = await cenario();
  try {
    const sem = await s.t.c.get('/api/v1/agents/ana/avatar');
    assert.equal(sem.status, 404); assert.match(sem.json.erro, /não tem foto/);
  } finally { await s.fechar(); }
});

test('send: voz:true põe voz="1" no fim dos atributos do envelope; sem voz (ou outro valor) não põe', async () => {
  const s = await cenario();
  try {
    await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'falado', voz: true } });
    await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'escrito' } });
    await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'texto da string', voz: 'true' } });
    await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'um', voz: 1 } });
    const [a, b, c, d] = s.rAna.rec.inputs.map((i) => i.text);
    assert.match(a, /^<dgchat from="pessoa" chat="c_ana" msg="[^"]+" ts="[^"]+" voz="1">falado<\/dgchat>$/);
    for (const t of [b, c, d]) assert.ok(!t.includes('voz='), t);
  } finally { await s.fechar(); }
});

test('send: comando de barra não leva a tag de voz', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: '/compact', voz: true } });
    assert.equal(r.status, 200, r.texto);
    for (const i of s.rAna.rec.inputs) assert.ok(!i.text.includes('voz='), i.text);
  } finally { await s.fechar(); }
});

test('montarEnvelope: voz só com true', () => {
  const base = { from: 'pessoa', chat: 'c', msg: 'm', ts: 't', text: 'x' };
  assert.equal(montarEnvelope({ ...base, voz: true }), '<dgchat from="pessoa" chat="c" msg="m" ts="t" voz="1">x</dgchat>');
  assert.equal(montarEnvelope({ ...base, voz: 'true' }), '<dgchat from="pessoa" chat="c" msg="m" ts="t">x</dgchat>');
  assert.equal(montarEnvelope(base), '<dgchat from="pessoa" chat="c" msg="m" ts="t">x</dgchat>');
});
