'use strict';
// Peças pequenas do diagnóstico: executar comando sem shell, tempo limite, datas do systemd e montagem das verificações.

const { execFile } = require('node:child_process');

const RX_NOME_SEGURO = /^[a-z0-9][a-z0-9-]{0,40}$/;
const RX_UNIT = /^dgclaw-[a-z0-9-]{1,60}\.(?:timer|service)$/;

// Tudo o que vem do container, de arquivo da casa do agente ou de comando precisa passar por uma enumeração
// fechada ou por um formato estrito antes de entrar em qualquer texto. Fora da lista vira null.
const INESPERADO = 'o sistema devolveu um valor inesperado';
const ENUMS = {
  load: ['loaded', 'not-found', 'error', 'masked', 'bad-setting', 'stub', 'merged'],
  ativo: ['active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance', 'refreshing'],
  sub: ['dead', 'running', 'exited', 'failed', 'waiting', 'start', 'start-pre', 'start-post', 'start-chown', 'condition', 'reload', 'stop', 'stop-watchdog', 'stop-sigterm', 'stop-sigkill', 'stop-post', 'final-watchdog', 'final-sigterm', 'final-sigkill', 'auto-restart', 'auto-restart-queued', 'cleaning', 'elapsed', 'listening', 'mounted', 'abandoned', 'active'],
  resultado: ['success', 'protocol', 'timeout', 'exit-code', 'signal', 'core-dump', 'watchdog', 'start-limit-hit', 'resources', 'oom-kill', 'exec-condition', 'condition', 'skipped', 'dependency', 'clean'],
  container: ['created', 'running', 'paused', 'exited', 'stopped', 'stopping', 'configured', 'initialized', 'removing', 'dead', 'unknown'],
  politica: ['no', 'always', 'on-failure', 'unless-stopped'],
  tipoSaude: ['ok', 'recusa', 'login', 'limite', 'sobrecarga', 'contexto', 'sem_resposta', 'erro_api', 'sessao_caida', 'desconhecido'],
  estadoSaude: ['ativo', 'inativo', 'atencao', 'indeterminado'],
  statusRunner: ['spawning', 'working', 'waiting_input', 'idle', 'completed', 'errored', 'stopped', 'resumable'],
  razaoRunner: ['runner:login-expirado', 'runner:sem-login', 'runner:sem-chave', 'runner:identidade-grande', 'runner:dialogo-bypass', 'runner:login-por-chave-falhou', 'hook:SessionStart', 'hook:PreCompact', 'hook:StopFailure rate_limit', 'transcript:turno encerrado sem o hook Stop'],
  ponteWhatsapp: ['conectado', 'deslogado', 'erro', 'reconectando', 'aguardando_codigo', 'codigo_pronto', 'pareado', 'desligado'],
};
/** O valor, se estiver na lista; senão null. */
function dentro(valor, lista) {
  return typeof valor === 'string' && lista.includes(valor) ? valor : null;
}
/** Inteiro de 0 a 255 (código de saída) a partir de texto ou número; senão null. */
function codigoDeSaida(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

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

// Tetos para texto que vem de fora (container, systemd, podman). Nada abaixo roda sobre texto sem passar por eles.
const MAX_SAIDA_BYTES = 256 * 1024;
const MAX_SAIDA_LINHAS = 4000;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_VALORES_POR_PROP = 20;
const MAX_BLOCOS_SHOW = 200;
// Só as propriedades que algum coletor lê (cron.js e maquina.js). O resto da saída é ignorado.
const PROPS_SHOW = new Set(['Id', 'LoadState', 'ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'ExecMainStartTimestamp', 'ActiveEnterTimestamp', 'ExecMainExitTimestamp', 'LastTriggerUSec', 'NextElapseUSecRealtime', 'TimersCalendar', 'TimersMonotonic', 'OnUnitActiveUSec']);

/** Corta o texto em MAX_SAIDA_BYTES e devolve no máximo MAX_SAIDA_LINHAS linhas (cada uma com até 2000 caracteres). */
function linhasLimitadas(saida) {
  const texto = String(saida == null ? '' : saida).slice(0, MAX_SAIDA_BYTES);
  const linhas = [];
  let ini = 0;
  while (ini <= texto.length && linhas.length < MAX_SAIDA_LINHAS) {
    let fim = texto.indexOf('\n', ini);
    if (fim === -1) fim = texto.length;
    linhas.push(texto.slice(ini, Math.min(fim, ini + 2000 + 100)));
    ini = fim + 1;
  }
  return linhas;
}

/** JSON.parse com teto de tamanho: texto maior que o teto vira null (quem chama trata como formato desconhecido). */
function jsonLimitado(texto) {
  if (typeof texto !== 'string' || texto.length > MAX_JSON_BYTES) return null;
  try { return JSON.parse(texto); } catch (_) { return null; }
}

/**
 * Saída de `systemctl show` com várias units: { <Id>: { Chave: valor | [valores] } }.
 * Custo linear: texto cortado antes, lista fechada de propriedades, no máximo 20 valores por propriedade e 200 units.
 */
function lerShow(saida) {
  const porId = Object.create(null);
  let blocos = 0;
  let props = Object.create(null);
  const fecha = () => {
    if (props.Id && typeof props.Id === 'string') porId[props.Id] = props;
    props = Object.create(null);
  };
  for (const linha of linhasLimitadas(saida)) {
    if (!linha.trim()) {
      if (Object.keys(props).length) { fecha(); blocos += 1; if (blocos >= MAX_BLOCOS_SHOW) return porId; }
      continue;
    }
    const i = linha.indexOf('=');
    if (i <= 0) continue;
    const k = linha.slice(0, i);
    if (!PROPS_SHOW.has(k)) continue;
    const v = linha.slice(i + 1, i + 1 + 2000);
    const atual = props[k];
    if (atual === undefined) props[k] = v;
    else if (Array.isArray(atual)) { if (atual.length < MAX_VALORES_POR_PROP) atual.push(v); }
    else props[k] = [atual, v];
  }
  if (Object.keys(props).length) fecha();
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
  INESPERADO, ENUMS, dentro, codigoDeSaida, RX_NOME_SEGURO, RX_UNIT, execPadrao, comLimite, dataSystemd, duracaoSystemd, lerShow, linhasLimitadas, jsonLimitado, iso, quando, duracaoCurta, promptAdmin, ONDE_COLAR,
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
