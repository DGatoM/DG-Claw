import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pastaTemporaria } from "./apoio-teste.js";
import { caminhoDaFila, carregarFila, gravarFila, nomeSeguro } from "./fila-ocioso.js";

test("nomeSeguro troca o que foge de [A-Za-z0-9._-] e evita . e ..", () => {
  assert.equal(nomeSeguro("a/b c:d"), "a_b_c_d");
  assert.equal(nomeSeguro("sess-1.x_y"), "sess-1.x_y");
  assert.equal(nomeSeguro(".."), "_..");
});

test("gravar e carregar: dois textos, na ordem, arquivo 600 e pasta 700", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "sess/1");
  gravarFila(arq, [{ texto: "primeiro", em: 1 }, { texto: "segundo", em: 2 }], "teste");
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(arq)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, "utf8")).itens.map((i: { texto: string }) => i.texto), ["primeiro", "segundo"]);
  assert.deepEqual(carregarFila(arq, "teste").map((i) => i.texto), ["primeiro", "segundo"]);
  assert.deepEqual(fs.readdirSync(path.dirname(arq)), [path.basename(arq)], "nenhum .tmp sobra");
});

test("arquivo inexistente é fila vazia", () => {
  const estado = pastaTemporaria("fila");
  assert.deepEqual(carregarFila(caminhoDaFila(estado, "x"), "teste"), []);
});

test("arquivo corrompido vira .corrompido-* e a fila nasce vazia", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "x");
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, "{não é json");
  assert.deepEqual(carregarFila(arq, "teste"), []);
  assert.equal(fs.existsSync(arq), false);
  const sobras = fs.readdirSync(path.dirname(arq)).filter((n) => n.startsWith("x.json.corrompido-"));
  assert.equal(sobras.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(arq), sobras[0]), "utf8"), "{não é json");
});

test("fila vazia apaga o arquivo", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "x");
  gravarFila(arq, [{ texto: "a", em: 1 }], "teste");
  assert.equal(fs.existsSync(arq), true);
  gravarFila(arq, [], "teste");
  assert.equal(fs.existsSync(arq), false);
  gravarFila(arq, [], "teste"); // apagar o que não existe não pode lançar
});
