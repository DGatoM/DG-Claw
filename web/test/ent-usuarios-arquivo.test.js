'use strict';
// usuarios.json: semente na primeira partida, modo 600, trava, gravação só quando há mudança e erro que se explica.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarArquivoUsuarios, ErroUsuarios } = require('../lib/usuarios-arquivo');
const { pastaTemp } = require('./ajuda');

function novo(extra) {
  const dir = pastaTemp('usr');
  fs.chmodSync(dir, 0o700);
  const logs = [];
  const a = criarArquivoUsuarios(Object.assign({ dataDir: dir, log: (n, m) => logs.push(`[${n}] ${m}`) }, extra));
  return { dir, a, logs, caminho: path.join(dir, 'usuarios.json') };
}

test('primeira leitura cria o arquivo com a semente, em modo 600', () => {
  const { a, caminho } = novo({ semente: () => [{ usuario: 'Dono', papel: 'ti', hash: 'h' }] });
  assert.equal(fs.existsSync(caminho), false, 'criar o objeto não toca o disco');
  const lista = a.lista();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].nome, 'Dono', 'o que falta é preenchido');
  assert.deepEqual(lista[0].agentes, []);
  assert.equal(lista[0].totp.ativo, false);
  assert.equal(fs.statSync(caminho).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(caminho, 'utf8')).versao, 1);
});

test('buscar ignora maiúsculas; atualizar grava e a leitura seguinte já vê', () => {
  const { a } = novo({ semente: () => [{ usuario: 'Dono', papel: 'ti' }] });
  assert.equal(a.buscar('dono').usuario, 'Dono');
  assert.equal(a.buscar('  DONO ').usuario, 'Dono');
  assert.equal(a.buscar('outro'), null);
  a.atualizar((d) => { d.usuarios.push({ usuario: 'ana', papel: 'funcionario', agentes: ['luna'] }); return null; });
  assert.deepEqual(a.buscar('ana').agentes, ['luna']);
});

test('semMudanca não regrava; erro dentro de atualizar não grava nada', () => {
  const { a, caminho } = novo({ semente: () => [{ usuario: 'a', papel: 'ti' }] });
  a.lista();
  const antes = fs.statSync(caminho).mtimeMs;
  const r = a.atualizar(() => ({ semMudanca: true, valor: 7 }));
  assert.equal(r.valor, 7);
  assert.equal(fs.statSync(caminho).mtimeMs, antes);
  assert.throws(() => a.atualizar((d) => { d.usuarios.push({ usuario: 'x' }); throw new Error('falhou no meio'); }), /falhou no meio/);
  assert.equal(a.buscar('x'), null);
});

test('arquivo que não é JSON: erro em português com o caminho e o que fazer, sem apagar nem recriar', () => {
  const { a, caminho } = novo();
  fs.writeFileSync(caminho, '{quebrado', { mode: 0o600 });
  assert.throws(() => a.lista(), (e) => e instanceof ErroUsuarios && e.status === 503 && e.message.includes(caminho) && /não é um JSON válido/.test(e.message) && /Restaure/.test(e.message));
  assert.equal(fs.readFileSync(caminho, 'utf8'), '{quebrado', 'o arquivo ruim fica como está para alguém consertar');
});

test('trava velha (processo morto) é removida com aviso; trava recente faz esperar e depois desiste explicando', () => {
  const { a, caminho, logs } = novo({ semente: () => [] });
  a.lista();
  fs.mkdirSync(`${caminho}.trava`);
  const velho = new Date(Date.now() - 120000);
  fs.utimesSync(`${caminho}.trava`, velho, velho);
  a.atualizar(() => ({ semMudanca: true }));
  assert.ok(logs.some((l) => /provavelmente morreu/.test(l)));
  assert.equal(fs.existsSync(`${caminho}.trava`), false);
});

test('não sobra pasta de trava depois de uma atualização', () => {
  const { a, caminho } = novo({ semente: () => [] });
  a.atualizar((d) => { d.usuarios.push({ usuario: 'b' }); return null; });
  assert.equal(fs.existsSync(`${caminho}.trava`), false);
});
