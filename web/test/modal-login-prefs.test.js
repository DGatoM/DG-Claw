'use strict';
// A escolha sobre o modal "Faça o login nos seus agentes": guardada no servidor, por usuário.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb } = require('./ajuda');

const ROTA = '/api/v1/modal-login/preferencia';

async function cenario() {
  const t = await subirWeb({});
  await t.login();
  return { t, fechar: () => t.web.fechar() };
}

test('padrão: nada visto, aviso ligado', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.get(ROTA);
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual([r.json.vistos, r.json.nao_mostrar_mais], [[], false]);
  } finally { await s.fechar(); }
});

test('vistos se acumulam sem repetir, "não mostrar mais" liga e persiste em arquivo 600', async () => {
  const s = await cenario();
  try {
    let r = await s.t.c.post(ROTA, { json: { vistos: ['sofia'] } });
    assert.equal(r.status, 200, r.texto);
    r = await s.t.c.post(ROTA, { json: { vistos: ['sofia', 'rita'] } });
    assert.deepEqual(r.json.vistos, ['sofia', 'rita']);
    assert.equal(r.json.nao_mostrar_mais, false);
    r = await s.t.c.post(ROTA, { json: { nao_mostrar_mais: true } });
    assert.deepEqual([r.json.vistos, r.json.nao_mostrar_mais], [['sofia', 'rita'], true]);
    const arq = path.join(s.t.dados, 'modal-login.json');
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    assert.equal((await s.t.c.get(ROTA)).json.nao_mostrar_mais, true);
  } finally { await s.fechar(); }
});

test('entrada ruim recebe 400 com o motivo; sem sessão 401; sem Origin 403', async () => {
  const s = await cenario();
  try {
    let r = await s.t.c.post(ROTA, { json: { vistos: 'sofia' } });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /lista de ids/);
    r = await s.t.c.post(ROTA, { json: { vistos: ['../x'] } });
    assert.equal(r.status, 400);
    r = await s.t.c.post(ROTA, { json: { nao_mostrar_mais: false } });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /só aceita true/);
    assert.equal((await s.t.c.pedir('POST', ROTA, { origin: false, json: {} })).status, 403);
    assert.equal((await s.t.c.pedir('DELETE', ROTA)).status, 405);
    const { cliente } = require('./ajuda');
    assert.equal((await cliente(s.t.porta).get(ROTA)).status, 401);
  } finally { await s.fechar(); }
});

test('arquivo ilegível: erro 503 que explica, e o arquivo não é apagado', async () => {
  const s = await cenario();
  try {
    const arq = path.join(s.t.dados, 'modal-login.json');
    fs.writeFileSync(arq, '{quebrado');
    const r = await s.t.c.post(ROTA, { json: { nao_mostrar_mais: true } });
    assert.equal(r.status, 503);
    assert.match(r.json.erro, /ilegível/);
    assert.equal(fs.readFileSync(arq, 'utf8'), '{quebrado');
  } finally { await s.fechar(); }
});

test('escolha de outro usuário no arquivo sobrevive à gravação', async () => {
  const s = await cenario();
  try {
    const arq = path.join(s.t.dados, 'modal-login.json');
    fs.writeFileSync(arq, JSON.stringify({ versao: 1, usuarios: { outro: { vistos: ['ze'], nao_mostrar_mais: true } } }), { mode: 0o600 });
    await s.t.c.post(ROTA, { json: { vistos: ['sofia'] } });
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    assert.deepEqual(j.usuarios.outro, { vistos: ['ze'], nao_mostrar_mais: true });
    assert.deepEqual(j.usuarios.dono.vistos, ['sofia']);
  } finally { await s.fechar(); }
});
