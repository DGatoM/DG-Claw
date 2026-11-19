'use strict';
// Diagnóstico dos limites do container: cgroup, journal e reinícios simulados, sem podman de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tarefaDeLimites, memoriaCalculadaMb } = require('../lib/diagnostico/limites');

const GB = 1073741824;
const ag = { slug: 'ana', nome: 'Ana', container: 'dgclaw-ana' };

/** Roda a verificação com um cgroup simulado. op: pids, mem (bytes ou 'max'), oomCgroup, oomJournal, reinicios, ramGb, env. */
async function rodar(op) {
  const chamadas = [];
  const ctx = {
    config: { agentesPath: '/etc/dgclaw/agentes.json' },
    log: () => {},
    lerEnv: () => ({ vars: op.env || {} }),
    meminfo: async () => `MemTotal:       ${(op.ramGb || 8) * 1024 * 1024} kB\nMemFree: 1 kB\n`,
    exec: async (cmd, args) => {
      chamadas.push([cmd, ...args]);
      const script = args[args.length - 1];
      if (script.includes('pids.max')) {
        if (op.semCgroup) return { codigo: 0, stdout: '== pids.max\n== memory.max\n== memory.events\n', stderr: '' };
        return { codigo: 0, stdout: `== pids.max\n${op.pids === undefined ? 4096 : op.pids}\n== memory.max\n${op.mem === undefined ? 6 * GB : op.mem}\n== memory.events\nlow 0\nhigh 0\nmax 0\noom ${op.oomCgroup || 0}\noom_kill ${op.oomCgroup || 0}\n`, stderr: '' };
      }
      if (op.runnerFalha) return { codigo: 1, stdout: '', stderr: 'x', erro: null };
      if (op.runnerSemValores) return { codigo: 0, stdout: 'oom \nreinicios \n', stderr: '' };
      return { codigo: 0, stdout: `oom ${op.oomJournal || 0}\nreinicios ${op.reinicios || 0}\n`, stderr: '' };
    },
  };
  const t = tarefaDeLimites(ctx, ag, {}, (d) => d && d.parado === true, 'parado');
  assert.equal(t.sufixo, 'limites');
  const r = await t.fn(op.dep);
  return { r, chamadas };
}

test('cálculo esperado de memória: 75% da RAM com piso de 2 GB e sobrescrita', () => {
  assert.equal(memoriaCalculadaMb(4 * 1024 * 1024), 3072);
  assert.equal(memoriaCalculadaMb(8 * 1024 * 1024), 6144);
  assert.equal(memoriaCalculadaMb(16 * 1024 * 1024), 12288);
  assert.equal(memoriaCalculadaMb(2 * 1024 * 1024), 2048);
  assert.equal(memoriaCalculadaMb(NaN), 2048);
  assert.equal(memoriaCalculadaMb(8 * 1024 * 1024, '3g'), 3072);
  assert.equal(memoriaCalculadaMb(8 * 1024 * 1024, '1500m'), 1500);
  assert.equal(memoriaCalculadaMb(8 * 1024 * 1024, 'lixo'), 6144);
});

test('limites em dia e sem sinal de OOM: ok', async () => {
  const { r } = await rodar({});
  assert.equal(r.estado, 'ok');
  assert.match(r.evidencia.sinal, /memory\.max 6144 MB/);
});

test('pids.max abaixo de 4096: aviso com o valor lido e o comando de reparar', async () => {
  const { r } = await rodar({ pids: 1024 });
  assert.equal(r.estado, 'atencao');
  assert.match(r.motivo, /limite antigo de processos: 1024/);
  assert.match(r.motivo, /dgclaw agente reparar ana/);
  assert.match(r.prompt_sugerido, /dgclaw agente reparar ana/);
});

test('memória abaixo do calculado: aviso; ilimitada ou acima: ok', async () => {
  const baixo = await rodar({ mem: 2 * GB });
  assert.equal(baixo.r.estado, 'atencao');
  assert.match(baixo.r.motivo, /limitado a 2,0 GB.*comporta 6,0 GB/);
  assert.equal((await rodar({ mem: 'max' })).r.estado, 'ok');
  assert.equal((await rodar({ mem: 12 * GB })).r.estado, 'ok');
  assert.equal((await rodar({ mem: 2 * GB, ramGb: 2 })).r.estado, 'ok', 'máquina de 2 GB: o piso de 2 GB é o esperado');
  assert.equal((await rodar({ mem: 2 * GB, env: { DGCLAW_CONTAINER_MEMORIA: '2g' } })).r.estado, 'ok', 'a sobrescrita do dono vale como esperado');
});

test('OOM no cgroup ou no journal do runner: aviso que diz o que aconteceu e o que fazer', async () => {
  const a = await rodar({ oomCgroup: 2 });
  assert.equal(a.r.estado, 'atencao');
  assert.match(a.r.motivo, /2 processos mortos por falta de memória/);
  const b = await rodar({ oomJournal: 1 });
  assert.equal(b.r.estado, 'atencao');
  assert.match(b.r.motivo, /1 linha com "oom-kill" nas últimas 24 horas/);
  assert.doesNotMatch(b.r.motivo, /dgclaw agente reparar ana/, "limites em dia: o OOM não manda reparar");
});

test('runner com reinícios: aviso; sem reinício: ok', async () => {
  const a = await rodar({ reinicios: 3 });
  assert.equal(a.r.estado, 'atencao');
  assert.match(a.r.motivo, /reiniciou 3 vezes/);
  assert.equal((await rodar({ reinicios: 0 })).r.estado, 'ok');
});

test('container parado, cgroup ilegível ou comando falhando: não medido, nunca ok', async () => {
  assert.equal((await rodar({ dep: { parado: true } })).r.estado, 'nao_medido');
  assert.equal((await rodar({ semCgroup: true })).r.estado, 'nao_medido');
  const { r } = await rodar({ runnerFalha: true, pids: 1024 });
  assert.equal(r.estado, 'atencao', 'o que deu para ler continua sendo avisado');
});

test('só lê: nenhum comando muda coisa, e nenhum leva ponto e vírgula', async () => {
  const { chamadas } = await rodar({});
  assert.equal(chamadas.length, 2);
  for (const c of chamadas) { assert.equal(c[1], 'exec'); assert.ok(!c.join(' ').includes(';')); assert.ok(!/update|rm|restart|kill/.test(c.slice(4).join(' ').replace(/NRestarts|oom-kill/g, ''))); }
});

test('segunda leitura falhando ou sem valores: não medido, nunca zero; com aviso medido, diz o que faltou', async () => {
  const a = await rodar({ runnerFalha: true });
  assert.equal(a.r.estado, 'nao_medido');
  assert.match(a.r.motivo, /Não consegui ler o journal e os reinícios do runner/);
  const b = await rodar({ runnerSemValores: true });
  assert.equal(b.r.estado, 'nao_medido');
  assert.match(b.r.motivo, /journal do runner.*reinícios do runner/);
  const c = await rodar({ runnerFalha: true, pids: 1024 });
  assert.equal(c.r.estado, 'atencao');
  assert.match(c.r.motivo, /limite antigo de processos: 1024/);
  assert.match(c.r.motivo, /Não consegui ler o journal e os reinícios do runner/);
  const d = await rodar({ runnerFalha: true, oomCgroup: 1 });
  assert.equal(d.r.estado, 'atencao');
  assert.match(d.r.evidencia.sinal, /não medido/);
});

test('OOM com limites em dia: atenção mostrando o evento, sem mandar reparar; com limite baixo, manda', async () => {
  const a = await rodar({ oomCgroup: 3 });
  assert.equal(a.r.estado, 'atencao');
  assert.match(a.r.motivo, /3 processos mortos/);
  assert.match(a.r.motivo, /rodar menos coisas pesadas/);
  assert.doesNotMatch(a.r.motivo, /dgclaw agente reparar/);
  assert.doesNotMatch(a.r.prompt_sugerido, /dgclaw agente reparar/);
  const b = await rodar({ oomJournal: 2, mem: 2 * GB });
  assert.equal(b.r.estado, 'atencao');
  assert.match(b.r.motivo, /dgclaw agente reparar ana/);
});
