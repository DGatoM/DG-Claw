'use strict';
// Seção Logs: limites contra texto hostil (tempo da máscara, laço de eventos), tetos da descoberta e concorrência.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpa, serializa } = require('../lib/logs-leitor');
const { criarLogsRotas } = require('../lib/logs-rotas');

const U = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (n) => new Date(BASE_T + n * 1000).toISOString();
const jl = (ls) => ls.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
const casa = () => {
  const home = pastaTemp('logs-lim');
  return { home, ag: { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' } };
};
const projetos = (c) => { const d = path.join(c.home, '.claude', 'projects', '-ws'); fs.mkdirSync(d, { recursive: true }); return d; };
const xItem = (n, item) => ({ timestamp: iso(n), type: 'event_msg', payload: { type: 'item_completed', item } });

// ── texto hostil ────────────────────────────────────────────────────────────
const N = 64 * 1024;
const rep = (u, n) => u.repeat(Math.ceil((n || N) / u.length)).slice(0, n || N);
const TRACOS = '-'.repeat(5);
// Uma família de padrão por linha (mascara.js e os extras de limpa). Os valores são só repetição de pedaços de sintaxe.
const HOSTIS = [
  'curl ', 'curl x ', 'curl -u ', 'mysql ', 'mysqldump -u ', 'a', 'a.', 'aaaaaaaa ', 'eyJaaaaa', 'eyJaaaaa.', 'sk-', 'sk_a', 'sk-ant-api03-',
  'sk-proj-', 'github_pat_', 'ghp_', 'gho_', 'ghs_', 'AKIA', 'AIza', 'gsk_', 'xai-', 'xoxb-', 'Authorization ', 'Authorization: ', '--password "\\', 'chave="a\\"', "token='\\'", '"\\\\', 'senha=\\', 'tokentoken', 'passwordpassword', 'Proxy-Authorization: Basic ', 'Authorization: Basic a b ', '--password "', "--token '", 'chave="a b ', "curl -u 'a ",  'X-Api-Key: ',
  '--password ', '--password=a\\ ', 'senha=a\\ b\\ ', '--token=', '--api-key ', 'chave="', "pwd='", 'cookie:', 'Cookie: a=b; ', 'set-cookie:', 'Cookie:' + ';'.repeat(5) + ' ', 'token=', 'api_key', 'secret:', 'password ', 'senha=', 'Bearer ', 'Basic ',
  `${TRACOS}BEGIN PRIVATE ` + `KEY${TRACOS}`, 'a://b:', 'a:b@', '1', '123456789:', ' ', '\n', '"', "'", '=', '-', ':', '@', '[segredo oculto] ',
  `${'a'.repeat(41)} token `, 'x'.repeat(130),
];

test('limpa: texto repetitivo de 64 KB de cada família de padrão sai em tempo curto', () => {
  let pior = 0;
  for (const u of HOSTIS) {
    for (const tamanho of [N, 3 * N]) {
      const t = rep(u, tamanho);
      const ini = process.hrtime.bigint();
      limpa(t);
      const ms = Number(process.hrtime.bigint() - ini) / 1e6;
      pior = Math.max(pior, ms);
      assert.ok(ms < 200, `${JSON.stringify(u.slice(0, 30))} x ${tamanho}: ${ms.toFixed(0)} ms`);
    }
  }
  assert.ok(pior < 200);
});

test('limpa: corta em 64 KB e descarta também o pedaço final sem espaço (não sobra segredo cortado)', () => {
  const segredo = 'sk-' + 'A1'.repeat(10);
  const t = 'palavra '.repeat(8190) + segredo + ' fim';   // 65520 caracteres de texto e o segredo começa antes do limite
  assert.ok(t.length > 64 * 1024);
  const r = limpa(t);
  assert.ok(!r.includes('sk-A1'), 'nenhum pedaço do segredo cortado');
  assert.ok(r.length <= 64 * 1024);
  assert.ok(r.endsWith('palavra '));
  assert.equal(limpa('x'.repeat(100000)).length < 64 * 1024, true);
  // sequência longa sem espaço (chave em base64, JWT) sai omitida por inteiro
  assert.equal(limpa(`antes ${'A'.repeat(500)} depois`), 'antes [trecho-longo-omitido] depois');
});

test('busca: o texto pesquisado é o mascarado e cortado em 64 KB (o que passa do limite não é achado)', async () => {
  const c = casa();
  const d = projetos(c);
  const longo = 'ola '.repeat(17000) + 'agulha-depois-do-limite';
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), jl([{ type: 'user', timestamp: iso(1), sessionId: U(1), message: { role: 'user', content: longo } }]));
  const l = criarLeitor();
  assert.equal((await l.eventos(c.ag, { limite: 5, cursor: null, q: 'agulha-depois' })).eventos.length, 0);
  assert.equal((await l.eventos(c.ag, { limite: 5, cursor: null, q: 'ola ola' })).eventos.length, 1);
});

async function medeLaco(fn) {
  let fimDaLeitura = false;
  let timerDuranteALeitura = false;
  setTimeout(() => { timerDuranteALeitura = !fimDaLeitura; }, 0);
  let maior = 0;
  let ticks = 0;
  let ultimo = Date.now();
  const iv = setInterval(() => { const n = Date.now(); maior = Math.max(maior, n - ultimo); ultimo = n; ticks++; }, 1);
  try { await fn(); fimDaLeitura = true; } finally { clearInterval(iv); }
  return { timerDuranteALeitura, maior, ticks };
}

test('leitor (Codex) com comandos e saídas hostis: o laço de eventos continua respondendo', async () => {
  const c = casa();
  const dir = path.join(c.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(dir, { recursive: true });
  const itens = [];
  for (let i = 0; i < 60; i++) {
    itens.push(xItem(i + 1, { type: 'CommandExecution', command: ['bash', '-lc', rep('curl ', 60000)], exit_code: 0, status: 'completed', aggregated_output: rep(i % 2 ? 'a' : 'eyJaaaaa', 60000) }));
  }
  fs.writeFileSync(path.join(dir, `rollout-x-${U(2)}.jsonl`), jl(itens));
  const l = criarLeitor({ orcamento: { maxMs: 120000, maxBytes: 1e9 } });
  let r;
  const m = await medeLaco(async () => { r = await l.eventos(c.ag, { limite: 60, cursor: null }); });
  assert.equal(r.eventos.length, 60);
  assert.ok(m.timerDuranteALeitura, 'o setTimeout(0) disparou durante a leitura');
  assert.ok(m.maior < 300, `o laço ficou ${m.maior} ms parado`);
});

test('leitor (Claude): uma linha com milhares de blocos hostis também cede o laço', async () => {
  const c = casa();
  const d = projetos(c);
  const blocos = Array.from({ length: 2000 }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: rep('curl ', 700), description: rep('curl ', 300) } }));
  fs.writeFileSync(path.join(d, `${U(3)}.jsonl`), jl([{ type: 'assistant', timestamp: iso(1), sessionId: U(3), message: { role: 'assistant', content: blocos } }]));
  const l = criarLeitor();
  let r;
  const m = await medeLaco(async () => { r = await l.eventos(c.ag, { limite: 200, cursor: null }); });
  assert.equal(r.eventos.length, 200);
  assert.ok(m.timerDuranteALeitura, 'o setTimeout(0) disparou durante a leitura');
  assert.ok(m.maior < 300, `o laço ficou ${m.maior} ms parado`);
});

test('linha cujo processamento estoura o prazo é abandonada e relida na página seguinte, sem perder evento', async () => {
  const c = casa();
  const d = projetos(c);
  const blocos = Array.from({ length: 400 }, (_, i) => ({ type: 'text', text: `bloco-${i}` }));
  fs.writeFileSync(path.join(d, `${U(4)}.jsonl`), jl([{ type: 'assistant', timestamp: iso(1), sessionId: U(4), message: { role: 'assistant', content: blocos } }]));
  let n = 0;
  const l = criarLeitor({ agora: () => (n++ < 40 ? 0 : 5000), orcamento: { maxMs: 1000 } });
  const r = await l.eventos(c.ag, { limite: 500, cursor: null });
  assert.equal(r.parcial, true, 'prazo estourado no meio da linha');
  assert.equal(r.eventos.length, 0, 'a linha incompleta não entrega pedaço');
  assert.ok(r.proximo);
  const cheia = await criarLeitor().eventos(c.ag, { limite: 500, cursor: null });
  assert.equal(cheia.eventos.length, 400);
});

// ── tetos da descoberta ─────────────────────────────────────────────────────
test('descoberta: pasta com entradas demais fica "parcial" com o motivo, nunca lista cortada em silêncio', async () => {
  const c = casa();
  const d = projetos(c);
  for (let i = 0; i < 120; i++) fs.mkdirSync(path.join(d, `vazia-${i}`));
  const l = criarLeitor({ orcamento: { maxEntradas: 30 } });
  const r = await l.resumoDasFontes(c.ag);
  const f = r.fontes.find((x) => x.motor === 'claude');
  assert.equal(f.estado, 'parcial');
  assert.match(f.motivo, /mais de 30 entradas/);
  assert.ok(r.avisos.some((a) => a.tipo === 'limite' && /30 entradas/.test(a.motivo)));
});

test('descoberta: subpastas pendentes demais também param com aviso', async () => {
  const c = casa();
  const d = projetos(c);
  for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(d, `sub-${i}`));
  const l = criarLeitor({ orcamento: { maxPastas: 5 } });
  const f = (await l.resumoDasFontes(c.ag)).fontes.find((x) => x.motor === 'claude');
  assert.equal(f.estado, 'parcial');
  assert.match(f.motivo, /subpastas/);
});

test('descoberta: muitos hardlinks geram poucos avisos e a contagem do que ficou de fora', async () => {
  const c = casa();
  const d = projetos(c);
  fs.writeFileSync(path.join(d, `${U(0)}.jsonl`), jl([{ type: 'user', timestamp: iso(1), sessionId: U(0), message: { role: 'user', content: 'x' } }]));
  for (let i = 1; i <= 40; i++) fs.linkSync(path.join(d, `${U(0)}.jsonl`), path.join(d, `${U(i)}.jsonl`));
  const l = criarLeitor({ orcamento: { maxAvisos: 5 } });
  const r = await l.eventos(c.ag, { limite: 10, cursor: null });
  assert.equal(r.eventos.length, 0);
  const recusados = r.avisos.filter((a) => a.tipo === 'arquivo_recusado');
  assert.equal(recusados.length, 5);
  const om = r.avisos.find((a) => a.tipo === 'avisos_omitidos');
  assert.ok(om, 'a resposta diz que omitiu avisos');
  assert.ok(Number(/mais (\d+) aviso/.exec(om.motivo)[1]) >= 36, om.motivo);
  assert.ok(r.avisos.length <= 6);
});

test('descoberta: hardlinks acima do teto de entradas deixam a fonte parcial (o aviso do teto sempre aparece)', async () => {
  const c = casa();
  const d = projetos(c);
  fs.writeFileSync(path.join(d, `${U(0)}.jsonl`), 'x\n');
  for (let i = 1; i <= 60; i++) fs.linkSync(path.join(d, `${U(0)}.jsonl`), path.join(d, `${U(i)}.jsonl`));
  const l = criarLeitor({ orcamento: { maxEntradas: 20, maxAvisos: 3 } });
  const r = await l.eventos(c.ag, { limite: 10, cursor: null });
  assert.equal(r.fontes.find((x) => x.motor === 'claude').estado, 'parcial');
  assert.ok(r.avisos.some((a) => a.tipo === 'limite'));
});

test('descoberta: prazo próprio, com relógio de teste', async () => {
  const c = casa();
  const d = projetos(c);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(d, `lixo-${i}.txt`), 'x');
  let t = 0;
  const l = criarLeitor({ agora: () => (t += 1000), orcamento: { descobertaMs: 1500 } });
  const f = (await l.resumoDasFontes(c.ag)).fontes.find((x) => x.motor === 'claude');
  assert.equal(f.estado, 'parcial');
  assert.match(f.motivo, /passou de 1500 ms/);
});

test('descoberta: o teto de arquivos aceitos também marca a fonte como parcial', async () => {
  const c = casa();
  const d = projetos(c);
  for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(d, `${U(i)}.jsonl`), 'x\n');
  const l = criarLeitor({ orcamento: { maxArquivos: 5 } });
  const f = (await l.resumoDasFontes(c.ag)).fontes.find((x) => x.motor === 'claude');
  assert.equal(f.estado, 'parcial');
  assert.equal(f.arquivos, 5);
});

// ── concorrência e prazo de /agentes ────────────────────────────────────────
function fakeRes() {
  const r = { status: null, headers: null, corpo: null, writeHead(s, h) { r.status = s; r.headers = h; }, end(t) { r.corpo = t; r.json = t ? JSON.parse(t) : null; } };
  return r;
}
const DONO = { usuario: 'dono', papel: 'dono' };
const registroFalso = (slugs) => {
  const agentes = slugs.map((s) => ({ slug: s, nome: s, tipo: 'agente', provedor: 'claude', home_host: '/nao/existe' }));
  return { estado: () => ({ ok: true, agentes }), obter: (s) => agentes.find((a) => a.slug === s) || null };
};
const chama = (rotas, caminho, res) => rotas.rotas({ method: 'GET' }, res, new URL(`http://x${caminho}`), DONO);

test('concorrência: agentes, sessões e eventos dividem as 2 vagas; a terceira recebe 429 explicado', async () => {
  let abre;
  const portao = new Promise((r) => { abre = r; });
  const real = criarLeitor();
  const leitor = {
    resumoDasFontes: async () => { await portao; return { fontes: [] }; },
    sessoes: async () => { await portao; return { sessoes: [] }; },
    eventos: async () => { await portao; return { eventos: [] }; },
    fontesNaoVerificadas: real.fontesNaoVerificadas,
  };
  const rotas = criarLogsRotas({ registro: registroFalso(['ana']), log: () => {}, leitor });
  const r1 = fakeRes(); const r2 = fakeRes(); const r3 = fakeRes(); const r4 = fakeRes();
  const p1 = chama(rotas, '/api/v1/logs/agentes', r1);
  const p2 = chama(rotas, '/api/v1/logs/agentes/ana/sessoes', r2);
  await new Promise((r) => setImmediate(r));
  await chama(rotas, '/api/v1/logs/agentes/ana/eventos', r3);
  assert.equal(r3.status, 429);
  assert.match(r3.json.erro, /buscas de logs em andamento/);
  assert.equal(r3.headers['Retry-After'], '1');
  await chama(rotas, '/api/v1/logs/agentes', r4);
  assert.equal(r4.status, 429);
  abre();
  await Promise.all([p1, p2]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const r5 = fakeRes();
  await chama(rotas, '/api/v1/logs/agentes/ana/eventos', r5);
  assert.equal(r5.status, 200, 'a vaga voltou');
});

test('concorrência: erro de entrada e erro do leitor devolvem a vaga', async () => {
  const leitor = { resumoDasFontes: async () => ({ fontes: [] }), sessoes: async () => { throw new Error('quebrou'); }, eventos: async () => ({ eventos: [] }), fontesNaoVerificadas: () => [] };
  const rotas = criarLogsRotas({ registro: registroFalso(['ana']), log: () => {}, leitor });
  for (let i = 0; i < 5; i++) {
    const r = fakeRes();
    await chama(rotas, '/api/v1/logs/agentes/ana/sessoes', r);
    assert.equal(r.status, 500);
  }
  const ok = fakeRes();
  await chama(rotas, '/api/v1/logs/agentes/ana/eventos', ok);
  assert.equal(ok.status, 200);
});

test('/agentes: o que não couber no prazo total vem como "nao_verificada", com o motivo', async () => {
  let t = 0;
  const real = criarLeitor();
  const leitor = {
    resumoDasFontes: async () => { t += 600; return { fontes: [{ motor: 'claude', estado: 'ok', motivo: null, arquivos: 1, bytes: 1, ultima_atividade: 1 }] }; },
    fontesNaoVerificadas: real.fontesNaoVerificadas,
  };
  const rotas = criarLogsRotas({ registro: registroFalso(['a1', 'a2', 'a3', 'a4']), log: () => {}, agora: () => t, orcamento: { agentesMs: 1000 }, leitor });
  const r = fakeRes();
  await chama(rotas, '/api/v1/logs/agentes', r);
  assert.equal(r.status, 200);
  const estados = r.json.agentes.map((a) => a.fontes.map((f) => f.estado).join(','));
  assert.deepEqual(estados, ['ok', 'ok', 'nao_verificada,nao_verificada', 'nao_verificada,nao_verificada']);
  const f = r.json.agentes[3].fontes[0];
  assert.match(f.motivo, /passou do prazo/);
  assert.equal(f.arquivos, null);
});

// ── objetos largos e fundos: orçamento global por valor ─────────────────────
const SEGREDO_FIM = 'FIM' + 'DO' + 'OBJETO' + '123';
const largo = (nObj, nChaves) => Array.from({ length: nObj }, (_, i) => Object.fromEntries(Array.from({ length: nChaves }, (_, k) => [`${'auth'.repeat(30)}${i}x${k}`, `valor ${k}`])));
const aninhado = (n) => { let o = { folha: 'x', ['pass' + 'word']: SEGREDO_FIM }; for (let i = 0; i < n; i++) o = { [`k${i}`]: o, outro: { a: 1 } }; return o; };

test('serializa: objeto largo, fundo ou com JSON dentro de texto fica abaixo de 100 ms (orçamento global)', () => {
  const casos = [
    largo(180, 175),
    aninhado(40),
    { texto: JSON.stringify(largo(150, 60)) },
    Array.from({ length: 5000 }, (_, i) => ({ ['k' + i]: rep('palavra ', 600) })),
    { json: rep('{"a":', 300) + '1' + '}'.repeat(300) },
  ];
  for (const c of casos) {
    const ini = process.hrtime.bigint();
    const r = serializa(c);
    const ms = Number(process.hrtime.bigint() - ini) / 1e6;
    assert.ok(ms < 100, `${ms.toFixed(0)} ms`);
    assert.ok(r.length < 400 * 1024);
  }
});

test('serializa: ao bater o limite o resto vira marcador e nada além do corte aparece', () => {
  const lista = Array.from({ length: 3000 }, (_, i) => ({ i }));
  lista.push({ ['pass' + 'word']: SEGREDO_FIM, visivel: SEGREDO_FIM });
  const r = serializa(lista);
  assert.ok(!r.includes(SEGREDO_FIM));
  assert.match(r, /entrada grande demais, omitida/);
  const texto = serializa({ a: 'x'.repeat(40000) + ' fim', b: 'y '.repeat(30000), c: SEGREDO_FIM });
  assert.ok(!texto.includes(SEGREDO_FIM));
  assert.match(texto, /entrada grande demais/);
  assert.ok(serializa({ pequeno: 'ok', n: 1 }).includes('"pequeno":"ok"'), 'entrada pequena não é afetada');
});

test('leitor (Claude e Codex): objetos largos e aninhados não param o laço e não vazam depois do corte', async () => {
  const c = casa();
  const d = path.join(c.home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  const blocos = [{ type: 'tool_use', id: 'a', name: 'x', input: { lista: largo(100, 175) } }];
  for (let i = 0; i < 10; i++) blocos.push({ type: 'tool_use', id: `b${i}`, name: 'y', input: { n: aninhado(30), lista: largo(5, 175) } });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), jl([{ type: 'assistant', timestamp: iso(1000), sessionId: U(1), message: { role: 'assistant', content: blocos } }]));
  const cx = path.join(c.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  const itens = [];
  for (let i = 0; i < 30; i++) itens.push({ timestamp: iso(2000 + i), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 's', tool: 't', arguments: { lista: largo(40, 175), fundo: aninhado(30) }, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(largo(60, 60)) }] } } } });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), jl(itens));
  const l = criarLeitor({ orcamento: { maxMs: 120000, maxBytes: 1e9 } });
  let r;
  const m = await medeLaco(async () => { r = await l.eventos(c.ag, { limite: 100, cursor: null }); });
    assert.equal(r.eventos.length, 11 + 30);
  assert.equal(r.contagens.linhas_gigantes, 0);
  assert.ok(m.timerDuranteALeitura, 'o setTimeout(0) disparou durante a leitura');
  assert.ok(m.maior < 300, `o laço ficou ${m.maior} ms parado`);
  assert.ok(!JSON.stringify(r).includes(SEGREDO_FIM));
});

// ── consumo da fila de uma mesma linha e montagem dos eventos cedem o laço ──
const pesado = (i) => `trecho ${i} ` + 'palavra token=abc senha="x y" '.repeat(Math.floor(65000 / 30));

test('Claude: uma linha com 50 blocos caros não para o laço (cede entre os eventos e os campos)', async () => {
  const c = casa();
  const d = path.join(c.home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  const blocos = Array.from({ length: 50 }, (_, i) => ({ type: 'text', text: `${i} ` + 'mysql -p '.repeat(7000) }));
  const linha = JSON.stringify({ type: 'assistant', timestamp: iso(1000), sessionId: U(1), message: { role: 'assistant', content: blocos } });
  assert.ok(linha.length > 3 * 1024 * 1024 && linha.length < 4 * 1024 * 1024, `linha com ${linha.length} bytes`);
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), linha + '\n');
  const l = criarLeitor({ orcamento: { maxMs: 120000 } });
  let r;
  const m = await medeLaco(async () => { r = await l.eventos(c.ag, { limite: 100, cursor: null }); });
  assert.equal(r.eventos.length, 50);
  assert.ok(m.timerDuranteALeitura, 'o setTimeout(0) disparou durante a leitura');
  assert.ok(m.maior < 300, `o laço ficou ${m.maior} ms parado`);
  // Quantas vezes cede depende da velocidade da máquina; com um relógio que anda 8 ms a cada consulta,
  // todo ponto de cessão cede de fato, e a contagem passa a medir os pontos, e não a CPU.
  let t = 0;
  const l2 = criarLeitor({ agora: () => (t += 8), orcamento: { maxMs: 1e12 } });
  let voltas = 0;
  let parar = false;
  const gira = () => { if (!parar) { voltas++; setImmediate(gira); } };
  setImmediate(gira);
  try { await l2.eventos(c.ag, { limite: 100, cursor: null }); } finally { parar = true; }
  assert.ok(voltas >= 50, `o laço só respirou ${voltas} vezes (cede entre os eventos e os campos)`);
});

test('Codex: muitos itens caros seguidos não param o laço', async () => {
  const c = casa();
  const cx = path.join(c.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  const itens = Array.from({ length: 50 }, (_, i) => ({ timestamp: iso(1000 + i), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', pesado(i)], exit_code: 0, status: 'completed', aggregated_output: pesado(i) } } }));
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), jl(itens));
  const l = criarLeitor({ orcamento: { maxMs: 120000 } });
  let r;
  const m = await medeLaco(async () => { r = await l.eventos(c.ag, { limite: 100, cursor: null, q: 'trecho' }); });
  assert.equal(r.eventos.length, 50);
  assert.ok(m.timerDuranteALeitura);
  assert.ok(m.maior < 300, `o laço ficou ${m.maior} ms parado`);
  assert.ok(m.ticks >= 10, `o laço só respirou ${m.ticks} vezes`);
});
