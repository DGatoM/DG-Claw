'use strict';
// Seção Logs: máscara de Cookie (valor inteiro) e formato do Codex só declarado desconhecido depois de ler o arquivo inteiro.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpaCamadaAntiga: limpa, decodificaCursor } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-4444-4444-8444-444444444444`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const jl = (ls) => ls.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
const casa = () => {
  const home = pastaTemp('logs-ck');
  return { home, ag: { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' } };
};
const ic = (ms, item) => ({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'item_completed', item } });
const rollout = (c, linhas, cru) => {
  const d = path.join(c.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(d, { recursive: true });
  const arq = path.join(d, `rollout-x-${U(1)}.jsonl`);
  fs.writeFileSync(arq, cru != null ? cru : jl(linhas));
  return arq;
};

// ── Cookie ──────────────────────────────────────────────────────────────────
// Os valores são montados na hora: nada aqui é segredo de verdade.
const V = ['valor-um-' + 'a1b2c3', 'valor-dois-' + 'd4e5f6', 'valor-tres-' + 'g7h8i9', 'valor-quatro-' + 'j1k2l3'];
const HDR = 'Cookie';
const linhasComCookie = () => [
  `${HDR}: theme=dark; sessao=${V[0]}; outro=${V[1]}`,
  `set-${HDR.toLowerCase()}: a=b; Path=/; Secure; sessao=${V[2]}`,
  `curl -H '${HDR.toUpperCase()}: lang=pt; sid=${V[3]}' https://exemplo.test`,
];

test('limpa: Cookie e Set-Cookie saem inteiros, sem diferenciar maiúsculas, mesmo depois do primeiro ";"', () => {
  for (const l of linhasComCookie()) {
    const r = limpa(l);
    for (const v of V) assert.ok(!r.includes(v), `vazou ${v} em: ${r}`);
    assert.match(r, /oculto/);
  }
  assert.equal(limpa(`antes\n${HDR}: a=b; c=d\ndepois`), `antes\n${HDR}: [segredo oculto]\ndepois`, 'só até o fim da linha');
});

test('Cookie nos dois motores e na busca: nada vaza e procurar pelo valor não acha', async () => {
  const c = casa();
  const d = path.join(c.home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  const [l1, l2, l3] = linhasComCookie();
  fs.writeFileSync(path.join(d, `${U(2)}.jsonl`), jl([
    { type: 'user', timestamp: iso(1000), sessionId: U(2), message: { role: 'user', content: l1 } },
    { type: 'assistant', timestamp: iso(2000), sessionId: U(2), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: l3, description: l2 } }] } },
    { type: 'user', timestamp: iso(3000), sessionId: U(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: l2 }] } },
  ]));
  rollout(c, [
    ic(4000, { type: 'UserMessage', content: [{ type: 'text', text: l1 }] }),
    ic(5000, { type: 'CommandExecution', command: ['bash', '-lc', l3], exit_code: 0, status: 'completed', aggregated_output: l2 }),
  ]);
  const l = criarLeitor();
  const r = await l.eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 4);
  const texto = JSON.stringify(r);
  for (const v of V) assert.ok(!texto.includes(v), `vazou ${v}`);
  for (const v of V) assert.equal((await l.eventos(c.ag, { limite: 50, cursor: null, q: v })).eventos.length, 0, `a busca por ${v} não acha`);
  assert.ok((await l.eventos(c.ag, { limite: 50, cursor: null, q: 'segredo oculto' })).eventos.length > 0);
});

// ── formato do Codex ────────────────────────────────────────────────────────
test('Codex: primeiro registro de conversa depois da janela de 256 KB não faz o arquivo sumir', async () => {
  const c = casa();
  rollout(c, [
    { timestamp: iso(0), type: 'session_meta', payload: { id: U(1) } },
    ic(1000, { type: 'UserMessage', content: [{ type: 'text', text: 'a'.repeat(30) + ' ' + 'palavra '.repeat(37500) }] }),
    ic(2000, { type: 'CommandExecution', command: ['bash', '-lc', 'ls'], exit_code: 0, status: 'completed', aggregated_output: 'ok' }),
  ]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.deepEqual(r.eventos.map((e) => e.tipo), ['comando', 'mensagem']);
  assert.ok(!r.avisos.some((a) => a.tipo === 'formato_desconhecido'));
});

test('Codex: arquivo só com linhas desconhecidas continua avisando, e só no fim da leitura dele (também paginando)', async () => {
  const c = casa();
  const desconhecida = (i) => JSON.stringify({ timestamp: iso(i), type: 'turn_context', payload: { x: 'y'.repeat(900) } });
  rollout(c, null, jl(Array.from({ length: 4000 }, (_, i) => desconhecida(i))));
  const l = criarLeitor({ orcamento: { maxBytes: 1536 * 1024 } });
  const avisosPorPagina = [];
  let cursor = null;
  for (let i = 0; i < 30; i++) {
    const r = await l.eventos(c.ag, { limite: 50, cursor });
    avisosPorPagina.push(r.avisos.filter((a) => a.tipo === 'formato_desconhecido').length);
    assert.equal(r.eventos.length, 0);
    if (!r.proximo) break;
    cursor = decodificaCursor(r.proximo);
  }
  assert.ok(avisosPorPagina.length >= 3, 'o arquivo pediu mais de uma página');
  assert.deepEqual(avisosPorPagina.slice(0, -1).every((n) => n === 0), true, 'nenhum aviso antes do fim');
  assert.equal(avisosPorPagina[avisosPorPagina.length - 1], 1, 'o aviso sai uma vez, no fim');
});

test('Codex: arquivo vazio ou só com JSON quebrado não é "formato desconhecido"', async () => {
  const c = casa();
  rollout(c, null, '{ quebrado\n{ outro\n');
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.ok(!r.avisos.some((a) => a.tipo === 'formato_desconhecido'));
  assert.equal(r.contagens.linhas_ilegiveis, 2);
});

test('Codex: página que retoma um arquivo já reconhecido não declara formato desconhecido', async () => {
  const c = casa();
  const msg = (i) => ic(i * 10, { type: 'UserMessage', content: [{ type: 'text', text: `m${i}` }] });
  const lixo = (i) => JSON.stringify({ timestamp: iso(i), type: 'turn_context', payload: { x: 'y'.repeat(900) } });
  // o começo do arquivo (lido por último) tem registro de conversa; o fim só tem linhas desconhecidas
  rollout(c, null, jl([msg(1), ...Array.from({ length: 3000 }, (_, i) => lixo(100000 + i))]));
  const l = criarLeitor({ orcamento: { maxBytes: 1536 * 1024 } });
  let cursor = null;
  let eventos = 0;
  for (let i = 0; i < 30; i++) {
    const r = await l.eventos(c.ag, { limite: 50, cursor });
    eventos += r.eventos.length;
    assert.ok(!r.avisos.some((a) => a.tipo === 'formato_desconhecido'), `página ${i}`);
    if (!r.proximo) break;
    cursor = decodificaCursor(r.proximo);
  }
  assert.equal(eventos, 1);
});
