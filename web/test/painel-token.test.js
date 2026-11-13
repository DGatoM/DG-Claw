'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarPainelToken, VIDA_MAX_S } = require('../lib/painel-token');

const modo = (f) => (fs.statSync(f).mode & 0o777).toString(8);

function novo(extra) {
  const dir = pastaTemp('ptk');
  const rel = { t: 1_800_000_000_000 };
  const pt = criarPainelToken(Object.assign({ dataDir: dir, agora: () => rel.t }, extra || {}));
  return { dir, rel, pt, arq: path.join(dir, 'painel-token.chave') };
}

test('a chave é criada no primeiro uso, com 32 bytes e modo 0600, e nunca sobrescrita', () => {
  const { pt, arq, dir, rel } = novo();
  assert.ok(!fs.existsSync(arq), 'só nasce no primeiro uso');
  const t1 = pt.emitir({ slug: 'ana', id: pt.idDaSessao('k1'), sessaoExpiraMs: rel.t + 3600_000 }).token;
  assert.equal(fs.statSync(arq).size, 32);
  assert.equal(modo(arq), '600');
  const antes = fs.readFileSync(arq);
  // outra instância (restart do Web) lê a mesma chave e valida o token antigo
  const pt2 = criarPainelToken({ dataDir: dir, agora: () => rel.t });
  assert.equal(pt2.verificar(t1).ok, true);
  assert.deepEqual(fs.readFileSync(arq), antes, 'a chave não muda');
});

test('chave corrompida: erro com o motivo em português, sem recriar em silêncio', () => {
  const { pt, arq } = novo();
  fs.writeFileSync(arq, Buffer.from('curta'), { mode: 0o600 });
  assert.throws(() => pt.idDaSessao('k'), /tem 5 bytes e deveria ter 32.*Não vou recriar sozinho/);
  assert.throws(() => pt.verificar('a.b'.padEnd(30, 'a')), /tem 5 bytes/);
  assert.equal(fs.readFileSync(arq).toString(), 'curta', 'o arquivo ficou como estava');
});

test('o token tem só caracteres de caminho de URL e leva slug, identificador e expiração', () => {
  const { pt, rel } = novo();
  const id = pt.idDaSessao('chave-do-mapa');
  const { token, expira } = pt.emitir({ slug: 'ana', id, sessaoExpiraMs: rel.t + 3600_000 });
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(token.length < 400);
  const v = pt.verificar(token);
  assert.deepEqual(v, { ok: true, slug: 'ana', id, expira });
  assert.equal(expira, Math.floor(rel.t / 1000) + 3600);
});

test('o identificador da sessão não é o valor do mapa nem o sha256 dele, e muda com a chave', () => {
  const a = novo(); const b = novo();
  const crypto = require('node:crypto');
  const chaveDoMapa = crypto.createHash('sha256').update('cookie-secreto').digest('hex');
  const id = a.pt.idDaSessao(chaveDoMapa);
  assert.notEqual(id, chaveDoMapa);
  assert.ok(!chaveDoMapa.startsWith(id) && !id.includes(chaveDoMapa.slice(0, 16)));
  assert.notEqual(id, crypto.createHash('sha256').update(chaveDoMapa).digest('base64url').slice(0, id.length));
  assert.equal(a.pt.idDaSessao(chaveDoMapa), id, 'determinístico para a mesma chave');
  assert.notEqual(b.pt.idDaSessao(chaveDoMapa), id, 'outra instalação, outro identificador');
  assert.equal(Buffer.from(id, 'base64url').length, 16);
});

test('vale no máximo 12 h e nunca mais que a sessão; expira de verdade', () => {
  const { pt, rel } = novo();
  const id = pt.idDaSessao('k');
  const longa = pt.emitir({ slug: 'ana', id, sessaoExpiraMs: rel.t + 30 * 86400_000 });
  assert.equal(longa.expira, Math.floor(rel.t / 1000) + VIDA_MAX_S);
  const curta = pt.emitir({ slug: 'ana', id, sessaoExpiraMs: rel.t + 60_000 });
  assert.equal(curta.expira, Math.floor(rel.t / 1000) + 60);
  rel.t += 59_000;
  assert.equal(pt.verificar(curta.token).ok, true);
  rel.t += 2_000;
  const v = pt.verificar(curta.token);
  assert.equal(v.ok, false);
  assert.match(v.motivo, /expirou/);
});

test('adulteração: slug, identificador, expiração, MAC, tamanho e formato', () => {
  const { pt, rel } = novo();
  const id = pt.idDaSessao('k');
  const { token } = pt.emitir({ slug: 'ana', id, sessaoExpiraMs: rel.t + 3600_000 });
  const [corpo, mac] = token.split('.');
  const d = JSON.parse(Buffer.from(corpo, 'base64url').toString());
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const ruins = [
    `${enc({ ...d, s: 'bob' })}.${mac}`, `${enc({ ...d, i: 'outro' })}.${mac}`, `${enc({ ...d, e: d.e + 1000 })}.${mac}`,
    `${corpo}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, `${corpo}.${mac.slice(1)}`, `${corpo}.`, `.${mac}`, corpo, `${corpo}.${mac}.x`, `${corpo}.${mac}=`,
    'x'.repeat(401), '', null, undefined, 42, {}, `${corpo}.${mac}/../x`,
  ];
  for (const t of ruins) assert.equal(pt.verificar(t).ok, false, String(t).slice(0, 40));
  // outra chave não valida
  assert.equal(novo().pt.verificar(token).ok, false);
  // corpo assinado mas que não é o JSON esperado
  const falso = Buffer.from('nao e json').toString('base64url');
  const crypto = require('node:crypto');
  assert.equal(pt.verificar(`${falso}.${crypto.randomBytes(32).toString('base64url')}`).ok, false);
});
