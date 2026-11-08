// test-cofre-chave-mestra.mjs: a chave mestra do motor `local` nunca pode ser trocada por engano.
// Roda numa pasta temporária. `node test-cofre-chave-mestra.mjs` na pasta do painel.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { criarCifra } = require('./lib/cofre-cifra.js');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-chave-'));
let falhas = 0;
function ok(c, o) { if (c) console.log(`  ok   ${o}`); else { console.log(`  FALHOU  ${o}`); falhas++; } }
function novo(nome) {
  const CHAVE_MESTRA = path.join(RAIZ, nome, 'cofre.chave');
  const c = criarCifra({ slug: 't', DIR: path.join(RAIZ, nome, 'd'), SEGREDOS: path.join(RAIZ, nome, 's'), CHAVE_MESTRA });
  return { c, CHAVE_MESTRA };
}
function tenta(fn) { try { return { v: fn() }; } catch (e) { return { e }; } }

console.log('\n(a) sem arquivo: gera e reaproveita');
{
  const { c, CHAVE_MESTRA } = novo('a');
  const k1 = c.chaveMestra();
  ok(k1.length === 32 && fs.existsSync(CHAVE_MESTRA), 'gerou chave de 32 bytes e gravou');
  ok((fs.statSync(CHAVE_MESTRA).mode & 0o777) === 0o600, 'modo 0600');
  ok(c.chaveMestra().equals(k1), 'segunda chamada devolve a mesma chave');
}

console.log('\n(b) arquivo existente ilegivel nao e sobrescrito');
{
  const { c, CHAVE_MESTRA } = novo('b');
  fs.mkdirSync(path.dirname(CHAVE_MESTRA), { recursive: true });
  let antes;
  if (process.getuid && process.getuid() !== 0) {
    antes = crypto32();
    fs.writeFileSync(CHAVE_MESTRA, antes, { mode: 0o600 });
    fs.chmodSync(CHAVE_MESTRA, 0o000);
  } else {
    fs.mkdirSync(CHAVE_MESTRA); // diretório no lugar do arquivo: EISDIR
  }
  const r = tenta(() => c.chaveMestra());
  ok(!!r.e, 'deu erro');
  ok(r.e && r.e.message.includes(CHAVE_MESTRA) && /EISDIR|EACCES/.test(r.e.message), 'erro diz o caminho e o codigo');
  ok(r.e && /Corrija|restaure/i.test(r.e.message), 'erro diz o que fazer');
  if (antes) {
    fs.chmodSync(CHAVE_MESTRA, 0o600);
    ok(fs.readFileSync(CHAVE_MESTRA).equals(antes), 'conteudo original intacto');
  } else {
    ok(fs.statSync(CHAVE_MESTRA).isDirectory(), 'o caminho continua como estava');
  }
}

console.log('\n(c) arquivo cortado/invalido nao e sobrescrito');
for (const [nome, conteudo] of [['c1', Buffer.alloc(10, 7)], ['c2', Buffer.alloc(0)], ['c3', Buffer.alloc(64, 1)]]) {
  const { c, CHAVE_MESTRA } = novo(nome);
  fs.mkdirSync(path.dirname(CHAVE_MESTRA), { recursive: true });
  fs.writeFileSync(CHAVE_MESTRA, conteudo, { mode: 0o600 });
  const r = tenta(() => c.chaveMestra());
  ok(!!r.e && r.e.code === 'CHAVE_INVALIDA' && r.e.message.includes(CHAVE_MESTRA), `${conteudo.length} bytes: erro claro com o caminho`);
  ok(fs.readFileSync(CHAVE_MESTRA).equals(conteudo), `${conteudo.length} bytes: arquivo intacto`);
}

console.log('\n(d) corrida: arquivo criado entre a checagem e a criacao');
{
  const { c, CHAVE_MESTRA } = novo('d');
  const outra = Buffer.alloc(32, 9);
  const orig = fs.readFileSync;
  let primeira = true;
  // Simula o outro processo: logo depois da primeira leitura (ENOENT), a chave aparece.
  fs.readFileSync = function (p, ...resto) {
    if (p === CHAVE_MESTRA && primeira) {
      primeira = false;
      fs.mkdirSync(path.dirname(CHAVE_MESTRA), { recursive: true });
      fs.writeFileSync(CHAVE_MESTRA, outra, { mode: 0o600 });
      const e = new Error('ENOENT simulado'); e.code = 'ENOENT'; throw e;
    }
    return orig.call(fs, p, ...resto);
  };
  let k;
  try { k = c.chaveMestra(); } finally { fs.readFileSync = orig; }
  ok(k.equals(outra), 'devolveu a chave que o outro processo criou');
  ok(orig(CHAVE_MESTRA).equals(outra), 'e o arquivo nao foi sobrescrito');
}

function crypto32() { return Buffer.alloc(32, 5); }
fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
