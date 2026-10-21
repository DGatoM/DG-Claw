'use strict';
// Peças pequenas do diagnóstico: executar comando sem shell, tempo limite, datas do systemd e montagem das verificações.

const { execFile } = require('node:child_process');

const RX_NOME_SEGURO = /^[a-z0-9][a-z0-9-]{0,40}$/;
const RX_UNIT = /^dgclaw-[a-z0-9][a-z0-9-]{0,80}\.(?:timer|service)$/;

/** Roda um comando SEM shell. Nunca rejeita: devolve { codigo, stdout, stderr, erro }. */
function execPadrao(cmd, args, opcoes) {
  const timeout = (opcoes && opcoes.timeout) || 5000;
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (!err) { resolve({ codigo: 0, stdout, stderr, erro: null }); return; }
      resolve({
        codigo: typeof err.code === 'number' ? err.code : null,
        stdout: stdout || '',
        stderr: stderr || '',
        erro: err.killed ? 'timeout' : (typeof err.code === 'string' ? err.code : null),
      });
    });
  });
}

/** Resolve com o resultado de `promessa` ou com { estourou:true } depois de `ms`. */
function comLimite(promessa, ms) {
  let t;
  const espera = new Promise((resolve) => { t = setTimeout(() => resolve({ estourou: true }), ms); });
  return Promise.race([Promise.resolve(promessa).then((valor) => ({ valor })), espera]).finally(() => clearTimeout(t));
}

/** "Wed 2026-10-21 09:11:30 -03", "@1792549819" ou "n/a" para milissegundos; null se não der para ler com certeza. */
function dataSystemd(texto) {
  if (typeof texto !== 'string') return null;
  const s = texto.trim();
  if (!s || s === 'n/a' || s === '0') return null;
  if (/^@\d+$/.test(s)) return Number(s.slice(1)) * 1000;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)? ?(UTC|GMT|Z|[+-]\d{2}(?::?\d{2})?)?$/);
  if (!m) return null;
  let desloc = 0;
  if (m[7] && !/^(UTC|GMT|Z)$/.test(m[7])) {
    const d = m[7].replace(':', '');
    const sinal = d[0] === '-' ? -1 : 1;
    desloc = sinal * (Number(d.slice(1, 3)) * 60 + Number(d.slice(3, 5) || 0));
  } else if (!m[7]) {
    return null; // sem fuso (ou abreviação como BRT): não dá para saber o instante com certeza
  }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - desloc * 60000;
}

const UNIDADES_MS = { us: 0.001, ms: 1, s: 1000, sec: 1000, min: 60000, m: 60000, h: 3600000, hr: 3600000, d: 86400000, w: 604800000, month: 2592000000, y: 31557600000 };
/** "1h 30min" -> milissegundos; null se não entender. */
function duracaoSystemd(texto) {
  if (typeof texto !== 'string') return null;
  let total = 0;
  let achou = false;
  for (const m of texto.matchAll(/(\d+(?:\.\d+)?)\s*(us|ms|sec|s|min|m|hr|h|d|w|month|y)\b/g)) {
    total += Number(m[1]) * UNIDADES_MS[m[2]];
    achou = true;
  }
  return achou ? total : null;
}

/** Saída de `systemctl show` com várias units: { <Id>: { Chave: valor | [valores] } }. */
function lerShow(saida) {
  const porId = {};
  for (const bloco of String(saida || '').split(/\n\s*\n/)) {
    const props = {};
    for (const linha of bloco.split('\n')) {
      const i = linha.indexOf('=');
      if (i <= 0) continue;
      const k = linha.slice(0, i);
      const v = linha.slice(i + 1);
      if (k in props) props[k] = [].concat(props[k], v);
      else props[k] = v;
    }
    if (props.Id) porId[props.Id] = props;
  }
  return porId;
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z') : null);

/** "20/10 às 00h10" no fuso da instalação. */
function quando(ms, tz) {
  if (!Number.isFinite(ms)) return 'horário desconhecido';
  const partes = new Intl.DateTimeFormat('pt-BR', { timeZone: tz || 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  return `${partes.day}/${partes.month} às ${partes.hour}h${partes.minute}`;
}

/** "3 h 20 min", "12 min", "2 dias". */
function duracaoCurta(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} dias`;
}

/** Texto que o cliente cola na conversa do Admin. Primeira pessoa do cliente. */
function promptAdmin(viu, conferir, comando) {
  return `Oi, Admin. Rodei o diagnóstico do meu DG Claw e ele apontou isto: ${viu} `
    + `Por favor confira se está mesmo assim (${conferir}) e conserte. O comando provável é \`${comando}\`. `
    + 'Quando terminar, me diga o que encontrou, o que fez e se voltou a funcionar.';
}
const ONDE_COLAR = 'Cole o texto do prompt_sugerido na conversa do Admin no DG Claw e envie. O Admin confere e conserta.';

module.exports = {
  RX_NOME_SEGURO, RX_UNIT, execPadrao, comLimite, dataSystemd, duracaoSystemd, lerShow, iso, quando, duracaoCurta, promptAdmin, ONDE_COLAR,
};

/** Resultado de uma verificação com todos os campos no lugar. */
function R(estado, motivo, extra) {
  return Object.assign({ estado, motivo: motivo || null, ultimo_sinal: null, evidencia: null, o_que_fazer: null, prompt_sugerido: null }, extra || {});
}
/** Os dois campos de "o que fazer" para um problema que o Admin resolve. */
function conserta(viu, conferir, comando) {
  return { o_que_fazer: ONDE_COLAR, prompt_sugerido: promptAdmin(viu, conferir, comando) };
}
module.exports.R = R;
module.exports.conserta = conserta;
