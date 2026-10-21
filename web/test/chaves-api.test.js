'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp, capturaLog } = require('./ajuda');
const { criarChavesApi, ESCOPOS } = require('../lib/chaves-api');

function loja(opcoes) {
  const dataDir = pastaTemp('chaves');
  const cap = capturaLog();
  let t = 1_800_000_000_000;
  const relogio = { avanca: (ms) => { t += ms; } };
  const api = criarChavesApi({ config: Object.assign({ dataDir }, opcoes), log: cap.log, agora: () => t });
  return { api, dataDir, cap, relogio, arquivo: path.join(dataDir, 'chaves-api.json') };
}
const bearer = (token) => `Bearer ${token}`;

test('o único escopo aceito hoje é diagnostico', () => {
  assert.deepEqual([...ESCOPOS], ['diagnostico']);
});

test('criar: o token aparece uma vez e só o hash vai para o disco', () => {
  const l = loja();
  const r = l.api.criar({ nome: 'Suporte DG', escopos: ['diagnostico'], quem: 'dono' });
  assert.equal(r.ok, true);
  assert.match(r.token, /^dgc_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(r.chave.escopos, ['diagnostico']);
  assert.equal(r.chave.ultimos4, r.token.slice(-4));
  assert.equal(r.chave.hash, undefined, 'a resposta pública não leva o hash');
  const disco = fs.readFileSync(l.arquivo, 'utf8');
  assert.ok(!disco.includes(r.token), 'o token não pode estar no arquivo');
  const reg = JSON.parse(disco).chaves[0];
  assert.match(reg.hash, /^[0-9a-f]{64}$/);
  assert.equal(reg.criadaPor, 'dono');
  assert.equal(reg.ultimoUsoIp, null);
  assert.equal(fs.statSync(l.arquivo).mode & 0o777, 0o600);
  assert.equal(fs.statSync(l.dataDir).mode & 0o777, 0o700);
  assert.ok(!l.cap.texto().includes(r.token), 'o token não pode estar no log');
});

test('criar: nome e escopo inválidos viram erro com motivo e status 400', () => {
  const l = loja();
  const casos = [
    [{ nome: '', escopos: ['diagnostico'] }, /nome/i],
    [{ nome: 'a'.repeat(61), escopos: ['diagnostico'] }, /60/],
    [{ nome: 'duas\nlinhas', escopos: ['diagnostico'] }, /linha/],
    [{ nome: 'ok' }, /escopo/i],
    [{ nome: 'ok', escopos: [] }, /escopo/i],
    [{ nome: 'ok', escopos: ['escrita'] }, /"escrita"/],
    [{ nome: 'ok', escopos: ['diagnostico', 'admin'] }, /"admin"/],
    [{ nome: 'ok', escopos: 'diagnostico' }, /escopo/i],
  ];
  for (const [entrada, rx] of casos) {
    const r = l.api.criar(entrada);
    assert.equal(r.ok, false, JSON.stringify(entrada));
    assert.equal(r.status, 400);
    assert.match(r.erro, rx);
    assert.ok(r.como_resolver);
  }
  assert.equal(fs.existsSync(l.arquivo), false, 'recusa não grava nada');
});

test('julgar: válida, desconhecida, formato ruim e revogada', () => {
  const l = loja();
  const a = l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  const b = l.api.criar({ nome: 'B', escopos: ['diagnostico'] });
  const ja = l.api.julgar(bearer(a.token));
  assert.equal(ja.estado, 'valida');
  assert.equal(ja.id, a.chave.id);
  assert.deepEqual(ja.escopos, ['diagnostico']);
  assert.equal(l.api.julgar(bearer(b.token)).id, b.chave.id);
  assert.equal(l.api.julgar(bearer('dgc_' + 'x'.repeat(43))).estado, 'desconhecida');
  assert.equal(l.api.julgar('Bearer lixo').estado, 'formato');
  assert.equal(l.api.julgar('Basic abc').estado, 'formato');
  assert.equal(l.api.julgar('').estado, 'formato');
  assert.equal(l.api.julgar(undefined).estado, 'formato');
  assert.equal(l.api.julgar(`bearer ${a.token}`).estado, 'valida', 'Bearer vale em qualquer caixa');

  const rv = l.api.revogar(a.chave.id, 'dono');
  assert.equal(rv.ok, true);
  const jr = l.api.julgar(bearer(a.token));
  assert.equal(jr.estado, 'revogada');
  assert.equal(jr.nome, 'A');
  assert.ok(jr.revogadaEm);
  assert.equal(l.api.julgar(bearer(b.token)).estado, 'valida', 'a outra chave segue valendo');
});

test('revogar: data quem e quando; repetir dá 409; id desconhecido dá 404', () => {
  const l = loja();
  const a = l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  const r = l.api.revogar(a.chave.id, 'Marta');
  assert.equal(r.ok, true);
  assert.equal(r.chave.revogadaPor, 'Marta');
  assert.ok(r.chave.revogadaEm);
  const de_novo = l.api.revogar(a.chave.id, 'Marta');
  assert.equal(de_novo.status, 409);
  assert.match(de_novo.erro, /já tinha sido revogada/);
  assert.equal(l.api.revogar('naoexiste', 'x').status, 404);
  assert.equal(l.api.listar().length, 1, 'o registro continua depois de revogar');
});

test('listar não devolve hash', () => {
  const l = loja();
  l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  assert.ok(l.api.listar().every((c) => c.hash === undefined));
});

test('arquivo ilegível: nenhuma chave vale e o log explica', () => {
  const l = loja();
  const a = l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  fs.writeFileSync(l.arquivo, '{ isto não é json');
  assert.equal(l.api.julgar(bearer(a.token)).estado, 'desconhecida');
  const erro = l.cap.linhas.find((x) => x.startsWith('[erro]'));
  assert.ok(erro, 'precisa haver um log de erro');
  assert.match(erro, /não consegui ler/);
  assert.match(erro, /Nenhuma chave de API vale/);
  assert.ok(erro.includes(l.arquivo));
});

test('relê o arquivo quando ele muda por fora (a CLI cria chave com o Web rodando)', () => {
  const l = loja();
  const a = l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  assert.equal(l.api.julgar(bearer(a.token)).estado, 'valida');
  const outra = criarChavesApi({ config: { dataDir: l.dataDir }, log: l.cap.log });
  const b = outra.criar({ nome: 'B', escopos: ['diagnostico'] });
  assert.equal(l.api.julgar(bearer(b.token)).estado, 'valida', 'enxerga a chave criada por outro processo');
  outra.revogar(a.chave.id, 'cli');
  assert.equal(l.api.julgar(bearer(a.token)).estado, 'revogada', 'enxerga a revogação feita por outro processo');
});

test('marcarUso: grava o IP e no máximo uma vez por minuto', () => {
  const l = loja();
  const a = l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  l.api.marcarUso(a.chave.id, '203.0.113.7');
  let c = l.api.listar()[0];
  assert.ok(c.ultimoUsoEm);
  assert.equal(c.ultimoUsoIp, '203.0.113.7');
  const primeiro = c.ultimoUsoEm;
  l.relogio.avanca(30 * 1000);
  l.api.marcarUso(a.chave.id, '198.51.100.9');
  c = l.api.listar()[0];
  assert.equal(c.ultimoUsoIp, '203.0.113.7', 'dentro do minuto não regrava');
  assert.equal(c.ultimoUsoEm, primeiro);
  l.relogio.avanca(31 * 1000);
  l.api.marcarUso(a.chave.id, '198.51.100.9');
  c = l.api.listar()[0];
  assert.equal(c.ultimoUsoIp, '198.51.100.9');
  assert.notEqual(c.ultimoUsoEm, primeiro);
});

test('limite de tentativas inválidas: 20 em 10 minutos por IP, e a janela passa', () => {
  const l = loja();
  for (let i = 0; i < 19; i += 1) l.api.registrarFalha('1.1.1.1');
  assert.equal(l.api.bloqueio('1.1.1.1').bloqueado, false);
  l.api.registrarFalha('1.1.1.1');
  const b = l.api.bloqueio('1.1.1.1');
  assert.equal(b.bloqueado, true);
  assert.ok(b.retryAfter > 0 && b.retryAfter <= 600);
  assert.equal(l.api.bloqueio('2.2.2.2').bloqueado, false, 'outro IP não é afetado');
  l.relogio.avanca(10 * 60 * 1000 + 1);
  assert.equal(l.api.bloqueio('1.1.1.1').bloqueado, false);
});

test('dataDir é o padrão e chavesApiArquivo permite trocar', () => {
  const l = loja();
  assert.equal(l.api.ARQUIVO, path.join(l.dataDir, 'chaves-api.json'));
  const outro = path.join(pastaTemp('outro'), 'k.json');
  const l2 = loja({ chavesApiArquivo: outro });
  l2.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  assert.ok(fs.existsSync(outro));
});

test('corrida: A leu a chave ativa, B revogou, A marca uso e a chave continua revogada', () => {
  const l = loja();
  const a = l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  const b = criarChavesApi({ config: { dataDir: l.dataDir }, log: l.cap.log });
  assert.equal(l.api.julgar(bearer(a.token)).estado, 'valida', 'A viu a chave ativa');
  assert.equal(b.revogar(a.chave.id, 'cli').ok, true);
  const antes = fs.readFileSync(l.arquivo, 'utf8');
  l.api.marcarUso(a.chave.id, '203.0.113.7');
  assert.equal(fs.readFileSync(l.arquivo, 'utf8'), antes, 'marcar uso não pode reescrever chaves-api.json');
  assert.equal(l.api.julgar(bearer(a.token)).estado, 'revogada');
  assert.equal(b.julgar(bearer(a.token)).estado, 'revogada');
  const uso = path.join(l.dataDir, 'chaves-api-uso.json');
  assert.equal(fs.statSync(uso).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(uso, 'utf8')).usos[a.chave.id].ip, '203.0.113.7');
  const c = l.api.listar()[0];
  assert.equal(c.ultimoUsoIp, '203.0.113.7', 'listar junta os dois arquivos');
  assert.ok(c.revogadaEm);
});

test('revogar relê o disco dentro da trava, mesmo com cache velho', () => {
  const l = loja();
  const a = l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  l.api.listar(); // aquece o cache de A
  const b = criarChavesApi({ config: { dataDir: l.dataDir }, log: l.cap.log });
  const nova = b.criar({ nome: 'B', escopos: ['diagnostico'] });
  assert.equal(l.api.revogar(a.chave.id, 'x').ok, true);
  const ids = JSON.parse(fs.readFileSync(l.arquivo, 'utf8')).chaves.map((c) => c.id);
  assert.ok(ids.includes(nova.chave.id), 'a chave criada por B não pode sumir quando A revoga');
  assert.equal(fs.existsSync(`${l.arquivo}.lock`), false, 'a trava é solta');
});

test('duas criações concorrentes em processos diferentes não se perdem', async () => {
  const { spawn } = require('node:child_process');
  const l = loja();
  const lib = path.join(__dirname, '..', 'lib', 'chaves-api.js');
  const script = `const { criarChavesApi } = require(${JSON.stringify(lib)});
    const api = criarChavesApi({ config: { dataDir: ${JSON.stringify(l.dataDir)} }, log: (n, m) => process.stderr.write(m + '\\n') });
    for (let i = 0; i < 8; i++) { const r = api.criar({ nome: 'p' + process.pid + '-' + i, escopos: ['diagnostico'] }); if (!r.ok) { process.stderr.write(r.erro + '\\n'); process.exit(1); } }`;
  const roda = () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (codigo) => resolve({ codigo, err }));
  });
  const rs = await Promise.all([roda(), roda(), roda()]);
  for (const r of rs) assert.equal(r.codigo, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(l.arquivo, 'utf8')).chaves.length, 24);
});

test('trava velha (mais de 30 s) é removida com log; trava recente faz recusar com motivo', () => {
  const l = loja();
  const trava = `${l.arquivo}.lock`;
  fs.writeFileSync(trava, JSON.stringify({ pid: 99999, em: 'antiga' }));
  const velho = new Date(Date.now() - 60_000);
  fs.utimesSync(trava, velho, velho);
  const r = l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  assert.equal(r.ok, true);
  assert.match(l.cap.texto(), /trava.*removida/);
  assert.equal(fs.existsSync(trava), false);

  fs.writeFileSync(trava, JSON.stringify({ pid: process.pid, em: 'agora' }));
  const t0 = Date.now();
  const r2 = l.api.criar({ nome: 'B', escopos: ['diagnostico'] });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 503);
  assert.match(r2.erro, /outro processo/);
  assert.ok(Date.now() - t0 >= 2500, 'esperou ~3 s antes de desistir');
  assert.equal(l.api.listar().length, 1, 'a criação recusada não gravou');
  fs.unlinkSync(trava);
});

test('arquivo ilegível: criar e revogar recusam sem sobrescrever', () => {
  const l = loja();
  l.api.criar({ nome: 'A', escopos: ['diagnostico'] });
  fs.writeFileSync(l.arquivo, '{ quebrado');
  const c = l.api.criar({ nome: 'B', escopos: ['diagnostico'] });
  assert.equal(c.ok, false);
  assert.match(c.erro, /ilegível/);
  assert.equal(fs.readFileSync(l.arquivo, 'utf8'), '{ quebrado');
  assert.equal(l.api.revogar('x', 'y').ok, false);
});
