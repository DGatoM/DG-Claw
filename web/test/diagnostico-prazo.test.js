'use strict';
// Diagnóstico: custo das leituras de texto de fora, prazo com cancelamento e uma coleta por vez.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarDiagnostico } = require('../lib/diagnostico');
const { conferirRotinas, cadenciaDoTimer } = require('../lib/diagnostico/cron');
const U = require('../lib/diagnostico/util');

const AGORA = Date.UTC(2026, 9, 21, 15, 0, 0);
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const AG = { slug: 'tina', nome: 'Tina', tipo: 'agente', container: 'dgclaw-tina', home_host: '/nao/existe' };

test('duracaoSystemd: formatos do systemd entendidos e o resto vira null', () => {
  assert.equal(U.duracaoSystemd('30min'), 30 * 60000);
  assert.equal(U.duracaoSystemd('1h 30min'), 90 * 60000);
  assert.equal(U.duracaoSystemd('1min 30s'), 90000);
  assert.equal(U.duracaoSystemd('1d 2h'), 26 * 3600000);
  assert.equal(U.duracaoSystemd('500ms'), 500);
  assert.equal(U.duracaoSystemd('5.5s'), 5500);
  assert.equal(U.duracaoSystemd('2w'), 14 * 86400000);
  assert.equal(U.duracaoSystemd('1M'), 2592000000);
  for (const ruim of ['', 'infinity', '30', 'min', '30xyz', '1234567890123min', '30min foo', '5s6', '9'.repeat(40), `${'9'.repeat(200)}min`, null, 12]) {
    assert.equal(U.duracaoSystemd(ruim), null, `esperava null para ${String(ruim).slice(0, 20)}`);
  }
});

test('cadenciaDoTimer: intervalo e calendário diário lidos sem regex sobre o texto de fora', () => {
  assert.deepEqual(cadenciaDoTimer({ TimersMonotonic: '{ OnUnitActiveUSec=30min ; next_elapse=2d 1h }' }), { tipo: 'intervalo', ms: 30 * 60000 });
  assert.equal(cadenciaDoTimer({ TimersCalendar: '{ OnCalendar=*-*-* 23:30:00 ; next_elapse=@1792549819 }' }).tipo, 'diaria');
  assert.equal(cadenciaDoTimer({ TimersCalendar: '{ OnCalendar=Mon *-*-* 23:30:00 ; next_elapse=x }' }).tipo, 'calendario');
  assert.equal(cadenciaDoTimer({}).tipo, 'desconhecida');
});

test('lerShow: unit repetida vale a primeira ocorrência e o valor é cortado em 200 caracteres', () => {
  const saida = 'Id=a.timer\nActiveState=active\n\nId=a.timer\nActiveState=failed\n\nId=b.timer\nSubState=' + 'x'.repeat(5000) + '\n';
  const p = U.lerShow(saida);
  assert.equal(p['a.timer'].ActiveState, 'active');
  assert.equal(p['b.timer'].SubState.length, 200);
});

// O payload do Codex: o mesmo timer 200 vezes, com TimersMonotonic cheio de dígitos sem unidade válida.
function payloadHostil(bytes) {
  const nome = 'dgclaw-tina-heartbeat';
  const lixo = `${'9'.repeat(190)} `.repeat(Math.max(1, Math.floor(bytes / 200 / 200 / 1.0)));
  const blocos = [];
  for (let i = 0; i < 200; i += 1) {
    const mono = Array.from({ length: Math.max(1, Math.floor(bytes / 200 / 200)) }, () => `TimersMonotonic={ OnUnitActiveUSec=${'9'.repeat(150)} ${lixo.slice(0, 40)} ; next_elapse=${'1'.repeat(60)} }`);
    blocos.push([`Id=${nome}.timer`, 'ActiveState=active', 'SubState=waiting', ...mono, 'LastTriggerUSec=@1792549819', 'NextElapseUSecRealtime='].join('\n'));
    blocos.push([`Id=${nome}.service`, 'ActiveState=inactive', 'SubState=dead', 'Result=success', 'ExecMainStatus=0'].join('\n'));
  }
  let texto = `${blocos.join('\n\n')}\n`;
  if (texto.length < bytes) texto += `${'Id=\n'.repeat(Math.ceil((bytes - texto.length) / 4))}`;
  return texto.slice(0, bytes);
}

function execHostil(bytes, atrasoMs) {
  const show = payloadHostil(bytes);
  const chamadas = [];
  const exec = async (cmd, args, op) => {
    chamadas.push({ t: Date.now(), cmd, args });
    if (cmd === 'podman' && args[0] === 'inspect') return { codigo: 0, stdout: JSON.stringify([{ State: { Status: 'running', Running: true, ConmonPid: 1, ExitCode: 0, StartedAt: '2026-10-19T17:19:43Z', FinishedAt: '0001-01-01T00:00:00Z' }, HostConfig: { RestartPolicy: { Name: 'always' } } }]), stderr: '' };
    const resto = args.slice(2);
    if (cmd === 'podman' && resto[1] === 'list-units') return { codigo: 0, stdout: `${'dgclaw-tina-heartbeat.timer loaded active waiting x\n'.repeat(200)}`, stderr: '' };
    if (cmd === 'podman' && resto[1] === 'show') return { codigo: 0, stdout: show, stderr: '' };
    if (atrasoMs) await dorme(atrasoMs);
    return { codigo: 1, stdout: '', stderr: 'nada', erro: op && op.signal && op.signal.aborted ? 'prazo' : null };
  };
  return { exec, chamadas };
}

/** Roda `fn` medindo o maior atraso do event loop (setInterval de 10 ms). */
async function medindoLoop(fn) {
  let maior = 0;
  let ultimo = performance.now();
  const iv = setInterval(() => { const n = performance.now(); maior = Math.max(maior, n - ultimo - 10); ultimo = n; }, 10);
  const ini = performance.now();
  try { const valor = await fn(); return { valor, ms: performance.now() - ini, atraso: maior }; } finally { clearInterval(iv); }
}

for (const bytes of [20 * 1024, 256 * 1024]) {
  test(`conferirRotinas com o payload hostil de ${bytes / 1024} KB: menos de 1 s e o event loop não trava`, async () => {
    const { exec } = execHostil(bytes);
    const ctx = { exec, agora: () => AGORA, tz: 'UTC', log: () => {} };
    const r = await medindoLoop(() => conferirRotinas(ctx, AG, async () => []));
    assert.ok(r.ms < 1000, `levou ${r.ms.toFixed(0)} ms`);
    assert.ok(r.atraso < 100, `o event loop ficou ${r.atraso.toFixed(0)} ms parado`);
    assert.equal(r.valor.itens.length, 1, 'o mesmo timer 200 vezes vira um item só');
  });
}

function montarDiag(exec, extra) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-prazo-'));
  const logs = [];
  const deps = Object.assign({
    config: { tz: 'UTC', agentesPath: path.join(raiz, 'agentes.json'), dataDir: path.join(raiz, 'web') },
    registro: { estado: () => ({ ok: true, erro: null, agentes: [AG] }) },
    runner: { pedir: async () => ({ ok: false, erro: 'fora' }), estado: async () => ({ ok: false, erro: 'fora' }), provedor: async () => ({ ok: false, erro: 'fora' }) },
    log: (n, m) => logs.push([n, m]),
    exec,
    agora: () => AGORA,
    statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 500, bavail: 500 }),
    meminfo: async () => 'MemTotal: 8000000 kB\nMemAvailable: 6000000 kB\n',
    uptime: () => 10 * 24 * 3600,
    procVivo: () => true,
    lerEnv: () => ({ vars: {}, erro: null }),
    atualizacao: { lerEstado: () => ({ ausente: true }) },
  }, extra);
  return { diag: criarDiagnostico(deps), logs, limpa: () => fs.rmSync(raiz, { recursive: true, force: true }) };
}

for (const bytes of [20 * 1024, 256 * 1024]) {
  test(`coletar() com o payload hostil de ${bytes / 1024} KB: menos de 1 s e o event loop não trava`, async () => {
    const { exec } = execHostil(bytes);
    const m = montarDiag(exec);
    try {
      const r = await medindoLoop(() => m.diag.coletar());
      assert.ok(r.ms < 1000, `levou ${r.ms.toFixed(0)} ms`);
      assert.ok(r.atraso < 100, `o event loop ficou ${r.atraso.toFixed(0)} ms parado`);
      assert.equal(r.valor.verificacoes.filter((v) => v.id.startsWith('agente.tina.cron.')).length, 1);
    } finally { m.limpa(); }
  });
}

// 200 timers falhos, cada journal demorando (4 s no mundo real; aqui 10 vezes mais curto, mesma proporção).
function execTimersFalhos(journalMs, respeitaSignal) {
  const chamadas = [];
  const unidades = Array.from({ length: 200 }, (_, i) => `dgclaw-tina-t${i}`);
  const exec = async (cmd, args, op) => {
    const resto = args.slice(2);
    if (cmd === 'podman' && args[0] === 'inspect') return { codigo: 0, stdout: JSON.stringify([{ State: { Status: 'running', Running: true, ConmonPid: 1, ExitCode: 0, StartedAt: '2026-10-19T17:19:43Z', FinishedAt: '0001-01-01T00:00:00Z' }, HostConfig: { RestartPolicy: { Name: 'always' } } }]), stderr: '' };
    if (cmd === 'podman' && resto[1] === 'list-units') return { codigo: 0, stdout: unidades.map((u) => `${u}.timer loaded failed failed x`).join('\n'), stderr: '' };
    if (cmd === 'podman' && resto[1] === 'show') {
      return { codigo: 0, stderr: '', stdout: unidades.map((u) => `Id=${u}.timer\nActiveState=active\n\nId=${u}.service\nActiveState=failed\nResult=exit-code\nExecMainStatus=1\n`).join('\n') };
    }
    if (cmd === 'podman' && resto[0] === 'journalctl') {
      chamadas.push(Date.now());
      await new Promise((resolve) => {
        const t = setTimeout(resolve, journalMs);
        if (respeitaSignal && op && op.signal) op.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      return { codigo: respeitaSignal && op.signal && op.signal.aborted ? null : 0, stdout: '', stderr: '', erro: op && op.signal && op.signal.aborted ? 'prazo' : null };
    }
    return { codigo: 1, stdout: '', stderr: '' };
  };
  return { exec, chamadas };
}

for (const respeita of [true, false]) {
  test(`prazo: com 200 timers falhos e journal lento nenhuma chamada nova começa depois do prazo (executor ${respeita ? 'obedece' : 'ignora'} o cancelamento)`, async () => {
    const LIMITE = 500;
    const { exec, chamadas } = execTimersFalhos(400, respeita);
    const m = montarDiag(exec, { limiteMs: LIMITE, prazoColetaMs: 1200 });
    try {
      const ini = Date.now();
      const r = await m.diag.coletar();
      const gasto = Date.now() - ini;
      assert.ok(gasto <= 1200 + 300, `a resposta levou ${gasto} ms`);
      assert.ok(chamadas.length >= 1 && chamadas.length <= 3, `chamadas de journal: ${chamadas.length}`);
      for (const t of chamadas) assert.ok(t - ini <= LIMITE + 40, `uma chamada de journal começou ${t - ini} ms depois do início, depois do prazo`);
      const cron = r.verificacoes.filter((v) => v.id.startsWith('agente.tina.cron') && v.estado === 'nao_medido');
      assert.ok(cron.length >= 1, 'as rotinas que não deu tempo de conferir ficaram como não medidas');
      assert.ok(cron.every((v) => /por tempo|não respondeu/i.test(v.motivo)), cron[0] && cron[0].motivo);
      const total = chamadas.length;
      await dorme(900); // se algo ainda estivesse rodando em segundo plano, apareceria aqui
      assert.equal(chamadas.length, total, 'nenhuma chamada nova depois da resposta');
    } finally { m.limpa(); }
  });
}

test('prazo: conferirRotinas sozinho marca o restante como não medido com o motivo de tempo', async () => {
  const { exec, chamadas } = execTimersFalhos(200, true);
  const ctx = { exec, agora: () => AGORA, tz: 'UTC', log: () => {} };
  const prazo = U.criarPrazo(450);
  const r = await conferirRotinas(ctx, AG, async () => [], prazo);
  prazo.encerrar();
  assert.equal(r.itens.length, 200);
  const parados = r.itens.filter((i) => i.estado === 'nao_medido');
  assert.ok(parados.length > 150, `parados por tempo: ${parados.length}`);
  assert.match(parados[0].motivo, /parou por tempo/);
  assert.ok(chamadas.length <= 3);
});

test('uma coleta por vez: pedido novo durante a coleta, ou depois da resposta por tempo, reaproveita e não dispara outra', async () => {
  const { exec, chamadas } = execTimersFalhos(700, false);
  let totalExec = 0;
  const contando = async (...a) => { totalExec += 1; return exec(...a); };
  const m = montarDiag(contando, { limiteMs: 300, prazoColetaMs: 600 });
  try {
    const [r1, r2] = await Promise.all([m.diag.coletar(), m.diag.coletar()]);
    assert.equal(r1, r2, 'pedidos simultâneos recebem o mesmo resultado');
    assert.equal(r1.ok, true);
    const depoisDaResposta = totalExec;
    assert.ok(chamadas.length >= 1, 'um journal lento ainda estava rodando quando a resposta saiu');
    const r3 = await m.diag.coletar();
    assert.equal(r3, r1, 'enquanto a coleta anterior encerra, vale o último resultado');
    assert.equal(totalExec, depoisDaResposta, 'nenhum subprocesso novo');
    await dorme(900);
    const r4 = await m.diag.coletar();
    assert.notEqual(r4, r1, 'depois de encerrar, uma coleta nova pode começar');
  } finally { m.limpa(); }
});

test('mascararDados: linhas hostis de 1000 caracteres não passam de 100 ms por padrão', () => {
  const { mascararDados } = require('../lib/mascara');
  const alvos = ['a'.repeat(1000), 'a@'.repeat(500), '1'.repeat(1000), `${'a'.repeat(999)}g`, 'sk-ant-api03-'.repeat(80), 'token='.repeat(160), 'a://b:'.repeat(160), '0123456789abcdef'.repeat(62) + 'zz', 'Bearer '.repeat(140), '.'.repeat(1000), 'x-'.repeat(500), '+55 11 '.repeat(140)];
  for (const a of alvos) {
    const ini = performance.now();
    mascararDados(a);
    const ms = performance.now() - ini;
    assert.ok(ms < 100, `${a.slice(0, 16)}... levou ${ms.toFixed(1)} ms`);
  }
});
