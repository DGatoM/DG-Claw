'use strict';
// Seção Logs: o valor de uma opção (`-o mysql`, `--output sshpass`) não troca o comando reconhecido e a credencial seguinte é mascarada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpaCamadaAntiga: limpa } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-7777-4777-8777-777777777777`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const S = 'SEGREDO' + 'ALHEIO' + '987';
const CASOS = [
  `curl -o mysql -u alice:${S} https://x`,
  `curl --output sshpass --user alice:${S} https://x`,
  `curl -o htpasswd -u alice:${S} https://x`,
];

test('limpa: valor de opção com nome de comando não troca o comando', () => {
  for (const c of CASOS) {
    const r = limpa(c);
    assert.ok(!r.includes(S), `sobrou o segredo em: ${c} => ${r}`);
    assert.match(r, / https:\/\/x$/, r);
  }
  assert.equal(limpa(`sshpass -p ${S} curl -u alice:${S} https://x`).includes(S), false);
});

test('resposta e busca nos dois motores: o segredo não aparece', async () => {
  const home = pastaTemp('logs-valor-opcao');
  const ag = { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' };
  const d = path.join(home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), CASOS.map((t, i) => JSON.stringify({ type: 'assistant', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: t } }] } })).join('\n') + '\n');
  const cx = path.join(home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), CASOS.map((t, i) => JSON.stringify({ timestamp: iso(5000 + i), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', t], exit_code: 0, status: 'completed', aggregated_output: '' } } })).join('\n') + '\n');
  const l = criarLeitor();
  const r = await l.eventos(ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, CASOS.length * 2);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));
  for (const q of [S, 'ALHEIO']) assert.equal((await l.eventos(ag, { limite: 50, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
});
