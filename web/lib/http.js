'use strict';
// Utilidades de HTTP usadas por todo o servidor: resposta JSON, corpo, cookies,
// IP do cliente e esquema/host do pedido (com confiança só em proxy local).

const net = require('node:net');

const LOOPBACK = new Set(['127.0.0.1', '::1']);

function normalizaIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  return s;
}

/** A conexão veio de um proxy em que podemos confiar (loopback ou lista configurada)? */
function vemDeProxyConfiavel(req, confiaveis) {
  const ip = normalizaIp(req.socket && req.socket.remoteAddress);
  return LOOPBACK.has(ip) || (confiaveis && confiaveis.has(ip));
}

/** IP do cliente. X-Forwarded-For só vale (e só o ÚLTIMO valor) quando o pedido vem de proxy confiável. */
function ipDoPedido(req, confiaveis) {
  const direto = normalizaIp(req.socket && req.socket.remoteAddress) || 'desconhecido';
  if (!vemDeProxyConfiavel(req, confiaveis)) return direto;
  const xff = req.headers['x-forwarded-for'];
  if (!xff) return direto;
  const partes = String(xff).split(',').map((p) => p.trim()).filter(Boolean);
  return partes.length ? normalizaIp(partes[partes.length - 1]) : direto;
}

function esquemaDoPedido(req, confiaveis) {
  if (vemDeProxyConfiavel(req, confiaveis)) {
    const p = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (p === 'https') return 'https';
  }
  return 'http';
}

function hostDoPedido(req, confiaveis) {
  if (vemDeProxyConfiavel(req, confiaveis) && req.headers['x-forwarded-host']) {
    return String(req.headers['x-forwarded-host']).split(',')[0].trim();
  }
  return String(req.headers.host || '').trim();
}

/** A origem do próprio Web como o navegador a vê: esquema://host. */
function origemPropria(req, confiaveis) {
  return `${esquemaDoPedido(req, confiaveis)}://${hostDoPedido(req, confiaveis)}`;
}

function enviaJson(res, status, corpo, cabecalhos) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
  }, cabecalhos || {}));
  res.end(texto);
}

/** Erro padrão da API: { ok:false, erro:"motivo em português" } com o status certo. */
function erroJson(res, status, motivo, extra, cabecalhos) {
  enviaJson(res, status, Object.assign({ ok: false, erro: motivo }, extra || {}), cabecalhos);
}

function escapaHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Página de erro mínima, em português, para quem abriu o endereço no navegador. */
function paginaErro(res, status, titulo, motivo, cabecalhos) {
  const html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapaHtml(titulo)}</title>` +
    '<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#222}' +
    'h1{font-size:1.3rem}a{color:#1a56db}</style></head><body>' +
    `<h1>${escapaHtml(titulo)}</h1><p>${escapaHtml(motivo)}</p><p><a href="/">Voltar ao início</a></p></body></html>`;
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  }, cabecalhos || {}));
  res.end(html);
}

/** Lê o corpo inteiro até `max` bytes. Passou disso: rejeita com { status: 413 }. */
function lerCorpo(req, max) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    let acabou = false;
    req.on('data', (c) => {
      if (acabou) return;
      total += c.length;
      if (total > max) {
        acabou = true;
        const e = new Error(`O corpo do pedido passou de ${max} bytes.`);
        e.status = 413;
        // esvazia o resto sem guardar, para a resposta de erro conseguir sair
        req.resume();
        reject(e);
        return;
      }
      pedacos.push(c);
    });
    req.on('end', () => { if (!acabou) { acabou = true; resolve(Buffer.concat(pedacos)); } });
    req.on('error', (e) => { if (!acabou) { acabou = true; reject(e); } });
  });
}

async function lerJson(req, max) {
  const buf = await lerCorpo(req, max || 1024 * 1024);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    const err = new Error('O corpo não é um JSON válido. Mande o objeto com Content-Type: application/json.');
    err.status = 400;
    throw err;
  }
}

function parseCookies(cabecalho) {
  const out = {};
  if (!cabecalho) return out;
  for (const par of String(cabecalho).split(';')) {
    const i = par.indexOf('=');
    if (i < 0) continue;
    const k = par.slice(0, i).trim();
    const v = par.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

function logPadrao(nivel, msg) {
  const linha = `${new Date().toISOString()} [${nivel}] ${msg}`;
  if (nivel === 'erro' || nivel === 'aviso') console.error(linha);
  else console.log(linha);
}

module.exports = {
  normalizaIp, vemDeProxyConfiavel, ipDoPedido, esquemaDoPedido, hostDoPedido, origemPropria,
  enviaJson, erroJson, escapaHtml, paginaErro, lerCorpo, lerJson, parseCookies, logPadrao,
};
