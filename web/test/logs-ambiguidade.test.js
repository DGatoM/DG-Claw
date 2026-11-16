'use strict';
// Seção Logs: a máscara não deixa sobra do valor, e o par entre as duas famílias do Codex só vale com correspondência inequívoca.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpaCamadaAntiga: limpa, decodificaCursor } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-5555-4555-8555-555555555555`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const jl = (ls) => ls.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
const casa = () => {
  const home = pastaTemp('logs-amb');
  return { home, ag: { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' } };
};

// ── máscara sem sobra ───────────────────────────────────────────────────────
const SUF = 'SUFIXO' + 'ALHEIO' + '789';   // marca o que vem depois do valor sensível
const longoSemEspaco = (n) => 'A1'.repeat(n / 2);
const CASOS = [
  `Authorization: Basic ${longoSemEspaco(412)} ${SUF}`,
  `Authorization: Bearer ${'tok '.repeat(120)}${SUF}`,
  `Proxy-Authorization: Basic abc ${SUF}`,
  `proxy-authorization: ${longoSemEspaco(300)}/${SUF}`,
  `X-Api-Key: ${longoSemEspaco(300)}/${SUF}`,
  `curl -H 'Authorization: Basic ${longoSemEspaco(412)} ${SUF}' https://exemplo.test`,
  `app --password "${'palavra '.repeat(80)}${SUF}" depois`,
  `app --token '${'palavra '.repeat(80)}${SUF}' depois`,
  `app --secret "${'palavra '.repeat(80)}${SUF}`,
  `app --senha=${longoSemEspaco(300)}/${SUF}`,
  `app --api-key ${longoSemEspaco(300)}/${SUF}`,
  `chave="${'x y '.repeat(100)}${SUF}" fim`,
  `pwd='${'x y '.repeat(100)}${SUF}' fim`,
  `curl -u "usuario:${'p '.repeat(100)}${SUF}" https://x`,
  `curl --user 'usuario:${'p '.repeat(100)}${SUF}`,
  `mysql -u root -p${longoSemEspaco(300)}/${SUF} db`,
];

test('limpa: o valor sensível nunca deixa sobra, mesmo muito longo', () => {
  for (const c of CASOS) {
    const r = limpa(c);
    assert.ok(!r.includes(SUF), `sobrou o sufixo em: ${c.slice(0, 40)} => ${r.slice(0, 120)}`);
    assert.ok(!r.includes('ALHEIO'));
  }
  assert.match(limpa(`app --password "${'a b '.repeat(100)}${SUF}" depois`), /depois$/, 'o que vem depois da aspa de fechamento fica');
  assert.match(limpa(`app --token 'abc def ${SUF}\nlinha seguinte`), /\nlinha seguinte$/, 'sem aspa de fechamento, só até o fim da linha');
  assert.match(limpa(`Authorization: Basic abc ${SUF}\noutra linha`), /\noutra linha$/);
  assert.match(limpa('app --password simples --outra coisa'), /^app --password \[segredo oculto\] --outra coisa$/, 'sem aspas, até o próximo espaço');
});

test('resposta e busca: nenhum pedaço do valor sai e procurar pelo sufixo não acha', async () => {
  const c = casa();
  const d = path.join(c.home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  const linhas = CASOS.map((texto, i) => ({ type: 'user', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'user', content: texto } }));
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), jl(linhas));
  const l = criarLeitor();
  const r = await l.eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, CASOS.length);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));
  for (const q of [SUF, 'ALHEIO', 'sufixo']) assert.equal((await l.eventos(c.ag, { limite: 50, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
});

// ── pares do Codex ──────────────────────────────────────────────────────────
const ic = (ms, item, extra) => ({ timestamp: iso(ms), type: 'event_msg', payload: Object.assign({ type: 'item_completed', item }, extra || {}) });
const ri = (ms, payload) => ({ timestamp: iso(ms), type: 'response_item', payload });
const cmdIC = (ms, cmd, id) => ic(ms + 100, { type: 'CommandExecution', id, command: ['bash', '-lc', cmd], exit_code: 0, status: 'completed', aggregated_output: 'ok' }, { started_at_ms: BASE_T + ms });
const cmdRI = (ms, cmd, callId) => ri(ms, { type: 'function_call', name: 'shell', call_id: callId, arguments: JSON.stringify({ command: ['bash', '-lc', cmd] }) });
const rollout = (c, linhas) => {
  const d = path.join(c.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `rollout-x-${U(2)}.jsonl`), jl(linhas));
};
const comandos = (r) => r.eventos.filter((e) => e.tipo === 'comando').map((e) => e.detalhes.comando.replace(/\s+/g, ' ')).sort();

async function paginado(l, ag, tamanho) {
  const ids = [];
  let cursor = null;
  for (let i = 0; i < 60; i++) {
    const r = await l.eventos(ag, { limite: tamanho, cursor });
    ids.push(...r.eventos.map((e) => e.id));
    if (!r.proximo) break;
    cursor = decodificaCursor(r.proximo);
  }
  return ids;
}

for (const ordem of ['ri-antes', 'ic-antes']) {
  test(`Codex: ações diferentes a 100 ms (${ordem}) ficam as duas; paginando com limite 1 também`, async () => {
    const c = casa();
    const a = cmdRI(5000, 'rm -rf /workspace/dados', 'call_1');
    const b = cmdIC(5050, 'ls /workspace', 'exec-2');
    rollout(c, [{ timestamp: iso(0), type: 'session_meta', payload: { id: U(2) } }, ...(ordem === 'ri-antes' ? [a, b] : [b, a])]);
    const l = criarLeitor();
    const r = await l.eventos(c.ag, { limite: 50, cursor: null });
    assert.deepEqual(comandos(r), ['ls /workspace', 'rm -rf /workspace/dados']);
    const ids = await paginado(l, c.ag, 1);
    assert.deepEqual(ids, r.eventos.map((e) => e.id));
  });

  test(`Codex: duplicata idêntica (${ordem}) colapsa; qualquer diferença no texto, até de espaço ou de caixa, mantém os dois`, async () => {
    const c = casa();
    const a = cmdRI(5000, 'rm -rf /workspace/dados', 'call_1');
    const b = cmdIC(5050, 'rm -rf /workspace/dados', 'exec-2');
    const x = cmdRI(7000, "rm -rf -- '/workspace/cliente  A'", 'call_3');
    const y = cmdIC(7050, "rm -rf -- '/workspace/cliente A'", 'exec-4');
    const m = cmdRI(9000, 'rm -rf /Workspace/Dados', 'call_5');
    const n = cmdIC(9050, 'rm -rf /workspace/dados', 'exec-6');
    const par = (p, q) => (ordem === 'ri-antes' ? [p, q] : [q, p]);
    rollout(c, [{ timestamp: iso(0), type: 'session_meta', payload: { id: U(2) } }, ...par(a, b), ...par(x, y), ...par(m, n)]);
    const l = criarLeitor();
    const r = await l.eventos(c.ag, { limite: 50, cursor: null });
    assert.deepEqual(comandos(r), [
      "rm -rf -- '/workspace/cliente A'", "rm -rf -- '/workspace/cliente A'", 'rm -rf /Workspace/Dados', 'rm -rf /workspace/dados', 'rm -rf /workspace/dados',
    ], 'a idêntica vira uma; o espaço duplo e a caixa diferente ficam as duas');
    assert.equal(r.eventos.filter((e) => e.tipo === 'comando').length, 5);
    assert.deepEqual(await paginado(l, c.ag, 1), r.eventos.map((e) => e.id));
  });

  test(`Codex: mensagens que só diferem depois do caractere 300 (${ordem}) ficam as duas; a idêntica colapsa`, async () => {
    const c = casa();
    const base = 'início comum '.repeat(30);   // mais de 300 caracteres
    const ri1 = ri(1000, { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${base}final A` }] });
    const ic1 = ic(1040, { type: 'UserMessage', content: [{ type: 'text', text: `${base}final B` }] });
    const ri2 = ri(3000, { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${base}igual` }] });
    const ic2 = ic(3040, { type: 'UserMessage', content: [{ type: 'text', text: `${base}igual` }] });
    const ri3 = ri(5000, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Olá  mundo' }] });
    const ic3 = ic(5040, { type: 'UserMessage', content: [{ type: 'text', text: 'olá mundo' }] });
    const par = (p, q) => (ordem === 'ri-antes' ? [p, q] : [q, p]);
    rollout(c, [{ timestamp: iso(0), type: 'session_meta', payload: { id: U(2) } }, ...par(ri1, ic1), ...par(ri2, ic2), ...par(ri3, ic3)]);
    const l = criarLeitor();
    const r = await l.eventos(c.ag, { limite: 50, cursor: null });
    const textos = r.eventos.map((e) => e.texto.replace(base, '#')).sort();
    assert.deepEqual(textos, ['#final A', '#final B', '#igual', 'Olá  mundo', 'olá mundo']);
    assert.deepEqual(await paginado(l, c.ag, 1), r.eventos.map((e) => e.id));
  });}

test('Codex: o mesmo comando duas vezes seguidas só colapsa com o par um para um', async () => {
  const c = casa();
  rollout(c, [
    cmdRI(5000, 'ls', 'c1'), cmdIC(5010, 'ls', 'e1'),
    cmdRI(5500, 'ls', 'c2'),   // sem item correspondente: tem de aparecer
  ]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(comandos(r).length, 2);
});

test('Codex: `exec` embrulhado nunca colapsa com o item sem o mesmo id: ficam os dois eventos', async () => {
  const c = casa();
  const exec = (ms, input, id) => ri(ms, { type: 'custom_tool_call', name: 'exec', call_id: id, input });
  rollout(c, [
    exec(1000, 'text(await tools.exec_command({cmd:"ls /workspace",max_output_tokens:6000}));', 'k1'), cmdIC(1010, 'ls /workspace', 'e1'),
    exec(2000, 'await tools.exec_command({cmd:"rm -rf /workspace/dados"});', 'k2'), cmdIC(2010, 'ls /workspace', 'e2'),
    exec(3000, 'await tools.reply({chat:"c",text:"oi"}); text(await tools.exec_command({cmd:"pwd"}));', 'k3'), cmdIC(3010, 'pwd', 'e3'),
    exec(4000, 'await tools.reply({chat:"c",text:"oi"});', 'k4'),
    ic(4100, { type: 'McpToolCall', id: 'e4', server: 'dgchat', tool: 'reply', arguments: { chat: 'c', text: 'oi' }, status: 'completed' }, { started_at_ms: BASE_T + 4010 }),
  ]);
  const l = criarLeitor();
  const r = await l.eventos(c.ag, { limite: 50, cursor: null });
  const cs = r.eventos.filter((e) => e.tipo === 'comando');
  assert.equal(cs.length, 7, 'os 4 exec e os 3 itens de comando');
  assert.equal(cs.filter((e) => /tools\.|^(comando|await) \[argumentos ocultos/.test(e.detalhes.comando)).length, 4, 'os trechos de exec aparecem');
  assert.equal(r.eventos.filter((e) => e.detalhes.ferramenta === 'dgchat/reply').length, 1);
  assert.deepEqual(await paginado(l, c.ag, 1), r.eventos.map((e) => e.id));
});

test('Codex: exec embrulhado com o mesmo id do item ainda pareia', async () => {
  const c = casa();
  rollout(c, [
    ri(1000, { type: 'custom_tool_call', name: 'exec', call_id: 'mesmo', input: 'await tools.exec_command({cmd:"ls"});' }),
    cmdIC(1010, 'ls', 'mesmo'),
  ]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 1);
});

test('exec com muitos espaços (que travava a extração por regex) é lido rápido', async () => {
  const c = casa();
  const input = 'await tools.exec_command({cmd:"ls"})' + ' '.repeat(7900) + '\ntext("ok");';
  rollout(c, [ri(1000, { type: 'custom_tool_call', name: 'exec', call_id: 'k', input }), cmdIC(1010, 'ls', 'e')]);
  const ini = Date.now();
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.ok(Date.now() - ini < 2000);
  assert.equal(r.eventos.length, 2);
});

test('Codex: o mesmo id pareia (correspondência inequívoca), mesmo com texto diferente', async () => {
  const c = casa();
  rollout(c, [
    ri(1000, { type: 'function_call', name: 'shell', call_id: 'mesmo-id', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }) }),
    ic(1500, { type: 'CommandExecution', id: 'mesmo-id', command: ['bash', '-lc', 'ls -la'], exit_code: 0, status: 'completed', aggregated_output: '' }, { started_at_ms: BASE_T + 1400 }),
  ]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 1);
});

// ── aspa escapada e objetos com chave sensível ──────────────────────────────
const ESCAPADOS = [
  `app --password "prefixo\\"${SUF}" depois`,
  `app --token 'prefixo\\'${SUF}' depois`,
  `app --secret "a\\\\\\"${SUF}" depois`,
  `app --api-key="a b \\" c ${SUF}" depois`,
  `senha="a\\"${SUF}" depois`,
  `chave: "a b \\" c ${SUF}" depois`,
  `curl -u "usuario:p\\"${SUF}" https://x depois`,
  `app --password "sem fechamento \\"${SUF}`,
  `app --password "termina em barra \\`,
];

test('limpa: aspa escapada não fecha o valor', () => {
  for (const c of ESCAPADOS) {
    const r = limpa(c);
    assert.ok(!r.includes(SUF), `sobrou o sufixo em: ${c} => ${r}`);
  }
  assert.match(limpa(ESCAPADOS[0]), /depois$/, 'o que vem depois da aspa de fechamento de verdade fica');
  assert.match(limpa(`app --token "abre \\" e segue ${SUF}\nlinha seguinte`), /\nlinha seguinte$/, 'sem fechamento, só até o fim da linha');
});

const K = { a: 'authori' + 'zation', c: 'cook' + 'ie', k: 'cha' + 've', p: 'pass' + 'word', s: 'sec' + 'ret', t: 'to' + 'ken' };
const objetoComSegredos = () => ({
  headers: { [K.a]: `Basic x ${SUF}`, 'X-Visivel': 'aparece' },
  nested: { deep: { deeper: { [K.p]: SUF } } },
  lista: [{ [K.t]: SUF }, { ok: 'tambem aparece' }],
  texto: JSON.stringify({ [K.s]: SUF, ok: 1, interno: JSON.stringify({ [K.c]: SUF }) }),
  comando: `app --password "x\\"${SUF}"`,
  [K.k]: SUF,
  cmd: 'ls',
});

test('objetos do log: valor de chave sensível sai escondido em qualquer nível, inclusive em texto que contém JSON (Claude e Codex)', async () => {
  const c = casa();
  const d = path.join(c.home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  const json = JSON.stringify({ [K.t]: SUF, visivel: 'sim' });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), jl([
    { type: 'user', timestamp: iso(1000), sessionId: U(1), message: { role: 'user', content: json } },
    { type: 'assistant', timestamp: iso(2000), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__x__faz', input: objetoComSegredos() }] } },
    { type: 'user', timestamp: iso(3000), sessionId: U(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: json }] } },
  ]));
  const cx = path.join(c.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  const item = (ms, i) => ({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'item_completed', item: i } });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), jl([
    item(4000, { type: 'McpToolCall', server: 'x', tool: 'faz', arguments: objetoComSegredos(), status: 'completed', result: { content: [{ type: 'text', text: json }] } }),
    item(5000, { type: 'CommandExecution', command: ['bash', '-lc', 'cat resposta.json'], exit_code: 0, status: 'completed', aggregated_output: json }),
    item(6000, { type: 'UserMessage', content: [{ type: 'text', text: json }] }),
  ]));
  const l = criarLeitor();
  const r = await l.eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 5);
  const texto = JSON.stringify(r);
  assert.ok(!texto.includes(SUF), 'nenhum valor sensível na resposta');
  assert.ok(texto.includes('aparece') && texto.includes('tambem aparece') && texto.includes('visivel'), 'o que não é sensível continua legível');
  for (const q of [SUF, 'ALHEIO']) assert.equal((await l.eventos(c.ag, { limite: 50, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
});

test('objetos do log: profundidade, número de chaves e tamanho limitados, sem erro', async () => {
  const c = casa();
  const d = path.join(c.home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  let fundo = { [K.p]: SUF };
  for (let i = 0; i < 30; i++) fundo = { n: fundo };
  const largo = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i === 999 ? SUF : 'v']));
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), jl([
    { type: 'assistant', timestamp: iso(1000), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: fundo }, { type: 'tool_use', id: 'b', name: 'y', input: largo }, { type: 'tool_use', id: 'c', name: 'z', input: { ['__proto__']: { x: 1 }, ok: 1 } }] } },
  ]));
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 3);
  assert.ok(!JSON.stringify(r).includes(SUF));
});

test('limpa: senha do mysql entre aspas, com espaços, não deixa sobra (mysql e mysqldump)', () => {
  const casos = [
    `mysql -u root -p"primeira ${SUF}" banco`,
    `mysqldump -u root -p'primeira ${SUF}' banco`,
    `mysql -u root -p"primeira \\"${SUF}" banco`,
    `mysql -u root -pabc"primeira ${SUF}"def banco`,
    `mysqldump -p"primeira ${SUF}`,
  ];
  for (const c of casos) {
    const r = limpa(c);
    assert.ok(!r.includes(SUF) && !r.includes('primeira'), `sobrou parte da senha em: ${r}`);
  }
  assert.match(limpa(`mysql -u root -p"a b" banco`), / banco$/, 'o que vem depois da senha continua legível');
});

// ── argumento com pedaços adjacentes (com e sem aspas) ──────────────────────
const ADJACENTES = [
  `app --password="prefixo"${SUF} depois`,
  `app --token='a b'c"d e"${SUF} depois`,
  `app --secret "a b"'c d'${SUF} depois`,
  `app --api-key=um"dois três"quatro'cinco seis'${SUF} depois`,
  `curl -u a:"b c"${SUF} https://x depois`,
  `curl --user 'a b'c:"d e"${SUF} https://x depois`,
  `senha="a"${SUF} depois`,
  `chave='a b'"c d"${SUF} depois`,
  `pwd=a"b c"${SUF} depois`,
  `mysql -u root -p"a b"c'd e'${SUF} db depois`,
  `app --password=primeira\\ ${SUF} depois`,
  `app --token a\\ b\\ ${SUF} depois`,
  `curl -u usuario:um\\ dois${SUF} https://x depois`,
  `senha=a\\ b\\"c${SUF} depois`,
  `mysql -u root -pum\\ dois${SUF} db depois`,
];

test('limpa: valor com pedaços adjacentes, com e sem aspas, sai inteiro e o que vem depois fica legível', () => {
  for (const c of ADJACENTES) {
    const r = limpa(c);
    assert.ok(!r.includes(SUF), `sobrou o sufixo em: ${c} => ${r}`);
    assert.match(r, /depois$/);
  }
});

test('limpa: JSON em texto cru para o valor na aspa de fechamento e preserva o resto do objeto', () => {
  const k = 'sen' + 'ha';
  const r = limpa(`{"${k}":"${SUF}","outro":"visivel","lista":["a","b"],"${k}2":"x"}`);
  assert.ok(!r.includes(SUF));
  assert.ok(r.includes('"outro":"visivel"') && r.includes('"lista":["a","b"]'), r);
  const r2 = limpa(`{"a":{"${k}":"${SUF}"},"b":"fica"}`);
  assert.ok(!r2.includes(SUF) && r2.includes('"b":"fica"'), r2);
  assert.ok(!limpa(`[{"${k}":"${SUF}"},{"c":1}]`).includes(SUF));
  assert.equal(limpa(`--password=pa,ss}x]y resto`), '--password=[segredo oculto] resto', 'sem aspas, vírgula e chave fazem parte do valor');
});

test('resposta e busca nos dois motores: nada do valor sai e procurar pelo sufixo não acha', async () => {
  const c = casa();
  const d = path.join(c.home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), jl(ADJACENTES.map((texto, i) => ({ type: 'user', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'user', content: texto } }))));
  const cx = path.join(c.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), jl(ADJACENTES.map((texto, i) => ic(5000 + i, { type: 'UserMessage', content: [{ type: 'text', text: texto }] }))));
  const l = criarLeitor();
  const r = await l.eventos(c.ag, { limite: 100, cursor: null });
  assert.equal(r.eventos.length, ADJACENTES.length * 2);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));
  for (const q of [SUF, 'ALHEIO']) assert.equal((await l.eventos(c.ag, { limite: 100, cursor: null, q })).eventos.length, 0);
  assert.ok(r.eventos.every((e) => /depois|linha oculta/.test(e.texto)));
});
