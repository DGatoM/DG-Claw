'use strict';
// Diagnóstico: runner que nunca termina de responder (fragmentos sem fim) não prende a coleta, e nenhum
// prompt_sugerido manda o Admin ler conteúdo escrito pelo container.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { criarDiagnostico } = require('../lib/diagnostico');
const { criarRunner } = require('../lib/runner');
const U = require('../lib/diagnostico/util');

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = (url) => ({ slug: 'admin', nome: 'Admin', tipo: 'admin', runner: url, agente_id: 'admin', home_host: '/nao/existe' });

function deps(agentes, runner, extra) {
  return Object.assign({
    config: { tz: 'America/Sao_Paulo', agentesPath: '/nao/existe/agentes.json', dataDir: '/nao/existe' },
    registro: { estado: () => ({ ok: true, erro: null, agentes }) },
    runner,
    log: () => {},
    exec: async () => ({ codigo: 1, stdout: '', stderr: 'não previsto' }),
    statfs: async () => ({ bsize: 4096, blocks: 1000000, bfree: 500000, bavail: 500000 }),
    meminfo: async () => 'MemTotal: 8000000 kB\nMemAvailable: 6000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
    uptime: () => 864000,
    procVivo: () => true,
    lerEnv: () => ({ vars: {}, erro: null }),
    atualizacao: { lerEstado: () => ({ estado: null }) },
    limiteMs: 300, prazoColetaMs: 600, gracaMs: 100,
  }, extra || {});
}

function servidorSemFim() {
  const estado = { pedidos: 0, fechadas: 0, timers: [] };
  const srv = http.createServer((req, res) => {
    estado.pedidos += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const t = setInterval(() => { try { res.write(' '); } catch (_) { /* conexão já caiu */ } }, 20); // sempre ativo: o timeout de inatividade nunca dispara
    estado.timers.push(t);
    res.on('close', () => { estado.fechadas += 1; clearInterval(t); });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, estado, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('runner que manda fragmentos sem parar: a conexão é derrubada no prazo e uma coleta nova acontece', async () => {
  const { srv, estado, url } = await servidorSemFim();
  const runner = criarRunner({ log: () => {}, timeoutMs: 60000 });
  const diag = criarDiagnostico(deps([ADMIN(url)], runner));
  try {
    const ini = Date.now();
    const r1 = await diag.coletar();
    assert.ok(Date.now() - ini < 1500, `a coleta levou ${Date.now() - ini} ms`);
    assert.equal(r1.ok, true);
    assert.ok(estado.pedidos >= 1, 'o runner foi consultado');
    await dorme(300);
    assert.equal(estado.fechadas, estado.pedidos, 'toda conexão vencida foi fechada');
    const antes = estado.pedidos;
    const r2 = await diag.coletar();
    assert.notEqual(r2, r1, 'depois do prazo uma coleta nova acontece, não o cache velho');
    assert.ok(estado.pedidos > antes, 'a coleta nova consultou o runner de novo');
  } finally { estado.timers.forEach(clearInterval); srv.closeAllConnections(); srv.close(); }
});

test('runner: resposta acima do teto de bytes é descartada e a conexão fechada', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.write('x'.repeat(5000)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const runner = criarRunner({ log: () => {}, timeoutMs: 5000 });
  try {
    const r = await runner.pedir(ADMIN(`http://127.0.0.1:${srv.address().port}`), 'GET', '/x', null, 5000, { maxBytes: 1000 });
    assert.equal(r.ok, false);
    assert.match(r.erro, /passou de 1000 bytes/);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('runner: signal já abortado ou abortado no meio cancela a consulta; prazo total vale mesmo com a conexão ativa', async () => {
  const { srv, estado, url } = await servidorSemFim();
  const runner = criarRunner({ log: () => {}, timeoutMs: 60000 });
  try {
    const c = new AbortController();
    c.abort();
    assert.match((await runner.pedir(ADMIN(url), 'GET', '/x', null, 5000, { signal: c.signal })).erro, /cancelada/);
    assert.equal(estado.pedidos, 0, 'nem chegou a abrir conexão');
    const t = Date.now();
    const r = await runner.pedir(ADMIN(url), 'GET', '/x', null, 5000, { prazoMs: 200 });
    assert.match(r.erro, /prazo total/);
    assert.ok(Date.now() - t < 1000);
    const c2 = new AbortController();
    setTimeout(() => c2.abort(), 100);
    assert.match((await runner.pedir(ADMIN(url), 'GET', '/x', null, 5000, { signal: c2.signal })).erro, /cancelada/);
    await dorme(100);
    assert.equal(estado.fechadas, estado.pedidos);
  } finally { estado.timers.forEach(clearInterval); srv.closeAllConnections(); srv.close(); }
});

// Runner falso que ignora o cancelamento e nunca responde: só a graça e a idade máxima do cache seguram o coletor.
// (os timers do coletor são unref: o teste mantém o laço de eventos vivo)
const mantemVivo = () => { const t = setInterval(() => {}, 50); return () => clearInterval(t); };
const runnerMudo = () => ({ pedir: () => new Promise(() => {}), estado: () => new Promise(() => {}), provedor: () => new Promise(() => {}) });

test('pendência que ignora o cancelamento: encerrando é liberado depois da graça e o cache velho não vale para sempre', async () => {
  let agora = Date.now();
  const diag = criarDiagnostico(deps([ADMIN('http://127.0.0.1:1')], runnerMudo(), { agora: () => agora, idadeMaximaMs: 5000 }));
  const solta = mantemVivo();
  const r1 = await diag.coletar();
  assert.equal(r1.ok, true);
  assert.equal(await diag.coletar(), r1, 'logo depois, ainda encerrando e com cache novo: devolve o cache');
  await dorme(550); // passa do resto do prazo da coleta mais a graça
  const r2 = await diag.coletar();
  assert.notEqual(r2, r1, 'liberado depois da graça: coleta nova');
  agora += 10000; // cache velho demais
  const r3Promessa = diag.coletar();
  const r3 = await r3Promessa;
  assert.notEqual(r3, r2);
  solta();
});

test('cache acima da idade máxima não é devolvido enquanto a coleta anterior encerra: espera e coleta de novo', async () => {
  let agora = Date.now();
  const diag = criarDiagnostico(deps([ADMIN('http://127.0.0.1:1')], runnerMudo(), { agora: () => agora, idadeMaximaMs: 1000 }));
  const solta = mantemVivo();
  const r1 = await diag.coletar();
  agora += 5000;
  const r2 = await diag.coletar();
  assert.notEqual(r2, r1);
  solta();
});

// O teste de que nenhum prompt manda o Admin ler conteúdo do container fica em diagnostico.test.js (usa o `montar` de lá).
test('promptAdmin: só aceita comandos do host da lista fechada', () => {
  for (const bom of ['`dgclaw status`', '`podman ps -a`', '`systemctl is-active dgclaw-web`', '`systemctl list-timers dgclaw-checar-atualizacao.timer`', '`df -h` e `du -sh /var/lib/dgclaw/* /var/backups/dgclaw`']) {
    assert.ok(U.promptAdmin('x.', bom, 'dgclaw status'), bom);
  }
  for (const ruim of ['`podman exec dgclaw-tina journalctl -u x`', '`journalctl -u dgclaw-web -n 50`', '`systemctl status dgclaw-web`', '`cat /root/x`', 'o log do vigia', '`dgclaw status` e `tail -n 5 x.log`', '`systemctl is-active x; id`']) {
    assert.throws(() => U.promptAdmin('x.', ruim, 'dgclaw status'), /lista fechada/, ruim);
  }
});
