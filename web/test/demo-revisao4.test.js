'use strict';
// Quarta revisão do modo demonstração: a confirmação de ENVIO revalida a geração do reset e o estado do cartão
// depois de esperar a leitura dos anexos (docs/MODO-DEMONSTRACAO.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const execFileP = require('node:util').promisify(require('node:child_process').execFile);
const { subirDemo } = require('./demo-ajuda');
const { pastaTemp } = require('./ajuda');

const ROTAS = { envio: '/api/demo/v1/envio' };

/** Leitor de anexo que fica preso até `solta()` (ou `solta(erro)`), e só então lê (ou falha). */
function leitorPreso() {
  const est = { casa: null, preso: null, solta: null, segurando: false };
  est.espera = new Promise((ok) => { est.preso = ok; });
  let libera; const portao = new Promise((ok) => { libera = ok; });
  est.solta = (erro) => libera(erro);
  est.exec = async (arq, args, opc) => {
    if (est.segurando) {
      est.segurando = false; est.preso();
      const erro = await portao;
      if (erro) throw erro;
    }
    const [, , , , , , , script, , ...partes] = args;
    return execFileP('python3', ['-I', '-c', script, est.casa, ...partes], opc);
  };
  return est;
}

async function comPedido(corpo) {
  const l = leitorPreso();
  const dir = pastaTemp('demo-rev4');
  const reset = path.join(dir, 'reset-falso.sh');
  fs.writeFileSync(reset, '#!/usr/bin/env bash\necho "==> ok"\nexit 0\n', { mode: 0o755 });
  const w = await subirDemo({ opcoesServidor: { demoExec: l.exec, demoResetBin: reset } });
  try {
    l.casa = w.casa;
    fs.writeFileSync(path.join(w.casa, 'saida', 'p.pdf'), 'PDF');
    const ref = await w.liberaContato();
    const r = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref, texto: 'oi', anexos: ['/home/agente/saida/p.pdf'] });
    assert.equal(r.status, 201, r.texto);
    await corpo(w, l, r.json.id);
  } finally { await w.fechar(); }
}
const arqCartao = (w, id) => path.join(w.dados, 'demo', 'cartoes', `${id}.json`);
const estadoGravado = (w, id) => JSON.parse(fs.readFileSync(arqCartao(w, id), 'utf8')).estado;
const quieto = () => new Promise((ok) => setTimeout(ok, 80));

test('reset concluído durante a leitura dos anexos: o envio não sai e o cartão antigo não é recriado', () => comPedido(async (w, l, id) => {
  l.segurando = true;
  const confirmar = w.decide(id, { decisao: 'confirmar' });
  await l.espera;
  assert.equal((await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } })).status, 202);
  for (let i = 0; i < 100; i++) { if ((await w.c.get('/api/demo/reset/estado')).json.fase !== 'em_andamento') break; await new Promise((ok) => setTimeout(ok, 20)); }
  // O reset de verdade move o cartão para o arquivo; aqui o simulamos.
  fs.rmSync(arqCartao(w, id));
  l.solta();
  const r = await confirmar;
  assert.equal(r.status, 503, r.texto);
  await quieto();
  assert.equal(w.fake.envios.length, 0, 'nada pode sair para o provedor');
  assert.equal(fs.existsSync(arqCartao(w, id)), false, 'o cartão do cliente anterior não pode ser recriado');
}));

test('cartão que expira durante a leitura dos anexos não termina como enviado', () => comPedido(async (w, l, id) => {
  l.segurando = true;
  const confirmar = w.decide(id, { decisao: 'confirmar' });
  await l.espera;
  w.relogio.t += 11 * 60 * 1000;
  l.solta();
  const r = await confirmar;
  assert.equal(r.status, 409, r.texto);
  await quieto();
  assert.equal(w.fake.envios.length, 0);
  assert.equal(estadoGravado(w, id), 'expirado');
}));

test('erro na leitura dos anexos não regrava um cartão que já foi arquivado', () => comPedido(async (w, l, id) => {
  l.segurando = true;
  const confirmar = w.decide(id, { decisao: 'confirmar' });
  await l.espera;
  fs.rmSync(arqCartao(w, id)); // o reset arquivou o cartão
  l.solta(Object.assign(new Error('container fora'), { code: 125, stderr: 'no container' }));
  const r = await confirmar;
  assert.ok(r.status === 409 || r.status === 503, r.texto);
  assert.equal(fs.existsSync(arqCartao(w, id)), false, 'o cartão arquivado não pode voltar como "falhou"');
  assert.equal(w.fake.envios.length, 0);
}));

test('erro na leitura dos anexos com o cartão ainda válido continua virando falha com motivo', () => comPedido(async (w, l, id) => {
  l.segurando = true;
  const confirmar = w.decide(id, { decisao: 'confirmar' });
  await l.espera;
  l.solta(Object.assign(new Error('container fora'), { code: 125, stderr: 'no container' }));
  const r = await confirmar;
  assert.ok(r.status >= 400, r.texto);
  assert.equal(estadoGravado(w, id), 'falhou');
}));
