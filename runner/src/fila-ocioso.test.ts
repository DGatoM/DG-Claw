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

test("o arquivo é gravado com versao 2 e a leitura aceita as versões 1 e 2", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "v");
  gravarFila(arq, [{ texto: "a", em: 1, digitado: true, incerto: true }], "teste");
  assert.equal(JSON.parse(fs.readFileSync(arq, "utf8")).versao, 2);
  assert.deepEqual(carregarFila(arq, "teste").map((i) => [i.texto, i.digitado, i.incerto]), [["a", true, true]]);
});

test("item vindo da versão 1 não tem digitado nem incerto, mesmo que o arquivo os traga", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "v1");
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, JSON.stringify({ versao: 1, itens: [{ texto: "antigo", em: 5, digitado: true, incerto: true }] }));
  const itens = carregarFila(arq, "teste");
  assert.equal(itens.length, 1);
  assert.equal(itens[0]!.texto, "antigo");
  assert.equal("digitado" in itens[0]!, false);
  assert.equal("incerto" in itens[0]!, false);
});

test("versão desconhecida do arquivo é tratada como corrompida (guardada, fila vazia)", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "v3");
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, JSON.stringify({ versao: 3, itens: [{ texto: "x", em: 1 }] }));
  assert.deepEqual(carregarFila(arq, "teste"), []);
  assert.equal(fs.readdirSync(path.dirname(arq)).some((n) => n.includes(".corrompido-")), true);
});

test("a gravação faz fsync do temporário antes do rename e da pasta depois; só então devolve true", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "fs");
  const chamadas: string[] = [];
  const fsync = fs.fsyncSync;
  const rename = fs.renameSync;
  (fs as unknown as { fsyncSync: (fd: number) => void }).fsyncSync = (fd: number) => { chamadas.push("fsync"); return fsync(fd); };
  (fs as unknown as { renameSync: (a: string, b: string) => void }).renameSync = (a: string, b: string) => { chamadas.push("rename"); return rename(a, b); };
  try {
    assert.equal(gravarFila(arq, [{ texto: "a", em: 1 }], "teste"), true);
  } finally {
    (fs as unknown as { fsyncSync: typeof fsync }).fsyncSync = fsync;
    (fs as unknown as { renameSync: typeof rename }).renameSync = rename;
  }
  assert.deepEqual(chamadas, ["fsync", "rename", "fsync"], "fsync do arquivo, rename, fsync da pasta");
});

test("se o fsync falha, a gravação não conta como sucesso e nenhum temporário sobra", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "fs-falha");
  const fsync = fs.fsyncSync;
  (fs as unknown as { fsyncSync: (fd: number) => void }).fsyncSync = () => { throw Object.assign(new Error("EIO simulado"), { code: "EIO" }); };
  try {
    assert.equal(gravarFila(arq, [{ texto: "a", em: 1 }], "teste"), false);
  } finally {
    (fs as unknown as { fsyncSync: typeof fsync }).fsyncSync = fsync;
  }
  assert.equal(fs.existsSync(arq), false);
  assert.deepEqual(fs.readdirSync(path.dirname(arq)), [], "nenhum .tmp sobra");
});
