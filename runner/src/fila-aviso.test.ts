import test from "node:test";
import assert from "node:assert/strict";
import { avisoDeAtraso } from "./sessao/fila.js";
import { AVISO_DE_FILA_APOS_MS } from "./sessao/constantes.js";

const ENV = '<dgchat from="pessoa" chat="c" msg="w1" ts="2026-11-18T17:32:00Z">ok</dgchat>';

test("mensagem que entrou com o agente ocioso e não esperou sai sem aviso", () => {
  const agora = Date.now();
  assert.equal(avisoDeAtraso({ texto: ENV, em: agora - 1_000 }, agora), "");
  assert.equal(avisoDeAtraso({ texto: ENV, em: agora - (AVISO_DE_FILA_APOS_MS - 1) }, agora), "");
});

test("mensagem que esperou chega com a hora, o tempo e a regra da resposta curta", () => {
  const agora = new Date(2026, 10, 18, 14, 40, 0).getTime();
  const em = new Date(2026, 10, 18, 14, 32, 0).getTime();
  const aviso = avisoDeAtraso({ texto: ENV, em }, agora);
  assert.ok(aviso.startsWith("\n\n[Aviso do sistema:"), "vem depois da mensagem, fora do envelope");
  assert.match(aviso, /às 14:32/);
  assert.match(aviso, /cerca de 8 min/);
  assert.match(aviso, /não autoriza uma ação nova/);
});

test("entrou com o agente ocupado: aviso mesmo com espera de poucos segundos", () => {
  const agora = Date.now();
  const aviso = avisoDeAtraso({ texto: ENV, em: agora - 3_000, esperou: true }, agora);
  assert.match(aviso, /esperou alguns segundos na fila/);
});

test("comando literal e mensagem de canal externo saem intactos, mesmo depois de esperar", () => {
  const agora = Date.now();
  const velho = agora - 600_000;
  assert.equal(avisoDeAtraso({ texto: "/model sonnet", em: velho, esperou: true }, agora), "");
  assert.equal(avisoDeAtraso({ texto: '<canal-externo origem="whatsapp">oi</canal-externo>', em: velho, esperou: true }, agora), "");
});
