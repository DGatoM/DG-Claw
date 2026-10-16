'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gravaArquivoSeguro, ErroGravacao } = require('../lib/cofre-agente');

const souRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function raizTemp() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'grava-seguro-'));
  fs.chmodSync(r, 0o700);
  return r;
}
const limpa = (r) => fs.rmSync(r, { recursive: true, force: true });
const modo = (p) => fs.statSync(p).mode & 0o777;
const recusa = (fn, code) => assert.throws(fn, (e) => e instanceof ErroGravacao && e.code === code);

test('grava atômico, 600 por padrão, sem sobrar temporário', () => {
  const r = raizTemp();
  try {
    const d = path.join(r, 'cofre.env');
    const out = gravaArquivoSeguro(d, 'A=1\n', { raiz: r });
    assert.equal(fs.readFileSync(d, 'utf8'), 'A=1\n');
    assert.equal(modo(d), 0o600);
    assert.equal(out.bytes, 4);
    assert.deepEqual(fs.readdirSync(r), ['cofre.env']);
  } finally { limpa(r); }
});

test('arquivo que já existe: preserva modo e dono quando não informados', () => {
  const r = raizTemp();
  try {
    const d = path.join(r, 'x.env');
    fs.writeFileSync(d, 'velho'); fs.chmodSync(d, 0o640);
    gravaArquivoSeguro(d, 'novo', { raiz: r });
    assert.equal(fs.readFileSync(d, 'utf8'), 'novo');
    assert.equal(modo(d), 0o640);
  } finally { limpa(r); }
});

test('recusa destino fora da raiz e caminho relativo', () => {
  const r = raizTemp();
  try {
    recusa(() => gravaArquivoSeguro(path.join(r, '..', 'fora.env'), 'x', { raiz: r }), 'FORA_DA_RAIZ');
    recusa(() => gravaArquivoSeguro('rel/x.env', 'x', { raiz: r }), 'OPCAO_INVALIDA');
    recusa(() => gravaArquivoSeguro(path.join(r, 'x'), 'x', {}), 'OPCAO_INVALIDA');
  } finally { limpa(r); }
});

test('recusa atalho no destino e numa pasta do caminho, sem tocar no alvo', () => {
  const r = raizTemp();
  const alvo = raizTemp();
  try {
    fs.writeFileSync(path.join(alvo, 'segredo'), 'original');
    fs.symlinkSync(path.join(alvo, 'segredo'), path.join(r, 'link.env'));
    recusa(() => gravaArquivoSeguro(path.join(r, 'link.env'), 'x', { raiz: r }), 'ATALHO');
    fs.symlinkSync(alvo, path.join(r, 'pasta'));
    recusa(() => gravaArquivoSeguro(path.join(r, 'pasta', 'segredo'), 'x', { raiz: r }), 'ATALHO');
    assert.equal(fs.readFileSync(path.join(alvo, 'segredo'), 'utf8'), 'original');
  } finally { limpa(r); limpa(alvo); }
});

test('recusa pasta com escrita de grupo ou de outros', () => {
  const r = raizTemp();
  try {
    const p = path.join(r, 'aberta');
    fs.mkdirSync(p); fs.chmodSync(p, 0o777);
    recusa(() => gravaArquivoSeguro(path.join(p, 'x.env'), 'x', { raiz: r }), 'PASTA_ABERTA');
  } finally { limpa(r); }
});

test('cria a pasta que falta com o modo pedido, um nível só', () => {
  const r = raizTemp();
  try {
    const uid = process.getuid(); const gid = process.getgid();
    const d = path.join(r, 'telegram', '.env');
    gravaArquivoSeguro(d, 'TOKEN=1\n', { raiz: r, pasta: { modo: 0o700, uid, gid } });
    assert.equal(modo(path.join(r, 'telegram')), 0o700);
    assert.equal(modo(d), 0o600);
    recusa(() => gravaArquivoSeguro(path.join(r, 'a', 'b', '.env'), 'x', { raiz: r, pasta: { modo: 0o700, uid, gid } }), 'PASTA_AUSENTE');
  } finally { limpa(r); }
});

test('com root: dono do arquivo e da pasta vêm das opções; pasta de outro usuário é recusada', { skip: !souRoot && 'precisa de root' }, () => {
  const r = raizTemp();
  try {
    const d = path.join(r, 'cofre', 'cofre.env');
    gravaArquivoSeguro(d, 'A=1\n', { raiz: r, uid: 100000, gid: 100000, pasta: { modo: 0o700, uid: 100000, gid: 100000 } });
    const st = fs.statSync(d);
    assert.equal(st.uid, 100000); assert.equal(st.gid, 100000);
    assert.equal(fs.statSync(path.join(r, 'cofre')).uid, 100000);
    // sem uid/gid: preserva o dono do arquivo existente
    gravaArquivoSeguro(d, 'A=2\n', { raiz: r });
    assert.equal(fs.statSync(d).uid, 100000);
    // pasta de um terceiro (nem root nem dono do arquivo)
    fs.chownSync(path.join(r, 'cofre'), 123456, 123456);
    recusa(() => gravaArquivoSeguro(d, 'A=3\n', { raiz: r, uid: 100000, gid: 100000 }), 'PASTA_DE_OUTRO');
    assert.equal(fs.readFileSync(d, 'utf8'), 'A=2\n');
  } finally { limpa(r); }
});

test('a mensagem de erro nunca leva o conteúdo', () => {
  const r = raizTemp();
  try {
    const p = path.join(r, 'aberta'); fs.mkdirSync(p); fs.chmodSync(p, 0o777);
    try { gravaArquivoSeguro(path.join(p, 'x'), 'sk-teste-SEGREDO-123456', { raiz: r }); assert.fail('devia recusar'); } catch (e) {
      assert.ok(!String(e.message).includes('SEGREDO'));
    }
  } finally { limpa(r); }
});
