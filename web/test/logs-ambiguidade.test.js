'use strict';
// Seção Logs: a máscara não deixa sobra do valor, e o par entre as duas famílias do Codex só vale com correspondência inequívoca.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpa, decodificaCursor } = require('../lib/logs-leitor');

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

  test(`Codex: a duplicata verdadeira (${ordem}) continua colapsando, com texto igual e espaços diferentes`, async () => {
    const c = casa();
    const a = cmdRI(5000, 'rm -rf   /workspace/dados', 'call_1');
    const b = cmdIC(5050, 'rm -rf /workspace/dados', 'exec-2');
    const outro = cmdIC(5060, 'rm -rf /Workspace/Dados', 'exec-3');
    rollout(c, [{ timestamp: iso(0), type: 'session_meta', payload: { id: U(2) } }, ...(ordem === 'ri-antes' ? [a, b] : [b, a]), outro]);
    const l = criarLeitor();
    const r = await l.eventos(c.ag, { limite: 50, cursor: null });
    assert.deepEqual(comandos(r), ['rm -rf /Workspace/Dados', 'rm -rf /workspace/dados'], 'maiúsculas diferentes são outro comando');
    assert.deepEqual(await paginado(l, c.ag, 1), r.eventos.map((e) => e.id));
  });
}

test('Codex: o mesmo comando duas vezes seguidas só colapsa com o par um para um', async () => {
  const c = casa();
  rollout(c, [
    cmdRI(5000, 'ls', 'c1'), cmdIC(5010, 'ls', 'e1'),
    cmdRI(5500, 'ls', 'c2'),   // sem item correspondente: tem de aparecer
  ]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(comandos(r).length, 2);
});

test('Codex: exec embrulhado só pareia quando o comando isolado se extrai com certeza', async () => {
  const c = casa();
  const exec = (ms, input, id) => ri(ms, { type: 'custom_tool_call', name: 'exec', call_id: id, input });
  rollout(c, [
    exec(1000, 'text(await tools.exec_command({cmd:"ls /workspace",max_output_tokens:6000}));', 'k1'), cmdIC(1010, 'ls  /workspace', 'e1'),       // par: um só
    exec(2000, 'await tools.exec_command({cmd:"rm -rf /workspace/dados"});', 'k2'), cmdIC(2010, 'ls /workspace', 'e2'),                     // diferentes: os dois
    exec(3000, 'await tools.reply({chat:"c",text:"oi"}); text(await tools.exec_command({cmd:"pwd"}));', 'k3'), cmdIC(3010, 'pwd', 'e3'),      // embrulho com mais de uma chamada: os dois
    exec(4000, 'await tools.reply({chat:"c",text:"oi"});', 'k4'),
    ic(4100, { type: 'McpToolCall', id: 'e4', server: 'dgchat', tool: 'reply', arguments: { chat: 'c', text: 'oi' }, status: 'completed' }, { started_at_ms: BASE_T + 4010 }),
  ]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  const cs = r.eventos.filter((e) => e.tipo === 'comando');
  const norm = (e) => e.detalhes.comando.replace(/\s+/g, ' ');
  assert.equal(cs.filter((e) => /ls \/workspace/.test(norm(e)) && !/rm/.test(norm(e))).length, 2, 'ls: um do par (k1/e1) e o ls solto (e2)');
  assert.equal(cs.filter((e) => /rm -rf/.test(norm(e))).length, 1);
  assert.equal(cs.filter((e) => /pwd/.test(norm(e))).length, 2, 'embrulho com mais de uma chamada não se compara');
  assert.equal(r.eventos.filter((e) => e.detalhes.ferramenta === 'dgchat/reply').length, 1);
  assert.equal(cs.length, 6);
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
