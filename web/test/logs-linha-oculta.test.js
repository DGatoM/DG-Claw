'use strict';
// Seção Logs: linha de saída que repete comando com credencial (set -x) sai oculta, na resposta e na busca, nos dois motores.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpa } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-7777-4777-8777-777777777777`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const S = 'EXPOSTO987';
const SAIDA = `# pass 12\ntotal 4\n+ curl --output --password -u alice:${S} https://example.invalid\nfim`;

test('limpa: só a linha com programa e marcador some', () => {
  const r = limpa(SAIDA);
  assert.equal(r, '# pass 12\ntotal 4\n[linha oculta: pode levar credencial]\nfim');
});

test('resposta e busca nos dois motores', async () => {
  const home = pastaTemp('logs-linha');
  const ag = { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' };
  const cmd = `set -x; curl --output --password -u alice:${S} https://example.invalid`;
  const d = path.join(home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), [
    { type: 'assistant', timestamp: iso(1000), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: cmd } }] } },
    { type: 'user', timestamp: iso(1100), sessionId: U(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: SAIDA }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const cx = path.join(home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), JSON.stringify({ timestamp: iso(5000), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', cmd], exit_code: 0, status: 'completed', aggregated_output: SAIDA } } }) + '\n');
  const l = criarLeitor();
  const r = await l.eventos(ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 2);
  const json = JSON.stringify(r);
  for (const x of [S, 'alice', 'example.invalid']) assert.ok(!json.includes(x), `vazou ${x}`);
  for (const e of r.eventos) assert.match(e.resultado.texto, /^# pass 12\ntotal 4\n\[linha oculta/);
  for (const q of [S, 'alice:']) assert.equal((await l.eventos(ag, { limite: 50, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
  assert.equal((await l.eventos(ag, { limite: 50, cursor: null, q: 'total 4' })).eventos.length, 2);
});
