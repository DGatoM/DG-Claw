'use strict';
// WebAuthn sem dependência: base64url, CBOR mínimo, authenticatorData, chave COSE e assinatura.
// Só ES256 (-7) e RS256 (-257, com RSA de pelo menos 2048 bits). Quem usa é web/lib/cadeado.js.
// Nada aqui lê disco nem registra log; as mensagens de erro dizem o que veio e o que esperar,
// e nunca levam assinatura nem desafio.

const crypto = require('node:crypto');

const ALG_ES256 = -7;
const ALG_RS256 = -257;
const NOME_ALG = { [ALG_ES256]: 'ES256', [ALG_RS256]: 'RS256' };
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;
const CAMPO_MAX = 16 * 1024;

/** Falha de verificação com motivo explicado. `motivo` é um código curto (teste e agente); a mensagem é para gente. */
class WebAuthnErro extends Error {
  constructor(mensagem, motivo, status, recebido) {
    super(mensagem);
    this.name = 'WebAuthnErro';
    this.motivo = motivo;
    this.status = status || 400;
    this.recebido = recebido;
  }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Decodifica um campo base64url do navegador. Recusa vazio, caractere fora do alfabeto e campo grande demais. */
function deB64u(valor, campo, max) {
  const limite = max || CAMPO_MAX;
  if (typeof valor !== 'string' || !valor) {
    throw new WebAuthnErro(`O campo ${campo} veio vazio ou não é texto. Ele precisa ser base64url, do jeito que o navegador entrega.`, 'formato', 400, typeof valor);
  }
  if (valor.length > limite) {
    throw new WebAuthnErro(`O campo ${campo} passou de ${Math.round(limite / 1024)} KB, grande demais para ser WebAuthn.`, 'formato', 400, `${valor.length} caracteres`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(valor)) {
    throw new WebAuthnErro(`O campo ${campo} não é base64url válido (só aceita letras, números, - e _).`, 'formato', 400, valor.slice(0, 20));
  }
  return Buffer.from(valor, 'base64url');
}

// ── CBOR (RFC 8949): só o que o attestationObject e a chave COSE usam ──────
class CborErro extends Error {}

function cborDecode(dados, pos0, prof0) {
  let pos = pos0 || 0;
  const prof = prof0 || 0;
  if (prof > 16) throw new CborErro('CBOR aninhado fundo demais (mais de 16 níveis)');
  if (pos >= dados.length) throw new CborErro(`o CBOR acabou no meio (byte ${pos} de ${dados.length})`);
  const ini = dados[pos++];
  const maior = ini >> 5;
  const info = ini & 0x1f;
  const pega = (n) => {
    if (pos + n > dados.length) throw new CborErro(`o CBOR acabou no meio (queria ${n} bytes no byte ${pos})`);
    const t = dados.subarray(pos, pos + n);
    pos += n;
    return t;
  };
  if (maior === 7) {
    if (info === 20) return [false, pos];
    if (info === 21) return [true, pos];
    if (info === 22 || info === 23) return [null, pos];
    if (info === 25) {
      const h = pega(2).readUInt16BE(0);
      const e = (h >> 10) & 0x1f;
      const f = h & 0x3ff;
      const v = e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15);
      return [h & 0x8000 ? -v : v, pos];
    }
    if (info === 26) return [pega(4).readFloatBE(0), pos];
    if (info === 27) return [pega(8).readDoubleBE(0), pos];
    throw new CborErro(`valor simples CBOR não aceito (info ${info})`);
  }
  let arg;
  if (info < 24) arg = info;
  else if (info === 24) arg = pega(1)[0];
  else if (info === 25) arg = pega(2).readUInt16BE(0);
  else if (info === 26) arg = pega(4).readUInt32BE(0);
  else if (info === 27) {
    const big = pega(8).readBigUInt64BE(0);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborErro('inteiro CBOR grande demais');
    arg = Number(big);
  } else throw new CborErro(`tamanho indefinido ou reservado no CBOR (tipo ${maior}, info ${info})`);

  if (maior === 0) return [arg, pos];
  if (maior === 1) return [-1 - arg, pos];
  if (maior === 2) return [Buffer.from(pega(arg)), pos];
  if (maior === 3) {
    try { return [new TextDecoder('utf-8', { fatal: true }).decode(pega(arg)), pos]; } catch (e) {
      if (e instanceof CborErro) throw e;
      throw new CborErro('texto CBOR que não é UTF-8');
    }
  }
  if (maior === 4) {
    if (arg > dados.length) throw new CborErro(`lista CBOR diz ter ${arg} itens, mais que o tamanho do dado`);
    const lista = [];
    for (let i = 0; i < arg; i++) { const [v, np] = cborDecode(dados, pos, prof + 1); lista.push(v); pos = np; }
    return [lista, pos];
  }
  if (maior === 5) {
    if (arg > dados.length) throw new CborErro(`mapa CBOR diz ter ${arg} pares, mais que o tamanho do dado`);
    const mapa = new Map();
    for (let i = 0; i < arg; i++) {
      const [k, np] = cborDecode(dados, pos, prof + 1);
      if (Array.isArray(k) || k instanceof Map) throw new CborErro('chave de mapa CBOR que é lista ou mapa não é aceita');
      const [v, np2] = cborDecode(dados, np, prof + 1);
      mapa.set(k, v);
      pos = np2;
    }
    return [mapa, pos];
  }
  if (maior === 6) return cborDecode(dados, pos, prof + 1);
  throw new CborErro(`tipo CBOR ${maior} desconhecido`);
}

/** Decodifica um item que precisa ocupar o dado inteiro. */
function cborInteiro(dados, campo) {
  let r;
  try { r = cborDecode(dados, 0, 0); } catch (e) {
    if (e instanceof CborErro) throw new WebAuthnErro(`O ${campo} não é CBOR válido: ${e.message}.`, 'formato');
    throw e;
  }
  if (r[1] !== dados.length) throw new WebAuthnErro(`O ${campo} tem ${dados.length - r[1]} bytes sobrando depois do CBOR.`, 'formato');
  return r[0];
}

/** Quebra o authenticatorData (WebAuthn §6.1) nos campos. */
function leAuthData(ad) {
  if (!Buffer.isBuffer(ad) || ad.length < 37) {
    throw new WebAuthnErro('O authenticatorData tem menos de 37 bytes: não é um dado de autenticador.', 'formato', 400, Buffer.isBuffer(ad) ? ad.length : typeof ad);
  }
  const flags = ad[32];
  const out = {
    rpHash: Buffer.from(ad.subarray(0, 32)), flags,
    up: !!(flags & FLAG_UP), uv: !!(flags & FLAG_UV), be: !!(flags & FLAG_BE), bs: !!(flags & FLAG_BS),
    contador: ad.readUInt32BE(33), credId: null, cose: null,
  };
  if (out.bs && !out.be) throw new WebAuthnErro('O authenticatorData diz que a passkey está sincronizada (BS) sem poder ser (BE): dado inconsistente.', 'formato');
  let pos = 37;
  try {
    if (flags & FLAG_AT) {
      if (ad.length < pos + 18) throw new WebAuthnErro('O authenticatorData diz que traz a credencial, mas acaba antes do id dela.', 'formato');
      const n = ad.readUInt16BE(pos + 16);
      pos += 18;
      if (n < 1 || n > 1023) throw new WebAuthnErro(`O id da credencial tem ${n} bytes; o WebAuthn aceita de 1 a 1023.`, 'formato');
      if (ad.length < pos + n) throw new WebAuthnErro('O id da credencial no authenticatorData está cortado.', 'formato');
      out.credId = Buffer.from(ad.subarray(pos, pos + n));
      pos += n;
      [out.cose, pos] = cborDecode(ad, pos, 0);
    }
    if (flags & FLAG_ED) [, pos] = cborDecode(ad, pos, 0);
  } catch (e) {
    if (e instanceof CborErro) throw new WebAuthnErro(`O authenticatorData tem CBOR inválido: ${e.message}.`, 'formato');
    throw e;
  }
  if (pos !== ad.length) throw new WebAuthnErro(`O authenticatorData tem ${ad.length - pos} bytes sobrando.`, 'formato');
  return out;
}

/** Chave COSE (Map) para { alg, jwk }. ES256 na P-256; RS256 só com 2048 bits ou mais. */
function chaveDoCose(cose) {
  if (!(cose instanceof Map)) throw new WebAuthnErro('A chave pública da credencial não é um mapa COSE.', 'chave');
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (alg === ALG_ES256) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (kty !== 2 || cose.get(-1) !== 1) {
      throw new WebAuthnErro(`Chave ES256 precisa ser EC2 (kty 2) na curva P-256 (crv 1). Veio kty ${String(kty)}, crv ${String(cose.get(-1))}.`, 'chave');
    }
    if (!(Buffer.isBuffer(x) && Buffer.isBuffer(y) && x.length === 32 && y.length === 32)) {
      throw new WebAuthnErro('Chave ES256 com x ou y fora do tamanho de 32 bytes.', 'chave');
    }
    jwk = { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) };
  } else if (alg === ALG_RS256) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (kty !== 3 || !Buffer.isBuffer(n) || !Buffer.isBuffer(e) || e.length < 1 || e.length > 8) {
      throw new WebAuthnErro('Chave RS256 precisa ser RSA (kty 3) com n e e em bytes.', 'chave');
    }
    jwk = { kty: 'RSA', n: b64u(n), e: b64u(e) };
  } else {
    throw new WebAuthnErro(`Algoritmo ${String(alg)} não aceito. Só ES256 (-7) e RS256 (-257).`, 'chave', 400, alg);
  }
  let key;
  try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch (e) {
    throw new WebAuthnErro(`A chave pública da credencial é inválida (${e.code || e.message}).`, 'chave');
  }
  if (alg === ALG_RS256) {
    const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
    if (!bits || bits < 2048 || bits > 8192) {
      throw new WebAuthnErro(`Chave RSA de ${bits || '?'} bits não serve (precisa ter de 2048 a 8192).`, 'chave');
    }
  }
  return { alg, jwk };
}

/** A assinatura confere? Chave guardada em JWK; ES256 vem em DER, como o WebAuthn entrega. */
function confereAssinatura(alg, jwk, assinatura, dados) {
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    if (alg === ALG_ES256) return crypto.verify('sha256', dados, { key, dsaEncoding: 'der' }, assinatura);
    if (alg === ALG_RS256) return crypto.verify('sha256', dados, key, assinatura);
    return false;
  } catch (_) {
    return false;
  }
}

module.exports = {
  ALG_ES256, ALG_RS256, NOME_ALG, FLAG_UP, FLAG_UV, FLAG_BE, FLAG_BS, FLAG_AT, FLAG_ED,
  WebAuthnErro, b64u, deB64u, cborDecode, cborInteiro, leAuthData, chaveDoCose, confereAssinatura,
};
