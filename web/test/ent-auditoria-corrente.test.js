'use strict';
// Auditoria completa, a corrente entre arquivos: rotação por mês (Node e bash), verificação que atravessa os
// arquivos, poda por retenção, exportação (jsonl e csv) e a origem "controle".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { criarAuditoria, ZERO } = require('../lib/auditoria');
const corrente = require('../lib/auditoria-corrente');
const { criarProtecoes } = require('../lib/protecoes');
const { pastaTemp, capturaLog } = require('./ajuda');

const REPO = path.join(__dirname, '..', '..');

function cenario(nivel, agoraInicial, ajustes) {
  const raiz = path.join(pastaTemp('corr'), 'raiz');
  fs.mkdirSync(path.join(raiz, 'etc', 'dgclaw'), { recursive: true });
  if (nivel) fs.writeFileSync(path.join(raiz, 'etc', 'dgclaw', 'protecoes.json'), JSON.stringify({ versao: 1, nivel, ajustes: ajustes || {} }));
  const cap = capturaLog();
  const protecoes = criarProtecoes({ caminho: path.join(raiz, 'etc', 'dgclaw', 'protecoes.json'), log: cap.log });
  const caminho = path.join(raiz, 'var', 'log', 'dgclaw', 'auditoria.jsonl');
  let agora = Date.parse(agoraInicial || '2026-08-15T12:00:00Z');
  const aud = criarAuditoria({ caminho, protecoes, log: cap.log, agora: () => agora });
  return { raiz, caminho, aud, cap, pasta: path.dirname(caminho), avanca: (iso) => { agora = Date.parse(iso); }, ms: () => agora };
}

const nomes = (pasta) => fs.readdirSync(pasta).filter((n) => n.startsWith('auditoria')).sort();

test('nível básico nunca rotaciona; completa fecha o mês na primeira linha do mês seguinte', () => {
  const b = cenario('escritorio');
  b.aud.registrar('a', {}, 'ana');
  b.avanca('2026-09-02T10:00:00Z');
  b.aud.registrar('b', {}, 'ana');
  assert.deepEqual(nomes(b.pasta), ['auditoria.jsonl']);

  const c = cenario('empresa');
  const l1 = JSON.parse(c.aud.registrar('a', {}, 'ana'));
  c.aud.registrar('b', {}, 'ana');
  assert.deepEqual(nomes(c.pasta), ['auditoria.jsonl']);
  c.avanca('2026-09-02T10:00:00Z');
  const l3 = JSON.parse(c.aud.registrar('c', {}, 'ana'));
  assert.deepEqual(nomes(c.pasta), ['auditoria-2026-08.jsonl', 'auditoria.jsonl']);
  const fechado = fs.readFileSync(path.join(c.pasta, 'auditoria-2026-08.jsonl'), 'utf8').trim().split('\n');
  assert.equal(fechado.length, 2);
  assert.equal(JSON.parse(fechado[0]).hash, l1.hash);
  assert.equal(l3.ant, JSON.parse(fechado[1]).hash, 'a primeira linha do mês novo guarda o hash da última do mês anterior');
  assert.deepEqual(c.aud.verificar(), { ok: true, linhas: 3 });
  assert.equal(fs.statSync(c.caminho).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${c.caminho}.trava`), false);
});

test('a conferência atravessa os arquivos e aponta o arquivo e a linha quando algo é mexido', () => {
  const c = cenario('empresa');
  for (let i = 0; i < 3; i += 1) c.aud.registrar('ago', { i }, 'ana');
  c.avanca('2026-09-10T10:00:00Z');
  for (let i = 0; i < 3; i += 1) c.aud.registrar('set', { i }, 'ana');
  c.avanca('2026-10-01T00:00:01Z');
  c.aud.registrar('out', {}, 'ana');
  assert.deepEqual(nomes(c.pasta), ['auditoria-2026-08.jsonl', 'auditoria-2026-09.jsonl', 'auditoria.jsonl']);
  assert.deepEqual(c.aud.verificar(), { ok: true, linhas: 7 });

  // alterar uma linha de agosto
  const ago = path.join(c.pasta, 'auditoria-2026-08.jsonl');
  const original = fs.readFileSync(ago, 'utf8');
  fs.writeFileSync(ago, original.replace('"i":1', '"i":99'));
  let r = c.aud.verificar();
  assert.equal(r.ok, false);
  assert.equal(r.quebradaEm, 2);
  assert.equal(r.arquivo, 'auditoria-2026-08.jsonl');
  assert.equal(r.linhaNoArquivo, 2);
  fs.writeFileSync(ago, original);

  // apagar o arquivo de setembro: a primeira linha de outubro não bate mais
  const set = path.join(c.pasta, 'auditoria-2026-09.jsonl');
  const guardado = fs.readFileSync(set);
  fs.unlinkSync(set);
  r = c.aud.verificar();
  assert.equal(r.ok, false);
  assert.equal(r.arquivo, 'auditoria.jsonl');
  assert.equal(r.linhaNoArquivo, 1);
  fs.writeFileSync(set, guardado);
  assert.equal(c.aud.verificar().ok, true);
});

test('bash e Node continuam a mesma corrente na virada do mês', () => {
  const c = cenario('empresa', '2026-01-10T12:00:00Z');
  c.aud.registrar('node1', {}, 'ana');
  const env = { ...process.env, DGCLAW_RAIZ: c.raiz, NO_COLOR: '1', DGCLAW_QUEM: 'bash', REPO_DGCLAW: REPO };
  // o relógio do Node está em janeiro de 2026 e o do bash é o de verdade: o bash fecha o mês de janeiro
  execFileSync('bash', ['-c', `set -euo pipefail; APP_DIR="$REPO_DGCLAW"; . "$REPO_DGCLAW/lib/comum.sh"; . "$REPO_DGCLAW/lib/protecoes.sh"; . "$REPO_DGCLAW/lib/enterprise/auditoria.sh"; auditar bash1`], { env });
  assert.deepEqual(nomes(c.pasta), ['auditoria-2026-01.jsonl', 'auditoria.jsonl']);
  assert.deepEqual(corrente.verificar(c.caminho), { ok: true, linhas: 2 });
  const viva = JSON.parse(fs.readFileSync(c.caminho, 'utf8').trim());
  assert.equal(viva.origem, 'cli');
  assert.equal(viva.ant, JSON.parse(fs.readFileSync(path.join(c.pasta, 'auditoria-2026-01.jsonl'), 'utf8').trim()).hash);
});

test('origem "controle": a auditoria aceita, no Node e no bash (DGCLAW_AUDITORIA_ORIGEM)', () => {
  const c = cenario('empresa', new Date().toISOString());
  const l = JSON.parse(c.aud.registrar('controle.executou', { acao: 'agente.criar' }, 'controle', 'controle'));
  assert.equal(l.origem, 'controle');
  const env = { ...process.env, DGCLAW_RAIZ: c.raiz, NO_COLOR: '1', DGCLAW_AUDITORIA_ORIGEM: 'controle', REPO_DGCLAW: REPO };
  execFileSync('bash', ['-c', `set -euo pipefail; APP_DIR="$REPO_DGCLAW"; . "$REPO_DGCLAW/lib/comum.sh"; . "$REPO_DGCLAW/lib/protecoes.sh"; . "$REPO_DGCLAW/lib/enterprise/auditoria.sh"; auditar controle.aprovou`], { env });
  const ls = fs.readFileSync(c.caminho, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.deepEqual(ls.map((x) => x.origem), ['controle', 'controle']);
  assert.equal(corrente.verificar(c.caminho).ok, true);
  const ruim = { ...env, DGCLAW_AUDITORIA_ORIGEM: 'Con trole!' };
  assert.throws(() => execFileSync('bash', ['-c', `set -euo pipefail; APP_DIR="$REPO_DGCLAW"; . "$REPO_DGCLAW/lib/comum.sh"; . "$REPO_DGCLAW/lib/protecoes.sh"; . "$REPO_DGCLAW/lib/enterprise/auditoria.sh"; auditar x`], { env: ruim, stdio: 'pipe' }), /origem/);
});

test('exportar: filtros por data, evento e quem; jsonl devolve as linhas originais; csv protege fórmulas', () => {
  const c = cenario('empresa', '2026-08-20T12:00:00Z');
  c.aud.registrar('login_ok', { via: 'senha' }, 'ana');
  c.aud.registrar('login_falha', {}, '=SOMA(A1)');
  c.avanca('2026-09-05T08:00:00Z');
  c.aud.registrar('login_ok', { texto: 'com "aspas", vírgula' }, 'bia');
  c.avanca('2026-09-06T08:00:00Z');
  c.aud.registrar('outro', {}, 'bia');

  const tudo = corrente.exportar(c.caminho, {}, 'jsonl');
  assert.equal(tudo.total, 4);
  assert.equal(tudo.corpo.split('\n').filter(Boolean).length, 4);
  const set = corrente.exportar(c.caminho, { de: '2026-09-01', ate: '2026-09-05' }, 'jsonl');
  assert.equal(set.total, 1);
  assert.equal(corrente.exportar(c.caminho, { evento: 'login_ok' }, 'jsonl').total, 2);
  assert.equal(corrente.exportar(c.caminho, { quem: 'bia' }, 'jsonl').total, 2);
  assert.equal(corrente.exportar(c.caminho, { ate: '2026-08-20' }, 'jsonl').total, 2);

  // o que foi exportado em jsonl continua conferível: cada linha tem hash e ant encadeados
  const linhas = tudo.corpo.trim().split('\n');
  for (let i = 1; i < linhas.length; i += 1) assert.equal(JSON.parse(linhas[i]).ant, JSON.parse(linhas[i - 1]).hash);

  const csv = corrente.exportar(c.caminho, {}, 'csv');
  assert.equal(csv.extensao, 'csv');
  assert.ok(csv.corpo.startsWith('\ufeff"ts","evento","quem","origem","dados","ant","hash"'));
  assert.match(csv.corpo, /"'=SOMA\(A1\)"/);
  assert.match(csv.corpo, /com \\""aspas\\"", vírgula/);

  assert.throws(() => corrente.exportar(c.caminho, { de: '2026-13-40' }, 'jsonl'), /data inicial/);
  assert.throws(() => corrente.exportar(c.caminho, {}, 'xml'), /formato/);
});

test('poda: a conferência passa a esperar o hash da poda na primeira linha que sobrou', () => {
  const c = cenario('empresa', '2026-01-10T12:00:00Z');
  c.aud.registrar('a', {}, 'ana');
  c.avanca('2026-02-10T12:00:00Z');
  const l2 = JSON.parse(c.aud.registrar('b', {}, 'ana'));
  c.avanca('2026-03-10T12:00:00Z');
  c.aud.registrar('c', {}, 'ana');
  const jan = path.join(c.pasta, 'auditoria-2026-01.jsonl');
  const hashJan = JSON.parse(fs.readFileSync(jan, 'utf8').trim()).hash;
  fs.unlinkSync(jan);
  assert.equal(corrente.verificar(c.caminho).ok, false, 'sem a poda registrada, faltar o primeiro mês é uma quebra');
  fs.writeFileSync(path.join(c.pasta, 'auditoria-poda.json'), JSON.stringify({ ate_hash: hashJan }));
  assert.deepEqual(corrente.verificar(c.caminho), { ok: true, linhas: 2 });
  assert.equal(l2.ant, hashJan);
  assert.equal(corrente.ZERO, ZERO);
});

test('no nível pessoal e com auditoria=nao nada é criado', () => {
  const c = cenario(null);
  assert.equal(c.aud.registrar('x', {}, 'ana'), null);
  assert.equal(fs.existsSync(c.caminho), false);
});
