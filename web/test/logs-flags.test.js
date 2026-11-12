'use strict';
// Seção Logs: as formas equivalentes de flags de usuário e senha (curl, sshpass, htpasswd e flags longas de segredo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpaCamadaAntiga: limpa } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-7777-4777-8777-777777777777`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const SUF = 'SUFIXO' + 'ALHEIO' + '321';

const COMUNS = [
  `curl --user=alice:${SUF} https://x depois`,
  `curl -ualice:${SUF} https://x depois`,
  `curl -u alice:${SUF} https://x depois`,
  `curl --user alice:${SUF} https://x depois`,
  `curl https://x --user 'alice:${SUF}' depois`,
  `curl --proxy-user=p:${SUF} https://x depois`,
  `curl --proxy-user p:${SUF} https://x depois`,
  `curl -U p:${SUF} https://x depois`,
  `curl -Up:${SUF} https://x depois`,
  `curl -u "alice":${SUF} depois`,
  `app --password valor${SUF} depois`,
  `app --password=valor${SUF} depois`,
  `app --pass=${SUF} depois`,
  `app --passwd ${SUF} depois`,
  `app --pwd=${SUF} depois`,
  `app --api_key=${SUF} depois`,
  `app --api-key ${SUF} depois`,
  `app --apikey ${SUF} depois`,
  `app --auth ${SUF} depois`,
  `app --access-token=${SUF} depois`,
  `app --client-secret ${SUF} depois`,
  `app --passphrase "a b"${SUF} depois`,
  `sshpass -p ${SUF} ssh host depois`,
  `sshpass -p${SUF} ssh host depois`,
  `sshpass -p "a b"${SUF} ssh host depois`,
  `mysqladmin -u root -p${SUF} status depois`,
];
const HTPASSWD = [
  `htpasswd -b arquivo usuario ${SUF}`,
  `htpasswd -nb usuario ${SUF}`,
  `htpasswd -bc arquivo usuario ${SUF}`,
  `htpasswd -c -b arquivo usuario ${SUF}`,
  `htpasswd -bn usuario ${SUF}`,
];

test('limpa: todas as formas de flag de usuário e senha saem inteiras e o resto da linha fica', () => {
  for (const c of COMUNS) {
    const r = limpa(c);
    assert.ok(!r.includes(SUF), `sobrou o sufixo em: ${c} => ${r}`);
    assert.match(r, /depois$/, `perdeu o resto em: ${c} => ${r}`);
  }
  for (const c of HTPASSWD) assert.ok(!limpa(c).includes(SUF), `sobrou o sufixo em: ${c}`);
  assert.equal(limpa(`htpasswd -b arq usr ${SUF} depois`), 'htpasswd -b [segredo oculto] depois');
  assert.equal(limpa(`htpasswd -nb usr ${SUF} depois`), 'htpasswd -nb [segredo oculto] depois');
});

test('limpa: o que não é segredo continua legível', () => {
  for (const c of ['curl --user-agent Mozilla https://x', 'git commit --author Fulano', 'app --user-name=ana', 'curl https://x/-u/abc', 'htpasswd arquivo usuario', 'mysql -u root db', 'sshpass -e ssh host']) {
    assert.equal(limpa(c), c, c);
  }
});

test('resposta e busca nos dois motores: nenhuma forma vaza e procurar pelo sufixo não acha', async () => {
  const todos = [...COMUNS, ...HTPASSWD];
  const home = pastaTemp('logs-flags');
  const ag = { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' };
  const d = path.join(home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), todos.map((t, i) => JSON.stringify({ type: 'assistant', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: t } }] } })).join('\n') + '\n');
  const cx = path.join(home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), todos.map((t, i) => JSON.stringify({ timestamp: iso(5000 + i), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', t], exit_code: 0, status: 'completed', aggregated_output: '' } } })).join('\n') + '\n');
  const l = criarLeitor();
  const r = await l.eventos(ag, { limite: 200, cursor: null });
  assert.equal(r.eventos.length, todos.length * 2);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));
  for (const q of [SUF, 'ALHEIO']) assert.equal((await l.eventos(ag, { limite: 200, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
});
