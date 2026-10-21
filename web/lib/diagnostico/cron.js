'use strict';
// Rotinas (timers systemd) de um agente, conferidas por dentro do container com `podman exec`.

const { higienizar } = require('./higiene');
const { classificar } = require('./classificar');
const U = require('./util');

const PROPRIEDADES = 'Id,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,LastTriggerUSec,NextElapseUSecRealtime,TimersCalendar,TimersMonotonic';
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

// O sufixo vem do nome da unit que o container informou: só entra se tiver o formato de slug.
function nomeAmigavel(nome) {
  if (NOMES[nome]) return NOMES[nome];
  if (nome.startsWith('self-')) return `Rotina própria: ${nome.slice(5)}`;
  return `Rotina ${nome}`;
}

const lista = (v) => (v == null ? [] : [].concat(v));

/** Valor logo depois de `chave` até ';' ou '}' (no máximo 64 caracteres), ou null. Sem regex. */
function valorApos(texto, chave) {
  const i = texto.indexOf(chave);
  if (i < 0) return null;
  const ini = i + chave.length;
  const max = Math.min(texto.length, ini + 64);
  let fim = ini;
  while (fim < max && texto[fim] !== ';' && texto[fim] !== '}') fim += 1;
  return texto.slice(ini, fim);
}

/** O valor tem a forma "OnCalendar=*-*-* HH:MM[:SS] ;" (uma vez por dia)? Cada valor já vem cortado em 200 caracteres. */
function temCalendarioDiario(valor) {
  const chave = 'OnCalendar=*-*-* ';
  const dig = (k) => valor.charCodeAt(k) >= 48 && valor.charCodeAt(k) <= 57;
  for (let i = valor.indexOf(chave); i >= 0; i = valor.indexOf(chave, i + 1)) {
    let p = i + chave.length;
    if (!(dig(p) && dig(p + 1) && valor[p + 2] === ':' && dig(p + 3) && dig(p + 4))) continue;
    p += 5;
    if (valor[p] === ':' && dig(p + 1) && dig(p + 2)) p += 3;
    while (valor[p] === ' ' || valor[p] === '\t') p += 1;
    if (valor[p] === ';') return true;
  }
  return false;
}

/** Cadência a partir do que o próprio timer declara. */
function cadenciaDoTimer(t) {
  const mono = lista(t.TimersMonotonic).map((v) => String(v).slice(0, U.MAX_VALOR_PROP)).join(' ');
  const ativo = mono.indexOf('OnUnitActiveUSec=');
  const inativo = mono.indexOf('OnUnitInactiveUSec=');
  const primeiro = ativo >= 0 && (inativo < 0 || ativo < inativo) ? 'OnUnitActiveUSec=' : (inativo >= 0 ? 'OnUnitInactiveUSec=' : null);
  if (primeiro) {
    const ms = U.duracaoSystemd(valorApos(mono, primeiro));
    if (ms) return { tipo: 'intervalo', ms };
  }
  const valoresCal = lista(t.TimersCalendar).map((v) => String(v).slice(0, U.MAX_VALOR_PROP));
  if (valoresCal.some(temCalendarioDiario)) return { tipo: 'diaria', ms: DIARIO_MS };
  if (valoresCal.length) return { tipo: 'calendario', ms: null };
  return { tipo: 'desconhecida', ms: null };
}

function proximaExecucaoMs(t) {
  const chave = 'next_elapse=';
  for (const c of lista(t.TimersCalendar)) {
    const v = String(c).slice(0, U.MAX_VALOR_PROP);
    const i = v.indexOf(chave);
    if (i < 0) continue;
    const ini = i + chave.length;
    let fim = v.indexOf('}', ini);
    if (fim < 0) fim = v.length;
    const ms = U.dataSystemd(v.slice(ini, Math.min(fim, ini + 64)));
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

/** Categorias dos erros recentes do journal da unit (nenhuma linha sai, só a classificação). */
async function ocorrenciasDoJournal(rodar, container, servico) {
  const r = await rodar(['exec', container, 'journalctl', '-u', servico, '-n', '40', '--no-pager', '-o', 'short-iso'], 4000);
  if (r.codigo !== 0) return [];
  return classificar(r.stdout);
}

const SEM_VALOR = { ultimo_sinal: null, evidencia: null, o_que_fazer: null, prompt_sugerido: null };

const PRAZO_PADRAO_MS = 5000;
const MAX_TIMERS = 200;

/**
 * Devolve { geral } (um item só, quando não deu para listar) ou { itens: [ { nome(sufixo), titulo, ...resultado } ] }.
 */
async function conferirRotinas(ctx, ag, ledgerP, prazoDado) {
  const prazo = prazoDado || U.criarPrazo(PRAZO_PADRAO_MS);
  try { return await conferir(ctx, ag, ledgerP, prazo); } finally { if (!prazoDado) prazo.encerrar(); }
}

async function conferir(ctx, ag, ledgerP, prazo) {
  const { agora, tz, log } = ctx;
  // Nenhum subprocesso começa depois que o prazo venceu; os que estão rodando recebem o signal e morrem.
  const rodar = (args, timeout) => {
    if (prazo.expirou()) return Promise.resolve({ codigo: null, stdout: '', stderr: '', erro: 'prazo' });
    return ctx.exec('podman', args, { timeout: Math.max(1, Math.min(timeout, Math.ceil(prazo.restanteMs()))), prazo, signal: prazo.signal });
  };
  const PAROU = `Parei de conferir as rotinas porque ${U.PARADO_POR_TEMPO}.`;
  const ctr = ag.container;
  const slug = ag.slug;
  const cmdReparar = `dgclaw agente reparar ${slug}`;
  const agoraMs = agora();

  const lst = await rodar(['exec', ctr, 'systemctl', 'list-units', '--all', '--type=timer', `dgclaw-${slug}-*`, '--plain', '--no-legend'], 4500);
  if (lst.codigo !== 0) {
    log('aviso', `Diagnóstico: não consegui listar os timers de ${slug} em ${ctr} (código ${lst.codigo}, ${lst.erro || 'sem erro de sistema'}): ${higienizar(lst.stderr, 200)}`);
    return { geral: { estado: 'nao_medido', motivo: `Não consegui listar as rotinas dentro do container (${U.demorou(lst) ? 'demorou demais' : `o comando saiu com código ${U.codigoDeSaida(lst.codigo) ?? 'desconhecido'}`}).`, ultimo_sinal: null, evidencia: { horario: null, codigo_saida: U.codigoDeSaida(lst.codigo), ocorrencias: classificar(lst.stderr, { soErros: false }) }, o_que_fazer: null, prompt_sugerido: null } };
  }
  // A lista vem do container. Só passa nome de unit no formato dgclaw-<slug>-<nome>.timer com <nome> em formato de slug.
  const prefixo = `dgclaw-${slug}-`;
  // Cada linha é cortada antes de olhar a primeira palavra; units repetidas valem uma vez (a primeira) e o teto é de 200.
  const vistos = new Set();
  const timers = [];
  for (const l of U.linhasLimitadas(lst.stdout, 200)) {
    if (timers.length >= MAX_TIMERS) break;
    const u = U.primeiroToken(l);
    if (!u || vistos.has(u) || !U.RX_UNIT.test(u) || !u.startsWith(prefixo) || !u.endsWith('.timer')) continue;
    if (!U.RX_NOME_SEGURO.test(u.slice(prefixo.length, -'.timer'.length))) continue;
    vistos.add(u);
    timers.push(u);
  }
  if (!timers.length) {
    return { geral: {
      estado: 'quebrado',
      motivo: `Não há nenhuma rotina automática instalada para ${ag.nome}. Sem elas a memória não é consolidada e o vigia da sessão não roda.`,
      ultimo_sinal: null, evidencia: null,
      o_que_fazer: U.ONDE_COLAR,
      prompt_sugerido: U.promptAdmin(`o agente ${slug} está sem nenhuma rotina automática (timers dgclaw-${slug}-*) dentro do container.`, `\`podman exec dgclaw-${slug} systemctl list-timers --all\``, cmdReparar),
    } };
  }
  const unidades = timers.flatMap((t) => [t, t.replace(/\.timer$/, '.service')]);
  const show = await rodar(['exec', ctr, 'systemctl', 'show', '--timestamp=unix', ...unidades, '-p', PROPRIEDADES], 4500);
  if (show.codigo !== 0) {
    log('aviso', `Diagnóstico: o systemctl show de ${slug} falhou (código ${show.codigo}, ${show.erro || 'sem erro de sistema'}): ${higienizar(show.stderr, 200)}`);
    return { geral: { estado: 'nao_medido', motivo: `Listei as rotinas, mas não consegui ler o estado delas dentro do container${U.demorou(show) ? ' (demorou demais)' : ''}.`, ultimo_sinal: null, evidencia: { horario: null, codigo_saida: U.codigoDeSaida(show.codigo), ocorrencias: classificar(show.stderr, { soErros: false }) }, o_que_fazer: null, prompt_sugerido: null } };
  }
  const props = U.lerShow(show.stdout);
  const ledger = await ledgerP();
  const itens = [];

  for (const unidadeTimer of timers) {
    const nome = unidadeTimer.slice(prefixo.length, -'.timer'.length);
    const servico = unidadeTimer.replace(/\.timer$/, '.service');
    const t = props[unidadeTimer];
    const s = props[servico] || {};
    const titulo = `${nomeAmigavel(nome)} - ${ag.nome}`;
    const item = { sufixo: nome, nome: titulo };
    if (prazo.expirou()) {
      itens.push(Object.assign(item, { estado: 'nao_medido', motivo: PAROU }, SEM_VALOR));
      continue;
    }
    if (!t) {
      itens.push(Object.assign(item, { estado: 'nao_medido', motivo: 'O systemd não devolveu o estado desta rotina.' }, SEM_VALOR));
      continue;
    }
    const ativoTimer = U.dentro(t.ActiveState, U.ENUMS.ativo);
    const ativoServico = s.ActiveState === undefined ? null : U.dentro(s.ActiveState, U.ENUMS.ativo);
    const resultado = s.Result === undefined || s.Result === '' ? null : U.dentro(s.Result, U.ENUMS.resultado);
    if (!ativoTimer || (s.ActiveState !== undefined && !ativoServico) || (s.Result !== undefined && s.Result !== '' && !resultado)) {
      log('aviso', `Diagnóstico: o systemd do container de ${slug} devolveu, para ${unidadeTimer}, um estado fora da lista conhecida (ActiveState/Result). O valor não foi usado no diagnóstico.`);
      itens.push(Object.assign(item, { estado: 'atencao', motivo: `Não consegui avaliar esta rotina: ${U.INESPERADO} para o estado dela.` }, SEM_VALOR, { o_que_fazer: 'Mostre este item ao suporte, que vai conferir a rotina por dentro do container.' }));
      continue;
    }
    const cad = cadenciaDoTimer(t);
    const ultimoMs = Math.max(U.dataSystemd(s.ExecMainStartTimestamp) || 0, U.dataSystemd(t.LastTriggerUSec) || 0) || null;
    const proxMs = proximaExecucaoMs(t);
    const pulso = ultimoRegistroDoPulso(ledger, nome);
    const falhaPulso = pulso && /^(erro|error|falha|fail)/i.test(pulso.status) ? pulso : null;
    const ocorrenciasPulso = falhaPulso ? classificar(falhaPulso.detalhe, { soErros: false, fallbackMs: Date.parse(falhaPulso.ts) || null }) : [];
    const fixTexto = (viu, comando) => ({ o_que_fazer: U.ONDE_COLAR, prompt_sugerido: U.promptAdmin(viu, `\`podman exec dgclaw-${slug} systemctl status ${servico}\``, comando) });
    const rotina = `a rotina "${nomeAmigavel(nome)}" do agente ${slug}`;

    if (ativoTimer !== 'active') {
      itens.push(Object.assign(item, {
        estado: 'quebrado', motivo: `A rotina está desligada (o timer está "${ativoTimer}"), então ela não roda mais.`,
        ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(ultimoMs), codigo_saida: null, sinal: `timer ${ativoTimer}` },
      }, fixTexto(`${rotina} está desligada.`, cmdReparar)));
      continue;
    }
    if ((resultado && resultado !== 'success') || ativoServico === 'failed') {
      const codigo = U.codigoDeSaida(s.ExecMainStatus);
      const ocorrencias = [...await ocorrenciasDoJournal(rodar, ctr, servico), ...ocorrenciasPulso];
      const fim = U.dataSystemd(s.ExecMainExitTimestamp) || ultimoMs;
      const quanto = resultado || ativoServico;
      itens.push(Object.assign(item, {
        estado: 'quebrado',
        motivo: `A última execução falhou${fim ? ` (${U.quando(fim, tz)})` : ''}: resultado "${quanto}"${codigo != null ? `, código de saída ${codigo}` : ''}.`,
        ultimo_sinal: U.iso(ultimoMs),
        evidencia: { horario: U.iso(fim), codigo_saida: codigo, sinal: `resultado ${quanto}`, ocorrencias },
      }, fixTexto(`${rotina} falhou na última execução (resultado ${quanto}${codigo != null ? `, código ${codigo}` : ''}).`, cmdReparar)));
      continue;
    }
    if (proxMs && agoraMs - proxMs > ATRASO_TOLERADO_MS) {
      itens.push(Object.assign(item, {
        estado: 'atencao', motivo: `Deveria ter rodado ${U.quando(proxMs, tz)} e não rodou.`,
        ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(proxMs), codigo_saida: null, sinal: 'próxima execução marcada no passado' },
      }, fixTexto(`${rotina} deveria ter rodado ${U.quando(proxMs, tz)} e não rodou.`, cmdReparar)));
      continue;
    }
    if (ultimoMs == null) {
      itens.push(Object.assign(item, { estado: 'nao_medido', motivo: 'Ainda não rodou desde que foi instalada (ou desde a última vez que o container foi iniciado).' }, SEM_VALOR));
      continue;
    }
    if (cad.ms && agoraMs - ultimoMs > (cad.tipo === 'diaria' ? cad.ms : 2 * cad.ms + ATRASO_TOLERADO_MS)) {
      itens.push(Object.assign(item, {
        estado: 'atencao', motivo: `A última execução foi ${U.quando(ultimoMs, tz)}, há ${U.duracaoCurta(agoraMs - ultimoMs)}, mais do que o intervalo desta rotina permite.`,
        ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(ultimoMs), codigo_saida: null },
      }, fixTexto(`${rotina} não roda desde ${U.quando(ultimoMs, tz)}.`, cmdReparar)));
      continue;
    }
    if (falhaPulso) {
      itens.push(Object.assign(item, {
        estado: 'atencao', motivo: 'O systemd diz que a rotina rodou bem, mas o registro do pulso anotou um erro dela.',
        ultimo_sinal: U.iso(ultimoMs), evidencia: { horario: U.iso(Date.parse(falhaPulso.ts) || null), codigo_saida: null, ocorrencias: ocorrenciasPulso },
      }, fixTexto(`${rotina} registrou erro no pulso.`, cmdReparar)));
      continue;
    }
    itens.push(Object.assign(item, { estado: 'ok', motivo: null }, SEM_VALOR, { ultimo_sinal: U.iso(ultimoMs) }));
  }
  return { itens };
}

module.exports = { conferirRotinas, nomeAmigavel, cadenciaDoTimer, proximaExecucaoMs };
