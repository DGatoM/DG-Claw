'use strict';
// Rotinas (timers systemd) de um agente, conferidas por dentro do container com `podman exec`.

const { higienizar } = require('./higiene');
const U = require('./util');

const PROPRIEDADES = 'Id,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,LastTriggerUSec,NextElapseUSecRealtime,TimersCalendar,TimersMonotonic';
const RX_ERRO = /error|erro|falh|fail|traceback|exception|denied|exit/i;
const ATRASO_TOLERADO_MS = 15 * 60 * 1000;
const DIARIO_MS = 26 * 3600 * 1000;

// Nomes em português para quem lê. Os de cadência fixa ficam com a cadência no nome.
const NOMES = {
  reflection: 'Reflexão noturna (consolida a memória do dia)',
  audit: 'Auditoria da reflexão noturna',
  'build-wm': 'Montagem da memória de trabalho (7h)',
  heartbeat: 'Batimento a cada 30 min',
  watchdog: 'Vigia da sessão (5 min)',
  'auto-compact': 'Compactação automática',
  'cron-audit': 'Auditoria das rotinas',
  'pulso-report-1': 'Relatório do pulso (13h)',
  'pulso-report-2': 'Relatório do pulso (19h)',
  'pulso-report-3': 'Relatório do pulso (23h58)',
  'channels-tokens-logger': 'Registro do consumo da sessão (5 min)',
  'cost-alerts': 'Alertas de orçamento (1 h)',
  'poke-verify': 'Conferência dos recados internos (15 min)',
  'conversas-fts': 'Índice da busca em conversas (15 min)',
  'memory-reindex': 'Índice da memória semântica (4h20)',
  monitor: 'Monitor dos cards (5 min)',
};

function nomeAmigavel(nome) {
  if (NOMES[nome]) return NOMES[nome];
  if (nome.startsWith('self-')) return `Rotina própria: ${nome.slice(5)}`;
  return `Rotina ${nome}`;
}

const lista = (v) => (v == null ? [] : [].concat(v));

/** Cadência a partir do que o próprio timer declara. */
function cadenciaDoTimer(t) {
  const mono = lista(t.TimersMonotonic).join(' ');
  const m = mono.match(/OnUnit(?:Active|Inactive)USec=([^;}]+)/);
  if (m) {
    const ms = U.duracaoSystemd(m[1]);
    if (ms) return { tipo: 'intervalo', ms };
  }
  const cal = lista(t.TimersCalendar).join(' ');
  if (/OnCalendar=\*-\*-\* \d{2}:\d{2}(?::\d{2})?\s*;/.test(cal)) return { tipo: 'diaria', ms: DIARIO_MS };
  if (cal) return { tipo: 'calendario', ms: null };
  return { tipo: 'desconhecida', ms: null };
}

function proximaExecucaoMs(t) {
  for (const c of lista(t.TimersCalendar)) {
    const m = String(c).match(/next_elapse=(@\d+|[^}]+?)\s*}/);
    const ms = m ? U.dataSystemd(m[1]) : null;
    if (ms) return ms;
  }
  return U.dataSystemd(t.NextElapseUSecRealtime);
}

function ultimoRegistroDoPulso(ledger, nome) {
  const base = nome.replace(/-\d+$/, '');
  let achado = null;
  for (const r of ledger) if (r.id === nome || r.id === base) achado = r;
  return achado;
}

/** Até 5 linhas do journal que parecem erro, já higienizadas. */
async function linhasDeErro(exec, container, servico) {
  const r = await exec('podman', ['exec', container, 'journalctl', '-u', servico, '-n', '40', '--no-pager', '-o', 'short-iso'], { timeout: 4000 });
  if (r.codigo !== 0) return [];
  return r.stdout.split('\n').filter((l) => RX_ERRO.test(l)).slice(-5).map((l) => higienizar(l, 200)).filter(Boolean);
}

/**
 * Devolve { geral } (um item só, quando não deu para listar) ou { itens: [ { nome(sufixo), titulo, ...resultado } ] }.
 */
async function conferirRotinas(ctx, ag, ledgerP) {
  const { exec, agora, tz, log } = ctx;
  const ctr = ag.container;
  const slug = ag.slug;
  const cmdReparar = `dgclaw agente reparar ${slug}`;
  const agoraMs = agora();

  const lst = await exec('podman', ['exec', ctr, 'systemctl', 'list-units', '--all', '--type=timer', `dgclaw-${slug}-*`, '--plain', '--no-legend'], { timeout: 4500 });
  if (lst.codigo !== 0) {
    log('aviso', `Diagnóstico: não consegui listar os timers de ${slug} em ${ctr} (código ${lst.codigo}, ${lst.erro || 'sem erro de sistema'}): ${higienizar(lst.stderr, 200)}`);
    return { geral: { estado: 'nao_medido', motivo: `Não consegui listar as rotinas dentro do container (${lst.erro === 'timeout' ? 'demorou demais' : `o comando saiu com código ${lst.codigo}`}).`, ultimo_sinal: null, evidencia: { horario: null, codigo_saida: lst.codigo, trecho: higienizar(lst.stderr, 160) || null }, o_que_fazer: null, prompt_sugerido: null } };
  }
  const rx = new RegExp(`^dgclaw-${slug}-[a-z0-9-]+\\.timer$`);
  const timers = lst.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => u && rx.test(u) && U.RX_UNIT.test(u));
  if (!timers.length) {
    return { geral: {
      estado: 'quebrado',
      motivo: `Não há nenhuma rotina automática instalada para ${ag.nome}. Sem elas a memória não é consolidada e o vigia da sessão não roda.`,
      ultimo_sinal: null, evidencia: null,
      o_que_fazer: U.ONDE_COLAR,
      prompt_sugerido: U.promptAdmin(`o agente ${ag.nome} está sem nenhuma rotina automática (timers dgclaw-${slug}-*) dentro do container.`, `\`podman exec dgclaw-${slug} systemctl list-timers --all\``, cmdReparar),
    } };
  }
  const unidades = timers.flatMap((t) => [t, t.replace(/\.timer$/, '.service')]);
  const show = await exec('podman', ['exec', ctr, 'systemctl', 'show', '--timestamp=unix', ...unidades, '-p', PROPRIEDADES], { timeout: 4500 });
  if (show.codigo !== 0) {
    log('aviso', `Diagnóstico: o systemctl show de ${slug} falhou (código ${show.codigo}): ${higienizar(show.stderr, 200)}`);
    return { geral: { estado: 'nao_medido', motivo: 'Listei as rotinas, mas não consegui ler o estado delas dentro do container.', ultimo_sinal: null, evidencia: { horario: null, codigo_saida: show.codigo, trecho: higienizar(show.stderr, 160) || null }, o_que_fazer: null, prompt_sugerido: null } };
  }
  const props = U.lerShow(show.stdout);
  const ledger = await ledgerP();
  const itens = [];

  for (const unidadeTimer of timers) {
    const nome = unidadeTimer.slice(`dgclaw-${slug}-`.length, -'.timer'.length);
    const servico = unidadeTimer.replace(/\.timer$/, '.service');
    const t = props[unidadeTimer];
    const s = props[servico] || {};
    const titulo = `${nomeAmigavel(nome)} - ${ag.nome}`;
    const item = { sufixo: nome, nome: titulo };
    if (!t) {
      itens.push(Object.assign(item, { estado: 'nao_medido', motivo: 'O systemd não devolveu o estado desta rotina.', ultimo_sinal: null, evidencia: null, o_que_fazer: null, prompt_sugerido: null }));
      continue;
    }
    const cad = cadenciaDoTimer(t);
    const ultimoMs = Math.max(U.dataSystemd(s.ExecMainStartTimestamp) || 0, U.dataSystemd(t.LastTriggerUSec) || 0) || null;
    const proxMs = proximaExecucaoMs(t);
    const pulso = ultimoRegistroDoPulso(ledger, nome);
    const falhaPulso = pulso && /^(erro|error|falha|fail)/i.test(pulso.status) ? pulso : null;
    const evidenciaPulso = falhaPulso ? higienizar(falhaPulso.detalhe, 160) : '';
    const fixTexto = (viu, comando) => ({ o_que_fazer: U.ONDE_COLAR, prompt_sugerido: U.promptAdmin(viu, `\`podman exec dgclaw-${slug} systemctl status ${servico}\``, comando) });

    if (t.ActiveState !== 'active') {
      itens.push(Object.assign(item, {
        estado: 'quebrado', motivo: `A rotina está desligada (o timer está "${higienizar(t.ActiveState, 20)}"), então ela não roda mais.`,
        ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(ultimoMs), codigo_saida: null, trecho: `timer ${higienizar(t.ActiveState, 20)}` },
      }, fixTexto(`a rotina "${nomeAmigavel(nome)}" do agente ${ag.nome} está desligada.`, cmdReparar)));
      continue;
    }
    if ((s.Result && s.Result !== 'success') || s.ActiveState === 'failed') {
      const codigo = s.ExecMainStatus !== undefined && /^\d+$/.test(s.ExecMainStatus) ? Number(s.ExecMainStatus) : null;
      const linhas = await linhasDeErro(exec, ctr, servico);
      if (evidenciaPulso) linhas.push(`pulso: ${evidenciaPulso}`);
      const fim = U.dataSystemd(s.ExecMainExitTimestamp) || ultimoMs;
      itens.push(Object.assign(item, {
        estado: 'quebrado',
        motivo: `A última execução falhou${fim ? ` (${U.quando(fim, tz)})` : ''}: resultado "${higienizar(s.Result || s.ActiveState, 30)}"${codigo != null ? `, código de saída ${codigo}` : ''}.`,
        ultimo_sinal: U.iso(ultimoMs),
        evidencia: { horario: U.iso(fim), codigo_saida: codigo, trecho: linhas.length ? linhas.join('\n') : null },
      }, fixTexto(`a rotina "${nomeAmigavel(nome)}" do agente ${ag.nome} falhou na última execução (resultado ${higienizar(s.Result || s.ActiveState, 30)}${codigo != null ? `, código ${codigo}` : ''}).`, cmdReparar)));
      continue;
    }
    if (proxMs && agoraMs - proxMs > ATRASO_TOLERADO_MS) {
      itens.push(Object.assign(item, {
        estado: 'atencao', motivo: `Deveria ter rodado ${U.quando(proxMs, tz)} e não rodou.`,
        ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(proxMs), codigo_saida: null, trecho: 'próxima execução marcada no passado' },
      }, fixTexto(`a rotina "${nomeAmigavel(nome)}" do agente ${ag.nome} deveria ter rodado ${U.quando(proxMs, tz)} e não rodou.`, cmdReparar)));
      continue;
    }
    if (ultimoMs == null) {
      itens.push(Object.assign(item, { estado: 'nao_medido', motivo: 'Ainda não rodou desde que foi instalada (ou desde a última vez que o container foi iniciado).', ultimo_sinal: null, evidencia: null, o_que_fazer: null, prompt_sugerido: null }));
      continue;
    }
    if (cad.ms && agoraMs - ultimoMs > (cad.tipo === 'diaria' ? cad.ms : 2 * cad.ms + ATRASO_TOLERADO_MS)) {
      itens.push(Object.assign(item, {
        estado: 'atencao', motivo: `A última execução foi ${U.quando(ultimoMs, tz)}, há ${U.duracaoCurta(agoraMs - ultimoMs)}, mais do que o intervalo desta rotina permite.`,
        ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(ultimoMs), codigo_saida: null, trecho: null },
      }, fixTexto(`a rotina "${nomeAmigavel(nome)}" do agente ${ag.nome} não roda desde ${U.quando(ultimoMs, tz)}.`, cmdReparar)));
      continue;
    }
    if (falhaPulso) {
      itens.push(Object.assign(item, {
        estado: 'atencao', motivo: 'O systemd diz que a rotina rodou bem, mas o registro do pulso anotou um erro dela.',
        ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(Date.parse(falhaPulso.ts) || null), codigo_saida: null, trecho: evidenciaPulso || null },
      }, fixTexto(`a rotina "${nomeAmigavel(nome)}" do agente ${ag.nome} registrou erro no pulso.`, cmdReparar)));
      continue;
    }
    itens.push(Object.assign(item, { estado: 'ok', motivo: null, ultimo_sinal: U.iso(ultimoMs), evidencia: null, o_que_fazer: null, prompt_sugerido: null }));
  }
  return { itens };
}

module.exports = { conferirRotinas, nomeAmigavel, cadenciaDoTimer };
