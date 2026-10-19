'use strict';
// operacoes-tempo.js: leitura da cadência dos timers do systemd (durações, dias, horários esperados) e cor do ledger.

/** "30min", "1h 30min", "5min", "1d", "2w", "45s" (formato do systemd) em ms. null se não entender. */
function duracaoMs(texto) {
  if (!texto) return null;
  const unidades = {
    us: 1e-3, usec: 1e-3, ms: 1, msec: 1, s: 1000, sec: 1000, second: 1000, seconds: 1000,
    m: 60000, min: 60000, minute: 60000, minutes: 60000,
    h: 3600000, hr: 3600000, hour: 3600000, hours: 3600000,
    d: 86400000, day: 86400000, days: 86400000,
    w: 604800000, week: 604800000, weeks: 604800000,
  };
  let total = 0;
  let achou = false;
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
  let m;
  while ((m = re.exec(String(texto)))) {
    const u = unidades[m[2].toLowerCase()];
    if (!u) return null;
    total += Number(m[1]) * u;
    achou = true;
  }
  return achou && total > 0 ? total : null;
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** "Mon..Fri", "Mon,Wed,Fri", "Sat" num conjunto de dias da semana (0 = domingo). null se não entender. */
function diasDaSemana(texto) {
  const dias = new Set();
  for (const parte of texto.split(',')) {
    const faixa = parte.match(/^([A-Z][a-z]{2})(?:\.\.([A-Z][a-z]{2}))?$/);
    if (!faixa || !(faixa[1] in DOW) || (faixa[2] && !(faixa[2] in DOW))) return null;
    const ini = DOW[faixa[1]];
    const fim = faixa[2] ? DOW[faixa[2]] : ini;
    for (let d = ini; ; d = (d + 1) % 7) {
      dias.add(d);
      if (d === fim) break;
    }
  }
  return dias;
}

/**
 * Os horários em que um timer de CALENDÁRIO devia ter rodado entre `desde` e `ate`.
 *
 * Só entende as formas que o plugin e o persona-cron-mgr realmente escrevem:
 *   *-*-* HH:MM[:SS]            todo dia
 *   Dow[..Dow][,Dow] *-*-* HH:MM  certos dias da semana
 *   *-*-DD HH:MM               um dia fixo do mês
 *   daily / weekly / hourly
 * com ou sem o fuso no fim ("America/Sao_Paulo"). O fuso é ignorado e a hora é
 * lida no horário desta máquina, que é o mesmo do systemd que dispara o timer
 * (o painel roda junto dele, no mesmo container). Qualquer outra forma devolve
 * null, e null quer dizer "não sei", nunca "não devia rodar".
 */
function horariosEsperados(spec, desde, ate) {
  if (!spec) return null;
  let s = String(spec).trim().replace(/\s+(?:[A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?|UTC)$/, '');
  if (s === 'daily') s = '*-*-* 00:00:00';
  if (s === 'weekly') s = 'Mon *-*-* 00:00:00';
  const saida = [];
  if (s === 'hourly') {
    const d = new Date(desde);
    d.setMinutes(0, 0, 0);
    for (let t = d.getTime(); t <= ate; t += 3600000) if (t >= desde) saida.push(t);
    return saida;
  }
  const m = s.match(/^(?:([A-Za-z.,]+)\s+)?\*-\*-(\*|\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const dias = m[1] ? diasDaSemana(m[1]) : null;
  if (m[1] && !dias) return null;
  const diaDoMes = m[2] === '*' ? null : Number(m[2]);
  const [hh, mm, ss] = [Number(m[3]), Number(m[4]), Number(m[5] || 0)];
  const d = new Date(desde);
  d.setHours(0, 0, 0, 0);
  for (; d.getTime() <= ate; d.setDate(d.getDate() + 1)) {
    if (dias && !dias.has(d.getDay())) continue;
    if (diaDoMes != null && d.getDate() !== diaDoMes) continue;
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, ss).getTime();
    if (t >= desde && t <= ate) saida.push(t);
  }
  return saida;
}

/** O intervalo de um timer de intervalo ("cada:30min" das rotinas.js) em ms, ou null. */
function intervaloDoTimer(horario) {
  const m = String(horario || '').match(/^cada:(.+)$/);
  return m ? duracaoMs(m[1]) : null;
}

/** "há 3 min", "há 2 h", "há 3 dias": para a frase de cada operação. */
function haQuanto(ms, agora) {
  const s = Math.max(0, (agora - ms) / 1000);
  if (s < 90) return 'agora há pouco';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400 * 1.5) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dias`;
}

function duracaoHumana(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function listaHumana(nomes) {
  if (nomes.length <= 1) return nomes.join('');
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

// ─── o que o JOB_RESULT quer dizer, em português ──────────────────────────────

const RESULTADO = {
  done: { cor: 'verde', titulo: 'Rodou e deu certo' },
  failed: { cor: 'vermelho', titulo: 'Falhou: o programa terminou com erro' },
  timeout: { cor: 'vermelho', titulo: 'Falhou: passou do tempo máximo e foi interrompida' },
  dependency: { cor: 'vermelho', titulo: 'Não rodou: uma peça de que ela depende falhou antes' },
  canceled: { cor: 'amarelo', titulo: 'Foi cancelada antes de terminar (normalmente por um reinício do sistema)' },
  skipped: { cor: 'amarelo', titulo: 'Não rodou: a condição para começar não foi atendida' },
  assert: { cor: 'vermelho', titulo: 'Não rodou: uma checagem obrigatória falhou' },
  invalid: { cor: 'vermelho', titulo: 'Não rodou: a configuração dela está inválida' },
  unsupported: { cor: 'vermelho', titulo: 'Não rodou: o sistema não sabe executar este tipo de rotina' },
};

/** Status do ledger do pulso traduzido em cor. Desconhecido = null (não muda o quadradinho). */
function corDoLedger(status) {
  const s = String(status || '').toLowerCase();
  if (['erro', 'error', 'fail', 'failed', 'falhou', 'faltou', 'missing'].includes(s)) return 'vermelho';
  if (['aviso', 'atencao', 'atenção', 'warn', 'warning', 'parcial', 'partial', 'pulado', 'skip', 'skipped'].includes(s)) return 'amarelo';
  if (['ok', 'success', 'done', 'rodou', 'completed'].includes(s)) return 'verde';
  return null;
}

module.exports = { duracaoMs, DOW, diasDaSemana, horariosEsperados, intervaloDoTimer, haQuanto, duracaoHumana, listaHumana, RESULTADO, corDoLedger };
