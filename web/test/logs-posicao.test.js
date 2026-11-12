'use strict';
// Seção Logs: formatos do Codex decididos linha a linha, sem duplicata, e paginação com posição global entre muitos arquivos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, decodificaCursor, codificaCursor, ErroEntrada } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-3333-4333-8333-333333333333`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const jl = (ls) => ls.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
const casa = () => {
  const home = pastaTemp('logs-pos');
  return { home, ag: { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' } };
};
const dirClaude = (c) => { const d = path.join(c.home, '.claude', 'projects', '-ws'); fs.mkdirSync(d, { recursive: true }); return d; };
const dirCodex = (c) => { const d = path.join(c.home, '.codex', 'sessions', '2026', '11', '01'); fs.mkdirSync(d, { recursive: true }); return d; };
const cUser = (ms, texto) => ({ type: 'user', timestamp: iso(ms), sessionId: U(1), message: { role: 'user', content: texto } });

// ── Codex: duas famílias no mesmo arquivo ───────────────────────────────────
const ic = (ms, item, extra) => ({ timestamp: iso(ms), type: 'event_msg', payload: Object.assign({ type: 'item_completed', item }, extra || {}) });
const ri = (ms, payload) => ({ timestamp: iso(ms), type: 'response_item', payload });
const riMsg = (ms, role, texto) => ri(ms, { type: 'message', role, content: [{ type: 'input_text', text: texto }] });

function rollout(c, linhas) {
  const arq = path.join(dirCodex(c), `rollout-x-${U(7)}.jsonl`);
  fs.writeFileSync(arq, jl(linhas));
  return arq;
}

test('Codex: mensagem que cita "item_completed" não faz eventos sumirem (a família não é decidida por busca de texto)', async () => {
  const c = casa();
  rollout(c, [
    { timestamp: iso(0), type: 'session_meta', payload: { id: U(7) } },
    riMsg(1000, 'user', 'item_completed'),
    ri(2000, { type: 'function_call', name: 'wait', call_id: 'c1', arguments: '{}' }),
    ri(3000, { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'ls' }),
    ri(3500, { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'text', text: 'a.txt' }] }),
    riMsg(4000, 'assistant', 'resposta final'),
  ]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.deepEqual(r.eventos.map((e) => e.tipo), ['mensagem', 'comando', 'ferramenta', 'mensagem']);
  assert.equal(r.eventos[1].resultado.texto, 'a.txt');
  assert.equal(r.fontes.find((f) => f.motor === 'codex').estado, 'ok');
});

test('Codex: mensagem de texto "response_item" num arquivo só de item_completed também não faz nada sumir', async () => {
  const c = casa();
  rollout(c, [
    ic(1000, { type: 'UserMessage', content: [{ type: 'text', text: 'response_item' }] }),
    ic(2000, { type: 'CommandExecution', command: ['bash', '-lc', 'ls'], exit_code: 0, status: 'completed', aggregated_output: 'ok' }, { started_at_ms: BASE_T + 1900 }),
    ic(3000, { type: 'AgentMessage', content: [{ type: 'text', text: 'é um tipo de registro' }] }),
  ]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 3);
});

function misto(ordem) {
  // as mesmas ações nas duas famílias, com a ordem relativa das linhas variando
  const par = (a, b) => (ordem === 'ri-primeiro' ? [a, b] : [b, a]);
  return [
    { timestamp: iso(0), type: 'session_meta', payload: { id: U(7) } },
    riMsg(500, 'user', '<environment_context>cwd</environment_context>'),
    ...par(riMsg(1000, 'user', 'rode os testes'), ic(1040, { type: 'UserMessage', content: [{ type: 'text', text: 'rode os testes' }] })),
    ...par(ri(2000, { type: 'function_call', name: 'shell', call_id: 'call_a', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) }),
      ic(2400, { type: 'CommandExecution', id: 'exec-a', command: ['bash', '-lc', 'npm test'], exit_code: 0, status: 'completed', aggregated_output: 'passou' }, { started_at_ms: BASE_T + 2010 })),
    ri(2600, { type: 'function_call_output', call_id: 'call_a', output: JSON.stringify({ output: 'saida do shell', metadata: { exit_code: 0 } }) }),
    ri(5000, { type: 'function_call', name: 'wait', call_id: 'call_w', arguments: '{}' }),
    ...par(ri(9000, { type: 'custom_tool_call', name: 'exec', call_id: 'call_b', input: 'dgchat reply' }),
      ic(9300, { type: 'McpToolCall', id: 'exec-b', server: 'dgchat', tool: 'reply', arguments: { text: 'oi' }, status: 'completed', result: { content: [{ type: 'text', text: 'enviado' }] } }, { started_at_ms: BASE_T + 9005 })),
    ic(12000, { type: 'CommandExecution', id: 'exec-solto', command: ['bash', '-lc', 'solto'], exit_code: 0, status: 'completed', aggregated_output: 'x' }, { started_at_ms: BASE_T + 11990 }),
    ...par(riMsg(15000, 'assistant', 'Tudo certo'), ic(15030, { type: 'AgentMessage', content: [{ type: 'text', text: 'Tudo certo' }] })),
  ];
}

for (const ordem of ['ri-primeiro', 'ic-primeiro']) {
  test(`Codex misto (${ordem}): cada ação aparece uma vez, o que não tem par não some`, async () => {
    const c = casa();
    rollout(c, misto(ordem));
    const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
    const resumo = r.eventos.map((e) => `${e.tipo}:${e.detalhes.comando || e.detalhes.ferramenta || e.texto}`.replace(/\s+/g, ' '));
    const contem = (rx) => resumo.filter((x) => rx.test(x)).length;
    assert.equal(contem(/rode os testes/), 1, resumo.join(' | '));
    assert.equal(r.eventos.filter((e) => e.tipo === 'comando' && /^npm \[argumentos ocultos/.test(e.detalhes.comando)).length, 1);
    assert.equal(contem(/^comando:solto/), 1, 'o item sem par aparece');
    assert.equal(contem(/^ferramenta:wait/), 1, 'a chamada sem item_completed aparece');
    // o `exec` com chamada embrulhada não se compara com o item MCP: os dois ficam (repetição, nunca falta de ação)
    assert.equal(r.eventos.filter((e) => e.detalhes.ferramenta === 'dgchat/reply').length, 1);
    assert.equal(r.eventos.filter((e) => e.detalhes.comando === 'dgchat reply').length, 1);
    assert.equal(contem(/tudo certo/i), 1);
    assert.ok(!resumo.some((x) => /environment_context/.test(x)));
    assert.equal(r.eventos.length, 7, resumo.join(' | '));
  });
}

test('Codex misto: a paginação também não repete a ação nem perde evento', async () => {
  const c = casa();
  rollout(c, misto('ri-primeiro'));
  const l = criarLeitor();
  const tudo = (await l.eventos(c.ag, { limite: 50, cursor: null })).eventos.map((e) => e.id);
  for (const tamanho of [1, 2, 3]) {
    const ids = [];
    let cursor = null;
    for (let i = 0; i < 30; i++) {
      const r = await l.eventos(c.ag, { limite: tamanho, cursor });
      ids.push(...r.eventos.map((e) => e.id));
      if (!r.proximo) break;
      cursor = decodificaCursor(r.proximo);
    }
    assert.deepEqual(ids, tudo, `limite ${tamanho}`);
  }
});

test('Codex: arquivo sem nenhum registro reconhecido continua sendo "formato não reconhecido"', async () => {
  const c = casa();
  rollout(c, [{ timestamp: iso(0), type: 'session_meta', payload: { id: U(7) } }, { timestamp: iso(1), type: 'turn_context', payload: {} }]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.ok(r.avisos.some((a) => a.tipo === 'formato_desconhecido'));
});

// ── posição global entre muitos arquivos ────────────────────────────────────
function muitosArquivos(c, n, comEvento) {
  const d = dirClaude(c);
  const lixo = JSON.stringify({ type: 'attachment', timestamp: iso(0), sessionId: U(1), attachment: { t: 'x'.repeat(400) } });
  for (let i = 1; i <= n; i++) {
    // arquivos separados por 10 minutos: um arquivo só precisa ser aberto quando o anterior já não pode ter evento mais novo
    const off = 100 * 600000 - i * 600000;
    const mt = new Date(BASE_T + off);
    const linhas = [lixo, lixo];
    if (comEvento(i)) linhas.unshift(cUser(off - 1000, `evento-${i}`));
    const arq = path.join(d, `${U(i)}.jsonl`);
    fs.writeFileSync(arq, jl(linhas));
    fs.utimesSync(arq, mt, mt);
  }
}

async function paginar(l, ag, f, tamanho, max) {
  const ids = [];
  const cursores = new Set();
  const avisos = [];
  let cursor = null;
  let paginas = 0;
  for (; paginas < (max || 400); paginas++) {
    const r = await l.eventos(ag, Object.assign({ limite: tamanho, cursor }, f || {}));
    ids.push(...r.eventos.map((e) => e.id));
    avisos.push(...r.avisos.map((a) => a.tipo));
    if (!r.proximo) return { ids, paginas, avisos, parcialFinal: r.parcial };
    assert.ok(!cursores.has(r.proximo), 'cursor repetido');
    cursores.add(r.proximo);
    cursor = decodificaCursor(r.proximo);
  }
  throw new Error('a paginação não terminou');
}

test('161 arquivos, orçamento baixo, evento só no último arquivo: a paginação chega nele (sem "sem_progresso")', async () => {
  const c = casa();
  muitosArquivos(c, 161, (i) => i === 161);
  const l = criarLeitor({ orcamento: { maxBytes: 2500 } });
  const { ids, avisos } = await paginar(l, c.ag, {}, 10);
  assert.equal(ids.length, 1);
  assert.ok(!avisos.includes('sem_progresso'));
});

test('muitos arquivos com eventos espalhados: paginação completa sem repetir nem perder, com orçamento baixo', async () => {
  const c = casa();
  muitosArquivos(c, 90, (i) => i % 3 === 0);
  const base = (await criarLeitor().eventos(c.ag, { limite: 200, cursor: null })).eventos.map((e) => e.id);
  assert.equal(base.length, 30);
  const l = criarLeitor({ orcamento: { maxBytes: 3000 } });
  const r = await paginar(l, c.ag, {}, 4);
  assert.deepEqual([...r.ids].sort(), [...base].sort());
  assert.equal(new Set(r.ids).size, r.ids.length);
  assert.deepEqual(r.ids, base, 'e na mesma ordem');
  assert.ok(!r.avisos.includes('sem_progresso'));
});

test('arquivo esgotado não é reaberto: a página seguinte lê só o que falta', async () => {
  const c = casa();
  muitosArquivos(c, 40, (i) => i === 40);
  const l = criarLeitor({ orcamento: { maxBytes: 4000 } });
  const r1 = await l.eventos(c.ag, { limite: 10, cursor: null });
  assert.equal(r1.parcial, true);
  const cur = decodificaCursor(r1.proximo);
  assert.ok(cur.g && cur.ts, 'o cursor leva a posição global e o momento em que nasceu');
  assert.ok(Object.keys(cur.h).length < 3, 'h só guarda arquivo lido pela metade');
});

test('arquivo que cresce entre as páginas: o que já saiu não repete e o que é novo e antigo aparece uma vez', async () => {
  const c = casa();
  muitosArquivos(c, 30, (i) => i % 2 === 0);
  const d = dirClaude(c);
  const l = criarLeitor({ orcamento: { maxBytes: 7000 } });
  const r1 = await l.eventos(c.ag, { limite: 3, cursor: null });
  let cursor = r1.proximo ? decodificaCursor(r1.proximo) : null;
  const vistos = new Set(r1.eventos.map((e) => e.id));
  // Escritas em ordem de horário, como o agente faz: o arquivo 2 (já esgotado, o mais novo) ganha um evento mais novo que o
  // cursor, e o arquivo 10 (ainda não aberto) ganha um evento que ainda está abaixo do cursor.
  fs.appendFileSync(path.join(d, `${U(2)}.jsonl`), jl([cUser(100 * 600000 + 5000, 'novo-demais')]));
  fs.appendFileSync(path.join(d, `${U(10)}.jsonl`), jl([cUser(90 * 600000 + 50000, 'chegou-atrasado')]));
  const todos = [...r1.eventos.map((e) => e.id)];
  for (let i = 0; i < 200 && cursor; i++) {
    const r = await l.eventos(c.ag, { limite: 3, cursor });
    for (const e of r.eventos) { assert.ok(!vistos.has(e.id), `repetido: ${e.id}`); vistos.add(e.id); todos.push(e.id); }
    cursor = r.proximo ? decodificaCursor(r.proximo) : null;
  }
  const textos = (await criarLeitor().eventos(c.ag, { limite: 200, cursor: null })).eventos;
  assert.ok(todos.length >= 15, 'os eventos originais (15) saíram: ' + todos.length);
  const atrasado = textos.find((e) => e.texto === 'chegou-atrasado');
  assert.ok(atrasado && todos.includes(atrasado.id), 'o evento antigo que chegou depois aparece');
  const novo = textos.find((e) => e.texto === 'novo-demais');
  assert.ok(novo && !todos.includes(novo.id), 'o mais novo que o cursor fica para quem recarregar');
});

test('mais arquivos em andamento do que cabem em "h": a busca continua correta e avisa', async () => {
  const c = casa();
  const d = dirClaude(c);
  // 80 arquivos com o mesmo mtime e horários intercalados: todos entram em andamento juntos
  const mt = new Date(BASE_T + 2000000);
  for (let i = 1; i <= 80; i++) {
    const arq = path.join(d, `${U(i)}.jsonl`);
    fs.writeFileSync(arq, jl([cUser(i * 10, `a${i}`), cUser(10000 + i * 10, `b${i}`), cUser(20000 + i * 10, `c${i}`)]));
    fs.utimesSync(arq, mt, mt);
  }
  // Prazo de descoberta folgado: numa máquina carregada os 3 s padrão podem estourar, e aí a lista fica parcial (com aviso
  // "limite"), o que é outro cenário. Aqui o que se confere é a posição com os arquivos em andamento além do "h".
  const leitor = () => criarLeitor({ orcamento: { descobertaMs: 600000 } });
  const base = (await leitor().eventos(c.ag, { limite: 500, cursor: null })).eventos.map((e) => e.id);
  assert.equal(base.length, 240);
  const r = await paginar(leitor(), c.ag, {}, 5);
  assert.deepEqual(r.ids, base);
  assert.ok(r.avisos.includes('hints_omitidos'));
});

test('cursor com posição global inválida é 400', () => {
  const b64 = (o) => codificaCursor(o);
  assert.throws(() => decodificaCursor(b64({ g: [1, 'curto'] })), ErroEntrada);
  assert.throws(() => decodificaCursor(b64({ g: 'x' })), ErroEntrada);
  assert.throws(() => decodificaCursor(b64({ ts: 'ontem' })), ErroEntrada);
  const ok = decodificaCursor(b64({ g: [123.5, 'aaaaaaaaaaaa'], ts: 99, h: {} }));
  assert.deepEqual(ok.g, { m: 123.5, id: 'aaaaaaaaaaaa' });
  assert.equal(ok.ts, 99);
});
