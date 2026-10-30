'use strict';
/**
 * tela-senha.js: a senha da Tela (o VNC do navegador do agente) no formato rfbauth.
 *
 * POR QUE ESTE ARQUIVO TEM UM DES DENTRO. O x11vnc lê a senha de um arquivo "rfbauth":
 * 8 bytes, que são a senha (completada com zeros até 8) cifrada em DES com uma chave fixa
 * do protocolo VNC. A ferramenta que grava esse arquivo é `x11vnc -storepasswd`, mas ela
 * recebe a senha por argumento ou pergunta no terminal, e argumento de comando aparece em
 * `ps` e em log. Gerar os 8 bytes aqui evita os dois. O Node 22 desta imagem não traz DES
 * (OpenSSL 3 sem o provider legado), por isso a cifra de um bloco está escrita abaixo, com
 * as tabelas do padrão FIPS 46-3. O teste confere o resultado contra vetores gerados pelo
 * próprio x11vnc.
 *
 * A CONVENÇÃO DO VNC: cada byte da chave fixa [23,82,107,6,35,78,88,7] entra no DES com os
 * bits em ordem invertida. É uma peculiaridade histórica do protocolo, não do DES.
 *
 * LIMITE DE 8 CARACTERES. O VNC só usa os 8 primeiros bytes da senha. Aceitar mais e
 * truncar calado faria a pessoa achar que a senha dela tem 20 caracteres quando só 8 valem,
 * então a validação RECUSA mais de 8 e diz por quê.
 *
 * A senha nunca é guardada: só os 8 bytes cifrados vão para o disco, por escrita atômica
 * (arquivo temporário na mesma pasta, modo 600, rename).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN_SENHA = 6;
const MAX_SENHA = 8;
const CHAVE_VNC = [23, 82, 107, 6, 35, 78, 88, 7];

// ─── DES (só cifrar um bloco de 8 bytes) ─────────────────────────────────────

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
// A permutação final é a inversa da inicial: calculada, e não digitada, para não haver
// uma segunda tabela que possa discordar da primeira.
const FP = (() => {
  const inv = new Array(64);
  IP.forEach((origem, i) => { inv[origem - 1] = i + 1; });
  return inv;
})();
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const GIROS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

function bitsDe(bytes) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
}

function bytesDe(bits) {
  const out = Buffer.alloc(bits.length / 8);
  bits.forEach((b, i) => { out[i >> 3] |= b << (7 - (i & 7)); });
  return out;
}

const permutar = (bits, tabela) => tabela.map((pos) => bits[pos - 1]);

function subchaves(chave8) {
  const k = permutar(bitsDe(chave8), PC1);
  let c = k.slice(0, 28);
  let d = k.slice(28);
  return GIROS.map((giro) => {
    c = c.slice(giro).concat(c.slice(0, giro));
    d = d.slice(giro).concat(d.slice(0, giro));
    return permutar(c.concat(d), PC2);
  });
}

function funcaoF(direita, subchave) {
  const x = permutar(direita, E).map((b, i) => b ^ subchave[i]);
  const saida = [];
  for (let caixa = 0; caixa < 8; caixa++) {
    const seis = x.slice(caixa * 6, caixa * 6 + 6);
    const linha = (seis[0] << 1) | seis[5];
    const coluna = (seis[1] << 3) | (seis[2] << 2) | (seis[3] << 1) | seis[4];
    const v = S[caixa][linha * 16 + coluna];
    saida.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
  }
  return permutar(saida, P);
}

/** DES-ECB de um bloco de 8 bytes. */
function cifrarBloco(chave8, bloco8) {
  const chaves = subchaves(chave8);
  const ip = permutar(bitsDe(bloco8), IP);
  let esq = ip.slice(0, 32);
  let dir = ip.slice(32);
  for (let i = 0; i < 16; i++) {
    const f = funcaoF(dir, chaves[i]);
    const nova = esq.map((b, j) => b ^ f[j]);
    esq = dir;
    dir = nova;
  }
  return bytesDe(permutar(dir.concat(esq), FP));
}

function inverterBits(byte) {
  let r = 0;
  for (let i = 0; i < 8; i++) if (byte & (1 << i)) r |= 1 << (7 - i);
  return r;
}

// ─── Validação e formato rfbauth ─────────────────────────────────────────────

/**
 * Confere a senha. Devolve { ok: true } ou { ok: false, erro, howToFix } (frases para o dono).
 * ASCII imprimível (espaço até til): o VNC manda a senha em bytes, e acento viraria dois
 * bytes e gastaria o limite de 8 sem a pessoa perceber.
 */
function validarSenha(senha) {
  if (typeof senha !== 'string' || senha === '') {
    return { ok: false, erro: 'Faltou a senha da tela.', howToFix: `Digite uma senha de ${MIN_SENHA} a ${MAX_SENHA} caracteres.` };
  }
  if (!/^[\x20-\x7e]+$/.test(senha)) {
    return {
      ok: false,
      erro: 'A senha da tela só pode ter letras sem acento, números, espaço e os símbolos do teclado (como ! @ # $ %).',
      howToFix: 'Troque as letras acentuadas e os caracteres especiais por letras e números comuns.',
    };
  }
  if (senha.length < MIN_SENHA) {
    return { ok: false, erro: `A senha da tela precisa de pelo menos ${MIN_SENHA} caracteres (a sua tem ${senha.length}).`, howToFix: `Digite de ${MIN_SENHA} a ${MAX_SENHA} caracteres.` };
  }
  if (senha.length > MAX_SENHA) {
    return {
      ok: false,
      erro: `A senha da tela tem no máximo ${MAX_SENHA} caracteres (a sua tem ${senha.length}). O VNC, que é o programa que mostra a tela, só olha os ${MAX_SENHA} primeiros e ignoraria o resto; por isso eu não aceito, para você não achar que a senha é maior do que é.`,
      howToFix: `Escolha uma senha de ${MIN_SENHA} a ${MAX_SENHA} caracteres.`,
    };
  }
  return { ok: true };
}

/** Os 8 bytes do arquivo rfbauth para esta senha (já validada). */
function gerarRfbauth(senha) {
  const v = validarSenha(senha);
  if (!v.ok) throw new Error(`${v.erro} ${v.howToFix}`);
  const entrada = Buffer.alloc(8);
  entrada.write(senha, 0, 'latin1');
  const chave = Buffer.from(CHAVE_VNC.map(inverterBits));
  return cifrarBloco(chave, entrada);
}

/**
 * Grava o rfbauth de forma atômica: pasta 700 se faltar, temporário na mesma pasta com modo
 * 600, rename. Lança Error com causa e o que fazer; a senha nunca entra na mensagem.
 */
function gravarRfbauth(arquivo, senha) {
  const bytes = gerarRfbauth(senha);
  const pasta = path.dirname(arquivo);
  const tmp = path.join(pasta, `.${path.basename(arquivo)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, arquivo);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* o temporário pode nem ter sido criado */ }
    throw new Error(`Não consegui gravar o arquivo da senha da tela em ${arquivo} (${err.code || err.message}). ` +
      'Confira se a pasta existe e se o usuário do painel pode escrever nela.');
  }
}

module.exports = { validarSenha, gerarRfbauth, gravarRfbauth, MIN_SENHA, MAX_SENHA };
