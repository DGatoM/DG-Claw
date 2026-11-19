import test from "node:test";
import assert from "node:assert/strict";
import { avisoDeAtraso } from "./sessao/fila.js";
import { AVISO_DE_FILA_APOS_MS } from "./sessao/constantes.js";

test("mensagem que não esperou sai sem aviso", () => {
  const agora = Date.now();
  assert.equal(avisoDeAtraso({ em: agora - 1_000 }, agora), "");
  assert.equal(avisoDeAtraso({ em: agora - (AVISO_DE_FILA_APOS_MS - 1) }, agora), "");
});

test("mensagem que esperou chega com a hora, o tempo e a regra da resposta curta", () => {
  const agora = new Date(2026, 10, 18, 14, 40, 0).getTime();
  const em = new Date(2026, 10, 18, 14, 32, 0).getTime();
  const aviso = avisoDeAtraso({ em }, agora);
  assert.ok(aviso.startsWith("\n\n[Aviso do sistema:"), "vem depois da mensagem, fora do envelope");
  assert.match(aviso, /às 14:32/);
  assert.match(aviso, /cerca de 8 min/);
  assert.match(aviso, /não autoriza uma ação nova/);
});

test("espera curta mas acima do limite conta pelo menos 1 minuto", () => {
  const agora = Date.now();
  assert.match(avisoDeAtraso({ em: agora - AVISO_DE_FILA_APOS_MS - 5 }, agora), /cerca de 1 min/);
});
