'use strict';
// Limites do container de um agente (processos e memória) e sinais de que ele bateu neles: OOM e reinícios do runner.
// Lê o cgroup do próprio container por `podman exec` (só leitura) e compara com o que o DG Claw calcularia hoje para
// esta máquina (mesma regra de lib/limites.sh: o maior entre 2 GB e 75% da RAM total, ou DGCLAW_CONTAINER_MEMORIA).
// Container criado antes do limite novo continua com o limite antigo até o `dgclaw agente reparar`.

const path = require('node:path');
const U = require('./util');

const { R, conserta } = U;
const LIMITE_PIDS = 4096;
const PISO_MEM_MB = 2048;
const MIN_REINICIOS = 1;
// Tudo o que o comando imprime é número ou a palavra `max`; as linhas de memory.events têm formato fixo.
// Sem ponto e vírgula: o teste do diagnóstico proíbe `;` em qualquer comando, como trava contra injeção pelo slug.
const SCRIPT_CGROUP = ['pids.max', 'memory.max', 'memory.events'].map((f) => `echo "== ${f}"\ncat /sys/fs/cgroup/${f} 2>/dev/null`).join('\n');
const SCRIPT_RUNNER = 'echo "oom $(journalctl -u dgclaw-runner --since \'24 hours ago\' --no-pager -q 2>/dev/null | grep -c oom-kill)"\necho "reinicios $(systemctl show -p NRestarts --value dgclaw-runner 2>/dev/null)"';

/** Memória (MB) que o DG Claw dá a um container nesta máquina: sobrescrita do dgclaw.env, ou 75% da RAM com piso de 2 GB. */
function memoriaCalculadaMb(totalKb, sobrescrita) {
  const m = /^([1-9][0-9]{0,8})([mg])$/.exec(String(sobrescrita || ''));
  if (m) return Number(m[1]) * (m[2] === 'g' ? 1024 : 1);
  const calc = Number.isFinite(totalKb) && totalKb > 0 ? Math.floor((totalKb * 75) / 100 / 1024) : 0;
  return Math.max(PISO_MEM_MB, calc);
}

/** Separa a saída do SCRIPT_CGROUP em { 'pids.max': 'texto', ... }. */
function lerBlocos(saida) {
  const blocos = {};
  let atual = null;
  for (const l of U.linhasLimitadas(saida, 200)) {
    const m = /^== (pids\.max|memory\.max|memory\.events)$/.exec(l);
    if (m) { atual = m[1]; blocos[atual] = []; } else if (atual) blocos[atual].push(l.trim());
  }
  return blocos;
}
/** Número inteiro não negativo, a palavra `max` (ilimitado) ou null (ausente ou ilegível). */
function valorCgroup(linhas) {
  const v = linhas && linhas[0];
  if (v === 'max') return 'max';
  return typeof v === 'string' && /^[0-9]{1,18}$/.test(v) ? Number(v) : null;
}
const gb = (mb) => (mb / 1024).toFixed(1).replace('.', ',');

function tarefaDeLimites(ctx, ag, container, naoRodando, PARADO) {
  const { exec, config, lerEnv, meminfo, log } = ctx;
  const { slug } = ag;
  const quem = `o agente ${slug}`;
  const cmdReparar = `dgclaw agente reparar ${slug}`;
  return {
    sufixo: 'limites', nome: `Limites do container - ${ag.nome}`, depende: container,
    async fn(dep) {
      if (naoRodando(dep)) return R('nao_medido', PARADO);
      if (!ag.container || !U.RX_NOME_SEGURO.test(ag.container.replace(/^dgclaw-/, ''))) return R('nao_medido', 'O registro de agentes não informa um nome de container válido para este agente.');
      const r = await exec('podman', ['exec', ag.container, 'sh', '-c', SCRIPT_CGROUP], { timeout: 4500 });
      if (r.codigo !== 0) {
        log('aviso', `Diagnóstico: não consegui ler o cgroup do container ${ag.container} (código ${r.codigo}, ${r.erro || 'sem erro de sistema'}).`);
        return R('nao_medido', `Não consegui ler os limites do container (${U.demorou(r) ? 'demorou demais' : `código ${r.codigo}`}).`);
      }
      const blocos = lerBlocos(r.stdout);
      const pids = valorCgroup(blocos['pids.max']);
      const memBytes = valorCgroup(blocos['memory.max']);
      const eventos = {};
      for (const l of blocos['memory.events'] || []) {
        const m = /^([a-z_]{1,30}) ([0-9]{1,18})$/.exec(l);
        if (m) eventos[m[1]] = Number(m[2]);
      }
      if (pids === null && memBytes === null) return R('nao_medido', 'O container não mostrou os arquivos de limite do cgroup (pids.max e memory.max), então não deu para conferir.');

      let totalKb = NaN;
      try {
        const mm = /^MemTotal:\s+([0-9]+)\s+kB/m.exec(await meminfo());
        if (mm) totalKb = Number(mm[1]);
      } catch (e) { log('aviso', `Diagnóstico: não consegui ler /proc/meminfo para calcular o limite de memória esperado (${e.code || e.message}).`); }
      const env = lerEnv(path.join(path.dirname(config.agentesPath), 'dgclaw.env'));
      const esperadoMb = memoriaCalculadaMb(totalKb, env && env.vars && env.vars.DGCLAW_CONTAINER_MEMORIA);

      const avisos = [];
      const sinais = [];
      if (typeof pids === 'number' && pids < LIMITE_PIDS) {
        avisos.push(`O container foi criado com o limite antigo de processos: ${pids} (hoje o DG Claw cria com ${LIMITE_PIDS}). Com o limite baixo, um render de vídeo ou um subagente pesado trava com "fork: Resource temporarily unavailable". Rode ${cmdReparar} para subir o limite sem recriar o container.`);
        sinais.push(`pids.max ${pids}`);
      }
      if (typeof memBytes === 'number') {
        const mb = Math.floor(memBytes / 1048576);
        if (mb < esperadoMb) {
          avisos.push(`O container está limitado a ${gb(mb)} GB de memória e esta máquina comporta ${gb(esperadoMb)} GB por container. Um processo pesado do agente pode ser morto por falta de memória. Rode ${cmdReparar} para subir o limite sem recriar o container.`);
          sinais.push(`memory.max ${mb} MB (esperado ${esperadoMb} MB)`);
        } else sinais.push(`memory.max ${mb} MB`);
      }
      const oomCgroup = Number.isInteger(eventos.oom_kill) ? eventos.oom_kill : 0;
      const r2 = await exec('podman', ['exec', ag.container, 'sh', '-c', SCRIPT_RUNNER], { timeout: 4500 });
      let oomJournal = 0;
      let reinicios = 0;
      if (r2.codigo === 0) {
        const mo = /^oom ([0-9]{1,9})$/m.exec(r2.stdout);
        const mr = /^reinicios ([0-9]{1,9})$/m.exec(r2.stdout);
        if (mo) oomJournal = Number(mo[1]);
        if (mr) reinicios = Number(mr[1]);
      } else log('aviso', `Diagnóstico: não consegui ler o journal e os reinícios do runner de ${ag.container} (código ${r2.codigo}, ${r2.erro || 'sem erro de sistema'}).`);
      if (oomCgroup > 0 || oomJournal > 0) {
        const partes = [];
        if (oomCgroup > 0) partes.push(`o cgroup do container registra ${oomCgroup} processo${oomCgroup === 1 ? '' : 's'} morto${oomCgroup === 1 ? '' : 's'} por falta de memória desde que ele foi ligado`);
        if (oomJournal > 0) partes.push(`o journal do runner tem ${oomJournal} linha${oomJournal === 1 ? '' : 's'} com "oom-kill" nas últimas 24 horas`);
        avisos.push(`O container ficou sem memória: ${partes.join(' e ')}. O sistema matou um processo do agente, e se foi o runner a conversa caiu. Rode ${cmdReparar} para subir o limite; se voltar a acontecer, peça ao agente para rodar menos coisas pesadas ao mesmo tempo.`);
        sinais.push(`oom_kill ${oomCgroup}, oom-kill no journal ${oomJournal}`);
      }
      if (reinicios >= MIN_REINICIOS) {
        avisos.push(`O runner reiniciou ${reinicios} vez${reinicios === 1 ? '' : 'es'} sozinho desde que o container foi ligado. Isso costuma vir de falta de memória ou de processos. Veja os itens de memória e de processos acima e, se não houver nenhum, olhe você mesmo o journal com \`podman exec dgclaw-${slug} journalctl -u dgclaw-runner -n 50\`.`);
        sinais.push(`NRestarts ${reinicios}`);
      }
      const evidencia = { horario: null, codigo_saida: null, sinal: sinais.join('; ') || null };
      if (!avisos.length) return R('ok', null, { evidencia });
      return R('atencao', avisos.join(' '), {
        evidencia,
        ...conserta(`o container de ${quem} está com limites ou sinais de falta de recurso: ${avisos.map((a) => a.split(' Rode ')[0].split(' Veja ')[0]).join(' ')}`, '`podman stats --no-stream`', cmdReparar),
      });
    },
  };
}

module.exports = { tarefaDeLimites, memoriaCalculadaMb };
