'use strict';
// A máquina inteira: serviços e timers do host, disco, memória e reinício.

const path = require('node:path');
const { higienizar } = require('./higiene');
const U = require('./util');

const { R, conserta } = U;
const RX_ERRO = /error|erro|falh|fail|traceback|exception|denied|exit/i;
const PROPS = 'Id,LoadState,ActiveState,SubState,Result,ExecMainStatus,ActiveEnterTimestamp,ExecMainExitTimestamp,LastTriggerUSec';
const GB = 1024 ** 3;

const SERVICOS = [
  { unit: 'caddy', nome: 'Serviço Caddy (entrada do site pela internet)', critico: false },
  { unit: 'dgclaw-web', nome: 'Serviço DG Claw Web (painel e chat)', critico: true },
  { unit: 'dgclaw-admin', nome: 'Serviço do Admin (agente de sistema)', critico: true },
  { unit: 'dgclaw-firewall', nome: 'Cerca de rede dos containers (firewall)', critico: true },
];
const TIMERS = [
  { unit: 'dgclaw-admin-monitor', nome: 'Rotina do Admin: monitor dos cards (5 min)', maxMs: 25 * 60000, desligavel: false },
  { unit: 'dgclaw-checar-atualizacao', nome: 'Rotina que procura versão nova do DG Claw (6 h)', maxMs: 12 * 3600000 + 15 * 60000, desligavel: true },
];

async function linhasDeErroDoHost(exec, unit) {
  const r = await exec('journalctl', ['-u', `${unit}.service`, '-n', '40', '--no-pager', '-o', 'short-iso'], { timeout: 4000 });
  if (r.codigo !== 0) return [];
  return r.stdout.split('\n').filter((l) => RX_ERRO.test(l)).slice(-5).map((l) => higienizar(l, 200)).filter(Boolean);
}

async function mostrar(exec, units) {
  const r = await exec('systemctl', ['show', '--timestamp=unix', ...units, '-p', PROPS], { timeout: 4500 });
  if (r.erro === 'ENOENT') return { erro: 'O comando systemctl não existe nesta máquina.' };
  if (r.codigo !== 0 && !r.stdout) return { erro: `O systemctl falhou (${r.erro === 'timeout' ? 'demorou demais' : `código ${r.codigo}`}).` };
  return { props: U.lerShow(r.stdout) };
}

function tarefasDaMaquina(ctx) {
  const { exec, agora, config } = ctx;
  const tz = config.tz;
  const tarefas = [];

  for (const s of SERVICOS) {
    tarefas.push({
      sufixo: `servico.${s.unit}`, nome: s.nome,
      async fn() {
        const m = await mostrar(exec, [`${s.unit}.service`]);
        if (m.erro) return R('nao_medido', m.erro);
        const p = m.props[`${s.unit}.service`];
        if (!p) return R('nao_medido', 'O systemd não devolveu o estado deste serviço.');
        if (p.LoadState === 'not-found') {
          return R(s.critico ? 'quebrado' : 'atencao', `O serviço ${s.unit} não está instalado nesta máquina.`, {
            evidencia: { horario: null, codigo_saida: null, trecho: 'LoadState not-found' },
            ...conserta(`o serviço ${s.unit} não está instalado na máquina.`, `\`systemctl status ${s.unit}\``, 'dgclaw status'),
          });
        }
        const entrouMs = U.dataSystemd(p.ActiveEnterTimestamp);
        const codigo = /^\d+$/.test(p.ExecMainStatus || '') ? Number(p.ExecMainStatus) : null;
        if (p.ActiveState === 'active') return R('ok', null, { ultimo_sinal: U.iso(entrouMs) });
        const linhas = await linhasDeErroDoHost(exec, s.unit);
        const evid = { horario: U.iso(entrouMs), codigo_saida: codigo, trecho: [`estado ${higienizar(p.ActiveState, 20)}/${higienizar(p.SubState, 20)}, resultado ${higienizar(p.Result, 30)}`, ...linhas].join('\n') };
        const fix = conserta(`o serviço ${s.unit} da máquina está parado (estado ${higienizar(p.ActiveState, 20)}, resultado ${higienizar(p.Result, 30)}).`, `\`systemctl status ${s.unit}\` e \`journalctl -u ${s.unit} -n 50\``, `systemctl restart ${s.unit}`);
        if (p.ActiveState === 'activating') return R('atencao', `O serviço ${s.unit} está subindo e ainda não terminou.`, { ultimo_sinal: U.iso(entrouMs), evidencia: evid, ...fix });
        return R('quebrado', `O serviço ${s.unit} está parado (${higienizar(p.ActiveState, 20)}, resultado "${higienizar(p.Result, 30)}"${codigo != null ? `, código de saída ${codigo}` : ''}).`, { ultimo_sinal: U.iso(entrouMs), evidencia: evid, ...fix });
      },
    });
  }

  for (const t of TIMERS) {
    tarefas.push({
      sufixo: `timer.${t.unit}`, nome: t.nome,
      async fn() {
        const m = await mostrar(exec, [`${t.unit}.timer`, `${t.unit}.service`]);
        if (m.erro) return R('nao_medido', m.erro);
        const tm = m.props[`${t.unit}.timer`];
        const sv = m.props[`${t.unit}.service`] || {};
        if (!tm || tm.LoadState === 'not-found') {
          return R('atencao', `A rotina ${t.unit} não está instalada nesta máquina.`, { evidencia: { horario: null, codigo_saida: null, trecho: 'timer not-found' }, ...conserta(`o timer ${t.unit} não está instalado.`, `\`systemctl list-timers --all\``, 'dgclaw atualizar --checar') });
        }
        const ultimoMs = Math.max(U.dataSystemd(sv.ExecMainExitTimestamp) || 0, U.dataSystemd(tm.LastTriggerUSec) || 0) || null;
        const codigo = /^\d+$/.test(sv.ExecMainStatus || '') ? Number(sv.ExecMainStatus) : null;
        if (tm.ActiveState !== 'active') {
          return R(t.desligavel ? 'atencao' : 'quebrado', `A rotina está desligada (timer "${higienizar(tm.ActiveState, 20)}").${t.desligavel ? ' Se foi o dono que desligou o aviso automático, não há o que fazer.' : ''}`, {
            ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(ultimoMs), codigo_saida: null, trecho: `timer ${higienizar(tm.ActiveState, 20)}` },
            ...conserta(`o timer ${t.unit} está desligado.`, `\`systemctl status ${t.unit}.timer\``, `systemctl enable --now ${t.unit}.timer`),
          });
        }
        if (sv.Result && sv.Result !== 'success') {
          const linhas = await linhasDeErroDoHost(exec, t.unit);
          return R('quebrado', `A última execução falhou: resultado "${higienizar(sv.Result, 30)}"${codigo != null ? `, código de saída ${codigo}` : ''}.`, {
            ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(ultimoMs), codigo_saida: codigo, trecho: linhas.length ? linhas.join('\n') : null },
            ...conserta(`a rotina ${t.unit} falhou na última execução (resultado ${higienizar(sv.Result, 30)}).`, `\`journalctl -u ${t.unit}.service -n 50\``, `systemctl start ${t.unit}.service`),
          });
        }
        if (ultimoMs && agora() - ultimoMs > t.maxMs) {
          return R('atencao', `A última execução foi ${U.quando(ultimoMs, tz)}, há ${U.duracaoCurta(agora() - ultimoMs)}, mais do que o previsto.`, {
            ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(ultimoMs), codigo_saida: null, trecho: null },
            ...conserta(`a rotina ${t.unit} não roda desde ${U.quando(ultimoMs, tz)}.`, `\`systemctl list-timers ${t.unit}.timer\``, `systemctl restart ${t.unit}.timer`),
          });
        }
        if (!ultimoMs) return R('nao_medido', 'Ainda não rodou desde que a máquina foi ligada.');
        return R('ok', null, { ultimo_sinal: U.iso(ultimoMs) });
      },
    });
  }

  tarefas.push({
    sufixo: 'disco', nome: 'Espaço em disco',
    async fn() {
      const alvos = ['/', path.dirname(config.dataDir || '/var/lib/dgclaw/web')];
      const medidas = [];
      for (const caminho of alvos) {
        try {
          const st = await ctx.statfs(caminho);
          const total = st.blocks * st.bsize;
          const usado = (st.blocks - st.bfree) * st.bsize;
          const livre = st.bavail * st.bsize;
          const pct = usado + livre > 0 ? Math.round((usado / (usado + livre)) * 100) : null;
          medidas.push({ caminho, pct, livreGb: Math.round((livre / GB) * 10) / 10, totalGb: Math.round(total / GB) });
        } catch (e) {
          if (e.code === 'ENOENT') continue; // a pasta de dados pode estar noutro lugar numa instalação diferente
          ctx.log('aviso', `Diagnóstico: não consegui medir o disco de ${caminho} (${e.code || e.message}).`);
        }
      }
      const medidas2 = medidas.filter((x) => x.pct != null);
      if (!medidas2.length) return R('nao_medido', 'Não consegui medir o espaço em disco.');
      const pior = medidas2.reduce((a, b) => (b.pct > a.pct ? b : a));
      const trecho = medidas2.map((x) => `${x.caminho}: ${x.pct}% usado, ${x.livreGb} GB livres de ${x.totalGb} GB`).join('\n');
      const evid = { horario: null, codigo_saida: null, trecho };
      if (pior.pct > 95) return R('quebrado', `O disco está ${pior.pct}% cheio (${pior.livreGb} GB livres). Perto de 100% os agentes param de gravar memória e conversa.`, { evidencia: evid, ...conserta(`o disco da máquina está ${pior.pct}% cheio, com ${pior.livreGb} GB livres.`, '`df -h` e `du -sh /var/lib/dgclaw/* /var/backups/dgclaw`', 'dgclaw status') });
      if (pior.pct > 85) return R('atencao', `O disco está ${pior.pct}% cheio (${pior.livreGb} GB livres). Vale liberar espaço antes que acabe.`, { evidencia: evid, ...conserta(`o disco da máquina está ${pior.pct}% cheio, com ${pior.livreGb} GB livres.`, '`df -h` e `du -sh /var/lib/dgclaw/* /var/backups/dgclaw`', 'dgclaw status') });
      return R('ok', null, { evidencia: evid });
    },
  });

  tarefas.push({
    sufixo: 'memoria', nome: 'Memória da máquina',
    async fn() {
      const texto = await ctx.meminfo();
      const pega = (k) => { const m = String(texto).match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm')); return m ? Number(m[1]) * 1024 : null; };
      const total = pega('MemTotal');
      const disp = pega('MemAvailable');
      if (!total || disp == null) return R('nao_medido', 'Não consegui ler a memória da máquina (/proc/meminfo veio sem MemTotal/MemAvailable).');
      const swapTotal = pega('SwapTotal') || 0;
      const swapLivre = pega('SwapFree') || 0;
      const pct = Math.round((disp / total) * 100);
      const gb = (v) => Math.round((v / GB) * 10) / 10;
      const evid = { horario: null, codigo_saida: null, trecho: `disponível ${gb(disp)} GB de ${gb(total)} GB (${pct}%); swap usado ${gb(swapTotal - swapLivre)} GB de ${gb(swapTotal)} GB` };
      const fix = conserta(`a máquina está com só ${pct}% da memória disponível (${gb(disp)} GB de ${gb(total)} GB).`, '`free -h` e `podman stats --no-stream`', 'dgclaw status');
      if (pct < 5) return R('quebrado', `A máquina está com só ${pct}% de memória disponível (${gb(disp)} GB). Processos podem ser encerrados à força a qualquer momento.`, { evidencia: evid, ...fix });
      if (pct < 10) return R('atencao', `A memória está apertada: só ${pct}% disponível (${gb(disp)} GB de ${gb(total)} GB).`, { evidencia: evid, ...fix });
      return R('ok', null, { evidencia: evid });
    },
  });

  tarefas.push({
    sufixo: 'reinicio', nome: 'Último reinício da máquina',
    async fn() {
      const seg = ctx.uptime();
      if (!Number.isFinite(seg)) return R('nao_medido', 'Não consegui ler há quanto tempo a máquina está ligada.');
      const bootMs = agora() - seg * 1000;
      if (seg < 24 * 3600) {
        return R('atencao', `A máquina reiniciou ${U.quando(bootMs, tz)}. Depois de um reinício os containers dos agentes às vezes ficam parados; confira os itens dos agentes.`, {
          ultimo_sinal: U.iso(bootMs), evidencia: { horario: U.iso(bootMs), codigo_saida: null, trecho: `ligada há ${U.duracaoCurta(seg * 1000)}` },
          o_que_fazer: 'Só informativo. Se algum agente estiver parado, use o prompt do item do container dele.', prompt_sugerido: null,
        });
      }
      return R('ok', null, { ultimo_sinal: U.iso(bootMs), evidencia: { horario: U.iso(bootMs), codigo_saida: null, trecho: `ligada há ${U.duracaoCurta(seg * 1000)}` } });
    },
  });

  return tarefas;
}

module.exports = { tarefasDaMaquina };
