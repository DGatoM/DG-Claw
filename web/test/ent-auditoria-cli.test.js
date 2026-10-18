'use strict';
// web/bin/auditoria.js: a poda por retenção (meses velhos saem, a corrente continua conferível a partir da poda),
// e a recusa de apagar quando a corrente está quebrada ou sem --confirmar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { criarAuditoria } = require('../lib/auditoria');
const { criarProtecoes } = require('../lib/protecoes');
const corrente = require('../lib/auditoria-corrente');
const { pastaTemp, capturaLog } = require('./ajuda');

const BIN = path.join(__dirname, '..', 'bin', 'auditoria.js');

function cenario() {
  const raiz = pastaTemp('cli');
  const etc = path.join(raiz, 'etc'); const log = path.join(raiz, 'log'); const dados = path.join(raiz, 'dados');
  for (const d of [etc, log, dados]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(etc, 'protecoes.json'), JSON.stringify({ versao: 1, nivel: 'empresa', ajustes: {} }));
  fs.writeFileSync(path.join(etc, 'web.env'), '');
  const cap = capturaLog();
  let agora = Date.parse('2020-01-15T10:00:00Z');
  const base = path.join(log, 'auditoria.jsonl');
  const aud = criarAuditoria({ caminho: base, protecoes: criarProtecoes({ caminho: path.join(etc, 'protecoes.json'), log: cap.log }), log: cap.log, agora: () => agora });
  const env = { ...process.env, DGCLAW_WEB_ENV: path.join(etc, 'web.env'), DGCLAW_PROTECOES: path.join(etc, 'protecoes.json'), DGCLAW_AUDITORIA: base, DGCLAW_WEB_DATA: dados, DGCLAW_QUEM: 'testador' };
  const rodar = (...args) => spawnSync('node', [BIN, ...args], { env, encoding: 'utf8' });
  return { base, aud, etc, ir: (iso) => { agora = Date.parse(iso); }, rodar, pasta: log };
}

test('retenção: só meses fechados além do prazo saem, depois de --confirmar, e a corrente segue conferível', () => {
  const c = cenario();
  c.aud.registrar('a', {}, 'ana');
  c.ir('2020-02-10T10:00:00Z'); c.aud.registrar('b', {}, 'ana');
  c.ir('2020-03-10T10:00:00Z'); c.aud.registrar('c', {}, 'ana');
  c.ir('2026-10-18T10:00:00Z'); c.aud.registrar('d', {}, 'ana');
  const nomes = () => fs.readdirSync(c.pasta).filter((n) => n.startsWith('auditoria') && !n.endsWith('.trava')).sort();
  assert.deepEqual(nomes(), ['auditoria-2020-01.jsonl', 'auditoria-2020-02.jsonl', 'auditoria-2020-03.jsonl', 'auditoria.jsonl']);

  let r = c.rodar('retencao', 'aplicar');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2020-01, 2020-02, 2020-03/);
  assert.match(r.stdout, /Nada foi apagado/);
  assert.equal(nomes().length, 4, 'sem --confirmar nada é apagado');

  r = c.rodar('retencao', 'definir', '300');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no mínimo 365 dias/);

  const hashMar = JSON.parse(fs.readFileSync(path.join(c.pasta, 'auditoria-2020-03.jsonl'), 'utf8').trim()).hash;
  r = c.rodar('retencao', 'aplicar', '--confirmar');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(nomes(), ['auditoria-poda.json', 'auditoria.jsonl']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.pasta, 'auditoria-poda.json'), 'utf8')).ate_hash, hashMar);
  const v = corrente.verificar(c.base);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(c.rodar('verificar').status, 0);
  const ev = corrente.lerEventos(c.base, {}).map((e) => e.obj);
  assert.equal(ev[ev.length - 1].evento, 'auditoria_podada');
  assert.deepEqual(ev[ev.length - 1].dados.meses, ['2020-01', '2020-02', '2020-03']);
  assert.equal(ev[ev.length - 1].origem, 'cli');
});

test('retenção: com a corrente quebrada não apaga nada', () => {
  const c = cenario();
  c.aud.registrar('a', {}, 'ana');
  c.ir('2020-02-10T10:00:00Z'); c.aud.registrar('b', {}, 'ana');
  c.ir('2026-10-18T10:00:00Z'); c.aud.registrar('c', {}, 'ana');
  const arq = path.join(c.pasta, 'auditoria-2020-01.jsonl');
  fs.writeFileSync(arq, fs.readFileSync(arq, 'utf8').replace('"quem":"ana"', '"quem":"x"'));
  const r = c.rodar('retencao', 'aplicar', '--confirmar');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /corrente está quebrada/);
  assert.equal(fs.existsSync(arq), true);
});

test('verificar e selo em trilha vazia explicam o que fazer', () => {
  const c = cenario();
  let r = c.rodar('verificar');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Ainda não há trilha/);
  r = c.rodar('selo');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /O que fazer/);
  r = c.rodar('exportar', '--formato', 'xml');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /formato/);
});
