'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { criarAuditoria, ZERO } = require('../lib/auditoria');
const { criarProtecoes } = require('../lib/protecoes');
const { pastaTemp, capturaLog } = require('./ajuda');

const REPO = path.join(__dirname, '..', '..');

/** Raiz falsa como a do bash: etc/dgclaw/protecoes.json e var/log/dgclaw/auditoria.jsonl. */
function cenario(nivel, opcoes) {
  const raiz = path.join(pastaTemp('aud'), 'raiz');
  fs.mkdirSync(path.join(raiz, 'etc', 'dgclaw'), { recursive: true });
  if (nivel) fs.writeFileSync(path.join(raiz, 'etc', 'dgclaw', 'protecoes.json'), JSON.stringify({ versao: 1, nivel, ajustes: {} }));
  const cap = capturaLog();
  const protecoes = criarProtecoes({ caminho: path.join(raiz, 'etc', 'dgclaw', 'protecoes.json'), log: cap.log });
  const caminho = path.join(raiz, 'var', 'log', 'dgclaw', 'auditoria.jsonl');
  const aud = criarAuditoria({ caminho, protecoes, log: cap.log, ...(opcoes || {}) });
  return { raiz, caminho, aud, cap };
}

const linhasDe = (c) => fs.readFileSync(c, 'utf8').split('\n').filter(Boolean);

test('no nível pessoal a auditoria não grava nada', () => {
  const { aud, caminho } = cenario(null);
  assert.equal(aud.registrar('login', { usuario: 'ana' }, 'ana'), null);
  assert.equal(fs.existsSync(caminho), false);
  assert.deepEqual(aud.verificar(), { ok: true, linhas: 0 });
});

test('grava linhas encadeadas, com os campos do contrato, arquivo 600 e sem trava sobrando', () => {
  const { aud, caminho } = cenario('escritorio', { agora: () => Date.UTC(2026, 9, 18, 12, 0, 0) });
  const a = JSON.parse(aud.registrar('login', { usuario: 'ana' }, 'ana', 'web'));
  const b = JSON.parse(aud.registrar('agente.criar', { slug: 'x' }, 'root', 'cli'));
  assert.deepEqual(Object.keys(a), ['ts', 'evento', 'quem', 'origem', 'dados', 'ant', 'hash']);
  assert.equal(a.ts, '2026-10-18T12:00:00.000Z');
  assert.equal(a.ant, ZERO);
  assert.equal(b.ant, a.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(a.origem, 'web');
  assert.equal(fs.statSync(caminho).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${caminho}.trava`), false);
  assert.deepEqual(aud.verificar(), { ok: true, linhas: 2 });
});

test('origem padrão é web', () => {
  const { aud } = cenario('empresa');
  assert.equal(JSON.parse(aud.registrar('x', {}, 'ana')).origem, 'web');
});

test('alterar uma linha antiga quebra a corrente e aponta qual', () => {
  const { aud, caminho } = cenario('empresa');
  for (let i = 0; i < 5; i += 1) aud.registrar('e', { i }, 'ana');
  const ls = linhasDe(caminho);
  ls[2] = ls[2].replace('"i":2', '"i":99');
  fs.writeFileSync(caminho, `${ls.join('\n')}\n`);
  const r = aud.verificar();
  assert.equal(r.ok, false);
  assert.equal(r.quebradaEm, 3);
  assert.equal(r.linhas, 2);
  assert.match(r.motivo, /alterada/);
});

test('apagar uma linha do meio quebra a corrente na linha seguinte', () => {
  const { aud, caminho } = cenario('empresa');
  for (let i = 0; i < 5; i += 1) aud.registrar('e', { i }, 'ana');
  const ls = linhasDe(caminho);
  ls.splice(1, 1);
  fs.writeFileSync(caminho, `${ls.join('\n')}\n`);
  const r = aud.verificar();
  assert.equal(r.ok, false);
  assert.equal(r.quebradaEm, 2);
  assert.match(r.motivo, /ant não bate/);
});

test('linha sem hash é apontada, e a próxima escrita recomeça a corrente com aviso', () => {
  const { aud, caminho, cap } = cenario('empresa');
  aud.registrar('a', {}, 'ana');
  fs.appendFileSync(caminho, '{"lixo":true}');
  assert.equal(aud.verificar().quebradaEm, 2);
  aud.registrar('b', {}, 'ana');
  assert.match(cap.texto(), /não tem hash válido/);
  assert.equal(linhasDe(caminho).length, 3, 'a linha cortada ganhou o fim de linha antes da nova');
});

test('texto com acento, aspas e caracteres de controle fecha a conta', () => {
  const { aud } = cenario('empresa');
  aud.registrar('nota', { texto: 'ação "difícil" \u007f \u0001 \n tab\t — fim 😀' }, 'ana');
  aud.registrar('nota', { texto: 'segunda' }, 'ana');
  assert.equal(aud.verificar().ok, true);
});

test('dados que não são objeto são recusados com explicação', () => {
  const { aud } = cenario('empresa');
  assert.throws(() => aud.registrar('x', [1], 'ana'), /precisam ser um objeto/);
  assert.throws(() => aud.registrar('', {}, 'ana'), /nome do evento/);
});

test('trava velha (mais de 30 s) é removida com aviso; trava recente faz esperar e depois falar', () => {
  const { aud, caminho, cap } = cenario('empresa', { esperaMs: 200 });
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.mkdirSync(`${caminho}.trava`);
  const velho = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(`${caminho}.trava`, velho, velho);
  aud.registrar('depois-da-trava-velha', {}, 'ana');
  assert.match(cap.texto(), /mais de 30/);
  assert.equal(fs.existsSync(`${caminho}.trava`), false);

  fs.mkdirSync(`${caminho}.trava`);
  assert.throws(() => aud.registrar('preso', {}, 'ana'), /Não consegui a trava da auditoria/);
  assert.equal(linhasDe(caminho).length, 1, 'nada foi gravado sem a trava');
  fs.rmdirSync(`${caminho}.trava`);
});

function bash(raiz, script, args) {
  const env = { ...process.env, DGCLAW_RAIZ: raiz, NO_COLOR: '1', DGCLAW_QUEM: 'bash' };
  return { env, cmd: ['-c', `set -euo pipefail; APP_DIR="${REPO}"; . "${REPO}/lib/comum.sh"; . "${REPO}/lib/protecoes.sh"; . "${REPO}/lib/enterprise/auditoria.sh"; ${script}`, '_', ...(args || [])] };
}

test('bash e Node escrevem na mesma corrente sem quebrá-la (em sequência)', () => {
  const { aud, raiz, caminho } = cenario('empresa');
  aud.registrar('node1', { a: 1 }, 'ana');
  const b = bash(raiz, 'auditar bash1 "{\\"texto\\":\\"ação \\\\\\"x\\\\\\" \\"}"');
  execFileSync('bash', b.cmd, { env: b.env });
  aud.registrar('node2', { b: 2 }, 'ana');
  const c = bash(raiz, 'auditar bash2');
  execFileSync('bash', c.cmd, { env: c.env });
  const ls = linhasDe(caminho).map((l) => JSON.parse(l));
  assert.deepEqual(ls.map((l) => l.origem), ['web', 'cli', 'web', 'cli']);
  assert.equal(ls[1].quem, 'bash');
  assert.deepEqual(aud.verificar(), { ok: true, linhas: 4 });
  assert.equal(fs.statSync(caminho).mode & 0o777, 0o600);
});

test('bash em paralelo com o Node: 4 processos x 8 eventos + 20 do Node, corrente inteira', async () => {
  const { aud, raiz } = cenario('empresa');
  const filhos = [];
  for (let p = 0; p < 4; p += 1) {
    const b = bash(raiz, 'for i in 1 2 3 4 5 6 7 8; do auditar "par$1" "{\\"i\\":$i}"; done', [String(p)]);
    filhos.push(new Promise((resolve, reject) => {
      const f = spawn('bash', b.cmd, { env: b.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      f.stderr.on('data', (d) => { err += d; });
      f.on('exit', (cod) => (cod === 0 ? resolve() : reject(new Error(`bash ${p} saiu com ${cod}: ${err}`))));
    }));
  }
  for (let i = 0; i < 20; i += 1) aud.registrar('node', { i }, 'ana');
  await Promise.all(filhos);
  assert.deepEqual(aud.verificar(), { ok: true, linhas: 52 });
});

test('o bash que encontra auditoria=nao não grava nada', () => {
  const { raiz, caminho } = cenario(null);
  const b = bash(raiz, 'auditar x');
  execFileSync('bash', b.cmd, { env: b.env });
  assert.equal(fs.existsSync(caminho), false);
});
