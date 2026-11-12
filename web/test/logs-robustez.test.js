'use strict';
// Seção Logs: registro malformado não vira 500 nem vaza descritor; descoberta lenta não trava a paginação.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, pastaTemp } = require('./ajuda');
const { criarLeitor, decodificaCursor } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (n) => new Date(BASE_T + n * 1000).toISOString();
const jl = (ls) => ls.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
const casa = () => {
  const home = pastaTemp('logs-rob');
  return { home, ag: { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' } };
};
const projetos = (c) => { const d = path.join(c.home, '.claude', 'projects', '-ws'); fs.mkdirSync(d, { recursive: true }); return d; };
const fds = () => fs.readdirSync('/proc/self/fd').length;
const cUser = (n, texto) => ({ type: 'user', timestamp: iso(n), sessionId: U(1), message: { role: 'user', content: texto } });
const cUso = (n, id, name, input) => ({ type: 'assistant', timestamp: iso(n), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });

const HOSTIL = '{"toString":null}';   // JSON válido: vira objeto com toString nulo, que quebraria uma conversão para texto

test('registro com campos de tipo hostil: evento sai (ou a linha é contada), sem 500 e sem vazar descritor', async () => {
  const c = casa();
  const d = projetos(c);
  const hostil = JSON.parse(HOSTIL);
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), jl([
    cUser(1, 'normal'),
    cUso(2, 'a', 'Read', { file_path: hostil }),
    cUso(3, 'b', 'Bash', { command: hostil, description: hostil }),
    cUso(4, 'c', 'Write', { file_path: [hostil], notebook_path: hostil, path: 7 }),
    { type: 'assistant', timestamp: iso(5), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'd', name: 'x', input: hostil }, { type: hostil, text: hostil }, { type: 'text', text: hostil }] } },
    { type: 'user', timestamp: iso(6), sessionId: U(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [hostil, { type: hostil }], is_error: hostil }] } },
    { type: hostil, timestamp: hostil, message: hostil },
  ]));
  const cx = path.join(c.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  const item = (n, i) => ({ timestamp: iso(n), type: 'event_msg', payload: { type: 'item_completed', item: i } });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), jl([
    item(1, { type: 'CommandExecution', command: [hostil, hostil, hostil], exit_code: hostil, aggregated_output: hostil }),
    item(2, { type: 'CommandExecution', command: ['bash', hostil, hostil] }),
    item(3, { type: 'McpToolCall', server: hostil, tool: hostil, arguments: hostil, status: hostil, result: { content: [hostil] } }),
    item(4, { type: 'FileChange', path: hostil, changes: [hostil] }),
    item(5, { type: 'UserMessage', content: [hostil, { text: hostil }] }),
  ]));
  const l = criarLeitor();
  const antes = fds();
  for (let i = 0; i < 30; i++) {
    const r = await l.eventos(c.ag, { limite: 50, cursor: null });
    assert.ok(r.eventos.some((e) => e.texto === 'normal'));
  }
  assert.ok(fds() <= antes + 1, `descritores: ${antes} antes, ${fds()} depois`);
});

test('servidor: registro hostil responde 200, não 500', async () => {
  const c = casa();
  const d = projetos(c);
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), jl([cUser(1, 'normal'), cUso(2, 'a', 'Read', { file_path: JSON.parse(HOSTIL) })]));
  const t = await subirWeb({ agentes: [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'a1', provedor: 'claude', home_host: c.home }] });
  try {
    await t.login();
    const antes = fds();
    for (let i = 0; i < 30; i++) {
      const r = await t.c.get('/api/v1/logs/agentes/ana/eventos');
      assert.equal(r.status, 200, r.texto);
    }
    assert.ok(fds() <= antes + 2, `descritores: ${antes} antes, ${fds()} depois`);
  } finally { await t.fechar(); }
});

test('falha no meio da leitura fecha todos os arquivos abertos (try/finally)', async () => {
  const c = casa();
  const d = projetos(c);
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(d, `${U(i)}.jsonl`), jl(Array.from({ length: 20 }, (_, k) => cUser(k + 1, `m${i}-${k}`))), { mtime: new Date(BASE_T) });
  let chamadas = 0;
  let quebra = false;
  const l = criarLeitor({ agora: () => { if (quebra && ++chamadas > 25) throw new Error('relógio quebrou'); return Date.now(); } });
  const antes = fds();
  for (let i = 0; i < 30; i++) {
    chamadas = 0; quebra = true;
    await assert.rejects(l.eventos(c.ag, { limite: 100, cursor: null }), /relógio quebrou/);
  }
  quebra = false;
  assert.ok(fds() <= antes + 1, `descritores: ${antes} antes, ${fds()} depois`);
  assert.equal((await l.eventos(c.ag, { limite: 200, cursor: null })).eventos.length, 120);
});

// ── prazo da leitura depois da descoberta ───────────────────────────────────
function montaDois(c) {
  const d = projetos(c);
  for (const [n, off] of [[1, 0], [2, 1]]) {
    fs.writeFileSync(path.join(d, `${U(n)}.jsonl`), jl(Array.from({ length: 10 }, (_, k) => cUser(k * 2 + off + 1, `m${n}-${k}`))), { mtime: new Date(BASE_T + 100000) });
  }
}

test('descoberta lenta ainda rende eventos, e paginar até o fim termina sem repetir cursor', async () => {
  const c = casa();
  montaDois(c);
  let t = 0;
  const l = criarLeitor({ agora: () => t, orcamento: { aposDescoberta: () => { t += 5000; }, maxMs: 1500 } });
  const vistos = new Set();
  const cursores = new Set();
  let cursor = null;
  let paginas = 0;
  for (; paginas < 40; paginas++) {
    const r = await l.eventos(c.ag, { limite: 3, cursor });
    assert.ok(r.eventos.length > 0, `a página ${paginas} veio sem eventos`);
    for (const e of r.eventos) { assert.ok(!vistos.has(e.id), 'evento repetido'); vistos.add(e.id); }
    if (!r.proximo) break;
    assert.ok(!cursores.has(r.proximo), 'cursor repetido');
    cursores.add(r.proximo);
    cursor = decodificaCursor(r.proximo);
  }
  assert.equal(vistos.size, 20);
  assert.ok(paginas < 39);
});

test('descoberta parcial por teto: a leitura usa o que foi descoberto e mantém o aviso', async () => {
  const c = casa();
  montaDois(c);
  const l = criarLeitor({ orcamento: { maxEntradas: 2 } });
  const r = await l.eventos(c.ag, { limite: 50, cursor: null });
  assert.ok(r.eventos.length > 0);
  assert.equal(r.fontes.find((f) => f.motor === 'claude').estado, 'parcial');
  assert.ok(r.avisos.some((a) => a.tipo === 'limite'));
});

test('parcial sem progresso: sem "proximo", com o aviso "sem_progresso" explicando a causa e o que fazer', async () => {
  const c = casa();
  montaDois(c);
  const l = criarLeitor({ orcamento: { maxBytes: 1 } });
  const r = await l.eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 0);
  assert.equal(r.proximo, null);
  assert.equal(r.parcial, true);
  const a = r.avisos.find((x) => x.tipo === 'sem_progresso');
  assert.ok(a, JSON.stringify(r.avisos));
  assert.match(a.motivo, /não conseguiu avançar/);
  assert.match(a.motivo, /Estreite o período/);
});

test('parcial com progresso continua devolvendo "proximo" diferente do recebido', async () => {
  const c = casa();
  const d = projetos(c);
  const enchimento = JSON.stringify({ type: 'attachment', timestamp: iso(0), sessionId: U(1), attachment: { t: 'x'.repeat(1000) } });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), jl([cUser(1, 'agulha'), ...Array.from({ length: 6000 }, () => enchimento), cUser(9000, 'topo')]));
  const l = criarLeitor({ orcamento: { maxBytes: 1536 * 1024 } });
  const r1 = await l.eventos(c.ag, { limite: 50, cursor: null, q: 'agulha' });
  assert.equal(r1.parcial, true);
  assert.ok(r1.proximo);
  const r2 = await l.eventos(c.ag, { limite: 50, cursor: decodificaCursor(r1.proximo), q: 'agulha' });
  assert.notEqual(r2.proximo, r1.proximo);
});
