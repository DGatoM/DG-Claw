'use strict';
// Regras de lista da saída controlada (bloco H): normalização de nomes, curinga, modos e a proteção contra
// destino interno. Sem dependência, usado pelo proxy (servidor.js), pela CLI (cli.js) e pelos testes.

const net = require('node:net');
const { domainToASCII } = require('node:url');

// Do mais solto para o mais firme. O modo de um agente só pode subir nesta ordem.
const MODOS = ['livre', 'registro', 'bloqueio'];
const SLUG_RX = /^[a-z0-9][a-z0-9-]{1,30}$/;

function modoMaisForte(a, b) {
  const ia = MODOS.indexOf(a);
  const ib = MODOS.indexOf(b);
  if (ia < 0) return ib < 0 ? 'bloqueio' : b;
  if (ib < 0) return a;
  return MODOS[Math.max(ia, ib)];
}

// Nome de host em forma única: minúsculas, sem ponto final, IDN em punycode, IPv6 canônico sem colchetes.
// Devolve null quando não é um nome nem um IP que se possa comparar com segurança.
function normalizarHost(bruto) {
  if (typeof bruto !== 'string') return null;
  let h = bruto.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIPv6(h)) {
    try { return new URL(`http://[${h}]/`).hostname.slice(1, -1); } catch { return null; }
  }
  h = h.replace(/\.$/, '');
  if (!h || h.length > 253) return null;
  if (net.isIPv4(h)) return h;
  if (/[\s/:@*?#%\\[\]]/.test(h)) return null;
  const ascii = domainToASCII(h);
  if (!ascii || ascii.length > 253) return null;
  if (ascii.split('.').some((p) => !p || p.length > 63)) return null;
  return ascii;
}

// Entrada de lista: "api.exemplo.com", "*.exemplo.com" (curinga só no começo) ou um IP literal.
// Devolve { valor } ou { erro, como }.
function validarEntrada(bruto) {
  const texto = typeof bruto === 'string' ? bruto.trim() : '';
  if (!texto) return { erro: 'o domínio veio vazio', como: 'informe um nome como api.exemplo.com ou *.exemplo.com' };
  if (/^[a-z]+:\/\//i.test(texto) || texto.includes('/')) {
    return { erro: `"${texto.slice(0, 60)}" parece uma URL, e a lista aceita só nomes de host`, como: 'tire o https:// e o caminho; deixe só o nome, por exemplo api.exemplo.com' };
  }
  if (texto.startsWith('*.')) {
    const resto = normalizarHost(texto.slice(2));
    if (!resto || net.isIP(resto)) return { erro: `o curinga "${texto.slice(0, 60)}" não tem um domínio válido depois do *.`, como: 'use o formato *.exemplo.com.br' };
    if (!resto.includes('.')) return { erro: `o curinga "${texto.slice(0, 60)}" cobre um domínio inteiro de topo, largo demais`, como: 'use pelo menos dois níveis, como *.exemplo.com' };
    return { valor: `*.${resto}` };
  }
  if (texto.includes('*')) return { erro: `"${texto.slice(0, 60)}" tem * fora do começo`, como: 'o curinga só vale no começo, no formato *.exemplo.com' };
  const h = normalizarHost(texto);
  if (!h) return { erro: `"${texto.slice(0, 60)}" não é um nome de host válido`, como: 'use letras, números, pontos e hífens, por exemplo api.exemplo.com' };
  return { valor: h };
}

// casa(entradas, host): host já normalizado. "*.x.com" cobre qualquer subdomínio de x.com, mas não o próprio x.com.
function casa(entradas, host) {
  for (const e of entradas) {
    if (e.startsWith('*.')) {
      if (host.length > e.length - 1 && host.endsWith(e.slice(1))) return true;
    } else if (e === host) {
      return true;
    }
  }
  return false;
}

function v4Para(ip) { return ip.split('.').map(Number); }

function v4Bloqueado(ip) {
  const [a, b, c] = v4Para(ip);
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

// Os 8 grupos de 16 bits de um IPv6 já canônico (o URL do Node expande o que vem depois de ::).
function gruposV6(ip) {
  const canon = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [cabeca, cauda] = canon.split('::');
  const a = cabeca ? cabeca.split(':') : [];
  const b = cauda === undefined ? [] : (cauda ? cauda.split(':') : []);
  const meio = cauda === undefined ? [] : new Array(8 - a.length - b.length).fill('0');
  return [...a, ...meio, ...b].map((g) => parseInt(g, 16));
}

function v4Dos(g1, g2) { return `${g1 >> 8}.${g1 & 255}.${g2 >> 8}.${g2 & 255}`; }

function v6Bloqueado(ip) {
  const g = gruposV6(ip);
  if (g.every((x) => x === 0)) return true;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Bloqueado(v4Dos(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Bloqueado(v4Dos(g[6], g[7]));
  if (g[0] === 0x2002) return v4Bloqueado(v4Dos(g[1], g[2]));
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  return false;
}

// Rede interna, loopback, link-local (inclui 169.254.169.254, os metadados da nuvem), multicast e reservados.
// Um IP que não dá para ler conta como bloqueado.
function ipBloqueado(ip) {
  if (net.isIPv4(ip)) return v4Bloqueado(ip);
  if (net.isIPv6(ip)) {
    try { return v6Bloqueado(ip); } catch { return true; }
  }
  return true;
}

module.exports = { MODOS, SLUG_RX, modoMaisForte, normalizarHost, validarEntrada, casa, ipBloqueado };
