'use strict';
// Seção Logs: opções curtas agrupadas do curl e valores sensíveis que atravessam linhas (continuação com barra e aspas abertas).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpaCamadaAntiga: limpa } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-8888-4888-8888-888888888888`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const V1 = 'FICTICIO_9f3c2a7b1e';
const V2 = 'FICTICIO_LINHA2_77d0';
const V3 = 'FICTICIO_LINHA3_c41a';

const CURL = [
  `curl -sSu usuario_x:${V1} https://exemplo.test depois`,
  `curl -sSuusuario_x:${V1} https://exemplo.test depois`,
  `curl -uusuario_x:${V1} https://exemplo.test depois`,
  `curl -sS -fL -u usuario_x:${V1} https://exemplo.test depois`,
  `curl -sSU proxy_x:${V1} https://exemplo.test depois`,
  `curl -sSUproxy_x:${V1} https://exemplo.test depois`,
  `curl -sSu "usuario_x:${V1}" https://exemplo.test depois`,
  `curl -sSu"usuario_x:${V1}" https://exemplo.test depois`,
  `curl -H 'X-Teste: 1' -sSu usuario_x:${V1} https://exemplo.test depois`,
  `curl -sSb cookie_x=${V1} https://exemplo.test depois`,
  `curl -b cookie_x=${V1} https://exemplo.test depois`,
  `curl --cookie cookie_x=${V1} https://exemplo.test depois`,
  `curl --oauth2-bearer ${V1} https://exemplo.test depois`,
  `curl --oauth2-bearer=${V1} https://exemplo.test depois`,
  `curl "--user" "usuario_x:${V1}" https://exemplo.test depois`,
  `curl '--user' 'usuario_x:${V1}' https://exemplo.test depois`,
  `curl "-u" "usuario_x:${V1}" https://exemplo.test depois`,
  `curl -"u" usuario_x:${V1} https://exemplo.test depois`,
  `curl -"u"usuario_x:${V1} https://exemplo.test depois`,
  `curl "-sSu" usuario_x:${V1} https://exemplo.test depois`,
  `curl -s"S"u usuario_x:${V1} https://exemplo.test depois`,
  `curl --us"er" usuario_x:${V1} https://exemplo.test depois`,
  `curl --us"er"=usuario_x:${V1} https://exemplo.test depois`,
  `curl "--user=usuario_x:${V1}" https://exemplo.test depois`,
  `curl --pro"xy-us"er usuario_x:${V1} https://exemplo.test depois`,
  `"curl" -u usuario_x:${V1} https://exemplo.test depois`,
  `'curl' "-sSu" usuario_x:${V1} https://exemplo.test depois`,
  `c"ur"l -u usuario_x:${V1} https://exemplo.test depois`,
  `"curl" "--cookie" "cookie_x=${V1}" https://exemplo.test depois`,
  `"curl" "--oauth2-bearer" "${V1}" https://exemplo.test depois`,
  `"sshpass" "-p" ${V1} ssh host depois`,
  `sshpass -"p"${V1} ssh host depois`,
  `app "--password" ${V1} depois`,
  `app '--pass'word=${V1} depois`,
  `app --api"-key" ${V1} depois`,
  `app "--access-token=${V1}" depois`,
  `"mysql" -"p"${V1} db depois`,
];
// O cabeçalho Authorization esconde a linha inteira (regra antiga, de propósito): só confere que o valor some.
const AUTORIZACAO = `curl -sS -H 'Authorization: Bearer ${V1}' https://exemplo.test`;
const MULTI = [
  `export DB_PASSWORD=\\\n${V1} depois`,
  `export DB_PASSWORD=\\\r\n${V1} depois`,
  `export DB_PASSWORD="${V2}\n${V1}" depois`,
  `export DB_PASSWORD='${V2}\n${V1}\n${V3}' depois`,
  `X_TOKEN="${V2}\n${V3}\n${V1}"; echo depois`,
  `export X_TOKEN=${V2}\\\n${V3}\\\n${V1} depois`,
  `export X_API_KEY="${V2} \\"${V3}\n${V1}" depois`,
];
const TODOS_VALORES = [V1, V2, V3];

test('limpa: curl com opções curtas agrupadas mascara usuário e senha, e o resto da linha fica', () => {
  for (const c of CURL) {
    const r = limpa(c);
    assert.ok(!r.includes(V1), `sobrou o valor em: ${c} => ${r}`);
    assert.ok(!r.includes('usuario_x') && !r.includes('proxy_x'), `sobrou o usuário em: ${c} => ${r}`);
    assert.match(r, /depois$/, `perdeu o resto em: ${c} => ${r}`);
  }
  assert.ok(!limpa(AUTORIZACAO).includes(V1));
  assert.equal(limpa(`curl -sSu usuario_x:${V1} https://x`), 'curl -sSu [segredo oculto] https://x');
});

test('limpa: curl sem credencial continua legível', () => {
  for (const c of ['curl -sS https://x', 'curl -sSL -o saida.txt https://x', 'curl -sSX POST https://x', 'curl -sS -H "Accept: json" https://x', 'curl -sSf --max-time 5 https://x/-u/abc']) {
    assert.equal(limpa(c), c, c);
  }
});

test('limpa: valor sensível em várias linhas sai inteiro, com o resto do texto preservado', () => {
  for (const c of MULTI) {
    const r = limpa(c);
    for (const v of TODOS_VALORES) assert.ok(!r.includes(v), `sobrou ${v} em: ${JSON.stringify(c)} => ${JSON.stringify(r)}`);
    assert.match(r, /depois$/, `perdeu o resto em: ${JSON.stringify(c)} => ${JSON.stringify(r)}`);
  }
  assert.equal(limpa(`export DB_PASSWORD=\\\n${V1}\nsegue`), 'export DB_PASSWORD=[segredo oculto]\nsegue');
  assert.equal(limpa('X_TOKEN=it\'s fine\nlinha2'), 'X_TOKEN=[segredo oculto]\nlinha2');
});

test('resposta e busca nos dois motores: nada vaza e procurar pelo valor não acha', async () => {
  const todos = [...CURL, AUTORIZACAO, ...MULTI];
  const home = pastaTemp('logs-mascara-agrupada');
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
  const json = JSON.stringify(r);
  for (const v of TODOS_VALORES) assert.ok(!json.includes(v), `a resposta carrega ${v}`);
  for (const q of [V1, V2, V3, 'FICTICIO_9f3c']) assert.equal((await l.eventos(ag, { limite: 200, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
});
