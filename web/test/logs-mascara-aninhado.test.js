'use strict';
// Seção Logs: comando dentro de substituição de comando, campo `auth` em JSON e senha cortada no limite de 64 KB.
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

const ANINHADOS = [
  `curl --data "$(curl -u usuario:${S} https://interno.test)" https://externo.test`,
  `curl --data $(curl -u usuario:${S} https://interno.test) https://externo.test`,
  `curl --data \`curl -u usuario:${S} https://interno.test\` https://externo.test`,
  `curl --data "$(echo "$(curl -u usuario:${S} https://interno.test)")" https://externo.test`,
  `curl -H "x: $(sshpass -p ${S} ssh host)" https://externo.test`,
  `curl --data "$(echo "$(echo "$(echo "$(curl -u usuario:${S} https://interno.test)")")")" https://externo.test`,
];
const CORTADA = `app --password "primeira linha\n${S} segunda linha ` + 'palavra '.repeat(10000) + '" fim';

test('limpa: comando aninhado, senha cortada no limite', () => {
  for (const c of ANINHADOS) assert.ok(!limpa(c).includes(S), `sobrou em: ${c} => ${limpa(c)}`);
  assert.match(limpa(ANINHADOS[0]), /https:\/\/externo\.test$/);
  assert.ok(!limpa(CORTADA).includes(S));
  assert.ok(!limpa(CORTADA).includes('segunda linha'));
});

const ESTRUTURAS = [{ config: JSON.stringify({ auth: S }) }, { auth: S }, { x: { auth: S } }];

test('resposta e busca nos dois motores', async () => {
  const home = pastaTemp('logs-aninhado');
  const ag = { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' };
  const cmds = [...ANINHADOS, CORTADA];
  const d = path.join(home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  const linhasC = [
    ...cmds.map((t) => ({ name: 'Bash', input: { command: t } })),
    ...ESTRUTURAS.map((e) => ({ name: 'Ferramenta', input: e })),
  ].map((b, i) => JSON.stringify({ type: 'assistant', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, ...b }] } }));
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), linhasC.join('\n') + '\n');
  const cx = path.join(home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  const linhasX = [
    ...cmds.map((t) => ({ type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', t], exit_code: 0, status: 'completed', aggregated_output: '' } })),
    ...ESTRUTURAS.map((e, i) => ({ type: 'response_item', _ri: true, p: { type: 'function_call', name: 'ferramenta', call_id: `c${i}`, arguments: JSON.stringify(e) } })),
  ].map((x, i) => JSON.stringify(x._ri
    ? { timestamp: iso(5000 + i), type: 'response_item', payload: x.p }
    : { timestamp: iso(5000 + i), type: 'event_msg', payload: x }));
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), linhasX.join('\n') + '\n');
  const l = criarLeitor();
  const r = await l.eventos(ag, { limite: 200, cursor: null });
  assert.equal(r.eventos.length, (cmds.length + ESTRUTURAS.length) * 2);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'), 'resposta vazou');
  for (const q of [S, 'ALHEIO', 'segunda linha']) assert.equal((await l.eventos(ag, { limite: 200, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
});
