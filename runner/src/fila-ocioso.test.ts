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
});

test("fila versão 1 não vazia: o primeiro item entra como incerto e os demais seguem comuns, na ordem", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "v1b");
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, JSON.stringify({ versao: 1, itens: [{ texto: "em voo", em: 1 }, { texto: "segundo", em: 2 }, { texto: "terceiro", em: 3 }] }));
  assert.deepEqual(carregarFila(arq, "teste").map((i) => [i.texto, i.incerto === true]), [["em voo", true], ["segundo", false], ["terceiro", false]]);
  const v2 = caminhoDaFila(estado, "v2b");
  fs.writeFileSync(v2, JSON.stringify({ versao: 2, itens: [{ texto: "a", em: 1 }] }));
  assert.equal(carregarFila(v2, "teste")[0]!.incerto, undefined, "versão 2 não muda");
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
    assert.equal(gravarFila(arq, [{ texto: "a", em: 1 }], "teste"), "gravado");
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
    assert.equal(gravarFila(arq, [{ texto: "a", em: 1 }], "teste"), "falhou");
  } finally {
    (fs as unknown as { fsyncSync: typeof fsync }).fsyncSync = fsync;
  }
  assert.equal(fs.existsSync(arq), false);
  assert.deepEqual(fs.readdirSync(path.dirname(arq)), [], "nenhum .tmp sobra");
});

test("gravar: writeSync que grava só parte dos bytes não deixa o arquivo da fila truncado", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "parcial");
  const original = fs.writeSync;
  // Simula um writeSync que só aceita 7 bytes por chamada.
  (fs as unknown as { writeSync: unknown }).writeSync = (fd: number, buf: Buffer, off: number, len: number) =>
    original(fd, buf, off, Math.min(7, len));
  try {
    assert.equal(gravarFila(arq, [{ texto: "um texto bem mais comprido que sete bytes", em: 1 }], "teste"), "gravado");
  } finally {
    (fs as unknown as { writeSync: unknown }).writeSync = original;
  }
  assert.deepEqual(carregarFila(arq, "teste").map((i) => i.texto), ["um texto bem mais comprido que sete bytes"]);
});

test("falha só no fsync da pasta depois do rename: o arquivo está no lugar e vale como gravado, com aviso", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "x");
  const original = fs.fsyncSync;
  let chamadas = 0;
  // A 1ª chamada é o fsync do arquivo temporário; a 2ª, a da pasta (depois do rename).
  fs.fsyncSync = ((fd: number) => {
    chamadas += 1;
    if (chamadas === 2) throw new Error("fsync da pasta falhou de propósito");
    return original(fd);
  }) as typeof fs.fsyncSync;
  try {
    assert.equal(gravarFila(arq, [{ texto: "pedido-importante", em: 1 }], "teste"), "sem-fsync-da-pasta");
  } finally {
    fs.fsyncSync = original;
  }
  assert.equal(chamadas, 2);
  assert.deepEqual(carregarFila(arq, "teste").map((i) => i.texto), ["pedido-importante"]);
});

test("falha de gravação de verdade (antes do rename) continua devolvendo false", () => {
  const estado = pastaTemporaria("fila");
  const bloqueio = path.join(estado, "arquivo");
  fs.writeFileSync(bloqueio, "x");
  assert.equal(gravarFila(path.join(bloqueio, "fila.json"), [{ texto: "a", em: 1 }], "teste"), "falhou");
});

test("carregar: id fora do formato de 8 hex é trocado por um novo e o id válido é mantido", () => {
  const estado = pastaTemporaria("fila");
  const arq = caminhoDaFila(estado, "ids");
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, JSON.stringify({ versao: 2, itens: [
    { texto: "um", em: 1, id: "abc\nINJETADO" },
    { texto: "dois", em: 2, id: "0a1b2c3d" },
  ] }));
  const itens = carregarFila(arq, "teste");
  assert.equal(itens.length, 2);
  assert.match(itens[0].id as string, /^[0-9a-f]{8}$/);
  assert.notEqual(itens[0].id, "abc\nINJETADO");
  assert.equal(itens[1].id, "0a1b2c3d");
});
