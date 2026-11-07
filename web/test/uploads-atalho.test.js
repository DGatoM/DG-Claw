'use strict';
// Upload e criação de pastas dentro da casa do agente: o Web é root e a casa é gravável pelo agente,
// então nenhum atalho (link simbólico) no caminho pode levar a gravação para fora da casa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gravaUpload } = require('../lib/uploads');
const { gravaArquivoSeguro, criaPastaSemAtalho, ErroGravacao } = require('../lib/grava-seguro');

const souRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const DONO = souRoot ? 65534 : process.getuid();

function temp(prefixo) { return fs.mkdtempSync(path.join(os.tmpdir(), `dgclaw-${prefixo}-`)); }
const limpa = (...ps) => { for (const p of ps) fs.rmSync(p, { recursive: true, force: true }); };

/** Casa do agente e uma pasta "alvo" fora dela, que nunca pode receber nada. */
function cenario() {
  const home = temp('casa');
  const alvo = temp('alvo');
  if (souRoot) fs.chownSync(home, DONO, DONO);
  fs.chmodSync(home, 0o755);
  return { home, alvo, agente: { slug: 'ana', nome: 'Ana', home_host: home }, limpa: () => limpa(home, alvo) };
}

test('upload: caminho normal grava o conteúdo, cria uploads/<dia> e o arquivo é do dono da casa', () => {
  const s = cenario();
  try {
    const dest = gravaUpload(s.agente, '2026-11-06', 'foto.png', Buffer.from([1, 2, 3, 0, 255]));
    assert.equal(dest, path.join(s.home, 'uploads', '2026-11-06', 'foto.png'));
    assert.deepEqual([...fs.readFileSync(dest)], [1, 2, 3, 0, 255]);
    assert.equal(fs.statSync(dest).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(s.home, 'uploads')).mode & 0o777, 0o755);
    if (souRoot) {
      assert.equal(fs.statSync(dest).uid, DONO, 'o arquivo é do dono da casa');
      assert.equal(fs.statSync(path.join(s.home, 'uploads')).uid, DONO, 'a pasta uploads é do dono da casa');
      assert.equal(fs.statSync(path.join(s.home, 'uploads', '2026-11-06')).uid, DONO);
    } else {
      console.log('(fora do root: conferência de dono pulada; sem root não há como o arquivo ter outro dono)');
    }
  } finally { s.limpa(); }
});

test('upload: nome repetido não sobrescreve (foto-1.png), e atalho com o nome do arquivo é pulado sem ser seguido', () => {
  const s = cenario();
  try {
    const a = gravaUpload(s.agente, '2026-11-06', 'foto.png', Buffer.from('um'));
    const b = gravaUpload(s.agente, '2026-11-06', 'foto.png', Buffer.from('dois'));
    assert.equal(path.basename(b), 'foto-1.png');
    assert.equal(fs.readFileSync(a, 'utf8'), 'um');
    const vitima = path.join(s.alvo, 'vitima.txt');
    fs.writeFileSync(vitima, 'intacto');
    fs.symlinkSync(vitima, path.join(s.home, 'uploads', '2026-11-06', 'doc.pdf'));
    const c = gravaUpload(s.agente, '2026-11-06', 'doc.pdf', Buffer.from('novo'));
    assert.equal(path.basename(c), 'doc-1.pdf');
    assert.equal(fs.readFileSync(vitima, 'utf8'), 'intacto', 'o alvo do atalho não foi tocado');
  } finally { s.limpa(); }
});

test('upload: uploads trocado por atalho para fora da casa é recusado com erro claro e nada aparece no alvo', () => {
  const s = cenario();
  try {
    fs.symlinkSync(s.alvo, path.join(s.home, 'uploads'));
    assert.throws(() => gravaUpload(s.agente, '2026-11-06', 'foto.png', Buffer.from('x')),
      (e) => e instanceof ErroGravacao && e.code === 'ATALHO' && /atalho/.test(e.message) && e.message.includes(path.join(s.home, 'uploads')));
    assert.deepEqual(fs.readdirSync(s.alvo), [], 'nada foi criado no alvo');
  } finally { s.limpa(); }
});

test('upload: pasta do dia trocada por atalho é recusada e nada aparece no alvo', () => {
  const s = cenario();
  try {
    fs.mkdirSync(path.join(s.home, 'uploads'));
    fs.symlinkSync(s.alvo, path.join(s.home, 'uploads', '2026-11-06'));
    assert.throws(() => gravaUpload(s.agente, '2026-11-06', 'foto.png', Buffer.from('x')),
      (e) => e instanceof ErroGravacao && e.code === 'ATALHO' && /atalho/.test(e.message));
    assert.deepEqual(fs.readdirSync(s.alvo), [], 'nada foi criado no alvo');
  } finally { s.limpa(); }
});

test('upload: casa sem home_host ou inexistente dá erro em português, sem gravar', () => {
  assert.throws(() => gravaUpload({ nome: 'Ana' }, 'd', 'a.txt', Buffer.from('x')), /não tem home_host/);
  assert.throws(() => gravaUpload({ nome: 'Ana', home_host: '/nao/existe/dgclaw-xyz' }, 'd', 'a.txt', Buffer.from('x')), /não existe ou não pôde ser lida/);
});

test('grava-seguro: pasta.recursiva cria cada nível com o dono pedido e recusa atalho no meio', () => {
  const s = cenario();
  try {
    const arq = path.join(s.home, 'a', 'b', 'c.txt');
    gravaArquivoSeguro(arq, 'ok', { raiz: s.home, uid: DONO, gid: DONO, modo: 0o644, pasta: { modo: 0o755, uid: DONO, gid: DONO, recursiva: true } });
    assert.equal(fs.readFileSync(arq, 'utf8'), 'ok');
    assert.equal(fs.statSync(path.join(s.home, 'a')).mode & 0o777, 0o755);
    fs.symlinkSync(s.alvo, path.join(s.home, 'x'));
    assert.throws(() => gravaArquivoSeguro(path.join(s.home, 'x', 'y', 'z.txt'), 'no', { raiz: s.home, uid: DONO, gid: DONO, pasta: { modo: 0o755, uid: DONO, gid: DONO, recursiva: true } }),
      (e) => e instanceof ErroGravacao && e.code === 'ATALHO');
    assert.deepEqual(fs.readdirSync(s.alvo), []);
  } finally { s.limpa(); }
});

test('grava-seguro: exclusivo não sobrescreve (JA_EXISTE) e deixa o arquivo antigo intacto', () => {
  const s = cenario();
  try {
    const arq = path.join(s.home, 'f.txt');
    gravaArquivoSeguro(arq, 'velho', { raiz: s.home, uid: DONO, gid: DONO, modo: 0o644, exclusivo: true });
    assert.throws(() => gravaArquivoSeguro(arq, 'novo', { raiz: s.home, uid: DONO, gid: DONO, modo: 0o644, exclusivo: true }),
      (e) => e instanceof ErroGravacao && e.code === 'JA_EXISTE');
    assert.equal(fs.readFileSync(arq, 'utf8'), 'velho');
    assert.deepEqual(fs.readdirSync(s.home), ['f.txt'], 'sem temporário sobrando');
  } finally { s.limpa(); }
});

test('criaPastaSemAtalho (usada pela caixa e pelo upload): cria com dono e modo; erro em português se a mãe falta', () => {
  const s = cenario();
  try {
    const p = path.join(s.home, 'nova');
    criaPastaSemAtalho(p, 0o700, DONO, DONO);
    assert.equal(fs.statSync(p).mode & 0o777, 0o700);
    if (souRoot) assert.equal(fs.statSync(p).uid, DONO);
    assert.throws(() => criaPastaSemAtalho(path.join(s.home, 'falta', 'filha'), 0o700, DONO, DONO), (e) => e.code === 'FALHA_ESCRITA' && /Não consegui criar a pasta/.test(e.message));
  } finally { s.limpa(); }
});
