'use strict';
// Seção Logs: comando que pode levar credencial sai só com o nome do programa, na resposta e na busca, nos dois motores.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, comandoExibivel } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-7777-4777-8777-777777777777`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const AVISO = ' [argumentos ocultos: comando que pode levar credencial]';
const S = 'EXPOSTO987';
const ABERTOS = [
  `curl --output --password -u alice:${S} https://x`,
  `curl -H "$(curl -u 'alice:prefixo)${S} cauda' https://x)" https://x`,
  `curl --data "$(curl -u usuario:${S} https://interno.test)" https://externo.test`,
  `curl --data \`curl -u usuario:${S} https://interno.test\` https://externo.test`,
  `mysql -u root -p${S} db`,
  `sshpass -p ${S} ssh host`,
  `/usr/bin/git clone https://u:${S}@host/r.git`,
  `X=1 echo ${S} --token`,
];

test('comandoExibivel: só o programa; comando inofensivo passa inteiro', () => {
  assert.equal(comandoExibivel(ABERTOS[0]), 'curl' + AVISO);
  assert.equal(comandoExibivel(ABERTOS[6]), 'git' + AVISO);
  assert.equal(comandoExibivel(ABERTOS[7]), 'comando' + AVISO);
  assert.equal(comandoExibivel('ls -la /tmp'), 'ls -la /tmp');
});

test('resposta e busca nos dois motores', async () => {
  const home = pastaTemp('logs-oculto');
  const ag = { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' };
  const todos = [...ABERTOS, 'ls -la /tmp'];
  const d = path.join(home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), todos.map((t, i) => JSON.stringify({ type: 'assistant', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: t, description: t } }] } })).join('\n') + '\n');
  const cx = path.join(home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), todos.map((t, i) => JSON.stringify({ timestamp: iso(5000 + i), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', t], exit_code: 0, status: 'completed', aggregated_output: '' } } })).join('\n') + '\n');
  const l = criarLeitor();
  const r = await l.eventos(ag, { limite: 200, cursor: null });
  assert.equal(r.eventos.length, todos.length * 2);
  const json = JSON.stringify(r);
  for (const x of [S, 'prefixo', 'cauda', 'alice', 'usuario', 'interno.test']) assert.ok(!json.includes(x), `resposta vazou ${x}`);
  assert.equal(r.eventos.filter((e) => e.detalhes.comando === 'ls -la /tmp').length, 2, 'o inofensivo aparece inteiro');
  assert.ok(r.eventos.some((e) => e.detalhes.comando === 'curl' + AVISO));
  for (const q of [S, 'prefixo', 'cauda', 'alice:', 'interno.test', 'externo.test', '--output']) assert.equal((await l.eventos(ag, { limite: 200, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
  assert.equal((await l.eventos(ag, { limite: 200, cursor: null, q: 'ls -la /tmp' })).eventos.length, 2);
});
