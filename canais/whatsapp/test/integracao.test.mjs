import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarAnotadorIntegracao } from '../lib/integracao.mjs';

function anotadorFalso() {
  const chamadas = [];
  let emCurso = 0, maxEmCurso = 0;
  const liberar = [];
  const registrarIntegracao = (resultado, origem) => {
    chamadas.push(`${resultado}/${origem}`);
    emCurso += 1; maxEmCurso = Math.max(maxEmCurso, emCurso);
    return new Promise((r) => liberar.push(() => { emCurso -= 1; r(); }));
  };
  const logs = [];
  const { anotar } = criarAnotadorIntegracao({ registrar: (m) => logs.push(m), env: {}, opcoes: { registrarIntegracao } });
  const solta = async () => { while (liberar.length) { liberar.shift()(); await new Promise((r) => setImmediate(r)); } };
  return { anotar, chamadas, logs, solta, max: () => maxEmCurso };
}

test('rajada de mensagens: um registro por vez, ok seguido condensado, falhas na ordem', async () => {
  const a = anotadorFalso();
  a.anotar('ok', 'uso');
  for (let i = 0; i < 10; i++) a.anotar('ok', 'uso');
  a.anotar('desconectado', 'canal');
  a.anotar('ok', 'uso');
  a.anotar('ok', 'uso');
  await a.solta(); await a.solta();
  assert.equal(a.max(), 1);
  assert.deepEqual(a.chamadas, ['ok/uso', 'desconectado/canal', 'ok/uso']);
});

test('fila cheia: descarta com um aviso só, sem abrir processo', async () => {
  const a = anotadorFalso();
  for (let i = 0; i < 30; i++) a.anotar(i % 2 ? 'ok' : 'erro', 'uso');
  assert.equal(a.logs.filter((m) => m.includes('fila')).length, 1);
  await a.solta(); for (let i = 0; i < 25; i++) await a.solta();
  assert.equal(a.chamadas.length, 20);
});

test('quem espera (logout) não passa do prazo mesmo com a fila parada', async () => {
  const a = anotadorFalso();
  a.anotar('erro', 'uso');   // fica preso: ninguém solta
  const vivo = setTimeout(() => {}, 10000);   // o prazo é unref (não segura a ponte); aqui algo precisa manter o laço
  const t0 = Date.now();
  await a.anotar('desconectado', 'canal');
  clearTimeout(vivo);
  const dt = Date.now() - t0;
  assert.ok(dt >= 2900 && dt < 4500, `esperou ${dt} ms`);
});
