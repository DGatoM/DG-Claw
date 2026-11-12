'use strict';
// Seção Logs: o tokenizador de comandos de shell (curl, sshpass, mysql, htpasswd) que oculta usuário e senha na linha.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpaCamadaAntiga: limpa, mascaraComandos } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-8888-4888-8888-888888888888`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const S1 = 'UMSUFIXO' + 'ALHEIO' + '1';
const S2 = 'DOISSUFIXO' + 'ALHEIO' + '2';
const O = '[segredo oculto]';

test('mascaraComandos: duas flags no mesmo comando, e o resto fica byte a byte', () => {
  assert.equal(mascaraComandos(`curl -u a:${S1} -U p:${S2} https://x/y?z=1`), `curl -u ${O} -U ${O} https://x/y?z=1`);
  assert.equal(mascaraComandos(`curl --user a:${S1} --proxy-user=p:${S2} -sS  https://x`), `curl --user ${O} --proxy-user=${O} -sS  https://x`);
  assert.equal(mascaraComandos(`curl -ua:${S1} -Up:${S2}`), `curl -u${O} -U${O}`);
});

test('mascaraComandos: duas chamadas de curl na mesma linha, por ; && || | e &', () => {
  for (const sep of [';', ' &&', ' ||', ' |', ' &']) {
    const r = mascaraComandos(`curl -u a:${S1} https://x${sep} curl --user b:${S2} https://y fim`);
    assert.ok(!r.includes(S1) && !r.includes(S2), `${sep}: ${r}`);
    assert.ok(r.endsWith('https://y fim'));
  }
  const r = mascaraComandos(`sshpass -p ${S1} curl -u a:${S2} https://x fim`);
  assert.equal(r, `sshpass -p ${O} curl -u ${O} https://x fim`);
});

test('mascaraComandos: o próximo comando depois de ; && || | & colados, sem espaços, também é analisado', () => {
  for (const sep of [';', '&&', '||', '|', '&', ';;', '; ', ' ; ']) {
    const r = mascaraComandos(`curl x -u a:${S1}${sep}curl y -u b:${S2} fim`);
    assert.equal(r, `curl x -u ${O}${sep}curl y -u ${O} fim`, sep);
  }
  assert.equal(mascaraComandos(`curl -u a:${S1};ls -u keep;curl --user b:${S2}`), `curl -u ${O};ls -u keep;curl --user ${O}`);
  assert.equal(mascaraComandos(`echo ok&&curl -U p:${S1}||sshpass -p ${S2}|cat`), `echo ok&&curl -U ${O}||sshpass -p ${O}|cat`);
});

test('mascaraComandos: continuação de linha entre o curl e a flag, com LF, CRLF e no meio do argumento', () => {
  const lf = mascaraComandos(`curl https://x \\\n  -H 'a: b' \\\n  -u user:${S1} \\\n  -d dados\ndepois`);
  assert.equal(lf, `curl https://x \\\n  -H 'a: b' \\\n  -u ${O} \\\n  -d dados\ndepois`);
  const crlf = mascaraComandos(`curl https://x \\\r\n  -u user:${S1} \\\r\n  -d x`);
  assert.ok(!crlf.includes(S1));
  assert.ok(crlf.includes('\\\r\n  -d x'));
  assert.ok(!mascaraComandos(`curl -u us\\\ner:${S1} https://x`).includes(S1), 'quebra escapada no meio do argumento');
  assert.ok(!mascaraComandos(`curl \\\n-u \\\n${S1} https://x`).includes(S1), 'quebra escapada entre a flag e o valor');
});

test('mascaraComandos: flag depois de mais de 300 caracteres (e de uma quebra de linha fora de aspas termina o comando)', () => {
  const longe = `curl ${'argumento '.repeat(200)}-u user:${S1} https://x fim`;
  const r = mascaraComandos(longe);
  assert.ok(!r.includes(S1));
  assert.ok(r.endsWith('https://x fim'));
  assert.equal(mascaraComandos(`curl https://x\n-u user:${S1}`), `curl https://x\n-u user:${S1}`, 'depois da quebra o comando acabou: não é flag do curl');
  const corpo = mascaraComandos(`curl -d '{"a":\n1}' -H "x: y\nz" -u u:${S1} https://x`);
  assert.ok(!corpo.includes(S1), 'aspas que atravessam linhas');
});

test('mascaraComandos: as mesmas flags em outros programas não são tocadas', () => {
  for (const c of ['ls -u a:b', 'grep -u foo bar', 'tar -U x', 'git log --user alice', 'ls -u; curl https://x; ls -u keep', 'echo curl; ls -u keep', 'curl --user-agent Mozilla https://x',
    'curl https://x -sS -d u', 'docker run --user 1000 img', 'mycurl -u a:b', 'curl-config -u a:b']) {
    assert.equal(mascaraComandos(c), c, c);
  }
});

test('mascaraComandos: aspas, escapes e `;` colado no valor', () => {
  assert.equal(mascaraComandos(`curl -u "a b":'c d'${S1} https://x fim`), `curl -u ${O} https://x fim`);
  assert.equal(mascaraComandos(`curl -u a:b\\ c${S1} https://x fim`), `curl -u ${O} https://x fim`);
  assert.equal(mascaraComandos(`curl -u "u:p\\"${S1}" https://x fim`), `curl -u ${O} https://x fim`);
  // regra do shell: `;` `&` `|` fora de aspas terminam o argumento e o comando
  assert.equal(mascaraComandos(`curl -u user:pa;${S1}`), `curl -u ${O};${S1}`);
  assert.equal(mascaraComandos(`curl -u 'user:pa;x&y|z'${S1} fim`), `curl -u ${O} fim`, 'entre aspas fazem parte do valor');
  assert.ok(!mascaraComandos(`curl -u "sem fechamento ${S1}\nlinha dois`).includes(S1));
  assert.ok(mascaraComandos(`curl -u "sem fechamento ${S1}\nlinha dois`).endsWith('linha dois'));
  assert.equal(mascaraComandos(`curl -u`), 'curl -u');
  assert.equal(mascaraComandos(`curl -u ; ls`), 'curl -u ; ls');
});

test('mascaraComandos: mysql, sshpass e htpasswd', () => {
  assert.equal(mascaraComandos(`mysql -u root -p${S1} db`), `mysql -u root -p${O} db`);
  assert.equal(mascaraComandos(`mysql -u root -p db`), 'mysql -u root -p db', 'com espaço o -p só pede a senha');
  assert.equal(mascaraComandos(`sshpass -p ${S1} ssh h`), `sshpass -p ${O} ssh h`);
  assert.equal(mascaraComandos(`sshpass -p${S1} ssh h`), `sshpass -p${O} ssh h`);
  assert.equal(mascaraComandos(`htpasswd -b arq usr ${S1} fim`), `htpasswd -b ${O} fim`);
  assert.equal(mascaraComandos(`htpasswd -c -b arq usr ${S1} fim`), `htpasswd -c -b ${O} fim`);
  assert.equal(mascaraComandos(`htpasswd -nb usr ${S1} fim`), `htpasswd -nb ${O} fim`);
  assert.equal(mascaraComandos(`htpasswd arq usr senha`), 'htpasswd arq usr senha');
});

const HOSTIS = ['--password \\\n', '--password=\\\r\n', '--token "\n', "--secret '\n", ';curl -u a:', '&&curl --user=', '||curl -u', '--password --password ', 'curl ', 'curl -u ', 'curl "\\"', "curl '", 'curl "a" -u ', 'curl \\\n', 'curl x \\\r\n', 'curl -u "', "curl --user '", 'curl --user=', 'sshpass -p ', 'htpasswd -b ', 'htpasswd -nb a ', 'mysql -p', 'curl ;', 'curl &', 'curl |', 'curl -u a;', 'curl\\', '\\\n', '"\\', "'", 'curl -u ' + 'x'.repeat(100) + ' '];

test('mascaraComandos: entradas hostis de 64 KB ficam abaixo de 200 ms', () => {
  const N = 64 * 1024;
  for (const h of HOSTIS) {
    for (const t of [h.repeat(Math.ceil(N / h.length)).slice(0, N), h + 'x'.repeat(N - h.length), (h + 'a ').repeat(Math.ceil(N / (h.length + 2))).slice(0, N), 'x '.repeat(N / 4) + h.repeat(2000)]) {
      const ini = process.hrtime.bigint();
      mascaraComandos(t);
      limpa(t);
      const ms = Number(process.hrtime.bigint() - ini) / 1e6;
      assert.ok(ms < 200, `${JSON.stringify(h.slice(0, 20))}: ${ms.toFixed(0)} ms`);
    }
  }
});

test('resposta e busca nos dois motores', async () => {
  const casos = [
    `curl -u a:${S1} -U p:${S2} https://x fim`,
    `curl -u a:${S1} https://x; curl --user b:${S2} https://y fim`,
    `curl https://x \\\n  -u user:${S1} \\\n  -d x fim`,
    `curl ${'argumento '.repeat(200)}-u user:${S2} https://x fim`,
    `sshpass -p ${S1} curl --proxy-user=p:${S2} https://x fim`,
  ];
  const home = pastaTemp('logs-cmd');
  const ag = { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' };
  const d = path.join(home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), casos.map((t, i) => JSON.stringify({ type: 'assistant', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: t } }] } })).join('\n') + '\n');
  const cx = path.join(home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), casos.map((t, i) => JSON.stringify({ timestamp: iso(5000 + i), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', t], exit_code: 0, status: 'completed', aggregated_output: '' } } })).join('\n') + '\n');
  const l = criarLeitor();
  const r = await l.eventos(ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, casos.length * 2);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));
  for (const q of [S1, S2, 'ALHEIO']) assert.equal((await l.eventos(ag, { limite: 50, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
});

// ── flags longas de segredo em qualquer comando, com valor em várias linhas ──
const LONGAS = [
  `app --password \\\n${S1} fim`,
  `app --password \\\r\n${S1} fim`,
  `app --password=\\\n${S1} fim`,
  `app --token \\\n  \\\n  ${S1} fim`,
  `app --secret "linha um\n${S1} linha tres" fim`,
  `app --api-key 'linha um\r\n${S1}' fim`,
  `app --client-secret=um"dois\n${S1}"tres fim`,
  `app --passphrase \\\n"a b\n${S1}" fim`,
  `app --pass ${S1} fim`,
  `app --auth=${S1} fim`,
  `outro --apikey ${S1} fim`,
];

test('flag longa de segredo em qualquer comando: valor em várias linhas sai inteiro, com LF e CRLF, e o resto fica', () => {
  for (const c of LONGAS) {
    const r = mascaraComandos(c);
    assert.ok(!r.includes(S1), `sobrou o sufixo em: ${JSON.stringify(c)} => ${JSON.stringify(r)}`);
    assert.ok(r.endsWith(' fim'), JSON.stringify(r));
  }
  assert.equal(mascaraComandos(`app --password \\\n${S1} fim`), `app --password \\\n${O} fim`);
  assert.equal(mascaraComandos(`app --password=\\\n${S1} fim`), `app --password=${O} fim`);
  assert.equal(mascaraComandos(`app --token 'a\nb' x; app --secret y`), `app --token ${O} x; app --secret ${O}`);
  assert.equal(mascaraComandos('app --password "sem fechamento\nlinha dois'), `app --password ${O}\nlinha dois`, 'sem fechamento: até o fim da linha');
  for (const c of ['app --author fulano', 'app --user-name ana', 'app --password-stdin']) assert.equal(mascaraComandos(c), c, c);
});

test('flag longa de segredo: resposta e busca nos dois motores', async () => {
  const home = pastaTemp('logs-longas');
  const ag = { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'claude', home_host: home, home_container: '/home/agente' };
  const d = path.join(home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), LONGAS.map((t, i) => JSON.stringify({ type: 'user', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'user', content: t } })).join('\n') + '\n');
  const cx = path.join(home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(cx, { recursive: true });
  fs.writeFileSync(path.join(cx, `rollout-x-${U(2)}.jsonl`), LONGAS.map((t, i) => JSON.stringify({ timestamp: iso(5000 + i), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: t }] } } })).join('\n') + '\n');
  const l = criarLeitor();
  const r = await l.eventos(ag, { limite: 100, cursor: null });
  assert.equal(r.eventos.length, LONGAS.length * 2);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));
  for (const q of [S1, 'ALHEIO']) assert.equal((await l.eventos(ag, { limite: 100, cursor: null, q })).eventos.length, 0, `a busca por ${q} não acha`);
});
