'use strict';
// TOTP (RFC 6238) sem dependência: HMAC-SHA1, 6 dígitos, passo de 30 s, janela de ±1 passo.
// O segredo é base32 (RFC 4648) de 20 bytes, o formato que os aplicativos autenticadores entendem.
// Proteção contra reuso: quem chama guarda o último passo aceito de cada pessoa e passa em `depoisDoPasso`;
// um código só vale se o passo dele for maior que esse.

const crypto = require('node:crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PASSO_S = 30;

function base32Codifica(buf) {
  let bits = 0; let valor = 0; let saida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) { saida += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31];
  return saida;
}

/** Devolve um Buffer, ou lança Error se o texto tem caractere fora do base32. Aceita espaços, traços e minúsculas. */
function base32Decodifica(texto) {
  const limpo = String(texto).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0; let valor = 0; const bytes = [];
  for (const c of limpo) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) throw new Error(`O segredo tem o caractere "${c}", que não existe em base32 (use A a Z e 2 a 7).`);
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) { bytes.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

/** Segredo novo: 20 bytes aleatórios em base32 (32 caracteres). */
function gerarSegredo() { return base32Codifica(crypto.randomBytes(20)); }

function hotp(segredoBuf, contador, digitos) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac('sha1', segredoBuf).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % (10 ** digitos)).padStart(digitos, '0');
}

const passoDe = (tempoMs) => Math.floor(tempoMs / 1000 / PASSO_S);

/** O código de 6 dígitos (ou `digitos`) do segredo naquele instante. */
function codigoEm(segredo, tempoMs, digitos) {
  return hotp(base32Decodifica(segredo), passoDe(tempoMs), digitos || 6);
}

/**
 * Confere o código digitado. opcoes: { agora (ms), janela (padrão 1), digitos (padrão 6), depoisDoPasso }.
 * Devolve { ok: true, passo } ou { ok: false, motivo: 'formato' | 'errado' | 'reuso' }.
 */
function verificar(segredo, digitado, opcoes) {
  const o = opcoes || {};
  const digitos = o.digitos || 6;
  const texto = String(digitado == null ? '' : digitado).replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digitos}}$`).test(texto)) return { ok: false, motivo: 'formato' };
  const buf = base32Decodifica(segredo);
  const agora = passoDe(o.agora == null ? Date.now() : o.agora);
  const janela = o.janela == null ? 1 : o.janela;
  const esperado = Buffer.from(texto);
  let acertou = null;
  // percorre a janela inteira sem parar no primeiro acerto, para o tempo não revelar qual passo bateu
  for (let d = -janela; d <= janela; d += 1) {
    const passo = agora + d;
    if (passo < 0) continue;
    const c = Buffer.from(hotp(buf, passo, digitos));
    if (crypto.timingSafeEqual(c, esperado) && (acertou === null || passo > acertou)) acertou = passo;
  }
  if (acertou === null) return { ok: false, motivo: 'errado' };
  if (o.depoisDoPasso != null && acertou <= o.depoisDoPasso) return { ok: false, motivo: 'reuso' };
  return { ok: true, passo: acertou };
}

/** O endereço otpauth:// que o QR code (ou o botão "abrir no aplicativo") carrega. */
function otpauth({ segredo, conta, emissor }) {
  const e = encodeURIComponent(emissor || 'DG Claw');
  return `otpauth://totp/${e}:${encodeURIComponent(conta)}?secret=${segredo}&issuer=${e}&algorithm=SHA1&digits=6&period=${PASSO_S}`;
}

/** "ABCD EFGH ..." em grupos de 4, para digitar à mão. */
function agrupa(segredo) { return String(segredo).replace(/(.{4})/g, '$1 ').trim(); }

module.exports = { gerarSegredo, base32Codifica, base32Decodifica, hotp, codigoEm, verificar, otpauth, agrupa, passoDe, PASSO_S };
