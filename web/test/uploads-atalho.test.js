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

/** Conta quantas vezes fs.writeSync foi chamado com conteúdo (>0 bytes) enquanto `fn` roda. */
function contaEscritas(fn) {
  const orig = fs.writeSync; let n = 0;
  fs.writeSync = function (...a) { n += 1; return orig.apply(this, a); };
  try { fn(); } finally { fs.writeSync = orig; }
  return n;
}

test('upload: 5 nomes ocupados grava em arquivo-5 com uma única escrita', () => {
  const s = cenario();
  try {
    const dir = path.join(s.home, 'uploads', 'd'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'arquivo.bin'), 'x');
    for (let i = 1; i < 5; i += 1) fs.writeFileSync(path.join(dir, `arquivo-${i}.bin`), 'x');
    let dest;
    const n = contaEscritas(() => { dest = gravaUpload(s.agente, 'd', 'arquivo.bin', Buffer.from('conteudo')); });
    assert.equal(path.basename(dest), 'arquivo-5.bin');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'conteudo');
    assert.equal(n, 1, 'o anexo foi escrito uma vez só');
  } finally { s.limpa(); }
});

test('upload: 1000 nomes ocupados (inclusive atalho) dá "Não achei um nome livre" sem escrever o anexo', () => {
  const s = cenario();
  try {
    const dir = path.join(s.home, 'uploads', 'd'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'arquivo.bin'), 'x');
    fs.symlinkSync('/nao/existe', path.join(dir, 'arquivo-1.bin'));
    for (let i = 2; i < 1000; i += 1) fs.writeFileSync(path.join(dir, `arquivo-${i}.bin`), 'x');
    const n = contaEscritas(() => assert.throws(() => gravaUpload(s.agente, 'd', 'arquivo.bin', Buffer.alloc(1024, 1)), /Não achei um nome livre/));
    assert.equal(n, 0, 'nenhuma escrita do anexo');
  } finally { s.limpa(); }
});

test('upload: nome ocupado durante a gravação (corrida) volta a procurar e grava no próximo, com poucas escritas', () => {
  const s = cenario();
  try {
    const dir = path.join(s.home, 'uploads', 'd'); fs.mkdirSync(dir, { recursive: true });
    const orig = fs.linkSync; let ocupou = false;
    fs.linkSync = function (a, b) { if (!ocupou) { ocupou = true; fs.writeFileSync(b, 'do agente'); } return orig.call(this, a, b); };
    let dest; let n;
    try { n = contaEscritas(() => { dest = gravaUpload(s.agente, 'd', 'a.bin', Buffer.from('meu')); }); } finally { fs.linkSync = orig; }
    assert.equal(path.basename(dest), 'a-1.bin');
    assert.equal(fs.readFileSync(path.join(dir, 'a.bin'), 'utf8'), 'do agente');
    assert.ok(n <= 3, `escritas: ${n}`);
  } finally { s.limpa(); }
});

test('grava-seguro: escrita parcial é completada em laço; sem progresso dá FALHA_ESCRITA, sem destino e sem temporário', () => {
  const s = cenario();
  try {
    const orig = fs.writeSync;
    // 1) escreve em pedaços de 3 bytes: o conteúdo sai inteiro
    fs.writeSync = function (fd, buf, off, len, pos) { return orig.call(this, fd, buf, off, Math.min(3, len), pos); };
    const ok = path.join(s.home, 'ok.txt');
    try { gravaArquivoSeguro(ok, 'abcdefghij', { raiz: s.home, uid: DONO, gid: DONO, modo: 0o644 }); } finally { fs.writeSync = orig; }
    assert.equal(fs.readFileSync(ok, 'utf8'), 'abcdefghij');
    // 2) escreve 4 bytes e depois 0: erro, nada publicado
    let chamadas = 0;
    fs.writeSync = function (fd, buf, off, len, pos) { chamadas += 1; return chamadas === 1 ? orig.call(this, fd, buf, off, 4, pos) : 0; };
    const ruim = path.join(s.home, 'ruim.txt');
    try {
      assert.throws(() => gravaArquivoSeguro(ruim, 'abcdefghij', { raiz: s.home, uid: DONO, gid: DONO }),
        (e) => e instanceof ErroGravacao && e.code === 'FALHA_ESCRITA' && /4 de 10 bytes/.test(e.message));
    } finally { fs.writeSync = orig; }
    assert.equal(fs.existsSync(ruim), false, 'destino não publicado');
    assert.deepEqual(fs.readdirSync(s.home).sort(), ['ok.txt'], 'nenhum temporário sobrando');
  } finally { s.limpa(); }
});
